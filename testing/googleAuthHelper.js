// googleAuthHelper.js
//
// Browser-side helper for driving REAL Google Sign-In against the Auth
// emulator's own mock Google popup — no real Google account needed. This
// replaces the old email/password signUp() duplicated across every spec
// file, which broke completely when email/password sign-up was removed
// from the app 2026-08-12 (Google Sign-In is now the ONLY way to create a
// new account — see index.html's google-signin-btn comment).
//
// The Auth emulator's popup always opens as a real new browser page —
// Playwright sees it via the browser CONTEXT's "page" event, not the
// original page. Selectors below (#add-account-button, #email-input,
// #display-name-input, #sign-in) come from actually running the flow
// against a live emulator and inspecting the popup's real DOM, not from
// Firebase's docs — the emulator's own UI isn't officially guaranteed
// stable across firebase-tools versions, so if this ever breaks on a
// tooling upgrade, re-run testing/probe-google-signin.js-style inspection
// rather than guessing.

// Completes signInWithPopup + (for a brand-new account) the app's own
// age/terms confirm modal — the email/password Sign Up form used to
// collect this same confirmation; Google's own popup has no room for it,
// so index.html gates it behind google-confirm-modal-backdrop instead.
// `email` should be unique per test run (e.g. include Date.now()) so the
// Auth emulator always treats it as a new account — reusing an email logs
// back into whatever account already has it instead, and this helper
// won't see the confirm modal at all in that case.
async function signUpWithGoogle(page, { email, displayName }) {
  await page.goto("/index.html");
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.locator("#google-signin-btn").click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");

  // "Add new account" only shows once the emulator already has at least
  // one Google account on file (e.g. an earlier test in the same run) —
  // a completely fresh emulator goes straight to the add-account form
  // instead, so this is conditional rather than always-click.
  const addAccountBtn = popup.locator("#add-account-button");
  if (await addAccountBtn.isVisible().catch(() => false)) {
    await addAccountBtn.click();
  }
  await popup.locator("#email-input").fill(email);
  // Optional in the emulator's own form, and never actually reaches the
  // app's profile (index.html deliberately never pre-fills profile.name
  // from cred.user.displayName — see its own comment on that) — a generic
  // default is fine everywhere this helper is called from.
  await popup.locator("#display-name-input").fill(displayName || "Test Robot");
  await popup.locator("#sign-in").click();
  // The emulator popup closes itself once it's relayed the result back to
  // the opener. Don't hard-fail if it doesn't within this window — the
  // confirm-modal wait right below is the real signal that actually
  // matters for a new account.
  await popup.waitForEvent("close", { timeout: 15_000 }).catch(() => {});

  await page.locator("#google-confirm-modal-backdrop").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("#google-confirm-age").check();
  await page.locator("#google-confirm-terms").check();
  await page.locator("#google-confirm-continue-btn").click();
  await page.locator("#google-confirm-modal-backdrop").waitFor({ state: "hidden" });
}

// For a RETURNING account (already created earlier in the same test run)
// — no confirm modal, onAuthStateChanged's existing watchUserDoc() just
// picks the session back up. Same popup mechanics as signUpWithGoogle,
// reusing the same email so the emulator resolves it to the same account.
//
// skipNavigation: true stays on the page's CURRENT url/state instead of
// the usual page.goto("/index.html") first — needed by at least one real
// regression test (a stale ?action=logout query param used to re-trigger
// itself on the next same-page login attempt; that test proves the fix
// by logging back in WITHOUT navigating anywhere first).
async function logInWithGoogle(page, { email, displayName, skipNavigation = false }) {
  if (!skipNavigation) await page.goto("/index.html");
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.locator("#google-signin-btn").click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  // A returning account shows up as its own list item rather than behind
  // "Add new account" — click it by its email if present, otherwise fall
  // back to the add-account form (covers a fresh emulator with no prior
  // account list entry yet, e.g. a suite that logs in without ever having
  // signed up in-process).
  const existingAccount = popup.locator(`li.mdc-list-item:has-text("${email}")`);
  if (await existingAccount.isVisible().catch(() => false)) {
    await existingAccount.click();
    return;
  }
  const addAccountBtn = popup.locator("#add-account-button");
  if (await addAccountBtn.isVisible().catch(() => false)) {
    await addAccountBtn.click();
  }
  await popup.locator("#email-input").fill(email);
  // Optional in the emulator's own form, and never actually reaches the
  // app's profile (index.html deliberately never pre-fills profile.name
  // from cred.user.displayName — see its own comment on that) — a generic
  // default is fine everywhere this helper is called from.
  await popup.locator("#display-name-input").fill(displayName || "Test Robot");
  await popup.locator("#sign-in").click();
  await popup.waitForEvent("close", { timeout: 15_000 }).catch(() => {});
}

module.exports = { signUpWithGoogle, logInWithGoogle };
