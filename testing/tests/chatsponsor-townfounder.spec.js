// chatsponsor-townfounder.spec.js
//
// Covers the two new business features added 2026-08-06:
//   1. Chat Room Sponsorship — self-service submission, admin approval,
//      the banner rendering for other viewers, and specifically the
//      reject-then-resubmit-by-a-different-user edge case (Firestore
//      evaluates that as an UPDATE against an existing doc, not a CREATE
//      — see the firestore.rules comment on chatSponsors/{roomId}).
//   2. Town Founder — the admin "Found a Town" grant (permanent
//      President badge, +1 year Diamond, business-listing promo
//      whitelist entry) and that the badge actually renders on a fresh
//      profile view.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test chatsponsor-townfounder.spec.js

const { test, expect } = require("@playwright/test");
const { getUidForGoogleSignIn: verifyEmailByAddress, admin } = require("../emulatorAdmin");
const { signUpWithGoogle } = require("../googleAuthHelper");

// Lets this suite validate any edition's real build — these two need to
// be two DIFFERENT real towns that exist on whichever edition is running
// (defaults to Pauls Valley's own towns for the normal/default run). Set
// TEST_TOWN_1/TEST_TOWN_2 when running against a different edition.
const TOWN_1 = process.env.TEST_TOWN_1 || "Wynnewood";
const TOWN_2 = process.env.TEST_TOWN_2 || "Davis";
const slug = (t) => t.toLowerCase().replace(/\s+/g, "-") + "-chat";
const TOWN_1_ROOM_ID = slug(TOWN_1);
const TOWN_2_ROOM_ID = slug(TOWN_2);

async function signUp(page, email) {
  await signUpWithGoogle(page, { email });
}

async function waitForRealSignupDoc(uid, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists && snap.data().email) return snap.data();
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`users/${uid} never got its real signup fields (email/createdAt) within ${timeoutMs}ms`);
}

// Tracked here (not per-test) since every approved profile this file
// creates goes through this one helper — see the file-level afterAll below,
// added 2026-08-28 after these leaking into the shared emulator was found
// to be part of why full-platform.spec.js's Feed test intermittently can't
// find Robot Bob: the Feed only keeps its top 21 profiles per town by
// friend count (index.html's TOP_PROFILES_LIMIT), and this file alone was
// leaving 6 unrelated "Pauls Valley" approved profiles competing for those
// slots in every CI run that included it before full-platform.spec.js.
const createdUserUids = [];

async function approve(uid, name, extraFields = {}) {
  await admin.firestore().collection("users").doc(uid).set(
    { approved: true, agreedToTerms: true, profile: { name, neighborhood: "Pauls Valley" }, ...extraFields },
    { merge: true }
  );
  createdUserUids.push(uid);
}

// Runs once after every test in this file (both describe blocks below) —
// removes every profile this file created via approve() so it can't
// compete for the Feed's per-town top-21 slice in whatever spec file runs
// next against the same shared emulator. None of these uids are
// referenced anywhere outside this file (each is a throwaway, uniquely
// timestamped account), so there's nothing later that still needs them.
test.afterAll(async () => {
  for (const uid of createdUserUids) {
    await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
  }
});

test.describe("Chat Room Sponsorship", () => {
  test("submit, admin approve, banner shows for another viewer", async ({ browser }) => {
    const sponsorEmail = "sponsor." + Date.now() + "@test.town";
    const adminEmail = "sponsoradmin." + Date.now() + "@test.town";
    const viewerEmail = "viewer." + Date.now() + "@test.town";

    const sponsorPage = await (await browser.newContext()).newPage();
    await signUp(sponsorPage, sponsorEmail);
    await sponsorPage.waitForTimeout(1000);
    const sponsorUid = await verifyEmailByAddress(sponsorEmail);
    await waitForRealSignupDoc(sponsorUid);
    await approve(sponsorUid, "Sponsor Co");
    await sponsorPage.reload();

    let navReady = false;
    for (let i = 0; i < 15; i++) {
      navReady = await sponsorPage.locator("#nav-pricing").isVisible().catch(() => false);
      if (navReady) break;
      await sponsorPage.waitForTimeout(400);
    }
    expect(navReady).toBe(true);

    await sponsorPage.locator("#nav-pricing").dispatchEvent("click");
    await sponsorPage.waitForTimeout(500);
    await sponsorPage.locator("#pricing-chatsponsor-btn").click();
    await sponsorPage.waitForTimeout(300);
    await sponsorPage.locator("#chatsponsor-room-select").selectOption({ label: `${TOWN_1} Chat` });
    await sponsorPage.locator("#chatsponsor-company-name").fill("Test Sponsor Co");
    await sponsorPage.locator("#chatsponsor-months").fill("3");

    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    await sponsorPage.setInputFiles("#chatsponsor-logo-input", { name: "logo.png", mimeType: "image/png", buffer: tinyPng });
    await sponsorPage.waitForTimeout(1000);
    await sponsorPage.locator("#chatsponsor-email").fill("billing@testsponsor.com");
    await sponsorPage.locator("#chatsponsor-policy-check").check();
    await sponsorPage.locator("#chatsponsor-form button[type=submit]").click();
    await sponsorPage.waitForTimeout(1500);

    const sponsorDoc = await admin.firestore().collection("chatSponsors").doc(TOWN_1_ROOM_ID).get();
    expect(sponsorDoc.exists).toBe(true);
    expect(sponsorDoc.data().status).toBe("pending");
    expect(sponsorDoc.data().companyName).toBe("Test Sponsor Co");

    // Admin approves.
    const adminPage = await (await browser.newContext()).newPage();
    await signUp(adminPage, adminEmail);
    await adminPage.waitForTimeout(1000);
    const adminUid = await verifyEmailByAddress(adminEmail);
    await waitForRealSignupDoc(adminUid);
    await admin.firestore().collection("admins").doc(adminUid).set({ createdAt: admin.firestore.Timestamp.now() });
    await approve(adminUid, "Test Admin");
    await adminPage.evaluate(() => sessionStorage.setItem("adminPinVerified", "true"));
    await adminPage.reload();
    await adminPage.waitForTimeout(1500);
    await adminPage.locator("#nav-admin").dispatchEvent("click");
    await adminPage.waitForTimeout(1200);

    const approveBtn = adminPage.locator('#admin-chatsponsor-queue [data-action="approve"]').first();
    await expect(approveBtn).toBeVisible({ timeout: 10000 });
    await approveBtn.click();
    await adminPage.waitForTimeout(1500);

    const approvedDoc = await admin.firestore().collection("chatSponsors").doc(TOWN_1_ROOM_ID).get();
    expect(approvedDoc.data().status).toBe("approved");
    expect(approvedDoc.data().expiresAt).toBeTruthy();

    // A different viewer sees the banner.
    const viewerPage = await (await browser.newContext()).newPage();
    await signUp(viewerPage, viewerEmail);
    await viewerPage.waitForTimeout(1000);
    const viewerUid = await verifyEmailByAddress(viewerEmail);
    await waitForRealSignupDoc(viewerUid);
    await approve(viewerUid, "Viewer Person");
    await viewerPage.reload();
    await viewerPage.waitForTimeout(1500);
    await viewerPage.locator("#nav-chatrooms").dispatchEvent("click");
    await viewerPage.waitForTimeout(1000);
    await viewerPage.getByText(`${TOWN_1} Chat`, { exact: true }).click();
    await viewerPage.waitForTimeout(1000);

    const banner = viewerPage.locator("#chatroom-sponsor-banner.has-sponsor");
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText("Test Sponsor Co");
  });

  test("a rejected room's slot can be claimed by a different company", async ({ browser }) => {
    // Seed the room as already-rejected from someone else, then verify a
    // fresh submitter can take it — this exercises the update-not-create
    // branch in firestore.rules directly.
    await admin.firestore().collection("chatSponsors").doc(TOWN_2_ROOM_ID).set({
      roomId: TOWN_2_ROOM_ID, roomName: `${TOWN_2} Chat`,
      submittedByUid: "someone-else", companyName: "Rejected LLC",
      status: "rejected", rejectedAt: admin.firestore.Timestamp.now(),
    });

    const email = "resubmit." + Date.now() + "@test.town";
    const { chromium } = require("playwright");
    const browser2 = await chromium.launch();
    const page = await browser2.newPage();
    await signUp(page, email);
    await page.waitForTimeout(1000);
    const uid = await verifyEmailByAddress(email);
    await waitForRealSignupDoc(uid);
    await approve(uid, "New Claimant");
    await page.reload();
    await page.waitForTimeout(1500);

    await page.locator("#nav-pricing").dispatchEvent("click");
    await page.waitForTimeout(500);
    await page.locator("#pricing-chatsponsor-btn").click();
    await page.waitForTimeout(300);
    await page.locator("#chatsponsor-room-select").selectOption({ label: `${TOWN_2} Chat` });
    await page.locator("#chatsponsor-company-name").fill("New Claimant Co");
    await page.locator("#chatsponsor-months").fill("1");
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    await page.setInputFiles("#chatsponsor-logo-input", { name: "logo.png", mimeType: "image/png", buffer: tinyPng });
    await page.waitForTimeout(1000);
    await page.locator("#chatsponsor-email").fill("x@newclaimant.com");
    await page.locator("#chatsponsor-policy-check").check();
    await page.locator("#chatsponsor-form button[type=submit]").click();
    await page.waitForTimeout(1500);

    const msg = await page.locator("#chatsponsor-modal-message").textContent();
    expect(msg).toContain("Submitted");

    const doc = await admin.firestore().collection("chatSponsors").doc(TOWN_2_ROOM_ID).get();
    expect(doc.data().status).toBe("pending");
    expect(doc.data().companyName).toBe("New Claimant Co");

    await browser2.close();
  });
});

test.describe("Town Founder", () => {
  test("admin grant sets the badge, extends Diamond, and queues the business promo", async ({ browser }) => {
    const adminEmail = "founderadmin." + Date.now() + "@test.town";
    const targetEmail = "founder." + Date.now() + "@test.town";

    const adminPage = await (await browser.newContext()).newPage();
    await signUp(adminPage, adminEmail);
    await adminPage.waitForTimeout(1000);
    const adminUid = await verifyEmailByAddress(adminEmail);
    await waitForRealSignupDoc(adminUid);
    await admin.firestore().collection("admins").doc(adminUid).set({ createdAt: admin.firestore.Timestamp.now() });
    await approve(adminUid, "Founder Admin");

    const targetPage = await (await browser.newContext()).newPage();
    await signUp(targetPage, targetEmail);
    await targetPage.waitForTimeout(1000);
    const targetUid = await verifyEmailByAddress(targetEmail);
    const targetRealDoc = await waitForRealSignupDoc(targetUid);
    expect(targetRealDoc.email).toBe(targetEmail.toLowerCase());
    await approve(targetUid, "Founder Candidate");

    await adminPage.evaluate(() => sessionStorage.setItem("adminPinVerified", "true"));
    await adminPage.reload();
    await adminPage.waitForTimeout(1500);
    await adminPage.locator("#nav-feed").dispatchEvent("click");
    await adminPage.waitForTimeout(1500);

    const targetCard = adminPage.locator(".top-profile-card", { hasText: "Founder Candidate" });
    await expect(targetCard).toBeVisible({ timeout: 10000 });

    adminPage.on("dialog", async (dialog) => {
      if (dialog.type() === "prompt") await dialog.accept("Testville");
      else await dialog.accept();
    });

    await targetCard.click();
    await adminPage.waitForTimeout(500);
    const grantBtn = adminPage.locator(`.admin-found-town-btn[data-uid="${targetUid}"]`);
    await expect(grantBtn).toBeVisible();
    await grantBtn.click();
    await adminPage.waitForTimeout(1500);

    const targetDoc = await admin.firestore().collection("users").doc(targetUid).get();
    expect(targetDoc.data().townFounderOf).toBe("Testville");
    expect(targetDoc.data().isDiamondMember).toBe(true);
    expect(targetDoc.data().diamondExpiresAt).toBeTruthy();

    const promoDoc = await admin.firestore().collection("businessPromoWhitelist").doc(targetEmail.toLowerCase()).get();
    expect(promoDoc.exists).toBe(true);

    // Badge renders on a fresh view (the already-open card is a
    // point-in-time snapshot and won't live-update).
    await adminPage.locator("#nav-feed").dispatchEvent("click");
    await adminPage.waitForTimeout(1000);
    await adminPage.locator(".top-profile-card", { hasText: "Founder Candidate" }).click();
    await adminPage.waitForTimeout(800);
    const badges = await adminPage.locator("#profile-detail .membership-badge").allTextContents();
    expect(badges.join(" ")).toContain("President of Testville");
    expect(badges.join(" ")).toContain("Diamond Member");
  });
});
