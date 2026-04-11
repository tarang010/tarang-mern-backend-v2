// Tarang 2.2.0 — middleware/auth.js
//
// v2.2.0 change:
//   Added ?token= query param fallback for GET requests only.
//   Required because the browser's EventSource API (used for SSE) cannot
//   send custom headers — the JWT must travel as ?token=xxx on the URL.
//   Restricted to GET to prevent abuse on mutation endpoints.

const jwt  = require("jsonwebtoken");
const User = require("../models/User");
const { getJwtSecret } = require("../utils/jwtSecret");

const protect = async (req, res, next) => {
  let token;

  // Standard: Bearer token from Authorization header
  if (req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  // v2.2.0: fallback to ?token= query param — for SSE / EventSource only.
  // Only accepted on GET requests to prevent it being used on mutations.
  if (!token && req.method === "GET" && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ status: "error", error: "Not authorised — no token." });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) {
      return res.status(401).json({ status: "error", error: "User not found." });
    }
    next();
  } catch (err) {
    return res.status(401).json({ status: "error", error: "Token invalid or expired." });
  }
};

const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ status: "error", error: "Admin access required." });
  }
  next();
};

module.exports = { protect, adminOnly };
