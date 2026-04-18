// Tarang 2.4.0 — models/Document.js
// STATELESS: No local file paths stored.
// All content stored in MongoDB or Cloudinary.
//
// v2.4.0 changes:
//   Added multi-part document fields (isMultiPart, partNumber, totalParts,
//   parentDocId) for smart splitting of large PDFs. All new fields are
//   optional with safe defaults — existing documents are unaffected.

const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true, index: true,
    },
    docId: {
      type: String, required: true, unique: true, index: true,
    },
    title: {
      type: String, required: true, trim: true, maxlength: 200,
    },
    originalFilename: { type: String, required: true },
    format:           { type: String, enum: ["pdf", "docx", "txt", "md"] },
    wordCount:        { type: Number, default: 0 },
    charCount:        { type: Number, default: 0 },
    durationSec:      { type: Number, default: 0 },

    // ── Content stored in MongoDB (no local files) ────────────────────────
    extractedText:     { type: String, default: null },
    visualizationHtml: { type: String, default: null },
    visualizationType: {
      type: String,
      enum: ["admin_report", "user_waveform", null],
      default: null,
    },

    // ── Captions (pre-baked during pipeline, cached after first play) ─────
    captions:            { type: mongoose.Schema.Types.Mixed, default: null },
    captionsGeneratedAt: { type: Date, default: null },

    // ── Audio stored in Cloudinary ────────────────────────────────────────
    audioCloudUrl:  { type: String, default: null },
    audioPublicId:  { type: String, default: null },

    // ── Local file paths — DEPRECATED, kept for migration compatibility ───
    extractedPath:     { type: String, default: null },
    ttsWavPath:        { type: String, default: null },
    modulatedWavPath:  { type: String, default: null },
    visualizationPath: { type: String, default: null },

    // ── Cognitive settings ────────────────────────────────────────────────
    cognitiveState: {
      type: String,
      enum: ["deep_focus", "memory", "calm", "deep_relaxation", "sleep"],
      default: "deep_focus",
    },
    beatFreqHz: { type: Number, default: 14.0 },
    ttsEngine:  { type: String, default: "edge" },
    voiceId:    { type: String, default: null },

    // ── Session tracking ──────────────────────────────────────────────────
    sessionsGenerated:   { type: Number, default: 0 },
    allSessionsComplete: { type: Boolean, default: false },

    // ── Sharing metadata ──────────────────────────────────────────────────
    isShared:         { type: Boolean, default: false },
    sharedFrom:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    isSharedDocument: { type: Boolean, default: false },
    shareToken:       { type: String, default: null },

    // ── Pipeline status ───────────────────────────────────────────────────
    pipelineStatus: {
      type: String,
      enum: ["processing", "audio_ready", "ready", "error"],
      default: "processing",
    },
    pipelineError: { type: String },

    // ── Multi-part document support (new in v2.4.0) ───────────────────────
    // Only populated when a PDF exceeds PART_WORD_LIMIT and is auto-split.
    // All fields default to values that represent a normal single document,
    // so every existing document in MongoDB continues to work without any
    // migration or backfill.
    isMultiPart: { type: Boolean, default: false },   // true only when split
    partNumber:  { type: Number,  default: 1 },       // 1 = first or only part
    totalParts:  { type: Number,  default: 1 },       // 1 = not split
    parentDocId: { type: String,  default: null, index: true },
    // parentDocId is null on part 1 (the "parent") and set to part 1's docId
    // on parts 2, 3, ... — this is how Dashboard.jsx groups them.
    // ─────────────────────────────────────────────────────────────────────
  },
  { timestamps: true }
);

// Compound index: fetch all parts of a document in order
documentSchema.index({ userId: 1, parentDocId: 1, partNumber: 1 });
// Dashboard listing
documentSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Document", documentSchema);