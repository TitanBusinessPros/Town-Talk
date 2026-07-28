// Playwright config — runs both test robots against your site as served
// locally (e.g. `firebase emulators:start` also serves your hosting files,
// or a simple local web server) while it's talking to the LOCAL EMULATORS
// instead of your real production Firebase project.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false, // the two robots need to interact with each other in a set order
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5000", // Firebase Hosting emulator's default local address
    headless: true, // set to false any time you want to WATCH the robots click around
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});