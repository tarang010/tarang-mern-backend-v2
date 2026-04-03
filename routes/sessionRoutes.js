// Tarang 1.0.0.1 — routes/sessionRoutes.js
// IMPORTANT: Route order matters in Express.
// Static paths must come BEFORE parameterized paths.
//
// NOTE: /status and /results are now POST because they need
// session_state in the body (read from MongoDB by the controller,
// passed to the stateless bridge).

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
