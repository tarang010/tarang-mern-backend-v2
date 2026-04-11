// Tarang 2.2.0 — utils/jwtSecret.js
//
// ROOT CAUSE OF 401 BUG:
//   The original version stored the JWT secret in a .jwt_secret file on disk.
//   Render's filesystem is EPHEMERAL — it is wiped on every deploy and every
//   cold start. So readSecretFile() always returned null → Case 1 always ran
//   → brand new secret generated on every restart → all tokens invalidated
//   → every user got 401 even immediately after logging in.
//
// FIX:
//   Store the secret in MongoDB (a "Config" document) instead of a file.
//   MongoDB persists across deploys and cold starts. The rotation logic
//   (7-day auto-rotate) is preserved exactly — it just reads/writes MongoDB
//   instead of the filesystem.
//
// FALLBACK:
//   If JWT_SECRET env var is set in Render dashboard, that always wins.
//   This is the simplest option and recommended for new installs.
//   MongoDB-based rotation is the automatic option for existing installs.

const crypto = require("crypto");

const ROTATION_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const SECRET_BYTES = 64;                         // 512-bit

// Lazy-load mongoose to avoid circular deps at module load time
let _Config = null;
const getConfigModel = () => {
  if (_Config) return _Config;
  const mongoose = require("mongoose");
  const schema   = new mongoose.Schema({
    key:         { type: String, required: true, unique: true },
    value:       { type: String, required: true },
    generatedAt: { type: Date,   required: true },
  }, { collection: "app_config" });
  _Config = mongoose.models.AppConfig || mongoose.model("AppConfig", schema);
  return _Config;
};

const generateSecret = () =>
  crypto.randomBytes(SECRET_BYTES).toString("hex");

const readSecretFromDB = async () => {
  try {
    const Config = getConfigModel();
    const doc    = await Config.findOne({ key: "jwt_secret" }).lean();
    if (!doc) return null;
    return { secret: doc.value, generatedAt: new Date(doc.generatedAt) };
  } catch (err) {
    console.error("jwtSecret: DB read failed —", err.message);
    return null;
  }
};

const writeSecretToDB = async (secret) => {
  try {
    const Config = getConfigModel();
    await Config.findOneAndUpdate(
      { key: "jwt_secret" },
      { key: "jwt_secret", value: secret, generatedAt: new Date() },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("jwtSecret: DB write failed —", err.message);
    throw err;
  }
};

// In-memory cache — avoid DB hit on every token verify
let _cachedSecret  = null;
let _cachedAt      = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // re-check DB at most once per hour

const getJwtSecret = () => {
  // Env var always wins
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // Return from cache if fresh
  if (_cachedSecret && _cachedAt && (Date.now() - _cachedAt < CACHE_TTL_MS)) {
    return _cachedSecret;
  }

  // Cache miss but initJwtSecret hasn't run yet — return stale cache if available
  if (_cachedSecret) return _cachedSecret;

  throw new Error(
    "JWT secret not initialised. " +
    "Ensure initJwtSecret() completes before handling requests, " +
    "or set JWT_SECRET in your environment variables."
  );
};

/**
 * Call once at server startup — MUST be awaited before app.listen().
 * Reads secret from MongoDB, rotates if > 7 days old, caches in memory.
 *
 * Rotation logic (same as original, now persisted in MongoDB):
 *   1. No secret in DB   → generate + save → use it
 *   2. Secret > 7 days   → rotate + save   → use new one
 *   3. Secret <= 7 days  → use as-is
 */
const initJwtSecret = async () => {
  // Env var takes priority — skip DB entirely
  if (process.env.JWT_SECRET) {
    _cachedSecret = process.env.JWT_SECRET;
    _cachedAt     = Date.now();
    console.log("✓ JWT secret loaded from environment variable.");
    return process.env.JWT_SECRET;
  }

  const stored = await readSecretFromDB();

  // Case 1: No secret in DB — first deploy
  if (!stored) {
    const secret = generateSecret();
    await writeSecretToDB(secret);
    _cachedSecret = secret;
    _cachedAt     = Date.now();
    console.log("✓ JWT secret generated and saved to DB (new installation).");
    return secret;
  }

  // Case 2: Check age — rotate if expired
  const ageMs   = Date.now() - stored.generatedAt.getTime();
  const daysOld = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  if (ageMs >= ROTATION_MS) {
    const secret = generateSecret();
    await writeSecretToDB(secret);
    _cachedSecret = secret;
    _cachedAt     = Date.now();
    console.log(`✓ JWT secret rotated (was ${daysOld} days old). All users must re-login.`);
    return secret;
  }

  // Case 3: Secret still valid
  const daysLeft = 7 - daysOld;
  _cachedSecret  = stored.secret;
  _cachedAt      = Date.now();
  console.log(`✓ JWT secret loaded from DB (rotates in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}).`);
  return stored.secret;
};

const daysUntilRotation = async () => {
  if (process.env.JWT_SECRET) return Infinity;
  const stored = await readSecretFromDB();
  if (!stored) return 0;
  const ageMs = Date.now() - stored.generatedAt.getTime();
  return Math.max(0, 7 - Math.floor(ageMs / (24 * 60 * 60 * 1000)));
};

const forceRotate = async () => {
  const secret = generateSecret();
  await writeSecretToDB(secret);
  _cachedSecret = secret;
  _cachedAt     = Date.now();
  if (process.env.JWT_SECRET) {
    console.warn("⚠  JWT_SECRET env var is set — DB updated but env var still takes priority.");
    console.warn("   Update JWT_SECRET in Render environment to complete the rotation.");
  } else {
    console.log("⚠  JWT secret force-rotated in DB. All active sessions invalidated.");
  }
  return secret;
};

module.exports = { initJwtSecret, getJwtSecret, daysUntilRotation, forceRotate };
