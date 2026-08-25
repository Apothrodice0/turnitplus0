import type { Client, Transaction } from "@libsql/client";
import type { CorpusAdmissionConnectionFactory } from "./corpus-admission-gate";

/**
 * Task B1B: daily retention cleanup for stale, NON-accepted corpus-admission
 * metadata. Runs as an additional step inside the EXISTING report-admission
 * sweep route (app/api/internal/corpus-admission-sweep/route.ts) — no new
 * Vercel cron entry. The Hobby plan's 2 cron slots are already spent by that
 * route and app/api/internal/corpus-admission-promotion-sweep/route.ts (see
 * vercel.json); this module is invoked from the FIRST one, gated by its own
 * independent CORPUS_RETENTION_ENABLED flag (default false, read fresh on
 * every call — no caching, same convention as isCorpusAdmissionEnabled()).
 *
 * Deletes ONLY:
 *
 *  1. corpus_admission_decisions rows where decision IN ('REJECT','REVIEW'),
 *     created_at older than the retention cutoff, with no retained content
 *     (content_store_id IS NULL — REJECT/REVIEW never gets one, by
 *     construction: see drizzle/0029's own header comment) and no
 *     corpus_admission_report_jobs row still pointing at it via decision_id.
 *
 *     That last condition is the load-bearing one, not a belt-and-suspenders
 *     extra: a decision produced by the LIVE report-upload path always has a
 *     job row (lib/corpus-admission-report-integration.ts's
 *     processReportAdmissionJob sets decision_id on the very same UPDATE
 *     that marks the job 'succeeded', for every decision it ever produces —
 *     REJECT/REVIEW included) for as long as the underlying report exists.
 *     lib/corpus-admission-admin-repo.ts's deriveStatus() would throw the
 *     moment that job's status is read as anything other than
 *     pending/failed/cancelled/succeeded-with-a-decision — deleting a
 *     decision a live 'succeeded' job still depends on would silently break
 *     the admin dashboard for that row. And when the report IS deleted,
 *     lib/corpus-admission-report-integration.ts's own
 *     deleteReportCorpusAdmissionData already removes that exact decision
 *     row synchronously at deletion time (a REJECT/REVIEW decision has no
 *     accepted content, so it is never left behind) — so a decision that
 *     went through the live path never reaches this sweep at all, whether
 *     its report still exists or not.
 *
 *     What DOES reach this sweep: REJECT/REVIEW decisions from a batch/
 *     tooling run (run_id set, never a live job — e.g. the calibrate/
 *     refreeze/rerun workflow drizzle/0029's own header comment describes)
 *     that never had a job row to begin with, and so never gained this
 *     dependency in the first place.
 *
 *     Decision rows are otherwise immutable for their entire lifetime: every
 *     evaluation, live or re-run, always INSERTs a brand-new row (see
 *     insertDecisionRow / acceptWithAtomicDedup in lib/corpus-admission-gate.ts)
 *     — nothing ever UPDATEs an existing decision's `decision` column or its
 *     content_store_id, and reEvaluateCorpusAdmissionCandidate can only ever
 *     be called on a decision that ALREADY has retained content (it JOINs
 *     corpus_admission_content_store ON c.id = d.content_store_id and throws
 *     if that join finds nothing) — so a REJECT/REVIEW decision (no content
 *     store row, by construction) can never later "become ACCEPT" by any
 *     mechanism this codebase has. Its dependency set is therefore fixed
 *     forever at creation time; there is no reachable race where a decision
 *     eligible by this sweep's own rule could ever stop being eligible. The
 *     job-existence recheck is still re-applied at DELETE time anyway (see
 *     sweepStaleDecisions below) — defense in depth, and honesty about
 *     "recheck inside the same transaction" as a real code path rather than
 *     an argument trusted from a comment alone.
 *
 *  2. corpus_admission_report_jobs rows with status IN ('failed','cancelled'),
 *     updated_at older than the retention cutoff. These rows carry
 *     account_id/device_key/report_id directly — the actual PII-adjacent
 *     data this policy exists to age out. A 'failed' job CAN legitimately
 *     transition to 'succeeded' concurrently, via runReportAdmissionRetrySweep
 *     (the sibling operation in this SAME route) — the DELETE re-applies its
 *     own status (and age) filter, so a job retried successfully between
 *     selection and deletion survives.
 *
 * Never deletes, and structurally cannot reach:
 *  - corpus_admission_accepted_representations / _shingles / content_store
 *    (ACCEPT-only tables; this sweep's decision query is scoped to
 *    REJECT/REVIEW and can never select an ACCEPT row).
 *  - corpus_admission_promotions (ACCEPT-only decisions; same reasoning).
 *    'failed' promotions are deliberately left alone — see
 *    countRetryableFailedPromotions's own comment for why purging one is
 *    never provably safe within what this sweep is allowed to touch.
 *  - corpus_admission_admin_audit_log — never referenced by this module.
 *  - users, saved_reports, sessions, document_identities, or anything
 *    outside the corpus_admission_* namespace.
 *
 * Idempotent by construction: a repeated sweep simply finds fewer (or zero)
 * age-eligible rows on each run — deleting an already-deleted row is not a
 * distinct code path, it's just "0 candidates found."
 */

export function isCorpusRetentionEnabled(): boolean {
  return process.env.CORPUS_RETENTION_ENABLED === "true";
}

export const CORPUS_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_BATCH_SIZE = 200;

const MAX_RETENTION_BUSY_RETRIES = 10;
function retentionBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}
function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

/**
 * Fresh-connection-per-retry write transaction — the same shape used
 * throughout the corpus-admission-* module family (see e.g.
 * lib/corpus-admission-admin-actions.ts's runAdminActionTransaction):
 * retrying on the SAME connection does not reliably recover from
 * cross-process SQLITE_BUSY in this project's local-file libSQL driver.
 */
async function runRetentionTransaction<T>(openConnection: CorpusAdmissionConnectionFactory, work: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETENTION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      const tx = await attemptClient.transaction("write");
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_RETENTION_BUSY_RETRIES) {
        await retentionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
  throw new Error("runRetentionTransaction: exhausted retries without resolving");
}

type BatchOutcome = { deleted: number; skippedProtected: number };

/**
 * SELECT candidates by age+type only, then DELETE re-applying the FULL
 * eligibility predicate (age, type, and every dependency) inside the same
 * transaction — the delete is the actual recheck, not the earlier SELECT.
 * skippedProtected = candidates that were age-eligible but the DELETE's own
 * WHERE clause excluded at the moment of deletion (a dependency that exists
 * now, whether or not it existed when the SELECT ran).
 */
async function sweepStaleDecisions(openConnection: CorpusAdmissionConnectionFactory, batchSize: number, retentionDays: number): Promise<BatchOutcome> {
  return runRetentionTransaction(openConnection, async (tx) => {
    const ageOffset = `-${retentionDays} days`;
    const candidates = await tx.execute({
      sql: `SELECT id FROM corpus_admission_decisions
            WHERE decision IN ('REJECT','REVIEW') AND created_at < datetime('now', ?)
            LIMIT ?`,
      args: [ageOffset, batchSize],
    });
    const ids = (candidates.rows as unknown as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return { deleted: 0, skippedProtected: 0 };

    const placeholders = ids.map(() => "?").join(",");
    const result = await tx.execute({
      sql: `DELETE FROM corpus_admission_decisions
            WHERE id IN (${placeholders})
              AND decision IN ('REJECT','REVIEW')
              AND created_at < datetime('now', ?)
              AND content_store_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM corpus_admission_content_store cs WHERE cs.decision_id = corpus_admission_decisions.id)
              AND NOT EXISTS (SELECT 1 FROM corpus_admission_promotions p WHERE p.decision_id = corpus_admission_decisions.id)
              AND NOT EXISTS (SELECT 1 FROM corpus_admission_report_jobs j WHERE j.decision_id = corpus_admission_decisions.id)`,
      args: [...ids, ageOffset],
    });
    return { deleted: result.rowsAffected, skippedProtected: ids.length - result.rowsAffected };
  });
}

async function sweepStaleJobs(openConnection: CorpusAdmissionConnectionFactory, batchSize: number, retentionDays: number): Promise<BatchOutcome> {
  return runRetentionTransaction(openConnection, async (tx) => {
    const ageOffset = `-${retentionDays} days`;
    const candidates = await tx.execute({
      sql: `SELECT id FROM corpus_admission_report_jobs
            WHERE status IN ('failed','cancelled') AND updated_at < datetime('now', ?)
            LIMIT ?`,
      args: [ageOffset, batchSize],
    });
    const ids = (candidates.rows as unknown as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return { deleted: 0, skippedProtected: 0 };

    const placeholders = ids.map(() => "?").join(",");
    const result = await tx.execute({
      sql: `DELETE FROM corpus_admission_report_jobs
            WHERE id IN (${placeholders}) AND status IN ('failed','cancelled') AND updated_at < datetime('now', ?)`,
      args: [...ids, ageOffset],
    });
    return { deleted: result.rowsAffected, skippedProtected: ids.length - result.rowsAffected };
  });
}

/**
 * Read-only observability count — NEVER deletes anything. Every
 * corpus_admission_promotions row with status='failed' belongs to a
 * decision that WAS ACCEPTed (promotions only ever exist for ACCEPT
 * decisions — see drizzle/0034's own header comment; this sweep's decision
 * cleanup above is scoped to REJECT/REVIEW and can never touch one).
 * lib/corpus-admission-promotion.ts's own daily sweep
 * (runCorpusAdmissionPromotionSweep, the OTHER existing cron route) already
 * retries every 'failed' promotion indefinitely, with no expiry of its own.
 * As long as this module leaves every ACCEPT decision and everything it
 * owns alone — which it always does; its decision query can never select
 * one — the accepted content a 'failed' promotion would index is still
 * there, so purging the promotion row would only cause that sweep's own
 * discovery query (`INSERT OR IGNORE ... WHERE d.decision='ACCEPT' AND NOT
 * EXISTS (a promotions row)`) to recreate an equivalent 'staged' row on its
 * very next run — pure churn, not a real cleanup, and would touch
 * "promotion eligibility" bookkeeping this task explicitly puts off limits.
 * Conclusion: failed promotions should remain retryable indefinitely, not
 * expire. This count exists so that conclusion is visible in the sweep's
 * own response rather than asserted only in a comment.
 */
async function countRetryableFailedPromotions(client: Client): Promise<number> {
  const result = await client.execute("SELECT COUNT(*) AS c FROM corpus_admission_promotions WHERE status = 'failed'");
  return Number((result.rows[0] as unknown as { c: number | bigint }).c);
}

export type CorpusAdmissionRetentionSweepResult = {
  decisionsDeleted: number;
  jobsDeleted: number;
  skippedProtected: number;
  /** Observability only — see countRetryableFailedPromotions's own comment for why these are never purged here. */
  failedPromotionsRetryable: number;
};

export type RunCorpusAdmissionRetentionSweepParams = {
  openConnection: CorpusAdmissionConnectionFactory;
  batchSize?: number;
  retentionDays?: number;
};

/** One bounded batch per table, per invocation — the next day's cron continues where this one left off if a table had more than batchSize stale rows. */
export async function runCorpusAdmissionRetentionSweep(client: Client, params: RunCorpusAdmissionRetentionSweepParams): Promise<CorpusAdmissionRetentionSweepResult> {
  const batchSize = params.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const retentionDays = params.retentionDays ?? CORPUS_RETENTION_DAYS;

  const decisions = await sweepStaleDecisions(params.openConnection, batchSize, retentionDays);
  const jobs = await sweepStaleJobs(params.openConnection, batchSize, retentionDays);
  const failedPromotionsRetryable = await countRetryableFailedPromotions(client);

  return {
    decisionsDeleted: decisions.deleted,
    jobsDeleted: jobs.deleted,
    skippedProtected: decisions.skippedProtected + jobs.skippedProtected,
    failedPromotionsRetryable,
  };
}
