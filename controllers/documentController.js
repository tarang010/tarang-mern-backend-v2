// Tarang 2.4.4 — controllers/documentController.js
//
// ══════════════════════════════════════════════════════════════════════════════
// ROOT CAUSE ANALYSIS — Why "Processing timed out" appears on the frontend
// ══════════════════════════════════════════════════════════════════════════════
//
// BUG 1 — BRIDGE AXIOS TIMEOUT TOO SHORT (main culprit for large PDFs)
//   The bridge /extract call for a 423-page PDF takes ~363s (6 min).
//   PIPELINE_TIMEOUT_MS was 20 * 60 * 1000 = 20 min — that should be fine.
//   BUT config/bridge.js had its own axios instance timeout.
//   Check your config/bridge.js — if it has timeout: 5 * 60 * 1000 (300s)
//   that axios instance timeout fires at 302s, before the 363s extraction
//   finishes. The fix is in THIS file: we pass explicit timeout on each call
//   to override any instance-level default. See EXTRACT_TIMEOUT_MS below.
//
// BUG 2 — RENDER REDEPLOY KILLS IN-FLIGHT BACKGROUND JOBS
//   From the logs: devops.pdf part 1 completed at 21:41:00, then Render
//   restarted at 21:41:07 — 7 seconds later. Parts 2-7 never ran.
//   The documents stayed in pipelineStatus:"processing" forever.
//   Fix: on server startup, scan for any docs stuck in "processing" and
//   mark them as "error" immediately so the SSE stream can resolve.
//   Also: the SSE stream now checks for stuck docs and self-resolves.
//
// BUG 3 — SSE TIMEOUT TOO SHORT FOR MULTI-PART DOCS
//   SSE_TIMEOUT_MS defaulted to 10 min. A 7-part document takes
//   7 × ~3min per part = ~21 min. The SSE stream timed out at 10 min
//   even though processing was still ongoing — sending "Pipeline timed out"
//   to the frontend while the backend was still working.
//   Fix: SSE_TIMEOUT_MS raised to 30 min. Frontend should poll /status
//   via REST if the user closes and reopens the tab anyway.
//
// ALSO RETAINED from 2.4.3:
//   • raw_text from bridge v2.0.1 for splitting (not optimized text)
//   • PART_WORD_MARGIN: docs within 100 words of limit stay single part
//   • frontendRedirectTarget: "audio_player" vs "dashboard"
//   • Part 1 processed first to unblock frontend redirect
//   • v2.4.3 split fix: 50-word lookback window with 70% guard
//
// ══════════════════════════════════════════════════════════════════════════════

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, bridgePost, wakeBridge } = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");

// ── Timeouts ──────────────────────────────────────────────────────────────────
// EXTRACT_TIMEOUT_MS: how long to wait for /extract on the bridge.
//   423-page PDF took 363s. We give 15 min to be safe for any size.
//   This is passed explicitly on the axios call to override instance defaults.
const EXTRACT_TIMEOUT_MS = parseInt(
  process.env.EXTRACT_TIMEOUT_MS || String(15 * 60 * 1000), 10
);

// PIPELINE_TIMEOUT_MS: how long to wait for /pipeline/audio per part.
//   A 3800-word part (TTS + modulate) takes ~3 min. 20 min gives plenty of room.
const PIPELINE_TIMEOUT_MS = parseInt(
  process.env.PIPELINE_TIMEOUT_MS || String(20 * 60 * 1000), 10
);

// SSE_TIMEOUT_MS: how long the SSE stream stays open before giving up.
//   Raised from 10 min → 30 min to handle 7-part documents (~21 min total).
const SSE_TIMEOUT_MS = parseInt(
  process.env.SSE_TIMEOUT_MS || String(30 * 60 * 1000), 10
);

const SSE_POLL_INTERVAL_MS    = parseInt(process.env.SSE_POLL_INTERVAL_MS    || "3000",  10);
const BRIDGE_BUSY_MAX_WAIT_MS = parseInt(process.env.BRIDGE_BUSY_MAX_WAIT_MS || String(18 * 60 * 1000), 10);
const BRIDGE_BUSY_POLL_MS     = parseInt(process.env.BRIDGE_BUSY_POLL_MS     || "8000", 10);

const PART_WORD_LIMIT  = parseInt(process.env.TARANG_PART_WORD_LIMIT  || "3800", 10);
const PART_WORD_MARGIN = parseInt(process.env.TARANG_PART_WORD_MARGIN || "100",  10);

// How long a doc can be in "processing" before we consider it stuck (from a crash/redeploy).
// If a doc has been processing for longer than this on startup, we mark it error.
const STUCK_THRESHOLD_MS = parseInt(
  process.env.STUCK_THRESHOLD_MS || String(35 * 60 * 1000), 10  // 35 min
);


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
// v2.4.3 FIX: lookback window reduced from 200 → 50 words, with 70% size guard.
const splitTextIntoParts = (text, wordLimit, margin = 0) => {
  const words = text.trim().split(/\s+/);

  if (words.length <= wordLimit + margin) return [text];

  const parts = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + wordLimit, words.length);

    if (end >= words.length) {
      parts.push(words.slice(start).join(" ").trim());
      break;
    }

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

      if (actualCut >= wordLimit * 0.7) {
        parts.push(words.slice(start, start + actualCut).join(" ").trim());
        start += actualCut;
        continue;
      }
    }

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


// ── BUG 2 FIX: Recover stuck docs on startup ──────────────────────────────────
// Call this from server.js after connectDB() completes.
// Any doc stuck in "processing" longer than STUCK_THRESHOLD_MS was almost
// certainly orphaned by a Render redeploy or crash. Mark it as error so the
// SSE stream (or next frontend poll) resolves immediately instead of hanging.
const recoverStuckDocuments = async () => {
  try {
    const stuckBefore = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await Document.find({
      pipelineStatus: "processing",
      updatedAt:      { $lt: stuckBefore },
    });

    if (stuck.length === 0) {
      console.log("✓ No stuck documents found on startup.");
      return;
    }

    console.warn(`⚠  Found ${stuck.length} stuck document(s) — marking as error (likely orphaned by redeploy).`);

    for (const doc of stuck) {
      await Document.findByIdAndUpdate(doc._id, {
        $set: {
          pipelineStatus: "error",
          pipelineError:  "Processing was interrupted (server restart or redeploy). Please re-upload.",
        },
      });
      console.warn(`  ✗ Recovered | docId=${doc.docId} | title="${doc.title}" | stuck since ${doc.updatedAt?.toISOString()}`);
    }
  } catch (err) {
    console.error("✗ recoverStuckDocuments failed:", err.message);
  }
};


// ── Process one part through pipeline/audio → Cloudinary → DB ────────────────
const processOnePart = async ({
  partText, partDocId, partTitle, cognitiveState, ttsEngine, voiceId,
  userRole, userId, originalFilename, format, partNumber, totalParts, parentDocId,
}) => {
  console.log(`⏳ Waiting for bridge to be free | part=${partNumber}/${totalParts} | docId=${partDocId}`);
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

  const startedAt = Date.now();
  console.log(`→ Bridge /pipeline/audio | part=${partNumber}/${totalParts} | docId=${partDocId} | words=${partWords} | timeout=${PIPELINE_TIMEOUT_MS/1000}s`);

  const { data: bridgeRes } = await bridge.post("/pipeline/audio", form, {
    headers:          form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
    timeout:          PIPELINE_TIMEOUT_MS,   // explicit per-call timeout
  });

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const pd = bridgeRes.data;
  console.log(`✓ Bridge /pipeline/audio OK | part=${partNumber}/${totalParts} | docId=${partDocId} | words=${pd.word_count} | dur=${pd.duration_sec}s | elapsed=${elapsed}s`);

  let audioCloudUrl = null, audioPublicId = null;
  if (isConfigured() && pd.mp3_b64) {
    try {
      console.log(`→ Uploading to Cloudinary | part=${partNumber}/${totalParts} | docId=${partDocId}`);
      const mp3Buffer = Buffer.from(pd.mp3_b64, "base64");
      const uploaded  = await uploadAudioBuffer(mp3Buffer, {
        folder:        `tarang/audio/${userId}`,
        publicId:      `${partDocId}_modulated`,
        resource_type: "video",
      });
      audioCloudUrl = uploaded.url;
      audioPublicId = uploaded.publicId;
      console.log(`✓ Cloudinary OK | part=${partNumber}/${totalParts} | docId=${partDocId} | url=${audioCloudUrl}`);
    } catch (e) {
      console.error(`✗ Cloudinary FAILED (non-fatal, audio still saved locally) | part=${partNumber}/${totalParts} | docId=${partDocId} | error=${e.message}`);
    }
  } else if (!isConfigured()) {
    console.log(`ℹ  Cloudinary not configured — skipping upload | part=${partNumber}/${totalParts}`);
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

  console.log(`✓ DB updated | part=${partNumber}/${totalParts} | docId=${partDocId} | status=audio_ready | redirect=${redirectTarget}`);
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

  console.log(`→ Upload received | docId=${part1DocId} | file=${req.file.originalname} | size=${req.file.size}B | user=${req.user._id}`);

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
    const bgStart = Date.now();
    try {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`→ Background pipeline START | docId=${part1DocId} | file=${fileOrigName}`);
      console.log(`  EXTRACT_TIMEOUT  : ${EXTRACT_TIMEOUT_MS/1000}s`);
      console.log(`  PIPELINE_TIMEOUT : ${PIPELINE_TIMEOUT_MS/1000}s`);
      console.log(`  SSE_TIMEOUT      : ${SSE_TIMEOUT_MS/1000}s`);
      console.log(`${"═".repeat(60)}\n`);

      await wakeBridge();
      console.log(`✓ Bridge wake OK | docId=${part1DocId}`);

      // ── Step 1: Wait for bridge to be free ───────────────────────────────
      const free = await waitForBridgeFree(part1DocId);
      if (!free) throw new Error("Bridge busy — cannot extract.");

      // ── Step 2: Extract ───────────────────────────────────────────────────
      const FormData    = require("form-data");
      const extractForm = new FormData();
      extractForm.append("file", fileBuffer, { filename: fileOrigName, contentType: fileMimetype });

      const extractStart = Date.now();
      console.log(`→ Bridge /extract START | docId=${part1DocId} | file=${fileOrigName} | timeout=${EXTRACT_TIMEOUT_MS/1000}s`);

      const { data: extractRes } = await bridge.post("/extract", extractForm, {
        headers:          extractForm.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        timeout:          EXTRACT_TIMEOUT_MS,   // BUG 1 FIX: explicit long timeout
      });

      const extractElapsed = Math.round((Date.now() - extractStart) / 1000);

      if (extractRes.status !== "success") {
        throw new Error(extractRes.error || "Extraction failed");
      }

      // ── Use raw_text for splitting (not the TTS-optimized text) ──────────
      const splitSource = extractRes.data.raw_text || extractRes.data.text;

      if (!extractRes.data.raw_text) {
        console.error(`✗ CRITICAL | bridge did not return raw_text | docId=${part1DocId} | Update bridge.py to v2.0.1!`);
      }

      if (!splitSource || !splitSource.trim()) {
        throw new Error("Extraction returned empty text");
      }

      const actualWords    = splitSource.trim().split(/\s+/).length;
      const optimizedWords = extractRes.data.word_count;

      console.log(`✓ Bridge /extract COMPLETE | docId=${part1DocId} | elapsed=${extractElapsed}s`);
      console.log(`  raw_text_words  : ${actualWords}`);
      console.log(`  optimized_words : ${optimizedWords}`);
      console.log(`  part_word_limit : ${PART_WORD_LIMIT}`);
      console.log(`  part_word_margin: ${PART_WORD_MARGIN}`);
      console.log(`  format          : ${extractRes.data.format}`);

      // ── Step 3: Split ─────────────────────────────────────────────────────
      const parts      = splitTextIntoParts(splitSource, PART_WORD_LIMIT, PART_WORD_MARGIN);
      const totalParts = parts.length;
      const partSizes  = parts.map(p => p.trim().split(/\s+/).length);

      console.log(`→ Split complete | docId=${part1DocId} | raw_words=${actualWords} | parts=${totalParts} | sizes=[${partSizes.join(", ")}] words`);

      const redirectTarget = totalParts === 1 ? "audio_player" : "dashboard";
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
        { $set: { isMultiPart: totalParts > 1, totalParts, frontendRedirectTarget: redirectTarget } }
      );

      // ── Step 4: Pre-create stubs for parts 2..N ──────────────────────────
      const partDocIds = [part1DocId];
      if (totalParts > 1) {
        console.log(`→ Creating ${totalParts - 1} stub document(s) for parts 2..${totalParts} | parentDocId=${part1DocId}`);
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
          console.log(`  → Stub created | part=${i + 1}/${totalParts} | docId=${pDocId} | words=${partSizes[i]}`);
        }
      }

      // ── Step 5: Process part 1 first (unblocks frontend redirect) ────────
      console.log(`\n→ Processing part 1/${totalParts} (priority — unblocks frontend) | docId=${part1DocId}`);
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
        const isTimeout = partErr.code === "ECONNABORTED" || partErr.message?.includes("timeout");
        console.error(`✗ Part 1 FAILED | docId=${part1DocId} | ${isTimeout ? "TIMEOUT" : "ERROR"} | ${partErr.message}`);
        await Document.findOneAndUpdate(
          { docId: part1DocId, userId },
          { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
        );
        return;  // abort — no point processing parts 2..N
      }

      // ── Step 6: Process parts 2..N ────────────────────────────────────────
      if (totalParts > 1) {
        let successCount = 1;
        for (let i = 1; i < totalParts; i++) {
          const partDocId = partDocIds[i];
          console.log(`\n→ Processing part ${i + 1}/${totalParts} | docId=${partDocId}`);
          try {
            await processOnePart({
              partText:         parts[i],
              partDocId,
              partTitle:        `${documentTitle} — Part ${i + 1}`,
              cognitiveState, ttsEngine, voiceId, userRole, userId,
              originalFilename: fileOrigName, format,
              partNumber: i + 1, totalParts, parentDocId: part1DocId,
            });
            successCount++;
          } catch (partErr) {
            const isTimeout = partErr.code === "ECONNABORTED" || partErr.message?.includes("timeout");
            console.error(`✗ Part ${i + 1}/${totalParts} FAILED | docId=${partDocId} | ${isTimeout ? "TIMEOUT" : "ERROR"} | ${partErr.message}`);
            await Document.findOneAndUpdate(
              { docId: partDocId, userId },
              { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
            );
            // continue processing remaining parts — don't abort
          }
        }

        const totalElapsed = Math.round((Date.now() - bgStart) / 1000);
        console.log(`\n${"═".repeat(60)}`);
        console.log(`✓ Pipeline complete | parentDocId=${part1DocId} | parts=${successCount}/${totalParts} succeeded | total_elapsed=${totalElapsed}s`);
        console.log(`${"═".repeat(60)}\n`);
      } else {
        const totalElapsed = Math.round((Date.now() - bgStart) / 1000);
        console.log(`✓ Pipeline complete (single part) | docId=${part1DocId} | total_elapsed=${totalElapsed}s`);
      }

    } catch (err) {
      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      const totalElapsed = Math.round((Date.now() - bgStart) / 1000);
      console.error(`\n✗ Background pipeline FAILED | docId=${part1DocId} | ${isTimeout ? "TIMEOUT" : "ERROR"} | elapsed=${totalElapsed}s | ${err.message}`);
      if (isTimeout) {
        console.error(`  ↳ The bridge took longer than ${EXTRACT_TIMEOUT_MS/1000}s to respond.`);
        console.error(`  ↳ Set EXTRACT_TIMEOUT_MS env var to increase (current: ${EXTRACT_TIMEOUT_MS}ms).`);
      }
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
      console.log(`→ MCQ pipeline START | docId=${docId} | title="${doc.title}"`);
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
      console.error(`✗ MCQ FAILED | docId=${docId} | ${err.message}`);
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


// ── GET /api/documents/:docId/status (SSE) ────────────────────────────────────
// BUG 3 FIX: SSE_TIMEOUT_MS raised to 30 min.
// Also added "stuck" detection: if a doc has been in "processing" for
// STUCK_THRESHOLD_MS and we're past that, self-resolve with an error instead
// of hanging until SSE timeout fires.
const streamDocumentStatus = async (req, res) => {
  const { docId } = req.params;
  const userId    = req.user._id;

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sseStart = Date.now();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const heartbeat   = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 25_000);

  const hardTimeout = setTimeout(() => {
    const elapsed = Math.round((Date.now() - sseStart) / 1000);
    console.warn(`⏰ SSE hard timeout | docId=${docId} | elapsed=${elapsed}s`);
    send("error", { message: "Processing is taking longer than expected. Check back in a few minutes — your document may still be processing." });
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
        "docId pipelineStatus pipelineError title audioUrl audioCloudUrl sessionsGenerated isMultiPart partNumber totalParts parentDocId frontendRedirectTarget updatedAt"
      ).lean();

      if (!doc) {
        send("error", { message: "Document not found." });
        return cleanup();
      }

      const status  = doc.pipelineStatus;
      const elapsed = Math.round((Date.now() - sseStart) / 1000);

      // BUG 2 FIX: detect docs stuck in "processing" after a crash/redeploy
      // If the doc hasn't been updated in STUCK_THRESHOLD_MS, it's orphaned.
      if (status === "processing" && doc.updatedAt) {
        const msSinceUpdate = Date.now() - new Date(doc.updatedAt).getTime();
        if (msSinceUpdate > STUCK_THRESHOLD_MS) {
          console.warn(`⚠  Stuck doc detected via SSE | docId=${docId} | last_update=${Math.round(msSinceUpdate/1000)}s ago`);
          // Mark it as error in DB
          await Document.findOneAndUpdate(
            { docId, userId },
            { $set: { pipelineStatus: "error", pipelineError: "Processing was interrupted (server restart). Please re-upload." } }
          );
          send("status", {
            docId, status: "error", title: doc.title,
            pipelineError: "Processing was interrupted (server restart). Please re-upload.",
            isMultiPart: doc.isMultiPart || false, partNumber: doc.partNumber || 1, totalParts: doc.totalParts || 1,
          });
          send("done", { docId, status: "error", frontendRedirectTarget: "dashboard", isMultiPart: doc.isMultiPart || false });
          return cleanup();
        }
      }

      send("status", {
        docId: doc.docId,
        status,
        title:                  doc.title,
        audioUrl:               doc.audioCloudUrl || doc.audioUrl || null,
        sessionsGenerated:      doc.sessionsGenerated || 0,
        pipelineError:          doc.pipelineError || null,
        isMultiPart:            doc.isMultiPart || false,
        partNumber:             doc.partNumber || 1,
        totalParts:             doc.totalParts || 1,
        frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
        elapsedSec:             elapsed,
      });

      if (status === "ready" || status === "audio_ready" || status === "error") {
        send("done", {
          docId: doc.docId,
          status,
          frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
          isMultiPart: doc.isMultiPart || false,
        });
        return cleanup();
      }

      pollTimer = setTimeout(poll, SSE_POLL_INTERVAL_MS);
    } catch (err) {
      console.error(`✗ SSE poll error | docId=${docId} | ${err.message}`);
      send("error", { message: "Internal error during status check." });
      cleanup();
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
  recoverStuckDocuments,   // export so server.js can call it on startup
};