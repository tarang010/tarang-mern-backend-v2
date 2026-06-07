// Tarang 1.1.0 - controllers/friendsController.js
// Leaderboard now uses completed Session data as the primary source so users
// appear as soon as they have real completed scores, even before a full
// 3-session analytics summary exists.

const User = require("../models/User");
const Friendship = require("../models/Friendship");
const Analytics = require("../models/Analytics");
const Session = require("../models/Session");
const Document = require("../models/Document");

const normalizePct = (value) => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

// Search users by name or email to add as friend
const searchUsers = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ status: "error", error: "Search query must be at least 2 characters." });
  }

  const regex = new RegExp(q.trim(), "i");
  const users = await User.find({
    _id: { $ne: req.user._id },
    isActive: true,
    $or: [{ name: regex }, { email: regex }],
  })
    .select("name email createdAt")
    .limit(10);

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
        _id: u._id,
        name: u.name,
        email: u.email,
        friendshipStatus: friendship?.status || null,
        friendshipId: friendship?._id || null,
        isRequester: friendship?.requester?.toString() === myId.toString(),
      };
    })
  );

  res.json({ status: "success", data: { users: results } });
};

const sendRequest = async (req, res) => {
  const { recipientId } = req.body;

  if (recipientId === req.user._id.toString()) {
    return res.status(400).json({ status: "error", error: "You cannot add yourself." });
  }

  const recipient = await User.findById(recipientId);
  if (!recipient) {
    return res.status(404).json({ status: "error", error: "User not found." });
  }

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

const respondToRequest = async (req, res) => {
  const { friendshipId, action } = req.body;

  if (!["accept", "reject"].includes(action)) {
    return res.status(400).json({ status: "error", error: "Action must be 'accept' or 'reject'." });
  }

  const friendship = await Friendship.findOne({
    _id: friendshipId,
    recipient: req.user._id,
    status: "pending",
  });

  if (!friendship) {
    return res.status(404).json({ status: "error", error: "Pending request not found." });
  }

  friendship.status = action === "accept" ? "accepted" : "rejected";
  await friendship.save();

  res.json({ status: "success", data: { friendship } });
};

const getFriends = async (req, res) => {
  const myId = req.user._id;

  const friendships = await Friendship.find({
    $or: [{ requester: myId }, { recipient: myId }],
    status: { $in: ["accepted", "pending"] },
  })
    .populate("requester", "name email")
    .populate("recipient", "name email")
    .sort({ updatedAt: -1 });

  const friends = [];
  const requests = [];

  for (const f of friendships) {
    if (f.status === "accepted") {
      const other = f.requester._id.toString() === myId.toString()
        ? f.recipient
        : f.requester;
      friends.push({ friendshipId: f._id, user: other, since: f.updatedAt });
    } else if (f.status === "pending" && f.recipient._id.toString() === myId.toString()) {
      requests.push({ friendshipId: f._id, from: f.requester, sentAt: f.createdAt });
    }
  }

  res.json({ status: "success", data: { friends, requests } });
};

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

const getLeaderboard = async (req, res) => {
  const myId = req.user._id;

  const friendships = await Friendship.find({
    $or: [{ requester: myId }, { recipient: myId }],
    status: "accepted",
  });

  const friendIds = friendships.map((f) => (
    f.requester.toString() === myId.toString() ? f.recipient : f.requester
  ));
  const allIds = [myId, ...friendIds];

  const users = await User.find({ _id: { $in: allIds }, isActive: true })
    .select("name email");
  const userMap = new Map(users.map((user) => [user._id.toString(), user]));

  const sessions = await Session.find({
    userId: { $in: allIds },
    status: "completed",
    scorePct: { $ne: null },
  }).select("userId docId sessionNumber scorePct submittedAt");

  const analyticsData = await Analytics.find({
    userId: { $in: allIds },
  }).select("userId docId scoreProgression")
    .populate("userId", "name email");

  const avgScoreMap = {};
  const perDocMap = {};
  const progressMap = {};

  for (const session of sessions) {
    const uid = session.userId.toString();
    const user = userMap.get(uid);
    const scorePct = normalizePct(session.scorePct);
    if (!user || scorePct == null) continue;

    if (!avgScoreMap[uid]) {
      avgScoreMap[uid] = {
        user,
        scores: [],
        docIds: new Set(),
        sessionsCompleted: 0,
      };
    }

    avgScoreMap[uid].scores.push(scorePct);
    avgScoreMap[uid].docIds.add(session.docId);
    avgScoreMap[uid].sessionsCompleted += 1;

    if (!perDocMap[session.docId]) perDocMap[session.docId] = [];
    perDocMap[session.docId].push({
      user,
      scorePct,
      isMe: uid === myId.toString(),
    });

    const progressKey = `${uid}:${session.docId}`;
    if (!progressMap[progressKey]) {
      progressMap[progressKey] = {
        user,
        points: [],
      };
    }
    progressMap[progressKey].points.push({
      sessionNumber: session.sessionNumber,
      scorePct,
    });
  }

  const avgScoreRanking = Object.values(avgScoreMap)
    .filter((entry) => entry.scores.length > 0)
    .map((entry) => ({
      user: entry.user,
      avgScore: parseFloat((
        entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length * 100
      ).toFixed(1)),
      totalDocs: entry.docIds.size,
      sessionsCompleted: entry.sessionsCompleted,
      isMe: entry.user._id.toString() === myId.toString(),
    }))
    .sort((a, b) => b.avgScore - a.avgScore)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  const improvedMap = {};
  for (const entry of Object.values(progressMap)) {
    const ordered = entry.points
      .slice()
      .sort((a, b) => a.sessionNumber - b.sessionNumber);
    if (ordered.length < 2) continue;

    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const improvement = (last.scorePct - first.scorePct) * 100;
    const uid = entry.user._id.toString();

    if (!improvedMap[uid] || improvement > improvedMap[uid].improvement) {
      improvedMap[uid] = {
        user: entry.user,
        improvement: parseFloat(improvement.toFixed(1)),
        s1Score: parseFloat((first.scorePct * 100).toFixed(1)),
        s3Score: parseFloat((last.scorePct * 100).toFixed(1)),
        isMe: uid === myId.toString(),
      };
    }
  }

  if (!Object.keys(improvedMap).length) {
    for (const analytics of analyticsData) {
      const uid = analytics.userId?._id?.toString?.();
      const progression = analytics.scoreProgression || [];
      if (!uid || progression.length < 2 || improvedMap[uid]) continue;

      const ordered = progression
        .map((point) => ({
          sessionNumber: point.session,
          scorePct: (point.score || 0) / 100,
        }))
        .sort((a, b) => a.sessionNumber - b.sessionNumber);

      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      improvedMap[uid] = {
        user: analytics.userId,
        improvement: parseFloat(((last.scorePct - first.scorePct) * 100).toFixed(1)),
        s1Score: parseFloat((first.scorePct * 100).toFixed(1)),
        s3Score: parseFloat((last.scorePct * 100).toFixed(1)),
        isMe: uid === myId.toString(),
      };
    }
  }

  const docIds = Object.keys(perDocMap);
  const documents = await Document.find({ docId: { $in: docIds } }).select("docId title");
  const docTitleMap = new Map(documents.map((doc) => [doc.docId, doc.title]));

  const perDocRanking = Object.entries(perDocMap)
    .map(([docId, entries]) => {
      const byUser = new Map();
      for (const entry of entries) {
        const uid = entry.user._id.toString();
        if (!byUser.has(uid)) {
          byUser.set(uid, {
            user: entry.user,
            scores: [],
            isMe: entry.isMe,
          });
        }
        byUser.get(uid).scores.push(entry.scorePct);
      }

      const rankedEntries = Array.from(byUser.values())
        .map((entry) => ({
          user: entry.user,
          score: parseFloat((
            entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length * 100
          ).toFixed(1)),
          isMe: entry.isMe,
        }))
        .sort((a, b) => b.score - a.score)
        .map((entry, index) => ({ ...entry, rank: index + 1 }));

      return {
        docId,
        title: docTitleMap.get(docId) || docId,
        entries: rankedEntries,
      };
    })
    .filter((doc) => doc.entries.length >= 2);

  const friendSummaries = friendIds
    .map((friendId) => {
      const uid = friendId.toString();
      const user = userMap.get(uid);
      if (!user) return null;

      const stats = avgScoreMap[uid];
      return {
        friendshipUserId: uid,
        user,
        avgScore: stats?.scores?.length
          ? parseFloat((
              stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length * 100
            ).toFixed(1))
          : null,
        sessionsCompleted: stats?.sessionsCompleted || 0,
        documentsStudied: stats?.docIds?.size || 0,
      };
    })
    .filter(Boolean);

  const myStats = avgScoreMap[myId.toString()];

  res.json({
    status: "success",
    data: {
      avgScoreRanking,
      mostImproved: Object.values(improvedMap)
        .sort((a, b) => b.improvement - a.improvement)
        .map((entry, index) => ({ ...entry, rank: index + 1 })),
      perDocRanking,
      totalFriends: friendIds.length,
      meSummary: {
        avgScore: myStats?.scores?.length
          ? parseFloat((
              myStats.scores.reduce((a, b) => a + b, 0) / myStats.scores.length * 100
            ).toFixed(1))
          : null,
        sessionsCompleted: myStats?.sessionsCompleted || 0,
        documentsStudied: myStats?.docIds?.size || 0,
      },
      friendSummaries,
    },
  });
};

module.exports = {
  searchUsers,
  sendRequest,
  respondToRequest,
  getFriends,
  removeFriend,
  getLeaderboard,
};
