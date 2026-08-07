// match3-deep.spec.js
//
// Deep functional coverage for match3.html — previously untested by the
// permanent suite. Added 2026-07-31 alongside follow-deep/desert-deep/
// cribbage-deep to close the gap: the permanent suite only covered
// chess/checkers/WynneWars/Golf/Frisbee Golf, leaving the four newer
// "solo run + leaderboard" games (Match-3, Follow Along, Desert Rattler,
// Cribbage) with no regression coverage of their own.
//
// Rather than waiting on real (random) tile swaps to produce a match —
// which could be flaky depending on the random grid — this directly seeds
// three same-color cells and calls the real processMatches() function, the
// same technique already validated live this session for Desert Rattler's
// fruit collision.
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test match3-deep.spec.js

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin } = require("../emulatorAdmin");

const P1 = { email: `match3.p1.${Date.now()}@test.town`, password: "TestPass123!" };

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

// Forces a deterministic 3-in-a-row at (0,0)-(0,2) and lets the real
// processMatches() (scoring, cascade, level-complete check) run for real.
async function forceOneMatch(page) {
  await page.evaluate(() => {
    grid[0][0] = 0; grid[0][1] = 0; grid[0][2] = 0;
    processMatches();
  });
  await page.waitForTimeout(1500); // match animation + drop + cascade-check chain
}

test.describe.serial("Match-3 — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, profile: { name: "Match3 Robot" } },
      { merge: true }
    );
  });

  test("Play for Fun: forcing a match raises the score via the real match-processing code", async () => {
    await page.goto("/match3.html");
    await page.locator("#game-tile-match3").click();
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#match3GameWrapper")).toBeVisible();
    await expect(page.locator(".grid .tile")).toHaveCount(64);

    expect(await readVar(page, "score")).toBe(0);
    await forceOneMatch(page);
    const score = await readVar(page, "score");
    expect(score).toBeGreaterThanOrEqual(30); // 3 tiles * 10 pts, or more if it cascaded
    await expect(page.locator("#score")).toContainText(String(score));
  });

  test("Play Online (Ranked): leaving mid-run after a forced match submits match3Best*", async () => {
    await page.locator("#match3GameWrapper button", { hasText: "Back to Games" }).click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-match3").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#match3GameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    await forceOneMatch(page);
    const totalScoreBefore = await readVar(page, "totalScore");
    expect(totalScoreBefore).toBeGreaterThanOrEqual(30);

    // Leaving early still submits whatever score/time this run has so far.
    await page.locator("#match3GameWrapper button", { hasText: "Back to Games" }).click();

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.match3BestScore) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.match3BestScore).toBe(totalScoreBefore);
    expect(data.match3BestTimeMs).toBeGreaterThan(0);
    expect(data.match3BestEfficiency).toBeCloseTo(data.match3BestScore / (data.match3BestTimeMs / 1000), 5);
  });

  test("A worse follow-up run (lower efficiency) does not overwrite the recorded best", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await page.locator("#game-tile-match3").click();
    await page.locator("#mode-tile-online").click();
    // mode-tile-online's click handler is async (awaits reserveGamePlaySlot
    // before calling beginRun(true)) and the listener isn't awaited by the
    // click itself, so isOnlineRun isn't reliably set the instant .click()
    // resolves — wait for the visible effect of beginRun(true) first.
    await expect(page.locator("#match3GameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");
    expect(await readVar(page, "isOnlineRun")).toBe(true);

    // Burn a couple of real seconds before scoring anything. NOTE: we
    // deliberately do NOT use forceOneMatch() here — processMatches()'s
    // tile refill uses Math.random() and can cascade into further matches,
    // so its resulting score is unbounded and occasionally out-scored the
    // first run enough to beat the time handicap (a real flake seen in
    // practice: score 90 here vs. 30 on the first run outweighed 2.5s).
    // Setting totalScore directly keeps the score side deterministic while
    // still exercising the real submission code path (backToGamesHub()
    // reads the live totalScore/runStartTime globals on click).
    await page.waitForTimeout(2500);
    await page.evaluate(() => { totalScore = 10; });
    await page.locator("#match3GameWrapper button", { hasText: "Back to Games" }).click();
    await page.waitForTimeout(1500);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.match3BestScore).toBe(before.match3BestScore);
    expect(after.match3BestTimeMs).toBe(before.match3BestTimeMs);
    expect(after.match3BestEfficiency).toBe(before.match3BestEfficiency);
  });

  test("Match-3 leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
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
    await page.locator("#game-tile-match3").click(); // nav-leaderboard only shows outside "hub"
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("match3BestEfficiency", ">", 0).orderBy("match3BestEfficiency", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html), not a local single-tile view", async () => {
    // Regression: nav-hub used to just re-show match3.html's own tiny
    // one-tile #view-hub, which reads as "clicking Games did nothing" —
    // reported by the user 2026-07-31. Every other game (checkers, golf,
    // Frisbee Golf, Cribbage) redirects to chess.html instead.
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
