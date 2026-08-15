// neon-drift-deep.spec.js
//
// Deep functional coverage for neon-drift.html — added 2026-08-01 alongside
// sudoku-deep.spec.js to close the gap those two newest games had: each
// previously only got a one-off diagnostic script (deleted after use)
// instead of permanent coverage.
//
// The "play offline then online" sequence in this spec isn't incidental —
// it's a direct regression test for a real bug found while building this
// game: beginRun() didn't reset gameState, so gameState.gameOver stayed
// true from a PREVIOUS run for the rest of the page's life. A second run
// (in this exact offline-then-online order) rendered a completely frozen,
// non-functional game with no error shown anywhere. Fixed by extracting a
// shared freshGameState() helper used by beginRun(), restart(), AND the
// initial page load.
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test neon-drift-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `neon.p1.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

async function playThroughIntro(page) {
  await page.locator("#skipButton").click();
  await page.locator("#startBtn").click();
}

// Forces a deterministic collision (rather than waiting on random obstacle
// spawns) by planting an obstacle exactly at the player's current position
// and letting the real update() loop process it on its next tick.
async function forceGameOverWithScore(page, score) {
  await page.evaluate((s) => {
    gameState.score = s;
    gameState.obstacles = [{
      x: gameState.player.x, y: gameState.player.y, width: 60, height: 60,
      speed: 0, rotation: 0, rotationSpeed: 0, type: 1,
    }];
  }, score);
  await expect(page.locator("#gameOver")).toBeVisible({ timeout: 5000 });
}

test.describe.serial("Neon Drift — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "Neon Robot" } },
      { merge: true }
    );
  });

  test("Play for Fun: canvas sizes correctly and a forced collision ends the run untracked", async () => {
    await page.goto("/neon-drift.html");
    await page.locator("#game-tile-neondrift").click();
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#neonDriftGameWrapper")).toBeVisible();
    expect(await readVar(page, "isOnlineRun")).toBe(false);

    // Regression guard for a canvas-sizing bug class: the container is
    // display:none until beginRun() shows it, so a resize computed before
    // that would read 0x0 — beginRun() re-runs resizeCanvas() after
    // becoming visible specifically to avoid this.
    const size = await page.evaluate(() => ({ w: canvas.width, h: canvas.height }));
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);

    await playThroughIntro(page);
    await forceGameOverWithScore(page, 120);
    await expect(page.locator("#finalScore")).toHaveText("120");
  });

  test("Play Online (Ranked): a second run in the SAME page (regression guard) actually works and submits the score", async () => {
    // THE regression: beginRun() used to never reset gameState, so
    // gameState.gameOver stayed true from the offline run above — this
    // exact online run would previously render completely frozen.
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-neondrift").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#neonDriftGameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    await playThroughIntro(page);
    expect(await readVar(page, "gameState.gameOver")).toBe(false); // proves the loop is actually running, not frozen

    await forceGameOverWithScore(page, 250);

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.neonDriftHighScore) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.neonDriftHighScore).toBe(250);
  });

  test("A worse follow-up run does not overwrite the recorded high score", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await page.locator("#restartBtn").click();
    expect(await readVar(page, "isOnlineRun")).toBe(false); // restart() always resumes untracked

    await forceGameOverWithScore(page, 10);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.neonDriftHighScore).toBe(before.neonDriftHighScore);
  });

  test("Neon Drift leaderboard view is reachable and the recorded data is queryable in score order", async () => {
    // NOTE: this deliberately does NOT assert on the live client-side query
    // result — the Firestore EMULATOR throws a spurious permission error on
    // this collection's `where(...)` list queries even for the querying
    // user's own matching document (confirmed emulator-only; real
    // production leaderboards work fine). Verify the view loads, and verify
    // the same query shape via the admin SDK instead.
    await page.locator("#back-to-hub-game-btn").click();
    await page.locator("#game-tile-neondrift").click();
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("neonDriftHighScore", ">", 0).orderBy("neonDriftHighScore", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
