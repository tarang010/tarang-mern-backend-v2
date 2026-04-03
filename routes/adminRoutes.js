// Tarang 1.0.0.1 — routes/adminRoutes.js

const express = require("express");
const router  = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const {
  getAllUsers, getUserDetail, updateUserRole,
  deactivateUser, getStats, getAllDocuments,
} = require("../controllers/adminController");

// All admin routes require JWT + admin role
router.use(protect, adminOnly);

router.get(  "/stats",               getStats);
router.get(  "/documents",           getAllDocuments);
router.get(  "/users",               getAllUsers);
router.get(  "/users/:id",           getUserDetail);
router.patch("/users/:id/role",      updateUserRole);
router.patch("/users/:id/deactivate",deactivateUser);

module.exports = router;
