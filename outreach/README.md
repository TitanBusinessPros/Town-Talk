# Town Fuss Outreach Agent

Sends 10 personalized outreach emails/day, spaced 10 minutes apart
starting 9:00 AM Central, from `info@titanbusinesspros.com` (shown to
recipients) riding `titanbusinesspros@gmail.com`'s already-warmed sending
reputation. Every email is reviewed by a human before it goes out — see
`../.claude/plans/sparkling-humming-reef.md` for the full reasoning.

This folder is completely separate from the live Town Fuss app — nothing
here is referenced by `build-edition.js`, any `firebase.*.json`, or
`index.js`, and nothing here can be deployed by the app's normal deploy
commands. It only touches your Gmail account and (read-only) one Firebase
project's `businesses` collection.

## One-time setup (do this once, start to finish takes a few hours not a day)

### Step 1 — Verify the Send-As alias

1. Open Gmail as `titanbusinesspros@gmail.com`.
2. Settings (gear icon) → **See all settings** → **Accounts** tab → next
   to "Send mail as" click **Add another email address**.
3. Enter `info@titanbusinesspros.com`, uncheck "Treat as an alias" is
   fine either way, click **Next Step** → **Send Verification**.
4. Open `info@titanbusinesspros.com`'s own inbox (you said you have
   access), find Gmail's confirmation email, click the verification link
   (or copy the confirmation code back into the Send-As dialog).
5. Confirm it now shows **verified** next to that address under Accounts.

### Step 2 — Google Cloud OAuth (for pulling leads + creating drafts)

1. Go to https://console.cloud.google.com/ , create a new project (any
   name, e.g. "town-fuss-outreach").
2. **APIs & Services → Library**: enable **Gmail API** and **Google
   Calendar API**.
3. **APIs & Services → OAuth consent screen**: External, fill in the
   minimum required fields, add `titanbusinesspros@gmail.com` as a test
   user (keeps it in "Testing" mode, which is fine — no Google review
   needed at this scale).
4. **APIs & Services → Credentials → Create Credentials → OAuth client
   ID** → Application type **Desktop app** → Create. Download the JSON.
5. Save the downloaded file as `outreach/credentials.json` (already
   gitignored — never commit it).
6. From the repo root: `cd outreach && npm install`
7. Run `node authorize.js`, open the printed URL, sign in as
   `titanbusinesspros@gmail.com`, approve, paste the code back. This
   creates `outreach/token.json` (gitignored) — one-time.

### Step 3 — Service account key (for reading lead data)

1. Firebase Console → the **Pauls Valley** project (`town-talk-87ff7`) →
   ⚙️ Project Settings → **Service Accounts** tab → **Generate new private
   key**.
2. Save the downloaded file as `outreach/service-account.json` (already
   gitignored — never commit it). This grants read access to that one
   project's Firestore only, and `firestoreAdmin.js` only ever calls
   `.get()` — it can't write anything back into the live app.

### Step 4 — Apps Script (the actual 9:00 AM / 10-minute sender)

1. Go to https://script.google.com/ signed in as
   `titanbusinesspros@gmail.com` → **New project**.
2. Delete the default `Code.gs` contents, paste in the contents of
   `outreach/apps-script/SendScheduler.gs` (keep that file here in sync
   if you ever edit the deployed version).
3. Project Settings (left sidebar) → set the **time zone** to
   `America/Chicago` — this is what makes "9:00 AM" mean Central, and it
   auto-handles the CST/CDT switch, no manual adjustment needed later.
4. In the editor's function dropdown, select `installDailyStartTrigger`,
   click **Run**. First run will ask you to authorize the script against
   your own Gmail — approve it (this is separate from Step 2's OAuth;
   Apps Script runs as the account itself, no token file involved).
5. Done — this installs a trigger that fires at 9:00 AM Central daily and
   self-chains every 10 minutes until that day's approved batch is sent.

## Daily workflow (once setup above is done)

There are two separate approval checkpoints — one for *who*, one for
*what gets said to them* — nothing is written or sent without both.

1. `node leads.js` — prints today's candidate list (up to 10) right in
   the terminal: name, email, town, and where each came from (an unpaid
   Town Fuss listing, or a row you added to `leads.csv`), already deduped
   against everyone contacted before. Also saves the same list to
   `todays-leads.json`. **Checkpoint 1 — nobody is marked as contacted
   yet and nothing has touched Gmail.** Look over the printed list and
   tell Claude which numbers, if any, to drop.
2. Ask Claude (in a normal chat session) to read `todays-leads.json` and
   write `todays-drafts.json` — an array of `{ "to", "subject", "body" }`
   — with genuinely varied, personalized copy, only for the leads you
   kept (not a find-and-replace template; see the plan's reasoning on why
   identical copy is a spam signal).
3. `node draft.js` — creates each of those as a real Gmail Draft, From
   `info@titanbusinesspros.com`. This is the point each lead actually
   gets recorded in `sent-log.json` as contacted, so dropping someone at
   Checkpoint 1 leaves no trace of them and they're free to be
   reconsidered another day.
4. **Checkpoint 2.** Open Gmail, review each draft's actual wording (edit
   anything that reads off), and apply the **Outreach/Approved** label to
   the ones you want sent today. Anything you don't label just stays a
   draft — it's never sent and isn't lost, you can approve it a different
   day.
5. Leave it — the Apps Script trigger sends the approved ones starting
   9:00 AM Central, 10 minutes apart, on its own.

## Adding your own leads

Edit `outreach/leads.csv` — header row `name,email,town,notes`, one row
per contact. `leads.js` picks these up automatically (after Firestore
leads, before hitting the 10/day cap) and dedupes them against everyone
already contacted, same as the Firestore-sourced leads.

## Explicitly NOT built yet (v2, not today)

- Automated reply detection or auto-drafted responses — check
  `info@titanbusinesspros.com`'s inbox yourself for now.
- Auto-created Calendar demo invites — propose 2-3 times in the email
  body itself for now; add manually to Calendar once someone confirms.
- Any automated web search/guessing of email addresses — every lead here
  is either a real Town Fuss signup or something you added yourself.
