// daily-rewards-verify.spec.js
//
// Functional coverage for markDailyRewardRedeemed and the sponsor-facing
// daily-rewards-verify.html portal it powers — previously untested.
//
// Sponsors sign in with plain email/password (not Google) — see
// daily-rewards-verify.html's own header comment. Created here directly
// via the Admin SDK (admin.auth().createUser) rather than exercising
// inviteDailyRewardSponsor's invite-link flow, which sponsor-invite.spec.js
// already covers — not what this file is testing.
//
// A sponsor account never gets a users/{uid} profile at all (see
// firestore.rules' comment on dailyRewardSponsorAccounts), so none of this
// file's sponsor data can ever compete in loadFeed()'s per-town top-21
// slice the way chatsponsor-townfounder.spec.js's/tier-limits.spec.js's
// data could (2026-08-29 cleanup fix). The one real users/{uid} doc this
// file DOES create — the plain non-sponsor account for the permission
// failure test — deliberately gets no profile.neighborhood either, same
// reasoning as admin-actions.spec.js.
//
// This function is intentionally a correctable toggle, not a one-way
// redemption claim (see index.js's own comment on markDailyRewardRedeemed)
// — there is no "duplicate redemption rejected" test here on purpose.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test daily-rewards-verify.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const STAMP = Date.now();
const BASE = "http://127.0.0.1:5000"; // same Firebase Hosting emulator index.html uses — no separate server needed

// Tracked here so afterAll can clean up exactly what this file created —
// nothing more, nothing less — and never touch another spec's data. Every
// delete below is wrapped so an already-removed record can't fail cleanup
// (idempotent).
const createdSponsorUids = [];
const createdSponsorDocIds = [];
const createdWinnerIds = [];
const createdUserUids = [];

async function createSponsor(companyName, password) {
  const slug = companyName.toLowerCase().replace(/\s+/g, "-");
  const email = `dailyrewards.${slug}.${STAMP}@test.town`;
  const userRecord = await admin.auth().createUser({ email, password, emailVerified: true });
  createdSponsorUids.push(userRecord.uid);

  // Bypasses the giveaway admin form (logo upload, dates, etc.) — same
  // shape sponsor-invite.spec.js's own createPublishedSponsor() writes,
  // not duplicated as a shared helper since that one isn't exported.
  const sponsorRef = admin.firestore().collection("dailyRewardSponsors").doc();
  await sponsorRef.set({
    companyName,
    prizeDescription: "A free thing",
    startDate: admin.firestore.Timestamp.now(),
    status: "published",
  });
  createdSponsorDocIds.push(sponsorRef.id);

  await admin.firestore().collection("dailyRewardSponsorAccounts").doc(userRecord.uid).set({
    email,
    sponsorId: sponsorRef.id,
    invitedAt: admin.firestore.Timestamp.now(),
    invitedBy: "test-setup",
  });

  return { uid: userRecord.uid, email, password, sponsorId: sponsorRef.id };
}

async function createWinner(sponsorId, winnerName) {
  const ref = admin.firestore().collection("dailyRewardWinners").doc();
  await ref.set({
    sponsorId,
    uid: `fake-winner-uid-${STAMP}-${createdWinnerIds.length}`,
    winnerName,
    prizeDescription: "A free thing",
    couponCode: `CODE${STAMP}${createdWinnerIds.length}`,
    wonAt: admin.firestore.Timestamp.now(),
    redeemed: false,
    redeemedAt: null,
  });
  createdWinnerIds.push(ref.id);
  return ref.id;
}

async function signInSponsor(page, sponsor) {
  await page.goto(`${BASE}/daily-rewards-verify.html`);
  await page.locator("#login-email").fill(sponsor.email);
  await page.locator("#login-password").fill(sponsor.password);
  await page.locator("#login-form button[type=submit]").click();
  await expect(page.locator("#portal-view")).toBeVisible({ timeout: 15_000 });
}

// Same pattern as admin-actions.spec.js's callFunction — no pre-existing
// window.*Callable bridge on this page, so httpsCallable is imported fresh
// inside the page, with the try/catch INSIDE the evaluate so a rejection
// comes back as a clean {ok, code, message} instead of throwing across the
// evaluate boundary.
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

test.describe.serial("markDailyRewardRedeemed / daily-rewards-verify.html", () => {
  test.setTimeout(120_000);
  let sponsorA, sponsorB, winnerAId, winnerBId, pageA;

  test("setup: two sponsors, one winner each, Sponsor A signed in", async ({ browser }) => {
    sponsorA = await createSponsor(`Sponsor A ${STAMP}`, "TestPass123!");
    sponsorB = await createSponsor(`Sponsor B ${STAMP}`, "TestPass123!");
    winnerAId = await createWinner(sponsorA.sponsorId, `Winner A ${STAMP}`);
    winnerBId = await createWinner(sponsorB.sponsorId, `Winner B ${STAMP}`);

    const context = await browser.newContext();
    pageA = await context.newPage();
    await signInSponsor(pageA, sponsorA);
  });

  test("Sponsor A sees their own winner and not Sponsor B's", async () => {
    await expect(pageA.locator(`tr[data-id="${winnerAId}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator(`tr[data-id="${winnerBId}"]`)).toHaveCount(0);
  });

  test("Checking the Redeemed box marks it redeemed with a real timestamp", async () => {
    const row = pageA.locator(`tr[data-id="${winnerAId}"]`);
    await row.locator("[data-redeemed-toggle]").check();
    await expect(async () => {
      const doc = (await admin.firestore().collection("dailyRewardWinners").doc(winnerAId).get()).data();
      expect(doc.redeemed).toBe(true);
      expect(doc.redeemedAt).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  });

  test("Unchecking the box reverses it back to not redeemed", async () => {
    const row = pageA.locator(`tr[data-id="${winnerAId}"]`);
    await row.locator("[data-redeemed-toggle]").uncheck();
    await expect(async () => {
      const doc = (await admin.firestore().collection("dailyRewardWinners").doc(winnerAId).get()).data();
      expect(doc.redeemed).toBe(false);
      expect(doc.redeemedAt).toBeNull();
    }).toPass({ timeout: 10_000 });
  });

  test("Sponsor A cannot modify Sponsor B's winner via direct callable", async () => {
    const result = await callFunction(pageA, "markDailyRewardRedeemed", { winnerId: winnerBId, redeemed: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("functions/permission-denied");
  });

  test("A normal non-sponsor Town Fuss user is rejected", async ({ browser }) => {
    const email = `dailyrewards.plain.${STAMP}@test.town`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUpWithGoogle(page, { email, displayName: "DailyRewards Plain" });
    const uid = await verifyEmailByAddress(email);
    createdUserUids.push(uid);
    // No profile.neighborhood on purpose — see file header comment.
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "DailyRewards Plain" } },
      { merge: true }
    );

    const result = await callFunction(page, "markDailyRewardRedeemed", { winnerId: winnerAId, redeemed: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("functions/permission-denied");

    await context.close();
  });

  test("A nonexistent winnerId is rejected with not-found", async () => {
    const result = await callFunction(pageA, "markDailyRewardRedeemed", { winnerId: `no-such-winner-${STAMP}` });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("functions/not-found");
  });

  test.afterAll(async () => {
    for (const id of createdWinnerIds) {
      await admin.firestore().collection("dailyRewardWinners").doc(id).delete().catch(() => {});
    }
    for (const uid of createdSponsorUids) {
      await admin.firestore().collection("dailyRewardSponsorAccounts").doc(uid).delete().catch(() => {});
      await admin.auth().deleteUser(uid).catch(() => {});
    }
    for (const id of createdSponsorDocIds) {
      await admin.firestore().collection("dailyRewardSponsors").doc(id).delete().catch(() => {});
    }
    for (const uid of createdUserUids) {
      await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
      await admin.auth().deleteUser(uid).catch(() => {});
    }
  });
});
