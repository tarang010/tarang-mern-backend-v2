// Tarang 1.0.0.1 — utils/jwtSecret.js
// Auto-generates and rotates JWT secret every 7 days
// Secret is stored in .jwt_secret file (never committed to git)
// On every server start, checks if secret is older than 7 days
// If expired — generates a new one and logs a rotation notice

const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");

const SECRET_FILE     = path.join(__dirname, "../.jwt_secret");
const ROTATION_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const SECRET_BYTES    = 64; // 512-bit secret — extremely strong

/**
 * Reads the stored secret file.
 * Returns { secret, generatedAt } or null if not found / corrupt.
 */
const readSecretFile = () => {
  try {
    if (!fs.existsSync(SECRET_FILE)) return null;
    const raw  = fs.readFileSync(SECRET_FILE, "utf-8").trim();
    const data = JSON.parse(raw);
    if (!data.secret || !data.generatedAt) return null;
    return data;
  } catch {
    return null;
  }
};

/**
 * Writes a new secret to the secret file with current timestamp.
 */
const writeSecretFile = (secret) => {
  const data = {
    secret,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SECRET_FILE, JSON.stringify(data, null, 2), "utf-8");
};

/**
 * Generates a cryptographically secure random secret string.
 */
const generateSecret = () =>
  crypto.randomBytes(SECRET_BYTES).toString("hex");

/**
 * Main function — call this once on server startup.
 *
 * Logic:
 *   1. If .jwt_secret does not exist → generate and save
 *   2. If .jwt_secret exists but is older than 7 days → rotate
 *   3. If .jwt_secret is fresh → use as-is
 *
 * Sets process.env.JWT_SECRET so all jwt.sign / jwt.verify calls
 * automatically pick up the correct secret without any changes.
 *
 * IMPORTANT: Rotation invalidates all existing tokens.
 * Users will need to log in again after a rotation.
 * This is intentional — it limits the blast radius of a leaked token.
 */
const initJwtSecret = () => {
  const stored = readSecretFile();

  // Case 1: No secret file — generate fresh
  if (!stored) {
    const secret = generateSecret();
    writeSecretFile(secret);
    process.env.JWT_SECRET = secret;
    console.log("✓ JWT secret generated (new installation).");
    return secret;
  }

  // Case 2: Secret exists — check age
  const generatedAt = new Date(stored.generatedAt);
  const ageMs       = Date.now() - generatedAt.getTime();
  const daysOld     = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  if (ageMs >= ROTATION_MS) {
    // Rotate
    const secret = generateSecret();
    writeSecretFile(secret);
    process.env.JWT_SECRET = secret;
    console.log(`✓ JWT secret rotated (was ${daysOld} days old). All users re-login required.`);
    return secret;
  }

  // Case 3: Secret is still valid — use it
  const daysLeft = 7 - daysOld;
  process.env.JWT_SECRET = stored.secret;
  console.log(`✓ JWT secret loaded (rotates in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}).`);
  return stored.secret;
};

/**
 * Returns how many days until next rotation.
 * Useful for admin dashboard display.
 */
const daysUntilRotation = () => {
  const stored = readSecretFile();
  if (!stored) return 0;
  const ageMs  = Date.now() - new Date(stored.generatedAt).getTime();
  return Math.max(0, 7 - Math.floor(ageMs / (24 * 60 * 60 * 1000)));
};

/**
 * Force-rotate the secret immediately.
 * Useful for emergency rotation if a breach is suspected.
 * Call via: node -e "require('./utils/jwtSecret').forceRotate()"
 */
const forceRotate = () => {
  const secret = generateSecret();
  writeSecretFile(secret);
  process.env.JWT_SECRET = secret;
  console.log("⚠  JWT secret force-rotated. All active sessions invalidated.");
  return secret;
};

module.exports = { initJwtSecret, daysUntilRotation, forceRotate };
