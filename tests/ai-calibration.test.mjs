import assert from "node:assert/strict";
import test from "node:test";
import calibration from "../public/data/ai-calibration.json" with { type: "json" };
import evaluation from "../public/data/ai-evaluation.json" with { type: "json" };

test("does not activate authorship verdicts without controlled positive validation", () => {
  assert.equal(calibration.calibrated, false);
  assert.equal(calibration.positiveSetSize, 0);
  assert.equal(calibration.recall, null);
  assert.equal(calibration.auc, null);
  assert.equal(evaluation.validated, false);
  assert.equal(evaluation.positiveSetSize, 0);
  assert.equal(evaluation.preliminaryPositiveControl.independentDocumentCount, 39);
  assert.equal(evaluation.preliminaryPositiveControl.sessionCount, 42);
  assert.equal(evaluation.preliminaryPositiveControl.minimumIndependentDocumentTargetReached, true);
  assert.equal(evaluation.preliminaryPositiveControl.displayedCoverageReviewBand, 22);
  assert.equal(evaluation.preliminaryPositiveControl.documentsAtOrAboveDisplayedCoverageReviewBand, 0);
  assert.equal(evaluation.preliminaryPositiveControl.displayedCoverageDetectionRate, 0);
  assert.equal(evaluation.preliminaryPositiveControl.displayedCoverageBandStatus, "derived-and-rejected-no-positive-recall");
  assert.equal(evaluation.preliminaryPositiveControl.displayedMetric, "continuous z-normalized document-median log-odds");
  assert.equal(evaluation.preliminaryPositiveControl.documentsAtOrAboveDisplayedReviewBand, 28);
  assert.equal(evaluation.preliminaryPositiveControl.displayedScoreUniqueValueCount, 21);
  assert.equal(evaluation.preliminaryPositiveControl.documentsAtOrAboveReviewFloor, 39);
  assert.equal(evaluation.preliminaryPositiveControl.diagnosticDetectionRate, 1);
  assert.equal(evaluation.preliminaryPositiveControl.diagnosticMedianLogOddsAuc > 0.98, true);
  assert.equal(evaluation.preliminaryPositiveControl.calibrationEligible, false);
});

test("withholds the population FPR gap when the native control is too small", () => {
  assert.equal(calibration.populations["native-english"].n, 4);
  assert.equal(calibration.populationComparisonReady, false);
  assert.deepEqual(calibration.fprGapAtBand, { "15": null, "30": null });
});

test("ships the median reference distribution and human 90th-percentile passage threshold", () => {
  assert.equal(calibration.version, 9);
  assert.equal(calibration.inputContractVersion, 3);
  assert.equal(calibration.humanCalibrationReady, true);
  assert.equal(calibration.extractionParityReady, true);
  assert.equal(calibration.extractionParity.status, "passed");
  assert.equal(calibration.modelContract.chunking, "token-based-overlapping-windows");
  assert.equal(calibration.modelContract.contentWindowTokens, 240);
  assert.equal(calibration.modelContract.tokenStride, 120);
  assert.equal(calibration.modelContract.truncationSide, "none");
  assert.equal(calibration.reviewPassagePercentile, 90);
  assert.equal(Number.isFinite(calibration.reviewPassageLogOddsThreshold), true);
  assert.equal(calibration.perDocument.length, 88);
  assert.equal(calibration.perDocument.every((row) => Number.isFinite(row.medianLogOdds)), true);
  assert.equal(calibration.perDocument.every((row) => Number.isFinite(row.conservativeDocScore)), true);
  assert.equal(calibration.documentCoverageLogOddsThreshold, calibration.reviewPassageLogOddsThreshold);
});
