// outreach-admin.spec.js
//
// Real functional coverage for the townfuss-outreach-admin tool, run
// against local emulators (never production) — see
// testing/serveOutreachAdmin.js for why this needs its own static server
// alongside `firebase emulators:start`.
//
// Requires, in separate terminals, BOTH:
//   firebase emulators:start
//   node testing/serveOutreachAdmin.js
// Run with: npx playwright test outreach-admin.spec.js

const { test, expect } = require("@playwright/test");
const { admin, makeAdmin } = require("../emulatorAdmin");
const { signInOutreachAdmin } = require("../outreachAuthHelper");

const BASE = "http://127.0.0.1:5050";
const STAMP = Date.now();

async function getUidByEmail(email, retries = 10, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      return user.uid;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`No auth user found for ${email} after ${retries} retries`);
}

// syncAdminClaim (index.js) is a Firestore-triggered function reacting to
// admins/{uid} writes — async, not instant, so poll for it rather than
// assuming it's already applied the moment makeAdmin()'s write resolves.
async function waitForAdminClaim(uid, retries = 60, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const user = await admin.auth().getUser(uid);
    if (user.customClaims?.admin) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`admin custom claim never appeared for ${uid}`);
}

async function signInAsAdmin(page, email) {
  page.on("console", (msg) => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`  [browser pageerror] ${err.message}`));
  page.on("requestfailed", (req) => console.log(`  [browser requestfailed] ${req.url()} — ${req.failure()?.errorText}`));
  await signInOutreachAdmin(page, { email, baseURL: BASE });
  const uid = await getUidByEmail(email);
  await makeAdmin(uid);
  await waitForAdminClaim(uid);
  // The page's own onAuthStateChanged already ran with getIdTokenResult(true)
  // before the claim existed, so it needs a fresh sign-in-state pass now
  // that it does. Re-navigating is the simplest way to get a clean pass
  // with the claim already in place, avoiding any client-side timing
  // assumptions about when to re-check.
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector("#app", { state: "visible", timeout: 15_000 });
  return uid;
}

test("sanity: signs in and reaches the admin app", async ({ page }) => {
  await signInAsAdmin(page, `outreach-sanity-${STAMP}@example.com`);
  await expect(page.locator("#campaign-notes")).toBeVisible();
});

test("campaign notes: survives an out-of-order save race", async ({ page }) => {
  await signInAsAdmin(page, `outreach-notesrace-${STAMP}@example.com`);

  const FIRST_TEXT = "Selling widgets to Pauls Valley";
  const FINAL_TEXT = "Selling widgets to Pauls Valley — mention the fall discount too";
  let firstRequestSeen = false;
  let secondRequestDone = false;
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });

  // Intercept outreachSetSettings calls specifically. Callable functions
  // POST to /<project>/<region>/<functionName> against the Functions
  // emulator — hold the FIRST (partial-text) request open until the
  // SECOND (final-text) one has already completed, simulating exactly
  // the out-of-order arrival a slow cold start can cause for real.
  await page.route("**/outreachSetSettings", async (route) => {
    // A crash anywhere in here (e.g. a bodyless CORS preflight OPTIONS
    // request with no JSON to parse) would leave that request — and
    // potentially this whole route — unresolved forever, silently
    // breaking the entire test. Never let that happen unhandled.
    let notes;
    try {
      const body = route.request().postDataJSON();
      notes = body?.data?.campaignNotes;
    } catch {
      notes = undefined;
    }
    try {
      if (notes === FIRST_TEXT && !firstRequestSeen) {
        firstRequestSeen = true;
        await firstReleased; // don't let this one hit the server until told to
      }
      await route.continue();
      if (notes === FINAL_TEXT) secondRequestDone = true;
    } catch (err) {
      console.log(`  [route handler error] ${err.message}`);
      await route.continue().catch(() => {});
    }
  });

  const notesBox = page.locator("#campaign-notes");
  await notesBox.click();
  await notesBox.fill(FIRST_TEXT);
  // Long enough for the 1.5s debounce to actually fire the first save.
  await page.waitForTimeout(1800);

  await notesBox.fill(FINAL_TEXT);
  await page.waitForTimeout(1800);
  // Give the (unblocked) second request a moment to actually finish.
  await expect.poll(() => secondRequestDone, { timeout: 5000 }).toBe(true);

  // NOW let the stale first request through, well after the real one landed.
  releaseFirst();
  await page.waitForTimeout(1000);

  const snap = await admin.firestore().collection("outreachSettings").doc("config").get();
  expect(snap.data()?.campaignNotes).toBe(FINAL_TEXT);
});

test("queue table: checking one candidate's box doesn't check the other", async ({ page }) => {
  const email = `outreach-queuecb-${STAMP}@example.com`;
  await signInAsAdmin(page, email);

  const idA = `test-cand-a-${STAMP}`;
  const idB = `test-cand-b-${STAMP}`;
  await admin.firestore().collection("outreachCandidates").doc(idA).set({
    companyName: "Alpha Test Co", phone: "", website: `https://alpha-${STAMP}.example.com`, address: "", email: `alpha-${STAMP}@example.com`, town: "Pauls Valley", status: "queued", searchedAt: admin.firestore.Timestamp.now(),
  });
  await admin.firestore().collection("outreachCandidates").doc(idB).set({
    companyName: "Beta Test Co", phone: "", website: `https://beta-${STAMP}.example.com`, address: "", email: `beta-${STAMP}@example.com`, town: "Pauls Valley", status: "queued", searchedAt: admin.firestore.Timestamp.now(),
  });

  // "This week's queue" panel loads on sign-in via loadQueue() — reload
  // to make sure this test's freshly-seeded docs are what's showing,
  // independent of load order relative to the seeding above.
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector("#app", { state: "visible", timeout: 15_000 });

  const rowA = page.locator(`#queue-table-wrap tr[data-id="${idA}"]`);
  const rowB = page.locator(`#queue-table-wrap tr[data-id="${idB}"]`);
  await expect(rowA).toBeVisible({ timeout: 10_000 });
  await expect(rowB).toBeVisible();

  const checkA = rowA.locator(".cand-check");
  const checkB = rowB.locator(".cand-check");
  await expect(checkA).not.toBeChecked();
  await expect(checkB).not.toBeChecked();

  await checkA.check();

  await expect(checkA).toBeChecked();
  await expect(checkB).not.toBeChecked(); // <-- this is the actual bug assertion
});

test("manual add lead: appears in Today's leads to draft", async ({ page }) => {
  await signInAsAdmin(page, `outreach-manuallead-${STAMP}@example.com`);

  const leadEmail = `manual-lead-${STAMP}@example.com`;
  await page.fill("#manual-name", "Manual Test Business");
  await page.fill("#manual-email", leadEmail);
  await page.fill("#manual-town", "Pauls Valley");
  await page.click("#manual-form button[type=submit]");
  await expect(page.locator("#manual-message")).toContainText("Added", { timeout: 10_000 });

  await page.click("#load-leads-btn");
  await expect(page.locator(`.lead-card[data-email="${leadEmail}"]`)).toBeVisible({ timeout: 10_000 });
});

test("review businesses: checking and queueing only affects the checked candidate", async ({ page }) => {
  await signInAsAdmin(page, `outreach-reviewqueue-${STAMP}@example.com`);

  const idC = `test-cand-c-${STAMP}`;
  const idD = `test-cand-d-${STAMP}`;
  await admin.firestore().collection("outreachCandidates").doc(idC).set({
    companyName: "Gamma Test Co", phone: "", website: `https://gamma-${STAMP}.example.com`, address: "", email: `gamma-${STAMP}@example.com`, town: "Pauls Valley", status: "candidate", searchedAt: admin.firestore.Timestamp.now(),
  });
  await admin.firestore().collection("outreachCandidates").doc(idD).set({
    companyName: "Delta Test Co", phone: "", website: `https://delta-${STAMP}.example.com`, address: "", email: `delta-${STAMP}@example.com`, town: "Pauls Valley", status: "candidate", searchedAt: admin.firestore.Timestamp.now(),
  });

  await page.click("#load-candidates-btn");
  const rowC = page.locator(`#candidates-table-wrap tr[data-id="${idC}"]`);
  const rowD = page.locator(`#candidates-table-wrap tr[data-id="${idD}"]`);
  await expect(rowC).toBeVisible({ timeout: 10_000 });
  await expect(rowD).toBeVisible();

  await rowC.locator(".cand-check").check();
  await expect(rowD.locator(".cand-check")).not.toBeChecked();

  await page.click("#queue-checked-btn");
  await expect(page.locator("#candidates-message")).toContainText("Added 1", { timeout: 10_000 });

  const snapC = await admin.firestore().collection("outreachCandidates").doc(idC).get();
  const snapD = await admin.firestore().collection("outreachCandidates").doc(idD).get();
  expect(snapC.data().status).toBe("queued");
  expect(snapD.data().status).toBe("candidate"); // must NOT have been affected
});
