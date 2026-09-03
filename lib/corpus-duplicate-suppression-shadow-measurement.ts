import type { Client } from "@libsql/client";

/**
 * Phase B2b — ADMIN-ONLY read-time measurement summary for the Phase B2a
 * corpus-duplicate suppression shadow (lib/corpus-duplicate-suppression-shadow.ts,
 * the deferred evaluator that writes corpus_duplicate_suppression_shadow_evaluations,
 * drizzle/0044). Gives admins a compact aggregate view of what the committed B1
 * counterfactual WOULD do to the unified similarity percentage if one qualifying
 * TurnitPlus-internal exact-canonical whole-document duplicate did not inflate
 * it — so the effect can be measured against real data before any later phase
 * wires a score change.
 *
 * MEASUREMENT ONLY — this module:
 *   - reads EXCLUSIVELY from corpus_duplicate_suppression_shadow_evaluations. It
 *     issues only SELECT statements and never INSERT / UPDATE / DELETE / DDL.
 *   - imports NOTHING on the similarity-scoring / relationship-classification /
 *     counterfactual / historical-matcher path. It does not import
 *     computeUnifiedSimilarity, the B1 corpus-duplicate policy
 *     (lib/corpus-duplicate-suppression-policy.ts), the B1 counterfactual
 *     (lib/corpus-duplicate-counterfactual.ts), the historical matcher,
 *     resolvePrimarySimilaritySummary, or any mutation helper. Its only
 *     dependency is @libsql/client's Client type. The one string it needs from
 *     the evaluator — the shadow policy_version used as the SELECT filter key —
 *     is redeclared here as SHADOW_POLICY_VERSION and pinned to the evaluator's
 *     own constant by a drift-guard test
 *     (tests/corpus-duplicate-suppression-shadow-measurement.test.mjs).
 *   - performs NO authorization check of its own — every caller MUST gate on
 *     lib/auth-session.ts's getAdminSessionUser() first, exactly like
 *     lib/developer-repo.ts and lib/device-provenance-shadow-measurement.ts.
 *
 * REAL-MEASUREMENT statistics — every score, delta, average, delta-bucket, and
 * surviving-word figure — are computed ONLY over rows with
 * status IN ('OK','BOUNDED'). A FAILED / SKIPPED_NOT_MATCHED /
 * SKIPPED_NO_AUTHORITATIVE row has NULL measurement columns and MUST never land
 * in the 0-delta bucket or an average. Operational counters (status tallies,
 * checker_accounts_status, error_code) may span every row for the policy.
 * candidate_count distribution additionally admits SKIPPED_NOT_MATCHED (its
 * candidate_count is a real 0). The checker-bucket distribution is further
 * narrowed to checker_accounts_status = 'OK'.
 *
 * PRIVACY: drizzle/0044 has, by construction, NO account/user id, email,
 * device-passport id, HMAC / passport fingerprint, source_ref, canonical hash,
 * document_identity_id, representation id, admission-decision id, promotion id,
 * owner-link id, action ref, or document / passage text column — so nothing of
 * the sort can be read or returned here. Every value below is a bounded count,
 * enum, integer score / word figure, boolean, timestamp, or version string. The
 * only per-row identifiers are report_id + report_device_key — the same
 * composite routing handle lib/developer-repo.ts and
 * lib/device-provenance-shadow-measurement.ts already expose to admins for
 * report deep-dive navigation; neither is an account identity or a
 * device-passport identifier.
 */

/**
 * The Phase B2a shadow evaluator's policy_version — the SELECT filter key.
 * Redeclared here (not imported) so this measurement module pulls in nothing
 * from the evaluator / counterfactual / policy subsystem. Pinned to
 * CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION by a drift-guard test.
 */
export const SHADOW_POLICY_VERSION = "document-local-corpus-duplicate-shadow-v1" as const;

const POLICY = SHADOW_POLICY_VERSION;

export const DEFAULT_RECENT_CANDIDATE_LIMIT = 25;
export const MAX_RECENT_CANDIDATE_LIMIT = 100;

/** status IN ('OK','BOUNDED') — the SQL fragment reused by every real-measurement statistic. */
const REAL_MEASUREMENT_FILTER = "status IN ('OK','BOUNDED')";

export type CorpusDuplicateSuppressionShadowScoreDeltaBuckets = {
  /** score_delta = 0 exactly (real-measurement rows only). */
  zero: number;
  d1to9: number;
  d10to24: number;
  d25to49: number;
  d50to99: number;
  /** score_delta = 100 (score_delta is bounded 0..100 by the B1 monotonicity invariant). */
  d100: number;
};

export type CorpusDuplicateSuppressionShadowMeasurement = {
  policyVersion: string;
  generatedAt: string;

  totals: {
    /** every row for the policy. */
    evaluations: number;
    ok: number;
    bounded: number;
    failed: number;
    /** SKIPPED_NOT_MATCHED + SKIPPED_NO_AUTHORITATIVE. */
    skipped: number;
    skippedNotMatched: number;
    skippedNoAuthoritative: number;
    /** status IN ('OK','BOUNDED') — the denominator for every real-measurement statistic. */
    realMeasurementRows: number;
    /** status IN ('OK','BOUNDED') AND candidate_count > 0. */
    candidatePositive: number;
  };

  /** candidatePositive / realMeasurementRows; 0 when there are no real-measurement rows. */
  candidateFrequency: number;

  /** candidate_count buckets over status IN ('OK','BOUNDED','SKIPPED_NOT_MATCHED'). */
  candidateCountDistribution: { zero: number; one: number; twoPlus: number };

  /** status IN ('OK','BOUNDED') only. */
  measurementCategoryDistribution: Record<string, number>;
  originConfidenceDistribution: Record<string, number>;
  multiOriginEvidenceDistribution: Record<string, number>;

  /** status IN ('OK','BOUNDED') only — FAILED / SKIPPED rows (NULL score_delta) never appear. */
  scoreDeltaBuckets: CorpusDuplicateSuppressionShadowScoreDeltaBuckets;
  /** AVG(score_delta) over status IN ('OK','BOUNDED'); null when there are none. */
  averageScoreDelta: number | null;
  /** AVG(score_delta) over status IN ('OK','BOUNDED') AND candidate_count > 0; null when there are none. */
  averageScoreDeltaWhereCandidate: number | null;

  /** status IN ('OK','BOUNDED') AND authoritative_score = 100 AND hypothetical_score = 0. */
  authoritative100Hypothetical0Count: number;
  /** status IN ('OK','BOUNDED') AND authoritative_score = 100 AND hypothetical_score BETWEEN 1 AND 99. */
  authoritative100HypotheticalPartialCount: number;

  /** every row for the policy (operational — checker_accounts_status is NOT NULL DEFAULT 'NOT_APPLICABLE'). */
  checkerAccountsStatusDistribution: Record<string, number>;
  /** status IN ('OK','BOUNDED') AND checker_accounts_status = 'OK' only. */
  distinctCheckerAccountsBucketDistribution: Record<string, number>;

  /** status = 'FAILED' only. */
  errorCodeDistribution: Record<string, number>;

  /**
   * INTEGRITY CHECK (no COALESCE). checkedRows: OK/BOUNDED rows with a non-NULL
   * hypothetical_unique_matched_words. reconciledRows: of those, the rows where
   * ALL FOUR surviving-word channels (archive_only + live_academic_only +
   * previous_upload_only + overlap) are non-NULL AND their direct sum equals
   * hypothetical_unique_matched_words. A NULL in any channel on an OK/BOUNDED
   * row is itself a reconciliation failure. reconciledRows should equal
   * checkedRows for a healthy evaluator; a gap is a bug worth an alert.
   */
  reconciliation: { checkedRows: number; reconciledRows: number };

  recentCandidatesLimit: number;
  /**
   * The most recent genuine candidates only — status IN ('OK','BOUNDED') AND
   * candidate_count > 0 — newest computed_at first, capped at recentCandidatesLimit
   * (default 25, max 100). FAILED / SKIPPED / candidate_count = 0 rows never appear.
   */
  recentCandidates: CorpusDuplicateSuppressionShadowRecentRow[];
};

export type CorpusDuplicateSuppressionShadowRecentRow = {
  reportId: string;
  reportDeviceKey: string;
  status: string;
  /** NULL unless status = 'FAILED'. */
  errorCode: string | null;
  checkerAccountsStatus: string;
  distinctCheckerAccountsBucket: string | null;
  authoritativeScore: number | null;
  hypotheticalScore: number | null;
  scoreDelta: number | null;
  candidateCount: number | null;
  measurementCategory: string | null;
  originConfidence: string | null;
  multiOriginEvidence: string | null;
  authoritativeUniqueMatchedWords: number | null;
  hypotheticalUniqueMatchedWords: number | null;
  uniqueMatchedWordsRemoved: number | null;
  candidateMatchedWords: number | null;
  candidatesExcluded: number | null;
  archiveOnlyWordsSurviving: number | null;
  liveAcademicOnlyWordsSurviving: number | null;
  previousUploadOnlyWordsSurviving: number | null;
  overlapWordsSurviving: number | null;
  candidateAdmittedPromotionBackingCount: number | null;
  candidateSubmissionReferenceBackingCount: number | null;
  candidateIndependentBackingCount: number | null;
  candidateSameDeviceBackingCount: number | null;
  samePassportCategory: boolean | null;
  crossAccountCategory: boolean | null;
  submittedWordCount: number | null;
  authoritativeCorpusGeneration: number | null;
  authoritativeSnapshotComputedAt: string | null;
  evaluationTruncated: boolean;
  totalRuntimeMs: number | null;
  computedAt: string;
  createdAt: string;
};

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return num(v) !== 0;
}

function toDistribution(rows: readonly Record<string, unknown>[], keyCol = "k", countCol = "n"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row[keyCol] ?? "(none)")] = num(row[countCol]);
  return out;
}

export async function summarizeCorpusDuplicateSuppressionShadowMeasurement(
  client: Client,
  opts?: { recentLimit?: number },
): Promise<CorpusDuplicateSuppressionShadowMeasurement> {
  const recentLimit = Math.min(
    MAX_RECENT_CANDIDATE_LIMIT,
    Math.max(1, Math.floor(opts?.recentLimit ?? DEFAULT_RECENT_CANDIDATE_LIMIT) || DEFAULT_RECENT_CANDIDATE_LIMIT),
  );

  // ---- one column-only pass: status tallies + every real-measurement scalar ----
  // REAL scoped by `status IN ('OK','BOUNDED')`; delta buckets additionally
  // guard `score_delta IS NOT NULL` (belt-and-braces — an OK/BOUNDED row always
  // has a non-null score_delta). AVG(CASE WHEN <filter> THEN ... END) skips the
  // non-matching NULLs, so a FAILED/SKIPPED row can never pull an average.
  const aggRow = (await client.execute({
    sql: `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'OK' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN status = 'BOUNDED' THEN 1 ELSE 0 END) AS bounded,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'SKIPPED_NOT_MATCHED' THEN 1 ELSE 0 END) AS skipped_not_matched,
            SUM(CASE WHEN status = 'SKIPPED_NO_AUTHORITATIVE' THEN 1 ELSE 0 END) AS skipped_no_authoritative,

            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} THEN 1 ELSE 0 END) AS real_rows,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND candidate_count > 0 THEN 1 ELSE 0 END) AS candidate_positive,

            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND score_delta IS NOT NULL AND score_delta = 0 THEN 1 ELSE 0 END) AS d_zero,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND score_delta BETWEEN 1 AND 9 THEN 1 ELSE 0 END) AS d_1_9,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND score_delta BETWEEN 10 AND 24 THEN 1 ELSE 0 END) AS d_10_24,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND score_delta BETWEEN 25 AND 49 THEN 1 ELSE 0 END) AS d_25_49,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND score_delta BETWEEN 50 AND 99 THEN 1 ELSE 0 END) AS d_50_99,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND score_delta >= 100 THEN 1 ELSE 0 END) AS d_100,

            AVG(CASE WHEN ${REAL_MEASUREMENT_FILTER} THEN CAST(score_delta AS REAL) END) AS avg_delta,
            AVG(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND candidate_count > 0 THEN CAST(score_delta AS REAL) END) AS avg_delta_candidate,

            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND authoritative_score = 100 AND hypothetical_score = 0 THEN 1 ELSE 0 END) AS a100_h0,
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND authoritative_score = 100 AND hypothetical_score BETWEEN 1 AND 99 THEN 1 ELSE 0 END) AS a100_hp,

            SUM(CASE WHEN status IN ('OK','BOUNDED','SKIPPED_NOT_MATCHED') AND candidate_count = 0 THEN 1 ELSE 0 END) AS cc_zero,
            SUM(CASE WHEN status IN ('OK','BOUNDED','SKIPPED_NOT_MATCHED') AND candidate_count = 1 THEN 1 ELSE 0 END) AS cc_one,
            SUM(CASE WHEN status IN ('OK','BOUNDED','SKIPPED_NOT_MATCHED') AND candidate_count >= 2 THEN 1 ELSE 0 END) AS cc_two_plus,

            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER} AND hypothetical_unique_matched_words IS NOT NULL THEN 1 ELSE 0 END) AS reconcile_checked,
            -- INTEGRITY CHECK — NO COALESCE. For an OK/BOUNDED row a NULL in any
            -- of the four surviving-word channels is itself a reconciliation
            -- failure (the evaluator always writes all four together), so each
            -- must be explicitly non-NULL before the direct sum is compared.
            SUM(CASE WHEN ${REAL_MEASUREMENT_FILTER}
                      AND hypothetical_unique_matched_words IS NOT NULL
                      AND archive_only_words_surviving IS NOT NULL
                      AND live_academic_only_words_surviving IS NOT NULL
                      AND previous_upload_only_words_surviving IS NOT NULL
                      AND overlap_words_surviving IS NOT NULL
                      AND (archive_only_words_surviving
                           + live_academic_only_words_surviving
                           + previous_upload_only_words_surviving
                           + overlap_words_surviving) = hypothetical_unique_matched_words
                 THEN 1 ELSE 0 END) AS reconcile_ok
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ?`,
    args: [POLICY],
  })).rows[0] as unknown as Record<string, unknown>;

  // ---- OK/BOUNDED-scoped GROUP BY distributions ----
  const measurementCategoryRows = (await client.execute({
    sql: `SELECT COALESCE(measurement_category, '(none)') AS k, COUNT(*) AS n
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ? AND ${REAL_MEASUREMENT_FILTER}
          GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  const originConfidenceRows = (await client.execute({
    sql: `SELECT COALESCE(origin_confidence, '(none)') AS k, COUNT(*) AS n
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ? AND ${REAL_MEASUREMENT_FILTER}
          GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  const multiOriginEvidenceRows = (await client.execute({
    sql: `SELECT COALESCE(multi_origin_evidence, '(none)') AS k, COUNT(*) AS n
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ? AND ${REAL_MEASUREMENT_FILTER}
          GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  // ---- operational distributions ----
  const checkerStatusRows = (await client.execute({
    sql: `SELECT checker_accounts_status AS k, COUNT(*) AS n
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ?
          GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  const checkerBucketRows = (await client.execute({
    sql: `SELECT COALESCE(distinct_checker_accounts_bucket, '(none)') AS k, COUNT(*) AS n
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ? AND ${REAL_MEASUREMENT_FILTER} AND checker_accounts_status = 'OK'
          GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  const errorCodeRows = (await client.execute({
    sql: `SELECT COALESCE(error_code, '(none)') AS k, COUNT(*) AS n
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ? AND status = 'FAILED'
          GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  // ---- bounded recent CANDIDATE rows table ----
  // Genuinely candidate-only: a real-measurement row (status IN ('OK','BOUNDED'))
  // that actually found a document-local corpus-duplicate candidate
  // (candidate_count > 0). A newer FAILED / SKIPPED / candidate_count = 0 row can
  // never appear here or push an older genuine candidate out of the window.
  const recentRows = (await client.execute({
    sql: `SELECT report_id, report_device_key, status, error_code,
                 checker_accounts_status, distinct_checker_accounts_bucket,
                 authoritative_score, hypothetical_score, score_delta,
                 candidate_count, measurement_category, origin_confidence, multi_origin_evidence,
                 authoritative_unique_matched_words, hypothetical_unique_matched_words,
                 unique_matched_words_removed, candidate_matched_words, candidates_excluded,
                 archive_only_words_surviving, live_academic_only_words_surviving,
                 previous_upload_only_words_surviving, overlap_words_surviving,
                 candidate_admitted_promotion_backing_count, candidate_submission_reference_backing_count,
                 candidate_independent_backing_count, candidate_same_device_backing_count,
                 same_passport_category, cross_account_category,
                 submitted_word_count, authoritative_corpus_generation, authoritative_snapshot_computed_at,
                 evaluation_truncated, total_runtime_ms, computed_at, created_at
          FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE policy_version = ?
            AND status IN ('OK','BOUNDED')
            AND candidate_count > 0
          ORDER BY computed_at DESC, id DESC
          LIMIT ?`,
    args: [POLICY, recentLimit],
  })).rows as unknown as Record<string, unknown>[];

  const recentCandidates: CorpusDuplicateSuppressionShadowRecentRow[] = recentRows.map((row) => ({
    reportId: String(row.report_id),
    reportDeviceKey: String(row.report_device_key),
    status: String(row.status),
    errorCode: strOrNull(row.error_code),
    checkerAccountsStatus: String(row.checker_accounts_status),
    distinctCheckerAccountsBucket: strOrNull(row.distinct_checker_accounts_bucket),
    authoritativeScore: numOrNull(row.authoritative_score),
    hypotheticalScore: numOrNull(row.hypothetical_score),
    scoreDelta: numOrNull(row.score_delta),
    candidateCount: numOrNull(row.candidate_count),
    measurementCategory: strOrNull(row.measurement_category),
    originConfidence: strOrNull(row.origin_confidence),
    multiOriginEvidence: strOrNull(row.multi_origin_evidence),
    authoritativeUniqueMatchedWords: numOrNull(row.authoritative_unique_matched_words),
    hypotheticalUniqueMatchedWords: numOrNull(row.hypothetical_unique_matched_words),
    uniqueMatchedWordsRemoved: numOrNull(row.unique_matched_words_removed),
    candidateMatchedWords: numOrNull(row.candidate_matched_words),
    candidatesExcluded: numOrNull(row.candidates_excluded),
    archiveOnlyWordsSurviving: numOrNull(row.archive_only_words_surviving),
    liveAcademicOnlyWordsSurviving: numOrNull(row.live_academic_only_words_surviving),
    previousUploadOnlyWordsSurviving: numOrNull(row.previous_upload_only_words_surviving),
    overlapWordsSurviving: numOrNull(row.overlap_words_surviving),
    candidateAdmittedPromotionBackingCount: numOrNull(row.candidate_admitted_promotion_backing_count),
    candidateSubmissionReferenceBackingCount: numOrNull(row.candidate_submission_reference_backing_count),
    candidateIndependentBackingCount: numOrNull(row.candidate_independent_backing_count),
    candidateSameDeviceBackingCount: numOrNull(row.candidate_same_device_backing_count),
    samePassportCategory: boolOrNull(row.same_passport_category),
    crossAccountCategory: boolOrNull(row.cross_account_category),
    submittedWordCount: numOrNull(row.submitted_word_count),
    authoritativeCorpusGeneration: numOrNull(row.authoritative_corpus_generation),
    authoritativeSnapshotComputedAt: strOrNull(row.authoritative_snapshot_computed_at),
    evaluationTruncated: num(row.evaluation_truncated) !== 0,
    totalRuntimeMs: numOrNull(row.total_runtime_ms),
    computedAt: String(row.computed_at),
    createdAt: String(row.created_at),
  }));

  const realRows = num(aggRow.real_rows);
  const candidatePositive = num(aggRow.candidate_positive);

  return {
    policyVersion: POLICY,
    generatedAt: new Date().toISOString(),
    totals: {
      evaluations: num(aggRow.total),
      ok: num(aggRow.ok),
      bounded: num(aggRow.bounded),
      failed: num(aggRow.failed),
      skipped: num(aggRow.skipped_not_matched) + num(aggRow.skipped_no_authoritative),
      skippedNotMatched: num(aggRow.skipped_not_matched),
      skippedNoAuthoritative: num(aggRow.skipped_no_authoritative),
      realMeasurementRows: realRows,
      candidatePositive,
    },
    candidateFrequency: realRows > 0 ? candidatePositive / realRows : 0,
    candidateCountDistribution: {
      zero: num(aggRow.cc_zero),
      one: num(aggRow.cc_one),
      twoPlus: num(aggRow.cc_two_plus),
    },
    measurementCategoryDistribution: toDistribution(measurementCategoryRows),
    originConfidenceDistribution: toDistribution(originConfidenceRows),
    multiOriginEvidenceDistribution: toDistribution(multiOriginEvidenceRows),
    scoreDeltaBuckets: {
      zero: num(aggRow.d_zero),
      d1to9: num(aggRow.d_1_9),
      d10to24: num(aggRow.d_10_24),
      d25to49: num(aggRow.d_25_49),
      d50to99: num(aggRow.d_50_99),
      d100: num(aggRow.d_100),
    },
    averageScoreDelta: numOrNull(aggRow.avg_delta),
    averageScoreDeltaWhereCandidate: numOrNull(aggRow.avg_delta_candidate),
    authoritative100Hypothetical0Count: num(aggRow.a100_h0),
    authoritative100HypotheticalPartialCount: num(aggRow.a100_hp),
    checkerAccountsStatusDistribution: toDistribution(checkerStatusRows),
    distinctCheckerAccountsBucketDistribution: toDistribution(checkerBucketRows),
    errorCodeDistribution: toDistribution(errorCodeRows),
    reconciliation: {
      checkedRows: num(aggRow.reconcile_checked),
      reconciledRows: num(aggRow.reconcile_ok),
    },
    recentCandidatesLimit: recentLimit,
    recentCandidates,
  };
}
