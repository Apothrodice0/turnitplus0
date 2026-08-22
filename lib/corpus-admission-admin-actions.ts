import { randomUUID } from "node:crypto";
import type { Client, Transaction, InStatement } from "@libsql/client";
import type { CorpusAdmissionConnectionFactory } from "./corpus-admission-gate";

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
 * Sets accepted_representations.revoked_at for the fingerprint belonging to
 * this decision — excluding it from lib/corpus-admission-gate.ts's active
 * family matching, per that column's own reserved purpose. Idempotent: a
 * second deactivate on an already-inactive row is a safe no-op (no second
 * audit row) rather than an error, so two concurrent admin actions (or a
 * double-click) can never produce a misleading double audit trail.
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
