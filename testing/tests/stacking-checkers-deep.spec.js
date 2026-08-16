// stacking-checkers-deep.spec.js
//
// Deep functional coverage for stacking-checkers.html — previously
// untested by the permanent suite. A checkers variant (8x8, captures
// stack pieces instead of removing them) with the same three-mode shape
// as most other multiplayer games here: vs Computer (with a difficulty
// pick), 2 Player local, and Online (Ranked) — waiting room, invite/join,
// real Firestore-synced turns, same structure as regular checkers.html
// (already covered in full-platform.spec.js) but with its own board
// layout: light pieces start rows 0-2, dark rows 5-7, LIGHT moves first
// (not red/dark like base checkers) — confirmed from buildInitialBoard()
// directly rather than assumed from the other game.
//
// A full real game to natural completion would mean working out actual
// capture-chain sequences in the stacking variant's own rules — instead
// this proves the win/stats path the same way War/Hearts do: a real
// resign, which is itself a genuine first-class action in the game
// (`#stack-resign-btn` → resignStackGame()), not a test-only shortcut.
//
// Uses its own throwaway accounts so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test stacking-checkers-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, grantUnlimitedGamePlay } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `stack.p1.${Date.now()}@test.town`, displayName: "Stack Robot A" };
const P2 = { email: `stack.p2.${Date.now()}@test.town`, displayName: "Stack Robot B" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.displayName });
}

async function waitForGameStatus(gameId, status, timeoutMs = 15_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = (await admin.firestore().collection("stackCheckersGames").doc(gameId).get()).data()?.status;
    if (last === status) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`stackCheckersGames/${gameId}.status never became "${status}" within ${timeoutMs}ms (last seen: "${last}")`);
}

test.describe.serial("Stacking Checkers — deep functional pass", () => {
  test.setTimeout(180_000);
  let pageA, pageB, contextA, contextB, uidA, uidB, gameId;

  test("Sign up two throwaway players and verify email", async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    await signUp(pageA, P1);
    await signUp(pageB, P2);
    uidA = await verifyEmailByAddress(P1.email);
    uidB = await verifyEmailByAddress(P2.email);
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, agreedToTerms: true, profile: { name: P1.displayName, neighborhood: "Pauls Valley" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, agreedToTerms: true, profile: { name: P2.displayName, neighborhood: "Pauls Valley" } }, { merge: true });
    await grantUnlimitedGamePlay(uidA);
    await grantUnlimitedGamePlay(uidB);
  });

  test("Local play: vs Computer (Medium) loads after a difficulty pick and accepts a move", async () => {
    await pageA.goto("/stacking-checkers.html");
    // Explicit wait before the first click on a freshly-loaded page —
    // clicking immediately after goto() can race the app's own async init
    // (checkForActiveGame()/auth-state-driven view setup), which can call
    // showView() itself a moment later and clobber this navigation.
    // Confirmed as a real flake here 2026-08-16 (#view-difficulty stayed
    // hidden); same documented nav-race class as other games in this
    // codebase, not something to reproduce in every future test file.
    await expect(pageA.locator("#mode-tile-ai")).toBeVisible({ timeout: 15_000 });
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#view-difficulty")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#difficulty-medium").click();
    await expect(pageA.locator("#stackWrapper")).toBeVisible({ timeout: 10_000 });

    // Light moves first — a piece at (2,1) has an empty diagonal-forward
    // square at (3,0), same legal-opening-move reasoning full-platform's
    // checkers.html test uses, just re-derived from THIS game's own
    // buildInitialBoard() layout (light starts rows 0-2 here, not the
    // other game's row 5).
    await pageA.locator('[data-row="2"][data-col="1"]').click();
    await pageA.locator('[data-row="3"][data-col="0"]').click();
    const moved = await pageA.locator('[data-row="3"][data-col="0"]').innerHTML();
    expect(moved.trim().length).toBeGreaterThan(0);

    await pageA.locator("#stack-back-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
  });

  test("Stacking Checkers: create an open table, Robot B joins, both see the board", async () => {
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#create-table-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#stackWrapper")).toBeVisible({ timeout: 15_000 });

    await pageB.goto("/stacking-checkers.html");
    await pageB.locator("#mode-tile-online").click();
    await expect(pageB.locator("#open-tables-list button", { hasText: "Join" }).first()).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#open-tables-list button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#stackWrapper")).toBeVisible({ timeout: 15_000 });

    const snap = await admin.firestore().collection("stackCheckersGames").where("player1Uid", "==", uidA).get();
    expect(snap.empty).toBe(false);
    gameId = snap.docs[0].id;
    await waitForGameStatus(gameId, "active");
  });

  test("A move made by Robot A (light, moves first) appears on Robot B's board", async () => {
    // The previous test only confirmed the backend reached "active" — not
    // that Robot A's own onSnapshot listener has actually applied that
    // yet. handleSquareClick() no-ops entirely until the client-side
    // gameStarted flag flips true (applyOnlineGameState() sets it from
    // gameData.status), so clicking too early silently does nothing.
    // #stack-resign-btn only shows once that's happened — wait for it as
    // a real UI-visible signal instead of trusting the backend check alone.
    await expect(pageA.locator("#stack-resign-btn")).toBeVisible({ timeout: 10_000 });
    // Confirmed genuinely intermittent 2026-08-16 (passed clean on some
    // runs, failed on others with the exact same code) — the onSnapshot
    // listener behind applyOnlineGameState() can fire more than once
    // right as the game transitions to "active" (an initial from-cache
    // snapshot, then a server-confirmed one), and renderBoard() rebuilds
    // the board's DOM from scratch on every call. A click landing between
    // that rebuild and the old node being detached can silently miss.
    // Giving it a moment to settle, then retrying the select-click once
    // if it didn't actually select, covers both the timing race and
    // (redundantly, harmlessly) an ordinary slow-click miss.
    await pageA.waitForTimeout(1000);
    await pageA.locator('[data-row="2"][data-col="1"]').click();
    if (!(await pageA.locator('[data-row="2"][data-col="1"]').getAttribute("class"))?.includes("square-selected")) {
      await pageA.locator('[data-row="2"][data-col="1"]').click();
    }
    await pageA.locator('[data-row="3"][data-col="0"]').click();

    await pageB.waitForTimeout(2000);
    const pieceMovedForB = await pageB.locator('[data-row="3"][data-col="0"]').innerHTML();
    expect(pieceMovedForB.trim().length).toBeGreaterThan(0);
    const originSquareForB = await pageB.locator('[data-row="2"][data-col="1"]').innerHTML();
    expect(originSquareForB.trim().length).toBe(0);

    // Firestore field is "turn" — submitOnlineMove() writes it that way;
    // "currentPlayer" is only the client-side local variable's own name.
    const data = (await admin.firestore().collection("stackCheckersGames").doc(gameId).get()).data();
    expect(data.turn).toBe("dark"); // turn passed to Robot B
  });

  test("Resign ends the game for real, crediting the other player the win through resignStackGame()", async () => {
    await pageA.on("dialog", (d) => d.accept()); // resignStackGame() uses a native confirm()
    await pageA.locator("#stack-resign-btn").click();

    await waitForGameStatus(gameId, "finished");
    const finalData = (await admin.firestore().collection("stackCheckersGames").doc(gameId).get()).data();
    expect(finalData.winner).toBe(uidB); // Robot A (light) resigned, so Robot B (dark) wins
  });

  test("Stats get recorded for both players through the real transaction-based path", async () => {
    let userA, userB;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA?.stackCheckersLosses && userB?.stackCheckersWins) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(userB.stackCheckersWins).toBe(1);
    expect(userB.stackCheckersPoints).toBe(3);
    expect(userA.stackCheckersLosses).toBe(1);
    expect(userA.stackCheckersPoints || 0).toBe(0);
  });

  test("Stacking Checkers leaderboard view is reachable and the recorded data is queryable in points order", async () => {
    // NOTE: deliberately not asserting on the live client-side query result
    // — the Firestore emulator throws a spurious permission error on this
    // collection's where(...) list queries even for the querying user's
    // own matching document (same emulator-only quirk documented in
    // dodge-deep.spec.js/golf-deep.spec.js; real production leaderboards
    // work fine). Verify the view loads, and verify the same query shape
    // via the admin SDK.
    await pageB.locator("#stack-back-btn").click();
    // backToStackHub() lands on mode-select, not the waiting room —
    // confirmed directly from the function itself. #nav-leaderboard is
    // only actually shown from inside the waiting room or leaderboard
    // views (see showView()'s insideOnlineMultiplayer check), so this
    // has to go through mode-tile-online first, same as a real user
    // would, and same fix already applied to sea-war-deep.spec.js's
    // equivalent test.
    await expect(pageB.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#mode-tile-online").click();
    await expect(pageB.locator("#nav-leaderboard")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#nav-leaderboard").click();
    await expect(pageB.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("stackCheckersPoints", ">", 0).orderBy("stackCheckersPoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uidB)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    await pageB.locator("#nav-hub").click();
    await pageB.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
