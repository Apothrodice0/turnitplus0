import type { AcademicSearchStatus } from "@/lib/academic-search/types";
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

/** USER-SUPPLIED REFERENCES V1 — the reference-file channel's own state.
 *  null / absent = no reference files were supplied (channel ABSENT, NOT failed).
 *  "COMPLETE" = every supplied reference was extracted and matcher-checked.
 *  "PARTIAL" = one or more supplied references failed extraction / had no usable
 *  text (the report is still produced; this contributes a PARTIAL completion). */
export type UserSuppliedReferenceBranchState = "COMPLETE" | "PARTIAL" | null;

export type ReportCompletion = {
  state: ReportCompletionState;
  /** short line for the top of the report. */
  headline: string;
  /** one extra sentence when state !== COMPLETED, else null. */
  detail: string | null;
  /** every contributing reason, preserved even though one primary state is chosen. */
  reasons: string[];
  signals: {
    academicSearch: AcademicSearchStatus | null;
    selectiveCorpus: SelectiveCorpusBranchState | null;
    extraction: ReportExtractionCompleteness;
    /** candidate sources identified but not text-verified (rank-ordered upstream). */
    unverifiedCandidateCount: number;
    /** USER-SUPPLIED REFERENCES V1 — null when no reference files were supplied. */
    userSuppliedReference: UserSuppliedReferenceBranchState;
  };
};

export type ResolveReportCompletionInput = {
  academicSearch?: AcademicSearchStatus | null;
  selectiveCorpus?: SelectiveCorpusBranchState | null;
  extraction?: ReportExtractionDiagnostic | null;
  unverifiedCandidateCount?: number;
  /** USER-SUPPLIED REFERENCES V1 — the reference-file channel state, or null when
   *  no reference files were supplied (channel ABSENT — never a failure). */
  userSuppliedReference?: UserSuppliedReferenceBranchState;
  /** for the PARTIAL/SOURCE_UNAVAILABLE detail sentence. */
  verifiedSimilarityPercent?: number;
};

const HEADLINE: Record<ReportCompletionState, string> = {
  COMPLETED: "Search completed within the available TurnitPlus source scope.",
  PARTIAL: "Some source searches were unavailable. Results may be incomplete.",
  SOURCE_UNAVAILABLE: "A candidate source was identified but its text could not be verified.",
  EXTRACTION_PARTIAL: "Part of the uploaded document could not be analyzed.",
};

export function resolveReportCompletion(input: ResolveReportCompletionInput): ReportCompletion {
  const academicSearch = input.academicSearch ?? null;
  const selectiveCorpus = input.selectiveCorpus ?? null;
  const extraction: ReportExtractionCompleteness = input.extraction?.completeness ?? "UNKNOWN";
  const unverifiedCandidateCount = Math.max(0, input.unverifiedCandidateCount ?? 0);
  const userSuppliedReference: UserSuppliedReferenceBranchState = input.userSuppliedReference ?? null;
  const pct = input.verifiedSimilarityPercent;

  const reasons: string[] = [];
  if (extraction === "PARTIAL") reasons.push("document extraction reported unread content");
  if (academicSearch === "FAILED") reasons.push("the live academic-source search could not complete");
  if (selectiveCorpus === "PARTIAL") reasons.push("part of the TurnitPlus reference index was unavailable at search time");
  if (selectiveCorpus === "UNAVAILABLE") reasons.push("the TurnitPlus reference index could not be loaded");
  if (userSuppliedReference === "PARTIAL") reasons.push("one or more supplied reference files could not be read");
  if (unverifiedCandidateCount > 0) {
    reasons.push(`${unverifiedCandidateCount} candidate source${unverifiedCandidateCount === 1 ? "" : "s"} could not be text-verified`);
  }

  let state: ReportCompletionState = "COMPLETED";
  if (extraction === "PARTIAL") state = "EXTRACTION_PARTIAL";
  else if (
    academicSearch === "FAILED" ||
    selectiveCorpus === "PARTIAL" ||
    selectiveCorpus === "UNAVAILABLE" ||
    userSuppliedReference === "PARTIAL"
  ) state = "PARTIAL";
  else if (unverifiedCandidateCount > 0) state = "SOURCE_UNAVAILABLE";

  let detail: string | null = null;
  if (state === "PARTIAL") {
    detail = pct != null
      ? `The ${pct}% shown is a lower bound — a source we could not reach may add more.`
      : "The result shown is a lower bound — a source we could not reach may add more.";
  } else if (state === "SOURCE_UNAVAILABLE") {
    detail = `${unverifiedCandidateCount} possible source${unverifiedCandidateCount === 1 ? " is" : "s are"} listed separately as “identified, not verified” and ${unverifiedCandidateCount === 1 ? "is" : "are"} not included${pct != null ? ` in the ${pct}%` : ""}.`;
  } else if (state === "EXTRACTION_PARTIAL") {
    const skipped = skippedUnitCount(input.extraction ?? { completeness: "PARTIAL", analyzableWordCount: null, skipped: null, extractor: null });
    const unit = input.extraction?.skipped?.unit ?? "sections";
    detail = skipped > 0
      ? `About ${skipped} ${unit} of the file could not be read and ${skipped === 1 ? "was" : "were"} skipped. Re-upload a text-based copy for a complete result.`
      : "Some of the file could not be read and was skipped. Re-upload a text-based copy for a complete result.";
  }

  return {
    state,
    headline: HEADLINE[state],
    detail,
    reasons,
    signals: { academicSearch, selectiveCorpus, extraction, unverifiedCandidateCount, userSuppliedReference },
  };
}
