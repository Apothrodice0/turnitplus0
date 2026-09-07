/**
 * Corpus admission / quality gate — shared vocabulary.
 *
 * Every other corpus-admission-* module imports its shared types and
 * versioned configuration from here, so there is exactly one place that
 * defines "what a threshold looks like" and "what evidence backs it" —
 * mirrors this codebase's existing SpecifiedValue<T>/EvidenceStatus pattern
 * for other pure policy/spec modules. This file has no logic and no I/O.
 *
 * This module is entirely new and is never imported by any normal
 * report-checking or report-scoring code path (app/api/reports/route.ts,
 * app/page.tsx, app/similarity-worker.ts, app/ai-detector-worker.ts) — see
 * tests/corpus-admission-privacy.test.mjs.
 */

/** How well-justified a configured value currently is — the same four-way taxonomy this codebase's other policy/spec modules already use. Every threshold in this feature is ENGINEERING_DEFAULT until the 770-article calibration pass (spec section 6) produces real evidence. */
export type EvidenceStatus = "EVIDENCE_BACKED" | "ENGINEERING_DEFAULT" | "PRODUCTION_INHERITED" | "UNRESOLVED";

export type SpecifiedValue<T> = {
  value: T;
  status: EvidenceStatus;
  /** Cites the specific finding this value traces to, or explains why it does not yet trace to one. */
  rationale: string;
};

function engineeringDefault<T>(value: T, rationale: string): SpecifiedValue<T> {
  return { value, status: "ENGINEERING_DEFAULT", rationale };
}

// ============================================================================
// Resource / safety limits — untrusted-file handling (revision 4, requirement 5)
// ============================================================================

export type CorpusAdmissionLimits = {
  /** Pre-parse cap on the raw uploaded file, checked before any parsing is attempted. */
  maxFileBytes: SpecifiedValue<number>;
  /** PDF page-count cap, checked via pdfDocument.numPages before extracting page text. */
  maxPdfPages: SpecifiedValue<number>;
  /** Post-extraction cap on extracted character count. */
  maxExtractedChars: SpecifiedValue<number>;
  /** Hard wall-clock budget for the isolated extraction worker before it is terminated. */
  extractionTimeoutMs: SpecifiedValue<number>;
  /** Heap ceiling (old-generation) for the isolated extraction worker, node:worker_threads resourceLimits.maxOldGenerationSizeMb. */
  extractionWorkerMaxOldGenerationMb: SpecifiedValue<number>;
  /** Heap ceiling (young-generation) for the isolated extraction worker. */
  extractionWorkerMaxYoungGenerationMb: SpecifiedValue<number>;
  /** DOCX/ZIP: max entries enumerated before the archive is rejected outright, checked before any entry is inflated. */
  maxZipEntries: SpecifiedValue<number>;
  /** DOCX/ZIP: max uncompressed size for any single entry. */
  maxZipEntryUncompressedBytes: SpecifiedValue<number>;
  /** DOCX/ZIP: max summed uncompressed size across all entries. */
  maxZipTotalUncompressedBytes: SpecifiedValue<number>;
  /** DOCX/ZIP: max uncompressed/compressed ratio for any single entry — the primary zip-bomb defense. */
  maxZipCompressionRatio: SpecifiedValue<number>;
  /** Dry-run CLI: max candidates processed concurrently. */
  cliMaxConcurrency: SpecifiedValue<number>;
  /** Library-level cap (lib/corpus-text-extraction.ts) on how many isolated extraction Worker threads may run at once, enforced regardless of caller — the CLI's own cliMaxConcurrency bounds end-to-end candidate processing; this bounds the specific scarce OS resource (worker-thread spawn) underneath it. */
  extractionWorkerConcurrencyLimit: SpecifiedValue<number>;
};

export const DEFAULT_CORPUS_ADMISSION_LIMITS: CorpusAdmissionLimits = {
  maxFileBytes: engineeringDefault(25 * 1024 * 1024, "No legitimate single-article PDF/DOCX/TXT this project has seen approaches 25MB; generous headroom over a real article while still rejecting obviously-oversized uploads before any parsing begins."),
  maxPdfPages: engineeringDefault(500, "Far beyond any real journal article or thesis chapter; bounds worst-case per-page extraction work."),
  maxExtractedChars: engineeringDefault(2_000_000, "Matches this project's existing POST /api/reports payload-size reasoning (app/api/reports/route.ts's own 2MB MAX_BYTES) applied to extracted text specifically, not a re-derived number."),
  extractionTimeoutMs: engineeringDefault(30_000, "Generous for a real single-article PDF/DOCX on typical hardware; short enough that a 770-document batch does not stall indefinitely on one pathological file."),
  extractionWorkerMaxOldGenerationMb: engineeringDefault(512, "Comfortably above real-world pdfjs/mammoth memory use for an article-length document, well below a host process's own budget."),
  extractionWorkerMaxYoungGenerationMb: engineeringDefault(64, "Node's own typical default order of magnitude for young-generation space; not independently tuned."),
  maxZipEntries: engineeringDefault(1000, "A real DOCX (document.xml, styles, a handful of relationship/media parts) uses a few dozen entries at most; 1000 is generous headroom while still bounding an entry-count-based zip bomb."),
  maxZipEntryUncompressedBytes: engineeringDefault(100 * 1024 * 1024, "Bounds a single pathological entry (e.g. one XML part) even if maxZipTotalUncompressedBytes were somehow not yet reached."),
  maxZipTotalUncompressedBytes: engineeringDefault(500 * 1024 * 1024, "Bounds the sum across all entries — the primary defense against many entries each individually under the per-entry cap."),
  maxZipCompressionRatio: engineeringDefault(200, "Legitimate DOCX XML parts typically compress at roughly 5:1-20:1; 200:1 leaves generous headroom for real documents while still catching pathological zip-bomb ratios, which are commonly 1000:1 or higher."),
  cliMaxConcurrency: engineeringDefault(4, "Bounds worker-thread fan-out for the dry-run CLI to a small, predictable number; not independently tuned against real hardware."),
  extractionWorkerConcurrencyLimit: engineeringDefault(4, "A library-level backstop independent of any one caller's own concurrency setting — bounds real OS worker-thread spawning directly, added after the verification pass observed full-test-suite resource contention from unbounded concurrent Worker creation."),
};

// ============================================================================
// Provenance / consent / retention (revision 1)
// ============================================================================

export type CorpusAcquisitionMethod = "MANUAL_UPLOAD" | "BULK_IMPORT_DOWNLOAD" | "API_RETRIEVAL" | "OTHER";
export type CorpusRetentionBasis = "LICENSED_REUSE" | "CONSENT_GRANTED" | "PUBLIC_DOMAIN" | "FAIR_USE_CLAIMED" | "UNRESOLVED";

/**
 * Per-candidate provenance/licensing record for a bulk-import candidate (the
 * 770-article workflow) — replaces a bare "operator authorized this" flag.
 * retentionRightsResolved is the single gate: false blocks BOTH corpus
 * admission (lib/corpus-hard-gates.ts's RETENTION_REQUIREMENT_UNMET) AND
 * full-text persistence (lib/corpus-admission-gate.ts never writes to
 * corpus_admission_content_store when this is false), by construction, not
 * by convention.
 */
export type CorpusProvenanceRecord = {
  sourceUrl: string | null;
  acquisitionMethod: CorpusAcquisitionMethod;
  licenseOrPermission: string | null;
  retentionBasis: CorpusRetentionBasis;
  retentionRightsResolved: boolean;
  notes: string | null;
};

/**
 * Two distinct consent shapes for two distinct callers. A live, per-account
 * user upload always carries `{ kind: "PER_USER_CONSENT", consented: true }`
 * — corpus-admission eligibility is mandatory for every authenticated
 * account (product decision), so lib/corpus-admission-report-integration.ts's
 * processReportAdmissionJob no longer reads users.corpus_reuse_consented_at
 * (now a vestigial column) to derive this. An externally-sourced bulk-import
 * candidate has no per-account consent to check at all and instead carries
 * its own CorpusProvenanceRecord.
 */
export type CorpusConsentEvidence =
  | { kind: "PER_USER_CONSENT"; consented: boolean }
  | { kind: "BULK_IMPORT_PROVENANCE"; provenance: CorpusProvenanceRecord };

// ============================================================================
// Reason-code taxonomy — closed unions, hard-gate codes are a strict subset
// of the overall reason-code union (tested: whenever hardGatePassed===false,
// reasonCodes is a superset of hardGateFailureCodes using the same string
// values, never two independently-maintained lists).
// ============================================================================

export const CORPUS_HARD_GATE_REASON_CODES = [
  "UNSUPPORTED_FILE_FORMAT",
  "EMPTY_FILE",
  "FILE_SIGNATURE_MISMATCH",
  "DANGEROUS_FILE_SIGNATURE",
  "FILE_TOO_LARGE",
  "DOCX_STRUCTURE_INVALID",
  "DOCX_ZIP_BOMB_SUSPECTED",
  "DOCX_PATH_TRAVERSAL_ENTRY",
  "DOCX_MACRO_DETECTED",
  "DOCX_DANGEROUS_EMBEDDED_OBJECT",
  "EXTRACTION_FAILED",
  "EXTRACTION_EMPTY_RESULT",
  "EXTRACTION_TIMEOUT",
  "EXTRACTION_WORKER_TERMINATED",
  "EXTRACTED_CONTENT_TOO_LARGE",
  "WORD_COUNT_BELOW_MINIMUM",
  "NOT_ENGLISH",
  "CONSENT_MISSING",
  "RETENTION_REQUIREMENT_UNMET",
] as const;
export type CorpusHardGateCode = typeof CORPUS_HARD_GATE_REASON_CODES[number];

export const CORPUS_FAMILY_REASON_CODES = [
  "DUPLICATE_ALREADY_REPRESENTED",
  "EDITED_VERSION_ALREADY_REPRESENTED",
] as const;

export const CORPUS_QUALITY_REASON_CODES = [
  "LOW_EXTRACTION_INTEGRITY",
  "LOW_LINGUISTIC_QUALITY",
  "LANGUAGE_UNCERTAIN",
  "WEAK_DOCUMENT_STRUCTURE",
  "HIGH_CONTAMINATION",
  "HIGH_INTERNAL_REDUNDANCY",
  "REFERENCE_SECTION_DOMINANT",
  "TABLE_CONTENT_DOMINANT",
  "CODE_CONTENT_DOMINANT",
  "FORMAT_DEFERRED_FOR_V1",
  "OVERALL_QUALITY_BELOW_ACCEPT_THRESHOLD",
  "OVERALL_QUALITY_CRITICALLY_LOW",
] as const;

export const CORPUS_VALUE_REASON_CODES = [
  "LOW_CORPUS_VALUE",
] as const;

export const CORPUS_POSITIVE_REASON_CODES = [
  "MEETS_ALL_HARD_GATES",
  "QUALITY_ABOVE_ACCEPT_THRESHOLD",
  "CORPUS_VALUE_ABOVE_ACCEPT_THRESHOLD",
] as const;

export type CorpusAdmissionReasonCode =
  | typeof CORPUS_HARD_GATE_REASON_CODES[number]
  | typeof CORPUS_FAMILY_REASON_CODES[number]
  | typeof CORPUS_QUALITY_REASON_CODES[number]
  | typeof CORPUS_VALUE_REASON_CODES[number]
  | typeof CORPUS_POSITIVE_REASON_CODES[number];

// ============================================================================
// Decision
// ============================================================================

export type CorpusAdmissionDecision = "ACCEPT" | "REVIEW" | "REJECT";

export type CorpusSupportedFormat = "pdf" | "docx" | "txt" | "md" | "html";
