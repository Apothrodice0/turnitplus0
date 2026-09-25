import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// This is a source-text wiring test, matching the convention used by
// account-entry-gate.test.mjs and privacy-terms-branding.test.mjs: it does
// not render the component, it verifies that the existing local (IndexedDB)
// persistence calls are still present and unmodified, and that the new
// remote (Turso) calls were added alongside them rather than replacing them.

test("existing local report persistence (IndexedDB) is still wired at every save/clear site", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /import \{ ANONYMOUS_LOCAL_REPORT_OWNER, accountLocalReportOwner, clearStoredReports, storeReportBestEffort \} from "@\/lib\/report-store";/);

  // Release-hardening audit finding LIFECYCLE-01: saveReport and the
  // AI-completion merge go through storeReportBestEffort (an IndexedDB
  // failure must never block the authoritative remote save, or become an
  // unhandled rejection — see lib/report-ai-completion.ts and
  // lib/report-store.ts's own header comments).
  //
  // Auth-report local-history isolation: every local write names its OWNER
  // (lib/report-store.ts's LocalReportOwner). This flow is account-gated, so
  // both writes are the signed-in account's; the page never calls the raw
  // storeReport any more — the one anonymous writer, the signed-out restore,
  // lives in lib/local-report-session.ts.
  assert.equal((page.match(/await storeReport\(/g) ?? []).length, 0, "no raw storeReport call site left in the page");
  assert.match(page, /await storeReportBestEffort\(report, accountLocalReportOwner\(account\?\.email\)\);/, "saveReport's local copy is the account's");
  assert.match(page, /await storeReportBestEffort\(enriched, localOwner\);/, "the AI-completion merge's local copy is the account's");
  assert.equal((page.match(/await storeReportBestEffort\(/g) ?? []).length, 2);

  // "Clear history" clears only the current owner's local records.
  assert.match(page, /if \(localOwner\) await clearStoredReports\(localOwner\);/);
  // loadStoredReports reads IndexedDB's lightweight summary store (see
  // lib/report-store.ts), not full SimilarityReport bodies — the caller
  // reads it as LocalReportHistoryEntry and converts via
  // localHistoryEntryToSummary rather than buildReportSummary(); only the
  // anonymous owner's summaries are ever loaded for the signed-out history.
  assert.match(page, /loadAnonymousLocalHistory<LocalReportHistoryEntry, SimilarityReport>\(\)/);
  assert.match(page, /history\.kind === "local" \? history\.entries\.map\(localHistoryEntryToSummary\)/);
  const sessionLib = await readFile(new URL("../lib/local-report-session.ts", import.meta.url), "utf8");
  assert.match(sessionLib, /loadLocal: \(\) => loadStoredReports<TEntry>\(11, ANONYMOUS_LOCAL_REPORT_OWNER\)/);
});

test("remote report persistence (Turso) is layered alongside local storage, not in place of it", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(
    page,
    /import \{ deleteRemoteReport, fetchAllReportSummariesAcrossRooms, fetchUploadLimitStatus, saveReportRemote, type ReportSummary, type UploadLimitStatus \} from "@\/lib\/reports-remote";/,
  );

  // Release-hardening audit finding LIFECYCLE-01: the local cache write no
  // longer gates the remote save with an unguarded await — saveReport uses
  // storeReportBestEffort (local failure is swallowed, remote save still
  // runs), and the AI-enrichment callback uses persistAiCompletion (same
  // local-best-effort-then-remote pairing, bundled into one call so the two
  // can never drift apart — see lib/report-ai-completion.ts). app/page.tsx's
  // own save flow is anonymous-only now (an authenticated account's new
  // check happens entirely on its own room page — see
  // app/reports/rooms/[room]/room-page-shell.tsx, which has the equivalent,
  // room-aware version of this same pairing), so neither call site here
  // threads a room through.
  //
  // USER-SUPPLIED REFERENCES V1: the local cache write is still the CLEAN
  // `report` (raw reference text is never persisted locally); the remote save
  // gets `reportForRemote`, which is `report` plus an optional
  // `userSuppliedReferences` sibling for that one request only.
  assert.match(page, /await storeReportBestEffort\(report, accountLocalReportOwner\(account\?\.email\)\);\s*\n\s*const reportForRemote =[\s\S]{0,200}?return await saveReportRemote\(reportForRemote, summary, academicSearchDiagnosticsId\);/);
  assert.doesNotMatch(page, /\bstoreReportBestEffort\(reportForRemote\)/, "the local IndexedDB copy must never carry the raw supplied-reference text");
  assert.match(page, /await persistAiCompletion\(enriched, enrichedSummary\);/);

  // clearHistory must clear local storage first, then best-effort delete the
  // remote copies — never the other way around.
  assert.match(
    page,
    /if \(localOwner\) await clearStoredReports\(localOwner\);\s*\n\s*await Promise\.all\(idsToDelete\.map\(\(id\) => deleteRemoteReport\(id\)\)\);/,
  );

  // The signed-out history (lib/local-report-session.ts) must only reach for
  // the remote copy when the anonymous local store is genuinely empty, must
  // hand back full SimilarityReport objects, and must fetch them WITHOUT
  // credentials (the device-key-only twins), so a still-valid session can
  // never return the account's reports into anonymous storage.
  const sessionLib = await readFile(new URL("../lib/local-report-session.ts", import.meta.url), "utf8");
  assert.match(sessionLib, /if \(entries\.length > 0\) return \{ kind: "local", entries \};/);
  assert.match(sessionLib, /const summaries = await deps\.listRemote\(\);/);
  assert.match(sessionLib, /const full = await deps\.fetchRemote\(summary\.id\);/);
  assert.match(sessionLib, /listRemote: \(\) => listAnonymousDeviceReportSummaries\(\)/);
  assert.match(sessionLib, /fetchRemote: \(id\) => fetchAnonymousDeviceReport<TReport>\(id\)/);
  const remoteLib = await readFile(new URL("../lib/reports-remote.ts", import.meta.url), "utf8");
  assert.match(remoteLib, /export async function listAnonymousDeviceReportSummaries[\s\S]*?credentials: "omit"/);
  assert.match(remoteLib, /export async function fetchAnonymousDeviceReport[\s\S]*?credentials: "omit"/);
});

test("the room page's occupant state is only ever set to processing/ready/failed once the remote save is confirmed to have actually succeeded", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");

  // This is the fix for the production 404 regression: a report that
  // appeared in a room but was never actually persisted server-side (a
  // rejected save — quota, room already occupied, or any other failure)
  // would 404 when opened at /reports/[id]. setOccupant(...) marking this
  // room processing/ready/failed must never run unconditionally after a
  // save — only inside a check against that save's own result, and it must
  // return (never fall through to setOccupant) on failure.
  const runCheckBody = shell.match(/async function runCheck\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(runCheckBody.length > 0, "runCheck function body must be found");
  assert.match(runCheckBody, /if \(!saveResult\.ok\) \{[\s\S]*?\n\s*return;\s*\n\s*\}/);
  assert.match(runCheckBody, /setOccupant\(\{ status: "processing", report: summary, cycleEndsAt:/);

  // The AI-enriched resave's setOccupant("ready"/"failed") now lives in the
  // shared saveEnrichedAiResult helper (production audit fix — used by both
  // this automatic post-upload pass and the manual retryAiCheck, so the two
  // can never disagree on when a room is allowed to claim "ready"), not
  // inlined in runCheck() itself — runCheck only ever hands its result to it.
  // Release-hardening audit finding LIFECYCLE-01: the automatic pass now
  // goes through completeAiAnalysisWithRecovery, which still ATTEMPTS to
  // persist a real "failed" terminal state even if aiAnalysisPromise itself
  // were to reject (a bare .catch() would skip saveEnrichedAiResult
  // entirely and leave the room stuck at "processing") — see
  // tests/report-ai-completion.test.mjs for the dynamic proof.
  assert.match(runCheckBody, /void completeAiAnalysisWithRecovery\(aiAnalysisPromise, \(aiResult\) => saveEnrichedAiResult\(report, aiResult\)\)\.then\(\(saved\) => \{\s*\n\s*if \(!saved\) notify\(/);

  const helperBody = shell.match(/async function saveEnrichedAiResult\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(helperBody.length > 0, "saveEnrichedAiResult function body must be found");
  assert.match(helperBody, /await persistAiCompletion\(enriched, enrichedSummary, room\)/, "the remote save must go through persistAiCompletion, not a raw unguarded saveReportRemote (the owner-scoped local copy goes through the never-throwing storeReportBestEffort right before it)");
  assert.match(helperBody, /if \(!enrichedSaveResult\.ok\) return false;/, "a failed remote save must never reach setOccupant");
  assert.match(helperBody, /setOccupant\(\{\s*\n\s*status: enrichedSummary\.aiStatus === "ready" \? "ready" : "failed",\s*\n\s*report: enrichedSummary,/);
});

test("logout clears account-scoped report state immediately, purges the account's BROWSER-LOCAL copies, and never touches Turso", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // clearAccountDisplayState() (shared with the cross-tab storage listener
  // — see the next test) must run before the (best-effort) network call, so
  // the sidebar badge and report list can never keep showing the previous
  // account's data during or after a failed logout.
  assert.match(
    page,
    /function signOutAccount\(\) \{\s*\n(?:\s*\/\/.*\r?\n)*\s*clearAccountDisplayState\(\);\s*\n(?:\s*\/\/.*\r?\n)*\s*void purgeLocalReportStateForSignedOut\(\);\s*\n\s*fetch\("\/api\/auth\/logout"/,
  );

  const displayStateBody = page.match(/function clearAccountDisplayState\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(displayStateBody.length > 0, "clearAccountDisplayState function body must be found");
  assert.match(displayStateBody, /setReports\(\[\]\);/);
  assert.match(displayStateBody, /setCurrentReport\(null\);/);

  // Auth-report local-history isolation (privacy fix): the previous
  // expectation here — sign-out leaves IndexedDB untouched — is exactly what
  // let an account's reports surface in the signed-out "ON THIS DEVICE"
  // history afterwards. Sign-out now purges the BROWSER-LOCAL account copies
  // and every account's room caches (lib/local-report-session.ts; proven
  // dynamically in tests/report-local-ownership-isolation.test.mjs).
  //
  // It must still never call deleteRemoteReport (server data is only ever
  // removed by the explicit "Clear history" action) nor clearStoredReports
  // (that is "Clear history"'s own per-owner wipe, not the auth purge).
  // Extract just this function's body to check that in isolation, rather
  // than asserting on the whole file (clearHistory legitimately calls both).
  const signOutBody = page.match(/function signOutAccount\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(signOutBody.length > 0, "signOutAccount function body must be found");
  assert.match(signOutBody, /void purgeLocalReportStateForSignedOut\(\);/);
  assert.doesNotMatch(signOutBody, /clearStoredReports|deleteRemoteReport/);
  const sessionLib = await readFile(new URL("../lib/local-report-session.ts", import.meta.url), "utf8");
  const purgeBody = sessionLib.match(/export async function purgeLocalReportStateForSignedOut\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(purgeBody, /deps\.clearAllAccountsReportRoomCaches\(\);/);
  assert.match(purgeBody, /await deps\.purgeStoredReportsExcept\(ANONYMOUS_LOCAL_REPORT_OWNER\);/);
  assert.doesNotMatch(purgeBody, /deleteRemoteReport|fetch\(/, "the purge is browser-local only — never Turso");
});

test("signing out broadcasts to other open tabs via a real storage-event listener, without repeating the network call there (production audit fix)", async () => {
  // Before this fix, a second open tab kept showing the previous account's
  // name/room list until manually refreshed — the session cookie was
  // cleared server-side, but nothing told any OTHER tab's React state. The
  // "storage" event is the browser's own same-origin cross-tab broadcast
  // primitive: it fires in every tab EXCEPT the one that wrote the key, so
  // signOutAccount's write and this listener are the two required halves.
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  const signOutBody = page.match(/function signOutAccount\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(signOutBody, /window\.localStorage\.setItem\(SIGNED_OUT_BROADCAST_KEY, String\(Date\.now\(\)\)\);/, "signOutAccount must write the broadcast key so other tabs' storage listeners fire");

  const listenerMatch = page.match(/function handleStorage\(event: StorageEvent\) \{[\s\S]*?\n {4}\}/);
  assert.ok(listenerMatch, "a storage-event handler must be found");
  const listenerBody = listenerMatch[0];
  assert.match(listenerBody, /if \(event\.key !== SIGNED_OUT_BROADCAST_KEY \|\| event\.newValue === null\) return;/, "the handler must ignore every other localStorage key — it must not react to unrelated writes (e.g. the room cache, the sidebar-collapsed flag)");
  assert.match(listenerBody, /clearAccountDisplayState\(\);/, "the handler must clear this tab's own account display state");

  // The listener's own tab must NEVER repeat the /api/auth/logout call or
  // the localStorage write — the initiating tab already did both; doing
  // either again here would be redundant at best and could re-trigger an
  // infinite loop of storage events at worst.
  assert.doesNotMatch(listenerBody, /fetch\("\/api\/auth\/logout"/);
  assert.doesNotMatch(listenerBody, /window\.localStorage\.setItem\(SIGNED_OUT_BROADCAST_KEY/);

  assert.match(page, /window\.addEventListener\("storage", handleStorage\);/);
  assert.match(page, /window\.removeEventListener\("storage", handleStorage\);/, "the listener must be cleaned up on unmount, not leaked");
});

test("authentication state is resolved before choosing anonymous vs. account-scoped report loading", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /async function loadAnonymousReports\(\)/);
  assert.match(page, /async function loadAccountReports\(\)/);

  // Room directory architecture: loadAccountReports no longer hydrates the
  // report list itself at all — ReportRoomsBrowser (rendered only when
  // `account` is set, further down) owns fetching its own account-scoped
  // room index directly from the session-scoped API route, and each room's
  // own dedicated page owns fetching that one room's data. This function's
  // remaining job is clearing the stale anonymous list and refreshing the
  // upload quota — it must NOT loop over a summaries array itself anymore
  // (that would mean the old full-hydration behavior crept back in).
  const accountLoaderBody = page.match(/async function loadAccountReports\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(accountLoaderBody.length > 0, "loadAccountReports function body must be found");
  assert.doesNotMatch(accountLoaderBody, /for \(const summary of summaries\)/, "loadAccountReports must not loop over reports itself — that responsibility now belongs entirely to ReportRoomsBrowser");
  assert.match(accountLoaderBody, /setReports\(\[\]\);/);
  assert.match(accountLoaderBody, /fetchUploadLimitStatus\(\)/);

  // The mount effect must check the session first, then call exactly one of
  // the two loaders depending on the result — never both, never neither —
  // and the anonymous one ONLY for a definitive signed-out answer: an
  // indeterminate one (network error, non-2xx, unreadable body) fails closed
  // (auth-report local-history isolation; dynamic proof in
  // tests/report-local-ownership-isolation.test.mjs).
  const resolverBody = page.match(/async function resolveAuthAndReports\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(resolverBody, /hydrate: hydrateAccountFromServer,\s*\n\s*loadAccountReports,\s*\n\s*loadAnonymousReports,/);
  assert.match(page, /useEffect\(\(\) => \{[\s\S]{0,200}?void resolveAuthAndReports\(\);\s*\n\s*\}, \[\]\);/);
  const sessionLib = await readFile(new URL("../lib/local-report-session.ts", import.meta.url), "utf8");
  const machine = sessionLib.match(/export async function hydrateHomeReports\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(machine, /if \(result\.status === "signed-in"\) \{\s*\n\s*await purgeForAccount\(result\.user\.email\);\s*\n\s*await deps\.loadAccountReports\(\);/);
  assert.match(machine, /if \(result\.status === "signed-out"\) \{\s*\n\s*await purgeForSignedOut\(\);\s*\n\s*await deps\.loadAnonymousReports\(\);/);
  assert.match(machine, /deps\.onIndeterminate\(\);\s*\n\s*return "error";/);
  assert.equal((machine.match(/deps\.loadAnonymousReports\(\)/g) ?? []).length, 1, "exactly one anonymous-load site: the definitive signed-out branch");

  // The actual account-scoping enforcement for an authenticated user's own
  // report list now lives in ReportRoomsBrowser: rendered only when
  // `account` is truthy, and only ever given the account's email (never a
  // raw report list) — it fetches its own data straight from the
  // session-scoped /api/reports/rooms and /api/reports?room=N routes, so a
  // different account's (or an anonymous, never-claimed) report can never
  // surface here, exactly the same guarantee this test protected before.
  assert.match(page, /\{account \? \(\s*\n\s*<ReportRoomsBrowser\s*\n\s*key=\{roomsBrowserKey\}\s*\n\s*accountEmail=\{account\.email\}/);
});

test("a successful login/signup replaces the visible report list with the newly authenticated account's reports", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // Must call the same account-scoped loader used at hydration (so the
  // behavior — and its guarantees against cross-account leakage — is
  // identical), and it must run before the account is considered "loaded",
  // replacing rather than appending to whatever was previously displayed.
  assert.match(
    page,
    /setAccount\(data\.user as LocalAccount\);\s*\n(?:\s*\/\/.*\r?\n)*\s*await hydrateAccountFromServer\(\);\s*\n\s*setAuthLoadingLabel\("Loading your report history"\);\s*\n(?:\s*\/\/.*\r?\n)*\s*setAuthHydrationFailed\(false\);\s*\n\s*await purgeLocalReportStateForAccount\(\(data\.user as LocalAccount\)\.email\);\s*\n\s*await loadAccountReports\(\);/,
  );
});
