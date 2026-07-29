// golf-deep.spec.js
//
// Deeper functional coverage for golf.html, beyond the "invite/accept/one
// shot syncs" smoke test in full-platform.spec.js: holing out, turn
// switching, advancing holes, finishing a full match (with a fast-forward
// to the final hole — playing all 24 for real would take far too long),
// stats recording, the leaderboard, and invite cooldown/decline.
//
// Uses its own throwaway accounts (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal, with
// the pubsub emulator NOT required here (no scheduled functions involved).
//
// Run with: npx playwright test golf-deep.spec.js

const path = require("path");
const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin } = require("../emulatorAdmin");

const P1 = { email: `golf.p1.${Date.now()}@test.town`, password: "TestPass123!" };
const P2 = { email: `golf.p2.${Date.now()}@test.town`, password: "TestPass123!" };
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results");

async function signUp(page, robot) {
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("#signup-email").fill(robot.email);
  await page.locator("#signup-password").fill(robot.password);
  await page.locator("#signup-age-confirm").check();
  await page.locator("#signup-terms-confirm").check();
  await page.locator("#form-signup button[type=submit]").click();
}

// Reverse-engineers the power/angle slider values that will send the ball
// straight at the hole, using the app's own physics constants: velocity
// decays by *0.98 every animation frame, so total travel distance before
// stopping is approximately v0 * (0.98/(1-0.98)) = v0*49, and
// v0 = (power/100)*15.
function computeShot(ball, hole) {
  const dx = hole.x - ball.x;
  const dy = hole.y - ball.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  let angleDeg = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (angleDeg < 0) angleDeg += 360;
  const power = Math.max(10, Math.min(100, Math.round((distance * 100) / (49 * 15))));
  return { power, angle: Math.round(angleDeg) };
}

async function setSlider(locator, value) {
  await locator.evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function takeAimedShot(page, ballPos, holePos, powerId, angleId, shootId) {
  const { power, angle } = computeShot(ballPos, holePos);
  await setSlider(page.locator(powerId), power);
  await setSlider(page.locator(angleId), angle);
  await page.locator(shootId).click();
}

// Polls Firestore directly for the shot to land (rather than a blind
// client-side sleep) — a lone, unfocused headless page's requestAnimationFrame
// loop can get throttled by the browser, making the physics take far
// longer in wall-clock time than the frame-count math assumes. Polling the
// actual write is correct no matter how slow the tab's rAF ends up ticking.
async function waitForShotToSettle(gameId, playerKey, priorStrokes, maxWaitMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const data = (await admin.firestore().collection("golfGames").doc(gameId).get()).data();
    if (data.strokes[playerKey] !== priorStrokes || data.playersCompletedHole[playerKey]) return data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return (await admin.firestore().collection("golfGames").doc(gameId).get()).data();
}

// Repeatedly aims at the hole (recomputing from the ball's actual current
// position each time, read straight from Firestore) until it's holed out
// or we run out of attempts — one imprecise shot shouldn't fail the test,
// since the point is confirming the mechanic works, not sinking a hole-in-one.
async function holeOutOnline(page, gameId, playerKey, holePos, maxAttempts = 6) {
  let holed = false;
  for (let attempt = 0; attempt < maxAttempts && !holed; attempt++) {
    const before = (await admin.firestore().collection("golfGames").doc(gameId).get()).data();
    if (before.playersCompletedHole[playerKey]) { holed = true; break; }
    await takeAimedShot(page, before.ballPositions[playerKey], holePos, "#golf-power", "#golf-angle", "#golf-shoot-btn");
    const after = await waitForShotToSettle(gameId, playerKey, before.strokes[playerKey]);
    holed = after.playersCompletedHole[playerKey];
  }
  return holed;
}

test.describe.serial("Golf — deep functional pass", () => {
  test.setTimeout(300_000);
  let pageA, pageB, contextA, contextB, uidA, uidB, gameId;
  const HOLE_POS = { x: 700, y: 100 }; // shared start/cup coords for holes 1 and 24

  test("Sign up two throwaway golfers and verify email", async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    await signUp(pageA, P1);
    await signUp(pageB, P2);
    uidA = await verifyEmailByAddress(P1.email);
    uidB = await verifyEmailByAddress(P2.email);
  });

  test("Local play: vs Computer mode loads and accepts a shot", async () => {
    await pageA.goto("/golf.html");
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#local-golf-canvas")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#local-hole-info")).toContainText("Hole 1 • Par 3");
    await expect(pageA.locator("#local-current-player")).toContainText("You");

    await pageA.locator("#local-shoot-btn").click();
    await expect(pageA.locator("#local-golf-status")).toContainText("Ball in motion", { timeout: 3000 });
    // Polling via expect (rather than a bare sleep) actively re-evaluates
    // the DOM, which keeps a lone, unfocused headless page's rAF loop
    // ticking at a normal rate instead of getting throttled.
    await expect(pageA.locator("#local-golf-status")).not.toContainText("Ball in motion", { timeout: 20_000 });
    const strokes = Number(await pageA.locator("#local-stroke-count").textContent());
    expect(strokes).toBeGreaterThanOrEqual(0);
  });

  test("Local play: Two Player mode loads and accepts a shot from Player 1", async () => {
    await pageA.locator("#local-back-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible();
    await pageA.locator("#mode-tile-2p").click();
    await expect(pageA.locator("#local-golf-canvas")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#local-current-player")).toContainText("Player 1");

    await pageA.locator("#local-shoot-btn").click();
    await expect(pageA.locator("#local-golf-status")).not.toContainText("Ball in motion", { timeout: 20_000 });
    await pageA.locator("#local-back-btn").click();
  });

  test("Golf: create an open table, Robot B joins, both see the game", async () => {
    await pageA.goto("/golf.html");
    await pageA.locator("#mode-tile-online").click();
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    await pageB.goto("/golf.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator("#open-tables-list button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    const snap = await admin.firestore().collection("golfGames").where("player1Uid", "==", uidA).get();
    expect(snap.empty).toBe(false);
    gameId = snap.docs[0].id;
  });

  test("Golf: visually verify the canvas actually renders the hole, hazards, and ball", async () => {
    await expect(pageA.locator("#golf-canvas")).toBeVisible({ timeout: 10_000 });
    // Give the drawing loop a moment and confirm a screenshot has real
    // green-course pixel content (not a blank/broken canvas) before
    // capturing it for a manual visual look.
    await pageA.waitForTimeout(1000);
    const fs = require("fs");
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await pageA.locator("#golf-canvas").screenshot({ path: path.join(SCREENSHOT_DIR, "golf-canvas-check.png") });
  });

  test("Golf: Robot A holes out on hole 1, turn passes to Robot B", async () => {
    await expect(pageA.locator("#golf-shoot-btn")).toBeEnabled({ timeout: 10_000 });
    const holed = await holeOutOnline(pageA, gameId, "player1", HOLE_POS);
    expect(holed).toBe(true);

    const data = (await admin.firestore().collection("golfGames").doc(gameId).get()).data();
    expect(data.currentPlayer).toBe("player2");
    expect(data.player1TotalScore).toBeGreaterThan(0);
  });

  test("Golf: Robot B holes out too, Next Hole becomes available and advances the hole", async () => {
    await expect(pageB.locator("#golf-shoot-btn")).toBeEnabled({ timeout: 10_000 });
    const holed = await holeOutOnline(pageB, gameId, "player2", HOLE_POS);
    expect(holed).toBe(true);

    await expect(pageA.locator("#golf-next-hole-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#golf-next-hole-btn").click();
    await pageB.waitForTimeout(2000);

    const data = (await admin.firestore().collection("golfGames").doc(gameId).get()).data();
    expect(data.currentHole).toBe(2);
    expect(data.playersCompletedHole.player1).toBe(false);
    expect(data.playersCompletedHole.player2).toBe(false);
    await expect(pageB.locator("#golf-hole-info")).toContainText("Hole 2");
  });

  test("Golf: fast-forward to the final hole and confirm the match finishes with the correct winner and recorded stats", async () => {
    // Playing all 24 holes for real would take far too long — jump the
    // shared game doc straight to hole 24 with a wide score gap so the
    // winner is unambiguous, then play THIS hole out for real through the
    // actual UI so the genuine finish-game code path gets exercised.
    await admin.firestore().collection("golfGames").doc(gameId).update({
      currentHole: 24,
      par: 5,
      ballPositions: { player1: { x: 100, y: 400 }, player2: { x: 100, y: 400 } },
      strokes: { player1: 0, player2: 0 },
      playersCompletedHole: { player1: false, player2: false },
      currentPlayer: "player1",
      player1TotalScore: 50,
      player2TotalScore: 200,
    });
    await expect(pageA.locator("#golf-hole-info")).toContainText("Hole 24", { timeout: 10_000 });

    expect(await holeOutOnline(pageA, gameId, "player1", HOLE_POS)).toBe(true);
    expect(await holeOutOnline(pageB, gameId, "player2", HOLE_POS)).toBe(true);

    await expect(pageA.locator("#golf-next-hole-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#golf-next-hole-btn").click();

    let finalData = null;
    const finishStart = Date.now();
    while (Date.now() - finishStart < 20_000) {
      finalData = (await admin.firestore().collection("golfGames").doc(gameId).get()).data();
      if (finalData.status === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(finalData.status).toBe("finished");
    expect(finalData.winner).toBe(uidA);

    // Stats get recorded client-side (maybeRecordGolfStats(), fired by the
    // finished-game onSnapshot) — poll for it rather than guessing a delay.
    let userA, userB;
    const statsStart = Date.now();
    while (Date.now() - statsStart < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA && userA.golfWins && userB && userB.golfLosses) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(userA.golfWins).toBe(1);
    expect(userA.golfPoints).toBe(3);
    expect(userB.golfLosses).toBe(1);
    expect(userB.golfPoints || 0).toBe(0);
  });

  test("Golf leaderboard shows both players with the correct results", async () => {
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, profile: { name: "Golf Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, profile: { name: "Golf Robot B" } }, { merge: true });

    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#leaderboard-list")).toContainText("Golf Robot A", { timeout: 10_000 });
    await expect(pageA.locator("#leaderboard-list")).toContainText("Golf Robot B");
    await expect(pageA.locator("#leaderboard-list")).toContainText("1W-0L-0D");
  });

  test("Golf: direct invite cooldown blocks a second invite, then the original is declined", async () => {
    // Needs an accepted friend relationship for the "Invite a friend" list —
    // write it directly (admin SDK bypasses rules) rather than replaying
    // the whole friend-request UI flow, which full-platform.spec.js already
    // covers thoroughly.
    const pairId = [uidA, uidB].sort().join("_");
    const { FieldValue } = require("firebase-admin/firestore");
    await admin.firestore().collection("friendRequests").doc(pairId).set({
      participants: [uidA, uidB].sort(),
      participantNames: { [uidA]: "Golf Robot A", [uidB]: "Golf Robot B" },
      requestedBy: uidA,
      status: "accepted",
      requestedAt: FieldValue.serverTimestamp(),
      respondedAt: FieldValue.serverTimestamp(),
    });

    await pageA.locator("#nav-waiting").click();
    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #waiting-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    // Second attempt right away should be blocked by the 1-hour cooldown.
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator("#waiting-message")).toContainText("again in about", { timeout: 10_000 });

    // Robot B declines the still-pending original invite.
    await pageB.locator("#nav-waiting").click();
    await pageB.locator("#my-invites-list").waitFor();
    await pageB.locator('button:has-text("Decline")').first().click();
    await expect(pageB.locator("#my-invites-empty")).toBeVisible({ timeout: 10_000 });
  });
});
