import { createHash } from "node:crypto";
import { grams, informativeGram, tokens } from "../similarity-core";
import {
  IMPORTED_SIMILARITY_EVIDENCE_MIN_ANCHOR_WINDOW,
  IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
  IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE,
  type ImportedSimilarityEvidenceConfidence,
  type ImportedSimilarityEvidenceProvenanceType,
  type ImportedSimilarityEvidenceSet,
  type ImportedSimilarityEvidenceSourceAttributionState,
  type ImportedSimilarityEvidenceUnit,
} from "./types";

/**
 * IMPORTED SIMILARITY EVIDENCE — versioned external package format.
 *
 * This is a small, self-contained, read-only, file-backed package format —
 * not a database migration, not coupled to the SQL-backed Archive scalable
 * index (drizzle/0049+) or to Selective Corpus's own shard format
 * (lib/selective-corpus/shard-reader.ts). It exists so imported evidence data
 * (the actual passage text derived from a customer-supplied third-party
 * report) never needs to live in application source or in a repo-tracked
 * fixture: it is built once by tools/import-similarity-evidence.ts and loaded
 * at runtime from a path named by an internal-only env var (see ./config.ts).
 *
 * Deterministic, fail-closed loading: `validateImportedSimilarityEvidencePackage`
 * is a pure function (no I/O) so it is exhaustively unit-testable. A
 * WHOLE-PACKAGE integrity/compatibility failure (bad JSON shape, wrong
 * formatVersion, wrong normalizationVersion, contentSha256 mismatch) yields
 * `{ ok: false }` — the caller must treat this as "no imported evidence
 * package configured," never a partial/best-effort load. An individual
 * malformed UNIT inside an otherwise-valid, otherwise-intact package is
 * dropped (reported in `rejectedUnits`, never silently discarded from the
 * caller's visibility) while every other valid unit in the same package still
 * loads and scores normally.
 */

export const IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION = "imported-similarity-evidence-package-v1";

const SOURCE_ATTRIBUTION_STATES: readonly ImportedSimilarityEvidenceSourceAttributionState[] = [
  "ORIGINAL_SOURCE_VERIFIED",
  "ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED",
  "TURNITIN_SOURCE_MARKER_ONLY",
  "REPORT_DERIVED_REFERENCE",
];
const CONFIDENCE_VALUES: readonly ImportedSimilarityEvidenceConfidence[] = ["HIGH", "MEDIUM"];
const PROVENANCE_TYPES: readonly ImportedSimilarityEvidenceProvenanceType[] = ["TURNITIN_REPORT_IMPORT"];

/** The on-disk shape of one unit — everything in ImportedSimilarityEvidenceUnit except the derived `anchorTokens`, which is always recomputed from `anchorNormalizedText` at load time (never trusted from disk) so tokenizer parity holds by construction. */
export type ImportedSimilarityEvidenceUnitRecord = Omit<ImportedSimilarityEvidenceUnit, "anchorTokens">;

export type ImportedSimilarityEvidencePackageMetadata = {
  formatVersion: string;
  normalizationVersion: string;
  createdAt: string;
  evidenceSetCount: number;
  unitCount: number;
  /** sha256 over the canonical serialization of evidenceSets + units (see canonicalPackagePayload below) — the whole-package integrity gate. */
  contentSha256: string;
};

/** The on-disk file shape, exactly what tools/import-similarity-evidence.ts writes and what the loader reads back. */
export type ImportedSimilarityEvidencePackageFile = {
  metadata: ImportedSimilarityEvidencePackageMetadata;
  evidenceSets: ImportedSimilarityEvidenceSet[];
  units: ImportedSimilarityEvidenceUnitRecord[];
};

/** The loaded, runtime-ready package — units carry precomputed `anchorTokens`. */
export type ImportedSimilarityEvidencePackage = {
  metadata: ImportedSimilarityEvidencePackageMetadata;
  evidenceSets: readonly ImportedSimilarityEvidenceSet[];
  units: readonly ImportedSimilarityEvidenceUnit[];
};

export type RejectedUnit = { evidenceUnitId: string | null; reason: string };

export type PackageValidationResult =
  | { ok: true; package: ImportedSimilarityEvidencePackage; rejectedUnits: RejectedUnit[] }
  | { ok: false; reason: string };

/**
 * Canonical (stable key order) JSON serialization used for the integrity
 * hash — shared by the importer (computes it when writing) and the loader
 * (recomputes it when validating), so the two are always in agreement.
 * Deliberately independent of object literal key insertion order.
 */
export function canonicalPackagePayload(
  evidenceSets: readonly ImportedSimilarityEvidenceSet[],
  units: readonly ImportedSimilarityEvidenceUnitRecord[],
): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = stable((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify({ evidenceSets: stable(evidenceSets), units: stable(units) });
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isInteger(v));
}

/**
 * Validates one on-disk unit record, recomputing `anchorTokens` from
 * `anchorNormalizedText` with this channel's OWN production tokenizer
 * (never trusting anything the disk record might claim about tokenization).
 * Returns the runtime unit on success, or a rejection reason. Pure, no I/O,
 * never throws.
 */
export function validateImportedSimilarityEvidenceUnitRecord(
  raw: unknown,
  knownEvidenceSetIds: ReadonlySet<string>,
): { ok: true; unit: ImportedSimilarityEvidenceUnit } | { ok: false; evidenceUnitId: string | null; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, evidenceUnitId: null, reason: "unit is not an object" };
  }
  const r = raw as Record<string, unknown>;
  const evidenceUnitId = isNonEmptyString(r.evidenceUnitId) ? r.evidenceUnitId : null;
  const fail = (reason: string) => ({ ok: false as const, evidenceUnitId, reason });

  if (!evidenceUnitId) return fail("missing evidenceUnitId");
  if (!isNonEmptyString(r.evidenceSetId)) return fail("missing evidenceSetId");
  if (!knownEvidenceSetIds.has(r.evidenceSetId)) return fail(`evidenceSetId ${r.evidenceSetId} not declared in evidenceSets`);
  if (!PROVENANCE_TYPES.includes(r.provenanceType as ImportedSimilarityEvidenceProvenanceType)) return fail("invalid provenanceType");
  if (!isNonEmptyString(r.reportSha256)) return fail("missing reportSha256");
  if (r.reportedSimilarityPercent !== null && typeof r.reportedSimilarityPercent !== "number") return fail("invalid reportedSimilarityPercent");
  if (r.normalizationVersion !== IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION) {
    return fail(`unit normalizationVersion ${String(r.normalizationVersion)} does not match ${IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION}`);
  }
  if (!SOURCE_ATTRIBUTION_STATES.includes(r.sourceAttributionState as ImportedSimilarityEvidenceSourceAttributionState)) {
    return fail("invalid sourceAttributionState");
  }
  if (!isIntegerArray(r.sourceMarkerNumbers)) return fail("invalid sourceMarkerNumbers");
  if (!isStringArray(r.sourceNames)) return fail("invalid sourceNames");
  if (!isNonEmptyString(r.anchorNormalizedText)) return fail("empty anchor");
  if (!isFiniteInteger(r.anchorTokenCount) || r.anchorTokenCount < 1) return fail("invalid anchorTokenCount");
  if (!isNonEmptyString(r.anchorTextSha256)) return fail("missing anchorTextSha256");
  if (sha256Hex(r.anchorNormalizedText) !== r.anchorTextSha256) return fail("anchorTextSha256 mismatch (tampered or corrupt anchor)");

  // Tokenizer parity, enforced by construction: this channel's own production
  // tokenizer must reproduce EXACTLY the token count/sequence the anchor was
  // built under. A mismatch here (e.g. a future tokens() change without a
  // normalizationVersion bump) fails this ONE unit closed rather than risk a
  // silently misaligned score mask — see implementation-spec.md's own
  // documented tokenizeParityOk failure mode (measured recall 100% -> 56%
  // from index drift alone when the two sides disagree).
  const anchorTokens = tokens(r.anchorNormalizedText);
  if (anchorTokens.length !== r.anchorTokenCount) {
    return fail(`tokenizer parity mismatch: re-tokenized length ${anchorTokens.length} != anchorTokenCount ${r.anchorTokenCount}`);
  }
  if (anchorTokens.length < IMPORTED_SIMILARITY_EVIDENCE_MIN_ANCHOR_WINDOW) {
    return fail(`anchor shorter than MIN_ANCHOR_WINDOW (${anchorTokens.length} < ${IMPORTED_SIMILARITY_EVIDENCE_MIN_ANCHOR_WINDOW})`);
  }
  // Candidate discovery indexes every shingle of the anchor (see ./matcher.ts)
  // but a unit whose anchor contains NO informative shingle at all could never
  // be discovered by a real submission scan in practice, and is exactly the
  // class of "isolated numeral / all-common-word" unit the validated design
  // deliberately excludes (production-import-coverage.json's own
  // excludedUnitBreakdown: "no informative content ... isolated numeral or
  // all-numeric run"). Reject defensively rather than silently keep a unit
  // that can only ever be a dead weight in the index.
  const hasInformativeGram = grams([...anchorTokens], IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE).some((gram) => informativeGram(gram));
  if (!hasInformativeGram) return fail("anchor has no informative gram (isolated numeral / all-common-word content)");

  if (!isIntegerArray(r.scoreMaskRelativePositions) || r.scoreMaskRelativePositions.length === 0) {
    return fail("empty or invalid scoreMaskRelativePositions");
  }
  const maskSet = new Set(r.scoreMaskRelativePositions);
  if (maskSet.size !== r.scoreMaskRelativePositions.length) return fail("duplicate scoreMaskRelativePositions");
  for (const position of maskSet) {
    if (position < 0 || position >= anchorTokens.length) return fail(`scoreMaskRelativePositions out of bounds: ${position}`);
  }
  const scoreMaskWordCount = typeof r.scoreMaskWordCount === "number" ? r.scoreMaskWordCount : NaN;
  if (scoreMaskWordCount !== maskSet.size) return fail("scoreMaskWordCount does not match scoreMaskRelativePositions length");

  if (!isStringArray(r.goldSpanIds)) return fail("invalid goldSpanIds");
  if (!isIntegerArray(r.originalManuscriptTokenPositions)) return fail("invalid originalManuscriptTokenPositions");
  if (r.originalReportPage !== null && !isFiniteInteger(r.originalReportPage)) return fail("invalid originalReportPage");
  if (!CONFIDENCE_VALUES.includes(r.confidence as ImportedSimilarityEvidenceConfidence)) return fail("invalid confidence");
  if (!isNonEmptyString(r.createdAt)) return fail("missing createdAt");

  const unit: ImportedSimilarityEvidenceUnit = {
    evidenceUnitId,
    evidenceSetId: r.evidenceSetId,
    provenanceType: r.provenanceType as ImportedSimilarityEvidenceProvenanceType,
    reportSha256: r.reportSha256,
    reportedSimilarityPercent: (r.reportedSimilarityPercent as number | null) ?? null,
    normalizationVersion: r.normalizationVersion,
    sourceAttributionState: r.sourceAttributionState as ImportedSimilarityEvidenceSourceAttributionState,
    sourceMarkerNumbers: r.sourceMarkerNumbers as number[],
    sourceNames: r.sourceNames as string[],
    anchorNormalizedText: r.anchorNormalizedText,
    anchorTokens,
    anchorTokenCount: r.anchorTokenCount,
    anchorTextSha256: r.anchorTextSha256,
    scoreMaskRelativePositions: [...maskSet].sort((a, b) => a - b),
    scoreMaskWordCount,
    goldSpanIds: r.goldSpanIds as string[],
    originalManuscriptTokenPositions: r.originalManuscriptTokenPositions as number[],
    originalReportPage: (r.originalReportPage as number | null) ?? null,
    confidence: r.confidence as ImportedSimilarityEvidenceConfidence,
    createdAt: r.createdAt,
  };
  return { ok: true, unit };
}

function validateEvidenceSet(raw: unknown): ImportedSimilarityEvidenceSet | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.evidenceSetId)) return null;
  if (!PROVENANCE_TYPES.includes(r.provenanceType as ImportedSimilarityEvidenceProvenanceType)) return null;
  if (!isNonEmptyString(r.reportSha256)) return null;
  if (r.reportedSimilarityPercent !== null && typeof r.reportedSimilarityPercent !== "number") return null;
  if (r.normalizationVersion !== IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION) return null;
  if (r.manuscriptIdentitySha256 !== null && !isNonEmptyString(r.manuscriptIdentitySha256)) return null;
  if (!isNonEmptyString(r.createdAt)) return null;
  if (!isFiniteInteger(r.unitCount) || r.unitCount < 0) return null;
  if (!isFiniteInteger(r.totalScoreMaskWords) || r.totalScoreMaskWords < 0) return null;
  return {
    evidenceSetId: r.evidenceSetId,
    provenanceType: r.provenanceType as ImportedSimilarityEvidenceProvenanceType,
    reportSha256: r.reportSha256,
    reportedSimilarityPercent: (r.reportedSimilarityPercent as number | null) ?? null,
    normalizationVersion: r.normalizationVersion,
    manuscriptIdentitySha256: (r.manuscriptIdentitySha256 as string | null) ?? null,
    createdAt: r.createdAt,
    unitCount: r.unitCount,
    totalScoreMaskWords: r.totalScoreMaskWords,
  };
}

/**
 * Validates an entire loaded package payload. Never throws. A whole-package
 * structural/compatibility failure returns `{ ok: false }` — the caller must
 * treat this as "no package configured" (fail closed, no imported evidence
 * scoring at all), never a partial load.
 */
export function validateImportedSimilarityEvidencePackage(raw: unknown): PackageValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "package is not an object" };
  const r = raw as Record<string, unknown>;
  const metadata = r.metadata as Partial<ImportedSimilarityEvidencePackageMetadata> | undefined;
  if (!metadata || typeof metadata !== "object") return { ok: false, reason: "missing metadata" };
  if (metadata.formatVersion !== IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION) {
    return { ok: false, reason: `unsupported formatVersion ${String(metadata.formatVersion)}` };
  }
  if (metadata.normalizationVersion !== IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION) {
    return { ok: false, reason: `unsupported normalizationVersion ${String(metadata.normalizationVersion)}` };
  }
  if (!isNonEmptyString(metadata.contentSha256)) return { ok: false, reason: "missing contentSha256" };
  if (!Array.isArray(r.evidenceSets)) return { ok: false, reason: "evidenceSets is not an array" };
  if (!Array.isArray(r.units)) return { ok: false, reason: "units is not an array" };

  const evidenceSets: ImportedSimilarityEvidenceSet[] = [];
  const seenSetIds = new Set<string>();
  for (const rawSet of r.evidenceSets) {
    const set = validateEvidenceSet(rawSet);
    if (!set) return { ok: false, reason: "malformed evidenceSet entry" };
    if (seenSetIds.has(set.evidenceSetId)) return { ok: false, reason: `duplicate evidenceSetId ${set.evidenceSetId}` };
    seenSetIds.add(set.evidenceSetId);
    evidenceSets.push(set);
  }
  if (evidenceSets.length !== metadata.evidenceSetCount) {
    return { ok: false, reason: `evidenceSetCount mismatch: declared ${metadata.evidenceSetCount}, found ${evidenceSets.length}` };
  }

  // Whole-package integrity gate: recompute the same canonical hash the
  // importer stamped at build time over the RAW (unvalidated) records —
  // any bit-level corruption anywhere in the payload is caught here, before
  // any individual unit is even inspected.
  const recomputedContentSha256 = sha256Hex(canonicalPackagePayload(evidenceSets, r.units as ImportedSimilarityEvidenceUnitRecord[]));
  if (recomputedContentSha256 !== metadata.contentSha256) {
    return { ok: false, reason: "contentSha256 mismatch (package corrupt or tampered)" };
  }
  if (r.units.length !== metadata.unitCount) {
    return { ok: false, reason: `unitCount mismatch: declared ${metadata.unitCount}, found ${r.units.length}` };
  }

  const units: ImportedSimilarityEvidenceUnit[] = [];
  const rejectedUnits: RejectedUnit[] = [];
  const seenUnitIds = new Set<string>();
  for (const rawUnit of r.units) {
    const result = validateImportedSimilarityEvidenceUnitRecord(rawUnit, seenSetIds);
    if (!result.ok) {
      rejectedUnits.push({ evidenceUnitId: result.evidenceUnitId, reason: result.reason });
      continue;
    }
    if (seenUnitIds.has(result.unit.evidenceUnitId)) {
      rejectedUnits.push({ evidenceUnitId: result.unit.evidenceUnitId, reason: "duplicate evidenceUnitId" });
      continue;
    }
    seenUnitIds.add(result.unit.evidenceUnitId);
    units.push(result.unit);
  }

  return {
    ok: true,
    package: {
      metadata: metadata as ImportedSimilarityEvidencePackageMetadata,
      evidenceSets,
      units,
    },
    rejectedUnits,
  };
}

/** Builds the on-disk package file shape (metadata + evidenceSets + unit records) from already-validated inputs — used by tools/import-similarity-evidence.ts. Pure, no I/O. */
export function buildImportedSimilarityEvidencePackageFile(
  evidenceSets: ImportedSimilarityEvidenceSet[],
  unitRecords: ImportedSimilarityEvidenceUnitRecord[],
): ImportedSimilarityEvidencePackageFile {
  const contentSha256 = sha256Hex(canonicalPackagePayload(evidenceSets, unitRecords));
  return {
    metadata: {
      formatVersion: IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION,
      normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
      createdAt: new Date().toISOString(),
      evidenceSetCount: evidenceSets.length,
      unitCount: unitRecords.length,
      contentSha256,
    },
    evidenceSets,
    units: unitRecords,
  };
}
