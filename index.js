/**
 * Town Fuss — Cloud Functions.
 *
 * 1. Push notifications (Firebase Cloud Messaging, free — no SMS):
 *      - A friend invites you to a game (chess, checkers, or WynneWars)
 *      - Someone messages you for the FIRST time (not every message —
 *        just the first one in a given conversation)
 *      - Someone likes or dislikes your chat message (onChatReaction)
 *
 * 2. Scheduled leaderboard cache (refreshLeaderboardCache):
 *      Twice a day (7am and 7pm America/Chicago), scans the "users"
 *      collection ONCE and writes the top-10 rankings per game into
 *      leaderboardCache/gameRanks. The website reads that one small
 *      cached document instead of scanning every approved profile on
 *      every single Feed/Profiles page visit — the fix for a cost that
 *      would otherwise scale with (users) × (visits) × (database size).
 *
 * 3. Neighbor of the Week (computeNeighborOfTheWeek):
 *      Every Monday at 12:10am America/Chicago, looks at the PAST week
 *      and crowns two winners:
 *        - Most friends GAINED that week (based on accepted friend
 *          requests, not total friend count — keeps the badge rotating
 *          instead of always going to whoever's been here longest)
 *        - Most likes received on chat-room messages posted that week
 *      Clears the badge from last week's winners and stamps it onto this
 *      week's winners directly on their users/{uid} doc, so the website
 *      can show the badge with zero extra reads.
 *
 * 4. Business listing expiration (expireBusinessListings):
 *      Runs daily at 3am America/Chicago. Any business account whose
 *      paid year has passed gets taken off the public feed automatically
 *      (approved: false) — their profile data is untouched, so paying
 *      again brings them straight back with nothing to re-enter.
 *
 * DEPLOYING THIS (one-time setup, run from a terminal — not pasted into
 * the Firebase Console browser UI like your rules/html files):
 *
 *   1. Install the Firebase CLI if you don't have it yet:
 *        npm install -g firebase-tools
 *   2. Log in:
 *        firebase login
 *   3. From the folder that CONTAINS this "functions" folder, run:
 *        firebase init functions
 *      - Choose "Use an existing project" → town-talk-87ff7
 *      - Language: JavaScript
 *      - When it asks to overwrite functions/index.js, package.json —
 *        say NO (you already have these files; don't let it wipe them)
 *   4. Install dependencies:
 *        cd functions
 *        npm install
 *   5. Deploy:
 *        firebase deploy --only functions
 *
 * You're already on the Blaze (pay-as-you-go) plan, so no billing change
 * is needed to deploy Cloud Functions.
 *
 * NOTE 1: scheduled functions (refreshLeaderboardCache, computeNeighborOfTheWeek,
 * expireBusinessListings) sometimes require an App Engine app to exist for
 * Cloud Scheduler's default region, the FIRST time you ever deploy any
 * scheduled function to a project. If deploy fails with a message about
 * "App Engine" or a location constraint, run:
 *     gcloud app create --region=us-central
 * (pick any us-central-adjacent region if prompted) and re-run the deploy.
 * This is a one-time thing.
 *
 * NOTE 2: expireBusinessListings queries on both "approved" and
 * "businessPaidUntil" at once. The very first time it actually runs,
 * Firestore may reject it with an error containing a link that says
 * "create it here" — that's normal for a brand-new query shape, not a
 * bug. Click that link once (it pre-fills everything), wait a minute or
 * two for the index to build, and it'll work from then on.
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Keep every function in one region close to your users; also keeps
// cold-start/cost behavior consistent across all of them.
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// -----------------------------------------------------------------------
// Shared helper: given a recipient uid + a notification payload, look up
// whether they've opted in and have any device tokens saved, send to all
// of them, and prune any tokens that have gone stale (uninstalled app,
// revoked permission, etc.) so the array doesn't grow forever.
// -----------------------------------------------------------------------
// Always logs an in-app notification for the bell icon in the nav bar —
// this happens regardless of whether the person has push notifications
// turned on, so the bell works for everyone. The actual OS-level push
// (sendPushToUser below) stays gated behind their notificationsEnabled
// toggle, same as before.
async function logInAppNotification(uid, { type, title, body, clickAction }) {
  try {
    await db.collection("users").doc(uid).collection("notifications").add({
      type,
      title,
      body,
      clickAction: clickAction || "/",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`Couldn't log in-app notification for ${uid}:`, err);
  }
}

async function sendPushToUser(uid, { type, title, body, clickAction }) {
  await logInAppNotification(uid, { type, title, body, clickAction });

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return;
  const userData = userSnap.data();

  if (!userData.notificationsEnabled) return; // respects the toggle
  const tokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  if (tokens.length === 0) return;

  const message = {
    notification: { title, body },
    data: { click_action: clickAction || "/" },
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);

  // Remove any token FCM says is no longer valid, so future sends don't
  // keep wasting a call on a dead device.
  const deadTokens = [];
  response.responses.forEach((resp, i) => {
    if (!resp.success) {
      const code = resp.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        deadTokens.push(tokens[i]);
      }
    }
  });
  if (deadTokens.length > 0) {
    await userSnap.ref.update({
      fcmTokens: FieldValue.arrayRemove(...deadTokens),
    });
  }
}

// -----------------------------------------------------------------------
// 1. Game invite notifications — chess, checkers, WynneWars.
// Each game document is created with inviteTo == null (open table) or
// inviteTo == <uid> (a direct invite, which is how the "invite a friend"
// flow on each game page works). We only notify on the direct-invite case.
// -----------------------------------------------------------------------
const GAME_LABELS = {
  chessGames: { label: "Chess", page: "/chess.html" },
  checkersGames: { label: "Checkers", page: "/checkers.html" },
  wynneGames: { label: "WynneWars", page: "/ww.html" },
};

function makeGameInviteTrigger(collectionName) {
  const { label, page } = GAME_LABELS[collectionName];
  return onDocumentCreated(`${collectionName}/{gameId}`, async (event) => {
    const game = event.data?.data();
    if (!game || !game.inviteTo) return; // open table, not a direct invite — nothing to notify

    await sendPushToUser(game.inviteTo, {
      type: "invite",
      title: "Town Fuss — Game Invite",
      body: `${game.player1Name || "A neighbor"} invited you to play ${label}!`,
      clickAction: page,
    });

    // Also drop it into their Messages inbox — the in-game invite list
    // (and the notification bell) are easy to miss since they only show up
    // if the person happens to open that specific game page. A message
    // shows up wherever they already look for messages.
    await postGameInviteMessage({
      fromUid: game.player1Uid,
      fromName: game.player1Name || "A neighbor",
      toUid: game.inviteTo,
      toName: game.inviteToName || "Neighbor",
      label,
      page,
    });
  });
}

async function postGameInviteMessage({ fromUid, fromName, toUid, toName, label, page }) {
  const conversationId = [fromUid, toUid].sort().join("_");
  const convoRef = db.collection("conversations").doc(conversationId);
  const msgRef = convoRef.collection("messages").doc();
  const text = `${fromName} invited you to play ${label}!`;

  try {
    const convoSnap = await convoRef.get();
    const existingReadBy = convoSnap.exists ? convoSnap.data().readBy || {} : {};

    await db.runTransaction(async (tx) => {
      tx.set(
        convoRef,
        {
          participants: [fromUid, toUid].sort(),
          participantNames: { [fromUid]: fromName, [toUid]: toName },
          lastMessageAt: FieldValue.serverTimestamp(),
          lastMessageText: `🎮 ${text}`,
          lastMessageSenderId: fromUid,
          readBy: existingReadBy,
        },
        { merge: true }
      );
      tx.set(msgRef, {
        senderId: fromUid,
        text,
        type: "game_invite",
        game: page,
        sentAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    console.error(`Couldn't post game invite message from ${fromUid} to ${toUid}:`, err);
  }
}

exports.onChessInvite = makeGameInviteTrigger("chessGames");
exports.onCheckersInvite = makeGameInviteTrigger("checkersGames");
exports.onWynneWarsInvite = makeGameInviteTrigger("wynneGames");

// -----------------------------------------------------------------------
// 2. First-time message notification.
// Fires on every new message, but only actually sends a push if this is
// the FIRST message ever created in that conversation — using a Firestore
// aggregate count query, which is a single cheap read regardless of how
// many messages the conversation eventually accumulates.
// -----------------------------------------------------------------------
exports.onFirstMessageNotify = onDocumentCreated(
  "conversations/{conversationId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;
    const { conversationId } = event.params;

    // Was THIS message the first one in the conversation? A live count()
    // at execution time is racy — if a second and third message land
    // before this trigger actually runs (easily happens with rapid
    // successive sends), the count is already >1 and a genuinely-first
    // message gets wrongly skipped. Checking whether this message is the
    // chronologically-oldest one is race-proof regardless of how many
    // later messages already exist by the time this runs.
    const messagesRef = db.collection("conversations").doc(conversationId).collection("messages");
    const oldestSnap = await messagesRef.orderBy("sentAt", "asc").limit(1).get();
    if (oldestSnap.empty || oldestSnap.docs[0].id !== event.params.messageId) return; // not the first message — skip

    const convoSnap = await db.collection("conversations").doc(conversationId).get();
    if (!convoSnap.exists) return;
    const convo = convoSnap.data();

    const recipientUid = (convo.participants || []).find((uid) => uid !== message.senderId);
    if (!recipientUid) return;

    const senderName = (convo.participantNames && convo.participantNames[message.senderId]) || "A neighbor";

    await sendPushToUser(recipientUid, {
      type: "message",
      title: "Town Fuss — New Message",
      body: `${senderName} sent you a message for the first time.`,
      clickAction: "/index.html",
    });
  }
);

// -----------------------------------------------------------------------
// 3. Like/dislike notification on chat messages.
//
// Fires on every update to a chat message, but only actually sends a
// push when the likes or dislikes array just grew by one NEW uid — so
// removing a like, or someone else's earlier like, doesn't re-notify.
// Skips notifying yourself if you react to your own message.
// -----------------------------------------------------------------------
exports.onChatReaction = onDocumentUpdated(
  "chatRooms/{roomId}/messages/{messageId}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after || !after.senderId) return;

    const beforeLikes = Array.isArray(before.likes) ? before.likes : [];
    const afterLikes = Array.isArray(after.likes) ? after.likes : [];
    const beforeDislikes = Array.isArray(before.dislikes) ? before.dislikes : [];
    const afterDislikes = Array.isArray(after.dislikes) ? after.dislikes : [];

    let reactorUid = null;
    let verb = null;
    if (afterLikes.length > beforeLikes.length) {
      reactorUid = afterLikes.find((uid) => !beforeLikes.includes(uid));
      verb = "liked";
    } else if (afterDislikes.length > beforeDislikes.length) {
      reactorUid = afterDislikes.find((uid) => !beforeDislikes.includes(uid));
      verb = "reacted to";
    }
    if (!reactorUid || reactorUid === after.senderId) return; // no new reactor, or reacting to your own message

    let reactorName = "A neighbor";
    try {
      const reactorSnap = await db.collection("users").doc(reactorUid).get();
      if (reactorSnap.exists) reactorName = reactorSnap.data().profile?.name || reactorName;
    } catch {
      // Fall back to the generic name rather than failing the notification.
    }

    await sendPushToUser(after.senderId, {
      type: "reaction",
      title: "Town Fuss — Chat Reaction",
      body: `${reactorName} ${verb} your message in chat.`,
      clickAction: "/index.html",
    });
  }
);

// -----------------------------------------------------------------------
// 4. Scheduled leaderboard cache — the cost fix.
//
// Runs twice a day, period — completely decoupled from how many users
// you have or how often they check the app. Reads the "users" collection
// ONCE per run, computes the top 10 for each game, and writes the result
// into a single small cached document. The website reads that document
// (one cheap read) instead of scanning the whole collection on every
// single Feed/Profiles page visit.
//
// Cost math: this is (2 runs/day) × (size of your database) — flat,
// regardless of growth in users or visits. That's the fix for a cost
// that otherwise scales with (users) × (visits) × (database size).
// -----------------------------------------------------------------------
const GAME_POINT_FIELDS = ["chessPoints", "checkersPoints", "wynneWarsPoints"];

exports.refreshLeaderboardCache = onSchedule(
  { schedule: "0 7,19 * * *", timeZone: "America/Chicago" },
  async () => {
    const snap = await db.collection("users").where("approved", "==", true).get();

    const cache = {};
    for (const field of GAME_POINT_FIELDS) {
      const players = [];
      snap.forEach((docSnap) => {
        const points = docSnap.data()[field] || 0;
        if (points > 0) players.push({ uid: docSnap.id, points });
      });
      players.sort((a, b) => b.points - a.points);
      cache[field] = players.slice(0, 10).map((p) => p.uid);
    }

    await db.collection("leaderboardCache").doc("gameRanks").set({
      ...cache,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
);

// -----------------------------------------------------------------------
// 5. Neighbor of the Week — most friends gained, and most-liked chat poster.
//
// Runs once a week, not per-visit — same cost philosophy as the
// leaderboard cache above. Two winners are picked for the PAST week and
// stamped directly onto their users/{uid} doc as booleans, so the
// website can render the badge with a plain field read, no extra query.
// -----------------------------------------------------------------------
const CHAT_ROOM_IDS = [
  "wynnewood-chat", "elmore-city-chat", "pauls-valley-chat",
  "davis-chat", "paoli-chat", "sulphur-chat", "singles-chat",
  "music-chat", "events-chat", "rants-raves-chat",
  "local-jobs-chat", "helping-hands-chat",
];

function isoDate(d) {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function mostFriendsGained(weekStart, weekEnd) {
  const snap = await db
    .collection("friendRequests")
    .where("respondedAt", ">=", weekStart)
    .where("respondedAt", "<", weekEnd)
    .get();

  const tally = new Map(); // uid -> count
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.status !== "accepted") return;
    (data.participants || []).forEach((uid) => {
      tally.set(uid, (tally.get(uid) || 0) + 1);
    });
  });

  let winnerUid = null;
  let winnerCount = 0;
  for (const [uid, count] of tally.entries()) {
    if (count > winnerCount) {
      winnerUid = uid;
      winnerCount = count;
    }
  }
  return winnerUid ? { uid: winnerUid, count: winnerCount } : null;
}

async function mostLikedChatPoster(weekStart, weekEnd) {
  const tally = new Map(); // senderId -> total likes

  for (const roomId of CHAT_ROOM_IDS) {
    const snap = await db
      .collection("chatRooms")
      .doc(roomId)
      .collection("messages")
      .where("sentAt", ">=", weekStart)
      .where("sentAt", "<", weekEnd)
      .get();

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const likeCount = Array.isArray(data.likes) ? data.likes.length : 0;
      if (likeCount === 0 || !data.senderId) return;
      tally.set(data.senderId, (tally.get(data.senderId) || 0) + likeCount);
    });
  }

  let winnerUid = null;
  let winnerCount = 0;
  for (const [uid, count] of tally.entries()) {
    if (count > winnerCount) {
      winnerUid = uid;
      winnerCount = count;
    }
  }
  return winnerUid ? { uid: winnerUid, count: winnerCount } : null;
}

exports.computeNeighborOfTheWeek = onSchedule(
  { schedule: "10 0 * * 1", timeZone: "America/Chicago" },
  async () => {
    const now = new Date();
    // "now" is just after midnight Monday when this runs — the week being
    // scored is the 7 days ending at this Monday's midnight.
    const weekEnd = new Date(now);
    weekEnd.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(weekEnd);
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);

    const weekStartTs = Timestamp.fromDate(weekStart);
    const weekEndTs = Timestamp.fromDate(weekEnd);

    const [friendsWinner, likesWinner] = await Promise.all([
      mostFriendsGained(weekStartTs, weekEndTs),
      mostLikedChatPoster(weekStartTs, weekEndTs),
    ]);

    // Clear the badge from whoever held it last week before assigning it
    // to this week's winner — otherwise old winners keep the badge forever.
    const [prevFriendsHolders, prevLikesHolders] = await Promise.all([
      db.collection("users").where("isNeighborOfWeekFriends", "==", true).get(),
      db.collection("users").where("isNeighborOfWeekLikes", "==", true).get(),
    ]);

    const batch = db.batch();
    prevFriendsHolders.forEach((docSnap) => batch.update(docSnap.ref, { isNeighborOfWeekFriends: false }));
    prevLikesHolders.forEach((docSnap) => batch.update(docSnap.ref, { isNeighborOfWeekLikes: false }));
    if (friendsWinner) {
      batch.update(db.collection("users").doc(friendsWinner.uid), { isNeighborOfWeekFriends: true });
    }
    if (likesWinner) {
      batch.update(db.collection("users").doc(likesWinner.uid), { isNeighborOfWeekLikes: true });
    }
    await batch.commit();

    await db.collection("spotlights").doc(isoDate(weekStart)).set({
      weekStart: weekStartTs,
      weekEnd: weekEndTs,
      mostFriends: friendsWinner || null,
      mostLikes: likesWinner || null,
      computedAt: FieldValue.serverTimestamp(),
    });
  }
);

// -----------------------------------------------------------------------
// 6. Business listing expiration.
//
// Runs once a day. Any business account whose paid year (businessPaidUntil)
// has passed gets taken off the public feed (approved: false) — their
// data isn't deleted, so paying again and getting re-approved brings them
// straight back with nothing to re-enter. Doesn't touch non-business
// accounts at all.
// -----------------------------------------------------------------------
exports.expireBusinessListings = onSchedule(
  { schedule: "0 3 * * *", timeZone: "America/Chicago" },
  async () => {
    const now = Timestamp.now();
    const snap = await db
      .collection("businesses")
      .where("approved", "==", true)
      .where("businessPaidUntil", "<", now)
      .get();

    if (snap.empty) return;
    const batch = db.batch();
    snap.forEach((docSnap) => batch.update(docSnap.ref, { approved: false }));
    await batch.commit();
  }
);
