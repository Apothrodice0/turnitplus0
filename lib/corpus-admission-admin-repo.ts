import type { Client } from "@libsql/client";
import { getSweepRunRecords, type SweepKind, type SweepRunStatus } from "./corpus-admission-sweep-state";

/**
 * Data-access layer for the admin-only corpus-admission dashboard
 * (app/admin/corpus/*, app/api/admin/corpus/*). Every function here reads
 * across every account's admitted/pending/rejected content — callers MUST
 * gate every one of these behind lib/auth-session.ts's
 * getAdminSessionUser()/getAdminSessionUserByToken() first, exactly like
 * lib/developer-repo.ts's own documented contract (this module performs no
 * authorization check of its own).
 *
 * A "row" here is either:
 *  - a corpus_admission_decisions row (an evaluation that actually
 *    completed — ACCEPT/REVIEW/REJECT), optionally joined to the
 *    corpus_admission_report_jobs row that produced it (absent if the
 *    source report was since deleted — accepted content survives that, see
 *    lib/corpus-admission-report-integration.ts's own header comment — or
 *    if this decision came from a non-live caller with no job at all), or
 *  - a corpus_admission_report_jobs row with NO decision yet
 *    (pending/failed/cancelled) — nothing to join to.
 * These are two different row universes with no shared primary key, so
 * every row carries a synthetic id ("decision:<id>" or "job:<id>") that
 * getCorpusAdmissionDecisionDetail can parse back apart — see its own
 * comment.
 */

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export type CorpusAdmissionAdminStatus = "pending" | "failed" | "cancelled" | "accepted" | "review" | "rejected";

export type CorpusAdmissionAdminListRow = {
  rowId: string; // "decision:<id>" | "job:<id>"
  status: CorpusAdmissionAdminStatus;
  decision: "ACCEPT" | "REVIEW" | "REJECT" | null;
  detectedLanguage: string | null;
  extractedWordCount: number | null;
  qualityScore: number | null;
  accountId: string | null;
  /** Resolved via the same users.email-by-account_id lookup getCorpusAdmissionDecisionDetail uses — batched into the list query itself (a LEFT JOIN, not a per-row lookup) rather than a second identity-resolution mechanism. null when there is no account_id, or no matching users row. */
  accountEmail: string | null;
  attemptCount: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** null when this decision was never ACCEPTed (or has no job/decision at all) — promotion never applies. See lib/corpus-admission-promotion.ts. */
  promotionStatus: "staged" | "indexed" | "failed" | "skipped" | "dead_lettered" | null;
  /** B1C: null under the same conditions as promotionStatus — the current completed-attempt count, distinguishing a retryable 'failed' row from one that has reached MAX_PROMOTION_ATTEMPTS. */
  promotionAttemptCount: number | null;
  /** null when this decision has no accepted fingerprint at all (never ACCEPTed, or ACCEPTed with no corpus_admission_accepted_representations row). Drives the admin dashboard's Remove/Removed affordance — see lib/corpus-admission-admin-actions.ts's deactivateAcceptedRepresentation. */
  acceptedRepresentationId: string | null;
  /** true = participates in "first accepted sample wins" matching; false = deactivated (revoked_at set); null when acceptedRepresentationId is null. */
  acceptedRepresentationActive: boolean | null;
};

type RawCombinedRow = {
  decision_id: string | null;
  job_id: string | null;
  decision: string | null;
  job_status: string | null;
  detected_language: string | null;
  extracted_word_count: number | null;
  quality_score: number | null;
  account_id: string | null;
  account_email: string | null;
  attempt_count: number | bigint | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  promotion_status: string | null;
  promotion_attempt_count: number | bigint | null;
  accepted_representation_id: string | null;
  accepted_representation_revoked_at: string | null;
};

function deriveStatus(decision: string | null, jobStatus: string | null): CorpusAdmissionAdminStatus {
  if (jobStatus === "pending") return "pending";
  if (jobStatus === "failed") return "failed";
  if (jobStatus === "cancelled") return "cancelled";
  if (decision === "ACCEPT") return "accepted";
  if (decision === "REVIEW") return "review";
  if (decision === "REJECT") return "rejected";
  // Unreachable given the CTE's own construction (every row is one of the
  // above) — never silently misrepresent an unexpected combination as a
  // real status.
  throw new Error(`deriveStatus: unrecognized combination decision=${decision} jobStatus=${jobStatus}`);
}

function toListRow(row: RawCombinedRow): CorpusAdmissionAdminListRow {
  const rowId = row.decision_id ? `decision:${row.decision_id}` : `job:${row.job_id}`;
  return {
    rowId,
    status: deriveStatus(row.decision, row.job_status),
    decision: row.decision as CorpusAdmissionAdminListRow["decision"],
    detectedLanguage: row.detected_language,
    extractedWordCount: row.extracted_word_count === null ? null : Number(row.extracted_word_count),
    qualityScore: row.quality_score,
    accountId: row.account_id,
    accountEmail: row.account_email,
    attemptCount: row.attempt_count === null ? null : Number(row.attempt_count),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotionStatus: row.promotion_status as CorpusAdmissionAdminListRow["promotionStatus"],
    promotionAttemptCount: row.promotion_attempt_count === null ? null : Number(row.promotion_attempt_count),
    acceptedRepresentationId: row.accepted_representation_id,
    acceptedRepresentationActive: row.accepted_representation_id === null ? null : row.accepted_representation_revoked_at === null,
  };
}

// Shared CTE: every corpus-admission "attempt" the admin dashboard should
// ever show, decision-driven rows first (job LEFT JOINed in, absent if
// deleted), then job-only rows that never reached a decision at all.
// promotion_status is read-only, admin-dashboard-only visibility into
// lib/corpus-admission-promotion.ts's own table — never joined by anything
// outside this admin surface. accepted_representation_id/_revoked_at are the
// same read-only visibility into corpus_admission_accepted_representations
// (unique on decision_id — see drizzle/0030 — so this LEFT JOIN can never
// fan out a decision into more than one row) that drives the admin
// dashboard's own Remove/Removed affordance; deactivateAcceptedRepresentation
// remains the only thing that ever writes revoked_at.
//
// account_email: the SAME users.email-by-account_id resolution
// getCorpusAdmissionDecisionDetail performs with its own single-row lookup,
// batched here into one LEFT JOIN across the whole page rather than a
// separate per-row (N+1) lookup or a second identity-resolution mechanism.
// users.id is a primary key, so this can never fan a row out further.
const COMBINED_CTE = `
  WITH combined AS (
    SELECT
      d.id AS decision_id, j.id AS job_id, d.decision AS decision, j.status AS job_status,
      d.detected_language, d.extracted_word_count, d.quality_score,
      j.account_id, u.email AS account_email, j.attempt_count, j.last_error,
      d.created_at AS created_at, COALESCE(j.updated_at, d.created_at) AS updated_at,
      p.status AS promotion_status, p.attempt_count AS promotion_attempt_count,
      ar.id AS accepted_representation_id, ar.revoked_at AS accepted_representation_revoked_at
    FROM corpus_admission_decisions d
    LEFT JOIN corpus_admission_report_jobs j ON j.decision_id = d.id
    LEFT JOIN corpus_admission_promotions p ON p.decision_id = d.id
    LEFT JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
    LEFT JOIN users u ON u.id = j.account_id
    UNION ALL
    SELECT
      NULL, j.id, NULL, j.status,
      NULL, NULL, NULL,
      j.account_id, u.email, j.attempt_count, j.last_error,
      j.created_at, j.updated_at,
      NULL, NULL,
      NULL, NULL
    FROM corpus_admission_report_jobs j
    LEFT JOIN users u ON u.id = j.account_id
    WHERE j.decision_id IS NULL
  )
`;

export type ListCorpusAdmissionDecisionsParams = {
  status?: CorpusAdmissionAdminStatus;
  language?: string;
  /** Free-text search — matched against source_ref (which embeds account/device/report ids), reason_codes, and last_error. */
  q?: string;
  page?: number;
  pageSize?: number;
};

export type ListCorpusAdmissionDecisionsResult = {
  rows: CorpusAdmissionAdminListRow[];
  page: number;
  pageSize: number;
  totalCount: number;
};

/**
 * pageSize is always clamped server-side to MAX_PAGE_SIZE — a caller
 * (however it got past authorization) cannot request an unbounded page.
 */
export async function listCorpusAdmissionDecisions(client: Client, params: ListCorpusAdmissionDecisionsParams): Promise<ListCorpusAdmissionDecisionsResult> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE)));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (params.status) {
    // Expressed directly over the CTE's own source columns (decision /
    // job_status), not a derived-status re-check, so this stays a plain
    // indexable-ish predicate rather than a function-of-columns compare.
    switch (params.status) {
      case "pending": conditions.push("job_status = 'pending'"); break;
      case "failed": conditions.push("job_status = 'failed'"); break;
      case "cancelled": conditions.push("job_status = 'cancelled'"); break;
      case "accepted": conditions.push("decision = 'ACCEPT'"); break;
      case "review": conditions.push("decision = 'REVIEW'"); break;
      case "rejected": conditions.push("decision = 'REJECT'"); break;
    }
  }
  if (params.language) {
    conditions.push("detected_language = ?");
    args.push(params.language);
  }
  if (params.q && params.q.trim()) {
    const likePattern = `%${params.q.trim()}%`;
    conditions.push(`(
      decision_id IN (SELECT id FROM corpus_admission_decisions WHERE source_ref LIKE ? OR reason_codes LIKE ?)
      OR job_id IN (SELECT id FROM corpus_admission_report_jobs WHERE source_ref LIKE ? OR last_error LIKE ?)
    )`);
    args.push(likePattern, likePattern, likePattern, likePattern);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await client.execute({
    sql: `${COMBINED_CTE} SELECT COUNT(*) AS c FROM combined ${whereClause}`,
    args,
  });
  const totalCount = Number((countResult.rows[0] as unknown as { c: number | bigint }).c);

  const rowsResult = await client.execute({
    sql: `${COMBINED_CTE} SELECT * FROM combined ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    args: [...args, pageSize, offset],
  });

  return {
    rows: (rowsResult.rows as unknown as RawCombinedRow[]).map(toListRow),
    page,
    pageSize,
    totalCount,
  };
}

export type CorpusAdmissionAdminDetail = {
  rowId: string;
  status: CorpusAdmissionAdminStatus;
  decisionId: string | null;
  decision: "ACCEPT" | "REVIEW" | "REJECT" | null;
  policyVersion: string | null;
  reasonCodes: string[];
  hardGatePassed: boolean | null;
  hardGateFailureCodes: string[];
  detectedFormat: string | null;
  extractedWordCount: number | null;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  canonicalSha256: string | null;
  qualityScore: number | null;
  qualityModelVersion: string | null;
  componentScores: Record<string, unknown> | null;
  corpusValueScore: number | null;
  familyRelation: string | null;
  familyMatchedSourceRef: string | null;
  familyContainment: number | null;
  decisionCreatedAt: string | null;
  // Job (may be absent — see this module's own header comment).
  jobId: string | null;
  jobStatus: string | null;
  attemptCount: number | null;
  lastError: string | null;
  claimedAt: string | null;
  jobCreatedAt: string | null;
  jobUpdatedAt: string | null;
  // Source report (only resolvable when the job row still exists).
  accountId: string | null;
  accountEmail: string | null;
  deviceKey: string | null;
  reportId: string | null;
  reportStillExists: boolean;
  // Fingerprint (ACCEPT only).
  acceptedRepresentationId: string | null;
  acceptedRepresentationActive: boolean | null; // null when there is no fingerprint at all
  revokedAt: string | null;
  // Never the text itself — see lib/corpus-admission-admin-actions.ts's revealRetainedTextPreview.
  hasRetainedText: boolean;
  // Promotion into the shared matching index (lib/corpus-admission-promotion.ts) — all null when this decision was never ACCEPTed.
  promotionStatus: "staged" | "indexed" | "failed" | "skipped" | "dead_lettered" | null;
  promotionAttemptCount: number | null;
  promotionLastError: string | null;
  promotionRepresentationId: string | null;
};

type RawDetailRow = {
  decision_id: string | null;
  decision: string | null;
  policy_version: string | null;
  reason_codes: string | null;
  hard_gate_passed: number | null;
  hard_gate_failure_codes: string | null;
  detected_format: string | null;
  extracted_word_count: number | null;
  detected_language: string | null;
  language_confidence: number | null;
  canonical_sha256: string | null;
  quality_score: number | null;
  quality_model_version: string | null;
  component_scores: string | null;
  corpus_value_score: number | null;
  family_relation: string | null;
  family_matched_source_ref: string | null;
  family_containment: number | null;
  decision_created_at: string | null;
  job_id: string | null;
  job_status: string | null;
  attempt_count: number | bigint | null;
  last_error: string | null;
  claimed_at: string | null;
  job_created_at: string | null;
  job_updated_at: string | null;
  account_id: string | null;
  device_key: string | null;
  report_id: string | null;
  accepted_representation_id: string | null;
  revoked_at: string | null;
  content_store_id: string | null;
  promotion_status: string | null;
  promotion_attempt_count: number | bigint | null;
  promotion_last_error: string | null;
  promotion_representation_id: string | null;
};

const DETAIL_SELECT_BY_DECISION = `
  SELECT
    d.id AS decision_id, d.decision AS decision, d.policy_version, d.reason_codes,
    d.hard_gate_passed, d.hard_gate_failure_codes, d.detected_format, d.extracted_word_count,
    d.detected_language, d.language_confidence, d.canonical_sha256,
    d.quality_score, d.quality_model_version, d.component_scores, d.corpus_value_score,
    d.family_relation, d.family_matched_source_ref, d.family_containment,
    d.created_at AS decision_created_at,
    j.id AS job_id, j.status AS job_status, j.attempt_count, j.last_error, j.claimed_at,
    j.created_at AS job_created_at, j.updated_at AS job_updated_at,
    j.account_id, j.device_key, j.report_id,
    ar.id AS accepted_representation_id, ar.revoked_at,
    cs.id AS content_store_id,
    p.status AS promotion_status, p.attempt_count AS promotion_attempt_count, p.last_error AS promotion_last_error, p.representation_id AS promotion_representation_id
  FROM corpus_admission_decisions d
  LEFT JOIN corpus_admission_report_jobs j ON j.decision_id = d.id
  LEFT JOIN corpus_admission_accepted_representations ar ON ar.decision_id = d.id
  LEFT JOIN corpus_admission_content_store cs ON cs.decision_id = d.id
  LEFT JOIN corpus_admission_promotions p ON p.decision_id = d.id
  WHERE d.id = ?
`;

const DETAIL_SELECT_BY_JOB_ONLY = `
  SELECT
    NULL AS decision_id, NULL AS decision, NULL AS policy_version, NULL AS reason_codes,
    NULL AS hard_gate_passed, NULL AS hard_gate_failure_codes, NULL AS detected_format, NULL AS extracted_word_count,
    NULL AS detected_language, NULL AS language_confidence, NULL AS canonical_sha256,
    NULL AS quality_score, NULL AS quality_model_version, NULL AS component_scores, NULL AS corpus_value_score,
    NULL AS family_relation, NULL AS family_matched_source_ref, NULL AS family_containment,
    NULL AS decision_created_at,
    j.id AS job_id, j.status AS job_status, j.attempt_count, j.last_error, j.claimed_at,
    j.created_at AS job_created_at, j.updated_at AS job_updated_at,
    j.account_id, j.device_key, j.report_id,
    NULL AS accepted_representation_id, NULL AS revoked_at,
    NULL AS content_store_id,
    NULL AS promotion_status, NULL AS promotion_attempt_count, NULL AS promotion_last_error, NULL AS promotion_representation_id
  FROM corpus_admission_report_jobs j
  WHERE j.id = ? AND j.decision_id IS NULL
`;

function safeJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function safeJsonObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * rowId is either "decision:<id>" or "job:<id>" — exactly the synthetic ids
 * listCorpusAdmissionDecisions produces (see this module's own header
 * comment for why two different row universes need one). Returns null for
 * an unparseable or nonexistent id — callers (the API route) turn that into
 * a 404, never distinguishing "malformed id" from "not found" in the
 * response (nothing for a non-admin or a guessing admin session to learn
 * either way — moot in practice since the route is admin-gated, but kept
 * consistent with this codebase's own "don't leak more than necessary"
 * discipline).
 */
/**
 * Parses a "decision:<id>" rowId into its bare decisionId — the form
 * lib/corpus-admission-admin-actions.ts's deactivate/reactivate/preview
 * actions actually key on (corpus_admission_accepted_representations and
 * corpus_admission_content_store are both keyed by decision_id, not by this
 * synthetic rowId). Returns null for a "job:<id>" rowId (a job-only row has
 * no decision, and therefore never has an accepted representation or
 * retained text to act on) or a malformed id — callers turn either into a
 * 404, the same "not found" a real but nonexistent decisionId would produce.
 */
export function parseDecisionRowId(rowId: string): string | null {
  if (!rowId.startsWith("decision:")) return null;
  const decisionId = rowId.slice("decision:".length);
  return decisionId || null;
}

export async function getCorpusAdmissionDecisionDetail(client: Client, rowId: string): Promise<CorpusAdmissionAdminDetail | null> {
  let raw: RawDetailRow | undefined;
  if (rowId.startsWith("decision:")) {
    const decisionId = rowId.slice("decision:".length);
    if (!decisionId) return null;
    const result = await client.execute({ sql: DETAIL_SELECT_BY_DECISION, args: [decisionId] });
    raw = result.rows[0] as unknown as RawDetailRow | undefined;
  } else if (rowId.startsWith("job:")) {
    const jobId = rowId.slice("job:".length);
    if (!jobId) return null;
    const result = await client.execute({ sql: DETAIL_SELECT_BY_JOB_ONLY, args: [jobId] });
    raw = result.rows[0] as unknown as RawDetailRow | undefined;
  } else {
    return null;
  }
  if (!raw) return null;

  let accountEmail: string | null = null;
  if (raw.account_id) {
    const userResult = await client.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [raw.account_id] });
    accountEmail = (userResult.rows[0] as unknown as { email: string } | undefined)?.email ?? null;
  }

  let reportStillExists = false;
  if (raw.device_key && raw.report_id) {
    const reportResult = await client.execute({
      sql: "SELECT 1 AS present FROM saved_reports WHERE device_key = ? AND id = ?",
      args: [raw.device_key, raw.report_id],
    });
    reportStillExists = reportResult.rows.length > 0;
  }

  return {
    rowId,
    status: deriveStatus(raw.decision, raw.job_status),
    decisionId: raw.decision_id,
    decision: raw.decision as CorpusAdmissionAdminDetail["decision"],
    policyVersion: raw.policy_version,
    reasonCodes: safeJsonArray(raw.reason_codes),
    hardGatePassed: raw.hard_gate_passed === null ? null : raw.hard_gate_passed === 1,
    hardGateFailureCodes: safeJsonArray(raw.hard_gate_failure_codes),
    detectedFormat: raw.detected_format,
    extractedWordCount: raw.extracted_word_count === null ? null : Number(raw.extracted_word_count),
    detectedLanguage: raw.detected_language,
    languageConfidence: raw.language_confidence,
    canonicalSha256: raw.canonical_sha256,
    qualityScore: raw.quality_score,
    qualityModelVersion: raw.quality_model_version,
    componentScores: safeJsonObject(raw.component_scores),
    corpusValueScore: raw.corpus_value_score,
    familyRelation: raw.family_relation,
    familyMatchedSourceRef: raw.family_matched_source_ref,
    familyContainment: raw.family_containment,
    decisionCreatedAt: raw.decision_created_at,
    jobId: raw.job_id,
    jobStatus: raw.job_status,
    attemptCount: raw.attempt_count === null ? null : Number(raw.attempt_count),
    lastError: raw.last_error,
    claimedAt: raw.claimed_at,
    jobCreatedAt: raw.job_created_at,
    jobUpdatedAt: raw.job_updated_at,
    accountId: raw.account_id,
    accountEmail,
    deviceKey: raw.device_key,
    reportId: raw.report_id,
    reportStillExists,
    acceptedRepresentationId: raw.accepted_representation_id,
    acceptedRepresentationActive: raw.accepted_representation_id === null ? null : raw.revoked_at === null,
    revokedAt: raw.revoked_at,
    hasRetainedText: raw.content_store_id !== null,
    promotionStatus: raw.promotion_status as CorpusAdmissionAdminDetail["promotionStatus"],
    promotionAttemptCount: raw.promotion_attempt_count === null ? null : Number(raw.promotion_attempt_count),
    promotionLastError: raw.promotion_last_error,
    promotionRepresentationId: raw.promotion_representation_id,
  };
}

export type CorpusAdmissionStatusCounts = {
  /** COUNT(*) across every row the admin list ever shows (every status combined). */
  total: number;
  accepted: number;
  review: number;
  rejected: number;
  pending: number;
  failed: number;
  cancelled: number;
  /** COUNT(*) of corpus_admission_accepted_representations rows with revoked_at IS NULL — the corpus's current live size. Distinct from `accepted`: an ACCEPTed decision's representation can later be deactivated via this same dashboard's Remove action (see lib/corpus-admission-admin-actions.ts's deactivateAcceptedRepresentation) without changing the original decision. */
  activeRepresentations: number;
};

/**
 * Trivial read-only status-breakdown for the admin corpus dashboard's
 * top-of-page summary tiles (Admin Phase 2A) — a COUNT(*)/GROUP BY over the
 * exact same `combined` CTE listCorpusAdmissionDecisions already queries, so
 * these numbers share identical status semantics with the list's own status
 * filter (no separate derivation, no new admission/maturity/scoring logic).
 * Same "no authorization of its own" contract as every other function here.
 */
export async function getCorpusAdmissionStatusCounts(client: Client): Promise<CorpusAdmissionStatusCounts> {
  const countsResult = await client.execute(`
    ${COMBINED_CTE}
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN decision = 'ACCEPT' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN decision = 'REVIEW' THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN decision = 'REJECT' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN job_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN job_status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN job_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM combined
  `);
  const row = countsResult.rows[0] as unknown as Record<string, number | bigint | null>;

  const activeRepsResult = await client.execute(
    "SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE revoked_at IS NULL",
  );
  const activeRepresentations = Number((activeRepsResult.rows[0] as unknown as { c: number | bigint }).c);

  return {
    total: Number(row.total ?? 0),
    accepted: Number(row.accepted ?? 0),
    review: Number(row.review ?? 0),
    rejected: Number(row.rejected ?? 0),
    pending: Number(row.pending ?? 0),
    failed: Number(row.failed ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    activeRepresentations,
  };
}

export type CorpusAdmissionOperationalSummary = {
  /** COUNT(*) of corpus_admission_promotions rows with status='failed' — still retryable by the promotion sweep. */
  retryablePromotionCount: number;
  /** COUNT(*) of corpus_admission_promotions rows with status='dead_lettered' — exhausted MAX_PROMOTION_ATTEMPTS, terminal (see lib/corpus-admission-promotion.ts). */
  deadLetteredPromotionCount: number;
  /** One entry per known SweepKind, always present as a key — null when that kind has never recorded a run at all (the admin strip's own "Last sweep: never"). */
  sweeps: Record<SweepKind, { lastRunAt: string; lastStatus: SweepRunStatus; summary: Record<string, number> | null } | null>;
};

/**
 * The admin corpus dashboard's status-strip data source — everything it
 * needs in one cheap call: two indexed COUNT(*) queries against
 * corpus_admission_promotions (idx_corpus_admission_promotions_sweep_candidates
 * covers both, leading on status) plus a read of every
 * corpus_admission_sweep_runs row (lib/corpus-admission-sweep-state.ts, at most 3
 * rows, no filter needed). Never touches decision_id, representation_id,
 * account/report identifiers, or last_error text — only counts and the
 * already-numeric-only sweep summaries. Same "no authorization of its own"
 * contract as every other function in this file.
 */
export async function getCorpusAdmissionOperationalSummary(client: Client): Promise<CorpusAdmissionOperationalSummary> {
  const countsResult = await client.execute(
    "SELECT status, COUNT(*) AS c FROM corpus_admission_promotions WHERE status IN ('failed','dead_lettered') GROUP BY status",
  );
  let retryablePromotionCount = 0;
  let deadLetteredPromotionCount = 0;
  for (const row of countsResult.rows as unknown as { status: string; c: number | bigint }[]) {
    if (row.status === "failed") retryablePromotionCount = Number(row.c);
    else if (row.status === "dead_lettered") deadLetteredPromotionCount = Number(row.c);
  }

  const records = await getSweepRunRecords(client);
  const sweeps: CorpusAdmissionOperationalSummary["sweeps"] = { promotion: null, report_admission: null, retention: null };
  for (const record of records) {
    sweeps[record.sweepKind] = { lastRunAt: record.lastRunAt, lastStatus: record.lastStatus, summary: record.summary };
  }

  return { retryablePromotionCount, deadLetteredPromotionCount, sweeps };
}
