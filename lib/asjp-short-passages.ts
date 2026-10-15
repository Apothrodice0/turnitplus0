import { readFileSync } from "node:fs";
import { tokensForScoringNormalization, tokenSpans } from "./similarity-core";
import { docIdFromDecimal } from "./corpus-engine/ids";
import { retrieveCandidates } from "./corpus-engine/retrieval";
import { runWithScoringNormalization } from "./scoring-normalization-scope";
import type { CorpusGenerationReader } from "./corpus-engine/reader";
import type { LaneTokenStore } from "./asjp-lane-tokens";
import { repetitionForm, structuralForm } from "./asjp-academic-lane";

/**
 * SHORT-PASSAGE EXPERIMENT (Phase 6, local only). It never changes the lane's credited positions or score: it reports
 * separately which verbatim runs of 6–59 words, outside the lane's credited words, have source-grounded evidence of
 * being distinctive copied material. Every reported run is an exact verbatim run between the manuscript and one
 * indexed article's lane tokens (positions and source word offsets exact). Evidence per run:
 *   otherHolders   indexed articles OTHER than the candidate holding the run verbatim (found by retrieval, confirmed
 *                  on their lane tokens): > 0 means shared / generic wording, never credited to one article
 *   rareWords      alphabetic words of the run held by <= RARE_DF articles of the 28,462 (word-df table)
 *   contentShare   share of the run's words that are not function words
 *   form           a citation / title / acronym / repetition form (the lane's own form tests)
 *   sameSource     other qualifying runs from the SAME article elsewhere in the manuscript
 * Tiers (the rule is frozen before the second independent evaluation; see SHORT_RULE):
 *   25–59  otherHolders 0, rareWords >= rule.a.rare, contentShare >= rule.a.content, no form
 *   15–24  otherHolders 0, rareWords >= rule.b.rare, contentShare >= rule.b.content, no form
 *   6–14   as 15–24 with rule.c, AND at least rule.c.sameSource other qualifying runs from the same article
 */
export const ASJP_SHORT_PASSAGES_VERSION = "asjp-short-passages-experiment-v2";
export type ShortRule = { rareDf: number; a: { rare: number; content: number }; b: { rare: number; content: number }; c: { rare: number; content: number; sameSource: number } | null };
/**
 * FROZEN for the Phase-6 second independent evaluation, chosen on development data only (evidence/phase6/135-short-grid.json:
 * 0 coincidental words on 127 manuscripts vs later-published articles; 30-/45-word copies 18/20 and 19/20; 15–24-word
 * copies 10/40). 6–14 words: no rule met both goals on development data (0/40 detected at any setting that kept
 * coincidental matches out), so that tier is never reported.
 */
export const SHORT_RULE: ShortRule = { rareDf: 20, a: { rare: 0, content: 0.4 }, b: { rare: 1, content: 0.4 }, c: null };

const FUNCTION_WORDS = new Set("a an and are as at be been being but by can could did do does for from had has have he her his i if in into is it its may might more most must no nor not of on or our she should so such than that the their them then there these they this those to was we were what when where which while who will with would you your also between both each other only same very within without about after before during over under upon whose whom been".split(" "));
export type WordDf = { documents: number; df: Record<string, number> };
export function loadWordDf(file: string): WordDf { return JSON.parse(readFileSync(file, "utf8")); }

export type ShortRun = {
  sourceId: string; docId: string; submittedWordStart: number; submittedWordEnd: number; sourceWordStart: number; words: number;
  tier: "6-14" | "15-24" | "25-59"; otherHolders: number; rareWords: number; rareByDf: Record<number, number>; contentShare: number; form: string | null; sameSourceRuns: number;
  decision: "DISTINCTIVE" | "NOT_DISTINCTIVE"; reason: string;
};

/** Maximal verbatim runs of >= 6 words between submission and source (exact token comparison). */
export function verbatimRuns(submission: readonly string[], source: readonly string[], min = 6) {
  const grams = new Map<string, number[]>();
  for (let j = 0; j + min <= source.length; j += 1) { const k = source.slice(j, j + min).join(" "); const l = grams.get(k); if (l) l.push(j); else grams.set(k, [j]); }
  const runs: Array<{ s: number; e: number; j: number }> = [];
  for (let i = 0; i + min <= submission.length; i += 1) {
    const starts = grams.get(submission.slice(i, i + min).join(" "));
    if (!starts) continue;
    let best = 0, bestJ = -1;
    for (const j of starts) {
      if (i > 0 && j > 0 && submission[i - 1] === source[j - 1]) continue;
      let n = min; while (i + n < submission.length && j + n < source.length && submission[i + n] === source[j + n]) n += 1;
      if (n > best) { best = n; bestJ = j; }
    }
    if (best >= min) runs.push({ s: i, e: i + best - 1, j: bestJ });
  }
  // keep the longest run where runs overlap in the manuscript
  runs.sort((x, y) => (y.e - y.s) - (x.e - x.s) || x.s - y.s);
  const taken = new Set<number>(), kept: typeof runs = [];
  for (const r of runs) { let free = true; for (let q = r.s; q <= r.e; q += 1) if (taken.has(q)) { free = false; break; } if (!free) continue; for (let q = r.s; q <= r.e; q += 1) taken.add(q); kept.push(r); }
  return kept.sort((x, y) => x.s - y.s);
}

export async function shortPassageRuns(options: {
  reader: CorpusGenerationReader; laneTokens: LaneTokenStore; wordDf: WordDf; submissionText: string;
  candidates: Array<{ sourceId: string; docId: string }>; creditedPositions: readonly number[]; rule?: ShortRule;
}): Promise<{ version: string; runs: ShortRun[]; distinctiveWords: number[] }> {
  const rule = options.rule ?? SHORT_RULE;
  const submission = tokensForScoringNormalization(options.submissionText, 2);
  const credited = new Set(options.creditedPositions);
  const holdersCache = new Map<string, Set<string>>();
  const holdersOf = async (run: string[], exclude: string): Promise<number> => {
    const key = run.join(" ");
    let set = holdersCache.get(key);
    if (!set) {
      set = new Set<string>();
      const r = await runWithScoringNormalization(2, () => retrieveCandidates(options.reader, key));
      for (const c of (r.candidates ?? []).slice(0, 25)) {
        const id = String(c.docId);
        const t = options.laneTokens.read(id);
        if (t && ` ${t.join(" ")} `.includes(` ${key} `)) set.add(id);
      }
      holdersCache.set(key, set);
    }
    return [...set].filter((d) => d !== exclude).length;
  };
  const out: ShortRun[] = [];
  for (const cand of options.candidates) {
    const source = options.laneTokens.read(cand.docId);
    if (!source) continue;
    const runs = verbatimRuns(submission, source).filter((r) => r.e - r.s + 1 <= 59 && ![...Array(r.e - r.s + 1).keys()].some((k) => credited.has(r.s + k)));
    const evaluated: ShortRun[] = [];
    for (const r of runs) {
      const words = submission.slice(r.s, r.e + 1);
      const n = words.length;
      const tier = n >= 25 ? "25-59" : n >= 15 ? "15-24" : "6-14";
      const t = tier === "25-59" ? rule.a : tier === "15-24" ? rule.b : rule.c;
      if (!t) { evaluated.push({ ...({ sourceId: cand.sourceId, docId: cand.docId, submittedWordStart: r.s, submittedWordEnd: r.e, sourceWordStart: r.j, words: n, tier, rareWords: 0, rareByDf: {}, contentShare: 0, form: null, sameSourceRuns: 0, otherHolders: -1 }), decision: "NOT_DISTINCTIVE", reason: "6-14 words: tier not credited" }); continue; }
      const rareAt = (d: number) => words.filter((w) => /\p{L}/u.test(w) && w.length >= 3 && (options.wordDf.df[w] ?? 1) <= d).length;
      const rare = rareAt(rule.rareDf);
      const rareByDf = { 10: rareAt(10), 20: rareAt(20), 50: rareAt(50), 100: rareAt(100) };
      const content = words.filter((w) => !FUNCTION_WORDS.has(w)).length / n;
      const formHit = repetitionForm(words) ?? structuralForm(words, words.join(" "));
      const base = { sourceId: cand.sourceId, docId: cand.docId, submittedWordStart: r.s, submittedWordEnd: r.e, sourceWordStart: r.j, words: n, tier, rareWords: rare, rareByDf, contentShare: +content.toFixed(3), form: formHit?.category ?? null, sameSourceRuns: 0, otherHolders: -1 } as Omit<ShortRun, "decision" | "reason">;
      if (formHit) { evaluated.push({ ...base, decision: "NOT_DISTINCTIVE", reason: "form" }); continue; }
      if (rare < t.rare || content < t.content) { evaluated.push({ ...base, decision: "NOT_DISTINCTIVE", reason: "few rare / content words" }); continue; }
      const others = await holdersOf(words, cand.docId);
      base.otherHolders = others;
      evaluated.push({ ...base, decision: others === 0 ? "DISTINCTIVE" : "NOT_DISTINCTIVE", reason: others === 0 ? "unique in the index" : "held by other articles" });
    }
    // 6-14: needs other distinctive-evidence runs from the same article
    const qualifying = evaluated.filter((e) => e.decision === "DISTINCTIVE" || (e.tier === "6-14" && e.reason === "unique in the index"));
    for (const e of evaluated) {
      e.sameSourceRuns = qualifying.filter((q) => q !== e).length;
      if (e.tier === "6-14" && e.decision === "DISTINCTIVE" && e.sameSourceRuns < (rule.c?.sameSource ?? Infinity)) { e.decision = "NOT_DISTINCTIVE"; e.reason = "isolated 6-14 run"; }
    }
    out.push(...evaluated);
  }
  const words = new Set<number>();
  for (const e of out) if (e.decision === "DISTINCTIVE") for (let q = e.submittedWordStart; q <= e.submittedWordEnd; q += 1) words.add(q);
  return { version: ASJP_SHORT_PASSAGES_VERSION, runs: out, distinctiveWords: [...words].sort((x, y) => x - y) };
}

/**
 * Phase 6.5: the 25–59-word SHORT-PASSAGE SIGNAL — a separate, UNSCORED research signal for an isolated research /
 * debug view. It is the DISTINCTIVE 25–59-word runs of shortPassageRuns (the frozen SHORT_RULE tier a), each with its
 * source and exact source offsets; 6–24-word runs stay research-only (shortPassageRuns) and are never in the signal.
 * Its positions are never scored highlights: they are outside the lane's credited words by construction and must
 * never be passed to computeUnifiedSimilarity or counted in a similarity percentage.
 */
export type AsjpShortPassageSignal = {
  version: string;
  scored: false;
  label: "UNSCORED_RESEARCH_SIGNAL";
  passages: Array<{
    sourceId: string; docId: string; band: "25-39" | "40-59"; words: number;
    submittedWordStart: number; submittedWordEnd: number;
    sourceWordStart: number; sourceWordEnd: number; sourceCharStart: number; sourceCharEnd: number;
    rareWords: number; contentShare: number;
  }>;
};
export async function asjpShortPassageSignal(options: Parameters<typeof shortPassageRuns>[0]): Promise<AsjpShortPassageSignal> {
  const { runs } = await shortPassageRuns(options);
  const passages: AsjpShortPassageSignal["passages"] = [];
  const spansOf = new Map<string, ReturnType<typeof tokenSpans> | null>();
  for (const r of runs) {
    if (r.decision !== "DISTINCTIVE" || r.tier !== "25-59") continue;
    if (!spansOf.has(r.docId)) {
      const fetched = await options.reader.fetchText(docIdFromDecimal(r.docId));
      spansOf.set(r.docId, fetched.state === "OK" ? tokenSpans(fetched.text, 2) : null);
    }
    const spans = spansOf.get(r.docId);
    const sourceWordEnd = r.sourceWordStart + r.words - 1;
    const start = spans?.[r.sourceWordStart]?.start, end = spans?.[sourceWordEnd]?.end;
    // exact source offsets or no passage (never a link to nowhere)
    if (start === undefined || end === undefined || !(end > start)) continue;
    passages.push({ sourceId: r.sourceId, docId: r.docId, band: r.words >= 40 ? "40-59" : "25-39", words: r.words, submittedWordStart: r.submittedWordStart, submittedWordEnd: r.submittedWordEnd, sourceWordStart: r.sourceWordStart, sourceWordEnd, sourceCharStart: start, sourceCharEnd: end, rareWords: r.rareWords, contentShare: r.contentShare });
  }
  return { version: ASJP_SHORT_PASSAGES_VERSION, scored: false, label: "UNSCORED_RESEARCH_SIGNAL", passages };
}
