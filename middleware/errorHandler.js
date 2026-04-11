// Tarang 2.2.0 — middleware/errorHandler.js
//
// v2.2.0 change:
//   Always attach CORS headers on error responses.
//   Previously, when the bridge threw a 502, Express hit this handler BEFORE
//   the cors() middleware could attach headers — browser saw "CORS error"
//   on top of the real 502, masking the actual problem in the network tab.
//
//   Fix: manually set Access-Control-Allow-Origin on every error response
//   so the browser can read the error body regardless of status code.

const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

const errorHandler = (err, req, res, next) => {
  // ── Always attach CORS headers on errors ──────────────────────────────────
  // cors() middleware only runs on successful route matches. Errors that
  // short-circuit routing (bridge timeouts, unhandled throws) skip it.
  const origin = req.headers.origin;
  if (
    origin && (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".web.app") ||
      origin.endsWith(".firebaseapp.com")
    )
  ) {
    res.setHeader("Access-Control-Allow-Origin",      origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // ── Log the error ─────────────────────────────────────────────────────────
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(`[errorHandler] ${req.method} ${req.originalUrl} → ${status}:`, err.message);
  }

  // ── Bridge / upstream errors — surface the real status ───────────────────
  // When the Python bridge returns 502/503, axios wraps it in an error with
  // err.response.status. Forward that status instead of always sending 500.
  const upstreamStatus = err.response?.status;
  const finalStatus    = upstreamStatus && upstreamStatus >= 400
    ? upstreamStatus
    : status;

  // ── Send JSON error response ──────────────────────────────────────────────
  res.status(finalStatus).json({
    status: "error",
    error:  err.message || "Internal server error.",
    // Only expose stack in development
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;
