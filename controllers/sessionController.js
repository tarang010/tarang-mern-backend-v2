// Tarang 2.2.0 — controllers/sessionController.js
// STATELESS: Reads session_state from MongoDB, passes to bridge as dict.
// Bridge returns updated_state which Express saves back to MongoDB.
//
// v2.2.0 changes:
//   - getStatus: added in-flight dedup guard — if the same docId+userId has
//     a getStatus call already in progress, subsequent requests wait for that
//     result instead of firing a new bridge call. Eliminates the duplicate
//     /status XHRs visible in the network tab when the frontend re-renders.
//   - getStatus: result cached in-memory for CACHE_TTL_MS (2s). Rapid
//     sequential polls within the TTL window get the cached response instantly.
//   - No logic changes to audioDone, getQuestions, overrideWindow, submitTest,
//     getResults — all behaviour is identical to v1.0.0.4.

const Document  = require("../models/Document");
const Session   = require("../models/Session");
const Analytics = require("../models/Analytics");
const { bridge, bridgePost } = require("../config/bridge");

// ── In-flight dedup + short-TTL cache for getStatus ──────────────────────────
// Key: `${docId}:${userId}`
// Value: { promise, resolvedAt, result }
const _statusCache    = new Map();
const CACHE_TTL_MS    = 2000; // serve cached result for 2s after resolution
const _statusInflight = new Map(); // Key → Promise (in-flight dedup)


// ── Helper: get current session_state from MongoDB ────────────────────────────
const getSessionState = async (docId, userId) => {
  const sessions = await Session.find({ docId, userId }).sort({ sessionNumber: 1 });
  if (!sessions.length) return null;

  const withState = sessions.find(s => s.sessionState);
  if (withState?.sessionState) {
    const state = JSON.parse(JSON.stringify(withState.sessionState));
    for (const s of sessions) {
      const n = s.sessionNumber.toString();
      if (state.sessions[n]) {
        state.sessions[n].status        = s.status;
        state.sessions[n].started_at    = s.startedAt?.toISOString()   || null;
        state.sessions[n].submitted_at  = s.submittedAt?.toISOString() || null;
        state.sessions[n].score_pct     = s.scorePct   ?? null;
        state.sessions[n].override_used = s.overrideUsed || false;
        state.sessions[n].user_answers  = s.userAnswers  || {};
      }
    }
    const doc = await Document.findOne({ docId, userId });
    if (doc) {
      state.all_sessions_complete = doc.allSessionsComplete || false;
      state.answers_unlocked      = doc.allSessionsComplete || false;
    }
    return state;
  }

  // Fallback: build state from scratch (for older documents)
  const doc = await Document.findOne({ docId, userId });
  const state = {
    document_id:             docId,
    document_title:          doc?.title || "",
    num_questions:           sessions[0]?.questions?.length || 10,
    s1_to_s2_hours:          12.0,
    s2_to_s3_hours:          24.0,
    current_session:         0,
    audio_completed_at:      null,
    sessions:                {},
    all_sessions_complete:   doc?.allSessionsComplete || false,
    answers_unlocked:        doc?.allSessionsComplete || false,
    poor_score_warning:      false,
    relistening_recommended: false,
    sessions_meta:           {},
    created_at:              doc?.createdAt?.toISOString() || new Date().toISOString(),
  };

  for (const s of sessions) {
    const n = s.sessionNumber.toString();
    state.sessions[n] = {
      status:        s.status,
      started_at:    s.startedAt?.toISOString()   || null,
      submitted_at:  s.submittedAt?.toISOString() || null,
      score_pct:     s.scorePct    ?? null,
      override_used: s.overrideUsed || false,
      user_answers:  s.userAnswers  || {},
    };
    if (s.scorePct !== null && s.scorePct < 0.30) {
      state.poor_score_warning      = true;
      state.relistening_recommended = true;
    }
  }

  return state;
};


// ── Helper: save updated_state back to MongoDB Session records ────────────────
const saveUpdatedState = async (docId, userId, updated_state) => {
  if (!updated_state) return;

  for (const n of [1, 2, 3]) {
    const s = updated_state.sessions?.[n.toString()];
    if (!s) continue;
    await Session.findOneAndUpdate(
      { docId, userId, sessionNumber: n },
      {
        $set: {
          status:       s.status,
          startedAt:    s.started_at    ? new Date(s.started_at)   : null,
          submittedAt:  s.submitted_at  ? new Date(s.submitted_at) : null,
          scorePct:     s.score_pct     ?? null,
          overrideUsed: s.override_used || false,
          userAnswers:  s.user_answers  || {},
          sessionState: updated_state,
        }
      }
    );
  }

  if (updated_state.all_sessions_complete) {
    await Document.findOneAndUpdate(
      { docId },
      { allSessionsComplete: true }
    );
  }
};


// ── POST /api/sessions/audio-done ─────────────────────────────────────────────
const audioDone = async (req, res) => {
  const { docId } = req.body;

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const session_state = await getSessionState(docId, req.user._id);
  if (!session_state) {
    return res.status(404).json({ status: "error", error: "Session state not found." });
  }

  const { data } = await bridgePost("/mcq/audio-completed", {
    doc_id:        docId,
    role:          req.user.role,
    session_state,
  });

  const result = data.data;

  await saveUpdatedState(docId, req.user._id, result.updated_state);

  await Session.findOneAndUpdate(
    { docId, userId: req.user._id, sessionNumber: 1 },
    { status: "available" }
  );

  if (req.user.role === "admin") {
    await Session.updateMany(
      { docId, userId: req.user._id },
      { status: "available" }
    );
  }

  res.json({ status: "success", data: result });
};


// ── GET /api/sessions/:docId/status ──────────────────────────────────────────
// v2.2.0: in-flight dedup + 2s cache.
//
// WHY: The frontend was calling this on every render cycle during the quiz
// "Preparing..." state — sometimes firing 3-4 identical requests within
// milliseconds of each other. Each one hit MongoDB + the bridge.
//
// HOW:
//   1. If a result for this docId+userId was computed < CACHE_TTL_MS ago,
//      return it immediately without touching MongoDB or the bridge.
//   2. If a bridge call for this docId+userId is already in flight,
//      await that same promise instead of issuing a second one.
//   3. Otherwise run the normal flow and cache the result.
const getStatus = async (req, res) => {
  const { docId } = req.params;
  const userId    = req.user._id.toString();
  const cacheKey  = `${docId}:${userId}`;

  // ── 1. Serve from cache if fresh ─────────────────────────────────────────
  const cached = _statusCache.get(cacheKey);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return res.json({ status: "success", data: cached.result });
  }

  // ── 2. Dedup in-flight requests ───────────────────────────────────────────
  if (_statusInflight.has(cacheKey)) {
    try {
      const result = await _statusInflight.get(cacheKey);
      return res.json({ status: "success", data: result });
    } catch (err) {
      return res.status(500).json({ status: "error", error: err.message });
    }
  }

  // ── 3. Normal flow — run once, cache result ───────────────────────────────
  const work = (async () => {
    const doc = await Document.findOne({ docId, userId: req.user._id });
    if (!doc) throw Object.assign(new Error("Document not found."), { statusCode: 404 });

    const session_state = await getSessionState(docId, req.user._id);
    if (!session_state) throw Object.assign(new Error("Session state not found."), { statusCode: 404 });

    const { data } = await bridgePost("/mcq/status", {
      doc_id:        docId,
      role:          req.user.role,
      session_state,
    });

    const result = data.data;

    if (result.updated_state) {
      await saveUpdatedState(docId, req.user._id, result.updated_state);
    }

    return result;
  })();

  // Register in-flight promise so concurrent calls can share it
  _statusInflight.set(cacheKey, work);

  try {
    const result = await work;

    // Cache the result
    _statusCache.set(cacheKey, { result, resolvedAt: Date.now() });

    return res.json({ status: "success", data: result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ status: "error", error: err.message });
  } finally {
    // Always remove from in-flight map regardless of outcome
    _statusInflight.delete(cacheKey);
  }
};


// ── POST /api/sessions/:docId/:session/questions ──────────────────────────────
const getQuestions = async (req, res) => {
  const { docId, session } = req.params;
  const sessionNum = parseInt(session);

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const sessionRecord = await Session.findOne({
    docId, userId: req.user._id, sessionNumber: sessionNum,
  });
  if (!sessionRecord) {
    return res.status(404).json({ status: "error", error: "Session not found." });
  }

  const session_state = await getSessionState(docId, req.user._id);
  if (!session_state) {
    return res.status(404).json({ status: "error", error: "Session state not found." });
  }

  try {
    const { data } = await bridgePost("/mcq/questions", {
      doc_id:         docId,
      session:        sessionNum,
      role:           req.user.role,
      session_state,
      questions_data: { questions: sessionRecord.questions || [] },
    });

    const result = data.data;

    if (result.updated_state) {
      await saveUpdatedState(docId, req.user._id, result.updated_state);
      await Session.findOneAndUpdate(
        { docId, userId: req.user._id, sessionNumber: sessionNum,
          status: { $nin: ["completed"] } },
        { status: "in_progress", startedAt: new Date() }
      );
    }

    res.json({ status: "success", data: result });
  } catch (err) {
    const bridgeData = err.response?.data || {};
    return res.status(err.response?.status || 403).json({
      status:          "error",
      error:           bridgeData.error || err.message,
      reason:          bridgeData.reason          || null,
      can_override:    bridgeData.can_override    || false,
      hours_remaining: bridgeData.hours_remaining || null,
    });
  }
};


// ── POST /api/sessions/:docId/override ───────────────────────────────────────
const overrideWindow = async (req, res) => {
  const { docId } = req.params;

  const session_state = await getSessionState(docId, req.user._id);
  if (!session_state) {
    return res.status(404).json({ status: "error", error: "Session state not found." });
  }

  const { data } = await bridgePost("/mcq/override", {
    doc_id:        docId,
    session_state,
  });

  const result = data.data;

  if (result.updated_state) {
    await saveUpdatedState(docId, req.user._id, result.updated_state);
  }

  await Session.findOneAndUpdate(
    { docId, userId: req.user._id, sessionNumber: 1 },
    { overrideUsed: true }
  );

  res.json({ status: "success", data: result });
};


// ── POST /api/sessions/:docId/:session/submit ─────────────────────────────────
const submitTest = async (req, res) => {
  const { docId, session } = req.params;
  const { userAnswers }    = req.body;
  const sessionNum         = parseInt(session);

  if (!userAnswers || typeof userAnswers !== "object") {
    return res.status(400).json({
      status: "error",
      error:  "userAnswers must be an object: { q001: ['A'], q002: ['B','C'] }",
    });
  }

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const sessionRecord = await Session.findOne({
    docId, userId: req.user._id, sessionNumber: sessionNum,
  });
  if (!sessionRecord?.answerKey) {
    return res.status(404).json({ status: "error", error: "Answer key not found." });
  }

  const session_state = await getSessionState(docId, req.user._id);
  if (!session_state) {
    return res.status(404).json({ status: "error", error: "Session state not found." });
  }

  const { data } = await bridgePost("/mcq/submit", {
    doc_id:          docId,
    session:         sessionNum,
    user_answers:    userAnswers,
    role:            req.user.role,
    session_state,
    answer_key_data: sessionRecord.answerKey,
  });

  const result = data.data;

  if (result.updated_state) {
    await saveUpdatedState(docId, req.user._id, result.updated_state);
  }

  // FIX (from v1.0.0.4): read real score from updated_state, NOT result.score_pct
  // result.score_pct is null for sessions 1 & 2 (hidden until all 3 done).
  const realScorePct = result.updated_state?.sessions?.[sessionNum.toString()]?.score_pct
    ?? result.score_pct
    ?? null;

  await Session.findOneAndUpdate(
    { docId, userId: req.user._id, sessionNumber: sessionNum },
    {
      $set: {
        status:         "completed",
        submittedAt:    new Date(),
        userAnswers,
        scorePct:       realScorePct,
        correctCount:   result.correct_count   ?? 0,
        totalQuestions: result.total_questions ?? 10,
      }
    },
    { new: true }
  );

  // Invalidate the status cache for this doc so next getStatus is fresh
  const cacheKey = `${docId}:${req.user._id.toString()}`;
  _statusCache.delete(cacheKey);

  // Auto-generate analytics when all 3 sessions complete
  if (result.all_sessions_done) {
    await Document.findOneAndUpdate({ docId }, { allSessionsComplete: true });

    try {
      const sessions        = await Session.find({ docId, userId: req.user._id }).sort({ sessionNumber: 1 });
      const all_questions   = {};
      const all_answer_keys = {};
      for (const s of sessions) {
        const n = s.sessionNumber;
        all_questions[n]   = { questions: s.questions || [] };
        all_answer_keys[n] = s.answerKey || { answers: {} };
      }

      const analyticsRes = await bridgePost("/analytics", {
        doc_id:          docId,
        role:            req.user.role,
        session_state:   result.updated_state || session_state,
        all_questions:   { "1": all_questions[1], "2": all_questions[2], "3": all_questions[3] },
        all_answer_keys: { "1": all_answer_keys[1], "2": all_answer_keys[2], "3": all_answer_keys[3] },
      });

      const { analytics: ad, html_content } = analyticsRes.data.data;

      await Analytics.findOneAndUpdate(
        { docId, userId: req.user._id },
        {
          userId:                 req.user._id,
          documentId:             doc._id,
          docId,
          averageScorePct:        ad.summary.average_score_pct,
          averageScoreDisplay:    ad.summary.average_score_display,
          averageScoreLabel:      ad.summary.average_score_label,
          learningCurve:          ad.summary.learning_curve,
          learningCurveDesc:      ad.summary.learning_curve_desc,
          improvementS1toS3:      ad.summary.improvement_s1_to_s3,
          totalTimeSpentMin:      ad.summary.total_time_spent_min,
          bestSession:            ad.summary.best_session,
          worstSession:           ad.summary.worst_session,
          scoreProgression:       ad.score_progression,
          weakTopics:             ad.weak_topics,
          suggestions:            ad.suggestions,
          relisteningRecommended: ad.summary.relistening_recommended,
          poorScoreWarning:       ad.summary.poor_score_warning,
          fullAnalytics:          ad,
          analyticsHtml:          html_content,
        },
        { upsert: true, new: true }
      );
      console.log(`✓ Analytics auto-generated for ${docId}`);
    } catch (analyticsErr) {
      console.error("Analytics auto-generation failed (non-fatal):", analyticsErr.message);
    }
  }

  res.json({ status: "success", data: result });
};


// ── GET /api/sessions/:docId/results ─────────────────────────────────────────
const getResults = async (req, res) => {
  const { docId } = req.params;

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const session_state = await getSessionState(docId, req.user._id);
  if (!session_state) {
    return res.status(404).json({ status: "error", error: "Session state not found." });
  }

  const sessions        = await Session.find({ docId, userId: req.user._id }).sort({ sessionNumber: 1 });
  const all_answer_keys = {};
  for (const s of sessions) {
    all_answer_keys[`session_${s.sessionNumber}`] = s.answerKey?.answers || {};
  }

  const { data } = await bridgePost("/mcq/results", {
    doc_id:          docId,
    role:            req.user.role,
    session_state,
    all_answer_keys,
  });

  res.json({ status: "success", data: data.data });
};


module.exports = {
  audioDone, getStatus, getQuestions,
  overrideWindow, submitTest, getResults,
};
