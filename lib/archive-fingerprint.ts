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
 *  shingle-size / hash — and, as of v3, on any change to the upstream
 *  tokens()/stripReferenceSection() text-transform this file's own
 *  archiveShingleHashes/computeArchiveFingerprint feed through en route to
 *  gramHash, since that transform silently changes the shingle sequence a
 *  document hashes to just as much as a winnow/cap change would. Deliberately
 *  distinct from ARCHIVE_FINGERPRINT_VERSION (the old full-shingle namespace)
 *  and CORPUS_FINGERPRINT_VERSION, so a fingerprint-algorithm change is never
 *  conflated with a DF-policy change (ARCHIVE_DF_BAND_POLICY_VERSION) or a
 *  phrase-index change (ARCHIVE_PHRASE_INDEX_VERSION).
 *
 *  v2 (book-fingerprint-cap-audit 20260918T180119Z): the flat 192-row hard
 *  cap became a length-scaled per-document budget (computeFingerprintCap),
 *  and the overflow trim became position-stratified instead of a pure
 *  lowest-hash-value sort (trimToHardCap). Old v1 rows are untouched and
 *  remain queryable until a re-fingerprint pass writes v2 rows alongside
 *  them; matchAgainstArchiveCorpus's default fingerprint-version read is not
 *  changed by this file.
 *
 *  v3 (book-reference-strip-audit 20260918T222732Z): findReferenceSectionStart
 *  (lib/reference-section.ts) gained a terminal-fraction requirement — a
 *  candidate heading must sit at or beyond 50% of the document's character
 *  length before it can trigger a strip — fixing a false-positive class where
 *  an incidental early heading occurrence discarded the remainder of a
 *  book-scale document. tokens()/comparisonText() (lib/similarity-core.ts)
 *  apply this transform ahead of every gramHash this file computes, so the
 *  cap/stratification algorithm itself is unchanged but the shingle sequence
 *  for any affected document is not; old v2 rows remain queryable under their
 *  existing tag until re-fingerprinted. Empirically confirmed against the
 *  full frozen Archive769 corpus (read-only copy): 0/769 documents change
 *  retention or trigger under this transform, so no currently-stored v2 row
 *  is stale as of this bump — the risk is prospective (future book-scale
 *  ingestion), not retroactive.
 *
 *  v4 (reference-strip-pointer-rule-audit 20260919T182220Z): findReferenceSectionStart
 *  gained a narrow citation-pointer rejection gate — a candidate heading
 *  already past the 50% terminal-fraction guard is further rejected when
 *  immediately followed by "see" / "of the" / "will be found" (in-prose
 *  pointer phrases, not the opening of an actual reference list), evaluated
 *  before the existing 700-char corroboration. Fixes a live Archive769 false
 *  positive (empirically confirmed: exactly 1/769 documents changes). Old v3
 *  rows remain queryable under their existing tag until re-fingerprinted;
 *  this file's own algorithm (winnow/cap/stratification) is unchanged.
 *
 *  This constant is BOTH the builders' default generation and the matcher's
 *  default query generation. It equals ARCHIVE_COMPACT_FINGERPRINT_VERSION_V5
 *  (archive-v5-default-switch 20260924): v5 rows are built for every archive
 *  source, and a database without them returns zero compact candidates —
 *  there is no fallback to v4/v1 rows. v4 and older tags stay buildable and
 *  queryable only when named explicitly. */
export const ARCHIVE_COMPACT_FINGERPRINT_VERSION = "archive-compact-fp-v5";

/** v5 (archive-v4-rebuild-preflight cap-policy review 20260924T132939Z):
 *  same shingles, hash, winnow window and v4 reference-section preprocessing,
 *  but the natural-overflow hard-ceiling cap policy — every natural winnow
 *  selection is kept, and the position-stratified trim runs only when a
 *  document's natural count exceeds MAX_FINGERPRINTS_PER_DOCUMENT. The v2-v4
 *  length-scaled budget (computeFingerprintCap) sits below the natural winnow
 *  density for ordinary-length documents, so it trimmed them and broke the
 *  winnowing recall guarantee for >= WINNOW_WINDOW + 4-word passages. The
 *  default build/query generation as of the v5 default switch (see above). */
export const ARCHIVE_COMPACT_FINGERPRINT_VERSION_V5 = "archive-compact-fp-v5";

/** "length-scaled": computeFingerprintCap(wordCount) — the v2-v4 budget.
 *  "natural-overflow-hard-ceiling": MAX_FINGERPRINTS_PER_DOCUMENT only — v5. */
export type ArchiveFingerprintCapPolicy = "length-scaled" | "natural-overflow-hard-ceiling";

/** The cap policy a stored generation tag was built with. Only v5 selects the
 *  hard-ceiling policy; every other tag keeps the pre-v5 length-scaled
 *  behaviour the builders have always applied. */
export function archiveFingerprintCapPolicyForVersion(fingerprintVersion: string): ArchiveFingerprintCapPolicy {
  return fingerprintVersion === ARCHIVE_COMPACT_FINGERPRINT_VERSION_V5 ? "natural-overflow-hard-ceiling" : "length-scaled";
}

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
export const MAX_FINGERPRINTS_PER_DOCUMENT = 1024; // HARD ceiling — never exceeded, enforced below regardless of document length

/** Archive769's measured median fingerprint density (fp per 1,000 words) —
 *  book-fingerprint-cap-audit 20260918T180119Z's
 *  archive-density-distribution.json / audit-summary.md section 3.
 *  computeFingerprintCap's proportionality constant, chosen so a
 *  typical (Archive769-median, ~5,617-word) document lands at essentially
 *  today's ~125-fingerprint output. */
export const TARGET_FINGERPRINT_DENSITY_PER_1000_WORDS = 22.211;

/** Number of equal-length gram-position ranges trimToHardCap's stratified
 *  selection buckets raw winnow selections into, per
 *  recommended-next-change.md ("~32 equal-length word-position ranges"). */
export const NUM_POSITIONAL_STRATA = 32;

/**
 * Length-scaled per-document fingerprint budget (book-fingerprint-cap-audit
 * 20260918T180119Z, recommended-next-change.md strategy B):
 * clamp(MIN_FINGERPRINTS_PER_DOCUMENT_WHEN_LENGTH_PERMITS,
 * ceil(TARGET_FINGERPRINT_DENSITY_PER_1000_WORDS * wordCount / 1000),
 * MAX_FINGERPRINTS_PER_DOCUMENT). Normal/typical-length documents land at
 * essentially the same output as the old flat 192 cap always produced for
 * them (they never neared it); book-scale documents scale proportionally up
 * to the ceiling instead of flatlining at 192.
 */
export function computeFingerprintCap(wordCount: number): number {
  const scaled = Math.ceil((TARGET_FINGERPRINT_DENSITY_PER_1000_WORDS * wordCount) / 1000);
  return Math.min(MAX_FINGERPRINTS_PER_DOCUMENT, Math.max(MIN_FINGERPRINTS_PER_DOCUMENT_WHEN_LENGTH_PERMITS, scaled));
}

/** Per-document fingerprint budget under `policy`. */
export function fingerprintCapForPolicy(policy: ArchiveFingerprintCapPolicy, wordCount: number): number {
  return policy === "natural-overflow-hard-ceiling" ? MAX_FINGERPRINTS_PER_DOCUMENT : computeFingerprintCap(wordCount);
}

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

const byHashAscending = (a: readonly [string, number], b: readonly [string, number]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/**
 * Deterministic per-document-budget trim with stratified positional
 * selection. Replaces the old pure "sort everything by hash, keep the
 * lowest `cap`" trim, which was position-blind and could leave large
 * gaps of the document with zero surviving fingerprints (the confirmed
 * cause of book-scale discovery misses — book-fingerprint-cap-audit
 * 20260918T180119Z).
 *
 * Algorithm (recommended-next-change.md item 2):
 * 1. Bucket every candidate by its gram position into NUM_POSITIONAL_STRATA
 *    equal-length ranges spanning [0, totalGramCount).
 * 2. Give each stratum a proportional share of `cap`
 *    (floor(cap / numStrata), with the remainder's extra single slot
 *    assigned to the lowest-indexed strata first — a fixed, data-independent
 *    rule, so ties in "who gets the remainder" are always resolved the same
 *    way).
 * 3. Within a stratum, keep the lowest-hash entries up to its share
 *    (gramHash's fixed-width zero-padded 16-hex-digit output makes
 *    lexicographic string comparison exactly numeric — no BigInt needed).
 * 4. If a stratum has fewer candidates than its share (short document
 *    regions, sparse strata), the shortfall is backfilled from the pooled
 *    leftovers of every other stratum's surplus, again lowest-hash-first.
 *    This can only under-fill when the input as a whole has fewer than
 *    `cap` candidates, which never happens here (only called when
 *    uniqueByHash.size > cap).
 *
 * Every ordering decision is an explicit array sort over stable stratum
 * index / hash value — never Map/Set/object iteration order — so the result
 * is a pure, deterministic function of (uniqueByHash, cap, totalGramCount).
 * Only ever fires for pathologically long documents.
 */
export function trimToHardCap(
  uniqueByHash: Map<string, number>,
  cap: number,
  totalGramCount: number,
): Map<string, number> {
  if (uniqueByHash.size <= cap) return uniqueByHash;

  const numStrata = Math.max(1, Math.min(NUM_POSITIONAL_STRATA, cap));
  const denom = Math.max(1, totalGramCount);

  const strata: Array<[string, number]>[] = Array.from({ length: numStrata }, () => []);
  for (const entry of uniqueByHash.entries()) {
    const position = entry[1];
    const bucket = Math.min(numStrata - 1, Math.floor((position / denom) * numStrata));
    strata[bucket].push(entry);
  }
  for (const bucket of strata) bucket.sort(byHashAscending);

  const baseShare = Math.floor(cap / numStrata);
  const remainder = cap % numStrata;

  const selected: [string, number][] = [];
  const leftovers: [string, number][] = [];
  for (let i = 0; i < numStrata; i += 1) {
    const allotment = baseShare + (i < remainder ? 1 : 0);
    const bucket = strata[i];
    const take = Math.min(allotment, bucket.length);
    for (let j = 0; j < take; j += 1) selected.push(bucket[j]);
    for (let j = take; j < bucket.length; j += 1) leftovers.push(bucket[j]);
  }

  if (selected.length < cap) {
    leftovers.sort(byHashAscending);
    for (const entry of leftovers) {
      if (selected.length >= cap) break;
      selected.push(entry);
    }
  }

  return new Map(selected);
}

export type ArchiveFingerprintResult = {
  /** position is the FIRST occurrence word-index of that hash among the winnowing selections — stored in optional_position, never read by discovery. */
  fingerprints: { hash: string; position: number }[];
  rawGramCount: number;
  /** distinct winnowed hashes BEFORE the hard-cap trim — diagnostics only. */
  rawWinnowSelectionCount: number;
  trimmedByHardCap: boolean;
  /** this document's fingerprintCapForPolicy(capPolicy, wordCount) result — diagnostics only, never read by discovery/storage. */
  fingerprintCap: number;
};

/** Computes the compact fingerprint set for one archive document's canonical text.
 *  `capPolicy` defaults to the v2-v4 length-scaled budget; builders derive it
 *  from the generation tag via archiveFingerprintCapPolicyForVersion. */
export function computeArchiveFingerprint(
  canonicalText: string,
  window: number = WINNOW_WINDOW,
  capPolicy: ArchiveFingerprintCapPolicy = "length-scaled",
): ArchiveFingerprintResult {
  const words = tokens(canonicalText);
  const gramList = grams(words, FINGERPRINT_SHINGLE_SIZE);
  const hashSequence = gramList.map((gram) => gramHash(gram));
  const selections = winnow(hashSequence, window);

  const uniqueByHash = new Map<string, number>(); // hash -> first-seen position
  for (const { position, hash } of selections) {
    if (!uniqueByHash.has(hash)) uniqueByHash.set(hash, position);
  }
  const fingerprintCap = fingerprintCapForPolicy(capPolicy, words.length);
  const trimmed = trimToHardCap(uniqueByHash, fingerprintCap, gramList.length);

  return {
    fingerprints: [...trimmed.entries()].map(([hash, position]) => ({ hash, position })),
    rawGramCount: gramList.length,
    rawWinnowSelectionCount: uniqueByHash.size,
    trimmedByHardCap: uniqueByHash.size > fingerprintCap,
    fingerprintCap,
  };
}
