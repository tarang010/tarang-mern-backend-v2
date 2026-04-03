// Tarang 1.0.0.1 — routes/sharingRoutes.js

const express = require("express");
const router  = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const {
  shareDocument, getSharePreview, acceptShare,
  getShareStatus, getReceivedShares, getMyShares, cleanupExpiredAudio,
} = require("../controllers/sharingController");

router.post("/share",            protect,            shareDocument);
router.get( "/received",         protect,            getReceivedShares);
router.get( "/my-shares",        protect,            getMyShares);
router.get( "/preview/:token",   protect,            getSharePreview);
router.post("/accept",           protect,            acceptShare);
router.get( "/status/:token",    protect,            getShareStatus);
router.post("/cleanup",          protect, adminOnly, cleanupExpiredAudio);

module.exports = router;
