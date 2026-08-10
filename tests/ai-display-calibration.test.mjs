import assert from "node:assert/strict";
import test from "node:test";
import evaluation from "../public/data/ai-evaluation.json" with { type: "json" };

test("AI report uses the validated ranking signal and records the rejected coverage candidate", () => {
  const preliminary = evaluation.preliminaryPositiveControl;
  assert.equal(evaluation.version, 10);
  assert.equal(preliminary.displayedMetric, "continuous z-normalized document-median log-odds");
  assert.equal(preliminary.displayedReviewBand, 51);
  assert.equal(preliminary.documentsAtOrAboveDisplayedReviewBand, 28);
  assert.equal(preliminary.displayedReviewDetectionRate, 0.7179);
  assert.equal(preliminary.displayedScoreUniqueValueCount, 21);
  assert.deepEqual(preliminary.displayedScoreObservedRange.verifiedHuman, { minimum: 0, maximum: 50 });
  assert.deepEqual(preliminary.displayedScoreObservedRange.externalPositiveControl, { minimum: 42, maximum: 72 });
  assert.equal(preliminary.displayedScoreSpreadDiagnostic.lowest.standardizedMedianDistance, 0.4353);
  assert.equal(preliminary.displayedScoreSpreadDiagnostic.lowest.humanReferencePercentile, 96.59);
  assert.equal(preliminary.displayedScoreSpreadDiagnostic.highest.standardizedMedianDistance, 0.5522);
  assert.equal(preliminary.displayedScoreSpreadDiagnostic.highest.humanReferencePercentile, 100);
  assert.equal(preliminary.displayedScoreSpreadDiagnostic.positiveZSpan, 0.1169);
  assert.match(preliminary.displayedScoreSpreadDiagnostic.thesisSummary, /AUC 0\.9939 with a positive z-span of 0\.1169/);
  assert.equal(preliminary.displayedScoreContract.humanStandardDeviation > preliminary.displayedScoreContract.humanRobustSigma * 2, true);
  assert.equal(preliminary.perDocument.every((row) => Number.isFinite(row.standardizedMedianDistance)), true);
  assert.equal(preliminary.perDocument.every((row) => Number.isInteger(row.continuousDisplayScore)), true);
  assert.equal(preliminary.displayedCoveragePassageThreshold, 0.9801311795213746);
  assert.equal(preliminary.displayedCoverageReviewBand, 22);
  assert.equal(preliminary.displayedCoverageDetectionRate, 0);
  assert.equal(preliminary.displayedCoverageBandStatus, "derived-and-rejected-no-positive-recall");
  assert.equal(preliminary.displayedCoverageDiagnosticAuc < 0.5, true);
});
