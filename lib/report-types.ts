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

// Phase D: account-based match classification (SELF vs PRIOR_SUBMISSION),
// bridged in from the document-identity/family system (lib/document-family.ts,
// lib/document-relationship.ts) by lib/report-classification.ts — kept out of
// that system's own modules so they stay report-agnostic, per their own
// header comments. Populated only when a saved report is *read back*
// (app/reports/[id]/page.tsx, GET /api/reports/[id]); never present on a
// freshly-analyzed, not-yet-saved report, since the underlying family
// resolution runs only after a save (see lib/run-after-response.ts).
// Deliberately independent of `score`/`archiveScore` below (the verified-
// source/archive similarity percentage) — nothing here is ever added into,
// subtracted from, or otherwise mixed with that calculation; see
// lib/report-classification.ts's own comment for why and how.
export type ReportMatchClassification = {
  /** 0-100, or null if no SELF-classified match exists for this report. Never inflates `score`. */
  selfMatchPercent: number | null;
  /** 0-100, or null if no PRIOR_SUBMISSION-classified match exists for this report. Never inflates `score`, and never identifies the other account. */
  priorSubmissionPercent: number | null;
};

/**
 * Phase E8C. A standalone, hand-written mirror of
 * lib/user-submission-matching.ts's UserSubmissionMatch/CorrespondencePassage
 * shapes — deliberately NOT imported from that module, exactly like
 * ReportMatchClassification above never imports lib/document-family.ts: this
 * file never imports a feature module (see this file's own existing
 * convention). externalWordStart is intentionally dropped (always null —
 * see lib/document-correspondence.ts's own comment on why) and no per-entry
 * version fields are kept, since every entry in one snapshot shares the
 * top-level version fields on ReportHistoricalSubmissionMatch below.
 */
export type HistoricalMatchPassage = {
  /** A bounded excerpt of the CURRENT report's own text — never the historical document's text. */
  submittedText: string;
  submittedWordStart: number;
  submittedWordEnd: number;
  matchedWordCount: number;
};

export type HistoricalSubmissionMatchEntry = {
  relationshipType: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP";
  matchedRepresentationId: string;
  matchType: "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";
  containment: number;
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
  passages: HistoricalMatchPassage[];
  /** How many OTHER accounts (never which ones) have also submitted this content. */
  historicalSubmissionCount: number;
};

/**
 * Phase E8C enrichment — a snapshot of lib/user-submission-matching.ts's
 * matchAgainstUserSubmissionCorpus, cached in report_historical_match_snapshots
 * and attached at read time (see lib/report-historical-match.ts). Completely
 * independent of `score`/`archiveScore`/ReportMatchClassification above —
 * three separate signals, never combined arithmetically. "UNAVAILABLE" means
 * the computation itself failed (see lib/report-historical-match.ts) — the
 * report must still render normally when this happens.
 */
export type ReportHistoricalSubmissionMatch = {
  status: "MATCHED" | "NO_HISTORICAL_MATCH" | "UNAVAILABLE";
  matches?: HistoricalSubmissionMatchEntry[];
  computedAt: string;
  matcherVersion: string;
  fingerprintVersion: string;
  canonicalizationVersion: string;
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
  /** Phase D enrichment — see ReportMatchClassification's own comment. Absent on older/unsaved/not-yet-classified reports; the reporting layer must treat its absence as "nothing to show", not an error. */
  matchClassification?: ReportMatchClassification;
  /** Phase E8C enrichment — see ReportHistoricalSubmissionMatch's own comment. Absent on a freshly-analyzed, not-yet-saved report (the snapshot only exists once a saved_reports row does), or if computing it failed before even producing an UNAVAILABLE snapshot. */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch;
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
