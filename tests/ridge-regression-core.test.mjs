import assert from "node:assert/strict";
import test from "node:test";
import { deterministicGroupFold, fitRidge, predictRidge } from "../tools/ridge-regression-core.ts";

test("ridge regression recovers a simple linear relationship", () => {
  const features = [[0], [1], [2], [3], [4]];
  const targets = features.map(([value]) => 2 + 3 * value);
  const model = fitRidge(features, targets, 1e-8);
  assert.ok(Math.abs(predictRidge(model, [5]) - 17) < 1e-6);
});

test("ridge regression standardizes constant features safely", () => {
  const model = fitRidge([[1, 4], [2, 4], [3, 4]], [2, 4, 6], 1);
  assert.ok(Number.isFinite(predictRidge(model, [4, 4])));
});

test("group folds are deterministic and bounded", () => {
  assert.equal(deterministicGroupFold("revision-a", 5), deterministicGroupFold("revision-a", 5));
  assert.ok(deterministicGroupFold("revision-b", 5) >= 0);
  assert.ok(deterministicGroupFold("revision-b", 5) < 5);
});
