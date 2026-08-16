// sponsor-invite.spec.js
//
// Covers inviteDailyRewardSponsor after the 2026-08-15 Resend removal: the
// function used to email the sponsor their password-setup link via Resend;
// now it just returns the link to the calling admin, and the admin panel
// shows/copies it instead of assuming an email went out. This is the one
// piece of that day's change that's a real feature (not just a dropped
// notification), and had zero prior test coverage.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test sponsor-invite.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

async function signUp(page, email) {
  await signUpWithGoogle(page, { email });
}

async function waitForRealSignupDoc(uid, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists && snap.data().email) return snap.data();
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`users/${uid} never got its real signup fields (email/createdAt) within ${timeoutMs}ms`);
}

// #sponsor-invite-message only ever gets SET after a submission resolves —
// it's never cleared at the start of one — so a second, rapid submission's
// "success" text can't be told apart from the FIRST submission's leftover
// text just by waiting for it to say "Account created" again; that
// condition is already true the instant the second click happens. Polling
// Firestore directly for the actual expected value is what proves the
// second call really completed, not just that the first one did.
async function waitForSponsorId(uid, expectedSponsorId, timeoutMs = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const snap = await admin.firestore().collection("dailyRewardSponsorAccounts").doc(uid).get();
    last = snap.data()?.sponsorId;
    if (last === expectedSponsorId) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`dailyRewardSponsorAccounts/${uid}.sponsorId never became "${expectedSponsorId}" within ${timeoutMs}ms (last seen: "${last}")`);
}

// Bypasses the giveaway admin form (logo upload, dates, etc.) — none of
// that is what this file is testing — and writes a published
// dailyRewardSponsors doc directly, same shape the real form's setDoc +
// publish action produce (see index.html's #dailyreward-form handler and
// the publish button in renderDailyRewardAdminCard).
async function createPublishedSponsor(companyName) {
  const ref = admin.firestore().collection("dailyRewardSponsors").doc();
  await ref.set({
    companyName,
    prizeDescription: "A free thing",
    startDate: admin.firestore.Timestamp.now(),
    endDate: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    maxWinnersPerDay: 1,
    quantityCap: null,
    redemptionInstructions: "Show this at the counter.",
    finePrint: "",
    status: "published",
    quantityAwarded: 0,
    createdAt: admin.firestore.Timestamp.now(),
    createdBy: "test-setup",
    publishedAt: admin.firestore.Timestamp.now(),
  });
  return ref.id;
}

test.describe("Daily Rewards sponsor invite", () => {
  test("admin invites a sponsor: account is created and a real setup link comes back, no email needed", async ({ browser }) => {
    const adminEmail = "sponsorinviteadmin." + Date.now() + "@test.town";
    const sponsorEmail = "invitedsponsor." + Date.now() + "@test.town";
    const sponsorId = await createPublishedSponsor("Test Sponsor Co " + Date.now());

    const adminPage = await (await browser.newContext()).newPage();
    await signUp(adminPage, adminEmail);
    await adminPage.waitForTimeout(1000);
    const adminUid = await verifyEmailByAddress(adminEmail);
    await waitForRealSignupDoc(adminUid);
    await admin.firestore().collection("admins").doc(adminUid).set({ createdAt: admin.firestore.Timestamp.now() });
    await adminPage.evaluate(() => sessionStorage.setItem("adminPinVerified", "true"));
    await adminPage.reload();
    await adminPage.waitForTimeout(1500);
    await adminPage.locator("#nav-admin").dispatchEvent("click");
    await adminPage.waitForTimeout(1200);

    // The dropdown only lists published/paused/ended giveaways (see
    // loadSponsorInviteList) — confirms the fixture actually shows up
    // before trying to invite against it.
    const select = adminPage.locator("#sponsor-invite-sponsor-select");
    await expect(select.locator(`option[value="${sponsorId}"]`)).toHaveCount(1, { timeout: 10_000 });
    await select.selectOption(sponsorId);
    await adminPage.locator("#sponsor-invite-email").fill(sponsorEmail);
    await adminPage.locator("#sponsor-invite-form button[type=submit]").click();

    // No Resend account exists anymore — if the function still tried to
    // email and failed, this would show an error instead. What comes back
    // now is the setup link itself, shown directly in the message (best-
    // effort clipboard-copy happens too, but headless test contexts don't
    // reliably grant clipboard permissions, so the visible text is what's
    // actually asserted on).
    const msg = adminPage.locator("#sponsor-invite-message");
    await expect(msg).toContainText("Account created", { timeout: 15_000 });
    await expect(msg).toContainText("http");

    // The account is real: a dailyRewardSponsorAccounts doc scoped to this
    // sponsorId, and an actual Firebase Auth user for that email — not
    // just a UI success message with nothing behind it.
    const accountsSnap = await admin.firestore().collection("dailyRewardSponsorAccounts").where("email", "==", sponsorEmail).limit(1).get();
    expect(accountsSnap.empty).toBe(false);
    const accountDoc = accountsSnap.docs[0];
    expect(accountDoc.data().sponsorId).toBe(sponsorId);
    expect(accountDoc.data().invitedBy).toBe(adminUid);

    const sponsorUserRecord = await admin.auth().getUserByEmail(sponsorEmail);
    expect(sponsorUserRecord.uid).toBe(accountDoc.id);

    // Shows up in the admin's own accounts list on screen too.
    await expect(adminPage.locator("#sponsor-invite-list")).toContainText(sponsorEmail, { timeout: 10_000 });
  });

  test("inviting the same email twice reuses the existing account instead of erroring", async ({ browser }) => {
    const adminEmail = "sponsorinviteadmin2." + Date.now() + "@test.town";
    const sponsorEmail = "repeatsponsor." + Date.now() + "@test.town";
    const sponsorIdA = await createPublishedSponsor("Repeat Test Co A " + Date.now());
    const sponsorIdB = await createPublishedSponsor("Repeat Test Co B " + Date.now());

    const adminPage = await (await browser.newContext()).newPage();
    await signUp(adminPage, adminEmail);
    await adminPage.waitForTimeout(1000);
    const adminUid = await verifyEmailByAddress(adminEmail);
    await waitForRealSignupDoc(adminUid);
    await admin.firestore().collection("admins").doc(adminUid).set({ createdAt: admin.firestore.Timestamp.now() });
    await adminPage.evaluate(() => sessionStorage.setItem("adminPinVerified", "true"));
    await adminPage.reload();
    await adminPage.waitForTimeout(1500);
    await adminPage.locator("#nav-admin").dispatchEvent("click");
    await adminPage.waitForTimeout(1200);

    const select = adminPage.locator("#sponsor-invite-sponsor-select");

    // First invite, against giveaway A.
    await expect(select.locator(`option[value="${sponsorIdA}"]`)).toHaveCount(1, { timeout: 10_000 });
    await select.selectOption(sponsorIdA);
    await adminPage.locator("#sponsor-invite-email").fill(sponsorEmail);
    await adminPage.locator("#sponsor-invite-form button[type=submit]").click();
    await expect(adminPage.locator("#sponsor-invite-message")).toContainText("Account created", { timeout: 15_000 });
    const firstUserRecord = await admin.auth().getUserByEmail(sponsorEmail);
    await waitForSponsorId(firstUserRecord.uid, sponsorIdA);

    // Second invite, same email, DIFFERENT giveaway — getUserByEmail
    // inside inviteDailyRewardSponsor should find the existing account
    // rather than createUser() throwing on a duplicate email.
    await expect(select.locator(`option[value="${sponsorIdB}"]`)).toHaveCount(1, { timeout: 10_000 });
    await select.selectOption(sponsorIdB);
    await adminPage.locator("#sponsor-invite-email").fill(sponsorEmail);
    await adminPage.locator("#sponsor-invite-form button[type=submit]").click();

    const secondUserRecord = await admin.auth().getUserByEmail(sponsorEmail);
    expect(secondUserRecord.uid).toBe(firstUserRecord.uid); // same Auth account, not a duplicate

    // The account doc now points at the SECOND giveaway (last invite wins).
    // Deliberately NOT waiting on #sponsor-invite-message here the way the
    // first invite's check above does — that element is only ever SET
    // after a submission resolves, never cleared at the start of one, so
    // right after this second click it can still be showing the FIRST
    // invite's leftover "Account created" text, satisfying a text-based
    // wait instantly without ever proving the second call actually
    // finished. Confirmed as a real false-pass 2026-08-16 (the assertion
    // below failed with the OLD sponsorId still in place — the "success"
    // message had already been sitting there since the first invite).
    // Polling Firestore for the real expected value sidesteps that
    // UI-staleness gap entirely.
    await waitForSponsorId(secondUserRecord.uid, sponsorIdB);
  });
});
