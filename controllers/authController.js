// Tarang 2.2.0 — controllers/authController.js
// Place at: backend/controllers/authController.js
//
// v2.2.0 fix:
//   generateToken now reads JWT_SECRET from process.env directly as the
//   primary source. initJwtSecret() in server.js was regenerating a new
//   in-memory secret on every Render cold start / redeploy, invalidating
//   all existing tokens and causing 401 on login for returning users.
//   Fix: if JWT_SECRET env var is set, always use it — never override it.
//
// v2.2.1 additions:
//   forgotPassword, verifyOtp, resetPassword — full OTP-based password reset flow.

const crypto            = require("crypto");
const bcrypt            = require("bcryptjs");
const User              = require("../models/User");
const OtpToken          = require("../models/OtpToken");
const { generateToken } = require("../utils/jwt");
const { sendOtpEmail }  = require("../utils/mailer");
const { bridge, bridgePost } = require("../config/bridge");

// ── POST /api/auth/register ───────────────────────────────────────────────────
const register = async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({
      status: "error",
      error:  "Name, email and password are required.",
    });
  }

  const exists = await User.findOne({ email });
  if (exists) {
    return res.status(409).json({
      status: "error",
      error:  "An account with this email already exists.",
    });
  }

  const user  = await User.create({ name, email, password });
  const token = generateToken(user._id);

  res.status(201).json({
    status: "success",
    data: {
      token,
      user: {
        id:                     user._id,
        name:                   user.name,
        email:                  user.email,
        role:                   user.role,
        preferredCognitiveMode: user.preferredCognitiveMode,
      },
    },
  });
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      status: "error",
      error:  "Email and password are required.",
    });
  }

  const user = await User.findOne({ email }).select("+password");
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({
      status: "error",
      error:  "Invalid email or password.",
    });
  }

  if (user.isActive === false) {
    return res.status(401).json({
      status: "error",
      error:  "Account is deactivated. Contact support.",
    });
  }

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const token = generateToken(user._id);

  res.json({
    status: "success",
    data: {
      token,
      user: {
        id:                     user._id,
        name:                   user.name,
        email:                  user.email,
        role:                   user.role,
        preferredCognitiveMode: user.preferredCognitiveMode,
      },
    },
  });
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  res.json({
    status: "success",
    data:   { user: req.user },
  });
};

// ── PUT /api/auth/password ────────────────────────────────────────────────────
const updatePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select("+password");
  if (!(await user.matchPassword(currentPassword))) {
    return res.status(401).json({
      status: "error",
      error:  "Current password is incorrect.",
    });
  }

  user.password = newPassword;
  await user.save();

  const token = generateToken(user._id);
  res.json({
    status: "success",
    data:   { token, message: "Password updated successfully." },
  });
};

// ── PUT /api/auth/preferences ─────────────────────────────────────────────────
const updatePreferences = async (req, res) => {
  const { themePreference } = req.body;
  if (themePreference && !["dark", "light"].includes(themePreference)) {
    return res.status(400).json({
      status: "error",
      error:  "Invalid theme. Use 'dark' or 'light'.",
    });
  }
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { ...(themePreference && { themePreference }) } },
    { new: true }
  );
  res.json({ status: "success", data: { user } });
};

// ── GET /api/auth/quiz ─────────────────────────────────────────────────────────
// FIX v2.2.1: bridge /quiz is GET — bridgePost was sending POST → 405.
const getQuiz = async (req, res) => {
  const { data: bridgeRes } = await bridge.get("/quiz");
  res.json({ status: "success", data: bridgeRes.data });
};

// ── POST /api/auth/suggest-mode ───────────────────────────────────────────────
const suggestMode = async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ status: "error", error: "answers dict is required." });
  }

  const { data: bridgeRes } = await bridgePost("/suggest-mode", { answers });
  const result = bridgeRes.data;

  await User.findByIdAndUpdate(req.user._id, {
    $set: {
      preferredCognitiveMode: result.recommended_mode,
      cognitiveQuizAnswers:   answers,
      cognitiveQuizTakenAt:   new Date(),
    },
  });

  res.json({ status: "success", data: result });
};

// ── PUT /api/auth/cognitive-mode ──────────────────────────────────────────────
const updateCognitiveMode = async (req, res) => {
  const { mode } = req.body;
  const valid = ["deep_focus", "memory", "calm", "deep_relaxation", "sleep"];
  if (!valid.includes(mode)) {
    return res.status(400).json({
      status: "error",
      error:  `Invalid mode. Must be one of: ${valid.join(", ")}`,
    });
  }

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { preferredCognitiveMode: mode } },
    { new: true }
  );

  res.json({ status: "success", data: { user } });
};

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Generates a 6-digit OTP, stores its bcrypt hash, emails it to the user.
// Always returns 200 — never reveals whether the email exists (prevents enumeration).
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ status: "error", error: "Email is required." });
  }

  const user = await User.findOne({ email: email.toLowerCase() });

  // Always respond the same way — prevents email enumeration
  if (!user) {
    return res.status(200).json({
      status:  "success",
      message: "If this email is registered, an OTP has been sent.",
    });
  }

  // Invalidate any existing OTPs for this email
  await OtpToken.deleteMany({ email: email.toLowerCase() });

  // Generate a cryptographically random 6-digit OTP
  const otp       = String(crypto.randomInt(100000, 999999));
  const otpHash   = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await OtpToken.create({ email: email.toLowerCase(), otpHash, expiresAt });
  await sendOtpEmail(user.email, otp);

  res.status(200).json({
    status:  "success",
    message: "If this email is registered, an OTP has been sent.",
  });
};

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
// Verifies the OTP. On success, issues a short-lived reset token that
// /reset-password consumes. The raw token only ever lives in the frontend's
// React state — never persisted.
const verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ status: "error", error: "Email and OTP are required." });
  }

  const record = await OtpToken.findOne({ email: email.toLowerCase() });
  if (!record) {
    return res.status(400).json({ status: "error", error: "OTP expired or not requested." });
  }

  const valid = await bcrypt.compare(String(otp), record.otpHash);
  if (!valid) {
    return res.status(400).json({ status: "error", error: "Invalid OTP." });
  }

  // OTP verified — issue a one-time reset token stored as a hash
  const resetToken     = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = await bcrypt.hash(resetToken, 10);

  // Reuse the same OtpToken doc — overwrite otpHash with the reset token hash
  // and extend expiry by 15 minutes for the reset window
  record.otpHash   = resetTokenHash;
  record.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await record.save();

  res.json({
    status: "success",
    data:   { resetToken }, // frontend holds this in state, sends it back with new password
  });
};

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Accepts the reset token from /verify-otp and sets the new password.
const resetPassword = async (req, res) => {
  const { email, resetToken, newPassword } = req.body;
  if (!email || !resetToken || !newPassword) {
    return res.status(400).json({
      status: "error",
      error:  "Email, resetToken, and newPassword are required.",
    });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({
      status: "error",
      error:  "Password must be at least 6 characters.",
    });
  }

  const record = await OtpToken.findOne({ email: email.toLowerCase() });
  if (!record) {
    return res.status(400).json({ status: "error", error: "Reset token expired. Please start over." });
  }

  const valid = await bcrypt.compare(resetToken, record.otpHash);
  if (!valid) {
    return res.status(400).json({ status: "error", error: "Invalid or expired reset token." });
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  // User model pre-save hook hashes the password automatically
  user.password = newPassword;
  await user.save();

  // Clean up — delete OTP/reset record
  await OtpToken.deleteMany({ email: email.toLowerCase() });

  res.json({ status: "success", message: "Password reset successfully. Please log in." });
};

module.exports = {
  register,
  login,
  getMe,
  updatePassword,
  updatePreferences,
  getQuiz,
  suggestMode,
  updateCognitiveMode,
  forgotPassword,
  verifyOtp,
  resetPassword,
};