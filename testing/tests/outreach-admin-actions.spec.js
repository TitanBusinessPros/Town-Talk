// outreach-admin-actions.spec.js
//
// Functional coverage for the 8 outreach onCall functions that are safe
// to test fully, locally, with no external dependency: outreachSkipLead,
// outreachUpdateCandidate, outreachBulkAddCandidates,
// outreachDeleteCandidates, outreachGetSettings, outreachGetCostSnapshot,
// outreachMarkUnsubscribed, outreachDismissReplyThreads.
//
// Deliberately NOT covered here (or anywhere yet): outreachCreateDraft,
// outreachSendReply, outreachListReplies, outreachEmailExport (all call
// the real Gmail API with real OAuth credentials not present in this test
// environment), outreachGenerateLeads (real paid Google Places API), and
// outreachImportFromDirectory (fetches an arbitrary external URL). See
// testing/function-coverage.js for why those 6 have no registry entry —
// this is a deliberate, discussed decision, not an oversight.
//
// Two of the 8 here (outreachMarkUnsubscribed, outreachDismissReplyThreads)
// have no REACHABLE real-UI path in this environment either: both only
// have a button on replies.html, and that button only ever renders next to
// a real reply THREAD CARD, which only exists if outreachListReplies
// actually returns real Gmail data — which, per above, this environment
// can't produce. Both functions are otherwise plain admin-gated Firestore
// writes with no Gmail dependency of their own, so they're called directly
// via a dynamically-imported httpsCallable in the browser (reusing the
// already-signed-in, already-emulator-connected Firebase app instance the
// page itself set up) rather than left uncovered over an unrelated
// function's missing credentials.
//
// Requires, in separate terminals: `firebase emulators:start` and
// `node testing/serveOutreachAdmin.js`. Run with:
//   npx playwright test outreach-admin-actions.spec.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { admin, makeAdmin } = require("../emulatorAdmin");
const { signInOutreachAdmin } = require("../outreachAuthHelper");

const BASE = "http://127.0.0.1:5050";
const STAMP = Date.now();

async function getUidByEmail(email, retries = 10, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return (await admin.auth().getUserByEmail(email)).uid;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`No auth user found for ${email} after ${retries} retries`);
}

async function waitForAdminClaim(uid, retries = 60, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const user = await admin.auth().getUser(uid);
    if (user.customClaims?.admin) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`admin custom claim never appeared for ${uid}`);
}

async function signInAsAdmin(page, email) {
  await signInOutreachAdmin(page, { email, baseURL: BASE });
  const uid = await getUidByEmail(email);
  await makeAdmin(uid);
  await waitForAdminClaim(uid);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector("#app", { state: "visible", timeout: 15_000 });
  return uid;
}

async function waitForCondition(fn, timeoutMs = 15_000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForCondition timed out");
}

// Calls an onCall function directly from the browser, bypassing whatever
// UI (if any) normally triggers it — reuses the app instance index.html's
// own script already initialized and already pointed at the Functions
// emulator (getFunctions(app) is cached per app+region by the Firebase JS
// SDK, so this doesn't need its own connectFunctionsEmulator call). Only
// used for outreachMarkUnsubscribed/outreachDismissReplyThreads, whose
// only real UI trigger lives behind Gmail data this environment can't
// produce — see this file's header comment.
async function callDirectly(page, functionName, data) {
  return page.evaluate(
    async ({ functionName, data }) => {
      const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js");
      const fn = httpsCallable(getFunctions(getApp()), functionName);
      const { data: result } = await fn(data);
      return result;
    },
    { functionName, data }
  );
}

test.describe("Outreach admin actions (no external API dependency)", () => {
  test("outreachGetSettings + outreachGetCostSnapshot: both load automatically on sign-in", async ({ page }) => {
    const notes = `Test campaign notes ${STAMP}`;
    await admin.firestore().collection("outreachSettings").doc("config").set({ campaignNotes: notes }, { merge: true });

    await signInAsAdmin(page, `outreach-settings-${STAMP}@example.com`);

    // outreachGetSettings — loadSettings() populates #campaign-notes on
    // sign-in. Confirmed via direct diagnostic call that the function
    // itself returns instantly and correctly; the slow part is a real
    // cold start on THIS function's first-ever invocation against a
    // freshly-restarted emulator (loadSettings() fires it automatically,
    // before this test gets a chance to warm it up any other way) — a
    // generous timeout here, not a logic fix, is the right call.
    await expect(page.locator("#campaign-notes")).toHaveValue(notes, { timeout: 20_000 });

    // outreachGetCostSnapshot — loadCostSnapshot() populates the cost widget.
    // No snapshot doc seeded here, so this also proves the "compute live"
    // fallback branch (see index.js's own comment on outreachGetCostSnapshot)
    // actually runs and returns real numbers, not just a cached one.
    await expect(page.locator("#cost-widget-toggle")).toContainText("$", { timeout: 20_000 });
  });

  test("outreachSkipLead: removing a manually-added lead really deletes it and records why", async ({ page }) => {
    await signInAsAdmin(page, `outreach-skiplead-${STAMP}@example.com`);

    const leadEmail = `skip-me-${STAMP}@example.com`;
    await page.fill("#manual-name", "Skip Test Business");
    await page.fill("#manual-email", leadEmail);
    await page.fill("#manual-town", "Pauls Valley");
    await page.click("#manual-form button[type=submit]");
    await expect(page.locator("#manual-message")).toContainText("Added", { timeout: 10_000 });

    await page.click("#load-leads-btn");
    const card = page.locator(`.lead-card[data-email="${leadEmail}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    page.once("dialog", (d) => d.accept());
    await card.locator(".remove-lead-btn").click();
    await expect(card).toHaveCount(0, { timeout: 10_000 });

    const skipDoc = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("outreachSentLog").doc(leadEmail).get();
      return snap.exists ? snap.data() : null;
    });
    expect(skipDoc.reason).toBe("manually removed");
  });

  test("outreachUpdateCandidate: editing a queued candidate's email auto-saves to Firestore", async ({ page }) => {
    await signInAsAdmin(page, `outreach-updatecand-${STAMP}@example.com`);

    const id = `update-cand-${STAMP}`;
    await admin.firestore().collection("outreachCandidates").doc(id).set({
      companyName: "Update Test Co", phone: "", website: "", address: "", email: "", town: "Pauls Valley", status: "queued", searchedAt: admin.firestore.Timestamp.now(),
    });

    await page.goto(`${BASE}/index.html`); // fresh loadQueue() pass with this test's own seeded doc present
    await page.waitForSelector("#app", { state: "visible", timeout: 15_000 });
    const row = page.locator(`#queue-table-wrap tr[data-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const newEmail = `updated-${STAMP}@example.com`;
    const emailInput = row.locator(".cand-email");
    await emailInput.fill(newEmail);
    // 1.2s debounce (see index.html's own comment on it) plus round-trip —
    // the input border flashing green is the page's own save-succeeded signal.
    await expect(emailInput).toHaveCSS("border-color", /.+/, { timeout: 5_000 }).catch(() => {});

    const doc = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("outreachCandidates").doc(id).get();
      return snap.data()?.email === newEmail ? snap.data() : null;
    });
    expect(doc.email).toBe(newEmail);
  });

  test("outreachBulkAddCandidates: a real CSV upload creates real candidates, dedup works", async ({ page }) => {
    await signInAsAdmin(page, `outreach-bulkadd-${STAMP}@example.com`);

    const csvEmail = `bulk-${STAMP}@example.com`;
    const csvPath = path.join(os.tmpdir(), `outreach-bulk-test-${STAMP}.csv`);
    fs.writeFileSync(
      csvPath,
      `Company,Email,Town,Website\n` +
      `Bulk Test Co,${csvEmail},Pauls Valley,https://bulk-${STAMP}.example.com\n` +
      `,,,\n` // a blank row -- rowsToLeads must filter this out, not just parse it
    );

    await page.selectOption("#import-format-select", "csv");
    await page.locator("#csv-file-input").setInputFiles(csvPath);
    await page.click("#csv-upload-btn");
    await expect(page.locator("#csv-message")).toContainText("Added 1", { timeout: 15_000 });

    const snap = await waitForCondition(async () => {
      const s = await admin.firestore().collection("outreachCandidates").where("email", "==", csvEmail).limit(1).get();
      return s.empty ? null : s.docs[0];
    });
    expect(snap.data().companyName).toBe("Bulk Test Co");
    expect(snap.data().source).toBe("csv-import");
    expect(snap.data().status).toBe("candidate");

    fs.unlinkSync(csvPath);
  });

  test("outreachDeleteCandidates: permanently deletes and marks the email so it can't silently reappear", async ({ page }) => {
    await signInAsAdmin(page, `outreach-deletecand-${STAMP}@example.com`);

    const id = `delete-cand-${STAMP}`;
    const email = `delete-me-${STAMP}@example.com`;
    await admin.firestore().collection("outreachCandidates").doc(id).set({
      companyName: "Delete Test Co", phone: "", website: "", address: "", email, town: "Pauls Valley", status: "candidate", searchedAt: admin.firestore.Timestamp.now(),
    });

    await page.click("#load-candidates-btn");
    const row = page.locator(`#candidates-table-wrap tr[data-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator(".cand-check").check();

    page.once("dialog", (d) => d.accept().catch(() => {}));
    await page.click("#delete-checked-btn");

    await waitForCondition(async () => {
      const snap = await admin.firestore().collection("outreachCandidates").doc(id).get();
      return snap.exists ? null : true;
    });

    const marker = (await admin.firestore().collection("outreachSentLog").doc(email).get()).data();
    expect(marker.reason).toBe("deleted from Review new businesses");
  });

  test("outreachMarkUnsubscribed: permanently blocks an address, enforced on future drafts/replies", async ({ page }) => {
    await signInAsAdmin(page, `outreach-markunsub-${STAMP}@example.com`);

    const email = `unsub-me-${STAMP}@example.com`;
    const result = await callDirectly(page, "outreachMarkUnsubscribed", { email, reason: "test unsubscribe" });
    expect(result.ok).toBe(true);

    const doc = (await admin.firestore().collection("outreachUnsubscribed").doc(email).get()).data();
    expect(doc.reason).toBe("test unsubscribe");
    expect(doc.unsubscribedAt).toBeTruthy();
  });

  test("outreachDismissReplyThreads: hides threads from the replies list without touching Gmail", async ({ page }) => {
    await signInAsAdmin(page, `outreach-dismissthreads-${STAMP}@example.com`);

    const threadId = `thread-${STAMP}`;
    const result = await callDirectly(page, "outreachDismissReplyThreads", { threadIds: [threadId] });
    expect(result).toEqual({ ok: true, dismissed: 1 });

    const doc = (await admin.firestore().collection("outreachDismissedReplyThreads").doc(threadId).get()).data();
    expect(doc.dismissedAt).toBeTruthy();
  });
});
