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

function textItemValue(item: unknown) {
  return item && typeof item === "object" && "str" in item
    ? String((item as { str: unknown }).str ?? "")
    : "";
}

/**
 * The single PDF text-layer contract used by both browser uploads and corpus
 * calibration. Keeping this page assembly in one pure helper prevents the
 * production and offline representations from drifting apart again.
 */
export async function extractPdfTextDocument(
  document: PdfTextDocument,
  onProgress?: PdfExtractionProgress,
) {
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress?.(pageNumber, document.numPages);
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map(textItemValue).join(" "));
  }
  return `${pages.join("\n\n")}\n\n`;
}
