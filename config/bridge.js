// Tarang 1.0.0.1 — config/bridge.js
// Axios instance pre-configured for the Python FastAPI bridge

const axios = require("axios");

const BRIDGE_BASE_URL =
  process.env.PYTHON_BRIDGE_URL || "http://localhost:5001";

const bridge = axios.create({
  baseURL: BRIDGE_BASE_URL,
  timeout: 600000, // 10 min — covers even large doc TTS + modulation
  headers: { "Content-Type": "application/json" },
});

// Log all bridge requests in development
bridge.interceptors.request.use((config) => {
  if (process.env.NODE_ENV === "development") {
    console.log(`→ Bridge: ${config.method?.toUpperCase()} ${config.url}`);
  }
  return config;
});

// Normalize bridge errors into a consistent format
bridge.interceptors.response.use(
  (response) => response,
  (error) => {
    const msg =
      error.response?.data?.error ||
      error.message ||
      "Python bridge request failed";
    const err = new Error(msg);
    err.bridgeStatus = error.response?.status || 500;
    err.bridgeData   = error.response?.data || null;
    throw err;
  }
);

// ── Helper: ping bridge health ────────────────────────────────────────────────
const pingBridge = async () => {
  try {
    const { data } = await bridge.get("/health");
    return data.status === "ok";
  } catch {
    return false;
  }
};

// ── Helper: wake bridge if sleeping (Render free tier cold start) ─────────────
//
// Render free tier spins down after 15 min of inactivity.
// The bridge has a self-ping loop to prevent this, but on a fresh deploy
// or after a forced restart the pod may still be cold.
// Call this before any pipeline request to absorb the 30-60s cold start.
//
// Usage: await wakeBridge();  // before calling bridge.post("/pipeline/audio", ...)
//
const wakeBridge = async () => {
  const WAKE_TIMEOUT_MS = 90_000;   // 90s — enough for cold start
  const POLL_INTERVAL_MS = 5_000;   // check every 5s
  const MAX_ATTEMPTS = Math.ceil(WAKE_TIMEOUT_MS / POLL_INTERVAL_MS);

  const wakeClient = axios.create({
    baseURL: BRIDGE_BASE_URL,
    timeout: WAKE_TIMEOUT_MS,
  });

  console.log(`→ [bridge] Waking Python bridge at ${BRIDGE_BASE_URL}/health ...`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { data } = await wakeClient.get("/health");
      if (data.status === "ok") {
        console.log(`✓ [bridge] Bridge is awake (attempt ${attempt})`);
        return true;
      }
    } catch {
      // Not awake yet — keep polling
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  console.warn(`⚠ [bridge] Bridge did not respond after ${WAKE_TIMEOUT_MS / 1000}s — proceeding anyway`);
  return false;
};

module.exports = { bridge, pingBridge, wakeBridge };
