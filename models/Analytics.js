// Tarang 2.0.0 — models/Analytics.js

const mongoose = require("mongoose");

const analyticsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true, index: true,
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document", required: true,
    },
    docId: { type: String, required: true, index: true },

    // ── Flat average (kept for backwards compat) ──────────────────────────
    averageScorePct:     { type: Number },
    averageScoreDisplay: { type: String },
    averageScoreLabel:   { type: String },

    // ── WRS (Weighted Retention Score) — new in v2.0.0 ────────────────────
    wrs:            { type: Number, default: null },
    wrsDisplay:     { type: String, default: null },   // e.g. "72%"
    wrsLabel:       { type: String, default: null },   // e.g. "Good retention"
    retentionDecay: { type: Number, default: null },   // decay coefficient
    bonusesEarned:  { type: mongoose.Schema.Types.Mixed, default: [] },

    // ── Learning curve ────────────────────────────────────────────────────
    learningCurve:       { type: String },
    learningCurveDesc:   { type: String },
    improvementS1toS3:   { type: String },
    totalTimeSpentMin:   { type: Number },
    bestSession:         { type: Number },
    worstSession:        { type: Number },

    // ── Detailed data ─────────────────────────────────────────────────────
    scoreProgression: { type: mongoose.Schema.Types.Mixed, default: [] },
    weakTopics:       { type: [String], default: [] },
    suggestions:      { type: [String], default: [] },

    // ── Flags ─────────────────────────────────────────────────────────────
    relisteningRecommended: { type: Boolean, default: false },
    poorScoreWarning:       { type: Boolean, default: false },

    // ── Full analytics JSON + HTML report ─────────────────────────────────
    fullAnalytics: { type: mongoose.Schema.Types.Mixed, default: null },
    analyticsHtml: { type: String, default: null },

    // ── DEPRECATED ────────────────────────────────────────────────────────
    jsonPath: { type: String, default: null },
    htmlPath: { type: String, default: null },
  },
  { timestamps: true }
);

analyticsSchema.index({ docId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("Analytics", analyticsSchema);