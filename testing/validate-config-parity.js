// validate-config-parity.js
//
// Catches the exact silent-failure class that hit pirates.html (confirmed
// live on all 6 non-Pauls-Valley editions 2026-08-18, per build-edition.js's
// own comment on that incident): a new game file ships its own embedded
// firebaseConfig block but never gets added to build-edition.js's
// SIMPLE_CONFIG_FILES array. That omission doesn't throw anywhere -- the
// file just silently keeps serving Pauls Valley's production Firebase
// config to every other edition. Every OTHER swap in build-edition.js fails
// loudly (throws if its regex doesn't match); this is the one gap that
// doesn't, because there's nothing to not-match against -- the file is just
// never looked at.
//
// This script closes that gap structurally: it scans every repo-root .html
// file for an embedded `const firebaseConfig = {` block and fails loudly if
// that file isn't listed in SIMPLE_CONFIG_FILES, instead of relying on
// someone remembering to update a checklist by hand. A brand new game file
// is caught automatically, regardless of what it's named.
//
// Run with: node testing/validate-config-parity.js

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BUILD_EDITION_PATH = path.join(__dirname, "build-edition.js");

function extractSimpleConfigFiles(buildEditionSource) {
  const match = buildEditionSource.match(/const SIMPLE_CONFIG_FILES = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error(
      "Could not find SIMPLE_CONFIG_FILES array in build-edition.js -- " +
      "has it been renamed or restructured? Update this script's regex to match."
    );
  }
  const files = [...match[1].matchAll(/"([^"]+\.html)"/g)].map((m) => m[1]);
  if (files.length === 0) {
    throw new Error(
      "SIMPLE_CONFIG_FILES parsed to zero entries -- something is wrong with " +
      "this script's extraction, not necessarily the source file. Don't trust a clean run off this."
    );
  }
  return new Set(files);
}

function main() {
  const buildEditionSource = fs.readFileSync(BUILD_EDITION_PATH, "utf8");
  const registered = extractSimpleConfigFiles(buildEditionSource);

  const rootHtmlFiles = fs.readdirSync(REPO_ROOT).filter((f) => f.endsWith(".html"));
  const missing = [];

  for (const file of rootHtmlFiles) {
    // index.html carries its own firebaseConfig too, but it's swapped by a
    // DIFFERENT mechanism entirely (swapIndexHtmlConfig, matched against the
    // whole EDITION CONFIGURATION block, not the simple per-file swap) --
    // it's correctly never in SIMPLE_CONFIG_FILES. Excluded here on
    // purpose, not an oversight in this check.
    if (file === "index.html") continue;

    const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const hasFirebaseConfig = /const firebaseConfig = \{/.test(content);
    if (hasFirebaseConfig && !registered.has(file)) {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    console.error("CONFIG PARITY CHECK FAILED\n");
    console.error("The following file(s) have their own firebaseConfig block but are NOT");
    console.error("listed in build-edition.js's SIMPLE_CONFIG_FILES array:\n");
    for (const f of missing) console.error(`  - ${f}`);
    console.error(
      "\nThis is exactly the bug class that hit pirates.html on 2026-08-18: a missed " +
      "file silently keeps shipping Pauls Valley's production Firebase config to " +
      "every other edition, with no error anywhere else in the pipeline. Add the " +
      "file(s) above to SIMPLE_CONFIG_FILES in testing/build-edition.js before merging."
    );
    process.exit(1);
  }

  const checkedCount = rootHtmlFiles.filter((f) => f !== "index.html").length;
  console.log(
    `Config parity check passed -- all ${checkedCount} non-index HTML files were ` +
    `checked, and every one with its own firebaseConfig is correctly registered in ` +
    `SIMPLE_CONFIG_FILES (${registered.size} entries).`
  );
}

main();
