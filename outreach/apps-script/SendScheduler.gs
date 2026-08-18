/**
 * SendScheduler.gs
 *
 * Reference copy of the Apps Script that actually sends the day's
 * approved outreach drafts. This file is NOT deployed automatically —
 * Apps Script projects live at script.google.com, not in this repo. Copy
 * this into a new script bound to titanbusinesspros@gmail.com (see
 * outreach/README.md Step 3) and keep this file in sync if you edit it
 * there, so there's always a tracked backup of the logic.
 *
 * What it does: sends one approved draft at 9:00 AM Central, then
 * reschedules itself to run again exactly 10 minutes later, and so on
 * until the day's approved queue is empty. A plain recurring
 * everyMinutes(10) trigger was considered first, but Apps Script doesn't
 * guarantee those land on exact clock boundaries (Google's own docs note
 * actual firing can drift by several minutes) — self-chaining single-shot
 * triggers give an exact 9:00 start and exact 10-minute gaps between
 * sends, which is what was actually asked for.
 */

const APPROVED_LABEL = "Outreach/Approved";
const SENT_LABEL = "Outreach/Sent"; // applied after sending, so a draft is never sent twice
const FROM_ALIAS = "info@titanbusinesspros.com"; // must already be verified under Send-As
const GAP_MINUTES = 10;
const HANDLER_NAME = "sendNextApprovedDraft";
// Plain HTTPS endpoint (index.js's outreachStatus), no auth needed — just
// a yes/no on whether the "day off" pause button is currently on.
const STATUS_URL = "https://us-central1-town-talk-87ff7.cloudfunctions.net/outreachStatus";

function sendNextApprovedDraft() {
  // Whether or not there's anything to send, clear any trigger THIS run
  // itself is currently sitting under before deciding whether to chain a
  // new one — avoids ever having two chains running at once.
  deleteOwnTriggers();

  // Hard rule, not a toggle: never send on Sunday. Script's time zone must
  // be set to America/Chicago (see installDailyStartTrigger's comment) for
  // "Sunday" here to mean Sunday in Central time, not UTC.
  const dayOfWeek = new Date().getDay(); // 0 = Sunday
  if (dayOfWeek === 0) {
    Logger.log("It's Sunday — outreach never sends on Sundays. Skipping, no chain scheduled.");
    return;
  }

  // The "day off" button on the admin page — checked fresh on every single
  // firing (not just the 9:00 AM start), so toggling it mid-morning stops
  // an in-progress chain immediately rather than waiting for tomorrow.
  try {
    const statusRes = UrlFetchApp.fetch(STATUS_URL, { muteHttpExceptions: true });
    const status = JSON.parse(statusRes.getContentText());
    if (status.paused) {
      Logger.log("Outreach is paused (day-off button is on) — skipping, no chain scheduled.");
      return;
    }
  } catch (err) {
    // If the status check itself fails (network hiccup, function down),
    // fail SAFE — don't send. A skipped morning is a much smaller problem
    // than sending real emails while we can't even confirm we're not
    // supposed to be paused.
    Logger.log("Couldn't reach outreachStatus (" + err.message + ") — skipping this run as a precaution.");
    return;
  }

  const approved = GmailApp.getUserLabelByName(APPROVED_LABEL);
  if (!approved) {
    Logger.log(`Label "${APPROVED_LABEL}" doesn't exist yet — run outreach/draft.js at least once first.`);
    return;
  }
  let sentLabel = GmailApp.getUserLabelByName(SENT_LABEL);
  if (!sentLabel) sentLabel = GmailApp.createLabel(SENT_LABEL);

  // Drafts don't carry labels directly in Apps Script's GmailApp API —
  // label lookups return Threads. A draft's thread only shows up under a
  // label once the label is applied to it via the Gmail web UI, which is
  // exactly the manual "approve" step this whole design relies on.
  const sentThreadIds = new Set(sentLabel.getThreads().map((t) => t.getId()));
  const pending = approved.getThreads().filter((t) => !sentThreadIds.has(t.getId()));

  if (pending.length === 0) {
    Logger.log("No approved-and-unsent drafts found — nothing to do, chain stops here for today.");
    return;
  }

  const thread = pending[0];
  const drafts = GmailApp.getDrafts().filter((d) => d.getMessage().getThread().getId() === thread.getId());
  if (drafts.length > 0) {
    const msg = drafts[0].getMessage();
    try {
      GmailApp.sendEmail(msg.getTo(), msg.getSubject(), msg.getPlainBody(), { from: FROM_ALIAS });
      thread.addLabel(sentLabel);
      Logger.log(`Sent to ${msg.getTo()}`);
    } catch (err) {
      Logger.log(`Failed to send to ${msg.getTo()}: ${err.message} — will still move on to the next one in ${GAP_MINUTES} minutes rather than get stuck retrying.`);
      thread.addLabel(sentLabel); // mark as handled even on failure, so a bad address doesn't jam the whole day's queue
    }
  }

  // More than 1 left after this one (pending includes the one just
  // handled) means there's a next draft to chain to.
  if (pending.length > 1) {
    ScriptApp.newTrigger(HANDLER_NAME)
      .timeBased()
      .after(GAP_MINUTES * 60 * 1000)
      .create();
  } else {
    Logger.log("That was the last approved draft for today — chain stops here.");
  }
}

function deleteOwnTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === HANDLER_NAME)
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/**
 * Run this ONCE manually (Apps Script editor > select this function >
 * Run) to install the daily 9:00 AM Central starting trigger. Re-running
 * it is safe — it clears any previous trigger for this function first, so
 * it never doubles up. IMPORTANT: also set the script's time zone to
 * America/Chicago first (Project Settings, in the Apps Script editor's
 * left sidebar) so "9:00 AM" means Central, not UTC or Pacific.
 */
function installDailyStartTrigger() {
  deleteOwnTriggers();
  ScriptApp.newTrigger(HANDLER_NAME)
    .timeBased()
    .atHour(9)
    .nearMinute(0)
    .everyDays(1)
    .create();
  Logger.log("Daily 9:00 AM Central starting trigger installed. Each morning it sends the first approved draft, then self-chains every 10 minutes until that day's approved queue is empty.");
}
