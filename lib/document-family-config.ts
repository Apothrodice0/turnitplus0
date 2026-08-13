/**
 * Phase B (document families/versions) thresholds. Deliberately not
 * hard-coded at call sites — every function in lib/document-family.ts takes
 * this as an optional parameter, defaulting to DEFAULT_DOCUMENT_FAMILY_
 * THRESHOLDS, so a caller (or a future config-loading mechanism) can override
 * it without touching matching logic. The default values below are a
 * starting point for testing/development, not a calibrated or permanent
 * product decision — nothing has measured what these should be against real
 * submissions yet (contrast with public/data/risk-calibration.json's
 * matchingParameters, which *are* calibrated, for the live archive-overlap
 * pipeline this module does not touch).
 */
export type DocumentFamilyThresholds = {
  /** Shingle (word n-gram) size used when fingerprinting a document's text for family matching. Independent of the live similarity worker's shingle size. */
  shingleSize: number;
  /**
   * Minimum containment (shared informative shingles / the smaller document's
   * unique shingle count) required to classify two document identities as a
   * STRONG_TEXT_MATCH candidate relationship. 0..1.
   */
  strongTextMatchContainment: number;
};

export const DEFAULT_DOCUMENT_FAMILY_THRESHOLDS: DocumentFamilyThresholds = {
  shingleSize: 5,
  strongTextMatchContainment: 0.6,
};
