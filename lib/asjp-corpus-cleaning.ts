import { alignTokenSpans, normalizeScoringV2 } from "./similarity-core";

/**
 * ASJP corpus-text cleaning — INGESTION ONLY. Never applied to a submission, an upload, a stored report or evaluation
 * text: it decides what of a journal article's extracted text goes into a corpus index, nothing else.
 *
 * ASJP article PDFs repeat journal furniture on every page (running headers and footers, ISSN / legal-deposit lines,
 * licence lines, author/title running heads, page numbers) and some bundle the journal's front matter. In the
 * 2026-10-08 pilot (270 articles) that furniture produced most verified cross-article overlap. This removes it
 * conservatively and records every removal so the original text can be rebuilt and audited.
 *
 * Input: one journal's articles, each as the page strings of pdf-text-extraction-v3 (`splitExtractedPages`).
 *
 *   R1 RUNNING_HEADER_FOOTER  a run of >= 4 tokens inside a page's head/tail zone (first/last 40 tokens; 80 on the
 *                             first page) recurring in the zones of >= 3 pages AND >= 40% of the article's non-empty
 *                             pages (>= 2 pages when it has <= 4).
 *   R2 JOURNAL_FURNITURE      a run of >= 5 tokens inside a page zone recurring in page zones of >= 3 different
 *                             articles of the same journal.
 *   R1 and R2 tokens are removed ONLY as an EDGE-ANCHORED block: from the page's first token forward (and from its last
 *   token backward), consecutive R1/R2 tokens with at most two page-number digits between them, stopping at the first
 *   ordinary token. An R1 run is removed only when an 8-token window of it (digits masked) recurs as header text on the
 *   same share of pages. A repeated phrase inside the page body is never removed, except a maximal run of >= 8 R1
 *   tokens whose window text recurs on >= 70% of the pages (a header line pdf.js emitted mid-page).
 *   R3 SHARED_PAGE            a whole page whose 5-gram set is >= 80% contained in one page of ANOTHER article of the
 *                             same journal (front matter / author guidelines bundled into article PDFs).
 *   PAGE_NUMBER               digits inside a kept edge block, or a bare first/last token continuing the page sequence.
 *
 * DUPLICATE PUBLICATIONS (v2). Two articles of the group whose whole-text 5-gram sets overlap by >= 50% of the smaller
 * are one work published twice (ASJP 56643 / 68197: 97%, another title). Their shared pages are BODY, not front matter:
 * v1 R3 deleted 9 body pages from both copies. So R3 never matches a page against a page of a duplicate partner, and R2
 * does not count an article for a 5-gram its duplicate partner already counted. Only texts with >= 200 distinct 5-grams
 * qualify (a header-only scan is contained in every journal-mate). Each result names its duplicate partners
 * (`duplicatePublications`); which copy to index is the caller's decision. Measured on 531 real ar/fr/en articles
 * (102 journals): the duplicate pair is at 0.968, the one real front-matter pair at 0.029.
 *
 * Header keys ignore U+0640 ARABIC TATWEEL (justification stretching varies from page to page). The removed text is
 * replaced by one space; nothing else in the page changes, so the cleaned text is a pure deletion of the extracted
 * text's tokens. Pilot audit: 0 body-text removals in a random sample of 45 spans after the edge-anchoring rule
 * (earlier rule versions removed recurring topic phrases; the measurements are in the pilot record).
 */

export const ASJP_CORPUS_CLEANING_VERSION = "asjp-corpus-cleaning-v2";

export type AsjpCleaningRule = "RUNNING_HEADER_FOOTER" | "JOURNAL_FURNITURE" | "SHARED_PAGE" | "PAGE_NUMBER";
/** One removal: page (1-based), character offsets in that page's ORIGINAL string, the rule, and the removed text. */
export type AsjpRemovedSpan = { page: number; start: number; end: number; rule: AsjpCleaningRule; text: string };
export type AsjpCleanedArticle = {
  id: string;
  pages: number;
  originalTokens: number;
  removedTokens: number;
  removed: AsjpRemovedSpan[];
  /** Other articles of the group that are the same text published again (whole-text 5-gram containment of the smaller). */
  duplicatePublications: Array<{ id: string; containmentOfSmaller: number }>;
  /** Cleaned pages joined the way the extractor joins pages ("\n\n" between pages, "\n\n" at the end). */
  cleanedText: string;
};

type Span = { word: string; start: number; end: number };

const ZONE = 40;
const FIRST_PAGE_ZONE = 80;
const R1_K = 4;
const R2_K = 5;
const R2_ARTICLES = 3;
const R3_CONTAINMENT = 0.8;
const DUPLICATE_CONTAINMENT = 0.5;
const DUPLICATE_MIN_GRAMS = 200;
const WINDOW = 8;
const TATWEEL = /ـ/g;

/** The extractor's page strings (pdf-text-extraction joins pages with "\n\n" and ends with "\n\n"). */
export function splitExtractedPages(text: string): string[] {
  const pages = text.split("\n\n");
  if (pages.length > 1 && pages[pages.length - 1] === "") pages.pop();
  return pages;
}

/** Scoring-normalization-v2 tokens of a page, with their character offsets in the page string. */
function pageSpans(text: string): Span[] {
  return alignTokenSpans(text, normalizeScoringV2(text).split(" ").filter(Boolean), 2);
}

export function cleanAsjpJournalArticles(articles: ReadonlyArray<{ id: string; pages: readonly string[] }>): AsjpCleanedArticle[] {
  const parsed = articles.map((a) => ({ id: a.id, pages: a.pages.map((text) => ({ text, spans: pageSpans(text) })) }));
  const zoneRanges = (n: number, pageIndex: number): Array<[number, number]> => {
    const head = pageIndex === 0 ? FIRST_PAGE_ZONE : ZONE;
    return n <= head + ZONE ? [[0, n]] : [[0, head], [n - ZONE, n]];
  };
  const gramsIn = (spans: Span[], k: number, ranges: Array<[number, number]>) => {
    const out = new Map<string, number[]>();
    for (const [a, b] of ranges) {
      for (let i = a; i + k <= b; i += 1) {
        const g = spans.slice(i, i + k).map((s) => s.word.replace(TATWEEL, "")).join(" ");
        if (/^[\d ]+$/.test(g)) continue;
        out.set(g, [...(out.get(g) ?? []), i]);
      }
    }
    return out;
  };
  // Page 5-gram sets (R3) and their union per article (duplicate publications).
  const pageSets = parsed.map((art) => art.pages.map((p) => {
    const set = new Set<string>();
    for (let i = 0; i + 5 <= p.spans.length; i += 1) set.add(p.spans.slice(i, i + 5).map((x) => x.word.replace(TATWEEL, "")).join(" "));
    return set;
  }));
  const articleSets = pageSets.map((pages) => { const set = new Set<string>(); for (const p of pages) for (const g of p) set.add(g); return set; });
  const duplicates = parsed.map(() => new Map<number, number>());
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const [small, large] = articleSets[i].size <= articleSets[j].size ? [articleSets[i], articleSets[j]] : [articleSets[j], articleSets[i]];
      // A near-empty text (e.g. a scan whose only text is the running header) is not a publication of anything.
      if (small.size < DUPLICATE_MIN_GRAMS) continue;
      let shared = 0;
      for (const g of small) if (large.has(g)) shared += 1;
      const containment = shared / small.size;
      if (containment >= DUPLICATE_CONTAINMENT) { duplicates[i].set(j, containment); duplicates[j].set(i, containment); }
    }
  }
  // R2: zone 5-grams, counted once per article; an article whose duplicate partner already counted the gram adds nothing.
  const journalCount = new Map<string, number>();
  const countedBy = new Map<string, number[]>();
  parsed.forEach((art, ai) => {
    const seen = new Set<string>();
    art.pages.forEach((p, pi) => { for (const g of gramsIn(p.spans, R2_K, zoneRanges(p.spans.length, pi)).keys()) seen.add(g); });
    for (const g of seen) {
      const by = countedBy.get(g) ?? [];
      if (by.some((aj) => duplicates[ai].has(aj))) continue;
      countedBy.set(g, [...by, ai]);
      journalCount.set(g, (journalCount.get(g) ?? 0) + 1);
    }
  });

  return parsed.map((art, ai) => {
    const removedTok = art.pages.map((p) => new Array<AsjpCleaningRule | null>(p.spans.length).fill(null));
    art.pages.forEach((p, pi) => {
      const mine = pageSets[ai][pi];
      if (mine.size < 20) return;
      for (let aj = 0; aj < parsed.length; aj += 1) {
        if (aj === ai || duplicates[ai].has(aj)) continue;
        for (const other of pageSets[aj]) {
          if (other.size < 20) continue;
          let shared = 0;
          for (const g of mine) if (other.has(g)) shared += 1;
          if (shared / mine.size >= R3_CONTAINMENT) { removedTok[pi].fill("SHARED_PAGE"); return; }
        }
      }
    });

    const pageCount = new Map<string, number>();
    const zoneGrams = art.pages.map((p, pi) => gramsIn(p.spans, R1_K, zoneRanges(p.spans.length, pi)));
    for (const zg of zoneGrams) for (const g of zg.keys()) pageCount.set(g, (pageCount.get(g) ?? 0) + 1);
    const nonEmptyPages = art.pages.filter((p) => p.spans.length > 0).length;
    // Pilot: running headers recur on 40-100% of pages (alternating headers ~50%); recurring topic phrases <= 28%.
    const r1Min = nonEmptyPages <= 4 ? 2 : Math.max(3, Math.ceil(0.4 * nonEmptyPages));
    const maskKey = (pi: number, ts: number[]) => ts.map((t) => art.pages[pi].spans[t].word.replace(TATWEEL, "").replace(/\d+/g, "#")).join(" ");

    // Phase A: candidates and tentative edge-anchored blocks (pilot: headers sit 0-1 tokens from the edge).
    type Block = { pi: number; tokens: Array<{ t: number; rule: AsjpCleaningRule }> };
    const blocks: Block[] = [];
    const midRuns: Array<{ pi: number; ts: number[] }> = [];
    art.pages.forEach((p, pi) => {
      if (removedTok[pi][0] === "SHARED_PAGE") return;
      const candidate = new Array<AsjpCleaningRule | null>(p.spans.length).fill(null);
      for (const [g, starts] of zoneGrams[pi]) if ((pageCount.get(g) ?? 0) >= r1Min) for (const s of starts) for (let t = s; t < s + R1_K; t += 1) candidate[t] ??= "RUNNING_HEADER_FOOTER";
      for (const [g, starts] of gramsIn(p.spans, R2_K, zoneRanges(p.spans.length, pi))) if ((journalCount.get(g) ?? 0) >= R2_ARTICLES) for (const s of starts) for (let t = s; t < s + R2_K; t += 1) candidate[t] ??= "JOURNAL_FURNITURE";
      const isNumber = (t: number) => /^\d{1,4}$/.test(p.spans[t].word);
      const walk = (from: number, step: 1 | -1) => {
        const tokens: Block["tokens"] = [];
        let streak = 0;
        for (let t = from; t >= 0 && t < p.spans.length; t += step) {
          const rule = candidate[t];
          if (rule) { tokens.push({ t, rule }); streak = 0; continue; }
          if (isNumber(t) && streak < 2) { tokens.push({ t, rule: "PAGE_NUMBER" }); streak += 1; continue; }
          break; // an ordinary token, or a third number in a row (table content), ends the block
        }
        while (tokens.length && tokens[tokens.length - 1].rule === "PAGE_NUMBER") tokens.pop();
        if (tokens.some((x) => x.rule !== "PAGE_NUMBER")) blocks.push({ pi, tokens });
      };
      walk(0, 1);
      walk(p.spans.length - 1, -1);
      for (let t = 0; t < candidate.length; t += 1) {
        if (candidate[t] !== "RUNNING_HEADER_FOOTER") continue;
        let u = t;
        while (u + 1 < candidate.length && candidate[u + 1] === "RUNNING_HEADER_FOOTER") u += 1;
        if (u - t + 1 >= WINDOW) midRuns.push({ pi, ts: Array.from({ length: u - t + 1 }, (_, i) => t + i) });
        t = u;
      }
    });

    // Phase B: window-level recurrence of R1 runs as header text.
    const r1RunsOf = (b: Block) => {
      const out: number[][] = [];
      let cur: number[] = [];
      for (const x of b.tokens) {
        if (x.rule === "RUNNING_HEADER_FOOTER") cur.push(x.t);
        else if (cur.length) { out.push(cur); cur = []; }
      }
      if (cur.length) out.push(cur);
      return out.map((ts) => [...ts].sort((a, c) => a - c));
    };
    const windowsOf = (ts: number[]) => (ts.length <= WINDOW ? [ts] : Array.from({ length: ts.length - WINDOW + 1 }, (_, i) => ts.slice(i, i + WINDOW)));
    const keyPages = new Map<string, Set<number>>();
    const note = (pi: number, ts: number[]) => { for (const w of windowsOf(ts)) { const k = maskKey(pi, w); keyPages.set(k, (keyPages.get(k) ?? new Set()).add(pi)); } };
    for (const b of blocks) for (const ts of r1RunsOf(b)) note(b.pi, ts);
    for (const m of midRuns) note(m.pi, m.ts);
    const recurringTokens = (pi: number, ts: number[], min: number) => new Set(windowsOf(ts).filter((w) => (keyPages.get(maskKey(pi, w))?.size ?? 0) >= min).flat());

    // Phase C: apply.
    for (const b of blocks) {
      const keepR1 = new Set(r1RunsOf(b).flatMap((ts) => [...recurringTokens(b.pi, ts, r1Min)]));
      const kept = b.tokens.filter((x) => (x.rule === "RUNNING_HEADER_FOOTER" && keepR1.has(x.t)) || x.rule === "JOURNAL_FURNITURE");
      if (!kept.length) continue;
      for (const x of kept) removedTok[b.pi][x.t] ??= x.rule;
      let lastKept = -1;
      b.tokens.forEach((x, i) => { if (x.rule !== "PAGE_NUMBER" && kept.includes(x)) lastKept = i; });
      for (const x of b.tokens.slice(0, lastKept + 1)) if (x.rule === "PAGE_NUMBER") removedTok[b.pi][x.t] ??= "PAGE_NUMBER";
    }
    const midMin = Math.max(r1Min, Math.ceil(0.7 * nonEmptyPages));
    for (const m of midRuns) for (const t of recurringTokens(m.pi, m.ts, midMin)) removedTok[m.pi][t] ??= "RUNNING_HEADER_FOOTER";
    const pageNumberOf = (pi: number): number | null => {
      const p = art.pages[pi];
      if (!p) return null;
      for (let t = 0; t < p.spans.length; t += 1) if (removedTok[pi][t] === "PAGE_NUMBER") return Number(p.spans[t].word);
      return null;
    };
    art.pages.forEach((p, pi) => {
      if (removedTok[pi].includes("PAGE_NUMBER")) return;
      for (const t of [0, p.spans.length - 1]) {
        if (t < 0 || removedTok[pi][t] || !/^\d{1,4}$/.test(p.spans[t]?.word ?? "")) continue;
        const value = Number(p.spans[t].word);
        const prev = pageNumberOf(pi - 1);
        const next = pageNumberOf(pi + 1);
        if ((prev !== null && value === prev + 1) || (next !== null && value === next - 1)) { removedTok[pi][t] = "PAGE_NUMBER"; break; }
      }
    });

    const removed: AsjpRemovedSpan[] = [];
    const cleanedPages: string[] = [];
    let originalTokens = 0;
    let removedTokens = 0;
    art.pages.forEach((p, pi) => {
      originalTokens += p.spans.length;
      let out = "";
      let cursor = 0;
      for (let t = 0; t < p.spans.length;) {
        const rule = removedTok[pi][t];
        if (!rule) { t += 1; continue; }
        let u = t;
        while (u + 1 < p.spans.length && removedTok[pi][u + 1] === rule) u += 1;
        const start = p.spans[t].start;
        const end = p.spans[u].end;
        removed.push({ page: pi + 1, start, end, rule, text: p.text.slice(start, end) });
        removedTokens += u - t + 1;
        out += `${p.text.slice(cursor, start)} `;
        cursor = end;
        t = u + 1;
      }
      cleanedPages.push(out + p.text.slice(cursor));
    });
    const duplicatePublications = [...duplicates[ai]].map(([aj, c]) => ({ id: parsed[aj].id, containmentOfSmaller: Math.round(c * 1000) / 1000 }));
    return { id: art.id, pages: art.pages.length, originalTokens, removedTokens, removed, duplicatePublications, cleanedText: `${cleanedPages.join("\n\n")}\n\n` };
  });
}

/** Rebuilds the extractor's original text from a cleaned text and its removal ledger (audit / provenance). */
export function reconstructAsjpOriginalText(cleaned: Pick<AsjpCleanedArticle, "cleanedText" | "removed">): string {
  const pages = splitExtractedPages(cleaned.cleanedText);
  const rebuilt = pages.map((page, pi) => {
    const spans = cleaned.removed.filter((r) => r.page === pi + 1).sort((a, b) => a.start - b.start);
    let out = "";
    let at = 0; // position in the cleaned page
    let shift = 0; // original offset - cleaned offset
    for (const span of spans) {
      const cleanedStart = span.start - shift;
      out += page.slice(at, cleanedStart) + span.text;
      at = cleanedStart + 1; // the one space that replaced the span
      shift += span.end - span.start - 1;
    }
    return out + page.slice(at);
  });
  return `${rebuilt.join("\n\n")}\n\n`;
}
