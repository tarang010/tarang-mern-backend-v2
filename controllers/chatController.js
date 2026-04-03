// Tarang 1.0.0.1 — controllers/chatController.js
// STATELESS: No local file reads/writes.
// extractedText read from MongoDB Document.extractedText.
// filePath field removed — download serves extractedText as .txt instead.

const Message    = require("../models/Message");
const Document   = require("../models/Document");
const Friendship = require("../models/Friendship");
const Notification = require("../models/Notification");

// ── Helper: verify two users are friends ──────────────────────────────────────
const areFriends = async (userA, userB) => {
  const f = await Friendship.findOne({
    $or: [
      { requester: userA, recipient: userB },
      { requester: userB, recipient: userA },
    ],
    status: "accepted",
  });
  return !!f;
};

// ── GET /api/chat/:friendId/messages ──────────────────────────────────────────
const getMessages = async (req, res) => {
  const { friendId } = req.params;
  const myId         = req.user._id;

  if (!(await areFriends(myId, friendId))) {
    return res.status(403).json({ status: "error", error: "Not friends." });
  }

  const convId = Message.conversationId(myId, friendId);

  const messages = await Message.find({ conversationId: convId })
    .sort({ createdAt: 1 })
    .limit(100)
    .populate("senderId",    "name")
    .populate("recipientId", "name");

  // Mark all as read
  await Message.updateMany(
    { conversationId: convId, recipientId: myId, readBy: { $ne: myId } },
    { $addToSet: { readBy: myId } }
  );

  // Check which shared documents have expired
  const processed = messages.map((m) => {
    const obj = m.toObject();
    if (obj.type === "document_share" && obj.sharedDocument) {
      const expired = obj.sharedDocument.fileExpiresAt &&
                      new Date(obj.sharedDocument.fileExpiresAt) < new Date();
      obj.sharedDocument.fileExpired = expired || obj.sharedDocument.fileDeleted;
    }
    return obj;
  });

  res.json({ status: "success", data: { messages: processed } });
};

// ── POST /api/chat/:friendId/send ─────────────────────────────────────────────
const sendMessage = async (req, res) => {
  const { friendId } = req.params;
  const { text }     = req.body;
  const myId         = req.user._id;

  if (!text?.trim()) {
    return res.status(400).json({ status: "error", error: "Message cannot be empty." });
  }

  if (!(await areFriends(myId, friendId))) {
    return res.status(403).json({ status: "error", error: "Not friends." });
  }

  const convId = Message.conversationId(myId, friendId);

  const message = await Message.create({
    conversationId: convId,
    senderId:       myId,
    recipientId:    friendId,
    type:           "text",
    text:           text.trim(),
    readBy:         [myId],
  });

  const populated = await message.populate(["senderId", "recipientId"]);
  res.status(201).json({ status: "success", data: { message: populated } });
};

// ── POST /api/chat/:friendId/share-document ───────────────────────────────────
// STATELESS: Reads extractedText directly from MongoDB Document.extractedText.
// No local file reads. filePath is always null.
// Download endpoint serves extractedText as a .txt file instead.
const shareDocumentInChat = async (req, res) => {
  const { friendId }   = req.params;
  const { documentId } = req.body;
  const myId           = req.user._id;

  if (!(await areFriends(myId, friendId))) {
    return res.status(403).json({ status: "error", error: "Not friends." });
  }

  const doc = await Document.findOne({ _id: documentId, userId: myId })
    .select("title originalFilename wordCount format docId extractedText pipelineStatus");

  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  if (!["ready", "audio_ready"].includes(doc.pipelineStatus)) {
    return res.status(400).json({ status: "error", error: "Document is still processing." });
  }

  // extractedText comes from MongoDB — no file read needed
  const extractedText = doc.extractedText || null;

  // Expires in 24h (controls UI display — no actual file to delete)
  const fileExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const convId        = Message.conversationId(myId, friendId);

  const message = await Message.create({
    conversationId: convId,
    senderId:       myId,
    recipientId:    friendId,
    type:           "document_share",
    text:           `Shared a document: ${doc.title}`,
    readBy:         [myId],
    sharedDocument: {
      documentId:       doc._id,
      docId:            doc.docId,
      title:            doc.title,
      originalFilename: doc.originalFilename,
      wordCount:        doc.wordCount,
      format:           doc.format,
      filePath:         null,          // no local file — always null now
      extractedText,                   // from MongoDB directly
      fileExpiresAt,
      fileDeleted:      false,
    },
  });

  // Notify recipient
  try {
    await Notification.create({
      userId:  friendId,
      type:    "document_shared",
      title:   `${req.user.name} shared a document in chat`,
      message: `"${doc.title}" — open the chat to view it.`,
      data:    { senderId: myId, documentTitle: doc.title },
    });
  } catch {}

  const populated = await message.populate(["senderId", "recipientId"]);
  res.status(201).json({ status: "success", data: { message: populated } });
};

// ── GET /api/chat/:friendId/download/:messageId ───────────────────────────────
// STATELESS: Serves extractedText as a downloadable .txt file.
// Original file no longer exists on Render — extractedText in MongoDB is the source.
const downloadDocument = async (req, res) => {
  const { messageId } = req.params;
  const myId          = req.user._id;

  const message = await Message.findById(messageId);
  if (!message || message.type !== "document_share") {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const isParticipant =
    message.senderId.toString()    === myId.toString() ||
    message.recipientId.toString() === myId.toString();
  if (!isParticipant) {
    return res.status(403).json({ status: "error", error: "Access denied." });
  }

  const sd = message.sharedDocument;

  // Check expiry
  if (sd.fileDeleted || (sd.fileExpiresAt && new Date(sd.fileExpiresAt) < new Date())) {
    return res.status(410).json({
      status: "error",
      error:  "This document has expired (24-hour limit).",
    });
  }

  // Serve extractedText as downloadable .txt
  if (!sd.extractedText) {
    return res.status(404).json({ status: "error", error: "Document text not available." });
  }

  const filename = (sd.originalFilename || sd.title || "document")
    .replace(/\.[^.]+$/, "") + "_extracted.txt";

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(sd.extractedText);
};

// ── GET /api/chat/:friendId/unread-count ──────────────────────────────────────
const getUnreadCount = async (req, res) => {
  const myId = req.user._id;
  const count = await Message.countDocuments({
    recipientId: myId,
    readBy:      { $ne: myId },
  });
  res.json({ status: "success", data: { unreadCount: count } });
};

// ── GET /api/chat/conversations ───────────────────────────────────────────────
const getConversations = async (req, res) => {
  const myId = req.user._id;

  const messages = await Message.find({
    $or: [{ senderId: myId }, { recipientId: myId }],
  })
    .sort({ createdAt: -1 })
    .populate("senderId",    "name email")
    .populate("recipientId", "name email");

  const convMap = {};
  for (const m of messages) {
    if (!convMap[m.conversationId]) {
      const other = m.senderId._id.toString() === myId.toString()
        ? m.recipientId : m.senderId;
      const unread = await Message.countDocuments({
        conversationId: m.conversationId,
        recipientId:    myId,
        readBy:         { $ne: myId },
      });
      convMap[m.conversationId] = {
        conversationId:  m.conversationId,
        friend:          other,
        lastMessage:     m.text || "Shared a document",
        lastMessageAt:   m.createdAt,
        unreadCount:     unread,
        lastMessageType: m.type,
      };
    }
  }

  res.json({
    status: "success",
    data:   {
      conversations: Object.values(convMap).sort((a, b) => b.lastMessageAt - a.lastMessageAt),
    },
  });
};

// ── POST /api/chat/cleanup (admin) ────────────────────────────────────────────
// Mark expired shared documents as deleted (no files to clean up anymore)
const cleanupExpiredFiles = async (req, res) => {
  const result = await Message.updateMany(
    {
      type: "document_share",
      "sharedDocument.fileExpiresAt": { $lt: new Date() },
      "sharedDocument.fileDeleted":   false,
    },
    {
      $set: {
        "sharedDocument.fileDeleted": true,
        "sharedDocument.filePath":    null,
      },
    }
  );

  res.json({
    status: "success",
    data:   { cleaned: result.modifiedCount, message: `${result.modifiedCount} expired record(s) marked.` },
  });
};

module.exports = {
  getMessages, sendMessage, shareDocumentInChat,
  downloadDocument, getUnreadCount, getConversations, cleanupExpiredFiles,
};
