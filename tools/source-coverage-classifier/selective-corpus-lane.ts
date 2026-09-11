import { admitSelectiveCorpusCandidate, selectiveCorpusSubmissionWords } from "../../lib/selective-corpus/verify";
import type { SelectiveCorpusArtifact } from "../../lib/selective-corpus/artifact";
import {
  SourceCoverageInputError,
  type AdmissionDiagnosticsSummary,
  type MatcherDiagnosticsSummary,
  type SourceCoverageClassification,
} from "./types";
import { unionVerifiedWordCount } from "./verified-word-count";

/**
 * SELECTIVE_CORPUS lane.
 *
 * Reuses lib/selective-corpus/verify.ts's admitSelectiveCorpusCandidate
 * verbatim — the UNMODIFIED comparator + the frozen STRICT_SPAN
 * (SELECTIVE_CORPUS_STRICT_SPAN: 60 matched words AND 25 longest span) and
 * FAMILY_GUARD (SELECTIVE_CORPUS_FAMILY_GUARD) gates from
 * lib/selective-corpus/constants.ts. This module never imports those
 * constants directly and never overrides them — verify.ts is the only
 * reader. Deliberately NOT the academic-search minEvidenceSimilarity(15)
 * threshold — see academic-search-lane.ts for that lane's own, separate
 * evidence rule, and tests/source-coverage-classifier.test.mjs's lane-
 * isolation tests for proof the two never cross over.
 */

export type SelectiveCorpusGroundTruth = {
  /**
   * Explicit, out-of-band proof the expected source is not part of the
   * evaluated Selective Corpus artifact at all. Never inferred from Stage A
   * or matcher output; supplying this field is the ONLY way a case can
   * classify as SOURCE_ABSENT in this lane.
   */
  reasonCode: string;
  detail: string;
};

export type SelectiveCorpusStageAInput = {
  /** Did Stage A's bounded top-K surface the expected source's ordinal at all? */
  surfaced: boolean;
  candidateRank: number | null;
};

export type SelectiveCorpusSourceTextInput = {
  available: boolean;
  /** The candidate's stored raw corpus text — required exactly when available is true. */
  text?: string;
};

export type SelectiveCorpusCaseInput = {
  caseId: string;
  expectedSourceId: string;
  submissionText: string;
  groundTruthAbsent?: SelectiveCorpusGroundTruth;
  stageA: SelectiveCorpusStageAInput;
  /** Required exactly when stageA.surfaced is true; must be absent otherwise. */
  sourceText?: SelectiveCorpusSourceTextInput;
  /**
   * A local, in-memory fixture Selective Corpus artifact — e.g. built with
   * lib/selective-corpus/shard-reader.ts's own InMemoryPostingsAccessor (see
   * fixtures.ts). Required exactly when the matcher stage is reached
   * (source text available); must be absent otherwise. Never a real,
   * disk-backed production artifact path.
   */
  artifact?: SelectiveCorpusArtifact;
};

/** Validates internal consistency up front; throws SourceCoverageInputError on any contradiction or missing required field rather than resolving it by branch order. */
function assertConsistentInput(input: SelectiveCorpusCaseInput): void {
  const id = input.caseId;

  if (input.groundTruthAbsent && input.stageA.surfaced) {
    throw new SourceCoverageInputError(
      `selective-corpus case "${id}": groundTruthAbsent was supplied together with stageA.surfaced=true — a source cannot be both proven absent from the artifact and surfaced by Stage A.`,
    );
  }

  if (!input.stageA.surfaced) {
    if (input.sourceText !== undefined || input.artifact !== undefined) {
      throw new SourceCoverageInputError(`selective-corpus case "${id}": sourceText/artifact supplied for stageA.surfaced=false, which never reaches the retrieval/matcher stage in production.`);
    }
    return;
  }

  if (!input.sourceText) {
    throw new SourceCoverageInputError(`selective-corpus case "${id}": stageA.surfaced is true but no sourceText outcome was supplied.`);
  }
  const textSupplied = input.sourceText.text !== undefined;
  if (input.sourceText.available && !textSupplied) {
    throw new SourceCoverageInputError(`selective-corpus case "${id}": sourceText.available is true but no text was supplied.`);
  }
  if (!input.sourceText.available && (textSupplied || input.artifact !== undefined)) {
    throw new SourceCoverageInputError(`selective-corpus case "${id}": sourceText.available is false but text and/or an artifact was also supplied — text that was never retrieved cannot reach the matcher.`);
  }
  if (input.sourceText.available && !input.artifact) {
    throw new SourceCoverageInputError(`selective-corpus case "${id}": the matcher stage was reached (sourceText.available=true) but no local fixture artifact was supplied.`);
  }
}

export function classifySelectiveCorpusCase(input: SelectiveCorpusCaseInput): SourceCoverageClassification {
  assertConsistentInput(input);

  const caseId = input.caseId;
  const lane = "SELECTIVE_CORPUS" as const;
  const expectedSourceId = input.expectedSourceId;
  const candidateRank = input.stageA.candidateRank;

  if (input.groundTruthAbsent) {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "SOURCE_ABSENT",
      failureStage: "ground-truth",
      reasonCode: input.groundTruthAbsent.reasonCode,
      reasonDetail: input.groundTruthAbsent.detail,
      retrievalSource: null,
      matcherDiagnostics: null,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { groundTruthAbsent: input.groundTruthAbsent },
    };
  }

  if (!input.stageA.surfaced) {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "CANDIDATE_MISSED",
      failureStage: "discovery",
      reasonCode: "NOT_SURFACED_BY_STAGE_A",
      reasonDetail: "Stage A fingerprint discovery did not surface the expected source's ordinal within its bounded top-K for this submission.",
      retrievalSource: null,
      matcherDiagnostics: null,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { stageA: input.stageA },
    };
  }

  const sourceText = input.sourceText as SelectiveCorpusSourceTextInput;

  if (!sourceText.available) {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "RETRIEVAL_FAILED",
      failureStage: "retrieval",
      reasonCode: "SOURCE_TEXT_UNAVAILABLE",
      reasonDetail: "Stage A surfaced the expected source, but its packed shard / raw source text could not be loaded.",
      retrievalSource: null,
      matcherDiagnostics: null,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { sourceText },
    };
  }

  const sourceTextValue = sourceText.text as string;
  const artifact = input.artifact as SelectiveCorpusArtifact;

  // The REAL, frozen Stage B: the unmodified comparator + STRICT_SPAN + FAMILY_GUARD.
  const submissionWords = selectiveCorpusSubmissionWords(input.submissionText);
  const admission = admitSelectiveCorpusCandidate(input.submissionText, submissionWords, sourceTextValue, artifact);

  const admissionDiagnostics: AdmissionDiagnosticsSummary = {
    admitted: admission.admitted,
    reason: admission.reason,
    strictSpanPass: admission.strictSpanPass,
    dominantSpanBoilerplate: admission.dominantSpanBoilerplate,
    familyGuardActivated: admission.familyGuardActivated,
    sourceSpecificWords: admission.sourceSpecificWords,
  };
  // verify.ts's SelectiveCorpusAdmissionResult does not expose the
  // comparator's own containment%/strongMatch/exactMatch (only the derived
  // spans) — genuinely unavailable from this lane's real output, so those
  // fields are honestly null rather than re-deriving a second, competing
  // similarity computation this module has no business performing.
  const rawMatchedWordCount = unionVerifiedWordCount(admission.spans, submissionWords.length);
  const matcherDiagnostics: MatcherDiagnosticsSummary = {
    ran: true,
    similarity: null,
    strongMatch: null,
    exactMatch: null,
    rawMatchedWordCount,
    longestSpanWords: admission.longestSpan > 0 ? admission.longestSpan : null,
  };

  if (admission.admitted) {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "VERIFIED_RECOVERED",
      failureStage: "recovered",
      reasonCode: "SELECTIVE_CORPUS_ADMITTED",
      reasonDetail: admission.reason,
      retrievalSource: "artifact-text",
      matcherDiagnostics,
      admissionDiagnostics,
      verifiedMatchedWordCount: rawMatchedWordCount,
      diagnostics: { admission },
    };
  }

  if (!admission.strictSpanPass) {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "MATCHER_FAILED",
      failureStage: "matcher",
      reasonCode: "STRICT_SPAN_NOT_MET",
      reasonDetail: admission.reason,
      retrievalSource: "artifact-text",
      matcherDiagnostics,
      admissionDiagnostics,
      verifiedMatchedWordCount: 0,
      diagnostics: { admission },
    };
  }

  // strictSpanPass true, admitted false => FAMILY_GUARD suppressed authority.
  return {
    caseId, lane, expectedSourceId, candidateRank,
    outcome: "ADMISSION_OR_ATTRIBUTION_FAILED",
    failureStage: "admission",
    reasonCode: "FAMILY_GUARD_SUPPRESSED",
    reasonDetail: admission.reason,
    retrievalSource: "artifact-text",
    matcherDiagnostics,
    admissionDiagnostics,
    verifiedMatchedWordCount: 0,
    diagnostics: { admission },
  };
}
