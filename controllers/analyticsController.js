// Tarang 1.0.0.1 — controllers/analyticsController.js
// STATELESS: Reads session data from MongoDB, passes to bridge as dicts.
// Bridge returns analytics + html_content string.
// Express stores both in MongoDB Analytics collection.

const Analytics = require("../models/Analytics");
const Document  = require("../models/Document");
const Session   = require("../models/Session");
const { bridge } = require("../config/bridge");


// ── Helper: build all_questions and all_answer_keys from MongoDB ──────────────
const buildSessionDicts = async (docId, userId) => {
  const sessions = await Session.find({ docId, userId }).sort({ sessionNumber: 1 });

  const all_questions   = {};
  const all_answer_keys = {};
  let   session_state   = null;

  for (const s of sessions) {
    const n = s.sessionNumber;
    all_questions[n]   = { questions: s.questions || [] };
    all_answer_keys[n] = s.answerKey || { answers: {} };
    // Use the most recent session_state (they all share the same state)
    if (s.sessionState) session_state = s.sessionState;
  }

  return { all_questions, all_answer_keys, session_state };
};


// ── Helper: build session_state from MongoDB Session records ──────────────────
// Used when session_state was not stored (older documents)
const buildSessionStateFromSessions = (sessions, doc) => {
  const state = {
    document_id:           doc.docId,
    document_title:        doc.title,
    num_questions:         sessions[0]?.questions?.length || 10,
    s1_to_s2_hours:        12.0,
    s2_to_s3_hours:        24.0,
    current_session:       0,
    audio_completed_at:    null,
    sessions:              {},
    all_sessions_complete: doc.allSessionsComplete || false,
    answers_unlocked:      doc.allSessionsComplete || false,
    poor_score_warning:    false,
    relistening_recommended: false,
    sessions_meta:         {},
    created_at:            doc.createdAt?.toISOString() || new Date().toISOString(),
  };

  for (const s of sessions) {
    const n = s.sessionNumber.toString();
    state.sessions[n] = {
      status:       s.status,
      started_at:   s.startedAt?.toISOString()   || null,
      submitted_at: s.submittedAt?.toISOString() || null,
      score_pct:    s.scorePct    ?? null,
      override_used:s.overrideUsed || false,
      user_answers: s.userAnswers || {},
    };
    if (s.scorePct !== null && s.scorePct < 0.30) {
      state.poor_score_warning      = true;
      state.relistening_recommended = true;
    }
  }

  return state;
};


// ── GET /api/analytics/:docId ─────────────────────────────────────────────────
const getAnalytics = async (req, res) => {
  const { docId }    = req.params;
  const forceRefresh = req.query.refresh === "true";

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  // ── Try MongoDB cache first ───────────────────────────────────────────────
  const cached    = await Analytics.findOne({ docId, userId: req.user._id });
  const cacheValid = cached?.averageScorePct != null && cached?.learningCurve != null;

  if (cacheValid && !forceRefresh) {
    const analyticsData = cached.fullAnalytics || {
      document_id:    docId,
      document_title: doc.title,
      role:           req.user.role,
      generated_at:   cached.updatedAt,
      summary: {
        average_score_pct:       cached.averageScorePct,
        average_score_display:   cached.averageScoreDisplay,
        average_score_label:     cached.averageScoreLabel,
        // WRS fields
        wrs:             cached.wrs,
        wrs_display:     cached.wrsDisplay,
        wrs_label:       cached.wrsLabel,
        retention_decay: cached.retentionDecay,
        bonuses_earned:  cached.bonusesEarned,
        // Learning curve
        learning_curve:          cached.learningCurve,
        learning_curve_desc:     cached.learningCurveDesc,
        improvement_s1_to_s3:    cached.improvementS1toS3,
        total_time_spent_min:    cached.totalTimeSpentMin,
        best_session:            cached.bestSession,
        worst_session:           cached.worstSession,
        relistening_recommended: cached.relisteningRecommended,
        poor_score_warning:      cached.poorScoreWarning,
      },
      score_progression: cached.scoreProgression || [],
      weak_topics:       cached.weakTopics       || [],
      suggestions:       cached.suggestions      || [],
      brain_facts:       [],
    };
    return res.json({ status: "success", data: { analytics: analyticsData } });
  }

  // ── Generate from bridge ──────────────────────────────────────────────────
  // Read all session data from MongoDB — pass to bridge as dicts
  const { all_questions, all_answer_keys, session_state: storedState } =
    await buildSessionDicts(docId, req.user._id);

  const sessions     = await Session.find({ docId, userId: req.user._id }).sort({ sessionNumber: 1 });
  const session_state = storedState || buildSessionStateFromSessions(sessions, doc);

  const { data: bridgeRes } = await bridge.post("/analytics", {
    doc_id:          docId,
    role:            req.user.role,
    session_state,
    all_questions:   { "1": all_questions[1], "2": all_questions[2], "3": all_questions[3] },
    all_answer_keys: { "1": all_answer_keys[1], "2": all_answer_keys[2], "3": all_answer_keys[3] },
  });

  const { analytics: ad, html_content } = bridgeRes.data;

  // ── Cache in MongoDB ──────────────────────────────────────────────────────
  if (ad?.summary) {
    try {
      await Analytics.findOneAndUpdate(
        { docId, userId: req.user._id },
        {
          userId:                req.user._id,
          documentId:            doc._id,
          docId,
          // Flat average
          averageScorePct:       ad.summary.average_score_pct,
          averageScoreDisplay:   ad.summary.average_score_display,
          averageScoreLabel:     ad.summary.average_score_label,
          // WRS
          wrs:                   ad.summary.wrs            ?? null,
          wrsDisplay:            ad.summary.wrs_display    ?? null,
          wrsLabel:              ad.summary.wrs_label      ?? null,
          retentionDecay:        ad.summary.retention_decay ?? null,
          bonusesEarned:         ad.summary.bonuses_earned  ?? [],
          // Learning curve
          learningCurve:         ad.summary.learning_curve,
          learningCurveDesc:     ad.summary.learning_curve_desc,
          improvementS1toS3:     ad.summary.improvement_s1_to_s3,
          totalTimeSpentMin:     ad.summary.total_time_spent_min,
          bestSession:           ad.summary.best_session,
          worstSession:          ad.summary.worst_session,
          scoreProgression:      ad.score_progression,
          weakTopics:            ad.weak_topics,
          suggestions:           ad.suggestions,
          relisteningRecommended:ad.summary.relistening_recommended,
          poorScoreWarning:      ad.summary.poor_score_warning,
          fullAnalytics:         ad,
          analyticsHtml:         html_content,
        },
        { upsert: true, new: true }
      );
    } catch (cacheErr) {
      console.error("Analytics cache save failed:", cacheErr.message);
    }
  }

  res.json({ status: "success", data: { analytics: ad } });
};


// ── GET /api/analytics/:docId/report ─────────────────────────────────────────
// Returns the HTML analytics report stored in MongoDB as a rendered HTML page
const getAnalyticsReport = async (req, res) => {
  const { docId } = req.params;

  const doc = await Document.findOne({ docId, userId: req.user._id });
  if (!doc) {
    return res.status(404).json({ status: "error", error: "Document not found." });
  }

  const analytics = await Analytics.findOne({ docId, userId: req.user._id });
  if (!analytics?.analyticsHtml) {
    return res.status(404).json({
      status: "error",
      error:  "Analytics report not generated yet. Complete all 3 sessions first.",
    });
  }

  // Serve as rendered HTML page
  res.setHeader("Content-Type", "text/html");
  res.send(analytics.analyticsHtml);
};


// ── GET /api/analytics (admin only) ──────────────────────────────────────────
const getAllAnalytics = async (req, res) => {
  const analytics = await Analytics.find()
    .populate("userId",     "name email")
    .populate("documentId", "title format")
    .sort({ createdAt: -1 })
    .limit(100)
    .select("-fullAnalytics -analyticsHtml"); // don't send huge payloads in list

  res.json({ status: "success", data: { analytics } });
};


module.exports = { getAnalytics, getAnalyticsReport, getAllAnalytics };
