// Tarang 1.0.0.1 — controllers/sharingController.js

const crypto         = require("crypto");
const path           = require("path");
const fs             = require("fs");
const FormData       = require("form-data");
const Document       = require("../models/Document");
const SharedDocument = require("../models/SharedDocument");
const Notification   = require("../models/Notification");
const Friendship     = require("../models/Friendship");
const User           = require("../models/User");
const { bridge }     = require("../config/bridge");

// ── Helper: get accepted friend IDs for a user ────────────────────────────────
const getFriendIds = async (userId) => {
  const friendships = await Friendship.find({
    $or: [{ requester: userId }, { recipient: userId }],
    status: "accepted",
  });
  return friendships.map((f) =>
    f.requester.toString() === userId.toString() ? f.recipient : f.requester
  );
};

// ── Helper: create notification ───────────────────────────────────────────────
const notify = async (userId, type, title, message, data = {}) => {
  try {
    await Notification.create({ userId, type, title, message, data });
  } catch (e) {
    console.error("Notification failed:", e.message);
  }
};

// ── POST /api/sharing/share ───────────────────────────────────────────────────
// Creates share link + notifies selected friends
// Body: { documentId, sharedWithIds: [], ttlDays: 1|2 }
const shareDocument = async (req, res) => {
  const { documentId, sharedWithIds = [], ttlDays = 1 } = req.body;

  const doc = await Document.findOne({
    _id:    documentId,
    userId: req.user._id,
  });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  // Verify all sharedWithIds are accepted friends
  const friendIds      = await getFriendIds(req.user._id);
  const friendStrings  = friendIds.map((id) => id.toString());
  const validRecipients = (sharedWithIds || []).filter((id) =>
    friendStrings.includes(id.toString())
  );

  // Read extracted text from file — store in MongoDB permanently
  let extractedText = null;
  if (doc.extractedPath) {
    const fullPath = path.join(__dirname, "../../..", doc.extractedPath);
    if (fs.existsSync(fullPath)) {
      extractedText = fs.readFileSync(fullPath, "utf-8");
    }
  }

  // Generate share token
  const shareToken = crypto.randomBytes(16).toString("hex");

  // Audio file expiry
  const safeTtl = [1, 2].includes(Number(ttlDays)) ? Number(ttlDays) : 1;
  const audioExpiresAt = new Date();
  audioExpiresAt.setDate(audioExpiresAt.getDate() + safeTtl);

  const shared = await SharedDocument.create({
    sharedBy:         req.user._id,
    sourceDocumentId: doc._id,
    sourceDocId:      doc.docId,
    shareToken,
    sharedWith:       validRecipients,
    extractedText,
    documentTitle:    doc.title,
    originalFilename: doc.originalFilename,
    wordCount:        doc.wordCount,
    ttlDays:          safeTtl,
    audioExpiresAt,
  });

  // Notify selected friends
  if (validRecipients.length > 0) {
    const sharer = await User.findById(req.user._id).select("name");
    for (const recipientId of validRecipients) {
      await notify(
        recipientId,
        "document_shared",
        `${sharer.name} shared a document with you`,
        `"${doc.title}" is available for you to study.`,
        { shareToken, documentTitle: doc.title, sharedBy: sharer.name }
      );
    }
  }

  const shareUrl = `${process.env.CLIENT_URL || "http://localhost:3000"}/share/${shareToken}`;

  res.status(201).json({
    status: "success",
    data: {
      shareToken,
      shareUrl,
      sharedWith:    validRecipients.length,
      audioExpiresAt,
      ttlDays:       safeTtl,
      message:       `Share link created. Audio deleted after ${safeTtl} day(s). Text kept permanently.`,
    },
  });
};

// ── GET /api/sharing/preview/:token ──────────────────────────────────────────
const getSharePreview = async (req, res) => {
  const { token } = req.params;

  const shared = await SharedDocument.findOne({
    shareToken: token,
    isActive:   true,
  }).populate("sharedBy", "name");

  if (!shared) {
    return res.status(404).json({ status: "error", error: "Share link not found or expired." });
  }

  const myId     = req.user._id.toString();
  const sharerId = shared.sharedBy._id.toString();
  const isSharer = myId === sharerId;

  if (!isSharer) {
    const friendIds = await getFriendIds(req.user._id);
    const isFriend  = friendIds.map((id) => id.toString()).includes(sharerId);
    if (!isFriend) {
      return res.status(403).json({
        status: "error",
        error:  "You must be friends with the sharer to access this document.",
      });
    }
  }

  const existing = shared.recipients.find((r) => r.userId?.toString() === myId);

  res.json({
    status: "success",
    data: {
      shareToken:      token,
      documentTitle:   shared.documentTitle,
      wordCount:       shared.wordCount,
      sharedBy:        shared.sharedBy.name,
      ttlDays:         shared.ttlDays,
      audioExpiresAt:  shared.audioExpiresAt,
      alreadyAccepted: !!existing,
      existingDocId:   existing?.docId  || null,
      existingStatus:  existing?.status || null,
    },
  });
};

// ── POST /api/sharing/accept ──────────────────────────────────────────────────
const acceptShare = async (req, res) => {
  const { shareToken, cognitiveState = "deep_focus", ttsEngine = "pyttsx3" } = req.body;

  const shared = await SharedDocument.findOne({ shareToken, isActive: true });
  if (!shared) {
    return res.status(404).json({ status: "error", error: "Share not found or expired." });
  }

  const myId = req.user._id.toString();

  const existing = shared.recipients.find((r) => r.userId?.toString() === myId);
  if (existing && ["processing", "ready"].includes(existing.status)) {
    return res.status(409).json({
      status: "error",
      error:  "You have already accepted this document.",
      docId:  existing.docId,
    });
  }

  // Verify friendship (unless sharer)
  if (myId !== shared.sharedBy.toString()) {
    const friendIds = await getFriendIds(req.user._id);
    const isFriend  = friendIds.map((id) => id.toString()).includes(shared.sharedBy.toString());
    if (!isFriend) {
      return res.status(403).json({ status: "error", error: "You must be friends with the sharer." });
    }
  }

  if (!existing) {
    shared.recipients.push({ userId: req.user._id, cognitiveState, status: "processing", acceptedAt: new Date() });
  } else {
    existing.status = "processing";
    existing.cognitiveState = cognitiveState;
    existing.acceptedAt = new Date();
  }
  await shared.save();

  // Respond immediately — pipeline runs in background
  res.status(202).json({
    status: "success",
    data:   { message: "Processing started.", shareToken },
  });

  // ── Background pipeline ───────────────────────────────────────────────────
  setImmediate(async () => {
    try {
      const os      = require("os");
      const tmpFile = path.join(os.tmpdir(), `tarang_share_${shareToken}_${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, shared.extractedText || "", "utf-8");

      const r2 = await bridge.post("/tts", { extracted_txt_path: tmpFile, engine: ttsEngine });
      const wavPath = r2.data.data.output_path;

      const r3 = await bridge.post("/modulate", { tts_wav_path: wavPath, cognitive_state: cognitiveState });
      const modPath = r3.data.data.output_path;

      const r4 = await bridge.post("/visualize", {
        modulated_wav_path: modPath, role: "user",
        cognitive_state: cognitiveState, document_title: shared.documentTitle,
      });

      const r5 = await bridge.post("/mcq/init", {
        extracted_txt_path: tmpFile, document_title: shared.documentTitle,
      });
      const docId = r5.data.data.document_id;

      const normPath = (p) => p ? p.replace(/\\/g, "/") : null;

      const newDoc = await Document.create({
        userId:            req.user._id,
        docId,
        title:             shared.documentTitle,
        originalFilename:  shared.originalFilename,
        format:            "txt",
        wordCount:         shared.wordCount,
        durationSec:       r3.data.data.duration_sec,
        extractedPath:     normPath(tmpFile),
        ttsWavPath:        normPath(wavPath),
        modulatedWavPath:  normPath(modPath),
        visualizationPath: normPath(r4.data.data.output_path),
        cognitiveState,
        beatFreqHz:        r3.data.data.beat_freq_hz,
        ttsEngine,
        sessionsGenerated: 3,
        pipelineStatus:    "ready",
        isSharedDocument:  true,
        shareToken,
      });

      const difficulties = { 1: "Easy", 2: "Medium", 3: "Hard" };
      for (const n of [1, 2, 3]) {
        await Session.findOneAndUpdate(
          { docId, userId: req.user._id, sessionNumber: n },
          { $setOnInsert: {
            userId: req.user._id, documentId: newDoc._id, docId,
            sessionNumber: n, difficulty: difficulties[n],
            status: n === 1 ? "pending" : "locked",
          }},
          { upsert: true }
        );
      }

      const shareDoc    = await SharedDocument.findOne({ shareToken });
      const recEntry    = shareDoc.recipients.find((r) => r.userId?.toString() === req.user._id.toString());
      if (recEntry) { recEntry.status = "ready"; recEntry.documentId = newDoc._id; recEntry.docId = docId; }
      await shareDoc.save();

      await notify(req.user._id, "share_processed",
        "Your shared document is ready",
        `"${shared.documentTitle}" is processed and ready to listen.`,
        { docId, documentTitle: shared.documentTitle }
      );

      try { fs.unlinkSync(tmpFile); } catch {}

    } catch (err) {
      console.error("Share pipeline failed:", err.message);
      const shareDoc = await SharedDocument.findOne({ shareToken });
      if (shareDoc) {
        const entry = shareDoc.recipients.find((r) => r.userId?.toString() === req.user._id.toString());
        if (entry) { entry.status = "error"; entry.pipelineError = err.message; }
        await shareDoc.save();
      }
    }
  });
};

// ── GET /api/sharing/status/:token ───────────────────────────────────────────
const getShareStatus = async (req, res) => {
  const { token } = req.params;
  const myId = req.user._id.toString();

  const shared = await SharedDocument.findOne({ shareToken: token });
  if (!shared) return res.status(404).json({ status: "error", error: "Share not found." });

  const entry = shared.recipients.find((r) => r.userId?.toString() === myId);
  if (!entry)  return res.status(404).json({ status: "error", error: "You have not accepted this share." });

  res.json({ status: "success", data: { status: entry.status, docId: entry.docId || null, pipelineError: entry.pipelineError || null } });
};

// ── GET /api/sharing/received ─────────────────────────────────────────────────
const getReceivedShares = async (req, res) => {
  const friendIds = await getFriendIds(req.user._id);
  const myId      = req.user._id;

  const shares = await SharedDocument.find({
    $or: [{ sharedWith: myId }, { sharedBy: { $in: friendIds }, isActive: true }],
  }).populate("sharedBy", "name email").sort({ createdAt: -1 }).limit(50);

  const result = shares.map((s) => {
    const myEntry = s.recipients.find((r) => r.userId?.toString() === myId.toString());
    return {
      shareToken: s.shareToken, documentTitle: s.documentTitle,
      wordCount: s.wordCount, sharedBy: s.sharedBy,
      audioExpiresAt: s.audioExpiresAt, ttlDays: s.ttlDays,
      myStatus: myEntry?.status || "not_accepted",
      myDocId:  myEntry?.docId  || null,
      createdAt: s.createdAt,
    };
  });

  res.json({ status: "success", data: { shares: result } });
};

// ── GET /api/sharing/my-shares ────────────────────────────────────────────────
const getMyShares = async (req, res) => {
  const shares = await SharedDocument.find({ sharedBy: req.user._id })
    .populate("recipients.userId", "name")
    .sort({ createdAt: -1 });
  res.json({ status: "success", data: { shares } });
};

// ── POST /api/sharing/cleanup (admin) ─────────────────────────────────────────
const cleanupExpiredAudio = async (req, res) => {
  const expired = await SharedDocument.find({ audioExpiresAt: { $lt: new Date() }, isActive: true });
  let cleaned = 0;
  for (const share of expired) {
    for (const r of share.recipients) {
      if (r.documentId) {
        const doc = await Document.findById(r.documentId);
        if (doc) {
          for (const field of ["ttsWavPath", "modulatedWavPath"]) {
            if (doc[field]) {
              const fp = path.join(__dirname, "../../..", doc[field]);
              try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
            }
          }
          await Document.findByIdAndUpdate(r.documentId, { pipelineStatus: "expired", ttsWavPath: null, modulatedWavPath: null });
          cleaned++;
        }
      }
    }
    share.isActive = false;
    await share.save();
  }
  res.json({ status: "success", data: { cleaned } });
};

module.exports = { shareDocument, getSharePreview, acceptShare, getShareStatus, getReceivedShares, getMyShares, cleanupExpiredAudio };
