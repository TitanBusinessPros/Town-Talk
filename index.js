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

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { beforeUserSignedIn, HttpsError: IdentityHttpsError } = require("firebase-functions/v2/identity");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const Stripe = require("stripe");
const vision = require("@google-cloud/vision");
const admin = require("firebase-admin");
// firebase-admin v13+ dropped the old namespaced admin.firestore()/
// admin.auth()/admin.messaging() API entirely (not just deprecated it) —
// everything here goes through the modular per-service imports instead.
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
const { getStorage } = require("firebase-admin/storage");

admin.initializeApp();
const db = getFirestore();
const messaging = getMessaging();
const visionClient = new vision.ImageAnnotatorClient();

// Keep every function in one region close to your users; also keeps
// cold-start/cost behavior consistent across all of them.
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Resend (resend.com) is no longer used anywhere in this file — the
// account/API key was removed 2026-08-15 (it was only ever wired up for
// a handful of admin-facing emails, all of which now either have no email
// at all or hand a link back to the admin to send themselves — see
// notifyAdminsOfSignup, checkImageSafeSearch, and inviteDailyRewardSponsor).

// Human-readable name per edition, keyed by Firebase project ID
// (process.env.GCLOUD_PROJECT) — this file is shared source deployed
// separately to all 7 editions, so a function needs this to know which
// one it's actually running in for anything edition-labeled.
const EDITION_DISPLAY_NAMES = {
  "town-talk-87ff7": "Pauls Valley",
  "eufaula-lake": "Eufaula Lake",
  "tulsa-townfuss": "Tulsa",
  "edmond-townfuss": "Edmond",
  "okc-townfuss": "Oklahoma City",
  "poteau-townfuss": "Poteau",
  "prague-townfuss": "Prague",
};

// "Today" for Daily Rewards purposes, in America/Chicago — the same
// timezone the 4pm draw and every other scheduled function in this file
// already runs in. en-CA locale is a deliberate trick, not a typo: it's
// the one built-in Intl format that outputs YYYY-MM-DD directly, no manual
// string assembly needed.
function centralDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(date);
}

// sendSignupAlertEmail, sendProfileApprovedEmail, and
// sendSafeSearchFlagAlertEmail (all Resend-based) were removed 2026-08-15
// along with the RESEND_API_KEY secret. The admin push notifications that
// already ran alongside each of them (notifyAdminsOfSignup's admin push,
// checkImageSafeSearch's admin push) cover the same ground with no email
// dependency; the member-facing profile-approved email had the in-app
// status badge (renderDashboard's post-status-badge) doing the same job.

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
  if (!userSnap.exists) {
    console.log(`sendPushToUser(${uid}, ${type}): no users doc — in-app only`);
    return;
  }
  const userData = userSnap.data();

  if (!userData.notificationsEnabled) {
    console.log(`sendPushToUser(${uid}, ${type}): notificationsEnabled is false — in-app only`);
    return;
  }
  const tokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  if (tokens.length === 0) {
    console.log(`sendPushToUser(${uid}, ${type}): notificationsEnabled but 0 fcmTokens — in-app only`);
    return;
  }

  // Real unread count at send time (includes the one logInAppNotification
  // just added above) — carried in the data payload so the service worker
  // can set the home-screen icon's badge number correctly even while the
  // app is fully closed, not just while it's open and the live
  // watchNotificationBell() listener in index.html can compute it itself.
  // FCM data payload values must be strings, not numbers.
  const unreadSnap = await db.collection("users").doc(uid).collection("notifications").where("read", "==", false).count().get();
  const badgeCount = String(unreadSnap.data().count);

  const message = {
    notification: { title, body },
    data: { click_action: clickAction || "/", badgeCount },
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);
  console.log(
    `sendPushToUser(${uid}, ${type}): sent to ${tokens.length} token(s), ` +
    `${response.successCount} succeeded, ${response.failureCount} failed` +
    (response.failureCount > 0
      ? ` — errors: ${response.responses.filter((r) => !r.success).map((r) => r.error?.code).join(", ")}`
      : "")
  );

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

// -----------------------------------------------------------------------
// 2. New signup notification — pushes every admin once a user actually
// submits a profile, so approvals don't sit unnoticed in the queue.
// Admins are just whoever has a doc in the admins/{uid} collection (same
// source of truth as isAdmin()/requireAdmin() everywhere else);
// sendPushToUser already respects each admin's own notificationsEnabled
// toggle, so an admin who doesn't want pushes simply won't get one.
//
// Split into two triggers below (onCreate + onUpdate) instead of one,
// because of how the very first users/{uid} write actually happens:
// beforeSignInBlocking (way down near the IP-ban logic) stamps
// lastKnownIp onto users/{uid} on EVERY sign-in, including the very
// first one right after signup — before the client ever gets to the
// profile form. That write is a `.set(..., {merge:true})` against a
// doc that doesn't exist yet, so it's what actually CREATES users/{uid},
// with nothing on it but lastKnownIp. If this alert fired on create like
// it used to, it would fire for 100% of signups — bot or human,
// profile or not — the instant they sign in, which is exactly the
// "alert with no profile to approve" false alarm this was rewritten to
// stop. onNewSignup is kept only as a safety net for some future path
// that creates users/{uid} with a real name already attached in one write.
//
// The actual signal is profile.NAME specifically, not merely the
// presence of a `profile` object — signInWithPopup's own handler (the
// very next write after the IP-stamp, still well before anyone reaches
// the profile form) already sets `profile: { name: "", neighborhood: "" }`
// as a blank starting draft, same shape watchUserDoc's self-heal path
// uses. That object is truthy, so a plain `!after.profile` check (what
// this shipped with 2026-08-15) treated the blank draft as "already had
// a profile" — firing the alert immediately with the "A new user"
// fallback, then skipping the REAL submission later because `before.profile`
// was already truthy by then. Caught this the same day via the
// permanent Playwright spec added right after (see full-platform.spec.js's
// two "Admin is/isn't notified" tests) — the profile-form's own submit
// handler always requires a non-empty trimmed name before it'll write at
// all, so before/after on .name specifically is the correct, unambiguous
// transition to watch instead.
// -----------------------------------------------------------------------
async function notifyAdminsOfSignup(uid, name) {
  const adminsSnap = await db.collection("admins").get();
  console.log(`notifyAdminsOfSignup(${uid}): found ${adminsSnap.size} admin doc(s): [${adminsSnap.docs.map((d) => d.id).join(", ")}]`);
  if (adminsSnap.empty) return;

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
}

exports.onNewSignup = onDocumentCreated(
  "users/{uid}",
  async (event) => {
    const newUser = event.data?.data();
    if (!newUser?.profile?.name) return; // no real name yet — just the IP stamp (or a blank draft profile); see comment above
    const { uid } = event.params;
    await notifyAdminsOfSignup(uid, newUser.profile.name);
  }
);

exports.onProfileSubmitted = onDocumentUpdated(
  "users/{uid}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (before.profile?.name || !after.profile?.name) return; // only the first time a REAL (non-blank) name appears
    const { uid } = event.params;
    await notifyAdminsOfSignup(uid, after.profile.name);
  }
);

// -----------------------------------------------------------------------
// Runs Cloud Vision's SafeSearch on every profile/business photo the
// moment it's uploaded — first upload AND every re-upload (a Storage
// trigger fires per file-write event, not per "profile created", so a
// photo swapped out after the 7-day image-edit-lock resets gets screened
// again automatically, same as the very first one).
//
// Scoped to users/{uid}/images/ and businesses/{uid}/images/ only — the
// two paths a MEMBER actually uploads to. dailyRewardLogos/
// chatSponsorLogos are admin-uploaded only (see storage.rules), so they
// don't need the same screening.
//
// A flagged image pulls the profile/business back to pending review
// (approved: false — harmless no-op if it wasn't approved yet anyway)
// and records WHY on safeSearchFlag, so the admin queue can show a real
// reason instead of just "pending". Never auto-deletes the image or
// auto-rejects the profile outright — SafeSearch has real false
// positives (swimwear, medical, art), so a human still makes the actual
// call; this only makes sure they're the one making it.
// -----------------------------------------------------------------------
// Storage triggers require the function's region to exactly match the
// bucket's own region — confirmed live 2026-08-14: town-talk-87ff7's
// default bucket is us-east1, an outlier among all 7 editions (every
// other edition's bucket is the us-central1 default that matches this
// file's setGlobalOptions), so deploying with the global region fails
// outright for Pauls Valley specifically.
const STORAGE_TRIGGER_REGION = process.env.GCLOUD_PROJECT === "town-talk-87ff7" ? "us-east1" : "us-central1";

exports.checkImageSafeSearch = onObjectFinalized({ region: STORAGE_TRIGGER_REGION }, async (event) => {
  const filePath = event.data.name;
  const contentType = event.data.contentType || "";
  if (!contentType.startsWith("image/")) return;

  const match = filePath.match(/^(users|businesses)\/([^/]+)\/images\/(.+)$/);
  if (!match) return; // not a path this feature screens
  const [, collection, uid, fileName] = match;

  const gcsUri = `gs://${event.data.bucket}/${filePath}`;
  let safe;
  try {
    const [result] = await visionClient.safeSearchDetection(gcsUri);
    safe = result.safeSearchAnnotation;
  } catch (err) {
    console.error(`checkImageSafeSearch(${filePath}): Vision API call failed:`, err);
    return;
  }
  if (!safe) return;

  // VERY_UNLIKELY / UNLIKELY / POSSIBLE / LIKELY / VERY_LIKELY — POSSIBLE
  // is deliberately excluded from triggering a flag (Vision's own docs
  // note it produces real false positives at that level; LIKELY and up
  // is where it's actually being confident).
  const LIKELY_OR_WORSE = new Set(["LIKELY", "VERY_LIKELY"]);
  const flaggedCategories = ["adult", "racy"].filter((category) => LIKELY_OR_WORSE.has(safe[category]));
  if (flaggedCategories.length === 0) return;

  const reason = flaggedCategories.map((category) => `${category}: ${safe[category]}`).join(", ");
  console.warn(`checkImageSafeSearch: FLAGGED ${filePath} — ${reason}`);

  await db.collection(collection).doc(uid).set({
    approved: false,
    safeSearchFlag: {
      flagged: true,
      reason,
      fileName,
      checkedAt: Timestamp.now(),
    },
  }, { merge: true });

  // Setting approved: false alone doesn't put anything in front of an
  // admin — the queue they actually see is driven by reviewQueue/
  // businessReviewQueue (see loadAdminQueue()/loadBusinessAdminQueue() in
  // index.html), a separate collection the client normally only writes to
  // when a member submits/resubmits. Without this, a flagged profile
  // would silently sit unreviewable with no card anywhere.
  const queueCollection = collection === "users" ? "reviewQueue" : "businessReviewQueue";
  await db.collection(queueCollection).doc(uid).set({ requestedAt: Timestamp.now() }, { merge: true });

  const adminsSnap = await db.collection("admins").get();
  await Promise.all(
    adminsSnap.docs.map((adminDoc) =>
      sendPushToUser(adminDoc.id, {
        type: "safesearch",
        title: "Town Fuss — Flagged Image",
        body: `An uploaded ${collection === "users" ? "profile" : "business"} photo was flagged (${reason}) and pulled for review.`,
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
// Notifies the ORIGINAL sender when someone replies to their chat message.
// Modeled directly on onChatReaction above — same trigger shape, same
// sendPushToUser call, same clickAction pattern — just onCreate instead of
// onUpdate, since a reply is a brand new message doc (with replyTo* fields
// on it) rather than a field changing on an existing one. Unlike
// onChatReaction, replyToSenderId comes straight off the new message
// itself (client-supplied, but firestore.rules' isValidChatReply()
// already verified it matches the real original sender before this could
// ever get written) — no extra lookup needed to find who to notify.
// -----------------------------------------------------------------------
exports.onChatReply = onDocumentCreated(
  "chatRooms/{roomId}/messages/{messageId}",
  async (event) => {
    const data = event.data?.data();
    if (!data || !data.replyToSenderId || data.replyToSenderId === data.senderId) return; // not a reply, or replying to yourself

    await sendPushToUser(data.replyToSenderId, {
      type: "reply",
      title: "Town Fuss — Chat Reply",
      body: `${data.senderName || "A neighbor"} replied to your message in chat.`,
      clickAction: `/index.html?chatroom=${event.params.roomId}&msg=${event.params.messageId}`,
    });
  }
);

// -----------------------------------------------------------------------
// Daily Rewards qualification: posting a chat message. Stamped server-side
// on message CREATE, unlike the game-played/share-clicked qualifiers (which
// are simple self-reported client writes, honor-system, same trust level
// already agreed for social-share verification) — a real chat message
// already has to pass real security rules to exist at all (isApproved,
// length limits, etc.), so it's a genuinely trustworthy signal rather than
// something worth trusting the client to self-report.
// -----------------------------------------------------------------------
exports.onChatMessageDailyRewardQualify = onDocumentCreated(
  "chatRooms/{roomId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message?.senderId) return;
    await db.collection("users").doc(message.senderId)
      .update({ "dailyRewards.chatMessageDate": centralDateString() })
      .catch((err) => console.error(`onChatMessageDailyRewardQualify: couldn't stamp ${message.senderId}:`, err));
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
// Every game with an online-competitive score, not just chess/checkers/
// WynneWars — that was the original set and nothing else was ever added
// as new games shipped, so every other game's top players never got a
// profile badge at all regardless of how good their score actually was.
// Confirmed live 2026-08-09: Titan Business Pros held the single highest
// (and only) Titan Space Defense score on production and still showed no
// #1 badge, purely because "titanSpaceHighScore" was missing from this
// list — nothing wrong with their score or approval status.
//
// Higher number = better rank, plain descending sort.
const GAME_POINT_FIELDS_DESC = [
  "chessPoints", "checkersPoints", "wynneWarsPoints",
  "blackjackPoints", "cribbagePoints", "fgPoints", "golfPoints",
  "heartsPoints", "seaWarPoints", "stackCheckersPoints", "warPoints",
  "blocksHighScore", "deepSeaHighScore", "desertHighScore", "dodgeHighScore",
  "neonDriftHighScore", "titanSpaceHighScore", "sudokuBestStreak",
  "gravitySlingScore", "match3BestEfficiency", "pongWins", "piratesPoints",
];
// Lower number = better rank (elapsed time) — sort ascending instead.
const GAME_TIME_FIELDS_ASC = ["gtfBestTimeMs"];

exports.refreshLeaderboardCache = onSchedule(
  { schedule: "0 7,19 * * *", timeZone: "America/Chicago" },
  async () => {
    const snap = await db.collection("users").where("approved", "==", true).get();

    const cache = {};
    for (const field of GAME_POINT_FIELDS_DESC) {
      const players = [];
      snap.forEach((docSnap) => {
        const points = docSnap.data()[field] || 0;
        if (points > 0) players.push({ uid: docSnap.id, points });
      });
      players.sort((a, b) => b.points - a.points);
      cache[field] = players.slice(0, 10).map((p) => p.uid);
    }

    for (const field of GAME_TIME_FIELDS_ASC) {
      const players = [];
      snap.forEach((docSnap) => {
        const ms = docSnap.data()[field] || 0;
        if (ms > 0) players.push({ uid: docSnap.id, ms });
      });
      players.sort((a, b) => a.ms - b.ms);
      cache[field] = players.slice(0, 10).map((p) => p.uid);
    }

    // Follow Along: ranked by rounds survived (higher wins), then by
    // elapsed time as a tiebreak (lower wins) — same two-field sort its
    // own leaderboard view uses, just computed here instead of queried.
    {
      const players = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const rounds = d.followBestRounds || 0;
        if (rounds > 0) players.push({ uid: docSnap.id, rounds, timeMs: d.followBestTimeMs || Infinity });
      });
      players.sort((a, b) => b.rounds - a.rounds || a.timeMs - b.timeMs);
      cache.followBestRounds = players.slice(0, 10).map((p) => p.uid);
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
// flow this replaces for business). Diamond is a real Stripe subscription,
// sold on two separate Payment Links ($2.99/month or $30/year, added
// 2026-08-15) that both share the "diamond_" prefix — checkout.session.
// completed grants a period computed from whichever plan's interval Stripe
// itself reports (see getDiamondDurationMs) and records the Stripe customer
// ID; invoice.payment_succeeded (fired on each renewal charge, monthly or
// yearly) extends it the same computed period by looking the user up via
// that stored customer ID, since renewal invoice events don't carry
// client_reference_id; customer.subscription.deleted revokes it immediately
// on cancellation, same lookup.
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

// client_reference_id carries THREE pieces of info packed into one string:
// "<type>_<uid>_<edition>", e.g. "gold_AbC123.._eufaula-lake" — type and
// edition are added by whichever edition's pricing page builds the
// Payment Link URL; Firebase uids and Firebase project IDs are both
// guaranteed never to contain an underscore themselves (project IDs:
// lowercase letters/digits/hyphens only; uids: alphanumeric), so splitting
// on the LAST underscore to pull edition off the end, then the first "_"
// to pull the type prefix off the front, is unambiguous. All 7 editions
// share the exact same 3 Payment Links — this is what lets one shared
// link tell 7 separate webhooks (one per edition's Firebase project)
// whether a given purchase is theirs, without needing 18 separate
// Payment Links configured with per-edition metadata in Stripe's
// dashboard. Missing edition suffix (links built before this existed)
// falls back to "town-talk-87ff7" so nothing already in flight breaks.
function parseCheckoutRef(ref) {
  const prefixes = ["business_", "gold_", "diamond_"];
  const prefix = prefixes.find((p) => ref.startsWith(p));
  if (!prefix) return null;
  const type = prefix.slice(0, -1);
  const rest = ref.slice(prefix.length);
  const lastUnderscore = rest.lastIndexOf("_");
  if (lastUnderscore === -1) return { type, uid: rest, edition: "town-talk-87ff7" };
  return { type, uid: rest.slice(0, lastUnderscore), edition: rest.slice(lastUnderscore + 1) };
}

// Diamond now sells on TWO Payment Links — the original $2.99/month
// subscription and a $30/year one added 2026-08-15 — both sharing the same
// "diamond_" client_reference_id prefix (see parseCheckoutRef), so the
// webhook can't tell them apart from the ref alone. Instead of a second
// prefix (which the pricing page would also have to start sending), this
// asks Stripe directly what interval the actual subscription bills on —
// the one thing that's always correct even if prices/plans change later.
// Defaults to monthly on any lookup failure since that's been the only
// option this whole grant path supported until now.
async function getDiamondDurationMs(stripe, subscriptionId) {
  if (!subscriptionId) return ONE_MONTH_MS;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return sub.items?.data?.[0]?.price?.recurring?.interval === "year" ? ONE_YEAR_MS : ONE_MONTH_MS;
  } catch (err) {
    console.error(`Stripe webhook: couldn't look up subscription ${subscriptionId} to determine Diamond duration, defaulting to monthly:`, err);
    return ONE_MONTH_MS;
  }
}

async function grantFromCheckout(session, stripe) {
  const parsed = parseCheckoutRef(session.client_reference_id || "");
  if (!parsed) {
    console.error("Stripe webhook: checkout.session.completed with unrecognized client_reference_id:", session.client_reference_id);
    return;
  }
  const { type, uid } = parsed;
  if (type === "business") {
    await db
      .collection("businesses")
      .doc(uid)
      .update({ businessPaidUntil: Timestamp.fromDate(new Date(Date.now() + ONE_YEAR_MS)) })
      .catch((err) => console.error(`Stripe webhook: couldn't mark business ${uid} paid:`, err));
  } else if (type === "gold") {
    await db
      .collection("users")
      .doc(uid)
      .update({
        isGoldMember: true,
        goldExpiresAt: Timestamp.fromDate(new Date(Date.now() + ONE_YEAR_MS)),
      })
      .catch((err) => console.error(`Stripe webhook: couldn't grant gold to ${uid}:`, err));
  } else if (type === "diamond") {
    const durationMs = await getDiamondDurationMs(stripe, session.subscription);
    await db
      .collection("users")
      .doc(uid)
      .update({
        isDiamondMember: true,
        diamondExpiresAt: Timestamp.fromDate(new Date(Date.now() + durationMs)),
        stripeCustomerId: session.customer || null,
      })
      .catch((err) => console.error(`Stripe webhook: couldn't grant diamond to ${uid}:`, err));
  }
}

async function extendDiamondFromInvoice(invoice, stripe) {
  if (!invoice.customer || !invoice.subscription) return;
  const snap = await db.collection("users").where("stripeCustomerId", "==", invoice.customer).limit(1).get();
  if (snap.empty) return; // likely the subscription's first invoice, already covered by checkout.session.completed
  const durationMs = await getDiamondDurationMs(stripe, invoice.subscription);
  await snap.docs[0].ref
    .update({
      isDiamondMember: true,
      diamondExpiresAt: Timestamp.fromDate(new Date(Date.now() + durationMs)),
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

    // Every edition (Pauls Valley, Eufaula Lake, ...) is a separate Firebase
    // project but shares ONE Stripe account and the same 3 Payment Links —
    // Stripe sends EVERY event to EVERY registered webhook endpoint on that
    // account, not just "the right one". The edition rides along inside
    // client_reference_id itself (see parseCheckoutRef above), so this
    // function can tell whether an event is actually its own before acting
    // on it. invoice.payment_succeeded/customer.subscription.deleted don't
    // need this same check — they look up the user by stripeCustomerId in
    // THIS project's own Firestore, which simply won't contain another
    // edition's customers at all, so cross-edition events already no-op
    // there on their own.
    if (event.type === "checkout.session.completed") {
      const eventEdition = parseCheckoutRef(event.data.object.client_reference_id || "")?.edition || "town-talk-87ff7";
      if (eventEdition !== process.env.GCLOUD_PROJECT) {
        console.log(`Stripe webhook: ignoring checkout.session.completed for edition "${eventEdition}" (this is ${process.env.GCLOUD_PROJECT})`);
        res.status(200).send("ignored - different edition");
        return;
      }
    }

    try {
      if (event.type === "checkout.session.completed") {
        await grantFromCheckout(event.data.object, stripe);
      } else if (event.type === "invoice.payment_succeeded") {
        await extendDiamondFromInvoice(event.data.object, stripe);
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

    // Admins keep their Diamond/Gold perks permanently, regardless of
    // whatever expiresAt their grant happens to carry — see
    // ensureAdminDiamondPerks() above for why this exclusion exists.
    const adminsSnap = await db.collection("admins").get();
    const adminUids = new Set(adminsSnap.docs.map((d) => d.id));

    const goldSnap = await db.collection("users").where("isGoldMember", "==", true).where("goldExpiresAt", "<", now).get();
    goldSnap.forEach((docSnap) => {
      if (adminUids.has(docSnap.id)) return;
      batch.update(docSnap.ref, { isGoldMember: false });
      any = true;
    });

    const diamondSnap = await db.collection("users").where("isDiamondMember", "==", true).where("diamondExpiresAt", "<", now).get();
    diamondSnap.forEach((docSnap) => {
      if (adminUids.has(docSnap.id)) return;
      batch.update(docSnap.ref, { isDiamondMember: false });
      any = true;
    });

    if (any) await batch.commit();
  }
);

// Excludes visually-ambiguous characters (0/O, 1/I/l) — this gets read off
// a phone screen and typed/spoken to a cashier, so avoiding characters
// that look alike matters more here than a slightly bigger keyspace would.
function generateDailyRewardCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// -----------------------------------------------------------------------
// Daily Rewards draw — runs once a day at 4pm America/Chicago. For each
// currently-active PUBLISHED sponsor, picks winner(s) at random from
// everyone who (a) opted in, (b) did all 3 qualifying things TODAY
// (centralDateString match on gamePlayedDate/chatMessageDate/
// shareClickDate), and (c) hasn't won anything from ANY sponsor in the
// past 7 days. Once someone wins once today, they're removed from the
// pool for every other sponsor's draw that same run — "spread it around"
// was explicit, not just the 7-day cooldown.
//
// Writes two very different kinds of record for each win — see the
// firestore.rules comment on dailyRewardWinners/dailyRewardsPublicToday
// for why: the full record (uid, coupon code, redeemed flag) stays
// narrowly readable (the winner, their sponsor, admins), while
// dailyRewardsPublicToday/current — a single doc — is the public,
// code-free summary the chat-room banner reads. The doc's `date` field
// is what drives the daily rotation ("yesterday's winners disappear"):
// on the first run of a new day the doc is replaced outright, but if
// this run's `date` already matches what's stored (a same-day re-run —
// scheduler retry, or a manual re-trigger while testing) this run's
// winners are merged into the existing array instead of clobbering it.
// Wrapped in a transaction so two same-day runs can't race each other's
// read-then-write.
// -----------------------------------------------------------------------
async function mergePublicWinnersToday(todayStr, newWinners) {
  const ref = db.collection("dailyRewardsPublicToday").doc("current");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : null;
    const sameDay = existing && existing.date === todayStr;
    const winners = sameDay ? [...(existing.winners || []), ...newWinners] : newWinners;
    tx.set(ref, { date: todayStr, winners });
  });
}

exports.dailyRewardsDraw = onSchedule(
  { schedule: "00 23 * * *", timeZone: "America/Chicago" },
  async () => {
    const todayStr = centralDateString();
    const now = Timestamp.now();

    const sponsorsSnap = await db.collection("dailyRewardSponsors").where("status", "==", "published").get();
    const activeSponsors = sponsorsSnap.docs.filter((d) => {
      const s = d.data();
      return s.startDate.toMillis() <= now.toMillis()
          && s.endDate.toMillis() >= now.toMillis()
          && (s.quantityCap == null || (s.quantityAwarded || 0) < s.quantityCap);
    });

    if (activeSponsors.length === 0) {
      await mergePublicWinnersToday(todayStr, []);
      return;
    }

    // Firestore has no clean way to query "3 different fields all equal
    // today" without a matching composite index for that exact
    // combination — filtering in memory instead, on just the opted-in
    // users, which is a small enough set per edition that this is cheap
    // rather than needing yet another index.
    const usersSnap = await db.collection("users").where("dailyRewards.optedIn", "==", true).get();
    const sevenDaysAgoMs = now.toMillis() - 7 * 24 * 60 * 60 * 1000;
    let eligible = usersSnap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => {
        const dr = u.dailyRewards || {};
        if (dr.gamePlayedDate !== todayStr || dr.chatMessageDate !== todayStr || dr.shareClickDate !== todayStr) return false;
        if (dr.lastWonAt && dr.lastWonAt.toMillis() > sevenDaysAgoMs) return false;
        return true;
      });

    if (eligible.length === 0) {
      await mergePublicWinnersToday(todayStr, []);
      return;
    }

    // Shuffle once — Math.random() is fine here, this isn't a security
    // context, just "pick a fair winner."
    eligible = eligible.sort(() => Math.random() - 0.5);

    const publicWinners = [];
    const usedUids = new Set();

    for (const sponsorDoc of activeSponsors) {
      const sponsor = sponsorDoc.data();
      const sponsorId = sponsorDoc.id;
      let remainingSlots = sponsor.maxWinnersPerDay || 1;
      if (sponsor.quantityCap != null) {
        remainingSlots = Math.min(remainingSlots, sponsor.quantityCap - (sponsor.quantityAwarded || 0));
      }

      let awarded = 0;
      for (const candidate of eligible) {
        if (awarded >= remainingSlots) break;
        if (usedUids.has(candidate.uid)) continue;
        usedUids.add(candidate.uid);
        awarded++;

        const code = generateDailyRewardCode();
        const winnerName = candidate.profile?.name || "A Town Fuss member";
        const winnerPhotoUrl = candidate.images?.[0]?.url || "";

        await db.collection("dailyRewardWinners").add({
          uid: candidate.uid,
          winnerName,
          winnerPhotoUrl,
          sponsorId,
          sponsorName: sponsor.companyName,
          sponsorLogoUrl: sponsor.logoUrl || "",
          prizeDescription: sponsor.prizeDescription,
          couponCode: code,
          wonAt: now,
          wonDateStr: todayStr,
          redeemed: false,
          redeemedAt: null,
        });
        await db.collection("users").doc(candidate.uid).update({ "dailyRewards.lastWonAt": now });
        await db.collection("dailyRewardSponsors").doc(sponsorId).update({ quantityAwarded: FieldValue.increment(1) });

        publicWinners.push({
          name: winnerName,
          photoUrl: winnerPhotoUrl,
          prize: sponsor.prizeDescription,
          sponsorName: sponsor.companyName,
          sponsorLogoUrl: sponsor.logoUrl || "",
        });

        await sendPushToUser(candidate.uid, {
          type: "daily_reward_win",
          title: "🎉 You won a Daily Reward!",
          body: `You won ${sponsor.prizeDescription} from ${sponsor.companyName}! Check your profile page for your code.`,
          clickAction: "/index.html?view=dashboard",
        }).catch((err) => console.error(`dailyRewardsDraw: couldn't push-notify winner ${candidate.uid}:`, err));
      }
    }

    await mergePublicWinnersToday(todayStr, publicWinners);
  }
);

// -----------------------------------------------------------------------
// Daily Rewards sponsor portal invite. A sponsor never gets a real Town
// Fuss account/profile — just a Firebase Auth login (same Auth instance,
// but no users/{uid} doc, and a dailyRewardSponsorAccounts/{uid} doc
// instead, which is what firestore.rules' isSponsorFor() actually checks
// to scope their reads to their own giveaway).
//
// Used to email the sponsor their setup link via Resend; since that
// account was removed 2026-08-15, this now just returns the link to the
// calling admin instead (see the #daily-rewards-sponsor-invite handler in
// index.html), who sends it to the sponsor themselves however they like.
// Still uses generatePasswordResetLink() under the hood — that part never
// depended on Resend, it's a plain Admin SDK call that returns a real
// Firebase-hosted link; Resend was only ever the delivery mechanism.
// -----------------------------------------------------------------------
exports.inviteDailyRewardSponsor = onCall(async (request) => {
  await requireAdmin(request);

  const sponsorId = (request.data?.sponsorId || "").trim();
  const email = (request.data?.email || "").trim().toLowerCase();
  if (!sponsorId || !email) throw new HttpsError("invalid-argument", "sponsorId and email are required.");

  const sponsorSnap = await db.collection("dailyRewardSponsors").doc(sponsorId).get();
  if (!sponsorSnap.exists) throw new HttpsError("not-found", "That giveaway doesn't exist.");

  let userRecord;
  try {
    userRecord = await getAuth().getUserByEmail(email);
  } catch {
    // Doesn't exist yet — create it. No password set; they set their own
    // via the link below, same as the removed password-reset flow.
    userRecord = await getAuth().createUser({ email });
  }

  await db.collection("dailyRewardSponsorAccounts").doc(userRecord.uid).set({
    email,
    sponsorId,
    invitedAt: Timestamp.now(),
    invitedBy: request.auth.uid,
  });

  const continueUrl = (request.data?.continueUrl || "").trim() || undefined;
  const link = await getAuth().generatePasswordResetLink(
    email,
    continueUrl ? { url: continueUrl } : undefined
  );

  return { ok: true, link };
});

// -----------------------------------------------------------------------
// The sponsor portal's ONE write action — marking a coupon redeemed. Not
// a direct client write (dailyRewardWinners' rule is allow write: if
// false, on purpose — see the firestore.rules comment) specifically so
// this can independently re-verify the caller is actually the RIGHT
// sponsor for THIS SPECIFIC winner doc server-side, not just trust
// whatever the client claims. The code itself always stays in the
// response either way — "in case of a mistake" was explicit.
// -----------------------------------------------------------------------
exports.markDailyRewardRedeemed = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const winnerId = (request.data?.winnerId || "").trim();
  const redeemed = !!request.data?.redeemed;
  if (!winnerId) throw new HttpsError("invalid-argument", "winnerId is required.");

  const acctSnap = await db.collection("dailyRewardSponsorAccounts").doc(request.auth.uid).get();
  if (!acctSnap.exists) throw new HttpsError("permission-denied", "Not a sponsor account.");

  const winnerSnap = await db.collection("dailyRewardWinners").doc(winnerId).get();
  if (!winnerSnap.exists) throw new HttpsError("not-found", "Winner record not found.");
  if (winnerSnap.data().sponsorId !== acctSnap.data().sponsorId) {
    throw new HttpsError("permission-denied", "That winner isn't from your giveaway.");
  }

  await winnerSnap.ref.update({
    redeemed,
    redeemedAt: redeemed ? Timestamp.now() : null,
  });
  return { ok: true };
});

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
      const result = await getAuth().listUsers(1000, pageToken);
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
  ensureAdminDiamondPerks(callerUid);
  return callerUid;
}

// Admins get full Diamond-tier perks (unlimited daily online games/
// messages) permanently — this was previously only ever a plain data
// field (isDiamondMember/diamondExpiresAt) manually set on an admin's own
// profile with no code-level tie to admin status at all, in ANY game, old
// or new. That meant it was fully subject to the nightly expireMemberships
// sweep below: if the original grant's diamondExpiresAt was ever left in
// the past (e.g. a normal 1-month grant that was never renewed), the very
// next 4am run would have silently cleared it — exactly what happened.
// Self-heals on every admin action instead of relying on a field that can
// silently expire out from under someone: fire-and-forget (never blocks
// or fails the actual admin action this ran alongside), idempotent, and
// belt-and-suspenders with the admin exclusion added to expireMemberships.
function ensureAdminDiamondPerks(uid) {
  db.collection("users").doc(uid).update({
    isDiamondMember: true,
    diamondExpiresAt: Timestamp.fromDate(new Date(Date.now() + 100 * ONE_YEAR_MS)),
  }).catch((err) => console.error(`Couldn't refresh admin Diamond perks for ${uid}:`, err));
}

// Client calls this once right after determining isAdminUser==true on
// every sign-in (index.html's onAuthStateChanged), not just when an admin
// happens to use Delete Profile/Restore Profile/Grant Gold — requireAdmin()
// only self-heals Diamond perks as a SIDE EFFECT of those three specific
// actions, so an admin who never touches any of them between deploys would
// never actually get healed. This makes the heal fire on every login
// instead of waiting on an unrelated action.
exports.ensureMyAdminPerks = onCall(async (request) => {
  await requireAdmin(request);
  return { ok: true };
});

// Shared by adminDeleteProfile and banUserAndIp — both end with the exact
// same outcome (profile archived for the 10-day restore window, doc
// deleted, Auth account disabled and its refresh tokens revoked); banUserAndIp
// just does one extra thing (blocking the IP) on top. Returns the deleted
// profile's data so banUserAndIp can pull lastKnownIp off it without a
// second read.
async function performProfileDeletion(callerUid, targetUid) {
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

  const profileData = userSnap.data();
  await db.collection("deletedUsers").doc(targetUid).set({
    profileData,
    deletedAt: Timestamp.now(),
    deletedBy: callerUid,
    purgeAt: Timestamp.fromMillis(now + DELETED_PROFILE_RETENTION_MS),
  });
  await userRef.delete();

  try {
    await getAuth().updateUser(targetUid, { disabled: true });
    await getAuth().revokeRefreshTokens(targetUid);
  } catch (err) {
    // The profile is already archived and removed either way — losing the
    // Auth-disable step isn't fatal, just log it for follow-up.
    console.error(`Couldn't disable Auth account for ${targetUid}:`, err);
  }

  return profileData;
}

exports.adminDeleteProfile = onCall(async (request) => {
  const callerUid = await requireAdmin(request);

  const targetUid = request.data?.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }

  await performProfileDeletion(callerUid, targetUid);
  return { ok: true };
});

// Same end state as adminDeleteProfile (archived profile, doc deleted, Auth
// account disabled) plus a permanent IP block, for serious-violation
// removals. The IP comes from users/{uid}.lastKnownIp, which
// beforeSignInBlocking (above) keeps fresh on every sign-in — if that field
// was never populated (e.g. the account never actually signed in through
// the Identity-Platform-upgraded project, or was created via some other
// path), the profile is still fully removed but there's no IP on record to
// block; that's surfaced back via ipBanned: false rather than failing the
// whole action, since removing the account is still the more urgent half
// of "serious violation" handling.
exports.banUserAndIp = onCall(async (request) => {
  const callerUid = await requireAdmin(request);

  const targetUid = request.data?.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }

  const profileData = await performProfileDeletion(callerUid, targetUid);

  const ip = profileData.lastKnownIp;
  if (ip) {
    await db.collection("blockedIPs").doc(ip).set({
      bannedAt: Timestamp.now(),
      bannedBy: callerUid,
      bannedUid: targetUid,
    });
  } else {
    console.error(`banUserAndIp(${targetUid}): no lastKnownIp on record — account disabled and profile removed, but no IP could be blocked.`);
  }

  return { ok: true, ipBanned: !!ip };
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
    await getAuth().updateUser(targetUid, { disabled: false });
  } catch (err) {
    console.error(`Couldn't re-enable Auth account for ${targetUid}:`, err);
  }

  return { ok: true };
});

// Lets an admin gift Gold membership to a member, rate-limited per admin
// (not platform-wide) to keep this a moderation/reward tool rather than a
// way to hand out unlimited free memberships. Same calendar-day reset as
// every other daily limit on this site (game plays, DMs, chat messages),
// not a rolling 24h window, for consistency with those.
const ADMIN_GOLD_GRANTS_PER_DAY = 3;
exports.adminGrantGold = onCall(async (request) => {
  const callerUid = await requireAdmin(request);

  const targetUid = request.data?.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }

  const targetSnap = await db.collection("users").doc(targetUid).get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "That profile no longer exists.");
  }

  const today = Math.floor(Date.now() / 86400000);
  const limitRef = db.collection("adminGoldGrantLimits").doc(callerUid);
  const limitSnap = await limitRef.get();
  const limitData = limitSnap.exists ? limitSnap.data() : { day: today, count: 0 };
  const usedToday = limitData.day === today ? limitData.count : 0;
  if (usedToday >= ADMIN_GOLD_GRANTS_PER_DAY) {
    throw new HttpsError("resource-exhausted", `You've already granted ${ADMIN_GOLD_GRANTS_PER_DAY} Gold memberships today — try again tomorrow.`);
  }

  await db.collection("users").doc(targetUid).update({
    isGoldMember: true,
    goldExpiresAt: Timestamp.fromDate(new Date(Date.now() + ONE_YEAR_MS)),
  });
  await limitRef.set({ day: today, count: usedToday + 1 });

  return { ok: true, remainingToday: ADMIN_GOLD_GRANTS_PER_DAY - (usedToday + 1) };
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
      await getAuth().deleteUser(docSnap.id).catch((err) => {
        console.error(`Couldn't delete Auth account ${docSnap.id} during purge:`, err);
      });
    }
  }
);

// -----------------------------------------------------------------------
// 11. IP ban enforcement — sign-in side.
//
// Requires the project to be upgraded to Firebase Authentication with
// Identity Platform (plain Firebase Auth has no blocking-function hook at
// all). Runs on EVERY sign-in, for every account, not just ones an admin
// has flagged:
//
//   1. If the signer's current IP is a doc ID in blockedIPs, the sign-in
//      is rejected outright with a clear error. This is what makes a ban
//      actually stick against the device/network itself, not just the one
//      account that got banned — the usual way someone tries to get back
//      on after a ban is a brand-new account from the same connection.
//   2. Otherwise, their current IP is stamped onto users/{uid}.lastKnownIp
//      (merge, so it works whether the profile doc exists yet or not —
//      this can fire on the very first sign-in right after signup, before
//      the client has necessarily created the doc). This keeps the field
//      fresh on every sign-in, not just at signup, since a ban usually
//      happens well after signup and banUserAndIp (below) needs whatever
//      IP the person most recently actually signed in from.
//
// A failure to WRITE lastKnownIp never blocks a legitimate sign-in — only
// an actual blockedIPs match does that.
// -----------------------------------------------------------------------
exports.beforeSignInBlocking = beforeUserSignedIn(async (event) => {
  const ip = event.ipAddress;
  const uid = event.data?.uid;
  if (!ip || !uid) return;

  const blockedSnap = await db.collection("blockedIPs").doc(ip).get();
  if (blockedSnap.exists) {
    throw new IdentityHttpsError("permission-denied", "This device has been blocked from Town Fuss.");
  }

  await db.collection("users").doc(uid).set({ lastKnownIp: ip }, { merge: true }).catch((err) => {
    console.error(`Couldn't record lastKnownIp for ${uid}:`, err);
  });
});

// -----------------------------------------------------------------------
// Keeps each admin's Firebase Auth custom claim (`admin: true`) in sync
// with the admins/{uid} Firestore collection, so security rules that
// can't do a Firestore lookup of their own — Storage rules, specifically —
// have a real way to check "is this caller an admin" without one.
//
// This replaces a cross-service firestore.exists() check that
// storage.rules used to make directly against admins/{uid}. That check
// was syntactically correct (verified against Firebase's own docs, and
// against the live-deployed rules content) but kept failing at runtime
// for a confirmed real admin — never fully root-caused, and cross-service
// Storage->Firestore rule calls add a real Firestore read (and its
// latency/failure surface) to every single Storage request regardless.
// Custom claims are the pattern Firebase actually recommends for
// role-based access control in rules generally: the claim rides on the
// ID token itself, so `request.auth.token.admin == true` is a pure,
// local, zero-latency check with no cross-service call at all.
//
// Custom claims only take effect on a FRESH ID token — an admin who was
// already signed in when their claim changes needs to sign out/in again
// (or wait for the SDK's background token refresh, roughly hourly) before
// a claim-gated rule will see it.
// -----------------------------------------------------------------------
exports.syncAdminClaim = onDocumentWritten("admins/{uid}", async (event) => {
  const uid = event.params.uid;
  const stillAdmin = event.data?.after?.exists ?? false;
  await getAuth().setCustomUserClaims(uid, stillAdmin ? { admin: true } : null).catch((err) => {
    // Most likely cause: the admins/{uid} doc was created for a uid that
    // doesn't have a matching Auth account (typo, or the account was
    // deleted separately) — log it but don't retry-loop forever on a
    // uid that will never resolve.
    console.error(`syncAdminClaim: couldn't set claim for ${uid}:`, err);
  });
});

// ============================= OUTREACH ADMIN ===============================
// Backs the separate townfuss-outreach-admin webpage/repo (not part of this
// site) — admin-only tools to draft cold-outreach emails to Town Fuss
// businesses. Deliberately callable-only, no new Firestore rules: every
// read/write here goes through requireAdmin() + the Admin SDK, so the
// client never touches outreachManualLeads/outreachSentLog directly.
//
// Superseded the local-script version of this (a `node leads.js` /
// `node draft.js` CLI in a separate outreach/ folder, built earlier the
// same day) after the user found running scripts in a terminal too
// clunky for daily use — this is the same logic, server-side, driven by
// buttons on a webpage instead.
// google-auth-library, not the full googleapis package: googleapis's
// require() generates client code for every Google API and was slow
// enough to load that Firebase's own deploy-time backend-discovery step
// hit its 10-second timeout and refused to deploy at all ("Cannot
// determine backend specification"). This only needs OAuth2 token
// refresh + one Gmail REST endpoint, called directly via fetch below.
const { OAuth2Client } = require("google-auth-library");

const gmailOAuthClientId = defineSecret("GMAIL_OAUTH_CLIENT_ID");
const gmailOAuthClientSecret = defineSecret("GMAIL_OAUTH_CLIENT_SECRET");
const gmailRefreshToken = defineSecret("GMAIL_REFRESH_TOKEN"); // titanbusinesspros@gmail.com
// Second sending account (pollysfarmok@gmail.com) — same identity
// (info@titanbusinesspros.com shown to recipients either way), just a
// second Gmail account to draft/send from so daily volume isn't capped at
// one account's worth. Reuses the SAME OAuth client id/secret above —
// only the refresh token differs per-account, since a token represents
// one specific account's permission grant and can't be shared across
// accounts (see the chat explanation of why this can't be skipped).
const gmailRefreshToken2 = defineSecret("GMAIL2_REFRESH_TOKEN");
// Third and fourth sending accounts (kouklainfo@gmail.com,
// singanewpsalm23@gmail.com), added 2026-08-21 — disguised behind
// okie@townfuss.com instead of info@titanbusinesspros.com, a different
// Send-As alias than accounts 1 and 2 use. Same OAuth client id/secret
// as before; only the refresh token and fromAddress differ per-account.
const gmailRefreshToken3 = defineSecret("GMAIL3_REFRESH_TOKEN");
const gmailRefreshToken4 = defineSecret("GMAIL4_REFRESH_TOKEN");
const OUTREACH_DAILY_BATCH_SIZE = 10;
// CAN-SPAM requires every commercial email — including a one-time send,
// there's no "just one email" exemption — to include a valid physical
// postal address and a working way to opt out of future email. Appended
// automatically here so it's never accidentally left out of a draft/reply
// (2026-08-21: previously nothing enforced this at all — whatever the
// admin happened to type into the body was all that went out).
const OUTREACH_COMPLIANCE_FOOTER =
  "\n\n—\nAddress: 9905 S Pennsylvania AVE, STE A, Oklahoma City OK 73159\n" +
  'Don\'t want to hear from us again? Reply to this email with "UNSUBSCRIBE" and we will never contact this address again.';

// Registry of every sending account this system knows about — the single
// source of truth the webpage, the lock/status endpoints, and
// outreachCreateDraft all read from, instead of "primary"/"secondary"
// being hardcoded in three different places. Each agent carries its own
// fromAddress now (2026-08-21) instead of one shared OUTREACH_FROM_ADDRESS
// constant, since different sending accounts can be disguised behind
// different verified Send-As aliases — not every agent has to share the
// same "info@titanbusinesspros.com"-style front.
//
// TO ADD A THIRD (or fourth, etc.) AGENT LATER:
//   1. `firebase functions:secrets:set GMAIL3_REFRESH_TOKEN` (after that
//      account's own OAuth authorization, same as accounts 1 and 2).
//   2. `const gmailRefreshToken3 = defineSecret("GMAIL3_REFRESH_TOKEN");`
//   3. Add one line below: `tertiary: { label: "...@gmail.com", secret: gmailRefreshToken3, fromAddress: "..." },`
//      and add gmailRefreshToken3 to outreachCreateDraft's `secrets: [...]` array.
// That's it — the settings/lock functions, and the webpage's per-agent
// controls, all read this list and don't need any other change.
const OUTREACH_AGENTS = {
  primary: { label: "titanbusinesspros@gmail.com", secret: gmailRefreshToken, fromAddress: "info@titanbusinesspros.com" },
  secondary: { label: "pollysfarmok@gmail.com", secret: gmailRefreshToken2, fromAddress: "info@titanbusinesspros.com" },
  tertiary: { label: "kouklainfo@gmail.com", secret: gmailRefreshToken3, fromAddress: "okie@townfuss.com" },
  quaternary: { label: "singanewpsalm23@gmail.com", secret: gmailRefreshToken4, fromAddress: "okie@townfuss.com" },
};
const OUTREACH_LOCK_STALE_MS = 3 * 60 * 60 * 1000; // 3 hours — see outreachAcquireLock

// Lists today's candidate leads — read-only, writes nothing. This is
// Checkpoint 1 (see the outreach admin page): nobody is marked contacted
// just by showing up in this list, only once outreachCreateDraft actually
// runs for them.
// Real unpaid Town Fuss business-listing signups are a legitimate lead
// source, but per explicit instruction they must NEVER show up in
// "Today's leads to draft" on their own — only after being explicitly
// checked into the queue, exactly like every other lead. So instead of
// handing them straight to Today's list, this upserts each one into
// outreachCandidates as status:"candidate" (skipped if a candidate with
// that email already exists) so it appears in "Review new businesses" and
// needs the same checkbox + "Add to queue" action as everything else.
//
// Called from BOTH outreachListLeads and outreachListCandidates — it has
// to run on whichever one the admin opens first, since "Review new
// businesses" is where the checkbox actually lives, not "Today's leads."
async function syncUnpaidBusinessLeadsIntoCandidates() {
  const sentSnap = await db.collection("outreachSentLog").get();
  const alreadyContacted = new Set(sentSnap.docs.map((d) => d.id));

  const existingCandidatesSnap = await db.collection("outreachCandidates").get();
  const knownCandidateEmails = new Set(
    existingCandidatesSnap.docs.map((d) => (d.data().email || "").toLowerCase()).filter(Boolean)
  );

  // Same "filter rejected/paid in JS, not in the query" reasoning as the
  // local leads.js had: most business docs never get a `rejected` field
  // written at all, and Firestore's `!=` excludes docs missing the field
  // entirely, which would silently drop almost every real lead.
  const bizSnap = await db.collection("businesses").get();
  const now = Date.now();
  const newCandidateWrites = [];
  for (const docSnap of bizSnap.docs) {
    const data = docSnap.data();
    if (data.rejected === true) continue;
    const paidUntilMs = data.businessPaidUntil?.toMillis ? data.businessPaidUntil.toMillis() : 0;
    if (paidUntilMs > now) continue; // already paid — not a lead
    let email;
    try {
      const userRecord = await getAuth().getUser(docSnap.id);
      email = (userRecord.email || "").toLowerCase();
    } catch {
      continue; // orphaned listing with no matching auth user — skip
    }
    if (!email || alreadyContacted.has(email) || knownCandidateEmails.has(email)) continue;
    newCandidateWrites.push(
      db.collection("outreachCandidates").add({
        companyName: data.name || "",
        phone: data.phone || "",
        town: data.town || "",
        email,
        source: "unpaid-business-listing",
        status: "candidate",
        searchedAt: Timestamp.now(),
      })
    );
    knownCandidateEmails.add(email);
  }
  await Promise.all(newCandidateWrites);
  return alreadyContacted;
}

exports.outreachListLeads = onCall(async (request) => {
  await requireAdmin(request);

  // NOTE: this used to filter out anything already in outreachSentLog
  // (i.e. already drafted/sent before) — removed entirely, permanently,
  // per explicit repeated instruction. The same email can now be checked
  // in and drafted again as many times as wanted; nothing here excludes
  // it based on contact history anymore.
  await syncUnpaidBusinessLeadsIntoCandidates();

  const manualSnap = await db.collection("outreachManualLeads").get();
  const manualLeads = manualSnap.docs.map((d) => ({ ...d.data(), email: d.id, source: "manual" }));

  // Businesses found via a town search (outreachGenerateLeads), or the
  // real unpaid-business-listing candidates upserted above, that have
  // been explicitly checked and moved into this week's queue. This is
  // now the ONLY way a business shows up here — nothing appears in
  // Today's leads to draft without being explicitly checked in first,
  // except manual leads (added one at a time on purpose via the "Add a
  // lead" form, which is itself an explicit pick). Carries candidateId so
  // outreachCreateDraft can mark the specific candidate doc "drafted"
  // once a real draft exists for it, not just the sentLog entry.
  const queuedSnap = await db.collection("outreachCandidates").where("status", "==", "queued").get();
  const queuedLeads = queuedSnap.docs
    .map((d) => {
      const data = d.data();
      return {
        name: data.companyName || "",
        phone: data.phone || "",
        town: data.town || "",
        email: (data.email || "").toLowerCase(),
        source: data.source || "town-search",
        candidateId: d.id,
        searchedAtMs: data.searchedAt?.toMillis?.() || 0,
      };
    })
    .filter((lead) => lead.email)
    // A plain .where() with no .orderBy() returns Firestore's unspecified
    // index order, NOT insertion order — this is the real reason a CSV
    // upload's row order (or a town search's result order) didn't survive
    // into "Today's leads to draft." Same sort direction "Review new
    // businesses" already uses (most-recently-added first), so CSV row 1
    // — which gets the newest timestamp among its batch, see
    // outreachBulkAddCandidates — ends up first here too.
    .sort((a, b) => b.searchedAtMs - a.searchedAtMs)
    .map(({ searchedAtMs, ...lead }) => lead);

  const combined = [...manualLeads, ...queuedLeads];
  const seen = new Set();
  const deduped = combined.filter((lead) => {
    if (seen.has(lead.email)) return false;
    seen.add(lead.email);
    return true;
  });

  return { leads: deduped.slice(0, OUTREACH_DAILY_BATCH_SIZE), totalCandidatesFound: deduped.length };
});

// Permanently removes a lead from ever showing up in "Today's leads to
// draft" again — WITHOUT drafting or sending anything. Real gap this
// fixes: leads sourced from Town Fuss's own unpaid business listings had
// no reject/remove option anywhere (only town-search candidates did, via
// outreachSetCandidateStatus). Reuses the exact same exclusion mechanism
// outreachCreateDraft already relies on (an outreachSentLog entry), just
// marked "skipped" instead of "drafted" so it's clear in the data why
// that email is excluded.
exports.outreachSkipLead = onCall(async (request) => {
  await requireAdmin(request);
  const email = (request.data?.email || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "email is required.");
  await db.collection("outreachSentLog").doc(email).set({ skippedAt: Timestamp.now(), reason: "manually removed" });
  return { ok: true };
});

// Adds a lead you know about yourself — the webpage's replacement for the
// old leads.csv file. Keyed by lowercased email so re-adding the same
// person just updates their info instead of duplicating.
exports.outreachAddManualLead = onCall(async (request) => {
  await requireAdmin(request);
  const email = (request.data?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new HttpsError("invalid-argument", "A valid email is required.");
  const name = (request.data?.name || "").trim();
  const town = (request.data?.town || "").trim();
  const notes = (request.data?.notes || "").trim();
  await db.collection("outreachManualLeads").doc(email).set({ name, town, notes, addedAt: Timestamp.now() });
  return { ok: true };
});

// Email headers (Subject, display names) are technically restricted to
// plain ASCII by RFC 5322 — raw UTF-8 bytes (like an em-dash "—") dropped
// directly into a header line get misinterpreted by mail clients as
// Latin-1/Windows-1252, producing exactly the "â€”"-style garbled text
// this fixes. RFC 2047's encoded-word format (=?UTF-8?B?...?=) is the
// correct way to put non-ASCII text in a header — every mail client
// understands it, no more guessing. Left alone if already pure ASCII.
function encodeMimeHeader(value) {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const OUTREACH_APPROVED_LABEL_NAME = "Outreach/Approved";

// Finds the Gmail label's internal ID (needed to apply it via the API —
// unlike the Apps Script side, which can look labels up by name
// directly), creating it if it somehow doesn't exist yet on this account.
async function ensureApprovedLabelId(accessToken) {
  const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new HttpsError("internal", `Gmail API error listing labels (${listRes.status}): ${await listRes.text().catch(() => "")}`);
  const listData = await listRes.json();
  const existing = (listData.labels || []).find((l) => l.name === OUTREACH_APPROVED_LABEL_NAME);
  if (existing) return existing.id;

  const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: OUTREACH_APPROVED_LABEL_NAME, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  if (!createRes.ok) throw new HttpsError("internal", `Gmail API error creating label (${createRes.status}): ${await createRes.text().catch(() => "")}`);
  return (await createRes.json()).id;
}

// Checkpoint 2's backend: creates a real Gmail Draft, From the verified
// Send-As alias, and immediately labels it Outreach/Approved itself — the
// review already happened on the webpage (editing subject/body before
// this is even called), so there's no reason to also require a separate
// trip into Gmail just to click a label. This is also the ONLY place a
// lead gets marked contacted (outreachSentLog) — dropping someone at
// Checkpoint 1 leaves no trace of them, same guarantee the local-script
// version had.
//
// IMPORTANT BEHAVIOR CHANGE: because this now auto-labels, clicking
// "Create drafts" is the real commit point — the agent's automatic
// sender WILL pick this up and send it once that agent is active and its
// start time has passed. Review the text before clicking, not after.
exports.outreachCreateDraft = onCall(
  { secrets: [gmailOAuthClientId, gmailOAuthClientSecret, gmailRefreshToken, gmailRefreshToken2, gmailRefreshToken3, gmailRefreshToken4] },
  async (request) => {
    await requireAdmin(request);

    const to = (request.data?.to || "").trim();
    const subject = (request.data?.subject || "").trim();
    const body = (request.data?.body || "").trim();
    const candidateId = (request.data?.candidateId || "").trim(); // set when this lead came from a town search
    const sender = OUTREACH_AGENTS[request.data?.sender] ? request.data.sender : "primary"; // which Gmail account drafts this
    if (!to || !subject || !body) throw new HttpsError("invalid-argument", "to, subject, and body are all required.");
    // Real validation instead of letting a malformed address (e.g. a typo
    // missing ".com", or a leftover "test"/placeholder value from manual
    // editing) reach Gmail's API and come back as a confusing raw
    // "Invalid To header" error with no indication of which field or why.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpsError("invalid-argument", `"${to}" doesn't look like a valid email address — check for typos (like a missing .com) and try again.`);
    }

    // Hard legal block — CAN-SPAM requires an opt-out request actually be
    // honored, permanently, with no exceptions. outreachSentLog does NOT do
    // that (it was deliberately changed so a contacted address can be
    // reused without limit — see outreachListLeads' comment on that), so
    // this is a genuinely separate collection, checked at the actual
    // moment of sending, that nothing else in this system can route around.
    const unsubSnap = await db.collection("outreachUnsubscribed").doc(to.toLowerCase()).get();
    if (unsubSnap.exists) {
      throw new HttpsError("failed-precondition", `${to} opted out and can never be emailed again — this system will not draft to that address.`);
    }

    const oAuth2Client = new OAuth2Client(gmailOAuthClientId.value(), gmailOAuthClientSecret.value());
    oAuth2Client.setCredentials({ refresh_token: OUTREACH_AGENTS[sender].secret.value() });
    const { token: accessToken } = await oAuth2Client.getAccessToken();

    const headers = [
      `From: Titan Business Pros <${OUTREACH_AGENTS[sender].fromAddress}>`,
      `To: ${to}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      "Content-Type: text/plain; charset=UTF-8",
    ].join("\r\n");
    const raw = Buffer.from(`${headers}\r\n\r\n${body}${OUTREACH_COMPLIANCE_FOOTER}`).toString("base64url");

    const gmailRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!gmailRes.ok) {
      const errBody = await gmailRes.text().catch(() => "");
      throw new HttpsError("internal", `Gmail API error (${gmailRes.status}): ${errBody}`);
    }
    const draftData = await gmailRes.json();

    // Auto-approve: apply the label right now, server-side, instead of
    // making the human do it by hand in Gmail afterward.
    const labelId = await ensureApprovedLabelId(accessToken);
    const messageId = draftData.message?.id;
    if (messageId) {
      const modifyRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ addLabelIds: [labelId] }),
      });
      if (!modifyRes.ok) {
        // Draft exists, just isn't auto-labeled — not worth failing the
        // whole call over, but worth surfacing so it doesn't silently
        // never send. Caller can still label it by hand as a fallback.
        console.error(`outreachCreateDraft: draft created but auto-label failed (${modifyRes.status}): ${await modifyRes.text().catch(() => "")}`);
      }
    }

    await db.collection("outreachSentLog").doc(to.toLowerCase()).set({ draftedAt: Timestamp.now(), subject });
    if (candidateId) {
      await db.collection("outreachCandidates").doc(candidateId).set({ status: "drafted" }, { merge: true }).catch(() => {});
    }

    return { ok: true };
  }
);

// Shared by the two reply-page functions below — same OAuth2Client
// pattern outreachCreateDraft already uses, factored out since both new
// functions need it, unlike outreachCreateDraft which only needed it once.
async function gmailAccessTokenFor(sender) {
  const oAuth2Client = new OAuth2Client(gmailOAuthClientId.value(), gmailOAuthClientSecret.value());
  oAuth2Client.setCredentials({ refresh_token: OUTREACH_AGENTS[sender].secret.value() });
  const { token } = await oAuth2Client.getAccessToken();
  return token;
}

// ---------------------------------------------------------------------
// Reply page (separate from the main admin page — see replies.html).
// Lists every sent thread that has gotten a reply, across BOTH agents,
// so a lead who writes back can actually be seen and answered instead of
// sitting unnoticed in Gmail. Reuses the exact same OAuth credentials
// already set up for drafting — gmail.compose (already granted) covers
// sending a reply too, no new authorization needed from the user.
// ---------------------------------------------------------------------
exports.outreachListReplies = onCall(
  { secrets: [gmailOAuthClientId, gmailOAuthClientSecret, gmailRefreshToken, gmailRefreshToken2, gmailRefreshToken3, gmailRefreshToken4] },
  async (request) => {
    await requireAdmin(request);

    // Real sends we've actually confirmed — the SAME data source the
    // webpage's own "Confirmed sent" status already relies on, and already
    // proven reliable (unlike Gmail's own "Outreach/Sent" label, which
    // turned out not to reliably land on the sent message). Keeps the
    // SUBJECT too, not just the recipient — see below for why that matters.
    // Filtering status in JS instead of a second .where() avoids needing a
    // composite index (status== + orderBy on a different field needs one;
    // a single orderBy alone doesn't) — outreachSentEvents is small enough
    // that this costs nothing meaningful.
    const eventsSnap = await db.collection("outreachSentEvents").orderBy("sentAt", "desc").limit(300).get();
    const seen = new Set();
    const sends = []; // [{agent, to, subject}]
    eventsSnap.docs.forEach((d) => {
      const data = d.data();
      if (data.status !== "sent" || !data.subject) return;
      const key = `${data.agent}|${data.to}|${data.subject}`;
      if (seen.has(key)) return;
      seen.add(key);
      sends.push({ agent: data.agent, to: data.to, subject: data.subject });
    });
    const threads = [];
    const seenThreadIds = new Set();
    const tokenCache = {};
    for (const { agent: agentId, to, subject } of sends) {
      if (!OUTREACH_AGENTS[agentId]) continue;
      if (!tokenCache[agentId]) {
        try {
          tokenCache[agentId] = await gmailAccessTokenFor(agentId);
        } catch (err) {
          console.error(`outreachListReplies: couldn't get a token for ${agentId}:`, err);
          tokenCache[agentId] = null;
        }
      }
      const accessToken = tokenCache[agentId];
      if (!accessToken) continue;

      // Scoped to the SPECIFIC outreach email actually sent (recipient AND
      // exact subject together) — not just "any thread ever involving this
      // address." A bare to:/from: search matched completely unrelated old
      // personal threads that happened to include the same address (e.g. a
      // years-old "All hands meeting" thread), making it look like nearly
      // everyone had "replied" when almost none of them actually had.
      const q = `to:${to} subject:"${subject.replace(/"/g, "")}"`;
      const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(q)}&maxResults=3`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();

      for (const t of searchData.threads || []) {
        if (seenThreadIds.has(t.id)) continue;
        const threadRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!threadRes.ok) continue;
        const messages = (await threadRes.json()).messages || [];
        if (messages.length < 2) continue; // just our original send, no reply yet
        seenThreadIds.add(t.id);

        const last = messages[messages.length - 1];
        const headers = last.payload?.headers || [];
        const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
        const fromAddr = getHeader("From");
        // Whichever message's From ISN'T this agent's own disguise address
        // is the lead's own address — works whether the very last message
        // is their reply (the common case) or our own follow-up. Checked
        // against THIS agent's fromAddress specifically, not a single
        // shared constant, since different agents can use different
        // disguise addresses.
        const isLastFromUs = fromAddr.toLowerCase().includes(OUTREACH_AGENTS[agentId].fromAddress.toLowerCase());
        threads.push({
          agent: agentId,
          threadId: t.id,
          subject: getHeader("Subject"),
          otherParty: isLastFromUs ? getHeader("To") : fromAddr,
          snippet: last.snippet || "",
          lastMessageAt: last.internalDate ? Number(last.internalDate) : 0,
          unread: (last.labelIds || []).includes("UNREAD"),
          messageCount: messages.length,
          awaitingReply: !isLastFromUs, // last message came FROM the lead — needs an answer
        });
      }
    }

    // Exclude threads the admin has explicitly dismissed from this view —
    // see outreachDismissReplyThreads. Dismissing doesn't touch Gmail at
    // all, it's purely "stop showing me this one here" — BUT only until
    // something new happens in that thread. A resend to the same address
    // with the same subject lands in this exact same Gmail thread (Gmail
    // groups by subject+participants), so treating a dismiss as permanent
    // meant a genuinely new reply arriving later in a previously-dismissed
    // thread stayed invisible forever (found via real diagnostic logging
    // 2026-08-21: 12 threads had actual replies, 9 of them were hidden this
    // way). Comparing the thread's own last-message time against when it
    // was dismissed lets a fresh reply un-hide it automatically.
    const dismissedSnap = await db.collection("outreachDismissedReplyThreads").get();
    const dismissedAtByThreadId = new Map(
      dismissedSnap.docs.map((d) => [d.id, d.data().dismissedAt?.toMillis?.() ?? 0])
    );
    const visible = threads.filter((th) => {
      const dismissedAt = dismissedAtByThreadId.get(th.threadId);
      const include = dismissedAt === undefined || th.lastMessageAt > dismissedAt;
      // TEMPORARY diagnostic logging (2026-08-21, round 2) — need to see the
      // actual numbers behind each include/exclude decision now that the
      // previous fix alone didn't resolve it. Remove once confirmed working.
      console.log(
        `outreachListReplies DIAG2: thread ${th.threadId} (${th.otherParty}) lastMessageAt=${th.lastMessageAt} dismissedAt=${dismissedAt ?? "n/a"} -> ${include ? "VISIBLE" : "hidden"}`
      );
      return include;
    });
    console.log(`outreachListReplies DIAG2: ${threads.length} threads found, ${visible.length} visible after dismiss filter`);

    visible.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return { threads: visible };
  }
);

// Sends a real reply within an existing thread — proper In-Reply-To/
// References headers so Gmail (and the lead's own inbox) thread it
// correctly instead of it showing up as a disconnected new email.

// "Delete" on the Replies page — doesn't touch Gmail or the actual
// conversation at all, just stops that thread from showing up in THIS
// list again (e.g. a false-positive match, or one you've fully wrapped
// up and don't need to keep seeing). Reversible in principle by deleting
// the doc directly, though there's no undo button for it in the UI.
exports.outreachDismissReplyThreads = onCall(async (request) => {
  await requireAdmin(request);
  const threadIds = Array.isArray(request.data?.threadIds) ? request.data.threadIds.filter((id) => typeof id === "string" && id) : [];
  if (threadIds.length === 0) throw new HttpsError("invalid-argument", "threadIds (non-empty array) is required.");
  const batch = db.batch();
  threadIds.forEach((id) => batch.set(db.collection("outreachDismissedReplyThreads").doc(id), { dismissedAt: Timestamp.now() }));
  await batch.commit();
  return { ok: true, dismissed: threadIds.length };
});

// The actual legal opt-out enforcement point — genuinely separate from
// outreachSkipLead/outreachSentLog (see outreachCreateDraft's comment on
// why that mechanism doesn't satisfy this). Once an email is in here,
// outreachCreateDraft and outreachSendReply both refuse to send to it,
// permanently, no matter what path re-adds it as a candidate/lead.
exports.outreachMarkUnsubscribed = onCall(async (request) => {
  await requireAdmin(request);
  const email = (request.data?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new HttpsError("invalid-argument", "A valid email is required.");
  await db.collection("outreachUnsubscribed").doc(email).set({
    unsubscribedAt: Timestamp.now(),
    reason: (request.data?.reason || "").trim() || "opted out",
  });
  return { ok: true };
});

exports.outreachSendReply = onCall(
  { secrets: [gmailOAuthClientId, gmailOAuthClientSecret, gmailRefreshToken, gmailRefreshToken2, gmailRefreshToken3, gmailRefreshToken4] },
  async (request) => {
    await requireAdmin(request);

    const agent = OUTREACH_AGENTS[request.data?.agent] ? request.data.agent : null;
    const threadId = (request.data?.threadId || "").trim();
    const body = (request.data?.body || "").trim();
    if (!agent || !threadId || !body) throw new HttpsError("invalid-argument", "agent, threadId, and body are all required.");

    const accessToken = await gmailAccessTokenFor(agent);

    const threadRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=References`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!threadRes.ok) throw new HttpsError("internal", `Couldn't load that thread (${threadRes.status}): ${await threadRes.text().catch(() => "")}`);
    const messages = (await threadRes.json()).messages || [];
    if (messages.length === 0) throw new HttpsError("not-found", "That thread has no messages.");

    const last = messages[messages.length - 1];
    const headers = last.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
    const lastFrom = getHeader("From");
    const lastMessageId = getHeader("Message-ID");
    const lastReferences = getHeader("References");
    const isLastFromUs = lastFrom.toLowerCase().includes(OUTREACH_AGENTS[agent].fromAddress.toLowerCase());
    // Reply goes to whoever sent the last message — unless that was us,
    // in which case reply to whoever WE last sent it to instead.
    const replyTo = isLastFromUs ? getHeader("To") : lastFrom;
    let subject = getHeader("Subject") || "";
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;

    // Same hard legal block as outreachCreateDraft — see its comment for
    // why this can't just reuse outreachSentLog.
    const replyToEmailMatch = replyTo.match(/<([^<>]+)>/);
    const replyToEmail = (replyToEmailMatch ? replyToEmailMatch[1] : replyTo).trim().toLowerCase();
    const unsubSnap = await db.collection("outreachUnsubscribed").doc(replyToEmail).get();
    if (unsubSnap.exists) {
      throw new HttpsError("failed-precondition", `${replyToEmail} opted out and can never be emailed again — this system will not reply to that address.`);
    }

    const references = [lastReferences, lastMessageId].filter(Boolean).join(" ");
    const headerLines = [`From: Titan Business Pros <${OUTREACH_AGENTS[agent].fromAddress}>`, `To: ${replyTo}`, `Subject: ${encodeMimeHeader(subject)}`];
    if (lastMessageId) headerLines.push(`In-Reply-To: ${lastMessageId}`);
    if (references) headerLines.push(`References: ${references}`);
    headerLines.push("Content-Type: text/plain; charset=UTF-8");
    const raw = Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n${body}${OUTREACH_COMPLIANCE_FOOTER}`).toString("base64url");

    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw, threadId }),
    });
    if (!sendRes.ok) throw new HttpsError("internal", `Gmail API error sending reply (${sendRes.status}): ${await sendRes.text().catch(() => "")}`);

    // Best-effort — a reply having been sent matters more than this
    // succeeding, so it isn't allowed to fail the whole call.
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }).catch(() => {});

    return { ok: true };
  }
);

// Emails an exported file (any of the 6 formats the admin page's
// importer/exporter both support) as a real attachment — the file itself
// is generated client-side (same code the importer already has, just run
// in reverse), this just attaches whatever bytes it's given and sends.
// Always sent from the primary account, same From identity as every
// other outreach email — this isn't tied to a specific campaign/lead.
exports.outreachEmailExport = onCall(
  { secrets: [gmailOAuthClientId, gmailOAuthClientSecret, gmailRefreshToken, gmailRefreshToken2] },
  async (request) => {
    await requireAdmin(request);

    const to = (request.data?.to || "").trim();
    const filename = (request.data?.filename || "export.csv").trim();
    const mimeType = (request.data?.mimeType || "application/octet-stream").trim();
    const contentBase64 = (request.data?.contentBase64 || "").trim();
    const count = Number(request.data?.count) || 0;
    if (!to || !contentBase64) throw new HttpsError("invalid-argument", "to and contentBase64 are both required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpsError("invalid-argument", `"${to}" doesn't look like a valid email address — check for typos and try again.`);
    }
    // Base64 runs ~4/3 the size of the real file; Gmail's actual limit is
    // 25MB per message including all attachments — capping around 20MB
    // of real file content leaves headroom for headers/encoding overhead.
    if (contentBase64.length > 27_000_000) {
      throw new HttpsError("invalid-argument", "That file is too large to email (Gmail's 25MB limit) — export fewer businesses at once.");
    }

    const accessToken = await gmailAccessTokenFor("primary");
    const boundary = `outreach_export_${Date.now()}`;
    const subject = `Town Fuss — ${count} business(es) exported`;
    const bodyText = `Attached: ${filename} (${count} business${count === 1 ? "" : "es"}).\n\nSent from the Town Fuss outreach admin page.`;
    // Wrapped at 76 chars/line per RFC 2045 — Gmail's own API usually
    // tolerates unwrapped base64, but some other mail clients are strict.
    const wrappedBase64 = contentBase64.match(/.{1,76}/g)?.join("\r\n") || contentBase64;

    const raw = [
      `From: Titan Business Pros <${OUTREACH_AGENTS.primary.fromAddress}>`,
      `To: ${to}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      bodyText,
      "",
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrappedBase64,
      "",
      `--${boundary}--`,
    ].join("\r\n");

    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
    });
    if (!sendRes.ok) throw new HttpsError("internal", `Gmail API error sending export (${sendRes.status}): ${await sendRes.text().catch(() => "")}`);

    return { ok: true };
  }
);

// ---------------------------------------------------------------------
// Outreach settings — TWO separate concerns sharing one doc:
//   1. campaignNotes: one global "what are we selling" note (Claude reads
//      this before writing each batch of copy, regardless of which agent
//      it's for — the pitch doesn't change per sending account).
//   2. agents.{agentId}: per-agent pause + daily start time, one entry per
//      OUTREACH_AGENTS key. Each agent's own Apps Script polls its own
//      entry via outreachAgentStatus?agent=X.
//
// A SEPARATE doc (outreachSettings/lock) enforces that only ONE agent's
// send-chain is ever actively running at a time, even though each agent
// has its own independent start time — see outreachAcquireLock/
// outreachReleaseLock. Without this, two agents whose start times happen
// to land close together could both be mid-chain simultaneously, both
// sending as the same info@titanbusinesspros.com identity at once, which
// is exactly the "looks coordinated/automated" pattern worth avoiding.
// ---------------------------------------------------------------------
const OUTREACH_SETTINGS_DOC = () => db.collection("outreachSettings").doc("config");
const OUTREACH_LOCK_DOC = () => db.collection("outreachSettings").doc("lock");

const OUTREACH_DEFAULT_START_TIME = "09:00"; // 24hr, Central — matches the Apps Script's configured timezone
const START_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

exports.outreachGetSettings = onCall(async (request) => {
  await requireAdmin(request);
  const snap = await OUTREACH_SETTINGS_DOC().get();
  const data = snap.exists ? snap.data() : {};
  const agentsData = data.agents || {};
  const agents = Object.entries(OUTREACH_AGENTS).map(([id, def]) => ({
    id,
    label: def.label,
    fromAddress: def.fromAddress,
    paused: !!agentsData[id]?.paused,
    startTime: agentsData[id]?.startTime || OUTREACH_DEFAULT_START_TIME,
  }));
  return { campaignNotes: data.campaignNotes || "", agents };
});

// Computes "today at HH:MM" in Central time, correctly, from a Cloud
// Function that itself runs in UTC — used so the webpage shows a
// countdown INSTANTLY the moment you set a start time, instead of
// waiting up to 15 minutes for Apps Script's own next tick to notice and
// report it. Works by reading Central's current wall-clock date/time via
// Intl, diffing that (parsed as if it were UTC) against the real UTC now
// to get today's actual UTC offset, then applying that same offset to
// the target wall-clock time. Handles CST/CDT automatically since it
// uses TODAY's real offset, not a hardcoded one.
function centralTodayAt(hour, minute) {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const centralWallAsUtc = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  const offsetMs = centralWallAsUtc.getTime() - now.getTime();
  const targetWallAsUtc = new Date(`${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  return new Date(targetWallAsUtc.getTime() - offsetMs);
}

exports.outreachSetSettings = onCall(async (request) => {
  await requireAdmin(request);
  const update = {};
  // clientTs is a strictly-increasing sequence number the page assigns
  // each save AT THE MOMENT IT ACTUALLY FIRES (after debounce), so it
  // reflects the real order the admin finished each round of typing —
  // NOT the order requests happen to arrive at the server. debounce()
  // only cancels a pending timer, not an already-in-flight request, so a
  // slow earlier save (cold start, etc.) can otherwise land AFTER a
  // later, more-complete one and silently overwrite it. The transaction
  // below drops this write if something newer already landed, guaranteeing
  // the stored value always ends up being the most-recently-typed one
  // regardless of network timing (2026-08-22 — this is the second, real
  // cause behind "reverts to old text," distinct from the load-race
  // outreachGetSettings/loadSettings already had fixed).
  const campaignNotesClientTs = Number(request.data?.campaignNotesClientTs) || 0;
  if (typeof request.data?.campaignNotes === "string") update.campaignNotes = request.data.campaignNotes.slice(0, 4000);

  const agentId = request.data?.agent;
  if (agentId !== undefined) {
    if (!OUTREACH_AGENTS[agentId]) throw new HttpsError("invalid-argument", `Unknown agent "${agentId}".`);
    const agentUpdate = {};
    let existingAgentData = null; // fetched lazily, at most once, below
    async function getExisting() {
      if (existingAgentData === null) {
        const snap = await OUTREACH_SETTINGS_DOC().get();
        existingAgentData = snap.data()?.agents?.[agentId] || {};
      }
      return existingAgentData;
    }

    if (typeof request.data?.paused === "boolean") {
      agentUpdate.paused = request.data.paused;
      // Pausing mid-countdown shouldn't leave a stale timer on the page —
      // clear it. sendNextApprovedDraft's own paused-mid-chain check
      // still stops any actual in-progress chain; this just keeps the
      // displayed countdown honest in the meantime.
      if (request.data.paused) agentUpdate.nextSendAt = null;
    }
    if (typeof request.data?.startTime === "string") {
      if (!START_TIME_PATTERN.test(request.data.startTime)) {
        throw new HttpsError("invalid-argument", "startTime must be 24-hour HH:MM, e.g. 09:00 or 14:30.");
      }
      agentUpdate.startTime = request.data.startTime;
    }

    // Instant countdown feedback, computed fresh any time this call could
    // plausibly change whether a countdown should be showing — either the
    // start time changed, or paused just flipped to false. Covers a real
    // gap: setting the start time WHILE paused (a common order — e.g.
    // right after using the pause button as a safety default) used to
    // never get a countdown at all, even after unpausing moments later,
    // because the countdown was only ever computed at the instant
    // startTime was submitted, checking paused status only at that exact
    // moment — not retroactively when unpausing later reused the
    // already-saved start time.
    const willBePaused = agentUpdate.paused !== undefined ? agentUpdate.paused : !!(await getExisting()).paused;
    if (!willBePaused && (agentUpdate.startTime || (await getExisting()).startTime)) {
      const effectiveStartTime = agentUpdate.startTime || (await getExisting()).startTime;
      const [h, m] = effectiveStartTime.split(":").map(Number);
      agentUpdate.nextSendAt = Timestamp.fromDate(centralTodayAt(h, m));
    }
    if (Object.keys(agentUpdate).length === 0) throw new HttpsError("invalid-argument", "Nothing to update for that agent.");
    // Nested-map merge: {agents: {primary: {paused: true}}} with
    // merge:true only touches agents.primary.paused — Firestore's set()
    // merges nested maps recursively, unlike update(), so this can't
    // accidentally clobber agents.secondary or agents.primary.startTime.
    update.agents = { [agentId]: agentUpdate };
  }

  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");

  await db.runTransaction(async (txn) => {
    if (typeof update.campaignNotes === "string") {
      const snap = await txn.get(OUTREACH_SETTINGS_DOC());
      const storedTs = snap.data()?.campaignNotesClientTs || 0;
      if (campaignNotesClientTs < storedTs) {
        // A newer save already landed — drop this stale write entirely
        // rather than let it clobber it, but still apply any other
        // (agent) changes in the same call.
        delete update.campaignNotes;
      } else {
        update.campaignNotesClientTs = campaignNotesClientTs;
      }
    }
    if (Object.keys(update).length > 0) txn.set(OUTREACH_SETTINGS_DOC(), update, { merge: true });
  });
  return { ok: true };
});

// Plain HTTPS endpoints (no Firebase Auth) — each agent's Apps Script
// calls these as server-to-server requests, not from a browser, so
// there's no Firebase ID token to attach and no admin gate. Deliberately
// exposes/mutates nothing sensitive: a pause flag, a start time, and a
// "who's currently sending" lock — no PII, same trust level as the
// original single-agent outreachStatus this replaces.
exports.outreachAgentStatus = onRequest(async (req, res) => {
  const agentId = OUTREACH_AGENTS[req.query.agent] ? req.query.agent : null;
  if (!agentId) {
    res.status(400).json({ error: `Unknown or missing agent. Known agents: ${Object.keys(OUTREACH_AGENTS).join(", ")}` });
    return;
  }
  const snap = await OUTREACH_SETTINGS_DOC().get();
  const agentData = (snap.exists ? snap.data().agents : null)?.[agentId] || {};
  res.set("Cache-Control", "no-store");
  res.json({ paused: !!agentData.paused, startTime: agentData.startTime || OUTREACH_DEFAULT_START_TIME });
});

// Called once by an agent's Apps Script right before it wants to start
// today's send-chain. Atomic (Firestore transaction) so two agents
// starting within the same watcher tick can't both think they got it.
// A lock older than OUTREACH_LOCK_STALE_MS is treated as abandoned (e.g.
// an Apps Script execution that errored out before releasing) and can be
// claimed by anyone — self-healing rather than requiring manual cleanup.
exports.outreachAcquireLock = onRequest(async (req, res) => {
  const agentId = OUTREACH_AGENTS[req.query.agent] ? req.query.agent : null;
  if (!agentId) {
    res.status(400).json({ error: `Unknown or missing agent. Known agents: ${Object.keys(OUTREACH_AGENTS).join(", ")}` });
    return;
  }
  res.set("Cache-Control", "no-store");
  try {
    const acquired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(OUTREACH_LOCK_DOC());
      const data = snap.exists ? snap.data() : {};
      const heldBy = data.heldBy || null;
      const lockedAtMs = data.lockedAt?.toMillis ? data.lockedAt.toMillis() : 0;
      const isStale = heldBy && Date.now() - lockedAtMs > OUTREACH_LOCK_STALE_MS;
      if (heldBy && heldBy !== agentId && !isStale) return false; // someone else genuinely holds it
      tx.set(OUTREACH_LOCK_DOC(), { heldBy: agentId, lockedAt: Timestamp.now() });
      return true;
    });
    const lockSnap = acquired ? null : await OUTREACH_LOCK_DOC().get();
    res.json({ acquired, heldBy: acquired ? agentId : lockSnap?.data()?.heldBy || null });
  } catch (err) {
    console.error("outreachAcquireLock failed:", err);
    res.status(500).json({ acquired: false, error: err.message });
  }
});

// Called when an agent's send-chain has nothing left to send (or stops
// early, e.g. pause flipped on mid-chain). Only releases if THIS agent is
// actually the current holder, so a late/duplicate release call from one
// agent can't accidentally free a lock a different agent has since
// legitimately acquired.
exports.outreachReleaseLock = onRequest(async (req, res) => {
  const agentId = OUTREACH_AGENTS[req.query.agent] ? req.query.agent : null;
  if (!agentId) {
    res.status(400).json({ error: `Unknown or missing agent. Known agents: ${Object.keys(OUTREACH_AGENTS).join(", ")}` });
    return;
  }
  res.set("Cache-Control", "no-store");
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(OUTREACH_LOCK_DOC());
      if (snap.exists && snap.data().heldBy === agentId) {
        tx.set(OUTREACH_LOCK_DOC(), { heldBy: null, lockedAt: Timestamp.now() });
      }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("outreachReleaseLock failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Called by an agent's Apps Script right after it schedules its next
// timed trigger (or to clear the countdown once a chain stops). Lets the
// admin webpage show a real, accurate "next send in MM:SS" — computed
// from an actual scheduled timestamp Apps Script reports, not a guess —
// via a live Firestore listener (see outreachSettings/{doc} read rule).
exports.outreachReportNextSend = onRequest(async (req, res) => {
  const agentId = OUTREACH_AGENTS[req.query.agent] ? req.query.agent : null;
  if (!agentId) {
    res.status(400).json({ error: `Unknown or missing agent. Known agents: ${Object.keys(OUTREACH_AGENTS).join(", ")}` });
    return;
  }
  res.set("Cache-Control", "no-store");
  try {
    // nextAt is either an ISO timestamp string (a send is scheduled) or
    // absent/null (chain stopped — clears any stale countdown on the page).
    const nextAtIso = req.query.nextAt || null;
    const nextSendAt = nextAtIso ? Timestamp.fromDate(new Date(nextAtIso)) : null;
    await OUTREACH_SETTINGS_DOC().set({ agents: { [agentId]: { nextSendAt } } }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("outreachReportNextSend failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Called by an agent's Apps Script every time it starts a chain (or
// continues one), reporting an ESTIMATED send time for every pending
// approved draft, not just the next one — this is what lets the webpage
// show a countdown on each individual drafted lead, matched by email, not
// just one overall "next send" timer for the agent. POST with a JSON
// body (not query params — up to 10 to/subject/estimatedAt tuples would
// be unwieldy and easy to hit URL length limits as a query string).
// Estimates only (nominal spacing, no jitter) — real jitter is only
// rolled at the moment each one actually sends, see sendNextApprovedDraft
// in SendScheduler.gs.
exports.outreachReportSchedule = onRequest(async (req, res) => {
  const agentId = OUTREACH_AGENTS[req.query.agent] ? req.query.agent : null;
  if (!agentId) {
    res.status(400).json({ error: `Unknown or missing agent. Known agents: ${Object.keys(OUTREACH_AGENTS).join(", ")}` });
    return;
  }
  res.set("Cache-Control", "no-store");
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const schedule = items
      .filter((it) => it && typeof it.to === "string" && it.estimatedAt)
      .map((it) => ({
        to: it.to.toLowerCase(),
        subject: typeof it.subject === "string" ? it.subject : "",
        estimatedAt: Timestamp.fromDate(new Date(it.estimatedAt)),
      }));
    await OUTREACH_SETTINGS_DOC().set({ agents: { [agentId]: { schedule } } }, { merge: true });
    res.json({ ok: true, count: schedule.length });
  } catch (err) {
    console.error("outreachReportSchedule failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Called by an agent's Apps Script right after each real send attempt
// (success or failure) — the actual "did it really go out" confirmation
// the webpage's per-lead status shows, via a live Firestore listener
// matched on the recipient email. Separate from outreachSentLog (which
// only tracks "drafted," for dedup) and the per-agent Google Sheet (which
// is for the account owner to eyeball, not for the webpage to query).
exports.outreachRecordSent = onRequest(async (req, res) => {
  const agentId = OUTREACH_AGENTS[req.query.agent] ? req.query.agent : null;
  const to = (req.query.to || "").trim().toLowerCase();
  if (!agentId || !to) {
    res.status(400).json({ error: "agent and to are both required." });
    return;
  }
  res.set("Cache-Control", "no-store");
  try {
    await db.collection("outreachSentEvents").add({
      agent: agentId,
      to,
      subject: (req.query.subject || "").slice(0, 300),
      status: (req.query.status || "sent").slice(0, 300),
      sentAt: Timestamp.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("outreachRecordSent failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// Town-search lead generation (Google Places API "New") — every doc this
// writes to outreachCandidates starts life with status:"candidate" (raw,
// unreviewed). Checking a box on the page and clicking "Add to queue"
// flips it to status:"queued", which is what outreachListLeads (above)
// actually reads from. status:"drafted" is set by outreachCreateDraft
// once a real Gmail Draft exists for it. Nothing here ever guesses an
// email — see tryFindEmailOnWebsite: best-effort scrape of the business's
// own site only, left blank on any failure, per the explicit "if not
// found no need to guess, we'll confirm ourselves" instruction.
// ---------------------------------------------------------------------
const googlePlacesApiKey = defineSecret("GOOGLE_PLACES_API_KEY");
const OUTREACH_CANDIDATE_BATCH_SIZE = 100; // matches the largest option (20/50/100) the admin page offers

// Domains that show up constantly in scraped small-business HTML but are
// never the business's own contact address — site-builder boilerplate,
// tracking pixels, embedded widgets, template placeholder text. A bare
// regex email match with no blocklist was grabbing these and reporting
// them as the lead's email, which is where most of the "fake" emails
// were coming from (2026-08-21).
const JUNK_EMAIL_DOMAINS = [
  "wixpress.com", "wix.com", "squarespace.com", "godaddy.com", "weebly.com",
  "sentry.io", "sentry-next.wixpress.com", "cloudflare.com", "shopify.com",
  "google.com", "googleapis.com", "gstatic.com", "googletagmanager.com",
  "google-analytics.com", "facebook.com", "fbcdn.net", "mailchimp.com",
  "list-manage.com", "polyfill.io", "jquery.com", "w3.org", "schema.org",
  "example.com", "example.org", "example.net", "yourdomain.com", "yourwebsite.com",
];
// Local-parts that are almost always template/system addresses, not a
// real contact — checked regardless of which domain they're on.
const JUNK_EMAIL_LOCAL_PARTS = ["noreply", "no-reply", "donotreply", "do-not-reply", "webmaster", "postmaster", "test", "sample", "yourname", "youremail"];

function isLikelyJunkEmail(email) {
  const [localPart, domain] = email.toLowerCase().split("@");
  if (!domain) return true;
  if (JUNK_EMAIL_LOCAL_PARTS.includes(localPart)) return true;
  return JUNK_EMAIL_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`));
}

// A real browser identity instead of Node's default fetch user-agent.
// Several site-builder platforms and CDNs (Cloudflare especially) quietly
// block or serve a stripped-down page to non-browser user agents, which
// was silently costing hits before this existed — this alone raises the
// scraper's find-rate on sites that were reachable all along.
const SCRAPER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Tries the homepage first (the common case — no slower than before when
// it works), and only pays the cost of checking a couple of likely
// contact pages when the homepage doesn't turn up a usable address. Most
// small businesses that publish an email at all put it on the homepage
// or a dedicated Contact/About page — this covers all three cheaply
// instead of only ever looking at whichever URL Places happened to give.
async function fetchEmailFromOnePage(pageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(pageUrl, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": SCRAPER_USER_AGENT } });
    clearTimeout(timeout);
    if (!res.ok) return "";
    const html = await res.text();
    // Scans EVERY match on the page, not just the first — a page can have
    // a junk address (tracking pixel, template placeholder) appear before
    // the business's real one in raw HTML order. Only checking the first
    // match meant one junk hit near the top of the page threw away a
    // legitimate email sitting further down the same page (2026-08-21 bug
    // — this is why the junk filter made the scraper's fill-rate worse,
    // not just its accuracy better).
    for (const m of html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
      if (!isLikelyJunkEmail(m[1])) return m[1].toLowerCase();
    }
    for (const m of html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) {
      if (!isLikelyJunkEmail(m[0])) return m[0].toLowerCase();
    }
    return "";
  } catch {
    return ""; // timed out, blocked, broken site, whatever — leave blank, never guess
  }
}

async function tryFindEmailOnWebsite(url) {
  if (!url) return "";
  const homepageEmail = await fetchEmailFromOnePage(url);
  if (homepageEmail) return homepageEmail;

  for (const path of ["/contact", "/contact-us", "/about"]) {
    let pageUrl;
    try {
      pageUrl = new URL(path, url).toString();
    } catch {
      continue; // malformed website URL from Places — skip the extra pages
    }
    const email = await fetchEmailFromOnePage(pageUrl);
    if (email) return email;
  }
  return "";
}

// Google's own official Places API business-type codes (a curated subset
// relevant to small-town local businesses, out of the ~150 Google
// publishes) — used as an exact includedType filter instead of guessing
// at English phrases. See
// https://developers.google.com/maps/documentation/places/web-service/place-types
const PLACE_TYPE_LABELS = {
  restaurant: "restaurants", fast_food_restaurant: "fast food restaurants", cafe: "cafes", bar: "bars",
  bakery: "bakeries", pizza_restaurant: "pizza restaurants", sandwich_shop: "sandwich shops",
  coffee_shop: "coffee shops", ice_cream_shop: "ice cream shops", hair_salon: "hair salons",
  barber_shop: "barber shops", beauty_salon: "beauty salons", nail_salon: "nail salons",
  car_repair: "auto repair shops", car_dealer: "car dealers", car_wash: "car washes", gas_station: "gas stations",
  church: "churches", hindu_temple: "Hindu temples", mosque: "mosques", synagogue: "synagogues",
  doctor: "doctors", dentist: "dentists", hospital: "hospitals", pharmacy: "pharmacies",
  veterinary_care: "veterinary clinics", lawyer: "lawyers", insurance_agency: "insurance agencies",
  real_estate_agency: "real estate agencies", bank: "banks", atm: "ATMs", electrician: "electricians",
  plumber: "plumbers", roofing_contractor: "roofing contractors", painter: "painters",
  moving_company: "moving companies", storage: "storage facilities", convenience_store: "convenience stores",
  supermarket: "supermarkets", clothing_store: "clothing stores", shoe_store: "shoe stores",
  jewelry_store: "jewelry stores", furniture_store: "furniture stores", hardware_store: "hardware stores",
  home_goods_store: "home goods stores", florist: "florists", gym: "gyms", spa: "spas", hotel: "hotels",
  motel: "motels", lodging: "lodging", funeral_home: "funeral homes", school: "schools", library: "libraries",
  movie_theater: "movie theaters", park: "parks", general_contractor: "general contractors",
};
// Google's own official Places API business-type codes (a curated subset
// relevant to small-town local businesses, out of the ~150 Google
// publishes) — used as an exact includedType filter instead of guessing
// at English phrases. See
// https://developers.google.com/maps/documentation/places/web-service/place-types
const KNOWN_PLACE_TYPES = new Set(Object.keys(PLACE_TYPE_LABELS));

exports.outreachGenerateLeads = onCall({ secrets: [googlePlacesApiKey], timeoutSeconds: 300 }, async (request) => {
  await requireAdmin(request);

  const town = (request.data?.town || "").trim();
  if (!town) throw new HttpsError("invalid-argument", "A town/city is required.");
  const count = Math.min(Math.max(parseInt(request.data?.count, 10) || OUTREACH_CANDIDATE_BATCH_SIZE, 1), OUTREACH_CANDIDATE_BATCH_SIZE);
  // Optional — restricts the search to just this one category/phrase
  // (e.g. "restaurants") instead of sweeping every category below. The
  // town field is location-only; this is the only way to actually narrow
  // to one kind of business, since typing a category into the town field
  // would just get every category phrase prepended to it too.
  const singleCategory = (request.data?.category || "").trim();
  // Optional — Google's own official Places business-type code (from the
  // portal's dropdown), e.g. "fast_food_restaurant". Filters by Google's
  // actual categorization metadata (includedType) instead of hoping a
  // plain-English phrase ranks the way we want in a text search — this is
  // what actually fixes "restaurants" not reliably surfacing fast-food
  // chains, rather than just wording around it. Validated against a known
  // list so a tampered/garbage value can't reach the Places API as-is.
  const rawPlaceType = (request.data?.placeType || "").trim();
  const placeType = KNOWN_PLACE_TYPES.has(rawPlaceType) ? rawPlaceType : "";

  // Dedup against every business ever found before (any status), keyed by
  // website when available (most reliable), else phone — so re-running a
  // search for the same town, or hitting "generate 60 more," doesn't keep
  // re-adding the same businesses.
  const existingSnap = await db.collection("outreachCandidates").get();
  const seenWebsites = new Set();
  const seenPhones = new Set();
  existingSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.website) seenWebsites.add(data.website);
    if (data.phone) seenPhones.add(data.phone);
  });

  const apiKey = googlePlacesApiKey.value();
  const fieldMask = "places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.nationalPhoneNumber,places.websiteUri,nextPageToken";
  const found = [];
  let pages = 0;

  // A single generic "businesses in X" query is relevance-ranked and
  // capped at ~60 total results by Places API, no matter how many real
  // businesses actually exist — it's a search, not an exhaustive
  // directory. Worse, once earlier searches have already deduped out
  // whatever that generic query tends to surface, re-running it returns
  // fewer and fewer NEW businesses long before the town's real business
  // count is anywhere close to exhausted (2026-08-21: this is why Pauls
  // Valley "ran out" while 50+ known real businesses were never found).
  // Running several category-specific queries instead surfaces a mostly
  // DIFFERENT set of businesses per category — each gets its own ~60-result
  // budget — so total real coverage is far higher than one query can reach.
  // Each entry: { textQuery, includedType? }. includedType filters by
  // Google's own categorization metadata directly — far more reliable
  // than hoping a plain-English phrase ranks the way we want (this is
  // what actually fixes "restaurants" not surfacing fast-food chains like
  // Sonic/Arby's/Braum's/Subway/Domino's, confirmed missing from every
  // phrase-based search tonight — 2026-08-21).
  let SEARCH_CATEGORIES;
  if (placeType) {
    // Dropdown pick — still needs a real natural-language phrase for
    // Places to understand this as "search near/in this town," not just
    // the bare town name (a bare town name reads as "find a place named
    // this town," filtered to the type, which finds nothing — this is
    // exactly why the fast-food-type search returned 0 results before
    // this fix, 2026-08-21). includedType is layered on top as an exact
    // filter, so this gets the reliability of the official type code
    // WITH the location/intent understanding a plain phrase provides.
    SEARCH_CATEGORIES = [{ textQuery: `${PLACE_TYPE_LABELS[placeType]} in ${town}`, includedType: placeType }];
  } else if (singleCategory) {
    // Free-text fallback for anything not in the dropdown — old
    // phrase-based behavior, unchanged.
    SEARCH_CATEGORIES = [{ textQuery: `${singleCategory} in ${town}` }];
  } else {
    // Full sweep — includedType added wherever a specific Google type is
    // confidently known; left off for the broader/vaguer categories,
    // which still work as plain phrase searches like before.
    SEARCH_CATEGORIES = [
      { phrase: "restaurants", includedType: "restaurant" },
      { phrase: "fast food restaurants", includedType: "fast_food_restaurant" },
      { phrase: "retail stores" },
      { phrase: "hair salons and barbershops" },
      { phrase: "auto repair shops", includedType: "car_repair" },
      { phrase: "churches", includedType: "church" },
      { phrase: "medical and dental offices" },
      { phrase: "law firms", includedType: "lawyer" },
      { phrase: "insurance agencies", includedType: "insurance_agency" },
      { phrase: "real estate agencies", includedType: "real_estate_agency" },
      { phrase: "contractors and construction companies", includedType: "general_contractor" },
      { phrase: "gas stations and convenience stores" },
      { phrase: "banks and credit unions", includedType: "bank" },
      { phrase: "daycare and childcare centers" },
      { phrase: "veterinary clinics", includedType: "veterinary_care" },
      { phrase: "gyms and fitness centers", includedType: "gym" },
      { phrase: "hotels and motels" },
      { phrase: "funeral homes", includedType: "funeral_home" },
      { phrase: "pharmacies", includedType: "pharmacy" },
      { phrase: "hardware stores", includedType: "hardware_store" },
      { phrase: "other businesses" }, // generic catch-all last, to sweep up anything the specific categories missed
    ].map((c) => ({ textQuery: `${c.phrase} in ${town}`, includedType: c.includedType }));
  }
  // When sweeping every category, 2 pages (40 results) each keeps total
  // cost/runtime bounded across ~20 categories. When searching just one
  // category on purpose, that cap would wrongly limit you to 40 even if
  // you asked for 100 — so it scales up to the actual requested count instead.
  const maxPagesPerCategory = singleCategory || placeType ? Math.ceil(count / 20) : 2;

  for (const { textQuery, includedType } of SEARCH_CATEGORIES) {
    if (found.length >= count) break;
    let pageToken = null;
    let categoryPages = 0;

    try {
      while (found.length < count && categoryPages < maxPagesPerCategory) {
        const reqBody = {
          textQuery,
          ...(includedType ? { includedType } : {}),
          ...(pageToken ? { pageToken } : { pageSize: 20 }),
        };
        const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fieldMask },
          body: JSON.stringify(reqBody),
        });
        if (!placesRes.ok) {
          // One bad category (or a transient API hiccup) shouldn't abort
          // an entire multi-category sweep — log it and move on to the
          // next category instead.
          const errText = await placesRes.text().catch(() => "");
          console.error(`outreachGenerateLeads: Places API error for "${textQuery}"${includedType ? ` (includedType=${includedType})` : ""} (${placesRes.status}): ${errText}`);
          break;
        }
        const placesData = await placesRes.json();
        for (const place of placesData.places || []) {
          const phone = place.internationalPhoneNumber || place.nationalPhoneNumber || "";
          const website = place.websiteUri || "";
          if ((website && seenWebsites.has(website)) || (!website && phone && seenPhones.has(phone))) continue;
          found.push({
            companyName: place.displayName?.text || "",
            phone,
            website,
            address: place.formattedAddress || "",
          });
          if (website) seenWebsites.add(website);
          if (phone) seenPhones.add(phone);
          if (found.length >= count) break;
        }
        pageToken = placesData.nextPageToken || null;
        pages++;
        categoryPages++;
        if (!pageToken) break;
        // Places API pageTokens need a brief moment before they're valid —
        // same quirk the legacy Places API had; a short delay avoids an
        // INVALID_ARGUMENT on the very next request.
        if (pageToken) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (err) {
      console.error(`outreachGenerateLeads: category "${textQuery}" failed unexpectedly:`, err);
    }
  }

  // Real, self-tracked usage — not pulled from Google's own billing API,
  // which needs a BigQuery export set up first and has a real reporting
  // lag anyway. This is exact and immediate: `pages` is the literal
  // number of billable Places API requests this call just made (each
  // request/page = up to 20 results, billed the same regardless of how
  // many of those 20 were actually kept — see outreachGetCostSnapshot's
  // comments for the per-request price). Keyed by the current Central
  // calendar month — Maps Platform's $200 free credit resets monthly, so
  // a doc per month means next month automatically starts back at 0 with
  // no explicit reset logic needed, matching how the real credit works.
  if (pages > 0) {
    await db.collection("outreachUsage").doc(`placesApi_${centralYearMonth()}`).set(
      { requestCount: FieldValue.increment(pages), lastUsedAt: Timestamp.now() },
      { merge: true }
    );
  }

  // Best-effort email lookup, one site at a time — sequential, not
  // Promise.all, so a slow/hanging site can't blow up the whole batch's
  // total function runtime beyond what the 5s-per-site timeout already
  // bounds it to.
  const now = Timestamp.now();
  const batch = db.batch();
  for (const lead of found) {
    const email = await tryFindEmailOnWebsite(lead.website);
    const ref = db.collection("outreachCandidates").doc();
    batch.set(ref, { ...lead, email, town, status: "candidate", searchedAt: now });
  }
  await batch.commit();

  return { created: found.length, requested: count };
});

// Basic robots.txt check — fetches {origin}/robots.txt and looks for a
// Disallow rule under User-agent: * that would block the given path. Not
// a full RFC 9309 parser (no wildcard/$ support, no explicit Allow:
// override precedence) — good enough to catch the common, explicit "this
// whole site/section says no bots" case, which is exactly why this check
// exists: respect a site's stated policy instead of just checking
// whether scraping it is technically possible. Missing/unreadable
// robots.txt defaults to allowed, same as how real crawlers treat it.
async function isAllowedByRobotsTxt(targetUrl) {
  let origin, targetPath;
  try {
    const parsed = new URL(targetUrl);
    origin = parsed.origin;
    targetPath = parsed.pathname || "/";
  } catch {
    return true; // malformed URL — let the actual fetch fail with a clearer error instead
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${origin}/robots.txt`, { signal: controller.signal, headers: { "User-Agent": SCRAPER_USER_AGENT } });
    clearTimeout(timeout);
    if (!res.ok) return true;
    const text = await res.text();
    let appliesToUs = false;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.split("#")[0].trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        appliesToUs = value === "*";
      } else if (appliesToUs && key === "disallow" && value && targetPath.startsWith(value)) {
        return false;
      }
    }
    return true;
  } catch {
    return true; // couldn't check — don't block a real import over a network hiccup
  }
}

// Generic "find businesses on a directory page" importer — for Chamber
// of Commerce member directories and similar listing pages. There's no
// unified API across these (every chamber's site looks different), so
// instead of parsing site-specific structured data, this pulls every
// mailto: link AND every outbound link to what looks like a business's
// own website off the page, then runs the SAME homepage/contact/about
// email-finder outreachGenerateLeads already uses on each website found
// that didn't already have a direct mailto:. Respects robots.txt — some
// directory sites (state government ones especially) explicitly disallow
// automated access, and this refuses rather than silently ignoring that.
//
// KNOWN LIMITATION: this only sees whatever HTML the server actually
// sends back — a directory that renders its member list with
// client-side JavaScript after the page loads (a lot of modern chamber
// sites do) will come back essentially empty, since there's no headless
// browser here to run that JavaScript. Works well on traditional
// server-rendered directory pages; poorly on JS-heavy ones.
const DIRECTORY_IGNORE_HOSTS = [
  "facebook.com", "twitter.com", "x.com", "instagram.com", "linkedin.com",
  "youtube.com", "google.com", "maps.google.com", "goo.gl", "yelp.com",
  "tiktok.com", "pinterest.com",
];

exports.outreachImportFromDirectory = onCall({ timeoutSeconds: 300 }, async (request) => {
  await requireAdmin(request);

  const directoryUrl = (request.data?.directoryUrl || "").trim();
  const town = (request.data?.town || "").trim();
  if (!directoryUrl || !town) throw new HttpsError("invalid-argument", "directoryUrl and town are both required.");
  let parsedDirectoryUrl;
  try {
    parsedDirectoryUrl = new URL(directoryUrl);
  } catch {
    throw new HttpsError("invalid-argument", `"${directoryUrl}" isn't a valid URL.`);
  }

  if (!(await isAllowedByRobotsTxt(directoryUrl))) {
    throw new HttpsError(
      "failed-precondition",
      `${parsedDirectoryUrl.hostname}'s robots.txt says not to automatically crawl this page — skipping out of respect for that.`
    );
  }

  const pageRes = await fetch(directoryUrl, { redirect: "follow", headers: { "User-Agent": SCRAPER_USER_AGENT } });
  if (!pageRes.ok) throw new HttpsError("internal", `Couldn't load that page (HTTP ${pageRes.status}).`);
  const html = await pageRes.text();

  // Every mailto: link on the page, paired with its visible link text
  // (usually the business/contact name) as a best-effort company name.
  const directEmails = []; // [{companyName, email}]
  const mailtoRe = /<a\b[^>]*href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = mailtoRe.exec(html))) {
    const email = m[1].toLowerCase();
    if (isLikelyJunkEmail(email)) continue;
    directEmails.push({ companyName: m[2].replace(/<[^>]+>/g, "").trim(), email });
  }

  // Every outbound link that isn't the directory's own domain or a known
  // social/utility platform — candidate business websites to check for
  // an email the same way outreachGenerateLeads does. Capped at 40 to
  // keep this function's own runtime bounded even if several sites are
  // slow to respond.
  const linkRe = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seenHostnames = new Set();
  const externalLinks = []; // [{companyName, website}]
  const directoryHostname = parsedDirectoryUrl.hostname.replace(/^www\./, "");
  while ((m = linkRe.exec(html)) && externalLinks.length < 40) {
    let hostname;
    try {
      hostname = new URL(m[1]).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (hostname === directoryHostname) continue;
    if (DIRECTORY_IGNORE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))) continue;
    if (seenHostnames.has(hostname)) continue;
    seenHostnames.add(hostname);
    externalLinks.push({ companyName: m[2].replace(/<[^>]+>/g, "").trim(), website: m[1] });
  }

  // Dedup against every candidate ever found, same reasoning as
  // outreachGenerateLeads.
  const existingSnap = await db.collection("outreachCandidates").get();
  const seenWebsites = new Set();
  const seenEmails = new Set();
  existingSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.website) seenWebsites.add(data.website);
    if (data.email) seenEmails.add(data.email);
  });

  const now = Timestamp.now();
  const batch = db.batch();
  let created = 0;

  for (const { companyName, email } of directEmails) {
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    const ref = db.collection("outreachCandidates").doc();
    batch.set(ref, { companyName, phone: "", website: "", address: "", email, town, status: "candidate", source: "directory", searchedAt: now });
    created++;
  }

  for (const { companyName, website } of externalLinks) {
    if (seenWebsites.has(website)) continue;
    seenWebsites.add(website);
    const email = await tryFindEmailOnWebsite(website);
    const ref = db.collection("outreachCandidates").doc();
    batch.set(ref, { companyName, phone: "", website, address: "", email, town, status: "candidate", source: "directory", searchedAt: now });
    created++;
  }

  await batch.commit();
  return { created, directEmailsFound: directEmails.length, websitesChecked: externalLinks.length };
});

exports.outreachListCandidates = onCall(async (request) => {
  await requireAdmin(request);
  const status = (request.data?.status || "candidate").trim();
  // Only sync when viewing "candidate" (i.e. "Review new businesses") —
  // this is what pulls fresh unpaid Town Fuss business signups in, so the
  // checkbox to queue them is there without needing to visit "Today's
  // leads to draft" first.
  if (status === "candidate") await syncUnpaidBusinessLeadsIntoCandidates();
  const snap = await db.collection("outreachCandidates").where("status", "==", status).get();
  const candidates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  candidates.sort((a, b) => (b.searchedAt?.toMillis?.() || 0) - (a.searchedAt?.toMillis?.() || 0));
  return { candidates };
});

// Bulk status change — the "Add checked to this week's queue" button
// (candidate -> queued) and also usable to discard ones you don't want
// (candidate -> rejected) without deleting the record, so a rejected
// business doesn't get re-suggested by a future search of the same town.
exports.outreachSetCandidateStatus = onCall(async (request) => {
  await requireAdmin(request);
  const ids = Array.isArray(request.data?.ids) ? request.data.ids : [];
  const status = (request.data?.status || "").trim();
  if (ids.length === 0 || !["queued", "candidate", "rejected"].includes(status)) {
    throw new HttpsError("invalid-argument", "ids (non-empty array) and a valid status are required.");
  }
  const batch = db.batch();
  ids.forEach((id) => batch.set(db.collection("outreachCandidates").doc(id), { status }, { merge: true }));
  await batch.commit();
  return { ok: true, updated: ids.length };
});

// Lets you fill in/correct a candidate's email (or phone/website/address)
// after looking it up yourself — Places API never guesses an email, so
// this is how a blank one gets confirmed and made usable before it can
// show up in outreachListLeads (which requires a non-blank email).
exports.outreachUpdateCandidate = onCall(async (request) => {
  await requireAdmin(request);
  const id = (request.data?.id || "").trim();
  if (!id) throw new HttpsError("invalid-argument", "id is required.");
  const update = {};
  for (const field of ["email", "phone", "website", "address", "companyName"]) {
    if (typeof request.data?.[field] === "string") update[field] = request.data[field].trim();
  }
  if (update.email) update.email = update.email.toLowerCase();
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.collection("outreachCandidates").doc(id).set(update, { merge: true });
  return { ok: true };
});

// Bulk-imports rows from an admin-uploaded CSV (parsed client-side —
// Company/Phone/Website/Address/Email/Town) into outreachCandidates as
// status:"candidate", exactly like a town search result — reviewed and
// checked into the queue the same way, nothing queued or sent just from
// uploading. Deduped against every existing candidate by website (most
// reliable) or email, same reasoning as outreachGenerateLeads, so
// re-uploading the same list twice doesn't create duplicates.
exports.outreachBulkAddCandidates = onCall(async (request) => {
  await requireAdmin(request);
  const leads = Array.isArray(request.data?.leads) ? request.data.leads : [];
  if (leads.length === 0) throw new HttpsError("invalid-argument", "No rows to import.");
  if (leads.length > 500) {
    throw new HttpsError("invalid-argument", "Too many rows at once (500 max per upload, a single Firestore batch's limit) — split the file and upload again.");
  }

  // Only dedupe against candidates still actively sitting in review/queue
  // — NOT "drafted" or "rejected" ones. Those are historical; blocking a
  // re-upload of the same address because it was already drafted (e.g.
  // during testing) or already rejected serves no purpose and was the
  // real cause of "it won't let me re-add addresses I've already used."
  const existingSnap = await db.collection("outreachCandidates").where("status", "in", ["candidate", "queued"]).get();
  const seenWebsites = new Set();
  const seenEmails = new Set();
  for (const d of existingSnap.docs) {
    const data = d.data();
    if (data.website) seenWebsites.add(data.website.trim().toLowerCase());
    if (data.email) seenEmails.add((data.email || "").toLowerCase());
  }

  // outreachDeleteCandidates marks a deleted candidate's email with a
  // "deleted from Review new businesses" entry in outreachSentLog so the
  // unpaid-business-listing sync can't silently resurrect it. That marker
  // was never meant to permanently block a DELIBERATE re-add — explicitly
  // re-uploading the same address via CSV is a clear signal it should be
  // usable again, so that specific marker (and only that one — a real
  // draftedAt/skippedAt-for-another-reason entry means it was genuinely
  // contacted or intentionally excluded, and stays blocked) gets cleared
  // for anything actually being re-added below.
  const sentLogSnap = await db.collection("outreachSentLog").get();
  const deletedMarkerEmails = new Set(
    sentLogSnap.docs.filter((d) => d.data().reason === "deleted from Review new businesses").map((d) => d.id)
  );

  const baseMillis = Date.now();
  const batch = db.batch();
  let added = 0;
  let skipped = 0;
  leads.forEach((lead, rowIndex) => {
    const companyName = (lead.companyName || "").trim();
    const email = (lead.email || "").trim().toLowerCase();
    const website = (lead.website || "").trim().toLowerCase();
    if (!companyName && !email) {
      skipped++; // not enough to be a usable lead
      return;
    }
    if ((website && seenWebsites.has(website)) || (email && seenEmails.has(email))) {
      skipped++;
      return;
    }
    batch.set(db.collection("outreachCandidates").doc(), {
      companyName,
      phone: (lead.phone || "").trim(),
      website: (lead.website || "").trim(),
      address: (lead.address || "").trim(),
      email,
      town: (lead.town || "").trim(),
      status: "candidate",
      source: "csv-import",
      // Every row in one upload used to get the exact SAME timestamp
      // (one Timestamp.now() for the whole batch), which is why row
      // order didn't survive anywhere that sorts by searchedAt — ties
      // sort in whatever arbitrary order Firestore happens to return
      // them in, not upload order. Descending-by-searchedAt is the
      // existing sort convention everywhere this is read, so row 0 (the
      // CSV's first data row) gets the LARGEST timestamp in the batch,
      // putting it first.
      searchedAt: Timestamp.fromMillis(baseMillis - rowIndex),
    });
    if (email && deletedMarkerEmails.has(email)) {
      batch.delete(db.collection("outreachSentLog").doc(email));
    }
    if (website) seenWebsites.add(website);
    if (email) seenEmails.add(email);
    added++;
  });
  await batch.commit();
  return { added, skipped };
});

// Permanent delete — different from outreachSetCandidateStatus's
// "rejected" status, which deliberately keeps the record around so a
// re-search of the same town or a re-upload of the same CSV doesn't
// re-suggest it. This is for actually cleaning up junk/duplicate/mistaken
// entries (e.g. a bad CSV upload) — gone for good, not just hidden.
//
// Real gap this closes: for a candidate sourced from a real unpaid Town
// Fuss business listing (source:"unpaid-business-listing"),
// syncUnpaidBusinessLeadsIntoCandidates() re-creates a "candidate" doc for
// it on every page load if one doesn't already exist by that email — so
// deleting it here without also excluding it would make it silently
// reappear the very next time "Review new businesses" refreshes, looking
// exactly like the delete button doesn't work. Recording the email in
// outreachSentLog (same exclusion set the sync already checks) is what
// makes the deletion actually stick.
exports.outreachDeleteCandidates = onCall(async (request) => {
  await requireAdmin(request);
  const ids = Array.isArray(request.data?.ids) ? request.data.ids : [];
  if (ids.length === 0) throw new HttpsError("invalid-argument", "ids (non-empty array) is required.");
  const docs = await Promise.all(ids.map((id) => db.collection("outreachCandidates").doc(id).get()));
  const batch = db.batch();
  for (const snap of docs) {
    if (!snap.exists) continue;
    batch.delete(snap.ref);
    const email = (snap.data().email || "").trim().toLowerCase();
    if (email) {
      batch.set(db.collection("outreachSentLog").doc(email), { skippedAt: Timestamp.now(), reason: "deleted from Review new businesses" }, { merge: true });
    }
  }
  await batch.commit();
  return { ok: true, deleted: ids.length };
});

// ---------------------------------------------------------------------
// Cost tracking — the outreach system's ONE real per-use expense is
// Places API Text Search calls (outreachGenerateLeads). Everything else
// (Cloud Functions, Firestore, Gmail API, Apps Script) runs comfortably
// inside its own free tier at this project's actual volume — confirmed
// directly with the user, not assumed — so those show as $0.00 rather
// than being left out, for a complete picture rather than a partial one.
//
// Deliberately NOT pulling from Google Cloud's own Billing API: real
// itemized cost data needs a BigQuery billing export configured first (a
// separate GCP Console setup step) and has a real day-or-more reporting
// lag regardless. Self-tracking the one metered call directly, the
// moment it happens (see the FieldValue.increment in outreachGenerateLeads
// above), is both simpler and more accurate for this specific project.
//
// Places API Text Search pricing: our field mask includes phone number
// and website, which puts every request in the "Enterprise" SKU —
// verified 2026-08-20 — $35.00 per 1,000 requests ($0.035/request), not
// the cheaper "Pro" tier's $32.00 (that would apply without those fields).
// ---------------------------------------------------------------------
const PLACES_API_COST_PER_REQUEST_USD = 0.035;
const MAPS_PLATFORM_MONTHLY_FREE_CREDIT_USD = 200;

function centralYearMonth() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}`;
}

function firstOfNextMonthCentral() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const year = Number(parts.year);
  const month = Number(parts.month); // 1-12
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

// Shared by both the twice-daily snapshot AND the live fallback below —
// one real place this gets computed, not two copies that could drift.
async function computeCostBreakdown() {
  const usageSnap = await db.collection("outreachUsage").doc(`placesApi_${centralYearMonth()}`).get();
  const requestCount = usageSnap.exists ? usageSnap.data().requestCount || 0 : 0;
  const placesApiCostUsd = Math.round(requestCount * PLACES_API_COST_PER_REQUEST_USD * 100) / 100;

  // Only services that actually cost something show up here — Cloud
  // Functions, Firestore, Gmail API, and Apps Script are all genuinely
  // free at this project's volume, so they're left out entirely rather
  // than listed as clutter at $0.00.
  const allServices = [
    { name: "Google Places API (town search)", detail: `${requestCount} request(s) this month × $${PLACES_API_COST_PER_REQUEST_USD.toFixed(3)} each`, costUsd: placesApiCostUsd },
  ];
  const services = allServices.filter((s) => s.costUsd > 0);
  const totalCostUsd = Math.round(services.reduce((sum, s) => sum + s.costUsd, 0) * 100) / 100;

  return {
    services,
    totalCostUsd,
    monthlyFreeCreditUsd: MAPS_PLATFORM_MONTHLY_FREE_CREDIT_USD,
    remainingCreditUsd: Math.max(0, Math.round((MAPS_PLATFORM_MONTHLY_FREE_CREDIT_USD - placesApiCostUsd) * 100) / 100),
    resetsOn: firstOfNextMonthCentral(),
  };
}

// Runs at 9 AM and 9 PM Central — a deliberately fixed check-in cadence
// (not live-updating on every page load) so the number on the page moves
// on a predictable schedule instead of changing under the admin's cursor.
exports.outreachUpdateCostSnapshot = onSchedule({ schedule: "0 9,21 * * *", timeZone: "America/Chicago" }, async () => {
  const breakdown = await computeCostBreakdown();
  await db.collection("outreachUsage").doc("costSnapshot").set({ generatedAt: Timestamp.now(), ...breakdown });
});

exports.outreachGetCostSnapshot = onCall(async (request) => {
  await requireAdmin(request);
  try {
    const snap = await db.collection("outreachUsage").doc("costSnapshot").get();
    if (snap.exists) return snap.data();
    // No twice-daily snapshot yet (first 9am/9pm check-in hasn't happened
    // since this was built) — compute the real breakdown live instead of
    // showing an empty one. Once the schedule has run at least once, this
    // branch stops being hit and the cached snapshot takes over.
    const breakdown = await computeCostBreakdown();
    return { generatedAt: null, ...breakdown };
  } catch (err) {
    console.error("outreachGetCostSnapshot failed:", err);
    throw new HttpsError("internal", `Couldn't load usage data: ${err.message}`);
  }
});

