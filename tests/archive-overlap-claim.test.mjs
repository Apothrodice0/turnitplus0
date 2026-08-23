import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * "Remove all user-facing references to Turnitin..." — this product no
 * longer names Turnitin, exposes its internal archive size, or renders the
 * word "archive" as a scoring label anywhere in normal user-facing UI,
 * reports, or receipts. Internal benchmark/calibration material (tools/,
 * corpus/) is explicitly exempt and untouched by this test.
 *
 * Supersedes this file's own earlier version, which asserted the OPPOSITE
 * (that "Archive overlap" / "not an estimate of a Turnitin score" text was
 * present) — that was the deliberately-changed behavior, not a regression.
 */

test("no user-facing Turnitin brand references remain in the report UI or receipt", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  const reportDetailShell = await readFile("app/reports/[id]/report-detail-shell.tsx", "utf8");
  const overviewReport = await readFile("components/report/similarity-report-papers.tsx", "utf8");
  const receipt = await readFile("lib/receipt-pdf.ts", "utf8");

  for (const [label, source] of [["app/page.tsx", page], ["report-detail-shell.tsx", reportDetailShell], ["similarity-report-papers.tsx", overviewReport], ["receipt-pdf.ts", receipt]]) {
    assert.doesNotMatch(source, /Turnitin(?!Plus)/, `${label} must not mention Turnitin by name`);
  }
});

test("no user-facing 'Archive overlap' label or exact indexed-document count remains in the report UI or receipt", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  const reportDetailShell = await readFile("app/reports/[id]/report-detail-shell.tsx", "utf8");
  const overviewReport = await readFile("components/report/similarity-report-papers.tsx", "utf8");
  const receipt = await readFile("lib/receipt-pdf.ts", "utf8");

  for (const [label, source] of [["app/page.tsx", page], ["report-detail-shell.tsx", reportDetailShell], ["similarity-report-papers.tsx", overviewReport], ["receipt-pdf.ts", receipt]]) {
    assert.doesNotMatch(source, />Archive overlap<|"Archive overlap"|Archive overlap:/, `${label} must not render the "Archive overlap" label`);
    assert.doesNotMatch(source, /\b230\b/, `${label} must not render the exact indexed-document count`);
    assert.doesNotMatch(source, /indexed documents|indexed archive/i, `${label} must not describe the internal archive/indexing mechanism`);
  }
});

test("the report card renders the neutral 'Similarity result' banner instead of the old archive-scope disclaimer", async () => {
  // Release-hardening audit finding SIM-01 renamed the local variable this
  // regex pins (overlapScore -> primaryScore, now selected via
  // primarySimilarityScore so it reflects the combined result when one has
  // been computed) — the wording asserted here is otherwise unchanged and
  // still renders for the archive-only fallback case this test's own intent
  // describes; see tests/similarity-result-consistency.test.mjs for coverage
  // of the unified-result banner text.
  const overviewReport = await readFile("components/report/similarity-report-papers.tsx", "utf8");
  assert.match(overviewReport, /Similarity result: \{primaryScore\}% — based on identified overlapping passages and verified academic sources\./);
});

test("external coverage messaging uses the approved 'millions of scholarly records' wording, never a specific unverified count", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(page, /Searches millions of scholarly records across major academic indexes|searching millions of scholarly records across major academic indexes/);
});
