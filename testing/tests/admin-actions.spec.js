// admin-actions.spec.js
//
// Functional coverage for adminGrantGold — previously untested. Admin-only
// Cloud Function that gifts a fellow member a 1-year Gold membership,
// rate-limited to 3 grants/day per admin (not platform-wide).
//
// Deliberately reached via Directory search (#nav-directory), not the
// Feed — loadDirectory()'s query (index.html) has no per-town top-21
// friendCount slice the way loadFeed() does, which chatsponsor-townfounder
// .spec.js/tier-limits.spec.js/admin-delete-restore.spec.js all had to add
// afterAll cleanup for (2026-08-29, fixing full-platform.spec.js's Feed
// test intermittently missing Robot Bob). Reaching the admin buttons via
// Directory instead means this file's target profiles never need a
// profile.neighborhood field at all — nothing to compete for, nothing to
// clean up on that front.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test admin-actions.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, makeAdmin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const STAMP = Date.now();
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ADMIN_GOLD_GRANTS_PER_DAY = 3;

function todayNumber() {
  return Math.floor(Date.now() / 86400000);
}

// Tracked here so afterAll can clean up exactly what this file created —
// nothing more, nothing less — and never touch another spec's data.
// Every delete below is wrapped so an already-removed record can't fail
// cleanup (idempotent).
const createdUserUids = [];
const createdAdminUids = [];

async function signUpApprovedTarget(browser, email, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signUpWithGoogle(page, { email, displayName: name });
  const uid = await verifyEmailByAddress(email);
  await context.close(); // before the admin-SDK write below — same watchUserDoc race admin-delete-restore.spec.js's header comment documents
  // No profile.neighborhood on purpose — see file header comment.
  await admin.firestore().collection("users").doc(uid).set(
    { approved: true, agreedToTerms: true, profile: { name } },
    { merge: true }
  );
  createdUserUids.push(uid);
  return uid;
}

// No window.adminGrantGoldCallable bridge exists on index.html (unlike
// adminDeleteProfile/adminRestoreProfile), so this dynamically imports the
// SDK fresh inside the page — same mechanism outreach-admin-actions.spec.js's
// own callDirectly() uses — but wraps it in a try/catch INSIDE the
// evaluate (like admin-delete-restore.spec.js's callAdminDelete/
// callAdminRestore) so a rejection returns a clean, serializable
// {ok, code, message} instead of throwing across the evaluate boundary.
async function callFunction(page, functionName, data) {
  return page.evaluate(
    async ({ functionName, data }) => {
      try {
        const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
        const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js");
        const fn = httpsCallable(getFunctions(getApp()), functionName);
        const { data: result } = await fn(data);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, code: err.code, message: err.message };
      }
    },
    { functionName, data }
  );
}

test.describe.serial("adminGrantGold", () => {
  test.setTimeout(120_000);
  let adminContext, adminPage, adminUid;
  let targetUid, targetName;

  test("Sign up an admin and grant admin rights", async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    const adminEmail = `admact.admin.${STAMP}@test.town`;
    await signUpWithGoogle(adminPage, { email: adminEmail, displayName: "AdmAct Admin" });
    adminUid = await verifyEmailByAddress(adminEmail);
    createdAdminUids.push(adminUid);
    await admin.firestore().collection("users").doc(adminUid).set(
      { approved: true, agreedToTerms: true, profile: { name: "AdmAct Admin" } },
      { merge: true }
    );
    await makeAdmin(adminUid);
    await adminPage.evaluate(() => sessionStorage.setItem("adminPinVerified", "true"));
    await adminPage.reload();
    await expect(adminPage.locator("#nav-directory")).toBeVisible({ timeout: 20_000 });
  });

  test("Grant Gold via the real Directory UI sets isGoldMember, a ~1-year expiry, and reports the remaining count", async () => {
    targetName = `AdmAct Target ${STAMP}`;
    targetUid = await signUpApprovedTarget(adminContext.browser(), `admact.target.${STAMP}@test.town`, targetName);

    await adminPage.locator("#nav-directory").click();
    await adminPage.locator("#directory-search").fill(targetName);
    await adminPage.locator(`.directory-card:has-text("${targetName}")`).click();

    // The real UI shows a confirm() prompt, then reports success via a
    // real alert() (index.html's admin-grant-gold-btn click handler) — a
    // single persistent listener discriminating by dialog.type() is used
    // instead of two separate .once() handlers, since both native dialogs
    // fire the SAME "dialog" event and two pre-registered .once() calls
    // would both race the FIRST dialog rather than one covering each in
    // order.
    let alertText = null;
    const dialogHandler = async (dialog) => {
      if (dialog.type() === "confirm") {
        await dialog.accept();
      } else if (dialog.type() === "alert") {
        alertText = dialog.message();
        await dialog.accept();
      }
    };
    adminPage.on("dialog", dialogHandler);

    const grantStart = Date.now();
    await adminPage.locator(".admin-grant-gold-btn").click();
    await expect.poll(() => alertText, { timeout: 10_000 }).not.toBeNull();
    const grantEnd = Date.now();
    adminPage.off("dialog", dialogHandler);

    // First grant of the day for this fresh admin: 3 - 1 = 2 remaining.
    expect(alertText).toContain(`${ADMIN_GOLD_GRANTS_PER_DAY - 1} grant(s) left today`);

    const targetDoc = await admin.firestore().collection("users").doc(targetUid).get();
    expect(targetDoc.data().isGoldMember).toBe(true);

    // Bounded tolerance around one year from the grant, not an exact
    // millisecond comparison — the write happens somewhere between
    // grantStart (before the click) and grantEnd (after the alert fires).
    const expiresMs = targetDoc.data().goldExpiresAt.toDate().getTime();
    const toleranceMs = 5 * 60 * 1000; // 5 minutes
    expect(expiresMs).toBeGreaterThan(grantStart + ONE_YEAR_MS - toleranceMs);
    expect(expiresMs).toBeLessThan(grantEnd + ONE_YEAR_MS + toleranceMs);
  });

  test("A non-admin direct callable attempt is rejected with permission-denied", async ({ browser }) => {
    const email = `admact.nonadmin.${STAMP}@test.town`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUpWithGoogle(page, { email, displayName: "AdmAct NonAdmin" });
    const uid = await verifyEmailByAddress(email);
    createdUserUids.push(uid);

    const result = await callFunction(page, "adminGrantGold", { targetUid: "irrelevant" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("functions/permission-denied");

    await context.close();
  });

  test("A nonexistent targetUid is rejected with not-found", async () => {
    const result = await callFunction(adminPage, "adminGrantGold", { targetUid: `no-such-uid-${STAMP}` });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("functions/not-found");
  });

  test("The same admin's 4th grant on the same calendar day is rejected with resource-exhausted", async () => {
    // Jump straight to "already granted 3 today" — same boundary-seeding
    // pattern tier-limits.spec.js uses for gamePlayLimits/messageLimits —
    // rather than clicking the real UI 3 times first. Overwrites (not
    // merges) whatever the previous grant test left behind, so there's no
    // leakage between that test's real count and this one's seeded value.
    await admin.firestore().collection("adminGoldGrantLimits").doc(adminUid).set({
      day: todayNumber(),
      count: ADMIN_GOLD_GRANTS_PER_DAY,
    });

    const result = await callFunction(adminPage, "adminGrantGold", { targetUid });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("functions/resource-exhausted");
  });

  test.afterAll(async () => {
    for (const uid of createdUserUids) {
      await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
      await admin.auth().deleteUser(uid).catch(() => {});
    }
    for (const uid of createdAdminUids) {
      await admin.firestore().collection("admins").doc(uid).delete().catch(() => {});
      await admin.firestore().collection("adminGoldGrantLimits").doc(uid).delete().catch(() => {});
      await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
      await admin.auth().deleteUser(uid).catch(() => {});
    }
  });
});
