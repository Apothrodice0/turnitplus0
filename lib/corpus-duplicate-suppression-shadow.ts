import type { Client } from "@libsql/client";
import { canonicalSha256 } from "./document-identity";
import { summarizeSubmissionProvenance } from "./submission-provenance";
import {
  classifyDocumentLocalCorpusDuplicate,
  CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION,
  type CorpusDuplicateCandidateClassification,
} from "./corpus-duplicate-suppression-policy";
import {
  computeCorpusDuplicateCounterfactual,
  CorpusDuplicateCounterfactualInvariantError,
  CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION,
  type CorpusDuplicateCounterfactualResult,
} from "./corpus-duplicate-counterfactual";
import { UNIFIED_SIMILARITY_VERSION, type UnifiedSimilarityResult } from "./unified-similarity";
import type { ExternalAcademicEvidence } from "./academic-search/types";
import type { HistoricalSubmissionMatchEntry, ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * Phase B2a — PRODUCTION SHADOW MEASUREMENT of the B1 corpus-duplicate
 * counterfactual.
 *
 * For a real report finalization / view this module independently measures
 * "what would the unified similarity percentage be if one qualifying TurnitPlus
 * internal exact-canonical whole-document duplicate did not inflate it", and
 * records ONLY bounded telemetry to
 * corpus_duplicate_suppression_shadow_evaluations (drizzle/0044). It NEVER:
 *   - changes what a caller sees — it runs AFTER the authoritative result is
 *     already resolved and on its way to the response, via
 *     lib/run-after-response.ts's runAfterResponse (through
 *     lib/report-shadow-evaluations.ts), exactly like the E8P and
 *     device-provenance shadows;
 *   - re-runs the historical matcher — it consumes production's already-computed
 *     ReportHistoricalSubmissionMatch and UnifiedSimilarityResult verbatim (it
 *     does NOT import matchAgainstUserSubmissionCorpus or
 *     getOrComputeHistoricalMatchSnapshot);
 *   - calls computeUnifiedSimilarity directly, or names its shadow-only
 *     hypothetical-exclusion parameter — the ONLY hypothetical computation goes
 *     through the committed B1 helper computeCorpusDuplicateCounterfactual
 *     (which owns that parameter). The B1 containment tripwire
 *     (tests/corpus-duplicate-suppression-containment.test.mjs) stays unchanged
 *     and green precisely because this module never mentions that token;
 *   - writes any scoring field, saved_reports column, report payload, or
 *     report_historical_match_snapshots row;
 *   - persists an account/user id, email, device-passport id, HMAC, source_ref,
 *     canonical hash, document_identity_id, representation id, admission-decision
 *     id, promotion id, owner-link id, action ref, document/passage text, or any
 *     generic JSON blob.
 *
 * Reuses, never modifies: the pure B1 candidate policy
 * (classifyDocumentLocalCorpusDuplicate), the pure B1 counterfactual
 * (computeCorpusDuplicateCounterfactual), and the bounded backing-evidence
 * summary (lib/submission-provenance.ts's summarizeSubmissionProvenance — the
 * same one the device-provenance shadow and the admin decision trace already
 * use, which resolves account/passport/source_ref ownership to booleans INSIDE
 * SQL).
 *
 * DELETION SAFETY: the drizzle/0044 AFTER DELETE trigger removes every shadow
 * row for a report inside the same statement that deletes its saved_reports row.
 * This module additionally EXISTS-guards its own INSERT on saved_reports (see
 * upsertRow) so a deferred evaluation scheduled before deletion cannot recreate
 * a row afterward. There is NO route-side B2 cleanup wiring — the trigger covers
 * every deletion path.
 */

/** The B2 shadow evaluator's own version — the UPSERT conflict key alongside (report_device_key, report_id). Bump to force a full re-evaluation of every row. */
export const CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION = "document-local-corpus-duplicate-shadow-v1" as const;

/**
 * Defensive cap on how many distinct matched representations the shadow
 * evaluator will classify (and, for the ones that pass the cheap pre-filter,
 * run one bounded provenance query for) in a single evaluation. The matcher
 * already bounds matches[] (USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidates = 10);
 * this is a belt-and-braces ceiling so a pathological result can never fan out
 * into an unbounded query loop. Exceeding it yields status 'BOUNDED' +
 * evaluation_truncated = 1 — never a silent truncation reported as 'OK'.
 */
export const MAX_SHADOW_CANDIDATE_REPRESENTATIONS = 10;

/** FAILED rows are retryable, but not on every single view — a short cooldown avoids hammering a transiently-failing computation. Frozen in code, no env var. */
const FAILED_RETRY_COOLDOWN_SQL = "-15 minutes";

/** Inclusive cap for the distinct-checker-account probe: '> CAP-1' collapses to the '6+' bucket, so the subquery never scans past CAP distinct accounts. */
const CHECKER_ACCOUNT_BUCKET_CAP = 6;

type ShadowStatus = "OK" | "BOUNDED" | "FAILED" | "SKIPPED_NOT_MATCHED" | "SKIPPED_NO_AUTHORITATIVE";
type ShadowErrorCode = "PROVENANCE_QUERY_FAILED" | "COUNTERFACTUAL_INVARIANT" | "UNEXPECTED";
type CheckerAccountsStatus = "NOT_APPLICABLE" | "OK" | "FAILED";
type CheckerAccountsBucket = "0" | "1" | "2" | "3-5" | "6+";

/** A caught throw from lib/submission-provenance.ts's summarizeSubmissionProvenance during candidate classification — mapped to error_code PROVENANCE_QUERY_FAILED. */
class ProvenanceQueryError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ProvenanceQueryError";
  }
}

export type RunCorpusDuplicateSuppressionShadowEvaluationParams = {
  reportDeviceKey: string;
  reportId: string;
  /** The report's own account (its immutable upload account for a report read). null for an anonymous report. Used transiently for provenance / checker-account queries — NEVER persisted; only its null-ness is recorded (ANONYMOUS). */
  accountId: string | null;
  /** The report's own submitted text — used transiently for canonicalSha256() fed to summarizeSubmissionProvenance. NEVER persisted, and the hash is never persisted. */
  rawText: string;
  /** Production's already-computed historical-match snapshot — read verbatim, never re-derived. Carries .computedAt (the snapshot freshness key) and .matches. */
  productionResult: ReportHistoricalSubmissionMatch;
  /** Production's already-computed authoritative UnifiedSimilarityResult (resolution.unifiedSimilarity). null when computeUnifiedSimilarity itself threw for this report — then status SKIPPED_NO_AUTHORITATIVE. */
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult | null;
  /** resolution.effectiveDeviceSelfRepresentationIds — passed through to the counterfactual unchanged so the hypothetical differs from authoritative by ONLY the document-local exclusion; also used to mark same_passport_category / ALREADY_EFFECTIVE_DEVICE_SELF. */
  effectiveDeviceSelfRepresentationIds: readonly string[];
  /** resolution.corpusGeneration — the freshness key alongside the snapshot computedAt. */
  authoritativeCorpusGeneration: number;
  /**
   * The EXACT archiveMatchedPositions the caller passed into
   * resolvePrimarySimilaritySummary to produce authoritativeUnifiedSimilarity —
   * captured request-locally and threaded straight through, NEVER re-read from
   * payload_json (which a concurrent resave / self-heal could theoretically
   * drift). This is the authoritative-scoring-input parity guarantee: the
   * hypothetical computeUnifiedSimilarity call inside
   * computeCorpusDuplicateCounterfactual is fed exactly the archive input the
   * authoritative run used, so the two differ by ONLY the document-local
   * exclusion. NEVER persisted.
   */
  archiveMatchedPositions: number[] | null;
  /** The EXACT externalAcademicEvidence the caller passed into resolvePrimarySimilaritySummary — same request-local parity guarantee as archiveMatchedPositions above. NEVER persisted. */
  externalAcademicEvidence: ExternalAcademicEvidence[] | null;
};

function truncatedRuntime(startedAt: number): number {
  return Date.now() - startedAt;
}

function safeCanonicalSha256(text: string): string {
  try {
    return canonicalSha256(text ?? "");
  } catch {
    return canonicalSha256("");
  }
}

/** Dedup by matchedRepresentationId, preserving production's priority order (matches[0] is the headline) — exactly as computeUnifiedSimilarity / device-provenance-shadow do. */
function distinctByRepresentation(matches: readonly HistoricalSubmissionMatchEntry[]): HistoricalSubmissionMatchEntry[] {
  const seen = new Set<string>();
  const out: HistoricalSubmissionMatchEntry[] = [];
  for (const match of matches) {
    if (seen.has(match.matchedRepresentationId)) continue;
    seen.add(match.matchedRepresentationId);
    out.push(match);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence — every write is EXISTS-guarded on saved_reports
// ---------------------------------------------------------------------------

/**
 * The full ordered column list for corpus_duplicate_suppression_shadow_evaluations,
 * minus id / created_at (autoincrement / DEFAULT). Built once so the INSERT
 * column list, the SELECT placeholder list, and the ON CONFLICT DO UPDATE SET
 * clause can never drift apart.
 *
 * PRIVACY CONTRACT: every name here is a bounded count / enum / boolean / version
 * string / timestamp / routing handle. No prohibited identifier appears — see
 * the structural test.
 */
const SHADOW_COLUMNS = [
  "report_device_key",
  "report_id",
  "status",
  "error_code",
  "error_detail",
  "checker_accounts_status",
  "distinct_checker_accounts_bucket",
  "policy_version",
  "rule_version",
  "unified_similarity_version",
  "counterfactual_version",
  "authoritative_corpus_generation",
  "authoritative_snapshot_computed_at",
  "submitted_word_count",
  "authoritative_score",
  "hypothetical_score",
  "score_delta",
  "authoritative_unique_matched_words",
  "hypothetical_unique_matched_words",
  "unique_matched_words_removed",
  "candidate_matched_words",
  "candidates_excluded",
  "archive_only_words_surviving",
  "live_academic_only_words_surviving",
  "previous_upload_only_words_surviving",
  "overlap_words_surviving",
  "candidate_count",
  "measurement_category",
  "origin_confidence",
  "multi_origin_evidence",
  "candidate_admitted_promotion_backing_count",
  "candidate_submission_reference_backing_count",
  "candidate_independent_backing_count",
  "candidate_same_device_backing_count",
  "same_passport_category",
  "cross_account_category",
  "evaluation_truncated",
  "total_runtime_ms",
  "computed_at",
] as const;

type ShadowColumn = (typeof SHADOW_COLUMNS)[number];
type ShadowRowValues = Record<ShadowColumn, string | number | null>;

/** Columns the UPSERT never rewrites on conflict — the identity + the conflict key + the immutable created_at (not in the list) + report_device_key/report_id. */
const NO_UPDATE_ON_CONFLICT = new Set<ShadowColumn>(["report_device_key", "report_id", "policy_version"]);

/**
 * INSERT ... SELECT ... WHERE EXISTS (saved_reports) ... ON CONFLICT DO UPDATE.
 * The EXISTS guard means a deferred evaluation whose report was deleted in the
 * meantime writes NOTHING (SELECT produces no row, so neither the INSERT nor the
 * ON CONFLICT branch runs) — proven in
 * tests/corpus-duplicate-suppression-shadow-deletion.test.mjs. Returns
 * rowsAffected so callers/tests can assert the no-op.
 */
async function upsertRow(client: Client, values: ShadowRowValues): Promise<{ rowsAffected: number }> {
  const insertCols = SHADOW_COLUMNS.join(", ");
  const selectPlaceholders = SHADOW_COLUMNS.map(() => "?").join(", ");
  const updateSet = SHADOW_COLUMNS.filter((c) => !NO_UPDATE_ON_CONFLICT.has(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const result = await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations (${insertCols})
          SELECT ${selectPlaceholders}
          WHERE EXISTS (SELECT 1 FROM saved_reports WHERE device_key = ? AND id = ?)
          ON CONFLICT(report_device_key, report_id, policy_version) DO UPDATE SET
            ${updateSet}`,
    args: [
      ...SHADOW_COLUMNS.map((c) => values[c]),
      values.report_device_key,
      values.report_id,
    ],
  });
  return { rowsAffected: Number(result.rowsAffected) };
}

/** Every column that is NULL unless a real counterfactual measurement was computed (status OK / BOUNDED). */
const NULL_MEASUREMENT_DEFAULTS: Partial<ShadowRowValues> = {
  authoritative_score: null,
  hypothetical_score: null,
  score_delta: null,
  authoritative_unique_matched_words: null,
  hypothetical_unique_matched_words: null,
  unique_matched_words_removed: null,
  candidate_matched_words: null,
  candidates_excluded: null,
  archive_only_words_surviving: null,
  live_academic_only_words_surviving: null,
  previous_upload_only_words_surviving: null,
  overlap_words_surviving: null,
  candidate_admitted_promotion_backing_count: null,
  candidate_submission_reference_backing_count: null,
  candidate_independent_backing_count: null,
  candidate_same_device_backing_count: null,
  same_passport_category: null,
  cross_account_category: null,
};

function baseValues(
  params: RunCorpusDuplicateSuppressionShadowEvaluationParams,
): ShadowRowValues {
  return {
    report_device_key: params.reportDeviceKey,
    report_id: params.reportId,
    status: "FAILED",
    error_code: null,
    error_detail: null,
    checker_accounts_status: "NOT_APPLICABLE",
    distinct_checker_accounts_bucket: null,
    policy_version: CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION,
    rule_version: CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION,
    unified_similarity_version: UNIFIED_SIMILARITY_VERSION,
    counterfactual_version: CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION,
    authoritative_corpus_generation: null,
    authoritative_snapshot_computed_at: null,
    submitted_word_count: null,
    ...NULL_MEASUREMENT_DEFAULTS,
    candidate_count: null,
    measurement_category: null,
    origin_confidence: null,
    multi_origin_evidence: null,
    evaluation_truncated: 0,
    total_runtime_ms: null,
    computed_at: null, // set at write time below
  } as ShadowRowValues;
}

// ---------------------------------------------------------------------------
// Freshness / reuse
// ---------------------------------------------------------------------------

type ExistingShadowRow = {
  status: string;
  checker_accounts_status: string | null;
  rule_version: string | null;
  unified_similarity_version: string | null;
  counterfactual_version: string | null;
  authoritative_corpus_generation: number | bigint | null;
  authoritative_snapshot_computed_at: string | null;
  failed_cooldown_elapsed: number | bigint | null;
};

async function loadExistingRow(
  client: Client,
  reportDeviceKey: string,
  reportId: string,
): Promise<ExistingShadowRow | null> {
  const result = await client.execute({
    sql: `SELECT status, checker_accounts_status, rule_version, unified_similarity_version, counterfactual_version,
                 authoritative_corpus_generation, authoritative_snapshot_computed_at,
                 (computed_at < datetime('now', ?)) AS failed_cooldown_elapsed
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE report_device_key = ? AND report_id = ? AND policy_version = ?`,
    args: [FAILED_RETRY_COOLDOWN_SQL, reportDeviceKey, reportId, CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION],
  });
  return (result.rows[0] as unknown as ExistingShadowRow | undefined) ?? null;
}

/**
 * True => the existing row is still trustworthy, skip recomputation. See the
 * reviewed freshness matrix:
 *   - any version tag changed        -> recompute
 *   - FAILED, cooldown not elapsed   -> reuse (skip); elapsed -> recompute
 *   - SKIPPED_NO_AUTHORITATIVE       -> reuse only while authoritative is still unavailable
 *   - OK / BOUNDED / SKIPPED_NOT_MATCHED -> reuse only while corpus generation AND
 *       snapshot computedAt are both unchanged (a Phase-A maturity crossing
 *       advances computedAt at equal generation and MUST stale the row)
 *   - OK / BOUNDED whose checker-account side signal FAILED -> also recompute
 *       once its own 15-minute cooldown has elapsed, even when the core
 *       freshness keys are unchanged (the checker probe is independently
 *       best-effort; a full recompute is acceptable and leaves the core
 *       score / counterfactual identical because its inputs are unchanged)
 */
function shouldReuseExistingRow(
  row: ExistingShadowRow,
  params: RunCorpusDuplicateSuppressionShadowEvaluationParams,
): boolean {
  if (
    row.rule_version !== CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION ||
    row.unified_similarity_version !== UNIFIED_SIMILARITY_VERSION ||
    row.counterfactual_version !== CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION
  ) {
    return false;
  }
  if (row.status === "FAILED") {
    return Number(row.failed_cooldown_elapsed) !== 1;
  }
  if (row.status === "SKIPPED_NO_AUTHORITATIVE") {
    return params.authoritativeUnifiedSimilarity === null;
  }
  if (row.status === "OK" || row.status === "BOUNDED" || row.status === "SKIPPED_NOT_MATCHED") {
    const coreFresh =
      row.authoritative_corpus_generation !== null &&
      Number(row.authoritative_corpus_generation) === params.authoritativeCorpusGeneration &&
      row.authoritative_snapshot_computed_at === params.productionResult.computedAt;
    if (!coreFresh) return false;
    // Core is fresh — but retry a checker-only failure once its cooldown elapses.
    // (SKIPPED_NOT_MATCHED never runs the checker probe, so its status stays
    // NOT_APPLICABLE and this never fires for it.)
    if (
      (row.status === "OK" || row.status === "BOUNDED") &&
      row.checker_accounts_status === "FAILED" &&
      Number(row.failed_cooldown_elapsed) === 1
    ) {
      return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Candidate classification (the only DB-touching phase besides the checker probe)
// ---------------------------------------------------------------------------

type PerMatchClassification = {
  match: HistoricalSubmissionMatchEntry;
  classification: CorpusDuplicateCandidateClassification;
  /** Only present when the cheap pre-filter passed and a provenance query ran. */
  backing: {
    admittedPromotionBackingCount: number;
    submissionReferenceBackingCount: number;
    independentBackingCount: number;
    sameDeviceBackingCount: number;
  } | null;
};

/** Higher rank = more informative to surface as the row's "strongest candidate". */
function classificationRank(entry: PerMatchClassification): number {
  const c = entry.classification.category;
  if (c === "CROSS_ACCOUNT_EXACT_CANONICAL") return 5;
  if (c === "BACKING_SHAPE_UNSUPPORTED") return 4; // exact-canonical corpus source, provenance ran, shape wrong
  if (c === "ALREADY_EFFECTIVE_DEVICE_SELF") return 3;
  if (c === "NOT_EXACT_CANONICAL") return 2; // a TURNITPLUS_CORPUS_SOURCE STRONG_TEXT_MATCH
  if (c === "NOT_CORPUS_SOURCE") return 1;
  return 0;
}

type ClassifyResult = {
  qualifyingRepresentationIds: string[];
  strongest: PerMatchClassification | null;
  truncated: boolean;
  samePassportSeen: boolean;
};

async function classifyCandidates(
  client: Client,
  params: RunCorpusDuplicateSuppressionShadowEvaluationParams,
  reportRow: { verified_device_passport_id: string | null; document_identity_id: string | null },
): Promise<ClassifyResult> {
  const effSet = new Set(params.effectiveDeviceSelfRepresentationIds);
  const reportCanonicalSha256 = safeCanonicalSha256(params.rawText);
  const distinct = distinctByRepresentation(params.productionResult.matches ?? []);
  const truncated = distinct.length > MAX_SHADOW_CANDIDATE_REPRESENTATIONS;
  const toEvaluate = distinct.slice(0, MAX_SHADOW_CANDIDATE_REPRESENTATIONS);

  const qualifyingRepresentationIds: string[] = [];
  let strongest: PerMatchClassification | null = null;
  let samePassportSeen = false;

  for (const match of toEvaluate) {
    if (effSet.has(match.matchedRepresentationId)) samePassportSeen = true;

    // Cheap pre-filter: a provenance query is only worth running for a
    // production-counted TURNITPLUS_CORPUS_SOURCE + EXACT_CANONICAL_MATCH that
    // scoring does not already treat as an effective same-Passport SELF.
    const preQualifies =
      match.relationshipType === "TURNITPLUS_CORPUS_SOURCE" &&
      match.matchType === "EXACT_CANONICAL_MATCH" &&
      !effSet.has(match.matchedRepresentationId);

    let backing: PerMatchClassification["backing"] = null;
    let classification: CorpusDuplicateCandidateClassification;

    if (preQualifies) {
      let provenance;
      try {
        provenance = await summarizeSubmissionProvenance(client, match.matchedRepresentationId, {
          accountId: params.accountId,
          excludeDocumentIdentityId: reportRow.document_identity_id,
          reportVerifiedDevicePassportId: reportRow.verified_device_passport_id,
          reportCanonicalSha256,
          reportDocumentIdentityId: reportRow.document_identity_id,
        });
      } catch (err) {
        throw new ProvenanceQueryError(err);
      }
      backing = {
        admittedPromotionBackingCount: provenance.admittedPromotionBackingCount,
        submissionReferenceBackingCount: provenance.submissionReferenceBackingCount,
        independentBackingCount: provenance.independentBackingCount,
        sameDeviceBackingCount: provenance.sameDeviceBackingCount,
      };
      classification = classifyDocumentLocalCorpusDuplicate({
        historicalStatus: "MATCHED",
        relationshipType: match.relationshipType,
        matchType: match.matchType,
        reportIsAuthenticated: params.accountId !== null,
        isAlreadyEffectiveDeviceSelf: false,
        backing: {
          admittedPromotionBackingCount: backing.admittedPromotionBackingCount,
          submissionReferenceBackingCount: backing.submissionReferenceBackingCount,
        },
      });
      if (classification.isCandidate) qualifyingRepresentationIds.push(match.matchedRepresentationId);
    } else {
      // No DB call — this match cannot be a candidate, but classify it anyway so
      // the strongest-match summary can explain why (NOT_EXACT_CANONICAL etc.).
      classification = classifyDocumentLocalCorpusDuplicate({
        historicalStatus: "MATCHED",
        relationshipType: match.relationshipType,
        matchType: match.matchType,
        reportIsAuthenticated: params.accountId !== null,
        isAlreadyEffectiveDeviceSelf: effSet.has(match.matchedRepresentationId),
        backing: { admittedPromotionBackingCount: 0, submissionReferenceBackingCount: 0 },
      });
    }

    const entry: PerMatchClassification = { match, classification, backing };
    if (!strongest || classificationRank(entry) > classificationRank(strongest)) strongest = entry;
  }

  return { qualifyingRepresentationIds, strongest, truncated, samePassportSeen };
}

// ---------------------------------------------------------------------------
// Checker-account side signal — INDEPENDENTLY best-effort
// ---------------------------------------------------------------------------

/**
 * Distinct accounts that ran a similarity check on this exact canonical text
 * (NOT authors, NOT owners, NOT independent corpus origins) — resolved to a
 * bounded bucket, never a raw count, never account ids. Indexed SEARCH on
 * document_identities.canonical_sha256 (verified via EXPLAIN QUERY PLAN); the
 * inner LIMIT caps the DISTINCT scan at CHECKER_ACCOUNT_BUCKET_CAP.
 */
async function checkerAccountBucket(
  client: Client,
  reportCanonicalSha256: string,
  accountId: string,
): Promise<CheckerAccountsBucket> {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT DISTINCT account_id
            FROM document_identities
            WHERE canonical_sha256 = ?
              AND account_id IS NOT NULL
              AND account_id <> ?
            LIMIT ?
          ) t`,
    args: [reportCanonicalSha256, accountId, CHECKER_ACCOUNT_BUCKET_CAP],
  });
  const n = Number((result.rows[0] as unknown as { n: number | bigint }).n);
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n === 2) return "2";
  if (n < CHECKER_ACCOUNT_BUCKET_CAP) return "3-5";
  return "6+";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * SHADOW ONLY. Best-effort, bounded, non-blocking, idempotent-upserted, never
 * throws — a telemetry failure must never fail report saving or a report read.
 * Writes NOTHING when production could not produce a comparable result
 * (status === "UNAVAILABLE"), and reuses an existing row when its authoritative
 * source state is unchanged (see the freshness matrix).
 */
export async function runCorpusDuplicateSuppressionShadowEvaluation(
  client: Client,
  params: RunCorpusDuplicateSuppressionShadowEvaluationParams,
): Promise<void> {
  const startedAt = Date.now();

  // Nothing to compare against yet — matches the E8P / device-provenance shadows.
  if (params.productionResult.status === "UNAVAILABLE") return;

  try {
    const existing = await loadExistingRow(client, params.reportDeviceKey, params.reportId);
    if (existing && shouldReuseExistingRow(existing, params)) return;

    // --- SKIPPED_NO_AUTHORITATIVE -------------------------------------------
    if (params.authoritativeUnifiedSimilarity === null) {
      await writeRow(client, {
        ...baseValues(params),
        status: "SKIPPED_NO_AUTHORITATIVE",
        total_runtime_ms: truncatedRuntime(startedAt),
      });
      return;
    }

    const authoritative = params.authoritativeUnifiedSimilarity;

    // --- SKIPPED_NOT_MATCHED (a real, dated NO_HISTORICAL_MATCH snapshot) ---
    if (params.productionResult.status !== "MATCHED") {
      await writeRow(client, {
        ...baseValues(params),
        status: "SKIPPED_NOT_MATCHED",
        authoritative_corpus_generation: params.authoritativeCorpusGeneration,
        authoritative_snapshot_computed_at: params.productionResult.computedAt,
        submitted_word_count: authoritative.wordCount,
        candidate_count: 0,
        measurement_category: "NOT_MATCHED",
        origin_confidence: "NOT_EVALUATED",
        multi_origin_evidence: "N/A",
        total_runtime_ms: truncatedRuntime(startedAt),
      });
      return;
    }

    // --- MATCHED: the core evaluation --------------------------------------
    // Only the transient provenance-routing fields — NOT payload_json. The
    // archive / live-academic scoring inputs come from params (captured
    // request-locally by the caller from the SAME request that produced
    // authoritativeUnifiedSimilarity), never re-read here, so a concurrent
    // resave / self-heal between scheduling and now cannot drift the
    // hypothetical away from the authoritative scoring inputs.
    const reportRowResult = await client.execute({
      sql: `SELECT verified_device_passport_id, document_identity_id
            FROM saved_reports WHERE device_key = ? AND id = ?`,
      args: [params.reportDeviceKey, params.reportId],
    });
    const reportRow = reportRowResult.rows[0] as unknown as
      | { verified_device_passport_id: string | null; document_identity_id: string | null }
      | undefined;
    // Report deleted between scheduling and now — write nothing (the guarded
    // UPSERT would no-op anyway; returning here also skips the work).
    if (!reportRow) return;

    const archiveMatchedPositions = params.archiveMatchedPositions;
    const externalAcademicEvidence = params.externalAcademicEvidence;

    let classifyResult: ClassifyResult;
    try {
      classifyResult = await classifyCandidates(client, params, reportRow);
    } catch (err) {
      if (err instanceof ProvenanceQueryError) {
        await writeFailed(client, params, "PROVENANCE_QUERY_FAILED", startedAt);
        return;
      }
      throw err; // -> UNEXPECTED (outer catch)
    }

    let cf: CorpusDuplicateCounterfactualResult;
    try {
      cf = computeCorpusDuplicateCounterfactual({
        wordCount: authoritative.wordCount,
        archiveMatchedPositions,
        externalAcademicEvidence,
        historicalSubmissionMatch: params.productionResult,
        effectiveDeviceSelfRepresentationIds: params.effectiveDeviceSelfRepresentationIds,
        authoritativeUnifiedSimilarity: authoritative,
        qualifyingRepresentationIds: classifyResult.qualifyingRepresentationIds,
      });
    } catch (err) {
      if (err instanceof CorpusDuplicateCounterfactualInvariantError) {
        await writeFailed(client, params, "COUNTERFACTUAL_INVARIANT", startedAt);
        return;
      }
      throw err; // -> UNEXPECTED
    }

    // Checker-account side signal — INDEPENDENT try/catch, only for an
    // authenticated actual B1 candidate. A failure here never touches the core
    // status.
    let checkerAccountsStatus: CheckerAccountsStatus = "NOT_APPLICABLE";
    let checkerBucket: CheckerAccountsBucket | null = null;
    if (params.accountId !== null && classifyResult.qualifyingRepresentationIds.length > 0) {
      try {
        checkerBucket = await checkerAccountBucket(client, safeCanonicalSha256(params.rawText), params.accountId);
        checkerAccountsStatus = "OK";
      } catch {
        checkerAccountsStatus = "FAILED";
        checkerBucket = null;
      }
    }

    const strongest = classifyResult.strongest;
    const hasCandidate = classifyResult.qualifyingRepresentationIds.length > 0;
    const status: ShadowStatus = classifyResult.truncated ? "BOUNDED" : "OK";

    await writeRow(client, {
      ...baseValues(params),
      status,
      checker_accounts_status: checkerAccountsStatus,
      distinct_checker_accounts_bucket: checkerBucket,
      authoritative_corpus_generation: params.authoritativeCorpusGeneration,
      authoritative_snapshot_computed_at: params.productionResult.computedAt,
      submitted_word_count: authoritative.wordCount,

      authoritative_score: cf.authoritativeScore,
      hypothetical_score: cf.hypotheticalScore,
      score_delta: cf.scoreDelta,
      authoritative_unique_matched_words: cf.authoritativeUniqueMatchedWords,
      hypothetical_unique_matched_words: cf.hypotheticalUniqueMatchedWords,
      unique_matched_words_removed: cf.uniqueMatchedWordsRemoved,
      candidate_matched_words: cf.candidateMatchedWords,
      candidates_excluded: cf.candidatesExcluded,
      archive_only_words_surviving: cf.archiveOnlyWordsSurviving,
      live_academic_only_words_surviving: cf.liveAcademicOnlyWordsSurviving,
      previous_upload_only_words_surviving: cf.previousUploadOnlyWordsSurviving,
      overlap_words_surviving: cf.overlapWordsSurviving,

      candidate_count: classifyResult.qualifyingRepresentationIds.length,
      measurement_category: strongest ? strongest.classification.category : "NOT_ELIGIBLE",
      origin_confidence: strongest ? strongest.classification.originConfidence : "NOT_EVALUATED",
      multi_origin_evidence: strongest ? strongest.classification.multiOriginEvidence : "N/A",

      candidate_admitted_promotion_backing_count: strongest?.backing?.admittedPromotionBackingCount ?? null,
      candidate_submission_reference_backing_count: strongest?.backing?.submissionReferenceBackingCount ?? null,
      candidate_independent_backing_count: strongest?.backing?.independentBackingCount ?? null,
      candidate_same_device_backing_count: strongest?.backing?.sameDeviceBackingCount ?? null,

      same_passport_category: classifyResult.samePassportSeen ? 1 : 0,
      cross_account_category: hasCandidate ? 1 : 0,

      evaluation_truncated: classifyResult.truncated ? 1 : 0,
      total_runtime_ms: truncatedRuntime(startedAt),
    });
  } catch (err) {
    console.error(
      `corpus-duplicate suppression shadow evaluation failed (non-fatal) for report=${params.reportId} (${truncatedRuntime(startedAt)}ms):`,
      err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    );
    try {
      await writeFailed(client, params, "UNEXPECTED", startedAt);
    } catch (writeErr) {
      // The UPSERT itself failed — the scheduler-level safety net absorbs it, no
      // row is written, and a later report view retries naturally. There is no
      // UPSERT_FAILED error_code by design.
      console.error(
        `corpus-duplicate suppression shadow evaluation: failed to persist FAILED row for report=${params.reportId}:`,
        writeErr instanceof Error ? writeErr.message.slice(0, 200) : String(writeErr).slice(0, 200),
      );
    }
  }
}

async function writeRow(client: Client, values: ShadowRowValues): Promise<void> {
  await upsertRow(client, { ...values, computed_at: sqliteNow() });
}

async function writeFailed(
  client: Client,
  params: RunCorpusDuplicateSuppressionShadowEvaluationParams,
  errorCode: ShadowErrorCode,
  startedAt: number,
): Promise<void> {
  await writeRow(client, {
    ...baseValues(params),
    status: "FAILED",
    error_code: errorCode,
    error_detail: null, // reserved; B2a never populates it (would require parsing an exception string)
    candidate_count: null,
    total_runtime_ms: truncatedRuntime(startedAt),
  });
}

/** SQLite's own CURRENT_TIMESTAMP text shape, so computed_at comparisons in loadExistingRow's cooldown check line up exactly. */
function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
