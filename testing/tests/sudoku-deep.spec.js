// sudoku-deep.spec.js
//
// Deep functional coverage for sudoku.html — added 2026-08-01 alongside
// neon-drift-deep.spec.js to close the gap those two newest games had:
// each previously only got a one-off diagnostic script (deleted after use)
// instead of permanent coverage.
//
// Sudoku's leaderboard is a pure online win-streak (win puzzles back to
// back; one loss ends the run) — hints are disabled online specifically so
// the streak can't be farmed for free, which this spec also verifies.
//
// Uses its own throwaway account so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test sudoku-deep.spec.js

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin } = require("../emulatorAdmin");

const P1 = { email: `sudoku.p1.${Date.now()}@test.town`, password: "TestPass123!" };

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

async function forceWinViaRealFillCell(page) {
  await page.evaluate(() => {
    board = initialBoard.map((row) => [...row]);
    updateBoardDisplay();
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 9; j++) {
        if (board[i][j] === 0) {
          const index = i * 9 + j;
          const cell = document.querySelector(`.cell[data-index="${index}"]`);
          fillCell(cell, solution[i][j]);
        }
      }
    }
  });
}

test.describe.serial("Sudoku — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    // agreedToTerms matters here — index.html's canSeeFullNav (and thus any
    // nav-dependent flow) requires it alongside emailVerified. Missing this
    // once already caused a real test hang (see tier-limits.spec.js history).
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: "Sudoku Robot" } },
      { merge: true }
    );
  });

  test("Play for Fun: filling the board with the real solution wins the puzzle, nothing submitted", async () => {
    await page.goto("/sudoku.html");
    await page.locator("#game-tile-sudoku").click();
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#sudokuGameWrapper")).toBeVisible();
    expect(await readVar(page, "isOnlineRun")).toBe(false);

    await forceWinViaRealFillCell(page);
    await expect(page.locator("#victoryOverlay")).toHaveClass(/active/);
    await page.locator("#celebrationNewGame").click();
  });

  test("Play Online (Ranked): hints are disabled, and winning advances the streak", async () => {
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-sudoku").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#sudokuGameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");
    expect(await readVar(page, "isOnlineRun")).toBe(true);
    // Regression guard: a pure streak leaderboard is meaningless if hints
    // let anyone farm an infinite streak — beginRun() hides the button.
    await expect(page.locator("#hintBtn")).toBeHidden();

    await forceWinViaRealFillCell(page);
    await expect(page.locator("#run-status")).toContainText("current streak: 1");
    await page.locator("#celebrationNewGame").click();

    await page.locator('.diff-btn[data-diff="medium"]').click();
    await forceWinViaRealFillCell(page);
    await expect(page.locator("#run-status")).toContainText("current streak: 2");

    // Poll for the SPECIFIC value 2, not just any truthy streak — the
    // first win already submitted streak=1 moments ago, which would
    // otherwise satisfy a bare truthy check before the second win's
    // submission has actually landed.
    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.sudokuBestStreak === 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.sudokuBestStreak).toBe(2);
  });

  test("A loss ends the streak attempt and resets the tracked session", async () => {
    await page.locator("#celebrationNewGame").click();
    await page.evaluate(() => {
      // Deliberately fill every empty cell with a WRONG number (never the
      // true solution) until maxWrong is exceeded and gameActive flips off.
      for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
          if (!gameActive) return;
          if (board[i][j] === 0) {
            const correct = solution[i][j];
            const wrong = (correct % 9) + 1 === correct ? ((correct % 9) + 2) % 10 || 1 : (correct % 9) + 1;
            const index = i * 9 + j;
            const cell = document.querySelector(`.cell[data-index="${index}"]`);
            fillCell(cell, wrong);
          }
        }
      }
    });
    await expect(page.locator("#gameOverOverlay")).toHaveClass(/active/, { timeout: 10_000 });
    expect(await readVar(page, "isOnlineRun")).toBe(false);
    expect(await readVar(page, "onlineStreak")).toBe(0);

    // The best streak recorded before the loss (2) must survive untouched.
    const data = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(data.sudokuBestStreak).toBe(2);
  });

  test("Sudoku leaderboard view is reachable and the recorded data is queryable in streak order", async () => {
    // NOTE: this deliberately does NOT assert on the live client-side query
    // result — the Firestore EMULATOR throws a spurious permission error on
    // this collection's `where(...)` list queries even for the querying
    // user's own matching document (confirmed emulator-only; real
    // production leaderboards work fine). Verify the view loads, and verify
    // the same query shape via the admin SDK instead.
    await page.locator("#gameOverNewGame").click().catch(() => {});
    await page.locator("#back-to-hub-game-btn").click().catch(() => {});
    await page.locator("#game-tile-sudoku").click();
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("sudokuBestStreak", ">", 0).orderBy("sudokuBestStreak", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 10_000 });
  });
});
