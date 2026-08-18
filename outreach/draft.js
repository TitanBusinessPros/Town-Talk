// draft.js
//
// Turns outreach/todays-drafts.json (an array of {to, subject, body} —
// written by Claude each morning, only for the leads.js candidates you
// actually approved; no LLM API call happens in this file, keeping the
// whole thing $0) into real Gmail Drafts in titanbusinesspros@gmail.com,
// sent From info@titanbusinesspros.com (works once Send-As is verified —
// see README.md Step 1.1).
//
// This is also the point where someone actually gets marked "contacted"
// in sent-log.json — deliberately not leads.js, which only ever proposes
// candidates. See sentLog.js's comment for the full reasoning: you get to
// drop a candidate before this point with zero record of them left
// behind.
//
// Ensures an "Outreach/Approved" label exists — after reviewing a draft
// in Gmail, apply that label to the ones you want sent. The Apps Script
// trigger (README.md Step 4) only ever sends drafts carrying it.
//
// Usage: node outreach/draft.js

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getAuthorizedClient } = require("./auth");
const { markContacted } = require("./sentLog");

const DRAFTS_INPUT_PATH = path.join(__dirname, "todays-drafts.json");
const FROM_ADDRESS = "info@titanbusinesspros.com";
const APPROVED_LABEL = "Outreach/Approved";

function buildRawMessage({ to, subject, body }) {
  const headers = [`From: Titan Business Pros <${FROM_ADDRESS}>`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8"].join(
    "\r\n"
  );
  const message = `${headers}\r\n\r\n${body}`;
  return Buffer.from(message).toString("base64url");
}

async function ensureApprovedLabel(gmail) {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = data.labels?.find((l) => l.name === APPROVED_LABEL);
  if (existing) return existing.id;
  const { data: created } = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: APPROVED_LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  console.log(`Created Gmail label "${APPROVED_LABEL}" — apply it to a draft in Gmail once you're ready to send it.`);
  return created.id;
}

async function main() {
  if (!fs.existsSync(DRAFTS_INPUT_PATH)) {
    throw new Error(`Missing ${DRAFTS_INPUT_PATH} — compose today's {to,subject,body} entries there first (see README.md's daily workflow).`);
  }
  const drafts = JSON.parse(fs.readFileSync(DRAFTS_INPUT_PATH, "utf8"));
  if (!Array.isArray(drafts) || drafts.length === 0) {
    console.log("No drafts to create — todays-drafts.json is empty.");
    return;
  }

  const auth = getAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });
  await ensureApprovedLabel(gmail); // just makes sure it exists / prints the reminder

  for (const entry of drafts) {
    if (!entry.to || !entry.subject || !entry.body) {
      console.warn("Skipping malformed entry (needs to/subject/body):", entry);
      continue;
    }
    const raw = buildRawMessage(entry);
    await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    markContacted(entry.to, "drafted");
    console.log(`Draft created for ${entry.to}`);
  }

  console.log(`\nDone — ${drafts.length} draft(s) created in Gmail. Review them, then apply the "${APPROVED_LABEL}" label to the ones you want sent.`);
}

main().catch((err) => {
  console.error("draft.js failed:", err.message);
  process.exit(1);
});
