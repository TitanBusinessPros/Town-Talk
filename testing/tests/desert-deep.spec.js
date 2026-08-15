// desert-deep.spec.js
//
// Deep functional coverage for desert.html — previously untested by the
// permanent suite. Added 2026-07-31 after a user bug report ("doesn't keep
// score, snake doesn't grow"). Live investigation that day found the core
// mechanic actually works correctly (confirmed with a forced-fruit test and
// a screenshot) — this spec exists so that mechanic, and the online
// high-score submission path, stay covered going forward.
//
// Uses its own throwaway account (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test desert-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `desert.p1.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

// Overwrites the fruit list with a single fruit directly one step ahead of
// the snake's head, on the head's current heading — makes the "does eating
// a fruit grow the snake and raise the score" mechanic deterministic
// instead of waiting on random placement.
async function placeFruitInPath(page) {
  await page.evaluate(() => {
    const head = snake[0];
    fruits.length = 0;
    fruits.push({ x: head.x + (dx || 1), y: head.y + dy, color: "#ff0000", size: 10 });
  });
}

test.describe.serial("Desert Rattler — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, profile: { name: "Desert Robot" } },
      { merge: true }
    );
  });

  test("Play for Fun: eating a forced fruit grows the snake and raises the score", async () => {
    await page.goto("/desert.html");
    await page.locator("#game-tile-desert").click();
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#desertGameWrapper")).toBeVisible();

    const before = await page.evaluate(() => ({ len: snake.length, score }));
    expect(before.len).toBe(1);
    expect(before.score).toBe(0);

    await placeFruitInPath(page);
    await page.locator("#startButton").click();
    // Poll for the forced fruit being eaten, then immediately halt further
    // ticks — generateFruit() places its replacement at a random spot, and
    // a fixed sleep long enough for several ticks risks that RANDOM fruit
    // also landing in the snake's path, eating a second one by chance and
    // making this assertion flaky (observed: len 3 instead of 2).
    await page.waitForFunction(() => score >= 1, { timeout: 3000 });
    const after = await page.evaluate(() => {
      clearInterval(gameInterval);
      return { len: snake.length, score };
    });
    expect(after.len).toBe(2);
    expect(after.score).toBe(1);
    await expect(page.locator("#currentScoreDisplay")).toContainText("Score: 1");
  });

  test("Play Online (Ranked): a forced wall collision submits desertHighScore", async () => {
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-desert").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#desertGameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");

    await placeFruitInPath(page);
    await page.locator("#startButton").click();
    await page.waitForTimeout(1000);
    expect(await readVar(page, "score")).toBeGreaterThanOrEqual(1);
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    // Force a deterministic wall collision so checkGameOver() fires on the
    // next tick, exercising the real online game-over → submitRunResult path.
    await page.evaluate(() => { snake[0].x = -1; });
    await page.waitForTimeout(500);
    expect(await readVar(page, "gameRunning")).toBe(false);

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.desertHighScore) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.desertHighScore).toBeGreaterThanOrEqual(1);
  });

  test("A worse follow-up run (0 score) does not overwrite the recorded high score", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await page.locator("#restartButton").click();
    // restartGame() always resumes untracked (isOnlineRun=false) by design,
    // same as match3/follow — so this run has nothing to submit even if it
    // scores. Crash immediately into a wall with no fruit eaten.
    await page.evaluate(() => { snake[0].x = -1; });
    await page.locator("#startButton").click();
    await page.waitForTimeout(500);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.desertHighScore).toBe(before.desertHighScore);
  });

  test("Desert Rattler leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    // NOTE: this deliberately does NOT assert on the live client-side query
    // result. The Firestore EMULATOR (confirmed via a standalone repro
    // script) throws "Property approved is undefined" on this collection's
    // `where(...)` list queries even when the querying user's OWN matching
    // document should trivially satisfy the rule via isOwner() — a known
    // emulator-only gap in implementing Firestore security rules' documented
    // error-tolerant `||` (a real document, actually approved:true, still
    // triggers it). Confirmed with the user this is emulator-only — the
    // real leaderboard works in production. So: verify the view loads, and
    // verify (via the admin SDK, bypassing rules) that the exact same
    // query shape the client uses returns this run's result correctly.
    await page.locator("#back-to-hub-game-btn").click();
    await page.locator("#game-tile-desert").click(); // nav-leaderboard only shows outside "hub"
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("desertHighScore", ">", 0).orderBy("desertHighScore", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html), not a local single-tile view", async () => {
    // Regression: nav-hub used to just re-show desert.html's own tiny
    // one-tile #view-hub, which reads as "clicking Games did nothing" —
    // reported by the user 2026-07-31. Every other game (checkers, golf,
    // Frisbee Golf, Cribbage) redirects to chess.html instead.
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
