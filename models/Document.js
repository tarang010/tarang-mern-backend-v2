// Tarang 1.0.0.1 — models/Document.js
// STATELESS: No local file paths stored.
// All content stored in MongoDB or Cloudinary.

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
    extractedText:     { type: String, default: null },   // full extracted text
    visualizationHtml: { type: String, default: null },   // admin/user viz HTML
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
    // These will be null for all new documents. Safe to remove after migration.
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
    ttsEngine:  { type: String, default: "pyttsx3" },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);
