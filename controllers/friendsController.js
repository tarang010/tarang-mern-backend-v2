// Tarang 1.0.0.1 — controllers/friendsController.js

const mongoose  = require("mongoose");
const User       = require("../models/User");
const Friendship = require("../models/Friendship");
const Analytics  = require("../models/Analytics");
const Session    = require("../models/Session");

// ── GET /api/friends/search?q=... ─────────────────────────────────────────────
// Search users by name or email to add as friend
const searchUsers = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ status: "error", error: "Search query must be at least 2 characters." });
  }

  const regex = new RegExp(q.trim(), "i");
  const users = await User.find({
    _id:      { $ne: req.user._id },
    isActive: true,
    $or: [{ name: regex }, { email: regex }],
  })
    .select("name email createdAt")
    .limit(10);

  // Attach friendship status for each result
  const myId = req.user._id;
  const results = await Promise.all(
    users.map(async (u) => {
      const friendship = await Friendship.findOne({
        $or: [
          { requester: myId, recipient: u._id },
          { requester: u._id, recipient: myId },
        ],
      });
      return {
        _id:              u._id,
        name:             u.name,
        email:            u.email,
        friendshipStatus: friendship?.status || null,
        friendshipId:     friendship?._id    || null,
        isRequester:      friendship?.requester.toString() === myId.toString(),
      };
    })
  );

  res.json({ status: "success", data: { users: results } });
};

// ── POST /api/friends/request ─────────────────────────────────────────────────
const sendRequest = async (req, res) => {
  const { recipientId } = req.body;

  if (recipientId === req.user._id.toString()) {
    return res.status(400).json({ status: "error", error: "You cannot add yourself." });
  }

  const recipient = await User.findById(recipientId);
  if (!recipient) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

  // Check if friendship already exists
  const existing = await Friendship.findOne({
    $or: [
      { requester: req.user._id, recipient: recipientId },
      { requester: recipientId, recipient: req.user._id },
    ],
  });

  if (existing) {
    const msg = existing.status === "accepted"
      ? "You are already friends."
      : existing.status === "pending"
      ? "Friend request already sent."
      : "Cannot send request.";
    return res.status(409).json({ status: "error", error: msg });
  }

  const friendship = await Friendship.create({
    requester: req.user._id,
    recipient: recipientId,
  });

  res.status(201).json({ status: "success", data: { friendship } });
};

// ── POST /api/friends/respond ─────────────────────────────────────────────────
const respondToRequest = async (req, res) => {
  const { friendshipId, action } = req.body; // action: "accept" | "reject"

  if (!["accept", "reject"].includes(action)) {
    return res.status(400).json({ status: "error", error: "Action must be 'accept' or 'reject'." });
  }

  const friendship = await Friendship.findOne({
    _id:       friendshipId,
    recipient: req.user._id,
    status:    "pending",
  });

  if (!friendship) {
    return res.status(404).json({ status: "error", error: "Pending request not found." });
  }

  friendship.status = action === "accept" ? "accepted" : "rejected";
  await friendship.save();

  res.json({ status: "success", data: { friendship } });
};

// ── GET /api/friends ──────────────────────────────────────────────────────────
// Get all accepted friends + pending requests
const getFriends = async (req, res) => {
  const myId = req.user._id;

  const friendships = await Friendship.find({
    $or: [{ requester: myId }, { recipient: myId }],
    status: { $in: ["accepted", "pending"] },
  })
    .populate("requester", "name email")
    .populate("recipient", "name email")
    .sort({ updatedAt: -1 });

  const friends  = [];
  const requests = []; // incoming pending requests

  for (const f of friendships) {
    if (f.status === "accepted") {
      const other = f.requester._id.toString() === myId.toString()
        ? f.recipient : f.requester;
      friends.push({ friendshipId: f._id, user: other, since: f.updatedAt });
    } else if (f.status === "pending" && f.recipient._id.toString() === myId.toString()) {
      requests.push({ friendshipId: f._id, from: f.requester, sentAt: f.createdAt });
    }
  }

  res.json({ status: "success", data: { friends, requests } });
};

// ── DELETE /api/friends/:friendshipId ─────────────────────────────────────────
const removeFriend = async (req, res) => {
  const { friendshipId } = req.params;
  const myId = req.user._id;

  const friendship = await Friendship.findOne({
    _id: friendshipId,
    $or: [{ requester: myId }, { recipient: myId }],
  });

  if (!friendship) {
    return res.status(404).json({ status: "error", error: "Friendship not found." });
  }

  await friendship.deleteOne();
  res.json({ status: "success", data: { message: "Friend removed." } });
};

// ── GET /api/friends/leaderboard ──────────────────────────────────────────────
// Returns friends-only leaderboard with 3 ranking modes
const getLeaderboard = async (req, res) => {
  const myId = req.user._id;

  // Get all accepted friends
  const friendships = await Friendship.find({
    $or: [{ requester: myId }, { recipient: myId }],
    status: "accepted",
  });

  // Build list of friend IDs + include self
  const friendIds = friendships.map((f) =>
    f.requester.toString() === myId.toString() ? f.recipient : f.requester
  );
  const allIds = [myId, ...friendIds];

  // Fetch analytics for all users in the group
  const analyticsData = await Analytics.find({
    userId: { $in: allIds },
  }).populate("userId", "name email");

  // ── Ranking 1: Overall average score ──────────────────────────────────────
  const avgScoreMap = {};
  for (const a of analyticsData) {
    const uid = a.userId._id.toString();
    if (!avgScoreMap[uid]) {
      avgScoreMap[uid] = {
        user:        a.userId,
        scores:      [],
        totalDocs:   0,
      };
    }
    if (a.averageScorePct != null) {
      avgScoreMap[uid].scores.push(a.averageScorePct);
      avgScoreMap[uid].totalDocs++;
    }
  }

  const avgScoreRanking = Object.values(avgScoreMap)
    .map((entry) => ({
      user:      entry.user,
      avgScore:  entry.scores.length > 0
        ? parseFloat((entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length * 100).toFixed(1))
        : 0,
      totalDocs: entry.totalDocs,
      isMe:      entry.user._id.toString() === myId.toString(),
    }))
    .sort((a, b) => b.avgScore - a.avgScore)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  // ── Ranking 2: Most improved (best S1→S3 jump) ────────────────────────────
  const improvedMap = {};
  for (const a of analyticsData) {
    const uid = a.userId._id.toString();
    const prog = a.scoreProgression || [];
    if (prog.length < 3) continue;
    const s1 = prog.find((p) => p.session === 1)?.score || 0;
    const s3 = prog.find((p) => p.session === 3)?.score || 0;
    const improvement = s3 - s1;
    if (!improvedMap[uid] || improvement > improvedMap[uid].improvement) {
      improvedMap[uid] = {
        user:        a.userId,
        improvement: parseFloat(improvement.toFixed(1)),
        s1Score:     parseFloat(s1.toFixed(1)),
        s3Score:     parseFloat(s3.toFixed(1)),
        isMe:        a.userId._id.toString() === myId.toString(),
      };
    }
  }

  const mostImproved = Object.values(improvedMap)
    .sort((a, b) => b.improvement - a.improvement)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  // ── Ranking 3: Per-document (friends who studied same docs) ───────────────
  const docMap = {}; // docId → [{ user, avgScore }]
  for (const a of analyticsData) {
    if (a.averageScorePct == null) continue;
    if (!docMap[a.docId]) docMap[a.docId] = { title: null, entries: [] };
    docMap[a.docId].entries.push({
      user:     a.userId,
      score:    parseFloat((a.averageScorePct * 100).toFixed(1)),
      isMe:     a.userId._id.toString() === myId.toString(),
    });
  }

  // Only include docs where at least 2 users have data
  const perDocRanking = Object.entries(docMap)
    .filter(([, v]) => v.entries.length >= 2)
    .map(([docId, v]) => ({
      docId,
      entries: v.entries
        .sort((a, b) => b.score - a.score)
        .map((e, i) => ({ ...e, rank: i + 1 })),
    }));

  // Populate document titles
  const Document = require("../models/Document");
  for (const item of perDocRanking) {
    const doc = await Document.findOne({ docId: item.docId }).select("title");
    item.title = doc?.title || item.docId;
  }

  res.json({
    status: "success",
    data: {
      avgScoreRanking,
      mostImproved,
      perDocRanking,
      totalFriends: friendIds.length,
    },
  });
};

module.exports = {
  searchUsers, sendRequest, respondToRequest,
  getFriends, removeFriend, getLeaderboard,
};
