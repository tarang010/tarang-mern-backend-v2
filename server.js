// Tarang 3.0.0 — server.js
// v3.0.0: added startBridgeKeepAlive() call inside app.listen callback.
//         Everything else is identical to v2.2.1.

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

// v3.0.0: also import startBridgeKeepAlive
const {
  recoverStuckDocuments,
  startBridgeKeepAlive,
} = require("./controllers/documentController");

const app  = express();
const PORT = process.env.PORT || 5000;

// const dns = require("dns");
// dns.setServers(["8.8.8.8", "8.8.4.4"]);

// ── Storage dirs (dev only) ───────────────────────────────────────────────────
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

app.set("trust proxy", 1);
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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

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

app.use("/api/auth",          authRoutes);
app.use("/api/documents",     documentRoutes);
app.use("/api/sessions",      sessionRoutes);
app.use("/api/analytics",     analyticsRoutes);
app.use("/api/admin",         adminRoutes);
app.use("/api/friends",       friendsRoutes);
app.use("/api/sharing",       sharingRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/chat",          chatRoutes);

app.get("/api/voices", async (req, res) => {
  try {
    const { bridge } = require("./config/bridge");
    const { data }   = await bridge.get("/voices");
    res.json(data);
  } catch (e) {
    res.status(503).json({ status: "error", error: "Bridge unavailable." });
  }
});

app.get("/api/health", async (req, res) => {
  const bridgeAlive = await pingBridge();
  res.json({
    status:  "ok",
    service: "Tarang Express Backend",
    version: "3.0.0",
    bridge:  bridgeAlive ? "connected" : "unreachable",
    mongo:   "connected",
    time:    new Date().toISOString(),
    config: {
      extract_timeout_ms:  process.env.EXTRACT_TIMEOUT_MS  || "900000 (default)",
      pipeline_timeout_ms: process.env.PIPELINE_TIMEOUT_MS || "1200000 (default)",
      sse_timeout_ms:      process.env.SSE_TIMEOUT_MS      || "1800000 (default)",
      stuck_threshold_ms:  process.env.STUCK_THRESHOLD_MS  || "2100000 (default)",
      bridge_keepalive_ms: process.env.BRIDGE_KEEPALIVE_MS || "45000 (default)",
    },
  });
});

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    error:  `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

app.use(errorHandler);

const start = async () => {
  await connectDB();
  await initJwtSecret();
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
    console.log(`✓ Tarang backend v3.0.0 on http://localhost:${PORT}`);
    console.log(`  Environment      : ${process.env.NODE_ENV || "development"}`);
    console.log(`  Health check     : http://localhost:${PORT}/api/health`);
    console.log(`  Extract timeout  : ${process.env.EXTRACT_TIMEOUT_MS  || "900000ms (15 min, default)"}`);
    console.log(`  Pipeline timeout : ${process.env.PIPELINE_TIMEOUT_MS || "1200000ms (20 min, default)"}`);
    console.log(`  SSE timeout      : ${process.env.SSE_TIMEOUT_MS      || "1800000ms (30 min, default)"}`);
    console.log(`  Bridge keep-alive: every ${process.env.BRIDGE_KEEPALIVE_MS || "45000"}ms`);

    // v3.0.0: keep bridge warm — prevents Render free-tier cold start
    // during long audio generation sessions. Runs entirely server-side
    // so it works even when no browser tab is open.
    startBridgeKeepAlive();
  });
};

start();