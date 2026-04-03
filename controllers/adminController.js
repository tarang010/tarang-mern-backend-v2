// Tarang 1.0.0.1 — controllers/adminController.js
// Admin-only endpoints

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

  // Prevent admin from demoting themselves
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

  const avgScore = await Analytics.aggregate([
    { $group: { _id: null, avg: { $avg: "$averageScorePct" } } },
  ]);

  res.json({
    status: "success",
    data: {
      totalUsers,
      totalDocuments,
      totalSessions,
      completedSessions,
      analyticsGenerated: analyticsCount,
      platformAverageScore: avgScore[0]
        ? `${(avgScore[0].avg * 100).toFixed(1)}%`
        : "N/A",
    },
  });
};

// ── GET /api/admin/documents ──────────────────────────────────────────────────
const getAllDocuments = async (req, res) => {
  const Document = require("../models/Document");
  const documents = await Document.find()
    .populate("userId", "name email role")
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ status: "success", data: { documents, total: documents.length } });
};

module.exports = { getAllUsers, getUserDetail, updateUserRole, deactivateUser, getStats, getAllDocuments };
