import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const artifact = JSON.parse(readFileSync("corpus/audit/similarity-source-floor-diagnostic.json", "utf8"));
const source = readFileSync("tools/diagnose-similarity-source-floor.ts", "utf8");

test("source-floor diagnostic is development-only and covers the predeclared floors", () => {
  assert.equal(artifact.schema, "turnitplus-similarity-source-floor-diagnostic");
  assert.equal(artifact.sampleSize, 284);
  assert.deepEqual(artifact.floors, [0, 0.05, 0.1, 0.15, 0.25]);
  assert.match(artifact.isolation, /60-document final cohort is not read/);
  assert.doesNotMatch(source, /similarity-final-test/);
});

test("no source floor passes the slope and low-band error gate", () => {
  assert.equal(
    artifact.results.some((result) => result.targetCheck.slopeAbovePoint4 && result.targetCheck.lowBandMaeBelow3),
    false,
  );
  assert.ok(artifact.results.every((result) => result.targetCheck.aucAbovePoint75));
  assert.ok(artifact.results.every((result) => !result.targetCheck.predictedMaximumAtLeast40));
});
