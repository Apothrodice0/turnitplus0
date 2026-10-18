export type PdfTextContent = {
  items: Array<unknown>;
};

export type PdfTextPage = {
  getTextContent(): Promise<PdfTextContent>;
  /** pdf.js's page operator list. Read only on pages holding right-to-left text (see RIGHT-TO-LEFT TEXT below). */
  getOperatorList?(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
};

export type PdfTextDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfTextPage>;
};

export type PdfExtractionProgress = (pageNumber: number, pageCount: number) => void;

/** Phase 5 addition — mirrors lib/html-text-extraction.ts's HTML_EXTRACTOR_VERSION convention, for callers (lib/http-content-retriever.ts) that record which extractor produced a given RetrievedSource.extractedText. */
/**
 * v1-rtl = v1 + the right-to-left repairs of RIGHT-TO-LEFT TEXT (below), ported from the local
 * pdf-text-extraction-v3 candidate (22c8220) WITHOUT its v2 line-break dehyphenation: glyph order of
 * multi-character RTL glyphs and right-to-left reading of mainly-RTL printed lines. Both act only on
 * pages holding a right-to-left character, so a document without one extracts byte for byte as v1.
 */
export const PDF_EXTRACTOR_VERSION = "pdf-text-extraction-v1-rtl";

type RawPdfTextItem = { str?: unknown; width?: unknown; transform?: unknown };

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
/** Right-to-left printed lines only: how far (in em) a following run may overlap the previous one and still continue its word. */
const RTL_ADJACENT_OVERLAP_RATIO = 0.5;
/** Right-to-left printed lines only: the largest positive gap (in em) that still continues a word. */
const RTL_ADJACENT_GAP_RATIO = 0.1;

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
  // A right-to-left printed line is emitted right to left, so the next item sits to the LEFT, and
  // justified Arabic overlaps the runs of one word. Measured on 68,422 item pairs of 69 ASJP articles: a mirrored
  // overlap of 0.2-0.5 em was word-internal 4,049 times and a word boundary 189 times; a positive gap of
  // 0.10-0.15 em was a boundary 567 times and word-internal 43 times; a gap of 0.2 em or more was a boundary.
  if (isRtlVisualLineItem(before) && isRtlVisualLineItem(after)) {
    const gap = a.left - b.right;
    const em = Math.max(a.emSize, b.emSize);
    return onSameBaseline && gap >= -em * RTL_ADJACENT_OVERLAP_RATIO && gap < em * RTL_ADJACENT_GAP_RATIO;
  }
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
 */
// =============================================================================
// RIGHT-TO-LEFT TEXT (ported from the v3 candidate 22c8220)
// =============================================================================

/**
 * Right-to-left text repair (pdf-text-extraction-v1-rtl; ported from the v3 candidate) for pdf.js getTextContent() items.
 *
 * Measured on 270 original ASJP (Algerian) journal PDFs, 2026-10-08: the v2 page assembly
 * reproduced the typed abstract of a Word-produced Arabic article at 17-24% of its words.
 * Two independent causes, both confined to right-to-left text:
 *
 * 1. GLYPH ORDER. pdf.js builds a text chunk from its glyphs' Unicode strings in DRAWING order
 *    and then reorders the whole string character by character (pdf.worker `runBidiTransform`).
 *    A glyph whose Unicode is several characters — an Arabic ligature (لم, لج, لا, في, تي ...)
 *    mapped by the PDF's ToUnicode CMap in logical order, or expanded by pdf.js normalizeUnicode —
 *    is therefore reversed inside itself: "الجمهورية" comes out as "اجلمهورية".
 *    repairRtlGlyphOrder reads the glyph strings from the page's operator list, aligns them with
 *    each RTL item by exact match and restores those glyphs. An item it cannot align is left as
 *    pdf.js produced it.
 *
 * 2. LINE ORDER. Word splits one printed right-to-left line into several items and pdf.js emits
 *    them left to right (other producers emit one item per word, left to right), so the v2 assembly
 *    read the line from its end and put spaces or line breaks inside words split across items.
 *    orderRtlVisualLines reads every printed line (consecutive items on one baseline) whose letters
 *    are mainly right-to-left from right to left, and glyphsAreAdjacent (above) tests adjacency
 *    mirrored for those items.
 *
 * Both repairs touch only items that hold a right-to-left character, and only lines whose letters
 * are mainly right-to-left: a document without such characters is extracted byte for byte as v1.
 */

/** pdf.js OPS codes of the text-showing operators (pdf.js 6.2.108, the release the extractor pins). */
const TEXT_SHOWING_OPS: ReadonlySet<number> = new Set([44, 45, 46, 47]);

let normalizeRegex: RegExp | null = null;
/** pdf.js 6.2.108 `normalizeUnicode`, verbatim: getTextContent applies it to every chunk, so the glyph stream must too. */
function pdfjsNormalizeUnicode(value: string): string {
  normalizeRegex ??= /([ µ;ຳ -  Ωﬀ-ﬄﬆﬠ-זּטּ-לּמּנּסּףּפּצּ-ﮡﮤ-ﮩﮮ-ﮱﯓ-ﯜﯞ-ﯧﯪ-ﯸﯼﯽﰀ-ﱝﱤ-ﳱﳵ-ﴽﶈﷴﷺﷻﹱﹷﹹﹻﹽ]+)|(ﬅ+)/gu;
  return value.replaceAll(normalizeRegex, (_, p1: string | undefined, p2: string | undefined) => (p1 ? p1.normalize("NFKC") : "ſt".repeat(p2?.length ?? 0)));
}

/** Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Arabic Extended, and their presentation forms. */
const RTL_CHARACTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
const RTL_CHARACTERS = /[֐-ࣿיִ-﷿ﹰ-﻿]/gu;
/** Letters and digits outside the RTL ranges end an RTL run in pdf.js's reordering. */
const ENDS_RTL_RUN = /[\p{L}\p{N}]/u;
const LATIN_LETTERS = /\p{Script=Latin}/gu;

type RawItem = { str?: unknown; dir?: unknown; hasEOL?: unknown; width?: unknown; transform?: unknown };
type OperatorList = { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };

export type PdfRtlRepairCounts = { rtlItems: number; alignedItems: number; unalignedItems: number; repairedGlyphs: number; rtlLines: number };

export function emptyPdfRtlRepairCounts(): PdfRtlRepairCounts {
  return { rtlItems: 0, alignedItems: 0, unalignedItems: 0, repairedGlyphs: 0, rtlLines: 0 };
}

const strOf = (item: unknown) => (item && typeof item === "object" && typeof (item as RawItem).str === "string" ? ((item as RawItem).str as string) : "");

/** Whether any item holds a right-to-left character (the only pages either repair ever looks at). */
export function hasRtlText(items: readonly unknown[]): boolean {
  return items.some((item) => RTL_CHARACTER.test(strOf(item)));
}

type GlyphStream = { rtl: string; multiCharacterGlyphAt: Map<number, string> };

/** The page's glyph Unicode strings in drawing order, reduced to RTL characters, with the start of every multi-character all-RTL glyph. */
function rtlGlyphStream(operatorList: OperatorList): GlyphStream {
  let rtl = "";
  const multiCharacterGlyphAt = new Map<number, string>();
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    if (!TEXT_SHOWING_OPS.has(operatorList.fnArray[index])) continue;
    const args = operatorList.argsArray[index];
    const glyphs = Array.isArray(args) ? args.find((arg) => Array.isArray(arg)) : null;
    if (!Array.isArray(glyphs)) continue;
    for (const glyph of glyphs) {
      if (!glyph || typeof glyph !== "object") continue;
      const raw = (glyph as { unicode?: unknown }).unicode;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const unit = pdfjsNormalizeUnicode(raw);
      const rtlPart = unit.match(RTL_CHARACTERS)?.join("") ?? "";
      if (rtlPart.length === 0) continue;
      if (unit.length >= 2 && rtlPart.length === unit.length) multiCharacterGlyphAt.set(rtl.length, unit);
      rtl += rtlPart;
    }
  }
  return { rtl, multiCharacterGlyphAt };
}

/**
 * UTF-16 indices of the item's RTL characters in DRAWING order: each RTL run read right to left,
 * the runs in reverse order for an "rtl" item (pdf.js base level 1) and in order otherwise (level 0).
 */
function rtlDrawingOrder(str: string, rtlItem: boolean): number[] {
  const runs: number[][] = [];
  let current: number[] | null = null;
  for (let index = 0; index < str.length; index += 1) {
    const character = str[index];
    if (RTL_CHARACTER.test(character)) (current ??= []).push(index);
    else if (ENDS_RTL_RUN.test(character)) {
      if (current) runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);
  if (rtlItem) runs.reverse();
  return runs.flatMap((run) => run.reverse());
}

/**
 * Restores every multi-character RTL glyph that pdf.js reversed inside itself. Exact-match alignment
 * only: the item's RTL characters, read in drawing order, must occur verbatim in the page's glyph
 * stream (next in sequence, or once anywhere on the page). A restored glyph's characters must sit
 * contiguous and reversed in the item; the result is a permutation inside those spans only.
 */
export function repairRtlGlyphOrder(items: readonly unknown[], operatorList: OperatorList, counts: PdfRtlRepairCounts): unknown[] {
  const stream = rtlGlyphStream(operatorList);
  let cursor = 0;
  return items.map((item) => {
    const str = strOf(item);
    if (!RTL_CHARACTER.test(str)) return item;
    counts.rtlItems += 1;
    const order = rtlDrawingOrder(str, (item as RawItem).dir === "rtl");
    const needle = order.map((index) => str[index]).join("");
    let at = stream.rtl.startsWith(needle, cursor) ? cursor : stream.rtl.indexOf(needle, cursor);
    if (at < 0) {
      const first = stream.rtl.indexOf(needle);
      at = first >= 0 && stream.rtl.indexOf(needle, first + 1) < 0 ? first : -1;
    }
    if (at < 0) {
      counts.unalignedItems += 1;
      return item;
    }
    counts.alignedItems += 1;
    cursor = at + needle.length;
    const characters = str.split("");
    let changed = false;
    for (let k = 0; k < needle.length; k += 1) {
      const glyph = stream.multiCharacterGlyphAt.get(at + k);
      if (!glyph || k + glyph.length > needle.length) continue;
      let contiguous = true;
      for (let j = 1; j < glyph.length; j += 1) if (order[k + j] !== order[k] - j) contiguous = false;
      if (!contiguous) continue;
      const end = order[k];
      for (let j = 0; j < glyph.length; j += 1) characters[end - glyph.length + 1 + j] = glyph[j];
      counts.repairedGlyphs += 1;
      changed = true;
    }
    return changed ? { ...(item as object), str: characters.join("") } : item;
  });
}

/** Marks an item copy that orderRtlVisualLines placed in right-to-left reading order. */
export const RTL_VISUAL_LINE = Symbol.for("turnitplus.pdf.rtl-visual-line");

function geometryOf(item: unknown): { left: number; right: number; baseline: number; em: number } | null {
  const { transform, width } = (item ?? {}) as RawItem;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const left = Number(transform[4]);
  const baseline = Number(transform[5]);
  const w = Number(width);
  const em = Math.abs(Number(transform[0])) || Math.abs(Number(transform[3]));
  if (![left, baseline, w, em].every(Number.isFinite) || em <= 0) return null;
  if (Math.abs(Number(transform[1])) > 1e-6 || Math.abs(Number(transform[2])) > 1e-6) return null; // rotated text: left as is
  return { left, right: left + w, baseline, em };
}

/**
 * Re-emits each printed line (a run of items closed by pdf.js's `hasEOL`) whose letters are mainly
 * right-to-left in right-to-left visual order — right edge descending — so the line reads in logical
 * order and a word split across items is rejoined by the mirrored adjacency test. A line is left
 * exactly as emitted unless every item on it has upright geometry on one baseline.
 */
export function orderRtlVisualLines(items: readonly unknown[], counts: PdfRtlRepairCounts): unknown[] {
  const out: unknown[] = [];
  /** One printed line: consecutive items on one baseline. Re-emitted right to left when its letters are mainly RTL. */
  const emitRun = (run: unknown[]) => {
    const geometry = run.map(geometryOf);
    const text = run.map(strOf).join("");
    const rtlLetters = text.match(RTL_CHARACTERS)?.length ?? 0;
    const latinLetters = text.match(LATIN_LETTERS)?.length ?? 0;
    if (run.length < 2 || rtlLetters <= latinLetters || geometry.some((g) => g === null)) {
      out.push(...run);
      return;
    }
    const lastHadEol = Boolean((run[run.length - 1] as RawItem).hasEOL);
    const ranked = run
      .map((item, index) => ({ item, index, right: geometry[index]!.right }))
      .sort((a, b) => b.right - a.right || a.index - b.index);
    counts.rtlLines += 1;
    out.push(...ranked.map(({ item }, position) => ({ ...(item as object), hasEOL: position === ranked.length - 1 ? lastHadEol : false, [RTL_VISUAL_LINE]: true })));
  };
  // pdf.js does not always set hasEOL between printed lines (measured: a presentation-form PDF emitting one item per
  // word ran two lines into one EOL group), so lines are the runs of consecutive items sharing a baseline.
  let run: unknown[] = [];
  let runBaseline: number | null = null;
  let runEm = 0;
  for (const item of items) {
    const g = geometryOf(item);
    const sameLine = run.length > 0 && g !== null && runBaseline !== null && Math.abs(g.baseline - runBaseline) < Math.max(runEm, g.em) * 0.15;
    if (run.length > 0 && !sameLine) {
      emitRun(run);
      run = [];
    }
    if (run.length === 0) {
      runBaseline = g?.baseline ?? null;
      runEm = g?.em ?? 0;
    }
    run.push(item);
    if (g) runEm = Math.max(runEm, g.em);
    if ((item as RawItem)?.hasEOL) {
      emitRun(run);
      run = [];
    }
  }
  if (run.length) emitRun(run);
  return out;
}

export function isRtlVisualLineItem(item: unknown): boolean {
  return Boolean(item && typeof item === "object" && (item as Record<symbol, unknown>)[RTL_VISUAL_LINE]);
}

/** The right-to-left repairs (see RIGHT-TO-LEFT TEXT above); a page without a right-to-left character is returned untouched. */
async function repairRightToLeftItems(page: PdfTextPage, items: unknown[]): Promise<unknown[]> {
  if (!hasRtlText(items)) return items;
  const counts = emptyPdfRtlRepairCounts();
  let repaired = items;
  if (typeof page.getOperatorList === "function") {
    let operatorList: Awaited<ReturnType<NonNullable<PdfTextPage["getOperatorList"]>>> | null = null;
    try {
      operatorList = await page.getOperatorList();
    } catch {
      // The glyph-order repair is skipped for this page; its text is still read, in right-to-left line order.
    }
    if (operatorList) repaired = repairRtlGlyphOrder(items, operatorList, counts);
  }
  return orderRtlVisualLines(repaired, counts);
}

async function collectPdfPages(
  document: PdfTextDocument,
  onProgress: PdfExtractionProgress | undefined,
  pageCount: number,
  strict: boolean,
): Promise<{ pages: string[]; failedPageNumbers: number[]; emptyPageCount: number }> {
  const pages: string[] = [];
  const failedPageNumbers: number[] = [];
  let emptyPageCount = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress?.(pageNumber, document.numPages);
    try {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const joined = joinPageTextItems(await repairRightToLeftItems(page, content.items));
      if (joined.trim().length === 0) emptyPageCount += 1;
      pages.push(joined);
    } catch (error) {
      if (strict) throw error;
      failedPageNumbers.push(pageNumber);
      pages.push("");
    }
  }
  return { pages, failedPageNumbers, emptyPageCount };
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
  diagnostics: string[];
}> {
  const totalPages = document.numPages;
  const pageCount = maxPages && maxPages > 0 ? Math.min(totalPages, maxPages) : totalPages;
  const truncatedByMaxPages = pageCount < totalPages;

  const { pages, failedPageNumbers, emptyPageCount } = await collectPdfPages(document, onProgress, pageCount, false);
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
    diagnostics,
  };
}
