// admin-delete-restore.spec.js
//
// Deep functional coverage for admin profile deletion — added 2026-08-02,
// same day the feature shipped. Any admin can delete a profile from that
// person's full profile view; every deletion re-prompts for the admin PIN
// (a separate, always-ask modal — unlike the session-gated one elsewhere
// that only verifies once per tab); deleting more than 3 profiles within a
// rolling 3-minute window starts a server-enforced 30-minute cooldown; a
// deleted profile is archived for 10 days and can be restored with the
// PIN, which also re-enables the Auth account deleting disabled.
//
// This spec deliberately does NOT type the real admin PIN anywhere —
// wrong-PIN rejection is tested through the real UI (doesn't need the
// real value), and the actual delete/restore functional correctness is
// tested by calling the exposed window.adminDeleteProfileCallable /
// window.adminRestoreProfileCallable bridges directly (index.html) —
// legitimate, since the PIN is only ever a client-side speed bump; the
// real security boundary is the isAdmin() check inside the Cloud
// Functions themselves, which this exercises for real either way.
//
// IMPORTANT test-harness gotcha found while building this: a target
// robot's OWN signup page must be closed before writing to their profile
// via the admin SDK. index.html's watchUserDoc() self-heals a MISSING
// doc by writing a fresh blank default the moment it notices one for a
// signed-in user — if that robot's page is still open and its listener
// fires after our admin-SDK write (a real race, not a rare one), it wins
// and clobbers approved:true/profile back to blank. Every target robot
// below closes its context immediately after signup, before the
// admin-SDK write, to avoid this entirely.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test admin-delete-restore.spec.js

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin, makeAdmin } = require("../emulatorAdmin");

const STAMP = Date.now();

async function signUpTarget(browser, email, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("#signup-email").fill(email);
  await page.locator("#signup-password").fill("TestPass123!");
  await page.locator("#signup-age-confirm").check();
  await page.locator("#signup-terms-confirm").check();
  await page.locator("#form-signup button[type=submit]").click();
  const uid = await verifyEmailByAddress(email);
  await context.close(); // before the admin-SDK write below — see file header
  await admin.firestore().collection("users").doc(uid).set(
    { approved: true, agreedToTerms: true, profile: { name, neighborhood: "Pauls Valley" } },
    { merge: true }
  );
  return { uid, name, email };
}

async function callAdminDelete(page, targetUid) {
  return page.evaluate(async (uid) => {
    try {
      await window.adminDeleteProfileCallable({ targetUid: uid });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code, message: err.message };
    }
  }, targetUid);
}

async function callAdminRestore(page, targetUid) {
  return page.evaluate(async (uid) => {
    try {
      await window.adminRestoreProfileCallable({ targetUid: uid });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code, message: err.message };
    }
  }, targetUid);
}

test.describe.serial("Admin profile delete/restore", () => {
  test.setTimeout(120_000);
  let adminContext, adminPage, adminUid;
  let b, c, d, e;

  test("Sign up an admin and grant admin rights", async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    await adminPage.goto("/index.html");
    await adminPage.getByRole("button", { name: "Sign up" }).click();
    await adminPage.locator("#signup-email").fill(`admdel.admin.${STAMP}@test.town`);
    await adminPage.locator("#signup-password").fill("TestPass123!");
    await adminPage.locator("#signup-age-confirm").check();
    await adminPage.locator("#signup-terms-confirm").check();
    await adminPage.locator("#form-signup button[type=submit]").click();
    adminUid = await verifyEmailByAddress(`admdel.admin.${STAMP}@test.town`);
    await admin.firestore().collection("users").doc(adminUid).set(
      { approved: true, agreedToTerms: true, profile: { name: "AdminDel Admin" } },
      { merge: true }
    );
    await makeAdmin(adminUid);
    // Bypasses only the session-gated PIN popup (verified once per tab) —
    // the delete/restore PIN modal tested below is a SEPARATE modal that
    // always re-prompts regardless of this flag.
    await adminPage.evaluate(() => sessionStorage.setItem("adminPinVerified", "true"));
  });

  test("Sign up throwaway target profiles B, C, D, E", async ({ browser }) => {
    b = await signUpTarget(browser, `admdel.b.${STAMP}@test.town`, `AdmDelB${STAMP}`);
    c = await signUpTarget(browser, `admdel.c.${STAMP}@test.town`, `AdmDelC${STAMP}`);
    d = await signUpTarget(browser, `admdel.d.${STAMP}@test.town`, `AdmDelD${STAMP}`);
    e = await signUpTarget(browser, `admdel.e.${STAMP}@test.town`, `AdmDelE${STAMP}`);
    expect((await admin.firestore().collection("users").doc(b.uid).get()).data().approved).toBe(true);
  });

  test("A wrong PIN is rejected on the real delete-confirmation modal", async () => {
    await adminPage.goto("/index.html");
    await adminPage.locator("#nav-directory").click();
    await adminPage.locator("#directory-search").fill(b.name);
    await adminPage.locator(`.directory-card:has-text("${b.name}")`).click();
    await adminPage.locator(".admin-delete-profile-btn").click();
    await expect(adminPage.locator("#delete-pin-modal-backdrop")).toBeVisible();

    await adminPage.locator("#delete-pin-input").fill("00000000");
    await adminPage.locator("#delete-pin-confirm-btn").click();
    await expect(adminPage.locator("#delete-pin-message")).toContainText("Incorrect PIN");

    // The profile must still exist — a rejected PIN must never call through.
    await adminPage.locator("#delete-pin-cancel-btn").click();
    expect((await admin.firestore().collection("users").doc(b.uid).get()).exists).toBe(true);
  });

  test("Deleting B archives the profile and disables their Auth account", async () => {
    const result = await callAdminDelete(adminPage, b.uid);
    expect(result.ok).toBe(true);

    expect((await admin.firestore().collection("users").doc(b.uid).get()).exists).toBe(false);
    const archived = (await admin.firestore().collection("deletedUsers").doc(b.uid).get()).data();
    expect(archived.profileData.profile.name).toBe(b.name);
    expect(archived.deletedBy).toBe(adminUid);

    const authUser = await admin.auth().getUser(b.uid);
    expect(authUser.disabled).toBe(true);
  });

  test("B can no longer sign in while deleted", async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto("/index.html");
    await page.locator("#login-email").fill(b.email);
    await page.locator("#login-password").fill("TestPass123!");
    await page.locator("#form-login button[type=submit]").click();
    await expect(page.locator("#login-message")).toContainText("disabled");
    await expect(page.locator("#nav-dashboard")).toBeHidden();
  });

  test("Restoring B brings the exact profile back and re-enables login", async () => {
    const result = await callAdminRestore(adminPage, b.uid);
    expect(result.ok).toBe(true);

    const restored = (await admin.firestore().collection("users").doc(b.uid).get()).data();
    expect(restored.profile.name).toBe(b.name);
    expect((await admin.firestore().collection("deletedUsers").doc(b.uid).get()).exists).toBe(false);

    const authUser = await admin.auth().getUser(b.uid);
    expect(authUser.disabled).toBe(false);
  });

  test("A 4th delete within 3 minutes is blocked by the server-enforced cooldown", async () => {
    // B's restore doesn't count against the delete rate limit — only
    // actual deletes do. This admin has deleted exactly 1 profile (B) so
    // far in this test run, so C and D are the 2nd and 3rd.
    const resultC = await callAdminDelete(adminPage, c.uid);
    expect(resultC.ok).toBe(true);
    const resultD = await callAdminDelete(adminPage, d.uid);
    expect(resultD.ok).toBe(true);

    const resultE = await callAdminDelete(adminPage, e.uid);
    expect(resultE.ok).toBe(false);
    // The callable SDK prefixes HttpsError codes with "functions/".
    expect(resultE.code).toBe("functions/resource-exhausted");
    expect(resultE.message).toContain("cooldown");

    // E must still exist — the blocked attempt must not have partially applied.
    expect((await admin.firestore().collection("users").doc(e.uid).get()).exists).toBe(true);
  });
});
