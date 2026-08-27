// outreachAuthHelper.js
//
// Same mechanism as googleAuthHelper.js (real Google Sign-In against the
// Auth emulator's own mock popup, no real Google account needed) but for
// the outreach-admin tool's own selectors — it has no signup/confirm-
// modal flow like the main game app does (it's an internal admin tool,
// not a public signup surface), so this is simpler: sign in, done.
async function signInOutreachAdmin(page, { email, displayName, baseURL = "http://127.0.0.1:5050" }) {
  await page.goto(`${baseURL}/index.html`);
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.locator("#sign-in-btn").click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");

  const existingAccount = popup.locator(`li.mdc-list-item:has-text("${email}")`);
  if (await existingAccount.isVisible().catch(() => false)) {
    await existingAccount.click();
  } else {
    const addAccountBtn = popup.locator("#add-account-button");
    if (await addAccountBtn.isVisible().catch(() => false)) {
      await addAccountBtn.click();
    }
    await popup.locator("#email-input").fill(email);
    await popup.locator("#display-name-input").fill(displayName || "Test Admin");
    await popup.locator("#sign-in").click();
  }
  await popup.waitForEvent("close", { timeout: 15_000 }).catch(() => {});
}

module.exports = { signInOutreachAdmin };
