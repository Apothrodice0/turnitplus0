import type { Client } from "@libsql/client";
import { reportScoringNormalizationVersion } from "./similarity-core";
import { resolvePrimarySimilaritySummary } from "./report-primary-similarity";
import { resolveVerifiedAcademicEvidence } from "./academic-search-diagnostics-repo";
import { buildFinalizedReportEvidenceInterpretation } from "./report-evidence-interpretation";
import { compactUnifiedSimilarityForPersistence } from "./unified-similarity-persistence";
import { tryDecodeReportFromPersistence } from "./report-persistence";
import { canonicalSha256 } from "./document-identity";
import type { SimilarityReport } from "./report-types";
import {
  asjpReportClientConfig,
  checkAsjpForReport,
  retryUnavailableAsjpRecord,
  signAsjpRecord,
  trustedAsjpRecord,
  asjpKeyring,
  asjpWithdrawnOf,
  normalizeWithdrawn,
  type AsjpPersistedEvidence,
} from "./asjp-report-evidence";

/**
 * ASJP (Phase 6.5, LOCAL PROTOTYPE) — the two explicit ways a SAVED report's ASJP evidence may change. Both land — in
 * ONE atomic compare-and-set statement — the new signed record, the recomputed score (the same shared resolver, fed
 * the new record) AND its rebuilt explanation (C2: a score is never persisted without its interpretation). The CAS is
 * on the record's own checkedAt as read, so concurrent writers land at most one result, and the usual generation /
 * scoring-normalization guards apply.
 *
 *   retryAsjpEvidenceForReport    an UNAVAILABLE record (service down, busy, timed out, wrong generation, …) is retried
 *                                 once per call; only an ACCEPTED answer changes the score (an UNAVAILABLE retry only
 *                                 records the attempt). Retries stop after maxAttempts. NOT WIRED to any route or job.
 *   retractAsjpEvidenceForReport  an ACCEPTED record is withdrawn (rollback, takedown of a cited article): the record
 *                                 becomes RETRACTED and the score + explanation are recomputed without it. With
 *                                 `sourceIds` (B3, per-article takedown) only those articles' cards are removed and the
 *                                 record stays ACCEPTED for the rest. EITHER WAY the withdrawn articles are listed in the
 *                                 record (withdrawnSourceIds): no later save of this report — a changed manuscript, a
 *                                 revert, a retry — ever credits them again (they are excluded at the service and here).
 *
 * TAKEDOWN RUNBOOK (B3). A per-report retraction is the BACKFILL for reports already saved. The takedown itself is
 * index-level, so no new report can credit the article: (1) mark the article withdrawn in the service catalog and
 * /admin/refresh (the lane never credits a withdrawn article), and (2) add it to ASJP_WITHDRAWN_SOURCE_IDS in the app
 * environment (excluded from every new record, belt and braces), then (3) retract it from the saved reports that cite it.
 * A report shows how many articles were withdrawn from it; their words are no longer highlighted or scored.
 *
 * Eligibility (review findings 2 and 4): only reports the ordinary finalization owns — never a Selective-Corpus-
 * authoritative report (pending, completed or incomplete: its finalizer owns the score) and never one whose score
 * includes server-verified user-supplied references (the shared resolver call here does not carry that channel, so a
 * recompute would drop it). Such reports are reported NOT_ELIGIBLE and left unchanged for a human decision.
 * Never throws; a failure leaves the row exactly as it was.
 */
export type AsjpRewriteOutcome =
  | { outcome: "NOT_ELIGIBLE"; reason: string }
  | { outcome: "STILL_UNAVAILABLE"; reason: string | null; attempts: number }
  | { outcome: "ACCEPTED"; scoreWritten: boolean }
  | { outcome: "RETRACTED" }
  | { outcome: "LOST_RACE" }
  | { outcome: "FAILED"; reason: string };
/** @deprecated name kept for the Phase 6.5 tests */
export type AsjpRetryOutcome = AsjpRewriteOutcome;

const CAS = `json_valid(payload_json)
  AND json_extract(payload_json, '$.asjpEvidence.checkedAt') = ?
  AND json_extract(payload_json, '$.asjpEvidence.status') = ?
  AND json_extract(payload_json, '$.selectiveCorpusAuthoritativeStatus') IS NULL`;

type Loaded = { payload: SimilarityReport; archiveScore: number; record: AsjpPersistedEvidence; binding: { reportDeviceKey: string; reportId: string; accountId: string | null } };
async function loadEligible(client: Client, params: { reportDeviceKey: string; reportId: string }): Promise<Loaded | { outcome: "NOT_ELIGIBLE"; reason: string }> {
  const row = await client.execute({ sql: "SELECT payload_json, archive_score, user_id FROM saved_reports WHERE device_key = ? AND id = ?", args: [params.reportDeviceKey, params.reportId] });
  const raw = row.rows[0] as unknown as { payload_json: string; archive_score: number | bigint; user_id: string | null } | undefined;
  if (!raw) return { outcome: "NOT_ELIGIBLE", reason: "NO_REPORT" };
  // the record is bound to the report's OWN owner (never the caller's claim)
  const binding = { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId, accountId: raw.user_id ?? null };
  const decoded = tryDecodeReportFromPersistence(JSON.parse(String(raw.payload_json)), { requireContributions: false });
  if (!decoded.ok) return { outcome: "NOT_ELIGIBLE", reason: "UNREADABLE_REPORT" };
  const payload = decoded.report as SimilarityReport;
  if (payload.selectiveCorpusAuthoritativeStatus != null) return { outcome: "NOT_ELIGIBLE", reason: "SELECTIVE_CORPUS_OWNED" };
  if ((payload.userSuppliedReferenceEvidence ?? []).some((r) => r?.admitted)) return { outcome: "NOT_ELIGIBLE", reason: "HAS_SUPPLIED_REFERENCES" };
  if (typeof payload.text !== "string" || !payload.text) return { outcome: "NOT_ELIGIBLE", reason: "NO_TEXT" };
  const record = trustedAsjpRecord(payload.asjpEvidence, binding);
  if (!record) return { outcome: "NOT_ELIGIBLE", reason: payload.asjpEvidence ? "UNVERIFIED_RECORD" : "NO_ASJP_RECORD" };
  return { payload, archiveScore: Number(raw.archive_score), record, binding };
}

/** Lands `next` (unsigned) for the report, recomputing score + explanation with it, CAS on `prev`. */
async function rewriteWithScore(client: Client, params: { reportDeviceKey: string; reportId: string; accountId: string | null }, loaded: Loaded, next: AsjpPersistedEvidence): Promise<"WRITTEN" | "LOST_RACE" | { failed: string }> {
  const { payload, record } = loaded;
  const signed = signAsjpRecord(next, loaded.binding, asjpKeyring());
  const scoringNormalizationVersion = reportScoringNormalizationVersion(payload);
  const verifiedAcademicEvidence = (await resolveVerifiedAcademicEvidence(client, {
    diagnosticsId: typeof payload.verifiedAcademicSearchDiagnosticsId === "number" && Number.isFinite(payload.verifiedAcademicSearchDiagnosticsId) ? payload.verifiedAcademicSearchDiagnosticsId : null,
    submissionCanonicalSha256: canonicalSha256(payload.text),
    scoringNormalizationVersion,
  })).evidence;
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: params.reportDeviceKey, reportId: params.reportId, accountId: loaded.binding.accountId,
    rawText: payload.text, wordCount: payload.wordCount, archiveMatchedPositions: payload.archiveMatchedPositions,
    scoringNormalizationVersion, externalAcademicEvidence: verifiedAcademicEvidence,
    asjpReportEvidence: signed,
    archiveScore: payload.archiveScore ?? payload.score ?? loaded.archiveScore,
  });
  if (!resolution.unifiedSimilarity) return { failed: "RESOLUTION_FAILED" };
  const finalReport = { ...payload, asjpEvidence: signed, unifiedSimilarity: resolution.unifiedSimilarity } as SimilarityReport;
  const interpretation = buildFinalizedReportEvidenceInterpretation(finalReport, { historicalSubmissionMatch: resolution.historicalSubmissionMatch });
  if (!interpretation.ok) return { failed: interpretation.reason };
  // ASJP retry / retraction writer (reviewed): the persisted forms follow the mode buildFinalizedReportEvidenceInterpretation
  // resolved and measured, exactly like the Selective finalizer's write
  const written = await client.execute({
    sql: `UPDATE saved_reports
          SET payload_json = json_set(
                payload_json,
                '$.asjpEvidence', json(?),
                '$.unifiedSimilarity', json(?),
                '$.evidenceInterpretation', json(?),
                '$.corpusSourceMatchingEnabledAtComputation', json(?),
                '$.unifiedSimilarityGeneration', ?,
                '$.unifiedSimilarityFailed', json('false')
              )
          WHERE device_key = ? AND id = ? AND ${CAS}
            AND COALESCE(json_extract(payload_json, '$.unifiedSimilarityGeneration'), -1) <= ?
            AND COALESCE(json_extract(payload_json, '$.scoringNormalizationVersion'), 1) = ?`,
    args: [
      JSON.stringify(signed),
      JSON.stringify(compactUnifiedSimilarityForPersistence(resolution.unifiedSimilarity, { compactWrites: interpretation.compactWrites })),
      JSON.stringify(interpretation.evidenceInterpretation),
      resolution.corpusSourceMatchingEnabled ? "true" : "false",
      resolution.corpusGeneration,
      params.reportDeviceKey, params.reportId, record.checkedAt, record.status,
      resolution.corpusGeneration, scoringNormalizationVersion,
    ],
  });
  return Number(written.rowsAffected) > 0 ? "WRITTEN" : "LOST_RACE";
}

export async function retryAsjpEvidenceForReport(
  client: Client,
  params: { reportDeviceKey: string; reportId: string; accountId: string | null; maxAttempts?: number },
  check: (input: { text: string; wordCount: number }, attempts: number, withdrawn: string[]) => Promise<AsjpPersistedEvidence | null> = (input, attempts, withdrawn) => checkAsjpForReport(input, asjpReportClientConfig(), undefined, attempts, undefined, withdrawn),
): Promise<AsjpRewriteOutcome> {
  try {
    const loaded = await loadEligible(client, params);
    if ("outcome" in loaded) return loaded;
    const { payload, record } = loaded;
    if (record.status !== "UNAVAILABLE") return { outcome: "NOT_ELIGIBLE", reason: record.status === "ACCEPTED" ? "ALREADY_ACCEPTED" : record.status };
    // B3: a retry never credits an article already withdrawn from this report
    const withdrawn = asjpWithdrawnOf(record);
    const next = await retryUnavailableAsjpRecord(record, { text: payload.text, wordCount: payload.wordCount }, (attempts) => check({ text: payload.text, wordCount: payload.wordCount }, attempts, withdrawn), params.maxAttempts ?? 3);
    if (!next) return { outcome: "NOT_ELIGIBLE", reason: "ATTEMPTS_EXHAUSTED_OR_MISMATCH" };
    if (next.status !== "ACCEPTED") {
      // still unavailable: only the attempt is recorded (score unchanged — it never had ASJP)
      const written = await client.execute({
        sql: `UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ? AND ${CAS}`,
        args: [JSON.stringify(signAsjpRecord(next, loaded.binding, asjpKeyring())), params.reportDeviceKey, params.reportId, record.checkedAt, record.status],
      });
      return Number(written.rowsAffected) === 0 ? { outcome: "LOST_RACE" } : { outcome: "STILL_UNAVAILABLE", reason: next.reason, attempts: next.attempts };
    }
    const result = await rewriteWithScore(client, params, loaded, next);
    if (result === "LOST_RACE") return { outcome: "LOST_RACE" };
    if (typeof result === "object") return { outcome: "FAILED", reason: result.failed };
    return { outcome: "ACCEPTED", scoreWritten: true };
  } catch (error) {
    console.error("retryAsjpEvidenceForReport failed (non-fatal — the report is unchanged):", error instanceof Error ? error.message : String(error));
    return { outcome: "FAILED", reason: "EXCEPTION" };
  }
}

/** Review finding 7 — the per-report kill switch / takedown: an ACCEPTED record becomes RETRACTED and the score loses it. */
export async function retractAsjpEvidenceForReport(
  client: Client,
  params: { reportDeviceKey: string; reportId: string; accountId: string | null; reason: string; sourceIds?: string[] },
): Promise<AsjpRewriteOutcome> {
  try {
    const loaded = await loadEligible(client, params);
    if ("outcome" in loaded) return loaded;
    if (loaded.record.status !== "ACCEPTED") return { outcome: "NOT_ELIGIBLE", reason: `NOT_ACCEPTED:${loaded.record.status}` };
    const { signature: _old, keyId: _oldId, ...base } = loaded.record;
    const reason = String(params.reason).replace(/[^A-Za-z0-9_:-]/g, "").slice(0, 64) || "RETRACTED";
    const targets = params.sourceIds === undefined ? null : normalizeWithdrawn(params.sourceIds);
    if (targets !== null && targets.length === 0) return { outcome: "NOT_ELIGIBLE", reason: "NO_VALID_SOURCE_IDS" };
    // B3: the withdrawn articles are recorded (sticky): the whole record's articles, or only the named ones
    const withdrawnSourceIds = normalizeWithdrawn([...(base.withdrawnSourceIds ?? []), ...(targets ?? base.cards.map((c) => c.sourceId))]);
    const gone = new Set(withdrawnSourceIds);
    const next: AsjpPersistedEvidence = targets === null
      ? { ...base, status: "RETRACTED", reason, checkedAt: new Date().toISOString(), withdrawnSourceIds }
      : {
          ...base, checkedAt: new Date().toISOString(), withdrawnSourceIds, cards: base.cards.filter((c) => !gone.has(c.sourceId)),
          ...(base.research ? { research: { shortPassages: { ...base.research.shortPassages, passages: base.research.shortPassages.passages.filter((p) => !gone.has(p.sourceId)) } } } : {}),
        };
    const result = await rewriteWithScore(client, params, loaded, next);
    if (result === "LOST_RACE") return { outcome: "LOST_RACE" };
    if (typeof result === "object") return { outcome: "FAILED", reason: result.failed };
    return { outcome: "RETRACTED" };
  } catch (error) {
    console.error("retractAsjpEvidenceForReport failed (non-fatal — the report is unchanged):", error instanceof Error ? error.message : String(error));
    return { outcome: "FAILED", reason: "EXCEPTION" };
  }
}
