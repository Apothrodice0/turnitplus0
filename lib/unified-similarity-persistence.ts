import type { UnifiedEvidenceContribution, UnifiedSimilarityResult } from "./unified-similarity";
import { jsonValuesEqual } from "./json-values-equal";
import { resolveCompactPersistenceWrites, type CompactPersistenceWriteOptions } from "./report-compact-persistence-flag";

/**
 * Pre-launch hardening fix — measured 2 MB report-transport-ceiling
 * characterization: `computeUnifiedSimilarity()`'s `previousUploadPositions`
 * is, by construction (see that function's own diagnostic-breakdown loop),
 * an EXCLUSIVE SUBSET of `matchedPositions` — every position attributed to
 * the previous-upload/corpus-source channel and no other. Whenever a
 * report's ONLY contributing channel is previous-upload/corpus-source (no
 * archive, no live-academic, no user-supplied-reference, no selective-corpus
 * contribution, no overlap), that subset equals the WHOLE set, and the two
 * sorted-ascending integer arrays serialize to byte-identical JSON — a real,
 * measured duplication (~100KB on the audited fixture) that is entirely
 * redundant: nothing about `unifiedScore`/`uniqueMatchedWords` depends on
 * either array (both are built in a diagnostic pass strictly AFTER scoring;
 * see computeUnifiedSimilarity's own comments), so eliding the duplicate at
 * the PERSISTENCE boundary changes zero scoring/presentation semantics.
 *
 * This module is the ONLY place that encodes/decodes this representation.
 * `computeUnifiedSimilarity()` itself is NEVER touched by this fix — its
 * in-memory return value stays fully expanded, exactly as before, for every
 * existing caller (shadow evaluators, tests, etc.) that never persists
 * anything. Compaction is applied ONLY immediately before JSON-serializing a
 * report for `payload_json`, at each of the three write sites; expansion is
 * applied ONLY immediately after JSON.parse-ing `payload_json` back, at
 * each customer-facing read site — everything in between (evidence
 * interpretation, report-completion, highlighting, accessors) continues to
 * see the exact same fully-expanded shape it always has.
 *
 * Scope of the ORIGINAL fix: ONLY `previousUploadPositions` — the one field the
 * real measured fixture proved responsible for the 413. It does NOT touch
 * `userSuppliedReferencePositions`/`selectiveCorpusPositions`/
 * `archiveMatchedPositions` (a repo-wide consumer audit found the first two
 * have no production readers at all today, and the third lives outside
 * `UnifiedSimilarityResult` entirely).
 *
 * C2 ADDITION — `contributions` (the admin-only per-passage attribution, ~39% of
 * a fragment-heavy report) gets the same treatment as a second, independent
 * persistence-only encoding: a versioned COMPACT form (string table + numeric
 * rows) that is proven lossless before it is kept (VERIFY-THEN-COMPACT, see
 * compactContributionsForPersistence) and expanded back to the exact array at
 * the same two read boundaries. The scoring fields and every position array are
 * untouched. Legacy rows (a plain `contributions` array) stay valid forever.
 *
 * R2 WRITE GATE — the C2 `contributions` compaction is an opt-in WRITE
 * (lib/report-compact-persistence-flag.ts, default OFF): with it off,
 * `contributions` is persisted as the plain array exactly as before C2, so a
 * pre-C2 reader never meets the compact form. The older `previousUploadPositions`
 * elision is NOT gated — it shipped (and is readable by the deployed fleet)
 * before C2. The READ side always understands every form.
 */

/** The one persistence-only marker this module introduces. Distinct from `UNIFIED_SIMILARITY_VERSION` (an unrelated, unbumped scoring-algorithm version) — this is a storage-representation flag only. */
export const PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS = "matchedPositions" as const;

/** Format marker shared with the evidence-interpretation compact form (a legacy `contributions` value is an array, never an object). */
export const COMPACT_CONTRIBUTIONS_FORMAT = "compact" as const;
export const COMPACT_CONTRIBUTIONS_FORMAT_VERSION = 1 as const;

/**
 * Compact v1 `contributions`: every contribution becomes one numeric row
 * `[sourceTypeRef, sourceIdRef, submittedWordStart, submittedWordEnd,
 * matchedWordCount, evidenceStatusRef, importedSourceAttributionStateRef?,
 * relationshipRef?, effectiveScoringRelationshipRef?, effectiveScoringReasonRef?]`
 * where every `…Ref` indexes `strings`, `-1` marks an absent optional field, and
 * trailing absent optionals are omitted. Every value is kept verbatim (nothing is
 * derived), so it cannot drift if scoring code changes later.
 */
export type CompactContributions = {
  format: typeof COMPACT_CONTRIBUTIONS_FORMAT;
  formatVersion: typeof COMPACT_CONTRIBUTIONS_FORMAT_VERSION;
  strings: string[];
  rows: number[][];
};

/**
 * The on-disk (payload_json) shape: identical to `UnifiedSimilarityResult`
 * except (1) `previousUploadPositions` may be OMITTED when
 * `previousUploadPositionsEncoding === "matchedPositions"` — in which case a
 * reader must reconstruct it as an exact copy of `matchedPositions`, and
 * (2) `contributions` may be the COMPACT form above instead of the array. Every
 * other field is always present, unchanged, exactly as computeUnifiedSimilarity
 * produces it. A row written before either encoding existed has no
 * `previousUploadPositionsEncoding` key, its `previousUploadPositions` array in
 * full, and a plain `contributions` array — every shape is valid, permanently,
 * with no migration ever required.
 */
export type PersistedUnifiedSimilarity = Omit<UnifiedSimilarityResult, "previousUploadPositions" | "contributions"> & {
  previousUploadPositions?: number[];
  previousUploadPositionsEncoding?: typeof PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS;
  contributions: UnifiedEvidenceContribution[] | CompactContributions;
};

function isCompactContributions(value: unknown): value is CompactContributions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { format?: unknown }).format === COMPACT_CONTRIBUTIONS_FORMAT
  );
}

const ABSENT_REF = -1;
/** Optional contribution fields, in row order (slot 6..9). */
const OPTIONAL_CONTRIBUTION_FIELDS = [
  "importedSourceAttributionState",
  "relationship",
  "effectiveScoringRelationship",
  "effectiveScoringReason",
] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Builds the compact form, or null when some contribution is not exactly representable. Does NOT verify. */
function buildCompactContributions(contributions: readonly UnifiedEvidenceContribution[]): CompactContributions | null {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (value: unknown): number | null => {
    if (typeof value !== "string") return null;
    const existing = stringIndex.get(value);
    if (existing !== undefined) return existing;
    stringIndex.set(value, strings.length);
    strings.push(value);
    return strings.length - 1;
  };

  const rows: number[][] = [];
  for (const contribution of contributions) {
    if (typeof contribution !== "object" || contribution === null) return null;
    const type = intern(contribution.sourceType);
    const id = intern(contribution.sourceId);
    const status = intern(contribution.evidenceStatus);
    if (type === null || id === null || status === null) return null;
    if (
      !isFiniteNumber(contribution.submittedWordStart) ||
      !isFiniteNumber(contribution.submittedWordEnd) ||
      !isFiniteNumber(contribution.matchedWordCount)
    ) {
      return null;
    }
    const row = [type, id, contribution.submittedWordStart, contribution.submittedWordEnd, contribution.matchedWordCount, status];
    for (const field of OPTIONAL_CONTRIBUTION_FIELDS) {
      const value = contribution[field];
      if (value === undefined) {
        row.push(ABSENT_REF);
        continue;
      }
      const ref = intern(value);
      if (ref === null) return null;
      row.push(ref);
    }
    while (row.length > 6 && row[row.length - 1] === ABSENT_REF) row.pop();
    rows.push(row);
  }
  return { format: COMPACT_CONTRIBUTIONS_FORMAT, formatVersion: COMPACT_CONTRIBUTIONS_FORMAT_VERSION, strings, rows };
}

type ContributionsExpansion =
  | { status: "expanded"; value: UnifiedEvidenceContribution[] }
  | { status: "unreadable"; reason: string };

function expandCompactContributions(compact: CompactContributions): ContributionsExpansion {
  if (compact.formatVersion !== COMPACT_CONTRIBUTIONS_FORMAT_VERSION) return { status: "unreadable", reason: "UNSUPPORTED_FORMAT_VERSION" };
  if (!Array.isArray(compact.strings) || !Array.isArray(compact.rows)) return { status: "unreadable", reason: "MALFORMED" };
  const { strings, rows } = compact;
  const ref = (value: unknown): string | undefined | null => {
    if (value === ABSENT_REF || value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= strings.length) return null;
    const text = strings[value];
    return typeof text === "string" ? text : null;
  };

  const value: UnifiedEvidenceContribution[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) return { status: "unreadable", reason: "MALFORMED_ROW" };
    const sourceType = ref(row[0]);
    const sourceId = ref(row[1]);
    const evidenceStatus = ref(row[5]);
    if (sourceType == null || sourceId == null || evidenceStatus == null) return { status: "unreadable", reason: "BAD_REF" };
    if (!isFiniteNumber(row[2]) || !isFiniteNumber(row[3]) || !isFiniteNumber(row[4])) return { status: "unreadable", reason: "BAD_NUMBER" };
    const optional = OPTIONAL_CONTRIBUTION_FIELDS.map((_, slot) => ref(row[6 + slot]));
    if (optional.some((entry) => entry === null)) return { status: "unreadable", reason: "BAD_REF" };
    const [importedSourceAttributionState, relationship, effectiveScoringRelationship, effectiveScoringReason] = optional;
    // Same key order computeUnifiedSimilarity emits (JSON order is not semantic, but a stable order keeps diffs readable).
    value.push({
      sourceType,
      sourceId,
      submittedWordStart: row[2],
      submittedWordEnd: row[3],
      matchedWordCount: row[4],
      ...(relationship !== undefined ? { relationship } : {}),
      ...(effectiveScoringRelationship !== undefined ? { effectiveScoringRelationship } : {}),
      ...(effectiveScoringReason !== undefined ? { effectiveScoringReason } : {}),
      evidenceStatus,
      ...(importedSourceAttributionState !== undefined ? { importedSourceAttributionState } : {}),
    } as UnifiedEvidenceContribution);
  }
  return { status: "expanded", value };
}

/**
 * Returns the compact v1 form ONLY when it provably reconstructs
 * `contributions` exactly (VERIFY-THEN-COMPACT); otherwise — including for an
 * empty array, an unexpected extra field, or a non-finite number — returns the
 * array unchanged. Never mutates, never throws, never drops a contribution.
 */
function compactContributionsForPersistence(
  contributions: UnifiedEvidenceContribution[],
): UnifiedEvidenceContribution[] | CompactContributions {
  if (!Array.isArray(contributions) || contributions.length === 0) return contributions;
  try {
    const compact = buildCompactContributions(contributions);
    if (!compact) return contributions;
    const roundTrip = expandCompactContributions(compact);
    if (roundTrip.status !== "expanded" || !jsonValuesEqual(roundTrip.value, contributions)) return contributions;
    return compact;
  } catch {
    return contributions;
  }
}

function isOrderedIdentical(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The real marginal JSON bytes either representation adds — the same `JSON.stringify` semantics production's own MAX_REPORT_SAVE_REQUEST_BYTES checks use (plain ASCII digits/brackets/marker text here, so `.length` already equals UTF-8 byte length exactly). */
function representationBytes(fieldName: string, value: unknown): number {
  return JSON.stringify({ [fieldName]: value }).length;
}

/**
 * Returns a COPY of `result` — never mutates the input — with
 * `previousUploadPositions` elided and replaced by the persistence marker,
 * but ONLY when ALL of the following hold (section 2's exact eligibility
 * contract):
 *   - matchedPositions is a real array
 *   - previousUploadPositions is a real array
 *   - both have identical length
 *   - every position is identical at every index (ordered comparison — both
 *     are already sorted ascending by computeUnifiedSimilarity, so this is
 *     the correct equality test, not mere set equality)
 *   - the compact representation is ACTUALLY smaller than the expanded one
 *     (for a small/empty array, the marker string itself costs more bytes
 *     than the array it would replace — compaction is skipped in that case,
 *     so an empty-array report is persisted exactly as before)
 * Whenever any condition fails, the expanded `previousUploadPositions` is
 * persisted completely unchanged (still a copy, never the original
 * reference) — this function never silently drops real data.
 *
 * INDEPENDENTLY, a non-empty `contributions` array is replaced by its compact v1
 * form when (and only when) compact writes are enabled (R2 write gate, default
 * OFF) AND that form is proven to reconstruct it exactly — see
 * compactContributionsForPersistence. The two encodings do not interact.
 */
export function compactUnifiedSimilarityForPersistence(
  result: UnifiedSimilarityResult,
  options?: CompactPersistenceWriteOptions,
): PersistedUnifiedSimilarity {
  const { matchedPositions, previousUploadPositions, ...restWithContributions } = result;
  // Overriding (never removing/re-adding) the key keeps `contributions` at its original position in the object.
  const rest =
    resolveCompactPersistenceWrites(options) && Array.isArray(restWithContributions.contributions)
      ? { ...restWithContributions, contributions: compactContributionsForPersistence(restWithContributions.contributions) }
      : restWithContributions;
  const eligible =
    Array.isArray(matchedPositions) &&
    Array.isArray(previousUploadPositions) &&
    isOrderedIdentical(matchedPositions, previousUploadPositions) &&
    representationBytes("previousUploadPositionsEncoding", PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS) <
      representationBytes("previousUploadPositions", previousUploadPositions);

  if (eligible) {
    return {
      ...rest,
      matchedPositions,
      previousUploadPositionsEncoding: PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
    };
  }
  return {
    ...rest,
    matchedPositions,
    ...(previousUploadPositions !== undefined ? { previousUploadPositions } : {}),
  };
}

/** Result of expanding a persisted `unifiedSimilarity` — see tryExpandUnifiedSimilarityFromPersistence. */
export type UnifiedSimilarityExpansion =
  | { status: "expanded"; value: UnifiedSimilarityResult }
  | { status: "contributions-unreadable"; value: UnifiedSimilarityResult; reason: string };

/**
 * Returns a COPY of `persisted` — never mutates the input — with the
 * legacy, fully-expanded shape every existing downstream consumer already
 * expects: `previousUploadPositions` present as a real array, and the
 * persistence-only `previousUploadPositionsEncoding` marker always removed
 * (a customer-facing response must never expose it).
 *
 * FAIL CLOSED, exactly per section 4: if the marker is present but
 * `matchedPositions` is not a valid array (malformed/corrupt persisted
 * data), `previousUploadPositions` is reconstructed as `[]` — the same
 * absence-compatible convention every existing accessor in this codebase
 * already uses (`report.unifiedSimilarity?.previousUploadPositions ?? []`)
 * — never an invented/guessed array. A row with NO marker at all (every
 * pre-existing report, permanently) is returned with its own
 * `previousUploadPositions` untouched if present, or `[]` if genuinely
 * absent — identical to today's existing behavior, a true no-op for the
 * "old expanded report" case.
 *
 * `contributions`: a COMPACT value is expanded to the exact array; a plain array
 * or an absent value is left exactly as it was. The compact marker object never
 * survives into the result. A compact value that is unknown or corrupt — or any
 * other non-array shape — is reported as `contributions-unreadable` (R2: this is
 * admin/internal diagnostic data, so the CALLER decides whether serving without
 * it is safe, see tryDecodeReportFromPersistence); the returned `value` then
 * carries the absence-compatible `[]` and is never a guessed array.
 */
export function tryExpandUnifiedSimilarityFromPersistence(persisted: PersistedUnifiedSimilarity): UnifiedSimilarityExpansion {
  const { previousUploadPositionsEncoding, previousUploadPositions, ...restWithContributions } = persisted;
  let contributionsFailure: string | null = null;
  let rest: typeof restWithContributions = restWithContributions;
  const contributions = restWithContributions.contributions as unknown;
  if (isCompactContributions(contributions)) {
    const expansion = expandCompactContributions(contributions);
    if (expansion.status === "expanded") {
      rest = { ...restWithContributions, contributions: expansion.value };
    } else {
      contributionsFailure = expansion.reason;
      rest = { ...restWithContributions, contributions: [] };
    }
  } else if (contributions !== undefined && contributions !== null && !Array.isArray(contributions)) {
    // Neither the legacy array nor compact v1: a future compact family (a `format` marker we do not know) or plain garbage.
    contributionsFailure =
      typeof contributions === "object" && (contributions as { format?: unknown }).format !== undefined ? "UNSUPPORTED_FORMAT" : "MALFORMED";
    rest = { ...restWithContributions, contributions: [] };
  }
  const value = (() => {
    if (previousUploadPositionsEncoding === PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS) {
      const matchedPositions = Array.isArray(rest.matchedPositions) ? rest.matchedPositions : [];
      return { ...rest, matchedPositions, previousUploadPositions: [...matchedPositions] } as UnifiedSimilarityResult;
    }
    return {
      ...rest,
      previousUploadPositions: Array.isArray(previousUploadPositions) ? previousUploadPositions : [],
    } as UnifiedSimilarityResult;
  })();
  return contributionsFailure === null
    ? { status: "expanded", value }
    : { status: "contributions-unreadable", value, reason: contributionsFailure };
}

/**
 * LENIENT expansion (the pre-R2 contract, kept for pure codec use and tests):
 * unreadable `contributions` become `[]` and the failure is logged (reason only,
 * no report data). Production READ boundaries must NOT use this — they go through
 * tryDecodeReportFromPersistence (lib/report-persistence.ts), which decides
 * whether serving without the diagnostics is safe for the viewer.
 */
export function expandUnifiedSimilarityFromPersistence(persisted: PersistedUnifiedSimilarity): UnifiedSimilarityResult {
  const expansion = tryExpandUnifiedSimilarityFromPersistence(persisted);
  if (expansion.status === "contributions-unreadable") {
    console.error(`persisted unifiedSimilarity.contributions is unreadable (${expansion.reason}); serving none`);
  }
  return expansion.value;
}
