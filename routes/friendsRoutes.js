// Tarang 1.0.0.1 — routes/friendsRoutes.js

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const {
  searchUsers, sendRequest, respondToRequest,
  getFriends, removeFriend, getLeaderboard,
} = require("../controllers/friendsController");

router.get(   "/search",      protect, searchUsers);
router.get(   "/leaderboard", protect, getLeaderboard);
router.get(   "/",            protect, getFriends);
router.post(  "/request",     protect, sendRequest);
router.post(  "/respond",     protect, respondToRequest);
router.delete("/:friendshipId", protect, removeFriend);

module.exports = router;
