// Tarang 2.4.0 — controllers/documentController.js
//
// v2.4.0: SMART DOCUMENT SPLITTING
//
//   If extracted word count > PART_WORD_LIMIT (3800 words), the document is
//   automatically split into parts. Each part is its own Document record with
//   its own Sessions and MCQ cycle — identical to a standalone upload.
//
//   Flow for a 12,000-word PDF (≈3 parts):
//
//     1. User uploads → 202 immediately (as before).
//     2. Bridge extracts text → ~12,000 words detected.
//     3. Part 1 (words 1-3800) processed immediately:
//          pipeline/audio → Cloudinary → Document saved as pipelineStatus=audio_ready.
//     4. Frontend is navigated to /listen/<part1_docId> (part1 docId is in
//          the 202 response so polling resolves to it).
//     5. Parts 2 and 3 process sequentially in background.
//          Each part's pipelineStatus transitions: processing → audio_ready → ready
//          as audio and MCQ complete — dashboard polls see them appear progressively.
//     6. trigger-mcq works per-part (unchanged).
//
//   Unchanged for documents ≤ PART_WORD_LIMIT:
//     Single-document flow is identical to v2.3.0.
//
//   Dashboard grouping:
//     All parts share the same parentDocId (= part1's docId).
//     getDocuments returns all parts; Dashboard.jsx groups them by parentDocId.

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, bridgePost, wakeBridge } = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");

const PIPELINE_TIMEOUT_MS     = 20 * 60 * 1000;
const SSE_POLL_INTERVAL_MS    = parseInt(process.env.SSE_POLL_INTERVAL_MS  || "3000",  10);
const SSE_TIMEOUT_MS          = parseInt(process.env.SSE_TIMEOUT_MS        || String(10 * 60 * 1000), 10);
const BRIDGE_BUSY_MAX_WAIT_MS = parseInt(process.env.BRIDGE_BUSY_MAX_WAIT_MS || String(18 * 60 * 1000), 10);
const BRIDGE_BUSY_POLL_MS     = parseInt(process.env.BRIDGE_BUSY_POLL_MS    || "8000", 10);

// ── Splitting config ──────────────────────────────────────────────────────────
const PART_WORD_LIMIT = parseInt(process.env.TARANG_PART_WORD_LIMIT || "3800", 10);

// ── Bridge busy check (unchanged from v2.3.0) ─────────────────────────────────
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
// Splits at sentence boundaries so parts don't start mid-sentence.
const splitTextIntoParts = (text, wordLimit) => {
  const words = text.trim().split(/\s+/);
  if (words.length <= wordLimit) return [text];

  const parts = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + wordLimit, words.length);
    let slice = words.slice(start, end).join(" ");

    // If not at end of text, try to cut at a sentence boundary (. ! ?)
    // Look back up to 200 words for the last sentence end
    if (end < words.length) {
      const lookback = words.slice(Math.max(start, end - 200), end).join(" ");
      const lastSentenceEnd = Math.max(
        lookback.lastIndexOf(". "),
        lookback.lastIndexOf("! "),
        lookback.lastIndexOf("? "),
      );
      if (lastSentenceEnd > lookback.length * 0.6) {
        // cut at sentence boundary
        const cutAt = lookback.substring(0, lastSentenceEnd + 1);
        const cutWords = cutAt.trim().split(/\s+/).length;
        slice = words.slice(start, start + cutWords).join(" ");
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
  // Wait for bridge to be free
  const free = await waitForBridgeFree(partDocId);
  if (!free) throw new Error("Bridge was busy for too long.");

  const FormData = require("form-data");
  const form = new FormData();

  // Create a text blob for this part
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

  // Upload to Cloudinary
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

  // Save / update this part's Document record
  await Document.findOneAndUpdate(
    { docId: partDocId, userId },
    {
      $set: {
        title:               partTitle,
        wordCount:           pd.word_count,
        durationSec:         pd.duration_sec,
        extractedText:       partText,
        beatFreqHz:          pd.beat_freq_hz,
        pipelineStatus:      "audio_ready",
        pipelineError:       null,
        audioCloudUrl,
        audioPublicId,
        captions:            pd.captions?.length ? pd.captions : null,
        captionsGeneratedAt: pd.captions?.length ? new Date() : null,
        // multi-part fields
        isMultiPart:  totalParts > 1,
        partNumber,
        totalParts,
        parentDocId:  parentDocId || null,
        format,
        originalFilename,
        cognitiveState,
        ttsEngine,
      }
    },
    { upsert: true, new: true }
  );

  console.log(`✓ Part ${partNumber}/${totalParts} audio_ready | docId=${partDocId}`);
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

  // Create a stable docId for part 1 (= the "primary" document the user polls)
  const part1DocId = makeDocId(req.file.originalname + String(req.user._id) + Date.now());

  // Pre-create the Document record so the frontend can start polling immediately
  const doc = await Document.findOneAndUpdate(
    { docId: part1DocId, userId: req.user._id },
    {
      $set: {
        userId:           req.user._id,
        docId:            part1DocId,
        title:            documentTitle,
        originalFilename: req.file.originalname,
        format:           req.file.originalname.split(".").pop().toLowerCase(),
        cognitiveState,
        ttsEngine,
        pipelineStatus:   "processing",
        pipelineError:    null,
        sessionsGenerated: 0,
        partNumber:       1,
        totalParts:       1,   // updated once we know how many parts
        isMultiPart:      false,
        parentDocId:      null,
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`→ Upload | docId=${part1DocId} | file=${req.file.originalname} | ${req.file.size}B`);

  // Respond 202 immediately with part1DocId — frontend polls this
  res.status(202).json({
    status: "success",
    data: {
      document: doc,
      phase:    "processing",
      message:  "Upload received. Processing in background.",
    },
  });

  // Keep a copy of everything needed in the background task
  const fileBuffer       = req.file.buffer;
  const fileOrigName     = req.file.originalname;
  const fileMimetype     = req.file.mimetype;
  const userId           = req.user._id;
  const userRole         = req.user.role;
  const format           = req.file.originalname.split(".").pop().toLowerCase();

  setImmediate(async () => {
    try {
      console.log(`→ Background START | docId=${part1DocId}`);

      await wakeBridge();

      // ── Step 1: Extract text from the full document ───────────────────────
      const free = await waitForBridgeFree(part1DocId);
      if (!free) throw new Error("Bridge busy — cannot extract.");

      const FormData = require("form-data");
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
      const metadata  = extractRes.data.metadata || {};

      console.log(`✓ Extraction OK | docId=${part1DocId} | words=${wordCount}`);

      // ── Step 2: Decide whether to split ──────────────────────────────────
      const parts     = splitTextIntoParts(fullText, PART_WORD_LIMIT);
      const totalParts = parts.length;

      console.log(`→ Splitting | words=${wordCount} | limit=${PART_WORD_LIMIT} | parts=${totalParts}`);

      // Update part1 with totalParts now that we know
      if (totalParts > 1) {
        await Document.findOneAndUpdate(
          { docId: part1DocId, userId },
          { $set: { isMultiPart: true, totalParts, parentDocId: null } }
        );
      }

      // Pre-create Document stubs for parts 2, 3, ... so dashboard shows them immediately
      const partDocIds = [part1DocId];
      if (totalParts > 1) {
        for (let i = 1; i < totalParts; i++) {
          const pDocId = makeDocId(`${part1DocId}_part${i + 1}`);
          partDocIds.push(pDocId);
          const partTitle = `${documentTitle} — Part ${i + 1}`;
          await Document.findOneAndUpdate(
            { docId: pDocId, userId },
            {
              $set: {
                userId,
                docId:            pDocId,
                title:            partTitle,
                originalFilename: fileOrigName,
                format,
                cognitiveState,
                ttsEngine,
                pipelineStatus:   "processing",
                pipelineError:    null,
                sessionsGenerated: 0,
                isMultiPart:      true,
                partNumber:       i + 1,
                totalParts,
                parentDocId:      part1DocId,
              }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          console.log(`→ Stub created | part=${i + 1}/${totalParts} | docId=${pDocId}`);
        }
      }

      // ── Step 3: Process parts sequentially ───────────────────────────────
      // Part 1 first so user lands on audio ASAP, then 2, 3, ...
      for (let i = 0; i < totalParts; i++) {
        const partDocId = partDocIds[i];
        const partTitle = totalParts > 1
          ? `${documentTitle} — Part ${i + 1}`
          : documentTitle;

        try {
          await processOnePart({
            partText:       parts[i],
            partDocId,
            partTitle,
            cognitiveState,
            ttsEngine,
            voiceId,
            userRole,
            userId,
            originalFilename: fileOrigName,
            format,
            partNumber:     i + 1,
            totalParts,
            parentDocId:    i === 0 ? null : part1DocId,
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

      console.log(`✓ All ${totalParts} part(s) audio_ready | parentDocId=${part1DocId}`);

    } catch (err) {
      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      console.error(`✗ Background FAILED | docId=${part1DocId} | ${isTimeout ? "TIMEOUT" : "ERROR"} | ${err.message}`);
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
        { $set: { pipelineStatus: "error", pipelineError: err.message || "Pipeline failed" } }
      );
    }
  });
};


// ── POST /api/documents/:docId/trigger-mcq ────────────────────────────────────
// Unchanged — works per-part because each part is its own Document + Sessions
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
// Returns all documents including all parts. Dashboard groups by parentDocId.
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
        "docId pipelineStatus pipelineError title audioUrl audioCloudUrl sessionsGenerated createdAt isMultiPart partNumber totalParts parentDocId"
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
        isMultiPart:       doc.isMultiPart || false,
        partNumber:        doc.partNumber || 1,
        totalParts:        doc.totalParts || 1,
      });

      if (status === "ready" || status === "audio_ready" || status === "error") {
        send("done", { docId: doc.docId, status });
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
// Deleting a part 1 (parent) also deletes all sibling parts
const deleteDocument = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  // Collect docIds to delete
  const toDelete = [doc];

  // If this is part 1 (parentDocId = null) and isMultiPart, delete siblings too
  if (doc.isMultiPart && !doc.parentDocId) {
    const siblings = await Document.find({
      parentDocId: doc.docId,
      userId:      req.user._id,
    });
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