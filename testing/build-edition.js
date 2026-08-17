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
    ownUrl: "https://eufaula.townfuss.com/",
    editionRegion: "Oklahoma",
    homeTown: "Eufaula",
    // Coweta swapped out 2026-08-11 -- it's a Tulsa-metro town (~15mi from
    // Tulsa, ~30mi from Eufaula) and was already duplicated on the Tulsa
    // edition's own list, which is the correct home for it. Replaced with
    // Porum (~18mi from Eufaula, pop. ~700), which wasn't claimed by any
    // other edition.
    towns: [
      "Eufaula", "Checotah", "Warner", "Henryetta", "Krebs", "Stigler",
      "McAlester", "Morris", "Hartshorne", "Okmulgee", "Muskogee", "Haskell",
      "Wetumka", "Longtown", "Texanna", "Porum",
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
      { name: "Tulsa Edition", url: "https://tulsa.townfuss.com" },
      { name: "Edmond Edition", url: "https://edmond.townfuss.com" },
      { name: "Oklahoma City Edition", url: "https://okc.townfuss.com" },
      { name: "Poteau Edition", url: "https://poteau.townfuss.com" },
      { name: "Prague Edition", url: "https://prague.townfuss.com" },
    ],
  },
  "tulsa-townfuss": {
    editionName: "Tulsa Edition",
    shortName: "Tulsa",
    ownUrl: "https://tulsa.townfuss.com/",
    editionRegion: "Oklahoma",
    homeTown: "Tulsa",
    // Straight-line (haversine) distance from Tulsa, verified against
    // current census populations 2026-08-08 — not copied from any single
    // web listing, several of which conflated driving distance with
    // straight-line or were simply wrong (e.g. Wagoner reads as a close-in
    // suburb on some sites but is actually ~37 mi out; excluded here).
    // Order below is distance order (closest first), same convention as
    // every other edition's town list.
    towns: [
      "Tulsa", "Sand Springs", "Jenks", "Owasso", "Sapulpa", "Broken Arrow",
      "Glenpool", "Catoosa", "Bixby", "Collinsville", "Skiatook", "Verdigris",
      "Mannford", "Coweta", "Claremore", "Cleveland",
    ],
    firebaseConfig: {
      apiKey: "AIzaSyCDV5bXQ5w57kJ3Y5sQPyo2tkv8YnGpuSY",
      authDomain: "tulsa-townfuss.firebaseapp.com",
      projectId: "tulsa-townfuss",
      storageBucket: "tulsa-townfuss.firebasestorage.app",
      messagingSenderId: "184420545538",
      appId: "1:184420545538:web:e7303b93bf7c06f1f4231b",
    },
    // Same one-time manual step as every other edition — see the
    // eufaula-lake entry's comment above.
    vapidKey: "BEn8szf0APOprQdidUNId_OoPdEB_piuI7miHaaiP28Ssq1R7jyLoxPjpzrNwNLh6XXBo5MGttfDd9k79TPwEGU",
    otherEditions: [
      { name: "Pauls Valley Edition", url: "https://www.townfuss.com" },
      { name: "Eufaula Lake Edition", url: "https://eufaula.townfuss.com" },
      { name: "Edmond Edition", url: "https://edmond.townfuss.com" },
      { name: "Oklahoma City Edition", url: "https://okc.townfuss.com" },
      { name: "Poteau Edition", url: "https://poteau.townfuss.com" },
      { name: "Prague Edition", url: "https://prague.townfuss.com" },
      { name: "Poteau Edition", url: "https://poteau.townfuss.com" },
    ],
  },
  "edmond-townfuss": {
    editionName: "Edmond Edition",
    shortName: "Edmond",
    ownUrl: "https://edmond.townfuss.com/",
    editionRegion: "Oklahoma",
    homeTown: "Edmond",
    // Town list as given directly by the user (2026-08-09) — not
    // independently re-derived via distance/population this time, since
    // the request already specified the exact 16 towns to use.
    towns: [
      "Edmond", "Guthrie", "Luther", "Cashion", "Crescent", "Kingfisher",
      "Langston", "Piedmont", "Wellston", "Jones", "Nichols Hills",
      "Forest Park", "Spencer", "Bethany", "Arcadia", "Choctaw",
    ],
    firebaseConfig: {
      apiKey: "AIzaSyBtr7np4GIBc4VoXOSi3j5nj44qkqnTwsU",
      authDomain: "edmond-townfuss.firebaseapp.com",
      projectId: "edmond-townfuss",
      storageBucket: "edmond-townfuss.firebasestorage.app",
      messagingSenderId: "1010429464536",
      appId: "1:1010429464536:web:8f971c747742e45c68ecad",
    },
    // Same one-time manual step as every other edition — see the
    // eufaula-lake entry's comment above.
    vapidKey: "BH7AKguKV-1ineKG4-GHJ2heNOWRuJp0toF4R_ATzvyRz4bvgspMRoecuQDCdbHmLjHyNxelMssXF41I436ZQU8",
    otherEditions: [
      { name: "Pauls Valley Edition", url: "https://www.townfuss.com" },
      { name: "Eufaula Lake Edition", url: "https://eufaula.townfuss.com" },
      { name: "Tulsa Edition", url: "https://tulsa.townfuss.com" },
      { name: "Oklahoma City Edition", url: "https://okc.townfuss.com" },
      { name: "Poteau Edition", url: "https://poteau.townfuss.com" },
      { name: "Prague Edition", url: "https://prague.townfuss.com" },
    ],
  },
  "okc-townfuss": {
    editionName: "Oklahoma City Edition",
    shortName: "Oklahoma City",
    ownUrl: "https://okc.townfuss.com/",
    editionRegion: "Oklahoma",
    homeTown: "Oklahoma City",
    // Town/district list as given directly by the user (2026-08-09) —
    // includes several OKC-internal districts/neighborhoods (Bricktown,
    // South/North/Central/West/East OKC) that aren't separately
    // incorporated towns, used anyway per explicit instruction for
    // hyper-local chat rooms within the city itself.
    towns: [
      "Oklahoma City", "Del City", "Midwest City", "Valley Brook", "Moore",
      "Mustang", "Bricktown", "South OKC", "North OKC", "Central OKC",
      "West OKC", "East OKC", "Yukon", "Union City", "El Reno", "Okarche",
    ],
    firebaseConfig: {
      apiKey: "AIzaSyCuqGQpiifP7yjBNe5FVlORSNkUgianTI8",
      authDomain: "okc-townfuss.firebaseapp.com",
      projectId: "okc-townfuss",
      storageBucket: "okc-townfuss.firebasestorage.app",
      messagingSenderId: "1089534300505",
      appId: "1:1089534300505:web:f6fcfa376278e7dd2c3c48",
    },
    // Same one-time manual step as every other edition — see the
    // eufaula-lake entry's comment above.
    vapidKey: "BLHlLuGEgucNfW6Brrpe73RrZj8A5TLM1K0zYoT6VcSgEHRrmWBOJVVp0d741fHk3sokyg1IWAUWX24pM3TZY98",
    otherEditions: [
      { name: "Pauls Valley Edition", url: "https://www.townfuss.com" },
      { name: "Eufaula Lake Edition", url: "https://eufaula.townfuss.com" },
      { name: "Tulsa Edition", url: "https://tulsa.townfuss.com" },
      { name: "Edmond Edition", url: "https://edmond.townfuss.com" },
      { name: "Poteau Edition", url: "https://poteau.townfuss.com" },
      { name: "Prague Edition", url: "https://prague.townfuss.com" },
    ],
  },
  "poteau-townfuss": {
    editionName: "Poteau Edition",
    shortName: "Poteau",
    ownUrl: "https://poteau.townfuss.com/",
    editionRegion: "Oklahoma",
    homeTown: "Poteau",
    // Derived via distance/population research (2026-08-10/11): every
    // Oklahoma town within 40 miles of Poteau with population 500+,
    // Arkansas towns excluded per explicit instruction (Fort Smith/Van
    // Buren/Greenwood/Barling/Mansfield would otherwise qualify too, but
    // were left out to keep this an Oklahoma-only edition). Gore, OK
    // (~42mi, 951 pop) also excluded per explicit instruction — just
    // outside the 40-mile cutoff.
    // Stigler swapped out 2026-08-11 -- it was already on the Eufaula Lake
    // edition's list first (its correct home, roughly equidistant but
    // added there earlier), duplicated here later. Replaced with Howe
    // (~15mi from Poteau, pop. ~800) -- not Gore, which stays excluded per
    // the note above.
    towns: [
      "Poteau", "Sallisaw", "Pocola", "Roland", "Heavener", "Spiro",
      "Arkoma", "Panama", "Wister", "Shady Point", "Talihina", "Keota",
      "McCurtain", "Muldrow", "Howe", "Wilburton",
    ],
    firebaseConfig: {
      apiKey: "AIzaSyA9SNsAbvnWxwB_fK4VmXC00wORipshFig",
      authDomain: "poteau-townfuss.firebaseapp.com",
      projectId: "poteau-townfuss",
      storageBucket: "poteau-townfuss.firebasestorage.app",
      messagingSenderId: "786435750960",
      appId: "1:786435750960:web:ebf7998d486875943001f5",
    },
    vapidKey: "BNm7U2-Nz0IYNFNdtQOyw8dZUalYanDWZ-37BHdDU40nwgQS7W6pL0WlGdH3FJB6fZaq_l9f8Z2chpzflUV-0Kk",
    otherEditions: [
      { name: "Pauls Valley Edition", url: "https://www.townfuss.com" },
      { name: "Eufaula Lake Edition", url: "https://eufaula.townfuss.com" },
      { name: "Tulsa Edition", url: "https://tulsa.townfuss.com" },
      { name: "Edmond Edition", url: "https://edmond.townfuss.com" },
      { name: "Oklahoma City Edition", url: "https://okc.townfuss.com" },
      { name: "Prague Edition", url: "https://prague.townfuss.com" },
    ],
  },
  "prague-townfuss": {
    editionName: "Prague Edition",
    shortName: "Prague",
    ownUrl: "https://prague.townfuss.com/",
    editionRegion: "Oklahoma",
    homeTown: "Prague",
    // Derived via distance/population research (2026-08-11): every
    // Oklahoma town within 45 miles of Prague with population 500+.
    // Okemah and Maud's distances are straight-line coordinate estimates
    // (no direct driving-distance source found for those two
    // specifically) — both comfortably under the 45mi cutoff either way.
    // Wellston swapped out 2026-08-11 -- it was already on the Edmond
    // edition's list first (its correct home, roughly equidistant but
    // added there earlier), duplicated here later. Replaced with Earlsboro
    // (~15mi from Prague, pop. ~600).
    towns: [
      "Prague", "Shawnee", "Cushing", "Seminole", "Tecumseh", "McLoud",
      "Bristow", "Wewoka", "Okemah", "Chandler", "Stroud", "Konawa",
      "Boley", "Meeker", "Maud", "Earlsboro",
    ],
    firebaseConfig: {
      apiKey: "AIzaSyBvWLgGupdzmJAMestDKlqMX-I80hJlAns",
      authDomain: "prague-townfuss.firebaseapp.com",
      projectId: "prague-townfuss",
      storageBucket: "prague-townfuss.firebasestorage.app",
      messagingSenderId: "220339095620",
      appId: "1:220339095620:web:c38a7d61123d316d05d411",
    },
    // Regenerated 2026-08-16 — the original key (same string on both the
    // Firebase Console display and in this file, confirmed identical, and
    // confirmed working correctly for both Installations and FCM
    // registration when called directly via REST) still failed
    // specifically at the browser's own pushManager.subscribe() step with
    // "messaging/token-subscribe-failed" on two separate devices. Root
    // cause was never pinned down remotely — everything server-side
    // checked out, so this was likely a Firebase-side key-pairing glitch
    // invisible from the outside, not a config mistake in this repo.
    // Regenerated a second time 2026-08-18 — the underlying push failure
    // was later traced to App Check's exchangeRecaptchaV3Token returning
    // "App attestation failed" (confirmed live, reproduced directly, and
    // confirmed happening identically on Pauls Valley too, ruling out a
    // Prague-specific cause) — this key swap is unlikely to fix that
    // particular failure on its own, but the user regenerated it via
    // Firebase Console and asked for the codebase updated to match.
    vapidKey: "BDQy5sTzrJrNbBR5v3mVuzDYhdRP8Fz6JmNhUeFhYbVTkPvgNMf3ipvXKcJVXTQpq54iEdAdH7FEtQWIVdOLyVI",
    otherEditions: [
      { name: "Pauls Valley Edition", url: "https://www.townfuss.com" },
      { name: "Eufaula Lake Edition", url: "https://eufaula.townfuss.com" },
      { name: "Tulsa Edition", url: "https://tulsa.townfuss.com" },
      { name: "Edmond Edition", url: "https://edmond.townfuss.com" },
      { name: "Oklahoma City Edition", url: "https://okc.townfuss.com" },
      { name: "Poteau Edition", url: "https://poteau.townfuss.com" },
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

// og:url has to be the edition's OWN real domain, not swapped by the
// blind "Pauls Valley" text replace above (a URL doesn't contain that
// text) or by swapIndexHtmlConfig (not part of the firebaseConfig
// block) — needs its own explicit swap, same reasoning as
// swapVapidKey/swapServiceWorkerConfig above for other per-edition
// values that live outside the main config block.
function swapOgUrl(content, edition) {
  if (!edition.ownUrl) return content; // shouldn't happen once every edition has one, but don't ship a broken tag if it's ever missing
  const re = /<meta property="og:url" content="[^"]*" \/>/;
  if (!re.test(content)) throw new Error("Could not find og:url meta tag to replace in index.html");
  return content.replace(re, `<meta property="og:url" content="${edition.ownUrl}" />`);
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

function copyDirExcept(src, dest, skipNames, skipFilePattern) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    if (skipFilePattern && !entry.isDirectory() && skipFilePattern.test(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirExcept(srcPath, destPath, new Set(), skipFilePattern);
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

  // Windows Defender/Search/OneDrive will sometimes hold a lock on files in
  // ./build for a few seconds right after the previous edition's `firebase
  // deploy` finished touching them (confirmed 2026-08-13: rmSync failed
  // with EBUSY for 60+ straight seconds across two separate editions back
  // to back, with no owning process found via Get-Process/Get-CimInstance —
  // consistent with an AV/indexer scan racing the delete, not a real
  // handle leak in our own tooling). Retrying with backoff instead of
  // failing outright, since the lock does eventually clear on its own.
  rmBuildDirWithRetry();

  function rmBuildDirWithRetry(attempt = 1) {
    if (!fs.existsSync(BUILD_DIR)) return;
    try {
      fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
      if (attempt >= 15) {
        // Give up deleting and just overwrite in place instead of failing
        // the whole build. Safe here specifically because copyDirExcept
        // below always copies the exact same REPO_ROOT file set regardless
        // of edition — the only thing that differs between editions is
        // file CONTENTS (config swaps), never which files exist — so a
        // stale ./build from a previous edition's run has nothing in it
        // that this run won't overwrite anyway.
        console.warn(`build dir still locked after ${attempt} attempts — leaving it in place and overwriting its contents instead of deleting it first.`);
        return;
      }
      const delayMs = Math.min(2000, 250 * attempt);
      console.warn(`build dir locked (${err.code}), retrying in ${delayMs}ms (attempt ${attempt}/15)...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      rmBuildDirWithRetry(attempt + 1);
    }
  }
  // *-debug.log: local emulator logs that land in the repo root while
  // testing (gitignored, never committed) but were still getting swept into
  // the deployed build since copyDirExcept only skips directories by name —
  // confirmed live 2026-08-07: firestore-debug.log/pubsub-debug.log were
  // both publicly downloadable at eufaula-lake.web.app.
  const skip = new Set(["node_modules", ".git", "build", "testing", ".firebase"]);
  const skipFilePattern = /-debug\.log$/;
  copyDirExcept(REPO_ROOT, BUILD_DIR, skip, skipFilePattern);

  const indexPath = path.join(BUILD_DIR, "index.html");
  // swapMarketingCopy MUST run before swapIndexHtmlConfig: it does a blind
  // global replace of the literal text "Pauls Valley", and
  // swapIndexHtmlConfig's own output (the OTHER_EDITIONS array) contains
  // the literal string "Pauls Valley Edition" for every edition that
  // links back to production. Running marketing-copy-swap second corrupted
  // that link's label into the current edition's own name (e.g. Eufaula
  // Lake's picker read "Enter Eufaula Lake Town Fuss" instead of "Enter
  // Pauls Valley Town Fuss", pointing at production) — confirmed live on
  // both Eufaula Lake and Tulsa 2026-08-08. Running it first means it only
  // ever touches the original page's actual prose (title, meta tags, hero
  // text, footer), never the freshly-generated config block.
  // ALL_EDITIONS_TOWNS is static source content (not generated by
  // swapIndexHtmlConfig, unlike the old OTHER_EDITIONS array the comment
  // above describes), so it's already present when swapMarketingCopy
  // runs and its "Pauls Valley"/"Pauls Valley Edition" entries got
  // silently mangled into the current edition's own name on every
  // non-production build — the real town vanished from the search and a
  // duplicate-looking entry appeared in its place. Confirmed live on
  // Poteau 2026-08-11 (reported as "Pauls Valley is missing from the
  // search"). Fixed by protecting the array from the blind replace:
  // pull it out, run the marketing swap, put the ORIGINAL text back.
  let rawIndexContent = fs.readFileSync(indexPath, "utf8");
  const townsBlockMatch = rawIndexContent.match(/const ALL_EDITIONS_TOWNS = \[[\s\S]*?\n\];/);
  if (!townsBlockMatch) throw new Error("Could not find ALL_EDITIONS_TOWNS block to protect in index.html");
  const townsBlockOriginal = townsBlockMatch[0];
  const townsPlaceholder = "/* __ALL_EDITIONS_TOWNS_PLACEHOLDER__ */";
  rawIndexContent = rawIndexContent.replace(townsBlockOriginal, townsPlaceholder);

  let indexContent = swapMarketingCopy(rawIndexContent, edition);
  indexContent = indexContent.replace(townsPlaceholder, townsBlockOriginal);
  indexContent = swapIndexHtmlConfig(indexContent, edition);
  indexContent = swapVapidKey(indexContent, edition);
  indexContent = swapOgUrl(indexContent, edition);
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
    "titanspace.html", "war.html", "daily-rewards-verify.html",
    // pirates.html was never added here when the game shipped 2026-08-16 —
    // exactly the same bug class the comment above warns about (missing a
    // new game from this list silently leaves it pointed at production).
    // Confirmed live on all 6 non-Pauls-Valley editions 2026-08-18: every
    // one of them was serving Pauls Valley's own firebaseConfig on
    // pirates.html specifically, while index.html/every other game file
    // was already correct.
    "pirates.html",
  ];
  for (const f of SIMPLE_CONFIG_FILES) {
    const p = path.join(BUILD_DIR, f);
    fs.writeFileSync(p, swapSimpleFirebaseConfig(fs.readFileSync(p, "utf8"), edition, f), "utf8");
  }

  console.log(`Built ${editionId} into ${BUILD_DIR}`);
  console.log(`Deploy with: firebase deploy --only hosting --project ${editionId} --config <path to a firebase.json pointing hosting.public at "build">`);
}

main();
