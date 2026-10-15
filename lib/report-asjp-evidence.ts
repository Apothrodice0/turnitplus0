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
  parseAsjpEvidenceRecord,
  retryUnavailableAsjpRecord,
  type AsjpPersistedEvidence,
} from "./asjp-report-evidence";

/**
 * ASJP (Phase 6.5, LOCAL PROTOTYPE) — FAILURE RECOVERY for a report whose upload-time ASJP check was UNAVAILABLE
 * (service down, busy, timed out, wrong generation, …). The report was saved and scored without ASJP and says so
 * ("ASJP check unavailable"). This retries the check ONCE per call and, only when the new answer is ACCEPTED, lands —
 * in ONE atomic compare-and-set statement — the new record, the recomputed score (the same shared resolver, fed the
 * new record) AND its rebuilt explanation (C2: a score is never persisted without its interpretation). The CAS is on
 * the UNAVAILABLE record's own checkedAt, so concurrent retries land at most one result, and the usual generation /
 * scoring-normalization guards still apply.
 *   - An ACCEPTED record is never retried or replaced: a saved report's ASJP evidence is final.
 *   - A Selective-Corpus-authoritative report: "pending" gets only the new record (its finalizer, which reads the
 *     record, computes the one final score); "completed" / "incomplete" are immutable and never retried.
 *   - Retries stop after `maxAttempts` (an UNAVAILABLE retry only bumps the attempt count).
 * Never throws; a failure leaves the row exactly as it was.
 */
export type AsjpRetryOutcome =
  | { outcome: "NOT_ELIGIBLE"; reason: string }
  | { outcome: "STILL_UNAVAILABLE"; reason: string | null; attempts: number }
  | { outcome: "ACCEPTED"; scoreWritten: boolean }
  | { outcome: "LOST_RACE" }
  | { outcome: "FAILED"; reason: string };

const GUARDS = `json_valid(payload_json)
  AND json_extract(payload_json, '$.asjpEvidence.status') = 'UNAVAILABLE'
  AND json_extract(payload_json, '$.asjpEvidence.checkedAt') = ?`;

export async function retryAsjpEvidenceForReport(
  client: Client,
  params: { reportDeviceKey: string; reportId: string; accountId: string | null; maxAttempts?: number },
  check: (input: { text: string; wordCount: number }, attempts: number) => Promise<AsjpPersistedEvidence | null> = (input, attempts) => checkAsjpForReport(input, asjpReportClientConfig(), undefined, attempts),
): Promise<AsjpRetryOutcome> {
  try {
    const row = await client.execute({ sql: "SELECT payload_json, archive_score FROM saved_reports WHERE device_key = ? AND id = ?", args: [params.reportDeviceKey, params.reportId] });
    const raw = row.rows[0] as unknown as { payload_json: string; archive_score: number | bigint } | undefined;
    if (!raw) return { outcome: "NOT_ELIGIBLE", reason: "NO_REPORT" };
    const decoded = tryDecodeReportFromPersistence(JSON.parse(String(raw.payload_json)), { requireContributions: false });
    if (!decoded.ok) return { outcome: "NOT_ELIGIBLE", reason: "UNREADABLE_REPORT" };
    const payload = decoded.report as SimilarityReport;
    const record = parseAsjpEvidenceRecord(payload.asjpEvidence);
    if (!record || record.status !== "UNAVAILABLE") return { outcome: "NOT_ELIGIBLE", reason: record ? "ALREADY_ACCEPTED" : "NO_ASJP_RECORD" };
    const selective = payload.selectiveCorpusAuthoritativeStatus ?? null;
    if (selective === "completed" || selective === "incomplete") return { outcome: "NOT_ELIGIBLE", reason: "SELECTIVE_FINAL_IMMUTABLE" };
    if (typeof payload.text !== "string" || !payload.text) return { outcome: "NOT_ELIGIBLE", reason: "NO_TEXT" };

    const next = await retryUnavailableAsjpRecord(record, { text: payload.text, wordCount: payload.wordCount }, (attempts) => check({ text: payload.text, wordCount: payload.wordCount }, attempts), params.maxAttempts ?? 3);
    if (!next) return { outcome: "NOT_ELIGIBLE", reason: "ATTEMPTS_EXHAUSTED_OR_MISMATCH" };

    if (next.status !== "ACCEPTED" || selective === "pending") {
      // record only: a still-UNAVAILABLE retry (attempts + reason), or a pending report its finalizer will score
      const written = await client.execute({
        sql: `UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ? AND ${GUARDS}`,
        args: [JSON.stringify(next), params.reportDeviceKey, params.reportId, record.checkedAt],
      });
      if (Number(written.rowsAffected) === 0) return { outcome: "LOST_RACE" };
      return next.status === "ACCEPTED" ? { outcome: "ACCEPTED", scoreWritten: false } : { outcome: "STILL_UNAVAILABLE", reason: next.reason, attempts: next.attempts };
    }

    // ACCEPTED: recompute through the ONE shared resolver with the new record, rebuild the explanation from that final
    // report, and land record + score + explanation together
    const scoringNormalizationVersion = reportScoringNormalizationVersion(payload);
    const verifiedAcademicEvidence = (await resolveVerifiedAcademicEvidence(client, {
      diagnosticsId: typeof payload.verifiedAcademicSearchDiagnosticsId === "number" && Number.isFinite(payload.verifiedAcademicSearchDiagnosticsId) ? payload.verifiedAcademicSearchDiagnosticsId : null,
      submissionCanonicalSha256: canonicalSha256(payload.text),
      scoringNormalizationVersion,
    })).evidence;
    const resolution = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: params.reportDeviceKey, reportId: params.reportId, accountId: params.accountId,
      rawText: payload.text, wordCount: payload.wordCount, archiveMatchedPositions: payload.archiveMatchedPositions,
      scoringNormalizationVersion, externalAcademicEvidence: verifiedAcademicEvidence,
      asjpReportEvidence: next,
      archiveScore: payload.archiveScore ?? payload.score ?? Number(raw.archive_score),
    });
    if (!resolution.unifiedSimilarity) return { outcome: "FAILED", reason: "RESOLUTION_FAILED" };
    const finalReport = { ...payload, asjpEvidence: next, unifiedSimilarity: resolution.unifiedSimilarity } as SimilarityReport;
    const interpretation = buildFinalizedReportEvidenceInterpretation(finalReport, { historicalSubmissionMatch: resolution.historicalSubmissionMatch });
    if (!interpretation.ok) return { outcome: "FAILED", reason: interpretation.reason };
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
            WHERE device_key = ? AND id = ? AND ${GUARDS}
              AND COALESCE(json_extract(payload_json, '$.unifiedSimilarityGeneration'), -1) <= ?
              AND COALESCE(json_extract(payload_json, '$.scoringNormalizationVersion'), 1) = ?
              AND json_extract(payload_json, '$.selectiveCorpusAuthoritativeStatus') IS NULL`,
      args: [
        JSON.stringify(next),
        JSON.stringify(compactUnifiedSimilarityForPersistence(resolution.unifiedSimilarity, { compactWrites: interpretation.compactWrites })),
        JSON.stringify(interpretation.evidenceInterpretation),
        resolution.corpusSourceMatchingEnabled ? "true" : "false",
        resolution.corpusGeneration,
        params.reportDeviceKey, params.reportId, record.checkedAt,
        resolution.corpusGeneration, scoringNormalizationVersion,
      ],
    });
    if (Number(written.rowsAffected) === 0) return { outcome: "LOST_RACE" };
    return { outcome: "ACCEPTED", scoreWritten: true };
  } catch (error) {
    console.error("retryAsjpEvidenceForReport failed (non-fatal — the report is unchanged):", error instanceof Error ? error.message : String(error));
    return { outcome: "FAILED", reason: "EXCEPTION" };
  }
}
