import assert from "node:assert/strict";
import test from "node:test";
import observations from "../corpus/wikipedia-similarity-observations.json" with { type: "json" };
import calibration from "../public/data/risk-calibration.json" with { type: "json" };

test("records a complete Wikipedia phrase sample for every similarity calibration paper", () => {
  assert.equal(observations.schema, "turnitplus-wikipedia-similarity-observations");
  assert.equal(observations.phraseCount, 20);
  assert.equal(observations.observations.length, 60);
  for (const row of observations.observations) {
    assert.equal(row.queryMethod, "wikimedia-rest-exact-or-v1");
    assert.equal(row.result.status, "complete");
    assert.equal(row.result.errorCount, 0);
    assert.equal(row.result.phrasesSampled, 20);
  }
});

test("ships the combined score only when its held-out AUC improves", () => {
  assert.equal(calibration.version, 8);
  const signal = calibration.wikipediaSignal;
  assert.equal(signal.sampleSize, 60);
  assert.equal(signal.archiveOnlySensitivity.sampleSize, 60);
  assert.equal(signal.improvedAuc, signal.leaveOneOut.auc > signal.archiveOnlySensitivity.auc);
  assert.equal(
    signal.shippingDecision,
    signal.improvedAuc
      ? "combined-regression-screening-signal"
      : "archive-score-with-wikipedia-band-escalation-only",
  );
});
