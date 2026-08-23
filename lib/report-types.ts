import type { WebCheckResult } from "@/lib/web-check-core";
import type { ReportSummary } from "@/lib/reports-remote";
import type { AcademicSearchStatus, ExternalAcademicEvidence } from "@/lib/academic-search/types";
import type { UnifiedSimilarityResult } from "@/lib/unified-similarity";
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
  /** TURNITPLUS_CORPUS_SOURCE: matched an actively promoted corpus-admission source, not any account's own submission — see lib/user-submission-matching.ts's own RelationshipType comment. Gated by CORPUS_SOURCE_MATCHING_ENABLED; stripped at read time when that flag is off, regardless of what a cached snapshot contains — see lib/report-historical-match.ts. */
  relationshipType: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP" | "TURNITPLUS_CORPUS_SOURCE";
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
  /** True when the underlying matchAgainstUserSubmissionCorpus call hit its soft time budget before finishing every candidate — see that function's own TIMEOUT HONESTY comment. A partial result is treated as never-final (see lib/report-historical-match.ts's own isCurrentVersion caller) — always recomputed on next view, the same "never cache the incomplete case as settled" rule NO_HISTORICAL_MATCH already gets. Absent/undefined means the computation ran to completion. */
  partial?: boolean;
};

/**
 * Phase E8P.3: the FIRST user-visible surface for the proposed experimental
 * historical-match policy — deliberately a SEPARATE field from
 * ReportHistoricalSubmissionMatch above, never merged into or read as a
 * substitute for it. Only ever constructed by lib/e8p-visibility.ts, only
 * ever for an explicitly allowlisted internal/test account (see that file's
 * own header comment), and only ever when production's own
 * historicalSubmissionMatch.status is NO_HISTORICAL_MATCH — this never
 * appears alongside, competes with, or overrides a real production match.
 * status is always the literal "HISTORICAL_PARTIAL_MATCH" (the one new case
 * production can't see) — nothing else ever populates this field, so its
 * mere presence is itself the display condition. passages are bounded
 * excerpts of the CURRENT report's own text only, same privacy property as
 * HistoricalMatchPassage above. disclaimer is reused verbatim from its own
 * source, not re-authored here — see lib/e8p-visibility.ts.
 */
export type ExperimentalHistoricalMatchDisplay = {
  status: "HISTORICAL_PARTIAL_MATCH";
  relationship: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP";
  evidence: string;
  matchedWordCount: number;
  containment: number;
  passageCount: number;
  passages: HistoricalMatchPassage[];
  disclaimer: string;
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
  /** Phase E8P.3 enrichment — see ExperimentalHistoricalMatchDisplay's own comment. Absent for every account outside the explicit allowlist, and absent whenever historicalSubmissionMatch already has a real production match. */
  experimentalHistoricalMatch?: ExperimentalHistoricalMatchDisplay;
  /** Phase E8S Step 11 enrichment — see lib/e8s-report-integration.ts's own comment. Absent for every account outside E8S_REUSE_CONTEXT_ALLOWLIST, or if this report's own document identity can't be resolved. Never decides what renders by itself — only tells the client which ids to fetch fresh state for. */
  reuseContext?: { documentIdentityId: string; representationId: string | null };
  aiScore?: number | null;
  aiAnalysis?: AiAnalysis;
  webCheck?: WebCheckResult;
  /**
   * Phase 3 enrichment, external academic-source evidence from
   * lib/academic-search/ (OpenAIRE + Europe PMC). "start the two fixes now"
   * TASK 1 changed WHEN this is computed: app/page.tsx's generateReport()
   * now awaits the academic search alongside archive analysis, before the
   * report is ever shown or saved, rather than backgrounding it and
   * silently re-saving a changed score later — this field (and
   * academicEvidenceStatus below) are therefore final by the time a new
   * report is first saved, not a placeholder to be topped up. Still never
   * folded into score/archiveScore/matchedWordCount — see this phase's own
   * PRIMARY PRODUCT RULE: TurnitPlus's own corpus similarity stays the
   * single, unambiguous headline number, and external academic overlap is
   * reported next to it, never combined with it directly (only through
   * unifiedSimilarity's own explicit dedup — see lib/unified-similarity.ts).
   * Absent/undefined means this report predates Phase 3.
   */
  externalAcademicEvidence?: ExternalAcademicEvidence[];
  /**
   * "start the two fixes now" TASK 2: the outcome of the academic search
   * that produced externalAcademicEvidence above — see
   * lib/academic-search/types.ts's own AcademicSearchStatus comment for the
   * exact three-way rule. Read this before treating an empty/absent
   * externalAcademicEvidence as "nothing found": COMPLETE_NO_MATCHES means
   * that; FAILED means the check itself could not get a real answer from
   * either provider and must be shown as unavailable, never as a silent
   * zero. Absent/undefined means this report predates this field (Phase 3
   * without it, or any report saved before this task).
   */
  academicEvidenceStatus?: AcademicSearchStatus;
  /**
   * Phase 4A — EXPERIMENTAL, additive only. Output of
   * lib/unified-similarity.ts's computeUnifiedSimilarity(), which is NOT
   * called anywhere in report generation yet (see that file's own header
   * comment) — this field only ever gets populated by whatever future
   * phase decides to wire it in, and by test/benchmark code in the
   * meantime. Never read by, or written into, score/archiveScore/aiScore/
   * verifiedSimilarity/E8S/E8P, and never required: every consumer of
   * SimilarityReport must keep working identically whether this field is
   * present, absent, or from a report saved before Phase 4A existed.
   */
  unifiedSimilarity?: UnifiedSimilarityResult;
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

export const PRIMARY_SIMILARITY_BAND_LABELS = {
  low: "Low similarity",
  review: "Moderate similarity",
  high: "High similarity",
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

/**
 * Phase 7: the customer-facing headline number — "TurnitPlus Similarity."
 * Prefers the unified result (archive + verified live academic evidence +
 * eligible previous-submission evidence, deduplicated into one set of
 * matched positions — see lib/unified-similarity.ts) whenever it has been
 * computed for this report; falls back to the existing archive-only score
 * for a report where it hasn't (a legacy report saved before Phase 6, or
 * the rare case where the read-time computation itself failed). Never
 * reads or derives from report.score/archiveScore directly beyond that
 * fallback — this is a DISPLAY selection, not a new scoring computation,
 * and report.score/archiveScore themselves are untouched by its existence.
 */
export function primarySimilarityScore(report: SimilarityReport) {
  return report.unifiedSimilarity?.unifiedScore ?? archiveOverlapScore(report);
}

/** True when primarySimilarityScore(report) reflects the full unified result rather than the archive-only fallback. */
export function hasUnifiedSimilarity(report: SimilarityReport): boolean {
  return report.unifiedSimilarity !== undefined;
}

/**
 * Release-hardening audit finding SIM-01: the word-count partner to
 * primarySimilarityScore — same fallback rule (unified when computed,
 * archive-only otherwise), so a matched-word-count sentence displayed next
 * to primarySimilarityScore's percentage can never cite a different,
 * contradicting source's word count. Before this existed, several surfaces
 * paired primarySimilarityScore (correctly preferring unifiedSimilarity)
 * with archiveMatchedWordCount (never preferring it) — a report whose
 * unified result came primarily from live-academic or prior-submission
 * evidence, not the archive, showed a headline percentage next to a matched-
 * word count that described a mostly-unrelated, much smaller figure.
 */
export function primaryMatchedWordCount(report: SimilarityReport): number {
  return report.unifiedSimilarity?.uniqueMatchedWords ?? archiveMatchedWordCount(report);
}

/**
 * The customer-facing label paired with primarySimilarityScore —
 * "TurnitPlus Similarity" whenever the unified result is what's being
 * shown, "Similarity result" for the archive-only fallback. Single source
 * for wording that was previously duplicated inline (and could drift) in
 * app/reports/[id]/report-detail-shell.tsx and, after this fix,
 * components/report/similarity-report-papers.tsx's OverviewReport.
 */
export function primaryResultLabel(report: SimilarityReport): string {
  return hasUnifiedSimilarity(report) ? "TurnitPlus Similarity" : "Similarity result";
}

/**
 * Phase 7 PRIORITY 6: a short, plain-language list of which evidence
 * channels contributed matched words to the unified score — for surfaces
 * (the receipt PDF) that show one summary line rather than the full
 * per-source breakdown UnifiedSimilaritySection already renders. Reads
 * only the *OnlyWords/overlapWords counts, never contributions (those stay
 * internal-only per UnifiedEvidenceContribution's own comment). Returns
 * "no matched sources" rather than an empty string so the PDF never prints
 * a blank value.
 */
export function unifiedEvidenceSummary(unified: UnifiedSimilarityResult): string {
  const parts: string[] = [];
  if (unified.archiveOnlyWords > 0 || unified.overlapWords > 0) parts.push("own reference material");
  if (unified.liveAcademicOnlyWords > 0) parts.push("live academic sources");
  if (unified.previousUploadOnlyWords > 0) parts.push("a prior submission");
  if (parts.length === 0) return "no matched sources";
  return parts.join(", ");
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
    // Release-hardening audit finding SIM-01: additive only — archiveScore
    // above is untouched, still the pure archive-only value. Whenever this
    // function is called, the caller already holds the full report (see
    // ReportSummary's own comment on primaryScore for why the lightweight,
    // DB-only room/history endpoints never go through this function at
    // all), so surfacing primarySimilarityScore/hasUnifiedSimilarity here
    // costs nothing extra and lets any room/history card display the same
    // combined result the detail page would show, instead of only ever
    // the archive component.
    primaryScore: primarySimilarityScore(report),
    isUnified: hasUnifiedSimilarity(report),
    scoreBand: report.scoreBand,
    aiScore: aiSignal.value,
    aiTone: aiSignal.tone,
  };
}
