import { SIXWORD_N, type SixwordIndex } from "./asjp-sixword-index";
import { SixwordBudgetExceeded, type SixwordFindResult, type SixwordRun } from "./asjp-sixword-match";
import { repetitionForm, structuralForm, legalForm, religiousForm } from "./asjp-academic-lane";

/**
 * SIX-WORD EVIDENCE (research, local only; asjp-sixword-evidence-v1).
 *
 * Turns the exact runs of findSixwordRuns into MATCHES: one per distinct manuscript interval [s, e] that is a maximal
 * run for at least one article, with EVERY article holding that exact word sequence (exhaustive: all positions in the
 * index), the holder's word position, and measured features. Nothing here decides plagiarism; it describes evidence:
 *
 *   holders           articles holding the whole sequence (an article whose own maximal run is longer still holds it)
 *   commonness        UNIQUE (1 article), SHARED (2..9), COMMON (>= 10)
 *   distinctiveCore   the longest stretch of the match whose six-word sequences are each held by ONE article only
 *   contentShare      share of words that are not function words
 *   rareWords         words held by <= 20 of the 28,462 articles (word-df table), alphabetic, >= 3 letters
 *   form              a structural form (citation, title/name, acronym legend, placeholder repetition): the lane's tests
 *   corroboration     for a unique holder: its other unique matches in the same manuscript (count, words, order)
 *   partial           for a unique match of >= 10 words: OTHER articles holding a substantial piece of it — at least 3
 *                     of its six-word sequences (grams3), or at least half of them (half). Quoted primary sources and
 *                     formulae recur in variants across articles; text specific to one article does not.
 *
 * TIERS (a match is always reported with its tier and the reasons):
 *   EXACT_MATCH_CANDIDATE   every verified match (>= 6 words). Informational: never scored.
 *   SCORING_ELIGIBLE        only when a frozen rule (ShortScoringRule) says so AND the scoring flag is on. The flag is
 *                           OFF by default (isSixwordShortScoringEnabled); with it off, no match is ever scored.
 * The rule never applies to a match with more than one holder: shared text keeps all its holders and no origin.
 */
export const ASJP_SIXWORD_EVIDENCE_VERSION = "asjp-sixword-evidence-v1";
export function isSixwordShortScoringEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ASJP_SIXWORD_SHORT_SCORING_ENABLED === "true";
}

export type SixwordBand = "6-9" | "10-14" | "15-19" | "20-24" | "25-39" | "40-59" | "60+";
export const bandOf = (words: number): SixwordBand => (words <= 9 ? "6-9" : words <= 14 ? "10-14" : words <= 19 ? "15-19" : words <= 24 ? "20-24" : words <= 39 ? "25-39" : words <= 59 ? "40-59" : "60+");

const FUNCTION_WORDS = new Set("a an and are as at be been being but by can could did do does for from had has have he her his i if in into is it its may might more most must no nor not of on or our she should so such than that the their them then there these they this those to was we were what when where which while who will with would you your also between both each other only same very within without about after before during over under upon whose whom".split(" "));

export type SixwordHolder = { ord: number; docId: string; p: number; q: number; occurrences: number; gate?: { eligible: boolean; reason: string | null } };
export type SixwordMatch = {
  s: number; e: number; words: number; band: SixwordBand;
  holders: SixwordHolder[]; holderCount: number; commonness: "UNIQUE" | "SHARED" | "COMMON";
  features: {
    contentShare: number; rareWords: number; rareWords100: number; numberShare: number;
    minGramHolders: number; maxGramHolders: number; distinctiveCore: number;
    form: string | null; legal: boolean; religious: boolean;
    /** unique holders only: other UNIQUE matches of the same article in this manuscript */
    corroboration: { matches: number; words: number; inOrder: number; nearest: number | null } | null;
    partial: { grams3: number; half: number } | null;
  };
};

export type WordDf = { documents: number; df: Record<string, number> };

/** All matches of one manuscript (sorted by s, then e). `original` / `spans` give the manuscript text for form tests. */
export function sixwordMatches(index: SixwordIndex, tokens: readonly string[], found: SixwordFindResult, options: {
  original: string; spans: ReadonlyArray<{ start: number; end: number }>; wordDf: WordDf; deadlineAt?: number;
}): SixwordMatch[] {
  // final review L-B: with a deadline, stop between matches (checked every 32) with the finder's own budget error
  let checked = 0;
  const overDeadline = () => options.deadlineAt !== undefined && (checked++ & 31) === 0 && performance.now() > options.deadlineAt;
  const byOrd = new Map<number, SixwordRun[]>();
  for (const r of found.runs) { const l = byOrd.get(r.ord); if (l) l.push(r); else byOrd.set(r.ord, [r]); }
  const intervals = new Map<string, [number, number]>();
  for (const r of found.runs) intervals.set(`${r.s}:${r.e}`, [r.s, r.e]);
  const df = options.wordDf.df;
  const text = (s: number, e: number) => options.original.slice(options.spans[s]?.start ?? 0, options.spans[e]?.end ?? 0);
  const gap = (left: number, right: number) => options.original.slice(left >= 0 ? options.spans[left]?.end ?? 0 : 0, right < options.spans.length ? options.spans[right]?.start ?? options.original.length : options.original.length);
  const matches: SixwordMatch[] = [];
  for (const [s, e] of intervals.values()) {
    if (overDeadline()) throw new SixwordBudgetExceeded("TIME_BUDGET", {});
    // candidates: the holders of the match's least-held gram (every holder of the sequence holds every gram of it)
    let g = s, best = Infinity;
    for (let i = s; i <= e - SIXWORD_N + 1; i += 1) if (found.gramDocs[i] && found.gramHolders[i] < best) { best = found.gramHolders[i]; g = i; }
    const candidates = found.gramDocs[g] ?? Uint32Array.from(byOrd.keys());
    const holders: SixwordHolder[] = [];
    for (const ord of candidates) {
      const runs = byOrd.get(ord);
      if (!runs) continue;
      let first: SixwordRun | null = null, occurrences = 0;
      for (const r of runs) if (r.s <= s && r.e >= e) { occurrences += 1; if (!first || r.p + (s - r.s) < first.p + (s - first.s)) first = r; }
      if (first) holders.push({ ord, docId: first.docId, p: first.p + (s - first.s), q: first.p + (s - first.s) + (e - s), occurrences });
    }
    holders.sort((x, y) => x.ord - y.ord);
    const words = tokens.slice(s, e + 1);
    const n = words.length;
    let minG = Infinity, maxG = 0, core = 0, runCore = 0;
    for (let i = s; i <= e - SIXWORD_N + 1; i += 1) {
      const h = found.gramHolders[i];
      minG = Math.min(minG, h); maxG = Math.max(maxG, h);
      if (h <= 1) { runCore += 1; core = Math.max(core, runCore); } else runCore = 0;
    }
    const alpha = (w: string) => /\p{L}/u.test(w) && w.length >= 3;
    const rare = words.filter((w) => alpha(w) && (df[w] ?? 1) <= 20).length;
    const rare100 = words.filter((w) => alpha(w) && (df[w] ?? 1) <= 100).length;
    const original = text(s, e);
    const form = repetitionForm(words) ?? structuralForm(words, original);
    const before = gap(s - 1, s), after = gap(e, e + 1);
    const context = text(Math.max(0, s - 40), e);
    matches.push({
      s, e, words: n, band: bandOf(n), holders, holderCount: holders.length,
      commonness: holders.length <= 1 ? "UNIQUE" : holders.length <= 9 ? "SHARED" : "COMMON",
      features: {
        contentShare: +(words.filter((w) => !FUNCTION_WORDS.has(w)).length / n).toFixed(3),
        rareWords: rare, rareWords100: rare100,
        numberShare: +(words.filter((w) => /^\d+$/.test(w)).length / n).toFixed(3),
        minGramHolders: minG === Infinity ? 0 : minG, maxGramHolders: maxG,
        distinctiveCore: core ? core + SIXWORD_N - 1 : 0,
        form: form?.category ?? null,
        legal: !!legalForm(words, before, after, context),
        religious: !!religiousForm(n, before, after, context),
        corroboration: null,
        partial: null,
      },
    });
  }
  matches.sort((x, y) => x.s - y.s || x.e - y.e);
  for (const m of matches) {
    if (overDeadline()) throw new SixwordBudgetExceeded("TIME_BUDGET", {});
    if (m.holderCount !== 1 || m.words < 10) continue;
    const own = m.holders[0].ord, held = new Map<number, number>();
    for (let i = m.s; i <= m.e - SIXWORD_N + 1; i += 1) for (const o of found.gramDocs[i] ?? []) if (o !== own) held.set(o, (held.get(o) ?? 0) + 1);
    const grams = m.e - m.s - SIXWORD_N + 2;
    let g3 = 0, half = 0;
    for (const c of held.values()) { if (c >= 3) g3 += 1; if (c >= Math.ceil(grams / 2)) half += 1; }
    m.features.partial = { grams3: g3, half };
  }
  // corroboration: other UNIQUE matches of the same article (non-overlapping in the manuscript)
  const uniqueByOrd = new Map<number, SixwordMatch[]>();
  for (const m of matches) if (m.holderCount === 1) { const o = m.holders[0].ord; const l = uniqueByOrd.get(o); if (l) l.push(m); else uniqueByOrd.set(o, [m]); }
  for (const list of uniqueByOrd.values()) {
    for (const m of list) {
      // review R2 N1: O(U²) per article, so the deadline is checked here too; no spread into Math.min (RangeError)
      if (overDeadline()) throw new SixwordBudgetExceeded("TIME_BUDGET", {});
      const others = list.filter((x) => x !== m && (x.e < m.s || x.s > m.e));
      const inOrder = others.filter((x) => Math.sign(x.s - m.s) === Math.sign(x.holders[0].p - m.holders[0].p)).length;
      let nearest: number | null = null;
      for (const x of others) { const d = x.s > m.e ? x.s - m.e : m.s - x.e; if (nearest === null || d < nearest) nearest = d; }
      m.features.corroboration = { matches: others.length, words: others.reduce((t, x) => t + x.words, 0), inOrder, nearest };
    }
  }
  return matches;
}

/**
 * A short-match scoring rule (a PROPOSAL; applied only with the flag on). For bands below 25 words a match can be
 * eligible only if it has ONE holder, no structural form, and meets the band's thresholds; corroboration lets a
 * shorter unique match count when the same article supplies other unique matches in order nearby.
 */
export type ShortScoringRule = {
  id: string;
  /** standalone eligibility: minimum words, content share, distinctive core, rare words */
  standalone: { minWords: number; minContentShare: number; minCore: number; minRare: number; maxPartialGrams3?: number; maxPartialHalf?: number } | null;
  /** corroborated eligibility: each match >= minWords, the article's other in-order unique matches >= minOthers within maxGap words, total >= minTotal */
  corroborated: { minWords: number; minContentShare: number; minOthers: number; maxGap: number; minTotal: number } | null;
};

export function shortEligibility(m: SixwordMatch, rule: ShortScoringRule, all?: readonly SixwordMatch[]): { eligible: boolean; reason: string } {
  if (m.words >= 25) return { eligible: false, reason: "25+ words: governed by the existing lane, not this rule" };
  if (m.holderCount !== 1) return { eligible: false, reason: m.holderCount === 0 ? "no holder" : `held by ${m.holderCount} articles: origin not established` };
  if (m.holders[0].gate && !m.holders[0].gate.eligible) return { eligible: false, reason: `holder not eligible: ${m.holders[0].gate.reason}` };
  if (m.features.form) return { eligible: false, reason: `structural form ${m.features.form}` };
  const st = rule.standalone;
  const partialOk = (p: SixwordMatch["features"]["partial"], g3?: number, half?: number) => (g3 === undefined || (p?.grams3 ?? Infinity) <= g3) && (half === undefined || (p?.half ?? Infinity) <= half);
  if (st && m.words >= st.minWords && m.features.contentShare >= st.minContentShare && m.features.distinctiveCore >= st.minCore && m.features.rareWords >= st.minRare && partialOk(m.features.partial, st.maxPartialGrams3, st.maxPartialHalf)) return { eligible: true, reason: "standalone" };
  const co = rule.corroborated;
  if (co && all && m.words >= co.minWords && m.features.contentShare >= co.minContentShare) {
    const ord = m.holders[0].ord;
    const others = all.filter((x) => x !== m && x.holderCount === 1 && x.holders[0].ord === ord && !x.features.form && x.words >= co.minWords && (x.e < m.s || x.s > m.e)
      && Math.sign(x.s - m.s) === Math.sign(x.holders[0].p - m.holders[0].p)
      && (x.s > m.e ? x.s - m.e : m.s - x.e) <= co.maxGap && Math.abs(x.holders[0].p - m.holders[0].p) <= co.maxGap + 2 * Math.max(x.words, m.words));
    const total = m.words + others.reduce((t, x) => t + x.words, 0);
    if (others.length >= co.minOthers && total >= co.minTotal) return { eligible: true, reason: `corroborated by ${others.length} in-order unique matches (${total} words)` };
  }
  return { eligible: false, reason: "below the band's evidence requirement" };
}

/**
 * Source offsets for a holder: the article's text from the generation, aligned to its lane tokens; the match is
 * re-verified on the fetched text. Null (never a guessed offset) when the text or the alignment is unavailable.
 */
export type SourceTextReader = { fetchText(docId: string): Promise<{ state: string; text?: string }> };
export async function holderOffsets(fetchText: (docId: string) => Promise<string | null>, tokenSpansOf: (text: string) => Array<{ start: number; end: number; word: string }>, tokensOf: (text: string) => string[], holder: SixwordHolder, manuscriptWords: readonly string[], cache = new Map<string, { text: string; spans: Array<{ start: number; end: number }>; tokens: string[] } | null>()) {
  if (!cache.has(holder.docId)) {
    const text = await fetchText(holder.docId);
    if (text == null) cache.set(holder.docId, null);
    else { const tokens = tokensOf(text); const spans = tokenSpansOf(text); cache.set(holder.docId, spans.length === tokens.length ? { text, spans, tokens } : null); }
  }
  const c = cache.get(holder.docId);
  if (!c) return null;
  if (c.tokens.slice(holder.p, holder.q + 1).join(" ") !== manuscriptWords.join(" ")) return null;
  const start = c.spans[holder.p]?.start, end = c.spans[holder.q]?.end;
  if (start === undefined || end === undefined || !(end > start)) return null;
  return { sourceCharStart: start, sourceCharEnd: end, sourceText: c.text.slice(start, end) };
}

/**
 * FROZEN PROPOSALS (chosen on development data only: evidence/30-dev.json, 33/34/35 grids; never on the hold-out).
 *   P15_STRICT    15–24 words, one holder, no structural form, no OTHER article holding >= 3 of its six-word sequences
 *   P15_BALANCED  as strict, but tolerating other articles holding fewer than half of its six-word sequences
 * Both stay OFF by default (isSixwordShortScoringEnabled). Corroborated clusters of 6–14-word fragments are a
 * research signal only (sixwordClusters), never scored.
 */
export const P15_STRICT: ShortScoringRule = { id: "P15_STRICT-v1", standalone: { minWords: 15, minContentShare: 0, minCore: 0, minRare: 0, maxPartialGrams3: 0 }, corroborated: null };
export const P15_BALANCED: ShortScoringRule = { id: "P15_BALANCED-v1", standalone: { minWords: 15, minContentShare: 0, minCore: 0, minRare: 0, maxPartialHalf: 0 }, corroborated: null };
export const CLUSTER_RULE = { id: "CLUSTER-v1", minFrag: 6, minCount: 2, minTotal: 25, gap: 150, maxPartialHalf: 0 } as const;

/** Research signal: unique, form-free matches of ONE article, in order in both texts and close in both, totalling >= minTotal. */
export function sixwordClusters(matches: readonly SixwordMatch[], rule = CLUSTER_RULE): Array<{ ord: number; docId: string; fragments: Array<[number, number]>; words: number }> {
  const by = new Map<number, SixwordMatch[]>();
  for (const m of matches) {
    if (m.holderCount !== 1 || m.features.form || m.words < rule.minFrag) continue;
    if (m.words >= 10 && (m.features.partial?.half ?? 0) > rule.maxPartialHalf) continue;
    const o = m.holders[0].ord; const l = by.get(o); if (l) l.push(m); else by.set(o, [m]);
  }
  const out: Array<{ ord: number; docId: string; fragments: Array<[number, number]>; words: number }> = [];
  for (const [ord, list] of by) {
    list.sort((a, b) => a.s - b.s);
    let cur = [list[0]];
    const flush = () => { const words = cur.reduce((t, m) => t + m.words, 0); if (cur.length >= rule.minCount && words >= rule.minTotal) out.push({ ord, docId: cur[0].holders[0].docId, fragments: cur.map((m) => [m.s, m.e]), words }); };
    for (let k = 1; k < list.length; k += 1) {
      const a = cur[cur.length - 1], b = list[k];
      if (b.s - a.e <= rule.gap && b.holders[0].p > a.holders[0].p && b.holders[0].p - a.holders[0].p <= rule.gap + a.words) cur.push(b); else { flush(); cur = [b]; }
    }
    flush();
  }
  return out;
}

/**
 * Source gates (added after the frozen hold-out; with every holder eligible nothing changes). The caller supplies the
 * lane's own gates for an article ord — identity, catalog, withdrawal, licence policy, publication before the
 * reference date — and every holder is annotated. Commonness and holder counts keep using the WHOLE index (they
 * describe how common the wording is); only an ELIGIBLE single holder can ever be attributed or scored, and an
 * ineligible holder is never shown as a source.
 */
export function applyHolderGates(matches: SixwordMatch[], gate: (ord: number) => { eligible: boolean; reason: string | null }): SixwordMatch[] {
  const memo = new Map<number, { eligible: boolean; reason: string | null }>();
  for (const m of matches) for (const h of m.holders) { if (!memo.has(h.ord)) memo.set(h.ord, gate(h.ord)); h.gate = memo.get(h.ord)!; }
  return matches;
}
