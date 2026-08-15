// emulatorAdmin.js
//
// This connects to your LOCAL emulators only — never your real production
// Firebase project. It exists to do the two things a browser robot
// genuinely can't do by clicking around:
//   1. Mark a test account's email as "verified" (no real email involved
//      when using the emulator, so there's no link to click)
//   2. Grant a test account admin rights, so one robot can test the
//      Admin approve/reject buttons for real
//
// Run this only while `firebase emulators:start` is running in another
// terminal window.

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
// The emulator suite runs in --single_project_mode, scoped to whichever
// --project was passed to `firebase emulators:start` — the Admin SDK here
// has to match that exactly or every lookup silently misses (e.g.
// getUserByEmail() throws "no user record" even though the browser's
// signup genuinely succeeded, just under a different project namespace).
// Defaults to production so nothing changes for the normal run; set
// TEST_PROJECT_ID when running the suite against a different edition's
// build (see testing/README or the edition's own build-edition.js entry
// for its exact project id). Confirmed as a real gap 2026-08-09 testing
// Eufaula Lake's build for the first time — this file had never been
// touched for the multi-edition work at all.
const PROJECT_ID = process.env.TEST_PROJECT_ID || "town-talk-87ff7";
process.env.GCLOUD_PROJECT = PROJECT_ID;

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
}

// createUserWithEmailAndPassword() on the client is async, so calling this
// right after a signup form submit can race the account actually existing
// yet in the Auth emulator — worse the more load the emulator is already
// under (e.g. deep into a long combined test run). Retry briefly instead
// of failing outright on a timing hiccup.
async function verifyEmailByAddress(email, retries = 10, delayMs = 500) {
  let uid;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(user.uid, { emailVerified: true });
      uid = user.uid;
      break;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // index.html's own signup handler writes the real users/{uid} profile
  // doc (email/createdAt/etc.) asynchronously, AFTER
  // createUserWithEmailAndPassword() resolves — which is also what makes
  // the account visible to getUserByEmail() above. Returning before that
  // write lands lets whatever the caller does next (almost always an
  // admin-SDK merge write marking the account approved) win the race and
  // reach the Firestore server FIRST, corrupting the exact "stub" doc
  // shape the client's own write depends on to pass firestore.rules —
  // which makes THAT write get rejected, and the signup handler responds
  // to any such rejection by deleting the account and signing the person
  // out. Root-caused 2026-08-06 after it spent a full session masquerading
  // as random game-page hangs. Wait for the real doc to actually exist
  // before handing the uid back, so nothing racing ahead of it can win.
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists && snap.data().email) return uid;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`users/${uid} never got its real signup fields (email/createdAt) within 15000ms`);
}

// Google-provider accounts have no "verify your email" gate (Google
// accounts are inherently already verified, and the Auth emulator's mock
// Google sign-in reflects that same emailVerified: true automatically) —
// so this is verifyEmailByAddress() minus the updateUser() step, kept as
// its own function rather than folded together since one flips a flag
// that genuinely doesn't apply to the other. Same race and same fix as
// verifyEmailByAddress's own comment: signInWithPopup resolving and
// index.html's own users/{uid} write landing are two separate async
// steps, so this returns the uid only once the real doc — not just the
// beforeSignInBlocking lastKnownIp-only stub — actually exists.
async function getUidForGoogleSignIn(email, retries = 10, delayMs = 500) {
  let uid;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      uid = user.uid;
      break;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists && snap.data().email) return uid;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`users/${uid} never got its real signup fields (email/createdAt) within 15000ms`);
}

async function makeAdmin(uid) {
  await admin.firestore().collection("admins").doc(uid).set({ grantedByTestSetup: true });
}

// Batch 2 added tiered daily limits (3 free / 10 Gold / unlimited Diamond)
// for online game plays and direct messages, shared across ALL 5 games via
// a single gamePlayLimits/{uid} counter. Grant Diamond here, mid-suite,
// AFTER the dedicated free-tier limit test runs but BEFORE the multi-game
// invite/move tests — otherwise the same two robot accounts run out of
// their 3 free online-game plays partway through (e.g. by the time the
// suite gets to Golf) since the counter isn't per-game.
async function grantUnlimitedGamePlay(uid) {
  await admin.firestore().collection("users").doc(uid).set(
    { isDiamondMember: true, diamondExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    { merge: true }
  );
}

module.exports = { admin, verifyEmailByAddress, getUidForGoogleSignIn, makeAdmin, grantUnlimitedGamePlay };