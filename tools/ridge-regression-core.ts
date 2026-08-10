export type RidgeModel = {
  means: number[];
  scales: number[];
  coefficients: number[];
};

function solve(matrix: number[][], target: number[]) {
  const size = target.length;
  const augmented = matrix.map((row, index) => [...row, target[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error("Ridge system is singular.");
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

export function fitRidge(features: number[][], targets: number[], lambda: number): RidgeModel {
  if (!features.length || features.length !== targets.length) throw new Error("Ridge training rows are missing or misaligned.");
  const featureCount = features[0].length;
  if (!featureCount || features.some((row) => row.length !== featureCount)) throw new Error("Ridge feature rows are inconsistent.");
  const means = Array.from({ length: featureCount }, (_, column) =>
    features.reduce((sum, row) => sum + row[column], 0) / features.length
  );
  const scales = means.map((mean, column) => {
    const variance = features.reduce((sum, row) => sum + (row[column] - mean) ** 2, 0) / features.length;
    return Math.sqrt(variance) || 1;
  });
  const design = features.map((row) => [1, ...row.map((value, column) => (value - means[column]) / scales[column])]);
  const width = featureCount + 1;
  const gram = Array.from({ length: width }, () => Array<number>(width).fill(0));
  const right = Array<number>(width).fill(0);
  for (let row = 0; row < design.length; row += 1) {
    for (let left = 0; left < width; left += 1) {
      right[left] += design[row][left] * targets[row];
      for (let column = 0; column < width; column += 1) gram[left][column] += design[row][left] * design[row][column];
    }
  }
  for (let index = 1; index < width; index += 1) gram[index][index] += lambda;
  return { means, scales, coefficients: solve(gram, right) };
}

export function predictRidge(model: RidgeModel, features: number[]) {
  if (features.length !== model.means.length) throw new Error("Ridge prediction feature count does not match the model.");
  return model.coefficients[0] + features.reduce((sum, value, column) =>
    sum + model.coefficients[column + 1] * ((value - model.means[column]) / model.scales[column]), 0
  );
}

export function deterministicGroupFold(group: string, folds: number) {
  let hash = 2166136261;
  for (let index = 0; index < group.length; index += 1) {
    hash ^= group.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % folds;
}
