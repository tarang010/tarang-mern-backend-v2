// Tarang 1.0.0.1 — scripts/fixStaleSessions.js
// Run once to repair sessions stuck in "in_progress" that were actually submitted
// Usage: node scripts/fixStaleSessions.js
//
// This fixes sessions where:
//   - status is "in_progress" but submittedAt exists (submitted but status not updated)
//   - correctCount > 0 but scorePct is null (score calculated but not saved)

require("dotenv").config({ path: "../.env" });
const mongoose = require("mongoose");

const SESSION_SCHEMA = new mongoose.Schema({
  userId:         mongoose.Schema.Types.ObjectId,
  documentId:     mongoose.Schema.Types.ObjectId,
  docId:          String,
  sessionNumber:  Number,
  difficulty:     String,
  status:         String,
  startedAt:      Date,
  submittedAt:    Date,
  scorePct:       Number,
  correctCount:   Number,
  totalQuestions: Number,
  userAnswers:    mongoose.Schema.Types.Mixed,
  overrideUsed:   Boolean,
}, { timestamps: true });

const Session = mongoose.model("Session", SESSION_SCHEMA);

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB Atlas");

  // Find all sessions stuck in "in_progress" that have a submittedAt timestamp
  const stale = await Session.find({
    status:      "in_progress",
    submittedAt: { $exists: true, $ne: null },
  });

  console.log(`Found ${stale.length} stale session(s) to fix`);

  for (const s of stale) {
    // Calculate scorePct from correctCount if not set
    const scorePct = (s.scorePct == null && s.correctCount > 0 && s.totalQuestions > 0)
      ? parseFloat((s.correctCount / s.totalQuestions).toFixed(4))
      : s.scorePct;

    await Session.findByIdAndUpdate(s._id, {
      $set: {
        status:   "completed",
        scorePct: scorePct,
      },
    });

    console.log(
      `Fixed Session ${s.sessionNumber} (${s.difficulty}) | ` +
      `docId: ${s.docId} | ` +
      `score: ${scorePct != null ? (scorePct * 100).toFixed(1) + "%" : "null"}`
    );
  }

  // Also ensure next sessions are unlocked for completed sessions
  const completed = await Session.find({ status: "completed" });
  for (const s of completed) {
    if (s.sessionNumber < 3) {
      const nextLocked = await Session.findOne({
        docId:         s.docId,
        userId:        s.userId,
        sessionNumber: s.sessionNumber + 1,
        status:        "locked",
      });
      if (nextLocked) {
        await Session.findByIdAndUpdate(nextLocked._id, {
          $set: { status: "available" },
        });
        console.log(
          `Unlocked Session ${nextLocked.sessionNumber} for docId: ${s.docId}`
        );
      }
    }
  }

  console.log("\nAll stale sessions fixed.");
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
