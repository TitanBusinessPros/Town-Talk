/**
 * Town Fuss — push notification Cloud Functions.
 *
 * Two triggers, matching exactly what was asked for:
 *   1. A friend invites you to a game (chess, checkers, or WynneWars)
 *   2. Someone messages you for the FIRST time (not every message —
 *      just the first one in a given conversation)
 *
 * Both are "free" pushes — Firebase Cloud Messaging (FCM), not SMS.
 * There is no per-message cost here at all; Cloud Functions billing is
 * per invocation/compute time, and at the volume a single-town app will
 * see, this comfortably sits inside the free tier.
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
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

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
async function sendPushToUser(uid, { title, body, clickAction }) {
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
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...deadTokens),
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
      title: "Town Fuss — Game Invite",
      body: `${game.player1Name || "A neighbor"} invited you to play ${label}!`,
      clickAction: page,
    });
  });
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

    const messagesRef = db.collection("conversations").doc(conversationId).collection("messages");
    const countSnap = await messagesRef.count().get();
    if (countSnap.data().count !== 1) return; // not the first message — skip

    const convoSnap = await db.collection("conversations").doc(conversationId).get();
    if (!convoSnap.exists) return;
    const convo = convoSnap.data();

    const recipientUid = (convo.participants || []).find((uid) => uid !== message.senderId);
    if (!recipientUid) return;

    const senderName = (convo.participantNames && convo.participantNames[message.senderId]) || "A neighbor";

    await sendPushToUser(recipientUid, {
      title: "Town Fuss — New Message",
      body: `${senderName} sent you a message for the first time.`,
      clickAction: "/index.html",
    });
  }
);
