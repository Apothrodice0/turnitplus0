export type PdfTextContent = {
  items: Array<unknown>;
};

export type PdfTextPage = {
  getTextContent(): Promise<PdfTextContent>;
};

export type PdfTextDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfTextPage>;
};

export type PdfExtractionProgress = (pageNumber: number, pageCount: number) => void;

/**
 * Phase 5 addition — mirrors lib/html-text-extraction.ts's HTML_EXTRACTOR_VERSION convention, for callers (lib/http-content-retriever.ts) that record which extractor produced a given RetrievedSource.extractedText.
 *
 * v2 = the v1 page assembly (joinPageTextItems below, unchanged) + the frozen
 * line-break hyphenation repair "Rule B3" (see repairLineBreakHyphenation).
 * Text extracted under v1 stays v1: the repair needs the page geometry, which
 * no stored text carries, so nothing already extracted is ever rewritten.
 */
export const PDF_EXTRACTOR_VERSION = "pdf-text-extraction-v2";

/**
 * The exact pdf.js release {@link PDF_EXTRACTOR_VERSION} is defined against.
 * Rule B3 reads pdf.js's own item stream (item order, `hasEOL`, `transform`,
 * `width`, `dir`), so a different pdf.js build is a different extractor: the
 * package pin is exact, and the browser path — the only one whose worker is
 * fetched at run time — refuses to extract on any other version.
 */
export const PDF_EXTRACTOR_PDFJS_VERSION = "6.2.108";

export class PdfjsContractVersionError extends Error {
  constructor(loadedVersion: unknown) {
    const loaded = typeof loadedVersion === "string" && loadedVersion.length > 0 ? loadedVersion : "an unknown version";
    super(
      `PDF text extraction ${PDF_EXTRACTOR_VERSION} requires pdf.js ${PDF_EXTRACTOR_PDFJS_VERSION}, but pdf.js ${loaded} was loaded. The document was not read.`,
    );
    this.name = "PdfjsContractVersionError";
  }
}

export function isPdfjsContractVersionError(error: unknown): boolean {
  return error instanceof Error && error.name === "PdfjsContractVersionError";
}

/**
 * Throws {@link PdfjsContractVersionError} unless the loaded pdf.js API is
 * exactly {@link PDF_EXTRACTOR_PDFJS_VERSION}. The worker needs no second
 * check of its own: its URL is built from the same `pdfjs.version`, and pdf.js
 * itself rejects getDocument() when the worker's version differs from the
 * API's ("The API version ... does not match the Worker version ...").
 */
export function assertPdfjsContractVersion(loadedVersion: unknown): void {
  if (loadedVersion !== PDF_EXTRACTOR_PDFJS_VERSION) throw new PdfjsContractVersionError(loadedVersion);
}

type RawPdfTextItem = { str?: unknown; width?: unknown; transform?: unknown; hasEOL?: unknown; dir?: unknown };

function itemStr(item: unknown): string {
  return item && typeof item === "object" && "str" in item
    ? String((item as RawPdfTextItem).str ?? "")
    : "";
}

/**
 * Engineering discovery diagnostic finding (2026-08-21): confirmed live
 * against a real, professionally-typeset Frontiers journal PDF (the
 * benchmark fixture whose own title contains "configuration") that a
 * "fi"/"fl" ligature glyph is rendered from a SEPARATE embedded font subset
 * than its surrounding text — inspected the real pdfjs items directly:
 * "con"/"guration" report fontName "g_d0_f1" while the "fi" between them
 * reports "g_d0_f2" (and the same font-subset split recurs for every other
 * occurrence — "ef"/"ciency", "bene"/"ts", "dif"/"ficult", "fl"/"exibility"
 * — across five different font sizes from 5.5pt to 20.9pt, on two separate
 * pages). A font/style change is exactly the kind of run boundary pdfjs's
 * own getTextContent() splits into a new item for, even though nothing is
 * visually different on the page and there is no real space there at all.
 *
 * Humanities discovery diagnostic finding (2026-08-21): the SAME signal —
 * near-zero geometric gap between consecutive items — also identifies a
 * SECOND, independent cause of the same kind of corruption on a different
 * real PDF: a stylized wordmark ("BIBLINDEX," a paper's own project name)
 * rendered as alternating full/small capitals, a genuine mid-word FONT-SIZE
 * change (12pt "B", 9.48pt "IBL", 12pt "I", 9.48pt "NDEX" — measured across
 * every one of 12+ occurrences on two pages, every gap under 0.05pt). This
 * has nothing to do with "fi"/"fl" specifically — it is the same class of
 * problem (pdfjs splits a text run at a font/style boundary that carries no
 * real space on the page) with a different trigger, so joinPageTextItems
 * below no longer restricts gluing to items whose str happens to read
 * "fi"/"fl": ANY two consecutive items this geometrically adjacent are
 * glued, whatever their content. This is strictly more general than (and
 * subsumes) the original ligature-only rule — it was never about
 * recognizing "configuration" or "BIBLINDEX" as specific words, only about
 * the measured geometry.
 *
 * itemGeometry/glyphsAreAdjacent below detect this from the REAL, measured
 * pdfjs item shape (transform + width): every corrupted occurrence measured
 * across both real fixtures sits within a small fraction of a point of its
 * neighbor's edge, while both documents' own explicit inter-word space
 * items are themselves 0.6pt+ wide with several points of visual gap
 * alongside a genuine word boundary — comfortably on the other side of the
 * tolerance below.
 */
type PdfItemGeometry = { left: number; right: number; baseline: number; emSize: number };

function itemGeometry(item: unknown): PdfItemGeometry | null {
  if (!item || typeof item !== "object") return null;
  const { transform, width } = item as RawPdfTextItem;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const left = Number(transform[4]);
  const baseline = Number(transform[5]);
  const numericWidth = Number(width);
  const emSize = Math.abs(Number(transform[0])) || Math.abs(Number(transform[3]));
  if (!Number.isFinite(left) || !Number.isFinite(baseline) || !Number.isFinite(numericWidth) || !Number.isFinite(emSize) || emSize <= 0) return null;
  return { left, right: left + numericWidth, baseline, emSize };
}

/**
 * A gap under 15% of the item's own font size is treated as "the same
 * continuous glyph/word run, no real space" — every corrupted-split
 * occurrence measured across both real fixtures (the ligature case and the
 * BIBLINDEX wordmark case) fell under 0.4pt of adjacency at font sizes from
 * 5.5pt to 20.9pt; the smallest explicit inter-word space item's own width
 * in either document was 0.6pt, with several more points of visual gap
 * alongside it — comfortably past this margin, so a genuine word boundary
 * is never mistaken for a same-run split.
 *
 * REGRESSION finding (Humanities discovery diagnostic, follow-up): a naive
 * `right-edge-to-left-edge < tolerance` check, with no lower bound, wrongly
 * glued the END of one wrapped line to the START of the next (e.g. "text
 * reuses" + "in the BIBLINDEX" -> "reusesin") — confirmed live: pdfjs's own
 * item order is reading order, so the next line's item has a SMALLER left
 * edge than the previous line's right edge, producing a large NEGATIVE gap
 * (measured: -453pt for one real wrapped line), and an unbounded `< tolerance`
 * comparison accepts any negative number. A genuine same-run split's gap
 * measured only ever as a small value EITHER side of zero (as small as
 * -0.004pt, floating-point noise) — never anywhere near a full line's
 * width — so the fix is to bound the gap on BOTH sides with Math.abs(),
 * not just the positive side.
 */
const ADJACENT_RUN_TOLERANCE_RATIO = 0.15;

function glyphsAreAdjacent(before: unknown, after: unknown): boolean {
  const a = itemGeometry(before);
  const b = itemGeometry(after);
  if (!a || !b) return false;
  const tolerance = Math.max(a.emSize, b.emSize) * ADJACENT_RUN_TOLERANCE_RATIO;
  // Same-run splits are always on the same text line — requiring a matching
  // baseline independently rules out a line wrap even if the horizontal gap
  // alone were ever ambiguous (it also catches superscripts/footnote marks,
  // which sit on a different baseline despite being horizontally adjacent).
  const onSameBaseline = Math.abs(b.baseline - a.baseline) < tolerance;
  return onSameBaseline && Math.abs(b.left - a.right) < tolerance;
}

/**
 * Reconstructs a page's text from pdfjs's own item array: consecutive items
 * are joined with a space by default, but ANY pair that is geometrically
 * adjacent (see glyphsAreAdjacent and this file's own header comment for
 * how that was measured against two independent real PDFs) is glued
 * directly together instead, with no space at all — regardless of what
 * either item's own text content is. A malformed/absent transform or width
 * (a test double, or any pdfjs item shape without position data) simply
 * falls back to the original space-joined behavior for that pair — never
 * throws, never guesses.
 */
function joinPageTextItems(items: unknown[]): string {
  let result = "";
  let previousItem: unknown = null;
  for (const item of items) {
    const str = itemStr(item);
    if (previousItem === null) {
      result = str;
      previousItem = item;
      continue;
    }
    const glue = glyphsAreAdjacent(previousItem, item);
    result += (glue ? "" : " ") + str;
    previousItem = item;
  }
  return result;
}

/**
 * LINE-BREAK HYPHENATION REPAIR — "Rule B3", the frozen contract of
 * {@link PDF_EXTRACTOR_VERSION} (contract audit 2026-10-02: rule description
 * sha256 e5c03787be91d3180ddd551d3cfa6e41c1bf393510865dda767f6f5ca4bc7ccc,
 * reference implementation sha256
 * 83cbdc7ca216075edbab0675a35b294be701feccb7203b62cc891f77c04d7eeb).
 * B and B2 were earlier candidates of the same audit; none of them shipped.
 *
 * A typeset word broken across two lines ("exam-" / "ple") reaches the page
 * text as "exam- ple" and never matches "example" again. The repair removes
 * that one line-final U+002D and joins the two fragments — and nothing else:
 * every other character of the page is emitted exactly as v1 emits it, and a
 * page on which nothing is joined is v1's own string.
 *
 * It runs here, on pdf.js's items, because the decision needs what the joined
 * text no longer has: where a line ends (`hasEOL`), where the next one starts,
 * and how wide the text block is. A hyphen is only removed when ALL the
 * ordered predicates below hold (PDF_LINE_BREAK_PREDICATES); the last two are
 * the ones that keep real compounds apart — the joined word must be written
 * inline somewhere in this same extraction, and the hyphenated pair must
 * never be.
 *
 * That inline evidence is built ONCE, from the original unrepaired segments of
 * every extracted page, before any decision, and is never updated. Both
 * shortcuts are forbidden and regression-tested: counting the line-break
 * fragments themselves (a document would vouch for its own breaks), and
 * re-running the rule on its own output (a word broken over three lines,
 * "inter-" / "nation-" / "al", would be assembled from words the document
 * never wrote).
 *
 * Deliberately NOT repaired: a break across a page boundary, any hyphen-like
 * character other than U+002D, non-Latin or upper-case fragments, rotated or
 * right-to-left text, a URL / e-mail / DOI token, a break to a line that is
 * not directly below in the same column, and a break at the end of a line
 * that holds a column gutter (predicate 12b, below). No dictionary, no stop
 * list, no language input.
 *
 * COLUMN GUTTERS. pdf.js puts no end-of-line between the cells of a printed
 * table row, nor between two columns drawn side by side: the whole row is
 * one line here. Its end is the end of the LAST cell, and the line emitted
 * next starts with the FIRST cell, so "…provides the in-" followed by
 * "formation of the committee…" would be joined across the column boundary
 * whenever "information" is written somewhere inline. Predicate 12b refuses a
 * hyphenated line that holds a gutter: a gap between two of its text items
 * that is 2 em wide or more, or 0.6 em or more and repeated at the same
 * position on the next line.
 *
 * KNOWN RESIDUAL, accepted for this extractor version: a gutter narrower than
 * 0.6 em is not a gap this predicate can see — pdf.js's text items do not
 * distinguish it from an ordinary word space — so such a table row can still
 * be joined across cells (pinned by the T13 fixture). The same holds for a
 * 0.6–2 em gutter that is not repeated on the next line. The real validation
 * sets hold no structural join; "no cross-cell join is possible" is NOT a
 * property of this rule.
 *
 * FROZEN: every regular expression, threshold and rounding step below is the
 * measured rule. Changing any of them is a new extractor version, not a fix.
 */
type PdfTextSegment = { text: string; separatorBefore: string };

type PdfSegmentLine = {
  /** index of this segment in the page's full segment list */
  segmentIndex: number;
  text: string;
  x0: number;
  x1: number;
  y: number;
  em: number;
  firstEm: number;
  firstDir: string;
  lastEm: number;
  lastDir: string;
  rotated: boolean;
  /** left and right edge of every ink item, in emission order, as flat pairs */
  ink: number[];
};

type PdfPageLayout = {
  /** v1's own page string — what the page emits when nothing on it is joined */
  text: string;
  /** every segment, in emission order; concatenating separatorBefore + text, then `tail`, rebuilds the page */
  segments: PdfTextSegment[];
  /** the segments that carry geometry — the only ones the rule ever looks at */
  lines: PdfSegmentLine[];
  tail: string;
};

const roundToTenth = (value: number) => Math.round(value * 10) / 10;
const roundToHundredth = (value: number) => +value.toFixed(2);

function measureSegment(segmentIndex: number, text: string, items: unknown[]): PdfSegmentLine | null {
  type Ink = { geometry: PdfItemGeometry; dir: string };
  let first: Ink | null = null;
  let last: Ink | null = null;
  let widest: Ink | null = null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let rotated = false;
  const extents: number[] = [];
  for (const item of items) {
    if (itemStr(item).trim() === "") continue;
    const geometry = itemGeometry(item);
    if (!geometry) continue;
    const { dir, transform } = item as RawPdfTextItem;
    const ink: Ink = { geometry, dir: typeof dir === "string" ? dir : "" };
    first ??= ink;
    last = ink;
    if (!widest || geometry.right - geometry.left > widest.geometry.right - widest.geometry.left) widest = ink;
    x0 = Math.min(x0, geometry.left);
    x1 = Math.max(x1, geometry.right);
    extents.push(roundToTenth(geometry.left), roundToTenth(geometry.right));
    const matrix = transform as unknown[];
    if (Math.abs(Number(matrix[1])) > 1e-6 || Math.abs(Number(matrix[2])) > 1e-6) rotated = true;
  }
  if (!first || !last || !widest) return null;
  return {
    segmentIndex,
    text,
    x0: roundToTenth(x0),
    x1: roundToTenth(x1),
    y: roundToTenth(widest.geometry.baseline),
    em: roundToTenth(widest.geometry.emSize),
    firstEm: roundToTenth(first.geometry.emSize),
    firstDir: first.dir,
    lastEm: roundToTenth(last.geometry.emSize),
    lastDir: last.dir,
    rotated,
    ink: extents,
  };
}

/**
 * Splits one page's items into segments: runs in pdf.js emission order, each
 * closed by an item whose `hasEOL` is set. A run that is only white space is
 * not a segment — its text is carried as the separator of the next one — so
 * the segments plus `tail` always rebuild the page exactly.
 */
function segmentPdfPage(items: unknown[]): PdfPageLayout {
  type OpenSegment = { text: string; separatorBefore: string; items: unknown[] };
  const segments: PdfTextSegment[] = [];
  const lines: PdfSegmentLine[] = [];
  let pendingSeparator = "";
  const close = (segment: OpenSegment) => {
    if (segment.text.trim() === "") {
      pendingSeparator += segment.separatorBefore + segment.text;
      return;
    }
    const line = measureSegment(segments.length, segment.text, segment.items);
    segments.push({ text: segment.text, separatorBefore: segment.separatorBefore });
    if (line) lines.push(line);
  };

  let open: OpenSegment | null = null;
  let previousItem: unknown = null;
  for (const item of items) {
    const str = itemStr(item);
    const separator = previousItem === null || glyphsAreAdjacent(previousItem, item) ? "" : " ";
    previousItem = item;
    if (open === null) {
      open = { text: str, separatorBefore: pendingSeparator + separator, items: [] };
      pendingSeparator = "";
    } else {
      open.text += separator + str;
    }
    open.items.push(item);
    if (item && typeof item === "object" && (item as RawPdfTextItem).hasEOL) {
      close(open);
      open = null;
    }
  }
  if (open !== null) close(open);
  return { text: joinPageTextItems(items), segments, lines, tail: pendingSeparator };
}

const EMPTY_PAGE_LAYOUT: PdfPageLayout = { text: "", segments: [], lines: [], tail: "" };

// U+002D and the look-alikes a line may end with. Only U+002D is ever removed
// (predicate 2); the others are recognised so that such a line end is still
// kept out of the inline evidence.
const LINE_END_FRAGMENT = /(\p{L}[\p{L}\p{M}]*)([\-\u00AD\u2010\u2011\u2012\u2013\u2014\u2212])$/u;
const LINE_START_FRAGMENT = /^(\p{L}[\p{L}\p{M}]*)/u;
const LATIN_FRAGMENT = /^[\p{Script=Latin}\p{M}]+$/u;
const INLINE_WORD = /\p{L}+(?:[-\u2010\u2011]\p{L}+)*/gu;
const INLINE_HYPHEN = /[-\u2010\u2011]/u;
const LEFT_TOKEN_SHAPE = /(?:^|\s)[\p{Ps}\p{Pi}"']*(\p{L}[\p{L}\p{M}]*)-$/u;
const RIGHT_TOKEN_SHAPE = /^(\p{L}[\p{L}\p{M}]*)(?=$|\s|[\p{Pe}\p{Pf}.,;:!?"'])/u;
// A slash, an at-sign, or a full stop / colon immediately followed by a letter
// or digit, anywhere in the white-space-delimited token: URL, domain, e-mail,
// DOI, scheme:identifier.
const URL_STRUCTURE = /[/@]|[.:][\p{L}\p{N}]/u;

// Column gutters (predicate 12b), in em of the hyphenated line.
/** A gap between two text items this wide is never a word space. */
const WIDE_GUTTER_EM = 2;
/** pdf.js itself stops treating a wider advance as an in-flow space. */
const REPEATED_GUTTER_EM = 0.6;
/** "The same position" on two consecutive printed lines. */
const GUTTER_ALIGN_EM = 0.1;
/** A line with more such gaps is word-per-item text (an OCR layer), not columns. */
const REPEATED_GUTTER_MAX = 5;

type PdfInlineEvidence = { words: ReadonlyMap<string, number>; pairs: ReadonlyMap<string, number> };

/**
 * The inline words and inline hyphenated pairs of the ORIGINAL segments. The
 * two fragments around every line-final hyphen are left out, so a line break
 * can never be evidence for itself. Returned read-only; nothing a decision
 * produces is ever added.
 */
function buildInlineEvidence(pages: readonly PdfPageLayout[]): PdfInlineEvidence {
  const words = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const page of pages) {
    for (let index = 0; index < page.lines.length; index += 1) {
      const line = page.lines[index];
      let body = line.text.toLowerCase();
      if (LINE_END_FRAGMENT.test(line.text.trimEnd())) body = body.trimEnd().replace(/\S+$/u, "");
      const previous = index > 0 ? page.lines[index - 1] : null;
      if (previous && LINE_END_FRAGMENT.test(previous.text.trimEnd())) body = body.trimStart().replace(/^\S+/u, "");
      for (const match of body.matchAll(INLINE_WORD)) {
        const parts = match[0].split(INLINE_HYPHEN);
        for (const part of parts) words.set(part, (words.get(part) ?? 0) + 1);
        for (let i = 0; i + 1 < parts.length; i += 1) {
          const pair = `${parts[i]}-${parts[i + 1]}`;
          pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
        }
      }
    }
  }
  return { words, pairs };
}

/** The ordered predicates of Rule B3. A site is joined only when none of them fails. */
export const PDF_LINE_BREAK_PREDICATES = [
  "1-same-page",
  "2-hyphen-is-U+002D",
  "3-lowercase-at-break",
  "4-latin-fragments",
  "5-fragment-length>=2",
  "6-left-token-shape",
  "7-right-token-shape",
  "7b-no-url-structure",
  "8-upright-not-rtl",
  "9-next-line-below-at-body-pitch",
  "10-same-column",
  "11-font-size-ratio",
  "12-right-edge-would-not-fit",
  "12b-no-column-gutter",
  "13-joined-word-inline",
  "14-pair-never-inline",
] as const;

export type PdfLineBreakPredicate = (typeof PDF_LINE_BREAK_PREDICATES)[number];

export type PdfLineBreakMeasurements = {
  lowercaseLeft: boolean;
  lowercaseRight: boolean;
  latin: boolean;
  /** vertical step to the next line, in em */
  dyEm: number;
  /** |step − page line pitch| / pitch; null when the page has no pitch sample */
  pitchDeviation: number | null;
  /** next line's left edge relative to this line's, in em */
  dx0Em: number;
  nextStartsLeftOfLineEnd: boolean;
  emRatio: number;
  /** block right edge − this line's right edge, in em; null without a block */
  rightGapEm: number | null;
  /** neighbouring printed lines of the same block */
  neighbours: number;
  /** room left on this line had the next fragment stayed on it, in em; null without a block */
  fitGapEm: number | null;
  /** widest gap between two consecutive text items of this printed line, in em; null across a page boundary */
  widestGapEm: number | null;
  /** gaps of at least 0.6 em on this printed line; null across a page boundary */
  gutterGaps: number | null;
  /** one of those gaps is repeated at the same position on the next printed line */
  sharedGutter: boolean;
  rotated: boolean;
  dirLeft: string;
  dirRight: string;
  /** inline occurrences of the joined word / of the hyphenated pair */
  joinedInline: number;
  pairInline: number;
};

/**
 * One line-final hyphen-like character followed by a line. In-memory only —
 * it holds fragments of the document's text and must never be persisted.
 */
export type PdfLineBreakSite = {
  pageIndex: number;
  /** index of the line that ends with the hyphen, among the page's geometry-bearing segments */
  lineIndex: number;
  kind: "same-page" | "page-boundary";
  /** code point of the line-final character, four upper-case hex digits */
  hyphen: string;
  leftFragment: string;
  /** null when the next line does not start with a letter (never joined) */
  rightFragment: string | null;
  leftToken: string | null;
  rightToken: string | null;
  measurements: PdfLineBreakMeasurements | null;
  join: boolean;
  failed: Array<PdfLineBreakPredicate | "next-line-not-letter">;
};

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function decideLineBreakSites(pages: readonly PdfPageLayout[]): PdfLineBreakSite[] {
  const evidence = buildInlineEvidence(pages);
  const sites: PdfLineBreakSite[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const lines = pages[pageIndex].lines;

    // Page line pitch: the median step between consecutive left-aligned lines.
    const pitchSamples: number[] = [];
    for (let i = 0; i + 1 < lines.length; i += 1) {
      const dy = lines[i].y - lines[i + 1].y;
      if (dy > 0 && Math.abs(lines[i].x0 - lines[i + 1].x0) < 3 * lines[i].em && dy < 3 * lines[i].em) pitchSamples.push(dy);
    }
    const pitch = medianOf(pitchSamples);

    // Printed lines: pdf.js can end a segment in the middle of a printed line
    // (a font change, a wide gap), so segments on one baseline that continue
    // to the right share a group and its horizontal extent.
    const group = new Array<number>(lines.length);
    for (let i = 0, g = -1; i < lines.length; i += 1) {
      const before = i > 0 ? lines[i - 1] : null;
      const sameLine =
        before !== null &&
        Math.abs(lines[i].y - before.y) <= 0.35 * Math.max(lines[i].em, before.em) &&
        lines[i].x0 >= before.x1 - 0.5 * lines[i].em;
      if (!sameLine) g += 1;
      group[i] = g;
    }
    const groupX0 = new Array<number>(lines.length);
    const groupX1 = new Array<number>(lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      let x0 = lines[i].x0;
      let x1 = lines[i].x1;
      for (let j = i - 1; j >= 0 && group[j] === group[i]; j -= 1) {
        x0 = Math.min(x0, lines[j].x0);
        x1 = Math.max(x1, lines[j].x1);
      }
      for (let j = i + 1; j < lines.length && group[j] === group[i]; j += 1) {
        x0 = Math.min(x0, lines[j].x0);
        x1 = Math.max(x1, lines[j].x1);
      }
      groupX0[i] = x0;
      groupX1[i] = x1;
    }

    // Predicate 12b: the positive horizontal gaps between consecutive ink
    // items of a printed line (all its segments, in emission order) — each
    // with its width and its edge, the left edge of the item after it. A
    // group is a run of consecutive lines, so each printed line is walked
    // once and kept for every site that asks for it, widest gap first.
    type LineGaps = { widths: number[]; edges: number[] };
    const gapsOfGroup = new Map<number, LineGaps>();
    const lineGaps = (i: number): LineGaps => {
      const known = gapsOfGroup.get(group[i]);
      if (known) return known;
      let first = i;
      while (first > 0 && group[first - 1] === group[i]) first -= 1;
      const widths: number[] = [];
      const edges: number[] = [];
      let previousRight: number | null = null;
      for (let j = first; j < lines.length && group[j] === group[i]; j += 1) {
        const ink = lines[j].ink;
        for (let q = 0; q < ink.length; q += 2) {
          if (previousRight !== null && ink[q] - previousRight > 0) {
            widths.push(ink[q] - previousRight);
            edges.push(ink[q]);
          }
          previousRight = ink[q + 1];
        }
      }
      const widestFirst = widths.map((_, q) => q).sort((p, q) => widths[q] - widths[p]);
      const gaps: LineGaps = { widths: widestFirst.map((q) => widths[q]), edges: widestFirst.map((q) => edges[q]) };
      gapsOfGroup.set(group[i], gaps);
      return gaps;
    };

    // Every consecutive pair of the page, then the pair that straddles the
    // page boundary — recorded so predicate 1 refuses it explicitly.
    const candidates: Array<[PdfSegmentLine, PdfSegmentLine, number, PdfLineBreakSite["kind"]]> = [];
    for (let i = 0; i + 1 < lines.length; i += 1) candidates.push([lines[i], lines[i + 1], i, "same-page"]);
    const nextPage = pageIndex + 1 < pages.length ? pages[pageIndex + 1] : null;
    if (nextPage && lines.length > 0 && nextPage.lines.length > 0) {
      candidates.push([lines[lines.length - 1], nextPage.lines[0], lines.length - 1, "page-boundary"]);
    }

    for (const [lineA, lineB, i, kind] of candidates) {
      const a = lineA.text.trimEnd();
      const b = lineB.text.trimStart();
      const end = LINE_END_FRAGMENT.exec(a);
      if (!end) continue;
      const hyphen = end[2].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      const start = LINE_START_FRAGMENT.exec(b);
      if (!start) {
        sites.push({
          pageIndex, lineIndex: i, kind, hyphen, leftFragment: end[1], rightFragment: null,
          leftToken: null, rightToken: null, measurements: null, join: false, failed: ["next-line-not-letter"],
        });
        continue;
      }
      const left = end[1];
      const right = start[1];
      const leftToken = a.slice(a.search(/\S+$/u));
      const rightToken = b.slice(0, b.search(/\s|$/u));
      const em = Math.max(lineA.lastEm || lineA.em, 1);

      let blockRight: number | null = null;
      let neighbours = 0;
      if (kind === "same-page") {
        for (let j = Math.max(0, i - 6); j <= Math.min(lines.length - 1, i + 6); j += 1) {
          const near = lines[j];
          if (near.rotated) continue;
          if (Math.abs(groupX0[j] - groupX0[i]) <= 3 * em && Math.abs(near.y - lineA.y) <= 10 * em) {
            blockRight = blockRight === null ? groupX1[j] : Math.max(blockRight, groupX1[j]);
            if (group[j] !== group[i]) neighbours += 1;
          }
        }
      }
      const ax0 = kind === "same-page" ? groupX0[i] : lineA.x0;
      const bx0 = kind === "same-page" ? groupX0[i + 1] : lineB.x0;
      const averageCharWidth = (lineB.x1 - lineB.x0) / Math.max(1, b.trimEnd().length);
      const firstHyphen = rightToken.search(INLINE_HYPHEN);
      const rightChunk = firstHyphen > 0 ? rightToken.slice(0, firstHyphen) : rightToken;
      const rightChunkWidth = averageCharWidth * rightChunk.length;
      const dy = lineA.y - lineB.y;

      let widestGapEm: number | null = null;
      let gutterGaps: number | null = null;
      let sharedGutter = false;
      if (kind === "same-page") {
        const gapsA = lineGaps(i);
        const gapsB = lineGaps(i + 1);
        widestGapEm = roundToHundredth((gapsA.widths[0] ?? 0) / em);
        // How many gaps of a line are at least REPEATED_GUTTER_EM wide: they
        // are the first ones, the rounded width never grows down the list.
        const guttersOf = (gaps: LineGaps): number => {
          let low = 0;
          let high = gaps.widths.length;
          while (low < high) {
            const middle = (low + high) >> 1;
            if (roundToHundredth(gaps.widths[middle] / em) >= REPEATED_GUTTER_EM) low = middle + 1;
            else high = middle;
          }
          return low;
        };
        const guttersA = guttersOf(gapsA);
        const guttersB = guttersOf(gapsB);
        gutterGaps = guttersA;
        if (guttersA <= REPEATED_GUTTER_MAX && guttersB <= REPEATED_GUTTER_MAX) {
          for (let p = 0; p < guttersA && !sharedGutter; p += 1) {
            for (let q = 0; q < guttersB && !sharedGutter; q += 1) {
              sharedGutter = roundToHundredth(Math.abs(gapsA.edges[p] - gapsB.edges[q]) / em) <= GUTTER_ALIGN_EM;
            }
          }
        }
      }

      const m: PdfLineBreakMeasurements = {
        lowercaseLeft: /\p{Ll}$/u.test(left),
        lowercaseRight: /^\p{Ll}/u.test(right),
        latin: LATIN_FRAGMENT.test(left) && LATIN_FRAGMENT.test(right),
        dyEm: roundToHundredth(dy / em),
        pitchDeviation: pitch ? roundToHundredth(Math.abs(dy - pitch) / pitch) : null,
        dx0Em: roundToHundredth((bx0 - ax0) / em),
        nextStartsLeftOfLineEnd: bx0 < lineA.x1,
        emRatio: roundToHundredth((lineB.firstEm || lineB.em) / em),
        rightGapEm: blockRight === null ? null : roundToHundredth((blockRight - lineA.x1) / em),
        neighbours,
        fitGapEm: blockRight === null ? null : roundToHundredth((blockRight - (lineA.x1 - 0.33 * em + rightChunkWidth)) / em),
        widestGapEm,
        gutterGaps,
        sharedGutter,
        rotated: lineA.rotated || lineB.rotated,
        dirLeft: lineA.lastDir,
        dirRight: lineB.firstDir,
        joinedInline: evidence.words.get((left + right).toLowerCase()) ?? 0,
        pairInline: evidence.pairs.get(`${left}-${right}`.toLowerCase()) ?? 0,
      };

      const failed: PdfLineBreakSite["failed"] = [];
      if (kind !== "same-page") failed.push("1-same-page");
      if (hyphen !== "002D") failed.push("2-hyphen-is-U+002D");
      if (!(m.lowercaseLeft && m.lowercaseRight)) failed.push("3-lowercase-at-break");
      if (!m.latin) failed.push("4-latin-fragments");
      if (!(left.length >= 2 && right.length >= 2)) failed.push("5-fragment-length>=2");
      if (!LEFT_TOKEN_SHAPE.test(` ${leftToken}`)) failed.push("6-left-token-shape");
      if (!RIGHT_TOKEN_SHAPE.test(rightToken)) failed.push("7-right-token-shape");
      if (URL_STRUCTURE.test(leftToken) || URL_STRUCTURE.test(rightToken)) failed.push("7b-no-url-structure");
      if (!(!m.rotated && m.dirLeft !== "rtl" && m.dirRight !== "rtl")) failed.push("8-upright-not-rtl");
      if (!(m.dyEm > 0.5 && (m.dyEm <= 2.6 || (m.pitchDeviation !== null && m.pitchDeviation <= 0.25)) && m.dyEm <= 4)) {
        failed.push("9-next-line-below-at-body-pitch");
      }
      if (!(m.dx0Em >= -6 && m.dx0Em <= 3 && m.nextStartsLeftOfLineEnd)) failed.push("10-same-column");
      if (!(m.emRatio >= 0.7 && m.emRatio <= 1.45)) failed.push("11-font-size-ratio");
      if (!(m.rightGapEm !== null && m.neighbours >= 1 && m.fitGapEm !== null && m.fitGapEm < 0.5)) {
        failed.push("12-right-edge-would-not-fit");
      }
      if (kind === "same-page" && !(m.widestGapEm !== null && m.widestGapEm < WIDE_GUTTER_EM && !m.sharedGutter)) {
        failed.push("12b-no-column-gutter");
      }
      if (!(m.joinedInline >= 1)) failed.push("13-joined-word-inline");
      if (!(m.pairInline === 0)) failed.push("14-pair-never-inline");

      sites.push({
        pageIndex, lineIndex: i, kind, hyphen, leftFragment: left, rightFragment: right,
        leftToken, rightToken, measurements: m, join: failed.length === 0, failed,
      });
    }
  }
  return sites;
}

export type PdfLineBreakRepair = {
  pages: string[];
  /** joins actually applied to the text */
  lineBreakJoins: number;
  /** decided joins left alone because a geometry-less segment sits between the two lines */
  skippedNonAdjacentJoins: number;
  sites: PdfLineBreakSite[];
};

/**
 * Decides every site from the immutable evidence, then renders each page once.
 * A join removes exactly the final U+002D of the upper segment and appends the
 * lower one with nothing between; every other segment is emitted with its own
 * separator, so a page without a join returns v1's string untouched.
 */
function repairLineBreakHyphenation(layouts: readonly PdfPageLayout[]): PdfLineBreakRepair {
  const sites = decideLineBreakSites(layouts);
  const joinAfterByPage = new Map<number, Set<number>>();
  let lineBreakJoins = 0;
  let skippedNonAdjacentJoins = 0;
  for (const site of sites) {
    if (!site.join) continue;
    const lines = layouts[site.pageIndex].lines;
    const upper = lines[site.lineIndex].segmentIndex;
    const lower = lines[site.lineIndex + 1].segmentIndex;
    if (lower !== upper + 1) {
      skippedNonAdjacentJoins += 1;
      continue;
    }
    const joinAfter = joinAfterByPage.get(site.pageIndex) ?? new Set<number>();
    joinAfter.add(upper);
    joinAfterByPage.set(site.pageIndex, joinAfter);
    lineBreakJoins += 1;
  }

  const pages = layouts.map((layout, pageIndex) => {
    const joinAfter = joinAfterByPage.get(pageIndex);
    if (!joinAfter) return layout.text;
    // Each segment is trimmed on its own, as it is emitted — never the page
    // built so far, which would cost the length of the page once per join. A
    // segment's text always holds ink, so the end of the page text is the end
    // of the segment just emitted and both give the same string.
    let text = "";
    let joinedToPrevious = false;
    for (let index = 0; index < layout.segments.length; index += 1) {
      const segment = layout.segments[index];
      const joinNext = index + 1 < layout.segments.length && joinAfter.has(index);
      let own = joinedToPrevious ? segment.text.trimStart() : segment.separatorBefore + segment.text;
      if (joinNext) own = own.trimEnd().slice(0, -1);
      text += own;
      joinedToPrevious = joinNext;
    }
    return text + layout.tail;
  });
  return { pages, lineBreakJoins, skippedNonAdjacentJoins, sites };
}

/**
 * The page-assembly core of {@link extractPdfTextDocument} on already-fetched
 * pdf.js item arrays, one per page, with every site's decision exposed — for
 * the conformance tests and the browser/Node parity check, which compare this
 * production code against the frozen reference. `pages` is exactly what the
 * extractor would emit for the same items.
 */
export function inspectPdfLineBreakRepair(pagesOfItems: readonly unknown[][]): PdfLineBreakRepair {
  return repairLineBreakHyphenation(pagesOfItems.map((items) => segmentPdfPage(items)));
}

/**
 * The single PDF text-layer contract used by both browser uploads and corpus
 * calibration. Keeping this page assembly in one pure helper prevents the
 * production and offline representations from drifting apart again.
 *
 * maxPages (Phase 5 addition, optional, defaults to unlimited — every
 * existing caller's behavior is unchanged): bounds how many pages are ever
 * extracted, for a caller retrieving an UNTRUSTED PDF (e.g. a candidate URL
 * from an external academic-search provider) where the byte cap alone still
 * permits a pathologically page-dense document to cost unbounded CPU time.
 */
/**
 * Shared page loop for {@link extractPdfTextDocument} (strict — rethrows a page
 * error exactly as before) and {@link extractPdfTextDocumentWithCompleteness}
 * (records the failure and keeps going). `strict: true` is byte- AND
 * behaviour-identical to the original inline loop: when no page throws, both
 * paths run the same `onProgress` → `getPage` → `getTextContent` →
 * `joinPageTextItems` sequence and `pages` is the identical array.
 *
 * v2: each page is segmented as it is read (its items are not kept), and the
 * line-break repair runs once, after the last page, because its evidence is
 * document-wide. A failed page takes part as an empty page.
 */
async function collectPdfPages(
  document: PdfTextDocument,
  onProgress: PdfExtractionProgress | undefined,
  pageCount: number,
  strict: boolean,
): Promise<{ pages: string[]; failedPageNumbers: number[]; emptyPageCount: number; lineBreakJoins: number }> {
  const layouts: PdfPageLayout[] = [];
  const failedPageNumbers: number[] = [];
  let emptyPageCount = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress?.(pageNumber, document.numPages);
    try {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const layout = segmentPdfPage(content.items);
      if (layout.text.trim().length === 0) emptyPageCount += 1;
      layouts.push(layout);
    } catch (error) {
      if (strict) throw error;
      failedPageNumbers.push(pageNumber);
      layouts.push(EMPTY_PAGE_LAYOUT);
    }
  }
  const { pages, lineBreakJoins } = repairLineBreakHyphenation(layouts);
  return { pages, failedPageNumbers, emptyPageCount, lineBreakJoins };
}

export async function extractPdfTextDocument(
  document: PdfTextDocument,
  onProgress?: PdfExtractionProgress,
  maxPages?: number,
) {
  const pageCount = maxPages && maxPages > 0 ? Math.min(document.numPages, maxPages) : document.numPages;
  const { pages } = await collectPdfPages(document, onProgress, pageCount, true);
  return `${pages.join("\n\n")}\n\n`;
}

export type PdfExtractionCompleteness =
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

/**
 * DOCUMENT EXTRACTION V2 — the same page assembly as {@link
 * extractPdfTextDocument}, but instead of letting the FIRST failing page abort
 * the whole extraction it records which pages failed, keeps the rest, and
 * reports a completeness verdict alongside the text. The product upload boundary
 * (lib/document-check-pipeline.ts `extractFileTextWithDiagnostics`) uses this so
 * a single un-parseable page produces a PARTIAL report rather than "I could not
 * read that document"; every other caller keeps using the strict function above
 * unchanged.
 *
 * `text` is byte-identical to `extractPdfTextDocument`'s output whenever no page
 * fails (a failed page contributes an empty string in its slot, exactly as if
 * the page were blank).
 *
 * A legitimately BLANK page (parsed fine, no text) is counted separately and
 * never on its own makes the result PARTIAL — only a genuine parse failure, a
 * `maxPages` truncation, or "no analyzable text anywhere" changes the verdict.
 * No OCR.
 */
export async function extractPdfTextDocumentWithCompleteness(
  document: PdfTextDocument,
  onProgress?: PdfExtractionProgress,
  maxPages?: number,
): Promise<{
  text: string;
  completeness: PdfExtractionCompleteness;
  totalPages: number;
  parsedPages: number;
  failedPages: number;
  emptyPages: number;
  truncatedByMaxPages: boolean;
  extractedWordCount: number;
  /** line-break hyphenations repaired in `text` — a count only, never the words */
  lineBreakJoins: number;
  diagnostics: string[];
}> {
  const totalPages = document.numPages;
  const pageCount = maxPages && maxPages > 0 ? Math.min(totalPages, maxPages) : totalPages;
  const truncatedByMaxPages = pageCount < totalPages;

  const { pages, failedPageNumbers, emptyPageCount, lineBreakJoins } = await collectPdfPages(document, onProgress, pageCount, false);
  const text = `${pages.join("\n\n")}\n\n`;

  const failedPages = failedPageNumbers.length;
  const parsedPages = pageCount - failedPages;
  const extractedWordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

  const diagnostics: string[] = [];
  for (const n of failedPageNumbers) diagnostics.push(`PAGE_EXTRACTION_FAILED:${n}`);
  if (truncatedByMaxPages) diagnostics.push(`MAX_PAGES_TRUNCATED:${pageCount}/${totalPages}`);

  let completeness: PdfExtractionCompleteness;
  if (parsedPages === 0 || extractedWordCount === 0) completeness = "FAILED";
  else if (failedPages > 0 || truncatedByMaxPages) completeness = "PARTIAL";
  else completeness = "COMPLETE";

  return {
    text,
    completeness,
    totalPages,
    parsedPages,
    failedPages,
    emptyPages: emptyPageCount,
    truncatedByMaxPages,
    extractedWordCount,
    lineBreakJoins,
    diagnostics,
  };
}
