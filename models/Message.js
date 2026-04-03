// Tarang 1.0.0.1 — models/Message.js
// Chat messages between friends
// Document shares are a special message type with file attachment

const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    // Conversation participants (always 2 users, sorted for consistency)
    conversationId: {
      type: String, required: true, index: true,
      // Format: sorted([userA._id, userB._id]).join("_")
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true,
    },
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", required: true,
    },

    // Message content
    type: {
      type: String,
      enum: ["text", "document_share"],
      default: "text",
    },
    text: { type: String, default: "" },

    // Document share fields (only when type === "document_share")
    sharedDocument: {
      documentId:      { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
      docId:           String,
      title:           String,
      originalFilename:String,
      wordCount:       Number,
      format:          String,
      // Path to the actual file on disk (for download)
      filePath:        String,
      // Extracted text (stored permanently in MongoDB)
      extractedText:   String,
      // Auto-delete file after 24 hours
      fileExpiresAt:   Date,
      fileDeleted:     { type: Boolean, default: false },
    },

    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

// Helper to generate consistent conversation ID from two user IDs
messageSchema.statics.conversationId = (userA, userB) =>
  [userA.toString(), userB.toString()].sort().join("_");

module.exports = mongoose.model("Message", messageSchema);
