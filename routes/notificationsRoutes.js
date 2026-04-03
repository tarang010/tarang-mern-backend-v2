// Tarang 1.0.0.1 — routes/notificationsRoutes.js

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const { getNotifications, markAllRead, markRead } = require("../controllers/notificationsController");

router.get(  "/",              protect, getNotifications);
router.patch("/read-all",      protect, markAllRead);
router.patch("/:id/read",      protect, markRead);

module.exports = router;
