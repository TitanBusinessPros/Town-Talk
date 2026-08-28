// function-coverage.js
//
// Explicit registry: every exported Cloud Function in index.js, mapped to
// the ONE spec file in testing/tests/ that genuinely exercises it (calls
// it, or triggers it via a real action — a signup, an upload, a click —
// and asserts on the result).
//
// Why a hand-maintained registry instead of just grepping testing/tests/
// for each function's name: tried that first, for real, against this exact
// codebase. It flagged 36 of the 58 functions below as "uncovered" even
// though most of them genuinely are tested — this codebase's own style is
// almost always "click a button, assert on the resulting behavior," not
// "reference the Cloud Function's name as a literal string anywhere in the
// spec file." A pure name-grep can't tell "tested via UI, name never
// written down" apart from "never tested at all," so it would cry wolf
// constantly. It also went the other way at least twice on manual review —
// pirates-mobile.spec.js's window.__pirateDebugGrantGold (in-game currency
// debug helper, nothing to do with the admin Cloud Function) and
// scheduled-functions.spec.js's `redeemed: false` field assertion both
// contain "GrantGold"/"redeem" as literal substrings without the function
// being called at all. Same problem class testing/validate-config-parity.js
// already solves for build-edition.js's SIMPLE_CONFIG_FILES array, applied
// here: an explicit registry that testing/validate-function-coverage.js
// checks against, rather than guessing from text.
//
// Every entry below was verified individually (not assumed) before being
// added — 2026-08-28. See testing/validate-function-coverage.js for what
// actually enforces this going forward: it fails loudly if a function gets
// added to index.js with no corresponding entry here.
//
// A function with NO entry here is a real, currently-uncovered function —
// don't add a placeholder/guessed entry just to make the validator quiet.
module.exports = {
  // --- Game invite triggers (makeGameInviteTrigger) ---
  onChessInvite: "full-platform.spec.js",
  onCheckersInvite: "full-platform.spec.js",
  onWynneWarsInvite: "full-platform.spec.js",
  onGolfInvite: "full-platform.spec.js",
  onFrisbeeGolfInvite: "full-platform.spec.js",
  onWarInvite: "war-deep.spec.js",
  onHeartsInvite: "hearts-deep.spec.js",
  onBlackjackInvite: "blackjack-deep.spec.js",

  // --- Signup / profile / chat / moderation triggers ---
  onNewSignup: "full-platform.spec.js",
  onProfileSubmitted: "full-platform.spec.js",
  checkImageSafeSearch: "full-platform.spec.js", // real setInputFiles uploads at lines ~607/653 trigger this Storage-finalize function for real
  onFirstMessageNotify: "full-platform.spec.js",
  onChatReaction: "full-platform.spec.js",
  onChatReply: "full-platform.spec.js",
  onChatMessageDailyRewardQualify: "scheduled-functions.spec.js",

  // --- Scheduled (cron) functions ---
  refreshLeaderboardCache: "scheduled-functions.spec.js",
  computeNeighborOfTheWeek: "scheduled-functions.spec.js",
  expireBusinessListings: "scheduled-functions.spec.js",
  expireMemberships: "scheduled-functions.spec.js",
  dailyRewardsDraw: "scheduled-functions.spec.js",
  backupAuthAccounts: "scheduled-functions.spec.js",
  purgeExpiredDeletedProfiles: "scheduled-functions.spec.js",
  outreachUpdateCostSnapshot: "scheduled-functions.spec.js",

  // --- Payments ---
  stripeWebhook: "stripe-webhook.spec.js",

  // --- Admin actions ---
  ensureMyAdminPerks: "admin-delete-restore.spec.js", // client calls this automatically on every isAdminUser==true transition; this file's makeAdmin()+reload pattern triggers it for real, even though the spec never names it directly
  adminDeleteProfile: "admin-delete-restore.spec.js",
  adminRestoreProfile: "admin-delete-restore.spec.js",
  syncAdminClaim: "admin-delete-restore.spec.js",
  banUserAndIp: "ip-blocker.spec.js",
  beforeSignInBlocking: "ip-blocker.spec.js",

  // --- Daily Rewards sponsor invite ---
  inviteDailyRewardSponsor: "sponsor-invite.spec.js",

  // --- Outreach (townfuss-outreach-admin portal) ---
  // Only these 6 of the 26 outreach* functions are actually exercised by
  // outreach-admin.spec.js's real test bodies — verified against the
  // portal's own httpsCallable() call sites (townfuss-outreach-admin/
  // index.html), not assumed from "some outreach spec exists." The other
  // 20 outreach* functions below have NO entry here on purpose: they are
  // genuinely uncovered, confirmed 2026-08-28, not an oversight in this
  // registry.
  outreachSetSettings: "outreach-admin.spec.js",
  outreachListCandidates: "outreach-admin.spec.js",
  outreachSetCandidateStatus: "outreach-admin.spec.js",
  outreachAddManualLead: "outreach-admin.spec.js",
  outreachListLeads: "outreach-admin.spec.js",

  // adminGrantGold: NO ENTRY -- genuinely uncovered (confirmed 2026-08-28).
  // markDailyRewardRedeemed: NO ENTRY -- genuinely uncovered (confirmed 2026-08-28).

  // --- Outreach admin actions with no external API dependency ---
  // Group 2's safe half, closed 2026-08-28. The other 6 outreach onCall
  // functions (outreachCreateDraft, outreachSendReply, outreachListReplies,
  // outreachEmailExport, outreachGenerateLeads, outreachImportFromDirectory)
  // are DELIBERATELY left with no entry -- discussed explicitly with the
  // user, not an oversight. All 6 call a real external API (Gmail send/
  // draft/list, the paid Google Places API, or an arbitrary admin-supplied
  // URL) with credentials this test environment doesn't have, and doesn't
  // have any business acquiring on its own -- creating real Gmail drafts,
  // sending real email, or spending real Places API budget from an
  // automated test suite is not a decision to make unilaterally. Revisit
  // if/when real sandboxed test credentials for those become available.
  outreachSkipLead: "outreach-admin-actions.spec.js",
  outreachUpdateCandidate: "outreach-admin-actions.spec.js",
  outreachBulkAddCandidates: "outreach-admin-actions.spec.js",
  outreachDeleteCandidates: "outreach-admin-actions.spec.js",
  outreachGetSettings: "outreach-admin-actions.spec.js",
  outreachGetCostSnapshot: "outreach-admin-actions.spec.js",
  outreachMarkUnsubscribed: "outreach-admin-actions.spec.js",
  outreachDismissReplyThreads: "outreach-admin-actions.spec.js",

  // --- Outreach scheduler endpoints (SendScheduler.gs's own callers) ---
  // Group 1 of the priority list, closed 2026-08-28 -- see
  // testing/tests/outreach-scheduler.spec.js's own header for why these
  // were prioritized first: the mutex/bookkeeping protecting the live
  // email-sending pipeline from double-sends, not just admin conveniences.
  outreachAgentStatus: "outreach-scheduler.spec.js",
  outreachAcquireLock: "outreach-scheduler.spec.js",
  outreachReleaseLock: "outreach-scheduler.spec.js",
  outreachReportNextSend: "outreach-scheduler.spec.js",
  outreachReportSchedule: "outreach-scheduler.spec.js",
  outreachRecordSent: "outreach-scheduler.spec.js",
};
