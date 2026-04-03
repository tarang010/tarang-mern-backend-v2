// Tarang 1.0.0.1 — middleware/errorHandler.js

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || err.bridgeStatus || 500;
  let message    = err.message    || "Internal server error";

  // Mongoose bad ObjectId
  if (err.name === "CastError") {
    statusCode = 400;
    message    = `Invalid ID format: ${err.value}`;
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    statusCode  = 409;
    message     = `Duplicate value for ${field}. Please use a different value.`;
  }

  // Mongoose validation error
  if (err.name === "ValidationError") {
    statusCode = 400;
    message    = Object.values(err.errors).map((e) => e.message).join(". ");
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message    = "Invalid token.";
  }
  if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message    = "Token expired. Please log in again.";
  }

  if (process.env.NODE_ENV === "development") {
    console.error(`[ERROR] ${statusCode} — ${message}`);
    if (err.stack) console.error(err.stack);
  }

  res.status(statusCode).json({
    status: "error",
    error:  message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;
