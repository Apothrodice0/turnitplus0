import type { UnifiedSimilarityResult } from "./unified-similarity";

/**
 * Pre-launch hardening fix — measured 2 MB report-transport-ceiling
 * characterization: `computeUnifiedSimilarity()`'s `previousUploadPositions`
 * is, by construction (see that function's own diagnostic-breakdown loop),
 * an EXCLUSIVE SUBSET of `matchedPositions` — every position attributed to
 * the previous-upload/corpus-source channel and no other. Whenever a
 * report's ONLY contributing channel is previous-upload/corpus-source (no
 * archive, no live-academic, no user-supplied-reference, no selective-corpus
 * contribution, no overlap), that subset equals the WHOLE set, and the two
 * sorted-ascending integer arrays serialize to byte-identical JSON — a real,
 * measured duplication (~100KB on the audited fixture) that is entirely
 * redundant: nothing about `unifiedScore`/`uniqueMatchedWords` depends on
 * either array (both are built in a diagnostic pass strictly AFTER scoring;
 * see computeUnifiedSimilarity's own comments), so eliding the duplicate at
 * the PERSISTENCE boundary changes zero scoring/presentation semantics.
 *
 * This module is the ONLY place that encodes/decodes this representation.
 * `computeUnifiedSimilarity()` itself is NEVER touched by this fix — its
 * in-memory return value stays fully expanded, exactly as before, for every
 * existing caller (shadow evaluators, tests, etc.) that never persists
 * anything. Compaction is applied ONLY immediately before JSON-serializing a
 * report for `payload_json`, at each of the three write sites; expansion is
 * applied ONLY immediately after JSON.parse-ing `payload_json` back, at
 * each customer-facing read site — everything in between (evidence
 * interpretation, report-completion, highlighting, accessors) continues to
 * see the exact same fully-expanded shape it always has.
 *
 * Deliberately scoped to ONLY `previousUploadPositions` — the one field the
 * real measured fixture proved responsible for the 413. Does NOT touch
 * `userSuppliedReferencePositions`/`selectiveCorpusPositions`/
 * `archiveMatchedPositions` (a repo-wide consumer audit found the first two
 * have no production readers at all today, and the third lives outside
 * `UnifiedSimilarityResult` entirely) — out of scope for this fix.
 */

/** The one persistence-only marker this module introduces. Distinct from `UNIFIED_SIMILARITY_VERSION` (an unrelated, unbumped scoring-algorithm version) — this is a storage-representation flag only. */
export const PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS = "matchedPositions" as const;

/**
 * The on-disk (payload_json) shape: identical to `UnifiedSimilarityResult`
 * except `previousUploadPositions` may be OMITTED when
 * `previousUploadPositionsEncoding === "matchedPositions"` — in which case a
 * reader must reconstruct it as an exact copy of `matchedPositions`. Every
 * other field is always present, unchanged, exactly as computeUnifiedSimilarity
 * produces it. A row written before this fix existed has no
 * `previousUploadPositionsEncoding` key at all and its `previousUploadPositions`
 * array present in full — both shapes are valid, permanently, with no
 * migration ever required.
 */
export type PersistedUnifiedSimilarity = Omit<UnifiedSimilarityResult, "previousUploadPositions"> & {
  previousUploadPositions?: number[];
  previousUploadPositionsEncoding?: typeof PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS;
};

function isOrderedIdentical(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The real marginal JSON bytes either representation adds — the same `JSON.stringify` semantics production's own MAX_REPORT_SAVE_REQUEST_BYTES checks use (plain ASCII digits/brackets/marker text here, so `.length` already equals UTF-8 byte length exactly). */
function representationBytes(fieldName: string, value: unknown): number {
  return JSON.stringify({ [fieldName]: value }).length;
}

/**
 * Returns a COPY of `result` — never mutates the input — with
 * `previousUploadPositions` elided and replaced by the persistence marker,
 * but ONLY when ALL of the following hold (section 2's exact eligibility
 * contract):
 *   - matchedPositions is a real array
 *   - previousUploadPositions is a real array
 *   - both have identical length
 *   - every position is identical at every index (ordered comparison — both
 *     are already sorted ascending by computeUnifiedSimilarity, so this is
 *     the correct equality test, not mere set equality)
 *   - the compact representation is ACTUALLY smaller than the expanded one
 *     (for a small/empty array, the marker string itself costs more bytes
 *     than the array it would replace — compaction is skipped in that case,
 *     so an empty-array report is persisted exactly as before)
 * Whenever any condition fails, the expanded `previousUploadPositions` is
 * persisted completely unchanged (still a copy, never the original
 * reference) — this function never silently drops real data.
 */
export function compactUnifiedSimilarityForPersistence(result: UnifiedSimilarityResult): PersistedUnifiedSimilarity {
  const { matchedPositions, previousUploadPositions, ...rest } = result;
  const eligible =
    Array.isArray(matchedPositions) &&
    Array.isArray(previousUploadPositions) &&
    isOrderedIdentical(matchedPositions, previousUploadPositions) &&
    representationBytes("previousUploadPositionsEncoding", PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS) <
      representationBytes("previousUploadPositions", previousUploadPositions);

  if (eligible) {
    return {
      ...rest,
      matchedPositions,
      previousUploadPositionsEncoding: PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
    };
  }
  return {
    ...rest,
    matchedPositions,
    ...(previousUploadPositions !== undefined ? { previousUploadPositions } : {}),
  };
}

/**
 * Returns a COPY of `persisted` — never mutates the input — with the
 * legacy, fully-expanded shape every existing downstream consumer already
 * expects: `previousUploadPositions` present as a real array, and the
 * persistence-only `previousUploadPositionsEncoding` marker always removed
 * (a customer-facing response must never expose it).
 *
 * FAIL CLOSED, exactly per section 4: if the marker is present but
 * `matchedPositions` is not a valid array (malformed/corrupt persisted
 * data), `previousUploadPositions` is reconstructed as `[]` — the same
 * absence-compatible convention every existing accessor in this codebase
 * already uses (`report.unifiedSimilarity?.previousUploadPositions ?? []`)
 * — never an invented/guessed array. A row with NO marker at all (every
 * pre-existing report, permanently) is returned with its own
 * `previousUploadPositions` untouched if present, or `[]` if genuinely
 * absent — identical to today's existing behavior, a true no-op for the
 * "old expanded report" case.
 */
export function expandUnifiedSimilarityFromPersistence(persisted: PersistedUnifiedSimilarity): UnifiedSimilarityResult {
  const { previousUploadPositionsEncoding, previousUploadPositions, ...rest } = persisted;
  if (previousUploadPositionsEncoding === PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS) {
    const matchedPositions = Array.isArray(rest.matchedPositions) ? rest.matchedPositions : [];
    return { ...rest, matchedPositions, previousUploadPositions: [...matchedPositions] } as UnifiedSimilarityResult;
  }
  return {
    ...rest,
    previousUploadPositions: Array.isArray(previousUploadPositions) ? previousUploadPositions : [],
  } as UnifiedSimilarityResult;
}
