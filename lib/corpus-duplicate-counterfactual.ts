import { computeUnifiedSimilarity, type UnifiedSimilarityResult } from "./unified-similarity";
import type { ReportHistoricalSubmissionMatch } from "./report-types";
import type { ExternalAcademicEvidence } from "./academic-search/types";

/**
 * Phase B1 — the PURE shadow counterfactual core.
 *
 * SHADOW ONLY. Given the exact inputs an authoritative unified-similarity
 * resolution already used, plus the set of representation ids
 * lib/corpus-duplicate-suppression-policy.ts classified as
 * `DOCUMENT_LOCAL_CORPUS_DUPLICATE_CANDIDATE`, this computes ONE hypothetical
 * unified-similarity result with those representations excluded and returns a
 * separate, non-persisted comparison object.
 *
 * It NEVER:
 *   - recomputes the authoritative result — the caller passes it in and it is
 *     echoed back verbatim (`authoritativeScore` === `authoritativeUnifiedSimilarity.unifiedScore`);
 *   - persists anything — the return value is a plain object;
 *   - mutates its inputs — it only reads them and hands a fresh params object
 *     to computeUnifiedSimilarity, which itself builds all its own local sets;
 *   - touches the database, the environment, report-types, or any persisted
 *     payload.
 *
 * PURE / deterministic. It throws in EXACTLY ONE case: the monotonicity
 * invariant below is violated — the hypothetical result (which, by
 * construction, can only ever REMOVE matched words from the scored union)
 * comes out LARGER than the authoritative one. That means the caller-supplied
 * authoritative result does not correspond to these inputs, or the exclusion
 * logic is broken — either way a `CorpusDuplicateCounterfactualInvariantError`
 * is raised rather than silently returning a misleading zero delta. It adds no
 * other failure mode (computeUnifiedSimilarity is documented never to throw on
 * malformed input).
 *
 * The authoritative path is untouched because it never calls this module and
 * never passes `hypotheticalExcludedRepresentationIds` — see that parameter's
 * own comment on lib/unified-similarity.ts.
 */

export const CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION = "corpus-duplicate-counterfactual-v1" as const;

/**
 * Raised when the hypothetical unified-similarity result is not <= the
 * authoritative one on score AND on unique matched words. Excluding
 * representations from the scored union is a strict subset operation, so a
 * hypothetical result that exceeds the authoritative one is impossible for
 * consistent inputs — this is an internal invariant tripwire, never an
 * expected outcome. The message is bounded: numeric fields only, never any
 * document / passage / representation-id content.
 */
export class CorpusDuplicateCounterfactualInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusDuplicateCounterfactualInvariantError";
  }
}

export type CorpusDuplicateCounterfactualInput = {
  /** The SAME wordCount the authoritative resolution used. */
  wordCount: number;
  /** The SAME archive matched positions the authoritative resolution used. */
  archiveMatchedPositions?: number[] | null;
  /** The SAME external academic evidence the authoritative resolution used. */
  externalAcademicEvidence?: ExternalAcademicEvidence[] | null;
  /** The SAME historical-match snapshot the authoritative resolution used (read-only). */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
  /** The SAME effective same-Passport SELF representation ids the authoritative resolution used — passed through unchanged so the hypothetical differs from authoritative by ONLY the document-local exclusion. */
  effectiveDeviceSelfRepresentationIds?: readonly string[] | ReadonlySet<string> | null;
  /** The authoritative UnifiedSimilarityResult resolvePrimarySimilaritySummary already produced — reused, NEVER recomputed. */
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult;
  /** matchedRepresentationId values classified DOCUMENT_LOCAL_CORPUS_DUPLICATE_CANDIDATE by lib/corpus-duplicate-suppression-policy.ts. */
  qualifyingRepresentationIds: readonly string[] | ReadonlySet<string>;
};

export type CorpusDuplicateCounterfactualResult = {
  version: typeof CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION;

  /** authoritativeUnifiedSimilarity.unifiedScore, echoed verbatim — never recomputed. */
  authoritativeScore: number;
  /** the hypothetical unified score with the qualifying representation(s) excluded. Guaranteed <= authoritativeScore (else the call throws). */
  hypotheticalScore: number;
  /** authoritativeScore - hypotheticalScore. Direct subtraction, NOT clamped: the monotonicity invariant guarantees it is >= 0. */
  scoreDelta: number;

  authoritativeUniqueMatchedWords: number;
  hypotheticalUniqueMatchedWords: number;
  /** authoritativeUniqueMatchedWords - hypotheticalUniqueMatchedWords. Direct subtraction, NOT clamped: guaranteed >= 0 by the invariant. Words that were matched ONLY through the excluded representation(s). */
  uniqueMatchedWordsRemoved: number;

  /**
   * Total matchedWordCount the excluded representation(s) claimed, deduped by
   * representation id. DISTINCT from uniqueMatchedWordsRemoved: a candidate can
   * claim 100 matched words while only 80 disappear from the union because the
   * other 20 are independently covered by archive / scholarly / another corpus
   * source.
   */
  candidateMatchedWords: number;
  /** How many distinct representations were actually excluded (present in matches[] AND in qualifyingRepresentationIds). */
  candidatesExcluded: number;

  /**
   * Surviving matched-word breakdown, straight from the HYPOTHETICAL result's
   * own EXCLUSIVE per-channel counters (the "*OnlyWords" figures — words
   * matched by that channel and no other). The four fields reconcile exactly:
   *   archiveOnlyWordsSurviving + liveAcademicOnlyWordsSurviving
   *   + previousUploadOnlyWordsSurviving + overlapWordsSurviving
   *   === hypotheticalUniqueMatchedWords
   */
  archiveOnlyWordsSurviving: number;
  liveAcademicOnlyWordsSurviving: number;
  previousUploadOnlyWordsSurviving: number;
  /** Words matched by more than one surviving channel — kept so the breakdown reconciles to hypotheticalUniqueMatchedWords rather than silently under-summing. */
  overlapWordsSurviving: number;
};

/**
 * Compute the shadow counterfactual. See this module's own header for the
 * "never recomputes / never persists / never mutates" contract and the single
 * monotonicity invariant it enforces.
 */
export function computeCorpusDuplicateCounterfactual(
  input: CorpusDuplicateCounterfactualInput,
): CorpusDuplicateCounterfactualResult {
  const qualifying: ReadonlySet<string> =
    input.qualifyingRepresentationIds instanceof Set
      ? input.qualifyingRepresentationIds
      : new Set(input.qualifyingRepresentationIds);

  // Reused as-is — this module is documented never to recompute it.
  const authoritative = input.authoritativeUnifiedSimilarity;

  // ONE hypothetical computation. computeUnifiedSimilarity builds its own local
  // sets from these values and never mutates them, so passing the caller's
  // arrays/objects straight through is safe (and cheaper than cloning).
  const hypothetical = computeUnifiedSimilarity({
    wordCount: input.wordCount,
    archiveMatchedPositions: input.archiveMatchedPositions,
    externalAcademicEvidence: input.externalAcademicEvidence,
    historicalSubmissionMatch: input.historicalSubmissionMatch,
    effectiveDeviceSelfRepresentationIds: input.effectiveDeviceSelfRepresentationIds,
    hypotheticalExcludedRepresentationIds: qualifying,
  });

  // Monotonicity invariant. Excluding representations from the scored union can
  // only remove matched positions, so BOTH of these must hold for consistent
  // inputs. A violation is an impossible counterfactual — throw a bounded
  // internal error rather than clamp to zero and return a misleading result.
  if (
    hypothetical.unifiedScore > authoritative.unifiedScore ||
    hypothetical.uniqueMatchedWords > authoritative.uniqueMatchedWords
  ) {
    throw new CorpusDuplicateCounterfactualInvariantError(
      `corpus-duplicate counterfactual invariant violated: the hypothetical result exceeds the authoritative one ` +
        `(hypotheticalScore=${hypothetical.unifiedScore}, authoritativeScore=${authoritative.unifiedScore}; ` +
        `hypotheticalUniqueMatchedWords=${hypothetical.uniqueMatchedWords}, authoritativeUniqueMatchedWords=${authoritative.uniqueMatchedWords}) ` +
        `— excluding representations can only shrink the matched-word union, so the supplied authoritative result does not correspond to these inputs`,
    );
  }

  // candidateMatchedWords: sum of matchedWordCount over the DISTINCT matched
  // representations that are both present in the historical match and in the
  // qualifying set. Deliberately independent of the union arithmetic above.
  let candidateMatchedWords = 0;
  let candidatesExcluded = 0;
  const seen = new Set<string>();
  const matches =
    input.historicalSubmissionMatch?.status === "MATCHED"
      ? input.historicalSubmissionMatch.matches ?? []
      : [];
  for (const match of matches) {
    if (!qualifying.has(match.matchedRepresentationId)) continue;
    if (seen.has(match.matchedRepresentationId)) continue;
    seen.add(match.matchedRepresentationId);
    candidateMatchedWords += Number.isFinite(match.matchedWordCount) ? match.matchedWordCount : 0;
    candidatesExcluded += 1;
  }

  // Direct subtraction — the invariant above guarantees both are >= 0.
  const scoreDelta = authoritative.unifiedScore - hypothetical.unifiedScore;
  const uniqueMatchedWordsRemoved = authoritative.uniqueMatchedWords - hypothetical.uniqueMatchedWords;

  return {
    version: CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION,
    authoritativeScore: authoritative.unifiedScore,
    hypotheticalScore: hypothetical.unifiedScore,
    scoreDelta,
    authoritativeUniqueMatchedWords: authoritative.uniqueMatchedWords,
    hypotheticalUniqueMatchedWords: hypothetical.uniqueMatchedWords,
    uniqueMatchedWordsRemoved,
    candidateMatchedWords,
    candidatesExcluded,
    archiveOnlyWordsSurviving: hypothetical.archiveOnlyWords,
    liveAcademicOnlyWordsSurviving: hypothetical.liveAcademicOnlyWords,
    previousUploadOnlyWordsSurviving: hypothetical.previousUploadOnlyWords,
    overlapWordsSurviving: hypothetical.overlapWords,
  };
}
