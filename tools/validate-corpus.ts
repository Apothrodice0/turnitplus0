import { AI_MINIMUM_WORDS } from "../lib/ai-core";
import { tokens } from "../lib/similarity-core";
import { loadCorpus, type Role } from "./calibration-utils";

const roles: Role[] = ["index-source", "similarity-calibration", "ai-negative", "ai-benchmark", "ai-positive", "ai-hybrid"];

function percentile(sorted: number[], fraction: number) {
  if (!sorted.length) return 0;
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

const report = Object.fromEntries(roles.map((role) => {
  const documents = loadCorpus(role, "corpus", { allowEmpty: role === "ai-positive" || role === "ai-hybrid" });
  const wordCounts = documents.map((document) => tokens(document.text).length).sort((a, b) => a - b);
  const years = documents.reduce<Record<string, number>>((result, document) => {
    if (document.publishedYear !== null) result[String(document.publishedYear)] = (result[String(document.publishedYear)] ?? 0) + 1;
    return result;
  }, {});
  const populations = documents.reduce<Record<string, number>>((result, document) => {
    if (document.writerPopulation) result[document.writerPopulation] = (result[document.writerPopulation] ?? 0) + 1;
    return result;
  }, {});
  const missingWriterPopulation = documents.filter((document) => document.writerPopulation === null).length;
  const missingGenre = documents.filter((document) => document.genre === null).length;
  const extractionMethods = documents.reduce<Record<string, number>>((result, document) => {
    const method = document.provenance.extractionMethod;
    if (typeof method === "string" && method) result[method] = (result[method] ?? 0) + 1;
    return result;
  }, {});
  const referenceGroups = documents.reduce<Record<string, number>>((result, document) => {
    if (document.referenceGroup) result[document.referenceGroup] = (result[document.referenceGroup] ?? 0) + 1;
    return result;
  }, {});
  const referenceStatuses = documents.reduce<Record<string, number>>((result, document) => {
    if (document.referenceStatus) result[document.referenceStatus] = (result[document.referenceStatus] ?? 0) + 1;
    return result;
  }, {});
  return [role, {
    documentCount: documents.length,
    wordCounts: {
      minimum: wordCounts[0] ?? null,
      p25: percentile(wordCounts, 0.25),
      median: percentile(wordCounts, 0.5),
      p75: percentile(wordCounts, 0.75),
      maximum: wordCounts[wordCounts.length - 1] ?? null,
      mean: wordCounts.length ? Math.round(wordCounts.reduce((total, count) => total + count, 0) / wordCounts.length) : null,
    },
    belowAiMinimumWords: wordCounts.filter((count) => count < AI_MINIMUM_WORDS).length,
    publicationYearHistogram: years,
    writerPopulations: populations,
    writerPopulationCoverage: {
      requiredForRole: role === "ai-negative",
      populated: documents.length - missingWriterPopulation,
      null: missingWriterPopulation,
      missingRequired: role === "ai-negative" ? missingWriterPopulation : 0,
      nullMeaning: role === "ai-benchmark"
        ? "Reference-only English publication; no writer population inferred without affiliation evidence."
        : role === "index-source" || role === "similarity-calibration"
          ? "Not required for similarity indexing or calibration."
          : null,
    },
    genreCoverage: {
      requiredForRole: false,
      populated: documents.length - missingGenre,
      null: missingGenre,
    },
    extractionMethods,
    referenceGroups,
    referenceStatuses,
  }];
}));

console.log(JSON.stringify({ schema: "turnitplus-corpus-validation", version: 1, roles: report }, null, 2));
