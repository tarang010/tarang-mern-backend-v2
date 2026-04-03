// Tarang 1.0.0.1 — routes/chatRoutes.js

const express = require("express");
const router  = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const {
  getMessages, sendMessage, shareDocumentInChat,
  downloadDocument, getUnreadCount, getConversations, cleanupExpiredFiles,
} = require("../controllers/chatController");

// Conversation list + unread count
router.get( "/conversations",                    protect, getConversations);
router.get( "/unread",                           protect, getUnreadCount);

// Per-friend chat
router.get( "/:friendId/messages",               protect, getMessages);
router.post("/:friendId/send",                   protect, sendMessage);
router.post("/:friendId/share-document",         protect, shareDocumentInChat);
router.get( "/:friendId/download/:messageId",    protect, downloadDocument);

// Admin cleanup
router.post("/cleanup",                          protect, adminOnly, cleanupExpiredFiles);

module.exports = router;
