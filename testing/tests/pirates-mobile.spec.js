// pirates-mobile.spec.js
//
// Mobile touch coverage for pirates.html. Filed after a real live bug
// report 2026-08-17: mobile "did nothing but sit there" and couldn't
// zoom — the game shipped to all 7 editions with the map camera
// completely stuck on a phone, because the only touch handling that ever
// existed was tap-to-select/hold-to-move; there was no pinch-zoom code
// behind the "Pinch to Zoom on Mobile" label at all, and no touch
// equivalent of desktop's right-click-drag-to-pan either. This spec
// exists specifically so that regression can't ship silently again.
//
// Playwright has no built-in multi-touch gesture API, so pinch is
// simulated the standard way: construct real Touch/TouchEvent objects in
// the page and dispatch them directly at the canvas via page.evaluate().
// Requires a touch-enabled browser context (hasTouch: true) — see the
// per-test context options below, not the file-level default (this repo's
// other specs run desktop/mouse, so touch is opted into per-file here
// rather than changed globally).
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
// input itself only needs hasTouch: true.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe("Pirates of No Honor — mobile touch (pinch-zoom, drag-to-pan)", () => {
  test.setTimeout(90_000);

  test("Two-finger pinch changes zoom, and one-finger drag on empty water pans the camera", async ({ page }) => {
    const robot = { email: `pirate.mobile.${Date.now()}@test.town`, displayName: "Pirate Mobile" };
    await signUpWithGoogle(page, { email: robot.email, displayName: robot.displayName });
    const uid = await verifyEmailByAddress(robot.email);
    await admin.firestore().collection("users").doc(uid).set({ approved: true, agreedToTerms: true, profile: { name: robot.displayName, neighborhood: "Pauls Valley" } }, { merge: true });
    await grantUnlimitedGamePlay(uid);

    await page.goto("/pirates.html");
    await expect(page.locator("#mode-tile-ai")).toBeVisible({ timeout: 15_000 });
    await page.locator("#mode-tile-ai").click();
    await expect(page.locator("#gameContainer")).toBeVisible({ timeout: 15_000 });

    const before = await page.evaluate(() => window.__pirateDebugCamera());
    expect(before).not.toBeNull();
    expect(before.zoom).toBeCloseTo(1, 5);

    // --- Pinch out (fingers moving apart) should zoom IN (increase zoom) ---
    await page.evaluate(() => {
      const canvas = document.getElementById("gameCanvas");
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

      function makeTouch(id, x, y) {
        return new Touch({ identifier: id, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y });
      }
      function fire(type, touches) {
        canvas.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
      }

      // Start close together (small pinch distance), then spread apart —
      // a real "pinch out to zoom in" gesture.
      let t0 = makeTouch(1, cx - 20, cy), t1 = makeTouch(2, cx + 20, cy);
      fire("touchstart", [t0, t1]);
      for (let step = 1; step <= 10; step++) {
        const offset = 20 + step * 15; // grows from 20 -> 170
        t0 = makeTouch(1, cx - offset, cy);
        t1 = makeTouch(2, cx + offset, cy);
        fire("touchmove", [t0, t1]);
      }
      fire("touchend", []);
    });

    await expect.poll(async () => (await page.evaluate(() => window.__pirateDebugCamera())).zoom, {
      message: "pinch-out should have increased zoom above the starting 1.0",
      timeout: 5_000,
    }).toBeGreaterThan(1.05);

    const afterPinch = await page.evaluate(() => window.__pirateDebugCamera());

    // --- One-finger drag on empty water should pan the camera ---
    await page.evaluate(() => {
      const canvas = document.getElementById("gameCanvas");
      const rect = canvas.getBoundingClientRect();
      // Bottom-right corner of the viewport is open ocean, far from the
      // player's base (spawned near the left edge) and empty of ships —
      // a drag starting there can't land on a unit and get treated as a
      // tap-select instead of a pan.
      const startX = rect.left + rect.width - 40, startY = rect.top + rect.height - 40;

      function makeTouch(id, x, y) {
        return new Touch({ identifier: id, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y });
      }
      function fire(type, touches) {
        canvas.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
      }

      let t = makeTouch(1, startX, startY);
      fire("touchstart", [t]);
      // Move well past the 10px pan-commit threshold, in several steps
      // (a real finger drag isn't a single jump).
      for (let step = 1; step <= 8; step++) {
        t = makeTouch(1, startX - step * 20, startY - step * 15);
        fire("touchmove", [t]);
      }
      fire("touchend", []);
    });

    await expect.poll(async () => {
      const cam = await page.evaluate(() => window.__pirateDebugCamera());
      return Math.hypot(cam.cameraX - afterPinch.cameraX, cam.cameraY - afterPinch.cameraY);
    }, {
      message: "dragging on empty water should have moved the camera",
      timeout: 5_000,
    }).toBeGreaterThan(20);
  });
});
