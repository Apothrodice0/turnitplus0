import { gramKeysOf, SIXWORD_N, type SixwordIndex } from "./asjp-sixword-index";

/**
 * EXACT SIX-WORD RUN FINDER over a SixwordIndex (research, local only). Given a manuscript's lane tokens it returns
 * every maximal verbatim run of >= 6 words that the manuscript shares with any indexed article, at every position the
 * article holds it, each verified token by token against the pinned token store:
 *
 *   1. every manuscript gram is looked up (each distinct gram once);
 *   2. hits are chained along diagonals (article, sourcePosition - manuscriptPosition): consecutive grams on one diagonal
 *      are one run; a gap made only of grams whose posting list exceeds `chainCap` is bridged and left to step 3;
 *   3. each run is read from the token store (with a margin) and compared word by word: mismatches split it (a 54-bit
 *      key collision, or a bridged gap the article does not hold), and every exact piece is extended left and right
 *      while the words agree, so a run is maximal whatever the chaining saw.
 *
 * Nothing is dropped for being common: grams above `chainCap` are still counted (postings, holders) and still inside
 * any run that reaches them; only a run made ENTIRELY of such grams is not enumerated per article. Those regions are
 * returned in `uncappedRegions` = [] / `commonRegions` with their exact posting and holder counts, so the caller can
 * report them as common text instead of listing every holder. Every reported run is token-verified.
 */
export type SixwordRun = {
  ord: number; docId: string;
  /** manuscript words [s, e], inclusive */
  s: number; e: number;
  /** article words [p, q], inclusive (lane-token indices) */
  p: number; q: number;
};
export type SixwordFindResult = {
  runs: SixwordRun[];
  /** per manuscript gram start i: number of index positions holding the gram (all articles) */
  gramPostings: Uint32Array;
  /** per manuscript gram start i: number of distinct articles holding the gram */
  gramHolders: Uint32Array;
  /** per gram, the distinct article ords holding it (null when above chainCap: only counts are kept) */
  gramDocs: Array<Uint32Array | null>;
  commonRegions: Array<{ s: number; e: number; minHolders: number; maxPostings: number }>;
  stats: { grams: number; distinctGrams: number; gramsHit: number; pairs: number; chains: number; cappedGrams: number; splitByVerification: number; extendedRuns: number; tokenReads: number; lookupMs: number; chainMs: number; verifyMs: number; totalMs: number };
};

export const SIXWORD_DEFAULT_CHAIN_CAP = 200_000;
const MARGIN = 12;

export function findSixwordRuns(index: SixwordIndex, tokens: readonly string[], options: { chainCap?: number } = {}): SixwordFindResult {
  const t0 = performance.now();
  const chainCap = options.chainCap ?? SIXWORD_DEFAULT_CHAIN_CAP;
  const { h1, h2 } = gramKeysOf(tokens);
  const m = h1.length;
  const gramPostings = new Uint32Array(m), gramHolders = new Uint32Array(m);
  const gramDocs: Array<Uint32Array | null> = new Array(m).fill(null);
  const capped = new Uint8Array(m);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < m; i += 1) { const k = `${h1[i]},${h2[i]}`; const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]); }
  let pairs = new BigUint64Array(1 << 16), np = 0, gramsHit = 0;
  const scratch = { buffer: new Uint32Array(1 << 14) };
  const reads0 = index.tokenReads;
  for (const list of groups.values()) {
    const hits = index.lookup(h1[list[0]], h2[list[0]], scratch);
    if (hits.length === 0) continue;
    gramsHit += list.length;
    const ords: number[] = [];
    let last = -1;
    const posOf = new Uint32Array(hits.length), ordOf = new Uint32Array(hits.length);
    for (let x = 0; x < hits.length; x += 1) {
      const o = index.docOf(hits[x]);
      ordOf[x] = o; posOf[x] = hits[x] - index.base(o);
      if (o !== last) { ords.push(o); last = o; }
    }
    const docs = Uint32Array.from(ords);
    const over = hits.length > chainCap;
    for (const i of list) { gramPostings[i] = hits.length; gramHolders[i] = docs.length; gramDocs[i] = over ? null : docs; if (over) capped[i] = 1; }
    if (over) continue;
    const need = np + hits.length * list.length;
    if (need > pairs.length) { let size = pairs.length; while (size < need) size *= 2; const grown = new BigUint64Array(size); grown.set(pairs.subarray(0, np)); pairs = grown; }
    for (const i of list) {
      for (let x = 0; x < hits.length; x += 1) {
        const diag = posOf[x] - i + 0x200000;
        pairs[np++] = (BigInt(ordOf[x]) << 43n) | (BigInt(diag) << 21n) | BigInt(i);
      }
    }
  }
  const t1 = performance.now();
  const sorted = pairs.subarray(0, np).sort();
  // chains: consecutive grams on one (article, diagonal); a gap of capped grams only is bridged (verified below)
  type Chain = { ord: number; diag: number; i0: number; i1: number };
  const chains: Chain[] = [];
  let cur: Chain | null = null;
  const MASK21 = (1n << 21n) - 1n, MASK22 = (1n << 22n) - 1n;
  for (let x = 0; x < np; x += 1) {
    const v = sorted[x];
    const ord = Number(v >> 43n), diag = Number((v >> 21n) & MASK22) - 0x200000, i = Number(v & MASK21);
    if (cur && cur.ord === ord && cur.diag === diag) {
      if (i === cur.i1 + 1) { cur.i1 = i; continue; }
      let bridge = i > cur.i1 + 1;
      for (let k = cur.i1 + 1; bridge && k < i; k += 1) if (!capped[k]) bridge = false;
      if (bridge) { cur.i1 = i; continue; }
    }
    if (cur) chains.push(cur);
    cur = { ord, diag, i0: i, i1: i };
  }
  if (cur) chains.push(cur);
  const t2 = performance.now();
  // verification and exact extension
  const seen = new Set<string>();
  const runs: SixwordRun[] = [];
  let split = 0, extended = 0;
  for (const c of chains) {
    const s0 = c.i0, e0 = c.i1 + SIXWORD_N - 1, p0 = s0 + c.diag;
    const from = Math.max(0, p0 - MARGIN), to = p0 + (e0 - s0) + 1 + MARGIN;
    const src = index.readTokens(c.ord, from, to);
    const at = (p: number) => src[p - from];
    // exact pieces inside the chain
    const pieces: Array<[number, number]> = [];
    let start = -1;
    for (let s = s0; s <= e0 + 1; s += 1) {
      const ok = s <= e0 && at(s + c.diag) !== undefined && at(s + c.diag) === tokens[s];
      if (ok && start < 0) start = s;
      if (!ok && start >= 0) { if (s - start >= SIXWORD_N) pieces.push([start, s - 1]); start = -1; }
    }
    if (pieces.length !== 1 || pieces[0][0] !== s0 || pieces[0][1] !== e0) split += 1;
    for (let [s, e] of pieces) {
      // extend left / right while the words agree (reading further when the margin runs out)
      let buf = src, bufFrom = from;
      const word = (p: number) => { if (p < bufFrom || p >= bufFrom + buf.length) { bufFrom = Math.max(0, p - 256); buf = index.readTokens(c.ord, bufFrom, p + 257); } return buf[p - bufFrom]; };
      const before = s, after = e;
      while (s > 0 && s + c.diag > 0 && word(s - 1 + c.diag) === tokens[s - 1]) s -= 1;
      const count = index.docs.tokenCounts[c.ord];
      while (e + 1 < tokens.length && e + 1 + c.diag < count && word(e + 1 + c.diag) === tokens[e + 1]) e += 1;
      if (s !== before || e !== after) extended += 1;
      const key = `${c.ord}:${s}:${c.diag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      runs.push({ ord: c.ord, docId: index.docs.docIds[c.ord], s, e, p: s + c.diag, q: e + c.diag });
    }
  }
  runs.sort((x, y) => x.s - y.s || x.ord - y.ord || x.p - y.p);
  // regions made only of capped grams that no enumerated run covers: common text, counted not enumerated
  const covered = new Uint8Array(tokens.length);
  for (const r of runs) covered.fill(1, r.s, r.e + 1);
  const commonRegions: SixwordFindResult["commonRegions"] = [];
  for (let i = 0; i < m; ) {
    if (!capped[i] || covered[i]) { i += 1; continue; }
    let j = i; let minHolders = Infinity, maxPostings = 0;
    while (j < m && capped[j]) { minHolders = Math.min(minHolders, gramHolders[j]); maxPostings = Math.max(maxPostings, gramPostings[j]); j += 1; }
    commonRegions.push({ s: i, e: j - 1 + SIXWORD_N - 1, minHolders, maxPostings });
    i = j;
  }
  const t3 = performance.now();
  return {
    runs, gramPostings, gramHolders, gramDocs, commonRegions,
    stats: { grams: m, distinctGrams: groups.size, gramsHit, pairs: np, chains: chains.length, cappedGrams: capped.reduce((t, x) => t + x, 0), splitByVerification: split, extendedRuns: extended, tokenReads: index.tokenReads - reads0, lookupMs: +(t1 - t0).toFixed(2), chainMs: +(t2 - t1).toFixed(2), verifyMs: +(t3 - t2).toFixed(2), totalMs: +(t3 - t0).toFixed(2) },
  };
}

/** Brute force (tests and audits only): every maximal verbatim run of >= 6 words between `tokens` and one article. */
export function bruteForceRuns(tokens: readonly string[], source: readonly string[], min = SIXWORD_N): Array<{ s: number; e: number; p: number; q: number }> {
  const at = new Map<string, number[]>();
  source.forEach((w, p) => { const l = at.get(w); if (l) l.push(p); else at.set(w, [p]); });
  const out: Array<{ s: number; e: number; p: number; q: number }> = [];
  for (let s = 0; s < tokens.length; s += 1) {
    for (const p of at.get(tokens[s]) ?? []) {
      if (s > 0 && p > 0 && tokens[s - 1] === source[p - 1]) continue; // not left-maximal
      let n = 1; while (s + n < tokens.length && p + n < source.length && tokens[s + n] === source[p + n]) n += 1;
      if (n >= min) out.push({ s, e: s + n - 1, p, q: p + n - 1 });
    }
  }
  return out;
}
