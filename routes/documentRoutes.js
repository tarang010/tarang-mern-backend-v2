// Tarang 2.2.0 — routes/documentRoutes.js
//
// v2.2.0 change:
//   Added GET /by-doc-id/:docId/stream — SSE endpoint that replaces the
//   frontend polling loop. Must be declared BEFORE /by-doc-id/:docId so
//   Express doesn't treat "stream" as a docId value.
//
// IMPORTANT: Specific routes MUST come before generic /:id routes in Express.

const express     = require("express");
const multer      = require("multer");
const { protect } = require("../middleware/auth");
const {
  uploadDocument,
  triggerMCQ,
  getDocuments,
  getDocumentByDocId,
  streamDocumentStatus,
  getDocument,
  deleteDocument,
  getCaptions,
  getVisualization,
} = require("../controllers/documentController");

const router  = express.Router();
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => cb(null, true),
});

// ── Static / specific routes FIRST ───────────────────────────────────────────

router.get("/",        protect, getDocuments);
router.post("/upload", protect, upload.single("file"), uploadDocument);

// SSE stream — must come BEFORE /by-doc-id/:docId so Express doesn't
// match "stream" as the docId parameter on the one-shot route below.
router.get("/by-doc-id/:docId/stream", protect, streamDocumentStatus);

// One-shot poll — kept for backward compat, Postman, mobile
router.get("/by-doc-id/:docId",        protect, getDocumentByDocId);

// ── /:docId sub-routes ────────────────────────────────────────────────────────
router.post("/:docId/trigger-mcq",   protect, triggerMCQ);
router.get ("/:docId/captions",      protect, getCaptions);
router.get ("/:docId/visualization", protect, getVisualization);

// ── Generic /:id routes LAST ──────────────────────────────────────────────────
router.get   ("/:id", protect, getDocument);
router.delete("/:id", protect, deleteDocument);

module.exports = router;
