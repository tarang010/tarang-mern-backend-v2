// Tarang 2.2.0 — routes/authRoutes.js
// Place at: backend/routes/authRoutes.js

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");

const {
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
} = require("../controllers/authController");

// ── Public routes ─────────────────────────────────────────────────────────────
router.post("/register",        register);
router.post("/login",           login);

// Password reset flow (no auth required — user is locked out)
router.post("/forgot-password", forgotPassword);
router.post("/verify-otp",      verifyOtp);
router.post("/reset-password",  resetPassword);

// ── Protected routes ──────────────────────────────────────────────────────────
router.get ("/me",              protect, getMe);
router.put ("/password",        protect, updatePassword);
router.put ("/preferences",     protect, updatePreferences);

// Cognitive mode quiz
router.get ("/quiz",            protect, getQuiz);
router.post("/suggest-mode",    protect, suggestMode);
router.put ("/cognitive-mode",  protect, updateCognitiveMode);

module.exports = router;