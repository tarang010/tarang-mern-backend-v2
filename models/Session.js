// Tarang 1.0.0.1 — models/Session.js
// Added sessionState field — stores full state dict for stateless bridge calls.
// Bridge reads session_state from here instead of local JSON files.

const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true, index: true,
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document", required: true,
    },
    docId:         { type: String, required: true, index: true },
    sessionNumber: { type: Number, required: true, enum: [1, 2, 3] },
    difficulty:    { type: String, enum: ["Easy", "Medium", "Hard"] },

    // ── Status ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "locked", "available", "in_progress", "completed"],
      default: "locked",
    },
    startedAt:   { type: Date, default: null },
    submittedAt: { type: Date, default: null },

    // ── Scoring ───────────────────────────────────────────────────────────
    scorePct:       { type: Number, default: null },
    correctCount:   { type: Number, default: 0 },
    totalQuestions: { type: Number, default: 10 },

    // ── User answers (stored for weak topic analysis) ─────────────────────
    userAnswers:  { type: mongoose.Schema.Types.Mixed, default: {} },
    overrideUsed: { type: Boolean, default: false },

    // ── MCQ data (returned by bridge, stored here — no local files) ───────
    questions: { type: mongoose.Schema.Types.Mixed, default: [] },
    answerKey: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Full session state dict (for stateless bridge calls) ──────────────
    // This is the complete state object that file5_mcq.py reads/writes.
    // Replaces storage/mcq/<doc_id>_session_state.json entirely.
    // Updated by Express after every bridge call that returns updated_state.
    sessionState: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Compound index for fast lookups
sessionSchema.index({ docId: 1, userId: 1, sessionNumber: 1 }, { unique: true });

module.exports = mongoose.model("Session", sessionSchema);
