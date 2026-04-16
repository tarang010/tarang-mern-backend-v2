// Tarang 2.3.0 — controllers/documentController.js
//
// v2.3.0 fix: BRIDGE BUSY → 503
//   When a large PDF (devops.pdf, 6+ min) is processing, any new upload
//   immediately got 503 because the bridge was occupied.
//
//   Fix: before calling /pipeline/audio, poll GET /status on the bridge
//   every BRIDGE_BUSY_POLL_MS until it's free or BRIDGE_BUSY_MAX_WAIT_MS
//   elapses. This means a second user uploading while the first is still
//   processing will simply wait in the Node background task rather than
//   failing instantly.
//
//   This is safe because uploadDocument already responds 202 immediately —
//   the user sees "Processing" on the dashboard while we wait for the bridge.
//
// All other behavior unchanged from v2.2.0.

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, bridgePost, wakeBridge } = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");

const PIPELINE_TIMEOUT_MS     = 20 * 60 * 1000; // 20 min
const SSE_POLL_INTERVAL_MS    = parseInt(process.env.SSE_POLL_INTERVAL_MS  || "3000",  10);
const SSE_TIMEOUT_MS          = parseInt(process.env.SSE_TIMEOUT_MS        || String(10 * 60 * 1000), 10);

// How long to wait for a busy bridge to free up before giving up
const BRIDGE_BUSY_MAX_WAIT_MS = parseInt(process.env.BRIDGE_BUSY_MAX_WAIT_MS || String(18 * 60 * 1000), 10); // 18 min
const BRIDGE_BUSY_POLL_MS     = parseInt(process.env.BRIDGE_BUSY_POLL_MS    || "8000", 10); // poll every 8s


// ── Bridge busy check ──────────────────────────────────────────────────────────
// Returns true when the bridge is free (or if /status endpoint doesn't exist).
// Returns false if the bridge is still processing after BRIDGE_BUSY_MAX_WAIT_MS.
const waitForBridgeFree = async (docId) => {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < BRIDGE_BUSY_MAX_WAIT_MS) {
    attempt++;
    try {
      const { data } = await bridge.get("/status", { timeout: 8_000 });
      const busy = data?.data?.busy || data?.busy || false;

      if (!busy) {
        if (attempt > 1) {
          console.log(`✓ Bridge free after ${Math.round((Date.now()-start)/1000)}s | docId=${docId}`);
        }
        return true;
      }

      if (attempt === 1) {
        console.log(`⏳ Bridge busy — waiting for it to free up | docId=${docId}`);
      }
    } catch (err) {
      // /status doesn't exist (older bridge) or bridge is down — just proceed
      if (err.response?.status === 404 || err.code === "ECONNREFUSED") {
        return true;
      }
      // 503 while checking status = bridge is overwhelmed, keep waiting
    }

    await new Promise(r => setTimeout(r, BRIDGE_BUSY_POLL_MS));
  }

  console.error(`✗ Bridge still busy after ${BRIDGE_BUSY_MAX_WAIT_MS/60000} min | docId=${docId}`);
  return false;
};


// ── POST /api/documents/upload ────────────────────────────────────────────────
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

  // Respond 202 immediately
  res.status(202).json({
    status: "success",
    data: {
      document: doc,
      phase:    "processing",
      message:  "Upload received. Processing audio in background.",
    },
  });

  const fileBuffer   = req.file.buffer;
  const fileOrigName = req.file.originalname;
  const fileMimetype = req.file.mimetype;
  const userId       = req.user._id;
  const userRole     = req.user.role;

  setImmediate(async () => {
    try {
      console.log(`→ Background Phase 1 START | docId=${tempDocId}`);

      // Step 1: wake the bridge (handles cold starts on Render/ngrok)
      await wakeBridge();

      // Step 2: wait for bridge to be free if another large PDF is processing
      // This prevents 503 when two users upload large PDFs simultaneously
      const bridgeFree = await waitForBridgeFree(tempDocId);
      if (!bridgeFree) {
        throw new Error("Bridge was busy for too long. Please try again in a few minutes.");
      }

      const FormData = require("form-data");
      const form     = new FormData();
      form.append("file", fileBuffer, { filename: fileOrigName, contentType: fileMimetype });
      form.append("cognitive_state", cognitiveState);
      form.append("document_title",  documentTitle);
      form.append("tts_engine",      ttsEngine);
      form.append("role",            userRole);
      if (voiceId) form.append("voice_id", voiceId);

      const axiosConfig = {
        headers:          form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        timeout:          PIPELINE_TIMEOUT_MS,
        responseType:     "json",
      };

      console.log(`→ Calling bridge /pipeline/audio | docId=${tempDocId} | timeout=${PIPELINE_TIMEOUT_MS/60000}min`);
      const { data: bridgeRes } = await bridge.post("/pipeline/audio", form, axiosConfig);

      const pd = bridgeRes.data;
      console.log(`✓ Bridge response | docId=${tempDocId} | words=${pd.word_count} | duration=${pd.duration_sec}s`);

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

  res.json({ status: "success", data: { message: "MCQ generation started in background." } });

  setImmediate(async () => {
    try {
      console.log(`→ Background MCQ START | docId=${docId}`);

      const { data: mcqRes } = await bridgePost("/pipeline/mcq", {
        extracted_text: doc.extractedText,
        document_title: doc.title,
        doc_id:         docId,
      }, { timeout: PIPELINE_TIMEOUT_MS });

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
const getDocumentByDocId = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }
  res.json({ status: "success", data: { document: doc } });
};


// ── GET /api/documents/by-doc-id/:docId/stream (SSE) ─────────────────────────
const streamDocumentStatus = async (req, res) => {
  const { docId } = req.params;
  const userId    = req.user._id;

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const heartbeat  = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25_000);
  const hardTimeout = setTimeout(() => { send("error", { message: "Pipeline timed out. Please retry." }); cleanup(); }, SSE_TIMEOUT_MS);
  let pollTimer = null;

  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(hardTimeout);
    clearTimeout(pollTimer);
    if (!res.writableEnded) res.end();
  };

  req.on("close", cleanup);

  const poll = async () => {
    try {
      const doc = await Document.findOne(
        { docId, userId },
        "docId pipelineStatus pipelineError title audioUrl audioCloudUrl sessionsGenerated createdAt"
      ).lean();

      if (!doc) { send("error", { message: "Document not found." }); return cleanup(); }

      const status = doc.pipelineStatus;
      send("status", {
        docId:             doc.docId,
        status,
        title:             doc.title,
        audioUrl:          doc.audioCloudUrl || doc.audioUrl || null,
        sessionsGenerated: doc.sessionsGenerated || 0,
        pipelineError:     doc.pipelineError || null,
      });

      if (status === "ready" || status === "error") {
        send("done", { docId: doc.docId, status });
        return cleanup();
      }

      pollTimer = setTimeout(poll, SSE_POLL_INTERVAL_MS);
    } catch (err) {
      console.error("[SSE] streamDocumentStatus error:", err.message);
      send("error", { message: "Internal error during status check." });
      cleanup();
    }
  };

  poll();
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
  const { data } = await bridgePost("/captions", { text: doc.extractedText, duration_sec: doc.durationSec });
  const result = data.data;
  await Document.findOneAndUpdate({ docId }, { captions: result.captions, captionsGeneratedAt: new Date() });
  res.json({ status: "success", data: { captions: result.captions, total: result.total_segments, cached: false } });
};


// ── GET /api/documents/:docId/visualization ───────────────────────────────────
const getVisualization = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id }, "visualizationHtml visualizationType title");
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
  streamDocumentStatus,
  getDocument,
  deleteDocument,
  getCaptions,
  getVisualization,
};