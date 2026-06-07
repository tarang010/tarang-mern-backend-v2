// Tarang 2.3.0 — controllers/authController.js
// Place at: backend/controllers/authController.js
//
// v2.3.0 changes:
//   register()          — sends signup OTP instead of issuing JWT immediately.
//                         Returns { status: "pending_verification", email }.
//                         FIX: if account exists but unverified, update name +
//                         password to what the user just submitted before
//                         re-sending OTP (previously stale credentials were kept).
//   verifySignupOtp()   — NEW. Verifies signup OTP, marks isEmailVerified,
//                         issues JWT and returns user + token.
//   login()             — checks isEmailVerified first, then sends login OTP
//                         instead of issuing JWT immediately.
//                         Returns { status: "pending_otp", email }.
//   verifyLoginOtp()    — NEW. Verifies login OTP, updates lastLoginAt,
//                         issues JWT and returns user + token.
//   forgotPassword()    — unchanged in behaviour, now passes purpose: "password_reset"
//   verifyOtp()         — scoped to purpose: "password_reset"
//   resetPassword()     — unchanged
//   All other handlers  — unchanged

const crypto            = require("crypto");
const bcrypt            = require("bcryptjs");
const User              = require("../models/User");
const OtpToken          = require("../models/OtpToken");
const { generateToken } = require("../utils/jwt");
const {
  sendOtpEmail,
  sendSignupOtpEmail,
  sendLoginOtpEmail,
} = require("../utils/mailer");
const { bridge, bridgePost } = require("../config/bridge");

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const BACKGROUND_SPECIALIZATIONS = {
  engineering: {
    coding:       { track: "Engineering - CSE",         practiceMode: "code_lab",            primaryWidget: "mini_ide",          enableMiniIde: true  },
    electronics:  { track: "Engineering - Electronics", practiceMode: "systems_lab",          primaryWidget: "problem_sets",      enableMiniIde: false },
    mechanics:    { track: "Engineering - Mechanical",  practiceMode: "problem_solving",      primaryWidget: "concept_checks",    enableMiniIde: false },
    civil:        { track: "Engineering - Civil",       practiceMode: "case_review",          primaryWidget: "formula_revision",  enableMiniIde: false },
    data_science: { track: "Engineering - Data",        practiceMode: "code_lab",             primaryWidget: "mini_ide",          enableMiniIde: true  },
  },
  commerce: {
    finance:         { track: "Commerce - Finance",     practiceMode: "case_review",          primaryWidget: "scenario_cards",    enableMiniIde: false },
    accounting:      { track: "Commerce - Accounting",  practiceMode: "worked_examples",      primaryWidget: "formula_revision",  enableMiniIde: false },
    marketing:       { track: "Commerce - Marketing",   practiceMode: "case_review",          primaryWidget: "campaign_analysis", enableMiniIde: false },
    entrepreneurship:{ track: "Commerce - Startup",     practiceMode: "strategy_review",      primaryWidget: "scenario_cards",    enableMiniIde: false },
  },
  medical: {
    anatomy:      { track: "Medical - Anatomy",         practiceMode: "recall_drills",        primaryWidget: "weak_topic_recall", enableMiniIde: false },
    clinical:     { track: "Medical - Clinical",        practiceMode: "differential_reasoning",primaryWidget: "case_review",      enableMiniIde: false },
    pharmacology: { track: "Medical - Pharmacology",    practiceMode: "recall_drills",        primaryWidget: "formula_revision",  enableMiniIde: false },
    research:     { track: "Medical - Research",        practiceMode: "critical_reading",     primaryWidget: "concept_checks",    enableMiniIde: false },
  },
  law: {
    litigation:    { track: "Law - Litigation",         practiceMode: "argument_drills",      primaryWidget: "case_review",       enableMiniIde: false },
    corporate:     { track: "Law - Corporate",          practiceMode: "clause_review",        primaryWidget: "scenario_cards",    enableMiniIde: false },
    constitutional:{ track: "Law - Constitutional",     practiceMode: "principle_application",primaryWidget: "concept_checks",    enableMiniIde: false },
    judiciary:     { track: "Law - Judiciary",          practiceMode: "precedent_review",     primaryWidget: "case_review",       enableMiniIde: false },
  },
};

const sanitizeAcademicProfile = (payload = {}) => {
  const background = ["engineering", "commerce", "medical", "law", "other"].includes(payload.background)
    ? payload.background : null;
  const specialization = typeof payload.specialization === "string"
    ? payload.specialization.trim().toLowerCase().replace(/\s+/g, "_") : "";
  const focusAreas = Array.isArray(payload.focusAreas)
    ? payload.focusAreas.map((i) => String(i || "").trim()).filter(Boolean).slice(0, 5) : [];
  const dashboardConfig =
    (background && BACKGROUND_SPECIALIZATIONS[background]?.[specialization]) || {
      track:         background ? `${background[0].toUpperCase()}${background.slice(1)} learner` : "General learner",
      practiceMode:  background === "other" ? "guided_revision" : "active_recall",
      primaryWidget: "concept_checks",
      enableMiniIde: false,
    };
  return {
    background,
    backgroundOther: background === "other" ? String(payload.backgroundOther || "").trim().slice(0, 80) : "",
    specialization,
    focusAreas,
    answers:         payload.answers && typeof payload.answers === "object" ? payload.answers : null,
    dashboardConfig,
  };
};

const serializeUser = (user) => ({
  id:                     user._id,
  name:                   user.name,
  email:                  user.email,
  role:                   user.role,
  isEmailVerified:        user.isEmailVerified,
  themePreference:        user.themePreference,
  preferredCognitiveMode: user.preferredCognitiveMode,
  cognitiveQuizTakenAt:   user.cognitiveQuizTakenAt,
  onboardingCompleted:    user.onboardingCompleted,
  onboardingCompletedAt:  user.onboardingCompletedAt,
  academicProfile:        user.academicProfile || null,
});

/**
 * Generate, hash and store an OTP for the given email + purpose.
 * Deletes any existing OTP for the same email+purpose first.
 * Returns the plaintext OTP (to be emailed — never stored).
 */
const _issueOtp = async (email, purpose) => {
  await OtpToken.deleteMany({ email: email.toLowerCase(), purpose });
  const otp       = String(crypto.randomInt(100000, 999999));
  const otpHash   = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await OtpToken.create({ email: email.toLowerCase(), otpHash, purpose, expiresAt });
  return otp;
};

/**
 * Verify an OTP for a given email + purpose.
 * Returns the OtpToken document on success, throws on failure.
 */
const _verifyOtp = async (email, otp, purpose) => {
  const record = await OtpToken.findOne({ email: email.toLowerCase(), purpose });
  if (!record) {
    const err = new Error("OTP expired or not requested.");
    err.status = 400;
    throw err;
  }
  const valid = await bcrypt.compare(String(otp), record.otpHash);
  if (!valid) {
    const err = new Error("Invalid OTP. Please check and try again.");
    err.status = 400;
    throw err;
  }
  return record;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// v2.3.0: Creates account (isEmailVerified: false) then sends signup OTP.
//         Does NOT issue a JWT — that happens in verifySignupOtp.
//
// FIX: If an unverified account already exists for this email, update the
//      stored name + password to match the new submission before re-sending
//      the OTP. Previously the old (possibly wrong) credentials were kept,
//      meaning verifySignupOtp would log the user in with stale data.
// ─────────────────────────────────────────────────────────────────────────────
const register = async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ status: "error", error: "Name, email and password are required." });
  }

  const exists = await User.findOne({ email: email.toLowerCase() });

  if (exists) {
    // Account exists and is already verified — hard stop.
    if (exists.isEmailVerified) {
      return res.status(409).json({ status: "error", error: "An account with this email already exists." });
    }

    // Account exists but email not yet verified.
    // Update name + password to whatever the user just submitted so that
    // verifySignupOtp logs them in with the correct, current credentials.
    exists.name     = name.trim();
    exists.password = password;           // model pre-save hook will re-hash
    await exists.save();

    const otp = await _issueOtp(exists.email, "email_verification");
    await sendSignupOtpEmail(exists.email, otp, exists.name);

    return res.status(200).json({
      status:  "pending_verification",
      message: "Account exists but email not verified. A new OTP has been sent.",
      email:   exists.email,
    });
  }

  // Brand-new account
  const user = await User.create({ name, email, password, isEmailVerified: false });
  const otp  = await _issueOtp(user.email, "email_verification");
  await sendSignupOtpEmail(user.email, otp, user.name);

  res.status(201).json({
    status:  "pending_verification",
    message: "Account created. Please check your email for a 6-digit verification OTP.",
    email:   user.email,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-signup-otp
// Verifies the email confirmation OTP, marks account as verified, issues JWT.
// ─────────────────────────────────────────────────────────────────────────────
const verifySignupOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ status: "error", error: "Email and OTP are required." });
  }

  let record;
  try {
    record = await _verifyOtp(email, otp, "email_verification");
  } catch (err) {
    return res.status(err.status || 400).json({ status: "error", error: err.message });
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  user.isEmailVerified = true;
  user.emailVerifiedAt = new Date();
  user.lastLoginAt     = new Date();
  await user.save({ validateBeforeSave: false });

  // Clean up OTP record
  await OtpToken.deleteMany({ email: email.toLowerCase(), purpose: "email_verification" });

  const token = generateToken(user._id);

  res.status(200).json({
    status: "success",
    data: {
      token,
      user: serializeUser(user),
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// v2.3.0: Checks credentials + isEmailVerified, then sends login OTP.
//         Does NOT issue a JWT — that happens in verifyLoginOtp.
// ─────────────────────────────────────────────────────────────────────────────
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ status: "error", error: "Email and password are required." });
  }

  const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ status: "error", error: "Invalid email or password." });
  }

  if (user.isActive === false) {
    return res.status(401).json({ status: "error", error: "Account is deactivated. Contact support." });
  }

  // Email must be verified before login is allowed
  if (!user.isEmailVerified) {
    // Re-send verification OTP so they can complete signup
    const otp = await _issueOtp(user.email, "email_verification");
    await sendSignupOtpEmail(user.email, otp, user.name);
    return res.status(403).json({
      status:  "email_not_verified",
      message: "Please verify your email first. A new OTP has been sent.",
      email:   user.email,
    });
  }

  // Credentials valid — send login OTP
  const otp = await _issueOtp(user.email, "login");
  await sendLoginOtpEmail(user.email, otp, user.name);

  res.status(200).json({
    status:  "pending_otp",
    message: "A sign-in OTP has been sent to your email.",
    email:   user.email,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-login-otp
// Verifies the login OTP, updates lastLoginAt, issues JWT.
// ─────────────────────────────────────────────────────────────────────────────
const verifyLoginOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ status: "error", error: "Email and OTP are required." });
  }

  let record;
  try {
    record = await _verifyOtp(email, otp, "login");
  } catch (err) {
    return res.status(err.status || 400).json({ status: "error", error: err.message });
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  // Clean up OTP record
  await OtpToken.deleteMany({ email: email.toLowerCase(), purpose: "login" });

  const token = generateToken(user._id);

  res.status(200).json({
    status: "success",
    data: {
      token,
      user: serializeUser(user),
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  res.json({ status: "success", data: { user: req.user } });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/auth/password
// ─────────────────────────────────────────────────────────────────────────────
const updatePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select("+password");
  if (!(await user.matchPassword(currentPassword))) {
    return res.status(401).json({ status: "error", error: "Current password is incorrect." });
  }
  user.password = newPassword;
  await user.save();
  const token = generateToken(user._id);
  res.json({ status: "success", data: { token, message: "Password updated successfully." } });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/auth/preferences
// ─────────────────────────────────────────────────────────────────────────────
const updatePreferences = async (req, res) => {
  const { themePreference, tutorTone, tutorEnabled } = req.body;
  if (themePreference && !["dark", "light"].includes(themePreference)) {
    return res.status(400).json({ status: "error", error: "Invalid theme. Use 'dark' or 'light'." });
  }
  const update = {};
  if (themePreference) update.themePreference = themePreference;
  if (typeof tutorTone === "string")    update["academicProfile.dashboardConfig.tutorTone"]    = tutorTone.trim().slice(0, 32);
  if (typeof tutorEnabled === "boolean") update["academicProfile.dashboardConfig.tutorEnabled"] = tutorEnabled;
  const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, { new: true });
  res.json({ status: "success", data: { user: serializeUser(user) } });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/quiz
// ─────────────────────────────────────────────────────────────────────────────
const getQuiz = async (req, res) => {
  const { data: bridgeRes } = await bridge.get("/quiz");
  res.json({ status: "success", data: bridgeRes.data });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/suggest-mode
// ─────────────────────────────────────────────────────────────────────────────
const suggestMode = async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ status: "error", error: "answers dict is required." });
  }
  const { data: bridgeRes } = await bridgePost("/suggest-mode", { answers });
  const result = bridgeRes.data;
  const user = await User.findByIdAndUpdate(req.user._id, {
    $set: {
      preferredCognitiveMode: result.recommended_mode,
      cognitiveQuizAnswers:   answers,
      cognitiveQuizTakenAt:   new Date(),
    },
  }, { new: true });
  res.json({ status: "success", data: { ...result, user: serializeUser(user) } });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/auth/cognitive-mode
// ─────────────────────────────────────────────────────────────────────────────
const updateCognitiveMode = async (req, res) => {
  const { mode } = req.body;
  const valid = ["deep_focus", "memory", "calm", "deep_relaxation", "sleep"];
  if (!valid.includes(mode)) {
    return res.status(400).json({ status: "error", error: `Invalid mode. Must be one of: ${valid.join(", ")}` });
  }
  const user = await User.findByIdAndUpdate(req.user._id, { $set: { preferredCognitiveMode: mode } }, { new: true });
  res.json({ status: "success", data: { user: serializeUser(user) } });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/auth/onboarding
// ─────────────────────────────────────────────────────────────────────────────
const completeOnboarding = async (req, res) => {
  const academicProfile        = sanitizeAcademicProfile(req.body.academicProfile || req.body);
  const preferredCognitiveMode = typeof req.body.preferredCognitiveMode === "string"
    ? req.body.preferredCognitiveMode : undefined;
  const update = { academicProfile, onboardingCompleted: true, onboardingCompletedAt: new Date() };
  if (preferredCognitiveMode) update.preferredCognitiveMode = preferredCognitiveMode;
  const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, { new: true });
  res.json({ status: "success", data: { user: serializeUser(user), dashboardConfig: academicProfile.dashboardConfig } });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// v2.3.0: purpose scoped to "password_reset"
// ─────────────────────────────────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ status: "error", error: "Email is required." });
  }

  const user = await User.findOne({ email: email.toLowerCase() });

  // Always same response — prevents email enumeration
  if (!user) {
    return res.status(200).json({ status: "success", message: "If this email is registered, an OTP has been sent." });
  }

  const otp = await _issueOtp(user.email, "password_reset");
  await sendOtpEmail(user.email, otp);

  res.status(200).json({ status: "success", message: "If this email is registered, an OTP has been sent." });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-otp  (password reset only)
// v2.3.0: scoped to purpose "password_reset"
// ─────────────────────────────────────────────────────────────────────────────
const verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ status: "error", error: "Email and OTP are required." });
  }

  let record;
  try {
    record = await _verifyOtp(email, otp, "password_reset");
  } catch (err) {
    return res.status(err.status || 400).json({ status: "error", error: err.message });
  }

  // Issue a one-time reset token — overwrite OTP hash with its hash
  const resetToken     = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = await bcrypt.hash(resetToken, 10);

  record.otpHash   = resetTokenHash;
  record.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await record.save();

  res.json({ status: "success", data: { resetToken } });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const { email, resetToken, newPassword } = req.body;
  if (!email || !resetToken || !newPassword) {
    return res.status(400).json({ status: "error", error: "Email, resetToken, and newPassword are required." });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ status: "error", error: "Password must be at least 6 characters." });
  }

  const record = await OtpToken.findOne({ email: email.toLowerCase(), purpose: "password_reset" });
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

  user.password = newPassword;
  await user.save();

  await OtpToken.deleteMany({ email: email.toLowerCase(), purpose: "password_reset" });

  res.json({ status: "success", message: "Password reset successfully. Please log in." });
};

module.exports = {
  register,
  verifySignupOtp,
  login,
  verifyLoginOtp,
  getMe,
  updatePassword,
  updatePreferences,
  getQuiz,
  suggestMode,
  updateCognitiveMode,
  completeOnboarding,
  forgotPassword,
  verifyOtp,
  resetPassword,
};