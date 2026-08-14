import type { Client } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCHER_VERSION } from "./user-submission-matching";
import { CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION } from "./user-submission-corpus";
import { canonicalSha256, findPriorSubmissionsForAccount } from "./document-identity";
import type { ReportHistoricalSubmissionMatch, HistoricalSubmissionMatchEntry } from "./report-types";

/**
 * Phase E8C bridge layer: turns a saved report's raw text + viewing account
 * into the ReportHistoricalSubmissionMatch snapshot attached to it as
 * SimilarityReport.historicalSubmissionMatch — the same role
 * lib/report-classification.ts plays for Phase D's matchClassification, but
 * backed by Phase E8A/E8B's corpus/matcher instead of Phase B's family
 * system. This is the only module that knows about both "reports" and
 * "the user submission corpus" — lib/user-submission-matching.ts stays
 * unaware of the report shape, exactly as lib/document-family.ts does for
 * Phase D.
 *
 * Deliberately never touches SimilarityReport.score/archiveScore, never
 * imports lib/provenance-verification-workflow.ts, never imports any E7
 * module (the 230-document historical evaluation corpus stays a separate
 * dataset), and never calls ASJP/Crossref discovery — see
 * tests/report-historical-match.test.mjs's structural checks.
 *
 * Snapshot/staleness model (this phase's own task description, section 14):
 * report_historical_match_snapshots holds exactly one row per report,
 * upserted on recompute. A stored snapshot is reused as-is when its three
 * version tags (matcher/fingerprint/canonicalization) all equal the
 * CURRENT_VERSIONS below; if any differ (or no snapshot exists yet), a
 * fresh computation runs and overwrites it via INSERT ... ON CONFLICT DO
 * UPDATE — atomic, so two simultaneous requests computing the same stale
 * snapshot race harmlessly to the same eventually-consistent row (this
 * phase's own task description, section 15) rather than needing a lock
 * table. A computation failure is itself persisted as status "FAILED" (never
 * thrown past this function) so a permanently-failing document does not get
 * recomputed on every single report view.
 *
 * Phase E8E fix: a cached "NO_HISTORICAL_MATCH" row is the one exception —
 * it is never reused, even with current version tags. Phase E8D activated
 * save-time indexing via a genuinely deferred after() callback in
 * production, so a report can legitimately be viewed for the first time
 * before another account's earlier upload has finished indexing; the very
 * first view would then compute and permanently cache NO_HISTORICAL_MATCH,
 * silently hiding a real PRIOR_SUBMISSION/SELF match that only exists a
 * moment later — version tags never change to invalidate it, since nothing
 * about the matcher/fingerprint/canonicalization changed, only the corpus's
 * contents did. A "MATCHED" result cannot go stale this same way (new
 * corpus content cannot make an existing match disappear), so it is still
 * cached as before; only the empty-result case is always recomputed.
 */

const CURRENT_VERSIONS = {
  matcherVersion: USER_SUBMISSION_MATCHER_VERSION,
  fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
  canonicalizationVersion: CANONICALIZATION_VERSION,
};

type SnapshotRow = {
  status: string;
  matcher_version: string | null;
  fingerprint_version: string | null;
  canonicalization_version: string | null;
  result_json: string | null;
  candidate_count: number | null;
  processing_duration_ms: number | null;
  error_message: string | null;
  computed_at: string;
};

function isCurrentVersion(row: SnapshotRow): boolean {
  return (
    row.matcher_version === CURRENT_VERSIONS.matcherVersion &&
    row.fingerprint_version === CURRENT_VERSIONS.fingerprintVersion &&
    row.canonicalization_version === CURRENT_VERSIONS.canonicalizationVersion
  );
}

function rowToResult(row: SnapshotRow): ReportHistoricalSubmissionMatch {
  const base = {
    computedAt: row.computed_at,
    matcherVersion: row.matcher_version ?? CURRENT_VERSIONS.matcherVersion,
    fingerprintVersion: row.fingerprint_version ?? CURRENT_VERSIONS.fingerprintVersion,
    canonicalizationVersion: row.canonicalization_version ?? CURRENT_VERSIONS.canonicalizationVersion,
  };
  if (row.status === "MATCHED") {
    return { ...base, status: "MATCHED", matches: row.result_json ? (JSON.parse(row.result_json) as HistoricalSubmissionMatchEntry[]) : [] };
  }
  if (row.status === "FAILED") {
    return { ...base, status: "UNAVAILABLE" };
  }
  return { ...base, status: "NO_HISTORICAL_MATCH" };
}

/** Only the fields this file ever persists — see report-types.ts's own comment on why externalWordStart and per-entry version tags are dropped. */
function serializeMatchesForStorage(matches: Array<{
  relationshipType: string;
  matchedRepresentationId: string;
  matchType: string;
  containment: number;
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
  passages: Array<{ submittedText: string; submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
  historicalSubmissionCount: number;
}>): HistoricalSubmissionMatchEntry[] {
  return matches.map((m) => ({
    relationshipType: m.relationshipType as HistoricalSubmissionMatchEntry["relationshipType"],
    matchedRepresentationId: m.matchedRepresentationId,
    matchType: m.matchType as HistoricalSubmissionMatchEntry["matchType"],
    containment: m.containment,
    matchedWordCount: m.matchedWordCount,
    passageCount: m.passageCount,
    longestMatchWords: m.longestMatchWords,
    passages: m.passages.map((p) => ({
      submittedText: p.submittedText,
      submittedWordStart: p.submittedWordStart,
      submittedWordEnd: p.submittedWordEnd,
      matchedWordCount: p.matchedWordCount,
    })),
    historicalSubmissionCount: m.historicalSubmissionCount,
  }));
}

/**
 * Returns the current historical-match snapshot for one saved report,
 * computing and persisting it first if missing or stale. Never throws — a
 * computation failure is caught, persisted as status "FAILED", and returned
 * as { status: "UNAVAILABLE" } so a caller can render the report normally
 * either way (this phase's own task description, section 13). accountId may
 * be null (anonymous report) — passed straight through to
 * matchAgainstUserSubmissionCorpus, which already reports
 * UNKNOWN_RELATIONSHIP rather than guessing SELF in that case (Phase E8B);
 * this function does not special-case anonymity beyond that.
 */
export async function getOrComputeHistoricalMatchSnapshot(
  client: Client,
  params: { reportDeviceKey: string; reportId: string; accountId: string | null; rawText: string },
): Promise<ReportHistoricalSubmissionMatch> {
  const existing = await client.execute({
    sql: `SELECT status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at
          FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?`,
    args: [params.reportDeviceKey, params.reportId],
  });
  const existingRow = existing.rows[0] as unknown as SnapshotRow | undefined;
  // See this file's own header comment (Phase E8E fix): NO_HISTORICAL_MATCH
  // is never treated as final, even with current version tags, because it
  // can be invalidated by new corpus content arriving after it was cached —
  // something version tags alone cannot detect.
  if (existingRow && isCurrentVersion(existingRow) && existingRow.status !== "NO_HISTORICAL_MATCH") {
    return rowToResult(existingRow);
  }

  const startedAt = Date.now();
  let status: "MATCHED" | "NO_HISTORICAL_MATCH" | "FAILED";
  let resultJson: string | null = null;
  let candidateCount: number | null = null;
  let errorMessage: string | null = null;

  try {
    const canonicalText = canonicalizeText(params.rawText);
    // Phase E8D: now that save-time indexing is live, this exact report's
    // own submission is typically already present in the corpus under
    // params.accountId by the time this ever runs — matchAgainstUserSubmissionCorpus's
    // own documentIdentityId parameter exists precisely for this ("relevant
    // only if the caller already indexed this exact submission into the
    // corpus before calling this function" — see that file's own comment).
    // Before E8D this was genuinely unreachable (nothing indexed the
    // current submission before its own report was ever viewed), so
    // omitting it was harmless; leaving it omitted now would make every
    // signed-in viewer's own representation membership look like a SELF
    // match against itself, even for another account's prior content. The
    // exact document_identities row is not stored on saved_reports (no
    // schema change here), so this picks the account's own most recent
    // identity row for this canonical hash — sufficient because excluding
    // any one of an account's own rows from ownership counting still
    // leaves a genuine repeat's earlier row counted, and leaves nothing
    // counted when this is that account's only submission of the content.
    const ownIdentities = params.accountId ? await findPriorSubmissionsForAccount(client, params.accountId, canonicalSha256(params.rawText)) : [];
    const documentIdentityId = ownIdentities.length > 0 ? ownIdentities[ownIdentities.length - 1].id : null;
    const matchResult = await matchAgainstUserSubmissionCorpus(client, { accountId: params.accountId, documentIdentityId, canonicalText });
    if (matchResult.status === "MATCHED") {
      status = "MATCHED";
      const serialized = serializeMatchesForStorage(matchResult.matches);
      resultJson = JSON.stringify(serialized);
      candidateCount = serialized.length;
    } else {
      status = "NO_HISTORICAL_MATCH";
    }
  } catch (error) {
    status = "FAILED";
    errorMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const processingDurationMs = Date.now() - startedAt;
  const computedAt = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(report_device_key, report_id) DO UPDATE SET
            status = excluded.status,
            matcher_version = excluded.matcher_version,
            fingerprint_version = excluded.fingerprint_version,
            canonicalization_version = excluded.canonicalization_version,
            result_json = excluded.result_json,
            candidate_count = excluded.candidate_count,
            processing_duration_ms = excluded.processing_duration_ms,
            error_message = excluded.error_message,
            computed_at = excluded.computed_at`,
    args: [
      params.reportDeviceKey,
      params.reportId,
      status,
      CURRENT_VERSIONS.matcherVersion,
      CURRENT_VERSIONS.fingerprintVersion,
      CURRENT_VERSIONS.canonicalizationVersion,
      resultJson,
      candidateCount,
      processingDurationMs,
      errorMessage,
      computedAt,
    ],
  });

  return rowToResult({
    status,
    matcher_version: CURRENT_VERSIONS.matcherVersion,
    fingerprint_version: CURRENT_VERSIONS.fingerprintVersion,
    canonicalization_version: CURRENT_VERSIONS.canonicalizationVersion,
    result_json: resultJson,
    candidate_count: candidateCount,
    processing_duration_ms: processingDurationMs,
    error_message: errorMessage,
    computed_at: computedAt,
  });
}

/** Deletes a report's historical-match snapshot, if any — see db/schema.ts's own comment on why this is an explicit application-level cascade rather than a DB-level FOREIGN KEY ... ON DELETE CASCADE. Called from app/api/reports/[id]/route.ts's DELETE handler, in the same request that deletes the report itself. */
export async function deleteHistoricalMatchSnapshot(client: Client, params: { reportDeviceKey: string; reportId: string }): Promise<void> {
  await client.execute({
    sql: "DELETE FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [params.reportDeviceKey, params.reportId],
  });
}
