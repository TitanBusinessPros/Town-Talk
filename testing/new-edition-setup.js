// new-edition-setup.js
//
// Everything from the Eufaula Lake setup that CAN be scripted, in the
// exact order that avoids every mistake made doing it by hand the first
// time: batched function deploys silently drop most functions on a
// brand-new project (deploy one at a time instead), Stripe secrets need
// placeholder values before ANY function deploy will even start (the
// codebase checks every declared secret exists, not just the ones being
// deployed), Storage/Auth "Get Started" and billing are the only parts
// Google genuinely does not expose an API for.
//
// Usage:
//   node new-edition-setup.js <project-id> "<Display Name>"
//
// This does NOT create the Firebase project itself or run the two
// unavoidable manual console steps — see the printed checklist below for
// exactly what to click and in what order. Run this script AFTER those,
// or it'll fail at the first step that needs them and tell you which one.

const { execSync } = require("child_process");
const fs = require("fs");

const ADMIN_EMAILS = [
  { email: "seven12forty@gmail.com", name: "T1B" },
  { email: "adonai4you@gmail.com", name: "Titan Business Pros" },
];

const ALL_FUNCTIONS = [
  "onChessInvite", "onCheckersInvite", "onWynneWarsInvite", "onGolfInvite",
  "onFrisbeeGolfInvite", "onWarInvite", "onHeartsInvite", "onBlackjackInvite",
  "onAirHockeyInvite", "onNewSignup", "onFirstMessageNotify", "onChatReaction",
  "refreshLeaderboardCache", "computeNeighborOfTheWeek", "expireBusinessListings",
  "stripeWebhook", "expireMemberships", "backupAuthAccounts", "ensureMyAdminPerks",
  "adminDeleteProfile", "banUserAndIp", "adminRestoreProfile", "adminGrantGold",
  "purgeExpiredDeletedProfiles", "beforeSignInBlocking",
];

function run(cmd) {
  console.log(">", cmd);
  execSync(cmd, { stdio: "inherit" });
}

function main() {
  const projectId = process.argv[2];
  const displayName = process.argv[3];
  if (!projectId || !displayName) {
    console.error('Usage: node new-edition-setup.js <project-id> "<Display Name>"');
    process.exit(1);
  }

  console.log(`
=========================================================================
BEFORE running this script, do these 4 things — they are the ONLY parts
of this whole process with no API, confirmed after actually trying every
workaround on Eufaula Lake:

  1. Create the project:
       firebase projects:create ${projectId} --display-name "${displayName}"
  2. Link billing: console.firebase.google.com/project/${projectId}/usage/details
     -> Modify plan -> Blaze -> pick the existing billing account.
  3. console.firebase.google.com/project/${projectId}/storage -> Get Started
     (default settings are fine).
  4. console.firebase.google.com/project/${projectId}/authentication -> Get
     Started -> enable Email/Password. Also enable Google sign-in here
     while you're on this screen (Console-only, no API — creates its own
     OAuth client automatically).
  5. console.cloud.google.com/customer-identity/ -> select ${projectId} ->
     Enable Identity Platform (required before beforeSignInBlocking can be
     wired into Auth — the function deploys fine without this, only the
     Auth wiring step below needs it).

Press Ctrl+C now if you haven't done all 5 yet. Continuing in 5 seconds...
=========================================================================
`);
  execSync("sleep 5 || timeout 5", { shell: true, stdio: "ignore" }).toString();

  console.log("\n--- Firestore ---");
  run(`firebase firestore:databases:create "(default)" --location nam5 --project ${projectId}`);
  run(`firebase deploy --only firestore:rules,firestore:indexes --project ${projectId}`);

  console.log("\n--- Storage rules (direct API — CLI has a known bug deploying these) ---");
  console.log("Run separately if this fails: see the deploy_storage_eufaula.js pattern from 2026-08-07.");
  try { run(`firebase deploy --only storage:rules --project ${projectId}`); }
  catch { console.log("Storage rules deploy failed via CLI (known firebase-tools bug) — needs the direct Rules API workaround by hand."); }

  console.log("\n--- Placeholder secrets (MUST exist before ANY function deploy) ---");
  for (const secret of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET_1", "STRIPE_WEBHOOK_SECRET_2", "STRIPE_WEBHOOK_SECRET_3"]) {
    run(`echo placeholder-not-yet-configured | firebase functions:secrets:set ${secret} --data-file - --project ${projectId}`);
  }

  console.log("\n--- Functions: one at a time, not batched (batching silently drops most of them on a new project) ---");
  for (const fn of ALL_FUNCTIONS) {
    try { run(`firebase deploy --only "functions:${fn}" --project ${projectId}`); }
    catch { console.log(`${fn} failed — likely still-propagating IAM permissions on a brand-new project. Wait a few minutes and re-run just this one.`); }
  }
  run(`firebase functions:artifacts:setpolicy --project ${projectId} --location us-central1 --force`);

  console.log("\n--- Web app + config ---");
  run(`firebase apps:create WEB "${displayName}" --project ${projectId}`);
  console.log("Copy the config from the output above into EDITIONS in build-edition.js, then re-run this script's admin step below.");

  console.log(`
=========================================================================
STILL MANUAL after this: wire beforeSignInBlocking into Auth config (one
API call, needs the function's real URL from the deploy output above),
create admin accounts (${ADMIN_EMAILS.map(a => a.email).join(", ")}),
build + deploy hosting via build-edition.js, and the custom domain DNS
record (Firebase gives you the exact CNAME after "Add custom domain" in
the Hosting console — no way to skip the DNS step, it's your registrar).
=========================================================================
`);
}

main();
