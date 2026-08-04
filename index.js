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
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

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
  golfGames: { label: "Golf", page: "/golf.html" },
  fgGames: { label: "Frisbee Golf", page: "/fg.html" },
  warGames: { label: "War", page: "/war.html" },
  heartsGames: { label: "Hearts", page: "/hearts.html" },
  blackjackGames: { label: "Blackjack", page: "/blackjack.html" },
  airHockeyGames: { label: "Air Hockey", page: "/airhockey.html" },
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
exports.onGolfInvite = makeGameInviteTrigger("golfGames");
exports.onFrisbeeGolfInvite = makeGameInviteTrigger("fgGames");
exports.onWarInvite = makeGameInviteTrigger("warGames");
exports.onHeartsInvite = makeGameInviteTrigger("heartsGames");
exports.onBlackjackInvite = makeGameInviteTrigger("blackjackGames");
exports.onAirHockeyInvite = makeGameInviteTrigger("airHockeyGames");

// -----------------------------------------------------------------------
// 2. New signup notification — fires once per new user doc and pushes
// every admin, so approvals don't sit unnoticed in the queue. Admins are
// just whoever has a doc in the admins/{uid} collection (same source of
// truth as isAdmin()/requireAdmin() everywhere else); sendPushToUser
// already respects each admin's own notificationsEnabled toggle, so an
// admin who doesn't want pushes simply won't get one.
// -----------------------------------------------------------------------
exports.onNewSignup = onDocumentCreated("users/{uid}", async (event) => {
  const newUser = event.data?.data();
  if (!newUser) return;
  const { uid } = event.params;

  const adminsSnap = await db.collection("admins").get();
  if (adminsSnap.empty) return;

  const name = newUser.profile?.name || "A new user";
  await Promise.all(
    adminsSnap.docs
      .filter((doc) => doc.id !== uid) // don't notify an admin about their own signup
      .map((doc) =>
        sendPushToUser(doc.id, {
          type: "signup",
          title: "Town Fuss — New Sign-Up",
          body: `${name} just signed up and is waiting on approval.`,
          clickAction: "/index.html?admin=pending",
        })
      )
  );
});

// -----------------------------------------------------------------------
// 3. First-time message notification.
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
// 4. Like/dislike notification on chat messages.
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
      clickAction: `/index.html?chatroom=${event.params.roomId}&msg=${event.params.messageId}`,
    });
  }
);

// -----------------------------------------------------------------------
// 5. Scheduled leaderboard cache — the cost fix.
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
// 6. Neighbor of the Week — most friends gained, and most-liked chat poster.
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
// 7. Business listing expiration.
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

// -----------------------------------------------------------------------
// 8. Stripe payments: Gold membership, Diamond membership, and business
// listings all go through the same webhook, distinguished by a prefix on
// client_reference_id ("gold_<uid>", "diamond_<uid>", "business_<uid>") —
// set client-side when building each Stripe Payment Link URL.
//
// Gold and business are simple one-time annual payments (grant one year
// from the moment of payment, same as the pre-webhook "mark paid by hand"
// flow this replaces for business). Diamond is a real Stripe subscription
// ($2.99/month): checkout.session.completed grants the first month and
// records the Stripe customer ID; invoice.payment_succeeded (fired on
// each monthly renewal charge) extends it another month by looking the
// user up via that stored customer ID, since renewal invoice events don't
// carry client_reference_id; customer.subscription.deleted revokes it
// immediately on cancellation, same lookup.
// -----------------------------------------------------------------------
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
// 3 separate secrets, not 1 — Stripe assigns a distinct signing secret per
// webhook *destination*, and this project has 3 separate destinations
// (rather than one destination subscribed to all 3 events) all posting to
// this same function, so an incoming request could legitimately be signed
// with any one of them.
const stripeWebhookSecret1 = defineSecret("STRIPE_WEBHOOK_SECRET_1");
const stripeWebhookSecret2 = defineSecret("STRIPE_WEBHOOK_SECRET_2");
const stripeWebhookSecret3 = defineSecret("STRIPE_WEBHOOK_SECRET_3");

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 31 * 24 * 60 * 60 * 1000;

async function grantFromCheckout(session) {
  const ref = session.client_reference_id || "";
  if (ref.startsWith("business_")) {
    const uid = ref.slice("business_".length);
    await db
      .collection("businesses")
      .doc(uid)
      .update({ businessPaidUntil: Timestamp.fromDate(new Date(Date.now() + ONE_YEAR_MS)) })
      .catch((err) => console.error(`Stripe webhook: couldn't mark business ${uid} paid:`, err));
  } else if (ref.startsWith("gold_")) {
    const uid = ref.slice("gold_".length);
    await db
      .collection("users")
      .doc(uid)
      .update({
        isGoldMember: true,
        goldExpiresAt: Timestamp.fromDate(new Date(Date.now() + ONE_YEAR_MS)),
      })
      .catch((err) => console.error(`Stripe webhook: couldn't grant gold to ${uid}:`, err));
  } else if (ref.startsWith("diamond_")) {
    const uid = ref.slice("diamond_".length);
    await db
      .collection("users")
      .doc(uid)
      .update({
        isDiamondMember: true,
        diamondExpiresAt: Timestamp.fromDate(new Date(Date.now() + ONE_MONTH_MS)),
        stripeCustomerId: session.customer || null,
      })
      .catch((err) => console.error(`Stripe webhook: couldn't grant diamond to ${uid}:`, err));
  } else {
    console.error("Stripe webhook: checkout.session.completed with unrecognized client_reference_id:", ref);
  }
}

async function extendDiamondFromInvoice(invoice) {
  if (!invoice.customer || !invoice.subscription) return;
  const snap = await db.collection("users").where("stripeCustomerId", "==", invoice.customer).limit(1).get();
  if (snap.empty) return; // likely the subscription's first invoice, already covered by checkout.session.completed
  await snap.docs[0].ref
    .update({
      isDiamondMember: true,
      diamondExpiresAt: Timestamp.fromDate(new Date(Date.now() + ONE_MONTH_MS)),
    })
    .catch((err) => console.error(`Stripe webhook: couldn't extend diamond for customer ${invoice.customer}:`, err));
}

async function revokeDiamondFromSubscription(subscription) {
  if (!subscription.customer) return;
  const snap = await db.collection("users").where("stripeCustomerId", "==", subscription.customer).limit(1).get();
  if (snap.empty) return;
  await snap.docs[0].ref
    .update({ isDiamondMember: false })
    .catch((err) => console.error(`Stripe webhook: couldn't revoke diamond for customer ${subscription.customer}:`, err));
}

// Tries each configured secret in turn against the incoming signature;
// the first one that verifies wins. Blank/unset secrets (defineSecret
// still resolves to an empty string if never given a value) are skipped.
function verifyStripeSignature(stripe, rawBody, signatureHeader, candidateSecrets) {
  let lastError = new Error("No Stripe webhook secrets configured");
  for (const secret of candidateSecrets) {
    if (!secret) continue;
    try {
      return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

exports.stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret1, stripeWebhookSecret2, stripeWebhookSecret3] },
  async (req, res) => {
    const stripe = new Stripe(stripeSecretKey.value());
    let event;
    try {
      event = verifyStripeSignature(stripe, req.rawBody, req.headers["stripe-signature"], [
        stripeWebhookSecret1.value(),
        stripeWebhookSecret2.value(),
        stripeWebhookSecret3.value(),
      ]);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type === "checkout.session.completed") {
        await grantFromCheckout(event.data.object);
      } else if (event.type === "invoice.payment_succeeded") {
        await extendDiamondFromInvoice(event.data.object);
      } else if (event.type === "customer.subscription.deleted") {
        await revokeDiamondFromSubscription(event.data.object);
      }
      res.status(200).send("ok");
    } catch (err) {
      // Still 200 so Stripe doesn't retry forever on a bug on our end for an
      // event that's already been logged loudly here.
      console.error("Stripe webhook: error handling event", event.type, err);
      res.status(200).send("logged error");
    }
  }
);

// Safety net alongside the webhook's own subscription.deleted handling —
// clears expired membership flags even if a cancellation event is ever
// missed (delivery failure, etc.), same defensive pattern as
// expireBusinessListings above.
exports.expireMemberships = onSchedule(
  { schedule: "0 4 * * *", timeZone: "America/Chicago" },
  async () => {
    const now = Timestamp.now();
    const batch = db.batch();
    let any = false;

    const goldSnap = await db.collection("users").where("isGoldMember", "==", true).where("goldExpiresAt", "<", now).get();
    goldSnap.forEach((docSnap) => { batch.update(docSnap.ref, { isGoldMember: false }); any = true; });

    const diamondSnap = await db.collection("users").where("isDiamondMember", "==", true).where("diamondExpiresAt", "<", now).get();
    diamondSnap.forEach((docSnap) => { batch.update(docSnap.ref, { isDiamondMember: false }); any = true; });

    if (any) await batch.commit();
  }
);

// -----------------------------------------------------------------------
// 9. Firebase Auth account backup (backupAuthAccounts):
//      Firestore's own scheduled backups (set up separately via
//      `firebase firestore:backups:schedules:create`) do NOT cover Auth —
//      accounts/emails/password hashes live in a completely separate
//      system. Runs daily at 2am America/Chicago, exports every user
//      record via listUsers() (paginated, since a single call caps at
//      1000), and writes the result as a dated JSON file to this
//      project's default Storage bucket at admin-backups/auth-exports/ —
//      a path with NO matching rule in storage.rules, so it's completely
//      unreachable from any client SDK (default-deny for anything not
//      explicitly matched) and only readable via the Admin SDK or the
//      Cloud Console. Also deletes any export older than 30 days, to
//      match the Firestore backup retention window instead of keeping
//      every daily file forever.
// -----------------------------------------------------------------------
exports.backupAuthAccounts = onSchedule(
  { schedule: "0 2 * * *", timeZone: "America/Chicago" },
  async () => {
    const users = [];
    let pageToken;
    do {
      const result = await admin.auth().listUsers(1000, pageToken);
      result.users.forEach((u) => users.push(u.toJSON()));
      pageToken = result.pageToken;
    } while (pageToken);

    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const bucket = getStorage().bucket();
    const filePath = `admin-backups/auth-exports/auth-export-${dateStr}.json`;
    await bucket.file(filePath).save(
      JSON.stringify({ exportedAt: new Date().toISOString(), userCount: users.length, users }, null, 2),
      { contentType: "application/json" }
    );

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const [files] = await bucket.getFiles({ prefix: "admin-backups/auth-exports/" });
    await Promise.all(
      files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        const ageMs = Date.now() - new Date(metadata.timeCreated).getTime();
        if (ageMs > THIRTY_DAYS_MS) await file.delete();
      })
    );
  }
);

// -----------------------------------------------------------------------
// 10. Admin profile deletion, with a 10-day restore window.
//
// This needs the Admin SDK (not just a Firestore rule) for two reasons:
// deleting someone ELSE's Auth account/disabling their login is something
// only Admin SDK can do, and the rate limit has to be enforced server-side
// (authoritative) rather than trusted to the client.
//
// The delete/restore PIN prompt on the client is the same "are you sure
// it's really you" speed bump as the admin PIN gate elsewhere on the
// site — not a real security boundary. The real boundary is the
// isAdmin() check below (via the admins/{uid} doc, same as every other
// admin-only action).
//
// Why disable the Auth account instead of just deleting the Firestore
// doc: index.html's watchUserDoc() auto-recreates a blank users/{uid} doc
// the instant it notices one is missing for a signed-in user (a
// convenience for legitimate cases, e.g. testing) — so deleting the doc
// alone while leaving the person able to log in would just have them
// immediately get a fresh blank profile, undoing the deletion. Disabling
// the Auth account (and revoking its refresh tokens, so an already-open
// tab can't keep coasting on a still-valid ID token) prevents that.
// Restoring re-enables the account and restores the exact archived doc.
// -----------------------------------------------------------------------
const DELETE_RATE_LIMIT_WINDOW_MS = 3 * 60 * 1000;
const DELETE_RATE_LIMIT_MAX = 3;
const DELETE_COOLDOWN_MS = 30 * 60 * 1000;
const DELETED_PROFILE_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

async function requireAdmin(request) {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Sign in required.");
  const adminSnap = await db.collection("admins").doc(callerUid).get();
  if (!adminSnap.exists) throw new HttpsError("permission-denied", "Admins only.");
  return callerUid;
}

exports.adminDeleteProfile = onCall(async (request) => {
  const callerUid = await requireAdmin(request);

  const targetUid = request.data?.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (targetUid === callerUid) {
    throw new HttpsError("failed-precondition", "You can't delete your own profile this way.");
  }

  const userRef = db.collection("users").doc(targetUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError("not-found", "That profile doesn't exist (already deleted?).");
  }

  // Rate limit — checked and recorded atomically so two rapid deletes
  // can't both read "2 so far" and both slip through as the 3rd.
  const limitRef = db.collection("adminDeleteLimits").doc(callerUid);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const limitSnap = await tx.get(limitRef);
    const limitData = limitSnap.exists ? limitSnap.data() : {};
    const cooldownUntil = limitData.cooldownUntil || 0;
    if (now < cooldownUntil) {
      const minsLeft = Math.ceil((cooldownUntil - now) / 60000);
      throw new HttpsError(
        "resource-exhausted",
        `Delete cooldown active — try again in about ${minsLeft} minute(s).`
      );
    }
    const recent = (limitData.recentDeletes || []).filter((ts) => now - ts < DELETE_RATE_LIMIT_WINDOW_MS);
    if (recent.length >= DELETE_RATE_LIMIT_MAX) {
      tx.set(limitRef, { recentDeletes: [], cooldownUntil: now + DELETE_COOLDOWN_MS }, { merge: true });
      throw new HttpsError(
        "resource-exhausted",
        `You've deleted ${DELETE_RATE_LIMIT_MAX} profiles in the last 3 minutes — a 30 minute cooldown has started.`
      );
    }
    recent.push(now);
    tx.set(limitRef, { recentDeletes: recent, cooldownUntil: 0 }, { merge: true });
  });

  await db.collection("deletedUsers").doc(targetUid).set({
    profileData: userSnap.data(),
    deletedAt: Timestamp.now(),
    deletedBy: callerUid,
    purgeAt: Timestamp.fromMillis(now + DELETED_PROFILE_RETENTION_MS),
  });
  await userRef.delete();

  try {
    await admin.auth().updateUser(targetUid, { disabled: true });
    await admin.auth().revokeRefreshTokens(targetUid);
  } catch (err) {
    // The profile is already archived and removed either way — losing the
    // Auth-disable step isn't fatal, just log it for follow-up.
    console.error(`Couldn't disable Auth account for ${targetUid}:`, err);
  }

  return { ok: true };
});

exports.adminRestoreProfile = onCall(async (request) => {
  await requireAdmin(request);

  const targetUid = request.data?.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }

  const archivedRef = db.collection("deletedUsers").doc(targetUid);
  const archivedSnap = await archivedRef.get();
  if (!archivedSnap.exists) {
    throw new HttpsError("not-found", "That deleted profile is no longer available (already purged or restored).");
  }

  await db.collection("users").doc(targetUid).set(archivedSnap.data().profileData);
  await archivedRef.delete();

  try {
    await admin.auth().updateUser(targetUid, { disabled: false });
  } catch (err) {
    console.error(`Couldn't re-enable Auth account for ${targetUid}:`, err);
  }

  return { ok: true };
});

// Sweeps the 10-day-old archive daily — after this, a deleted profile is
// gone for good (Auth account included), same as the self-service "Delete
// my account" flow's end state.
exports.purgeExpiredDeletedProfiles = onSchedule(
  { schedule: "30 3 * * *", timeZone: "America/Chicago" },
  async () => {
    const now = Timestamp.now();
    const snap = await db.collection("deletedUsers").where("purgeAt", "<=", now).get();
    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      await docSnap.ref.delete();
      await admin.auth().deleteUser(docSnap.id).catch((err) => {
        console.error(`Couldn't delete Auth account ${docSnap.id} during purge:`, err);
      });
    }
  }
);
