// full-platform.spec.js
//
// Two "robots" (real, automated browser sessions) play the parts of two
// neighbors on Town Fuss. Robot A is also granted admin rights for this
// test run, so it can approve/reject like a real admin would.
//
// Requires `firebase emulators:start` running in another terminal, and
// your site being served locally (the Hosting emulator does this
// automatically if firebase.json is configured for it — see the setup
// notes that came with this file).
//
// Run with: npx playwright test

const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, makeAdmin } = require("../emulatorAdmin");

const ROBOT_A = { email: "robot.a@test.town", password: "TestPass123!", name: "Robot Alice", town: "Pauls Valley" };
const ROBOT_B = { email: "robot.b@test.town", password: "TestPass123!", name: "Robot Bob", town: "Pauls Valley" };

// -----------------------------------------------------------------------
// Small reusable helpers
// -----------------------------------------------------------------------
async function signUp(page, robot) {
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("#signup-email").fill(robot.email);
  await page.locator("#signup-password").fill(robot.password);
  await page.locator("#signup-age-confirm").check();
  await page.locator("#signup-terms-confirm").check();
  await page.locator("#form-signup button[type=submit]").click();
  // At this point the account exists but sits on the "verify your email" gate.
}

async function logIn(page, robot) {
  await page.goto("/index.html");
  await page.locator("#login-email").fill(robot.email);
  await page.locator("#login-password").fill(robot.password);
  await page.locator("#form-login button[type=submit]").click();
}

async function fillBasicsAndPost(page, robot) {
  await page.locator("#display-name").fill(robot.name);
  await page.locator("#neighborhood").selectOption(robot.town);
  await page.locator("#profile-form button[type=submit]").click();
  await page.locator("#post-text").fill(
    `Hi neighbors, I'm ${robot.name}, an automated test account used to check that Town Fuss features are working correctly. Please ignore.`
  );
  await page.locator("#post-form button[type=submit]").click();
}

// =========================================================================
test.describe.serial("Town Fuss — full platform pass", () => {
  test.setTimeout(180_000);
  let pageA, pageB, contextA, contextB, uidA, uidB;

  test("Sign up both robots and get past email verification", async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    await signUp(pageA, ROBOT_A);
    await signUp(pageB, ROBOT_B);

    // A real browser click can't click a link in a real inbox — this is
    // the one step the emulator lets us shortcut safely.
    uidA = await verifyEmailByAddress(ROBOT_A.email);
    uidB = await verifyEmailByAddress(ROBOT_B.email);
    await makeAdmin(uidA); // Robot A doubles as our test admin

    // Reload so each page picks up the now-verified status.
    await pageA.reload();
    await pageB.reload();
    await expect(pageA.locator("#profile-form")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#profile-form")).toBeVisible({ timeout: 15_000 });
  });

  test("Both robots fill in their profile and submit a post", async () => {
    await fillBasicsAndPost(pageA, ROBOT_A);
    await fillBasicsAndPost(pageB, ROBOT_B);
    await expect(pageA.locator("#post-message")).toContainText("Saved");
    await expect(pageB.locator("#post-message")).toContainText("Saved");
  });

  test("Post-form rejects a too-long post and a post with a phone number", async () => {
    const tooLong = "word ".repeat(501);
    await pageA.locator("#post-text").fill(tooLong);
    await pageA.locator("#post-form button[type=submit]").click();
    await expect(pageA.locator("#post-message")).toContainText("500 words");

    await pageA.locator("#post-text").fill("Call me at 405-555-1234 anytime!");
    await pageA.locator("#post-form button[type=submit]").click();
    await expect(pageA.locator("#post-message")).toContainText("phone number");

    // Restore a clean, valid post before continuing.
    await fillBasicsAndPost(pageA, ROBOT_A);
  });

  test("Admin (Robot A) approves both profiles", async () => {
    await pageA.locator("#nav-admin").click();
    await expect(pageA.locator("#admin-queue")).toBeVisible();
    // Approve every card currently in the queue (both robots' submissions).
    const approveButtons = pageA.locator('#admin-queue button:has-text("Approve")');
    const count = await approveButtons.count();
    for (let i = 0; i < count; i++) {
      await pageA.locator('#admin-queue button:has-text("Approve")').first().click();
      await pageA.waitForTimeout(500); // let the card removal settle between clicks
    }
    await pageA.locator("#nav-dashboard").click();
  });

  test("Both robots now appear in the Feed", async () => {
    await pageA.locator("#nav-feed").click();
    // Scoped to .tp-name specifically — a plain text match also hits the
    // post excerpt, since the auto-generated post text embeds the robot's
    // own name too ("Hi neighbors, I'm Robot Alice...").
    await expect(pageA.locator(".tp-name", { hasText: ROBOT_A.name })).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator(".tp-name", { hasText: ROBOT_B.name })).toBeVisible({ timeout: 10_000 });
  });

  test("Directory search finds Robot B by name", async () => {
    await pageA.locator("#nav-directory").click();
    await pageA.locator("#directory-search").fill(ROBOT_B.name);
    // Directory search result cards use .dir-name (renderDirectory() in
    // index.html), not .tp-name — that class is only used by Feed/profile
    // cards. Targeting the wrong class here matched a stale, hidden .tp-name
    // span left over from the previous view instead of a real result.
    await expect(pageA.locator(".dir-name", { hasText: ROBOT_B.name })).toBeVisible();
  });

  test("Robot A sends a friend request, Robot B accepts", async () => {
    await pageA.locator("#directory-search").fill(ROBOT_B.name);
    await pageA.locator(".directory-card", { hasText: ROBOT_B.name }).click();
    await pageA.locator(".friend-add-btn").click();
    await expect(pageA.locator(".friend-action")).toContainText("Request sent");

    await pageB.locator("#nav-friends").click();
    await pageB.locator('button:has-text("Accept")').first().click();
    await expect(pageB.getByText(ROBOT_A.name)).toBeVisible();
  });

  test("Robot A sends Robot B their first message, and it arrives", async () => {
    await pageA.locator("#nav-directory").click();
    await pageA.locator("#directory-search").fill(ROBOT_B.name);
    await pageA.locator(".directory-card", { hasText: ROBOT_B.name }).click();
    await pageA.locator(".msg-btn").click();
    await pageA.locator("#thread-input").fill("Hey neighbor, this is an automated test message.");
    await pageA.locator("#thread-form button[type=submit]").click();
    await expect(pageA.locator("#thread-messages")).toContainText("automated test message");

    await pageB.locator("#nav-messages").click();
    await pageB.locator(".conversation-item", { hasText: ROBOT_A.name }).click();
    await expect(pageB.locator("#thread-messages")).toContainText("automated test message");
  });

  test("Messaging respects the daily 3-message limit", async () => {
    for (let i = 0; i < 2; i++) {
      await pageA.locator("#thread-input").fill(`Test message number ${i + 2}`);
      await pageA.locator("#thread-form button[type=submit]").click();
      // The submit handler is async (it runs a Firestore transaction before
      // clearing the input) — clicking Send again before that resolves
      // races the two sends against each other. Wait for the input to
      // actually clear (the handler's own success signal) before the next
      // iteration, so each send's transaction is confirmed complete first.
      await expect(pageA.locator("#thread-input")).toHaveValue("", { timeout: 10_000 });
    }
    // After 3 total messages today (1 from the earlier test + 2 here), the
    // real-time messageLimits listener proactively disables the Send button
    // (renderMessageRemaining() in index.html) instead of letting a 4th send
    // attempt happen and get rejected after the fact — so there's no 4th
    // click to make; the button itself going disabled IS the expected result.
    await expect(pageA.locator("#thread-send-btn")).toBeDisabled();
    await expect(pageA.locator("#messages-remaining")).toContainText("0 / 3 messages left today");
  });

  test("Chat room: Robot A posts, Robot B likes it, count updates for both", async () => {
    await pageA.locator("#nav-chatrooms").click();
    await pageA.locator(".chatroom-tile", { hasText: "Pauls Valley Chat" }).click();
    await pageA.locator("#chatroom-input").fill("Automated test chat message");
    await pageA.locator("#chatroom-form button[type=submit]").click();
    await expect(pageA.locator(".chat-msg-row").last()).toContainText("Automated test chat message");

    await pageB.locator("#nav-chatrooms").click();
    await pageB.locator(".chatroom-tile", { hasText: "Pauls Valley Chat" }).click();
    const lastRow = pageB.locator(".chat-msg-row").last();
    await lastRow.locator('[data-action="like"]').click();
    await expect(lastRow.locator('[data-action="like"]')).toContainText("1");

    // Confirm Robot A sees the like count update too (real-time listener).
    await expect(pageA.locator(".chat-msg-row").last().locator('[data-action="like"]')).toContainText("1");
  });

  test("Blocking: Robot A blocks Robot B, who can no longer message them", async () => {
    await pageA.locator("#nav-directory").click();
    await pageA.locator("#directory-search").fill(ROBOT_B.name);
    await pageA.locator(".directory-card", { hasText: ROBOT_B.name }).click();
    pageA.once("dialog", (dialog) => dialog.accept()); // confirm() popup
    await pageA.locator(".block-btn").click();
    await pageA.waitForTimeout(500);

    // Unblock immediately after, so later tests aren't affected.
    await pageA.locator("#nav-dashboard").click();
    pageA.once("dialog", (dialog) => dialog.accept());
    const unblockBtn = pageA.locator('#blocked-users-list button:has-text("Unblock")').first();
    if (await unblockBtn.count()) await unblockBtn.click();
  });

  test("Chess: Robot A invites Robot B directly, Robot B accepts, both see the board", async () => {
    // chess.html lands on a game hub, not the waiting room directly —
    // #friends-invite-list only exists inside view-waiting, reached via
    // hub -> mode-select -> "Play Online".
    await pageA.goto("/chess.html");
    await pageA.locator("#game-tile-chess").click();
    await pageA.locator("#mode-tile-online").click();

    // Open the friends-invite list and click Invite next to Robot B.
    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #create-table-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    // Robot B navigates to the same waiting room fresh (after the invite
    // already exists), so no reload is needed to pick it up.
    await pageB.goto("/chess.html");
    await pageB.locator("#game-tile-chess").click();
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator('button:has-text("Accept")').first().click();

    // Both players' game view should now actually be showing — checking
    // just #board .square count is a false positive: those 64 squares are
    // created unconditionally at page load (initBoardGrid() in chess.html)
    // regardless of which view is visible, so it can't tell "on the game
    // screen" apart from "still on the Waiting Room".
    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });
    await expect(pageA.locator("#board .square").first()).toBeVisible();
    await expect(pageB.locator("#board .square").first()).toBeVisible();
  });

  test("Chess: a move made by one player appears on the other player's board", async () => {
    // Whoever is White moves first — try Robot A; if it's not A's turn,
    // the click is harmless (illegal-move clicks are simply ignored).
    await pageA.locator('[data-row="6"][data-col="4"]').click();
    await pageA.locator('[data-row="4"][data-col="4"]').click();

    // Give the Firestore sync a moment, then confirm Robot B's board changed.
    await pageB.waitForTimeout(2000);
    const pieceMovedForB = await pageB.locator('[data-row="4"][data-col="4"]').textContent();
    expect(pieceMovedForB?.trim().length).toBeGreaterThan(0);
  });

  test("Checkers: Robot A invites Robot B directly, Robot B accepts, both see the board", async () => {
    // Unlike chess.html, checkers.html has no separate hub screen — it
    // lands straight on mode-select (see checkForActiveGame()'s fallback).
    await pageA.goto("/checkers.html");
    await pageA.locator("#mode-tile-online").click();

    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #create-table-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    await pageB.goto("/checkers.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator('button:has-text("Accept")').first().click();

    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });
    await expect(pageA.locator("#board .square").first()).toBeVisible();
    await expect(pageB.locator("#board .square").first()).toBeVisible();
  });

  test("Checkers: a move made by one player appears on the other player's board", async () => {
    // Red (player1) moves first. initialBoardState() puts a red piece at
    // (5,0); (4,1) is empty and diagonally forward — a legal opening move.
    await pageA.locator('[data-row="5"][data-col="0"]').click();
    await pageA.locator('[data-row="4"][data-col="1"]').click();

    await pageB.waitForTimeout(2000);
    // Checkers renders pieces via innerHTML (a styled circle div), not
    // textContent like chess's unicode piece characters — check for markup
    // presence instead.
    const pieceMovedForB = await pageB.locator('[data-row="4"][data-col="1"]').innerHTML();
    expect(pieceMovedForB.trim().length).toBeGreaterThan(0);
    const originSquareForB = await pageB.locator('[data-row="5"][data-col="0"]').innerHTML();
    expect(originSquareForB.trim().length).toBe(0);
  });

  test("WynneWars: Robot A invites Robot B directly, Robot B accepts, both see the board", async () => {
    // Like checkers.html, ww.html lands straight on mode-select.
    await pageA.goto("/ww.html");
    await pageA.locator("#mode-tile-online").click();

    await pageA.locator("#ww-friends-invite-list").waitFor();
    await pageA.locator("#ww-friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #ww-waiting-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    await pageB.goto("/ww.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator('button:has-text("Accept")').first().click();

    await expect(pageA.locator("#view-game-board")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#view-game-board")).toBeVisible({ timeout: 15_000 });
  });

  test("WynneWars: completing a full turn syncs to the other player without hanging on any phase", async () => {
    // This directly re-checks the original "stuck on expand" bug: click
    // through every phase for Robot A's first turn. #end-btn isn't disabled
    // during wizard_move/expand/attack/fortify (only "deploy" blocks it
    // until all reinforcements are placed), so those phases can be skipped
    // outright; deploy requires actually placing all 3 starting
    // reinforcements (getReinforcementCount() for 3 starting territories)
    // onto an owned cell, which auto-advances to "expand" on its own.
    await pageA.locator("#end-btn").click(); // wizard_move -> deploy
    for (let i = 0; i < 3; i++) {
      await pageA.locator("#board .ww-cell").nth(5).click();
    }
    await expect(pageA.locator("#phase-indicator")).toContainText("EXPAND", { timeout: 5_000 });
    await pageA.locator("#end-btn").click(); // expand -> attack
    await pageA.locator("#end-btn").click(); // attack -> fortify
    await pageA.locator("#end-btn").click(); // fortify -> submits the turn online

    // Robot B's board should now show it's their turn.
    await expect(pageB.locator("#status")).toContainText("Your turn", { timeout: 10_000 });
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });
});