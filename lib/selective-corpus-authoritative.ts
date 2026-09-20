import type { Client } from "@libsql/client";
import {
  resolvePrimarySimilaritySummary,
  persistSelectiveCorpusAuthoritativeFinalization,
  type SelectiveCorpusAuthoritativeTerminalStatus,
} from "./report-primary-similarity";
import { resolveVerifiedAcademicEvidence } from "./academic-search-diagnostics-repo";
import { buildFinalizedReportEvidenceInterpretation } from "./report-evidence-interpretation";
import { canonicalSha256 } from "./document-identity";
import type { SimilarityReport } from "./report-types";
import type { SelectiveCorpusShadowResult } from "./selective-corpus/types";

/**
 * Selective Corpus V4 AUTHORITATIVE PROMOTION — the canonical, single
 * implementation of the "pending -> terminal" lifecycle transition. Both the
 * deferred POST-triggered finalizer (lib/report-shadow-evaluations.ts) and
 * the recovery sweep (app/api/internal/selective-corpus-authoritative-sweep/
 * route.ts) call the SAME finalizeSelectiveCorpusAuthoritativeReport below —
 * there is no second implementation, and neither caller re-runs
 * resolvePrimarySimilaritySummary/computeUnifiedSimilarity itself; both
 * simply hand an already-computed SelectiveCorpusShadowResult to this module.
 *
 * NEVER runs Selective Corpus itself — that stays entirely the callers'
 * responsibility (via runSelectiveCorpusShadowEvaluation with
 * requiredForAuthoritativePendingReport:true). This module only decides WHAT
 * evidence a terminal shadow state is allowed to contribute, and PERSISTS the
 * one final result through the existing canonical scoring path
 * (resolvePrimarySimilaritySummary -> computeUnifiedSimilarity), CAS-guarded
 * so the pending -> {completed|incomplete} transition can only ever happen
 * once, no matter how many duplicate finalization attempts race each other.
 */

export type SelectiveCorpusFinalizationEvidenceSelection = {
  /** null (never []) when the terminal state carries zero evidence at all — mirrors resolvePrimarySimilaritySummary's own selectiveCorpusEvidence contract (absent/empty is byte-identical to "no V4 channel"). */
  evidence:
    | ReadonlyArray<{
        sourceId: string;
        matchedPassages: ReadonlyArray<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
      }>
    | null;
  terminalStatus: SelectiveCorpusAuthoritativeTerminalStatus;
};

/**
 * Pure state -> evidence/status policy mapping — no I/O, directly testable.
 *
 *   COMPLETED: real verifiedEvidence (already-verified, already-co-source-
 *     attributed passages) merges in; marker -> "completed".
 *   PARTIAL: shadow.ts's own PARTIAL construction is `{...completed, state:
 *     "PARTIAL", degradedShard*}` — the SAME verification pipeline as
 *     COMPLETED, over an index that had one or more packed shards
 *     unavailable at query time. Its verifiedEvidence is therefore genuine,
 *     already-verified evidence too — a lower bound, never fabricated — so it
 *     merges in exactly like COMPLETED's; marker -> "incomplete" (the search
 *     itself was over an incomplete index, disclosed rather than hidden).
 *   TIMEOUT / ARTIFACT_UNAVAILABLE / FAILED / DISABLED: these states never
 *     carry a verifiedEvidence field at all (confirmed by shadow.ts's own
 *     construction — TIMEOUT/ARTIFACT_UNAVAILABLE/FAILED return bare
 *     failure-code objects with no evidence fields whatsoever), so zero
 *     contribution here is simply what the result object contains, not a
 *     choice this function makes; marker -> "incomplete".
 */
export function selectSelectiveCorpusFinalizationEvidence(
  shadowResult: SelectiveCorpusShadowResult,
): SelectiveCorpusFinalizationEvidenceSelection {
  const toEvidence = (
    verifiedEvidence: SelectiveCorpusShadowResult["verifiedEvidence"],
  ): SelectiveCorpusFinalizationEvidenceSelection["evidence"] => {
    if (!verifiedEvidence || verifiedEvidence.length === 0) return null;
    return verifiedEvidence.map((source) => ({ sourceId: source.sourceLabel, matchedPassages: source.matchedPassages }));
  };

  if (shadowResult.state === "COMPLETED") {
    return { evidence: toEvidence(shadowResult.verifiedEvidence), terminalStatus: "completed" };
  }
  if (shadowResult.state === "PARTIAL") {
    return { evidence: toEvidence(shadowResult.verifiedEvidence), terminalStatus: "incomplete" };
  }
  // TIMEOUT, ARTIFACT_UNAVAILABLE, FAILED, DISABLED (defensive — the two
  // callers of this module always pass requiredForAuthoritativePendingReport,
  // so a genuine DISABLED should never actually reach here in practice).
  return { evidence: null, terminalStatus: "incomplete" };
}

export type FinalizeSelectiveCorpusAuthoritativeReportParams = {
  reportDeviceKey: string;
  reportId: string;
  accountId: string | null;
  /** Already-computed by the caller — this module never runs Stage A/B itself. */
  shadowResult: SelectiveCorpusShadowResult;
};

export type FinalizeSelectiveCorpusAuthoritativeReportResult =
  | { outcome: "finalized"; status: SelectiveCorpusAuthoritativeTerminalStatus }
  | { outcome: "already-finalized" }
  | { outcome: "not-pending" }
  | { outcome: "row-missing" }
  | { outcome: "gave-up" }
  /**
   * C2 fail-closed: the ENCODED (compact) whole final report — score plus its
   * explanation — exceeds the report persistence limit. NOTHING was written: the
   * report keeps exactly the row it had ("pending", no final score), so a
   * customer-visible score is never persisted without the interpretation that
   * explains it. Deliberately NOT retried with less evidence (the zero-V4
   * fallback below is for unexpected exceptions only): shrinking the score to
   * make it fit would be a scoring-semantics decision this module does not make.
   */
  | { outcome: "persistence-limit-exceeded" };

type ReadReportRowResult = { payload: SimilarityReport; archiveScoreColumn: number | bigint };

async function readReportRow(client: Client, reportDeviceKey: string, reportId: string): Promise<ReadReportRowResult | null> {
  const row = await client.execute({
    sql: "SELECT payload_json, archive_score FROM saved_reports WHERE device_key = ? AND id = ?",
    args: [reportDeviceKey, reportId],
  });
  const raw = row.rows[0] as unknown as { payload_json: string; archive_score: number | bigint } | undefined;
  if (!raw) return null;
  const payload = JSON.parse(String(raw.payload_json)) as SimilarityReport;
  return { payload, archiveScoreColumn: raw.archive_score };
}

function safeCanonicalSha256Text(text: string): string {
  try {
    return canonicalSha256(text ?? "");
  } catch {
    return canonicalSha256("");
  }
}

/**
 * One resolve-then-persist attempt. Reused for both the primary
 * (evidence-per-state-policy) attempt and the best-effort zero-V4 fallback
 * (see finalizeSelectiveCorpusAuthoritativeReport's own catch block) — never
 * a second scoring implementation, only a different evidenceSelection input.
 * Mirrors exactly the same set of inputs lib/report-primary-similarity.ts's
 * own selfHealUnifiedSimilarity already threads (wordCount,
 * archiveMatchedPositions, server-re-verified externalAcademicEvidence,
 * archiveScore) — deliberately does not widen that scope (e.g. it does not
 * re-resolve userSuppliedReferenceEvidence, exactly like selfHeal does not
 * either — a pre-existing, deliberate design boundary this module does not
 * change).
 */
async function resolveAndPersist(
  client: Client,
  params: FinalizeSelectiveCorpusAuthoritativeReportParams,
  row: ReadReportRowResult,
  evidenceSelection: SelectiveCorpusFinalizationEvidenceSelection,
): Promise<FinalizeSelectiveCorpusAuthoritativeReportResult> {
  const { payload, archiveScoreColumn } = row;

  // Scholarly evidence server trust boundary (drizzle/0052) — same
  // re-verification selfHealUnifiedSimilarity already performs: the
  // persisted payload.externalAcademicEvidence is NEVER trusted directly.
  const verifiedAcademicEvidence =
    typeof payload.text === "string" && payload.text.length > 0
      ? (
          await resolveVerifiedAcademicEvidence(client, {
            diagnosticsId:
              typeof payload.verifiedAcademicSearchDiagnosticsId === "number" && Number.isFinite(payload.verifiedAcademicSearchDiagnosticsId)
                ? payload.verifiedAcademicSearchDiagnosticsId
                : null,
            submissionCanonicalSha256: safeCanonicalSha256Text(payload.text),
          })
        ).evidence
      : [];

  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: params.reportDeviceKey,
    reportId: params.reportId,
    accountId: params.accountId,
    rawText: payload.text,
    wordCount: payload.wordCount,
    archiveMatchedPositions: payload.archiveMatchedPositions,
    externalAcademicEvidence: verifiedAcademicEvidence,
    selectiveCorpusEvidence: evidenceSelection.evidence,
    archiveScore: payload.archiveScore ?? payload.score ?? Number(archiveScoreColumn),
  });

  if (!resolution.unifiedSimilarity) {
    // A genuine, reproducible computeUnifiedSimilarity failure for this
    // report's own data (documented as never happening in practice) — no
    // safe result to persist from this attempt.
    return { outcome: "gave-up" };
  }

  // The FINAL unifiedSimilarity is now known — derive the customer-visible
  // evidenceInterpretation from IT (through the shared write-time builder), so
  // the score and its explanation can never disagree. A report created in this
  // mode was persisted while "pending" with NO unifiedSimilarity, so the
  // interpretation POST built for it came from archive-only positions and can
  // explain none of the channels that only exist in this final score (imported
  // evidence, Selective Corpus). Built over exactly the inputs that fed the
  // score — the server-verified academic evidence re-resolved above, this
  // resolution's historical match — never the persisted, possibly-stale ones.
  // No user-supplied-reference evidence is passed, mirroring the score
  // resolution above (which deliberately gets none): the explanation never
  // describes evidence the final score does not contain.
  //
  // C2 FAIL CLOSED: the score and its explanation are persisted together or not
  // at all. There is no "land the score, remove the interpretation" outcome.
  //   - BUILD_FAILED: an unexpected exception — thrown, so the existing
  //     exception handling (best-effort zero-V4 fallback, else leave pending for
  //     the recovery sweep) applies exactly as it does for any other failure.
  //   - PERSISTED_SIZE_EXCEEDED: even the compact whole report does not fit the
  //     persistence limit. Nothing is written and the pending row is left
  //     untouched (see the outcome's own doc comment).
  const prepared = buildFinalizedReportEvidenceInterpretation(
    { ...payload, externalAcademicEvidence: verifiedAcademicEvidence, unifiedSimilarity: resolution.unifiedSimilarity },
    { historicalSubmissionMatch: resolution.historicalSubmissionMatch },
  );
  if (!prepared.ok) {
    if (prepared.reason === "PERSISTED_SIZE_EXCEEDED") {
      console.error(
        "selective-corpus authoritative finalization: the final report cannot be persisted WITH its explanation within the persistence limit; leaving the report pending, nothing written:",
        { reportId: params.reportId, persistedBytes: prepared.persistedBytes, maxBytes: prepared.maxBytes },
      );
      return { outcome: "persistence-limit-exceeded" };
    }
    throw new Error("selective-corpus authoritative finalization could not build the final report's evidenceInterpretation");
  }

  const write = await persistSelectiveCorpusAuthoritativeFinalization(
    client,
    { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId },
    {
      unifiedSimilarity: resolution.unifiedSimilarity,
      corpusSourceMatchingEnabled: resolution.corpusSourceMatchingEnabled,
      corpusGeneration: resolution.corpusGeneration,
      terminalStatus: evidenceSelection.terminalStatus,
      evidenceInterpretation: prepared.evidenceInterpretation,
    },
  );
  if (!write.written) {
    // rowsAffected === 0: some other finalizer (a duplicate deferred run, or
    // a racing sweep claim) already won the pending -> terminal transition.
    // A clean no-op, never an error, never retried.
    return { outcome: "already-finalized" };
  }
  return { outcome: "finalized", status: evidenceSelection.terminalStatus };
}

/**
 * Finalizes ONE authoritative-pending report using an already-computed
 * terminal SelectiveCorpusShadowResult. Never re-runs Stage A/B. Safe to call
 * more than once for the same report (from a duplicate deferred run, a
 * racing sweep claim, or a genuine retry) — the CAS in
 * persistSelectiveCorpusAuthoritativeFinalization makes every write after the
 * first a harmless no-op.
 *
 * Failure boundary: the primary attempt (real evidence per state policy) is
 * wrapped in a try/catch. On any unexpected exception (a DB hiccup, a bug —
 * NOT the ordinary "gave-up" outcome above, which is a clean return, not a
 * throw), this function attempts exactly ONE best-effort fallback: recompute
 * and persist a real, final result with ZERO Selective Corpus evidence
 * (terminalStatus "incomplete") — the report still leaves "pending" honestly,
 * just without V4's own contribution. If that fallback ALSO fails, this
 * function gives up silently (best-effort, matches this codebase's
 * pervasive "telemetry/finalization failures never propagate" discipline)
 * and the report is deliberately left "pending" — safe, because the recovery
 * sweep (app/api/internal/selective-corpus-authoritative-sweep) is the
 * durable backstop that will retry it later. This function itself never
 * throws.
 */
export async function finalizeSelectiveCorpusAuthoritativeReport(
  client: Client,
  params: FinalizeSelectiveCorpusAuthoritativeReportParams,
): Promise<FinalizeSelectiveCorpusAuthoritativeReportResult> {
  try {
    const row = await readReportRow(client, params.reportDeviceKey, params.reportId);
    if (!row) return { outcome: "row-missing" };
    if (row.payload.selectiveCorpusAuthoritativeStatus !== "pending") {
      return { outcome: "not-pending" };
    }
    const evidenceSelection = selectSelectiveCorpusFinalizationEvidence(params.shadowResult);
    const result = await resolveAndPersist(client, params, row, evidenceSelection);
    if (result.outcome !== "gave-up") return result;
    throw new Error("selective-corpus authoritative finalization produced no unifiedSimilarity");
  } catch (err) {
    console.error(
      "finalizeSelectiveCorpusAuthoritativeReport: primary finalization attempt failed (best-effort zero-V4 fallback follows):",
      err instanceof Error ? err.message : String(err),
    );
    try {
      const row = await readReportRow(client, params.reportDeviceKey, params.reportId);
      if (!row) return { outcome: "row-missing" };
      if (row.payload.selectiveCorpusAuthoritativeStatus !== "pending") {
        return { outcome: "not-pending" };
      }
      const fallback = await resolveAndPersist(client, params, row, { evidence: null, terminalStatus: "incomplete" });
      return fallback;
    } catch (fallbackErr) {
      console.error(
        "finalizeSelectiveCorpusAuthoritativeReport: best-effort fallback ALSO failed — report remains pending, the recovery sweep will retry it later:",
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      );
      return { outcome: "gave-up" };
    }
  }
}

// ============================================================================
// Recovery sweep — atomic claim (durability backstop)
// ============================================================================

export type ClaimedSelectiveCorpusAuthoritativePendingReport = { reportDeviceKey: string; reportId: string };

export type ClaimStaleSelectiveCorpusAuthoritativePendingReportsParams = {
  openConnection: () => Client | Promise<Client>;
  batchSize?: number;
  /**
   * A pending report younger than this is presumed still genuinely in
   * flight and is never claimed as abandoned. Default 10 minutes — V4's own
   * measured Production Stage A+B totals are ~1.8-4.8s (20-document
   * promotion-gate canary), so this is a deliberately conservative floor
   * against normal serverless cold-start/latency variance, not a tight bound.
   */
  minAgeMs?: number;
  /**
   * A claim older than this is considered abandoned (the worker that made
   * it likely died mid-attempt) and becomes reclaimable by a later sweep run
   * — no permanent lease. Default 10 minutes, mirroring
   * lib/corpus-admission-report-integration.ts's own staleClaimMs
   * convention exactly.
   */
  staleClaimMs?: number;
};

const MAX_CLAIM_BUSY_RETRIES = 10;
function claimBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}
function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

/**
 * Atomically claims up to batchSize stale-pending reports inside ONE real
 * write transaction — directly modeled on
 * lib/corpus-admission-report-integration.ts's runReportAdmissionRetrySweep
 * (the already-shipped, already-proven pattern for exactly this class of
 * problem), adapted to payload_json JSON fields instead of a dedicated jobs
 * table (no migration, no new table). The select-then-claim happens entirely
 * while holding the write transaction's lock, so no other concurrent sweep
 * (in this process or a genuinely separate one) can select the same rows
 * before this transaction commits — the claim UPDATE below is therefore
 * unconditional on the exact ids the SELECT just found, exactly like the
 * reference implementation's own `WHERE id IN (...)`.
 *
 * Uses SQLite's own datetime('now', ...) for every threshold comparison
 * (never a JS-computed ISO string) — the reference implementation's own
 * comment documents a real, previously-fixed bug where an ISO string
 * lexicographically sorts before a same-day CURRENT_TIMESTAMP value
 * regardless of actual time; computing thresholds in the same format, in the
 * same database, sidesteps that whole class of mismatch.
 */
export async function claimStaleSelectiveCorpusAuthoritativePendingReports(
  params: ClaimStaleSelectiveCorpusAuthoritativePendingReportsParams,
): Promise<ClaimedSelectiveCorpusAuthoritativePendingReport[]> {
  const batchSize = params.batchSize ?? 20;
  const minAgeSeconds = Math.max(1, Math.floor((params.minAgeMs ?? 10 * 60 * 1000) / 1000));
  const staleClaimSeconds = Math.max(1, Math.floor((params.staleClaimMs ?? 10 * 60 * 1000) / 1000));
  // report_created_at is NOT a SQLite CURRENT_TIMESTAMP-style column — it is
  // always populated from the client's own `createdAt` field
  // (new Date().toISOString(), "YYYY-MM-DDTHH:MM:SS.sssZ", see
  // app/api/reports/route.ts's SAVE_REPORT_SQL), unlike
  // selectiveCorpusAuthoritativeClaimedAt below, which THIS module sets via
  // SQLite's own datetime('now') (space-separated). Comparing an ISO 'T'
  // string against a datetime('now', ...) threshold hits exactly the
  // lexicographic mismatch lib/corpus-admission-report-integration.ts's own
  // runReportAdmissionRetrySweep comment documents (' ' < 'T' in ASCII, so a
  // same-day ISO timestamp never sorts before a same-day space-separated
  // one) — it would silently make minAgeMs never trigger for any report
  // created earlier the same UTC day. Computed here as a JS ISO threshold
  // instead, so the comparison stays within one consistent format.
  const minAgeThresholdIso = new Date(Date.now() - minAgeSeconds * 1000).toISOString();

  for (let attempt = 1; attempt <= MAX_CLAIM_BUSY_RETRIES; attempt += 1) {
    const client = await params.openConnection();
    try {
      const tx = await client.transaction("write");
      try {
        const candidates = await tx.execute({
          sql: `SELECT device_key, id FROM saved_reports
                WHERE json_extract(payload_json, '$.selectiveCorpusAuthoritativeStatus') = 'pending'
                  AND report_created_at < ?
                  AND (
                    json_extract(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt') IS NULL
                    OR json_extract(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt') < datetime('now', ?)
                  )
                ORDER BY report_created_at ASC LIMIT ?`,
          args: [minAgeThresholdIso, `-${staleClaimSeconds} seconds`, batchSize],
        });
        const rows = candidates.rows as unknown as { device_key: string; id: string | number }[];
        const claimed: ClaimedSelectiveCorpusAuthoritativePendingReport[] = [];
        for (const candidate of rows) {
          const reportDeviceKey = String(candidate.device_key);
          const reportId = String(candidate.id);
          await tx.execute({
            sql: `UPDATE saved_reports
                  SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt', datetime('now'))
                  WHERE device_key = ? AND id = ?`,
            args: [reportDeviceKey, reportId],
          });
          claimed.push({ reportDeviceKey, reportId });
        }
        await tx.commit();
        return claimed;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_CLAIM_BUSY_RETRIES) {
        await claimBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      client.close();
    }
  }
  return [];
}
