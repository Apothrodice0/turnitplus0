import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tokens } from "../lib/similarity-core";
import {
  IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
  type ImportedSimilarityEvidenceConfidence,
  type ImportedSimilarityEvidenceProvenanceType,
  type ImportedSimilarityEvidenceSet,
  type ImportedSimilarityEvidenceSourceAttributionState,
} from "../lib/imported-similarity-evidence/types";
import {
  buildImportedSimilarityEvidencePackageFile,
  sha256Hex,
  validateImportedSimilarityEvidenceUnitRecord,
  type ImportedSimilarityEvidenceUnitRecord,
  type RejectedUnit,
} from "../lib/imported-similarity-evidence/package";

/**
 * IMPORTED SIMILARITY EVIDENCE — generic local importer/builder.
 *
 * Consumes validated evidence records (one JSON object per line — the
 * `production-import-units.jsonl` shape) and produces a runtime-loadable
 * package (see lib/imported-similarity-evidence/package.ts). A DEV-ONLY
 * build tool: it never runs as part of request handling, and its output is
 * an external, versioned data file — never committed into this repo, never
 * baked into application source.
 *
 * Does NOT require or use a whole-document hash for matching — a report/
 * article SHA is carried through purely as provenance metadata (see
 * lib/imported-similarity-evidence/types.ts's own header comment).
 *
 * Usage:
 *   node --import tsx tools/import-similarity-evidence.ts \
 *     --input <path-to-production-import-units.jsonl> \
 *     --output <output-directory> \
 *     [--manuscript <path-to-manuscript-text-file>]
 */

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
function requireArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return value;
}

const SOURCE_ATTRIBUTION_STATES = new Set<ImportedSimilarityEvidenceSourceAttributionState>([
  "ORIGINAL_SOURCE_VERIFIED",
  "ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED",
  "TURNITIN_SOURCE_MARKER_ONLY",
  "REPORT_DERIVED_REFERENCE",
]);
const CONFIDENCE_VALUES = new Set<ImportedSimilarityEvidenceConfidence>(["HIGH", "MEDIUM"]);
const PROVENANCE_TYPES = new Set<ImportedSimilarityEvidenceProvenanceType>(["TURNITIN_REPORT_IMPORT"]);

type RawImportRecord = {
  EVIDENCE_SET_ID?: unknown;
  EVIDENCE_UNIT_ID?: unknown;
  PROVENANCE_TYPE?: unknown;
  REPORT_SHA256?: unknown;
  REPORTED_SIMILARITY_PERCENT?: unknown;
  SOURCE_ATTRIBUTION_STATE?: unknown;
  SOURCE_MARKER_NUMBERS?: unknown;
  SOURCE_NAMES?: unknown;
  ANCHOR_NORMALIZED_TEXT?: unknown;
  SCORE_MASK_RELATIVE_POSITIONS?: unknown;
  GOLD_SPAN_IDS?: unknown;
  ORIGINAL_MANUSCRIPT_TOKEN_POSITIONS?: unknown;
  ORIGINAL_REPORT_PAGE?: unknown;
  CONFIDENCE?: unknown;
  CREATED_AT?: unknown;
};

function transformRecord(raw: RawImportRecord, lineNumber: number): { record: ImportedSimilarityEvidenceUnitRecord } | { reject: RejectedUnit } {
  const evidenceUnitId = typeof raw.EVIDENCE_UNIT_ID === "string" ? raw.EVIDENCE_UNIT_ID : null;
  const reject = (reason: string) => ({ reject: { evidenceUnitId, reason: `line ${lineNumber}: ${reason}` } });

  if (typeof raw.EVIDENCE_SET_ID !== "string") return reject("missing EVIDENCE_SET_ID");
  if (!evidenceUnitId) return reject("missing EVIDENCE_UNIT_ID");
  if (!PROVENANCE_TYPES.has(raw.PROVENANCE_TYPE as ImportedSimilarityEvidenceProvenanceType)) return reject("invalid PROVENANCE_TYPE");
  if (typeof raw.REPORT_SHA256 !== "string" || raw.REPORT_SHA256.length === 0) return reject("missing REPORT_SHA256");
  if (typeof raw.ANCHOR_NORMALIZED_TEXT !== "string" || raw.ANCHOR_NORMALIZED_TEXT.trim().length === 0) return reject("empty ANCHOR_NORMALIZED_TEXT");
  if (!SOURCE_ATTRIBUTION_STATES.has(raw.SOURCE_ATTRIBUTION_STATE as ImportedSimilarityEvidenceSourceAttributionState)) return reject("invalid SOURCE_ATTRIBUTION_STATE");
  if (!CONFIDENCE_VALUES.has(raw.CONFIDENCE as ImportedSimilarityEvidenceConfidence)) return reject("invalid CONFIDENCE");
  if (typeof raw.CREATED_AT !== "string" || raw.CREATED_AT.length === 0) return reject("missing CREATED_AT");
  if (!Array.isArray(raw.SCORE_MASK_RELATIVE_POSITIONS) || raw.SCORE_MASK_RELATIVE_POSITIONS.length === 0) return reject("empty/missing SCORE_MASK_RELATIVE_POSITIONS");

  // Re-tokenize with THIS production tokenizer (never trust the source
  // export's own token count/hash) — the tokenizer-parity fix this channel's
  // implementation spec requires. See package.ts's own validator, which
  // re-checks this exact invariant at load time as a second, independent
  // gate.
  const anchorNormalizedText = raw.ANCHOR_NORMALIZED_TEXT.trim();
  const anchorTokens = tokens(anchorNormalizedText);
  if (anchorTokens.join(" ") !== anchorNormalizedText) {
    return reject(`tokenizer parity mismatch: re-tokenizing "${anchorNormalizedText.slice(0, 40)}..." does not round-trip`);
  }

  const maskSet = new Set<number>();
  for (const value of raw.SCORE_MASK_RELATIVE_POSITIONS as unknown[]) {
    if (typeof value !== "number" || !Number.isInteger(value)) return reject("non-integer entry in SCORE_MASK_RELATIVE_POSITIONS");
    maskSet.add(value);
  }
  for (const position of maskSet) {
    if (position < 0 || position >= anchorTokens.length) return reject(`SCORE_MASK_RELATIVE_POSITIONS out of bounds: ${position}`);
  }

  const sourceMarkerNumbers = Array.isArray(raw.SOURCE_MARKER_NUMBERS)
    ? (raw.SOURCE_MARKER_NUMBERS as unknown[]).filter((v): v is number => typeof v === "number" && Number.isInteger(v))
    : [];
  const sourceNames = Array.isArray(raw.SOURCE_NAMES)
    ? (raw.SOURCE_NAMES as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const goldSpanIds = Array.isArray(raw.GOLD_SPAN_IDS)
    ? (raw.GOLD_SPAN_IDS as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const originalManuscriptTokenPositions = Array.isArray(raw.ORIGINAL_MANUSCRIPT_TOKEN_POSITIONS)
    ? (raw.ORIGINAL_MANUSCRIPT_TOKEN_POSITIONS as unknown[]).filter((v): v is number => typeof v === "number" && Number.isInteger(v))
    : [];
  const originalReportPage = typeof raw.ORIGINAL_REPORT_PAGE === "number" && Number.isInteger(raw.ORIGINAL_REPORT_PAGE)
    ? raw.ORIGINAL_REPORT_PAGE
    : null;
  const reportedSimilarityPercent = typeof raw.REPORTED_SIMILARITY_PERCENT === "number" ? raw.REPORTED_SIMILARITY_PERCENT : null;

  const record: ImportedSimilarityEvidenceUnitRecord = {
    evidenceUnitId,
    evidenceSetId: raw.EVIDENCE_SET_ID,
    provenanceType: raw.PROVENANCE_TYPE as ImportedSimilarityEvidenceProvenanceType,
    reportSha256: raw.REPORT_SHA256,
    reportedSimilarityPercent,
    normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
    sourceAttributionState: raw.SOURCE_ATTRIBUTION_STATE as ImportedSimilarityEvidenceSourceAttributionState,
    sourceMarkerNumbers,
    sourceNames,
    anchorNormalizedText,
    anchorTokenCount: anchorTokens.length,
    anchorTextSha256: sha256Hex(anchorNormalizedText),
    scoreMaskRelativePositions: [...maskSet].sort((a, b) => a - b),
    scoreMaskWordCount: maskSet.size,
    goldSpanIds,
    originalManuscriptTokenPositions,
    originalReportPage,
    confidence: raw.CONFIDENCE as ImportedSimilarityEvidenceConfidence,
    createdAt: raw.CREATED_AT,
  };
  return { record };
}

async function main() {
  const inputPath = resolve(requireArg("--input"));
  const outputDir = resolve(requireArg("--output"));
  const manuscriptPath = arg("--manuscript");

  const lines = readFileSync(inputPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);

  const candidateRecords: ImportedSimilarityEvidenceUnitRecord[] = [];
  const rejected: RejectedUnit[] = [];
  const setMetaSeen = new Map<string, { reportSha256: string; reportedSimilarityPercent: number | null; provenanceType: ImportedSimilarityEvidenceProvenanceType; createdAt: string }>();

  lines.forEach((line, index) => {
    let raw: RawImportRecord;
    try {
      raw = JSON.parse(line) as RawImportRecord;
    } catch (err) {
      rejected.push({ evidenceUnitId: null, reason: `line ${index + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
    const outcome = transformRecord(raw, index + 1);
    if ("reject" in outcome) {
      rejected.push(outcome.reject);
      return;
    }
    candidateRecords.push(outcome.record);
    if (!setMetaSeen.has(outcome.record.evidenceSetId)) {
      setMetaSeen.set(outcome.record.evidenceSetId, {
        reportSha256: outcome.record.reportSha256,
        reportedSimilarityPercent: outcome.record.reportedSimilarityPercent,
        provenanceType: outcome.record.provenanceType,
        createdAt: outcome.record.createdAt,
      });
    }
  });

  // Second, independent gate: run every candidate record through the SAME
  // validator the runtime loader uses (package.ts), so a unit that would be
  // rejected at load time is caught and reported HERE instead of silently
  // shrinking the runtime package later. Duplicate ids are also caught here.
  const knownSetIds = new Set(setMetaSeen.keys());
  const acceptedRecords: ImportedSimilarityEvidenceUnitRecord[] = [];
  const seenUnitIds = new Set<string>();
  for (const record of candidateRecords) {
    const result = validateImportedSimilarityEvidenceUnitRecord(record, knownSetIds);
    if (!result.ok) {
      rejected.push({ evidenceUnitId: result.evidenceUnitId, reason: `post-transform validation: ${result.reason}` });
      continue;
    }
    if (seenUnitIds.has(record.evidenceUnitId)) {
      rejected.push({ evidenceUnitId: record.evidenceUnitId, reason: "duplicate evidenceUnitId" });
      continue;
    }
    seenUnitIds.add(record.evidenceUnitId);
    acceptedRecords.push(record);
  }

  const manuscriptIdentitySha256 = manuscriptPath
    ? createHash("sha256").update(readFileSync(resolve(manuscriptPath))).digest("hex")
    : null;

  const unitCountBySet = new Map<string, number>();
  const scoreMaskWordsBySet = new Map<string, number>();
  for (const record of acceptedRecords) {
    unitCountBySet.set(record.evidenceSetId, (unitCountBySet.get(record.evidenceSetId) ?? 0) + 1);
    scoreMaskWordsBySet.set(record.evidenceSetId, (scoreMaskWordsBySet.get(record.evidenceSetId) ?? 0) + record.scoreMaskWordCount);
  }

  const evidenceSets: ImportedSimilarityEvidenceSet[] = [...setMetaSeen.entries()]
    .filter(([setId]) => (unitCountBySet.get(setId) ?? 0) > 0)
    .map(([evidenceSetId, meta]) => ({
      evidenceSetId,
      provenanceType: meta.provenanceType,
      reportSha256: meta.reportSha256,
      reportedSimilarityPercent: meta.reportedSimilarityPercent,
      normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
      manuscriptIdentitySha256,
      createdAt: meta.createdAt,
      unitCount: unitCountBySet.get(evidenceSetId) ?? 0,
      totalScoreMaskWords: scoreMaskWordsBySet.get(evidenceSetId) ?? 0,
    }));

  const packageFile = buildImportedSimilarityEvidencePackageFile(evidenceSets, acceptedRecords);
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "imported-similarity-evidence-package.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  const serialized = JSON.stringify(packageFile, null, 2);
  writeFileSync(outputPath, serialized);
  const packageBytes = Buffer.byteLength(serialized, "utf8");
  const packageFileSha256 = createHash("sha256").update(serialized).digest("hex");

  const summary = {
    inputPath,
    outputPath,
    evidenceSets: evidenceSets.length,
    unitsCandidate: candidateRecords.length,
    unitsImported: acceptedRecords.length,
    unitsRejected: rejected.length,
    rejectedUnits: rejected,
    packageBytes,
    packageFileSha256,
    packageContentSha256: packageFile.metadata.contentSha256,
    normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
    manuscriptIdentitySha256,
  };
  writeFileSync(join(outputDir, "import-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
