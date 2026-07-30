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

const path = require("path");
const { test, expect } = require("@playwright/test");
const { verifyEmailByAddress, makeAdmin } = require("../emulatorAdmin");

const ROBOT_A = { email: "robot.a@test.town", password: "TestPass123!", name: "Robot Alice", town: "Pauls Valley" };
const ROBOT_B = { email: "robot.b@test.town", password: "TestPass123!", name: "Robot Bob", town: "Pauls Valley" };
const TEST_IMAGE_PATH = path.resolve(__dirname, "..", "..", "Logo-Fav.png");

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

// Simulates a real mouse drag on a frisbee-golf canvas. Coordinates are in
// the canvas's LOGICAL pixel space (its width/height attributes, e.g.
// 800x600) — converted here to real page coordinates via the canvas's
// current on-screen bounding box, so it works correctly regardless of how
// small the canvas is actually rendered (it's CSS-scaled to fit the page).
async function dragFrisbee(page, canvasLocator, fromLogical, toLogical) {
  const box = await canvasLocator.boundingBox();
  const canvasWidth = await canvasLocator.evaluate((el) => el.width);
  const canvasHeight = await canvasLocator.evaluate((el) => el.height);
  const toPage = (p) => ({
    x: box.x + (p.x / canvasWidth) * box.width,
    y: box.y + (p.y / canvasHeight) * box.height,
  });
  const start = toPage(fromLogical);
  const end = toPage(toLogical);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
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
    // Generous timeout here specifically: this is the very first real
    // Firestore round-trip against a freshly-started emulator (cold
    // gRPC/WebChannel connection setup for two concurrent listeners), which
    // can take noticeably longer than any later request in the suite.
    await expect(pageA.locator("#profile-form")).toBeVisible({ timeout: 45_000 });
    await expect(pageB.locator("#profile-form")).toBeVisible({ timeout: 45_000 });
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

    // Resign so this game is actually "finished" — otherwise
    // checkForActiveGame() jumps whoever loads chess.html next straight
    // back into this still-"active" game instead of the hub, breaking
    // every later test that expects to start fresh from there.
    pageA.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await pageA.locator("#resign-btn").click();
    await pageA.waitForTimeout(500);
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

  test("Golf: Robot A invites Robot B directly, Robot B accepts, both see the board", async () => {
    // Like checkers.html, golf.html lands straight on mode-select.
    await pageA.goto("/golf.html");
    await pageA.locator("#mode-tile-online").click();

    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #waiting-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    await pageB.goto("/golf.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator('button:has-text("Accept")').first().click();

    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });
  });

  test("Golf: a shot taken by one player syncs to the other player", async () => {
    // Robot A created the table, so she's player1 and goes first.
    await expect(pageA.locator("#golf-shoot-btn")).toBeEnabled({ timeout: 10_000 });
    await pageA.locator("#golf-shoot-btn").click();

    // Give the shot's physics time to settle (friction-based deceleration
    // takes a few seconds) and sync to Firestore, then to Robot B's client.
    await pageB.waitForTimeout(6000);
    await expect(pageB.locator("#golf-status")).not.toContainText("Waiting for an opponent", { timeout: 5000 });

    // Resign so this game finishes cleanly — otherwise checkForActiveGame()
    // would jump whoever loads golf.html next straight back into it.
    pageA.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await pageA.locator("#resign-btn").click();
    await pageA.waitForTimeout(500);
  });

  test("Frisbee Golf: Robot A invites Robot B directly, Robot B accepts, both see the board", async () => {
    await pageA.goto("/fg.html");
    await pageA.locator("#mode-tile-online").click();

    await pageA.locator("#friends-invite-list").waitFor();
    await pageA.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageA.locator(".message, #waiting-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    await pageB.goto("/fg.html");
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator('button:has-text("Accept")').first().click();

    await expect(pageA.locator("#view-game")).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator("#view-game")).toBeVisible({ timeout: 15_000 });
  });

  test("Frisbee Golf: a throw taken by one player syncs to the other player", async () => {
    // Robot A created the table, so she's player1 and goes first. Hole 1
    // has no obstacles and a straight horizontal shot, so any modest
    // pull-back-and-release drag is a safe, uncomplicated smoke test.
    await expect(pageA.locator("#fg-status")).toContainText("Your turn", { timeout: 10_000 });
    await dragFrisbee(pageA, pageA.locator("#fg-canvas"), { x: 100, y: 300 }, { x: 20, y: 300 });

    // Give the throw's physics time to settle and sync to Firestore, then
    // to Robot B's client.
    await pageB.waitForTimeout(6000);
    await expect(pageB.locator("#fg-status")).not.toContainText("Waiting for an opponent", { timeout: 5000 });

    // Resign so this game finishes cleanly — otherwise checkForActiveGame()
    // would jump whoever loads fg.html next straight back into it.
    pageA.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await pageA.locator("#resign-btn").click();
    await pageA.waitForTimeout(500);
  });

  test("Robot B uploads a profile photo", async () => {
    // Robot B, not A — uploading a new photo un-approves the profile
    // pending re-review (everApproved gate), and test 28 later needs to
    // find Robot A via directory search, which only shows approved
    // profiles. Robot B's approval status isn't checked again after this.
    // pageB is still on ww.html from the last game test — #nav-dashboard
    // only exists on index.html.
    await pageB.goto("/index.html");
    await pageB.locator("#nav-dashboard").click();
    await pageB.locator("#image-input").setInputFiles(TEST_IMAGE_PATH);
    await expect(pageB.locator("#image-message")).toContainText("Uploaded", { timeout: 15_000 });
    await expect(pageB.locator("#image-slots img")).toBeVisible({ timeout: 10_000 });
  });

  test("Robot B creates a business listing with a logo", async () => {
    await pageB.goto("/index.html");
    await pageB.locator("#nav-business").click();
    await pageB.locator("#business-tab-mylisting").click();
    // Save the text fields first, then upload the logo — doing it the other
    // way around races the form: uploading first creates a bare-bones
    // listing doc with an empty name via setDoc(), and the live listener
    // that keeps #biz-name in sync overwrites whatever was just typed
    // there (it only skips the overwrite while the field has focus).
    await pageB.locator("#biz-name").fill("Bob's Bait & Tackle");
    await pageB.locator("#biz-phone").fill("(405) 555-0199");
    await pageB.locator("#biz-town").selectOption("Pauls Valley");
    await pageB.locator("#biz-description").fill("Worms, lures, and lake gossip since this morning.");
    await pageB.locator("#business-form button[type=submit]").click();
    await expect(pageB.locator("#business-form-message")).toContainText("Saved", { timeout: 10_000 });
    await expect(pageB.locator("#business-status-badge")).toContainText("Pending review");

    await pageB.locator("#business-image-input").setInputFiles(TEST_IMAGE_PATH);
    await expect(pageB.locator("#business-image-message")).toContainText("Uploaded", { timeout: 15_000 });
  });

  test("Admin approves the business listing and marks it paid", async () => {
    // pageA is still on ww.html from the WynneWars turn test.
    await pageA.goto("/index.html");
    await pageA.locator("#nav-admin").click();
    const bizCard = pageA.locator("#admin-business-queue .admin-card", { hasText: "Bob's Bait & Tackle" });
    await expect(bizCard).toBeVisible({ timeout: 10_000 });
    await bizCard.locator('[data-action="mark-paid"]').click();
    await expect(bizCard.locator(".message")).toContainText("Marked paid", { timeout: 10_000 });
    await bizCard.locator('[data-action="approve"]').click();
    await expect(bizCard).toHaveCount(0, { timeout: 10_000 });
  });

  test("The approved business appears in the Local Businesses directory with its logo, in a 2-column grid layout", async () => {
    await pageA.locator("#nav-business").click();
    await pageA.locator("#business-tab-directory").click();
    const card = pageA.locator(".directory-card", { hasText: "Bob's Bait & Tackle" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator("img")).toBeVisible();
    // .business-directory-grid is a 2-column CSS grid (wraps down the page
    // instead of a single horizontal-scrolling row) — confirm that's
    // actually the layout in effect, not a single-column vertical stack.
    const display = await pageA.locator("#business-directory-grid").evaluate((el) => getComputedStyle(el).display);
    const columnCount = await pageA.locator("#business-directory-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(display).toBe("grid");
    expect(columnCount).toBe(2);
  });

  test("Favicon is set on the page", async () => {
    const href = await pageA.locator('link[rel="icon"]').getAttribute("href");
    expect(href).toContain("Logo-Fav.png");
  });

  test("Friend avatars render in the Friends section", async () => {
    await pageA.locator("#nav-friends").click();
    await expect(pageA.locator(".friend-list-item .profile-avatar, .friend-list-item .profile-avatar-fallback").first()).toBeVisible({ timeout: 10_000 });
  });

  test("Notification bell shows entries for the earlier first message and chat reaction", async () => {
    // Reuses events that already happened in earlier tests (Robot A
    // messaged Robot B for the first time; Robot B liked Robot A's chat
    // message) — just checking the bell picked them up, not re-triggering
    // them.
    await pageB.locator("#nav-notifications").click();
    await expect(pageB.locator("#notif-bell-list")).toContainText("message", { timeout: 20_000 });

    await pageA.locator("#nav-notifications").click();
    await expect(pageA.locator("#notif-bell-list")).toContainText("liked", { timeout: 20_000 });

    // Clicking the reaction notification should jump straight to the exact
    // chat room + message that got liked, not just the chat rooms list.
    await pageA.locator(".notif-bell-item", { hasText: "liked" }).click();
    await expect(pageA.locator("#chatroom-thread-view")).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator("#chatroom-title")).toContainText("Pauls Valley Chat");
    await expect(pageA.locator(".chat-msg-highlight")).toContainText("Automated test chat message");
  });

  test("Robot B invites Robot A to chess; it shows up in Robot A's Messages and notification bell", async () => {
    // Reverse direction from the earlier chess test (which was A -> B) so
    // this doesn't collide with that invite's 1-hour rate-limit cooldown.
    await pageB.goto("/chess.html");
    // view-hub has no display:none in the static markup, so it's clickable
    // immediately on load — but checkForActiveGame()'s async query can
    // still be in flight and call showView("hub") *after* our click
    // navigates past it, silently resetting back to the hub. Give it a
    // moment to settle first (chessGames has accumulated enough documents
    // by this point in the suite for that race to actually matter).
    await pageB.waitForTimeout(1000);
    await pageB.locator("#game-tile-chess").click();
    await pageB.locator("#mode-tile-online").click();
    await pageB.locator("#friends-invite-list").waitFor();
    await pageB.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageB.locator(".message, #create-table-message")).toBeVisible({ timeout: 10_000 }).catch(() => {});

    // The invite Cloud Function posts into Messages and the bell — give the
    // emulator a moment to run the trigger.
    await pageA.locator("#nav-messages").click();
    await pageA.locator(".conversation-item", { hasText: "Robot Bob" }).click();
    await expect(pageA.locator("#thread-messages")).toContainText("invited you to play Chess", { timeout: 15_000 });
    await expect(pageA.locator("#thread-messages a[href='/chess.html'], #thread-messages a[href='chess.html']")).toBeVisible();

    // The Messages check above already proves the invite Cloud Function ran
    // (sendPushToUser, which logs the bell entry, runs before
    // postGameInviteMessage in that same trigger) — so the notification doc
    // already exists server-side. Reload for a fresh onSnapshot
    // subscription rather than trust the existing listener to have already
    // delivered it; that live-delivery timing has proven flaky under the
    // load of this many tests hammering the emulator back-to-back.
    await pageA.reload();
    // Reload re-runs onAuthStateChanged, which does an awaited forced
    // token refresh before watchNotificationBell() is even called — give
    // that dance time to finish before we click into the panel, otherwise
    // we can click/read before the fresh onSnapshot listener has attached.
    await pageA.locator("#nav-notifications").waitFor({ state: "visible", timeout: 20_000 });
    await pageA.waitForTimeout(5000);
    await pageA.locator("#nav-notifications").click();
    await expect(pageA.locator("#notif-bell-list")).toContainText("Game Invite", { timeout: 25_000 });
  });

  test("Robot B can't invite Robot A to chess again within the cooldown", async () => {
    await pageB.locator("#friends-invite-list button", { hasText: "Invite" }).first().click();
    await expect(pageB.locator("#waiting-message")).toContainText("again in about", { timeout: 10_000 });
  });

  test("Robot A declines Robot B's chess invite", async () => {
    await pageA.goto("/chess.html");
    await pageA.waitForTimeout(1000); // see note above on checkForActiveGame() race
    await pageA.locator("#game-tile-chess").click();
    await pageA.locator("#mode-tile-online").click();
    const inviteRow = pageA.locator(".invite-row", { hasText: "Robot Bob" });
    await expect(inviteRow).toBeVisible({ timeout: 10_000 });
    await inviteRow.locator("button", { hasText: "Decline" }).click();
    await expect(inviteRow).toHaveCount(0, { timeout: 10_000 });
  });

  test("Robot B reports Robot A's profile", async () => {
    // pageB is still on chess.html from the cooldown test.
    await pageB.goto("/index.html");
    await pageB.locator("#nav-directory").click();
    await pageB.locator("#directory-search").fill(ROBOT_A.name);
    await pageB.locator(".directory-card", { hasText: ROBOT_A.name }).click();
    await pageB.locator(".report-btn").first().click();
    await pageB.locator("#report-reason-select").selectOption("other");
    await pageB.locator("#report-details-text").fill("Automated test report — please ignore.");
    await pageB.locator("#report-modal-form button[type=submit]").click();
    await expect(pageB.locator("#report-modal-message")).toContainText("sent to our admin team", { timeout: 10_000 });
  });

  test("Robot A reports a chat room message from Robot B", async () => {
    // Robot B has posted in chat before (liked A's message in an earlier
    // test, but hasn't posted their own yet) — post one now so there's a
    // message from Robot B for Robot A to report.
    await pageB.locator("#nav-chatrooms").click();
    await pageB.locator(".chatroom-tile", { hasText: "Pauls Valley Chat" }).click();
    await pageB.locator("#chatroom-input").fill("Reportable test message from Bob.");
    await pageB.locator("#chatroom-form button[type=submit]").click();
    await expect(pageB.locator(".chat-msg-row").last()).toContainText("Reportable test message from Bob.");

    // pageA is still on chess.html from the decline test.
    await pageA.goto("/index.html");
    await pageA.locator("#nav-chatrooms").click();
    await pageA.locator(".chatroom-tile", { hasText: "Pauls Valley Chat" }).click();
    const lastRow = pageA.locator(".chat-msg-row").last();
    await expect(lastRow).toContainText("Reportable test message from Bob.");
    await lastRow.locator(".report-btn").click();
    await pageA.locator("#report-reason-select").selectOption("spam");
    await pageA.locator("#report-modal-form button[type=submit]").click();
    await expect(pageA.locator("#report-modal-message")).toContainText("sent to our admin team", { timeout: 10_000 });
  });

  test("Admin sees both reports in the Reports queue", async () => {
    await pageA.locator("#nav-admin").click();
    await expect(pageA.locator("#admin-reports-queue")).toContainText("Robot Alice", { timeout: 10_000 });
    await expect(pageA.locator("#admin-reports-queue")).toContainText("Robot Bob", { timeout: 10_000 });
  });

  test("Robot B submits a bug report, and it shows up in the admin Bug reports queue", async () => {
    await pageB.locator("#nav-report-issue").click();
    await pageB.locator("#bug-report-text").fill("Automated test bug report — please ignore.");
    await pageB.locator("#bug-report-modal-form button[type=submit]").click();
    await expect(pageB.locator("#bug-report-modal-message")).toContainText("sent to our team", { timeout: 10_000 });

    await pageA.locator("#nav-admin").click();
    await expect(pageA.locator("#admin-bug-reports-queue")).toContainText("Robot Bob", { timeout: 10_000 });
    await expect(pageA.locator("#admin-bug-reports-queue")).toContainText("Automated test bug report", { timeout: 10_000 });
  });

  test("Robot B can't submit a second bug report while the first is still open", async () => {
    await pageB.locator("#nav-report-issue").click();
    await expect(pageB.locator("#bug-report-modal-message")).toContainText("already have an open report", { timeout: 10_000 });
    // The submit button should be disabled by that same pre-check.
    await expect(pageB.locator("#bug-report-modal-form button[type=submit]")).toBeDisabled();
    await pageB.locator("#bug-report-modal-cancel").click();
  });

  test("Admin resolves the bug report, which frees Robot B to submit a new one", async () => {
    await pageA.locator("#admin-bug-reports-queue button", { hasText: "Mark reviewed" }).first().click();
    await expect(pageA.locator("#admin-bug-reports-queue")).not.toContainText("Automated test bug report", { timeout: 10_000 });

    await pageB.locator("#nav-report-issue").click();
    await expect(pageB.locator("#bug-report-modal-message")).not.toBeVisible();
    await expect(pageB.locator("#bug-report-modal-form button[type=submit]")).toBeEnabled();
    await pageB.locator("#bug-report-modal-cancel").click();
  });

  test("Password reset request succeeds against the Auth emulator", async ({ browser }) => {
    // Independent context — doesn't touch Robot A/B's signed-in sessions.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/index.html");
    await page.locator('.tab[data-tab="reset"]').click();
    await page.locator("#reset-email").fill(ROBOT_B.email);
    await page.locator("#form-reset button[type=submit]").click();
    await expect(page.locator("#reset-message")).toContainText("Check your email", { timeout: 10_000 });
    await context.close();
  });

  test("Account deletion removes the account and its data", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const throwaway = { email: `deleteme.${Date.now()}@test.town`, password: "TestPass123!", name: "Delete Me" };

    await signUp(page, throwaway);
    await page.waitForTimeout(500);
    await verifyEmailByAddress(throwaway.email);
    await page.reload();
    await page.waitForSelector("#profile-form", { timeout: 15_000 });
    await page.locator("#display-name").fill(throwaway.name);
    await page.locator("#neighborhood").selectOption("Pauls Valley");
    await page.locator("#profile-form button[type=submit]").click();

    await page.locator("#nav-dashboard").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#delete-password").fill(throwaway.password);
    await page.locator("#delete-account-form button[type=submit]").click();

    // onAuthStateChanged should detect the sign-out and drop back to a
    // signed-out view.
    await expect(page.locator("#nav-auth")).toBeVisible({ timeout: 10_000 });

    // Confirm the account is actually gone, not just signed out — a
    // deleted account can't log back in.
    await page.locator("#login-email").fill(throwaway.email);
    await page.locator("#login-password").fill(throwaway.password);
    await page.locator("#form-login button[type=submit]").click();
    await expect(page.locator("#login-message")).toContainText("incorrect", { timeout: 10_000 });

    await context.close();
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });
});