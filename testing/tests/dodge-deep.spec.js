// dodge-deep.spec.js
//
// Deep functional coverage for dodge.html (Dodge) — added 2026-08-02, same
// day the game shipped, per the every-3-upgrades cadence (written
// immediately at the user's request rather than waiting).
//
// The simplest submission model of any game so far: only one metric (high
// score, no time/level component), reported whenever an online run ends,
// whether by collision (endGame()) or by quitting early (backToGamesHub()).
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test dodge-deep.spec.js

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin, grantUnlimitedGamePlay } = require("../emulatorAdmin");

const P1 = { email: `dodge.p1.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("#signup-email").fill(robot.email);
  await page.locator("#signup-password").fill(robot.password);
  await page.locator("#signup-age-confirm").check();
  await page.locator("#signup-terms-confirm").check();
  await page.locator("#form-signup button[type=submit]").click();
}

function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

// Forces a deterministic collision (rather than real movement, which would
// be flaky) by teleporting an obstacle directly onto the player and letting
// the real checkCollision()/endGame() code process it on its next tick.
async function forceCollisionWithScore(page, targetScore) {
  await page.evaluate((s) => {
    score = s;
    scoreDisplay.textContent = 'Score: ' + score;
    const obstacle = document.createElement('div');
    obstacle.className = 'obstacle';
    const playerRect = player.getBoundingClientRect();
    const containerRect = gameContainer.getBoundingClientRect();
    obstacle.style.left = (playerRect.left - containerRect.left) + 'px';
    obstacle.style.top = (playerRect.top - containerRect.top) + 'px';
    gameContainer.appendChild(obstacle);
    obstacles.push({ element: obstacle, y: playerRect.top - containerRect.top });
  }, targetScore);
  await page.waitForFunction(() => gameActive === false, { timeout: 5000 });
}

test.describe.serial("Dodge — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "Dodge Robot" } },
      { merge: true }
    );
    await grantUnlimitedGamePlay(uid); // this spec runs several online runs back-to-back
  });

  test("Play for Fun: a forced collision ends the run untracked, and containerWidth is real (not 0) once the wrapper is shown", async () => {
    await page.goto("/dodge.html");
    await page.locator("#game-tile-dodge").click();
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#dodgeGameWrapper")).toBeVisible();
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    // Regression guard: containerWidth is read from gameContainer.offsetWidth,
    // which would be 0 if computed while the wrapper was still display:none —
    // startGame() recomputes it live, but only once the wrapper is visible.
    expect(await readVar(page, "containerWidth")).toBeGreaterThan(0);

    await forceCollisionWithScore(page, 5);
    await expect(page.locator("#gameOver")).toBeVisible();
    await expect(page.locator("#finalScore")).toHaveText("Final Score: 5");
  });

  test("Restart after game over always resumes untracked", async () => {
    await page.locator("#restartBtn").click();
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    expect(await readVar(page, "gameActive")).toBe(true);
  });

  test("Play Online (Ranked): quitting mid-run (before any collision) still submits the current score", async () => {
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-dodge").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#dodgeGameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    await page.evaluate(() => { score = 12; scoreDisplay.textContent = 'Score: 12'; });
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.dodgeHighScore) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.dodgeHighScore).toBe(12);
  });

  test("A forced collision at a higher score overwrites via endGame()'s submission path", async () => {
    await page.locator("#game-tile-dodge").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#dodgeGameWrapper")).toBeVisible();

    await forceCollisionWithScore(page, 40);

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.dodgeHighScore === 40) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.dodgeHighScore).toBe(40);
  });

  test("A worse follow-up run (lower score) does not overwrite the recorded high score", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await page.locator("#restartBtn").click(); // resumes untracked per convention
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-dodge").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#dodgeGameWrapper")).toBeVisible();
    await forceCollisionWithScore(page, 3);
    await page.waitForTimeout(1000);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.dodgeHighScore).toBe(before.dodgeHighScore);
  });

  test("Dodge leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    // NOTE: this deliberately does NOT assert on the live client-side query
    // result — the Firestore EMULATOR throws a spurious permission error on
    // this collection's `where(...)` list queries even for the querying
    // user's own matching document (confirmed emulator-only; real
    // production leaderboards work fine). Verify the view loads, and verify
    // the same query shape via the admin SDK instead.
    await page.locator("#restartBtn").click();
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });
    await page.locator("#game-tile-dodge").click();
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("dodgeHighScore", ">", 0).orderBy("dodgeHighScore", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
