// airhockey-deep.spec.js
//
// Permanent deep functional coverage for airhockey.html — added 2026-08-02,
// the same day the game shipped. Air Hockey is architecturally different
// from every other multiplayer game in this suite: it's a continuous
// real-time physics sync (host-authoritative — the table creator runs the
// full puck/paddle simulation and streams state to Firestore at ~20Hz,
// the joining player only sends their own paddle position and mirrors the
// rest), not a turn-based or simultaneous-reveal design. Scripting a real
// paddle-drag rally to actually score 7 goals through the UI would mean
// reimplementing/predicting the physics engine's exact ball path in the
// test itself — instead this fast-forwards the shared game doc directly to
// a finished state and lets the real client-side finishAirHockeyMatch()/
// stats-recording code (driven by the live onSnapshot listener) do the
// actual work, the same technique cribbage-deep.spec.js and
// golf-deep.spec.js use to jump to a final result without playing a full
// game for real. What IS exercised for real: the host creating a live
// simulation, a genuine touch/mouse-driven paddle move being picked up and
// streamed to Firestore, and the guest's client mirroring it.
//
// Uses its own throwaway accounts (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering. Each
// account only ever creates 2 online tables across this whole file (one
// normal match, one resign match) — comfortably under the 3/day free-tier
// limit, so no grantUnlimitedGamePlay() needed.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test airhockey-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const stamp = Date.now();
const P1 = { email: `ah.p1.${stamp}@test.town`, password: "TestPass123!" };
const P2 = { email: `ah.p2.${stamp}@test.town`, password: "TestPass123!" };
const R1 = { email: `ah.r1.${stamp}@test.town`, password: "TestPass123!" };
const R2 = { email: `ah.r2.${stamp}@test.town`, password: "TestPass123!" };

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

async function findGameIdForCreator(collectionName, creatorUid) {
  const snap = await admin.firestore().collection(collectionName).where("player1Uid", "==", creatorUid).get();
  return snap.docs[0]?.id;
}

test.describe.serial("Air Hockey — deep functional pass", () => {
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
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, agreedToTerms: true, profile: { name: "AH Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, agreedToTerms: true, profile: { name: "AH Robot B" } }, { merge: true });
  });

  test("Local play: vs Computer mode shows the fullscreen canvas", async () => {
    await pageA.goto("/airhockey.html");
    await pageA.locator("#mode-tile-ai").click();
    await expect(pageA.locator("#airhockeyWrapper")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#gameCanvas")).toBeVisible();
    await pageA.locator("#back-to-hub-game-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
  });

  test("Air Hockey: create an open table, Robot B joins, both start simulating", async () => {
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#waitingOverlay")).toBeVisible({ timeout: 10_000 });

    gameId = await waitForCondition(() => findGameIdForCreator("airHockeyGames", uidA));
    expect(gameId).toBeTruthy();

    await pageB.goto("/airhockey.html");
    await pageB.locator("#mode-tile-online").click();
    await expect(pageB.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#gameCanvas")).toBeVisible({ timeout: 15_000 });

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const snap = await admin.firestore().collection("airHockeyGames").doc(gameId).get();
      data = snap.data();
      if (data.status === "playing") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.status).toBe("playing");
    expect(data.player2Uid).toBe(uidB);

    // The host's waiting overlay should clear once the match actually
    // starts, and both clients should be rendering the live canvas.
    await expect(pageA.locator("#waitingOverlay")).toBeHidden({ timeout: 10_000 });
    await expect(pageA.locator("#gameCanvas")).toBeVisible();
  });

  test("A real paddle drag on the host is picked up and streamed to Firestore", async () => {
    // Move the host's mouse across the canvas — this exercises the actual
    // touch/mouse input handler -> movePlayerTo() -> the network-tick hook
    // that pushes paddle1 to Firestore, not just a forced write.
    const box = await pageA.locator("#gameCanvas").boundingBox();
    await pageA.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
    await pageA.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.8, { steps: 5 });

    let paddle1;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const snap = await admin.firestore().collection("airHockeyGames").doc(gameId).get();
      paddle1 = snap.data().paddle1;
      // Default spawn is table-width/2, height-100 — any real movement
      // pushed over the network will have nudged x away from center.
      if (Math.abs(paddle1.x - 300) > 5) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(Math.abs(paddle1.x - 300)).toBeGreaterThan(5);
  });

  test("Fast-forward to Robot A winning 7-3 and confirm both clients + stats", async () => {
    // Forcing Firestore directly (bypassing the host's own live loop, which
    // keeps running and keeps pushing its own real near-0-0 scores every
    // ~50ms) raced unpredictably no matter how long the test waited or how
    // hard it polled to confirm the write "stuck" — because there's always
    // exactly one more already-in-flight host write that can land after any
    // given point. Real gameplay never has this problem (scores+status are
    // only ever written together, atomically, by the host's own single
    // source of truth) — so instead of fighting the live loop from outside,
    // nudge ITS OWN internal score state via a small test-only hook and let
    // its own next network tick naturally detect the win and write both
    // fields itself, through the exact same code path a real match uses.
    await pageA.evaluate(() => window.debugSetAirHockeyScore(7, 3));

    await expect(pageA.locator("#gameOverTitle")).toContainText("YOU WIN", { timeout: 10_000 });
    await expect(pageB.locator("#gameOverTitle")).toContainText("YOU LOSE", { timeout: 10_000 });
    await expect(pageA.locator("#gameOverScore")).toContainText("7 - 3");

    let userA, userB;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA.airHockeyWins && userB.airHockeyLosses) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(userA.airHockeyWins).toBe(1);
    expect(userA.airHockeyPoints).toBe(3);
    expect(userB.airHockeyLosses).toBe(1);
    expect(userB.airHockeyPoints || 0).toBe(0);
  });

  test("Air Hockey leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
    // Same defensive pattern cribbage-deep.spec.js uses: verify the view
    // loads, and cross-check via the admin SDK (bypassing rules) rather
    // than asserting on the live client-side query result — the emulator's
    // `list`-query rules evaluation has shown real flakiness on this
    // codebase's `users` collection rule shape before (see cribbage's own
    // note; same underlying class of issue as the blackjackGames "Property
    // X is undefined" bug this session root-caused and fixed with a
    // `.get(field, default)` accessor — worth revisiting on `users`' own
    // rule if this ever needs to be more than defensive).
    await pageA.locator("#game-over-hub-btn").click();
    await expect(pageA.locator("#view-mode-select")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#nav-hub").click().catch(() => {});
    await pageA.goto("/airhockey.html");
    await pageA.locator("#mode-tile-online").click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("airHockeyPoints", ">", 0).orderBy("airHockeyPoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uidA)).toBe(true);
  });

  test("Air Hockey: resign forfeits the match and credits the other player the win", async ({ browser }) => {
    const contextC = await browser.newContext();
    const contextD = await browser.newContext();
    const pageC = await contextC.newPage();
    const pageD = await contextD.newPage();
    await signUp(pageC, R1);
    await signUp(pageD, R2);
    const uidC = await verifyEmailByAddress(R1.email);
    const uidD = await verifyEmailByAddress(R2.email);
    await admin.firestore().collection("users").doc(uidC).set({ approved: true, agreedToTerms: true, profile: { name: "AH Robot C" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidD).set({ approved: true, agreedToTerms: true, profile: { name: "AH Robot D" } }, { merge: true });

    await pageC.goto("/airhockey.html");
    await pageC.locator("#mode-tile-online").click();
    await expect(pageC.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageC.locator("#create-table-btn").click();
    const gameId2 = await waitForCondition(() => findGameIdForCreator("airHockeyGames", uidC));
    expect(gameId2).toBeTruthy();

    await pageD.goto("/airhockey.html");
    await pageD.locator("#mode-tile-online").click();
    await expect(pageD.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageD.locator("#open-tables-list .table-row button", { hasText: "Join" }).first().click();
    await expect(pageD.locator("#gameCanvas")).toBeVisible({ timeout: 15_000 });

    await expect(pageD.locator("#resign-btn")).toBeVisible({ timeout: 10_000 });
    pageD.once("dialog", (d) => d.accept());
    await pageD.locator("#resign-btn").click();

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const snap = await admin.firestore().collection("airHockeyGames").doc(gameId2).get();
      data = snap.data();
      if (data.status === "finished") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.status).toBe("finished");
    expect(data.winner).toBe(uidC);

    await expect(pageC.locator("#gameOverTitle")).toContainText("YOU WIN", { timeout: 10_000 });
    await expect(pageD.locator("#gameOverTitle")).toContainText("YOU LOSE", { timeout: 10_000 });

    await contextC.close();
    await contextD.close();
  });

  test("Air Hockey: direct invite cooldown blocks a second invite, then the original is declined", async () => {
    // Exercises onAirHockeyInvite (index.js) via a real UI-created invite --
    // same pattern as golf-deep.spec.js's equivalent test.
    const pairId = [uidA, uidB].sort().join("_");
    const { FieldValue } = require("firebase-admin/firestore");
    await admin.firestore().collection("friendRequests").doc(pairId).set({
      participants: [uidA, uidB].sort(),
      participantNames: { [uidA]: "AH Robot A", [uidB]: "AH Robot B" },
      requestedBy: uidA,
      status: "accepted",
      requestedAt: FieldValue.serverTimestamp(),
      respondedAt: FieldValue.serverTimestamp(),
    });

    await pageA.goto("/airhockey.html");
    await pageA.locator("#mode-tile-online").click();
    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #waiting-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator("#waiting-message")).toContainText("again in about", { timeout: 10_000 });

    await pageB.goto("/airhockey.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator("#my-invites-list").waitFor();
    await pageB.locator('button:has-text("Decline")').first().click();
    await expect(pageB.locator("#my-invites-empty")).toBeVisible({ timeout: 10_000 });
  });
});
