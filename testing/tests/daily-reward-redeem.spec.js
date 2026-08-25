// daily-reward-redeem.spec.js
//
// Covers markDailyRewardRedeemed (index.js) -- the sponsor portal's one
// write action, toggled via the "Redeemed" checkbox on
// daily-rewards-verify.html. Had zero test coverage before this file
// (identified in the 2026-08-24 CI risk review as one of 9 reachable-but-
// untested Cloud Functions).
//
// Unlike the main app, daily-rewards-verify.html signs sponsors in with
// signInWithEmailAndPassword, not Google -- the sponsor account itself is
// created directly via the Admin SDK here (same shortcut sponsor-invite.spec.js
// uses for the published-giveaway fixture), since the real invite flow
// (inviteDailyRewardSponsor) already has its own dedicated test file.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test daily-reward-redeem.spec.js

const { test, expect } = require("@playwright/test");
const { admin } = require("../emulatorAdmin");

const SPONSOR_PASSWORD = "TestPass123!";

test.describe("Daily Rewards redemption (markDailyRewardRedeemed)", () => {
  test("sponsor toggles a winner's Redeemed checkbox, and it's real server-side", async ({ page }) => {
    const stamp = Date.now();
    const sponsorEmail = `redeem.sponsor.${stamp}@test.town`;

    // Published giveaway, same shape sponsor-invite.spec.js's
    // createPublishedSponsor() writes.
    const sponsorRef = admin.firestore().collection("dailyRewardSponsors").doc();
    await sponsorRef.set({
      companyName: `Redeem Test Co ${stamp}`,
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
    const sponsorId = sponsorRef.id;

    // Real Auth account (email+password -- this portal doesn't use Google
    // Sign-In) plus the dailyRewardSponsorAccounts doc that
    // isSponsorFor()/this function's own server-side check requires.
    const sponsorUser = await admin.auth().createUser({ email: sponsorEmail, password: SPONSOR_PASSWORD });
    await admin.firestore().collection("dailyRewardSponsorAccounts").doc(sponsorUser.uid).set({
      sponsorId,
      email: sponsorEmail,
      invitedBy: "test-setup",
      createdAt: admin.firestore.Timestamp.now(),
    });

    // A winner within the portal's own 30-day query window, not yet redeemed.
    const winnerRef = admin.firestore().collection("dailyRewardWinners").doc();
    await winnerRef.set({
      sponsorId,
      winnerName: "Redeem Test Winner",
      prizeDescription: "A free thing",
      couponCode: `TEST-${stamp}`,
      wonAt: admin.firestore.Timestamp.now(),
      redeemed: false,
    });

    await page.goto("/daily-rewards-verify.html");
    await page.locator("#login-email").fill(sponsorEmail);
    await page.locator("#login-password").fill(SPONSOR_PASSWORD);
    await page.locator("#login-form button[type=submit]").click();

    await expect(page.locator("#winners-table-wrap")).toContainText("Redeem Test Winner", { timeout: 15_000 });
    await expect(page.locator("#winners-table-wrap")).toContainText(`TEST-${stamp}`);

    const checkbox = page.locator(`tr[data-id="${winnerRef.id}"] [data-redeemed-toggle]`);
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();

    // Confirms the callable actually ran and wrote back -- not just that
    // the checkbox's own visual state flipped client-side.
    await expect(async () => {
      const snap = await winnerRef.get();
      expect(snap.data()?.redeemed).toBe(true);
      expect(snap.data()?.redeemedAt).toBeTruthy();
    }).toPass({ timeout: 10_000 });

    // Toggling back off exercises the redeemed:false branch too, and
    // proves this isn't a one-way flag.
    await checkbox.uncheck();
    await expect(async () => {
      const snap = await winnerRef.get();
      expect(snap.data()?.redeemed).toBe(false);
      expect(snap.data()?.redeemedAt).toBeNull();
    }).toPass({ timeout: 10_000 });
  });
});
