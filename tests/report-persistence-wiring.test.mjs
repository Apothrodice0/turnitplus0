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

  assert.match(page, /import \{ clearStoredReports, loadStoredReports, storeReport \} from "@\/lib\/report-store";/);

  // storeReport must still run at all of its existing sites: the anonymous
  // remote-restore loop, the authenticated account-report cache loop,
  // saveReport, and the Wikipedia-enrichment callback. (runAiAnalysis's two
  // sites moved out along with the old in-app result view it powered — see
  // app/reports/[id], which renders saved AI results read-only instead.)
  const storeReportCalls = page.match(/await storeReport\(/g) ?? [];
  assert.equal(storeReportCalls.length, 4, "storeReport should still be called at exactly its 4 existing sites");

  assert.match(page, /await clearStoredReports\(\);/);
  assert.match(page, /loadStoredReports<SimilarityReport>\(11\)/);
});

test("remote report persistence (Turso) is layered alongside local storage, not in place of it", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(
    page,
    /import \{ deleteRemoteReport, fetchRemoteReport, listRemoteReportSummaries, saveReportRemote \} from "@\/lib\/reports-remote";/,
  );

  // Every storeReport call site must be immediately followed by the matching
  // saveReportRemote call, so a remote failure can never happen without the
  // local copy already having succeeded first.
  assert.match(page, /await storeReport\(report\);\s*\n\s*await saveReportRemote\(report, buildReportSummary\(report\)\);/);
  assert.match(page, /await storeReport\(enriched\);\s*\n\s*await saveReportRemote\(enriched, buildReportSummary\(enriched\)\);/);

  // clearHistory must clear local storage first, then best-effort delete the
  // remote copies — never the other way around.
  assert.match(
    page,
    /await clearStoredReports\(\);\s*\n\s*await Promise\.all\(idsToDelete\.map\(\(id\) => deleteRemoteReport\(id\)\)\);/,
  );

  // Mount-time hydration must only reach for the remote copy when local
  // storage is genuinely empty, and must never leave `reports` populated
  // with anything less than full SimilarityReport objects.
  assert.match(page, /if \(localReports\.length > 0\) return;/);
  assert.match(page, /const summaries = await listRemoteReportSummaries\(\);/);
  assert.match(page, /const full = await fetchRemoteReport<SimilarityReport>\(summary\.id\);/);
});

test("logout clears account-scoped report state immediately, and never touches IndexedDB or Turso", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // setReports([])/setCurrentReport(null) must run before the (best-effort)
  // network call, so the sidebar badge and report list can never keep
  // showing the previous account's data during or after a failed logout.
  assert.match(
    page,
    /function signOutAccount\(\) \{\s*\n(?:\s*\/\/.*\r?\n)*\s*setReports\(\[\]\);\s*\n\s*setCurrentReport\(null\);\s*\n\s*fetch\("\/api\/auth\/logout"/,
  );
  // signOutAccount must never call clearStoredReports or deleteRemoteReport
  // — those belong only to the explicit "Clear history" action, not to
  // signing out. Extract just this function's body to check that in
  // isolation, rather than asserting on the whole file (clearHistory
  // legitimately calls both, elsewhere).
  const signOutBody = page.match(/function signOutAccount\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(signOutBody.length > 0, "signOutAccount function body must be found");
  assert.doesNotMatch(signOutBody, /clearStoredReports|deleteRemoteReport/);
});

test("authentication state is resolved before choosing anonymous vs. account-scoped report loading", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /async function loadAnonymousReports\(\)/);
  assert.match(page, /async function loadAccountReports\(\)/);

  // The account-scoped loader's report set must come from the session-
  // scoped list endpoint, not from an unscoped local dump — this is what
  // keeps one account's reports from ever surfacing under a different
  // account or an anonymous device.
  const accountLoaderBody = page.match(/async function loadAccountReports\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(accountLoaderBody.length > 0, "loadAccountReports function body must be found");
  assert.match(accountLoaderBody, /const summaries = await listRemoteReportSummaries\(\);/);
  assert.match(accountLoaderBody, /for \(const summary of summaries\)/);

  // The mount effect must check the session first, then call exactly one of
  // the two loaders depending on the result — never both, never neither.
  assert.match(
    page,
    /if \(result && result\.user\) \{\s*\n\s*setAccount\(result\.user\);\s*\n\s*await loadAccountReports\(\);\s*\n\s*\} else \{\s*\n\s*await loadAnonymousReports\(\);\s*\n\s*\}/,
  );
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
