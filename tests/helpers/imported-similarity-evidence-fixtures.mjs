import { tokens } from "../../lib/similarity-core.ts";
import { sha256Hex, buildImportedSimilarityEvidencePackageFile } from "../../lib/imported-similarity-evidence/package.ts";
import { IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION } from "../../lib/imported-similarity-evidence/types.ts";

const SAMPLE_SHA256 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/** Builds a valid on-disk unit record from a plain anchor phrase (>= 6 informative words recommended) — defaults credit every anchor word unless scoreMaskRelativePositions is supplied. */
export function makeUnitRecord({
  evidenceUnitId,
  evidenceSetId = "ES-TEST00000001",
  anchorNormalizedText,
  scoreMaskRelativePositions,
  sourceAttributionState = "TURNITIN_SOURCE_MARKER_ONLY",
  reportSha256 = SAMPLE_SHA256,
  reportedSimilarityPercent = 49,
  confidence = "HIGH",
  normalizationVersion = IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
  overrides = {},
}) {
  const anchorTokens = tokens(anchorNormalizedText);
  const mask = scoreMaskRelativePositions ?? anchorTokens.map((_, index) => index);
  return {
    evidenceUnitId,
    evidenceSetId,
    provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256,
    reportedSimilarityPercent,
    normalizationVersion,
    sourceAttributionState,
    sourceMarkerNumbers: [],
    sourceNames: [],
    anchorNormalizedText,
    anchorTokenCount: anchorTokens.length,
    anchorTextSha256: sha256Hex(anchorNormalizedText),
    scoreMaskRelativePositions: [...new Set(mask)].sort((a, b) => a - b),
    scoreMaskWordCount: new Set(mask).size,
    goldSpanIds: [],
    originalManuscriptTokenPositions: [],
    originalReportPage: null,
    confidence,
    createdAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

export function makeEvidenceSet({
  evidenceSetId = "ES-TEST00000001",
  unitCount,
  totalScoreMaskWords,
  reportSha256 = SAMPLE_SHA256,
  reportedSimilarityPercent = 49,
  normalizationVersion = IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
  overrides = {},
}) {
  return {
    evidenceSetId,
    provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256,
    reportedSimilarityPercent,
    normalizationVersion,
    manuscriptIdentitySha256: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    unitCount,
    totalScoreMaskWords,
    ...overrides,
  };
}

/** Builds a full, valid on-disk package file from a list of unit records — one evidence set unless setOverrides.evidenceSetId groups differ. */
export function makePackageFile(unitRecords, setOverrides = {}) {
  const evidenceSetId = setOverrides.evidenceSetId ?? "ES-TEST00000001";
  const totalScoreMaskWords = unitRecords.reduce((sum, unit) => sum + unit.scoreMaskWordCount, 0);
  const evidenceSets = [makeEvidenceSet({ evidenceSetId, unitCount: unitRecords.length, totalScoreMaskWords, ...setOverrides })];
  return buildImportedSimilarityEvidencePackageFile(evidenceSets, unitRecords);
}
