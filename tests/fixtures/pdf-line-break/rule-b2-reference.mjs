// RULE B2 — FROZEN REFERENCE (scratch, not repo code). Do not edit: its SHA-256 is recorded in RULE_B2_FROZEN.json.
//
// RULE B2 = frozen Rule B (ruleB-frozen.mjs, sha256 b36764af96f89b8d7d26b6803b9e4058377bf9eb8fe52ce00ea0edb97adacafd)
//         + ONE added predicate, 7b: neither token around the break may show URL / domain / address structure.
// This file is generated from ruleB-frozen.mjs by b2/make-b2.mjs; the only code differences are the constant
// URL_STRUCTURE and the line that tests it. No other predicate or threshold differs.
//
// A self-contained port of exactly the computation that produced the development-set numbers in DECISION.md
// (build-lines.mjs summarize -> analyze.mjs features -> eval-rules.mjs rule "PF"), with no labels, no lexicon and
// no document-set knowledge. Input: the per-page pdfjs getTextContent() item arrays. Output: join decisions.
//
// Evidence is built ONCE from the original, unrepaired segments (buildEvidence) and is immutable afterwards;
// decisions never feed back into it.

// ---------------------------------------------------------------- stage 0: lib/pdf-text-extraction.ts v1 replica
const itemStr = (item) => (item && typeof item === "object" && "str" in item ? String(item.str ?? "") : "");
function itemGeometry(item) {
  if (!item || typeof item !== "object") return null;
  const { transform, width } = item;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const left = Number(transform[4]);
  const baseline = Number(transform[5]);
  const numericWidth = Number(width);
  const emSize = Math.abs(Number(transform[0])) || Math.abs(Number(transform[3]));
  if (!Number.isFinite(left) || !Number.isFinite(baseline) || !Number.isFinite(numericWidth) || !Number.isFinite(emSize) || emSize <= 0) return null;
  return { left, right: left + numericWidth, baseline, emSize };
}
const ADJACENT_RUN_TOLERANCE_RATIO = 0.15;
function glyphsAreAdjacent(before, after) {
  const a = itemGeometry(before);
  const b = itemGeometry(after);
  if (!a || !b) return false;
  const tolerance = Math.max(a.emSize, b.emSize) * ADJACENT_RUN_TOLERANCE_RATIO;
  return Math.abs(b.baseline - a.baseline) < tolerance && Math.abs(b.left - a.right) < tolerance;
}

// ---------------------------------------------------------------- stage 1: segments
const r1 = (n) => Math.round(n * 10) / 10;
/** One page of pdfjs items -> segments. `productText` is byte-identical to v1 joinPageTextItems(items). */
export function segmentPage(items) {
  const raw = [];
  let cur = null;
  let previousItem = null;
  let productText = "";
  let pendingSep = "";
  for (const item of items) {
    const str = itemStr(item);
    let sep = "";
    if (previousItem !== null) sep = glyphsAreAdjacent(previousItem, item) ? "" : " ";
    productText += sep + str;
    previousItem = item;
    if (!cur) { cur = { text: str, items: [], sepBefore: pendingSep + sep }; pendingSep = ""; }
    else cur.text += sep + str;
    cur.items.push(item);
    if (item && typeof item === "object" && item.hasEOL) {
      if (cur.text.trim() === "") { pendingSep += cur.sepBefore + cur.text; cur = null; }
      else { raw.push(cur); cur = null; }
    }
  }
  if (cur) { if (cur.text.trim() === "") { pendingSep += cur.sepBefore + cur.text; cur = null; } else { raw.push(cur); cur = null; } }
  const lines = [];
  // `all` keeps EVERY segment for text emission; `lines` keeps only segments with geometry, which are the
  // only ones the rule ever looks at (a segment rotated by 90 degrees, or a test double, has no geometry).
  const all = raw.map((line) => ({ t: line.text, s: line.sepBefore }));
  for (const [ai, line] of raw.entries()) {
    const ink = line.items.filter((it) => itemStr(it).trim() !== "" && itemGeometry(it));
    if (ink.length === 0) continue;
    const g = ink.map((it) => ({ it, g: itemGeometry(it) }));
    const widest = g.reduce((a, b) => ((b.g.right - b.g.left) > (a.g.right - a.g.left) ? b : a));
    const first = g[0];
    const last = g[g.length - 1];
    lines.push({
      ai, t: line.text, s: line.sepBefore,
      x0: r1(Math.min(...g.map((x) => x.g.left))), x1: r1(Math.max(...g.map((x) => x.g.right))),
      y: r1(widest.g.baseline), em: r1(widest.g.emSize),
      fe: r1(first.g.emSize), fd: first.it.dir ?? "",
      le: r1(last.g.emSize), ld: last.it.dir ?? "",
      rot: ink.some((it) => Math.abs(Number(it.transform[1])) > 1e-6 || Math.abs(Number(it.transform[2])) > 1e-6) ? 1 : 0,
    });
  }
  return { lines, all, productText, tail: pendingSep };
}

// ---------------------------------------------------------------- stage 2: evidence (immutable, from the original text only)
const HY = "\\-\\u00AD\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212";
const END_RE = new RegExp(`(\\p{L}[\\p{L}\\p{M}]*)([${HY}])$`, "u");
const START_RE = /^(\p{L}[\p{L}\p{M}]*)/u;
const isLatin = (s) => /^[\p{Script=Latin}\p{M}]+$/u.test(s);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** pages: [{ lines: [segment] }]. Returns frozen Maps: inline words and inline hyphenated pairs. */
export function buildEvidence(pages) {
  const words = new Map(); const pairs = new Map();
  for (const pg of pages) for (const [li, l] of pg.lines.entries()) {
    let body = l.t.toLowerCase();
    if (END_RE.test(l.t.trimEnd())) body = body.trimEnd().replace(/\S+$/u, "");
    const prev = li > 0 ? pg.lines[li - 1] : null;
    if (prev && END_RE.test(prev.t.trimEnd())) body = body.trimStart().replace(/^\S+/u, "");
    for (const m of body.matchAll(/\p{L}+(?:[-‐‑]\p{L}+)*/gu)) {
      const parts = m[0].split(/[-‐‑]/u);
      for (const p of parts) words.set(p, (words.get(p) ?? 0) + 1);
      for (let i = 0; i + 1 < parts.length; i += 1) { const k = `${parts[i]}-${parts[i + 1]}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
    }
  }
  return { words, pairs };
}

// ---------------------------------------------------------------- stage 3: candidates, features, decision
const SHAPE_L = /(?:^|\s)[\p{Ps}\p{Pi}"']*(\p{L}[\p{L}\p{M}]*)-$/u;
const SHAPE_R = /^(\p{L}[\p{L}\p{M}]*)(?=$|\s|[\p{Pe}\p{Pf}.,;:!?"'])/u;
// B2: URL / domain / address structure anywhere in a white-space-delimited token:
//   a slash, an at-sign, or a full stop or colon immediately followed by a letter or a digit.
const URL_STRUCTURE = /[/@]|[.:][\p{L}\p{N}]/u;

/**
 * pages: [{ p?, lines: [segment] }] in document order.
 * Returns every line-final hyphen-like site followed by a letter-initial segment, with features and the decision.
 * kind "page-boundary" sites are reported for measurement only and can never be joined.
 */
export function decideDocument(pages) {
  const evidence = buildEvidence(pages);
  const sites = [];
  for (const [pi, pg] of pages.entries()) {
    const L = pg.lines;
    const pitches = [];
    for (let i = 0; i + 1 < L.length; i += 1) { const dy = L[i].y - L[i + 1].y; if (dy > 0 && Math.abs(L[i].x0 - L[i + 1].x0) < 3 * L[i].em && dy < 3 * L[i].em) pitches.push(dy); }
    const pitch = median(pitches);
    const gx0 = new Array(L.length); const gx1 = new Array(L.length); const gid = new Array(L.length);
    for (let i = 0, g = -1; i < L.length; i += 1) {
      const prevSeg = i > 0 ? L[i - 1] : null;
      const sameLine = prevSeg && Math.abs(L[i].y - prevSeg.y) <= 0.35 * Math.max(L[i].em, prevSeg.em) && L[i].x0 >= prevSeg.x1 - 0.5 * L[i].em;
      if (!sameLine) g += 1;
      gid[i] = g;
    }
    for (let i = 0; i < L.length; i += 1) {
      let a = L[i].x0, b = L[i].x1;
      for (let j = i - 1; j >= 0 && gid[j] === gid[i]; j -= 1) { a = Math.min(a, L[j].x0); b = Math.max(b, L[j].x1); }
      for (let j = i + 1; j < L.length && gid[j] === gid[i]; j += 1) { a = Math.min(a, L[j].x0); b = Math.max(b, L[j].x1); }
      gx0[i] = a; gx1[i] = b;
    }
    const consider = [];
    for (let i = 0; i + 1 < L.length; i += 1) consider.push([L[i], L[i + 1], i, "same-page"]);
    const next = pages[pi + 1];
    if (next && L.length && next.lines.length) consider.push([L[L.length - 1], next.lines[0], L.length - 1, "page-boundary"]);
    for (const [A, B, i, kind] of consider) {
      const a = A.t.trimEnd(); const b = B.t.trimStart();
      const me = END_RE.exec(a);
      if (!me) continue;
      const ms = START_RE.exec(b);
      if (!ms) { sites.push({ pi, p: pg.p ?? pi + 1, i, kind, hy: me[2].codePointAt(0).toString(16).toUpperCase().padStart(4, "0"), L: me[1], R: null, nextNonLetter: true, join: false, failed: ["next-line-not-letter"] }); continue; }
      const Lf = me[1], hy = me[2], Rf = ms[1];
      const tokL = a.slice(a.search(/\S+$/u));
      const tokR = b.slice(0, b.search(/\s|$/u));
      const em = Math.max(A.le || A.em, 1);
      let blockRight = null; let neigh = 0;
      if (kind === "same-page") {
        for (let j = Math.max(0, i - 6); j <= Math.min(L.length - 1, i + 6); j += 1) {
          const n = L[j];
          if (n.rot) continue;
          if (Math.abs(gx0[j] - gx0[i]) <= 3 * em && Math.abs(n.y - A.y) <= 10 * em) { blockRight = blockRight === null ? gx1[j] : Math.max(blockRight, gx1[j]); if (gid[j] !== gid[i]) neigh += 1; }
        }
      }
      const ax0 = kind === "same-page" ? gx0[i] : A.x0;
      const bx0 = kind === "same-page" ? gx0[i + 1] : B.x0;
      const bLen = Math.max(1, b.trimEnd().length);
      const avgChar = (B.x1 - B.x0) / bLen;
      const firstBreak = tokR.search(/[-‐‑]/u);
      const rChunk = firstBreak > 0 ? tokR.slice(0, firstBreak) : tokR;
      const wR = avgChar * rChunk.length;
      const dy = A.y - B.y;
      const joined = (Lf + Rf).toLowerCase(); const pair = `${Lf}-${Rf}`.toLowerCase();
      const f = {
        hy: hy.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"),
        lowL: /\p{Ll}$/u.test(Lf) ? 1 : 0, lowR: /^\p{Ll}/u.test(Rf) ? 1 : 0, latin: isLatin(Lf) && isLatin(Rf) ? 1 : 0,
        dyEm: +(dy / em).toFixed(2), pitchDev: pitch ? +(Math.abs(dy - pitch) / pitch).toFixed(2) : null,
        dx0Em: +((bx0 - ax0) / em).toFixed(2), bLeftOfAEnd: bx0 < A.x1 ? 1 : 0,
        emRatio: +((B.fe || B.em) / em).toFixed(2),
        rightGapEm: blockRight === null ? null : +((blockRight - A.x1) / em).toFixed(2), neigh,
        fitGapEm: blockRight === null ? null : +((blockRight - (A.x1 - 0.33 * em + wR)) / em).toFixed(2),
        rot: A.rot || B.rot ? 1 : 0, dirA: A.ld, dirB: B.fd,
        jd: evidence.words.get(joined) ?? 0, pd: evidence.pairs.get(pair) ?? 0,
      };
      // ---- the ordered predicates of Rule B2; every failed one is recorded
      const failed = [];
      if (kind !== "same-page") failed.push("1-same-page");
      if (f.hy !== "002D") failed.push("2-hyphen-is-U+002D");
      if (!(f.lowL === 1 && f.lowR === 1)) failed.push("3-lowercase-at-break");
      if (f.latin !== 1) failed.push("4-latin-fragments");
      if (!(Lf.length >= 2 && Rf.length >= 2)) failed.push("5-fragment-length>=2");
      if (!SHAPE_L.test(` ${tokL}`)) failed.push("6-left-token-shape");
      if (!SHAPE_R.test(tokR)) failed.push("7-right-token-shape");
      if (URL_STRUCTURE.test(tokL) || URL_STRUCTURE.test(tokR)) failed.push("7b-no-url-structure");
      if (!(!f.rot && f.dirA !== "rtl" && f.dirB !== "rtl")) failed.push("8-upright-not-rtl");
      if (!(f.dyEm > 0.5 && (f.dyEm <= 2.6 || (f.pitchDev !== null && f.pitchDev <= 0.25)) && f.dyEm <= 4)) failed.push("9-next-line-below-at-body-pitch");
      if (!(f.dx0Em >= -6 && f.dx0Em <= 3 && f.bLeftOfAEnd === 1)) failed.push("10-same-column");
      if (!(f.emRatio >= 0.7 && f.emRatio <= 1.45)) failed.push("11-font-size-ratio");
      if (!(f.rightGapEm !== null && f.neigh >= 1 && f.fitGapEm < 0.5)) failed.push("12-right-edge-would-not-fit");
      if (!(f.jd >= 1)) failed.push("13-joined-word-inline");
      if (!(f.pd === 0)) failed.push("14-pair-never-inline");
      sites.push({ pi, p: pg.p ?? pi + 1, i, kind, L: Lf, R: Rf, tokL, tokR, ...f, join: failed.length === 0, failed });
    }
  }
  return { sites, evidence };
}

/**
 * Apply decisions. Returns one string per page. With no join the string is byte-identical to v1
 * joinPageTextItems(items). A decided join is applied only when the two segments are adjacent in the full
 * segment list (no geometry-less segment between them); otherwise it is skipped and counted.
 */
export function applyJoins(pages, sites) {
  let skippedNonAdjacent = 0;
  const texts = pages.map((pg, pi) => {
    const joinAfterAll = new Set();
    for (const s of sites) {
      if (!s.join || s.pi !== pi) continue;
      const a = pg.lines[s.i].ai, b = pg.lines[s.i + 1].ai;
      if (b === a + 1) joinAfterAll.add(a); else skippedNonAdjacent += 1;
    }
    let text = ""; let joinNext = false;
    for (const [ai, l] of pg.all.entries()) {
      if (joinNext) text = text.trimEnd().slice(0, -1) + l.t.trimStart();
      else text += l.s + l.t;
      joinNext = joinAfterAll.has(ai);
    }
    return text + (pg.tail ?? "");
  });
  return { texts, skippedNonAdjacent };
}

/** Convenience: pdfjs item arrays -> { pages, sites, texts }. */
export function ruleB(pagesOfItems) {
  const pages = pagesOfItems.map((items, pi) => ({ p: pi + 1, ...segmentPage(items) }));
  const { sites, evidence } = decideDocument(pages);
  const { texts, skippedNonAdjacent } = applyJoins(pages, sites);
  return { pages, sites, evidence, texts, skippedNonAdjacent };
}
