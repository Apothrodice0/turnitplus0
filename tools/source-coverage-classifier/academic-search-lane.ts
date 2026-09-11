import { compareSubmissionToExternalText } from "../../lib/academic-search/comparator";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../../lib/academic-search/orchestrator";
import { tokens } from "../../lib/similarity-core";
// Type-only: lib/retrieval-types.ts is a live, shared vocabulary file
// lib/academic-search/text-retriever.ts itself already imports
// (`import type { RetrievalStatus, ... } from "../retrieval-types"`) — it is
// NOT part of the dead discovery/retrieval/provenance/E7 pipeline (that is
// lib/retrieval-repository.ts and lib/retrieval-correspondence-bridge.ts,
// neither of which this module imports). Reusing the real RetrievalStatus
// vocabulary here, rather than inventing a parallel one, is the whole point
// of this fix — see this file's own header comment below.
import type { RetrievalStatus } from "../../lib/retrieval-types";
import { SourceCoverageInputError, type MatcherDiagnosticsSummary, type SourceCoverageClassification } from "./types";
import { unionVerifiedWordCount } from "./verified-word-count";

/**
 * ACADEMIC_SEARCH lane.
 *
 * Reuses lib/academic-search/orchestrator.ts's own frozen evidence-
 * acceptance rule (`comparison.similarity >= config.minEvidenceSimilarity`,
 * runAcademicSearch()'s own `includedAsEvidence` line) by reading
 * DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity directly at
 * classification time — NOT a locally duplicated literal. If that config
 * value ever changes, this lane's behavior changes with it automatically;
 * there is nothing here to fall out of sync.
 *
 * RETRIEVAL / EXTRACTION SEMANTICS (adversarial-review fix): the previous
 * version modeled EXTRACTION_FAILED as a stage reached only after retrieval
 * had already succeeded. That state cannot occur in production:
 * lib/academic-search/text-retriever.ts's retrieveCandidateText() only ever
 * returns `source: "provider"` or `"http-fallback"` when non-empty text was
 * ALREADY obtained (`if (text && text.trim())` / `if (retrieved.status ===
 * "SUCCESS" && retrieved.extractedText)`) — every other path resolves to
 * `source: "unavailable"`. Production's real, distinguishable extraction-
 * failure signal is `RetrievalStatus.EXTRACTION_FAILED`
 * (lib/retrieval-types.ts), set by lib/http-content-retriever.ts's
 * retrieve() when content was fetched but no extractable text resulted, and
 * surfaced as `httpRetrievalStatus` — a SUB-CASE of `source: "unavailable"`,
 * never a state after it. This lane now reads that same field directly.
 *
 * BUDGET REPRESENTATION (adversarial-review fix): production only attempts
 * retrieval for the top `maxCandidatesToRetrieve` (5) ranked candidates
 * (`orchestrator.ts`'s `ranked.slice(0, config.maxCandidatesToRetrieve)`). A
 * candidate that is genuinely discovered and ranked, but falls outside that
 * budget, never has retrieval attempted at all — a real state distinct from
 * both "never discovered" and "retrieval attempted and failed". Both
 * "never discovered" and "ranked outside the budget" still classify as
 * CANDIDATE_MISSED (per the task's own taxonomy — this lane does not invent
 * an eighth outcome), but carry distinct reason codes so the two real causes
 * are never conflated in reasonDetail/diagnostics.
 */

export type AcademicSearchGroundTruth = {
  /**
   * Explicit, out-of-band proof the expected source does not exist within
   * academic-search's provider scope — e.g. a confirmed "not indexed by any
   * configured provider" finding. Never inferred from a failed or empty
   * search; supplying this field is the ONLY way a case can classify as
   * SOURCE_ABSENT in this lane.
   */
  reasonCode: string;
  detail: string;
};

/**
 * Discriminated by `status`, mirroring the three real states production can
 * leave an expected source in after discovery/ranking:
 *  - NOT_DISCOVERED: absent from the ranked candidate list entirely.
 *  - RANKED_OUTSIDE_RETRIEVAL_BUDGET: discovered and ranked, but outside
 *    config.maxCandidatesToRetrieve — retrieval was never attempted.
 *  - SELECTED_FOR_RETRIEVAL: among the top-ranked candidates retrieval was
 *    actually attempted for; a `retrieval` outcome is required alongside it.
 */
export type AcademicSearchDiscoveryOutcome =
  | { status: "NOT_DISCOVERED" }
  | { status: "RANKED_OUTSIDE_RETRIEVAL_BUDGET"; candidateRank: number }
  | { status: "SELECTED_FOR_RETRIEVAL"; candidateRank: number };

/**
 * Discriminated by `source`, mirroring lib/academic-search/text-retriever.ts's
 * real TextRetrievalResult exactly: `source !== "unavailable"` if and only
 * if usable, non-empty text was obtained. `httpRetrievalStatus` is the real
 * RetrievalStatus (lib/retrieval-types.ts) the HTTP fallback path recorded —
 * only meaningful when `source === "unavailable"`, and only ever set when
 * the fallback was actually attempted, exactly as production's own
 * AcademicSearchRetrievalDiagnostic.httpRetrievalStatus behaves.
 */
export type AcademicSearchRetrievalOutcome =
  | { source: "provider" | "http-fallback"; retrievedTextLength?: number | null }
  | { source: "unavailable"; httpRetrievalStatus?: RetrievalStatus };

export type AcademicSearchCaseInput = {
  caseId: string;
  expectedSourceId: string;
  /** The manuscript's own text — fed verbatim into the unmodified comparator, no preprocessing performed here. */
  submittedText: string;
  groundTruthAbsent?: AcademicSearchGroundTruth;
  discovery: AcademicSearchDiscoveryOutcome;
  /** Required exactly when discovery.status === "SELECTED_FOR_RETRIEVAL"; must be absent otherwise. */
  retrieval?: AcademicSearchRetrievalOutcome;
  /** The retrieved candidate's full text — required exactly when retrieval.source !== "unavailable"; must be absent otherwise. */
  retrievedExternalText?: string;
};

/** Validates internal consistency up front; throws SourceCoverageInputError on any contradiction or missing required field rather than resolving it by branch order. */
function assertConsistentInput(input: AcademicSearchCaseInput): void {
  const id = input.caseId;

  if (input.groundTruthAbsent && input.discovery.status !== "NOT_DISCOVERED") {
    throw new SourceCoverageInputError(
      `academic-search case "${id}": groundTruthAbsent was supplied together with discovery.status="${input.discovery.status}" — a source cannot be both proven absent and discovered/ranked.`,
    );
  }

  if (input.discovery.status === "SELECTED_FOR_RETRIEVAL") {
    if (!input.retrieval) {
      throw new SourceCoverageInputError(`academic-search case "${id}": discovery.status is SELECTED_FOR_RETRIEVAL but no retrieval outcome was supplied.`);
    }
    const textSupplied = input.retrievedExternalText !== undefined;
    if (input.retrieval.source === "unavailable" && textSupplied) {
      throw new SourceCoverageInputError(`academic-search case "${id}": retrieval.source is "unavailable" but retrievedExternalText was also supplied — text that was never retrieved cannot be fed to the matcher.`);
    }
    if (input.retrieval.source !== "unavailable" && !textSupplied) {
      throw new SourceCoverageInputError(`academic-search case "${id}": retrieval.source is "${input.retrieval.source}" (text obtained) but no retrievedExternalText was supplied for the matcher.`);
    }
  } else if (input.retrieval !== undefined || input.retrievedExternalText !== undefined) {
    throw new SourceCoverageInputError(
      `academic-search case "${id}": retrieval/retrievedExternalText supplied for discovery.status="${input.discovery.status}", which never reaches the retrieval stage in production.`,
    );
  }
}

export function classifyAcademicSearchCase(input: AcademicSearchCaseInput): SourceCoverageClassification {
  assertConsistentInput(input);

  const caseId = input.caseId;
  const lane = "ACADEMIC_SEARCH" as const;
  const expectedSourceId = input.expectedSourceId;
  const candidateRank = input.discovery.status === "NOT_DISCOVERED" ? null : input.discovery.candidateRank;

  // 1. Ground truth wins outright — and is NEVER inferred, only ever
  //    supplied explicitly by the caller. See the SOURCE_ABSENT protection
  //    test in tests/source-coverage-classifier.test.mjs.
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

  // 2. Discovery. Neither "not discovered" nor "ranked outside the
  //    retrieval budget" is ever SOURCE_ABSENT — both are CANDIDATE_MISSED,
  //    distinguished only by reasonCode/reasonDetail.
  if (input.discovery.status === "NOT_DISCOVERED") {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "CANDIDATE_MISSED",
      failureStage: "discovery",
      reasonCode: "CANDIDATE_NOT_DISCOVERED",
      reasonDetail: "The expected source did not appear anywhere in academic-search's discovery/ranking output for this submission.",
      retrievalSource: null,
      matcherDiagnostics: null,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { discovery: input.discovery },
    };
  }

  if (input.discovery.status === "RANKED_OUTSIDE_RETRIEVAL_BUDGET") {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "CANDIDATE_MISSED",
      failureStage: "discovery",
      reasonCode: "RANKED_OUTSIDE_RETRIEVAL_BUDGET",
      reasonDetail: `The expected source was discovered and ranked #${input.discovery.candidateRank}, but fell outside academic-search's maxCandidatesToRetrieve budget — retrieval was never attempted for it.`,
      retrievalSource: null,
      matcherDiagnostics: null,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { discovery: input.discovery },
    };
  }

  // discovery.status === "SELECTED_FOR_RETRIEVAL" from here on.
  const retrieval = input.retrieval as AcademicSearchRetrievalOutcome;

  // 3/4. Retrieval / extraction — read directly from the real, shared
  //    RetrievalStatus vocabulary. EXTRACTION_FAILED is the ONE specific
  //    sub-case of "unavailable"; every other sub-case (or none reported at
  //    all) is a genuine RETRIEVAL_FAILED.
  if (retrieval.source === "unavailable") {
    if (retrieval.httpRetrievalStatus === "EXTRACTION_FAILED") {
      return {
        caseId, lane, expectedSourceId, candidateRank,
        outcome: "EXTRACTION_FAILED",
        failureStage: "extraction",
        reasonCode: "EXTRACTION_FAILED",
        reasonDetail: "Content was fetched via the HTTP fallback, but lib/http-content-retriever.ts's own extraction step produced no usable text (RetrievalStatus.EXTRACTION_FAILED).",
        retrievalSource: "unavailable",
        matcherDiagnostics: null,
        admissionDiagnostics: null,
        verifiedMatchedWordCount: 0,
        diagnostics: { retrieval },
      };
    }
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "RETRIEVAL_FAILED",
      failureStage: "retrieval",
      reasonCode: retrieval.httpRetrievalStatus ?? "TEXT_RETRIEVAL_UNAVAILABLE",
      reasonDetail: retrieval.httpRetrievalStatus
        ? `A candidate was discovered, ranked, and selected for retrieval, but neither a contributing provider's getText() nor the HTTP fallback produced usable text (RetrievalStatus.${retrieval.httpRetrievalStatus}).`
        : "A candidate was discovered, ranked, and selected for retrieval, but no full text could be retrieved from any contributing provider, and no HTTP fallback was attempted (no candidate URL).",
      retrievalSource: "unavailable",
      matcherDiagnostics: null,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { retrieval },
    };
  }

  // 5. Matcher — the REAL, frozen lib/document-correspondence.ts engine via
  //    lib/academic-search/comparator.ts, unmodified, default thresholds.
  const retrievedExternalText = input.retrievedExternalText as string;
  const manuscriptWordCount = tokens(input.submittedText).length;
  const comparison = compareSubmissionToExternalText(input.submittedText, retrievedExternalText);
  const includedAsEvidence = comparison.similarity >= DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity;
  const rawSpans = comparison.matchedPassages.map((p) => ({ start: p.submittedWordStart, end: p.submittedWordEnd }));
  const rawMatchedWordCount = unionVerifiedWordCount(rawSpans, manuscriptWordCount);
  const longestSpanWords = comparison.matchedPassages.length > 0
    ? comparison.matchedPassages.reduce((max, p) => Math.max(max, p.matchedWordCount), 0)
    : null;

  const matcherDiagnostics: MatcherDiagnosticsSummary = {
    ran: true,
    similarity: comparison.similarity,
    strongMatch: comparison.strongMatch,
    exactMatch: comparison.exactMatch,
    rawMatchedWordCount,
    longestSpanWords,
  };

  if (!includedAsEvidence) {
    return {
      caseId, lane, expectedSourceId, candidateRank,
      outcome: "MATCHER_FAILED",
      failureStage: "matcher",
      reasonCode: "BELOW_MIN_EVIDENCE_SIMILARITY",
      reasonDetail: `Comparator similarity ${comparison.similarity} did not clear academic-search's own minEvidenceSimilarity floor (${DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity}); production would not have included this candidate as evidence.`,
      retrievalSource: retrieval.source,
      matcherDiagnostics,
      admissionDiagnostics: null,
      verifiedMatchedWordCount: 0,
      diagnostics: { retrieval, comparison },
    };
  }

  return {
    caseId, lane, expectedSourceId, candidateRank,
    outcome: "VERIFIED_RECOVERED",
    failureStage: "recovered",
    reasonCode: "ACADEMIC_EVIDENCE_ACCEPTED",
    reasonDetail: `Comparator similarity ${comparison.similarity} cleared minEvidenceSimilarity (${DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity}); production would include this candidate as ExternalAcademicEvidence.`,
    retrievalSource: retrieval.source,
    matcherDiagnostics,
    admissionDiagnostics: null,
    verifiedMatchedWordCount: rawMatchedWordCount,
    diagnostics: { retrieval, comparison },
  };
}
