// stripe-webhook.spec.js
//
// Functional coverage for exports.stripeWebhook (index.js) — the one
// Cloud Function with genuinely zero test coverage anywhere in the repo
// before this, since it's not reachable through any UI: Stripe calls it
// directly, server-to-server, with an HMAC-signed raw body.
//
// This uses Playwright's API-testing `request` fixture (no browser page
// involved at all) to POST directly at the Functions emulator's local
// HTTP endpoint for stripeWebhook, with a payload signed the same way
// Stripe itself would sign it — using the SAME webhook secret value the
// running emulator already loaded from the repo's own .secret.local
// (never hardcoded here; read fresh from disk so this file never contains
// a real secret value).
//
// Requires `firebase emulators:start` running in another terminal.
// Run with: npx playwright test stripe-webhook.spec.js

const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const { test, expect } = require("@playwright/test");
const { admin } = require("../emulatorAdmin");

const PROJECT_ID = process.env.TEST_PROJECT_ID || "town-talk-87ff7";
const FUNCTION_URL = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1/stripeWebhook`;

// .secret.local lives at the repo root (testing/tests/.. .. = repo root),
// same file `firebase emulators:start` itself loads secrets from — see
// firebase.json / the functions emulator's own docs on local secret
// overrides. Never committed (repo-root .gitignore), so this only works
// with that file present locally or written fresh by CI (see
// .github/workflows/ci.yml's "Write .secret.local" steps).
function loadSecretLocal() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "..", ".secret.local"), "utf8");
  const map = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
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

// Only used locally to compute a valid HMAC signature — never makes a
// real network call to Stripe, so a dummy API key is fine here.
const stripeForSigning = new Stripe("sk_test_dummy_key_used_only_to_sign_locally");

test.describe("Stripe webhook — signature verification and grant logic", () => {
  let webhookSecret;

  test.beforeAll(() => {
    const secrets = loadSecretLocal();
    webhookSecret = secrets.STRIPE_WEBHOOK_SECRET_1;
    if (!webhookSecret) {
      throw new Error(
        "STRIPE_WEBHOOK_SECRET_1 missing from .secret.local — the running emulator " +
        "and this test both need the same value to agree on a valid signature."
      );
    }
  });

  test("checkout.session.completed with a valid signature grants Gold membership", async ({ request }) => {
    const uid = `stripewebhook.gold.${Date.now()}`;
    await admin.firestore().collection("users").doc(uid).set({
      approved: true,
      isGoldMember: false,
      profile: { name: "Stripe Webhook Test User" },
    });

    const event = {
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          client_reference_id: `gold_${uid}_${PROJECT_ID}`,
          customer: null,
          subscription: null,
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    const response = await request.post(FUNCTION_URL, {
      data: payload,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
    expect(response.status()).toBe(200);

    const userDoc = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("users").doc(uid).get();
      return snap.data()?.isGoldMember ? snap.data() : null;
    });
    expect(userDoc.isGoldMember).toBe(true);
    expect(userDoc.goldExpiresAt).toBeTruthy();
    // Roughly one year out — not asserting an exact millisecond, just that
    // it's a real future expiry in the right ballpark (ONE_YEAR_MS).
    const msUntilExpiry = userDoc.goldExpiresAt.toMillis() - Date.now();
    expect(msUntilExpiry).toBeGreaterThan(300 * 24 * 60 * 60 * 1000);
    expect(msUntilExpiry).toBeLessThan(400 * 24 * 60 * 60 * 1000);
  });

  test("checkout.session.completed with a business ref grants a paid year to that business", async ({ request }) => {
    const uid = `stripewebhook.biz.${Date.now()}`;
    await admin.firestore().collection("businesses").doc(uid).set({
      approved: true,
      businessPaidUntil: admin.firestore.Timestamp.fromMillis(0),
      companyName: "Stripe Webhook Test Business",
    });

    const event = {
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      data: { object: { object: "checkout.session", client_reference_id: `business_${uid}_${PROJECT_ID}` } },
    };
    const payload = JSON.stringify(event);
    const signature = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    const response = await request.post(FUNCTION_URL, {
      data: payload,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
    expect(response.status()).toBe(200);

    const bizDoc = await waitForCondition(async () => {
      const snap = await admin.firestore().collection("businesses").doc(uid).get();
      const data = snap.data();
      return data?.businessPaidUntil?.toMillis() > 0 ? data : null;
    });
    expect(bizDoc.businessPaidUntil.toMillis()).toBeGreaterThan(Date.now());
  });

  test("An invalid/forged signature is rejected with 400 and grants nothing", async ({ request }) => {
    const uid = `stripewebhook.forged.${Date.now()}`;
    await admin.firestore().collection("users").doc(uid).set({
      approved: true,
      isGoldMember: false,
      profile: { name: "Stripe Webhook Forged-Signature Test User" },
    });

    const event = {
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      data: { object: { object: "checkout.session", client_reference_id: `gold_${uid}_${PROJECT_ID}` } },
    };
    const payload = JSON.stringify(event);

    const response = await request.post(FUNCTION_URL, {
      data: payload,
      headers: {
        "content-type": "application/json",
        // Well-formed header shape, but signed with the wrong secret —
        // constructEvent() must reject this the same way it would reject
        // a genuinely forged request.
        "stripe-signature": stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong_secret" }),
      },
    });
    expect(response.status()).toBe(400);

    // Give the (correctly-rejected) request a moment to have possibly
    // done any damage, then confirm it didn't.
    await new Promise((r) => setTimeout(r, 1500));
    const snap = await admin.firestore().collection("users").doc(uid).get();
    expect(snap.data().isGoldMember).toBe(false);
  });

  test("checkout.session.completed for a DIFFERENT edition's client_reference_id is ignored, not applied here", async ({ request }) => {
    const uid = `stripewebhook.otheredition.${Date.now()}`;
    await admin.firestore().collection("users").doc(uid).set({
      approved: true,
      isGoldMember: false,
      profile: { name: "Stripe Webhook Cross-Edition Test User" },
    });

    const event = {
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      // Same webhook, but the purchase was tagged for a different edition's
      // Firebase project — this project's copy of the function must no-op.
      data: { object: { object: "checkout.session", client_reference_id: `gold_${uid}_eufaula-lake` } },
    };
    const payload = JSON.stringify(event);
    const signature = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    const response = await request.post(FUNCTION_URL, {
      data: payload,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
    expect(response.status()).toBe(200); // acknowledged, but ignored — see the function's own comment

    await new Promise((r) => setTimeout(r, 1500));
    const snap = await admin.firestore().collection("users").doc(uid).get();
    expect(snap.data().isGoldMember).toBe(false);
  });
});
