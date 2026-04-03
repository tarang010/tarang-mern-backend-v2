// Tarang 1.0.0.1 — server.js
// Main Express entry point

require("dotenv").config();
require("express-async-errors");

// ── JWT secret — auto-generated and rotated every 7 days ─────────────────────
// Must run BEFORE any route or middleware that uses JWT
const { initJwtSecret } = require("./utils/jwtSecret");
initJwtSecret();

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

const authRoutes      = require("./routes/authRoutes");
const documentRoutes  = require("./routes/documentRoutes");
const sessionRoutes   = require("./routes/sessionRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const adminRoutes     = require("./routes/adminRoutes");
const friendsRoutes        = require("./routes/friendsRoutes");
const sharingRoutes        = require("./routes/sharingRoutes");
const notificationsRoutes  = require("./routes/notificationsRoutes");
const chatRoutes           = require("./routes/chatRoutes");

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Ensure storage directories exist (development only) ──────────────────────
// In production (Render), all storage goes to Cloudinary + MongoDB Atlas
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

// ── Trust proxy (required on Render/Heroku — sits behind a load balancer) ─────
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set("trust proxy", 1);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
// Allow multiple origins — Firebase has two domains (.web.app and .firebaseapp.com)
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

// Also allow any subdomain of firebaseapp.com and web.app
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
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
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Rate limits — relaxed in development, strict in production
const isDev = process.env.NODE_ENV !== "production";
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      isDev ? 20000000 : 100000, // 200000 in dev, 10000 in prod
  message:  { status: "error", error: "Too many requests. Please try again later." },
  skip:     () => isDev,        // completely skip in development
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      isDev ? 5000 : 1000,   // 50 in dev, 10 in prod
  message:  { status: "error", error: "Upload limit reached. Try again in an hour." },
});

app.use("/api/",                  apiLimiter);
app.use("/api/documents/upload",  uploadLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ── Static file serving ───────────────────────────────────────────────────────
// Serve generated audio, reports, analytics directly to frontend
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
app.use("/api/auth",       authRoutes);
app.use("/api/documents",  documentRoutes);
app.use("/api/sessions",   sessionRoutes);
app.use("/api/analytics",  analyticsRoutes);
app.use("/api/admin",      adminRoutes);
app.use("/api/friends",        friendsRoutes);
app.use("/api/sharing",        sharingRoutes);
app.use("/api/notifications",  notificationsRoutes);
app.use("/api/chat",           chatRoutes);

// ── Voices proxy — forwards to Python bridge ─────────────────────────────────
app.get("/api/voices", async (req, res) => {
  try {
    const { bridge } = require("./config/bridge");
    const { data } = await bridge.get("/voices");
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
    version: "1.0.0.1",
    bridge:  bridgeAlive ? "connected" : "unreachable",
    mongo:   "connected",
    time:    new Date().toISOString(),
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

  // Warn if Python bridge is not reachable on startup
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
    console.log(`  Environment : ${process.env.NODE_ENV || "development"}`);
    console.log(`  Health check: http://localhost:${PORT}/api/health`);
  });

};

start();
