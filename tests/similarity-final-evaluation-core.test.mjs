import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapMae,
  classificationMetrics,
  errorMetrics,
  pearson,
  regressionPredictedOnActual,
  spearman,
} from "../tools/similarity-final-evaluation-core.ts";

test("computes signed and absolute error metrics", () => {
  const rows = [
    { actual: 1, predicted: 4 },
    { actual: 8, predicted: 6 },
    { actual: 15, predicted: 15 },
  ];
  assert.deepEqual(errorMetrics(rows), {
    n: 3,
    meanError: 0.3333,
    mae: 1.6667,
    rmse: 2.0817,
    medianAbsoluteError: 2,
    minimumSignedError: -2,
    maximumSignedError: 3,
  });
});

test("computes classification metrics at independent cutoffs", () => {
  const result = classificationMetrics([
    { actual: 20, predicted: 8 },
    { actual: 16, predicted: 3 },
    { actual: 2, predicted: 9 },
    { actual: 1, predicted: 1 },
  ], 15, 7);
  assert.deepEqual({ tp: result.tp, fp: result.fp, fn: result.fn, tn: result.tn }, { tp: 1, fp: 1, fn: 1, tn: 1 });
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 0.5);
});

test("correlations and regression preserve a perfect linear relationship", () => {
  const actual = [1, 2, 3, 4];
  const predicted = [3, 5, 7, 9];
  assert.equal(pearson(actual, predicted), 1);
  assert.equal(spearman(actual, predicted), 1);
  assert.deepEqual(regressionPredictedOnActual(actual.map((value, index) => ({ actual: value, predicted: predicted[index] }))), {
    definition: "ordinary least squares: predicted = intercept + slope * actual",
    intercept: 1,
    slope: 2,
  });
});

test("bootstrap MAE is deterministic and labelled as population uncertainty", () => {
  const rows = [{ actual: 0, predicted: 1 }, { actual: 0, predicted: 3 }];
  assert.deepEqual(bootstrapMae(rows, 100), bootstrapMae(rows, 100));
  assert.match(bootstrapMae(rows, 100).interpretation, /not a per-document prediction interval/);
});
