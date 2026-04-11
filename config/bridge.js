// Tarang 2.2.0 — config/bridge.js
//
// v2.2.0 changes:
//   - bridgePost() helper: auto-retries on 502/503/ECONNREFUSED/timeout
//     with exponential backoff (1s → 2s → 4s, max 3 attempts)
//   - wakeBridge(): increased max wait from 90s to 120s, pings every 4s
//     instead of every 3s (reduces log spam on slow cold starts)
//   - Axios instance: added explicit timeout on the instance level as well
//     as per-call (belt-and-suspenders for Render)

require("dotenv").config();
const axios = require("axios");

const BRIDGE_URL       = process.env.PYTHON_BRIDGE_URL || "http://localhost:5010";
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
// Usage — replace:
//   await bridge.post("/mcq/status", body)
// With:
//   await bridgePost("/mcq/status", body)
//
// For multipart FormData (file upload) use bridge.post() directly with its
// own PIPELINE_TIMEOUT_MS — FormData streams can't be retried safely.
const RETRYABLE_CODES   = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED"]);
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

      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s, 2s, 4s
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
// Called before Phase 1 pipeline to absorb Render cold-start latency.
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
