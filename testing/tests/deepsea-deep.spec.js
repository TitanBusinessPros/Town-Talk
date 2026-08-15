// deepsea-deep.spec.js
//
// Deep functional coverage for deepsea.html (Deep Sea Gem Diver) — added
// 2026-08-02, the day the game shipped. Architecturally almost identical to
// dodge.html (solo endless run, single high-score metric, "Play for Fun" vs
// "Play Online (Ranked)"), so this follows dodge-deep.spec.js's pattern
// closely, adapted for the one real difference: a character-selection step
// between choosing a mode and the run actually starting.
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test deepsea-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, grantUnlimitedGamePlay } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `deepsea.p1.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

async function pickCharacterAndDive(page) {
  await page.locator("#startGameBtn").click();
  await expect(page.locator("#gameArea .diver")).toBeVisible({ timeout: 10_000 });
}

test.describe.serial("Deep Sea Gem Diver — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "Deep Sea Robot" } },
      { merge: true }
    );
    await grantUnlimitedGamePlay(uid); // this spec runs several online runs back-to-back
  });

  test("Play for Fun: character selection deals into a real run, untracked", async () => {
    await page.goto("/deepsea.html");
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#deepSeaWrapper")).toBeVisible();
    await expect(page.locator("#characterScreen")).toBeVisible();

    // Second character should be selectable, not just the default first one.
    await page.locator('.character-option[data-character="player2"]').click();
    await expect(page.locator('.character-option[data-character="player2"]')).toHaveClass(/selected/);

    await pickCharacterAndDive(page);
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    expect(await readVar(page, "selectedCharacter")).toBe("player2");
    // Regression guard: gameArea dimensions are read while the wrapper is
    // visible (matching dodge.html's containerWidth lesson) — the diver's
    // starting x/y depend on gameArea.offsetWidth/Height being real, not 0.
    expect(await readVar(page, "diverPosition.x")).toBeGreaterThan(0);
  });

  test("A real coral collision (not a forced score) ends the run through the actual detection code", async () => {
    // Teleport a coral directly onto the diver and let the real
    // checkCoralCollision()/gameOver() code process it on its next tick —
    // proves the actual geometry-based detection works, not just the
    // score-submission path other tests exercise more directly.
    await page.evaluate(() => {
      const coralX = diverPosition.x;
      const coralY = diverPosition.y;
      createCoral(coralX, coralY);
    });
    await page.waitForFunction(() => gameActive === false, { timeout: 5_000 });
    await expect(page.locator("#gameOverScreen")).toBeVisible();
  });

  test("Restart after game over deals a fresh run, still untracked", async () => {
    await page.locator("#restartBtn").click();
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    expect(await readVar(page, "gameActive")).toBe(true);
    await expect(page.locator("#gameArea .diver")).toBeVisible();
  });

  test("Play Online (Ranked): quitting mid-run still submits the current score", async () => {
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });

    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#deepSeaWrapper")).toBeVisible();
    await expect(page.locator("#run-status-deepsea")).toContainText("Online run");
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    await pickCharacterAndDive(page);
    await page.evaluate(() => { score = 220; updateUI(); });
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.deepSeaHighScore) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.deepSeaHighScore).toBe(220);
  });

  test("A higher-scoring forced game-over overwrites via the real submission path", async () => {
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#deepSeaWrapper")).toBeVisible();
    await pickCharacterAndDive(page);

    await page.evaluate(() => { score = 500; gameOver(); });
    await expect(page.locator("#gameOverScreen")).toBeVisible();

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.deepSeaHighScore === 500) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.deepSeaHighScore).toBe(500);
  });

  test("A worse follow-up run does not overwrite the recorded high score", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await page.locator("#restartBtn").click(); // resumes untracked per convention
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });

    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#deepSeaWrapper")).toBeVisible();
    await pickCharacterAndDive(page);
    await page.evaluate(() => { score = 10; gameOver(); });
    await page.waitForTimeout(1000);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.deepSeaHighScore).toBe(before.deepSeaHighScore);
  });

  test("Deep Sea Gem Diver leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    // Same defensive pattern dodge-deep.spec.js/cribbage-deep.spec.js use:
    // verify the view loads, cross-check via the admin SDK rather than
    // asserting on the live client-side query result, since the Firestore
    // EMULATOR has shown real flakiness on `users` collection list queries
    // before (a known class of issue this session already root-caused and
    // fixed for game-table collections with a `.get(field, default)`
    // accessor — the `users` rule itself hasn't been touched, so the same
    // flake can still surface here).
    await page.locator("#restartBtn").click();
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("deepSeaHighScore", ">", 0).orderBy("deepSeaHighScore", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    // chess.html itself initializes App Check (unlike this file), and by
    // the time this last test runs the emulator has accumulated load from
    // every prior test in the file — confirmed via a direct diagnostic
    // that the navigation always succeeds, just sometimes past 10s.
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
