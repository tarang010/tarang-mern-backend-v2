// Tarang 2.3.0 — models/User.js
// Place at: backend/models/User.js
//
// v2.3.0 addition:
//   isEmailVerified  — false until the signup OTP is confirmed.
//   emailVerifiedAt  — timestamp of verification.
//   login() in authController checks isEmailVerified before proceeding.

const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String, required: true, trim: true, maxlength: 80,
    },
    email: {
      type: String, required: true, unique: true,
      lowercase: true, trim: true,
    },
    password: {
      type: String, required: true, minlength: 6, select: false,
    },
    role: {
      type: String, enum: ["user", "admin"], default: "user",
    },
    isActive: { type: Boolean, default: true },

    // v2.3.0 — email verification
    isEmailVerified:  { type: Boolean, default: false },
    emailVerifiedAt:  { type: Date,    default: null  },

    themePreference: { type: String, enum: ["dark", "light"], default: "dark" },
    lastLoginAt: { type: Date },

    // ── Cognitive mode (from /suggest-mode quiz) ──────────────────────────
    preferredCognitiveMode: {
      type:    String,
      enum:    ["deep_focus", "memory", "calm", "deep_relaxation", "sleep", null],
      default: null,
    },
    cognitiveQuizAnswers:  { type: mongoose.Schema.Types.Mixed, default: null },
    cognitiveQuizTakenAt:  { type: Date, default: null },

    onboardingCompleted:   { type: Boolean, default: false },
    onboardingCompletedAt: { type: Date,    default: null  },

    academicProfile: {
      background: {
        type: String,
        enum: ["engineering", "commerce", "medical", "law", "other", null],
        default: null,
      },
      backgroundOther: { type: String, trim: true, default: "" },
      specialization:  { type: String, trim: true, default: "" },
      focusAreas: [{ type: String, trim: true }],
      answers: { type: mongoose.Schema.Types.Mixed, default: null },
      dashboardConfig: {
        track:         { type: String,  trim: true, default: "" },
        practiceMode:  { type: String,  trim: true, default: "" },
        primaryWidget: { type: String,  trim: true, default: "" },
        enableMiniIde: { type: Boolean, default: false },
      },
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.matchPassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model("User", userSchema);