// Tarang 2.3.0 — routes/authRoutes.js
// Place at: backend/routes/authRoutes.js
//
// v2.3.0 additions:
//   POST /verify-signup-otp  — confirms email after register
//   POST /verify-login-otp   — completes login after OTP

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");

const {
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
} = require("../controllers/authController");

// ── Public routes ─────────────────────────────────────────────────────────────

// Registration + email verification
router.post("/register",           register);
router.post("/verify-signup-otp",  verifySignupOtp);

// Login + OTP step
router.post("/login",              login);
router.post("/verify-login-otp",   verifyLoginOtp);

// Forgot-password flow
router.post("/forgot-password",    forgotPassword);
router.post("/verify-otp",         verifyOtp);
router.post("/reset-password",     resetPassword);

// ── Protected routes ──────────────────────────────────────────────────────────
router.get ("/me",                 protect, getMe);
router.put ("/password",           protect, updatePassword);
router.put ("/preferences",        protect, updatePreferences);

// Cognitive mode
router.get ("/quiz",               protect, getQuiz);
router.post("/suggest-mode",       protect, suggestMode);
router.put ("/cognitive-mode",     protect, updateCognitiveMode);
router.put ("/onboarding",         protect, completeOnboarding);

module.exports = router;