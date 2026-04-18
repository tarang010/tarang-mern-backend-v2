// Tarang 2.2.1 — server.js
//
// v2.2.1 changes:
//   recoverStuckDocuments() called on startup (after connectDB + initJwtSecret).
//   This marks any docs that were stuck in "processing" from a previous
//   crash or Render redeploy as "error" immediately, so the frontend SSE
//   stream resolves instead of hanging for 30 minutes.
//
// v2.2.0 changes (retained):
//   CORS: maxAge: 86400 — browser caches OPTIONS preflight for 24h.
//   auth: protect middleware accepts ?token= query param for SSE endpoints.

require("dotenv").config();
require("express-async-errors");

const { initJwtSecret } = require("./utils/jwtSecret");

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const rateLimit   = require("express-rate-limit");
const path        = require("path");
const fs          = require("fs");

const connectDB      = require("./config/db");
const { pingBridge } = require("./config/bridge");
const errorHandler   = require("./middleware/errorHandler");

const authRoutes          = require("./routes/authRoutes");
const documentRoutes      = require("./routes/documentRoutes");
const sessionRoutes       = require("./routes/sessionRoutes");
const analyticsRoutes     = require("./routes/analyticsRoutes");
const adminRoutes         = require("./routes/adminRoutes");
const friendsRoutes       = require("./routes/friendsRoutes");
const sharingRoutes       = require("./routes/sharingRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const chatRoutes          = require("./routes/chatRoutes");

// Import recoverStuckDocuments — called after DB is ready
const { recoverStuckDocuments } = require("./controllers/documentController");

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Ensure storage directories exist (development only) ──────────────────────
if (process.env.NODE_ENV !== "production") {
  const storageDirs = [
    "../../storage/uploads",
    "../../storage/extracted",
    "../../storage/audio_cache",
    "../../storage/reports",
    "../../storage/mcq",
    "../../storage/analytics",
  ].map((d) => path.join(__dirname, d));

  storageDirs.forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

// ── Trust proxy ───────────────────────────────────────────────────────────────
app.set("trust proxy", 1);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".web.app") ||
      origin.endsWith(".firebaseapp.com")
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials:    true,
  maxAge:         86400,
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== "production";
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      isDev ? 20000000 : 100000,
  message:  { status: "error", error: "Too many requests. Please try again later." },
  skip:     () => isDev,
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      isDev ? 5000 : 1000,
  message:  { status: "error", error: "Upload limit reached. Try again in an hour." },
});

app.use("/api/",                 apiLimiter);
app.use("/api/documents/upload", uploadLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ── Static file serving ───────────────────────────────────────────────────────
app.use(
  "/storage",
  express.static(path.join(__dirname, "../../storage"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".wav")) {
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Accept-Ranges", "bytes");
      }
      if (filePath.endsWith(".mp3")) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Accept-Ranges", "bytes");
      }
      if (filePath.endsWith(".html")) {
        res.setHeader("Content-Type", "text/html");
      }
    },
  })
);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use("/api/auth",          authRoutes);
app.use("/api/documents",     documentRoutes);
app.use("/api/sessions",      sessionRoutes);
app.use("/api/analytics",     analyticsRoutes);
app.use("/api/admin",         adminRoutes);
app.use("/api/friends",       friendsRoutes);
app.use("/api/sharing",       sharingRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/chat",          chatRoutes);

// ── Voices proxy ──────────────────────────────────────────────────────────────
app.get("/api/voices", async (req, res) => {
  try {
    const { bridge } = require("./config/bridge");
    const { data }   = await bridge.get("/voices");
    res.json(data);
  } catch (e) {
    res.status(503).json({ status: "error", error: "Bridge unavailable." });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  const bridgeAlive = await pingBridge();
  res.json({
    status:  "ok",
    service: "Tarang Express Backend",
    version: "2.2.1",
    bridge:  bridgeAlive ? "connected" : "unreachable",
    mongo:   "connected",
    time:    new Date().toISOString(),
    config: {
      extract_timeout_ms:  process.env.EXTRACT_TIMEOUT_MS  || "900000 (default)",
      pipeline_timeout_ms: process.env.PIPELINE_TIMEOUT_MS || "1200000 (default)",
      sse_timeout_ms:      process.env.SSE_TIMEOUT_MS      || "1800000 (default)",
      stuck_threshold_ms:  process.env.STUCK_THRESHOLD_MS  || "2100000 (default)",
    },
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    error:  `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const start = async () => {
  await connectDB();

  // initJwtSecret MUST run after connectDB
  await initJwtSecret();

  // v2.2.1: Recover any docs stuck in "processing" from a previous crash/redeploy.
  // Must run after connectDB so MongoDB is available.
  await recoverStuckDocuments();

  const bridgeAlive = await pingBridge();
  if (!bridgeAlive) {
    console.warn(
      "⚠  Python bridge unreachable at",
      process.env.PYTHON_BRIDGE_URL || "http://localhost:5001",
      "\n   Start bridge.py before uploading documents."
    );
  } else {
    console.log("✓ Python bridge connected at", process.env.PYTHON_BRIDGE_URL || "http://localhost:5001");
  }

  app.listen(PORT, () => {
    console.log(`✓ Tarang backend running on http://localhost:${PORT}`);
    console.log(`  Environment      : ${process.env.NODE_ENV || "development"}`);
    console.log(`  Health check     : http://localhost:${PORT}/api/health`);
    console.log(`  Extract timeout  : ${process.env.EXTRACT_TIMEOUT_MS  || "900000ms (15 min, default)"}`);
    console.log(`  Pipeline timeout : ${process.env.PIPELINE_TIMEOUT_MS || "1200000ms (20 min, default)"}`);
    console.log(`  SSE timeout      : ${process.env.SSE_TIMEOUT_MS      || "1800000ms (30 min, default)"}`);
  });
};

start();