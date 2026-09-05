import { tokens, grams, gramHash } from "./similarity-core";

/**
 * 100k-scale architecture — the compact winnowed fingerprint set that
 * replaces per-archive-document full-shingle persistence for candidate
 * discovery. Ported verbatim from the Slice 2A prototype
 * (tests/compact-archive-index/fingerprint.mjs), validated end-to-end in
 * Slices 2A.4 / 2A.5. The algorithm here is FROZEN — a change to it must bump
 * ARCHIVE_COMPACT_FINGERPRINT_VERSION so a re-fingerprint pass adds a new
 * generation rather than silently reinterpreting the old rows.
 *
 * Only the STORED ARCHIVE DOCUMENT is fingerprint-reduced. The submitted
 * query is NEVER reduced — lib/archive-corpus-matching.ts keeps using its
 * full, complete 5-gram hash set. That is what makes the winnowing recall
 * guarantee unconditional on query length: winnowing guarantees that any run
 * of >= WINNOW_WINDOW consecutive 5-grams within a given document contributes
 * at least one selected fingerprint to that document's set, so a verbatim
 * passage of >= WINNOW_WINDOW + 4 words copied from an archive document is
 * always discoverable. Shorter overlaps are handled by the bounded FTS phrase
 * fallback (lib/archive-phrase-fallback.ts), not by this index.
 *
 * Determinism: gramHash (lib/similarity-core.ts) is a pure FNV-1a+djb2
 * combination over char codes — no randomness, stable across machines/runs.
 * winnow()'s rightmost-minimum selection and the overflow trim's
 * lexicographic sort are pure functions of the hash sequence. No RNG anywhere.
 */

/** Fingerprint-ALGORITHM generation. Bump on any change to winnow / cap /
 *  shingle-size / hash. Deliberately distinct from ARCHIVE_FINGERPRINT_VERSION
 *  (the old full-shingle namespace) and CORPUS_FINGERPRINT_VERSION, so a
 *  fingerprint-algorithm change is never conflated with a DF-policy change
 *  (ARCHIVE_DF_BAND_POLICY_VERSION) or a phrase-index change
 *  (ARCHIVE_PHRASE_INDEX_VERSION). */
export const ARCHIVE_COMPACT_FINGERPRINT_VERSION = "archive-compact-fp-v1";

export const FINGERPRINT_SHINGLE_SIZE = 5;
/** 5-gram size for every archive-index structure (fingerprints, phrase index,
 *  df-bands). Kept here — the leaf module that only depends on
 *  lib/similarity-core.ts — so lib/archive-df-bands.ts / lib/archive-phrase-
 *  fallback.ts can share it without importing lib/archive-corpus-seed.ts
 *  (which would create an import cycle via lib/archive-index-build.ts). */
export const ARCHIVE_SHINGLE_SIZE = 5;

/**
 * EVERY distinct 5-gram hash of canonicalText — deliberately unfiltered by
 * informativeGram, matching how the built-in archive's own static index was
 * built (scripts/build-document-corpus.py's informative() filter is dead
 * code — see lib/archive-corpus-seed.ts's header for the grep-verified
 * reason). This is the posting universe the scorer's self-exclusion
 * (containment >= 0.75) and per-document uniqueShingleCount are computed over.
 */
export function archiveShingleHashes(canonicalText: string, shingleSize: number = ARCHIVE_SHINGLE_SIZE): Set<string> {
  const words = tokens(canonicalText);
  const hashes = new Set<string>();
  for (const gram of grams(words, shingleSize)) hashes.add(gramHash(gram));
  return hashes;
}

// Tuned so a "typical" real archive document (~5,506 5-grams — the measured
// average for the real 321-document archive) lands close to the
// 128-fingerprint target: expected output ~= gramCount * 2/(WINDOW+1).
export const WINNOW_WINDOW = 85;

export const TARGET_FINGERPRINTS_PER_DOCUMENT = 128; // aspirational, not a per-document hard requirement
export const MIN_FINGERPRINTS_PER_DOCUMENT_WHEN_LENGTH_PERMITS = 64; // soft floor — short documents may legitimately fall under this
export const MAX_FINGERPRINTS_PER_DOCUMENT = 192; // HARD cap — never exceeded, enforced below regardless of document length

export type WinnowSelection = { position: number; hash: string };

/**
 * Classic Schleimer/Wilkerson/Aiken winnowing selection over an ORDERED array
 * of hash values (duplicates and order preserved). Returns every SELECTED
 * window-minimum using the standard "rightmost minimum, never reselect the
 * same position twice in a row" convention. O(n) via a monotonic deque of
 * indices (front = current window's minimum position); popping the back while
 * its value >= the incoming value keeps the LATER index for a tie, i.e. the
 * rightmost minimum.
 */
export function winnow(hashSequence: string[], window: number): WinnowSelection[] {
  const selections: WinnowSelection[] = [];
  const n = hashSequence.length;
  if (n === 0) return selections;
  if (n <= window) {
    // Degenerate short case: a single window covering the whole sequence.
    let bestIndex = 0;
    for (let i = 1; i < n; i += 1) {
      if (hashSequence[i] <= hashSequence[bestIndex]) bestIndex = i; // <= => rightmost minimum
    }
    selections.push({ position: bestIndex, hash: hashSequence[bestIndex] });
    return selections;
  }

  const deque: number[] = []; // indices; front = smallest hashSequence value in current window
  let lastSelectedPosition = -1;
  for (let i = 0; i < n; i += 1) {
    while (deque.length > 0 && hashSequence[deque[deque.length - 1]] >= hashSequence[i]) deque.pop();
    deque.push(i);
    while (deque[0] <= i - window) deque.shift();

    const windowStart = i - window + 1;
    if (windowStart >= 0) {
      const bestIndex = deque[0];
      if (bestIndex !== lastSelectedPosition) {
        selections.push({ position: bestIndex, hash: hashSequence[bestIndex] });
        lastSelectedPosition = bestIndex;
      }
    }
  }
  return selections;
}

/**
 * Deterministic hard-cap trim: keeps the MAX_FINGERPRINTS_PER_DOCUMENT
 * entries with the numerically lowest hash value. gramHash's output is a
 * fixed-width zero-padded 16-hex-digit string, so lexicographic string
 * comparison is exactly numeric comparison — no BigInt conversion needed.
 * Only ever fires for pathologically long documents.
 */
function trimToHardCap(uniqueByHash: Map<string, number>): Map<string, number> {
  if (uniqueByHash.size <= MAX_FINGERPRINTS_PER_DOCUMENT) return uniqueByHash;
  const sorted = [...uniqueByHash.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Map(sorted.slice(0, MAX_FINGERPRINTS_PER_DOCUMENT));
}

export type ArchiveFingerprintResult = {
  /** position is the FIRST occurrence word-index of that hash among the winnowing selections — stored in optional_position, never read by discovery. */
  fingerprints: { hash: string; position: number }[];
  rawGramCount: number;
  /** distinct winnowed hashes BEFORE the hard-cap trim — diagnostics only. */
  rawWinnowSelectionCount: number;
  trimmedByHardCap: boolean;
};

/** Computes the compact fingerprint set for one archive document's canonical text. */
export function computeArchiveFingerprint(canonicalText: string, window: number = WINNOW_WINDOW): ArchiveFingerprintResult {
  const words = tokens(canonicalText);
  const gramList = grams(words, FINGERPRINT_SHINGLE_SIZE);
  const hashSequence = gramList.map((gram) => gramHash(gram));
  const selections = winnow(hashSequence, window);

  const uniqueByHash = new Map<string, number>(); // hash -> first-seen position
  for (const { position, hash } of selections) {
    if (!uniqueByHash.has(hash)) uniqueByHash.set(hash, position);
  }
  const trimmed = trimToHardCap(uniqueByHash);

  return {
    fingerprints: [...trimmed.entries()].map(([hash, position]) => ({ hash, position })),
    rawGramCount: gramList.length,
    rawWinnowSelectionCount: uniqueByHash.size,
    trimmedByHardCap: uniqueByHash.size > MAX_FINGERPRINTS_PER_DOCUMENT,
  };
}
