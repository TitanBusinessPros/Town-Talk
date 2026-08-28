// ip-blocker.spec.js
//
// Functional coverage for the IP-ban system added in commit f9ac415
// ("Add IP banning and Google Sign-In"): banUserAndIp (index.js) writes a
// blockedIPs/{ip} doc using the target's lastKnownIp, and beforeSignInBlocking
// (also index.js, a real Cloud Functions v2 Auth blocking function —
// firebase-functions/v2/identity's beforeUserSignedIn) rejects sign-in
// outright on every subsequent attempt from that same IP, for ANY account,
// not just the one that got banned — that's the whole point (a fresh
// account from the same connection must not be a way back in).
//
// Known emulator limitation, stated up front rather than glossed over: the
// Auth emulator's beforeUserSignedIn trigger fires for real here (this is
// what stamps lastKnownIp onto users/{uid} on every real sign-in — see
// emulatorAdmin.js's own comments, which already depend on that half
// working), but every Playwright-driven sign-in in this whole test run
// originates from the same machine, so every account ends up with the
// SAME lastKnownIp. That means this suite can prove the blocking LOGIC
// works (a matching blockedIPs doc really does reject a sign-in, for an
// account that never did anything wrong itself) and that banUserAndIp
// writes the right doc — it can NOT prove real IP-address specificity
// (i.e. that an unrelated person on a genuinely different network stays
// unaffected), since the emulator has no way to simulate two different
// source IPs.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test ip-blocker.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin, makeAdmin } = require("../emulatorAdmin");
const { signUpWithGoogle, logInWithGoogle } = require("../googleAuthHelper");

const STAMP = Date.now();

test.describe.serial("IP blocker (banUserAndIp + beforeSignInBlocking)", () => {
  test.setTimeout(120_000);
  let adminContext, adminPage, adminUid;
  let victimUid, victimIp;

  test("Sign up an admin and grant admin rights", async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    await signUpWithGoogle(adminPage, { email: `ipban.admin.${STAMP}@test.town`, displayName: "IpBan Admin" });
    adminUid = await verifyEmailByAddress(`ipban.admin.${STAMP}@test.town`);
    await admin.firestore().collection("users").doc(adminUid).set(
      { approved: true, agreedToTerms: true, profile: { name: "IpBan Admin" } },
      { merge: true }
    );
    await makeAdmin(adminUid);
  });

  test("A real sign-in stamps lastKnownIp via beforeSignInBlocking", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUpWithGoogle(page, { email: `ipban.victim.${STAMP}@test.town`, displayName: "IpBan Victim" });
    victimUid = await verifyEmailByAddress(`ipban.victim.${STAMP}@test.town`);
    await context.close();

    const snap = await admin.firestore().collection("users").doc(victimUid).get();
    victimIp = snap.data().lastKnownIp;
    expect(victimIp).toBeTruthy();

    await admin.firestore().collection("users").doc(victimUid).set(
      { approved: true, agreedToTerms: true, profile: { name: "IpBan Victim" } },
      { merge: true }
    );
  });

  test("banUserAndIp removes the profile and blocks their recorded IP", async () => {
    const result = await adminPage.evaluate(async (uid) => {
      try {
        const r = await window.banUserAndIpCallable({ targetUid: uid });
        return { ok: true, data: r.data };
      } catch (err) {
        return { ok: false, code: err.code, message: err.message };
      }
    }, victimUid);

    expect(result.ok).toBe(true);
    expect(result.data.ipBanned).toBe(true);

    expect((await admin.firestore().collection("users").doc(victimUid).get()).exists).toBe(false);
    expect((await admin.firestore().collection("deletedUsers").doc(victimUid).get()).exists).toBe(true);

    const banDoc = (await admin.firestore().collection("blockedIPs").doc(victimIp).get()).data();
    expect(banDoc.bannedBy).toBe(adminUid);
    expect(banDoc.bannedUid).toBe(victimUid);

    const authUser = await admin.auth().getUser(victimUid);
    expect(authUser.disabled).toBe(true);
  });

  test("The banned account itself is rejected on retry via the Auth-disabled path", async ({ browser }) => {
    // Not "blocked" here — Identity Platform rejects a disabled Auth
    // account before a beforeUserSignedIn blocking function ever runs, so
    // this account never actually reaches beforeSignInBlocking's own
    // check. Same auth/user-disabled behavior already covered by
    // admin-delete-restore.spec.js for a plain (non-IP-banned) deletion —
    // confirmed empirically here, not assumed. The IP block's own
    // rejection message is only reachable by an account that ISN'T
    // already disabled, which is exactly what the next test covers.
    const page = await (await browser.newContext()).newPage();
    await logInWithGoogle(page, { email: `ipban.victim.${STAMP}@test.town` });
    await expect(page.locator("#google-signin-message")).toContainText("disabled");
    await expect(page.locator("#nav-dashboard")).toBeHidden();
  });

  test("A brand-new, never-banned account from the SAME IP is also rejected on its very first sign-in", async ({ browser }) => {
    const freshEmail = `ipban.bystander.${STAMP}@test.town`;
    const page = await (await browser.newContext()).newPage();

    // Not using signUpWithGoogle() here: that helper waits for the
    // post-signup confirm modal, which never appears because
    // beforeSignInBlocking rejects the sign-in before the client gets that
    // far. Drive the popup manually and assert on the rejection instead.
    await page.goto("/index.html");
    const [popup] = await Promise.all([
      page.context().waitForEvent("page"),
      page.locator("#google-signin-btn").click(),
    ]);
    await popup.waitForLoadState("domcontentloaded");
    const addAccountBtn = popup.locator("#add-account-button");
    if (await addAccountBtn.isVisible().catch(() => false)) {
      await addAccountBtn.click();
    }
    await popup.locator("#email-input").fill(freshEmail);
    await popup.locator("#display-name-input").fill("IpBan Bystander");
    await popup.locator("#sign-in").click();
    await popup.waitForEvent("close", { timeout: 15_000 }).catch(() => {});

    await expect(page.locator("#google-signin-message")).toContainText("blocked", { timeout: 15_000 });
    await expect(page.locator("#google-confirm-modal-backdrop")).toBeHidden();
    await expect(page.locator("#nav-dashboard")).toBeHidden();

    // No profile doc should exist for a sign-in that was rejected before
    // it ever got that far.
    const usersMatch = await admin.firestore().collection("users").where("profile.name", "==", "IpBan Bystander").get();
    expect(usersMatch.empty).toBe(true);
  });

  // Real, previously-undiscovered bug found 2026-08-27: nothing ever
  // cleared blockedIPs/{victimIp} after this suite's own tests -- and
  // every Playwright-driven sign-in in a run shares the SAME machine IP
  // (this file's own header comment already says so). Any spec file that
  // runs in the same emulator session AFTER this one -- which is every
  // other spec in this exact CI matrix group, sequentially, in one job --
  // inherited a permanent ban on its own IP and had EVERY subsequent
  // sign-in silently rejected by beforeSignInBlocking, surfacing as a
  // confusing "#google-confirm-modal-backdrop never becomes visible"
  // timeout with no obvious connection to IP banning at all. Confirmed by
  // directly inspecting blockedIPs in a local emulator that had already
  // run this file once -- the entry was still sitting there blocking
  // every later test. Unban this file's own test IP once its tests are
  // done so it can't leak into whatever runs after it.
  test.afterAll(async () => {
    if (victimIp) {
      await admin.firestore().collection("blockedIPs").doc(victimIp).delete().catch(() => {});
    }
  });
});
