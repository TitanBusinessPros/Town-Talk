// validate-function-coverage.js
//
// Catches a specific silent-gap class: a new Cloud Function gets added to
// index.js, but nobody adds a matching test AND registers it in
// testing/function-coverage.js. Neither omission throws anywhere else --
// the function just deploys and quietly has zero coverage, the same way a
// missed build-edition.js SIMPLE_CONFIG_FILES entry silently ships the
// wrong Firebase config (see testing/validate-config-parity.js, which this
// script is deliberately modeled on).
//
// What this checks, in order:
//   1. Every exports.X in index.js has an entry in function-coverage.js.
//   2. Every entry's spec file actually exists in testing/tests/.
//   3. Every entry's spec file is wired into .github/workflows/ci.yml's
//      test-matrix (a spec file that exists on disk but was never added to
//      any matrix group's `specs:` string silently never runs in CI at
//      all -- confirmed as a real, separate gap class on this repo before,
//      see the ci.yml consolidation commit history).
//
// What this deliberately does NOT check: that the registered test's
// assertions are actually meaningful, or that the test currently passes.
// Same trust model as SIMPLE_CONFIG_FILES -- the registry entry is a human
// (or Claude) claim that real coverage exists; this script only catches
// the OMISSION of that claim, not whether the claim itself is honest. See
// function-coverage.js's own header for why a fully automatic check
// (grepping test file text for the function's name) doesn't work here.
//
// Run with: node testing/validate-function-coverage.js

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const INDEX_JS_PATH = path.join(REPO_ROOT, "index.js");
const SPEC_DIR = path.join(__dirname, "tests");
const CI_YML_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

function getExportedFunctionNames() {
  const src = fs.readFileSync(INDEX_JS_PATH, "utf8");
  const names = [...src.matchAll(/^exports\.(\w+)/gm)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(
      "Found zero `exports.X` lines in index.js -- something is wrong with this script's " +
      "extraction, not necessarily index.js itself. Don't trust a clean run off this."
    );
  }
  return names;
}

function getSpecFilesWiredIntoCi() {
  const yaml = fs.readFileSync(CI_YML_PATH, "utf8");
  const wired = new Set();
  for (const m of yaml.matchAll(/specs:\s*"([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((s) => wired.add(s));
  }
  // outreach-admin-test's job runs a single named spec file directly
  // (`npx playwright test outreach-admin.spec.js`), not via a `specs:`
  // matrix string like test-matrix's groups -- catch that pattern too.
  for (const m of yaml.matchAll(/npx playwright test ([\w.\- ]+\.spec\.js)/g)) {
    m[1].split(/\s+/).forEach((s) => wired.add(s));
  }
  return wired;
}

function main() {
  const functionNames = getExportedFunctionNames();
  const coverage = require(path.join(__dirname, "function-coverage.js"));
  const EXTERNAL_OUTREACH_SUBSYSTEM = coverage.EXTERNAL_OUTREACH_SUBSYSTEM;
  const specFilesOnDisk = new Set(fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith(".spec.js")));
  const specFilesInCi = getSpecFilesWiredIntoCi();

  const missingEntry = [];
  const specFileNotOnDisk = [];
  const specFileNotInCi = [];
  // Functions whose registry entry is the EXTERNAL_OUTREACH_SUBSYSTEM
  // marker -- a real, deliberate classification (see function-coverage.js's
  // own comment on it), not a gap. Tracked and reported separately so they
  // stay fully visible rather than silently vanishing from either count.
  const externalOutreach = [];
  // Town Fuss's OWN functions -- everything except the external-outreach
  // set -- is what "core coverage" below is measured against.
  const coreFunctionNames = [];

  for (const name of functionNames) {
    const specFile = coverage[name];
    if (specFile === EXTERNAL_OUTREACH_SUBSYSTEM) {
      externalOutreach.push(name);
      continue;
    }
    coreFunctionNames.push(name);
    if (!specFile) {
      missingEntry.push(name);
      continue;
    }
    if (!specFilesOnDisk.has(specFile)) {
      specFileNotOnDisk.push(`${name} -> ${specFile}`);
    }
    if (!specFilesInCi.has(specFile)) {
      specFileNotInCi.push(`${name} -> ${specFile}`);
    }
  }

  // Also flag registry entries for functions that no longer exist --
  // otherwise a renamed/removed function leaves a stale, misleading entry
  // behind forever instead of ever being noticed.
  const functionNameSet = new Set(functionNames);
  const staleEntries = Object.keys(coverage).filter((name) => !functionNameSet.has(name));

  const problems = [];
  if (missingEntry.length > 0) {
    problems.push(
      `${missingEntry.length} exported function(s) have NO entry in testing/function-coverage.js:\n` +
      missingEntry.map((n) => `  - ${n}`).join("\n") +
      `\n\nAdd a real test that exercises each one, then register it in testing/function-coverage.js. ` +
      `Don't add a guessed/placeholder entry just to silence this check.`
    );
  }
  if (specFileNotOnDisk.length > 0) {
    problems.push(
      `${specFileNotOnDisk.length} registry entr(y/ies) point at a spec file that doesn't exist in testing/tests/:\n` +
      specFileNotOnDisk.map((s) => `  - ${s}`).join("\n")
    );
  }
  if (specFileNotInCi.length > 0) {
    problems.push(
      `${specFileNotInCi.length} registry entr(y/ies) point at a spec file that exists but isn't wired into ` +
      `.github/workflows/ci.yml's test matrix, so it never actually runs in CI:\n` +
      specFileNotInCi.map((s) => `  - ${s}`).join("\n")
    );
  }
  if (staleEntries.length > 0) {
    problems.push(
      `${staleEntries.length} entr(y/ies) in testing/function-coverage.js reference function(s) that no ` +
      `longer exist in index.js (renamed or removed?) -- remove the stale entr(y/ies):\n` +
      staleEntries.map((n) => `  - ${n}`).join("\n")
    );
  }

  if (problems.length > 0) {
    console.error("FUNCTION COVERAGE CHECK FAILED\n");
    console.error(problems.join("\n\n"));
    process.exit(1);
  }

  // Two counts, always shown separately and in full -- external-outreach
  // functions are real, deployed, live functions (see
  // function-coverage.js's EXTERNAL_OUTREACH_SUBSYSTEM comment); they are
  // deliberately excluded from Town Fuss's OWN coverage count, not hidden
  // from the report entirely.
  const coreCoveredCount = coreFunctionNames.length - missingEntry.length;
  console.log(
    `Function coverage check passed.\n\n` +
    `Town Fuss core Functions: ${coreCoveredCount} / ${coreFunctionNames.length} covered\n` +
    `External outreach subsystem Functions: 0 / ${externalOutreach.length} with verified automated coverage; separately tracked\n` +
    (externalOutreach.length > 0
      ? `  (belongs to the separate TF-Email-Agent-1 repo / townfuss-outreach.web.app -- still deployed live from this repo's index.js in all 7 Town Fuss projects; not deleted, disabled, safe-by-default, or covered elsewhere -- confirmed 2026-08-30 that TF-Email-Agent-1 itself has no tests and no CI)\n` +
        externalOutreach.map((n) => `  - ${n}`).join("\n") + "\n"
      : "")
  );
}

main();
