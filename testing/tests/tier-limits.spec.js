// tier-limits.spec.js
//
// Closes two coverage gaps flagged after Batch 2 (tiered daily limits for
// online game plays and direct messages: 3/day Free, 10/day Gold, unlimited
// Diamond):
//   1. The Gold tier's 10/day cap was never actually exercised end-to-end —
//      only Free's 3 (via full-platform.spec.js) and Diamond's unlimited
//      (via the mid-suite Diamond grant) had been.
//   2. Whether local vs-computer / same-device 2-player modes really stay
//      exempt from the online-game-play limit was assumed, not verified.
//
// Uses throwaway accounts and admin-SDK seeding of gamePlayLimits/
// messageLimits docs to jump straight to each boundary (e.g. "already
// played 9 games today") instead of clicking through 9 real games first —
// the actual 10th/11th attempt still goes through the real client code and
// real Firestore security rules, which is the part actually being tested.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test tier-limits.spec.js

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin } = require("../emulatorAdmin");

function todayNumber() {
  return Math.floor(Date.now() / 86400000);
}

async function signUp(page, account) {
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("#signup-email").fill(account.email);
  await page.locator("#signup-password").fill(account.password);
  await page.locator("#signup-age-confirm").check();
  await page.locator("#signup-terms-confirm").check();
  await page.locator("#form-signup button[type=submit]").click();
}

// Skips the profile-form/admin-approval UI entirely (already covered by
// full-platform.spec.js) — just need an approved, named profile so
// Directory search and the game pages' full nav both work. agreedToTerms
// matters here too: index.html's canSeeFullNav (which gates #nav-directory,
// among others) requires BOTH agreedToTerms and emailVerified — without it,
// a click on #nav-directory just times out waiting on a link that never
// becomes visible, since the account is permanently stuck behind the
// terms-gate screen it never clicked through.
async function approveWithProfile(uid, name, extraFields = {}) {
  await admin.firestore().collection("users").doc(uid).set(
    { approved: true, agreedToTerms: true, profile: { name, neighborhood: "Pauls Valley" }, ...extraFields },
    { merge: true }
  );
}

async function seedGamePlayLimit(uid, count) {
  await admin.firestore().collection("gamePlayLimits").doc(uid).set({ day: todayNumber(), count });
}

async function seedMessageLimit(uid, count) {
  await admin.firestore().collection("messageLimits").doc(uid).set({ day: todayNumber(), count });
}

// A fake "other party" for messaging tests — messaging only needs the
// recipient's uid to exist as an approved profile doc (index.html's msg-btn
// has no friend-relationship requirement), not a real Firebase Auth account
// or browser session.
async function makeFakeApprovedProfile(label, name) {
  const uid = `tier-test-${label}-${Date.now()}`;
  await admin.firestore().collection("users").doc(uid).set({ approved: true, profile: { name, neighborhood: "Pauls Valley" } });
  return uid;
}

test.describe.serial("Tiered daily limits — Gold cap, Diamond unlimited, local modes exempt", () => {
  test.setTimeout(120_000);

  // ---------------------------------------------------------------------
  // Group 1: Gold — 10 online game plays/day, blocked at the 11th
  // ---------------------------------------------------------------------
  test.describe.serial("Gold: 10 online game plays per day", () => {
    let page, context, uid;
    const ACCOUNT = { email: `tier.gold.play.${Date.now()}@test.town`, password: "TestPass123!" };

    test("setup: sign up, approve, grant Gold, seed 9 plays already used today", async ({ browser }) => {
      context = await browser.newContext();
      page = await context.newPage();
      await signUp(page, ACCOUNT);
      uid = await verifyEmailByAddress(ACCOUNT.email);
      await approveWithProfile(uid, "Gold Play Tester", { isGoldMember: true });
      await seedGamePlayLimit(uid, 9);
    });

    test("10th play succeeds", async () => {
      await page.goto("/chess.html");
      await page.locator("#game-tile-chess").click();
      await page.locator("#mode-tile-online").click();
      await expect(page.locator("#chess-play-remaining")).toContainText("1 / 10 online games left today", { timeout: 10_000 });

      await page.locator("#create-table-btn").click();
      await expect(page.locator("#view-game")).toBeVisible({ timeout: 15_000 });

      const limitDoc = await admin.firestore().collection("gamePlayLimits").doc(uid).get();
      expect(limitDoc.data().count).toBe(10);
    });

    test("11th play is blocked with a friendly message, count stays at 10", async () => {
      await page.locator("#leave-table-btn").click();
      await expect(page.locator("#view-waiting")).toBeVisible();
      await expect(page.locator("#chess-play-remaining")).toContainText("0 / 10 online games left today", { timeout: 10_000 });

      await page.locator("#create-table-btn").click();
      await expect(page.locator("#waiting-message")).toContainText("daily limit of online games", { timeout: 10_000 });

      const limitDoc = await admin.firestore().collection("gamePlayLimits").doc(uid).get();
      expect(limitDoc.data().count).toBe(10);
    });
  });

  // ---------------------------------------------------------------------
  // Group 2: Gold — 10 direct messages/day, blocked at the 11th
  // ---------------------------------------------------------------------
  test.describe.serial("Gold: 10 direct messages per day", () => {
    let page, context, uid, buddyUid;
    const ACCOUNT = { email: `tier.gold.msg.${Date.now()}@test.town`, password: "TestPass123!" };

    test("setup: sign up, approve, grant Gold, seed 9 messages already sent today", async ({ browser }) => {
      context = await browser.newContext();
      page = await context.newPage();
      await signUp(page, ACCOUNT);
      uid = await verifyEmailByAddress(ACCOUNT.email);
      await approveWithProfile(uid, "Gold Message Tester", { isGoldMember: true });
      await seedMessageLimit(uid, 9);
      buddyUid = await makeFakeApprovedProfile("gold-buddy", "Message Test Buddy");
    });

    test("10th message succeeds", async () => {
      await page.goto("/index.html");
      await page.locator("#nav-directory").click();
      await page.locator("#directory-search").fill("Message Test Buddy");
      await page.locator(".directory-card", { hasText: "Message Test Buddy" }).click();
      await page.locator(".msg-btn").click();
      await page.locator("#thread-input").fill("Tenth message today.");
      await page.locator("#thread-form button[type=submit]").click();
      await expect(page.locator("#thread-messages")).toContainText("Tenth message today.");
      await expect(page.locator("#messages-remaining")).toContainText("0 / 10 messages left today", { timeout: 10_000 });

      const limitDoc = await admin.firestore().collection("messageLimits").doc(uid).get();
      expect(limitDoc.data().count).toBe(10);
    });

    test("11th message is blocked, send button disabled, count stays at 10", async () => {
      await expect(page.locator("#thread-send-btn")).toBeDisabled();
      const limitDoc = await admin.firestore().collection("messageLimits").doc(uid).get();
      expect(limitDoc.data().count).toBe(10);
    });
  });

  // ---------------------------------------------------------------------
  // Group 3: Diamond — unlimited, both game plays and messages keep working past 10
  // ---------------------------------------------------------------------
  test.describe.serial("Diamond: unlimited game plays and messages", () => {
    let page, context, uid, buddyUid;
    const ACCOUNT = { email: `tier.diamond.${Date.now()}@test.town`, password: "TestPass123!" };

    test("setup: sign up, approve, grant Diamond, seed 15 plays and 15 messages already used today", async ({ browser }) => {
      context = await browser.newContext();
      page = await context.newPage();
      await signUp(page, ACCOUNT);
      uid = await verifyEmailByAddress(ACCOUNT.email);
      await approveWithProfile(uid, "Diamond Tester", { isDiamondMember: true });
      await seedGamePlayLimit(uid, 15);
      await seedMessageLimit(uid, 15);
      buddyUid = await makeFakeApprovedProfile("diamond-buddy", "Diamond Test Buddy");
    });

    test("16th online game play still succeeds", async () => {
      await page.goto("/chess.html");
      await page.locator("#game-tile-chess").click();
      await page.locator("#mode-tile-online").click();
      await expect(page.locator("#chess-play-remaining")).toContainText("Unlimited online games today", { timeout: 10_000 });

      await page.locator("#create-table-btn").click();
      await expect(page.locator("#view-game")).toBeVisible({ timeout: 15_000 });

      const limitDoc = await admin.firestore().collection("gamePlayLimits").doc(uid).get();
      expect(limitDoc.data().count).toBe(16);
    });

    test("16th direct message still succeeds", async () => {
      await page.goto("/index.html");
      await page.locator("#nav-directory").click();
      await page.locator("#directory-search").fill("Diamond Test Buddy");
      await page.locator(".directory-card", { hasText: "Diamond Test Buddy" }).click();
      await page.locator(".msg-btn").click();
      await expect(page.locator("#messages-remaining")).toContainText("Unlimited messages today", { timeout: 10_000 });

      await page.locator("#thread-input").fill("Sixteenth message today, still going.");
      await page.locator("#thread-form button[type=submit]").click();
      await expect(page.locator("#thread-messages")).toContainText("Sixteenth message today, still going.");

      const limitDoc = await admin.firestore().collection("messageLimits").doc(uid).get();
      expect(limitDoc.data().count).toBe(16);
    });
  });

  // ---------------------------------------------------------------------
  // Group 4: Free tier maxed out on online plays — local modes stay exempt
  // ---------------------------------------------------------------------
  test.describe.serial("Free tier at its online-game cap: local modes are unaffected", () => {
    let page, context, uid;
    const ACCOUNT = { email: `tier.free.local.${Date.now()}@test.town`, password: "TestPass123!" };

    test("setup: sign up, approve (Free tier — no Gold/Diamond flags), seed 3 plays already used today", async ({ browser }) => {
      context = await browser.newContext();
      page = await context.newPage();
      await signUp(page, ACCOUNT);
      uid = await verifyEmailByAddress(ACCOUNT.email);
      await approveWithProfile(uid, "Free Local Tester");
      await seedGamePlayLimit(uid, 3);
    });

    test("vs-Computer (local) mode loads and accepts a move despite the online cap being maxed", async () => {
      await page.goto("/chess.html");
      await page.locator("#game-tile-chess").click();
      await page.locator("#mode-tile-ai").click();
      await expect(page.locator("#local-board")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#local-game-status")).toContainText("White to move");

      await page.locator('#local-board [data-row="6"][data-col="4"]').click();
      await page.locator('#local-board [data-row="4"][data-col="4"]').click();
      await expect(page.locator('#local-board [data-row="4"][data-col="4"]')).not.toHaveText("");
      await expect(page.locator('#local-board [data-row="6"][data-col="4"]')).toHaveText("");
    });

    test("2-Player (same device, local) mode loads and accepts a move despite the online cap being maxed", async () => {
      await page.locator("#local-back-btn").click();
      await expect(page.locator("#view-mode-select")).toBeVisible();
      await page.locator("#mode-tile-2p").click();
      await expect(page.locator("#local-board")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#local-game-status")).toContainText("White to move");

      await page.locator('#local-board [data-row="6"][data-col="4"]').click();
      await page.locator('#local-board [data-row="4"][data-col="4"]').click();
      await expect(page.locator("#local-game-status")).toContainText("Black to move");
    });

    test("sanity check: online play for this same account is still actually blocked", async () => {
      await page.locator("#local-back-btn").click();
      await page.locator("#mode-tile-online").click();
      await expect(page.locator("#chess-play-remaining")).toContainText("0 / 3 online games left today", { timeout: 10_000 });

      await page.locator("#create-table-btn").click();
      await expect(page.locator("#waiting-message")).toContainText("daily limit of online games", { timeout: 10_000 });
    });
  });
});
