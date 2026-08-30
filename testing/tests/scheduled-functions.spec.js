// scheduled-functions.spec.js
//
// Functional coverage for the 8 onSchedule (cron) Cloud Functions in
// index.js, plus onChatMessageDailyRewardQualify (a Firestore trigger with
// no UI of its own to click through). None of these are reachable through
// any page — Cloud Scheduler fires them in production.
//
// How this actually triggers each one, and why: the obvious approach —
// POST to the Functions emulator's local HTTP URL for the function name,
// or publish straight to its backing Pub/Sub emulator topic
// (firebase-schedule-<name>) — does NOT work against this firebase-tools
// version. Both were tried and confirmed broken: the HTTP URL 404s (v2
// scheduled functions aren't exposed there the way onRequest/onCall are),
// and a raw Pub/Sub publish gets accepted but then silently dropped —
// firebase-debug.log shows the emulator's own pubsub handler logging
// `FirebaseError: Unsupported trigger signature: http` and acking the
// message without ever invoking the handler. Confirmed via the emulator's
// own debug log, not assumed.
//
// What DOES work, and what this file actually uses: firebase-functions v2
// attaches the raw, undecorated handler you wrote directly onto the
// exported function as `.run` (see node_modules/firebase-functions/lib/
// v2/providers/scheduler.js — `func.run = handler`) specifically so it can
// be invoked directly for testing, bypassing Cloud Scheduler/Pub/Sub/HTTP
// entirely. This runs that in a fresh child `node` process per function
// (not in-process here) because index.js unconditionally calls
// admin.initializeApp() with no guard — requiring it in this same process,
// which already has emulatorAdmin.js's own initialized default app, would
// throw "the default Firebase app already exists" immediately. The child
// process gets the same emulator-host env vars emulatorAdmin.js sets, so
// every Firestore/Auth/Storage call inside index.js still lands on the
// exact same local emulators this file's own assertions read back from.
//
// No browser page is used anywhere in this file — every function here is
// backend-only, so this talks to the emulator suite directly via the
// Admin SDK (emulatorAdmin.js), the same technique stripe-webhook.spec.js
// uses for its own assertions.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test scheduled-functions.spec.js

const path = require("path");
const { execFile } = require("child_process");
const { test, expect } = require("@playwright/test");
const { admin } = require("../emulatorAdmin");

const PROJECT_ID = process.env.TEST_PROJECT_ID || "town-talk-87ff7";
const INDEX_JS_PATH = path.join(__dirname, "..", "..", "index.js");

function runScheduledFunction(name) {
  const script = `
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
    process.env.GCLOUD_PROJECT = ${JSON.stringify(PROJECT_ID)};
    // The real Functions Framework injects FIREBASE_CONFIG (projectId,
    // storageBucket, ...) automatically -- this standalone process has to
    // set it itself, or admin.initializeApp() inside index.js has no
    // default bucket to hand getStorage().bucket() (backupAuthAccounts
    // needs it), even though Firestore/Auth still work fine without it.
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: ${JSON.stringify(PROJECT_ID)},
      storageBucket: ${JSON.stringify(PROJECT_ID)} + ".firebasestorage.app",
    });
    const fns = require(${JSON.stringify(INDEX_JS_PATH)});
    fns.${name}.run()
      .then(() => { console.log("SCHEDULED_FN_OK"); process.exit(0); })
      .catch((err) => { console.error("SCHEDULED_FN_ERROR", err && err.stack || err); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", script],
      { cwd: path.join(__dirname, "..", ".."), timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err || !stdout.includes("SCHEDULED_FN_OK")) {
          reject(new Error(`${name}.run() failed:\n${stderr}\n${stdout}`));
        } else {
          resolve();
        }
      }
    );
  });
}

async function triggerScheduled(_request, name) {
  await expect(runScheduledFunction(name), `${name}.run() should complete without throwing`).resolves.toBeUndefined();
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

// computeNeighborOfTheWeek and dailyRewardsDraw both pick a winner by
// scanning an ENTIRE collection with no per-test scoping (no way to ask
// "only consider docs from this specific test run") — so against a
// persistent local emulator that's been re-run manually a few times
// already, leftover friendRequests/dailyRewardSponsors/liked-message docs
// from an EARLIER run of this same file are still there and can out-tally
// or out-prioritize the current run's freshly-seeded winner, making the
// result non-deterministic. In real CI each matrix job gets a completely
// fresh emulator (nothing to wipe), but this file is also meant to be
// re-run against one long-lived local emulator during normal dev — which
// every other spec's own header comment assumes is the normal workflow —
// so clear these specific collections before seeding rather than only
// working by coincidence the first time.
async function wipeCollection(query) {
  const snap = await query.get();
  if (snap.empty) return;
  const batch = admin.firestore().batch();
  snap.forEach((docSnap) => batch.delete(docSnap.ref));
  await batch.commit();
}

function centralDateString(date = new Date()) {
  // Exact same call index.js's own centralDateString() makes — duplicated
  // here rather than imported since index.js doesn't export it, but it's
  // a one-line built-in Intl call, not custom logic that could drift.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(date);
}

test.describe("Scheduled (cron) Cloud Functions", () => {
  test("refreshLeaderboardCache: ranks approved users by points, descending, top 10", async ({ request }) => {
    const stamp = Date.now();
    const hi = `sched.rlc.hi.${stamp}`;
    const mid = `sched.rlc.mid.${stamp}`;
    const zero = `sched.rlc.zero.${stamp}`;
    const unapproved = `sched.rlc.unapproved.${stamp}`;
    // Deliberately huge point values, not realistic small ones (30/15) —
    // this collection accumulates real warPoints from every other spec
    // that plays a real game (a few points per win) plus any earlier
    // manual re-run of this exact test, and the cache only keeps the top
    // 10. A value that's merely "high" can still get crowded out of the
    // top 10 over time; these can't be, by any realistic accumulation.
    await admin.firestore().collection("users").doc(hi).set({ approved: true, warPoints: 10_000_000, profile: { name: "RLC Hi" } });
    await admin.firestore().collection("users").doc(mid).set({ approved: true, warPoints: 9_999_999, profile: { name: "RLC Mid" } });
    await admin.firestore().collection("users").doc(zero).set({ approved: true, warPoints: 0, profile: { name: "RLC Zero" } });
    // Not approved — must never appear in the cache even with a huge score.
    await admin.firestore().collection("users").doc(unapproved).set({ approved: false, warPoints: 999, profile: { name: "RLC Unapproved" } });

    await triggerScheduled(request, "refreshLeaderboardCache");

    const cache = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("leaderboardCache").doc("gameRanks").get();
      const data = snap.data();
      return data?.warPoints?.includes(hi) ? data : null;
    });
    expect(cache.warPoints.indexOf(hi)).toBeLessThan(cache.warPoints.indexOf(mid));
    expect(cache.warPoints).not.toContain(zero); // 0 points is filtered out entirely
    expect(cache.warPoints).not.toContain(unapproved);

    // warPoints is the same field war-deep.spec.js's own leaderboard test
    // checks against — leaving these absurdly-high-scoring users sitting
    // around forever would permanently crowd War's real top-10 out of its
    // own top-10 the next time that spec runs against this same emulator.
    // Clean up after asserting, don't just rely on a big-enough margin.
    for (const uid of [hi, mid, zero, unapproved]) {
      await admin.firestore().collection("users").doc(uid).delete();
    }
  });

  test("computeNeighborOfTheWeek: picks the real most-friends and most-likes winners for the past week", async ({ request }) => {
    // See wipeCollection's own comment above: this collection accumulates
    // across manual re-runs against one local emulator, and this
    // function's winner-picking has no per-run scoping at all — a margin
    // that's "safe" against one earlier run just becomes the new leftover
    // that the NEXT run ties against. Clearing it is the only actually
    // reliable fix, not a bigger number.
    await wipeCollection(admin.firestore().collection("friendRequests"));
    await wipeCollection(admin.firestore().collection("chatRooms").doc("pauls-valley-chat").collection("messages"));

    const stamp = Date.now();
    const uidA = `sched.now.a.${stamp}`;
    const uidD = `sched.now.d.${stamp}`;
    const friends = Array.from({ length: 5 }, (_, i) => `sched.now.friend${i}.${stamp}`);
    for (const uid of [uidA, uidD, ...friends]) {
      await admin.firestore().collection("users").doc(uid).set({
        approved: true, profile: { name: uid }, isNeighborOfWeekFriends: false, isNeighborOfWeekLikes: false,
      });
    }

    const respondedAt = admin.firestore.Timestamp.fromMillis(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    for (const friendUid of friends) {
      await admin.firestore().collection("friendRequests").add({ participants: [uidA, friendUid], status: "accepted", respondedAt });
    }

    await admin.firestore().collection("chatRooms").doc("pauls-valley-chat").collection("messages").add({
      senderId: uidD, text: "Neighbor of the Week test message", likes: Array.from({ length: 10 }, (_, i) => `liker${i}.${stamp}`), sentAt: respondedAt,
    });

    await triggerScheduled(request, "computeNeighborOfTheWeek");

    const winnerA = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("users").doc(uidA).get();
      return snap.data()?.isNeighborOfWeekFriends ? snap.data() : null;
    });
    expect(winnerA.isNeighborOfWeekFriends).toBe(true);

    const winnerD = (await admin.firestore().collection("users").doc(uidD).get()).data();
    expect(winnerD.isNeighborOfWeekLikes).toBe(true);

    // Each of uidA's 5 friends only gained 1 friend-add this week (from
    // uidA) — none of them should be crowned themselves.
    const loserFriend = (await admin.firestore().collection("users").doc(friends[0]).get()).data();
    expect(loserFriend.isNeighborOfWeekFriends).toBe(false);
  });

  test("expireBusinessListings: unapproves a business past its paid year, leaves a still-current one alone", async ({ request }) => {
    const stamp = Date.now();
    const expired = `sched.ebl.expired.${stamp}`;
    const current = `sched.ebl.current.${stamp}`;
    await admin.firestore().collection("businesses").doc(expired).set({
      approved: true, businessPaidUntil: admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000), companyName: "Expired Biz",
    });
    await admin.firestore().collection("businesses").doc(current).set({
      approved: true, businessPaidUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000), companyName: "Current Biz",
    });

    await triggerScheduled(request, "expireBusinessListings");

    const expiredDoc = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("businesses").doc(expired).get();
      return snap.data()?.approved === false ? snap.data() : null;
    });
    expect(expiredDoc.approved).toBe(false);

    const currentDoc = (await admin.firestore().collection("businesses").doc(current).get()).data();
    expect(currentDoc.approved).toBe(true); // untouched
  });

  test("expireMemberships: clears expired Gold/Diamond flags, but never for an admin", async ({ request }) => {
    const stamp = Date.now();
    const expiredGold = `sched.em.gold.${stamp}`;
    const expiredDiamond = `sched.em.diamond.${stamp}`;
    const adminUid = `sched.em.admin.${stamp}`;
    const pastMs = admin.firestore.Timestamp.fromMillis(Date.now() - 1000);

    await admin.firestore().collection("users").doc(expiredGold).set({ isGoldMember: true, goldExpiresAt: pastMs, profile: { name: "EM Gold" } });
    await admin.firestore().collection("users").doc(expiredDiamond).set({ isDiamondMember: true, diamondExpiresAt: pastMs, profile: { name: "EM Diamond" } });
    await admin.firestore().collection("users").doc(adminUid).set({ isGoldMember: true, goldExpiresAt: pastMs, isDiamondMember: true, diamondExpiresAt: pastMs, profile: { name: "EM Admin" } });
    await admin.firestore().collection("admins").doc(adminUid).set({ addedAt: admin.firestore.Timestamp.now() });

    await triggerScheduled(request, "expireMemberships");

    const goldAfter = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("users").doc(expiredGold).get();
      return snap.data()?.isGoldMember === false ? snap.data() : null;
    });
    expect(goldAfter.isGoldMember).toBe(false);

    const diamondAfter = (await admin.firestore().collection("users").doc(expiredDiamond).get()).data();
    expect(diamondAfter.isDiamondMember).toBe(false);

    // The admin exclusion — this is the whole reason expireMemberships reads
    // the admins collection at all (see its own comment in index.js).
    const adminAfter = (await admin.firestore().collection("users").doc(adminUid).get()).data();
    expect(adminAfter.isGoldMember).toBe(true);
    expect(adminAfter.isDiamondMember).toBe(true);
  });

  test("dailyRewardsDraw: a fully-qualified opted-in user wins today's active sponsor giveaway", async ({ request }) => {
    // Same reasoning as computeNeighborOfTheWeek above: a leftover
    // "published", still-in-date-range sponsor from an earlier manual run
    // of this test is indistinguishable from a real one to the function,
    // and gets its own winner slot alongside this run's sponsor — which is
    // how a PRIOR run's winnerUid can end up in this run's dailyRewardWinners
    // query instead of the one just seeded. Clear old test sponsors and any
    // earlier run's winner-candidate user docs (scoped by uid prefix, not a
    // blanket users wipe) before seeding fresh.
    await wipeCollection(admin.firestore().collection("dailyRewardSponsors"));
    await wipeCollection(
      admin.firestore().collection("users")
        .where(admin.firestore.FieldPath.documentId(), ">=", "sched.drd.")
        .where(admin.firestore.FieldPath.documentId(), "<", "sched.drd.")
    );

    const stamp = Date.now();
    const winnerUid = `sched.drd.winner.${stamp}`;
    const today = centralDateString();
    const now = admin.firestore.Timestamp.now();

    await admin.firestore().collection("users").doc(winnerUid).set({
      approved: true,
      profile: { name: "DRD Winner" },
      dailyRewards: {
        optedIn: true,
        gamePlayedDate: today,
        chatMessageDate: today,
        shareClickDate: today,
        // lastWonAt intentionally absent — never won before, so the 7-day cooldown doesn't exclude them.
      },
    });

    const sponsorRef = await admin.firestore().collection("dailyRewardSponsors").add({
      status: "published",
      companyName: "Scheduled-Function Test Sponsor",
      prizeDescription: "A free test prize",
      maxWinnersPerDay: 1,
      startDate: admin.firestore.Timestamp.fromMillis(now.toMillis() - 24 * 60 * 60 * 1000),
      endDate: admin.firestore.Timestamp.fromMillis(now.toMillis() + 24 * 60 * 60 * 1000),
      quantityAwarded: 0,
    });

    await triggerScheduled(request, "dailyRewardsDraw");

    const winSnap = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("dailyRewardWinners").where("uid", "==", winnerUid).limit(1).get();
      return snap.empty ? null : snap.docs[0];
    });
    const win = winSnap.data();
    expect(win.sponsorId).toBe(sponsorRef.id);
    expect(win.couponCode).toMatch(/^[A-Z0-9]{5}$/);
    expect(win.redeemed).toBe(false);

    const userAfter = (await admin.firestore().collection("users").doc(winnerUid).get()).data();
    expect(userAfter.dailyRewards.lastWonAt).toBeTruthy();

    const sponsorAfter = (await sponsorRef.get()).data();
    expect(sponsorAfter.quantityAwarded).toBe(1);

    const publicToday = (await admin.firestore().collection("dailyRewardsPublicToday").doc("current").get()).data();
    expect(publicToday.date).toBe(today);
    expect(publicToday.winners.some((w) => w.sponsorName === "Scheduled-Function Test Sponsor")).toBe(true);
  });

  test("dailyRewardsDraw: a single draw hands out exactly maxWinnersPerDay winners, not more or fewer", async ({ request }) => {
    // Same leftover-sponsor contamination risk as the test above -- a
    // stale "published", still-in-date-range sponsor from an earlier run
    // can steal slots from THIS test's own qualifying candidates, via the
    // shared usedUids set inside dailyRewardsDraw (sponsors are processed
    // one at a time in query order, and once a candidate is claimed by one
    // sponsor's slot, no other sponsor in the same run can also award
    // them). Confirmed empirically 2026-08-30: an un-wiped leftover
    // sponsor from a prior manual run pulled 1 of 10 otherwise-qualified
    // candidates into its own slot instead of this test's, producing 9/10
    // instead of 10/10 -- wipe first, same as the sibling test above.
    await wipeCollection(admin.firestore().collection("dailyRewardSponsors"));

    const stamp = Date.now();
    const today = centralDateString();
    const now = admin.firestore.Timestamp.now();
    const MAX_WINNERS = 10;

    const uids = [];
    for (let i = 0; i < MAX_WINNERS; i++) {
      const uid = `sched.drd10.${stamp}.${i}`;
      uids.push(uid);
      await admin.firestore().collection("users").doc(uid).set({
        approved: true,
        profile: { name: `Ten-Winner Test ${i}` },
        dailyRewards: {
          optedIn: true,
          gamePlayedDate: today,
          chatMessageDate: today,
          shareClickDate: today,
          // lastWonAt intentionally absent, same reasoning as the sibling test.
        },
      });
    }

    const sponsorRef = await admin.firestore().collection("dailyRewardSponsors").add({
      status: "published",
      companyName: "Ten-Winner Test Sponsor",
      prizeDescription: "A free test prize",
      maxWinnersPerDay: MAX_WINNERS,
      startDate: admin.firestore.Timestamp.fromMillis(now.toMillis() - 24 * 60 * 60 * 1000),
      endDate: admin.firestore.Timestamp.fromMillis(now.toMillis() + 24 * 60 * 60 * 1000),
      quantityAwarded: 0,
    });

    await triggerScheduled(request, "dailyRewardsDraw");

    const winSnap = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("dailyRewardWinners").where("sponsorId", "==", sponsorRef.id).get();
      return snap.size === MAX_WINNERS ? snap : null;
    });
    expect(winSnap.size).toBe(MAX_WINNERS);

    // Every winner really is one of THIS test's own seeded candidates, not
    // a leftover from elsewhere leaking in.
    const winningUids = new Set(winSnap.docs.map((d) => d.data().uid));
    for (const uid of uids) expect(winningUids.has(uid)).toBe(true);

    const sponsorAfter = (await sponsorRef.get()).data();
    expect(sponsorAfter.quantityAwarded).toBe(MAX_WINNERS);
  });

  test("backupAuthAccounts: writes a real Storage export of every Auth user for today", async ({ request }) => {
    // Make sure there's at least one real Auth account for the export to
    // actually contain (earlier specs in a full CI run already guarantee
    // this, but this test has to stand on its own too).
    const email = `sched.backup.${Date.now()}@test.town`;
    await admin.auth().createUser({ email, password: "TestPass123!" });

    await triggerScheduled(request, "backupAuthAccounts");

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = `admin-backups/auth-exports/auth-export-${dateStr}.json`;
    // emulatorAdmin.js's admin app was initialized with just a projectId
    // (no storageBucket option), unlike index.js's own FIREBASE_CONFIG-
    // driven child process above — pass the bucket name explicitly here
    // rather than touching that shared helper other specs also rely on.
    const file = admin.storage().bucket(`${PROJECT_ID}.firebasestorage.app`).file(filePath);

    const contents = await waitForCondition(async () => {
      const [exists] = await file.exists();
      if (!exists) return null;
      const [buf] = await file.download();
      return buf;
    });
    const parsed = JSON.parse(contents.toString("utf8"));
    expect(parsed.userCount).toBeGreaterThan(0);
    expect(parsed.users.some((u) => u.email === email)).toBe(true);
  });

  test("purgeExpiredDeletedProfiles: deletes both the archive doc and the real Auth account once past purgeAt", async ({ request }) => {
    const email = `sched.purge.${Date.now()}@test.town`;
    const userRecord = await admin.auth().createUser({ email, password: "TestPass123!" });
    const uid = userRecord.uid;

    await admin.firestore().collection("deletedUsers").doc(uid).set({
      purgeAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000), // already due
      deletedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 24 * 60 * 60 * 1000),
      archivedProfile: { profile: { name: "Purge Test User" } },
    });

    await triggerScheduled(request, "purgeExpiredDeletedProfiles");

    await waitForCondition(async () => {
      const snap = await admin.firestore().collection("deletedUsers").doc(uid).get();
      return snap.exists ? null : true;
    });

    await expect(admin.auth().getUser(uid)).rejects.toThrow();
  });

  test("outreachUpdateCostSnapshot: writes a fresh cost snapshot doc", async ({ request }) => {
    // Clear any prior run's doc so this test can prove a NEW write happened,
    // not just that an old one already existed.
    await admin.firestore().collection("outreachUsage").doc("costSnapshot").delete().catch(() => {});

    await triggerScheduled(request, "outreachUpdateCostSnapshot");

    const snapshot = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("outreachUsage").doc("costSnapshot").get();
      return snap.exists ? snap.data() : null;
    });
    expect(snapshot.generatedAt).toBeTruthy();
    expect(typeof snapshot.totalCostUsd).toBe("number");
    expect(Array.isArray(snapshot.services)).toBe(true);
    expect(typeof snapshot.remainingCreditUsd).toBe("number");
  });
});

test.describe("onChatMessageDailyRewardQualify (Firestore trigger, no schedule/UI)", () => {
  test("Posting a chat message stamps today's date onto the sender's dailyRewards.chatMessageDate", async () => {
    const uid = `sched.chatqualify.${Date.now()}`;
    await admin.firestore().collection("users").doc(uid).set({
      approved: true, profile: { name: "Chat Qualify Test User" }, dailyRewards: { optedIn: true },
    });

    await admin.firestore().collection("chatRooms").doc("pauls-valley-chat").collection("messages").add({
      senderId: uid,
      text: "onChatMessageDailyRewardQualify coverage test message",
      sentAt: admin.firestore.Timestamp.now(),
    });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const userAfter = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("users").doc(uid).get();
      return snap.data()?.dailyRewards?.chatMessageDate === today ? snap.data() : null;
    });
    expect(userAfter.dailyRewards.chatMessageDate).toBe(today);
  });
});
