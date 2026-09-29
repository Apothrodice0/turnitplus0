import type { ArchiveReadClient } from "./archive-read-retry";
import { tokens, gramHash, informativeGram } from "./similarity-core";
import { ARCHIVE_SHINGLE_SIZE } from "./archive-fingerprint";
import { phraseAnyPresent, phraseFanOut, phraseSearch } from "./archive-phrase-index";

/**
 * 100k-scale architecture — the bounded FTS phrase-search fallback for
 * archive candidate DISCOVERY. Ported verbatim from the Slice 2A.4/2A.5
 * prototype (tests/compact-archive-index/phrase-fallback/lib-fallback.mjs),
 * which validated it to Baseline-B parity (11/11), secondary-miss recovery
 * (7/7) and short-span stress parity (14/14).
 *
 * This layer ONLY produces additional candidate representation IDs. It never
 * computes similarity, never touches scoreAgainstArchive, never changes a
 * threshold. Its output is deduplicated-unioned with compact-discovery
 * candidates and handed to the UNMODIFIED scorer exactly as compact
 * discovery's output already is. The FTS index itself never adds
 * similarity/evidence.
 *
 * The tuning constants below (dfCap 20, fan-out gate 20, budget 16, prefer-
 * long / hybrid, max phrase length 10) were validated ONLY on the current
 * 321-document archive. They are deliberately INTERNAL — never a user
 * setting — and bundled under ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION so a
 * re-calibration against a larger corpus is a visible, versioned change, not
 * a silent edit to a "forever" constant.
 *
 * v2 (rare-seed discovery): v1 resolved unmatched-region 5-gram DFs one FTS
 * COUNT at a time in DOCUMENT ORDER until the 384-check cap, so on a long
 * submission an edited copied passage past ~token 760 was never checked at
 * all. v2 resolves EXACTLY the grams v1 resolved, to the same values (so the
 * probe selection and phrase candidates are unchanged), but settles each
 * block of DF_RESOLVE_GROUP_SIZE grams with one OR-existence query first —
 * novel text is ~98% DF-0 grams, so most blocks cost one query instead of 16.
 * The queries this saves are spent on a whole-document pass over the grams v1
 * never reached (blocks visited in wholeDocumentOrder). Any resolved gram
 * whose exact archive DF is 1..RARE_SEED_MAX_DF is a rare seed; rare seeds
 * only NOMINATE documents (nominateRareSeedCandidates, which demands
 * corroboration), and nominated documents go through the same canonical_text
 * retrieval and the UNMODIFIED scoreAgainstArchive as every other candidate.
 * Whole-document results never feed the probe DF map. A seed position never
 * scores.
 */

export const ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION = "archive-phrase-fallback-v2";

/** HARD upper bound on selected probes per submission — the acceptance gate
 *  (Slice 2A.4) and asserted by regression tests. Never raised without a
 *  policy-version bump and a fresh parity run. */
export const PHRASE_FALLBACK_BUDGET = 16;
/** Longest probe window tried per anchor before falling back toward 5 words. */
export const PHRASE_FALLBACK_MAX_LEN = 10;
/** Probe a matched-region 5-gram only if its archive DF is in [2, this].
 *  Corpus-validated (Slice 2A.5), NOT forever-calibrated. */
export const PHRASE_FALLBACK_DF_CAP = 20;
/** Reject a probe whose FTS fan-out exceeds this (candidate flood guard).
 *  Corpus-validated (Slice 2A.5), NOT forever-calibrated. */
export const PHRASE_FALLBACK_FANOUT_GATE = 20;
/** Tentative weight for a 5-gram absent from the persisted df-band table
 *  (DF 0 or 1); the FTS fan-out gate then drops the DF=0 ones. */
export const PHRASE_FALLBACK_ABSENT_DF_WEIGHT = 0.1;
/** Upper bound on the request-time FTS frequency checks the DF-resolution
 *  pass issues (Slice 2A.5 Design 2). v2 spends the SAME budget; the only
 *  overrun is <= ceil(checks / DF_RESOLVE_GROUP_SIZE) group queries when
 *  nearly every block of the v1 region holds an archive 5-gram, and then the
 *  whole-document pass gets no budget (see resolveQueryGramDfWithRareSeeds). */
export const PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS = 384;
/** Grams settled per OR-existence query in the DF-resolution pass. */
export const DF_RESOLVE_GROUP_SIZE = 16;
/** A checked unmatched-region 5-gram is a rare seed iff its exact archive
 *  document frequency (the FTS fan-out of that exact 5-token run — the same
 *  number resolveQueryGramDf has always resolved) is in [1, this]: at most 3
 *  archive documents contain the run. Discovery-only. */
export const RARE_SEED_MAX_DF = 3;
/** A document is nominated only when at least this many NON-OVERLAPPING rare
 *  seeds (start positions >= 5 tokens apart) pointing at it start within one
 *  RARE_SEED_WINDOW-token window. On the real 321-doc archive (every gram
 *  resolved, 66 clean human-written negatives incl. an 8k-word one) no
 *  generic coincidence ever reached more than 2 in 60 tokens, while every
 *  lightly edited 150-word copy the v1 engine missed reached 8-10. */
export const RARE_SEED_MIN_SUPPORT = 3;
export const RARE_SEED_WINDOW = 60;
/** Hard cap on NEW candidates the rare-seed pass may add per submission. */
export const RARE_SEED_MAX_CANDIDATES = 16;

const S = ARCHIVE_SHINGLE_SIZE; // 5
/** df_bucket value that means "DF >= 21" — mirrors DF_BAND_OVERFLOW_BUCKET in
 *  lib/archive-df-bands.ts; kept local to avoid a circular-feel import. */
const DF_OVERFLOW = 21;

export type GapRegion = [start: number, end: number];

/**
 * "Discovery-gap" regions of the query. A word position is a gap if EITHER it
 * is not in `matchedPositions` (compact discovery + matcher found nothing
 * there), OR the 5-gram anchored there has an archive DF in [2, dfBand] —
 * i.e. shared with other archive documents but not stop evidence, so the
 * compact candidate set may be missing a co-source even though the primary
 * matched (this is what reproduces the scorer's runtime
 * `> maximumDocumentFrequency` suppression once enough co-sources are found).
 */
export function discoveryGapRegions(
  queryWords: string[],
  matchedPositions: number[],
  opts: { globalDf: Map<string, number>; stopHashSet: Set<string>; dfBand: number; minLen?: number },
): GapRegion[] {
  const { globalDf, stopHashSet, dfBand } = opts;
  const minLen = opts.minLen ?? S;
  const matched = new Set(matchedPositions);
  const wordCount = queryWords.length;
  const isGap = (i: number): boolean => {
    if (!matched.has(i)) return true;
    if (i + S > wordCount) return false;
    const h = gramHash(queryWords.slice(i, i + S).join(" "));
    const df = globalDf.get(h) ?? 0;
    if (dfBand <= 12 && stopHashSet.has(h)) return false;
    return df >= 2 && df <= dfBand;
  };
  const regions: GapRegion[] = [];
  let start: number | null = null;
  for (let i = 0; i <= wordCount; i += 1) {
    const gap = i < wordCount && isGap(i);
    if (gap && start === null) start = i;
    else if (!gap && start !== null) {
      if (i - start >= minLen) regions.push([start, i]);
      start = null;
    }
  }
  return regions;
}

export type SelectedProbe = { words: string[]; len: number; weight: number };

/**
 * Deterministic phrase-probe selection ("prefer-long"): from each anchor in a
 * gap region, the longest distinctive window <= maxLen, PLUS the bare 5-word
 * window (needle floor — a 5-word overlap can only be recovered by a 5-word
 * probe). Ranked by a distinctiveness weight (rarer 5-grams first; band
 * grams never drop to zero priority), floor(budget/2) slots reserved for the
 * rarest 5-word windows, top `budget` kept. Fully deterministic — no sampling.
 */
export function selectProbes(
  queryWords: string[],
  regions: GapRegion[],
  opts: {
    maxLen: number;
    budget: number;
    stopHashSet: Set<string>;
    globalDf: Map<string, number>;
    dfCap: number;
    absentDfWeight: number;
  },
): SelectedProbe[] {
  const { maxLen, budget, stopHashSet, globalDf, dfCap, absentDfWeight } = opts;

  const hashCache = new Map<number, string>();
  const hashFor = (start: number): string => {
    let h = hashCache.get(start);
    if (h === undefined) {
      h = gramHash(queryWords.slice(start, start + S).join(" "));
      hashCache.set(start, h);
    }
    return h;
  };
  const gramWeight = (start: number): number => {
    const df = globalDf.get(hashFor(start)) ?? 0;
    if (df > dfCap) return 0; // too common / stop
    if (dfCap <= 12 && stopHashSet.has(hashFor(start))) return 0;
    if (df === 0) return absentDfWeight; // absent from df-band table: DF 0 or 1; FTS gate resolves
    if (df === 1) return 0.1; // single archive source: eligible, low priority
    return Math.max(1 / df, 0.15); // hybrid: rarity-ordered, band grams keep a floor
  };

  type Probe = { words: string[]; wStart: number; len: number; weight: number; regionIndex: number };
  const windowProbe = (wStart: number, wEnd: number, regionIndex: number): Probe | null => {
    const words = queryWords.slice(wStart, wEnd);
    if (words.length < S) return null;
    let weight = 0;
    let informative = false;
    for (let s = wStart; s + S <= wEnd; s += 1) {
      weight += gramWeight(s);
      if (informativeGram(queryWords.slice(s, s + S).join(" "))) informative = true;
    }
    if (weight <= 0 || !informative) return null;
    return { words, wStart, len: words.length, weight, regionIndex };
  };

  const probes: Probe[] = [];
  const seen = new Set<string>();
  const push = (p: Probe | null) => {
    if (!p) return;
    const key = p.words.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(p);
  };

  regions.forEach(([rStart, rEnd], regionIndex) => {
    for (let s = rStart; s + S <= rEnd; s += 1) {
      let chosen: Probe | null = null;
      for (let L = Math.min(maxLen, rEnd - s); L >= S; L -= 1) {
        const p = windowProbe(s, s + L, regionIndex);
        if (p) { chosen = p; break; }
      }
      push(chosen);
      push(windowProbe(s, s + S, regionIndex));
    }
  });

  const cmp = (a: Probe, b: Probe) =>
    b.weight - a.weight || a.regionIndex - b.regionIndex || a.wStart - b.wStart || a.len - b.len;
  const ranked = probes.slice().sort(cmp);

  const floorQuota = Math.floor(budget / 2);
  const fives = ranked.filter((p) => p.len === S).slice(0, floorQuota);
  const merged = [...fives, ...ranked.filter((p) => !fives.includes(p))].sort(cmp);
  const chosen: Probe[] = [];
  const chosenKeys = new Set<string>();
  for (const p of fives) { chosen.push(p); chosenKeys.add(p.words.join(" ")); }
  for (const p of merged) {
    if (chosen.length >= budget) break;
    const k = p.words.join(" ");
    if (!chosenKeys.has(k)) { chosen.push(p); chosenKeys.add(k); }
  }
  return chosen.slice(0, budget).map((p) => ({ words: p.words, len: p.len, weight: p.weight }));
}

export type PhraseProbeRun = {
  candidateIds: string[];
  perProbe: { phrase: string; len: number; weight: number; fanOut: number; admitted: boolean; newIds: number }[];
};

/**
 * Run the selected probes against the FTS phrase index. Admits a probe's
 * candidates only when 0 < fanOut <= fanOutLimit (the candidate-flood guard;
 * fanOut === 0 also resolves "this absent gram was really DF=0").
 */
export async function runPhraseProbes(
  client: ArchiveReadClient,
  probes: SelectedProbe[],
  opts: { fanOutLimit: number; existingCandidateIds?: string[] },
): Promise<PhraseProbeRun> {
  const existing = new Set(opts.existingCandidateIds ?? []);
  const union = new Set<string>();
  const perProbe: PhraseProbeRun["perProbe"] = [];
  for (const probe of probes) {
    const fanOut = await phraseFanOut(client, probe.words);
    const admitted = fanOut > 0 && fanOut <= opts.fanOutLimit;
    let newIds = 0;
    if (admitted) {
      for (const id of await phraseSearch(client, probe.words)) {
        if (!existing.has(id) && !union.has(id)) { union.add(id); newIds += 1; }
      }
    }
    perProbe.push({ phrase: probe.words.join(" "), len: probe.len, weight: Number(probe.weight.toFixed(6)), fanOut, admitted, newIds });
  }
  return { candidateIds: [...union], perProbe };
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * Deterministic whole-document visiting order over `count` items: the
 * golden-ratio stride permutation k -> (k * stride) mod count, stride ~= 0.618
 * * count and coprime to count, so every item is visited exactly once. Every
 * PREFIX is spread across the whole range (a Weyl sequence), so a bounded
 * check budget reaches the end of a long submission instead of exhausting
 * itself on its opening; a non-power-of-two stride also avoids aliasing with
 * periodic edits (a word inserted every k words). Integer-only.
 */
export function wholeDocumentOrder(count: number): number[] {
  if (count <= 0) return [];
  let stride = Math.max(1, Math.floor((count * 987) / 1597));
  while (gcd(stride, count) !== 1) stride += 1;
  const order = new Array<number>(count);
  for (let k = 0, index = 0; k < count; k += 1, index = (index + stride) % count) order[k] = index;
  return order;
}

/** One rare seed — discovery bookkeeping ONLY. `position` is where the exact
 *  5-gram starts in the submission; it is never a scored position. */
export type RareSeedHit = { position: number; df: number; representationIds: string[] };

export type QueryGramDfResolution = {
  /** Map<gramHash, DF> exactly as resolveQueryGramDf returns it. */
  df: Map<string, number>;
  /** Unmatched-region grams whose exact archive DF is 1..rareSeedMaxDf. */
  rareSeeds: RareSeedHit[];
  /** FTS queries issued (per-gram checks + group existence queries). */
  queries: number;
};

type PendingGram = { position: number; words: string[]; hash: string };

/**
 * Slice 2A.5 Design 2 — resolve the exact DF of a bounded set of query
 * 5-grams from the FTS phrase index (whose fan-out for an exact 5-word run
 * IS that 5-gram's archive DF). Stop-set grams and non-informative grams are
 * skipped without a round-trip.
 *
 * 1. Matched positions, document order, one COUNT per gram (for
 *    discoveryGapRegions rule b) — unchanged from v1.
 * 2. The unmatched grams v1 would have checked next (document order, until
 *    `maxChecks` checks in all) — the SAME grams resolved to the same values,
 *    so `df` is v1's map. Each block of `groupSize` is first tested with one
 *    phraseAnyPresent query; a negative block is DF 0 throughout, a positive
 *    block is resolved gram by gram with phraseSearch(limit DF_OVERFLOW),
 *    whose length is min(DF, 21), exactly the value phraseFallbackDiscovery
 *    clamps every resolved DF to.
 * 3. Whatever budget step 2 saved goes to the unmatched grams v1 never
 *    reached, in blocks visited in wholeDocumentOrder. These results are used
 *    ONLY for rare seeds and never enter `df`, so they cannot move a probe.
 *
 * Every gram resolved with phraseSearch whose DF is 1..rareSeedMaxDf becomes a
 * rare seed with its document ids — no extra query. Total queries <= maxChecks
 * + ceil(maxChecks / groupSize); the overrun happens only when nearly every
 * step-2 block holds an archive 5-gram, and step 3 then gets no budget.
 */
export async function resolveQueryGramDfWithRareSeeds(
  client: ArchiveReadClient,
  queryWords: string[],
  matchedPositions: number[],
  opts: { stopHashSet: Set<string>; maxChecks?: number; rareSeedMaxDf?: number; groupSize?: number },
): Promise<QueryGramDfResolution> {
  const maxChecks = opts.maxChecks ?? PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS;
  const rareSeedMaxDf = opts.rareSeedMaxDf ?? RARE_SEED_MAX_DF;
  const groupSize = Math.max(1, opts.groupSize ?? DF_RESOLVE_GROUP_SIZE);
  const matched = new Set(matchedPositions);
  const df = new Map<string, number>();
  const rareSeeds: RareSeedHit[] = [];
  const seen = new Set<string>();
  let checks = 0;
  let queries = 0;
  const wc = queryWords.length;

  const pendingGram = (s: number): PendingGram | "skip" | "uninformative" => {
    const words = queryWords.slice(s, s + S);
    const hash = gramHash(words.join(" "));
    if (seen.has(hash) || opts.stopHashSet.has(hash)) return "skip";
    seen.add(hash);
    if (!informativeGram(words.join(" "))) { df.set(hash, 0); return "uninformative"; }
    return { position: s, words, hash };
  };
  const checkGram = async (gram: PendingGram): Promise<number> => {
    const ids = await phraseSearch(client, gram.words, DF_OVERFLOW);
    queries += 1;
    if (ids.length >= 1 && ids.length <= rareSeedMaxDf) {
      rareSeeds.push({ position: gram.position, df: ids.length, representationIds: [...ids].sort() });
    }
    return ids.length;
  };
  const blockHasArchiveGram = async (block: PendingGram[]): Promise<boolean> => {
    if (block.length === 1) return true; // a lone gram is cheaper to check directly
    queries += 1;
    return phraseAnyPresent(client, block.map((gram) => gram.words));
  };

  // 1) matched positions — v1, unchanged.
  for (let s = 0; s + S <= wc && checks < maxChecks; s += 1) {
    if (!matched.has(s)) continue;
    const gram = pendingGram(s);
    if (typeof gram === "string") continue;
    df.set(gram.hash, await phraseFanOut(client, gram.words));
    checks += 1;
    queries += 1;
  }

  // 2) exactly the unmatched grams v1 checked next, to v1's values.
  const v1Region: PendingGram[] = [];
  for (let s = 0; s + S <= wc && checks < maxChecks; s += 1) {
    if (matched.has(s)) continue;
    const gram = pendingGram(s);
    if (typeof gram === "string") continue;
    df.set(gram.hash, 0); // v1's insertion order; overwritten below when DF >= 1
    v1Region.push(gram);
    checks += 1;
  }
  for (let i = 0; i < v1Region.length; i += groupSize) {
    const block = v1Region.slice(i, i + groupSize);
    if (!(await blockHasArchiveGram(block))) continue;
    for (const gram of block) df.set(gram.hash, await checkGram(gram));
  }

  // 3) the rest of the document, whole-document block order, rare seeds only.
  const rest: PendingGram[] = [];
  for (let s = 0; s + S <= wc; s += 1) {
    if (matched.has(s)) continue;
    const words = queryWords.slice(s, s + S);
    const hash = gramHash(words.join(" "));
    if (seen.has(hash) || opts.stopHashSet.has(hash)) continue;
    seen.add(hash);
    if (informativeGram(words.join(" "))) rest.push({ position: s, words, hash });
  }
  const blockCount = Math.ceil(rest.length / groupSize);
  for (const b of wholeDocumentOrder(blockCount)) {
    if (queries >= maxChecks) break;
    const block = rest.slice(b * groupSize, (b + 1) * groupSize);
    if (!(await blockHasArchiveGram(block))) continue;
    for (const gram of block) {
      if (queries >= maxChecks) break;
      await checkGram(gram);
    }
  }
  return { df, rareSeeds, queries };
}

/** The DF map alone (Map<gramHash, DF>) — see resolveQueryGramDfWithRareSeeds. */
export async function resolveQueryGramDf(
  client: ArchiveReadClient,
  queryWords: string[],
  matchedPositions: number[],
  opts: { stopHashSet: Set<string>; maxChecks?: number },
): Promise<Map<string, number>> {
  return (await resolveQueryGramDfWithRareSeeds(client, queryWords, matchedPositions, opts)).df;
}

/**
 * Rare seeds -> NEW candidate representation IDs (discovery only). A document
 * not already in `existingCandidateIds` is nominated iff, for some window of
 * `window` tokens, at least `minSupport` of the rare seeds pointing at it
 * start inside the window and are pairwise non-overlapping (start positions
 * >= 5 apart; greedy over sorted positions, which maximises that count).
 * Ranked by that support desc, then representation_id asc; at most
 * `maxCandidates` returned. Pure and deterministic; the nominated documents
 * are then retrieved and verified by the unchanged scorer like any other
 * candidate.
 */
export function nominateRareSeedCandidates(
  rareSeeds: RareSeedHit[],
  existingCandidateIds: string[],
  opts: { minSupport?: number; window?: number; maxCandidates?: number } = {},
): string[] {
  const minSupport = opts.minSupport ?? RARE_SEED_MIN_SUPPORT;
  const window = opts.window ?? RARE_SEED_WINDOW;
  const maxCandidates = opts.maxCandidates ?? RARE_SEED_MAX_CANDIDATES;
  const existing = new Set(existingCandidateIds);
  const positionsById = new Map<string, number[]>();
  for (const seed of rareSeeds) {
    for (const id of seed.representationIds) {
      if (existing.has(id)) continue;
      const positions = positionsById.get(id);
      if (positions) positions.push(seed.position);
      else positionsById.set(id, [seed.position]);
    }
  }
  const supported: { id: string; support: number }[] = [];
  for (const [id, positions] of positionsById) {
    positions.sort((a, b) => a - b);
    let support = 0;
    for (let first = 0; first < positions.length; first += 1) {
      let inWindow = 0;
      let lastStart = Number.NEGATIVE_INFINITY;
      for (let k = first; k < positions.length && positions[k] - positions[first] < window; k += 1) {
        if (positions[k] - lastStart >= S) { inWindow += 1; lastStart = positions[k]; }
      }
      support = Math.max(support, inWindow);
    }
    if (support >= minSupport) supported.push({ id, support });
  }
  supported.sort((a, b) => b.support - a.support || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return supported.slice(0, maxCandidates).map((x) => x.id);
}

export type PhraseFallbackDiscovery = {
  regions: GapRegion[];
  probes: SelectedProbe[];
  perProbe: PhraseProbeRun["perProbe"];
  phraseCandidateIds: string[];
  /** rare seeds recorded by the DF-resolution pass (nominations only) */
  rareSeedCount: number;
  /** NEW candidates nominated by corroborated rare seeds */
  rareSeedCandidateIds: string[];
  /**
   * gramHash of every query 5-gram this pass resolved to an exact archive DF
   * of 1..rareSeedMaxDf: the rare seeds plus the matched-region grams step 1
   * resolved. Read only by the verification-side span extension's seed gate
   * (lib/archive-corpus-matching.ts); never a candidate input, never scored.
   */
  rareGramHashes: string[];
  /** deduplicated union of compact + phrase + rare-seed candidates */
  unionCandidateIds: string[];
  dfResolveChecks: number;
  /** FTS queries the DF-resolution pass issued (checks + group queries). */
  dfResolveQueries: number;
};

/**
 * End-to-end phrase-fallback discovery for one submission. `matchedPositions`
 * is the primary (compact + scorer) result's archiveMatchedPositions.
 * Everything is bounded: DF resolution by maxChecks, probe count by budget,
 * per-probe candidates by fanOutLimit, rare-seed nominations by
 * rareSeedMaxCandidates (and they come from the DF-resolution queries — no
 * extra query). The probes are chosen from the same DF map as v1, so the
 * phrase candidates are v1's; rare-seed nominations can only ADD candidates.
 */
export async function phraseFallbackDiscovery(
  client: ArchiveReadClient,
  submittedText: string,
  matchedPositions: number[],
  compactCandidateIds: string[],
  opts: {
    stopHashSet: Set<string>;
    bandByHash: Map<string, number>;
    budget?: number;
    maxLen?: number;
    dfCap?: number;
    fanOutLimit?: number;
    absentDfWeight?: number;
    dfResolveMaxChecks?: number;
    dfResolveGroupSize?: number;
    rareSeedMaxDf?: number;
    rareSeedMinSupport?: number;
    rareSeedWindow?: number;
    rareSeedMaxCandidates?: number;
  },
): Promise<PhraseFallbackDiscovery> {
  const budget = opts.budget ?? PHRASE_FALLBACK_BUDGET;
  const maxLen = opts.maxLen ?? PHRASE_FALLBACK_MAX_LEN;
  const dfCap = opts.dfCap ?? PHRASE_FALLBACK_DF_CAP;
  const fanOutLimit = opts.fanOutLimit ?? PHRASE_FALLBACK_FANOUT_GATE;
  const absentDfWeight = opts.absentDfWeight ?? PHRASE_FALLBACK_ABSENT_DF_WEIGHT;
  const dfResolveMaxChecks = opts.dfResolveMaxChecks ?? PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS;

  const queryWords = tokens(submittedText);
  const resolution = await resolveQueryGramDfWithRareSeeds(client, queryWords, matchedPositions, {
    stopHashSet: opts.stopHashSet,
    maxChecks: dfResolveMaxChecks,
    rareSeedMaxDf: opts.rareSeedMaxDf,
    groupSize: opts.dfResolveGroupSize,
  });
  const resolved = resolution.df;

  // Effective DF map: persisted band buckets, overlaid with FTS-resolved
  // exact values. An FTS-resolved 0 is encoded as (dfCap + 2) so the frozen
  // gramWeight's `df > dfCap` branch filters it exactly like the 2A.4 oracle's
  // DF=0; 1..21 pass through so the `df === 1` / `1/df` branches fire.
  const effectiveDf = new Map(opts.bandByHash);
  for (const [h, v] of resolved) effectiveDf.set(h, v === 0 ? dfCap + 2 : Math.min(v, DF_OVERFLOW));

  const regions = discoveryGapRegions(queryWords, matchedPositions, {
    globalDf: opts.bandByHash,
    stopHashSet: opts.stopHashSet,
    dfBand: dfCap,
  });
  const probes = selectProbes(queryWords, regions, {
    maxLen,
    budget,
    stopHashSet: opts.stopHashSet,
    globalDf: effectiveDf,
    dfCap,
    absentDfWeight,
  });
  const { candidateIds: phraseCandidateIds, perProbe } = await runPhraseProbes(client, probes, {
    fanOutLimit,
    existingCandidateIds: compactCandidateIds,
  });
  const rareSeedCandidateIds = nominateRareSeedCandidates(
    resolution.rareSeeds,
    [...compactCandidateIds, ...phraseCandidateIds],
    { minSupport: opts.rareSeedMinSupport, window: opts.rareSeedWindow, maxCandidates: opts.rareSeedMaxCandidates },
  );
  const unionCandidateIds = [...new Set([...compactCandidateIds, ...phraseCandidateIds, ...rareSeedCandidateIds])];
  const rareSeedMaxDf = opts.rareSeedMaxDf ?? RARE_SEED_MAX_DF;
  const rareGramHashes = new Set<string>();
  for (const [hash, df] of resolved) if (df >= 1 && df <= rareSeedMaxDf) rareGramHashes.add(hash);
  for (const seed of resolution.rareSeeds) rareGramHashes.add(gramHash(queryWords.slice(seed.position, seed.position + S).join(" ")));
  return {
    regions,
    probes,
    perProbe,
    phraseCandidateIds,
    rareSeedCount: resolution.rareSeeds.length,
    rareSeedCandidateIds,
    rareGramHashes: [...rareGramHashes],
    unionCandidateIds,
    dfResolveChecks: resolved.size,
    dfResolveQueries: resolution.queries,
  };
}
