import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { evaluateCorpusAdmissionCandidate, type CorpusAdmissionConnectionFactory, type CorpusAdmissionDecisionRecord } from "./corpus-admission-gate";
import { isCorpusPromotionEnabled, stageAndClaimCorpusAdmissionPromotionForDecision, processCorpusAdmissionPromotion } from "./corpus-admission-promotion";

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
 *  - Consent re-checked fresh, every time: processReportAdmissionJob takes
 *    no "consented" parameter at all — it always re-reads
 *    users.corpus_reuse_consented_at itself, on a connection obtained via
 *    the caller's openConnection factory, opened and closed immediately
 *    around that one check. A caller cannot pass a stale snapshot because
 *    there is no parameter for one. This runs identically whether the
 *    caller is the original deferred attempt, a manual retry, or a sweep.
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
 *    row with a corpus_admission_content_store row), neither revoking the
 *    submitting account's consent NOR deleting the report or account ever
 *    removes it. This mirrors the real corpus's own existing behavior
 *    (lib/report-deletion.ts's own header comment: shared corpus content
 *    outlives the submission that produced it) — consent and deletion
 *    govern what happens to FUTURE/PENDING work for an account, never what
 *    already became part of the shared, reusable corpus:
 *      - revokeConsentAndCancelPendingAdmissionJobs (called from
 *        PATCH /api/auth/me on a true->false transition) flips the consent
 *        flag and cancels this account's still-'pending'/'failed' jobs
 *        (nothing not-yet-accepted survives to be processed later) —
 *        atomically, in one transaction — but never touches a 'succeeded'
 *        job or its decision/content/fingerprint rows, accepted or not.
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

export function buildReportAdmissionSourceRef(params: { accountId: string; deviceKey: string; reportId: string }): string {
  return `report-upload:account=${params.accountId}:device=${params.deviceKey}:report=${params.reportId}`;
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

export type CreatePendingReportAdmissionJobParams = { accountId: string; deviceKey: string; reportId: string };

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
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, decision_id, claimed_at, attempt_count, last_error, created_at, updated_at)
          VALUES (?,?,?,?,?,'pending',NULL,NULL,0,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
          ON CONFLICT(source_ref) DO NOTHING`,
    args: [id, sourceRef, params.accountId, params.deviceKey, params.reportId],
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
  | { outcome: "terminal"; jobId: string; status: "cancelled" }
  | { outcome: "consent_not_granted"; jobId: string }
  | { outcome: "succeeded"; jobId: string; decisionId: string; decision: CorpusAdmissionDecisionRecord["decision"] }
  | { outcome: "failed"; jobId: string; error: string };

export type ProcessReportAdmissionJobParams = {
  jobId: string;
  /** Required — used both for the fresh consent re-check and for the admission gate's own write-retry paths. */
  openConnection: CorpusAdmissionConnectionFactory;
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

  const consentClient = await params.openConnection();
  let consented: boolean;
  try {
    const result = await consentClient.execute({ sql: "SELECT corpus_reuse_consented_at FROM users WHERE id = ?", args: [job.accountId] });
    const row = result.rows[0] as unknown as { corpus_reuse_consented_at: string | null } | undefined;
    consented = row?.corpus_reuse_consented_at != null;
  } finally {
    consentClient.close();
  }
  if (!consented) {
    await executeJobWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_report_jobs SET status = 'cancelled', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [job.id],
    });
    return { outcome: "consent_not_granted", jobId: job.id };
  }

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
    await executeJobWriteWithRetry(params.openConnection, {
      sql: "UPDATE corpus_admission_report_jobs SET status = 'succeeded', decision_id = ?, claimed_at = NULL, last_error = NULL, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [decision.id, job.id],
    });

    // Automatic promotion fix: ACCEPT previously relied exclusively on the
    // scheduled sweep to ever get staged/indexed — a decision could sit
    // ACCEPTed, with active fingerprint and retained content, for up to a
    // full day (or forever, if CORPUS_PROMOTION_ENABLED happened to be off
    // at the time) before becoming matchable. This runs the SAME real
    // pipeline the sweep uses (stageCorpusAdmissionPromotionForDecision,
    // then processCorpusAdmissionPromotion — no second shingle/indexing
    // implementation) immediately, at this exact async job boundary, which
    // every real trigger (the deferred post-save callback, a manual retry,
    // the report-admission sweep) already awaits — never fire-and-forget.
    //
    // Also the fix for re-ACCEPT after an admin deactivation: when a
    // deactivated representation's canonical hash is re-uploaded,
    // evaluateCorpusAdmissionCandidate's own pre-check (revoked_at IS NULL)
    // does not see the old, revoked accepted_representations row, so this
    // is a genuinely NEW ACCEPT with its own new acceptedRepresentationId —
    // staged and promoted here exactly like a first-ever ACCEPT. Its own
    // indexPromotionAtomically may legitimately reuse the same underlying
    // corpus_document_representations row (EXACT_CANONICAL_DUPLICATE), but
    // this promotion's own 'indexed' row, backed by the NEW, non-revoked
    // accepted_representation, is what restores
    // findCandidateCorpusRepresentations' own eligibility join (lib/user-
    // submission-corpus.ts: "at least one 'indexed' promotion whose own
    // accepted_representation is not revoked") — matching becomes active
    // again without this module needing to know anything about matching
    // eligibility itself.
    //
    // Deliberately gated the same way the sweep already gates itself
    // (isCorpusPromotionEnabled()) — preserves existing disabled behavior:
    // while off, nothing is staged here either, so a decision accepted
    // while disabled is discovered fresh by the sweep's own batch discovery
    // once the flag is later turned on, exactly as before this fix existed.
    //
    // Failure isolation: this decision is ALREADY committed as ACCEPT and
    // the job is ALREADY marked 'succeeded' above — nothing below this
    // point can roll either back. processCorpusAdmissionPromotion already
    // isolates a genuine indexing failure internally (persists
    // status='failed', returns a value, never throws for that case); the
    // try/catch here exists only for a failure in staging/claiming/processing
    // itself never reaching that internal write (e.g. a connection-level
    // error) — either way, the row is left 'staged' or 'failed' with
    // claimed_at NULL (a failed claim attempt never sets claimed_at at
    // all), exactly the shape runCorpusAdmissionPromotionSweep's own claim
    // query (status IN ('staged','failed')) already discovers and retries,
    // so nothing extra is needed to keep it recoverable.
    //
    // Claim-safety fix: this path does not process a promotion it has not
    // won the claim on. stageAndClaimCorpusAdmissionPromotionForDecision
    // stages (idempotent, unchanged) and then attempts the SAME
    // single-owner claim the sweep's own claim query uses (status IN
    // ('staged','failed') AND unclaimed-or-stale) — a racing sweep tick
    // that claims this exact row first makes this call's own claim a
    // no-op (claimed:false), and this path correctly does not process it a
    // second time. A promotion that is already 'indexed' or 'skipped' can
    // never be claimed either (excluded by the same status filter), so an
    // id returned by staging that turns out to already be terminal is
    // never re-processed here — processCorpusAdmissionPromotion's own
    // defensive terminal-idempotency guard is the second, independent
    // layer of that same guarantee.
    if (decision.decision === "ACCEPT" && isCorpusPromotionEnabled()) {
      try {
        const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(params.openConnection, decision.id);
        if (staged.staged && staged.claimed) {
          await processCorpusAdmissionPromotion(client, { promotionId: staged.promotionId, openConnection: params.openConnection });
        }
      } catch (err) {
        console.error("processReportAdmissionJob: immediate promotion attempt failed (non-fatal — admission remains ACCEPT, and the row stays discoverable/retryable by the existing promotion sweep):", err instanceof Error ? err.message : String(err));
      }
    }

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
 * Called synchronously from PATCH /api/auth/me the moment consent flips
 * from true to false — not deferred, for the same durability reason job
 * creation is not deferred (a durability-critical write must not depend on
 * a callback that might never run).
 *
 * Deliberately narrow: this is a consent change, not a takedown request.
 * It affects only work that has not yet been accepted —
 *  1. users.corpus_reuse_consented_at set to NULL (no new admission
 *     attempts will pass the fresh consent check processReportAdmissionJob
 *     always performs).
 *  2. Every job still 'pending' or 'failed' for this account is cancelled
 *     (status='cancelled') — nothing not-yet-accepted survives to be
 *     processed later.
 * It never touches a 'succeeded' job, its decision row, its retained
 * corpus_admission_content_store text, or its accepted_representations
 * fingerprint — accepted corpus content is durable and outlives a later
 * consent change, exactly as it outlives report/account deletion (see
 * deleteReportCorpusAdmissionData). revoked_at stays unset here; it is
 * reserved for a future, explicitly admin-triggered removal flow.
 *
 * Atomic: both writes run inside ONE real write transaction (the same
 * BEGIN IMMEDIATE + fresh-connection-per-retry mechanism used throughout
 * this module and lib/corpus-admission-gate.ts) — either both commit or
 * neither does. A caller that gets an exception (retries exhausted, or an
 * unexpected error) is guaranteed the account's data is completely
 * unchanged, exactly as if the call had never been made — so simply
 * calling it again (exactly what happens if the browser retries a failed
 * PATCH /api/auth/me) is always safe and will eventually succeed once the
 * transient condition clears; no separate persistent retry-job bookkeeping
 * is needed for this operation, because a rolled-back attempt has done
 * nothing to redo.
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
