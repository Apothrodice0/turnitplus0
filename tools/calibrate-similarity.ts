import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  gramHash,
  grams,
  informativeGram,
  tokens,
  type SourceAggregationParameters,
} from "../lib/similarity-core";
import { bootstrapAuc, bootstrapAucByGroup, loadCorpus, rocAuc } from "./calibration-utils";
import {
  pendingOpenAlexSignal,
  summarizeOpenAlexSignal,
  type OpenAlexObservationFile,
} from "./openalex-signal";
import { evaluateWikipediaRegression, type WikipediaObservation } from "./wikipedia-regression";

type SearchIndex = {
  schema: "tplus-search-index";
  version: 3;
  shingleSize: number;
  corpusVersion: string;
  maximumDocumentFrequency: number;
  articles: Array<{ id: string; uniqueShingleCount: number }>;
  invertedIndex: Record<string, number[]>;
};

type DuplicateClusters = {
  schema: "turnitplus-duplicate-clusters";
  version: 1;
  corpusVersion: string;
  containmentThreshold: number;
  topContainments: number[];
  clusters: Array<{ clusterId: string; members: Array<{ id: string }> }>;
  exclusionMap: Record<string, string[]>;
};

type ParameterSweep = {
  schema: "turnitplus-similarity-parameter-sweep";
  version: 2;
  corpusVersion: string;
  sampleSize: number;
  selectionPolicy: string;
  selected: {
    parameters: {
      minimumMatchedWords: number;
      maximumDocumentFrequency: number;
    } & SourceAggregationParameters;
    auc: number;
    meanError: number;
    mae: number;
    rmse: number;
    operatingPoint: {
      cutoff: number;
      precision: number;
      recall: number;
      f2: number;
      tp: number;
      fp: number;
      fn: number;
      tn: number;
    };
  };
};

const search = JSON.parse(gunzipSync(readFileSync("public/data/document-index.json.gz")).toString("utf8")) as SearchIndex;
if (search.schema !== "tplus-search-index" || search.version !== 3) throw new Error("Unsupported similarity index schema.");
const duplicateClusters = JSON.parse(readFileSync("corpus/duplicate-clusters.json", "utf8")) as DuplicateClusters;
if (duplicateClusters.schema !== "turnitplus-duplicate-clusters" || duplicateClusters.version !== 1) {
  throw new Error("Unsupported duplicate-cluster schema.");
}
if (duplicateClusters.corpusVersion !== search.corpusVersion) {
  throw new Error("Duplicate clusters are stale for the current similarity index. Run npm run detect:duplicates.");
}
const allCalibrationDocuments = loadCorpus("similarity-calibration");
const documents = allCalibrationDocuments.filter((document) => document.calibrationIndependent !== false);
const TARGET_THRESHOLD = 15;
const POSITIVE_DEFINITION = ">= 15";
const MINIMUM_PRECISION = 0.45;
const parameterSweep = JSON.parse(
  readFileSync("corpus/audit/similarity-parameter-sweep.json", "utf8"),
) as ParameterSweep;
if (
  parameterSweep.schema !== "turnitplus-similarity-parameter-sweep"
  || parameterSweep.version !== 2
  || parameterSweep.corpusVersion !== search.corpusVersion
  || parameterSweep.sampleSize !== documents.length
) {
  throw new Error("The similarity parameter sweep is missing or stale. Run npm run sweep:similarity.");
}
const MATCHING_PARAMETERS = parameterSweep.selected.parameters;
const sourceById = new Map(search.articles.map((article, index) => [article.id, index]));
const revisionMembers = new Map<string, string[]>();
for (const document of allCalibrationDocuments) {
  const groupId = document.revisionGroupId ?? document.id;
  revisionMembers.set(groupId, [...(revisionMembers.get(groupId) ?? []), document.id]);
}

function scoreDocument(
  document: (typeof documents)[number],
  excludeCluster: boolean,
  matchingParameters = MATCHING_PARAMETERS,
) {
  const heldOutIndex = sourceById.get(document.id);
  const groupIds = revisionMembers.get(document.revisionGroupId ?? document.id) ?? [document.id];
  const excludedIds = excludeCluster
    ? [...new Set([
      ...groupIds,
      ...groupIds.flatMap((id) => duplicateClusters.exclusionMap[id] ?? []),
    ])]
    : [document.id];
  const excludedIndexes = new Set(excludedIds.map((id) => sourceById.get(id)).filter((value): value is number => value !== undefined));
  const words = tokens(document.text);
  const documentGrams = grams(words, search.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  uniqueDocumentGrams.forEach((gram) => {
    for (const sourceIndex of search.invertedIndex[gramHash(gram)] ?? []) {
      if (!excludedIndexes.has(sourceIndex)) {
        sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
      }
    }
  });
  const positionScores = new Map<number, Map<number, number>>();
  const eligibleDocumentCount = search.articles.length - excludedIndexes.size;
  documentGrams.forEach((gram, start) => {
    if (!informativeGram(gram)) return;
    const sources = (search.invertedIndex[gramHash(gram)] ?? []).filter((index) => !excludedIndexes.has(index));
    if (!sources.length || sources.length > matchingParameters.maximumDocumentFrequency) return;
    const idf = Math.log((eligibleDocumentCount + 1) / (sources.length + 1)) + 1;
    sources.forEach((sourceIndex) => {
      for (let position = start; position < start + search.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
  });
  const matchedBySource = new Map<number, Set<number>>();
  positionScores.forEach((scores, position) => {
    const bestSource = [...scores.entries()].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0]?.[0];
    if (bestSource === undefined) return;
    const positions = matchedBySource.get(bestSource) ?? new Set<number>();
    positions.add(position);
    matchedBySource.set(bestSource, positions);
  });
  const { spansBySource } = acceptedSimilaritySpans(
    matchedBySource,
    matchingParameters.minimumMatchedWords,
  );
  const evidence = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set<number>();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(
        sharedBySource.get(sourceIndex) ?? 0,
        uniqueDocumentGrams.size,
        search.articles[sourceIndex].uniqueShingleCount,
      ),
    };
  });
  const aggregation = aggregateSimilaritySources(evidence, words.length, matchingParameters);
  return {
    score: aggregation.score,
    excludedClusterMembers: excludedIds.filter((id) => id !== document.id),
    heldOutIndexPresent: heldOutIndex !== undefined,
  };
}

const predictions = documents.map((document) => {
  const clusterAware = scoreDocument(document, true);
  const naive = scoreDocument(document, false);
  return {
    id: document.id,
    actual: Number(document.turnitinScore),
    score: clusterAware.score,
    naiveScore: naive.score,
    excludedClusterMembers: clusterAware.excludedClusterMembers,
    revisionGroupId: document.revisionGroupId,
    heldOutIndexPresent: clusterAware.heldOutIndexPresent,
  };
});

function evaluate(scoreField: "score" | "naiveScore", rows = predictions) {
  const labelled = rows.map((row) => ({
    score: row[scoreField],
    positive: row.actual >= TARGET_THRESHOLD,
    group: row.revisionGroupId ?? row.id,
  }));
  const auc = rocAuc(labelled);
  const aucCi95 = bootstrapAucByGroup(labelled);
  const candidates = Array.from({ length: 101 }, (_, cutoff) => {
  const tp = rows.filter((row) => row[scoreField] >= cutoff && row.actual >= TARGET_THRESHOLD).length;
  const fp = rows.filter((row) => row[scoreField] >= cutoff && row.actual < TARGET_THRESHOLD).length;
  const fn = rows.filter((row) => row[scoreField] < cutoff && row.actual >= TARGET_THRESHOLD).length;
  const tn = rows.length - tp - fp - fn;
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f2 = (5 * precision * recall) / Math.max(Number.EPSILON, 4 * precision + recall);
  return { cutoff, tp, fp, fn, tn, precision, recall, f2 };
  });
  const rank = (left: (typeof candidates)[number], right: (typeof candidates)[number]) =>
    right.f2 - left.f2 || right.recall - left.recall || right.precision - left.precision || right.cutoff - left.cutoff;
  const bestUnconstrained = [...candidates].sort(rank)[0];
  const constrained = candidates.filter((candidate) =>
    candidate.tp + candidate.fp > 0 && candidate.precision >= MINIMUM_PRECISION,
  );
  if (!constrained.length) {
    throw new Error(`No ${scoreField} cutoff satisfies the ${MINIMUM_PRECISION} precision floor.`);
  }
  const bestConstrained = [...constrained].sort(rank)[0];
  return { auc, aucCi95, bestUnconstrained, bestConstrained };
}

const clusterAware = evaluate("score");
const naive = evaluate("naiveScore");
const duplicateMemberIds = new Set(Object.keys(duplicateClusters.exclusionMap));
const uncontaminatedRows = predictions.filter((row) => !duplicateMemberIds.has(row.id));
const withoutDuplicateRows = evaluate("score", uncontaminatedRows);
const oneRowPerRevisionGroup = [...predictions.reduce((groups, row) => {
  const group = row.revisionGroupId ?? row.id;
  if (!groups.has(group)) groups.set(group, row);
  return groups;
}, new Map<string, (typeof predictions)[number]>()).values()];
const onePerRevisionGroup = evaluate("score", oneRowPerRevisionGroup);
const best = clusterAware.bestConstrained;
const unconstrainedBest = clusterAware.bestUnconstrained;
const errors = predictions.map((row) => row.score - row.actual);
const errorMetrics = {
  meanError: Number((errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(4)),
  mae: Number((errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length).toFixed(4)),
  rmse: Number(Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length).toFixed(4)),
};
const wikipediaObservationPath = "corpus/wikipedia-similarity-observations.json";
if (!existsSync(wikipediaObservationPath)) throw new Error(`Missing ${wikipediaObservationPath}. Run npm run collect:wikipedia-calibration first.`);
const wikipediaObservationFile = JSON.parse(readFileSync(wikipediaObservationPath, "utf8")) as { schema:string;version:number;phraseCount:number;observations:WikipediaObservation[] };
if (wikipediaObservationFile.schema !== "turnitplus-wikipedia-similarity-observations" || wikipediaObservationFile.version !== 1 || wikipediaObservationFile.phraseCount !== 20) throw new Error("Unsupported Wikipedia similarity observation file.");
const wikipediaObservedIds = new Set(wikipediaObservationFile.observations.map((observation) => observation.id));
const wikipediaDocuments = documents.filter((document) => wikipediaObservedIds.has(document.id));
const wikipediaPredictions = predictions.filter((row) => wikipediaObservedIds.has(row.id));
const wikipediaArchiveBaseline = evaluate("score", wikipediaPredictions);
const wikipediaSignalBase = evaluateWikipediaRegression(wikipediaDocuments, wikipediaPredictions, wikipediaObservationFile.observations, rocAuc, bootstrapAuc, TARGET_THRESHOLD);
const wikipediaImprovedAuc = typeof wikipediaSignalBase.leaveOneOut.auc === "number"
  && wikipediaSignalBase.leaveOneOut.auc > Number(wikipediaArchiveBaseline.auc.toFixed(4));
const wikipediaSignal = {
  ...wikipediaSignalBase,
  archiveOnlySensitivity: {
    evaluation: "cluster-aware strict leave-one-out archive score on the same Wikipedia-observed subset",
    sampleSize: wikipediaPredictions.length,
    auc: Number(wikipediaArchiveBaseline.auc.toFixed(4)),
    aucCi95: wikipediaArchiveBaseline.aucCi95.map(value => Number(value.toFixed(4))),
  },
  deltaAuc: typeof wikipediaSignalBase.leaveOneOut.auc === "number"
    ? Number((wikipediaSignalBase.leaveOneOut.auc - wikipediaArchiveBaseline.auc).toFixed(4))
    : null,
  improvedAuc: wikipediaImprovedAuc,
  shippingDecision: wikipediaImprovedAuc ? "combined-regression-screening-signal" : "archive-score-with-wikipedia-band-escalation-only",
};
const openAlexObservationPath = "corpus/openalex-similarity-observations.json";
let openAlexSignal: ReturnType<typeof summarizeOpenAlexSignal> | ReturnType<typeof pendingOpenAlexSignal>;
if (existsSync(openAlexObservationPath)) {
  const observationFile = JSON.parse(readFileSync(openAlexObservationPath, "utf8")) as OpenAlexObservationFile;
  if (
    observationFile.schema !== "turnitplus-openalex-similarity-observations"
    || observationFile.version !== 1
    || observationFile.provider !== "OpenAlex"
    || observationFile.phraseCount !== 20
    || !Array.isArray(observationFile.observations)
  ) {
    throw new Error("Unsupported OpenAlex similarity observation file.");
  }
  openAlexSignal = summarizeOpenAlexSignal(documents, observationFile.observations, observationFile.phraseCount);
} else {
  openAlexSignal = pendingOpenAlexSignal();
}
const output = {
  schema: "turnitplus-risk-calibration",
  version: 8,
  generatedBy: "tools/calibrate-similarity.ts",
  generatedAt: new Date().toISOString(),
  evaluation: "cluster-aware-strict-leave-one-out-against-full-index",
  positiveDefinition: POSITIVE_DEFINITION,
  corpusVersion: search.corpusVersion,
  indexSourceCount: search.articles.length,
  sampleSize: predictions.length,
  totalLabelledReports: allCalibrationDocuments.length,
  independentCalibrationRows: documents.length,
  targetThreshold: TARGET_THRESHOLD,
  archiveCutoff: best.cutoff,
  matchingParameters: MATCHING_PARAMETERS,
  parameterSweep: {
    artifact: "corpus/audit/similarity-parameter-sweep.json",
    selectionPolicy: parameterSweep.selectionPolicy,
    selectedAuc: parameterSweep.selected.auc,
    selectedMeanError: parameterSweep.selected.meanError,
    selectedMae: parameterSweep.selected.mae,
    selectedRmse: parameterSweep.selected.rmse,
  },
  errorMetrics,
  clusterExclusion: true,
  revisionGroupExclusion: true,
  duplicateClusterCount: duplicateClusters.clusters.length,
  duplicateContainmentThreshold: duplicateClusters.containmentThreshold,
  duplicateTopContainments: duplicateClusters.topContainments,
  auc: Number(clusterAware.auc.toFixed(4)),
  aucCi95: clusterAware.aucCi95.map((value) => Number(value.toFixed(4))),
  aucCiMethod: "revision-group bootstrap, 2,000 rounds",
  precision: Number(best.precision.toFixed(4)),
  recall: Number(best.recall.toFixed(4)),
  truePositives: best.tp,
  falsePositives: best.fp,
  falseNegatives: best.fn,
  trueNegatives: best.tn,
  selectionMetric: "F2 subject to a minimum precision constraint",
  precisionFloor: MINIMUM_PRECISION,
  operatingPointPolicy: "Choose the highest-F2 cutoff among operating points with precision >= 0.45. Preserve the unconstrained F2 optimum as a sensitivity result.",
  unconstrainedF2Comparison: {
    archiveCutoff: unconstrainedBest.cutoff,
    precision: Number(unconstrainedBest.precision.toFixed(4)),
    recall: Number(unconstrainedBest.recall.toFixed(4)),
    truePositives: unconstrainedBest.tp,
    falsePositives: unconstrainedBest.fp,
    falseNegatives: unconstrainedBest.fn,
    trueNegatives: unconstrainedBest.tn,
    f2: Number(unconstrainedBest.f2.toFixed(4)),
  },
  wikipediaSignal,
  openAlexSignal,
  naiveComparison: {
    evaluation: "self-only-leave-one-out",
    auc: Number(naive.auc.toFixed(4)),
    aucCi95: naive.aucCi95.map((value) => Number(value.toFixed(4))),
    archiveCutoff: naive.bestConstrained.cutoff,
    precision: Number(naive.bestConstrained.precision.toFixed(4)),
    recall: Number(naive.bestConstrained.recall.toFixed(4)),
    truePositives: naive.bestConstrained.tp,
    falsePositives: naive.bestConstrained.fp,
    falseNegatives: naive.bestConstrained.fn,
    trueNegatives: naive.bestConstrained.tn,
  },
  sensitivityWithoutDuplicateRows: {
    evaluation: "all-members-of-near-duplicate-clusters-removed",
    sampleSize: uncontaminatedRows.length,
    auc: Number(withoutDuplicateRows.auc.toFixed(4)),
    aucCi95: withoutDuplicateRows.aucCi95.map((value) => Number(value.toFixed(4))),
    archiveCutoff: withoutDuplicateRows.bestConstrained.cutoff,
    precision: Number(withoutDuplicateRows.bestConstrained.precision.toFixed(4)),
    recall: Number(withoutDuplicateRows.bestConstrained.recall.toFixed(4)),
    truePositives: withoutDuplicateRows.bestConstrained.tp,
    falsePositives: withoutDuplicateRows.bestConstrained.fp,
    falseNegatives: withoutDuplicateRows.bestConstrained.fn,
    trueNegatives: withoutDuplicateRows.bestConstrained.tn,
  },
  sensitivityOneRowPerRevisionGroup: {
    evaluation: "one labelled observation retained per revision group",
    sampleSize: oneRowPerRevisionGroup.length,
    auc: Number(onePerRevisionGroup.auc.toFixed(4)),
    aucCi95: onePerRevisionGroup.aucCi95.map((value) => Number(value.toFixed(4))),
    archiveCutoff: onePerRevisionGroup.bestConstrained.cutoff,
    precision: Number(onePerRevisionGroup.bestConstrained.precision.toFixed(4)),
    recall: Number(onePerRevisionGroup.bestConstrained.recall.toFixed(4)),
    truePositives: onePerRevisionGroup.bestConstrained.tp,
    falsePositives: onePerRevisionGroup.bestConstrained.fp,
    falseNegatives: onePerRevisionGroup.bestConstrained.fn,
    trueNegatives: onePerRevisionGroup.bestConstrained.tn,
  },
  perDocument: predictions,
};
mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/risk-calibration.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
