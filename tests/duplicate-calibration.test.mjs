import assert from "node:assert/strict";
import test from "node:test";
import clusters from "../corpus/duplicate-clusters.json" with { type: "json" };
import calibration from "../public/data/risk-calibration.json" with { type: "json" };

test("duplicate clusters sit above a measured containment gap", () => {
  assert.equal(clusters.corpusVersion, calibration.corpusVersion);
  assert.equal(clusters.clusters.length, 3);
  assert.equal(clusters.topContainments.slice(0, 3).every((value) => value >= clusters.containmentThreshold), true);
  assert.equal(clusters.topContainments[3] < clusters.containmentThreshold, true);
  for (const [id, twins] of Object.entries(clusters.exclusionMap)) {
    assert.equal(twins.includes(id), false);
    for (const twin of twins) assert.equal(clusters.exclusionMap[twin].includes(id), true);
  }
});

test("cluster-aware calibration removes twin inflation and reports the naive comparison", () => {
  assert.equal(calibration.version, 8);
  assert.equal(calibration.matchingParameters.minimumMatchedWords >= 5, true);
  assert.equal(calibration.matchingParameters.maximumDocumentFrequency <= 12, true);
  assert.equal(calibration.matchingParameters.minimumSourceContribution >= 0, true);
  assert.equal(["raw", "containment"].includes(calibration.matchingParameters.sourceWeighting), true);
  assert.equal(calibration.parameterSweep.artifact, "corpus/audit/similarity-parameter-sweep.json");
  assert.equal(calibration.clusterExclusion, true);
  assert.equal(calibration.revisionGroupExclusion, true);
  assert.equal(calibration.duplicateClusterCount, 3);
  const legacyClusterIds = new Set(Object.keys(clusters.exclusionMap));
  assert.equal(calibration.perDocument.filter((row) => legacyClusterIds.has(row.id)).length, 6);
  assert.equal(calibration.perDocument
    .filter((row) => legacyClusterIds.has(row.id))
    .every((row) => row.score < row.naiveScore), true);
  assert.equal(calibration.auc < calibration.naiveComparison.auc, true);
  assert.equal(
    calibration.sensitivityWithoutDuplicateRows.sampleSize,
    calibration.sampleSize - legacyClusterIds.size,
  );
  assert.equal(calibration.aucCiMethod, "revision-group bootstrap, 2,000 rounds");
  assert.equal(calibration.sensitivityOneRowPerRevisionGroup.sampleSize < calibration.sampleSize, true);
  assert.equal(calibration.perDocument
    .filter((row) => !row.heldOutIndexPresent && row.excludedClusterMembers.length > 0)
    .every((row) => row.score < row.naiveScore), true);
});

test("production cutoff maximizes F2 inside the declared precision floor", () => {
  assert.equal(calibration.precisionFloor, 0.45);
  assert.equal(calibration.precision >= calibration.precisionFloor, true);
  const candidates = Array.from({ length: 101 }, (_, cutoff) => {
    const tp = calibration.perDocument.filter((row) => row.score >= cutoff && row.actual >= 15).length;
    const fp = calibration.perDocument.filter((row) => row.score >= cutoff && row.actual < 15).length;
    const fn = calibration.perDocument.filter((row) => row.score < cutoff && row.actual >= 15).length;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f2 = (5 * precision * recall) / Math.max(Number.EPSILON, 4 * precision + recall);
    return { cutoff, precision, recall, f2, predicted: tp + fp };
  });
  const rank = (left, right) => right.f2 - left.f2
    || right.recall - left.recall
    || right.precision - left.precision
    || right.cutoff - left.cutoff;
  const best = candidates
    .filter((candidate) => candidate.predicted > 0 && candidate.precision >= calibration.precisionFloor)
    .sort(rank)[0];
  assert.equal(calibration.archiveCutoff, best.cutoff);
  assert.equal(calibration.precision, Number(best.precision.toFixed(4)));
  assert.equal(calibration.recall, Number(best.recall.toFixed(4)));
});
