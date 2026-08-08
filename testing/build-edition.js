// build-edition.js
//
// Builds a deployable copy of Town Fuss for a specific regional edition by
// swapping the EDITION CONFIGURATION block in index.html/chess.html/
// checkers.html/ww.html, then copying every other file unchanged into a
// build directory ready for `firebase deploy --project <edition-project>`.
//
// The source repo always stays on the Pauls Valley (production) config —
// this script never modifies files in place, it only writes into ./build.
//
// Usage:
//   node build-edition.js eufaula-lake
//
// Add new editions to the EDITIONS map below.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BUILD_DIR = path.join(__dirname, "..", "build");

const EDITIONS = {
  "eufaula-lake": {
    editionName: "Eufaula Lake Edition",
    // Used to replace every plain-text "Pauls Valley" mention in marketing
    // copy (title, meta tags, hero text, footer) — a bare town/area name,
    // not the "___ Edition" branding string above. Missed entirely until
    // a live user found "Pauls Valley" still showing on Eufaula Lake
    // 2026-08-07 — this file previously only swapped the config block,
    // not the surrounding page copy.
    shortName: "Eufaula Lake",
    editionRegion: "Oklahoma",
    homeTown: "Eufaula",
    towns: [
      "Eufaula", "Checotah", "Warner", "Henryetta", "Krebs", "Stigler",
      "McAlester", "Morris", "Hartshorne", "Okmulgee", "Muskogee", "Haskell",
      "Wetumka", "Longtown", "Texanna", "Coweta",
    ],
    firebaseConfig: {
      apiKey: "AIzaSyAzSpyuWsl_533D24U1J9fYEY0efw30FO0",
      authDomain: "eufaula-lake.firebaseapp.com",
      projectId: "eufaula-lake",
      storageBucket: "eufaula-lake.firebasestorage.app",
      messagingSenderId: "825364437058",
      appId: "1:825364437058:web:12a32229ae30acf3e435db",
    },
    // Web Push certificate key pair — generated per-project in Firebase
    // Console (Project Settings -> Cloud Messaging -> Web Push
    // certificates -> generate key pair). There is no API to create or
    // read this; it's a one-time manual step for every new edition. Until
    // it's set to a real value here, push notifications on this edition
    // fail with "messaging/token-subscribe-failed" — confirmed live on
    // Eufaula Lake 2026-08-07.
    vapidKey: "BJfarbE3nY-ex5avq1iE4kVaMs1jTvBIVtjckkr8-g_p2Q05e8ccuOPhvpUTua0WWusvy-zNPk23amCI_38ysbs",
    otherEditions: [
      { name: "Pauls Valley Edition", url: "https://www.townfuss.com" },
    ],
  },
};

function formatTownsArray(towns) {
  // Match the source files' own wrapping style (multiple towns per line)
  // closely enough to stay readable — exact wrapping doesn't matter
  // functionally, just for anyone reading the built file.
  const quoted = towns.map((t) => `"${t}"`);
  const lines = [];
  for (let i = 0; i < quoted.length; i += 6) {
    lines.push("  " + quoted.slice(i, i + 6).join(", ") + ",");
  }
  return lines.join("\n");
}

function formatFirebaseConfig(cfg) {
  return Object.entries(cfg)
    .map(([k, v]) => `  ${k}: "${v}",`)
    .join("\n");
}

function formatOtherEditions(list) {
  if (!list || !list.length) return "[]";
  const entries = list.map((ed) => `  { name: "${ed.name}", url: "${ed.url}" },`).join("\n");
  return `[\n${entries}\n]`;
}

function swapIndexHtmlConfig(content, edition) {
  const newBlock = `const EDITION_NAME = "${edition.editionName}";
const EDITION_REGION = "${edition.editionRegion}";
// Order here is also the display order everywhere this list is rendered
// (both town dropdowns, the About page's town chips, and the town chat
// room list).
const EDITION_TOWNS = [
${formatTownsArray(edition.towns)}
];
// The town selected by default on the Feed's town-filter tabs.
const EDITION_HOME_TOWN = "${edition.homeTown}";
// Other live Town Fuss editions, shown as a small picker at the top of the
// sign-in page — each is an entirely separate Firebase project/deployment
// (not a different view of this same app), so entries just link out to
// that edition's own site. List order is also display order.
const OTHER_EDITIONS = ${formatOtherEditions(edition.otherEditions)};

// These Firebase project values are safe to expose publicly — access
// control lives in Firestore/Storage security rules, not in hiding this
// object.
const firebaseConfig = {
${formatFirebaseConfig(edition.firebaseConfig)}
};`;

  const re = /const EDITION_NAME = "[^"]*";[\s\S]*?const firebaseConfig = \{[\s\S]*?\};/;
  if (!re.test(content)) throw new Error("Could not find EDITION CONFIGURATION block to replace in index.html");
  return content.replace(re, newBlock);
}

// Marketing copy (page title, meta tags, hero text, footer) that names
// "Pauls Valley" directly as plain text, outside the EDITION CONFIGURATION
// block — a plain global replace, not template-driven, since these are
// free-form sentences (title tags, meta descriptions, paragraphs) rather
// than a fixed data structure like EDITION_TOWNS.
function swapMarketingCopy(content, edition) {
  if (!edition.shortName) return content;
  return content.split("Pauls Valley").join(edition.shortName);
}

function swapSimpleFirebaseConfig(content, edition, fileLabel) {
  const newBlock = `const firebaseConfig = {\n${formatFirebaseConfig(edition.firebaseConfig)}\n};`;
  const re = /const firebaseConfig = \{[\s\S]*?\};/;
  if (!re.test(content)) throw new Error(`Could not find firebaseConfig block to replace in ${fileLabel}`);
  return content.replace(re, newBlock);
}

// FCM_VAPID_KEY is tied to the Firebase project the same way firebaseConfig
// is, but it lives in its own constant further down index.html (added after
// push notifications shipped, post-dating the EDITION CONFIGURATION block).
// Missed entirely on Eufaula Lake's first build — confirmed live 2026-08-07
// as "messaging/token-subscribe-failed" when a real user tried to turn
// notifications on.
function swapVapidKey(content, edition) {
  if (!edition.vapidKey) return content; // no key generated yet for this edition — leave production's in place rather than write a guaranteed-broken empty string
  const re = /const FCM_VAPID_KEY = "[^"]*";/;
  if (!re.test(content)) throw new Error("Could not find FCM_VAPID_KEY to replace in index.html");
  return content.replace(re, `const FCM_VAPID_KEY = "${edition.vapidKey}";`);
}

// firebase-messaging-sw.js is a THIRD place carrying its own hardcoded
// firebaseConfig (service workers can't share index.html's JS scope) — same
// bug class as the 22 game files, just easier to miss since it's not a
// .html file. Its config uses the compat SDK's plain-object literal, same
// shape as the modular one, so the same formatter works.
function swapServiceWorkerConfig(content, edition) {
  const newBlock = `firebase.initializeApp({\n${formatFirebaseConfig(edition.firebaseConfig)}\n});`;
  const re = /firebase\.initializeApp\(\{[\s\S]*?\}\);/;
  if (!re.test(content)) throw new Error("Could not find firebase.initializeApp block to replace in firebase-messaging-sw.js");
  return content.replace(re, newBlock);
}

function copyDirExcept(src, dest, skipNames) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirExcept(srcPath, destPath, new Set());
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  const editionId = process.argv[2];
  if (!editionId || !EDITIONS[editionId]) {
    console.error("Usage: node build-edition.js <edition-id>");
    console.error("Known editions:", Object.keys(EDITIONS).join(", "));
    process.exit(1);
  }
  const edition = EDITIONS[editionId];

  if (fs.existsSync(BUILD_DIR)) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const skip = new Set(["node_modules", ".git", "build", "testing", ".firebase"]);
  copyDirExcept(REPO_ROOT, BUILD_DIR, skip);

  const indexPath = path.join(BUILD_DIR, "index.html");
  let indexContent = swapIndexHtmlConfig(fs.readFileSync(indexPath, "utf8"), edition);
  indexContent = swapMarketingCopy(indexContent, edition);
  indexContent = swapVapidKey(indexContent, edition);
  fs.writeFileSync(indexPath, indexContent, "utf8");
  if (!edition.vapidKey) {
    console.warn(`WARNING: no vapidKey set for ${editionId} — push notifications on this edition will keep failing with messaging/token-subscribe-failed until one is generated in that project's Firebase Console (Project Settings -> Cloud Messaging -> Web Push certificates) and added to EDITIONS in this file.`);
  }

  const swPath = path.join(BUILD_DIR, "firebase-messaging-sw.js");
  fs.writeFileSync(swPath, swapServiceWorkerConfig(fs.readFileSync(swPath, "utf8"), edition), "utf8");

  // Every other page that has its own firebaseConfig (all 22 solo/2-player
  // game pages plus the game-hub page) — each is its own separate script
  // context with no way to import index.html's config, so each one carries
  // its own copy that has to be swapped the same way. Missing one of these
  // here is exactly how a whole game silently ends up talking to the wrong
  // Firebase project on a cloned edition (confirmed real bug 2026-08-07 on
  // Eufaula Lake: titanspace.html was still pointed at production).
  const SIMPLE_CONFIG_FILES = [
    "chess.html", "checkers.html", "ww.html",
    "airhockey.html", "blackjack.html", "blocks.html", "deepsea.html",
    "desert.html", "dodge.html", "fg.html", "follow.html", "gamezone.html",
    "golf.html", "gravity-sling.html", "gtf.html", "hearts.html",
    "m3game.html", "match3.html", "neon-drift.html", "pong.html",
    "sea-war.html", "stacking-checkers.html", "sudoku.html",
    "titanspace.html", "war.html",
  ];
  for (const f of SIMPLE_CONFIG_FILES) {
    const p = path.join(BUILD_DIR, f);
    fs.writeFileSync(p, swapSimpleFirebaseConfig(fs.readFileSync(p, "utf8"), edition, f), "utf8");
  }

  console.log(`Built ${editionId} into ${BUILD_DIR}`);
  console.log(`Deploy with: firebase deploy --only hosting --project ${editionId} --config <path to a firebase.json pointing hosting.public at "build">`);
}

main();
