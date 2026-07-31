# Town Fuss — Disaster Recovery

This document exists so that if something goes badly wrong, you don't have
to remember anything — just find the section that matches what happened and
follow it step by step. It assumes you (or whoever is reading this) have
forgotten all the technical details and may be doing this while stressed.
That's fine. Go slow, follow the steps in order.

If at any point a step doesn't make sense or a command doesn't work, the
fastest path forward is to open Claude Code in this repo folder and paste
this whole document in, along with what actually happened. Everything below
was set up *by* Claude Code, so handing it back this document is a
completely reasonable way to execute it.

---

## The big picture first (read this before anything else)

Town Fuss is actually two separate systems, and it matters which one is
broken:

1. **The website itself** (every HTML/CSS/JS file — what a visitor's
   browser loads) lives in this GitHub repository and is served directly by
   **GitHub Pages**, not by Firebase. As long as GitHub exists and this
   repo exists, the website's files are safe — nothing below is needed to
   protect them specifically.

2. **Everything the website *talks to*** — the database (Firestore: user
   accounts, posts, messages, business listings, game data), the login
   system (Firebase Authentication), uploaded photos/logos (Firebase
   Storage), and the backend (Cloud Functions: Stripe payments, scheduled
   cleanup jobs, push notifications) — all of that lives in a single
   Firebase project called **`town-talk-87ff7`**.

If the Firebase project is ever damaged or destroyed, the website will
still *load* (GitHub Pages doesn't know Firebase exists), but it will be
completely broken to actually use — nobody can log in, no data loads,
nothing saves — because every page has a small snippet of config
(`firebaseConfig`) pointing at that specific project ID.

**Key project facts, all in one place:**
- Firebase/Google Cloud project ID: `town-talk-87ff7`
- GitHub repo: `https://github.com/TitanBusinessPros/Town-Talk`
- Domain: `www.townfuss.com`, served by GitHub Pages (see the `CNAME` file
  in the repo root)
- Firestore backups: automatic, daily, keeps the last 30 days
- Auth account backups: automatic, daily at 2am Central Time, keeps the
  last 30 days, stored in Firebase Storage
- Storage (photos/logos): protected by Object Versioning, old versions
  kept 90 days

---

## Before you do anything: what you'll need installed

All the recovery steps below use the **Firebase CLI**. If it's not already
installed on whatever computer you're using:

```
npm install -g firebase-tools
firebase login
```

(That requires Node.js to be installed first — if it isn't, install it from
nodejs.org, any recent version.)

Log in with the Google account that has access to the `town-talk-87ff7`
Firebase project (as of this writing, that's the account tied to
`titanbusinesspros@gmail.com`).

---

## Scenario 1: The Firestore database got wiped, corrupted, or badly messed up

This is the "someone deleted a bunch of data" or "a bug wrote garbage into
the database" scenario.

**Step 1 — Find the most recent backup:**
```
firebase firestore:backups:list --project town-talk-87ff7
```
This lists every available backup with a name like
`projects/town-talk-87ff7/locations/.../backups/xxxxxxxx`. Copy the full
name of the most recent one (or whichever one predates the problem — if the
damage happened today, you may want *yesterday's* backup instead of
today's, in case today's backup was already taken after the damage).

**Step 2 — Restore from it:**

Restoring creates a **new** database from the backup — it does not
overwrite the broken one in place. This is deliberate: it lets you check
the restored data looks right before switching over, instead of gambling
on an in-place overwrite.

```
firebase firestore:databases:restore --database RESTORED-DB --backup "paste-the-full-backup-name-here" --project town-talk-87ff7
```

(`RESTORED-DB` can be any name you want, e.g. `restored-2026-08-01`.)

**Step 3 — Verify the restored data:**
Open the Firebase Console → Firestore Database → switch the database
selector to your new restored database → spot-check that the `users`,
`conversations`, and a couple of game collections look correct.

**Step 4 — Switch the app over to the restored database:**
This is the trickiest part, because the app code (`index.js` and all the
`.html` files) currently talks to the `(default)` database, not to a
renamed one. The cleanest approach is:
1. Delete or rename the broken `(default)` database in the Firebase
   Console (Firestore → Databases → the `(default)` one → Delete).
   **This step is irreversible for the broken data — make sure you've
   already confirmed the restored copy looks right in Step 3 first.**
2. Restore again, this time specifying `--database "(default)"` instead of
   a custom name, so the restored data lands in the actual database the
   app uses:
   ```
   firebase firestore:databases:restore --database "(default)" --backup "same-backup-name-as-before" --project town-talk-87ff7
   ```
3. No code changes or redeploys are needed after this — the app already
   points at `(default)`.

**Note on "30 days":** the backup schedule only keeps the last 30 days of
snapshots. If the damage happened more than 30 days before you're reading
this, there is no backup old enough — this is the real tradeoff of the
retention window, discussed when this was set up.

---

## Scenario 2: Auth accounts (logins/emails) got lost

Auth (who can log in, with what email/password) is a **completely separate
system from Firestore** — restoring Firestore does not restore this, and
vice versa.

**Step 1 — Find the most recent export:**
Auth accounts are exported automatically every night at 2am Central Time
to Firebase Storage, at a path like:
```
admin-backups/auth-exports/auth-export-2026-08-01.json
```
To download the most recent one, open the Firebase Console → Storage →
navigate to the `admin-backups/auth-exports/` folder → download the file
with the most recent date in its name.

(If the Cloud Function itself is somehow also gone — see Scenario 4 — this
export won't exist either. In that case, the most recent Firestore backup
combined with whatever data still exists in Auth is the best you have.)

**Step 2 — Get this project's password hash settings.**

This is the part that's easy to get wrong: Firebase doesn't store plain
passwords, it stores scrambled ("hashed") versions, using a specific
secret configuration unique to this project. Restoring the export
correctly requires telling Firebase that same configuration — otherwise
the accounts come back, but **everyone's saved password stops working**
(they'd need to reset it).

This configuration includes a secret key, which is deliberately **not**
written down anywhere in this document or committed to the repo — writing
a project's password-signing secret into a document that lives in version
control would be a real security mistake. Instead, fetch it fresh, right
before you need it:

- **If you have Claude Code available:** just ask it to "fetch the Auth
  password hash config for town-talk-87ff7 from the Identity Toolkit API"
  — it did this exact thing while building this document and can repeat
  it.
- **If you don't:** the value can be retrieved by making an authenticated
  request to
  `https://identitytoolkit.googleapis.com/admin/v2/projects/town-talk-87ff7/config?fields=signIn.hashConfig`
  using a Google account with access to the project. Any engineer
  comfortable with Google Cloud auth can do this in a couple of minutes.

**Step 3 — Import the accounts back in**, using the export file from Step 1
and the hash config values from Step 2:

```
firebase auth:import auth-export-2026-08-01.json --hash-algo=SCRYPT --hash-key="<signerKey from Step 2>" --salt-separator="<saltSeparator from Step 2>" --rounds=<rounds from Step 2> --mem-cost=<memoryCost from Step 2> --project town-talk-87ff7
```

**Step 4 — Verify:** try logging into a known test account, or check the
Firebase Console → Authentication → Users to confirm the expected number of
accounts came back.

---

## Scenario 3: A single photo, logo, or file got accidentally deleted or overwritten

This is the smallest, most common kind of accident — someone's profile
photo or a business logo got overwritten by a new upload, or deleted, and
you want the old one back. This is what Object Versioning (turned on
2026-07-30) protects.

**Step 1 — Find the file's history:**
Open the Firebase Console → Storage → navigate to the file's folder (e.g.
`users/{their-uid}/images/` or `businesses/{their-uid}/images/`).

If the Console's UI doesn't show old versions directly (it's not always
obvious in the interface), the reliable way is to ask Claude Code to list
the "generations" of that specific file via the Cloud Storage API — this
is quick to do and was demonstrated while setting this up.

**Step 2 — Restore the old version:**
Once you have the old version identified, it can be copied back over the
current (broken/deleted) version, which makes it the "current" version
again. Claude Code (or any engineer with Cloud Storage access) can do this
directly via the Storage API.

**Note:** old versions are only kept for **90 days** after being replaced
or deleted (a cleanup rule, so storage costs don't grow forever) — beyond
that window, they're gone for good.

---

## Scenario 4: The whole Firebase project is deleted or completely inaccessible

This is the worst case, so let's be honest about it up front:

**The website itself is fine.** GitHub Pages doesn't depend on Firebase at
all — `www.townfuss.com` keeps loading normally.

**The data is the real risk here, and there's an important gap to know
about:** the Firestore backups and Auth exports set up on 2026-07-30 both
live *inside* the `town-talk-87ff7` project itself. If the entire project
is deleted, there's a real chance those backups are deleted along with it.
This setup protects well against *accidental damage within* the project
(bad deletes, bugs, corruption) — it is **not** a complete guarantee
against the project itself disappearing. If you want protection against
that specific scenario too, the fix is periodically exporting a copy of
the data to somewhere outside this project entirely (a different Google
Cloud project, or just downloading a copy to a computer) — that wasn't
part of what was set up today and would be a reasonable thing to ask for
next.

With that said, here's the recovery path:

**Step 1 — Check if the project can simply be undeleted.**
Google holds a deleted Cloud project for about 30 days before it's gone
for good. If this just happened recently:
- Go to https://console.cloud.google.com/cloud-resource-manager
- Look for `town-talk-87ff7` in the deleted/trash view
- If it's there, restore it — this is by far the easiest outcome, since
  everything (data, config, backups) comes back exactly as it was.

**Step 2 — If it can't be undeleted, you're building a new project.**
Important: a brand-new project will almost certainly need a **new project
ID** — Google doesn't generally let you reuse the exact same ID once it's
been deleted for good. This means every place in the code that references
`town-talk-87ff7` needs updating. Concretely:

1. Create a new Firebase project (console.firebase.google.com → Add
   project).
2. Enable: Firestore (Native mode), Authentication (turn on the
   Email/Password sign-in method), Storage, and upgrade to the Blaze
   (pay-as-you-go) plan (required for Cloud Functions).
3. In the new project's settings, find the new `firebaseConfig` values
   (apiKey, authDomain, projectId, storageBucket, messagingSenderId,
   appId) and update them in **every** HTML file in the repo that has a
   `firebaseConfig` object — as of this writing that's `index.html`,
   `chess.html`, `checkers.html`, `ww.html`, `golf.html`, `fg.html`,
   `m3game.html`, and `gamezone.html`. (Ask Claude Code to do this
   mechanically across all files at once — it's the same values pasted in
   8 places.)
4. From this repo folder, point the Firebase CLI at the new project:
   ```
   firebase use --add
   ```
   (follow the prompts, select the new project)
5. Redeploy everything:
   ```
   firebase deploy --only firestore:rules,storage,functions
   ```
6. Re-set the Cloud Functions secrets (these do **not** carry over to a
   new project automatically):
   ```
   firebase functions:secrets:set STRIPE_SECRET_KEY --project <new-project-id>
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET_1 --project <new-project-id>
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET_2 --project <new-project-id>
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET_3 --project <new-project-id>
   ```
   (The actual secret values need to come from your Stripe Dashboard — see
   your own records for those, they are not stored in this repo.)
7. Update the 3 Stripe webhook destinations in the Stripe Dashboard to
   point at the new project's webhook URL (shown in the deploy output from
   step 5, looks like
   `https://us-central1-<new-project-id>.cloudfunctions.net/stripeWebhook`).
8. Re-run the setup from steps 1–3 of *this* document (Firestore backup
   schedule, Auth export function, Storage versioning) on the new project —
   none of that carries over automatically either.
9. If you have a recent Firestore backup or Auth export from *before* the
   project was destroyed (see the caveat above about where those lived),
   follow Scenario 1 / Scenario 2 above, but targeting the new project ID.

This is a big, multi-hour undertaking, not a quick fix — which is exactly
why avoiding it (via the backups already in place, and by considering an
outside-the-project backup copy per the note above) is worth the effort.

---

## A note on all of this

Everything in this document reflects how the system was set up on
2026-07-30. If new games, new Cloud Functions, new Storage paths, or a
new payment system get added later, this document should get updated
alongside those changes — it's only useful if it stays accurate. When in
doubt, ask Claude Code to review this document against the current state
of the project and flag anything that's drifted out of date.
