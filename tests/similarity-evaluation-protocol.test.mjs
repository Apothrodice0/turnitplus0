import assert from "node:assert/strict";
import test from "node:test";
import protocol from "../corpus/protocol/similarity-evaluation-v1.json" with { type: "json" };
import lock from "../corpus/protocol/similarity-evaluation-v1.lock.json" with { type: "json" };
import { assignSimilarityEvaluationSplit, loadProtocolLock } from "../tools/similarity-evaluation-protocol.ts";

test("similarity evaluation protocol fixes eligibility before sealed collection", () => {
  assert.equal(protocol.version, 1);
  assert.equal(protocol.status, "fixed-before-first-sealed-cohort-admission");
  assert.equal(protocol.naturalStreamEligibility.minimumEligibleWords, 300);
  assert.match(protocol.naturalStreamEligibility.scoreBlindExclusion, /No document may be excluded/i);
  assert.equal(protocol.finalReleaseGate.minimumLockedTestSize, 60);
  assert.equal(protocol.finalReleaseGate.minimumAbsoluteMaeImprovement, 1);
  assert.equal(protocol.powerAssumption.approximatelyDetectableMaeImprovement, 1.12);
});

test("protocol lock points to a pre-admission immutable commit", () => {
  assert.equal(lock.protocolVersion, protocol.version);
  assert.match(lock.protocolCommit, /^[a-f0-9]{40}$/);
  assert.equal(lock.admittedSealedDocumentsAtLock, 0);
  assert.deepEqual(loadProtocolLock(), lock);
});

test("revision groups receive stable score-blind splits", () => {
  const first = assignSimilarityEvaluationSplit("article-family-001");
  const repeat = assignSimilarityEvaluationSplit("article-family-001");
  assert.deepEqual(first, repeat);
  assert.equal(["calibration", "development-validation", "locked-final-test"].includes(first.split), true);
  assert.equal(first.bucket >= 0 && first.bucket <= 3, true);
  assert.throws(() => assignSimilarityEvaluationSplit(""), /non-empty/);
});

test("hash buckets implement the fixed 50/25/25 group allocation", () => {
  const counts = { calibration: 0, "development-validation": 0, "locked-final-test": 0 };
  for (let index = 0; index < 4000; index += 1) counts[assignSimilarityEvaluationSplit(`group-${index}`).split] += 1;
  assert.equal(Math.abs(counts.calibration / 4000 - 0.5) < 0.04, true);
  assert.equal(Math.abs(counts["development-validation"] / 4000 - 0.25) < 0.04, true);
  assert.equal(Math.abs(counts["locked-final-test"] / 4000 - 0.25) < 0.04, true);
});
