// Tarang 1.0.0.2 — controllers/adminController.js
//
// v1.0.0.2 fix:
//   getStats platformAverageScore: Session.scorePct is stored as a 0-1 decimal
//   (e.g. 0.72 = 72%). Analytics.averageScorePct is also 0-1 (bridge returns
//   decimals). The old code did `(platformAverage * 100).toFixed(1)` which is
//   correct IF the value is 0-1 — but the ?? chain mixed both sources without
//   normalizing, so if Analytics had already stored a 0-100 value from an older
//   bridge version, the display would show "7200.0%" instead of "72.0%".
//
//   Fix: normalize both aggregation results to 0-1 before the ?? chain, then
//   multiply by 100 once for display. A guard clamps the result to [0, 100].

const User      = require("../models/User");
const Document  = require("../models/Document");
const Session   = require("../models/Session");
const Analytics = require("../models/Analytics");

// ── GET /api/admin/users ──────────────────────────────────────────────────────
const getAllUsers = async (req, res) => {
  const users = await User.find()
    .select("-password")
    .sort({ createdAt: -1 });

  res.json({ status: "success", data: { users, total: users.length } });
};

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
const getUserDetail = async (req, res) => {
  const user = await User.findById(req.params.id).select("-password");
  if (!user) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  const documents = await Document.find({ userId: user._id }).sort({ createdAt: -1 });
  const sessions  = await Session.find({ userId: user._id });

  res.json({
    status: "success",
    data:   { user, documents, sessions },
  });
};

// ── PATCH /api/admin/users/:id/role ──────────────────────────────────────────
const updateUserRole = async (req, res) => {
  const { role } = req.body;
  if (!["user", "admin"].includes(role)) {
    return res.status(400).json({ status: "error", error: "Role must be 'user' or 'admin'." });
  }

  if (req.params.id === req.user._id.toString()) {
    return res.status(400).json({ status: "error", error: "You cannot change your own role." });
  }

  const user = await User.findByIdAndUpdate(
    req.params.id, { role }, { new: true }
  ).select("-password");

  if (!user) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  res.json({ status: "success", data: { user } });
};

// ── PATCH /api/admin/users/:id/deactivate ────────────────────────────────────
const deactivateUser = async (req, res) => {
  if (req.params.id === req.user._id.toString()) {
    return res.status(400).json({ status: "error", error: "You cannot deactivate yourself." });
  }

  const user = await User.findByIdAndUpdate(
    req.params.id, { isActive: false }, { new: true }
  ).select("-password");

  if (!user) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  res.json({ status: "success", data: { user, message: "User deactivated." } });
};

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
const getStats = async (req, res) => {
  const [
    totalUsers, totalDocuments, totalSessions,
    completedSessions, analyticsCount,
  ] = await Promise.all([
    User.countDocuments(),
    Document.countDocuments(),
    Session.countDocuments(),
    Session.countDocuments({ status: "completed" }),
    Analytics.countDocuments(),
  ]);

  // Session.scorePct is stored as 0-1 decimal (e.g. 0.72 = 72%)
  const sessionAvg = await Session.aggregate([
    {
      $match: {
        status: "completed",
        scorePct: { $ne: null },
      },
    },
    { $group: { _id: null, avg: { $avg: "$scorePct" } } },
  ]);

  // Analytics.averageScorePct: bridge stores as 0-1 decimal.
  // Guard: if any record is > 1 it was stored as 0-100 — normalize it back.
  const analyticsAvgRaw = await Analytics.aggregate([
    { $match: { averageScorePct: { $gt: 0 } } },
    { $group: { _id: null, avg: { $avg: "$averageScorePct" } } },
  ]);

  // Normalize analytics avg: if > 1, assume it was stored as 0-100 and divide
  const rawAnalyticsAvg = analyticsAvgRaw[0]?.avg ?? null;
  const normalizedAnalyticsAvg =
    rawAnalyticsAvg != null
      ? rawAnalyticsAvg > 1
        ? rawAnalyticsAvg / 100   // was stored as 0-100 — convert to 0-1
        : rawAnalyticsAvg         // already 0-1
      : null;

  // Session avg is always 0-1 (scorePct stored by submitTest as a 0-1 value)
  const platformAverage = sessionAvg[0]?.avg ?? normalizedAnalyticsAvg ?? null;

  // Display: multiply by 100, clamp to [0, 100]
  let platformAverageDisplay = "N/A";
  if (platformAverage != null) {
    const pct = Math.min(Math.max(platformAverage * 100, 0), 100);
    platformAverageDisplay = `${pct.toFixed(1)}%`;
  }

  res.json({
    status: "success",
    data: {
      totalUsers,
      totalDocuments,
      totalSessions,
      completedSessions,
      analyticsGenerated: analyticsCount,
      platformAverageScore: platformAverageDisplay,
    },
  });
};

// ── GET /api/admin/documents ──────────────────────────────────────────────────
const getAllDocuments = async (req, res) => {
  const documents = await Document.find()
    .populate("userId", "name email role")
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ status: "success", data: { documents, total: documents.length } });
};

module.exports = { getAllUsers, getUserDetail, updateUserRole, deactivateUser, getStats, getAllDocuments };