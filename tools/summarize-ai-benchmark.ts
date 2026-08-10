import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tokens } from "../lib/similarity-core";
import { loadCorpus } from "./calibration-utils";

const documents = loadCorpus("ai-benchmark");
const comparisonDocuments = documents.filter((document) => document.referenceStatus === "unverified-population-proxy");
const dateIneligibleDocuments = documents.filter((document) => document.referenceStatus === "date-ineligible");

function counts(values: Array<string | number | null | undefined>) {
  return Object.fromEntries([...values.reduce<Map<string, number>>((result, value) => {
    const key = value === null || value === undefined || value === "" ? "unknown" : String(value);
    result.set(key, (result.get(key) ?? 0) + 1);
    return result;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

const wordCounts = documents.map((document) => tokens(document.text).length).sort((a, b) => a - b);
const reasons = documents.flatMap((document) => document.benchmarkExclusionReasons ?? []);
const scoreCache = existsSync("corpus/ai-score-cache.json")
  ? JSON.parse(readFileSync("corpus/ai-score-cache.json", "utf8")) as { documents?: Record<string, unknown> }
  : {};
const scoredIds = new Set(Object.keys(scoreCache.documents ?? {}));
function summarizeGroups(selected: typeof documents, decisionUse: string) {
  return Object.fromEntries([...selected.reduce<Map<string, typeof documents>>((groups, document) => {
  const key = document.referenceGroup ?? "unassigned-reference-group";
  groups.set(key, [...(groups.get(key) ?? []), document]);
  return groups;
}, new Map()).entries()].map(([group, rows]) => [group, {
  documentCount: rows.length,
  decisionUse,
  excludedUse: "Does not affect calibration negatives, FPR, thresholds, confidence intervals, or similarity indexing.",
  publicationYears: counts(rows.map((document) => document.publishedYear)),
  writerPopulations: counts(rows.map((document) => document.writerPopulation)),
  modelScoresAvailable: rows.filter((document) => scoredIds.has(document.id)).length,
}]));
}
const referenceGroups = summarizeGroups(comparisonDocuments, "Exploratory pre-November-2022 English-reference distribution only.");
const dateIneligibleGroups = summarizeGroups(dateIneligibleDocuments, "Scored diagnostics only; excluded from every human-reference comparison distribution.");
const summary = {
  schema: "turnitplus-ai-benchmark-summary",
  version: 1,
  generatedBy: "tools/summarize-ai-benchmark.ts",
  generatedAt: new Date().toISOString(),
  role: "ai-benchmark",
  status: "mixed-reference-eligibility",
  intendedUse: "Exploratory pre-November-2022 English-reference score distributions only.",
  excludedUse: "Not verified ground truth for false-positive, accuracy, or authorship claims.",
  documentCount: documents.length,
  comparisonDocumentCount: comparisonDocuments.length,
  dateIneligibleDocumentCount: dateIneligibleDocuments.length,
  modelScoresAvailable: documents.filter((document) => scoredIds.has(document.id)).length,
  totalWords: wordCounts.reduce((total, count) => total + count, 0),
  wordCounts: {
    minimum: wordCounts[0],
    median: wordCounts[Math.floor(wordCounts.length / 2)],
    maximum: wordCounts[wordCounts.length - 1],
  },
  languages: counts(documents.map((document) => document.language)),
  publicationYears: counts(documents.map((document) => document.publishedYear)),
  writerPopulations: counts(documents.map((document) => document.writerPopulation)),
  referenceGroups,
  dateIneligibleGroups,
  extractionMethods: counts(documents.map((document) => document.provenance.extractionMethod as string | null)),
  aiNegativeExclusionReasons: counts(reasons),
  documents: documents.map((document) => ({
    id: document.id,
    title: document.title,
    publishedYear: document.publishedYear,
    language: document.language,
    writerPopulation: document.writerPopulation,
    referenceGroup: document.referenceGroup ?? "unassigned-reference-group",
    referenceStatus: document.referenceStatus ?? null,
    wordCount: tokens(document.text).length,
    extractionMethod: document.provenance.extractionMethod,
    aiNegativeExclusionReasons: document.benchmarkExclusionReasons,
  })),
};

writeFileSync("corpus/ai-benchmark-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${documents.length} human-reference benchmark documents · ${summary.totalWords} words`);
