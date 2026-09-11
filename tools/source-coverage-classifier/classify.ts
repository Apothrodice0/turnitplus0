import { classifyAcademicSearchCase, type AcademicSearchCaseInput } from "./academic-search-lane";
import { classifySelectiveCorpusCase, type SelectiveCorpusCaseInput } from "./selective-corpus-lane";
import type { SourceCoverageClassification } from "./types";

/** Lane-tagged case input — dispatches to the matching lane's own classifier, never a shared/generic classification path (see each lane file's own header comment for why the two must stay separate). */
export type SourceCoverageCaseInput =
  | ({ lane: "ACADEMIC_SEARCH" } & AcademicSearchCaseInput)
  | ({ lane: "SELECTIVE_CORPUS" } & SelectiveCorpusCaseInput);

export function classifySourceCoverageCase(input: SourceCoverageCaseInput): SourceCoverageClassification {
  if (input.lane === "ACADEMIC_SEARCH") return classifyAcademicSearchCase(input);
  return classifySelectiveCorpusCase(input);
}

export type {
  SourceCoverageLane,
  SourceCoverageOutcome,
  SourceCoverageFailureStage,
  SourceCoverageClassification,
  MatcherDiagnosticsSummary,
  AdmissionDiagnosticsSummary,
  VerifiedWordSpan,
} from "./types";
export { SourceCoverageInputError, SourceCoverageSpanValidationError } from "./types";
export { unionVerifiedWordCount } from "./verified-word-count";
export {
  classifyAcademicSearchCase,
  type AcademicSearchCaseInput,
  type AcademicSearchGroundTruth,
  type AcademicSearchDiscoveryOutcome,
  type AcademicSearchRetrievalOutcome,
} from "./academic-search-lane";
export {
  classifySelectiveCorpusCase,
  type SelectiveCorpusCaseInput,
  type SelectiveCorpusGroundTruth,
  type SelectiveCorpusStageAInput,
  type SelectiveCorpusSourceTextInput,
} from "./selective-corpus-lane";
