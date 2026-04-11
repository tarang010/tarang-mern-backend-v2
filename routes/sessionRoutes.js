// Tarang 2.2.0 — routes/sessionRoutes.js
// No route changes in v2.2.0.
// Duplicate /status calls are handled inside sessionController.js via
// in-flight dedup + 2s cache — no route-level changes needed.
//
// IMPORTANT: Route order matters in Express.
// Static paths must come BEFORE parameterized paths.

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const {
  audioDone, getStatus, getQuestions,
  overrideWindow, submitTest, getResults,
} = require("../controllers/sessionController");

// Static paths first — before any :param routes
router.post("/audio-done",                protect, audioDone);

// :docId static sub-routes — must come before /:docId/:session
router.get( "/:docId/status",             protect, getStatus);
router.get( "/:docId/results",            protect, getResults);
router.post("/:docId/override",           protect, overrideWindow);

// :docId + :session routes last
router.post("/:docId/:session/questions", protect, getQuestions);
router.post("/:docId/:session/submit",    protect, submitTest);

module.exports = router;
