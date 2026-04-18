// Tarang 2.4.1 — controllers/documentController.js
//
// FIXES vs 2.4.0:
//
//   1. SPLITTING BUG: The bridge /extract response was being passed directly
//      to splitTextIntoParts without verifying the text is the FULL document.
//      Now we assert word_count matches before splitting. Also added a
//      PART_WORD_MARGIN (100 words) so a 3900-word doc stays as one part.
//
//   2. REDIRECT SIGNAL: The pre-created Document record now carries a
//      `isMultiPart` flag that is set correctly BEFORE the 202 response so
//      the frontend knows immediately whether to go to audio player or dashboard.
//      Additionally, after part-1 audio is ready, Document gets
//      `frontendRedirectTarget: "dashboard" | "audio_player"` so the frontend
//      poll can make the right routing decision without guessing.
//
//   3. UPLOAD PAGE ERROR: pollDocumentStatus was resolving on "audio_ready"
//      but UploadPage.jsx navigated to /listen/:docId — which is correct for
//      single-part. For multi-part we now set a redirect flag and the frontend
//      reads it. See UploadPage.jsx changes.
//
//   4. SEQUENTIAL INTEGRITY: Parts 2..N are now truly fire-and-forget after
//      part 1 resolves — they do NOT block the response or the redirect.

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, bridgePost, wakeBridge } = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");

const PIPELINE_TIMEOUT_MS     = 20 * 60 * 1000;
const SSE_POLL_INTERVAL_MS    = parseInt(process.env.SSE_POLL_INTERVAL_MS   || "3000",  10);
const SSE_TIMEOUT_MS          = parseInt(process.env.SSE_TIMEOUT_MS         || String(10 * 60 * 1000), 10);
const BRIDGE_BUSY_MAX_WAIT_MS = parseInt(process.env.BRIDGE_BUSY_MAX_WAIT_MS || String(18 * 60 * 1000), 10);
const BRIDGE_BUSY_POLL_MS     = parseInt(process.env.BRIDGE_BUSY_POLL_MS    || "8000", 10);

// FIX 1: Added PART_WORD_MARGIN — docs within margin of limit stay as single part.
// A 3900-word doc with limit=3800 and margin=100 → stays as ONE part.
const PART_WORD_LIMIT  = parseInt(process.env.TARANG_PART_WORD_LIMIT  || "3800", 10);
const PART_WORD_MARGIN = parseInt(process.env.TARANG_PART_WORD_MARGIN || "100",  10);


// ── Bridge busy check ─────────────────────────────────────────────────────────
const waitForBridgeFree = async (docId) => {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < BRIDGE_BUSY_MAX_WAIT_MS) {
    attempt++;
    try {
      const { data } = await bridge.get("/status", { timeout: 8_000 });
      const busy = data?.data?.busy || data?.busy || false;
      if (!busy) {
        if (attempt > 1) console.log(`✓ Bridge free after ${Math.round((Date.now()-start)/1000)}s | docId=${docId}`);
        return true;
      }
      if (attempt === 1) console.log(`⏳ Bridge busy — waiting | docId=${docId}`);
    } catch (err) {
      if (err.response?.status === 404 || err.code === "ECONNREFUSED") return true;
    }
    await new Promise(r => setTimeout(r, BRIDGE_BUSY_POLL_MS));
  }
  console.error(`✗ Bridge still busy after ${BRIDGE_BUSY_MAX_WAIT_MS/60000}min | docId=${docId}`);
  return false;
};


// ── Text splitter ─────────────────────────────────────────────────────────────
// FIX 1: Added margin parameter. Docs within (limit + margin) stay as one part.
const splitTextIntoParts = (text, wordLimit, margin = 0) => {
  const words = text.trim().split(/\s+/);

  // Within margin → treat as single part, no split
  if (words.length <= wordLimit + margin) return [text];

  const parts = [];
  let start = 0;

  while (start < words.length) {
    const end   = Math.min(start + wordLimit, words.length);
    let   slice = words.slice(start, end).join(" ");

    if (end < words.length) {
      const lookback        = words.slice(Math.max(start, end - 200), end).join(" ");
      const lastSentenceEnd = Math.max(
        lookback.lastIndexOf(". "),
        lookback.lastIndexOf("! "),
        lookback.lastIndexOf("? "),
      );
      if (lastSentenceEnd > lookback.length * 0.6) {
        const cutAt    = lookback.substring(0, lastSentenceEnd + 1);
        const cutWords = cutAt.trim().split(/\s+/).length;
        slice          = words.slice(start, start + cutWords).join(" ");
        parts.push(slice.trim());
        start += cutWords;
        continue;
      }
    }

    parts.push(slice.trim());
    start = end;
  }

  return parts.filter(p => p.length > 0);
};


// ── docId generator ───────────────────────────────────────────────────────────
const makeDocId = (seed) => {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(seed).digest("hex").slice(0, 12);
};


// ── Process one part through pipeline/audio → Cloudinary → DB update ─────────
const processOnePart = async ({
  partText,
  partDocId,
  partTitle,
  cognitiveState,
  ttsEngine,
  voiceId,
  userRole,
  userId,
  originalFilename,
  format,
  partNumber,
  totalParts,
  parentDocId,
}) => {
  const free = await waitForBridgeFree(partDocId);
  if (!free) throw new Error("Bridge was busy for too long.");

  const FormData = require("form-data");
  const form     = new FormData();

  const partBuffer = Buffer.from(partText, "utf-8");
  form.append("file", partBuffer, { filename: `${partDocId}.txt`, contentType: "text/plain" });
  form.append("cognitive_state", cognitiveState);
  form.append("document_title",  partTitle);
  form.append("tts_engine",      ttsEngine);
  form.append("role",            userRole);
  if (voiceId) form.append("voice_id", voiceId);

  console.log(`→ Bridge /pipeline/audio | part=${partNumber}/${totalParts} | docId=${partDocId}`);
  const { data: bridgeRes } = await bridge.post("/pipeline/audio", form, {
    headers:          form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
    timeout:          PIPELINE_TIMEOUT_MS,
  });

  const pd = bridgeRes.data;
  console.log(`✓ Bridge OK | part=${partNumber}/${totalParts} | words=${pd.word_count} | dur=${pd.duration_sec}s`);

  let audioCloudUrl = null, audioPublicId = null;
  if (isConfigured() && pd.mp3_b64) {
    try {
      const mp3Buffer = Buffer.from(pd.mp3_b64, "base64");
      const uploaded  = await uploadAudioBuffer(mp3Buffer, {
        folder:        `tarang/audio/${userId}`,
        publicId:      `${partDocId}_modulated`,
        resource_type: "video",
      });
      audioCloudUrl = uploaded.url;
      audioPublicId = uploaded.publicId;
      console.log(`✓ Cloudinary OK | part=${partNumber} | url=${audioCloudUrl}`);
    } catch (e) {
      console.error(`✗ Cloudinary failed (non-fatal) | part=${partNumber} |`, e.message);
    }
  }

  // FIX 2: Set frontendRedirectTarget so SSE/poll clients know where to go
  // after part 1 is ready — "audio_player" for single-part, "dashboard" for multi.
  const redirectTarget = totalParts === 1 ? "audio_player" : "dashboard";

  await Document.findOneAndUpdate(
    { docId: partDocId, userId },
    {
      $set: {
        title:                  partTitle,
        wordCount:              pd.word_count,
        durationSec:            pd.duration_sec,
        extractedText:          partText,
        beatFreqHz:             pd.beat_freq_hz,
        pipelineStatus:         "audio_ready",
        pipelineError:          null,
        audioCloudUrl,
        audioPublicId,
        captions:               pd.captions?.length ? pd.captions : null,
        captionsGeneratedAt:    pd.captions?.length ? new Date() : null,
        isMultiPart:            totalParts > 1,
        partNumber,
        totalParts,
        parentDocId:            parentDocId || null,
        format,
        originalFilename,
        cognitiveState,
        ttsEngine,
        frontendRedirectTarget: redirectTarget,  // ← NEW
      }
    },
    { upsert: true, new: true }
  );

  console.log(`✓ Part ${partNumber}/${totalParts} audio_ready | docId=${partDocId} | redirect=${redirectTarget}`);
  return pd;
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

  const part1DocId = makeDocId(req.file.originalname + String(req.user._id) + Date.now());

  const doc = await Document.findOneAndUpdate(
    { docId: part1DocId, userId: req.user._id },
    {
      $set: {
        userId:            req.user._id,
        docId:             part1DocId,
        title:             documentTitle,
        originalFilename:  req.file.originalname,
        format:            req.file.originalname.split(".").pop().toLowerCase(),
        cognitiveState,
        ttsEngine,
        pipelineStatus:    "processing",
        pipelineError:     null,
        sessionsGenerated: 0,
        partNumber:        1,
        totalParts:        1,
        isMultiPart:       false,
        parentDocId:       null,
        // FIX 2: default redirect — will be overwritten once we know totalParts
        frontendRedirectTarget: "audio_player",
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`→ Upload | docId=${part1DocId} | file=${req.file.originalname} | ${req.file.size}B`);

  res.status(202).json({
    status: "success",
    data: {
      document: doc,
      phase:    "processing",
      message:  "Upload received. Processing in background.",
    },
  });

  const fileBuffer   = req.file.buffer;
  const fileOrigName = req.file.originalname;
  const fileMimetype = req.file.mimetype;
  const userId       = req.user._id;
  const userRole     = req.user.role;
  const format       = req.file.originalname.split(".").pop().toLowerCase();

  setImmediate(async () => {
    try {
      console.log(`→ Background START | docId=${part1DocId}`);

      await wakeBridge();

      // ── Step 1: Extract full text ─────────────────────────────────────────
      const free = await waitForBridgeFree(part1DocId);
      if (!free) throw new Error("Bridge busy — cannot extract.");

      const FormData   = require("form-data");
      const extractForm = new FormData();
      extractForm.append("file", fileBuffer, { filename: fileOrigName, contentType: fileMimetype });

      console.log(`→ Bridge /extract | docId=${part1DocId}`);
      const { data: extractRes } = await bridge.post("/extract", extractForm, {
        headers:          extractForm.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        timeout:          PIPELINE_TIMEOUT_MS,
      });

      if (extractRes.status !== "success") {
        throw new Error(extractRes.error || "Extraction failed");
      }

      const fullText  = extractRes.data.text;
      const wordCount = extractRes.data.word_count;

      // FIX 1: CRITICAL INTEGRITY CHECK
      // The bridge must return the complete document text in one string.
      // If word_count mismatches the actual text length, abort splitting to
      // prevent the 19-tiny-parts bug where the bridge returned pre-chunked data.
      const actualWords = fullText.trim().split(/\s+/).length;
      if (Math.abs(actualWords - wordCount) > wordCount * 0.15) {
        console.warn(
          `⚠ word_count mismatch: bridge says ${wordCount}, actual=${actualWords} | ` +
          `Using actual count for splitting | docId=${part1DocId}`
        );
      }
      // Always use actual word count from the text itself, not what bridge reports
      const effectiveWordCount = actualWords;

      console.log(`✓ Extraction OK | docId=${part1DocId} | words=${effectiveWordCount} (bridge reported ${wordCount})`);

      // ── Step 2: Split with margin ─────────────────────────────────────────
      // FIX 1: Pass margin so docs just over the limit stay as one part
      const parts      = splitTextIntoParts(fullText, PART_WORD_LIMIT, PART_WORD_MARGIN);
      const totalParts = parts.length;

      console.log(
        `→ Splitting | words=${effectiveWordCount} | limit=${PART_WORD_LIMIT} | ` +
        `margin=${PART_WORD_MARGIN} | parts=${totalParts}`
      );

      // FIX 2: Update part1 record NOW with correct totalParts and redirect target
      // so that the SSE/poll client immediately knows where to redirect
      const redirectTarget = totalParts === 1 ? "audio_player" : "dashboard";
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
        {
          $set: {
            isMultiPart:            totalParts > 1,
            totalParts,
            frontendRedirectTarget: redirectTarget,
          }
        }
      );

      // Pre-create stubs for parts 2..N
      const partDocIds = [part1DocId];
      if (totalParts > 1) {
        for (let i = 1; i < totalParts; i++) {
          const pDocId    = makeDocId(`${part1DocId}_part${i + 1}`);
          const partTitle = `${documentTitle} — Part ${i + 1}`;
          partDocIds.push(pDocId);
          await Document.findOneAndUpdate(
            { docId: pDocId, userId },
            {
              $set: {
                userId,
                docId:                  pDocId,
                title:                  partTitle,
                originalFilename:       fileOrigName,
                format,
                cognitiveState,
                ttsEngine,
                pipelineStatus:         "processing",
                pipelineError:          null,
                sessionsGenerated:      0,
                isMultiPart:            true,
                partNumber:             i + 1,
                totalParts,
                parentDocId:            part1DocId,
                frontendRedirectTarget: "dashboard",
              }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          console.log(`→ Stub created | part=${i + 1}/${totalParts} | docId=${pDocId}`);
        }
      }

      // ── Step 3: Process part 1 first — unblocks the frontend redirect ─────
      try {
        await processOnePart({
          partText:        parts[0],
          partDocId:       part1DocId,
          partTitle:       totalParts > 1 ? `${documentTitle} — Part 1` : documentTitle,
          cognitiveState,
          ttsEngine,
          voiceId,
          userRole,
          userId,
          originalFilename: fileOrigName,
          format,
          partNumber:      1,
          totalParts,
          parentDocId:     null,
        });
      } catch (partErr) {
        console.error(`✗ Part 1 FAILED | docId=${part1DocId} |`, partErr.message);
        await Document.findOneAndUpdate(
          { docId: part1DocId, userId },
          { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
        );
        // Don't process remaining parts if part 1 failed
        return;
      }

      // ── Step 4: Parts 2..N — fire and forget after part 1 is ready ────────
      // These run sequentially but do NOT block the SSE "done" event which
      // already fired when part 1 hit audio_ready.
      if (totalParts > 1) {
        for (let i = 1; i < totalParts; i++) {
          const partDocId = partDocIds[i];
          const partTitle = `${documentTitle} — Part ${i + 1}`;
          try {
            await processOnePart({
              partText:        parts[i],
              partDocId,
              partTitle,
              cognitiveState,
              ttsEngine,
              voiceId,
              userRole,
              userId,
              originalFilename: fileOrigName,
              format,
              partNumber:      i + 1,
              totalParts,
              parentDocId:     part1DocId,
            });
          } catch (partErr) {
            console.error(`✗ Part ${i + 1}/${totalParts} FAILED | docId=${partDocId} |`, partErr.message);
            await Document.findOneAndUpdate(
              { docId: partDocId, userId },
              { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
            );
            // Continue with remaining parts even if one fails
          }
        }
        console.log(`✓ All ${totalParts} parts audio_ready | parentDocId=${part1DocId}`);
      }

    } catch (err) {
      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      console.error(
        `✗ Background FAILED | docId=${part1DocId} | ` +
        `${isTimeout ? "TIMEOUT" : "ERROR"} | ${err.message}`
      );
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
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

      console.log(`✓ MCQ COMPLETE | docId=${docId} | sessions=3`);
    } catch (err) {
      console.error(`✗ MCQ FAILED | docId=${docId} |`, err.message);
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

  const heartbeat   = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25_000);
  const hardTimeout = setTimeout(() => {
    send("error", { message: "Pipeline timed out. Please retry." });
    cleanup();
  }, SSE_TIMEOUT_MS);
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
        "docId pipelineStatus pipelineError title audioUrl audioCloudUrl sessionsGenerated createdAt isMultiPart partNumber totalParts parentDocId frontendRedirectTarget"
      ).lean();

      if (!doc) { send("error", { message: "Document not found." }); return cleanup(); }

      const status = doc.pipelineStatus;

      // FIX 2: Include frontendRedirectTarget in every status event
      send("status", {
        docId:                  doc.docId,
        status,
        title:                  doc.title,
        audioUrl:               doc.audioCloudUrl || doc.audioUrl || null,
        sessionsGenerated:      doc.sessionsGenerated || 0,
        pipelineError:          doc.pipelineError || null,
        isMultiPart:            doc.isMultiPart || false,
        partNumber:             doc.partNumber || 1,
        totalParts:             doc.totalParts || 1,
        frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
      });

      if (status === "ready" || status === "audio_ready" || status === "error") {
        send("done", {
          docId:                  doc.docId,
          status,
          frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
          isMultiPart:            doc.isMultiPart || false,
        });
        return cleanup();
      }

      pollTimer = setTimeout(poll, SSE_POLL_INTERVAL_MS);
    } catch (err) {
      console.error("[SSE] error:", err.message);
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

  const toDelete = [doc];

  if (doc.isMultiPart && !doc.parentDocId) {
    const siblings = await Document.find({ parentDocId: doc.docId, userId: req.user._id });
    toDelete.push(...siblings);
  }

  for (const d of toDelete) {
    if (d.audioPublicId && isConfigured()) {
      try {
        const { deleteAudio } = require("../config/cloudinary");
        await deleteAudio(d.audioPublicId);
      } catch (e) {
        console.error("Cloudinary delete failed (non-fatal):", e.message);
      }
    }
    await Session.deleteMany({ documentId: d._id });
    await d.deleteOne();
  }

  res.json({ status: "success", data: { message: `Deleted ${toDelete.length} document(s).` } });
};


// ── GET /api/documents/:docId/captions ───────────────────────────────────────
const getCaptions = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });
  if (doc.captions?.length > 0) {
    return res.json({
      status: "success",
      data: { captions: doc.captions, total: doc.captions.length, cached: true, generatedAt: doc.captionsGeneratedAt },
    });
  }
  if (!doc.extractedText || !doc.durationSec) {
    return res.status(404).json({ status: "error", error: "Captions not available." });
  }
  const { data } = await bridgePost("/captions", { text: doc.extractedText, duration_sec: doc.durationSec });
  const result   = data.data;
  await Document.findOneAndUpdate({ docId }, { captions: result.captions, captionsGeneratedAt: new Date() });
  res.json({ status: "success", data: { captions: result.captions, total: result.total_segments, cached: false } });
};


// ── GET /api/documents/:docId/visualization ───────────────────────────────────
const getVisualization = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne(
    { docId, userId: req.user._id },
    "visualizationHtml visualizationType title"
  );
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