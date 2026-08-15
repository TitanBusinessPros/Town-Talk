// titanspace-deep.spec.js
//
// Deep functional coverage for titanspace.html (Titan Space Defense) —
// added 2026-08-03, the day the game shipped. Same solo/high-score
// leaderboard architecture as dodge.html/deepsea.html (Play for Fun vs
// Play Online Ranked, single titanSpaceHighScore metric), but this game
// draws its own start/game-over/restart UI directly on the canvas rather
// than using DOM buttons — so instead of clicking DOM elements for those
// transitions, this test reads/drives the classic script's own global
// state via page.evaluate(), and clicks the canvas at the coordinates the
// game's own handleRestartClick() computes for its "PLAY AGAIN" button.
//
// Also directly exercises the rebalanced difficulty-curve functions
// (waveEnemiesFor/healthMultiplierFor/speedMultiplierFor), since the whole
// point of this build was making sure levels never stop scaling but also
// never explode into an unplayable/absurd state at high levels — a real
// regression to guard against going forward.
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test titanspace-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, grantUnlimitedGamePlay } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `titanspace.p1.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

async function tapToStart(page) {
  // Click canvas CENTER, not a corner — (50,50) sat directly under the
  // back-to-hub button (top:20px;left:20px), which correctly intercepted
  // the click instead of reaching the canvas underneath it.
  const center = await page.evaluate(() => ({ x: canvas.width / 2, y: canvas.height / 2 }));
  await page.locator("#game").click({ position: center });
  await page.waitForFunction(() => gameStarted === true, { timeout: 5_000 });
}

// Mirrors handleRestartClick()'s own button-position formula so the click
// lands on the real "PLAY AGAIN" hit target the game itself computes.
async function clickPlayAgain(page) {
  const pos = await page.evaluate(() => {
    const centerX = canvas.width / 2;
    const buttonY = canvas.height / 2 + 120;
    return { x: centerX, y: buttonY + 30 };
  });
  await page.locator("#game").click({ position: pos });
}

async function forceGameOver(page, score) {
  await page.evaluate((s) => { score = s; lives = 0; loseLife(); }, score);
  await page.waitForFunction(() => gameOver === true, { timeout: 5_000 });
}

test.describe.serial("Titan Space Defense — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "Titan Space Robot" } },
      { merge: true }
    );
    await grantUnlimitedGamePlay(uid); // this spec runs several online runs back-to-back
  });

  test("The rebalanced difficulty curve stays bounded at very high levels (the whole point of this build)", async () => {
    await page.goto("/titanspace.html");
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#titanSpaceWrapper")).toBeVisible();

    // Calibration check: the new sqrt-based multipliers were tuned to
    // match the ORIGINAL linear formulas exactly at level 15 (the
    // original design's own max level), so existing balance for the
    // tested range is preserved.
    const at15 = await page.evaluate(() => ({
      health: healthMultiplierFor(15),
      speed: speedMultiplierFor(15),
    }));
    expect(at15.health).toBeCloseTo(1 + 15 * 0.15, 1);
    expect(at15.speed).toBeCloseTo(1 + 15 * 0.07, 1);

    // The regression this whole rebalance exists to prevent: the ORIGINAL
    // formulas were unbounded linear growth — at level 200 that would
    // have meant ~205 enemies per wave and enemies with 30x their base
    // health. The new curve must stay sane indefinitely.
    const atExtreme = await page.evaluate(() => ({
      wave: waveEnemiesFor(200),
      health: healthMultiplierFor(200),
      speed: speedMultiplierFor(200),
    }));
    expect(atExtreme.wave).toBeLessThanOrEqual(50);
    expect(atExtreme.health).toBeLessThan(15);
    expect(atExtreme.speed).toBeLessThan(8);

    // No more sudden difficulty cliff at the old level-12 boundary — the
    // original had wave size instantly DROP from 63 (level 11) to 29
    // (level 12) because two different formulas met there.
    const around12 = await page.evaluate(() => [11, 12, 13].map(waveEnemiesFor));
    expect(Math.abs(around12[1] - around12[0])).toBeLessThan(10);
    expect(Math.abs(around12[2] - around12[1])).toBeLessThan(10);
  });

  test("Play for Fun: tapping the canvas starts a real, untracked run", async () => {
    await tapToStart(page);
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    expect(await readVar(page, "currentLevel")).toBe(1);
    expect(await readVar(page, "lives")).toBe(5);
  });

  test("Levels keep advancing past the old 15-level cap with no fixed win condition", async () => {
    // Real gameplay reaches level 20 through many cleared waves — jump
    // straight there via the real startLevel() function (the same one
    // nextLevel() calls) rather than scripting dozens of real kills.
    await page.evaluate(() => { startLevel(20); });
    expect(await readVar(page, "currentLevel")).toBe(20);
    expect(await readVar(page, "gameRunning")).toBe(true); // still playing, no win screen
    // readVar's eval() would throw a ReferenceError on a plain "gameWon"
    // reference for an undeclared variable — put `typeof` INSIDE the
    // evaluated expression instead, which is exactly what `typeof` is for.
    expect(await readVar(page, "typeof gameWon")).toBe("undefined"); // the old win-condition variable no longer exists at all
  });

  test("A forced game over (not a real collision) ends the run through the real loseLife()/showGameOver() path", async () => {
    await forceGameOver(page, 0);
    expect(await readVar(page, "lives")).toBeLessThanOrEqual(0);
  });

  test("Clicking PLAY AGAIN at the real computed button position restarts, still untracked", async () => {
    await clickPlayAgain(page);
    await page.waitForFunction(() => gameOver === false && gameStarted === true, { timeout: 5_000 });
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    expect(await readVar(page, "currentLevel")).toBe(1);
  });

  test("Play Online (Ranked): a forced game over submits the score through the real path", async () => {
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });

    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#titanSpaceWrapper")).toBeVisible();
    await expect(page.locator("#run-status-titanspace")).toContainText("Online run");
    await tapToStart(page);
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    await forceGameOver(page, 340);

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.titanSpaceHighScore) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.titanSpaceHighScore).toBe(340);
  });

  test("A higher score overwrites the recorded best", async () => {
    await clickPlayAgain(page);
    await page.waitForFunction(() => gameOver === false && gameStarted === true, { timeout: 5_000 });
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });

    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#titanSpaceWrapper")).toBeVisible();
    await tapToStart(page);
    await forceGameOver(page, 900);

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.titanSpaceHighScore === 900) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.titanSpaceHighScore).toBe(900);
  });

  test("A worse follow-up run does not overwrite the recorded high score", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await clickPlayAgain(page); // resumes untracked per convention
    await page.waitForFunction(() => gameOver === false && gameStarted === true, { timeout: 5_000 });
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });

    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#titanSpaceWrapper")).toBeVisible();
    await tapToStart(page);
    await forceGameOver(page, 50);
    await page.waitForTimeout(1000);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.titanSpaceHighScore).toBe(before.titanSpaceHighScore);
  });

  test("Titan Space Defense leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    // Same defensive pattern dodge-deep/deepsea-deep.spec.js use: verify
    // the view loads, cross-check via the admin SDK rather than asserting
    // on the live client-side query result, since the Firestore EMULATOR
    // has shown real flakiness on `users` collection list queries before.
    await clickPlayAgain(page);
    await page.waitForFunction(() => gameOver === false, { timeout: 5_000 });
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("titanSpaceHighScore", ">", 0).orderBy("titanSpaceHighScore", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    // chess.html initializes App Check (this file doesn't) and by this
    // last test the emulator has accumulated load from every prior test
    // in the file — a 20s timeout avoids the same false-flake seen with
    // blackjack-deep.spec.js and deepsea-deep.spec.js.
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
