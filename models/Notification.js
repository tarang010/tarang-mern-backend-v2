// Tarang 1.0.0.1 — models/Notification.js
// In-app notifications for friend requests, document shares etc.

const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true, index: true,
    },
    type: {
      type: String,
      enum: ["friend_request", "friend_accepted", "document_shared", "share_processed"],
      required: true,
    },
    title:   { type: String, required: true },
    message: { type: String, required: true },
    data:    { type: mongoose.Schema.Types.Mixed, default: {} },
    read:    { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
