/**
 * SendScheduler.gs
 *
 * Reference copy of the Apps Script that actually sends the day's
 * approved outreach drafts. This file is NOT deployed automatically —
 * Apps Script projects live at script.google.com, not in this repo. Copy
 * this into a new script bound to the sending account (see
 * outreach/README.md) and keep this file in sync if you edit it there,
 * so there's always a tracked backup of the logic.
 *
 * MULTI-AGENT ARCHITECTURE 2026-08-19: this system can run more than one
 * sending account (e.g. titanbusinesspros@gmail.com AND
 * pollysfarmok@gmail.com), each with its OWN pause button and start time,
 * but they must never both be actively sending at once — both show the
 * same From address (info@titanbusinesspros.com), so two agents sending
 * at the same time would look like the same identity sending through two
 * different mail paths simultaneously. A shared "lock" on the backend
 * (outreachAcquireLock/outreachReleaseLock) enforces this: before
 * starting today's chain, an agent must successfully acquire the lock;
 * if another agent already holds it, this agent just waits and checks
 * again on its next 15-minute tick, for as long as it takes.
 *
 * SET AGENT_ID BELOW to match which account this specific copy of the
 * script is bound to — "primary" for titanbusinesspros@gmail.com,
 * "secondary" for pollysfarmok@gmail.com, "tertiary" for a future third
 * account, etc. This is the ONLY line that should differ between the
 * separate copies of this script pasted into each account's Apps Script
 * project — everything else is identical code.
 */

const AGENT_ID = "primary"; // <-- CHANGE THIS to "secondary" (etc.) for other accounts' copies of this script

const APPROVED_LABEL = "Outreach/Approved";
const SENT_LABEL = "Outreach/Sent"; // applied after sending, so a draft is never sent twice
const FROM_ALIAS = "info@titanbusinesspros.com"; // must already be verified under Send-As, same for every agent
const GAP_MINUTES = 10;
const GAP_JITTER_MINUTES = 3; // +/- this many minutes of randomness on top of GAP_MINUTES
const CHAIN_HANDLER = "sendNextApprovedDraft";
const WATCHER_HANDLER = "checkAndMaybeStart";
const WATCHER_INTERVAL_MINUTES = 15;
// Base URL for all three plain HTTPS endpoints in index.js — each call
// appends ?agent=AGENT_ID. No Firebase Auth token involved; these are
// deliberately unauthenticated server-to-server endpoints (see index.js's
// comments on them) since Apps Script has no way to attach a Firebase ID
// token, and none of them expose or accept anything sensitive.
const FUNCTIONS_BASE = "https://us-central1-town-talk-87ff7.cloudfunctions.net";
const LAST_STARTED_KEY = "outreach_last_started_date"; // Script Property, e.g. "2026-08-19"
const LOG_SHEET_ID_KEY = "outreach_log_sheet_id"; // Script Property — set the first time getOrCreateLogSheet() runs

// Progress tracking, one spreadsheet per agent (this account creates and
// owns its own — nothing shared with the other agent's account). Uses
// Apps Script's native SpreadsheetApp, NOT the Sheets API/OAuth route —
// deliberately, so this needed zero new Google permission grant beyond
// what installWatcherTrigger already asked for. Only logs actual SENDS
// (not draft-creation, which happens in the Cloud Function, not here) —
// "progress" in the sense of "did this really go out," the milestone
// that matters most.
function getOrCreateLogSheet() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(LOG_SHEET_ID_KEY);
  if (existingId) {
    try {
      return SpreadsheetApp.openById(existingId).getSheets()[0];
    } catch (err) {
      Logger.log(`(${AGENT_ID}) Stored log sheet id ${existingId} couldn't be opened (${err.message}) — creating a new one.`);
    }
  }
  const ss = SpreadsheetApp.create(`Town Fuss Outreach Log — ${AGENT_ID}`);
  const sheet = ss.getSheets()[0];
  sheet.appendRow(["Date/Time (Central)", "To", "Subject", "Status"]);
  sheet.setFrozenRows(1);
  props.setProperty(LOG_SHEET_ID_KEY, ss.getId());
  Logger.log(`(${AGENT_ID}) Created log sheet: ${ss.getUrl()}`);
  return sheet;
}

function logToSheet(to, subject, status) {
  try {
    const sheet = getOrCreateLogSheet();
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([timestamp, to, subject, status]);
  } catch (err) {
    // Never let a logging failure break the actual send/chain — this is
    // a record-keeping nice-to-have, not something that should be able
    // to stop real emails from going out.
    Logger.log(`(${AGENT_ID}) Couldn't log to sheet (${err.message}) — send itself was not affected.`);
  }
}

/**
 * Run this once, any time, to print the log sheet's URL to the execution
 * log without needing to send anything first — creates it if it doesn't
 * exist yet.
 */
function printLogSheetUrl() {
  const sheet = getOrCreateLogSheet();
  Logger.log(`(${AGENT_ID}) Log sheet: ${sheet.getParent().getUrl()}`);
}

function fetchJson(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return JSON.parse(res.getContentText());
}

function fetchStatus() {
  return fetchJson(`${FUNCTIONS_BASE}/outreachAgentStatus?agent=${AGENT_ID}`);
}

function tryAcquireLock() {
  return fetchJson(`${FUNCTIONS_BASE}/outreachAcquireLock?agent=${AGENT_ID}`);
}

function releaseLock() {
  try {
    fetchJson(`${FUNCTIONS_BASE}/outreachReleaseLock?agent=${AGENT_ID}`);
  } catch (err) {
    Logger.log(`releaseLock failed (${err.message}) — a stale lock older than 3 hours self-heals on the backend regardless, so this isn't fatal.`);
  }
}

function todayDateString() {
  // Script's own time zone (must be America/Chicago, see installWatcherTrigger)
  // is what Session.getScriptTimeZone() reflects, so this is a Central-time date.
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * Runs every 15 minutes, all day, every day. Does almost nothing on most
 * firings — only actually starts a send-chain the first time, each day,
 * that BOTH (a) it notices this agent's configured start time has passed,
 * AND (b) it successfully acquires the cross-agent lock. If another agent
 * currently holds the lock, this just tries again next tick — for as long
 * as it takes, there's no timeout or giving up for the day.
 */
function checkAndMaybeStart() {
  const dayOfWeek = new Date().getDay(); // 0 = Sunday — hard rule, not a toggle, applies to every agent
  if (dayOfWeek === 0) return;

  let status;
  try {
    status = fetchStatus();
  } catch (err) {
    Logger.log(`checkAndMaybeStart (${AGENT_ID}): couldn't reach outreachAgentStatus (${err.message}) — skipping this check.`);
    return;
  }
  if (status.paused) return;

  const today = todayDateString();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(LAST_STARTED_KEY) === today) return; // already started today's chain

  const [startHour, startMinute] = (status.startTime || "09:00").split(":").map(Number);
  const now = new Date();
  const startTimeToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startHour, startMinute);
  if (now < startTimeToday) return; // this agent's configured time hasn't arrived yet today

  const lockResult = tryAcquireLock();
  if (!lockResult.acquired) {
    Logger.log(`(${AGENT_ID}) Start time has passed, but agent "${lockResult.heldBy}" is currently sending — will check again in ${WATCHER_INTERVAL_MINUTES} minutes.`);
    return; // don't mark today as started — keep retrying every tick until the lock frees up
  }

  props.setProperty(LAST_STARTED_KEY, today);
  Logger.log(`(${AGENT_ID}) Starting today's send-chain (configured start time ${status.startTime} has passed, lock acquired).`);
  sendNextApprovedDraft();
}

/**
 * Sends exactly one approved-and-unsent draft, then — if more are waiting
 * — schedules itself to run again roughly GAP_MINUTES later (randomized a
 * bit, see GAP_JITTER_MINUTES, so sends don't land at a suspiciously
 * mechanical exact interval). Releases the cross-agent lock on every path
 * that means "not continuing right now" — that's what lets the next
 * eligible agent start as soon as this one is truly done, not a fixed
 * time later.
 */
function sendNextApprovedDraft() {
  // Clear any leftover chain trigger before deciding whether to schedule
  // a new one — avoids ever having two chains running at once for THIS
  // agent (separate from the cross-agent lock, which prevents two
  // different agents' chains overlapping).
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === CHAIN_HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));

  // Re-check pause here too (not just in checkAndMaybeStart) — this is
  // what lets toggling this agent's pause button mid-morning stop an
  // in-progress chain immediately, rather than waiting for tomorrow.
  let status;
  try {
    status = fetchStatus();
  } catch (err) {
    Logger.log(`(${AGENT_ID}) Couldn't reach outreachAgentStatus (${err.message}) — stopping this chain as a precaution.`);
    releaseLock();
    return;
  }
  if (status.paused) {
    Logger.log(`(${AGENT_ID}) Paused mid-chain — stopping here.`);
    releaseLock();
    return;
  }

  const approved = GmailApp.getUserLabelByName(APPROVED_LABEL);
  if (!approved) {
    Logger.log(`(${AGENT_ID}) Label "${APPROVED_LABEL}" doesn't exist yet — create it in Gmail first.`);
    releaseLock();
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
    Logger.log(`(${AGENT_ID}) No approved-and-unsent drafts found — nothing to do, chain stops here for today.`);
    releaseLock();
    return;
  }

  const thread = pending[0];
  const drafts = GmailApp.getDrafts().filter((d) => d.getMessage().getThread().getId() === thread.getId());
  if (drafts.length > 0) {
    const msg = drafts[0].getMessage();
    try {
      GmailApp.sendEmail(msg.getTo(), msg.getSubject(), msg.getPlainBody(), { from: FROM_ALIAS });
      thread.addLabel(sentLabel);
      Logger.log(`(${AGENT_ID}) Sent to ${msg.getTo()}`);
      logToSheet(msg.getTo(), msg.getSubject(), "sent");
    } catch (err) {
      Logger.log(`(${AGENT_ID}) Failed to send to ${msg.getTo()}: ${err.message} — will still move on to the next one rather than get stuck retrying.`);
      thread.addLabel(sentLabel); // mark as handled even on failure, so a bad address doesn't jam the whole day's queue
      logToSheet(msg.getTo(), msg.getSubject(), `failed: ${err.message}`);
    }
  }

  if (pending.length > 1) {
    // Math.random() * 2 - 1 gives a value in [-1, 1); scaling by
    // GAP_JITTER_MINUTES spreads that across [-3, +3) minutes, so the
    // actual gap lands somewhere around 7-13 minutes, never the same
    // twice in a row. Lock stays held — we're continuing the chain.
    const jitterMs = (Math.random() * 2 - 1) * GAP_JITTER_MINUTES * 60 * 1000;
    const delayMs = GAP_MINUTES * 60 * 1000 + jitterMs;
    ScriptApp.newTrigger(CHAIN_HANDLER)
      .timeBased()
      .after(delayMs)
      .create();
    Logger.log(`(${AGENT_ID}) Next send scheduled in ~${Math.round(delayMs / 60000)} minutes.`);
  } else {
    Logger.log(`(${AGENT_ID}) That was the last approved draft for today — chain stops here.`);
    releaseLock();
  }
}

function deleteOwnTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === WATCHER_HANDLER || t.getHandlerFunction() === CHAIN_HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/**
 * Run this ONCE per account (Apps Script editor > select this function >
 * Run) to install the 15-minute watcher. Safe to re-run any time — it
 * clears any previous watcher/chain trigger for THIS script first, so it
 * never doubles up. IMPORTANT: also set the script's time zone to
 * America/Chicago first (gear icon > Project Settings, left sidebar), and
 * double-check AGENT_ID above matches which account this copy belongs to
 * — a wrong AGENT_ID would make this account check (and lock/release)
 * the wrong agent's settings.
 */
function installWatcherTrigger() {
  deleteOwnTriggers();

  ScriptApp.newTrigger(WATCHER_HANDLER)
    .timeBased()
    .everyMinutes(WATCHER_INTERVAL_MINUTES)
    .create();

  Logger.log(
    `(${AGENT_ID}) Watcher installed: checks every ${WATCHER_INTERVAL_MINUTES} minutes whether this agent's ` +
      `configured start time has passed AND the cross-agent lock is free, and starts the send-chain the first ` +
      `time both are true each day.`
  );
}
