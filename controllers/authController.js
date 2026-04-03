// Tarang 2.0.0 — controllers/authController.js

const User              = require("../models/User");
const { generateToken } = require("../utils/jwt");
const { bridge }        = require("../config/bridge");

// ── POST /api/auth/register ───────────────────────────────────────────────────
const register = async (req, res) => {
  const { name, email, password } = req.body;

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
        id:                   user._id,
        name:                 user.name,
        email:                user.email,
        role:                 user.role,
        preferredCognitiveMode: user.preferredCognitiveMode,
      },
    },
  });
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
const login = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select("+password");
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({
      status: "error",
      error:  "Invalid email or password.",
    });
  }

  if (!user.isActive) {
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
        id:                   user._id,
        name:                 user.name,
        email:                user.email,
        role:                 user.role,
        preferredCognitiveMode: user.preferredCognitiveMode,
      },
    },
  });
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  res.json({
    status: "success",
    data: { user: req.user },
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
    return res.status(400).json({ status: "error", error: "Invalid theme. Use 'dark' or 'light'." });
  }
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { ...(themePreference && { themePreference }) } },
    { new: true }
  );
  res.json({ status: "success", data: { user } });
};

// ── GET /api/auth/quiz ─────────────────────────────────────────────────────────
// Proxy to bridge GET /quiz — returns personality quiz questions
const getQuiz = async (req, res) => {
  const { data: bridgeRes } = await bridge.get("/quiz");
  res.json({ status: "success", data: bridgeRes.data });
};

// ── POST /api/auth/suggest-mode ───────────────────────────────────────────────
// Proxy to bridge POST /suggest-mode — saves result to user profile
const suggestMode = async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ status: "error", error: "answers dict is required." });
  }

  const { data: bridgeRes } = await bridge.post("/suggest-mode", { answers });
  const result = bridgeRes.data;

  // Persist result to user profile
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
// Manual override — user picks mode from profile settings page
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