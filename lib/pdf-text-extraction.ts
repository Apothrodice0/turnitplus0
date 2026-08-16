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

function textItemValue(item: unknown) {
  return item && typeof item === "object" && "str" in item
    ? String((item as { str: unknown }).str ?? "")
    : "";
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
export async function extractPdfTextDocument(
  document: PdfTextDocument,
  onProgress?: PdfExtractionProgress,
  maxPages?: number,
) {
  const pageCount = maxPages && maxPages > 0 ? Math.min(document.numPages, maxPages) : document.numPages;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress?.(pageNumber, document.numPages);
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map(textItemValue).join(" "));
  }
  return `${pages.join("\n\n")}\n\n`;
}
