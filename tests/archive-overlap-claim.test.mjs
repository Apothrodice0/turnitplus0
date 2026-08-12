import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the product reports scoped archive overlap instead of a Turnitin forecast", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  // OverviewReport (and its "matched against {archiveCount} indexed
  // documents" copy) moved to components/report/similarity-report-papers.tsx
  // when saved reports became a routable page — see app/reports/[id].
  const overviewReport = await readFile("components/report/similarity-report-papers.tsx", "utf8");
  const receipt = await readFile("lib/receipt-pdf.ts", "utf8");
  const boundary = JSON.parse(await readFile("public/data/similarity-boundary-evaluation.json", "utf8"));

  assert.match(page, /Archive overlap/);
  assert.match(overviewReport, /matched against \{archiveCount\.toLocaleString\(\)\} indexed documents/);
  assert.match(page, /not an estimate of a Turnitin score/i);
  assert.doesNotMatch(page, /\$\{currentReport\.score\}% Similarity/);
  assert.doesNotMatch(page, /Review is recommended from \{currentReport\.riskCutoff\}/);

  assert.match(receipt, /Archive overlap/);
  assert.match(receipt, /Archive scope/);
  assert.match(receipt, /not an estimate of a Turnitin score/i);
  assert.doesNotMatch(receipt, /\["Review threshold"/);

  assert.equal(boundary.sampleSize, 60);
  assert.equal(boundary.indexedDocumentCount, 230);
  assert.equal(boundary.productDecision.forecastClaim, "withdrawn");
  assert.equal(boundary.productDecision.externalScoreEstimate, false);
});
