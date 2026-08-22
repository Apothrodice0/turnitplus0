import { randomUUID } from "node:crypto";
import type { Client, Transaction, InStatement } from "@libsql/client";
import type { CorpusAdmissionConnectionFactory } from "./corpus-admission-gate";
import { invalidateHistoricalMatchSnapshotsForRepresentation, bumpCorpusMatchGeneration } from "./report-historical-match";

/**
 * Mutating actions for the admin-only corpus-admission dashboard
 * (app/admin/corpus/*, app/api/admin/corpus/*). Performs no authorization
 * check of its own — callers MUST gate every one of these behind
 * lib/auth-session.ts's getAdminSessionUser() first, exactly like
 * lib/corpus-admission-admin-repo.ts's own documented contract.
 *
 * Every state-changing action here (deactivate, reactivate) runs inside ONE
 * real write transaction — fresh connection per SQLITE_BUSY retry attempt,
 * the same mechanism used throughout lib/corpus-admission-gate.ts and
 * lib/corpus-admission-report-integration.ts (confirmed this session:
 * retrying on the SAME connection does not reliably recover from
 * cross-process SQLITE_BUSY) — so the state change and its audit row commit
 * together or not at all; a failed attempt leaves the row completely
 * unchanged, with no audit row for something that did not actually happen.
 *
 * revealRetainedTextPreview is the one exception to "transaction wraps
 * everything": it is a read (the retained text) plus a single write (the
 * audit row), not a state change, and the ordering — not the atomicity — is
 * what matters: the audit row must be written, and that write must
 * SUCCEED, before the preview is ever returned to the caller. If the audit
 * write fails, the text is never included in the result at all.
 */

const MAX_ACTION_BUSY_RETRIES = 10;
function actionBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}
function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}
function isUniqueActiveHashViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    /SQLITE_CONSTRAINT/i.test(err.message) &&
    /ux_corpus_admission_accepted_representations_canonical_sha256_active|corpus_admission_accepted_representations\.canonical_sha256/i.test(err.message)
  );
}

/**
 * Generic fresh-connection-per-retry write transaction: opens a connection
 * via openConnection, begins a real write transaction, runs `work` against
 * it, commits, and returns work's result — retrying the WHOLE attempt
 * (fresh connection included) on SQLITE_BUSY. `work` may itself catch and
 * handle a specific constraint violation to return a typed outcome instead
 * of throwing (see reactivateAcceptedRepresentation) — only an error that
 * escapes `work` triggers rollback-and-possibly-retry here.
 */
async function runAdminActionTransaction<T>(openConnection: CorpusAdmissionConnectionFactory, work: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ACTION_BUSY_RETRIES; attempt += 1) {
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
      if (isSqliteBusyError(err) && attempt < MAX_ACTION_BUSY_RETRIES) {
        await actionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
  throw new Error("runAdminActionTransaction: exhausted retries without resolving");
}

async function executeWithRetry(openConnection: CorpusAdmissionConnectionFactory, stmt: InStatement): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ACTION_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      await attemptClient.execute(stmt);
      return;
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_ACTION_BUSY_RETRIES) {
        await actionBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
}

type AuditAction = "deactivate" | "reactivate" | "view_retained_text";

async function insertAuditRow(
  exec: { execute(stmt: InStatement): Promise<unknown> },
  params: { adminUserId: string; action: AuditAction; decisionId: string; acceptedRepresentationId: string | null; reason: string | null },
): Promise<void> {
  await exec.execute({
    sql: `INSERT INTO corpus_admission_admin_audit_log (id, admin_user_id, action, decision_id, accepted_representation_id, reason, created_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), params.adminUserId, params.action, params.decisionId, params.acceptedRepresentationId, params.reason],
  });
}

// ============================================================================
// Admin reason validation (required, short) — shared by deactivate/reactivate
// ============================================================================

const MIN_REASON_LENGTH = 3;
const MAX_REASON_LENGTH = 500;

export type AdminReasonValidation = { ok: true; reason: string } | { ok: false; error: string };

/** A "short admin reason" is required for deactivate/reactivate — never optional, never defaulted. */
export function validateAdminReason(raw: unknown): AdminReasonValidation {
  if (typeof raw !== "string") return { ok: false, error: "reason is required and must be a string" };
  const trimmed = raw.trim();
  if (trimmed.length < MIN_REASON_LENGTH) return { ok: false, error: `reason must be at least ${MIN_REASON_LENGTH} characters` };
  if (trimmed.length > MAX_REASON_LENGTH) return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
  return { ok: true, reason: trimmed };
}

// ============================================================================
// Deactivate / reactivate
// ============================================================================

export type DeactivateOutcome =
  | { outcome: "not_found" }
  | { outcome: "already_inactive"; acceptedRepresentationId: string }
  | { outcome: "deactivated"; acceptedRepresentationId: string };

export type DeactivateParams = {
  decisionId: string;
  adminUserId: string;
  reason: string;
  openConnection: CorpusAdmissionConnectionFactory;
};

/**
 * Looks up the shared-matching-index representation this decision's
 * promotion (if any) resolved to — used only to know WHICH cached
 * historical-match snapshots need invalidating after a deactivate/
 * reactivate, never returned to any caller outside this module. null when
 * this decision was never promoted (nothing to invalidate) or its
 * promotion has not reached 'indexed' yet.
 */
async function findIndexedPromotionRepresentationId(tx: Transaction, decisionId: string): Promise<string | null> {
  const result = await tx.execute({
    sql: "SELECT representation_id FROM corpus_admission_promotions WHERE decision_id = ? AND status = 'indexed'",
    args: [decisionId],
  });
  const row = result.rows[0] as unknown as { representation_id: string | null } | undefined;
  return row?.representation_id ?? null;
}

/**
 * Sets accepted_representations.revoked_at for the fingerprint belonging to
 * this decision — excluding it from lib/corpus-admission-gate.ts's active
 * family matching, per that column's own reserved purpose. Idempotent: a
 * second deactivate on an already-inactive row is a safe no-op (no second
 * audit row) rather than an error, so two concurrent admin actions (or a
 * double-click) can never produce a misleading double audit trail.
 *
 * If this decision has an 'indexed' promotion, the same transaction does
 * TWO things to keep cached historical-match snapshots correct — this
 * file's own review corrected an earlier version of this comment that
 * claimed targeted deletion alone was "sound and sufficient" here, which
 * is wrong:
 *   1. Targeted, per-representation deletion (unchanged) — an immediate-
 *      effect OPTIMIZATION for the common, non-racing case: a report
 *      already holding a cached match against this representation has it
 *      removed in the SAME commit, not lazily on next view.
 *   2. A GLOBAL generation bump (drizzle/0036) — the actual correctness
 *      backstop, required because targeted deletion has a real race: a
 *      concurrent getOrComputeHistoricalMatchSnapshot call can READ this
 *      representation while it is still eligible (before this transaction
 *      commits), then not WRITE its snapshot until AFTER this transaction
 *      (and its targeted DELETE) has already committed — the DELETE runs
 *      against a row that does not exist yet, finds nothing, and the
 *      concurrent write lands moments later already stale, with nothing
 *      left to ever invalidate it. The generation bump closes this: that
 *      concurrent computation captured the OLD generation value before it
 *      started (see lib/report-historical-match.ts's own header comment),
 *      so its stale write is stamped with a generation this bump has
 *      already moved past — correctly rejected as stale the very next time
 *      anyone views that report, regardless of exactly when its write
 *      landed relative to this commit.
 * Unconditional whenever a promotion exists, regardless of whether OTHER
 * active sources still back that representation (see
 * lib/user-submission-corpus.ts's own multi-source eligibility comment) —
 * determining in advance whether eligibility actually flipped would
 * duplicate that query's own logic for no real benefit; an unnecessary
 * recompute is harmless, a missed one is not.
 */
export async function deactivateAcceptedRepresentation(params: DeactivateParams): Promise<DeactivateOutcome> {
  return runAdminActionTransaction(params.openConnection, async (tx) => {
    const row = await tx.execute({
      sql: "SELECT id, revoked_at FROM corpus_admission_accepted_representations WHERE decision_id = ?",
      args: [params.decisionId],
    });
    const rep = row.rows[0] as unknown as { id: string; revoked_at: string | null } | undefined;
    if (!rep) return { outcome: "not_found" as const };
    if (rep.revoked_at !== null) return { outcome: "already_inactive" as const, acceptedRepresentationId: rep.id };

    await tx.execute({
      sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [rep.id],
    });
    const representationId = await findIndexedPromotionRepresentationId(tx, params.decisionId);
    if (representationId) {
      await invalidateHistoricalMatchSnapshotsForRepresentation(tx, representationId);
      await bumpCorpusMatchGeneration(tx);
    }
    await insertAuditRow(tx, { adminUserId: params.adminUserId, action: "deactivate", decisionId: params.decisionId, acceptedRepresentationId: rep.id, reason: params.reason });
    return { outcome: "deactivated" as const, acceptedRepresentationId: rep.id };
  });
}

export type ReactivateOutcome =
  | { outcome: "not_found" }
  | { outcome: "already_active"; acceptedRepresentationId: string }
  | { outcome: "conflict"; acceptedRepresentationId: string; activeConflictSourceRef: string }
  | { outcome: "reactivated"; acceptedRepresentationId: string };

export type ReactivateParams = DeactivateParams;

/**
 * Clears revoked_at for the fingerprint belonging to this decision — UNLESS
 * a different, currently-active fingerprint already holds the same
 * canonical_sha256 (the exact scenario the REPLACEMENT-ADMISSION behavior
 * from the previous session proves is possible: content was deactivated,
 * then a later authorized submission of the same content was independently
 * accepted and became canonical). Reactivating the original in that case
 * would violate the partial UNIQUE index
 * (ux_corpus_admission_accepted_representations_canonical_sha256_active) —
 * this returns a typed 'conflict' outcome instead, identifying the
 * currently-active row, and never lets the underlying constraint violation
 * surface as an unhandled error. A pre-check inside the same write
 * transaction closes the common case cheaply; the UNIQUE index itself
 * remains the authoritative backstop for the underlying UPDATE, caught the
 * same way lib/corpus-admission-gate.ts treats its own accepted-hash
 * UNIQUE violation as an expected, typed outcome rather than an internal
 * error.
 *
 * If this decision has an 'indexed' promotion, the same transaction also
 * bumps the GLOBAL corpus-match generation (drizzle/0036) — no targeted,
 * per-representation invalidation here at all (unlike
 * deactivateAcceptedRepresentation, which does the bump AND a targeted
 * delete as an immediate-effect optimization): reactivation ADDS
 * eligibility back, and a report whose cached snapshot never referenced
 * this representation at all (because it wasn't eligible the last time
 * that report was viewed) could still textually match it now — a search
 * over stored snapshot rows can never discover a report that's missing the
 * very thing it should gain, so there is no useful targeted delete to run
 * in this direction. See lib/report-historical-match.ts's own header
 * comment for the full argument.
 */
export async function reactivateAcceptedRepresentation(params: ReactivateParams): Promise<ReactivateOutcome> {
  return runAdminActionTransaction(params.openConnection, async (tx) => {
    const row = await tx.execute({
      sql: "SELECT id, canonical_sha256, revoked_at FROM corpus_admission_accepted_representations WHERE decision_id = ?",
      args: [params.decisionId],
    });
    const rep = row.rows[0] as unknown as { id: string; canonical_sha256: string; revoked_at: string | null } | undefined;
    if (!rep) return { outcome: "not_found" as const };
    if (rep.revoked_at === null) return { outcome: "already_active" as const, acceptedRepresentationId: rep.id };

    const findActiveConflict = async () => {
      const result = await tx.execute({
        sql: `SELECT ar.id, d.source_ref FROM corpus_admission_accepted_representations ar
              JOIN corpus_admission_decisions d ON d.id = ar.decision_id
              WHERE ar.canonical_sha256 = ? AND ar.revoked_at IS NULL AND ar.id != ?`,
        args: [rep.canonical_sha256, rep.id],
      });
      return result.rows[0] as unknown as { id: string; source_ref: string } | undefined;
    };

    const preCheckConflict = await findActiveConflict();
    if (preCheckConflict) {
      return { outcome: "conflict" as const, acceptedRepresentationId: rep.id, activeConflictSourceRef: preCheckConflict.source_ref };
    }

    try {
      await tx.execute({
        sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = NULL WHERE id = ?",
        args: [rep.id],
      });
    } catch (err) {
      if (isUniqueActiveHashViolation(err)) {
        const winner = await findActiveConflict();
        return { outcome: "conflict" as const, acceptedRepresentationId: rep.id, activeConflictSourceRef: winner?.source_ref ?? "unknown" };
      }
      throw err;
    }

    // Global generation bump — see this function's own header comment for
    // why this must NOT be the same targeted invalidation deactivate uses.
    // Gated on an indexed promotion actually existing (same lookup
    // deactivate uses) purely to skip a pointless global bump when
    // reactivating a decision that was never promoted into the shared
    // index at all — reactivation itself always proceeds either way.
    const representationId = await findIndexedPromotionRepresentationId(tx, params.decisionId);
    if (representationId) await bumpCorpusMatchGeneration(tx);
    await insertAuditRow(tx, { adminUserId: params.adminUserId, action: "reactivate", decisionId: params.decisionId, acceptedRepresentationId: rep.id, reason: params.reason });
    return { outcome: "reactivated" as const, acceptedRepresentationId: rep.id };
  });
}

// ============================================================================
// Retained-text preview reveal — audit-write-before-return
// ============================================================================

const MAX_PREVIEW_CHARS = 2000;

export type RevealRetainedTextPreviewOutcome =
  | { outcome: "not_found" }
  | { outcome: "audit_failed" }
  | { outcome: "revealed"; preview: string; truncated: boolean; fullLength: number };

export type RevealRetainedTextPreviewParams = {
  decisionId: string;
  adminUserId: string;
  openConnection: CorpusAdmissionConnectionFactory;
};

/**
 * Never returns the full retained text — only a bounded preview
 * (MAX_PREVIEW_CHARS). The audit row is written FIRST (with its own
 * fresh-connection BUSY retry) and must succeed before `preview` is ever
 * populated in the result — see this module's own header comment. No
 * reason is collected or required here (only deactivate/reactivate require
 * one).
 */
export async function revealRetainedTextPreview(client: Client, params: RevealRetainedTextPreviewParams): Promise<RevealRetainedTextPreviewOutcome> {
  const row = await client.execute({
    sql: `SELECT cs.canonical_text FROM corpus_admission_content_store cs
          JOIN corpus_admission_decisions d ON d.id = cs.decision_id
          WHERE d.id = ?`,
    args: [params.decisionId],
  });
  const textRow = row.rows[0] as unknown as { canonical_text: string } | undefined;
  if (!textRow) return { outcome: "not_found" };

  const fullText = textRow.canonical_text;
  const preview = fullText.slice(0, MAX_PREVIEW_CHARS);
  const truncated = fullText.length > MAX_PREVIEW_CHARS;

  try {
    await executeWithRetry(params.openConnection, {
      sql: `INSERT INTO corpus_admission_admin_audit_log (id, admin_user_id, action, decision_id, accepted_representation_id, reason, created_at)
            VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [randomUUID(), params.adminUserId, "view_retained_text", params.decisionId, null, null],
    });
  } catch {
    return { outcome: "audit_failed" };
  }

  return { outcome: "revealed", preview, truncated, fullLength: fullText.length };
}
