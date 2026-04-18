// Tarang 2.4.3 — controllers/documentController.js
//
// ROOT CAUSE FIX for 18-parts bug (follow-up to 2.4.2):
//
//   The bridge v2.0.1 fix was correct — raw_text IS now returned with 6893 words.
//   But splitTextIntoParts() was STILL producing 18 tiny parts because of a bug
//   in its sentence-boundary detection logic.
//
//   THE BUG in the old splitTextIntoParts:
//     lookback = last 200 words of the 3800-word chunk joined as string (~1200 chars)
//     lastSentenceEnd = last '. ' position in that string
//     For real text (many short sentences), lastSentenceEnd ≈ 1130 (near string end)
//     cutAt = lookback[0..1130] ≈ 188 words of lookback
//     cutWords = 188, so next start = current_start + 188 → ~190 words per part
//     6893 / 190 ≈ 36 raw parts → merged to 18 final parts
//
//   THE FIX:
//     Only look for sentence boundary within the LAST 50 words of the chunk.
//     Only accept the boundary if it keeps ≥70% of the intended chunk size.
//     Otherwise cut at exact word limit.
//     Result: 6893-word doc → 2 parts of ~3800 and ~3093 words ✓
//
// ALSO RETAINED from 2.4.2:
//   • raw_text from bridge v2.0.1 for splitting (not optimized text)
//   • PART_WORD_MARGIN: docs within 100 words of limit stay single part
//   • frontendRedirectTarget: "audio_player" vs "dashboard"
//   • Part 1 processed first to unblock frontend redirect

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, bridgePost, wakeBridge } = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");

const PIPELINE_TIMEOUT_MS     = 20 * 60 * 1000;
const SSE_POLL_INTERVAL_MS    = parseInt(process.env.SSE_POLL_INTERVAL_MS    || "3000",  10);
const SSE_TIMEOUT_MS          = parseInt(process.env.SSE_TIMEOUT_MS          || String(10 * 60 * 1000), 10);
const BRIDGE_BUSY_MAX_WAIT_MS = parseInt(process.env.BRIDGE_BUSY_MAX_WAIT_MS || String(18 * 60 * 1000), 10);
const BRIDGE_BUSY_POLL_MS     = parseInt(process.env.BRIDGE_BUSY_POLL_MS     || "8000", 10);

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
// Splits raw continuous text into parts of ~wordLimit words each.
// Docs within (limit + margin) words stay as a single part.
//
// MUST receive raw_text (sanitize_text output) — NOT the TTS-optimized text
// (optimize_for_presentation output). The optimized text has ~200-word paragraphs
// that cause this function to produce hundreds of tiny parts.
//
// v2.4.3 FIX: lookback window reduced from 200 → 50 words, with 70% size guard.
// The old 200-word window always found a sentence boundary within 13 words of
// the end of any real chunk, cutting at ~190 words instead of ~3800.
const splitTextIntoParts = (text, wordLimit, margin = 0) => {
  const words = text.trim().split(/\s+/);

  if (words.length <= wordLimit + margin) return [text];

  const parts = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + wordLimit, words.length);

    // Last chunk — take everything remaining
    if (end >= words.length) {
      parts.push(words.slice(start).join(" ").trim());
      break;
    }

    // Look for a clean sentence boundary within the LAST 50 words only.
    // (Old code used 200 words, which always found a boundary ~13 words
    //  before end of chunk → ~190-word parts instead of ~3800-word parts.)
    const lookbackStart = Math.max(start, end - 50);
    const lookback      = words.slice(lookbackStart, end).join(" ");

    const lastSentenceEnd = Math.max(
      lookback.lastIndexOf(". "),
      lookback.lastIndexOf("! "),
      lookback.lastIndexOf("? "),
    );

    if (lastSentenceEnd !== -1) {
      const cutAt     = lookback.substring(0, lastSentenceEnd + 1);
      const cutWords  = cutAt.trim().split(/\s+/).length;
      const actualCut = (lookbackStart - start) + cutWords;

      // Only accept this boundary if it keeps ≥70% of the intended chunk.
      // Prevents pathological early cuts when the last sentence happens to be
      // very short and far from wordLimit.
      if (actualCut >= wordLimit * 0.7) {
        parts.push(words.slice(start, start + actualCut).join(" ").trim());
        start += actualCut;
        continue;
      }
    }

    // No usable sentence boundary found — cut at exact word limit
    parts.push(words.slice(start, end).join(" ").trim());
    start = end;
  }

  return parts.filter(p => p.length > 0);
};


// ── docId generator ───────────────────────────────────────────────────────────
const makeDocId = (seed) => {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(seed).digest("hex").slice(0, 12);
};


// ── Process one part through pipeline/audio → Cloudinary → DB ────────────────
const processOnePart = async ({
  partText, partDocId, partTitle, cognitiveState, ttsEngine, voiceId,
  userRole, userId, originalFilename, format, partNumber, totalParts, parentDocId,
}) => {
  const free = await waitForBridgeFree(partDocId);
  if (!free) throw new Error("Bridge was busy for too long.");

  const FormData  = require("form-data");
  const form      = new FormData();
  const partWords = partText.trim().split(/\s+/).length;

  const partBuffer = Buffer.from(partText, "utf-8");
  form.append("file", partBuffer, { filename: `${partDocId}.txt`, contentType: "text/plain" });
  form.append("cognitive_state", cognitiveState);
  form.append("document_title",  partTitle);
  form.append("tts_engine",      ttsEngine);
  form.append("role",            userRole);
  if (voiceId) form.append("voice_id", voiceId);

  console.log(`→ Bridge /pipeline/audio | part=${partNumber}/${totalParts} | docId=${partDocId} | words=${partWords}`);

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
        frontendRedirectTarget: redirectTarget,
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
        userId:                 req.user._id,
        docId:                  part1DocId,
        title:                  documentTitle,
        originalFilename:       req.file.originalname,
        format:                 req.file.originalname.split(".").pop().toLowerCase(),
        cognitiveState,
        ttsEngine,
        pipelineStatus:         "processing",
        pipelineError:          null,
        sessionsGenerated:      0,
        partNumber:             1,
        totalParts:             1,
        isMultiPart:            false,
        parentDocId:            null,
        frontendRedirectTarget: "audio_player",
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`→ Upload | docId=${part1DocId} | file=${req.file.originalname} | ${req.file.size}B`);

  res.status(202).json({
    status: "success",
    data: { document: doc, phase: "processing", message: "Upload received. Processing in background." },
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

      // ── Step 1: Extract ───────────────────────────────────────────────────
      const free = await waitForBridgeFree(part1DocId);
      if (!free) throw new Error("Bridge busy — cannot extract.");

      const FormData    = require("form-data");
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

      // ── Use raw_text for splitting ─────────────────────────────────────────
      // raw_text = sanitize_text() output — continuous string for correct splitting.
      // data.text = optimize_for_presentation() output — paragraph-split prose
      //             (~200 words/para × 36 paras = 36 sections → 18 bad parts).
      // bridge v2.0.1 returns both fields. The || fallback should never trigger.
      const splitSource = extractRes.data.raw_text || extractRes.data.text;

      if (!extractRes.data.raw_text) {
        console.error(
          `✗ CRITICAL: Bridge did not return raw_text for docId=${part1DocId}. ` +
          `Please update bridge.py to v2.0.1 — splitting will be incorrect.`
        );
      }

      if (!splitSource || !splitSource.trim()) {
        throw new Error("Extraction returned empty text");
      }

      const actualWords = splitSource.trim().split(/\s+/).length;

      console.log(
        `✓ Extraction OK | docId=${part1DocId} | ` +
        `raw_text_words=${actualWords} | ` +
        `optimized_words=${extractRes.data.word_count} | ` +
        `limit=${PART_WORD_LIMIT} | margin=${PART_WORD_MARGIN}`
      );

      // ── Step 2: Split ─────────────────────────────────────────────────────
      const parts      = splitTextIntoParts(splitSource, PART_WORD_LIMIT, PART_WORD_MARGIN);
      const totalParts = parts.length;

      const partSizes = parts.map(p => p.trim().split(/\s+/).length);
      console.log(
        `→ Split result | raw_words=${actualWords} | parts=${totalParts} | ` +
        `sizes=[${partSizes.join(", ")}] words`
      );

      const redirectTarget = totalParts === 1 ? "audio_player" : "dashboard";
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
        { $set: { isMultiPart: totalParts > 1, totalParts, frontendRedirectTarget: redirectTarget } }
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
                userId, docId: pDocId, title: partTitle,
                originalFilename: fileOrigName, format, cognitiveState, ttsEngine,
                pipelineStatus: "processing", pipelineError: null, sessionsGenerated: 0,
                isMultiPart: true, partNumber: i + 1, totalParts,
                parentDocId: part1DocId, frontendRedirectTarget: "dashboard",
              }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          console.log(`→ Stub created | part=${i + 1}/${totalParts} | docId=${pDocId} | words=${partSizes[i]}`);
        }
      }

      // ── Step 3: Process part 1 first — unblocks frontend redirect ─────────
      try {
        await processOnePart({
          partText:         parts[0],
          partDocId:        part1DocId,
          partTitle:        totalParts > 1 ? `${documentTitle} — Part 1` : documentTitle,
          cognitiveState, ttsEngine, voiceId, userRole, userId,
          originalFilename: fileOrigName, format,
          partNumber: 1, totalParts, parentDocId: null,
        });
      } catch (partErr) {
        console.error(`✗ Part 1 FAILED | docId=${part1DocId} |`, partErr.message);
        await Document.findOneAndUpdate(
          { docId: part1DocId, userId },
          { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
        );
        return;
      }

      // ── Step 4: Parts 2..N ────────────────────────────────────────────────
      if (totalParts > 1) {
        for (let i = 1; i < totalParts; i++) {
          const partDocId = partDocIds[i];
          try {
            await processOnePart({
              partText:         parts[i],
              partDocId,
              partTitle:        `${documentTitle} — Part ${i + 1}`,
              cognitiveState, ttsEngine, voiceId, userRole, userId,
              originalFilename: fileOrigName, format,
              partNumber: i + 1, totalParts, parentDocId: part1DocId,
            });
          } catch (partErr) {
            console.error(`✗ Part ${i + 1}/${totalParts} FAILED | docId=${partDocId} |`, partErr.message);
            await Document.findOneAndUpdate(
              { docId: partDocId, userId },
              { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
            );
          }
        }
        console.log(`✓ All ${totalParts} parts complete | parentDocId=${part1DocId}`);
      }

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
const triggerMCQ = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });

  const existingSessions = await Session.countDocuments({ docId, userId: req.user._id });
  if (existingSessions >= 3) return res.json({ status: "success", data: { message: "MCQ already generated." } });
  if (!doc.extractedText || doc.extractedText.split(" ").length < 50)
    return res.json({ status: "success", data: { message: "Document too short for MCQ." } });

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
              userId: req.user._id, documentId: doc._id, docId,
              sessionNumber: n, difficulty: difficulties[n],
              status: n === 1 ? "pending" : "locked",
              startedAt: null, submittedAt: null, scorePct: null,
              correctCount: 0, userAnswers: {}, overrideUsed: false,
              questions: qData?.questions || [], answerKey: aData || null,
              sessionState: md.session_state || null,
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
      await Document.findOneAndUpdate({ docId }, { $set: { pipelineError: `MCQ failed: ${err.message}` } });
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

const getDocumentByDocId = async (req, res) => {
  const doc = await Document.findOne({ docId: req.params.docId, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });
  res.json({ status: "success", data: { document: doc } });
};

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
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const heartbeat   = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25_000);
  const hardTimeout = setTimeout(() => { send("error", { message: "Pipeline timed out." }); cleanup(); }, SSE_TIMEOUT_MS);
  let pollTimer = null;

  const cleanup = () => {
    clearInterval(heartbeat); clearTimeout(hardTimeout); clearTimeout(pollTimer);
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);

  const poll = async () => {
    try {
      const doc = await Document.findOne(
        { docId, userId },
        "docId pipelineStatus pipelineError title audioUrl audioCloudUrl sessionsGenerated isMultiPart partNumber totalParts parentDocId frontendRedirectTarget"
      ).lean();

      if (!doc) { send("error", { message: "Document not found." }); return cleanup(); }

      const status = doc.pipelineStatus;
      send("status", {
        docId: doc.docId, status, title: doc.title,
        audioUrl: doc.audioCloudUrl || doc.audioUrl || null,
        sessionsGenerated: doc.sessionsGenerated || 0,
        pipelineError: doc.pipelineError || null,
        isMultiPart: doc.isMultiPart || false,
        partNumber: doc.partNumber || 1, totalParts: doc.totalParts || 1,
        frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
      });

      if (status === "ready" || status === "audio_ready" || status === "error") {
        send("done", {
          docId: doc.docId, status,
          frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
          isMultiPart: doc.isMultiPart || false,
        });
        return cleanup();
      }
      pollTimer = setTimeout(poll, SSE_POLL_INTERVAL_MS);
    } catch (err) {
      send("error", { message: "Internal error during status check." }); cleanup();
    }
  };
  poll();
};

const getDocument = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });
  res.json({ status: "success", data: { document: doc } });
};

const deleteDocument = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });

  const toDelete = [doc];
  if (doc.isMultiPart && !doc.parentDocId) {
    const siblings = await Document.find({ parentDocId: doc.docId, userId: req.user._id });
    toDelete.push(...siblings);
  }
  for (const d of toDelete) {
    if (d.audioPublicId && isConfigured()) {
      try { const { deleteAudio } = require("../config/cloudinary"); await deleteAudio(d.audioPublicId); }
      catch (e) { console.error("Cloudinary delete failed:", e.message); }
    }
    await Session.deleteMany({ documentId: d._id });
    await d.deleteOne();
  }
  res.json({ status: "success", data: { message: `Deleted ${toDelete.length} document(s).` } });
};

const getCaptions = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });
  if (doc.captions?.length > 0) {
    return res.json({ status: "success", data: { captions: doc.captions, total: doc.captions.length, cached: true, generatedAt: doc.captionsGeneratedAt } });
  }
  if (!doc.extractedText || !doc.durationSec)
    return res.status(404).json({ status: "error", error: "Captions not available." });
  const { data } = await bridgePost("/captions", { text: doc.extractedText, duration_sec: doc.durationSec });
  const result   = data.data;
  await Document.findOneAndUpdate({ docId }, { captions: result.captions, captionsGeneratedAt: new Date() });
  res.json({ status: "success", data: { captions: result.captions, total: result.total_segments, cached: false } });
};

const getVisualization = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id }, "visualizationHtml visualizationType title");
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });
  if (!doc.visualizationHtml) return res.status(404).json({ status: "error", error: "Visualization not available." });
  res.setHeader("Content-Type", "text/html");
  res.send(doc.visualizationHtml);
};


module.exports = {
  uploadDocument, triggerMCQ, getDocuments, getDocumentByDocId,
  streamDocumentStatus, getDocument, deleteDocument, getCaptions, getVisualization,
};