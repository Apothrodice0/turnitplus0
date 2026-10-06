import { gramHash, grams, tokensForScoringNormalization, type ScoringNormalizationVersion } from "../similarity-core";
import { winnow } from "../archive-fingerprint";
import { sha256Hex } from "./bytes";
import { fingerprintFromHex } from "./ids";
import {
  CORPUS_FINGERPRINT_SHINGLE_SIZE,
  CORPUS_FINGERPRINT_WINNOW_WINDOW,
  CORPUS_NORMALIZATION_VERSION,
} from "./versions";

/**
 * Corpus Engine v1 — normalization and fingerprints, composed ONLY from the
 * frozen TurnitPlus primitives:
 *
 *   tokensForScoringNormalization (lib/similarity-core.ts, named contract)
 *   grams / gramHash               (lib/similarity-core.ts)
 *   winnow                         (lib/archive-fingerprint.ts)
 *
 * at the Selective Corpus Stage A parameters (shingle 5, window 15). No new
 * hash, no new selection rule: the resulting set equals
 * lib/selective-corpus/fingerprint.ts's for the same text. The one thing added
 * is that the POSITION of each selected gram is kept for a submission, which
 * region-aware retrieval needs and the existing helper discards.
 *
 * The normalization contract is passed by number. Nothing here reads the
 * ambient "current" contract.
 */

export type NormalizedDocument = {
  tokens: string[];
  tokenCount: number;
  /** sha256 of the normalized token stream joined by single spaces — the exact-deduplication key. */
  normalizedContentSha256: string;
};

export function normalizeForCorpus(text: string, version: ScoringNormalizationVersion = CORPUS_NORMALIZATION_VERSION): NormalizedDocument {
  const tokens = tokensForScoringNormalization(text, version);
  return { tokens, tokenCount: tokens.length, normalizedContentSha256: sha256Hex(tokens.join(" ")) };
}

/** Distinct winnowed fingerprints of a corpus document, as 16-hex strings in ascending order. */
export function documentFingerprintHexes(tokens: string[]): string[] {
  const sequence = grams(tokens, CORPUS_FINGERPRINT_SHINGLE_SIZE).map((gram) => gramHash(gram));
  const distinct = new Set<string>();
  for (const selection of winnow(sequence, CORPUS_FINGERPRINT_WINNOW_WINDOW)) distinct.add(selection.hash);
  return [...distinct].sort();
}

export type QueryFingerprint = {
  hex: string;
  key: bigint;
  /** Word index of every selected occurrence of this fingerprint in the submission, ascending. */
  positions: number[];
  /** Distinct regions those occurrences fall in, ascending. */
  regions: number[];
};

export type QueryFingerprints = {
  tokenCount: number;
  regionWords: number;
  regionCount: number;
  /** Distinct fingerprints, ascending by key. */
  fingerprints: QueryFingerprint[];
  /** Winnow selections before de-duplication. */
  selectionCount: number;
  normalizationVersion: ScoringNormalizationVersion;
};

/**
 * A submission's winnowed fingerprints with the region each one supports.
 * Region r covers words [r * regionWords, (r + 1) * regionWords); a selected
 * 5-gram belongs to the region its first word is in.
 *
 * The submission is NOT clipped to a fingerprint budget here: clipping by
 * lowest hash (what the existing Stage A does above 4,096) is position-blind
 * and would silently blind whole regions of a long submission.
 */
export function computeQueryFingerprints(
  text: string,
  regionWords: number,
  version: ScoringNormalizationVersion = CORPUS_NORMALIZATION_VERSION,
): QueryFingerprints {
  if (!Number.isInteger(regionWords) || regionWords < 1) throw new RangeError("regionWords must be a positive integer");
  const tokens = tokensForScoringNormalization(text, version);
  const sequence = grams(tokens, CORPUS_FINGERPRINT_SHINGLE_SIZE).map((gram) => gramHash(gram));
  const selections = winnow(sequence, CORPUS_FINGERPRINT_WINNOW_WINDOW);
  const byHex = new Map<string, { positions: number[]; regions: Set<number> }>();
  for (const selection of selections) {
    let entry = byHex.get(selection.hash);
    if (!entry) {
      entry = { positions: [], regions: new Set<number>() };
      byHex.set(selection.hash, entry);
    }
    entry.positions.push(selection.position);
    entry.regions.add(Math.floor(selection.position / regionWords));
  }
  const fingerprints: QueryFingerprint[] = [...byHex.entries()]
    .map(([hex, entry]) => ({
      hex,
      key: fingerprintFromHex(hex),
      positions: entry.positions.sort((left, right) => left - right),
      regions: [...entry.regions].sort((left, right) => left - right),
    }))
    .sort((left, right) => (left.hex < right.hex ? -1 : left.hex > right.hex ? 1 : 0));
  return {
    tokenCount: tokens.length,
    regionWords,
    regionCount: tokens.length === 0 ? 0 : Math.floor((Math.max(tokens.length - 1, 0)) / regionWords) + 1,
    fingerprints,
    selectionCount: selections.length,
    normalizationVersion: version,
  };
}
