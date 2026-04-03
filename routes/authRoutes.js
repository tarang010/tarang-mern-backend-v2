// Tarang 2.0.0 — routes/authRoutes.js

const express = require("express");
const router  = express.Router();
const { protect, adminOnly } = require("../middleware/auth");

const {
  register,
  login,
  getMe,
  updatePassword,
  updatePreferences,
  getQuiz,
  suggestMode,
  updateCognitiveMode,
} = require("../controllers/authController");

// Public
router.post("/register", register);
router.post("/login",    login);

// Protected
router.get ("/me",               protect, getMe);
router.put ("/password",         protect, updatePassword);
router.put ("/preferences",      protect, updatePreferences);

// Cognitive mode quiz (v2.0.0)
router.get ("/quiz",             protect, getQuiz);
router.post("/suggest-mode",     protect, suggestMode);
router.put ("/cognitive-mode",   protect, updateCognitiveMode);

module.exports = router;
