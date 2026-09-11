import { SourceCoverageSpanValidationError, type VerifiedWordSpan } from "./types";

/**
 * Unions inclusive [start,end] manuscript word-index spans into a word
 * count, each word counted once regardless of how many spans cover it.
 * Mirrors lib/selective-corpus/shadow.ts's own verifiedPositions Set-
 * building (`for (const p of spans) for (let i = p.start; i <= p.end; i++)
 * verifiedPositions.add(i)`) — the same technique production already uses
 * for exactly this purpose, not a new algorithm.
 *
 * ENDPOINT SEMANTICS (confirmed against the real production span
 * representation before implementing the bounds below): every span this
 * module ever receives is built directly from
 * lib/document-correspondence.ts's own accepted spans — see
 * DocumentCorrespondenceResult.allMatchedPassages and
 * lib/selective-corpus/verify.ts's SelectiveCorpusVerifiedSpan, both
 * populated from the exact same `acceptedGlobalSpans`/`matchedPositions`
 * computation in document-correspondence.ts. That computation only ever
 * adds positions `p` with `0 <= p <= submittedWords.length - 1` (each
 * position comes from a 5-word gram starting at some informative-gram index
 * `i <= submittedGrams.length - 1 = submittedWords.length - shingleSize`,
 * expanded to `i .. i + shingleSize - 1`, whose maximum is exactly
 * `submittedWords.length - 1`) and always has `start <= end` (spans are
 * built from a Set of positions via a single ascending merge). So the valid
 * range for a real span is 0-indexed, inclusive, `start <= end <
 * manuscriptWordCount` — enforced exactly below, never swapped or clamped.
 *
 * FAILS CLOSED: a reversed, negative, non-integer, or out-of-range span
 * throws SourceCoverageSpanValidationError rather than being silently
 * "repaired" — real production output can never trigger this (see above),
 * so a thrown error here means the CALLER supplied malformed data, not that
 * this function guessed wrong.
 *
 * `null` in, `null` out: `spans === null` means "the case data this
 * classification was built from does not expose exact verified positions,"
 * which must surface as null, never as an estimate. An empty array is a
 * real, exact zero, not missing data.
 */
export function unionVerifiedWordCount(
  spans: readonly VerifiedWordSpan[] | null | undefined,
  manuscriptWordCount: number,
): number | null {
  if (!Number.isInteger(manuscriptWordCount) || manuscriptWordCount < 0) {
    throw new SourceCoverageSpanValidationError(
      `manuscriptWordCount must be a non-negative integer, got ${JSON.stringify(manuscriptWordCount)}`,
    );
  }
  if (spans == null) return null;

  const positions = new Set<number>();
  for (const span of spans) {
    const { start, end } = span;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new SourceCoverageSpanValidationError(`span endpoints must be integers, got ${JSON.stringify(span)}`);
    }
    if (start < 0) {
      throw new SourceCoverageSpanValidationError(`span start must be >= 0, got ${JSON.stringify(span)}`);
    }
    if (end < start) {
      throw new SourceCoverageSpanValidationError(
        `span end (${end}) must be >= start (${start}) — reversed spans are rejected, never silently swapped: ${JSON.stringify(span)}`,
      );
    }
    if (end >= manuscriptWordCount) {
      throw new SourceCoverageSpanValidationError(
        `span end (${end}) must be < manuscriptWordCount (${manuscriptWordCount}) — out-of-range spans are rejected, never clamped: ${JSON.stringify(span)}`,
      );
    }
    for (let index = start; index <= end; index += 1) positions.add(index);
  }
  return positions.size;
}
