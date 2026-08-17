// pirates-mobile.spec.js
//
// Mobile touch coverage for pirates.html. Filed after two real live bug
// reports:
//   2026-08-17 (1): mobile "did nothing but sit there" and couldn't zoom
//     — no pan or zoom gesture existed at all, and the "Pinch to Zoom on
//     Mobile" label was never backed by any actual pinch-handling code.
//   2026-08-17 (2), after the above was fixed and shipped: still broken
//     on a real phone even though a synthetic-touch-event test passed —
//     root cause was the viewport allowing the BROWSER's own native
//     pinch-zoom-the-page to consume the gesture before the canvas's own
//     handlers ever saw it (see the viewport meta / touch-action fix).
//     Also requested in the same follow-up: mouse-only instructions were
//     showing unconditionally on phones with no mouse, the info panels
//     didn't fit a phone screen, and there was no way to select more than
//     one ship at a time on mobile (desktop's click-drag box-select had
//     no touch equivalent).
// This spec exists so none of that can regress silently again.
//
// Playwright has no built-in multi-touch gesture API, so gestures are
// simulated the standard way: construct real Touch/TouchEvent objects in
// the page and dispatch them directly at the canvas via page.evaluate().
// IMPORTANT: this proves the JS handlers are correct GIVEN a touch event
// — it does NOT prove a real phone's browser will actually hand the
// gesture to the canvas instead of consuming it natively itself (that's
// exactly what went wrong the first time). The viewport-meta/touch-action
// fix is what addresses that half; this file cannot re-verify it by
// itself, which is why real-device confirmation still matters before
// treating mobile as done.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test pirates-mobile.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, grantUnlimitedGamePlay } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

// isMobile is deliberately omitted — combined with hasTouch it changes how
// Chromium opens signInWithPopup's popup window (the sign-up helper's
// waitForEvent("page") never resolves), which has nothing to do with what
// this spec actually tests (touch gesture handling on the canvas). Touch
// input itself only needs hasTouch: true. The 390x844 viewport is also
// what exercises the narrow-screen HUD/build-menu auto-collapse CSS.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function signUpAndEnterAiMode(page, displayName) {
  const robot = { email: `${displayName.toLowerCase().replace(/\s+/g, ".")}.${Date.now()}@test.town`, displayName };
  await signUpWithGoogle(page, { email: robot.email, displayName });
  const uid = await verifyEmailByAddress(robot.email);
  await admin.firestore().collection("users").doc(uid).set({ approved: true, agreedToTerms: true, profile: { name: robot.displayName, neighborhood: "Pauls Valley" } }, { merge: true });
  await grantUnlimitedGamePlay(uid);

  await page.goto("/pirates.html");
  await expect(page.locator("#mode-tile-ai")).toBeVisible({ timeout: 15_000 });
  await page.locator("#mode-tile-ai").click();
  await expect(page.locator("#gameContainer")).toBeVisible({ timeout: 15_000 });
}

// Shared synthetic-touch dispatcher, injected into the page for every test
// below rather than duplicated per-test.
async function dispatchTouchSequence(page, steps) {
  await page.evaluate((steps) => {
    const canvas = document.getElementById("gameCanvas");
    function makeTouch(id, x, y) {
      return new Touch({ identifier: id, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y });
    }
    function fire(type, points) {
      const touches = points.map(([id, x, y]) => makeTouch(id, x, y));
      canvas.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
    }
    for (const step of steps) fire(step.type, step.points || []);
  }, steps);
}

test.describe("Pirates of No Honor — mobile touch (pinch-zoom, drag-to-pan, box-select, UI)", () => {
  test.setTimeout(90_000);

  test("Two-finger pinch changes zoom, and one-finger drag on empty water pans the camera", async ({ page }) => {
    await signUpAndEnterAiMode(page, "Pirate Mobile Pinch");

    const before = await page.evaluate(() => window.__pirateDebugCamera());
    expect(before).not.toBeNull();
    expect(before.zoom).toBeCloseTo(1, 5);

    // --- Pinch out (fingers moving apart) should zoom IN (increase zoom) ---
    const rect0 = await page.evaluate(() => {
      const r = document.getElementById("gameCanvas").getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    const pinchSteps = [{ type: "touchstart", points: [[1, rect0.cx - 20, rect0.cy], [2, rect0.cx + 20, rect0.cy]] }];
    for (let step = 1; step <= 10; step++) {
      const offset = 20 + step * 15; // grows from 20 -> 170
      pinchSteps.push({ type: "touchmove", points: [[1, rect0.cx - offset, rect0.cy], [2, rect0.cx + offset, rect0.cy]] });
    }
    pinchSteps.push({ type: "touchend", points: [] });
    await dispatchTouchSequence(page, pinchSteps);

    await expect.poll(async () => (await page.evaluate(() => window.__pirateDebugCamera())).zoom, {
      message: "pinch-out should have increased zoom above the starting 1.0",
      timeout: 5_000,
    }).toBeGreaterThan(1.05);

    const afterPinch = await page.evaluate(() => window.__pirateDebugCamera());

    // --- One-finger drag on empty water should pan the camera ---
    const rect1 = await page.evaluate(() => {
      const r = document.getElementById("gameCanvas").getBoundingClientRect();
      // Bottom-right corner of the viewport is open ocean, far from the
      // player's base (spawned near the left edge) and empty of ships —
      // a drag starting there can't land on a unit and get treated as a
      // tap-select instead of a pan.
      return { startX: r.left + r.width - 40, startY: r.top + r.height - 40 };
    });
    const panSteps = [{ type: "touchstart", points: [[1, rect1.startX, rect1.startY]] }];
    for (let step = 1; step <= 8; step++) {
      panSteps.push({ type: "touchmove", points: [[1, rect1.startX - step * 20, rect1.startY - step * 15]] });
    }
    panSteps.push({ type: "touchend", points: [] });
    await dispatchTouchSequence(page, panSteps);

    await expect.poll(async () => {
      const cam = await page.evaluate(() => window.__pirateDebugCamera());
      return Math.hypot(cam.cameraX - afterPinch.cameraX, cam.cameraY - afterPinch.cameraY);
    }, {
      message: "dragging on empty water should have moved the camera",
      timeout: 5_000,
    }).toBeGreaterThan(20);
  });

  test("Hold-then-drag on empty water with nothing selected draws a box that selects multiple ships", async ({ page }) => {
    await signUpAndEnterAiMode(page, "Pirate Mobile Box");

    // The build menu starts collapsed on this narrow viewport (see
    // collapseHudPanelsIfNarrowScreen()) — open it before trying to click
    // anything inside it.
    await page.locator("#buildMenuHeader").click();

    // Fast-track to having 2 ships without waiting on real ROUND_TIME
    // gold ticks — see __pirateDebugGrantGold's own comment for why this
    // test-only shortcut exists.
    await page.evaluate(() => window.__pirateDebugGrantGold(1000));
    await expect(page.locator("#buildCommand")).toBeEnabled({ timeout: 5_000 });
    await page.locator("#buildCommand").click();
    await expect(page.locator("#buildDock")).toBeEnabled({ timeout: 5_000 });
    await page.locator("#buildDock").click();
    await expect(page.locator("#buildMiniShip")).toBeEnabled({ timeout: 5_000 });
    await page.locator("#buildMiniShip").click();
    await page.locator("#buildMiniShip").click();

    await expect.poll(() => page.evaluate(() => window.__pirateDebugShipWorldPositions().length), {
      message: "expected 2 mini ships to have spawned",
      timeout: 5_000,
    }).toBe(2);

    // Convert the two ships' real world positions to screen coordinates
    // using the game's own camera state, rather than guessing pixel
    // offsets — spawn position math living in two places (game + test)
    // is exactly the kind of thing that silently drifts out of sync.
    const box = await page.evaluate(() => {
      const cam = window.__pirateDebugCamera();
      const ships = window.__pirateDebugShipWorldPositions();
      const xs = ships.map((s) => (s.x - cam.cameraX) * cam.zoom);
      const ys = ships.map((s) => (s.y - cam.cameraY) * cam.zoom);
      return {
        left: Math.min(...xs) - 30,
        top: Math.min(...ys) - 30,
        right: Math.max(...xs.map((x, i) => x + ships[i].width)) + 30,
        bottom: Math.max(...ys.map((y, i) => y + ships[i].height)) + 30,
      };
    });

    // Hold still first (box-select only arms once the 500ms hold timer
    // fires with nothing already selected), THEN drag to grow the box —
    // a quick drag from the start would resolve as a pan instead, same
    // as the real gesture this is modeling.
    await dispatchTouchSequence(page, [{ type: "touchstart", points: [[1, box.left, box.top]] }]);
    await page.waitForTimeout(600); // clears the 500ms hold-to-arm threshold
    await dispatchTouchSequence(page, [
      { type: "touchmove", points: [[1, (box.left + box.right) / 2, (box.top + box.bottom) / 2]] },
      { type: "touchmove", points: [[1, box.right, box.bottom]] },
      { type: "touchend", points: [] },
    ]);

    await expect.poll(() => page.evaluate(() => window.__pirateDebugSelectedCount()), {
      message: "box-select should have selected both mini ships",
      timeout: 5_000,
    }).toBe(2);
  });

  test("Tapping open water with a ship selected deselects it, unblocking box-select afterward", async ({ page }) => {
    // Reproduces the exact real bug report 2026-08-17: box-select only
    // ever arms when nothing is selected, but before this fix there was
    // no way to get back to "nothing selected" on touch once any ship
    // had been tapped — a quick tap on open water did nothing at all, so
    // box-select was permanently unreachable in practice the moment a
    // player selected their first ship.
    await signUpAndEnterAiMode(page, "Pirate Mobile Deselect");
    await page.locator("#buildMenuHeader").click();
    await page.evaluate(() => window.__pirateDebugGrantGold(1000));
    await expect(page.locator("#buildCommand")).toBeEnabled({ timeout: 5_000 });
    await page.locator("#buildCommand").click();
    await expect(page.locator("#buildDock")).toBeEnabled({ timeout: 5_000 });
    await page.locator("#buildDock").click();
    await expect(page.locator("#buildMiniShip")).toBeEnabled({ timeout: 5_000 });
    await page.locator("#buildMiniShip").click();
    await page.locator("#buildMiniShip").click();
    await expect.poll(() => page.evaluate(() => window.__pirateDebugShipWorldPositions().length), { timeout: 5_000 }).toBe(2);

    const points = await page.evaluate(() => {
      const cam = window.__pirateDebugCamera();
      const ships = window.__pirateDebugShipWorldPositions();
      const toScreen = (s) => ({ x: (s.x + s.width / 2 - cam.cameraX) * cam.zoom, y: (s.y + s.height / 2 - cam.cameraY) * cam.zoom });
      const first = toScreen(ships[0]);
      const xs = ships.map((s) => (s.x - cam.cameraX) * cam.zoom);
      const ys = ships.map((s) => (s.y - cam.cameraY) * cam.zoom);
      return {
        firstShip: first,
        emptyWater: { x: first.x + 250, y: first.y + 250 }, // well clear of either ship
        box: {
          left: Math.min(...xs) - 30, top: Math.min(...ys) - 30,
          right: Math.max(...xs.map((x, i) => x + ships[i].width)) + 30,
          bottom: Math.max(...ys.map((y, i) => y + ships[i].height)) + 30,
        },
      };
    });

    // 1) Tap the ship to select it.
    await dispatchTouchSequence(page, [
      { type: "touchstart", points: [[1, points.firstShip.x, points.firstShip.y]] },
      { type: "touchend", points: [] },
    ]);
    await expect.poll(() => page.evaluate(() => window.__pirateDebugSelectedCount())).toBe(1);

    // 2) A quick TAP (not a hold) on open water should deselect it.
    await dispatchTouchSequence(page, [
      { type: "touchstart", points: [[1, points.emptyWater.x, points.emptyWater.y]] },
      { type: "touchend", points: [] },
    ]);
    await expect.poll(() => page.evaluate(() => window.__pirateDebugSelectedCount()), {
      message: "a quick tap on open water should have deselected the ship",
      timeout: 3_000,
    }).toBe(0);

    // 3) With nothing selected, hold-then-drag should now reach
    // box-select and pick up both ships — proving the deselect actually
    // unblocked it, not just that deselect alone works in isolation.
    await dispatchTouchSequence(page, [{ type: "touchstart", points: [[1, points.box.left, points.box.top]] }]);
    await page.waitForTimeout(600);
    await dispatchTouchSequence(page, [
      { type: "touchmove", points: [[1, points.box.right, points.box.bottom]] },
      { type: "touchend", points: [] },
    ]);
    await expect.poll(() => page.evaluate(() => window.__pirateDebugSelectedCount()), {
      message: "box-select should now be reachable and select both ships",
      timeout: 5_000,
    }).toBe(2);
  });

  test("Help panel starts collapsed, shows touch instructions (not mouse ones), and toggles open", async ({ page }) => {
    await signUpAndEnterAiMode(page, "Pirate Mobile Help");

    await expect(page.locator("#helpPanelContent")).toBeHidden();
    const content = await page.locator("#helpPanelContent").innerHTML();
    expect(content).toContain("Tap");
    expect(content).toContain("Pinch");
    expect(content.toLowerCase()).not.toContain("left-click");
    expect(content.toLowerCase()).not.toContain("right-click");
    expect(content.toLowerCase()).not.toContain("scroll wheel");

    await page.locator("#helpPanelHeader").click();
    await expect(page.locator("#helpPanelContent")).toBeVisible();
    await page.locator("#helpPanelHeader").click();
    await expect(page.locator("#helpPanelContent")).toBeHidden();
  });

  test("HUD and build menu start collapsed on a narrow (phone-width) screen", async ({ page }) => {
    await signUpAndEnterAiMode(page, "Pirate Mobile Layout");

    await expect(page.locator("#hudContent")).toBeHidden();
    await expect(page.locator("#buildMenuContent")).toBeHidden();

    // Both still open on demand — collapsed-by-default isn't the same as
    // unreachable.
    await page.locator("#hudHeader").click();
    await expect(page.locator("#hudContent")).toBeVisible();
    await page.locator("#buildMenuHeader").click();
    await expect(page.locator("#buildMenuContent")).toBeVisible();
  });
});
