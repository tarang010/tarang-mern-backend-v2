// Tarang 2.2.0 — utils/jwt.js
//
// Uses getJwtSecret() from jwtSecret.js which reads from MongoDB-persisted
// secret (or JWT_SECRET env var if set). This ensures generateToken always
// uses the same secret as token verification in auth middleware.

const jwt            = require("jsonwebtoken");
const { getJwtSecret } = require("./jwtSecret");

const generateToken = (userId) =>
  jwt.sign({ id: userId }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

module.exports = { generateToken };
