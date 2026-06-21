// Tarang 3.0.1 — controllers/documentController.js
//
// ══════════════════════════════════════════════════════════════════════════════
// ARCHITECTURE CHANGE vs 2.5.1
// ══════════════════════════════════════════════════════════════════════════════
//
// BEFORE (2.5.1 problem):
//   1. MERN sends full document to bridge /extract
//   2. Bridge returns raw_text → MERN splits locally
//   3. MERN sends each part to bridge /pipeline/audio-text sequentially
//   4. Bridge processes full doc in memory → 512 MB OOM on Render → 502
//   5. User waits 10–15 min seeing nothing → frustration
//
// AFTER (3.0.0 fix):
//   1. MERN calls bridge /extract → gets raw_text (fast, low memory)
//   2. MERN splits raw_text into ≤3800-word parts (CPU-only, no bridge)
//   3. MERN sends ONLY Part 1 text to bridge /pipeline/audio-text
//   4. Part 1 done → 202 returned to frontend IMMEDIATELY → user redirected
//      to /listen and starts listening Part 1 within ~30s
//   5. Parts 2..N processed sequentially in background (setImmediate chain)
//   6. MCQ generated per-part immediately after each part's audio completes
//      (not on full text) → MCQ available while user listens Part 1
//   7. Node keep-alive pings bridge /health every 45s to prevent cold start
//   8. Bridge never holds >3800 words in TTS memory → no OOM
//
// MCQ PER PART:
//   Each part gets its own 3 sessions (Easy/Medium/Hard).
//   Sessions are scoped by docId (partDocId) so the existing session
//   schema and frontend code work unchanged.
//
// KEEP-ALIVE:
//   startBridgeKeepAlive() is called from server.js after startup.
//   Pings /health every 45s — well inside Render's 15-min spin-down window.
//
// fixStaleSessions.js:
//   Still needed — run manually after any crash/redeploy to repair
//   sessions stuck in "in_progress".
//
// ── v3.0.1 changes ────────────────────────────────────────────────────────────
//   - Added downloadAudio: proxies the Cloudinary audio file through our
//     server with a Content-Disposition header carrying the real document
//     title, so users get a properly-named .mp3 instead of the Cloudinary
//     public_id filename. No DB schema changes.
// ══════════════════════════════════════════════════════════════════════════════

const Document = require("../models/Document");
const Session  = require("../models/Session");
const { bridge, bridgePost, wakeBridge } = require("../config/bridge");
const { uploadAudioBuffer, isConfigured } = require("../config/cloudinary");
const { sendAudioReadyEmail } = require("../utils/mailer");
const User = require("../models/User");

// ── Timeouts ──────────────────────────────────────────────────────────────────
const EXTRACT_TIMEOUT_MS  = parseInt(process.env.EXTRACT_TIMEOUT_MS  || String(15 * 60 * 1000), 10);
const PIPELINE_TIMEOUT_MS = parseInt(process.env.PIPELINE_TIMEOUT_MS || String(20 * 60 * 1000), 10);
const SSE_TIMEOUT_MS      = parseInt(process.env.SSE_TIMEOUT_MS      || String(30 * 60 * 1000), 10);

const SSE_POLL_INTERVAL_MS    = parseInt(process.env.SSE_POLL_INTERVAL_MS    || "3000",  10);
const BRIDGE_BUSY_MAX_WAIT_MS = parseInt(process.env.BRIDGE_BUSY_MAX_WAIT_MS || String(18 * 60 * 1000), 10);
const BRIDGE_BUSY_POLL_MS     = parseInt(process.env.BRIDGE_BUSY_POLL_MS     || "8000",  10);
const STUCK_THRESHOLD_MS      = parseInt(process.env.STUCK_THRESHOLD_MS      || String(35 * 60 * 1000), 10);

// Part splitting config
const PART_WORD_LIMIT  = parseInt(process.env.TARANG_PART_WORD_LIMIT  || "3800", 10);
const PART_WORD_MARGIN = parseInt(process.env.TARANG_PART_WORD_MARGIN || "100",  10);

// Keep-alive interval — 45s (well inside Render's 15-min spin-down)
const KEEPALIVE_INTERVAL_MS = parseInt(process.env.BRIDGE_KEEPALIVE_MS || "45000", 10);

// Download proxy timeout
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || "30000", 10);


// ── Keep-alive ────────────────────────────────────────────────────────────────
// Called once from server.js after startup. Pings bridge /health every 45s
// so Render free tier never spins down while the Node server is running.
let _keepAliveTimer = null;
const startBridgeKeepAlive = () => {
  if (_keepAliveTimer) return; // already started
  _keepAliveTimer = setInterval(async () => {
    try {
      await bridge.get("/health", { timeout: 8_000 });
    } catch {
      // silent — bridge may be cold-starting, next ping will succeed
    }
  }, KEEPALIVE_INTERVAL_MS);
  console.log(`✓ Bridge keep-alive started | interval=${KEEPALIVE_INTERVAL_MS/1000}s`);
};


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


// ── Text splitter (MERN-side, no bridge involved) ─────────────────────────────
const splitTextIntoParts = (text, wordLimit = PART_WORD_LIMIT, margin = PART_WORD_MARGIN) => {
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
    const lastSentEnd   = Math.max(
      lookback.lastIndexOf(". "),
      lookback.lastIndexOf("! "),
      lookback.lastIndexOf("? "),
    );

    if (lastSentEnd !== -1) {
      const cutAt    = lookback.substring(0, lastSentEnd + 1);
      const cutWords = cutAt.trim().split(/\s+/).length;
      const actual   = (lookbackStart - start) + cutWords;
      if (actual >= wordLimit * 0.7) {
        parts.push(words.slice(start, start + actual).join(" ").trim());
        start += actual;
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


// ── Recover stuck docs on startup ─────────────────────────────────────────────
const recoverStuckDocuments = async () => {
  try {
    const stuckBefore = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await Document.find({ pipelineStatus: "processing", updatedAt: { $lt: stuckBefore } });
    if (stuck.length === 0) { console.log("✓ No stuck documents."); return; }
    console.warn(`⚠  ${stuck.length} stuck document(s) — marking as error.`);
    for (const doc of stuck) {
      await Document.findByIdAndUpdate(doc._id, {
        $set: { pipelineStatus: "error", pipelineError: "Processing interrupted (server restart). Please re-upload." }
      });
      console.warn(`  ✗ Recovered | docId=${doc.docId} | stuck since ${doc.updatedAt?.toISOString()}`);
    }
  } catch (err) {
    console.error("✗ recoverStuckDocuments failed:", err.message);
  }
};


// ── Generate MCQ for one part ─────────────────────────────────────────────────
// Called immediately after each part's audio is ready.
// partText: the raw part text (≤3800 words) — NOT the full document.
const _generatePartMCQ = async ({ partText, partDocId, partTitle, doc, userId }) => {
  try {
    const wordCount = partText.trim().split(/\s+/).length;
    if (wordCount < 50) {
      console.log(`⚠  Part too short for MCQ | docId=${partDocId} | words=${wordCount}`);
      return;
    }

    console.log(`→ MCQ START | docId=${partDocId} | words=${wordCount}`);

    const { data: mcqRes } = await bridgePost("/pipeline/mcq", {
      extracted_text: partText,
      document_title: partTitle,
      doc_id:         partDocId,
    }, { timeout: PIPELINE_TIMEOUT_MS });

    const md           = mcqRes.data;
    const difficulties = { 1: "Easy", 2: "Medium", 3: "Hard" };

    for (const n of [1, 2, 3]) {
      const qData      = md[`session_${n}_questions`];
      const aData      = md[`session_${n}_answers`];
      const initStatus = n === 1 ? "pending" : "locked";

      await Session.findOneAndUpdate(
        { docId: partDocId, userId, sessionNumber: n },
        {
          $set: {
            questions:     qData?.questions || [],
            answerKey:     aData || null,
            sessionState:  md.session_state || null,
            userId,
            documentId:    doc._id,
            docId:         partDocId,
            sessionNumber: n,
            difficulty:    difficulties[n],
          },
          $setOnInsert: {
            status:       initStatus,
            startedAt:    null,
            submittedAt:  null,
            scorePct:     null,
            correctCount: 0,
            userAnswers:  {},
            overrideUsed: false,
          },
        },
        { upsert: true, new: true }
      );
    }

    await Document.findOneAndUpdate(
      { docId: partDocId },
      { $set: { sessionsGenerated: md.sessions_generated, pipelineStatus: "ready" } }
    );

    console.log(`✓ MCQ COMPLETE | docId=${partDocId} | sessions=3`);
  } catch (err) {
    console.error(`✗ MCQ FAILED | docId=${partDocId} | ${err.message}`);
    await Document.findOneAndUpdate(
      { docId: partDocId },
      { $set: { pipelineError: `MCQ failed: ${err.message}` } }
    );
  }
};


// ── Process one part: audio + Cloudinary + DB + MCQ ──────────────────────────
const _processOnePart = async ({
  partText, partDocId, partTitle, cognitiveState, ttsEngine, voiceId,
  userRole, userId, originalFilename, format, partNumber, totalParts,
  parentDocId, file1Metadata = {}, docMongoId,
}) => {
  console.log(`⏳ Waiting bridge free | part=${partNumber}/${totalParts} | docId=${partDocId}`);
  const free = await waitForBridgeFree(partDocId);
  if (!free) throw new Error("Bridge was busy for too long.");

  const partWords = partText.trim().split(/\s+/).length;
  const t0 = Date.now();
  console.log(`→ /pipeline/audio-text | part=${partNumber}/${totalParts} | docId=${partDocId} | words=${partWords}`);

  const { data: bridgeRes } = await bridgePost("/pipeline/audio-text", {
    text:            partText,
    cognitive_state: cognitiveState,
    document_title:  partTitle,
    tts_engine:      ttsEngine,
    role:            userRole,
    voice_id:        voiceId || null,
    file1_metadata:  file1Metadata,
  }, { timeout: PIPELINE_TIMEOUT_MS });

  const pd = bridgeRes.data;
  console.log(`✓ /pipeline/audio-text OK | part=${partNumber}/${totalParts} | dur=${pd.duration_sec}s | elapsed=${Math.round((Date.now()-t0)/1000)}s`);

  // ── Cloudinary upload ──────────────────────────────────────────────────────
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
      console.log(`✓ Cloudinary | part=${partNumber}/${totalParts} | docId=${partDocId}`);
    } catch (e) {
      console.error(`✗ Cloudinary FAILED (non-fatal) | part=${partNumber}/${totalParts} | ${e.message}`);
    }
  }

  // ── DB update → audio_ready ────────────────────────────────────────────────
  const updatedDoc = await Document.findOneAndUpdate(
    { docId: partDocId, userId },
    {
      $set: {
        title:               partTitle,
        wordCount:           pd.word_count,
        durationSec:         pd.duration_sec,
        extractedText:       partText,          // store part text for MCQ
        beatFreqHz:          pd.beat_freq_hz,
        pipelineStatus:      "audio_ready",
        pipelineError:       null,
        audioCloudUrl,
        audioPublicId,
        captions:            pd.captions?.length ? pd.captions : null,
        captionsGeneratedAt: pd.captions?.length ? new Date() : null,
        isMultiPart:         totalParts > 1,
        partNumber,
        totalParts,
        parentDocId:         parentDocId || null,
        format,
        originalFilename,
        cognitiveState,
        ttsEngine,
        frontendRedirectTarget: totalParts === 1 ? "audio_player" : "dashboard",
      }
    },
    { upsert: true, new: true }
  );

  console.log(`✓ DB audio_ready | part=${partNumber}/${totalParts} | docId=${partDocId}`);

  // ── Per-part MCQ (non-blocking — runs after audio is confirmed ready) ──────
  // Fire-and-forget: user can start listening immediately, MCQ generates
  // while they listen. Each part gets its own 3 sessions.
  _generatePartMCQ({
    partText,
    partDocId,
    partTitle,
    doc: updatedDoc,
    userId,
  }).catch(err => console.error(`✗ _generatePartMCQ | docId=${partDocId} | ${err.message}`));

  return pd;
};


// ══════════════════════════════════════════════════════════════════════════════
// POST /api/documents/upload
// ══════════════════════════════════════════════════════════════════════════════
//
// Flow:
//   1. Extract text from document (bridge /extract — fast, low memory)
//   2. Split raw_text into ≤3800-word parts on MERN side
//   3. Create DB records for all parts (status: processing)
//   4. Process Part 1 audio synchronously in background
//   5. Return 202 immediately once Part 1 docId is known (before audio done)
//      → frontend polls SSE for Part 1 status → redirects on audio_ready
//   6. Parts 2..N process sequentially after Part 1
//   7. Email sent when ALL parts are audio_ready
//
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
  const userId     = req.user._id;
  const userRole   = req.user.role;
  const format     = req.file.originalname.split(".").pop().toLowerCase();

  // Create Part 1 DB record immediately so SSE polling can start
  const doc = await Document.findOneAndUpdate(
    { docId: part1DocId, userId },
    {
      $set: {
        userId, docId: part1DocId, title: documentTitle,
        originalFilename: req.file.originalname, format,
        cognitiveState, ttsEngine,
        pipelineStatus:  "processing",
        pipelineError:   null,
        sessionsGenerated: 0,
        partNumber: 1, totalParts: 1, isMultiPart: false,
        parentDocId: null, frontendRedirectTarget: "audio_player",
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Respond immediately — frontend starts SSE polling on part1DocId
  res.status(202).json({
    status: "success",
    data: {
      document: doc,
      phase:    "processing",
      message:  "Upload received. Part 1 audio generating — you'll be redirected shortly.",
    },
  });

  // Capture buffer before async — req.file is gone after response
  const fileBuffer   = req.file.buffer;
  const fileOrigName = req.file.originalname;
  const fileMimetype = req.file.mimetype;

  setImmediate(async () => {
    const bgStart = Date.now();
    try {
      // ── Step 1: Wake bridge ───────────────────────────────────────────────
      const awake = await wakeBridge();
      if (!awake) throw new Error("Bridge did not wake — aborting pipeline.");
      console.log(`✓ Bridge awake | docId=${part1DocId}`);

      // ── Step 2: Extract (bridge /extract) ────────────────────────────────
      // Only extract once — returns raw_text for MERN-side splitting.
      const free = await waitForBridgeFree(part1DocId);
      if (!free) throw new Error("Bridge busy — cannot extract.");

      const FormData    = require("form-data");
      const extractForm = new FormData();
      extractForm.append("file", fileBuffer, { filename: fileOrigName, contentType: fileMimetype });

      console.log(`→ /extract | docId=${part1DocId} | file=${fileOrigName}`);
      const { data: extractRes } = await bridge.post("/extract", extractForm, {
        headers: extractForm.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        timeout:          EXTRACT_TIMEOUT_MS,
      });

      if (extractRes.status !== "success") throw new Error(extractRes.error || "Extraction failed");

      const splitSource = extractRes.data.raw_text || extractRes.data.text;
      if (!splitSource?.trim()) throw new Error("Extraction returned empty text");

      const totalWords = splitSource.trim().split(/\s+/).length;
      console.log(`✓ /extract DONE | docId=${part1DocId} | raw_words=${totalWords}`);

      // ── Step 3: MERN-side split ───────────────────────────────────────────
      const parts      = splitTextIntoParts(splitSource);
      const totalParts = parts.length;
      const partSizes  = parts.map(p => p.trim().split(/\s+/).length);
      console.log(`→ Split | parts=${totalParts} | sizes=[${partSizes.join(",")}] words | limit=${PART_WORD_LIMIT}`);

      // ── Step 4: Create DB records for all parts ───────────────────────────
      const redirectTarget = totalParts === 1 ? "audio_player" : "dashboard";
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
        { $set: { isMultiPart: totalParts > 1, totalParts, frontendRedirectTarget: redirectTarget } }
      );

      const partDocIds = [part1DocId];
      const partTitles = [totalParts > 1 ? `${documentTitle} — Part 1` : documentTitle];

      if (totalParts > 1) {
        for (let i = 1; i < totalParts; i++) {
          const pDocId    = makeDocId(`${part1DocId}_part${i + 1}`);
          const pTitle    = `${documentTitle} — Part ${i + 1}`;
          partDocIds.push(pDocId);
          partTitles.push(pTitle);
          await Document.findOneAndUpdate(
            { docId: pDocId, userId },
            {
              $set: {
                userId, docId: pDocId, title: pTitle,
                originalFilename: fileOrigName, format, cognitiveState, ttsEngine,
                pipelineStatus: "processing", pipelineError: null, sessionsGenerated: 0,
                isMultiPart: true, partNumber: i + 1, totalParts,
                parentDocId: part1DocId, frontendRedirectTarget: "dashboard",
              }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        }
      }

      const file1Metadata = extractRes.data.metadata || {};

      // ── Step 5: Process Part 1 (user is already redirected, listening soon) ─
      try {
        await _processOnePart({
          partText: parts[0], partDocId: part1DocId, partTitle: partTitles[0],
          cognitiveState, ttsEngine, voiceId, userRole, userId,
          originalFilename: fileOrigName, format,
          partNumber: 1, totalParts, parentDocId: null,
          file1Metadata, docMongoId: doc._id,
        });
      } catch (partErr) {
        console.error(`✗ Part 1 FAILED | docId=${part1DocId} | ${partErr.message}`);
        await Document.findOneAndUpdate(
          { docId: part1DocId, userId },
          { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
        );
        return; // stop — don't process remaining parts if Part 1 fails
      }

      // ── Step 6: Process remaining parts sequentially ──────────────────────
      let allReady = true;
      if (totalParts > 1) {
        for (let i = 1; i < totalParts; i++) {
          console.log(`\n→ Part ${i+1}/${totalParts} | docId=${partDocIds[i]}`);
          try {
            await _processOnePart({
              partText: parts[i], partDocId: partDocIds[i], partTitle: partTitles[i],
              cognitiveState, ttsEngine, voiceId, userRole, userId,
              originalFilename: fileOrigName, format,
              partNumber: i + 1, totalParts, parentDocId: part1DocId,
              file1Metadata, docMongoId: doc._id,
            });
          } catch (partErr) {
            console.error(`✗ Part ${i+1} FAILED | docId=${partDocIds[i]} | ${partErr.message}`);
            await Document.findOneAndUpdate(
              { docId: partDocIds[i], userId },
              { $set: { pipelineStatus: "error", pipelineError: partErr.message } }
            );
            allReady = false;
          }
        }
      }

      // ── Step 7: Send "audio ready" email when all parts done ─────────────
      if (allReady) {
        try {
          const user = await User.findById(userId).select("email name");
          if (user?.email) {
            const listenUrl = `${process.env.CLIENT_URL}/listen/${part1DocId}`;
            await sendAudioReadyEmail(user.email, user.name, documentTitle, listenUrl);
            console.log(`✓ Audio-ready email sent | to=${user.email} | docId=${part1DocId}`);
          }
        } catch (mailErr) {
          console.error(`✗ Audio-ready email FAILED (non-fatal) | ${mailErr.message}`);
        }
      }

      const totalElapsed = Math.round((Date.now() - bgStart) / 1000);
      console.log(`✓ Pipeline complete | parts=${totalParts} | elapsed=${totalElapsed}s`);

    } catch (err) {
      const totalElapsed = Math.round((Date.now() - bgStart) / 1000);
      console.error(`✗ Pipeline FAILED | docId=${part1DocId} | elapsed=${totalElapsed}s | ${err.message}`);
      await Document.findOneAndUpdate(
        { docId: part1DocId, userId },
        { $set: { pipelineStatus: "error", pipelineError: err.message || "Pipeline failed" } }
      );
    }
  });
};


// ── POST /api/documents/upload/stream (SSE proxy — kept for compatibility) ────
const streamAudioPipeline = async (req, res) => {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emit = (step, pct, extra = {}) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ step, pct, ...extra })}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  if (!req.file) { emit("error", -1, { error: "No file uploaded." }); return res.end(); }

  const awake = await wakeBridge();
  if (!awake) { emit("error", -1, { error: "Python service unavailable." }); return res.end(); }

  const axios    = require("axios");
  const FormData = require("form-data");
  const fd       = new FormData();
  fd.append("file",            req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
  fd.append("cognitive_state", req.body.cognitive_state || "deep_focus");
  fd.append("document_title",  req.body.document_title  || req.file.originalname.replace(/\.[^.]+$/, ""));
  fd.append("tts_engine",      req.body.tts_engine      || "edge");
  fd.append("voice_id",        req.body.voice_id        || "");
  fd.append("role",            req.user.role            || "user");

  const BRIDGE_URL = process.env.PYTHON_BRIDGE_URL || "http://localhost:9801";
  let pythonRes;
  try {
    pythonRes = await axios.post(`${BRIDGE_URL}/pipeline/audio/stream`, fd, {
      headers: fd.getHeaders(), responseType: "stream",
      timeout: PIPELINE_TIMEOUT_MS, maxContentLength: Infinity, maxBodyLength: Infinity,
    });
  } catch (err) {
    emit("error", -1, { error: `Bridge: ${err.message}` });
    return res.end();
  }

  let buf = "";
  pythonRes.data.on("data", (chunk) => {
    if (res.writableEnded) return;
    buf += chunk.toString("utf8");
    const events = buf.split("\n\n");
    buf = events.pop();
    for (const event of events) {
      if (!event.trim()) continue;
      res.write(event + "\n\n");
      if (typeof res.flush === "function") res.flush();
      if (event.includes('"step":"done"') || event.includes('"step": "done"')) {
        try {
          const ev = JSON.parse(event.replace(/^data:\s*/, ""));
          _persistStreamResult(ev, req.user).catch(e => console.error("Stream persist:", e.message));
        } catch { /* non-fatal */ }
      }
    }
  });
  pythonRes.data.on("end",   () => { if (!res.writableEnded) res.end(); });
  pythonRes.data.on("error", (err) => {
    if (!res.writableEnded) { emit("error", -1, { error: `Stream interrupted: ${err.message}` }); res.end(); }
  });
  req.on("close", () => { if (pythonRes?.data?.destroy) pythonRes.data.destroy(); });
};


// ── Helper: persist streaming result ─────────────────────────────────────────
const _persistStreamResult = async (ev, user) => {
  if (!ev.mp3_b64 || !ev.document_title) return;
  const crypto  = require("crypto");
  const docId   = crypto.createHash("md5")
    .update(ev.document_title + String(user._id) + Date.now())
    .digest("hex").slice(0, 12);
  let audioCloudUrl = null, audioPublicId = null;
  if (isConfigured()) {
    try {
      const uploaded = await uploadAudioBuffer(Buffer.from(ev.mp3_b64, "base64"), {
        folder: `tarang/audio/${user._id}`, publicId: `${docId}_stream`,
      });
      audioCloudUrl = uploaded.url;
      audioPublicId = uploaded.publicId;
    } catch (e) { console.error(`✗ Cloudinary stream persist: ${e.message}`); }
  }
  await Document.findOneAndUpdate(
    { docId, userId: user._id },
    {
      $set: {
        userId: user._id, docId, title: ev.document_title,
        wordCount: ev.word_count || 0, durationSec: ev.duration_sec || 0,
        extractedText: ev.extracted_text || "", beatFreqHz: ev.beat_freq_hz || null,
        pipelineStatus: "audio_ready", pipelineError: null,
        audioCloudUrl, audioPublicId,
        captions: ev.captions?.length ? ev.captions : null,
        captionsGeneratedAt: ev.captions?.length ? new Date() : null,
        isMultiPart: false, partNumber: 1, totalParts: 1,
        cognitiveState: ev.cognitive_state || "deep_focus",
        frontendRedirectTarget: "audio_player",
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`✓ Stream persisted | docId=${docId}`);
};


// ── POST /api/documents/:docId/trigger-mcq ────────────────────────────────────
// Kept for manual re-trigger from frontend if MCQ failed.
// Now calls _generatePartMCQ which operates on the stored extractedText (part text).
const triggerMCQ = async (req, res) => {
  const { docId } = req.params;
  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) return res.status(404).json({ status: "error", error: "Document not found." });

  const existing = await Session.countDocuments({ docId, userId: req.user._id });
  if (existing >= 3) return res.json({ status: "success", data: { message: "MCQ already generated." } });
  if (!doc.extractedText || doc.extractedText.split(" ").length < 50)
    return res.json({ status: "success", data: { message: "Document too short for MCQ." } });

  res.json({ status: "success", data: { message: "MCQ generation started." } });

  setImmediate(() =>
    _generatePartMCQ({
      partText:  doc.extractedText,
      partDocId: docId,
      partTitle: doc.title,
      doc,
      userId:    req.user._id,
    }).catch(err => console.error(`✗ triggerMCQ | docId=${docId} | ${err.message}`))
  );
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
const streamDocumentStatus = async (req, res) => {
  const { docId } = req.params;
  const userId    = req.user._id;

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sseStart = Date.now();
  const send     = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const heartbeat   = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25_000);
  const hardTimeout = setTimeout(() => {
    send("error", { message: "Processing is taking longer than expected. Check back in a few minutes." });
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

      if (!doc) { send("error", { message: "Document not found." }); return cleanup(); }

      const status  = doc.pipelineStatus;
      const elapsed = Math.round((Date.now() - sseStart) / 1000);

      // Auto-recover stuck doc
      if (status === "processing" && doc.updatedAt) {
        const msSince = Date.now() - new Date(doc.updatedAt).getTime();
        if (msSince > STUCK_THRESHOLD_MS) {
          await Document.findOneAndUpdate(
            { docId, userId },
            { $set: { pipelineStatus: "error", pipelineError: "Processing interrupted. Please re-upload." } }
          );
          send("status", { docId, status: "error", title: doc.title, pipelineError: "Processing interrupted.", isMultiPart: doc.isMultiPart || false, partNumber: doc.partNumber || 1, totalParts: doc.totalParts || 1 });
          send("done",   { docId, status: "error", frontendRedirectTarget: "dashboard", isMultiPart: doc.isMultiPart || false });
          return cleanup();
        }
      }

      send("status", {
        docId: doc.docId, status, title: doc.title,
        audioUrl: doc.audioCloudUrl || doc.audioUrl || null,
        sessionsGenerated: doc.sessionsGenerated || 0,
        pipelineError: doc.pipelineError || null,
        isMultiPart: doc.isMultiPart || false,
        partNumber: doc.partNumber || 1,
        totalParts: doc.totalParts || 1,
        frontendRedirectTarget: doc.frontendRedirectTarget || "audio_player",
        elapsedSec: elapsed,
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
      catch (e) { console.error("Cloudinary delete:", e.message); }
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
    return res.json({ status: "success", data: { captions: doc.captions, total: doc.captions.length, cached: true } });
  }
  if (!doc.extractedText || !doc.durationSec)
    return res.status(404).json({ status: "error", error: "Captions not available." });
  const { data } = await bridgePost("/captions", { text: doc.extractedText, duration_sec: doc.durationSec });
  await Document.findOneAndUpdate({ docId }, { captions: data.data.captions, captionsGeneratedAt: new Date() });
  res.json({ status: "success", data: { captions: data.data.captions, total: data.data.total_segments, cached: false } });
};

const getVisualization = async (req, res) => {
  const doc = await Document.findOne({ docId: req.params.docId, userId: req.user._id }, "visualizationHtml");
  if (!doc?.visualizationHtml) return res.status(404).json({ status: "error", error: "Visualization not available." });
  res.setHeader("Content-Type", "text/html");
  res.send(doc.visualizationHtml);
};


// ── GET /api/documents/:docId/download ────────────────────────────────────────
// Streams the audio file through our server (instead of linking directly to
// Cloudinary) so the browser saves it with the real document title, e.g.
// "Thermodynamics Chapter 3.mp3", rather than the Cloudinary public_id
// filename like "a1b2c3d4e5f6_modulated.mp3". Cross-origin <a download>
// attributes are unreliable across browsers, so this proxy guarantees the
// Content-Disposition header is honoured everywhere.
const downloadAudio = async (req, res) => {
  const { docId } = req.params;

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }
  if (!doc.audioCloudUrl) {
    return res.status(404).json({ status: "error", error: "Audio not available for this document yet." });
  }

  // Sanitize title into a filesystem-safe filename
  const safeName = (doc.title || "tarang_audio")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "tarang_audio";

  try {
    const axios = require("axios");
    const upstream = await axios.get(doc.audioCloudUrl, {
      responseType: "stream",
      timeout: DOWNLOAD_TIMEOUT_MS,
    });

    res.setHeader("Content-Type", upstream.headers["content-type"] || "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp3"`);
    if (upstream.headers["content-length"]) {
      res.setHeader("Content-Length", upstream.headers["content-length"]);
    }

    upstream.data.pipe(res);

    upstream.data.on("error", (err) => {
      console.error(`✗ downloadAudio stream error | docId=${docId} | ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (err) {
    console.error(`✗ downloadAudio FAILED | docId=${docId} | ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ status: "error", error: "Failed to fetch audio file." });
    } else {
      res.end();
    }
  }
};


module.exports = {
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
  recoverStuckDocuments,
  startBridgeKeepAlive,
};