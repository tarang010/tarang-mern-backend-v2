// Tarang 1.0.0.1 — middleware/auth.js
// JWT verification middleware

const jwt  = require("jsonwebtoken");
const User = require("../models/User");

// ── Protect route — requires valid JWT ───────────────────────────────────────
const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({
      status: "error",
      error:  "Not authorised. No token provided.",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");

    if (!req.user) {
      return res.status(401).json({
        status: "error",
        error:  "User no longer exists.",
      });
    }

    if (!req.user.isActive) {
      return res.status(401).json({
        status: "error",
        error:  "Account is deactivated.",
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({
      status: "error",
      error:  "Invalid or expired token.",
    });
  }
};

// ── Admin only route ──────────────────────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      status: "error",
      error:  "Access denied. Admin role required.",
    });
  }
  next();
};

// ── Attach role to request (no block — just enriches req.user.role) ───────────
const attachRole = async (req, res, next) => {
  // Reads role from req.user if already authenticated, else defaults to "user"
  req.role = req.user?.role || "user";
  next();
};

module.exports = { protect, adminOnly, attachRole };
