import type { Client } from "@libsql/client";
import { canonicalSha256 } from "./document-identity";
import { createArchiveReadRetryClient, type ArchiveReadRetryHooks } from "./archive-read-retry";
import { UNIFIED_SIMILARITY_VERSION, type UnifiedSimilarityResult } from "./unified-similarity";
import type { ExternalAcademicEvidence } from "./academic-search/types";
import type { ReportHistoricalSubmissionMatch } from "./report-types";
import { isPmcCoverageShadowEnabled } from "./pmc-coverage/flag";
import {
  PMC_COVERAGE_SHADOW_EVALUATOR_VERSION,
  PMC_COMPACT_FINGERPRINT_VERSION,
  PMC_DF_BAND_POLICY_VERSION,
  PMC_EVALUATOR_TIME_BUDGET_MS,
  PMC_FAILED_RETRY_COOLDOWN_SQL,
  PMC_MAX_QUERY_FINGERPRINTS,
  PMC_STAGE_A_TOP_K,
} from "./pmc-coverage/constants";
import { winnowSubmissionFingerprints, type PmcQueryFingerprints } from "./pmc-coverage/fingerprint";
import { loadPmcDfBandMap, derivePmcStopHashSet } from "./pmc-coverage/df-bands";
import {
  loadRetractedPmcIds,
  retrievePmcStageACandidates,
  loadPmcCandidateTexts,
  type PmcStageAResult,
} from "./pmc-coverage/repository";
import { verifyPmcCandidates, type PmcStageBResult } from "./pmc-coverage/verify";
import {
  computePmcCoverageCounterfactual,
  PmcCoverageCounterfactualInvariantError,
  type PmcCoverageCounterfactualResult,
} from "./pmc-coverage/counterfactual";

/**
 * PMC OA scholarly-coverage SHADOW slice — the deferred, bounded, never-throws
 * telemetry evaluator. Scheduled off-response by lib/report-shadow-evaluations.ts
 * exactly like the E8P / device-provenance / corpus-duplicate shadows.
 *
 * ARCHITECTURE (winnowed fingerprint hits NEVER score directly):
 *   submission -> production 5-gram hashes -> winnow w=15
 *     -> DF-banded fingerprint candidate retrieval (pmc_document_fingerprints,
 *        pmc_hash_df_bands as the stop set for BOTH stages)
 *     -> rank top-K <= 20
 *     -> load ONLY those canonical texts
 *     -> the UNMODIFIED lib/archive-similarity-scoring.ts scoreAgainstArchive
 *        over the <= 20 candidates -> verified submission word positions
 *     -> lib/pmc-coverage/counterfactual.ts computeUnifiedSimilarity(baseline
 *        inputs + PMC positions) -> score delta
 *     -> ONE bounded UPSERT into pmc_coverage_shadow_evaluations.
 *
 * NEVER:
 *   - runs when PMC_COVERAGE_SHADOW_ENABLED is not exactly "true" (immediate
 *     no-op — no connection, no query, no tokenization);
 *   - reads, re-derives, or writes the authoritative unifiedSimilarity.unifiedScore
 *     (it recomputes a PARITY baseline with computeUnifiedSimilarity and refuses
 *     to publish a delta if that baseline disagrees with authoritative);
 *   - writes any scoring field, saved_reports column, report payload, or
 *     report_historical_match_snapshots row;
 *   - throws into the report flow — every failure path writes a FAILED row (or
 *     nothing) and returns.
 *
 * BOUNDED: top-K <= 20; chunked fingerprint queries; explicit maximum query
 * fingerprints (PMC_MAX_QUERY_FINGERPRINTS); DF stop/band policy; the shared
 * lib/archive-read-retry.ts bounded read budget; a wall-clock evaluator budget.
 *
 * IDEMPOTENT: UPSERTs on (report_id, evaluator_version), EXISTS-guarded on
 * saved_reports; a repeat POST, a repeat GET, or a POST then GET converge on the
 * SAME row.
 */

export const PMC_COVERAGE_SHADOW_STATUS = {
  OK: "OK",
  BOUNDED: "BOUNDED",
  FAILED: "FAILED",
  SKIPPED_NO_AUTHORITATIVE: "SKIPPED_NO_AUTHORITATIVE",
  SKIPPED_EMPTY_CORPUS: "SKIPPED_EMPTY_CORPUS",
  SKIPPED_BASELINE_MISMATCH: "SKIPPED_BASELINE_MISMATCH",
} as const;
type PmcShadowStatus = (typeof PMC_COVERAGE_SHADOW_STATUS)[keyof typeof PMC_COVERAGE_SHADOW_STATUS];
type PmcShadowErrorCode =
  | "STAGE_A_FAILED"
  | "STAGE_B_FAILED"
  | "COUNTERFACTUAL_INVARIANT"
  | "TIME_BUDGET_EXCEEDED"
  | "UNEXPECTED";

export type RunPmcCoverageShadowEvaluationParams = {
  reportDeviceKey: string;
  reportId: string;
  /** null for an anonymous report. Used only for the ordinary-user privacy
   *  invariant (never persisted, never a scoring gate here). */
  accountId: string | null;
  /** The report's own submitted text — used transiently for winnowing +
   *  canonicalSha256. Never persisted. */
  rawText: string;
  /** Production's already-computed historical-match result — read verbatim. */
  productionResult: ReportHistoricalSubmissionMatch;
  /** Production's already-computed authoritative UnifiedSimilarityResult. null
   *  when computeUnifiedSimilarity itself threw for this report. */
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult | null;
  /** resolvePrimarySimilaritySummary(...).effectiveDeviceSelfRepresentationIds. */
  effectiveDeviceSelfRepresentationIds: readonly string[];
  /** The EXACT archiveMatchedPositions the caller passed into
   *  resolvePrimarySimilaritySummary — request-local parity guarantee. */
  authoritativeArchiveMatchedPositions: number[] | null;
  /** The EXACT (server-verified) externalAcademicEvidence the caller passed in. */
  authoritativeExternalAcademicEvidence: ExternalAcademicEvidence[] | null;
  /** Test seam for the bounded read-retry layer. Production leaves this unset. */
  readRetry?: ArchiveReadRetryHooks;
  /** Test seam — override the wall-clock budget. */
  timeBudgetMs?: number;
};

function nowMs(): number {
  return Date.now();
}

/** SQLite CURRENT_TIMESTAMP text shape, so computed_at cooldown comparisons line up. */
function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function safeCanonicalSha256(text: string): string {
  try {
    return canonicalSha256(text ?? "");
  } catch {
    return canonicalSha256("");
  }
}

// ── row shape ──────────────────────────────────────────────────────────────

const SHADOW_COLUMNS = [
  "report_device_key",
  "report_id",
  "status",
  "error_code",
  "evaluator_version",
  "unified_similarity_version",
  "fingerprint_version",
  "df_band_policy_version",
  "authoritative_snapshot_computed_at",
  "submission_canonical_sha256",
  "submitted_word_count",
  "baseline_unified_score",
  "counterfactual_unified_score",
  "score_delta",
  "pmc_matched_word_count",
  "pmc_marginal_word_count",
  "pmc_candidate_count",
  "pmc_verified_source_count",
  "stage_a_query_fingerprints",
  "stage_a_stopped_fingerprints",
  "stage_a_tombstoned_hits",
  "evaluation_truncated",
  "pmc_matched_positions_json",
  "pmc_sources_json",
  "total_runtime_ms",
  "computed_at",
] as const;
type ShadowColumn = (typeof SHADOW_COLUMNS)[number];
type ShadowRow = Record<ShadowColumn, string | number | null>;

const NO_UPDATE_ON_CONFLICT = new Set<ShadowColumn>([
  "report_device_key",
  "report_id",
  "evaluator_version",
]);

function baseRow(params: RunPmcCoverageShadowEvaluationParams): ShadowRow {
  return {
    report_device_key: params.reportDeviceKey,
    report_id: params.reportId,
    status: PMC_COVERAGE_SHADOW_STATUS.FAILED,
    error_code: null,
    evaluator_version: PMC_COVERAGE_SHADOW_EVALUATOR_VERSION,
    unified_similarity_version: UNIFIED_SIMILARITY_VERSION,
    fingerprint_version: PMC_COMPACT_FINGERPRINT_VERSION,
    df_band_policy_version: PMC_DF_BAND_POLICY_VERSION,
    authoritative_snapshot_computed_at: null,
    submission_canonical_sha256: null,
    submitted_word_count: null,
    baseline_unified_score: null,
    counterfactual_unified_score: null,
    score_delta: null,
    pmc_matched_word_count: null,
    pmc_marginal_word_count: null,
    pmc_candidate_count: null,
    pmc_verified_source_count: null,
    stage_a_query_fingerprints: null,
    stage_a_stopped_fingerprints: null,
    stage_a_tombstoned_hits: null,
    evaluation_truncated: 0,
    pmc_matched_positions_json: null,
    pmc_sources_json: null,
    total_runtime_ms: null,
    computed_at: null,
  };
}

async function upsertRow(client: Client, row: ShadowRow): Promise<{ rowsAffected: number }> {
  const insertCols = SHADOW_COLUMNS.join(", ");
  const selectPlaceholders = SHADOW_COLUMNS.map(() => "?").join(", ");
  const updateSet = SHADOW_COLUMNS.filter((c) => !NO_UPDATE_ON_CONFLICT.has(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const result = await client.execute({
    sql: `INSERT INTO pmc_coverage_shadow_evaluations (${insertCols})
          SELECT ${selectPlaceholders}
          WHERE EXISTS (SELECT 1 FROM saved_reports WHERE device_key = ? AND id = ?)
          ON CONFLICT(report_id, evaluator_version) DO UPDATE SET ${updateSet}`,
    args: [...SHADOW_COLUMNS.map((c) => row[c]), row.report_device_key, row.report_id],
  });
  return { rowsAffected: Number(result.rowsAffected) };
}

async function writeRow(client: Client, row: ShadowRow, startedAt: number): Promise<void> {
  await upsertRow(client, {
    ...row,
    total_runtime_ms: row.total_runtime_ms ?? nowMs() - startedAt,
    computed_at: sqliteNow(),
  });
}

// ── freshness / reuse ──────────────────────────────────────────────────────

type ExistingRow = {
  status: string;
  evaluator_version: string | null;
  unified_similarity_version: string | null;
  fingerprint_version: string | null;
  df_band_policy_version: string | null;
  authoritative_snapshot_computed_at: string | null;
  failed_cooldown_elapsed: number | bigint | null;
};

async function loadExistingRow(
  client: Client,
  reportId: string,
): Promise<ExistingRow | null> {
  const result = await client.execute({
    sql: `SELECT status, evaluator_version, unified_similarity_version, fingerprint_version,
                 df_band_policy_version, authoritative_snapshot_computed_at,
                 (computed_at < datetime('now', ?)) AS failed_cooldown_elapsed
          FROM pmc_coverage_shadow_evaluations
          WHERE report_id = ? AND evaluator_version = ?`,
    args: [PMC_FAILED_RETRY_COOLDOWN_SQL, reportId, PMC_COVERAGE_SHADOW_EVALUATOR_VERSION],
  });
  return (result.rows[0] as unknown as ExistingRow | undefined) ?? null;
}

function shouldReuseExistingRow(
  row: ExistingRow,
  params: RunPmcCoverageShadowEvaluationParams,
): boolean {
  if (
    row.unified_similarity_version !== UNIFIED_SIMILARITY_VERSION ||
    row.fingerprint_version !== PMC_COMPACT_FINGERPRINT_VERSION ||
    row.df_band_policy_version !== PMC_DF_BAND_POLICY_VERSION
  ) {
    return false;
  }
  if (row.status === PMC_COVERAGE_SHADOW_STATUS.FAILED) {
    return Number(row.failed_cooldown_elapsed) !== 1;
  }
  if (row.status === PMC_COVERAGE_SHADOW_STATUS.SKIPPED_NO_AUTHORITATIVE) {
    return params.authoritativeUnifiedSimilarity === null;
  }
  if (row.status === PMC_COVERAGE_SHADOW_STATUS.SKIPPED_EMPTY_CORPUS) {
    return false; // cheap to re-check; the corpus may have been seeded since
  }
  // OK / BOUNDED / SKIPPED_BASELINE_MISMATCH: reuse only while the authoritative
  // snapshot the delta was measured against is unchanged.
  return row.authoritative_snapshot_computed_at === params.productionResult.computedAt;
}

// ── entry point ────────────────────────────────────────────────────────────

export async function runPmcCoverageShadowEvaluation(
  client: Client,
  params: RunPmcCoverageShadowEvaluationParams,
): Promise<void> {
  // Flag OFF => IMMEDIATE no-op. Nothing below runs.
  if (!isPmcCoverageShadowEnabled()) return;

  const startedAt = nowMs();
  const budgetMs = params.timeBudgetMs ?? PMC_EVALUATOR_TIME_BUDGET_MS;
  const overBudget = () => nowMs() - startedAt > budgetMs;

  // Nothing to compare against — matches the other shadows.
  if (params.productionResult.status === "UNAVAILABLE") return;

  try {
    const existing = await loadExistingRow(client, params.reportId);
    if (existing && shouldReuseExistingRow(existing, params)) return;

    if (params.authoritativeUnifiedSimilarity === null) {
      await writeRow(
        client,
        { ...baseRow(params), status: PMC_COVERAGE_SHADOW_STATUS.SKIPPED_NO_AUTHORITATIVE },
        startedAt,
      );
      return;
    }
    const authoritative = params.authoritativeUnifiedSimilarity;
    const submissionCanonicalSha256 = safeCanonicalSha256(params.rawText);

    const { client: readClient } = createArchiveReadRetryClient(client, params.readRetry);

    // Corpus presence — the expected "flag on, Preview not yet seeded" state.
    const seededProbe = await readClient.execute({
      sql: `SELECT pmc_id FROM pmc_coverage_documents LIMIT 1`,
      args: [],
    });
    if (seededProbe.rows.length === 0) {
      await writeRow(
        client,
        {
          ...baseRow(params),
          status: PMC_COVERAGE_SHADOW_STATUS.SKIPPED_EMPTY_CORPUS,
          authoritative_snapshot_computed_at: params.productionResult.computedAt,
          submission_canonical_sha256: submissionCanonicalSha256,
          submitted_word_count: authoritative.wordCount,
        },
        startedAt,
      );
      return;
    }

    // ---- Stage A --------------------------------------------------------------
    let stageA: PmcStageAResult & { stopHashes: Set<string> };
    let queryFingerprints: PmcQueryFingerprints;
    try {
      queryFingerprints = winnowSubmissionFingerprints(params.rawText, PMC_MAX_QUERY_FINGERPRINTS);
      const dfBandMap = await loadPmcDfBandMap(readClient);
      const stopHashes = derivePmcStopHashSet(dfBandMap.bandByHash);
      const retracted = await loadRetractedPmcIds(readClient);
      if (overBudget()) throw new Error("time budget exceeded before Stage A retrieval");
      const retrieved = await retrievePmcStageACandidates(
        readClient,
        queryFingerprints.fingerprints,
        stopHashes,
        retracted,
        { topK: PMC_STAGE_A_TOP_K },
      );
      // Carry the stop set forward for Stage B getPostings parity.
      stageA = { ...retrieved, stopHashes };
    } catch (err) {
      if (err instanceof Error && /time budget/i.test(err.message)) {
        await writeFailed(client, params, "TIME_BUDGET_EXCEEDED", startedAt, submissionCanonicalSha256);
        return;
      }
      await writeFailed(client, params, "STAGE_A_FAILED", startedAt, submissionCanonicalSha256);
      return;
    }

    const truncated = queryFingerprints.trimmed || stageA.truncated;

    // ---- Stage B (UNMODIFIED matcher) --------------------------------------
    let stageB: PmcStageBResult;
    try {
      if (overBudget()) throw new Error("time budget exceeded before Stage B");
      const candidateTexts = await loadPmcCandidateTexts(
        readClient,
        stageA.candidates.map((c) => c.pmcId),
      );
      stageB = verifyPmcCandidates(params.rawText, candidateTexts, stageA.stopHashes);
    } catch (err) {
      if (err instanceof Error && /time budget/i.test(err.message)) {
        await writeFailed(client, params, "TIME_BUDGET_EXCEEDED", startedAt, submissionCanonicalSha256);
        return;
      }
      await writeFailed(client, params, "STAGE_B_FAILED", startedAt, submissionCanonicalSha256);
      return;
    }

    // ---- Counterfactual (UNMODIFIED computeUnifiedSimilarity) --------------
    let counterfactual: PmcCoverageCounterfactualResult;
    try {
      counterfactual = computePmcCoverageCounterfactual({
        wordCount: authoritative.wordCount,
        authoritativeArchiveMatchedPositions: params.authoritativeArchiveMatchedPositions,
        externalAcademicEvidence: params.authoritativeExternalAcademicEvidence,
        historicalSubmissionMatch: params.productionResult,
        effectiveDeviceSelfRepresentationIds: params.effectiveDeviceSelfRepresentationIds,
        authoritativeUnifiedSimilarity: authoritative,
        pmcVerifiedPositions: stageB.verifiedPositions,
      });
    } catch (err) {
      if (err instanceof PmcCoverageCounterfactualInvariantError && err.reason === "BASELINE_MISMATCH") {
        await writeRow(
          client,
          {
            ...baseRow(params),
            status: PMC_COVERAGE_SHADOW_STATUS.SKIPPED_BASELINE_MISMATCH,
            authoritative_snapshot_computed_at: params.productionResult.computedAt,
            submission_canonical_sha256: submissionCanonicalSha256,
            submitted_word_count: authoritative.wordCount,
          },
          startedAt,
        );
        return;
      }
      await writeFailed(client, params, "COUNTERFACTUAL_INVARIANT", startedAt, submissionCanonicalSha256);
      return;
    }

    // ---- Persist ---------------------------------------------------------------
    const verifiedPmcIds = new Set(stageB.sources.map((s) => s.pmcId));
    await writeRow(
      client,
      {
        ...baseRow(params),
        status: truncated ? PMC_COVERAGE_SHADOW_STATUS.BOUNDED : PMC_COVERAGE_SHADOW_STATUS.OK,
        authoritative_snapshot_computed_at: params.productionResult.computedAt,
        submission_canonical_sha256: submissionCanonicalSha256,
        submitted_word_count: authoritative.wordCount,
        baseline_unified_score: counterfactual.baselineScore,
        counterfactual_unified_score: counterfactual.counterfactualScore,
        score_delta: counterfactual.scoreDelta,
        pmc_matched_word_count: counterfactual.pmcMatchedWordCount,
        pmc_marginal_word_count: counterfactual.pmcMarginalWordCount,
        pmc_candidate_count: stageA.candidates.length,
        pmc_verified_source_count: verifiedPmcIds.size,
        stage_a_query_fingerprints: stageA.queryFingerprintsUsed,
        stage_a_stopped_fingerprints: stageA.stoppedFingerprints,
        stage_a_tombstoned_hits: stageA.tombstonedHits,
        evaluation_truncated: truncated ? 1 : 0,
        pmc_matched_positions_json: JSON.stringify(stageB.verifiedPositions),
        pmc_sources_json: JSON.stringify(
          stageB.sources.map((s) => ({
            pmcId: s.pmcId,
            doi: s.doi,
            title: s.title,
            matchedWords: s.matchedWords,
          })),
        ),
      },
      startedAt,
    );
  } catch (err) {
    console.error(
      `pmc-coverage shadow evaluation failed (non-fatal) for report=${params.reportId} (${nowMs() - startedAt}ms):`,
      err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    );
    try {
      await writeFailed(client, params, "UNEXPECTED", startedAt, safeCanonicalSha256(params.rawText));
    } catch (writeErr) {
      console.error(
        `pmc-coverage shadow evaluation: failed to persist FAILED row for report=${params.reportId}:`,
        writeErr instanceof Error ? writeErr.message.slice(0, 200) : String(writeErr).slice(0, 200),
      );
    }
  }
}

async function writeFailed(
  client: Client,
  params: RunPmcCoverageShadowEvaluationParams,
  errorCode: PmcShadowErrorCode,
  startedAt: number,
  submissionCanonicalSha256: string | null,
): Promise<void> {
  await writeRow(
    client,
    {
      ...baseRow(params),
      status: PMC_COVERAGE_SHADOW_STATUS.FAILED,
      error_code: errorCode,
      submission_canonical_sha256: submissionCanonicalSha256,
    },
    startedAt,
  );
}

export type { PmcShadowStatus, PmcShadowErrorCode };
