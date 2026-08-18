// auth.js
//
// OAuth2 helper for titanbusinesspros@gmail.com. Used ONLY by leads.js
// (read inbox, later, for reply-detection in v2) and draft.js (create
// Gmail Drafts). Deliberately does NOT request gmail.send — v1 never
// sends automatically from Node; the timed sending is handled separately
// by the Apps Script trigger described in outreach/README.md, which runs
// as the account owner and needs no OAuth token at all.
//
// One-time setup (see outreach/README.md for the full walkthrough):
//   1. Create a Google Cloud project, enable the Gmail API and Calendar
//      API, create an OAuth 2.0 Client ID (Desktop app type), download
//      the JSON and save it as outreach/credentials.json (gitignored).
//   2. Run `node outreach/authorize.js` once — it prints a consent URL,
//      you approve as titanbusinesspros@gmail.com, paste the code back,
//      and it saves outreach/token.json (gitignored). Every script below
//      reuses that token (and auto-refreshes it) after that.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// calendar.events is requested now even though v1's code doesn't use it
// yet, so the user doesn't have to redo the consent screen when v2 adds
// demo-scheduling — see the plan's Step 1.2.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
];

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing ${CREDENTIALS_PATH} — download the OAuth client JSON from Google Cloud Console ` +
        `(APIs & Services > Credentials) and save it there. See outreach/README.md Step 1.2.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  return raw.installed || raw.web;
}

function buildOAuthClient() {
  const { client_id, client_secret, redirect_uris } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// Used by authorize.js only, to run the one-time consent flow.
function getAuthUrl(oAuth2Client) {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent", // forces a refresh_token even on repeat authorizations
    scope: SCOPES,
  });
}

// Used by every other script — throws a clear error pointing at
// authorize.js if the one-time setup hasn't been done yet.
function getAuthorizedClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Missing ${TOKEN_PATH} — run \`node outreach/authorize.js\` once first (see outreach/README.md).`);
  }
  const oAuth2Client = buildOAuthClient();
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  oAuth2Client.setCredentials(token);
  // googleapis auto-refreshes the access token using the stored
  // refresh_token as needed; persist any refreshed token back to disk so
  // a long-lived refresh_token isn't lost on rotation.
  oAuth2Client.on("tokens", (newTokens) => {
    const merged = { ...token, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return oAuth2Client;
}

module.exports = { buildOAuthClient, getAuthUrl, getAuthorizedClient, TOKEN_PATH, SCOPES };
