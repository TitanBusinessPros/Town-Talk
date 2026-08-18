// authorize.js
//
// Run this ONCE to grant Node/googleapis access to
// titanbusinesspros@gmail.com. Saves outreach/token.json (gitignored),
// which every other script in this folder reuses afterward.
//
// Usage: node outreach/authorize.js

const fs = require("fs");
const readline = require("readline");
const { buildOAuthClient, getAuthUrl, TOKEN_PATH } = require("./auth");

async function main() {
  const oAuth2Client = buildOAuthClient();
  const authUrl = getAuthUrl(oAuth2Client);

  console.log("1. Open this URL in a browser, sign in as titanbusinesspros@gmail.com, and approve access:\n");
  console.log(authUrl);
  console.log("\n2. Google will show you a code (or redirect to a URL with ?code=... in it — copy just the code).");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => rl.question("\nPaste the code here: ", resolve));
  rl.close();

  const { tokens } = await oAuth2Client.getToken(code.trim());
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nSaved ${TOKEN_PATH}. You're done — leads.js and draft.js will use this automatically.`);
}

main().catch((err) => {
  console.error("Authorization failed:", err.message);
  process.exit(1);
});
