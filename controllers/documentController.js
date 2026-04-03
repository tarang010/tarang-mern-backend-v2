// Tarang 1.0.0.1 — controllers/documentController.js
// TWO-PHASE PIPELINE:
//   Phase 1 (/pipeline/audio)  — runs in background after upload → 202 response
//   Phase 2 (/pipeline/mcq)    — runs in background when user clicks Play
//
// Frontend polls GET /api/documents/by-doc-id/:docId every 3s
// until pipelineStatus === "audio_ready" before showing the player.

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, wakeBridge }              = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");

// Pipeline timeout — 20 minutes.
// Covers worst case: 200KB+ PDF → 2500+ words → 22min audio → modulation.
// Axios timeout on FormData streams must be set via this constant AND passed
// explicitly on every bridge.post() call — do not rely on the axios default.
const PIPELINE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes


// ── POST /api/documents/upload ────────────────────────────────────────────────
// Responds 202 immediately. Full pipeline runs in background via setImmediate.
const uploadDocument = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ status: "error", error: "No file uploaded." });
  }

  const {
    cognitiveState = "deep_focus",
    documentTitle  = req.file.originalname.replace(/\.[^.]+$/, ""),
    ttsEngine      = "edge",
    voiceId        = "",
  } = req.body;

  const crypto    = require("crypto");
  const tempDocId = crypto
    .createHash("md5")
    .update(req.file.originalname + String(req.user._id) + Date.now())
    .digest("hex")
    .slice(0, 12);

  // ── Save doc immediately with status "processing" ─────────────────────────
  const doc = await Document.findOneAndUpdate(
    { docId: tempDocId, userId: req.user._id },
    {
      $set: {
        userId:            req.user._id,
        docId:             tempDocId,
        title:             documentTitle,
        originalFilename:  req.file.originalname,
        format:            req.file.originalname.split(".").pop().toLowerCase(),
        cognitiveState,
        ttsEngine,
        pipelineStatus:    "processing",
        pipelineError:     null,
        sessionsGenerated: 0,
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`→ Upload received | docId=${tempDocId} | file=${req.file.originalname} | size=${req.file.size}B`);

  // ── Respond 202 immediately ───────────────────────────────────────────────
  res.status(202).json({
    status: "success",
    data: {
      document: doc,
      phase:    "processing",
      message:  "Upload received. Processing audio in background.",
    },
  });

  // ── Capture values needed in background before req/res go out of scope ────
  const fileBuffer   = req.file.buffer;
  const fileOrigName = req.file.originalname;
  const fileMimetype = req.file.mimetype;
  const userId       = req.user._id;
  const userRole     = req.user.role;

  // ── Run Phase 1 pipeline in background ────────────────────────────────────
  setImmediate(async () => {
    try {
      console.log(`→ Background Phase 1 START | docId=${tempDocId}`);

      // ── Wake bridge first — absorbs cold start on free tier ──────────────
      // This polls /health until the Python pod responds (up to 90s).
      // If the bridge is already warm this returns in < 1s.
      await wakeBridge();

      const FormData = require("form-data");
      const form     = new FormData();
      form.append("file", fileBuffer, {
        filename:    fileOrigName,
        contentType: fileMimetype,
      });
      form.append("cognitive_state", cognitiveState);
      form.append("document_title",  documentTitle);
      form.append("tts_engine",      ttsEngine);
      form.append("role",            userRole);
      if (voiceId) form.append("voice_id", voiceId);

      // ── Build axios config explicitly ─────────────────────────────────────
      // timeout must be set here AND on the axios instance.
      // For multipart streams, axios applies the timeout to the entire
      // request lifecycle only when passed directly — not from defaults.
      const axiosConfig = {
        headers:          form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        timeout:          PIPELINE_TIMEOUT_MS,
        // Disable axios response data size limit — MP3 base64 can be large
        responseType:     "json",
      };

      console.log(`→ Calling bridge /pipeline/audio | docId=${tempDocId} | timeout=${PIPELINE_TIMEOUT_MS / 60000}min`);
      const { data: bridgeRes } = await bridge.post("/pipeline/audio", form, axiosConfig);

      const pd = bridgeRes.data;
      console.log(`✓ Bridge response | docId=${tempDocId} | words=${pd.word_count} | duration=${pd.duration_sec}s`);

      // ── Upload audio to Cloudinary ────────────────────────────────────────
      let audioCloudUrl = null;
      let audioPublicId = null;

      if (isConfigured() && pd.mp3_b64) {
        try {
          console.log(`→ Uploading to Cloudinary | docId=${tempDocId} | size=${Math.round(pd.mp3_b64.length * 0.75 / 1024)}KB`);
          const mp3Buffer = Buffer.from(pd.mp3_b64, "base64");
          const uploaded  = await uploadAudioBuffer(mp3Buffer, {
            folder:        `tarang/audio/${userId}`,
            publicId:      `${tempDocId}_modulated`,
            resource_type: "video",
          });
          audioCloudUrl = uploaded.url;
          audioPublicId = uploaded.publicId;
          console.log(`✓ Cloudinary OK | docId=${tempDocId} | url=${audioCloudUrl}`);
        } catch (e) {
          console.error(`✗ Cloudinary failed (non-fatal) | docId=${tempDocId} |`, e.message);
        }
      }

      // ── Update document — Phase 1 complete ───────────────────────────────
      await Document.findOneAndUpdate(
        { docId: tempDocId, userId },
        {
          $set: {
            title:               pd.document_title || documentTitle,
            wordCount:           pd.word_count,
            durationSec:         pd.duration_sec,
            extractedText:       pd.extracted_text,
            beatFreqHz:          pd.beat_freq_hz,
            pipelineStatus:      "audio_ready",
            pipelineError:       null,
            audioCloudUrl,
            audioPublicId,
            captions:            pd.captions?.length ? pd.captions : null,
            captionsGeneratedAt: pd.captions?.length ? new Date() : null,
            extractedPath:       null,
            ttsWavPath:          null,
            modulatedWavPath:    null,
            visualizationPath:   null,
          }
        }
      );

      console.log(`✓ Phase 1 COMPLETE | docId=${tempDocId} | status=audio_ready`);

    } catch (err) {
      // Log full error details so we can see if it's a timeout vs crash
      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      console.error(
        `✗ Phase 1 FAILED | docId=${tempDocId} | type=${isTimeout ? "TIMEOUT" : "ERROR"} | ${err.message}`
      );
      await Document.findOneAndUpdate(
        { docId: tempDocId, userId },
        { $set: { pipelineStatus: "error", pipelineError: err.message || "Pipeline failed" } }
      );
    }
  });
};


// ── POST /api/documents/:docId/trigger-mcq ────────────────────────────────────
// Called when user clicks Play. MCQ runs in background.
const triggerMCQ = async (req, res) => {
  const { docId } = req.params;

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const existingSessions = await Session.countDocuments({ docId, userId: req.user._id });
  if (existingSessions >= 3) {
    return res.json({ status: "success", data: { message: "MCQ already generated." } });
  }

  if (!doc.extractedText || doc.extractedText.split(" ").length < 50) {
    return res.json({ status: "success", data: { message: "Document too short for MCQ." } });
  }

  // Respond immediately
  res.json({ status: "success", data: { message: "MCQ generation started in background." } });

  setImmediate(async () => {
    try {
      console.log(`→ Background MCQ START | docId=${docId}`);

      const { data: mcqRes } = await bridge.post("/pipeline/mcq", {
        extracted_text: doc.extractedText,
        document_title: doc.title,
        doc_id:         docId,
      }, {
        timeout: PIPELINE_TIMEOUT_MS,  // MCQ generation (OpenAI calls) can also be slow
      });

      const md           = mcqRes.data;
      const difficulties = { 1: "Easy", 2: "Medium", 3: "Hard" };

      for (const n of [1, 2, 3]) {
        const qData = md[`session_${n}_questions`];
        const aData = md[`session_${n}_answers`];
        await Session.findOneAndUpdate(
          { docId, userId: req.user._id, sessionNumber: n },
          {
            $set: {
              userId:        req.user._id,
              documentId:    doc._id,
              docId,
              sessionNumber: n,
              difficulty:    difficulties[n],
              status:        n === 1 ? "pending" : "locked",
              startedAt:     null,
              submittedAt:   null,
              scorePct:      null,
              correctCount:  0,
              userAnswers:   {},
              overrideUsed:  false,
              questions:     qData?.questions || [],
              answerKey:     aData            || null,
              sessionState:  md.session_state || null,
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      await Document.findOneAndUpdate(
        { docId },
        { $set: { sessionsGenerated: md.sessions_generated, pipelineStatus: "ready" } }
      );

      console.log(`✓ Background MCQ COMPLETE | docId=${docId} | sessions=3`);
    } catch (err) {
      console.error(`✗ Background MCQ FAILED | docId=${docId} |`, err.message);
      await Document.findOneAndUpdate(
        { docId },
        { $set: { pipelineError: `MCQ generation failed: ${err.message}` } }
      );
    }
  });
};


// ── GET /api/documents ────────────────────────────────────────────────────────
const getDocuments = async (req, res) => {
  const docs = await Document.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .select("-extractedText -visualizationHtml -captions");
  res.json({ status: "success", data: { documents: docs } });
};


// ── GET /api/documents/by-doc-id/:docId ──────────────────────────────────────
// Used by frontend polling to check pipelineStatus during background processing
const getDocumentByDocId = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }
  res.json({ status: "success", data: { document: doc } });
};


// ── GET /api/documents/:id ────────────────────────────────────────────────────
const getDocument = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }
  res.json({ status: "success", data: { document: doc } });
};


// ── DELETE /api/documents/:id ─────────────────────────────────────────────────
const deleteDocument = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }
  if (doc.audioPublicId && isConfigured()) {
    try {
      const { deleteAudio } = require("../config/cloudinary");
      await deleteAudio(doc.audioPublicId);
    } catch (e) {
      console.error("Cloudinary delete failed (non-fatal):", e.message);
    }
  }
  await Session.deleteMany({ documentId: doc._id });
  await doc.deleteOne();
  res.json({ status: "success", data: { message: "Document deleted." } });
};


// ── GET /api/documents/:docId/captions ───────────────────────────────────────
const getCaptions = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }
  if (doc.captions && doc.captions.length > 0) {
    return res.json({
      status: "success",
      data: { captions: doc.captions, total: doc.captions.length, cached: true, generatedAt: doc.captionsGeneratedAt },
    });
  }
  if (!doc.extractedText || !doc.durationSec) {
    return res.status(404).json({ status: "error", error: "Captions not available." });
  }
  const { data } = await bridge.post("/captions", { text: doc.extractedText, duration_sec: doc.durationSec });
  const result   = data.data;
  await Document.findOneAndUpdate({ docId }, { captions: result.captions, captionsGeneratedAt: new Date() });
  res.json({ status: "success", data: { captions: result.captions, total: result.total_segments, cached: false } });
};


// ── GET /api/documents/:docId/visualization ───────────────────────────────────
const getVisualization = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id }).select("visualizationHtml visualizationType title");
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });
  if (!doc.visualizationHtml) return res.status(404).json({ status: "error", error: "Visualization not available." });
  res.setHeader("Content-Type", "text/html");
  res.send(doc.visualizationHtml);
};


module.exports = {
  uploadDocument,
  triggerMCQ,
  getDocuments,
  getDocumentByDocId,
  getDocument,
  deleteDocument,
  getCaptions,
  getVisualization,
};
