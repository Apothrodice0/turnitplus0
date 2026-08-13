import type { WebCheckResult } from "@/lib/web-check-core";
import type { ReportSummary } from "@/lib/reports-remote";
import { AI_SCORING_VERSION, calibratedAiDisplaySignal } from "@/lib/ai-core";

export type SourceType = "Internet" | "Publication";
export type ReportMode = "ai" | "similarity";
export type ResultTab = "full" | "overview" | "submission" | "sources";

export type SourceMatch = {
  name: string;
  type: SourceType;
  percent: number;
  matches: number;
  matchedWords?: number;
  phrases: string[];
  color: string;
};

export type AiPassage = {
  start: number;
  end: number;
  wordStart: number;
  wordEnd: number;
  text: string;
  wordCount: number;
  probability: number;
  logOdds?: number;
  flagged?: boolean;
  tokenStart?: number;
  tokenEnd?: number;
  tokenCount?: number;
  wasTruncated?: boolean;
};

export type AiAnalysis = {
  status: "complete" | "unsupported" | "error";
  score: number | null;
  model: string;
  engine: "WebGPU" | "CPU" | null;
  threshold: number;
  thresholdLogOdds?: number;
  eligibleWordCount: number;
  analyzedWordCount: number;
  passages: AiPassage[];
  meanProbability?: number;
  maxProbability?: number;
  top3MeanLogOdds?: number | null;
  coveragePercent?: number;
  medianLogOdds?: number | null;
  flaggedWordCount?: number;
  flaggedPassageCount?: number;
  analyzedTokenCount?: number;
  flaggedTokenCount?: number;
  truncatedPassageCount?: number;
  populationPercentile?: number | null;
  scoringVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  error?: string;
};

export type AiSignalTone = "low" | "review" | "high" | "unavailable";
export type AiSignalDisplay = {
  value: number | null;
  tone: AiSignalTone;
  label: string;
  detail: string;
  range: string;
};

export type SimilarityReport = {
  version: 11;
  id: number;
  submissionId: string;
  title: string;
  author: string;
  assignment: string;
  created: string;
  score: number;
  archiveScore?: number;
  aiScore?: number | null;
  aiAnalysis?: AiAnalysis;
  webCheck?: WebCheckResult;
  wordCount: number;
  characterCount: number;
  pageCount: number;
  fileSize: string;
  databaseSize: number;
  corpusVersion: string;
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
    detectedLanguage: "Arabic" | "French" | "English" | "Mixed";
  };
  excludedDocuments: number;
  matchedWordCount: number;
  archiveMatchedPositions?: number[];
  wikipediaMatchedWordCount?: number;
  sources: SourceMatch[];
  repeats: [string, number][];
  text: string;
};

export type HighlightRange = {
  start: number;
  end: number;
  sourceIndex: number;
  color: string;
  label: string;
  kind: "source" | "wikipedia";
  url?: string;
  wikipediaSources?: Array<{ pageId: number; title: string; url: string }>;
};

export const SIMILARITY_BAND_LABELS = {
  low: "Low archive overlap",
  review: "Moderate archive overlap",
  high: "High archive overlap",
} as const;

export const ARCHIVE_DOCUMENT_FALLBACK = 230;

export function archiveDocumentCount(corpusVersion: string) {
  const match = corpusVersion.match(/^archive-v\d+-(\d+)-/);
  return match ? Number(match[1]) : null;
}

export function archiveScopeCount(report: SimilarityReport) {
  return archiveDocumentCount(report.corpusVersion) ?? report.databaseSize ?? ARCHIVE_DOCUMENT_FALLBACK;
}

export function archiveOverlapScore(report: SimilarityReport) {
  return report.archiveScore ?? report.score;
}

export function archiveMatchedWordCount(report: SimilarityReport) {
  return report.archiveMatchedPositions?.length
    ?? Math.max(0, report.matchedWordCount - (report.wikipediaMatchedWordCount ?? 0));
}

export function sourceMatchedWordCount(source: SourceMatch, report: SimilarityReport) {
  return source.matchedWords ?? Math.round((source.percent / 100) * report.wordCount);
}

export function aiSignalDisplay(report: SimilarityReport): AiSignalDisplay {
  const analysis = report.aiAnalysis;
  if (analysis?.status === "unsupported") {
    return {
      value: null,
      tone: "unavailable",
      label: "Not enough text",
      detail: "Fewer than 300 eligible English words were available, so no AI percentage was calculated.",
      range: "No AI result",
    };
  }
  if (analysis?.status === "error") {
    return {
      value: null,
      tone: "unavailable",
      label: "Analysis unavailable",
      detail: analysis.error ?? "The local AI analysis did not finish.",
      range: "Try again",
    };
  }
  const normalizedSignal = analysis?.status === "complete"
    && analysis.scoringVersion === AI_SCORING_VERSION
    && typeof analysis.medianLogOdds === "number"
    ? calibratedAiDisplaySignal(analysis.medianLogOdds)
    : null;
  if (normalizedSignal === null) {
    return {
      value: null,
      tone: "unavailable",
      label: "AI report pending",
      detail: "Run the AI analysis to calculate the document's AI writing score.",
      range: "No result yet",
    };
  }
  const value = normalizedSignal.score;
  const scoreDetail = "The score is calculated from the language patterns found across the document's analyzed passages.";
  if (value < 20) {
    return {
      value,
      tone: "low",
      label: "Low AI indicators",
      detail: scoreDetail,
      range: "Green · 0–19%",
    };
  }
  if (value <= 50) {
    return {
      value,
      tone: "review",
      label: "Moderate AI indicators",
      detail: scoreDetail,
      range: "Blue · 20–50%",
    };
  }
  return {
    value,
    tone: "high",
    label: "Strong AI indicators",
    detail: scoreDetail,
    range: "Red · 51–100%",
  };
}

export function buildReportSummary(report: SimilarityReport): ReportSummary {
  const aiSignal = aiSignalDisplay(report);
  return {
    id: String(report.id),
    submissionId: report.submissionId,
    title: report.title,
    createdAt: report.created,
    wordCount: report.wordCount,
    archiveScore: archiveOverlapScore(report),
    scoreBand: report.scoreBand,
    aiScore: aiSignal.value,
    aiTone: aiSignal.tone,
  };
}
