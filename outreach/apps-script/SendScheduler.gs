/**
 * SendScheduler.gs
 *
 * Reference copy of the Apps Script that actually sends the day's
 * approved outreach drafts. This file is NOT deployed automatically —
 * Apps Script projects live at script.google.com, not in this repo. Copy
 * this into a new script bound to titanbusinesspros@gmail.com (see
 * outreach/README.md) and keep this file in sync if you edit it there,
 * so there's always a tracked backup of the logic.
 *
 * ARCHITECTURE CHANGE 2026-08-19: the start time is now configurable from
 * the admin webpage (Controls section) instead of fixed at 9:00 AM. Apps
 * Script's time-based triggers bake their fire time in at the moment
 * you CREATE them — a trigger literally can't read a variable each day —
 * so a single "daily at 9am" trigger can't respond to the webpage
 * changing the time. Instead, a "watcher" trigger fires every 15 minutes,
 * checks the currently configured start time from outreachStatus, and
 * kicks off the day's send-chain the first time it notices that time has
 * passed. Once a day's chain has started, it self-chains roughly every
 * 10 minutes (randomized a few minutes each time — see
 * GAP_JITTER_MINUTES — so sends don't land at a suspiciously exact,
 * bot-like clockwork interval).
 *
 * If you installed the OLD version of this script (a single fixed 9am
 * trigger), just run installWatcherTrigger() once — it cleans up the old
 * trigger automatically before installing the new one.
 */

const APPROVED_LABEL = "Outreach/Approved";
const SENT_LABEL = "Outreach/Sent"; // applied after sending, so a draft is never sent twice
const FROM_ALIAS = "info@titanbusinesspros.com"; // must already be verified under Send-As
const GAP_MINUTES = 10;
const GAP_JITTER_MINUTES = 3; // +/- this many minutes of randomness on top of GAP_MINUTES
const CHAIN_HANDLER = "sendNextApprovedDraft";
const WATCHER_HANDLER = "checkAndMaybeStart";
const WATCHER_INTERVAL_MINUTES = 15;
// Plain HTTPS endpoint (index.js's outreachStatus), no auth needed —
// returns { paused, startTime } where startTime is "HH:MM" 24-hour, Central.
const STATUS_URL = "https://us-central1-town-talk-87ff7.cloudfunctions.net/outreachStatus";
const LAST_STARTED_KEY = "outreach_last_started_date"; // Script Property, e.g. "2026-08-19"

function fetchStatus() {
  const res = UrlFetchApp.fetch(STATUS_URL, { muteHttpExceptions: true });
  return JSON.parse(res.getContentText());
}

function todayDateString() {
  // Script's own time zone (must be America/Chicago, see installWatcherTrigger)
  // is what Session.getScriptTimeZone() reflects, so this is a Central-time date.
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * Runs every 15 minutes, all day, every day. Does almost nothing on most
 * firings — only actually starts a send-chain the first time, each day,
 * that it notices the configured start time has passed.
 */
function checkAndMaybeStart() {
  const dayOfWeek = new Date().getDay(); // 0 = Sunday — hard rule, not a toggle
  if (dayOfWeek === 0) return;

  let status;
  try {
    status = fetchStatus();
  } catch (err) {
    Logger.log("checkAndMaybeStart: couldn't reach outreachStatus (" + err.message + ") — skipping this check.");
    return;
  }
  if (status.paused) return;

  const today = todayDateString();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(LAST_STARTED_KEY) === today) return; // already started today's chain

  const [startHour, startMinute] = (status.startTime || "09:00").split(":").map(Number);
  const now = new Date();
  const startTimeToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startHour, startMinute);
  if (now < startTimeToday) return; // configured time hasn't arrived yet today

  props.setProperty(LAST_STARTED_KEY, today);
  Logger.log(`Starting today's send-chain (configured start time ${status.startTime} has passed).`);
  sendNextApprovedDraft();
}

/**
 * Sends exactly one approved-and-unsent draft, then — if more are waiting
 * — schedules itself to run again roughly GAP_MINUTES later (randomized a
 * bit, see GAP_JITTER_MINUTES, so sends don't land at a suspiciously
 * mechanical exact interval — a human clicking Send doesn't do it on the
 * dot every 10 minutes, so this shouldn't look like they do either).
 * Called either by checkAndMaybeStart() (the first send of the day) or by
 * its own previous firing (every send after that).
 */
function sendNextApprovedDraft() {
  // Clear any leftover chain trigger before deciding whether to schedule
  // a new one — avoids ever having two chains running at once.
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === CHAIN_HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));

  // Re-check pause here too (not just in checkAndMaybeStart) — this is
  // what lets toggling the pause button mid-morning stop an in-progress
  // chain immediately, rather than waiting for tomorrow.
  try {
    const status = fetchStatus();
    if (status.paused) {
      Logger.log("Outreach is paused (day-off button is on) — stopping the chain here.");
      return;
    }
  } catch (err) {
    Logger.log("Couldn't reach outreachStatus (" + err.message + ") — stopping this chain as a precaution.");
    return;
  }

  const approved = GmailApp.getUserLabelByName(APPROVED_LABEL);
  if (!approved) {
    Logger.log(`Label "${APPROVED_LABEL}" doesn't exist yet — create it in Gmail first.`);
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

  if (pending.length > 1) {
    // Math.random() * 2 - 1 gives a value in [-1, 1); scaling by
    // GAP_JITTER_MINUTES spreads that across [-3, +3) minutes, so the
    // actual gap lands somewhere around 7-13 minutes, never the same
    // twice in a row.
    const jitterMs = (Math.random() * 2 - 1) * GAP_JITTER_MINUTES * 60 * 1000;
    const delayMs = GAP_MINUTES * 60 * 1000 + jitterMs;
    ScriptApp.newTrigger(CHAIN_HANDLER)
      .timeBased()
      .after(delayMs)
      .create();
    Logger.log(`Next send scheduled in ~${Math.round(delayMs / 60000)} minutes.`);
  } else {
    Logger.log("That was the last approved draft for today — chain stops here.");
  }
}

/**
 * Run this ONCE (Apps Script editor > select this function > Run) to
 * install the 15-minute watcher. Safe to re-run any time — it clears any
 * previous watcher AND any old-style fixed-9am trigger first, so it never
 * doubles up regardless of which version you had installed before.
 * IMPORTANT: also set the script's time zone to America/Chicago first
 * (gear icon > Project Settings, left sidebar) — this is what makes the
 * webpage's start-time setting mean Central time, not UTC or Pacific.
 */
function installWatcherTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === WATCHER_HANDLER || t.getHandlerFunction() === CHAIN_HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(WATCHER_HANDLER)
    .timeBased()
    .everyMinutes(WATCHER_INTERVAL_MINUTES)
    .create();

  Logger.log(
    `Watcher installed: checks every ${WATCHER_INTERVAL_MINUTES} minutes whether today's configured start ` +
      `time (set on the webpage, defaults to 09:00) has passed, and starts the send-chain the first time it ` +
      `has each day. Because it only checks every ${WATCHER_INTERVAL_MINUTES} minutes, the actual first send ` +
      `of the day may land up to ${WATCHER_INTERVAL_MINUTES} minutes after your configured time, not the exact minute.`
  );
}
