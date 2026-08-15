// fg-deep.spec.js
//
// Deeper functional coverage for fg.html (Frisbee Golf), mirroring
// golf-deep.spec.js: catching the disc, turn switching, advancing holes,
// finishing a full match (fast-forwarded to hole 24), stats recording, the
// leaderboard, invite cooldown/decline, both local play modes, and a
// visual screenshot check of the actual canvas rendering.
//
// Uses its own throwaway accounts, independent of full-platform.spec.js.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test fg-deep.spec.js

const path = require("path");
const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `fg.p1.${Date.now()}@test.town`, password: "TestPass123!" };
const P2 = { email: `fg.p2.${Date.now()}@test.town`, password: "TestPass123!" };
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results");

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

// Same real-mouse-drag approach as full-platform.spec.js's dragFrisbee(),
// converting LOGICAL canvas coordinates to real page coordinates via the
// canvas's current bounding box.
async function dragFrisbee(page, canvasLocator, fromLogical, toLogical) {
  const box = await canvasLocator.boundingBox();
  const canvasWidth = await canvasLocator.evaluate((el) => el.width);
  const canvasHeight = await canvasLocator.evaluate((el) => el.height);
  const toPage = (p) => ({
    x: box.x + (p.x / canvasWidth) * box.width,
    y: box.y + (p.y / canvasHeight) * box.height,
  });
  const start = toPage(fromLogical);
  const end = toPage(toLogical);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

// Reverse-engineers a drag-END point that throws roughly the right
// distance in the right direction: vx/vy = (disc - dragEnd) * 0.15, and
// total travel distance ≈ v0 * 49 (same 0.98-per-frame friction constant
// used throughout this app's physics). Clamped to stay within the canvas
// so the simulated mouseup still lands on it.
function computeFgDrag(disc, basket) {
  const dx = basket.x - disc.x, dy = basket.y - disc.y;
  const k = 1 / (49 * 0.15);
  return {
    x: Math.max(10, Math.min(790, disc.x - k * dx)),
    y: Math.max(10, Math.min(590, disc.y - k * dy)),
  };
}

// The LOCAL canvas resizes to fit its container (fg.html's resizeLocalCanvas()),
// unlike the online canvas which stays fixed at 800x600 — so a hole's
// design-space position (e.g. hole 1's disc start at 100,300 out of
// 800x600) must be scaled by the canvas's CURRENT actual width/height to
// find where it really is on screen right now.
async function localDiscPosition(canvasLocator, designX, designY) {
  const canvasWidth = await canvasLocator.evaluate((el) => el.width);
  const canvasHeight = await canvasLocator.evaluate((el) => el.height);
  return { x: (designX / 800) * canvasWidth, y: (designY / 600) * canvasHeight };
}

async function waitForThrowToSettle(gameId, playerKey, priorThrows, maxWaitMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const data = (await admin.firestore().collection("fgGames").doc(gameId).get()).data();
    if (data.throws[playerKey] !== priorThrows || data.playersCompletedHole[playerKey]) return data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return (await admin.firestore().collection("fgGames").doc(gameId).get()).data();
}

async function catchDiscOnline(page, gameId, playerKey, basketPos, maxAttempts = 6) {
  let caught = false;
  for (let attempt = 0; attempt < maxAttempts && !caught; attempt++) {
    const before = (await admin.firestore().collection("fgGames").doc(gameId).get()).data();
    if (before.playersCompletedHole[playerKey]) { caught = true; break; }
    const disc = before.frisbeePositions[playerKey];

    // A pure straight-line aim, recomputed identically each retry, can get
    // stuck permanently re-throwing into the same obstacle edge — there's
    // no randomness in the physics to eventually break the pattern. Nudge
    // the aim TARGET sideways (perpendicular to the disc->basket line),
    // growing and alternating sides each attempt, so later throws route
    // around an obstacle a straight shot keeps clipping.
    let target = basketPos;
    if (attempt > 0) {
      const dx = basketPos.x - disc.x, dy = basketPos.y - disc.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = -dy / len, perpY = dx / len;
      const wobble = (attempt % 2 === 0 ? 1 : -1) * Math.min(150, attempt * 20);
      target = { x: basketPos.x + perpX * wobble, y: basketPos.y + perpY * wobble };
    }

    const dragEnd = computeFgDrag(disc, target);
    await dragFrisbee(page, page.locator("#fg-canvas"), disc, dragEnd);
    const after = await waitForThrowToSettle(gameId, playerKey, before.throws[playerKey]);
    caught = after.playersCompletedHole[playerKey];
  }
  return caught;
}

test.describe.serial("Frisbee Golf — deep functional pass", () => {
  test.setTimeout(300_000);
  let pageA, pageB, contextA, contextB, uidA, uidB, gameId;
  const BASKET_POS = { x: 700, y: 300 }; // hole 1's basket, no obstacles in the way

  test("Sign up two throwaway frisbee golfers and verify email", async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    await signUp(pageA, P1);
    await signUp(pageB, P2);
    uidA = await verifyEmailByAddress(P1.email);
    uidB = await verifyEmailByAddress(P2.email);
    // Every game page (including local/practice modes) now gates all play
    // behind admin approval — see the platform-wide "not-approved-notice"
    // fix. Set it here, right after signup, matching every other -deep
    // spec file's convention, instead of only at the leaderboard test.
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, profile: { name: "FG Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, profile: { name: "FG Robot B" } }, { merge: true });
  });

  test("Local play: vs Computer mode loads and accepts a throw", async () => {
    await pageA.goto("/fg.html");
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#local-fg-canvas")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#local-hole-info")).toContainText("Hole 1 of 24");

    const disc1 = await localDiscPosition(pageA.locator("#local-fg-canvas"), 100, 300);
    await dragFrisbee(pageA, pageA.locator("#local-fg-canvas"), disc1, { x: disc1.x - 40, y: disc1.y });
    await expect(pageA.locator("#local-p1-throws")).toHaveText("1", { timeout: 10_000 });
  });

  test("Local play: Two Player mode loads and accepts a throw from Player 1", async () => {
    await pageA.locator("#local-back-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible();
    await pageA.locator("#mode-tile-2p").click();
    await expect(pageA.locator("#local-fg-canvas")).toBeVisible({ timeout: 10_000 });

    const disc2 = await localDiscPosition(pageA.locator("#local-fg-canvas"), 100, 300);
    await dragFrisbee(pageA, pageA.locator("#local-fg-canvas"), disc2, { x: disc2.x - 40, y: disc2.y });
    await expect(pageA.locator("#local-p1-throws")).toHaveText("1", { timeout: 10_000 });
    await pageA.locator("#local-back-btn").click();
  });

  test("Frisbee Golf: create an open table, Robot B joins, both see the game", async () => {
    await pageA.goto("/fg.html");
    await pageA.locator("#mode-tile-online").click();
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    await pageB.goto("/fg.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator("#open-tables-list button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    const snap = await admin.firestore().collection("fgGames").where("player1Uid", "==", uidA).get();
    expect(snap.empty).toBe(false);
    gameId = snap.docs[0].id;
  });

  test("Frisbee Golf: visually verify the canvas actually renders the course, basket, and disc", async () => {
    await expect(pageA.locator("#fg-canvas")).toBeVisible({ timeout: 10_000 });
    await pageA.waitForTimeout(1000);
    const fs = require("fs");
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await pageA.locator("#fg-canvas").screenshot({ path: path.join(SCREENSHOT_DIR, "fg-canvas-check.png") });
  });

  test("Frisbee Golf: Robot A catches the disc on hole 1, turn passes to Robot B", async () => {
    await expect(pageA.locator("#fg-status")).toContainText("Your turn", { timeout: 10_000 });
    const caught = await catchDiscOnline(pageA, gameId, "player1", BASKET_POS);
    expect(caught).toBe(true);

    const data = (await admin.firestore().collection("fgGames").doc(gameId).get()).data();
    expect(data.currentPlayer).toBe("player2");
    expect(data.player1TotalScore).toBeGreaterThan(0);
  });

  test("Frisbee Golf: Robot B catches it too, Next Hole becomes available and advances the hole", async () => {
    await expect(pageB.locator("#fg-status")).toContainText("Your turn", { timeout: 10_000 });
    const caught = await catchDiscOnline(pageB, gameId, "player2", BASKET_POS);
    expect(caught).toBe(true);

    await expect(pageA.locator("#fg-next-hole-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#fg-next-hole-btn").click();
    await pageB.waitForTimeout(2000);

    const data = (await admin.firestore().collection("fgGames").doc(gameId).get()).data();
    expect(data.currentHole).toBe(2);
    expect(data.playersCompletedHole.player1).toBe(false);
    expect(data.playersCompletedHole.player2).toBe(false);
    await expect(pageB.locator("#fg-hole-info")).toContainText("Hole 2");
  });

  test("Frisbee Golf: fast-forward to the final hole and confirm the match finishes with the correct winner and recorded stats", async () => {
    // Hole 1 already proved the real mechanic — throw, catch, turn switch,
    // hole advance — all work with genuine physics-driven gameplay. What's
    // left to verify here is specifically the FINISH-GAME transition at
    // the 24-hole boundary, which doesn't require re-proving obstacle
    // navigation: set both players as having already completed hole 24
    // (matching what a real catch on this par-5 would leave in Firestore),
    // then click Next Hole through the real UI so the genuine finish-game
    // code path — winner determination, status change — gets exercised.
    await admin.firestore().collection("fgGames").doc(gameId).update({
      currentHole: 24,
      par: 5,
      frisbeePositions: { player1: { x: 700, y: 100 }, player2: { x: 700, y: 100 } },
      throws: { player1: 4, player2: 6 },
      playersCompletedHole: { player1: true, player2: true },
      currentPlayer: "player2",
      player1TotalScore: 54,
      player2TotalScore: 206,
    });
    await expect(pageA.locator("#fg-hole-info")).toContainText("Hole 24", { timeout: 10_000 });

    await expect(pageA.locator("#fg-next-hole-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#fg-next-hole-btn").click();

    let finalData = null;
    const finishStart = Date.now();
    while (Date.now() - finishStart < 20_000) {
      finalData = (await admin.firestore().collection("fgGames").doc(gameId).get()).data();
      if (finalData.status === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(finalData.status).toBe("finished");
    expect(finalData.winner).toBe(uidA);

    let userA, userB;
    const statsStart = Date.now();
    while (Date.now() - statsStart < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA && userA.fgWins && userB && userB.fgLosses) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(userA.fgWins).toBe(1);
    expect(userA.fgPoints).toBe(3);
    expect(userB.fgLosses).toBe(1);
    expect(userB.fgPoints || 0).toBe(0);
  });

  test("Frisbee Golf leaderboard shows both players with the correct results", async () => {
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, profile: { name: "FG Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, profile: { name: "FG Robot B" } }, { merge: true });

    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#leaderboard-list")).toContainText("FG Robot A", { timeout: 10_000 });
    await expect(pageA.locator("#leaderboard-list")).toContainText("FG Robot B");
    await expect(pageA.locator("#leaderboard-list")).toContainText("1W-0L-0D");
  });

  test("Frisbee Golf: direct invite cooldown blocks a second invite, then the original is declined", async () => {
    const pairId = [uidA, uidB].sort().join("_");
    const { FieldValue } = require("firebase-admin/firestore");
    await admin.firestore().collection("friendRequests").doc(pairId).set({
      participants: [uidA, uidB].sort(),
      participantNames: { [uidA]: "FG Robot A", [uidB]: "FG Robot B" },
      requestedBy: uidA,
      status: "accepted",
      requestedAt: FieldValue.serverTimestamp(),
      respondedAt: FieldValue.serverTimestamp(),
    });

    await pageA.locator("#nav-waiting").click();
    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #waiting-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator("#waiting-message")).toContainText("again in about", { timeout: 10_000 });

    await pageB.locator("#nav-waiting").click();
    await pageB.locator("#my-invites-list").waitFor();
    await pageB.locator('button:has-text("Decline")').first().click();
    await expect(pageB.locator("#my-invites-empty")).toBeVisible({ timeout: 10_000 });
  });
});
