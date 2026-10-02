import { assertPdfjsContractVersion, PDF_EXTRACTOR_VERSION } from "../lib/pdf-text-extraction";

/**
 * What tools/reextract-ai-negatives-pdfjs.ts may claim about the text it
 * writes, and when it may replace text that is already there.
 *
 * The 88 verified-human AI-negative documents the AI calibration was built
 * from are recorded in corpus/manifest.json as `shared-pdfjs-text-layer-v3`:
 * the shared PDF.js page assembly as it was when they were extracted. That
 * label was a fixed string, so it kept being written after the shared
 * extractor changed underneath it. The label is now DERIVED from the
 * extractor's own version tag — the tool cannot name one extraction contract
 * while running another — and a run that would replace text recorded under a
 * different contract stops unless the operator names the new contract.
 */
export const AI_NEGATIVE_EXTRACTION_METHOD = `shared-pdfjs-text-layer-${PDF_EXTRACTOR_VERSION}`;

export const REPLACE_EXTRACTION_CONTRACT_FLAG = "--replace-extraction-contract";

type ManifestProvenance = { extractionMethod?: unknown; [key: string]: unknown };

/** How many of `entries` hold text recorded under each contract other than the one this build writes. */
export function extractionContractsBeingReplaced(
  entries: ReadonlyArray<{ provenance: ManifestProvenance }>,
): Record<string, number> {
  const replaced: Record<string, number> = {};
  for (const entry of entries) {
    const recorded = entry.provenance.extractionMethod;
    if (recorded === AI_NEGATIVE_EXTRACTION_METHOD) continue;
    const label = typeof recorded === "string" && recorded ? recorded : "(unrecorded)";
    replaced[label] = (replaced[label] ?? 0) + 1;
  }
  return replaced;
}

/**
 * FAIL CLOSED. Replacing calibrated text with text from another extraction
 * contract changes what the AI calibration was measured on; it is never a
 * side effect of a routine re-run. Throws — before any archive is read or any
 * file is written — unless every entry already carries this build's label, or
 * `acknowledged` (the value of {@link REPLACE_EXTRACTION_CONTRACT_FLAG}) is
 * exactly this build's label. An acknowledgement naming any other label is
 * refused too, so a saved command line stops working the next time the
 * extractor changes.
 */
export function assertExtractionContractReplacementAcknowledged(
  entries: ReadonlyArray<{ provenance: ManifestProvenance }>,
  acknowledged: string | null,
): void {
  if (acknowledged !== null && acknowledged !== AI_NEGATIVE_EXTRACTION_METHOD) {
    throw new Error(
      `${REPLACE_EXTRACTION_CONTRACT_FLAG} ${acknowledged} does not name the contract this build extracts under `
      + `(${AI_NEGATIVE_EXTRACTION_METHOD}). Nothing was read or written.`,
    );
  }
  const replaced = extractionContractsBeingReplaced(entries);
  const count = Object.values(replaced).reduce((total, n) => total + n, 0);
  if (count === 0 || acknowledged === AI_NEGATIVE_EXTRACTION_METHOD) return;
  const recorded = Object.entries(replaced).map(([label, n]) => `${label} (${n})`).join(", ");
  throw new Error(
    `Refusing to re-extract: ${count} of ${entries.length} AI-negative documents hold text recorded as ${recorded}. `
    + `This build would replace it with ${AI_NEGATIVE_EXTRACTION_METHOD} text, a different extraction contract, so the `
    + "AI calibration measured on the stored text (public/data/ai-calibration.json) would no longer describe it. "
    + "Nothing was read or written. To replace the calibrated text deliberately, re-run with "
    + `${REPLACE_EXTRACTION_CONTRACT_FLAG} ${AI_NEGATIVE_EXTRACTION_METHOD} and then repeat the AI calibration.`,
  );
}

/**
 * The provenance of one re-extracted document: this build's label, the
 * extractor tag and the pdf.js release that produced the text. Refuses a
 * pdf.js build the extractor tag is not defined against, and drops the old
 * integer `textExtractionContractVersion`, which described the text that was
 * just replaced.
 */
export function reextractedProvenance<T extends ManifestProvenance>(
  previous: T,
  update: { textSha256: string; pdfSha256: string; sourceFileName: string; pdfjsVersion: unknown },
) {
  assertPdfjsContractVersion(update.pdfjsVersion);
  const kept: T & { textExtractionContractVersion?: unknown } = { ...previous };
  delete kept.textExtractionContractVersion;
  return {
    ...kept,
    sha256: update.textSha256,
    pdfSha256: update.pdfSha256,
    sourceFileName: update.sourceFileName,
    extractionMethod: AI_NEGATIVE_EXTRACTION_METHOD,
    pdfExtractorVersion: PDF_EXTRACTOR_VERSION,
    pdfjsVersion: update.pdfjsVersion as string,
  };
}
