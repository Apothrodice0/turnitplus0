import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { bootstrapAuc, rocAuc } from "./calibration-utils";
import {
  bootstrapMae,
  classificationMetrics,
  errorMetrics,
  pearson,
  regressionPredictedOnActual,
  spearman,
} from "./similarity-final-evaluation-core";

type Parameters = { minimumMatchedWords: number; maximumDocumentFrequency: number } & SourceAggregationParameters;
type SearchIndex = {
  schema: "tplus-search-index";
  version: 3;
  shingleSize: number;
  corpusVersion: string;
  articles: Array<{ id: string; title: string; uniqueShingleCount: number }>;
  invertedIndex: Record<string, number[]>;
};
type SealedDocument = {
  id: string;
  title: string;
  textPath: string;
  textSha256: string;
  language: string;
  eligibleWordCount: number;
  turnitinScore: number;
  submissionId: string;
  revisionGroupId: string;
  independent: boolean;
  status: string;
};

const ROOT = "corpus/similarity-final-test";
const MANIFEST_PATH = join(ROOT, "manifest.json");
const AUDIT_PATH = join(ROOT, "intake-audit.json");
const OUTPUT_PATH = "corpus/audit/similarity-final-test-evaluation.json";

if (existsSync(OUTPUT_PATH)) throw new Error(`The sealed evaluation has already been opened: ${OUTPUT_PATH}`);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as SealedDocument[];
const audit = JSON.parse(readFileSync(AUDIT_PATH, "utf8")) as Record<string, unknown>;
const index = JSON.parse(gunzipSync(readFileSync("public/data/document-index.json.gz")).toString("utf8")) as SearchIndex;
const calibration = JSON.parse(readFileSync("public/data/risk-calibration.json", "utf8")) as {
  schema: string;
  version: number;
  corpusVersion: string;
  archiveCutoff: number;
  matchingParameters: Parameters;
};

if (audit.evaluationOpened !== false || audit.cohortStatus !== "complete-ready-to-open") {
  throw new Error("The final cohort is not sealed and ready for its one permitted opening.");
}
if (manifest.length !== 60) throw new Error(`Expected exactly 60 sealed documents; found ${manifest.length}.`);
if (index.schema !== "tplus-search-index" || index.version !== 3) throw new Error("Unsupported search index.");
if (
  calibration.schema !== "turnitplus-risk-calibration"
  || calibration.version !== 8
  || calibration.corpusVersion !== index.corpusVersion
) {
  throw new Error("The final test must use the shipped version 8 calibration and its matching index.");
}

const archiveManifest = JSON.parse(readFileSync("corpus/manifest.json", "utf8")) as Array<{ id: string }>;
const archiveIds = new Set([...archiveManifest.map((row) => row.id), ...index.articles.map((row) => row.id)]);
const unique = (values: string[]) => new Set(values).size === values.length;
if (!unique(manifest.map((row) => row.id))) throw new Error("Duplicate sealed document id.");
if (!unique(manifest.map((row) => row.submissionId))) throw new Error("Duplicate Turnitin submission id.");
if (!unique(manifest.map((row) => row.revisionGroupId))) throw new Error("Duplicate revision group in the independent final cohort.");

for (const document of manifest) {
  if (document.status !== "accepted-sealed" || document.independent !== true) throw new Error(`${document.id}: not independently sealed.`);
  if (document.language !== "English" || document.eligibleWordCount < 300) throw new Error(`${document.id}: failed locked eligibility rules.`);
  if (!Number.isFinite(document.turnitinScore) || document.turnitinScore < 0 || document.turnitinScore > 100) {
    throw new Error(`${document.id}: invalid Turnitin score.`);
  }
  if (archiveIds.has(document.id)) throw new Error(`${document.id}: leaked into the training/index corpus.`);
  const bytes = readFileSync(join(ROOT, document.textPath));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== document.textSha256) throw new Error(`${document.id}: sealed text hash mismatch.`);
  if (!bytes.toString("utf8").trim()) throw new Error(`${document.id}: empty sealed text.`);
}

function score(text: string, parameters: Parameters) {
  const words = tokens(text);
  const documentGrams = grams(words, index.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  uniqueDocumentGrams.forEach((gram) => {
    for (const sourceIndex of index.invertedIndex[gramHash(gram)] ?? []) {
      sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    }
  });
  const excluded = new Set<number>();
  index.articles.forEach((article, sourceIndex) => {
    if (containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, article.uniqueShingleCount) >= 0.75) {
      excluded.add(sourceIndex);
    }
  });
  const positionScores = new Map<number, Map<number, number>>();
  const eligibleCount = index.articles.length - excluded.size;
  documentGrams.forEach((gram, start) => {
    if (!informativeGram(gram)) return;
    const postings = (index.invertedIndex[gramHash(gram)] ?? []).filter((sourceIndex) => !excluded.has(sourceIndex));
    if (!postings.length || postings.length > parameters.maximumDocumentFrequency) return;
    const idf = Math.log((eligibleCount + 1) / (postings.length + 1)) + 1;
    postings.forEach((sourceIndex) => {
      for (let position = start; position < start + index.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
  });
  const matchedBySource = new Map<number, Set<number>>();
  positionScores.forEach((scores, position) => {
    const sourceIndex = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
    if (sourceIndex === undefined) return;
    const positions = matchedBySource.get(sourceIndex) ?? new Set<number>();
    positions.add(position);
    matchedBySource.set(sourceIndex, positions);
  });
  const { spansBySource } = acceptedSimilaritySpans(matchedBySource, parameters.minimumMatchedWords);
  const evidence = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set<number>();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, index.articles[sourceIndex].uniqueShingleCount),
    };
  });
  const aggregation = aggregateSimilaritySources(evidence, words.length, parameters);
  return {
    predictedScore: aggregation.score,
    excludedSelfMatches: excluded.size,
    retainedSources: aggregation.sourceContributions.length,
  };
}

const perDocument = manifest.map((document) => {
  const scored = score(readFileSync(join(ROOT, document.textPath), "utf8"), calibration.matchingParameters);
  const signedError = scored.predictedScore - document.turnitinScore;
  return {
    id: document.id,
    title: document.title,
    turnitinScore: document.turnitinScore,
    turnitPlusScore: scored.predictedScore,
    signedError,
    absoluteError: Math.abs(signedError),
    retainedSources: scored.retainedSources,
    excludedSelfMatches: scored.excludedSelfMatches,
  };
});

const rows = perDocument.map((row) => ({ actual: row.turnitinScore, predicted: row.turnitPlusScore }));
const positiveDefinition = 15;
const aucRows = rows.map((row) => ({ score: row.predicted, positive: row.actual >= positiveDefinition }));
const actualScores = rows.map((row) => row.actual);
const predictedScores = rows.map((row) => row.predicted);
const generatedAt = new Date().toISOString();
const output = {
  schema: "turnitplus-similarity-final-test-evaluation",
  version: 1,
  generatedBy: "tools/evaluate-similarity-final-test.ts",
  generatedAt,
  evaluationPolicy: "One-time evaluation of the prospectively sealed 60-document cohort. No row was used to fit or tune the shipped scorer.",
  sampleSize: rows.length,
  corpusVersion: index.corpusVersion,
  riskCalibrationVersion: calibration.version,
  archiveCutoff: calibration.archiveCutoff,
  matchingParameters: calibration.matchingParameters,
  scoreBandCounts: {
    below5: rows.filter((row) => row.actual < 5).length,
    from5To14: rows.filter((row) => row.actual >= 5 && row.actual < 15).length,
    atLeast15: rows.filter((row) => row.actual >= 15).length,
  },
  errors: errorMetrics(rows),
  populationMaeUncertainty: bootstrapMae(rows),
  association: {
    pearson: Number(pearson(actualScores, predictedScores).toFixed(4)),
    spearman: Number(spearman(actualScores, predictedScores).toFixed(4)),
    calibration: regressionPredictedOnActual(rows),
  },
  discrimination: {
    positiveDefinition: `Turnitin score >= ${positiveDefinition}`,
    auc: Number(rocAuc(aucRows).toFixed(4)),
    aucCi95: bootstrapAuc(aucRows).map((value) => Number(value.toFixed(4))),
  },
  classification: classificationMetrics(rows, positiveDefinition, calibration.archiveCutoff),
  perDocument,
};

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const temporaryOutput = `${OUTPUT_PATH}.tmp`;
writeFileSync(temporaryOutput, JSON.stringify(output, null, 2));
renameSync(temporaryOutput, OUTPUT_PATH);

const openedAudit = {
  ...audit,
  cohortStatus: "opened-evaluated",
  evaluationOpened: true,
  openedAt: generatedAt,
  evaluationArtifact: OUTPUT_PATH,
  evaluationSampleSize: rows.length,
};
const temporaryAudit = `${AUDIT_PATH}.tmp`;
writeFileSync(temporaryAudit, JSON.stringify(openedAudit, null, 2));
renameSync(temporaryAudit, AUDIT_PATH);

console.log(JSON.stringify({
  evaluationArtifact: OUTPUT_PATH,
  sampleSize: output.sampleSize,
  scoreBandCounts: output.scoreBandCounts,
  errors: output.errors,
  populationMaeUncertainty: output.populationMaeUncertainty,
  association: output.association,
  discrimination: output.discrimination,
  classification: output.classification,
}, null, 2));
