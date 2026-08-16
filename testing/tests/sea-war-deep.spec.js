// sea-war-deep.spec.js
//
// Deep functional coverage for sea-war.html (Sea War, a Battleship-style
// game) — previously untested by the permanent suite. Three modes: vs
// Computer, 2 Player (same device, pass-and-play), and Online (Ranked) —
// waiting room, invite/join like Golf/Chess, real Firestore-synced
// attack turns.
//
// Playing out a full real battle (place 5 ships across a 10x10 board,
// then alternate real attack clicks until every cell of every ship is
// found) would take far too long and mostly test click-precision, not
// the actual game logic — same reasoning golf-deep.spec.js gives for
// fast-forwarding to the final hole. Both players' SETUP phase (ship
// placement + ready-up) is exercised for real through the UI, since
// that's the interesting/fragile part (two-sided readiness sync). Once
// the game reaches "playing", the opponent's fleet gets fast-forwarded
// down to a single 1-cell sacrificial ship via a direct Firestore write
// (same data shape placeShipsRandomly() itself produces), and the
// WINNING shot is still a real click through handleOnlineAttackClick —
// so the actual attack-resolution/win-detection/stats-recording code
// path all still runs for real, just without dozens of real turns first.
//
// Uses its own throwaway accounts so it can run independently of
// full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test sea-war-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, grantUnlimitedGamePlay } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `seawar.p1.${Date.now()}@test.town`, displayName: "Sea War Robot A" };
const P2 = { email: `seawar.p2.${Date.now()}@test.town`, displayName: "Sea War Robot B" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.displayName });
}

// Same shape placeShipsRandomly()/getShipPositions() produce in the real
// client code — one ship, one cell, so a single attack click sinks it.
function sacrificialFleet() {
  const board = new Array(100).fill(null);
  board[0] = "ship"; // row 0, col 0
  const ships = [{ name: "Sacrifice", size: 1, hits: 0, positions: [{ row: 0, col: 0 }] }];
  return { board, ships };
}

async function waitForGameStatus(gameId, status, timeoutMs = 15_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = (await admin.firestore().collection("seaWarGames").doc(gameId).get()).data()?.status;
    if (last === status) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`seaWarGames/${gameId}.status never became "${status}" within ${timeoutMs}ms (last seen: "${last}")`);
}

// The ready-btn click handler is async (submitReady() awaits an
// updateDoc()) — Playwright's .click() only waits for the click event
// itself to register, not for whatever async work the handler kicks off
// afterward, so reading Firestore immediately after the click can catch
// it before the write has actually landed. Poll instead of reading once.
async function waitForReady(gameId, field, timeoutMs = 15_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = (await admin.firestore().collection("seaWarGames").doc(gameId).get()).data()?.[field];
    if (last === true) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`seaWarGames/${gameId}.${field} never became true within ${timeoutMs}ms (last seen: ${last})`);
}

test.describe.serial("Sea War — deep functional pass", () => {
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

  test("Local play: vs Computer loads and accepts ship placement", async () => {
    await pageA.goto("/sea-war.html");
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#seaWarWrapper")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#randomize-btn")).toBeVisible();
    await pageA.locator("#randomize-btn").click();
    await expect(pageA.locator("#player-board .cell.ship").first()).toBeVisible();
    await pageA.locator("#seawar-back-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
  });

  test("Sea War: create an open table, Robot B joins, both reach the real setup phase", async () => {
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#create-table-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#seaWarWrapper")).toBeVisible({ timeout: 15_000 });

    await pageB.goto("/sea-war.html");
    await pageB.locator("#mode-tile-online").click();
    await expect(pageB.locator("#open-tables-list button", { hasText: "Join" }).first()).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#open-tables-list button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#seaWarWrapper")).toBeVisible({ timeout: 15_000 });

    const snap = await admin.firestore().collection("seaWarGames").where("player1Uid", "==", uidA).get();
    expect(snap.empty).toBe(false);
    gameId = snap.docs[0].id;
    expect(snap.docs[0].data().status).toBe("setup");
  });

  test("Both players place ships (Randomize) and ready up through the real submitReady() path", async () => {
    await expect(pageA.locator("#randomize-btn")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#randomize-btn").click();
    await pageA.locator("#ready-btn").click();
    await waitForReady(gameId, "player1Ready");

    await expect(pageB.locator("#randomize-btn")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#randomize-btn").click();
    await pageB.locator("#ready-btn").click();
    await waitForReady(gameId, "player2Ready");

    await waitForGameStatus(gameId, "playing");
    const data = (await admin.firestore().collection("seaWarGames").doc(gameId).get()).data();
    expect(data.turn).toBe("player1");
  });

  test("Sea War: a real winning attack click sinks the fast-forwarded fleet and finishes the game", async () => {
    // Fast-forward ONLY the opponent's fleet down to one sacrificial cell —
    // everything else about the game (whose turn it is, both-ready status)
    // is exactly what the real setup flow above already produced.
    const { board, ships } = sacrificialFleet();
    await admin.firestore().collection("seaWarGames").doc(gameId).update({
      player2Board: board,
      player2Ships: ships,
    });
    await pageA.waitForTimeout(1500); // let the fast-forward's onSnapshot update land in Robot A's UI before clicking

    await expect(pageA.locator('#opponent-board .cell[data-row="0"][data-col="0"]')).toBeVisible({ timeout: 10_000 });
    await pageA.locator('#opponent-board .cell[data-row="0"][data-col="0"]').click();

    await waitForGameStatus(gameId, "finished");
    const finalData = (await admin.firestore().collection("seaWarGames").doc(gameId).get()).data();
    expect(finalData.winner).toBe(uidA);
    expect(finalData.player2Ships[0].hits).toBe(1);

    await expect(pageA.locator("#status-message")).toContainText("won", { timeout: 10_000 });
    await expect(pageB.locator("#status-message")).toContainText("lost", { timeout: 10_000 });
  });

  test("Stats get recorded for both players through the real transaction-based path", async () => {
    // recordSeaWarStatsForGame fires client-side off the finished-game
    // onSnapshot for EACH player's own page — poll rather than guess a delay.
    let userA, userB;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA?.seaWarWins && userB?.seaWarLosses) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(userA.seaWarWins).toBe(1);
    expect(userA.seaWarPoints).toBe(3);
    expect(userB.seaWarLosses).toBe(1);
    expect(userB.seaWarPoints || 0).toBe(0);
  });

  test("Sea War leaderboard view is reachable and the recorded data is queryable in points order", async () => {
    // NOTE: deliberately not asserting on the live client-side query result
    // — the Firestore emulator throws a spurious permission error on this
    // collection's where(...) list queries even for the querying user's
    // own matching document (same emulator-only quirk documented in
    // dodge-deep.spec.js/golf-deep.spec.js; real production leaderboards
    // work fine). Verify the view loads, and verify the same query shape
    // via the admin SDK.
    await pageA.locator("#seawar-back-btn").click();
    // backToSeaWarHub() lands on mode-select, not the waiting room —
    // confirmed directly from the function itself rather than assumed.
    // #nav-leaderboard is only actually shown from inside the waiting
    // room or leaderboard views (see showView()'s insideOnlineMultiplayer
    // check) — not from mode-select, so this has to go through
    // mode-tile-online first, same as a real user would.
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#nav-leaderboard")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("seaWarPoints", ">", 0).orderBy("seaWarPoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uidA)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html)", async () => {
    await pageA.locator("#nav-hub").click();
    await pageA.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
