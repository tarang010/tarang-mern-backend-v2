// Tarang 1.0.0.1 — routes/documentRoutes.js
// IMPORTANT: Specific routes MUST come before generic /:id routes in Express.
// Otherwise /:id swallows all specific paths like /by-doc-id/xxx, /upload etc.

const express     = require("express");
const multer      = require("multer");
const { protect } = require("../middleware/auth");
const {
  uploadDocument,
  triggerMCQ,
  getDocuments,
  getDocument,
  getDocumentByDocId,
  deleteDocument,
  getCaptions,
  getVisualization,
} = require("../controllers/documentController");

const router  = express.Router();
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, _file, cb) => cb(null, true), // validate in controller
});

// ── Static / specific routes FIRST (before any /:param routes) ───────────────

// List all documents
router.get("/", protect, getDocuments);

// Upload new document — multipart
router.post("/upload", protect, upload.single("file"), uploadDocument);

// Poll pipelineStatus — MUST be before /:id
router.get("/by-doc-id/:docId", protect, getDocumentByDocId);

// ── /:docId sub-routes — MUST be before /:id ─────────────────────────────────
router.post("/:docId/trigger-mcq",   protect, triggerMCQ);
router.get ("/:docId/captions",      protect, getCaptions);
router.get ("/:docId/visualization", protect, getVisualization);

// ── Generic /:id routes LAST ──────────────────────────────────────────────────
router.get   ("/:id", protect, getDocument);
router.delete("/:id", protect, deleteDocument);

module.exports = router;
