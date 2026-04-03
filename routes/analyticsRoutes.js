// Tarang 1.0.0.1 — routes/analyticsRoutes.js

const express = require("express");
const router  = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const {
  getAnalytics, getAnalyticsReport, getAllAnalytics,
} = require("../controllers/analyticsController");

// Admin list — must come before /:docId to avoid param collision
router.get("/",              protect, adminOnly, getAllAnalytics);

// Per-document analytics
router.get("/:docId",        protect, getAnalytics);
router.get("/:docId/report", protect, getAnalyticsReport);

module.exports = router;
