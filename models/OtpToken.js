// Tarang 2.3.0 — models/OtpToken.js
// Place at: backend/models/OtpToken.js
//
// v2.3.0 addition:
//   `purpose` field scopes every OTP to exactly one action so codes
//   can't be cross-used across flows (e.g. a login OTP can't verify email).
//   Allowed values: "password_reset" | "email_verification" | "login"

const mongoose = require("mongoose");

const otpTokenSchema = new mongoose.Schema({
  email: {
    type:     String,
    required: true,
    lowercase: true,
  },
  otpHash: {
    type:     String,
    required: true, // bcrypt hash — never store plaintext OTP
  },
  purpose: {
    type:     String,
    required: true,
    enum:     ["password_reset", "email_verification", "login"],
  },
  createdAt: {
    type:    Date,
    default: Date.now,
  },
  expiresAt: {
    type:     Date,
    required: true,
  },
});

// MongoDB TTL index — auto-deletes document after expiresAt passes
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Fast lookup by email + purpose (the two fields always queried together)
otpTokenSchema.index({ email: 1, purpose: 1 });

module.exports = mongoose.model("OtpToken", otpTokenSchema);