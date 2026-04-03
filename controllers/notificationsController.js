// Tarang 1.0.0.1 — controllers/notificationsController.js

const Notification = require("../models/Notification");

// ── GET /api/notifications ────────────────────────────────────────────────────
const getNotifications = async (req, res) => {
  const notifications = await Notification.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50);

  const unreadCount = await Notification.countDocuments({
    userId: req.user._id,
    read:   false,
  });

  res.json({ status: "success", data: { notifications, unreadCount } });
};

// ── PATCH /api/notifications/read-all ─────────────────────────────────────────
const markAllRead = async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false }, { read: true });
  res.json({ status: "success", data: { message: "All notifications marked as read." } });
};

// ── PATCH /api/notifications/:id/read ─────────────────────────────────────────
const markRead = async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { read: true }
  );
  res.json({ status: "success", data: { message: "Notification marked as read." } });
};

module.exports = { getNotifications, markAllRead, markRead };
