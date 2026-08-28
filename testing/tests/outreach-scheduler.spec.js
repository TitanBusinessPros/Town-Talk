// outreach-scheduler.spec.js
//
// Functional coverage for the 6 plain-HTTP (onRequest, no Firebase Auth)
// Cloud Functions that outreach/apps-script/SendScheduler.gs calls
// directly, server-to-server, as it runs the real automated sending
// chain: outreachAgentStatus, outreachAcquireLock, outreachReleaseLock,
// outreachReportNextSend, outreachReportSchedule, outreachRecordSent.
//
// These are the highest-priority of the 22 functions found uncovered
// 2026-08-28 (see testing/function-coverage.js) -- not because they're
// complex, but because they're the mutex and bookkeeping protecting a
// live email-sending pipeline that actually contacts real Oklahoma
// businesses. A bug in the lock specifically means either two agents
// sending at once (real duplicate emails) or a stuck lock (sending
// silently stops until someone notices and manually clears it) -- there's
// no browser click that would ever surface either failure mode.
//
// No browser page anywhere in this file -- these functions have no UI of
// their own, so this drives them the exact same way SendScheduler.gs
// itself does: plain HTTP requests via Playwright's API-testing `request`
// fixture, same technique stripe-webhook.spec.js/scheduled-functions.spec.js
// use, with admin-SDK writes/reads for setup and assertions.
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test outreach-scheduler.spec.js

const { test, expect } = require("@playwright/test");
const { admin } = require("../emulatorAdmin");

const PROJECT_ID = process.env.TEST_PROJECT_ID || "town-talk-87ff7";
const REGION = "us-central1";

function functionUrl(name) {
  return `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/${name}`;
}

async function waitForCondition(fn, timeoutMs = 10_000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForCondition timed out");
}

// Real agent IDs from index.js's own OUTREACH_AGENTS map — "made-up-agent"
// deliberately isn't one of them, for the unknown-agent rejection tests.
const AGENT_A = "primary";
const AGENT_B = "secondary";

async function clearOutreachSettings() {
  // outreachSettings/config and .../lock are both singleton docs shared by
  // every test in this file (and by the real production agents, in a real
  // deploy) — reset them before each test so one test's lock/schedule
  // state can't leak into the next, the same class of bug fixed in
  // scheduled-functions.spec.js for computeNeighborOfTheWeek/dailyRewardsDraw.
  await admin.firestore().collection("outreachSettings").doc("config").set({ agents: {} });
  await admin.firestore().collection("outreachSettings").doc("lock").set({ heldBy: null, lockedAt: admin.firestore.Timestamp.now() });
}

test.describe("Outreach scheduler endpoints (SendScheduler.gs callers)", () => {
  test.beforeEach(async () => {
    await clearOutreachSettings();
  });

  test("outreachAgentStatus: unknown agent is rejected with 400", async ({ request }) => {
    const res = await request.get(functionUrl("outreachAgentStatus"), { params: { agent: "not-a-real-agent" } });
    expect(res.status()).toBe(400);
  });

  test("outreachAgentStatus: a never-configured agent returns paused:false and the default 09:00 start time", async ({ request }) => {
    const res = await request.get(functionUrl("outreachAgentStatus"), { params: { agent: AGENT_A } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ paused: false, startTime: "09:00" });
  });

  test("outreachAgentStatus: reflects a real paused flag and custom start time", async ({ request }) => {
    await admin.firestore().collection("outreachSettings").doc("config").set(
      { agents: { [AGENT_A]: { paused: true, startTime: "14:30" } } },
      { merge: true }
    );
    const res = await request.get(functionUrl("outreachAgentStatus"), { params: { agent: AGENT_A } });
    const body = await res.json();
    expect(body).toEqual({ paused: true, startTime: "14:30" });
  });

  test("outreachAcquireLock: unknown agent is rejected with 400", async ({ request }) => {
    const res = await request.post(functionUrl("outreachAcquireLock"), { params: { agent: "not-a-real-agent" } });
    expect(res.status()).toBe(400);
  });

  test("outreachAcquireLock: an unheld lock is acquired, and really persists to Firestore", async ({ request }) => {
    const res = await request.post(functionUrl("outreachAcquireLock"), { params: { agent: AGENT_A } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ acquired: true, heldBy: AGENT_A });

    const lockDoc = (await admin.firestore().collection("outreachSettings").doc("lock").get()).data();
    expect(lockDoc.heldBy).toBe(AGENT_A);
  });

  test("outreachAcquireLock: a lock genuinely held by a DIFFERENT agent (fresh) is NOT acquired", async ({ request }) => {
    await admin.firestore().collection("outreachSettings").doc("lock").set({ heldBy: AGENT_A, lockedAt: admin.firestore.Timestamp.now() });

    const res = await request.post(functionUrl("outreachAcquireLock"), { params: { agent: AGENT_B } });
    const body = await res.json();
    expect(body).toEqual({ acquired: false, heldBy: AGENT_A });

    // Must NOT have been overwritten by the failed attempt.
    const lockDoc = (await admin.firestore().collection("outreachSettings").doc("lock").get()).data();
    expect(lockDoc.heldBy).toBe(AGENT_A);
  });

  test("outreachAcquireLock: a STALE lock (>3h old) from a different agent is self-healed and claimable", async ({ request }) => {
    const fourHoursAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 4 * 60 * 60 * 1000);
    await admin.firestore().collection("outreachSettings").doc("lock").set({ heldBy: AGENT_A, lockedAt: fourHoursAgo });

    const res = await request.post(functionUrl("outreachAcquireLock"), { params: { agent: AGENT_B } });
    const body = await res.json();
    expect(body).toEqual({ acquired: true, heldBy: AGENT_B });

    const lockDoc = (await admin.firestore().collection("outreachSettings").doc("lock").get()).data();
    expect(lockDoc.heldBy).toBe(AGENT_B);
  });

  test("outreachReleaseLock: unknown agent is rejected with 400", async ({ request }) => {
    const res = await request.post(functionUrl("outreachReleaseLock"), { params: { agent: "not-a-real-agent" } });
    expect(res.status()).toBe(400);
  });

  test("outreachReleaseLock: releases a lock this agent actually holds", async ({ request }) => {
    await admin.firestore().collection("outreachSettings").doc("lock").set({ heldBy: AGENT_A, lockedAt: admin.firestore.Timestamp.now() });

    const res = await request.post(functionUrl("outreachReleaseLock"), { params: { agent: AGENT_A } });
    expect(res.status()).toBe(200);

    const lockDoc = (await admin.firestore().collection("outreachSettings").doc("lock").get()).data();
    expect(lockDoc.heldBy).toBe(null);
  });

  test("outreachReleaseLock: a late/duplicate release from an agent that DOESN'T hold the lock does nothing", async ({ request }) => {
    // AGENT_B legitimately holds it; a stale release call from AGENT_A
    // (e.g. a slow duplicate request) must not free AGENT_B's real lock.
    await admin.firestore().collection("outreachSettings").doc("lock").set({ heldBy: AGENT_B, lockedAt: admin.firestore.Timestamp.now() });

    const res = await request.post(functionUrl("outreachReleaseLock"), { params: { agent: AGENT_A } });
    expect(res.status()).toBe(200); // still reports ok:true -- it's a no-op, not an error

    const lockDoc = (await admin.firestore().collection("outreachSettings").doc("lock").get()).data();
    expect(lockDoc.heldBy).toBe(AGENT_B); // untouched
  });

  test("outreachReportNextSend: unknown agent is rejected with 400", async ({ request }) => {
    const res = await request.post(functionUrl("outreachReportNextSend"), { params: { agent: "not-a-real-agent" } });
    expect(res.status()).toBe(400);
  });

  test("outreachReportNextSend: a real nextAt timestamp is stored for the page's countdown to read", async ({ request }) => {
    const nextAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = await request.post(functionUrl("outreachReportNextSend"), { params: { agent: AGENT_A, nextAt } });
    expect(res.status()).toBe(200);

    const doc = (await admin.firestore().collection("outreachSettings").doc("config").get()).data();
    const stored = doc.agents[AGENT_A].nextSendAt;
    expect(stored.toDate().toISOString()).toBe(nextAt);
  });

  test("outreachReportNextSend: omitting nextAt clears any stale countdown", async ({ request }) => {
    await admin.firestore().collection("outreachSettings").doc("config").set(
      { agents: { [AGENT_A]: { nextSendAt: admin.firestore.Timestamp.now() } } },
      { merge: true }
    );
    const res = await request.post(functionUrl("outreachReportNextSend"), { params: { agent: AGENT_A } });
    expect(res.status()).toBe(200);

    const doc = (await admin.firestore().collection("outreachSettings").doc("config").get()).data();
    expect(doc.agents[AGENT_A].nextSendAt).toBe(null);
  });

  test("outreachReportSchedule: unknown agent is rejected with 400", async ({ request }) => {
    const res = await request.post(functionUrl("outreachReportSchedule"), { params: { agent: "not-a-real-agent" }, data: { items: [] } });
    expect(res.status()).toBe(400);
  });

  test("outreachReportSchedule: stores a per-lead estimated-send schedule, filtering out malformed entries", async ({ request }) => {
    const estimatedAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const res = await request.post(functionUrl("outreachReportSchedule"), {
      params: { agent: AGENT_A },
      data: {
        items: [
          { to: "Real.Lead@Example.com", subject: "Hello there", estimatedAt },
          { to: "missing-estimate@example.com" }, // no estimatedAt -- must be filtered out
          { subject: "no recipient at all" }, // no `to` -- must be filtered out
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, count: 1 });

    const doc = (await admin.firestore().collection("outreachSettings").doc("config").get()).data();
    const schedule = doc.agents[AGENT_A].schedule;
    expect(schedule.length).toBe(1);
    expect(schedule[0].to).toBe("real.lead@example.com"); // lowercased
    expect(schedule[0].subject).toBe("Hello there");
  });

  test("outreachRecordSent: missing agent or to is rejected with 400", async ({ request }) => {
    const missingAgent = await request.post(functionUrl("outreachRecordSent"), { params: { to: "someone@example.com" } });
    expect(missingAgent.status()).toBe(400);

    const missingTo = await request.post(functionUrl("outreachRecordSent"), { params: { agent: AGENT_A } });
    expect(missingTo.status()).toBe(400);
  });

  test("outreachRecordSent: writes a real, queryable send-confirmation event", async ({ request }) => {
    const to = `spanktest.${Date.now()}@example.com`;
    const res = await request.post(functionUrl("outreachRecordSent"), {
      params: { agent: AGENT_A, to, subject: "Test subject line", status: "sent" },
    });
    expect(res.status()).toBe(200);

    const event = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("outreachSentEvents").where("to", "==", to).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    });
    expect(event.agent).toBe(AGENT_A);
    expect(event.subject).toBe("Test subject line");
    expect(event.status).toBe("sent");
    expect(event.sentAt).toBeTruthy();
  });
});
