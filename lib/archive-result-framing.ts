import { detectLanguage, grams, normalize, tokens, type DetectedLanguage } from "./similarity-core";
import type { ArchiveScoringResult, ArchiveScoringSource } from "./archive-similarity-scoring";

/**
 * 100k-scale architecture, slice 2E — the browser-worker's own risk /
 * quotation / reference-list / repeated-phrase FRAMING, lifted VERBATIM out of
 * app/similarity-worker.ts's analyze() so the exact same rules run on top of
 * both posting sources:
 *
 *   - the browser static packed index (app/similarity-worker.ts), and
 *   - the server DB-backed matcher (lib/archive-corpus-matching.ts, reached
 *     through lib/archive-server-analysis.ts / app/api/archive/match).
 *
 * This file knows NOTHING about how the ArchiveScoringResult was produced — it
 * only re-frames one. Pure and synchronous; every helper it calls
 * (tokens/grams/normalize/detectLanguage) is imported unmodified from
 * lib/similarity-core.ts, the same module app/similarity-worker.ts uses. The
 * scoring itself (lib/archive-similarity-scoring.ts's scoreAgainstArchive) is
 * untouched — see that file's own header.
 *
 * ArchiveAnalysisResult is the FROZEN public worker-result contract every
 * existing consumer of app/similarity-worker.ts's postMessage already reads
 * (lib/document-check-pipeline.ts's analyzeText, and through it every
 * SimilarityReport field). Nothing here adds, removes, or renames a field —
 * a change to this shape is a change to that contract.
 */

export type ArchiveScoreBand = { label: "Low" | "Moderate" | "High"; minimum: number; maximum: number };

export type ArchiveFramingConfig = {
  /** document-index.meta.json's scoreBands — the score→band lookup table. */
  scoreBands: ArchiveScoreBand[];
  /** document-index.meta.json's corpusVersion — echoed straight back out. */
  corpusVersion: string;
  /** risk-calibration.json's headline numbers. */
  risk: {
    targetThreshold: number;
    archiveCutoff: number;
    auc: number;
    precision: number;
    recall: number;
    sampleSize: number;
  };
};

/** ArchiveScoringSource minus sourceIndex — exactly what the browser worker
 *  has always emitted (SourceMatch-compatible; see lib/report-types.ts). */
export type ArchiveAnalysisSource = Omit<ArchiveScoringSource, "sourceIndex">;

export type ArchiveAnalysisResult = {
  wordCount: number;
  databaseSize: number;
  excludedDocuments: number;
  matchedWordCount: number;
  archiveMatchedPositions: number[];
  score: number;
  scoreBand: "Low" | "Moderate" | "High";
  riskStatus: "Elevated" | "Lower";
  riskTarget: number;
  riskCutoff: number;
  riskCalibration: { auc: number; precision: number; recall: number; sampleSize: number };
  features: {
    maxSourceContainment: number;
    longestMatchedSpan: number;
    quotationDensity: number;
    referenceListRatio: number;
    highFrequencyShingleCount: number;
    repeatedThreeGramCount: number;
    detectedLanguage: DetectedLanguage;
  };
  corpusVersion: string;
  sources: ArchiveAnalysisSource[];
  repeats: [string, number][];
};

/**
 * Re-frame one ArchiveScoringResult into the frozen public worker-result
 * shape. Statement-for-statement identical to the tail of
 * app/similarity-worker.ts's old inline analyze() (the repeated-3-gram scan,
 * the scoreBand lookup, the quotation/reference-list ratios, the risk status,
 * and the sourceIndex strip) — its extraction here is purely so the server
 * path cannot drift from it.
 */
export function frameArchiveResult(
  text: string,
  result: ArchiveScoringResult,
  config: ArchiveFramingConfig,
): ArchiveAnalysisResult {
  const words = tokens(text);
  const triples = grams(words, 3);
  const frequency = triples.reduce<Record<string, number>>((total, gram) => {
    total[gram] = (total[gram] ?? 0) + 1;
    return total;
  }, {});
  const repeats = Object.entries(frequency)
    .filter(([gram, count]) => count >= 3 && !/^(the|and|for|with|that|this|from|into|have|has|was|were)\b/.test(gram))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  const scoreBand = config.scoreBands.find(
    (candidate) => result.score >= candidate.minimum && result.score <= candidate.maximum,
  )?.label ?? "High";
  const completeWordCount = normalize(text).split(" ").filter(Boolean).length;
  const referenceListRatio = Math.max(0, (completeWordCount - result.wordCount) / Math.max(1, completeWordCount));
  const quotedWordCount = [...text.matchAll(/["“«]([\s\S]*?)["”»]/g)]
    .reduce((total, match) => total + tokens(match[1]).length, 0);
  const quotationDensity = quotedWordCount / Math.max(1, completeWordCount);
  const riskStatus = result.score >= config.risk.archiveCutoff ? "Elevated" : "Lower";

  return {
    wordCount: result.wordCount,
    databaseSize: result.databaseSize,
    excludedDocuments: result.excludedDocuments,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    score: result.score,
    scoreBand,
    riskStatus,
    riskTarget: config.risk.targetThreshold,
    riskCutoff: config.risk.archiveCutoff,
    riskCalibration: {
      auc: config.risk.auc,
      precision: config.risk.precision,
      recall: config.risk.recall,
      sampleSize: config.risk.sampleSize,
    },
    features: {
      maxSourceContainment: result.maxSourceContainment,
      longestMatchedSpan: result.longestMatchedSpan,
      quotationDensity: Math.round(quotationDensity * 1000) / 1000,
      referenceListRatio: Math.round(referenceListRatio * 1000) / 1000,
      highFrequencyShingleCount: result.highFrequencyShingleCount,
      repeatedThreeGramCount: repeats.length,
      detectedLanguage: detectLanguage(text),
    },
    corpusVersion: config.corpusVersion,
    sources: result.sources.map(({ sourceIndex: _sourceIndex, ...source }) => source),
    repeats,
  };
}
