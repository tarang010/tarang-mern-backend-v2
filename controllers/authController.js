// Tarang 2.2.0 — controllers/authController.js
//
// v2.2.0 fix:
//   generateToken now reads JWT_SECRET from process.env directly as the
//   primary source. initJwtSecret() in server.js was regenerating a new
//   in-memory secret on every Render cold start / redeploy, invalidating
//   all existing tokens and causing 401 on login for returning users.
//   Fix: if JWT_SECRET env var is set, always use it — never override it.

const User              = require("../models/User");
const { generateToken } = require("../utils/jwt");
const { bridgePost }    = require("../config/bridge");

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
const getQuiz = async (req, res) => {
  const { data: bridgeRes } = await bridgePost("/quiz", {});
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

module.exports = {
  register, login, getMe,
  updatePassword, updatePreferences,
  getQuiz, suggestMode, updateCognitiveMode,
};
