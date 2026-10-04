import type { AcademicSearchFailureReason, AcademicSearchStatus } from "@/lib/academic-search/types";
import type { ReportExtractionCompleteness, ReportExtractionDiagnostic } from "./extraction";
import { skippedUnitCount } from "./extraction";

/**
 * PHASE 6 — ONE report-level completion state, chosen deterministically from
 * the separate branch signals. Detailed reasons are preserved internally even
 * though one primary state is chosen.
 *
 * Precedence (highest first):
 *   EXTRACTION_PARTIAL  document extraction explicitly incomplete
 *   PARTIAL             a configured source-search branch failed/degraded
 *   SOURCE_UNAVAILABLE  candidate source identified but its text was unverifiable
 *   COMPLETED           the declared TurnitPlus search workflow finished
 *
 * Copy is non-alarming and NEVER implies "the entire internet was searched".
 */

export type ReportCompletionState = "COMPLETED" | "PARTIAL" | "SOURCE_UNAVAILABLE" | "EXTRACTION_PARTIAL";

export type SelectiveCorpusBranchState = "COMPLETED" | "PARTIAL" | "DISABLED" | "UNAVAILABLE";

/**
 * Why a Selective Corpus authoritative run finalized "incomplete" — the
 * terminal shadow-result state that produced it (PARTIAL_INDEX = the PARTIAL
 * state: one or more index shards unavailable at query time), or
 * FINALIZER_ERROR when the finalizer's own fallback path landed it.
 * Server-internal on the saved row; surfaces only as a completion diagnostic.
 */
export type SelectiveCorpusIncompleteReason =
  | "PARTIAL_INDEX"
  | "TIMEOUT"
  | "ARTIFACT_UNAVAILABLE"
  | "FAILED"
  | "DISABLED"
  | "FINALIZER_ERROR";

/** USER-SUPPLIED REFERENCES V1 — the reference-file channel's own state.
 *  null / absent = no reference files were supplied (channel ABSENT, NOT failed).
 *  "COMPLETE" = every supplied reference was extracted and matcher-checked.
 *  "PARTIAL" = one or more supplied references failed extraction / had no usable
 *  text (the report is still produced; this contributes a PARTIAL completion). */
export type UserSuppliedReferenceBranchState = "COMPLETE" | "PARTIAL" | null;

/** The previous-submission (TurnitPlus corpus) check's own state.
 *  null = the check did not run for this report, or its outcome is unknown.
 *  "COMPLETE" = every discovered candidate that could score was examined —
 *  including when nothing matched, or when every match was the author's own
 *  (SELF) or of unknown ownership: those are correct exclusions, not gaps.
 *  "PARTIAL" = a candidate that could have scored was discovered but never
 *  verified (time budget, failed candidate query, over-size document), or the
 *  check itself failed. The similarity shown is then a lower bound.
 *  See lib/report-evidence-interpretation.ts's priorSubmissionBranchState. */
export type PriorSubmissionBranchState = "COMPLETE" | "PARTIAL" | null;

/** The channel a completion diagnostic is about. */
export type ReportCompletionChannel =
  | "DOCUMENT_EXTRACTION"
  | "LIVE_ACADEMIC_SEARCH"
  | "SELECTIVE_CORPUS"
  | "USER_SUPPLIED_REFERENCES"
  | "PRIOR_SUBMISSION"
  | "SOURCE_TEXT_VERIFICATION";

/**
 * MACHINE-READABLE completion diagnostics: one entry per channel that kept the
 * report from COMPLETED, with the most precise reason the saved report records.
 * NOT_RECORDED = the channel's state is known but the report predates reason
 * capture (or the reason was not a known code), or the channel records no
 * reason at all (the previous-submission check stores only that it was
 * partial) — never a guessed reason.
 * Generic codes only: never a provider name, URL, path or document identity.
 */
export type ReportCompletionDiagnosticReason =
  | AcademicSearchFailureReason
  | SelectiveCorpusIncompleteReason
  | "INDEX_UNAVAILABLE"
  | "REFERENCE_FILE_UNREADABLE"
  | "CONTENT_UNREAD"
  | "CANDIDATE_TEXT_UNAVAILABLE"
  | "NOT_RECORDED";

export type ReportCompletionDiagnostic = {
  channel: ReportCompletionChannel;
  reason: ReportCompletionDiagnosticReason;
};

export type ReportCompletion = {
  state: ReportCompletionState;
  /** short line for the top of the report. */
  headline: string;
  /** one extra sentence when state !== COMPLETED, else null. */
  detail: string | null;
  /** every contributing reason, preserved even though one primary state is chosen. */
  reasons: string[];
  /**
   * Machine-readable channel + reason for every contributing channel (empty for
   * COMPLETED). Optional: a completion persisted before diagnostics existed has
   * none — readers derive NOT_RECORDED entries from `signals` (see
   * completionDiagnosticsFromSignals).
   */
  diagnostics?: ReportCompletionDiagnostic[];
  signals: {
    academicSearch: AcademicSearchStatus | null;
    selectiveCorpus: SelectiveCorpusBranchState | null;
    extraction: ReportExtractionCompleteness;
    /** candidate sources identified but not text-verified (rank-ordered upstream). */
    unverifiedCandidateCount: number;
    /** USER-SUPPLIED REFERENCES V1 — null when no reference files were supplied. */
    userSuppliedReference: UserSuppliedReferenceBranchState;
    /** The previous-submission check. Absent on every report saved before this
     *  signal existed — read as null (unknown), never inferred. */
    priorSubmission?: PriorSubmissionBranchState;
  };
};

export type ResolveReportCompletionInput = {
  academicSearch?: AcademicSearchStatus | null;
  /** why academicSearch is FAILED — client-reported, so sanitized here to a known code. */
  academicSearchFailureReason?: unknown;
  selectiveCorpus?: SelectiveCorpusBranchState | null;
  /** why selectiveCorpus is PARTIAL — sanitized here to a known code. */
  selectiveCorpusIncompleteReason?: unknown;
  extraction?: ReportExtractionDiagnostic | null;
  unverifiedCandidateCount?: number;
  /** USER-SUPPLIED REFERENCES V1 — the reference-file channel state, or null when
   *  no reference files were supplied (channel ABSENT — never a failure). */
  userSuppliedReference?: UserSuppliedReferenceBranchState;
  /** The previous-submission check's state, or null when it did not run / is unknown. */
  priorSubmission?: PriorSubmissionBranchState;
  /** for the PARTIAL/SOURCE_UNAVAILABLE detail sentence. */
  verifiedSimilarityPercent?: number;
};

export const REPORT_COMPLETION_HEADLINE: Record<ReportCompletionState, string> = {
  COMPLETED: "Search completed within the available TurnitPlus source scope.",
  PARTIAL: "Partial search: some sources were unavailable.",
  SOURCE_UNAVAILABLE: "A candidate source was identified but its text could not be verified.",
  EXTRACTION_PARTIAL: "Part of the uploaded document could not be analyzed.",
};

/** The PARTIAL detail sentence: the verified score is a lower bound, completed channels still count, unavailable ones do not. */
export function partialCompletionDetail(verifiedSimilarityPercent: number | null | undefined): string {
  const shown = verifiedSimilarityPercent != null ? `The ${verifiedSimilarityPercent}% shown` : "The result shown";
  return `${shown} is a verified lower bound. Completed searches still produced valid evidence; sources we could not reach are not counted.`;
}

const ACADEMIC_SEARCH_FAILURE_REASONS: ReadonlySet<string> = new Set<AcademicSearchFailureReason>([
  "ALL_PROVIDER_CALLS_FAILED",
  "SEARCH_PIPELINE_ERROR",
  "RATE_LIMITED",
  "ROUTE_TIMEOUT",
  "SERVER_ERROR",
  "REQUEST_REJECTED",
  "NETWORK_ERROR",
  "MALFORMED_RESPONSE",
]);

const SELECTIVE_CORPUS_INCOMPLETE_REASONS: ReadonlySet<string> = new Set<SelectiveCorpusIncompleteReason>([
  "PARTIAL_INDEX",
  "TIMEOUT",
  "ARTIFACT_UNAVAILABLE",
  "FAILED",
  "DISABLED",
  "FINALIZER_ERROR",
]);

/** A known AcademicSearchFailureReason, else null — the value reaches the report from the browser, so it is never trusted verbatim. */
export function sanitizeAcademicSearchFailureReason(value: unknown): AcademicSearchFailureReason | null {
  return typeof value === "string" && ACADEMIC_SEARCH_FAILURE_REASONS.has(value) ? (value as AcademicSearchFailureReason) : null;
}

/** A known SelectiveCorpusIncompleteReason, else null. */
export function sanitizeSelectiveCorpusIncompleteReason(value: unknown): SelectiveCorpusIncompleteReason | null {
  return typeof value === "string" && SELECTIVE_CORPUS_INCOMPLETE_REASONS.has(value) ? (value as SelectiveCorpusIncompleteReason) : null;
}

/**
 * The diagnostics a completion's own `signals` imply, with the per-channel
 * reasons when known (NOT_RECORDED otherwise). Order is fixed (extraction,
 * academic, Selective Corpus, references, previous submissions, source
 * verification) so the same signals always produce the same list.
 */
export function completionDiagnosticsFromSignals(
  signals: ReportCompletion["signals"],
  reasons: { academicSearchFailureReason?: unknown; selectiveCorpusIncompleteReason?: unknown } = {},
): ReportCompletionDiagnostic[] {
  const diagnostics: ReportCompletionDiagnostic[] = [];
  if (signals.extraction === "PARTIAL") diagnostics.push({ channel: "DOCUMENT_EXTRACTION", reason: "CONTENT_UNREAD" });
  if (signals.academicSearch === "FAILED") {
    diagnostics.push({
      channel: "LIVE_ACADEMIC_SEARCH",
      reason: sanitizeAcademicSearchFailureReason(reasons.academicSearchFailureReason) ?? "NOT_RECORDED",
    });
  }
  if (signals.selectiveCorpus === "PARTIAL") {
    diagnostics.push({
      channel: "SELECTIVE_CORPUS",
      reason: sanitizeSelectiveCorpusIncompleteReason(reasons.selectiveCorpusIncompleteReason) ?? "NOT_RECORDED",
    });
  }
  if (signals.selectiveCorpus === "UNAVAILABLE") diagnostics.push({ channel: "SELECTIVE_CORPUS", reason: "INDEX_UNAVAILABLE" });
  if (signals.userSuppliedReference === "PARTIAL") {
    diagnostics.push({ channel: "USER_SUPPLIED_REFERENCES", reason: "REFERENCE_FILE_UNREADABLE" });
  }
  if (signals.priorSubmission === "PARTIAL") diagnostics.push({ channel: "PRIOR_SUBMISSION", reason: "NOT_RECORDED" });
  if (signals.unverifiedCandidateCount > 0) {
    diagnostics.push({ channel: "SOURCE_TEXT_VERIFICATION", reason: "CANDIDATE_TEXT_UNAVAILABLE" });
  }
  return diagnostics;
}

export function resolveReportCompletion(input: ResolveReportCompletionInput): ReportCompletion {
  const academicSearch = input.academicSearch ?? null;
  const selectiveCorpus = input.selectiveCorpus ?? null;
  const extraction: ReportExtractionCompleteness = input.extraction?.completeness ?? "UNKNOWN";
  const unverifiedCandidateCount = Math.max(0, input.unverifiedCandidateCount ?? 0);
  const userSuppliedReference: UserSuppliedReferenceBranchState = input.userSuppliedReference ?? null;
  const priorSubmission: PriorSubmissionBranchState = input.priorSubmission ?? null;
  const pct = input.verifiedSimilarityPercent;

  const reasons: string[] = [];
  if (extraction === "PARTIAL") reasons.push("document extraction reported unread content");
  if (academicSearch === "FAILED") reasons.push("the live academic-source search could not complete");
  if (selectiveCorpus === "PARTIAL") reasons.push("part of the TurnitPlus reference index was unavailable at search time");
  if (selectiveCorpus === "UNAVAILABLE") reasons.push("the TurnitPlus reference index could not be loaded");
  if (userSuppliedReference === "PARTIAL") reasons.push("one or more supplied reference files could not be read");
  if (priorSubmission === "PARTIAL") reasons.push("the previous-submission check could not examine every candidate");
  if (unverifiedCandidateCount > 0) {
    reasons.push(`${unverifiedCandidateCount} candidate source${unverifiedCandidateCount === 1 ? "" : "s"} could not be text-verified`);
  }

  let state: ReportCompletionState = "COMPLETED";
  if (extraction === "PARTIAL") state = "EXTRACTION_PARTIAL";
  else if (
    academicSearch === "FAILED" ||
    selectiveCorpus === "PARTIAL" ||
    selectiveCorpus === "UNAVAILABLE" ||
    userSuppliedReference === "PARTIAL" ||
    priorSubmission === "PARTIAL"
  ) state = "PARTIAL";
  else if (unverifiedCandidateCount > 0) state = "SOURCE_UNAVAILABLE";

  let detail: string | null = null;
  if (state === "PARTIAL") {
    detail = partialCompletionDetail(pct);
  } else if (state === "SOURCE_UNAVAILABLE") {
    detail = `${unverifiedCandidateCount} possible source${unverifiedCandidateCount === 1 ? " is" : "s are"} listed separately as “identified, not verified” and ${unverifiedCandidateCount === 1 ? "is" : "are"} not included${pct != null ? ` in the ${pct}%` : ""}.`;
  } else if (state === "EXTRACTION_PARTIAL") {
    const skipped = skippedUnitCount(input.extraction ?? { completeness: "PARTIAL", analyzableWordCount: null, skipped: null, extractor: null });
    const unit = input.extraction?.skipped?.unit ?? "sections";
    detail = skipped > 0
      ? `About ${skipped} ${unit} of the file could not be read and ${skipped === 1 ? "was" : "were"} skipped. Re-upload a text-based copy for a complete result.`
      : "Some of the file could not be read and was skipped. Re-upload a text-based copy for a complete result.";
  }

  const signals: ReportCompletion["signals"] = { academicSearch, selectiveCorpus, extraction, unverifiedCandidateCount, userSuppliedReference, priorSubmission };
  return {
    state,
    headline: REPORT_COMPLETION_HEADLINE[state],
    detail,
    reasons,
    diagnostics: completionDiagnosticsFromSignals(signals, {
      academicSearchFailureReason: input.academicSearchFailureReason,
      selectiveCorpusIncompleteReason: input.selectiveCorpusIncompleteReason,
    }),
    signals,
  };
}
