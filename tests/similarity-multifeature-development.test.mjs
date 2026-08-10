import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const artifact = JSON.parse(readFileSync("corpus/audit/similarity-multifeature-development.json", "utf8"));
const source = readFileSync("tools/evaluate-similarity-multifeature.ts", "utf8");

test("multi-feature evaluation is nested, grouped, and development-only", () => {
  assert.equal(artifact.schema, "turnitplus-similarity-multifeature-development");
  assert.equal(artifact.sampleSize, 284);
  assert.equal(artifact.validation.outerFolds, 5);
  assert.match(artifact.validation.grouping, /revisionGroupId/);
  assert.match(artifact.isolation, /60-document final cohort is not read/);
  assert.doesNotMatch(source, /similarity-final-test/);
});

test("failed multi-feature candidate remains rejected", () => {
  assert.equal(artifact.fullModel.gatePassed, false);
  assert.equal(artifact.fullModel.metrics.targetCheck.slopeAbovePoint5, false);
  assert.equal(artifact.fullModel.metrics.targetCheck.predictedMaximumAtLeast40, false);
  assert.equal(artifact.fullModel.metrics.targetCheck.aucAbovePoint75, false);
  assert.equal(artifact.fullModel.metrics.targetCheck.lowBandMaeBelow3, false);
  assert.ok(artifact.archiveOnly.metrics.auc > artifact.fullModel.metrics.auc);
});

test("feature ablation covers every predeclared feature", () => {
  assert.deepEqual(
    artifact.ablation.map((row) => row.removedFeature).sort(),
    [...artifact.featureNames].sort(),
  );
});
