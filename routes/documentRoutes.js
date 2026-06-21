// Tarang 2.5.0 — routes/documentRoutes.js
//
// v2.5.0 changes:
//   FIX 3: Added POST /upload/stream — SSE proxy for the Python
//   /pipeline/audio/stream endpoint. Must be declared BEFORE /upload
//   so Express doesn't try to match "stream" as a sub-path of the
//   generic upload handler.
//
//   Route order (Express matches top to bottom):
//     POST /upload/stream   ← FIX 3: new SSE pipeline proxy
//     POST /upload          ← existing multipart upload
//     GET  /by-doc-id/:docId/stream  ← document status SSE
//     GET  /by-doc-id/:docId         ← one-shot status poll
//     ...
//
// IMPORTANT: Specific/static routes MUST come before generic /:id routes.

const express     = require("express");
const multer      = require("multer");
const { protect } = require("../middleware/auth");
const {
  uploadDocument,
  streamAudioPipeline,
  triggerMCQ,
  getDocuments,
  getDocumentByDocId,
  streamDocumentStatus,
  getDocument,
  deleteDocument,
  getCaptions,
  getVisualization,
  downloadAudio,
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

// FIX 3: SSE audio pipeline proxy — MUST be before POST /upload so Express
// doesn't strip "stream" as an ambiguous sub-path.
router.post("/upload/stream", protect, upload.single("file"), streamAudioPipeline);

// Standard upload
router.post("/upload",        protect, upload.single("file"), uploadDocument);

// SSE document status — MUST be before /by-doc-id/:docId
router.get("/by-doc-id/:docId/stream", protect, streamDocumentStatus);

// One-shot poll — kept for backward compat + Postman
router.get("/by-doc-id/:docId",        protect, getDocumentByDocId);

// Download Audio
router.get("/:docId/download", protect, downloadAudio)

// ── /:docId sub-routes ────────────────────────────────────────────────────────
router.post("/:docId/trigger-mcq",   protect, triggerMCQ);
router.get ("/:docId/captions",      protect, getCaptions);
router.get ("/:docId/visualization", protect, getVisualization);

// ── Generic /:id routes LAST ──────────────────────────────────────────────────
router.get   ("/:id", protect, getDocument);
router.delete("/:id", protect, deleteDocument);

module.exports = router;