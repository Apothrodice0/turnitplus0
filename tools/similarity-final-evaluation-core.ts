export type EvaluationRow = {
  actual: number;
  predicted: number;
};

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

function quantile(sorted: number[], probability: number) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function ranks(values: number[]) {
  const ordered = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const result = Array<number>(values.length);
  let start = 0;
  while (start < ordered.length) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
    const rank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) result[ordered[index].index] = rank;
    start = end;
  }
  return result;
}

export function pearson(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSum = 0;
  let rightSum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSum += leftDelta ** 2;
    rightSum += rightDelta ** 2;
  }
  return leftSum === 0 || rightSum === 0 ? 0 : numerator / Math.sqrt(leftSum * rightSum);
}

export function spearman(left: number[], right: number[]) {
  return pearson(ranks(left), ranks(right));
}

export function regressionPredictedOnActual(rows: EvaluationRow[]) {
  const actual = rows.map((row) => row.actual);
  const predicted = rows.map((row) => row.predicted);
  const actualMean = mean(actual);
  const predictedMean = mean(predicted);
  const denominator = actual.reduce((sum, value) => sum + (value - actualMean) ** 2, 0);
  const slope = denominator === 0
    ? 0
    : rows.reduce((sum, row) => sum + (row.actual - actualMean) * (row.predicted - predictedMean), 0) / denominator;
  return {
    definition: "ordinary least squares: predicted = intercept + slope * actual",
    intercept: round(predictedMean - slope * actualMean),
    slope: round(slope),
  };
}

export function classificationMetrics(rows: EvaluationRow[], actualCutoff: number, predictedCutoff: number) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  rows.forEach((row) => {
    const actualPositive = row.actual >= actualCutoff;
    const predictedPositive = row.predicted >= predictedCutoff;
    if (actualPositive && predictedPositive) tp += 1;
    else if (!actualPositive && predictedPositive) fp += 1;
    else if (actualPositive) fn += 1;
    else tn += 1;
  });
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const specificity = tn + fp === 0 ? 0 : tn / (tn + fp);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const beta2 = 4;
  const f2 = beta2 * precision + recall === 0
    ? 0
    : ((1 + beta2) * precision * recall) / (beta2 * precision + recall);
  return {
    actualPositiveDefinition: `Turnitin score >= ${actualCutoff}`,
    predictedPositiveDefinition: `TurnitPlus score >= ${predictedCutoff}`,
    tp,
    fp,
    fn,
    tn,
    precision: round(precision),
    recall: round(recall),
    specificity: round(specificity),
    f1: round(f1),
    f2: round(f2),
  };
}

export function errorMetrics(rows: EvaluationRow[]) {
  const errors = rows.map((row) => row.predicted - row.actual);
  const absoluteErrors = errors.map(Math.abs).sort((left, right) => left - right);
  return {
    n: rows.length,
    meanError: round(mean(errors)),
    mae: round(mean(absoluteErrors)),
    rmse: round(Math.sqrt(mean(errors.map((error) => error ** 2)))),
    medianAbsoluteError: round(quantile(absoluteErrors, 0.5)),
    minimumSignedError: Math.min(...errors),
    maximumSignedError: Math.max(...errors),
  };
}

export function bootstrapMae(rows: EvaluationRow[], rounds = 5000) {
  let state = 0x46544c53;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const values: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    values.push(mean(sample.map((row) => Math.abs(row.predicted - row.actual))));
  }
  values.sort((left, right) => left - right);
  return {
    method: `deterministic percentile bootstrap over documents (${rounds} rounds)`,
    interpretation: "confidence interval for population MAE; not a per-document prediction interval",
    ci95: [round(quantile(values, 0.025)), round(quantile(values, 0.975))],
  };
}
