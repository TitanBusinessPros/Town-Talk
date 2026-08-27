// war-deep.spec.js
//
// Permanent deep functional coverage for war.html — added 2026-08-02, the
// day after the game shipped. War is turn-based (nothing runs between
// player actions, unlike Air Hockey's continuous physics loop), so this
// follows the same "fast-forward via a direct admin-SDK write, let the
// real client-side finish/stats code do the actual work" technique
// cribbage-deep.spec.js and golf-deep.spec.js use — no risk of racing a
// live simulation the way airhockey-deep.spec.js had to work around.
//
// Uses its own throwaway accounts (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test war-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const stamp = Date.now();
const P1 = { email: `war.p1.${stamp}@test.town`, password: "TestPass123!" };
const P2 = { email: `war.p2.${stamp}@test.town`, password: "TestPass123!" };

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
  const snap = await admin.firestore().collection("warGames").where("player1Uid", "==", creatorUid).get();
  return snap.docs[0]?.id;
}

test.describe.serial("War — deep functional pass", () => {
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
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, agreedToTerms: true, profile: { name: "War Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, agreedToTerms: true, profile: { name: "War Robot B" } }, { merge: true });
  });

  test("Local play: vs Computer deals 26 cards to each of 2 players", async () => {
    await pageA.goto("/war.html");
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#view-local-game")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#local-start-btn").click();
    await expect(pageA.locator(".war-cards-left").first()).toContainText("Cards: 26", { timeout: 10_000 });
    await expect(pageA.locator(".war-cards-left").last()).toContainText("Cards: 26");
    await pageA.locator("#local-back-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
  });

  test("War: create an open table, Robot B joins, both see the battlefield", async () => {
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 10_000 });

    gameId = await waitForCondition(() => findGameIdForCreator(uidA));
    expect(gameId).toBeTruthy();

    await pageB.goto("/war.html");
    await pageB.locator("#mode-tile-online").click();
    await expect(pageB.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    const data = (await admin.firestore().collection("warGames").doc(gameId).get()).data();
    expect(data.participants).toContain(uidB);
    expect(data.players.length).toBe(2);
  });

  test("War: start the battle, deal 26 cards each", async () => {
    await pageA.locator("#online-start-btn").click();
    await waitForCondition(async () => {
      const d = (await admin.firestore().collection("warGames").doc(gameId).get()).data();
      return d.status === "active" ? d : null;
    });
    const dealt = (await admin.firestore().collection("warGames").doc(gameId).get()).data();
    expect(dealt.hands[uidA].length).toBe(26);
    expect(dealt.hands[uidB].length).toBe(26);
    await expect(pageA.locator("#online-war-battle-btn")).toBeVisible({ timeout: 10_000 });
  });

  test("A real Battle click resolves a round through the actual transaction", async () => {
    const before = (await admin.firestore().collection("warGames").doc(gameId).get()).data();
    await pageA.locator("#online-war-battle-btn").click();
    await waitForCondition(async () => {
      const d = (await admin.firestore().collection("warGames").doc(gameId).get()).data();
      return d.hands[uidA].length !== before.hands[uidA].length || d.hands[uidB].length !== before.hands[uidB].length ? d : null;
    });
    const after = (await admin.firestore().collection("warGames").doc(gameId).get()).data();
    // A single round (no war chain) moves exactly 2 cards from the loser's
    // hand to the winner's — total card count across both hands is always
    // conserved regardless of who won.
    expect(after.hands[uidA].length + after.hands[uidB].length).toBe(52);
  });

  test("Fast-forward to Robot A winning and confirm stats + winner text", async () => {
    // Real gameplay reaches a winner through many more Battle clicks —
    // jump straight to the win condition (Robot B out of cards) and let the
    // real client-side stats-recording code (driven by the live onSnapshot
    // on warGames/{id}) do the actual work, same technique cribbage-deep
    // and blackjack-deep use.
    await admin.firestore().collection("warGames").doc(gameId).update({
      hands: { [uidA]: Array(52).fill({ rank: "2", suit: "♣" }), [uidB]: [] },
      status: "finished",
      winner: uidA,
      message: "",
    });

    await expect(pageA.locator("#online-war-gameover")).toContainText("win", { ignoreCase: true, timeout: 10_000 });
    await expect(pageB.locator("#online-war-gameover")).toBeVisible({ timeout: 10_000 });

    let userA, userB;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA.warWins && userB.warLosses) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(userA.warWins).toBe(1);
    expect(userA.warPoints).toBe(3);
    expect(userB.warLosses).toBe(1);
    expect(userB.warPoints || 0).toBe(0);
  });

  test("War leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    await pageA.locator("#leave-table-btn").click().catch(() => {});
    await pageA.goto("/war.html");
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("warPoints", ">", 0).orderBy("warPoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uidA)).toBe(true);
  });

  test("War: Robot A invites Robot B directly, triggering onWarInvite", async () => {
    // Runs down here, not right after signup: findGameIdForCreator(uidA)
    // (used by the "create an open table" test above) does an unordered
    // `.where("player1Uid","==",uidA).get()` and takes docs[0] — a direct
    // invite (a warGames doc with inviteTo set, created below) is a SEPARATE
    // warGames doc with the same player1Uid, and doesn't show up in the
    // open-tables list (inviteTo != null is filtered out there), but it's
    // still a real match for that query. Creating it before that test ran
    // made docs[0] ambiguous and that test picked up the wrong doc. Every
    // test above this point that still needs a single unambiguous gameId
    // has already run, so this is now safe.
    //
    // onWarInvite (index.js) only fires on a DIRECT invite (a warGames doc
    // with inviteTo set), and the UI only offers that against an accepted
    // friend -- seed the friendRequests doc straight via the admin SDK
    // rather than driving the whole friend-request UI, matching this
    // file's own "fast-forward via a direct admin-SDK write" approach.
    await admin.firestore().collection("friendRequests").add({
      participants: [uidA, uidB],
      participantNames: { [uidA]: "War Robot A", [uidB]: "War Robot B" },
      status: "accepted",
      respondedAt: admin.firestore.Timestamp.now(),
    });

    await pageA.goto("/war.html");
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite to War" }).first().click();

    // Proof the Cloud Function actually ran: onWarInvite posts a Messages
    // thread entry (postGameInviteMessage), same assertion pattern
    // full-platform.spec.js uses for Chess/Checkers/WynneWars/Golf/Frisbee
    // Golf invites.
    await pageB.goto("/index.html");
    await pageB.locator("#nav-messages").click();
    await pageB.locator(".conversation-item", { hasText: "War Robot A" }).click();
    await expect(pageB.locator("#thread-messages")).toContainText("invited you to play War", { timeout: 15_000 });
  });

  test("War: resign ends a 2-player game with the other player credited the win", async ({ browser }) => {
    const contextC = await browser.newContext();
    const contextD = await browser.newContext();
    const pageC = await contextC.newPage();
    const pageD = await contextD.newPage();
    const R1 = { email: `war.r1.${stamp}@test.town`, password: "TestPass123!" };
    const R2 = { email: `war.r2.${stamp}@test.town`, password: "TestPass123!" };
    await signUp(pageC, R1);
    await signUp(pageD, R2);
    const uidC = await verifyEmailByAddress(R1.email);
    const uidD = await verifyEmailByAddress(R2.email);
    await admin.firestore().collection("users").doc(uidC).set({ approved: true, agreedToTerms: true, profile: { name: "War Robot C" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidD).set({ approved: true, agreedToTerms: true, profile: { name: "War Robot D" } }, { merge: true });

    await pageC.goto("/war.html");
    await pageC.locator("#mode-tile-online").click();
    await expect(pageC.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageC.locator("#create-table-btn").click();
    const gameId2 = await waitForCondition(() => findGameIdForCreator(uidC));

    await pageD.goto("/war.html");
    await pageD.locator("#mode-tile-online").click();
    await expect(pageD.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageD.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
    await expect(pageD.locator("#view-game")).toBeVisible({ timeout: 15_000 });

    await pageC.locator("#online-start-btn").click();
    await waitForCondition(async () => {
      const d = (await admin.firestore().collection("warGames").doc(gameId2).get()).data();
      return d.status === "active" ? d : null;
    });

    await expect(pageD.locator("#online-resign-btn")).toBeVisible({ timeout: 10_000 });
    pageD.once("dialog", (d) => d.accept());
    await pageD.locator("#online-resign-btn").click();

    const resigned = await waitForCondition(async () => {
      const d = (await admin.firestore().collection("warGames").doc(gameId2).get()).data();
      return d.status === "finished" ? d : null;
    });
    expect(resigned.winner).toBe(uidC);

    await contextC.close();
    await contextD.close();
  });
});
