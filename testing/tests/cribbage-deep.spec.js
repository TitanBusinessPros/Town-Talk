// cribbage-deep.spec.js
//
// Deep functional coverage for m3game.html (Cribbage) — previously
// untested by the permanent suite. Added 2026-07-31 alongside
// match3-deep/follow-deep/desert-deep to close the gap: the permanent
// suite only covered chess/checkers/WynneWars/Golf/Frisbee Golf, leaving
// the four newer "solo run + leaderboard" games with no coverage of
// their own — Cribbage is the one exception among those four that's
// actually a real two-player online game (with a Firestore-synced hidden-
// hand engine), so it gets the invite/join/stats/leaderboard treatment
// like golf-deep/fg-deep, rather than the solo-run treatment.
//
// Playing an entire real hand through the UI (deal → discard → cut →
// count-play → show) would require reimplementing cribbage scoring logic
// in the test itself just to pick legal cards — instead this fast-forwards
// the shared game doc directly to a near-finished score and lets the
// real client-side win-detection/stats-recording code
// (applyWinCheck/maybeRecordCribbageStats, driven by the live onSnapshot
// listener) do the actual work, the same technique golf-deep.spec.js uses
// to jump to the final hole without playing all 24 holes for real.
//
// Uses its own throwaway accounts (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test cribbage-deep.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

const P1 = { email: `crib.p1.${Date.now()}@test.town`, password: "TestPass123!" };
const P2 = { email: `crib.p2.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await signUpWithGoogle(page, { email: robot.email, displayName: robot.name });
}

test.describe.serial("Cribbage — deep functional pass", () => {
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
    await admin.firestore().collection("users").doc(uidA).set({ approved: true, profile: { name: "Cribbage Robot A" } }, { merge: true });
    await admin.firestore().collection("users").doc(uidB).set({ approved: true, profile: { name: "Cribbage Robot B" } }, { merge: true });
  });

  test("Local play: vs AI mode deals a real 6-card hand", async () => {
    await pageA.goto("/m3game.html");
    await pageA.locator("#game-tile-cribbage").click();
    await expect(pageA.locator("#welcomeModal")).toHaveClass(/show/);
    await pageA.locator("#welcomeModal button", { hasText: "vs AI" }).click();
    await expect(pageA.locator("#aiDifficultySelect")).toBeVisible();
    await pageA.locator("#aiDifficultySelect button", { hasText: "Average" }).click();
    await expect(pageA.locator("#welcomeModal")).not.toHaveClass(/show/);
    await expect(pageA.locator("#pHand .card")).toHaveCount(6);
    await pageA.locator("#backToHubBtn").click();
  });

  test("Local play: 2 Player (same device) mode deals real hands to both players", async () => {
    await pageA.locator("#game-tile-cribbage").click();
    await pageA.locator("#welcomeModal button", { hasText: "2 Players" }).click();
    await expect(pageA.locator("#welcomeModal")).not.toHaveClass(/show/);
    await expect(pageA.locator("#pHand .card")).toHaveCount(6);
    await pageA.locator("#backToHubBtn").click();
  });

  test("Cribbage: create an open table, Robot B joins, both see the game", async () => {
    await pageA.locator("#game-tile-cribbage").click();
    await pageA.locator("#welcomeModal button", { hasText: "Play Online" }).click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#create-table-btn").click();
    await expect(pageA.locator("#cribbageGameWrapper")).toBeVisible({ timeout: 15_000 });

    await pageB.goto("/m3game.html");
    await pageB.locator("#game-tile-cribbage").click();
    await pageB.locator("#welcomeModal button", { hasText: "Play Online" }).click();
    await expect(pageB.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageB.locator("#open-tables-list button", { hasText: "Join" }).first().click();
    await expect(pageB.locator("#cribbageGameWrapper")).toBeVisible({ timeout: 15_000 });

    // cribbageGameWrapper becoming visible confirms the CLIENT's own
    // batch.commit() resolved, but a separate admin-SDK connection reading
    // immediately afterward can still race slightly behind it — poll
    // instead of a single-shot read.
    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const snap = await admin.firestore().collection("cribbageGames").where("player1Uid", "==", uidA).get();
      if (!snap.empty) {
        data = snap.docs[0].data();
        gameId = snap.docs[0].id;
        if (data.status === "active") break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.status).toBe("active");
    expect(data.player2Uid).toBe(uidB);
  });

  test("Fast-forward to Robot A winning at 121 and confirm stats + winner text", async () => {
    // Real gameplay reaches 121 through many hands of deal/discard/cut/
    // play/show — jump straight to the win condition and let the real
    // client-side win-check + stats-recording code (driven by the live
    // onSnapshot on cribbageGames/{id}) do the actual work.
    await admin.firestore().collection("cribbageGames").doc(gameId).update({
      player1Score: 121,
      status: "finished",
      phase: "finished",
      winner: uidA,
    });

    await expect(pageA.locator("#online-match-info")).toContainText("You won", { timeout: 10_000 });
    await expect(pageB.locator("#online-match-info")).toContainText("You lost", { timeout: 10_000 });

    let userA, userB;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      userA = (await admin.firestore().collection("users").doc(uidA).get()).data();
      userB = (await admin.firestore().collection("users").doc(uidB).get()).data();
      if (userA.cribbageWins && userB.cribbageLosses) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(userA.cribbageWins).toBe(1);
    expect(userA.cribbagePoints).toBe(3);
    expect(userB.cribbageLosses).toBe(1);
    expect(userB.cribbagePoints || 0).toBe(0);
  });

  test("Cribbage leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
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
    await pageA.goto("/m3game.html");
    await pageA.locator("#game-tile-cribbage").click();
    await pageA.locator("#welcomeModal button", { hasText: "Play Online" }).click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });
    await pageA.locator("#nav-leaderboard").click();
    await expect(pageA.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users").where("cribbagePoints", ">", 0).orderBy("cribbagePoints", "desc").limit(10).get();
    expect(snap.docs.some((d) => d.id === uidA)).toBe(true);
  });

  test("Cribbage: direct invite cooldown blocks a second invite, then the original is declined", async () => {
    const pairId = [uidA, uidB].sort().join("_");
    const { FieldValue } = require("firebase-admin/firestore");
    await admin.firestore().collection("friendRequests").doc(pairId).set({
      participants: [uidA, uidB].sort(),
      participantNames: { [uidA]: "Cribbage Robot A", [uidB]: "Cribbage Robot B" },
      requestedBy: uidA,
      status: "accepted",
      requestedAt: FieldValue.serverTimestamp(),
      respondedAt: FieldValue.serverTimestamp(),
    });

    await pageA.locator("#nav-hub").click().catch(() => {});
    // nav-hub navigates away to chess.html by design for this game — go
    // back to the waiting room directly instead.
    await pageA.goto("/m3game.html");
    await pageA.locator("#game-tile-cribbage").click();
    await pageA.locator("#welcomeModal button", { hasText: "Play Online" }).click();
    await expect(pageA.locator("#view-waiting")).toBeVisible({ timeout: 10_000 });

    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await pageA.waitForTimeout(1000);

    // Second attempt right away should be blocked by the 1-hour cooldown.
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator("#waiting-message")).toContainText("again in about", { timeout: 10_000 });

    // Robot B declines the still-pending original invite.
    await pageB.goto("/m3game.html");
    await pageB.locator("#game-tile-cribbage").click();
    await pageB.locator("#welcomeModal button", { hasText: "Play Online" }).click();
    await pageB.locator("#my-invites-list").waitFor();
    await pageB.locator('button:has-text("Decline")').first().click();
    await expect(pageB.locator("#my-invites-empty")).toBeVisible({ timeout: 10_000 });
  });
});
