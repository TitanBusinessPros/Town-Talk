// blackjack-deep.spec.js
//
// Permanent deep functional coverage for blackjack.html — added 2026-08-02.
// Blackjack is turn-based (a Firestore transaction resolves each hit/stand,
// nothing runs between actions), so this fast-forwards via a direct
// admin-SDK write to reach game-end, same technique as war-deep/
// hearts-deep.spec.js — no continuous-loop race conditions like Air Hockey.
//
// Uses its own throwaway accounts (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test blackjack-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const stamp = Date.now();
const P1 = { email: `bj.p1.${stamp}@test.town`, password: "TestPass123!" };
const P2 = { email: `bj.p2.${stamp}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

async function waitForCondition(fn, timeoutMs = 15_000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForCondition timed out");
}

async function findGameIdForCreator(creatorUid) {
  const snap = await admin.firestore().collection("blackjackGames").where("player1Uid", "==", creatorUid).get();
  return snap.docs[0]?.id;
}

test.describe.serial("Blackjack — deep functional pass", () => {
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
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, agreedToTerms: true, profile: { name: "BJ Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, agreedToTerms: true, profile: { name: "BJ Robot B" } }, { merge: true });
  });

  test("Local play: vs Dealer deals 2 cards to the player automatically", async () => {
    await pageA.goto("/blackjack.html");
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#view-local-game")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#local-player-cards .bj-card")).toHaveCount(2, { timeout: 10_000 });
    await pageA.locator("#local-back-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
  });

  test("Blackjack: create an open table, Robot B joins, both seated", async () => {
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 10_000 });

    gameId = await waitForCondition(() => findGameIdForCreator(uidA));
    expect(gameId).toBeTruthy();

    await pageB.goto("/blackjack.html");
    await pageB.locator("#mode-tile-online").click();
    await expect(pageB.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    const data = (await admin.firestore().collection("blackjackGames").doc(gameId).get()).data();
    expect(data.players.length).toBe(2);
  });

  test("Blackjack: host deals, both players get 2 cards each", async () => {
    await pageA.locator("#online-start-btn").click();
    const data = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("blackjackGames").doc(gameId).get()).data();
      return d.status === "playing" ? d : null;
    });
    expect(data.hands[uidA].length).toBe(2);
    expect(data.hands[uidB].length).toBe(2);
    expect(data.dealerHand.length).toBe(2);
  });

  test("A real Hit click resolves through the actual transaction", async () => {
    const before = (await admin.firestore().collection("blackjackGames").doc(gameId).get()).data();
    const firstToActPage = before.currentPlayerUid === uidA ? pageA : pageB;
    await expect(firstToActPage.locator("#online-hit-btn")).toBeVisible({ timeout: 10_000 });
    await firstToActPage.locator("#online-hit-btn").click();
    const after = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("blackjackGames").doc(gameId).get()).data();
      return d.hands[before.currentPlayerUid].length === 3 ? d : null;
    });
    expect(after.hands[before.currentPlayerUid].length).toBe(3);
  });

  test("Fast-forward to a settled hand and confirm both clients + stats", async () => {
    // Real gameplay reaches settlement through more hits/stands from
    // whoever's turn it still is — jump straight to a finished, settled
    // result and let the real client-side stats-recording code (driven by
    // the live onSnapshot) do the actual work, same technique the other
    // *-deep.spec.js files use.
    await admin.firestore().collection("blackjackGames").doc(gameId).update({
      status: "finished",
      results: { [uidA]: "win", [uidB]: "lose" },
      dealerHand: [{ value: "10", suit: "Spades" }, { value: "8", suit: "Spades" }],
      playerStatus: { [uidA]: "stood", [uidB]: "bust" },
      message: "Dealer: 18. 1 win, 1 lose, 0 push.",
    });

    await expect(pageA.locator("#online-bj-message")).toContainText("Dealer", { timeout: 10_000 });
    await expect(pageA.locator("#online-players-area")).toContainText("won", { timeout: 10_000 });
    await expect(pageB.locator("#online-players-area")).toContainText("lost", { timeout: 10_000 });

    let userA, userB;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA.blackjackWins && userB.blackjackLosses) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(userA.blackjackWins).toBe(1);
    expect(userA.blackjackPoints).toBe(3);
    expect(userB.blackjackLosses).toBe(1);
    expect(userB.blackjackPoints || 0).toBe(0);
  });

  test("Blackjack leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    await pageA.goto("/blackjack.html");
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("blackjackPoints", ">", 0).orderBy("blackjackPoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uidA)).toBe(true);
  });

  test("Blackjack: resign only forfeits your own hand — the table keeps going for the other player", async ({ browser }) => {
    const contextC = await browser.newContext();
    const contextD = await browser.newContext();
    const pageC = await contextC.newPage();
    const pageD = await contextD.newPage();
    const R1 = { email: `bj.r1.${stamp}@test.town`, password: "TestPass123!" };
    const R2 = { email: `bj.r2.${stamp}@test.town`, password: "TestPass123!" };
    await signUp(pageC, R1);
    await signUp(pageD, R2);
    const uidC = await verifyEmailByAddress(R1.email);
    const uidD = await verifyEmailByAddress(R2.email);
    await admin.firestore().collection("users").doc(uidC).set({ approved: true, agreedToTerms: true, profile: { name: "BJ Robot C" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidD).set({ approved: true, agreedToTerms: true, profile: { name: "BJ Robot D" } }, { merge: true });

    await pageC.goto("/blackjack.html");
    await pageC.locator("#mode-tile-online").click();
    await expect(pageC.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageC.locator("#create-table-btn").click();
    const gameId2 = await waitForCondition(() => findGameIdForCreator(uidC));

    await pageD.goto("/blackjack.html");
    await pageD.locator("#mode-tile-online").click();
    await expect(pageD.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageD.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
    await expect(pageD.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    await pageC.locator("#online-start-btn").click();
    const dealt = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("blackjackGames").doc(gameId2).get()).data();
      return d.status === "playing" ? d : null;
    });

    const resignerPage = dealt.currentPlayerUid === uidC ? pageC : pageD;
    const resignerUid = dealt.currentPlayerUid;
    const otherUid = resignerUid === uidC ? uidD : uidC;
    const otherPage = resignerUid === uidC ? pageD : pageC;

    await expect(resignerPage.locator("#online-resign-btn")).toBeVisible({ timeout: 10_000 });
    resignerPage.once("dialog", (d) => d.accept());
    await resignerPage.locator("#online-resign-btn").click();

    const afterResign = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("blackjackGames").doc(gameId2).get()).data();
      return d.playerStatus[resignerUid] === "resigned" ? d : null;
    });
    // The table itself keeps going — either it's now the other player's
    // turn (still 'playing'), or if they'd already finished their own turn
    // it may have settled immediately. Either way the resigner is marked
    // resigned, never the whole game forced to 'finished' with no winner
    // the way Hearts must.
    expect(afterResign.playerStatus[resignerUid]).toBe("resigned");

    if (afterResign.status === "playing") {
      expect(afterResign.currentPlayerUid).toBe(otherUid);
      await expect(otherPage.locator("#online-stand-btn")).toBeVisible({ timeout: 10_000 });
      await otherPage.locator("#online-stand-btn").click();
      const settled = await waitForCondition(async () => {
        const d = (await admin.firestore().collection("blackjackGames").doc(gameId2).get()).data();
        return d.status === "finished" ? d : null;
      });
      expect(settled.results[resignerUid]).toBe("lose");
    } else {
      expect(afterResign.results[resignerUid]).toBe("lose");
    }

    await contextC.close();
    await contextD.close();
  });
});
