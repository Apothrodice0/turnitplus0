import type { Client } from "@libsql/client";
import { tokens, gramHash, informativeGram } from "./similarity-core";
import { ARCHIVE_SHINGLE_SIZE } from "./archive-fingerprint";
import { phraseFanOut, phraseSearch } from "./archive-phrase-index";

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
 */

export const ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION = "archive-phrase-fallback-v1";

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
/** Upper bound on the request-time FTS COUNT calls the DF-resolution pass
 *  issues (Slice 2A.5 Design 2). */
export const PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS = 384;

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
  client: Client,
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

/**
 * Slice 2A.5 Design 2 — resolve the exact DF of a bounded set of query
 * 5-grams from the FTS phrase index (whose fan-out for an exact 5-word run
 * IS that 5-gram's archive DF). Covers every 5-gram at a matched position
 * (for discoveryGapRegions rule b) then every 5-gram in an unmatched region,
 * capped at `maxChecks` total. Stop-set grams and non-informative grams are
 * skipped without a round-trip. Returns Map<gramHash, exactDf>.
 */
export async function resolveQueryGramDf(
  client: Client,
  queryWords: string[],
  matchedPositions: number[],
  opts: { stopHashSet: Set<string>; maxChecks?: number },
): Promise<Map<string, number>> {
  const maxChecks = opts.maxChecks ?? PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS;
  const matched = new Set(matchedPositions);
  const df = new Map<string, number>();
  const seen = new Set<string>();
  let checks = 0;
  const wc = queryWords.length;
  for (const wantMatched of [true, false]) {
    for (let s = 0; s + S <= wc; s += 1) {
      if (checks >= maxChecks) return df;
      if (matched.has(s) !== wantMatched) continue;
      const words = queryWords.slice(s, s + S);
      const h = gramHash(words.join(" "));
      if (seen.has(h) || opts.stopHashSet.has(h)) continue;
      seen.add(h);
      if (!informativeGram(words.join(" "))) { df.set(h, 0); continue; }
      df.set(h, await phraseFanOut(client, words));
      checks += 1;
    }
  }
  return df;
}

export type PhraseFallbackDiscovery = {
  regions: GapRegion[];
  probes: SelectedProbe[];
  perProbe: PhraseProbeRun["perProbe"];
  phraseCandidateIds: string[];
  /** deduplicated union of compact + phrase candidates */
  unionCandidateIds: string[];
  dfResolveChecks: number;
};

/**
 * End-to-end phrase-fallback discovery for one submission. `matchedPositions`
 * is the primary (compact + scorer) result's archiveMatchedPositions.
 * Everything is bounded: DF resolution by maxChecks, probe count by budget,
 * per-probe candidates by fanOutLimit.
 */
export async function phraseFallbackDiscovery(
  client: Client,
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
  },
): Promise<PhraseFallbackDiscovery> {
  const budget = opts.budget ?? PHRASE_FALLBACK_BUDGET;
  const maxLen = opts.maxLen ?? PHRASE_FALLBACK_MAX_LEN;
  const dfCap = opts.dfCap ?? PHRASE_FALLBACK_DF_CAP;
  const fanOutLimit = opts.fanOutLimit ?? PHRASE_FALLBACK_FANOUT_GATE;
  const absentDfWeight = opts.absentDfWeight ?? PHRASE_FALLBACK_ABSENT_DF_WEIGHT;
  const dfResolveMaxChecks = opts.dfResolveMaxChecks ?? PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS;

  const queryWords = tokens(submittedText);
  const resolved = await resolveQueryGramDf(client, queryWords, matchedPositions, {
    stopHashSet: opts.stopHashSet,
    maxChecks: dfResolveMaxChecks,
  });

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
  const unionCandidateIds = [...new Set([...compactCandidateIds, ...phraseCandidateIds])];
  return {
    regions,
    probes,
    perProbe,
    phraseCandidateIds,
    unionCandidateIds,
    dfResolveChecks: resolved.size,
  };
}
