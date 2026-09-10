import type { SelectiveCorpusVerifiedSpan } from "./verify";
import { SELECTIVE_CORPUS_CO_SOURCE } from "./constants";

/**
 * Selective Corpus V1 SHADOW slice — co-source span attribution.
 *
 * The frozen structural rule from the co-source-attribution run (rule sha256
 * ff3a4d00…). ATTRIBUTION ONLY: it never removes a matched submission position
 * from the global union — it only decides which admitted source is credited
 * for positions the matcher already matched.
 *
 * For a run R of positions claimed by >= 2 admitted sources, let S* be the
 * source whose covering span is longest. Displace R from another source S_j iff
 * ALL of:
 *   1. S_j's covering span is NOT S_j's dominant span and is shorter than it;
 *   2. S_j's covering span is position-contained (+/- shingle slack) in S*'s;
 *   3. S*'s covering span IS S*'s dominant span and is strictly longer;
 *   4. after removing R (and any other runs displaced from S_j) S_j still
 *      retains >= 60 matched words AND a >= 25-word contiguous span.
 * Otherwise preserve multi-attribution.
 */

export type SelectiveCorpusCoSourceResult = {
  /** key -> attributed submission positions (after disambiguation). */
  attributed: Map<string, Set<number>>;
  /** union of ALL attributed positions — identical before and after (invariant). */
  unionBefore: Set<number>;
  unionAfter: Set<number>;
  positionsReassigned: number;
  activations: number;
};

const posOf = (spans: readonly SelectiveCorpusVerifiedSpan[]): Set<number> => {
  const s = new Set<number>();
  for (const p of spans) for (let i = p.start; i <= p.end; i++) s.add(i);
  return s;
};
const dominant = (spans: readonly SelectiveCorpusVerifiedSpan[]): SelectiveCorpusVerifiedSpan =>
  spans.slice().sort((a, b) => b.words - a.words)[0];

function contiguousStats(set: Set<number>): { total: number; longest: number } {
  if (set.size === 0) return { total: 0, longest: 0 };
  const a = [...set].sort((x, y) => x - y);
  let longest = 1;
  let cur = 1;
  for (let i = 1; i < a.length; i++) {
    if (a[i] === a[i - 1] + 1) {
      cur += 1;
      longest = Math.max(longest, cur);
    } else cur = 1;
  }
  return { total: a.length, longest };
}

export function disambiguateSelectiveCorpusCoSources(
  spansByKey: Map<string, SelectiveCorpusVerifiedSpan[]>,
): SelectiveCorpusCoSourceResult {
  const attributed = new Map<string, Set<number>>();
  for (const [k, v] of spansByKey) attributed.set(k, new Set(posOf(v)));
  const domByKey = new Map<string, SelectiveCorpusVerifiedSpan>();
  for (const [k, v] of spansByKey) domByKey.set(k, dominant(v));

  const unionBefore = new Set<number>();
  for (const s of attributed.values()) for (const p of s) unionBefore.add(p);

  // runs of positions claimed by >= 2 keys
  const claim = new Map<number, string[]>();
  for (const [k, set] of attributed) for (const p of set) {
    const list = claim.get(p);
    if (list) list.push(k);
    else claim.set(p, [k]);
  }
  const shared = [...claim.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => a[0] - b[0]);
  const runs: { start: number; end: number; key: string; keys: string[] }[] = [];
  let cur: { start: number; end: number; key: string; keys: string[] } | null = null;
  for (const [pos, keys] of shared) {
    const key = keys.slice().sort().join("+");
    if (cur && cur.end === pos - 1 && cur.key === key) cur.end = pos;
    else {
      if (cur) runs.push(cur);
      cur = { start: pos, end: pos, key, keys: keys.slice().sort() };
    }
  }
  if (cur) runs.push(cur);

  let positionsReassigned = 0;
  let activations = 0;
  const slack = SELECTIVE_CORPUS_CO_SOURCE.containmentSlackWords;

  for (const run of runs) {
    const cover: Record<string, SelectiveCorpusVerifiedSpan | undefined> = {};
    for (const k of run.keys) {
      const spans = spansByKey.get(k) ?? [];
      cover[k] =
        spans.filter((s) => s.start <= run.start && s.end >= run.end).sort((a, b) => b.words - a.words)[0] ??
        spans.filter((s) => !(s.end < run.start || s.start > run.end)).sort((a, b) => b.words - a.words)[0];
    }
    const strongest = run.keys.slice().sort((a, b) => (cover[b]?.words ?? 0) - (cover[a]?.words ?? 0))[0];
    const cs = cover[strongest];
    if (!cs) continue;
    for (const k of run.keys) {
      if (k === strongest) continue;
      const cj = cover[k];
      if (!cj) continue;
      const dj = domByKey.get(k);
      const ds = domByKey.get(strongest);
      if (!dj || !ds) continue;
      const cond1 = !(cj.start === dj.start && cj.end === dj.end) && cj.words < dj.words;
      const cond2 = cj.start >= cs.start - slack && cj.end <= cs.end + slack;
      const cond3 = cs.start === ds.start && cs.end === ds.end && cs.words > cj.words;
      let cond4 = false;
      if (cond1 && cond2 && cond3) {
        const remaining = new Set(attributed.get(k));
        for (let i = run.start; i <= run.end; i++) remaining.delete(i);
        const st = contiguousStats(remaining);
        cond4 =
          st.total >= SELECTIVE_CORPUS_CO_SOURCE.retainMinMatchedWords &&
          st.longest >= SELECTIVE_CORPUS_CO_SOURCE.retainMinLongestSpan;
      }
      if (cond1 && cond2 && cond3 && cond4) {
        for (let i = run.start; i <= run.end; i++) attributed.get(k)!.delete(i);
        positionsReassigned += run.end - run.start + 1;
        activations += 1;
      }
    }
  }

  const unionAfter = new Set<number>();
  for (const s of attributed.values()) for (const p of s) unionAfter.add(p);

  return { attributed, unionBefore, unionAfter, positionsReassigned, activations };
}
