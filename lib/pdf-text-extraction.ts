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

/** Phase 5 addition — mirrors lib/html-text-extraction.ts's HTML_EXTRACTOR_VERSION convention, for callers (lib/http-content-retriever.ts) that record which extractor produced a given RetrievedSource.extractedText. */
export const PDF_EXTRACTOR_VERSION = "pdf-text-extraction-v1";

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
      const joined = joinPageTextItems(content.items);
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
