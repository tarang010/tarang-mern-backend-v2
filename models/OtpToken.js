// Tarang 2.2.0 — models/OtpToken.js
// Place at: backend/models/OtpToken.js

const mongoose = require("mongoose");

const otpTokenSchema = new mongoose.Schema({
  email:     { type: String, required: true, lowercase: true },
  otpHash:   { type: String, required: true }, // bcrypt hash — never store plaintext
  createdAt: { type: Date,   default: Date.now },
  expiresAt: { type: Date,   required: true },
});

// MongoDB TTL index — auto-deletes the document after expiresAt
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Fast lookup by email
otpTokenSchema.index({ email: 1 });

module.exports = mongoose.model("OtpToken", otpTokenSchema);
