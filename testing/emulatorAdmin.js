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
process.env.GCLOUD_PROJECT = "town-talk-87ff7";

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "town-talk-87ff7" });
}

// createUserWithEmailAndPassword() on the client is async, so calling this
// right after a signup form submit can race the account actually existing
// yet in the Auth emulator — worse the more load the emulator is already
// under (e.g. deep into a long combined test run). Retry briefly instead
// of failing outright on a timing hiccup.
async function verifyEmailByAddress(email, retries = 10, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(user.uid, { emailVerified: true });
      return user.uid;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function makeAdmin(uid) {
  await admin.firestore().collection("admins").doc(uid).set({ grantedByTestSetup: true });
}

module.exports = { admin, verifyEmailByAddress, makeAdmin };