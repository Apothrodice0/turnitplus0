import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { evaluateCorpusAdmissionCandidate, type CorpusAdmissionConnectionFactory, type CorpusAdmissionDecisionRecord } from "./corpus-admission-gate";
import { isCorpusPromotionEnabled, stageAndClaimCorpusAdmissionPromotionForDecision, processCorpusAdmissionPromotion } from "./corpus-admission-promotion";
// Imported (and re-exported below, unchanged, for every existing importer
// of this file) rather than defined here — the function itself now lives
// in its own tiny, dependency-free module so a caller that needs only the
// source_ref format (lib/report-primary-similarity.ts) never has to pull
// in this file's own heavier admission-gate/text-extraction import chain.
// See that module's own header comment for the real `next build` failure
// this split fixes.
import { buildReportAdmissionSourceRef } from "./corpus-admission-source-ref";
export { buildReportAdmissionSourceRef };

/**
 * Controlled integration between the live report-upload path
 * (app/api/reports/route.ts) and the corpus-admission gate
 * (lib/corpus-admission-gate.ts). This module admits content into the
 * admission gate's own audit trail (corpus_admission_decisions /
 * corpus_admission_content_store) via lib/corpus-admission-gate.ts, and —
 * as of the automatic-promotion fix — also stages and immediately attempts
 * to index a fresh ACCEPT into the real reusable corpus
 * (corpus_document_representations et al), by calling through
 * lib/corpus-admission-promotion.ts's own closed door (see this module's
 * own processReportAdmissionJob for exactly where). It still never calls
 * lib/user-submission-corpus.ts's write functions directly, and still never
 * links a promoted representation to a document_identity_id/account — see
 * lib/corpus-admission-promotion.ts's own header comment for that
 * boundary, which this module does not change. tests/corpus-admission-
 * privacy.test.mjs's structural checks (the "third door") still enforce
 * that lib/corpus-admission-promotion.ts is reachable only from this
 * module and the sweep/admin-dashboard routes, never directly from
 * arbitrary app/ code.
 *
 * Design properties:
 *  - Feature-flagged: isCorpusAdmissionEnabled() reads
 *    process.env.CORPUS_ADMISSION_ENABLED fresh on every call (no caching,
 *    so tests can toggle it) — unset/false by default.
 *  - Durable job creation: createPendingReportAdmissionJob is called
 *    SYNCHRONOUSLY by the route, in the same request that inserts the
 *    report — never only inside runAfterResponse's deferred callback. A
 *    process that crashes after sending the response but before that
 *    deferred work ever starts still leaves a durable 'pending' row for
 *    runReportAdmissionRetrySweep to find later. This function only ever
 *    ensures a row exists (INSERT ... ON CONFLICT DO NOTHING) — it never
 *    disturbs an existing job's status/decision_id/attempt_count.
  *  - Mandatory, not consent-gated: product decision — cross-account
 *    TurnitPlus corpus-admission eligibility applies to every authenticated
 *    account, with no per-account preference able to block it.
 *    processReportAdmissionJob no longer reads or re-checks
 *    users.corpus_reuse_consented_at at all (that column is now a vestigial
 *    historical timestamp — see db/schema.ts's own comment on it); the
 *    "consent_not_granted" job outcome this module used to produce no
 *    longer exists. This runs identically whether the caller is the
 *    original deferred attempt, a manual retry, or a sweep.
 *  - Atomic retry sweep: runReportAdmissionRetrySweep claims a batch of
 *    pending/failed jobs inside one real write transaction (the same
 *    BEGIN IMMEDIATE mechanism this session's cross-process work already
 *    verified is safe across processes — see
 *    tests/corpus-admission-cross-process.test.mjs's own transaction-type
 *    documentation) before processing any of them, so two sweeps running
 *    at once (or two sweep-capable processes) can never both process the
 *    same job.
 *  - Accepted corpus content is durable — retention policy, not a
 *    self-service toggle: once a candidate has been ACCEPTed (a decision
 *    row with a corpus_admission_content_store row), deleting the report or
 *    account never removes it. This mirrors the real corpus's own existing
 *    behavior (lib/report-deletion.ts's own header comment: shared corpus
 *    content outlives the submission that produced it):
 *      - revokeConsentAndCancelPendingAdmissionJobs still exists (some
 *        callers/tests use it directly) but PATCH /api/auth/me no longer
 *        calls it — since corpus-admission eligibility can no longer be
 *        disabled per-account, there is nothing left for an account action
 *        to revoke. If called directly, it still flips the (now-vestigial)
 *        consent flag and cancels this account's still-'pending'/'failed'
 *        jobs atomically, but never touches a 'succeeded' job or its
 *        decision/content/fingerprint rows, accepted or not.
 *      - deleteReportCorpusAdmissionData (report/account deletion) always
 *        removes this report's own job-tracking row, but only removes the
 *        decision row (and cascaded content/fingerprint) when that
 *        decision was never ACCEPTed with retained content — see its own
 *        comment.
 *    corpus_admission_accepted_representations.revoked_at (drizzle/0032)
 *    is therefore NOT set by anything in this module — it remains reserved
 *    for a future, explicitly admin-triggered removal flow (e.g. a legal
 *    takedown), which does not exist yet. lib/corpus-admission-gate.ts's
 *    own filtering (WHERE revoked_at IS NULL) is unaffected by that: it
 *    still excludes any row that future flow does mark, whenever it ships.
 *  - Report/owner-scoped provenance: source_ref is built from
 *    (account_id, device_key, report_id) directly (buildReportAdmissionSourceRef),
 *    never from document_identity_id — see deleteReportCorpusAdmissionData's
 *    own comment for why that matters for deletion correctness.
 */

export function isCorpusAdmissionEnabled(): boolean {
  return process.env.CORPUS_ADMISSION_ENABLED === "true";
}

type ReportAdmissionJobStatus = "pending" | "succeeded" | "failed" | "cancelled";

type ReportAdmissionJobRow = {
  id: string;
  sourceRef: string;
  accountId: string;
  deviceKey: string;
  reportId: string;
  status: ReportAdmissionJobStatus;
  decisionId: string | null;
  claimedAt: string | null;
  attemptCount: number;
  lastError: string | null;
  /** Device Passport (Phase 2): the cryptographically verified upload passport, copied here at job creation from the verified upload context — never re-derived. NULL when no attestation was verified. */
  verifiedDevicePassportId: string | null;
};

type RawJobRow = {
  id: string;
  source_ref: string;
  account_id: string;
  device_key: string;
  report_id: string;
  status: string;
  decision_id: string | null;
  claimed_at: string | null;
  attempt_count: number | bigint;
  last_error: string | null;
  verified_device_passport_id: string | null;
};

function toJobRow(row: RawJobRow): ReportAdmissionJobRow {
  return {
    id: row.id,
    sourceRef: row.source_ref,
    accountId: row.account_id,
    deviceKey: row.device_key,
    reportId: row.report_id,
    status: row.status as ReportAdmissionJobStatus,
    decisionId: row.decision_id,
    claimedAt: row.claimed_at,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    verifiedDevicePassportId: row.verified_device_passport_id ?? null,
  };
}

async function fetchJobById(client: Client, jobId: string): Promise<ReportAdmissionJobRow | null> {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_report_jobs WHERE id = ?", args: [jobId] });
  const row = result.rows[0] as unknown as RawJobRow | undefined;
  return row ? toJobRow(row) : null;
}

async function fetchJobBySourceRef(client: Client, sourceRef: string): Promise<ReportAdmissionJobRow | null> {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_report_jobs WHERE source_ref = ?", args: [sourceRef] });
  const row = result.rows[0] as unknown as RawJobRow | undefined;
  return row ? toJobRow(row) : null;
}

// ============================================================================
// Synchronous, durable job creation (blocker 1)
// ============================================================================

export type CreatePendingReportAdmissionJobParams = {
  accountId: string;
  deviceKey: string;
  reportId: string;
  /** Device Passport (Phase 2): the verified upload passport (or null/absent). Stored on the job row so processReportAdmissionJob can record per-backing provenance on ACCEPT without re-deriving anything. */
  verifiedDevicePassportId?: string | null;
};

/**
 * Ensures a 'pending' job row exists for this report. Called SYNCHRONOUSLY
 * by the route, before the response is sent — NOT from inside
 * runAfterResponse. Pure "ensure the row exists": if a job already exists
 * for this report (any status — a defensive case that should never occur
 * from the live route, which only ever calls this once per report via
 * isFirstSaveOfThisReport), this leaves it completely untouched and simply
 * returns its id. Returns null when the flag is off — no row is ever
 * created while disabled.
 */
export async function createPendingReportAdmissionJob(client: Client, params: CreatePendingReportAdmissionJobParams): Promise<{ jobId: string } | null> {
  if (!isCorpusAdmissionEnabled()) return null;

  const sourceRef = buildReportAdmissionSourceRef(params);
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, decision_id, claimed_at, attempt_count, last_error, verified_device_passport_id, created_at, updated_at)
          VALUES (?,?,?,?,?,'pending',NULL,NULL,0,NULL,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
          ON CONFLICT(source_ref) DO NOTHING`,
    args: [id, sourceRef, params.accountId, params.deviceKey, params.reportId, params.verifiedDevicePassportId ?? null],
  });
  const job = await fetchJobBySourceRef(client, sourceRef);
  return job ? { jobId: job.id } : null;
}

// ============================================================================
// Processing a job (shared by the deferred attempt, manual retry, and sweep)
// ============================================================================

export type ReportAdmissionOutcome =
  | { outcome: "disabled" }
  | { outcome: "already_succeeded"; jobId: string; decisionId: string | null }
  // "cancelled" jobs still exist (e.g. a direct call to
  // revokeConsentAndCancelPendingAdmissionJobs, or report/account deletion)
  // even though no per-account preference can produce one any more.
  | { outcome: "terminal"; jobId: string; status: "cancelled" }
  | { outcome: "succeeded"; jobId: string; decisionId: string; decision: CorpusAdmissionDecisionRecord["decision"] }
  | { outcome: "failed"; jobId: string; error: string };

export type ProcessReportAdmissionJobParams = {
  jobId: string;
  /** Required — used for the admission gate's own write-retry paths. */
  openConnection: CorpusAdmissionConnectionFactory;
  /**
   * Test-only fault injection (mirrors lib/corpus-admission-promotion.ts's
   * simulateFailureAfterShingles convention): forces the required
   * device-provenance INSERT inside finalizeAcceptedAdmissionJob's atomic
   * batch to fail, so a test can prove the job is NEVER marked 'succeeded'
   * without its provenance (the batch rolls back together) and that a plain
   * retry re-finalizes the SAME decision to completion. Always undefined in
   * production.
   */
  testOnlySimulateProvenanceWriteFailure?: boolean;
};

function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

const MAX_WRITE_BUSY_RETRIES = 10;
function writeBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}

/**
 * A single status-mutating write against corpus_admission_report_jobs,
 * retried with a genuinely fresh connection on every attempt — the same
 * fresh-connection-per-retry mechanism lib/corpus-admission-gate.ts's own
 * accept-transaction and decision-row-insert paths use, for the identical
 * reason (confirmed this session: retrying on the SAME connection does not
 * reliably recover from cross-process/cross-connection SQLITE_BUSY). Job
 * status writes are simple, single, autocommit statements — no transaction
 * needed here, just a connection that hasn't already lost a race.
 */
async function executeJobWriteWithRetry(openConnection: CorpusAdmissionConnectionFactory, stmt: InStatement): Promise<void> {
  for (let attempt = 1; attempt <= MAX_WRITE_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      await attemptClient.execute(stmt);
      return;
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_WRITE_BUSY_RETRIES) {
        await writeBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
}

/**
 * The multi-statement counterpart to executeJobWriteWithRetry — client.batch(
 * stmts, "write") is one server-side transaction, so either every statement
 * commits or none does. Same fresh-connection-per-attempt SQLITE_BUSY retry
 * (a losing concurrent write transaction does not reliably recover on a
 * reused connection). Used by finalizeAcceptedAdmissionJob to make the
 * job-'succeeded' write and its required device-provenance write atomic.
 */
async function executeJobBatchWithRetry(openConnection: CorpusAdmissionConnectionFactory, stmts: InStatement[]): Promise<void> {
  for (let attempt = 1; attempt <= MAX_WRITE_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      await attemptClient.batch(stmts, "write");
      return;
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_WRITE_BUSY_RETRIES) {
        await writeBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
}

/** The decision kind (ACCEPT | REJECT | REVIEW) for a decision id, or null if the row is gone. */
async function fetchDecisionKind(client: Client, decisionId: string): Promise<string | null> {
  const result = await client.execute({ sql: "SELECT decision FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
  const row = result.rows[0] as unknown as { decision: string } | undefined;
  return row ? String(row.decision) : null;
}

/**
 * Finalizes an already-evaluated report-admission job as 'succeeded'. When
 * the job carried a cryptographically verified upload passport AND the
 * decision is ACCEPT, the corpus_admission_decision_device_provenance INSERT
 * is placed in the SAME atomic batch as the status write — so the job can
 * NEVER be observed 'succeeded' without its required per-decision device
 * provenance: both land or neither does. If the provenance write fails, the
 * batch rolls back (status stays whatever it was), this function throws, and
 * the caller reverts the job to the retryable 'failed' state with its
 * decision_id preserved — a plain retry then re-finalizes THIS exact
 * decision (see processReportAdmissionJob's own re-finalization fast path),
 * never re-evaluating.
 *
 * Idempotent: the provenance INSERT is ON CONFLICT(decision_id) DO NOTHING,
 * and re-finalizing an already-'succeeded' job just re-asserts the same
 * state. When no provenance is required (REJECT/REVIEW, or an ACCEPT with no
 * verified passport) this is a single status UPDATE — byte-identical to the
 * pre-Phase-2 finalization.
 */
async function finalizeAcceptedAdmissionJob(
  openConnection: CorpusAdmissionConnectionFactory,
  params: { jobId: string; decisionId: string; decisionKind: string; verifiedDevicePassportId: string | null; simulateProvenanceWriteFailure?: boolean },
): Promise<void> {
  const statusUpdate: InStatement = {
    sql: "UPDATE corpus_admission_report_jobs SET status = 'succeeded', decision_id = ?, claimed_at = NULL, last_error = NULL, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [params.decisionId, params.jobId],
  };

  const needsProvenance = params.decisionKind === "ACCEPT" && params.verifiedDevicePassportId != null;
  if (!needsProvenance) {
    await executeJobWriteWithRetry(openConnection, statusUpdate);
    return;
  }

  const provenanceInsert: InStatement = params.simulateProvenanceWriteFailure
    // Test-only: a deliberately invalid statement so the batch's own
    // transaction genuinely rolls back (proving the status write cannot
    // land without it), rather than a mocked throw that never reaches SQL.
    ? {
        sql: "INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at, __test_only_forced_failure) VALUES (?,?,?,?)",
        args: [params.decisionId, params.verifiedDevicePassportId, Date.now(), 1],
      }
    : {
        sql: `INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at)
              VALUES (?,?,?)
              ON CONFLICT(decision_id) DO NOTHING`,
        args: [params.decisionId, params.verifiedDevicePassportId, Date.now()],
      };

  await executeJobBatchWithRetry(openConnection, [statusUpdate, provenanceInsert]);
}

/**
 * The immediate promotion attempt for an ACCEPT decision. Extracted so
 * processReportAdmissionJob's normal path and its re-finalization fast path
 * share exactly one implementation; both call it AFTER the job is already
 * finalized 'succeeded' (nothing here can roll that back).
 *
 * Why do it here at all: ACCEPT previously relied exclusively on the
 * scheduled sweep to ever get staged/indexed — a decision could sit
 * ACCEPTed, with active fingerprint and retained content, for up to a full
 * day (or forever, if CORPUS_PROMOTION_ENABLED happened to be off at the
 * time) before becoming matchable. This runs the SAME real pipeline the
 * sweep uses (stageAndClaimCorpusAdmissionPromotionForDecision, then
 * processCorpusAdmissionPromotion — no second shingle/indexing
 * implementation) immediately, at this exact async job boundary, which
 * every real trigger already awaits — never fire-and-forget.
 *
 * Also the fix for re-ACCEPT after an admin deactivation: when a
 * deactivated representation's canonical hash is re-uploaded,
 * evaluateCorpusAdmissionCandidate's own pre-check (revoked_at IS NULL)
 * does not see the old, revoked accepted_representations row, so this is a
 * genuinely NEW ACCEPT with its own new acceptedRepresentationId — staged
 * and promoted here exactly like a first-ever ACCEPT. Its own
 * indexPromotionAtomically may legitimately reuse the same underlying
 * corpus_document_representations row (EXACT_CANONICAL_DUPLICATE), but this
 * promotion's own 'indexed' row, backed by the NEW, non-revoked
 * accepted_representation, is what restores
 * findCandidateCorpusRepresentations' eligibility join — matching becomes
 * active again without this module knowing anything about matching
 * eligibility itself.
 *
 * Gated the same way the sweep gates itself (isCorpusPromotionEnabled()) —
 * while off, nothing is staged here either, so a decision accepted while
 * disabled is discovered fresh by the sweep's own batch discovery once the
 * flag is later turned on, exactly as before this existed.
 *
 * Failure isolation: processCorpusAdmissionPromotion already isolates a
 * genuine indexing failure internally (persists status='failed', returns a
 * value, never throws for that case); the try/catch here is only for a
 * failure in staging/claiming/processing itself never reaching that
 * internal write (e.g. a connection-level error) — either way the row is
 * left 'staged' or 'failed' with claimed_at NULL, exactly the shape
 * runCorpusAdmissionPromotionSweep's own claim query (status IN
 * ('staged','failed')) already discovers and retries.
 *
 * Claim-safety: this path never processes a promotion it has not won the
 * claim on. stageAndClaimCorpusAdmissionPromotionForDecision stages
 * (idempotent) then attempts the SAME single-owner claim the sweep uses —
 * a racing sweep tick that claims this row first makes this call's claim a
 * no-op (claimed:false) and this path correctly does not re-process it. An
 * already-'indexed'/'skipped' promotion can never be claimed either, and
 * processCorpusAdmissionPromotion has its own terminal-idempotency guard as
 * a second independent layer.
 */
async function maybePromoteAcceptedDecision(
  client: Client,
  openConnection: CorpusAdmissionConnectionFactory,
  decisionId: string,
  decisionKind: string,
): Promise<void> {
  if (decisionKind !== "ACCEPT" || !isCorpusPromotionEnabled()) return;
  try {
    const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decisionId);
    if (staged.staged && staged.claimed) {
      await processCorpusAdmissionPromotion(client, { promotionId: staged.promotionId, openConnection });
    }
  } catch (err) {
    console.error("processReportAdmissionJob: immediate promotion attempt failed (non-fatal — admission remains ACCEPT, and the row stays discoverable/retryable by the existing promotion sweep):", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Does the actual work for one existing job: re-checks consent fresh (a
 * connection opened via openConnection and closed immediately around this
 * one check — never a parameter, never a snapshot), re-derives rawText
 * from saved_reports.payload_json (the durable record — never anything
 * held in memory from the original request, so this is correct whether
 * called seconds or days after the report was saved), and calls the
 * admission gate. Never throws: every outcome (already done, consent
 * absent, succeeded, failed) is returned as a plain value, and a genuine
 * gate failure is persisted (status='failed', last_error set) rather than
 * only logged.
 *
 * A job already 'succeeded' or 'cancelled' is a safe no-op — this function
 * is the single call site every caller (the deferred callback, a manual
 * retry, the sweep) shares, so "retry" and "process" are the same
 * operation with the same idempotency guarantee everywhere.
 */
export async function processReportAdmissionJob(client: Client, params: ProcessReportAdmissionJobParams): Promise<ReportAdmissionOutcome> {
  const job = await fetchJobById(client, params.jobId);
  if (!job) {
    throw new Error(`processReportAdmissionJob: no admission job found for id ${params.jobId}`);
  }
  if (job.status === "succeeded") {
    return { outcome: "already_succeeded", jobId: job.id, decisionId: job.decisionId };
  }
  if (job.status === "cancelled") {
    return { outcome: "terminal", jobId: job.id, status: job.status };
  }

  // Re-finalization fast path (Device Passport Phase 2 atomicity fix). A
  // prior attempt already evaluated this candidate — decision_id is durably
  // recorded on the job (see the normal path below) — but did not finish
  // finalizing it, e.g. the required device-provenance write failed and rolled
  // the whole finalization batch back, reverting the job to 'failed'.
  //
  // Re-finalize THAT EXACT decision. NEVER re-evaluate:
  // evaluateCorpusAdmissionCandidate has irreversible, already-committed side
  // effects (the corpus_admission_decisions row, and for an ACCEPT the
  // durable "first accepted sample wins" corpus_admission_accepted_representations
  // row), so a second evaluation of the same content produces a divergent
  // REJECT and orphans the first ACCEPT without its provenance — the exact
  // corruption this fix exists to prevent.
  //
  // Reaching this branch means a committed decision is still owed its
  // finalization. The decision and any accepted content it reuses are
  // durable by policy regardless — see this module's own header comment.
  if (job.decisionId != null) {
    const decisionKind = await fetchDecisionKind(client, job.decisionId);
    if (decisionKind != null) {
      try {
        await finalizeAcceptedAdmissionJob(params.openConnection, {
          jobId: job.id,
          decisionId: job.decisionId,
          decisionKind,
          verifiedDevicePassportId: job.verifiedDevicePassportId,
          simulateProvenanceWriteFailure: params.testOnlySimulateProvenanceWriteFailure,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await executeJobWriteWithRetry(params.openConnection, {
          sql: "UPDATE corpus_admission_report_jobs SET status = 'failed', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [message, job.id],
        });
        return { outcome: "failed", jobId: job.id, error: message };
      }
      await maybePromoteAcceptedDecision(client, params.openConnection, job.decisionId, decisionKind);
      return { outcome: "succeeded", jobId: job.id, decisionId: job.decisionId, decision: decisionKind as CorpusAdmissionDecisionRecord["decision"] };
    }
    // The recorded decision row is gone (not an expected flow — a deleted
    // decision cascades its accepted_representation, so re-evaluation would
    // be a clean first ACCEPT). Fall through to a fresh evaluation.
  }

  // Product decision: corpus-admission eligibility is mandatory for every
  // authenticated account — there is no per-account preference left to
  // re-check here (see this module's own header comment; the
  // "consent_not_granted" outcome this used to produce no longer exists).

  const reportResult = await client.execute({
    sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?",
    args: [job.deviceKey, job.reportId],
  });
  const payloadJson = (reportResult.rows[0] as unknown as { payload_json: string } | undefined)?.payload_json;
  const rawText = payloadJson ? ((JSON.parse(payloadJson) as { text?: unknown }).text as string | undefined) : undefined;

  // attempt_count is bumped as PART of each terminal write below (not as
  // its own separate statement) — it should reflect "how many times an
  // evaluation actually concluded" (success or failure), and folding it in
  // keeps every real attempt to just one openConnection() call for its own
  // status write, rather than two.
  if (!rawText || typeof rawText !== "string") {
    const message = `the underlying report (device_key=${job.deviceKey}, id=${job.reportId}) no longer exists or has no retained text`;
    await executeJobWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_report_jobs SET status = 'failed', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [message, job.id],
    });
    return { outcome: "failed", jobId: job.id, error: message };
  }

  try {
    const decision = await evaluateCorpusAdmissionCandidate(client, {
      sourceRef: job.sourceRef,
      filename: "live-submission.txt",
      bytes: Buffer.from(rawText, "utf8"),
      consent: { kind: "PER_USER_CONSENT", consented: true },
      dryRun: false,
      openConnection: params.openConnection,
    });

    // Device Passport (Phase 2) atomicity: durably record which decision this
    // job produced BEFORE finalizing it — a lone UPDATE that does not touch
    // status. If finalization then fails (e.g. the required device-provenance
    // write), the outer catch reverts this job to 'failed' with its
    // decision_id preserved, and a plain retry re-finalizes THIS exact
    // decision via the fast path at the top of this function, never
    // re-evaluating (which would produce a divergent second decision).
    await executeJobWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_report_jobs SET decision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [decision.id, job.id],
    });

    // Finalize as 'succeeded' — atomically with the required per-decision
    // device-provenance write when the job carried a verified upload passport
    // and this is an ACCEPT. The job can NEVER be observed 'succeeded'
    // without that provenance: finalizeAcceptedAdmissionJob puts both in one
    // client.batch("write") transaction. A provenance failure throws here and
    // is handled by the outer catch (job -> retryable 'failed', decision_id
    // intact). The passport id NEVER touches corpus_document_representations
    // (deduplicated, many independent backings) — it lives only on the
    // per-decision corpus_admission_decision_device_provenance row.
    await finalizeAcceptedAdmissionJob(params.openConnection, {
      jobId: job.id,
      decisionId: decision.id,
      decisionKind: decision.decision,
      verifiedDevicePassportId: job.verifiedDevicePassportId,
      simulateProvenanceWriteFailure: params.testOnlySimulateProvenanceWriteFailure,
    });

    // Immediate promotion for an ACCEPT — same real pipeline the sweep uses,
    // best-effort, isolated. Full rationale on maybePromoteAcceptedDecision.
    await maybePromoteAcceptedDecision(client, params.openConnection, decision.id, decision.decision);

    return { outcome: "succeeded", jobId: job.id, decisionId: decision.id, decision: decision.decision };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await executeJobWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_report_jobs SET status = 'failed', claimed_at = NULL, last_error = ?, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [message, job.id],
    });
    return { outcome: "failed", jobId: job.id, error: message };
  }
}

// ============================================================================
// Retry sweep with atomic claiming (blocker 2)
// ============================================================================

const MAX_CLAIM_BUSY_RETRIES = 10;
function claimBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}

export type RunReportAdmissionRetrySweepParams = {
  openConnection: CorpusAdmissionConnectionFactory;
  batchSize?: number;
  /** A claim older than this is considered abandoned (the process that made it likely died mid-attempt) and is reclaimable by a later sweep. Default 5 minutes. */
  staleClaimMs?: number;
};

export type RunReportAdmissionRetrySweepResult = {
  claimedJobIds: string[];
  results: ReportAdmissionOutcome[];
};

/**
 * Atomically claims up to batchSize eligible jobs (status IN
 * ('pending','failed'), and either never claimed or claimed long enough
 * ago to be considered abandoned) inside ONE real write transaction — the
 * select-then-claim happens entirely while holding SQLite's BEGIN IMMEDIATE
 * lock, so no other concurrent sweep (in this process or a genuinely
 * separate one) can select the same rows before this transaction commits.
 * Every attempt opens a fresh connection via openConnection, exactly like
 * lib/corpus-admission-gate.ts's own accept-transaction retry loop, for the
 * same reason (a losing concurrent write transaction does not reliably
 * recover on a reused connection — see that module's own comment).
 *
 * Once claimed, each job is processed one at a time via
 * processReportAdmissionJob on the plain `client` passed in — claiming and
 * processing are deliberately separate steps so one job's processing time
 * never extends how long the claim transaction (and its write lock) is
 * held.
 */
export async function runReportAdmissionRetrySweep(client: Client, params: RunReportAdmissionRetrySweepParams): Promise<RunReportAdmissionRetrySweepResult> {
  const batchSize = params.batchSize ?? 20;
  const staleClaimMs = params.staleClaimMs ?? 5 * 60 * 1000;
  // Computed via SQLite's own datetime('now', ...) rather than JS
  // Date.toISOString(): CURRENT_TIMESTAMP (used to set claimed_at) produces
  // "YYYY-MM-DD HH:MM:SS" (space-separated, no fractional seconds); a JS
  // ISO string ("YYYY-MM-DDTHH:MM:SS.sssZ") lexicographically sorts BEFORE
  // any same-day space-separated timestamp (' ' < 'T' in ASCII) regardless
  // of actual time — which made every freshly-claimed row look stale
  // immediately, a real bug caught by this session's own concurrent-sweep
  // test. Computing the threshold in the same format, in the same
  // database, sidesteps the whole class of mismatch rather than just this
  // one instance of it.
  const staleClaimSeconds = Math.max(1, Math.floor(staleClaimMs / 1000));

  let claimedJobIds: string[] = [];
  for (let attempt = 1; attempt <= MAX_CLAIM_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await params.openConnection();
    try {
      const tx = await attemptClient.transaction("write");
      try {
        const candidates = await tx.execute({
          sql: `SELECT id FROM corpus_admission_report_jobs
                WHERE status IN ('pending','failed') AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))
                ORDER BY updated_at ASC LIMIT ?`,
          args: [`-${staleClaimSeconds} seconds`, batchSize],
        });
        const ids = (candidates.rows as unknown as { id: string }[]).map((r) => r.id);
        if (ids.length > 0) {
          const placeholders = ids.map(() => "?").join(",");
          await tx.execute({
            sql: `UPDATE corpus_admission_report_jobs SET claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
            args: ids,
          });
        }
        await tx.commit();
        claimedJobIds = ids;
        break;
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
      attemptClient.close();
    }
  }

  const results: ReportAdmissionOutcome[] = [];
  for (const jobId of claimedJobIds) {
    results.push(await processReportAdmissionJob(client, { jobId, openConnection: params.openConnection }));
  }
  return { claimedJobIds, results };
}

// ============================================================================
// Deletion (report / account)
// ============================================================================

/**
 * Report/account deletion cleanup, scoped to this exact
 * (account_id, device_key, report_id) triple.
 *
 * source_ref is built the same way admission itself builds it
 * (buildReportAdmissionSourceRef) directly from this triple — never from
 * document_identity_id, and never a hash or partial match — so this can
 * never match, and therefore can never delete, a different report's
 * retained source, including a different report belonging to the SAME
 * account.
 *
 * Always removes this report's own job-tracking row
 * (corpus_admission_report_jobs) — that row exists only to track THIS
 * report's own processing status, which is moot once the report is gone.
 *
 * The decision row (and, if it exists, its cascaded content/fingerprint) is
 * removed ONLY when this candidate was never ACCEPTed with retained
 * content — a REJECT/REVIEW decision, or no decision at all, has nothing
 * corpus-valuable to preserve. When it WAS accepted (a
 * corpus_admission_content_store row exists for it), the decision, its
 * retained text, and its accepted_representations fingerprint are left
 * completely untouched: accepted corpus content is durable and survives
 * report/account deletion by design (see this module's own header
 * comment) — mirroring lib/report-deletion.ts's identical treatment of the
 * real corpus's own shared content.
 */
export async function deleteReportCorpusAdmissionData(
  client: Client,
  params: { accountId: string; deviceKey: string; reportId: string },
): Promise<void> {
  const sourceRef = buildReportAdmissionSourceRef(params);

  const acceptedResult = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM corpus_admission_decisions d
          JOIN corpus_admission_content_store cs ON cs.decision_id = d.id
          WHERE d.source_ref = ?`,
    args: [sourceRef],
  });
  const hasAcceptedContent = Number((acceptedResult.rows[0] as unknown as { c: number | bigint }).c) > 0;

  await client.execute({ sql: "DELETE FROM corpus_admission_report_jobs WHERE source_ref = ?", args: [sourceRef] });
  if (!hasAcceptedContent) {
    await client.execute({ sql: "DELETE FROM corpus_admission_decisions WHERE source_ref = ?", args: [sourceRef] });
  }
}

// ============================================================================
// Consent revocation — atomic, but scoped to not-yet-accepted work only
// ============================================================================

export type RevokeConsentResult = { cancelledJobCount: number };

const MAX_REVOCATION_BUSY_RETRIES = 10;
function revocationBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}

/**
 * NOT called by PATCH /api/auth/me any more (product decision: corpus-
 * admission eligibility is mandatory for every authenticated account, so
 * there is no account action left that should revoke/cancel anything —
 * see this module's own header comment). Kept for its own direct test
 * coverage and as a primitive some future explicitly admin-triggered flow
 * could still reuse; no production caller reaches it today.
 *
 * Deliberately narrow: this is a consent change, not a takedown request.
 * It affects only work that has not yet been accepted —
 *  1. users.corpus_reuse_consented_at (now a vestigial historical
 *     timestamp — processReportAdmissionJob no longer reads it) set to
 *     NULL.
 *  2. Every job still 'pending' or 'failed' for this account is cancelled
 *     (status='cancelled') — nothing not-yet-accepted survives to be
 *     processed later.
 * It never touches a 'succeeded' job, its decision row, its retained
 * corpus_admission_content_store text, or its accepted_representations
 * fingerprint — accepted corpus content is durable, exactly as it outlives
 * report/account deletion (see deleteReportCorpusAdmissionData). revoked_at
 * stays unset here; it is reserved for a future, explicitly admin-triggered
 * removal flow.
 *
 * Atomic: both writes run inside ONE real write transaction (the same
 * BEGIN IMMEDIATE + fresh-connection-per-retry mechanism used throughout
 * this module and lib/corpus-admission-gate.ts) — either both commit or
 * neither does. A caller that gets an exception (retries exhausted, or an
 * unexpected error) is guaranteed the account's data is completely
 * unchanged, exactly as if the call had never been made.
 */
export async function revokeConsentAndCancelPendingAdmissionJobs(
  accountId: string,
  openConnection: CorpusAdmissionConnectionFactory,
): Promise<RevokeConsentResult> {
  for (let attempt = 1; attempt <= MAX_REVOCATION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      const tx = await attemptClient.transaction("write");
      try {
        await tx.execute({
          sql: "UPDATE users SET corpus_reuse_consented_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [accountId],
        });

        const cancelled = await tx.execute({
          sql: "UPDATE corpus_admission_report_jobs SET status = 'cancelled', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND status IN ('pending','failed')",
          args: [accountId],
        });

        await tx.commit();
        return { cancelledJobCount: cancelled.rowsAffected };
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_REVOCATION_BUSY_RETRIES) {
        await revocationBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
  throw new Error("revokeConsentAndCancelPendingAdmissionJobs: exhausted retries without resolving");
}
