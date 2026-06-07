// Tarang 2.2.1 — config/bridge.js
//
// v2.2.1 fix:
//   bridgePost() delay comment corrected: cap is 8s (Math.min(..., 8000)),
//   so the backoff sequence is 1s → 2s → 4s (→ 8s for attempt 4+, if
//   maxAttempts is ever raised). Previous comment said "1s, 2s, 4s" which
//   implied a hard cap at 4s, misleading anyone raising maxAttempts.
//
// v2.2.0 (retained):
//   - bridgePost(): auto-retries on 502/503/504/ECONNREFUSED/timeout
//   - wakeBridge(): max wait 120s, ping every 4s
//   - Axios instance: explicit timeout at instance level

require("dotenv").config();
const axios = require("axios");

const BRIDGE_URL       = process.env.PYTHON_BRIDGE_URL || "http://localhost:9801";
const BRIDGE_TIMEOUT   = parseInt(process.env.BRIDGE_TIMEOUT_MS || String(20 * 60 * 1000), 10);
const WAKE_MAX_WAIT_MS = 120_000;  // 2 min max to wait for cold start
const WAKE_PING_MS     = 4_000;   // ping every 4s while waking

// ── Axios instance ────────────────────────────────────────────────────────────
const bridge = axios.create({
  baseURL: BRIDGE_URL,
  timeout: BRIDGE_TIMEOUT,
  headers: { "Content-Type": "application/json" },
});


// ── Retry helper ──────────────────────────────────────────────────────────────
// Wraps any bridge call with exponential backoff retry on transient errors.
// Retryable: 502, 503, 504, ECONNREFUSED, ECONNRESET, ETIMEDOUT, ECONNABORTED
//
// Backoff sequence (exponential, capped at 8s):
//   attempt 1 fails → wait 1s   (2^0 * 1000)
//   attempt 2 fails → wait 2s   (2^1 * 1000)
//   attempt 3 fails → wait 4s   (2^2 * 1000)
//   attempt 4 fails → wait 8s   (2^3 * 1000, capped at 8000)
//   (default maxAttempts = 3, so only attempts 1 and 2 produce a retry)
//
// For multipart FormData (file uploads) use bridge.post() directly —
// FormData streams cannot be replayed on retry.
const RETRYABLE_CODES    = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED"]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const bridgePost = async (path, body, config = {}, maxAttempts = 3) => {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await bridge.post(path, body, config);
    } catch (err) {
      const status  = err.response?.status;
      const isRetry = RETRYABLE_STATUSES.has(status) || RETRYABLE_CODES.has(err.code);

      if (!isRetry || attempt === maxAttempts) throw err;

      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `⚠  Bridge ${path} failed (attempt ${attempt}/${maxAttempts}) | ` +
        `status=${status || err.code} | retrying in ${delay}ms`
      );
      await new Promise(r => setTimeout(r, delay));
      lastErr = err;
    }
  }
  throw lastErr;
};


// ── Wake bridge ───────────────────────────────────────────────────────────────
// Polls /health until the Python pod responds or WAKE_MAX_WAIT_MS elapses.
// Returns true if bridge is alive, false if timeout exceeded.
// CALLERS MUST CHECK the return value — a false return means the bridge
// never woke up and processing should be aborted.
const wakeBridge = async () => {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < WAKE_MAX_WAIT_MS) {
    attempt++;
    try {
      await bridge.get("/health", { timeout: 8_000 });
      if (attempt > 1) {
        console.log(`✓ Bridge warm after ${Math.round((Date.now() - start) / 1000)}s (${attempt} pings)`);
      }
      return true;
    } catch {
      if (attempt === 1) {
        console.log(`⏳ Waiting for Python bridge to wake (cold start)...`);
      }
      await new Promise(r => setTimeout(r, WAKE_PING_MS));
    }
  }
  console.error(`✗ Bridge did not wake within ${WAKE_MAX_WAIT_MS / 1000}s`);
  return false;
};


// ── Ping bridge (health check only) ──────────────────────────────────────────
const pingBridge = async () => {
  try {
    await bridge.get("/health", { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};


module.exports = { bridge, bridgePost, wakeBridge, pingBridge };