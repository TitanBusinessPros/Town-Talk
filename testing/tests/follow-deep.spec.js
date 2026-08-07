// follow-deep.spec.js
//
// Deep functional coverage for follow.html — previously untested by the
// permanent suite. Added 2026-07-31 after a user bug report ("leaderboard
// stats aren't recording") turned out to be a real regression: startGame()
// was unconditionally resetting isOnlineRun to false on every Start click,
// including the very first one after choosing "Play Online" from
// mode-select — silently wiping the online flag before a round even ran,
// so submitRunResult() never fired. That's now fixed in follow.html, and
// this spec exists so it can never silently regress again.
//
// Uses its own throwaway account (not Robot A/B) so it can run
// independently of full-platform.spec.js's careful test ordering.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test follow-deep.spec.js

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, admin } = require("../emulatorAdmin");

const P1 = { email: `follow.p1.${Date.now()}@test.town`, password: "TestPass123!" };

async function signUp(page, robot) {
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("#signup-email").fill(robot.email);
  await page.locator("#signup-password").fill(robot.password);
  await page.locator("#signup-age-confirm").check();
  await page.locator("#signup-terms-confirm").check();
  await page.locator("#form-signup button[type=submit]").click();
}

// Reads a plain (non-module) top-level `let`/`const` binding out of the
// page. Classic <script> top-level `let` bindings are NOT attached to
// `window` (unlike function declarations), so `page.evaluate(() => x)`
// can't see them directly — but Playwright's page.evaluate runs in the
// page's own global scope, where a bare identifier reference DOES resolve
// to that binding. Wrapping it in eval() sidesteps esbuild/Playwright
// trying to statically analyze `x` as a closure variable that doesn't
// exist in the injected function.
function readVar(page, name) {
  return page.evaluate((n) => eval(n), name);
}

test.describe.serial("Follow Along — deep functional pass", () => {
  test.setTimeout(120_000);
  let page, context, uid;

  test("Sign up a throwaway account and verify email", async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signUp(page, P1);
    uid = await verifyEmailByAddress(P1.email);
    await admin.firestore().collection("users").doc(uid).set(
      { approved: true, profile: { name: "Follow Robot" } },
      { merge: true }
    );
  });

  test("Play for Fun: sequence advances on a correct answer, nothing submitted", async () => {
    await page.goto("/follow.html");
    await page.locator("#game-tile-follow").click();
    await page.locator("#mode-tile-offline").click();
    await expect(page.locator("#followGameWrapper")).toBeVisible();

    await page.locator("#start-btn").click();
    await page.waitForFunction(() => { try { return eval("isPlayerTurn") === true; } catch { return false; } }, { timeout: 10_000 });

    const seq = await readVar(page, "sequence");
    expect(seq.length).toBe(1);
    await page.locator(`#btn${seq[0]}`).click();
    await expect(page.locator("#message")).toContainText("Correct", { timeout: 5000 });

    // Round 2 should now be in progress — the core "sequence grows and
    // advances" mechanic the user reported as broken.
    await page.waitForFunction(() => { try { return eval("level") === 2; } catch { return false; } }, { timeout: 10_000 });
  });

  test("Play Online (Ranked): isOnlineRun survives clicking Start (regression guard)", async () => {
    await page.locator("#back-to-hub-game-btn").click();
    await expect(page.locator("#view-hub")).toBeVisible({ timeout: 10_000 });

    await page.locator("#game-tile-follow").click();
    await page.locator("#mode-tile-online").click();
    await expect(page.locator("#followGameWrapper")).toBeVisible();
    await expect(page.locator("#run-status")).toContainText("Online run");

    await page.locator("#start-btn").click();
    // THE regression: before the fix, startGame() unconditionally reset
    // isOnlineRun to false right here, before the round even ran.
    const isOnline = await readVar(page, "isOnlineRun");
    expect(isOnline).toBe(true);
  });

  test("Reaching round 1 online and then failing round 2 submits followBestRounds/TimeMs", async () => {
    // Checking level alongside isPlayerTurn matters here: handleButtonClick()
    // is a fire-and-forget async handler (the click listener doesn't await
    // it), so right after clicking round 1's button, isPlayerTurn can still
    // read as true for a brief moment before the handler catches up — a
    // bare isPlayerTurn===true wait can false-positive on round 1 still
    // being active instead of genuinely waiting for round 2.
    await page.waitForFunction(() => { try { return eval("isPlayerTurn") === true && eval("level") === 1; } catch { return false; } }, { timeout: 10_000 });
    let seq = await readVar(page, "sequence");
    for (const btn of seq) {
      await page.locator(`#btn${btn}`).click();
      await page.waitForTimeout(400);
    }

    await page.waitForFunction(() => { try { return eval("isPlayerTurn") === true && eval("level") === 2; } catch { return false; } }, { timeout: 10_000 });
    seq = await readVar(page, "sequence");
    const wrongButton = seq[0] === 1 ? 2 : 1;
    await page.locator(`#btn${wrongButton}`).click();
    await expect(page.locator("#message")).toContainText("Game Over", { timeout: 5000 });

    let data;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      data = (await admin.firestore().collection("users").doc(uid).get()).data();
      if (data.followBestRounds) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(data.followBestRounds).toBe(1);
    expect(data.followBestTimeMs).toBeGreaterThan(0);
  });

  test("A worse follow-up run (0 rounds) does not overwrite the recorded best", async () => {
    const before = (await admin.firestore().collection("users").doc(uid).get()).data();

    await page.evaluate(() => window.startGame());
    await page.waitForFunction(() => { try { return eval("isPlayerTurn") === true && eval("level") === 1; } catch { return false; } }, { timeout: 10_000 });
    const seq = await readVar(page, "sequence");
    const wrongButton = seq[0] === 1 ? 2 : 1;
    await page.locator(`#btn${wrongButton}`).click();
    await expect(page.locator("#message")).toContainText("Game Over", { timeout: 5000 });
    await page.waitForTimeout(1500);

    const after = (await admin.firestore().collection("users").doc(uid).get()).data();
    expect(after.followBestRounds).toBe(before.followBestRounds);
    expect(after.followBestTimeMs).toBe(before.followBestTimeMs);
  });

  test("Follow Along leaderboard view is reachable and the recorded data is queryable in leaderboard order", async () => {
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
    await page.locator("#back-to-hub-game-btn").click();
    await page.locator("#game-tile-follow").click(); // nav-leaderboard only shows outside "hub"
    await page.locator("#nav-leaderboard").click();
    await expect(page.locator("#view-leaderboard h1")).toContainText("Leaderboard");

    const snap = await admin.firestore().collection("users")
      .where("followBestRounds", ">", 0)
      .orderBy("followBestRounds", "desc")
      .orderBy("followBestTimeMs", "asc")
      .limit(10).get();
    expect(snap.docs.some((d) => d.id === uid)).toBe(true);
  });

  test("The 'Games' nav button returns to the real cross-game hub (chess.html), not a local single-tile view", async () => {
    // Regression: nav-hub used to just re-show follow.html's own tiny
    // one-tile #view-hub, which reads as "clicking Games did nothing" —
    // reported by the user 2026-07-31. Every other game (checkers, golf,
    // Frisbee Golf, Cribbage) redirects to chess.html instead.
    await page.locator("#nav-hub").click();
    await page.waitForURL(/chess\.html/, { timeout: 20_000 });
  });
});
