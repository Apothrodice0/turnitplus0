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

  // storeReport must still run at all of its existing sites: the mount-time
  // remote-restore loop, saveReport, the Wikipedia-enrichment callback, and
  // both the success and failure paths of runAiAnalysis.
  const storeReportCalls = page.match(/await storeReport\(/g) ?? [];
  assert.equal(storeReportCalls.length, 5, "storeReport should still be called at exactly its 5 existing sites");

  assert.match(page, /await clearStoredReports\(\);/);
  assert.match(page, /loadStoredReports<SimilarityReport>\(11\)/);
});

test("remote report persistence (Turso) is layered alongside local storage, not in place of it", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(
    page,
    /import \{ deleteRemoteReport, fetchRemoteReport, listRemoteReportSummaries, saveReportRemote, type ReportSummary \} from "@\/lib\/reports-remote";/,
  );

  // Every storeReport call site must be immediately followed by the matching
  // saveReportRemote call, so a remote failure can never happen without the
  // local copy already having succeeded first.
  assert.match(page, /await storeReport\(report\);\s*\n\s*await saveReportRemote\(report, buildReportSummary\(report\)\);/);
  assert.match(page, /await storeReport\(enriched\);\s*\n\s*await saveReportRemote\(enriched, buildReportSummary\(enriched\)\);/);
  assert.match(page, /await storeReport\(updated\);\s*\n\s*await saveReportRemote\(updated, buildReportSummary\(updated\)\);/);
  assert.match(page, /await storeReport\(failed\);\s*\n\s*await saveReportRemote\(failed, buildReportSummary\(failed\)\);/);

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
