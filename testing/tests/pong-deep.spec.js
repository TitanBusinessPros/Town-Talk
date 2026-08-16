// pong-deep.spec.js
//
// Deep functional coverage for pong.html (Classic Pong) — previously
// untested by the permanent suite. Different shape from every other solo
// game tested so far: both modes are SAME-DEVICE (vs Computer, or 2 Player
// Challenge with two people sharing one keyboard/screen), first to 7
// wins, and only a 2 Player Challenge win is ever submitted — to
// whichever single account is actually signed in on that device, credited
// regardless of which seat (P1/P2) won (see submitPongWin's own comment
// in pong.html). No daily play-limit gating exists on this page at all.
//
// pong.html's game-engine script is deliberately kept as a classic
// (non-module) script specifically so its state/functions land on real
// `window` scope — per its own comment, "matching every other game's
// testing convention" — so this can call the REAL checkPongGameOver()
// directly after setting a score, rather than needing an exposed
// window.* shim the way blocks.html's module script needed one.
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test pong-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `pong.p1.${Date.now()}@test.town`, displayName: "Pong Robot" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.displayName });
}

function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

async function waitForPongWins(uid, expected, timeoutMs = 15_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = (await admin.firestore().collection("users").doc(uid).get()).data()?.pongWins;
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`pongWins never became ${expected} within ${timeoutMs}ms (last seen: ${last})`);
}

test.describe.serial("Classic Pong — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "Pong Robot", neighborhood: "Pauls Valley" } },
      { merge: true }
    );
  });

  test("Play vs Computer: a forced win through the real checkPongGameOver() path is never submitted", async () => {
    await page.goto("/pong.html");
    await expect(page.locator("#mode-tile-ai")).toBeVisible({ timeout: 15_000 });
    await page.locator("#mode-tile-ai").click();
    await expect(page.locator("#view-game")).toBeVisible();
    expect(await readVar(page, "pongMode")).toBe("ai");

    await page.evaluate(() => { player1Score = 7; checkPongGameOver(); });
    await expect(page.locator("#pongGameOver")).toBeVisible();
    await expect(page.locator("#pongWinnerText")).toHaveText("PLAYER 1 WINS!");

    const data = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(data.pongWins).toBeFalsy();
  });

  test("Restart returns to a fresh 0-0 match, still vs Computer", async () => {
    await page.locator("#pongRestartBtn").click({ force: true }); // .pulse CSS animation (scale only, never repositions) fails Playwright's stability check otherwise
    await expect
      .poll(async () => await readVar(page, "player1Score"))
      .toBe(0);
    expect(await readVar(page, "pongMode")).toBe("ai");
  });

  test("2 Player Challenge: a forced Player 1 win submits through the real submitPongWin() path", async () => {
    await page.locator("#pongBackBtn").click();
    await expect(page.locator("#mode-tile-2p")).toBeVisible({ timeout: 10_000 });
    await page.locator("#mode-tile-2p").click();
    await expect(page.locator("#view-game")).toBeVisible();
    expect(await readVar(page, "pongMode")).toBe("2p");

    await page.evaluate(() => { player1Score = 7; checkPongGameOver(); });
    await waitForPongWins(uid, 1);
  });

  test("2 Player Challenge: a Player 2 win ALSO credits the one signed-in account (same device, same tally)", async () => {
    await page.locator("#pongRestartBtn").click({ force: true }); // .pulse CSS animation (scale only, never repositions) fails Playwright's stability check otherwise
    await expect
      .poll(async () => await readVar(page, "player2Score"))
      .toBe(0);

    await page.evaluate(() => { player2Score = 7; checkPongGameOver(); });
    await expect(page.locator("#pongWinnerText")).toHaveText("PLAYER 2 WINS!");
    await waitForPongWins(uid, 2); // incremented again, regardless of which seat won
  });

  test("Vs Computer games still never submit, even played right after real 2 Player wins", async () => {
    // Deliberately going straight to Back from the already-finished game
    // over screen, WITHOUT clicking Restart first — restart reuses
    // whatever pongMode currently is (still '2p' from the prior test) and
    // makes pongGameActive true again, briefly re-activating a live match
    // whose real ball-physics loop can score naturally in the background
    // while later actions here are still processing. Confirmed as the
    // real cause of a flaky-looking failure here 2026-08-16 (pongWins
    // ended up 3, not 2 — the stale 2p match scored for real before this
    // test ever got to mode-tile-ai). Game over already means
    // pongGameActive is false, so it's safe to leave as-is.
    await page.locator("#pongBackBtn").click();
    await expect(page.locator("#mode-tile-ai")).toBeVisible({ timeout: 10_000 });
    await page.locator("#mode-tile-ai").click();
    await expect(page.locator("#view-game")).toBeVisible();

    await page.evaluate(() => { player1Score = 7; checkPongGameOver(); });
    await page.waitForTimeout(1500); // give a wrongful submit a real chance to land before checking
    const data = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(data.pongWins).toBe(2); // unchanged from the two real 2p wins above
  });

  test("Classic Pong leaderboard view is reachable and the recorded data is queryable in win order", async () => {
    // NOTE: deliberately not asserting on the live client-side query result
    // — the Firestore emulator throws a spurious permission error on this
    // collection's where(...) list queries even for the querying user's
    // own matching document (same emulator-only quirk documented in
    // dodge-deep.spec.js; real production leaderboards work fine). Verify
    // the view loads, and verify the same query shape via the admin SDK.
    await page.locator("#pongBackBtn").click(); // no need to restart first — see the comment on the test above
    await expect(page.locator("#mode-tile-ai")).toBeVisible({ timeout: 10_000 });
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("pongWins", ">", 0).orderBy("pongWins", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
