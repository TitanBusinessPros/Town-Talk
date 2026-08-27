// hearts-deep.spec.js
//
// Permanent deep functional coverage for hearts.html — added 2026-08-02.
// Hearts is turn-based (a Firestore transaction resolves each card play,
// nothing runs between actions), so — like war-deep.spec.js — this can
// safely fast-forward via a direct admin-SDK write to reach game-end,
// without any of airhockey-deep.spec.js's continuous-loop race conditions.
// The one thing that's genuinely different from War/Blackjack: Hearts
// needs EXACTLY 4 real players to start (not a flexible 2-4), so both the
// main flow and the resign flow need 4 throwaway accounts each.
//
// Uses its own throwaway accounts (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test hearts-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const stamp = Date.now();

async function signUp(page, email) {
  await signUpWithGoogle(page, { email });
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
  const snap = await admin.firestore().collection("heartsGames").where("player1Uid", "==", creatorUid).get();
  return snap.docs[0]?.id;
}

async function makeFourPlayers(browser, prefix) {
  const players = [];
  for (let i = 1; i <= 4; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const email = `hearts.${prefix}${i}.${stamp}@test.town`;
    await signUp(page, email);
    const uid = await verifyEmailByAddress(email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, agreedToTerms: true, profile: { name: `Hearts ${prefix.toUpperCase()}${i}` } },
      { merge: true }
    );
    players.push({ context, page, uid, email });
  }
  return players;
}

async function joinOpenTable(page) {
  await page.goto("/hearts.html");
  await page.locator("#mode-tile-online").click();
  await expect(page.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
  await page.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
  await expect(page.locator("#view-game")).toBeVisible({ timeout: 15_000 });
}

test.describe.serial("Hearts — deep functional pass", () => {
  test.setTimeout(180_000);
  let players, gameId;

  test("Sign up four throwaway players and verify email", async ({ browser }) => {
    players = await makeFourPlayers(browser, "p");
  });

  test("Local play: vs Computer deals 13 cards and prompts a pass direction", async () => {
    const page = players[0].page;
    await page.goto("/hearts.html");
    await page.locator("#mode-tile-ai").click();
    await expect(page.locator("#view-local-game")).toBeVisible({ timeout: 10_000 });
    await page.locator("#local-start-btn").click();
    await expect(page.locator("#local-hearts-hand .hearts-card")).toHaveCount(13, { timeout: 10_000 });
    await expect(page.locator("#local-hearts-message")).toContainText("pass", { ignoreCase: true });
    await page.locator("#local-back-btn").click();
    await expect(page.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
  });

  test("Hearts: create a table, three more players join, all 4 seated", async () => {
    const [p1, p2, p3, p4] = players;
    await p1.page.locator("#mode-tile-online").click();
    await expect(p1.page.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await p1.page.locator("#create-table-btn").click();

    gameId = await waitForCondition(() => findGameIdForCreator(p1.uid));
    expect(gameId).toBeTruthy();

    await joinOpenTable(p2.page);
    await joinOpenTable(p3.page);
    await joinOpenTable(p4.page);

    const data = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId).get()).data();
      return d.players.length === 4 ? d : null;
    });
    expect(data.players.length).toBe(4);
  });

  test("Hearts: host starts the deal, all 4 get 13 cards and a passing prompt", async () => {
    await players[0].page.locator("#online-start-btn").click();
    const data = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId).get()).data();
      return d.status === "passing" ? d : null;
    });
    for (const p of players) expect(data.hands[p.uid].length).toBe(13);
    expect(data.passDirection).toBe("left");
    await expect(players[0].page.locator("#online-hearts-hand .hearts-card")).toHaveCount(13, { timeout: 10_000 });
  });

  test("All 4 players submit a real pass; the swap resolves through the actual transaction", async () => {
    for (const p of players) {
      const cards = p.page.locator("#online-hearts-hand .hearts-card");
      await cards.nth(0).click();
      await cards.nth(1).click();
      await cards.nth(2).click();
      await p.page.locator("#online-pass-btn").click();
    }
    const data = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId).get()).data();
      return d.status === "playing" ? d : null;
    });
    for (const p of players) expect(data.hands[p.uid].length).toBe(13);
    expect(data.currentPlayerUid).toBeTruthy();
    // Whoever holds the 2♣ must be able to lead it — confirm the real hand
    // that's dealt actually contains it for that player.
    const starter = data.hands[data.currentPlayerUid];
    expect(starter.some((c) => c.rank === "2" && c.suit === "♣")).toBe(true);
  });

  test("A real card play (leading the 2♣) resolves through the actual transaction", async () => {
    const data = (await admin.firestore().collection("heartsGames").doc(gameId).get()).data();
    const starterPage = players.find((p) => p.uid === data.currentPlayerUid).page;
    await starterPage.locator("#online-hearts-hand .hearts-card:not(.disabled)").first().click();
    const after = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId).get()).data();
      return d.currentTrick.length === 1 ? d : null;
    });
    expect(after.leadSuit).toBe("♣");
  });

  test("Fast-forward to Robot P4 winning the round and confirm stats", async () => {
    // Real gameplay reaches 100 points through many more tricks/rounds —
    // jump straight to game-end and let the real client-side stats-
    // recording code (driven by the live onSnapshot) do the actual work,
    // same technique war-deep/blackjack-deep use.
    const winnerUid = players[3].uid;
    const roundScores = {};
    players.forEach((p, i) => { roundScores[p.uid] = i === 3 ? 10 : 40 + i * 20; });
    await admin.firestore().collection("heartsGames").doc(gameId).update({
      status: "finished",
      winner: winnerUid,
      roundScores,
      message: `Game over! Hearts P4 wins with ${roundScores[winnerUid]} points.`,
    });

    await expect(players[3].page.locator("#online-hearts-message")).toContainText("wins", { ignoreCase: true, timeout: 10_000 });
    await expect(players[0].page.locator("#online-hearts-message")).toContainText("wins", { ignoreCase: true, timeout: 10_000 });

    let winnerData, loserData;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      winnerData = (await admin.firestore().collection("users").doc(players[3].uid).get()).data();
      loserData = (await admin.firestore().collection("users").doc(players[0].uid).get()).data();
      if (winnerData.heartsWins && loserData.heartsLosses) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(winnerData.heartsWins).toBe(1);
    expect(winnerData.heartsPoints).toBe(3);
    expect(loserData.heartsLosses).toBe(1);
    expect(loserData.heartsPoints || 0).toBe(0);
  });

  test("Hearts leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    await players[0].page.goto("/hearts.html");
    await players[0].page.locator("#mode-tile-online").click();
    await expect(players[0].page.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await players[0].page.locator("#nav-leaderboard").click();
    await expect(players[0].page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("heartsPoints", ">", 0).orderBy("heartsPoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === players[3].uid)).toBe(true);
  });

  test("Hearts: Player 1 invites Player 2 directly, triggering onHeartsInvite", async () => {
    // Runs down here, not right after signup: findGameIdForCreator(p1.uid)
    // (used by the "create a table, three more players join" test above)
    // does an unordered `.where("player1Uid","==",p1.uid).get()` and takes
    // docs[0] — a direct invite (a heartsGames doc with inviteTo set,
    // created below) is a separate heartsGames doc with the same
    // player1Uid, and doesn't show up in the open-tables list (inviteTo !=
    // null is filtered out there), but it's still a real match for that
    // query. Creating it before that test ran made docs[0] ambiguous and
    // that test picked up the wrong doc. Every test above this point that
    // still needs a single unambiguous gameId has already run, so this is
    // now safe.
    //
    // onHeartsInvite (index.js) only fires on a DIRECT invite (a
    // heartsGames doc with inviteTo set), and the UI only offers that
    // against an accepted friend -- seed the friendRequests doc straight
    // via the admin SDK rather than driving the whole friend-request UI,
    // matching this file's own "fast-forward via a direct admin-SDK write"
    // approach.
    const [p1, p2] = players;
    await admin.firestore().collection("friendRequests").add({
      participants: [p1.uid, p2.uid],
      participantNames: { [p1.uid]: "Hearts P1", [p2.uid]: "Hearts P2" },
      status: "accepted",
      respondedAt: admin.firestore.Timestamp.now(),
    });

    await p1.page.goto("/hearts.html");
    await p1.page.locator("#mode-tile-online").click();
    await expect(p1.page.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await p1.page.locator("#friends-invite-list").waitFor();
    await p1.page.locator("#friends-invite-list button", { hasText: "Invite to Hearts" }).first().click();

    // Proof the Cloud Function actually ran: onHeartsInvite posts a
    // Messages thread entry (postGameInviteMessage), same assertion
    // pattern full-platform.spec.js uses for Chess/Checkers/WynneWars/
    // Golf/Frisbee Golf invites.
    await p2.page.goto("/index.html");
    await p2.page.locator("#nav-messages").click();
    await p2.page.locator(".conversation-item", { hasText: "Hearts P1" }).click();
    await expect(p2.page.locator("#thread-messages")).toContainText("invited you to play Hearts", { timeout: 15_000 });
  });

  test("Hearts: resign ends the game for everyone with no winner credited", async ({ browser }) => {
    const r = await makeFourPlayers(browser, "r");
    const [r1, r2, r3, r4] = r;

    await r1.page.goto("/hearts.html");
    await r1.page.locator("#mode-tile-online").click();
    await expect(r1.page.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await r1.page.locator("#create-table-btn").click();
    const gameId2 = await waitForCondition(() => findGameIdForCreator(r1.uid));

    await joinOpenTable(r2.page);
    await joinOpenTable(r3.page);
    await joinOpenTable(r4.page);
    await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId2).get()).data();
      return d.players.length === 4 ? d : null;
    });

    await r1.page.locator("#online-start-btn").click();
    await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId2).get()).data();
      return d.status === "passing" ? d : null;
    });

    await expect(r1.page.locator("#online-resign-btn")).toBeVisible({ timeout: 10_000 });
    r1.page.once("dialog", (d) => d.accept());
    await r1.page.locator("#online-resign-btn").click();

    const resigned = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("heartsGames").doc(gameId2).get()).data();
      return d.status === "finished" ? d : null;
    });
    expect(resigned.winner).toBeNull();

    for (const p of r) await p.context.close();
  });
});
