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

  assert.match(page, /import \{ clearStoredReports, loadStoredReports, storeReport, storeReportBestEffort \} from "@\/lib\/report-store";/);

  // Release-hardening audit finding LIFECYCLE-01: saveReport and the
  // Wikipedia-enrichment callback now go through storeReportBestEffort (an
  // IndexedDB failure must never block the authoritative remote save, or
  // become an unhandled rejection — see lib/report-ai-completion.ts and
  // lib/report-store.ts's own header comments). The anonymous remote-restore
  // loop is unchanged: it's already inside its own try/catch, so a failure
  // there was never able to escape as an unhandled rejection in the first
  // place, and stays on the raw storeReport.
  const storeReportCalls = page.match(/await storeReport\(/g) ?? [];
  assert.equal(storeReportCalls.length, 1, "the remote-restore loop should still be storeReport's one remaining direct call site");
  const storeReportBestEffortCalls = page.match(/await storeReportBestEffort\(/g) ?? [];
  assert.equal(storeReportBestEffortCalls.length, 1, "saveReport's own local cache write should go through storeReportBestEffort");

  assert.match(page, /await clearStoredReports\(\);/);
  // loadStoredReports now reads IndexedDB's lightweight summary store (see
  // lib/report-store.ts), not full SimilarityReport bodies — the caller
  // reads it as LocalReportHistoryEntry and converts via
  // localHistoryEntryToSummary rather than buildReportSummary().
  assert.match(page, /loadStoredReports<LocalReportHistoryEntry>\(11\)/);
});

test("remote report persistence (Turso) is layered alongside local storage, not in place of it", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(
    page,
    /import \{ deleteRemoteReport, fetchAllReportSummariesAcrossRooms, fetchRemoteReport, fetchUploadLimitStatus, listRemoteReportSummaries, saveReportRemote, type ReportSummary, type UploadLimitStatus \} from "@\/lib\/reports-remote";/,
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
  assert.match(page, /await storeReportBestEffort\(report\);\s*\n\s*return await saveReportRemote\(report, summary, academicSearchDiagnosticsId\);/);
  assert.match(page, /await persistAiCompletion\(enriched, enrichedSummary\);/);

  // clearHistory must clear local storage first, then best-effort delete the
  // remote copies — never the other way around.
  assert.match(
    page,
    /await clearStoredReports\(\);\s*\n\s*await Promise\.all\(idsToDelete\.map\(\(id\) => deleteRemoteReport\(id\)\)\);/,
  );

  // Mount-time hydration must only reach for the remote copy when local
  // storage is genuinely empty, and must never leave `reports` populated
  // with anything less than full SimilarityReport objects.
  assert.match(page, /if \(localEntries\.length > 0\) return;/);
  assert.match(page, /const summaries = await listRemoteReportSummaries\(\);/);
  assert.match(page, /const full = await fetchRemoteReport<SimilarityReport>\(summary\.id\);/);
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
  assert.match(helperBody, /await persistAiCompletion\(enriched, enrichedSummary, room\)/, "the local IndexedDB write and the remote save must both go through persistAiCompletion, not a raw unguarded storeReport/saveReportRemote pair");
  assert.match(helperBody, /if \(!enrichedSaveResult\.ok\) return false;/, "a failed remote save must never reach setOccupant");
  assert.match(helperBody, /setOccupant\(\{\s*\n\s*status: enrichedSummary\.aiStatus === "ready" \? "ready" : "failed",\s*\n\s*report: enrichedSummary,/);
});

test("logout clears account-scoped report state immediately, and never touches IndexedDB or Turso", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // clearAccountDisplayState() (shared with the cross-tab storage listener
  // — see the next test) must run before the (best-effort) network call, so
  // the sidebar badge and report list can never keep showing the previous
  // account's data during or after a failed logout.
  assert.match(
    page,
    /function signOutAccount\(\) \{\s*\n(?:\s*\/\/.*\r?\n)*\s*clearAccountDisplayState\(\);\s*\n\s*fetch\("\/api\/auth\/logout"/,
  );

  const displayStateBody = page.match(/function clearAccountDisplayState\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(displayStateBody.length > 0, "clearAccountDisplayState function body must be found");
  assert.match(displayStateBody, /setReports\(\[\]\);/);
  assert.match(displayStateBody, /setCurrentReport\(null\);/);

  // signOutAccount must never call clearStoredReports or deleteRemoteReport
  // — those belong only to the explicit "Clear history" action, not to
  // signing out. Extract just this function's body to check that in
  // isolation, rather than asserting on the whole file (clearHistory
  // legitimately calls both, elsewhere).
  const signOutBody = page.match(/function signOutAccount\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(signOutBody.length > 0, "signOutAccount function body must be found");
  assert.doesNotMatch(signOutBody, /clearStoredReports|deleteRemoteReport/);
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
  // the two loaders depending on the result — never both, never neither.
  assert.match(
    page,
    /if \(result && result\.user\) \{\s*\n\s*setAccount\(result\.user\);\s*\n\s*await loadAccountReports\(\);\s*\n\s*\} else \{\s*\n\s*await loadAnonymousReports\(\);\s*\n\s*\}/,
  );

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
    /setAccount\(data\.user as LocalAccount\);\s*\n\s*setAuthLoadingLabel\("Loading your report history"\);\s*\n(?:\s*\/\/.*\r?\n)*\s*await loadAccountReports\(\);/,
  );
});
