import { COMMON_WORDS, gramHash, informativeGram } from "./similarity-core";
import { GENERIC_ACADEMIC_REGISTER_DENSITY_LIMIT, genericAcademicRegisterDensity } from "./document-correspondence";

/**
 * Bounded seed-and-extend alignment — VERIFICATION-side edit tolerance around
 * an exact, source-backed seed (similarity-seed-extend audit, section G: the
 * "greedy bounded window" method it recommended, with the audited policy
 * numbers below). Pure and deterministic; no I/O.
 *
 * Alignment only proves that nearby EXACT token islands belong to one
 * source-backed passage. It never scores anything by similarity:
 *
 *   - a scored position is a submission index `a` of an aligned pair whose
 *     token is EXACTLY EQUAL to the source token it is aligned with
 *     (submissionWords[a] === sourceWords[b], both tokens() output), and only
 *     inside a run of >= SEED_EXTEND_MIN_SCORED_ISLAND_LENGTH consecutive
 *     exact pairs;
 *   - inserted submission tokens (I), substituted tokens (X) and source-only
 *     tokens (D) never produce a position, and neither does the [start, end]
 *     range an alignment spans — only the exact pairs themselves;
 *   - an alignment contributes nothing unless the whole aligned passage is
 *     admitted (verifyAlignment);
 *   - it only recovers what an EDIT broke: a token is contributed only when it
 *     lies within SEED_EXTEND_SEED_LENGTH - 1 tokens of an edit inside the
 *     aligned passage, i.e. at least one of its 5-grams was broken by that
 *     edit. Anywhere else — a verbatim copy, or the part of a passage far from
 *     every edit — the exact path's own result (informativeGram and frequency
 *     gates included) stands unchanged;
 *   - when the caller supplies its gram-frequency gate, a token inside an
 *     exact island of >= 5 whose every exact aligned 5-gram is gated
 *     (archive-common text, e.g. licence boilerplate) is not evidence: it
 *     neither scores nor counts toward admission. Tokens of shorter islands
 *     have no aligned 5-gram and are judged by the passage controls alone.
 *
 * Extension walks outward from the seed one token pair at a time. An exact
 * pair is taken whenever the two current tokens are equal. On a mismatch it
 * looks for the cheapest resynchronisation that skips at most
 * SEED_EXTEND_MAX_CONSECUTIVE_EDITS tokens on each side (cost = skipped
 * submission + skipped source tokens, ties broken by fewer skipped submission
 * tokens) and is confirmed by SEED_EXTEND_RESYNC_TOKENS consecutive
 * exact-equal pairs, at least one of them informative. The skipped tokens
 * become min(skips) substitutions plus the remainder as insertions or
 * deletions, so one gap is at most SEED_EXTEND_MAX_CONSECUTIVE_EDITS edit
 * operations and is always followed by >= 2 exact pairs. No resync ⇒ the
 * extension stops. Each direction consumes at most
 * SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE submission tokens and at most as many
 * source tokens, so one alignment never covers more than 2 × 200 + 5 tokens
 * of either text — never a full-document × full-source alignment.
 */

export const SEED_EXTEND_ALIGNMENT_POLICY_VERSION = "seed-extend-alignment-v1";

/** A seed is one exact 5-token run (the archive shingle size). */
export const SEED_EXTEND_SEED_LENGTH = 5;
/** Maximum submission tokens and maximum source tokens one extension direction may consume. */
export const SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE = 200;
/** Maximum consecutive edit operations (one resync gap). A third adjacent edit breaks the extension. */
export const SEED_EXTEND_MAX_CONSECUTIVE_EDITS = 2;
/** Consecutive exact-equal pairs a resynchronisation needs (at least one informative). */
export const SEED_EXTEND_RESYNC_TOKENS = 2;
/** edit operations / (exact pairs + edit operations) over the whole aligned passage. */
export const SEED_EXTEND_MAX_EDIT_RATIO = 0.25;
/** Island-qualified exact aligned tokens an aligned passage needs to be admitted. */
export const SEED_EXTEND_MIN_EXACT_ALIGNED_TOKENS = 12;
/** Distinct informative words among those exact aligned tokens. */
export const SEED_EXTEND_MIN_DISTINCT_INFORMATIVE_WORDS = 4;
/** Generic academic-register density of those tokens must stay strictly below this
 *  (lib/document-correspondence.ts's own measure and limit, 0.4). */
export const SEED_EXTEND_GENERIC_DENSITY_LIMIT = GENERIC_ACADEMIC_REGISTER_DENSITY_LIMIT;
/** Only runs of at least this many consecutive exact pairs contribute positions. */
export const SEED_EXTEND_MIN_SCORED_ISLAND_LENGTH = 2;
/** Hard cap on alignments per call (seeds inside an admitted passage are skipped, so
 *  real submissions need a handful); reaching it stops further alignments and sets
 *  `truncated`. A bound, not an admission rule. */
export const SEED_EXTEND_MAX_ALIGNMENTS = 512;

export type AlignmentOp =
  | { op: "M"; a: number; b: number }
  | { op: "X"; a: number; b: number }
  | { op: "I"; a: number; b: null }
  | { op: "D"; a: null; b: number };

export type AlignmentVerdict = {
  admitted: boolean;
  /** island tokens dropped because every exact aligned 5-gram covering them is frequency-gated */
  frequencyGatedPositions: number;
  /** island-qualified, non-gated exact pairs' submission positions, ascending — the
   *  evidence the admission controls are measured on */
  evidencePositions: number[];
  /** every exact pair in the alignment (seed included) */
  exactPairs: number;
  editOperations: number;
  editRatio: number;
  maxConsecutiveEdits: number;
  /** the evidence positions within SEED_EXTEND_SEED_LENGTH - 1 tokens of an in-passage
   *  edit, ascending — the only positions an admitted alignment contributes */
  scoredPositions: number[];
  distinctInformativeWords: number;
  genericDensity: number;
};

export type SeedExtendStats = {
  /** submission positions whose 5-gram passed the seed gate (informative + in the seed set) */
  seedPositions: number;
  alignments: number;
  admittedAlignments: number;
  /** token-pair equality checks performed by extension (the cost measure) */
  comparisons: number;
  /** SEED_EXTEND_MAX_ALIGNMENTS was reached */
  truncated: boolean;
};

export type SeedGram = { position: number; gram: string; hash: string };

export type SeedExtendSource<K> = { key: K; words: readonly string[] };

/** Informative word, as the audited design defined it: informativeGram's per-word
 *  floor (>= 4 characters, not in COMMON_WORDS) and not purely numeric. */
export function isInformativeAlignmentWord(word: string): boolean {
  return word.length >= 4 && !COMMON_WORDS.has(word) && !/^\p{N}+$/u.test(word);
}

/**
 * Seed gate over the submission: every position whose 5-gram is informative
 * (informativeGram) and whose gramHash is in `seedGramHashes` — the caller's
 * set of trustworthy seed grams (for the archive: exact archive DF 1..3,
 * not stop). Ascending positions.
 */
export function findSeedGrams(submissionWords: readonly string[], seedGramHashes: ReadonlySet<string>): SeedGram[] {
  const seeds: SeedGram[] = [];
  if (seedGramHashes.size === 0) return seeds;
  for (let position = 0; position + SEED_EXTEND_SEED_LENGTH <= submissionWords.length; position += 1) {
    const gram = submissionWords.slice(position, position + SEED_EXTEND_SEED_LENGTH).join(" ");
    const hash = gramHash(gram);
    if (seedGramHashes.has(hash) && informativeGram(gram)) seeds.push({ position, gram, hash });
  }
  return seeds;
}

/**
 * One extension direction from (a0, b0) — the first pair OUTSIDE the seed —
 * walking by `dir` (+1 right, -1 left). Returns the ops in walk order; never
 * ends on an edit.
 */
export function extendFromSeed(
  submissionWords: readonly string[],
  sourceWords: readonly string[],
  a0: number,
  b0: number,
  dir: 1 | -1,
  stats: Pick<SeedExtendStats, "comparisons">,
): AlignmentOp[] {
  const S = submissionWords;
  const R = sourceWords;
  const window = SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE;
  const maxSkip = SEED_EXTEND_MAX_CONSECUTIVE_EDITS;
  const inWindow = (a: number, b: number) =>
    a >= 0 && a < S.length && b >= 0 && b < R.length && Math.abs(a - a0) < window && Math.abs(b - b0) < window;

  const ops: AlignmentOp[] = [];
  let a = a0;
  let b = b0;
  while (inWindow(a, b)) {
    stats.comparisons += 1;
    if (S[a] === R[b]) {
      ops.push({ op: "M", a, b });
      a += dir;
      b += dir;
      continue;
    }
    let skipA = -1;
    let skipB = -1;
    for (let cost = 1; cost <= 2 * maxSkip && skipA < 0; cost += 1) {
      for (let da = 0; da <= maxSkip && skipA < 0; da += 1) {
        const db = cost - da;
        if (db < 0 || db > maxSkip) continue;
        const a1 = a + dir * da;
        const b1 = b + dir * db;
        if (!inWindow(a1 + dir * (SEED_EXTEND_RESYNC_TOKENS - 1), b1 + dir * (SEED_EXTEND_RESYNC_TOKENS - 1))) continue;
        let equal = true;
        let informative = false;
        for (let k = 0; k < SEED_EXTEND_RESYNC_TOKENS; k += 1) {
          stats.comparisons += 1;
          const word = S[a1 + dir * k];
          if (word !== R[b1 + dir * k]) { equal = false; break; }
          if (isInformativeAlignmentWord(word)) informative = true;
        }
        if (equal && informative) { skipA = da; skipB = db; }
      }
    }
    if (skipA < 0) break;
    const substitutions = Math.min(skipA, skipB);
    for (let k = 0; k < substitutions; k += 1) ops.push({ op: "X", a: a + dir * k, b: b + dir * k });
    for (let k = substitutions; k < skipA; k += 1) ops.push({ op: "I", a: a + dir * k, b: null });
    for (let k = substitutions; k < skipB; k += 1) ops.push({ op: "D", a: null, b: b + dir * k });
    a += dir * skipA;
    b += dir * skipB;
  }
  while (ops.length > 0 && ops[ops.length - 1].op !== "M") ops.pop();
  return ops;
}

/** Aligned-passage admission (the audited controls) over ops in text order.
 *  `isFrequencyGatedGram` (optional) is the caller's gram-frequency gate on a
 *  5-gram hash — see the header. */
export function verifyAlignment(
  submissionWords: readonly string[],
  ops: readonly AlignmentOp[],
  isFrequencyGatedGram?: (hash: string) => boolean,
): AlignmentVerdict {
  let exactPairs = 0;
  let editOperations = 0;
  let editRun = 0;
  let maxConsecutiveEdits = 0;
  for (const op of ops) {
    if (op.op === "M") {
      exactPairs += 1;
      editRun = 0;
    } else {
      editOperations += 1;
      editRun += 1;
      maxConsecutiveEdits = Math.max(maxConsecutiveEdits, editRun);
    }
  }
  const evidencePositions: number[] = [];
  const scoredPositions: number[] = [];
  let frequencyGatedPositions = 0;
  for (let start = 0; start < ops.length;) {
    if (ops[start].op !== "M") { start += 1; continue; }
    let end = start;
    while (end < ops.length && ops[end].op === "M") end += 1;
    if (end - start >= SEED_EXTEND_MIN_SCORED_ISLAND_LENGTH) {
      // an island's exact pairs are consecutive in both texts, text order
      const island = ops.slice(start, end).map((op) => op.a as number);
      const evidence = new Array<boolean>(island.length).fill(!isFrequencyGatedGram || island.length < SEED_EXTEND_SEED_LENGTH);
      if (isFrequencyGatedGram && island.length >= SEED_EXTEND_SEED_LENGTH) {
        for (let w = 0; w + SEED_EXTEND_SEED_LENGTH <= island.length; w += 1) {
          const hash = gramHash(submissionWords.slice(island[w], island[w] + SEED_EXTEND_SEED_LENGTH).join(" "));
          if (!isFrequencyGatedGram(hash)) evidence.fill(true, w, w + SEED_EXTEND_SEED_LENGTH);
        }
      }
      // Islands are maximal and an alignment never starts or ends on an edit, so a
      // neighbouring op is always an edit. A token has a 5-gram crossing that edit
      // iff it lies within SEED_EXTEND_SEED_LENGTH - 1 tokens of it.
      const editBefore = start > 0;
      const editAfter = end < ops.length;
      island.forEach((position, k) => {
        if (!evidence[k]) { frequencyGatedPositions += 1; return; }
        evidencePositions.push(position);
        if ((editBefore && k <= SEED_EXTEND_SEED_LENGTH - 2) || (editAfter && k >= island.length - (SEED_EXTEND_SEED_LENGTH - 1))) {
          scoredPositions.push(position);
        }
      });
    }
    start = end;
  }
  evidencePositions.sort((left, right) => left - right);
  scoredPositions.sort((left, right) => left - right);
  const evidenceWords = evidencePositions.map((position) => submissionWords[position]);
  const distinctInformativeWords = new Set(evidenceWords.filter(isInformativeAlignmentWord)).size;
  const genericDensity = genericAcademicRegisterDensity(evidenceWords);
  const editRatio = editOperations / Math.max(1, exactPairs + editOperations);
  const admitted = evidencePositions.length >= SEED_EXTEND_MIN_EXACT_ALIGNED_TOKENS
    && editRatio <= SEED_EXTEND_MAX_EDIT_RATIO
    && maxConsecutiveEdits <= SEED_EXTEND_MAX_CONSECUTIVE_EDITS
    && distinctInformativeWords >= SEED_EXTEND_MIN_DISTINCT_INFORMATIVE_WORDS
    && genericDensity < SEED_EXTEND_GENERIC_DENSITY_LIMIT;
  return { admitted, frequencyGatedPositions, evidencePositions, exactPairs, editOperations, editRatio, maxConsecutiveEdits, scoredPositions, distinctInformativeWords, genericDensity };
}

/** Full alignment around the exact seed submission[a..a+4] == source[b..b+4]. */
export function alignAroundSeed(
  submissionWords: readonly string[],
  sourceWords: readonly string[],
  a: number,
  b: number,
  stats: Pick<SeedExtendStats, "comparisons">,
): AlignmentOp[] {
  const right = extendFromSeed(submissionWords, sourceWords, a + SEED_EXTEND_SEED_LENGTH, b + SEED_EXTEND_SEED_LENGTH, 1, stats);
  const left = extendFromSeed(submissionWords, sourceWords, a - 1, b - 1, -1, stats);
  const seed: AlignmentOp[] = [];
  for (let k = 0; k < SEED_EXTEND_SEED_LENGTH; k += 1) seed.push({ op: "M", a: a + k, b: b + k });
  return [...left.reverse(), ...seed, ...right];
}

function isExactSeedAt(submissionWords: readonly string[], sourceWords: readonly string[], a: number, b: number): boolean {
  for (let k = 0; k < SEED_EXTEND_SEED_LENGTH; k += 1) {
    if (submissionWords[a + k] !== sourceWords[b + k]) return false;
  }
  return true;
}

/**
 * Seed-and-extend of the submission against each source, in the given source
 * order. Per source: seeds are tried in ascending submission position, each
 * anchored at the seed gram's FIRST occurrence in that source (found by exact
 * token comparison, never by hash); a seed starting inside an
 * already-admitted alignment of that source is skipped. Returns, per source
 * key, the ascending union of admitted alignments' scored positions — exact
 * pairs next to an in-passage edit only. Positions are NOT deduplicated across sources (the caller
 * attributes them). `isFrequencyGatedGram` is passed to verifyAlignment.
 * Deterministic.
 */
export function seedExtendVerifiedPositions<K>(
  submissionWords: readonly string[],
  sources: readonly SeedExtendSource<K>[],
  seedGramHashes: ReadonlySet<string>,
  options: { maxAlignments?: number; isFrequencyGatedGram?: (hash: string) => boolean } = {},
): { positionsBySource: Map<K, number[]>; stats: SeedExtendStats } {
  const maxAlignments = options.maxAlignments ?? SEED_EXTEND_MAX_ALIGNMENTS;
  const stats: SeedExtendStats = { seedPositions: 0, alignments: 0, admittedAlignments: 0, comparisons: 0, truncated: false };
  const positionsBySource = new Map<K, number[]>();
  const seeds = findSeedGrams(submissionWords, seedGramHashes);
  stats.seedPositions = seeds.length;
  if (seeds.length === 0) return { positionsBySource, stats };
  const seedGrams = new Set(seeds.map((seed) => seed.gram));
  const seedFirstWords = new Set(seeds.map((seed) => submissionWords[seed.position]));

  for (const source of sources) {
    if (stats.truncated) break;
    const R = source.words;
    const firstOccurrence = new Map<string, number>();
    for (let b = 0; b + SEED_EXTEND_SEED_LENGTH <= R.length; b += 1) {
      if (!seedFirstWords.has(R[b])) continue;
      const gram = R.slice(b, b + SEED_EXTEND_SEED_LENGTH).join(" ");
      if (seedGrams.has(gram) && !firstOccurrence.has(gram)) firstOccurrence.set(gram, b);
    }
    if (firstOccurrence.size === 0) continue;

    const scored = new Set<number>();
    let coveredUpTo = -1;
    for (const seed of seeds) {
      if (seed.position <= coveredUpTo) continue;
      const b = firstOccurrence.get(seed.gram);
      if (b === undefined || !isExactSeedAt(submissionWords, R, seed.position, b)) continue;
      if (stats.alignments >= maxAlignments) { stats.truncated = true; break; }
      stats.alignments += 1;
      const ops = alignAroundSeed(submissionWords, R, seed.position, b, stats);
      const verdict = verifyAlignment(submissionWords, ops, options.isFrequencyGatedGram);
      if (!verdict.admitted) continue;
      stats.admittedAlignments += 1;
      for (const position of verdict.scoredPositions) scored.add(position);
      for (const op of ops) if (op.a !== null && op.a > coveredUpTo) coveredUpTo = op.a;
    }
    if (scored.size > 0) positionsBySource.set(source.key, [...scored].sort((left, right) => left - right));
  }
  return { positionsBySource, stats };
}
