// Tarang 1.0.0.1 — models/SharedDocument.js
// Tracks document shares between friends
// Audio files are deleted after TTL (1 or 2 days)
// Only extracted text is kept permanently in MongoDB

const mongoose = require("mongoose");

const sharedDocumentSchema = new mongoose.Schema(
  {
    // Who shared it
    sharedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true, index: true,
    },
    // Who it was shared with
    sharedWith: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true, index: true,
    },
    // Source document
    sourceDocId:    { type: String, required: true },
    sourceDocTitle: { type: String, required: true },

    // Extracted text stored in MongoDB (persists permanently)
    extractedText:  { type: String, default: null },

    // Share link token — unique UUID for link-based access
    shareToken: {
      type: String, required: true, unique: true, index: true,
    },

    // Status of the share
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "expired", "rejected"],
      default: "pending",
    },

    // Recipient's pipeline result (created after they accept + pick cognitive mode)
    recipientDocId:       { type: String,  default: null },
    recipientDocumentId:  { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    cognitiveMode:        { type: String,  default: null },

    // Notification read status
    readByRecipient:  { type: Boolean, default: false },

    // Error if pipeline failed
    pipelineError:    { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SharedDocument", sharedDocumentSchema);
