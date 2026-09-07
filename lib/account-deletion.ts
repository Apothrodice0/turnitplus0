import type { Client } from "@libsql/client";
import { deleteReportDocumentData } from "./report-deletion";
import { deleteHistoricalMatchSnapshot } from "./report-historical-match";
import { deleteReportCorpusAdmissionData } from "./corpus-admission-report-integration";

/**
 * Account deletion (production audit fix — no such endpoint existed).
 * Server-side canonical definition of the confirmation phrase DELETE
 * /api/auth/me requires in its request body, alongside the password re-entry
 * check — a second, explicit, hard-to-send-by-accident signal that this
 * request really came from the deliberate UI flow (app/page.tsx's account
 * deletion form), not a stray/buggy client. app/page.tsx cannot import this
 * file directly (lib/account-deletion.ts pulls in @libsql/client, a
 * Node-only dependency that must never reach the browser bundle), so it
 * duplicates this exact literal with a comment pointing back here — keep
 * both in sync if this ever changes.
 */
export const ACCOUNT_DELETION_CONFIRMATION_PHRASE = "DELETE MY ACCOUNT";

export type DeleteAccountDataResult = {
  reportsDeleted: number;
  identitiesProcessed: number;
};

/**
 * Deletes everything the given account exclusively owns: every saved_reports
 * row it owns (+ that report's historical-match snapshot) and every
 * document_identities row attributed to it (+ cascaded shingles/family rows,
 * and any corpus_document_representation that becomes fully unreferenced as
 * a result). Reuses the exact same per-identity cleanup DELETE
 * /api/reports/[id] already relies on (lib/report-deletion.ts's
 * deleteReportDocumentData), so account deletion and single-report deletion
 * can never disagree about what is safe to remove — in particular, a shared
 * corpus_document_representation is only ever deleted once its LAST
 * remaining corpus_submission_references row is gone, so another account's
 * still-live report keeps its evidence exactly as report-deletion.ts already
 * guarantees for the single-report case. Accepted/promoted corpus content is
 * likewise durable: deleteReportCorpusAdmissionData leaves an ACCEPTed
 * decision, its retained text, and its accepted_representations fingerprint
 * completely untouched (only the report's own job-tracking row and any
 * never-accepted decision go), so this function is safe to run against a
 * living account without ever eroding the corpus.
 *
 * Goes further than saved_reports.document_identity_id alone: also queries
 * document_identities directly by account_id, which additionally reaches
 * identities from reports saved before that link existed (a documented,
 * accepted gap for single-report deletion — see lib/report-deletion.ts's own
 * header comment) or any other path that created an identity without
 * immediately linking it to a report. Safe specifically because account_id
 * is direct, reliable attribution set once at creation time
 * (lib/document-identity.ts's createDocumentIdentity) — never a hash-based
 * guess, so there is no risk of touching a different account's data the way
 * a canonical-hash lookup would.
 *
 * Every query and write here is scoped to `accountId` (WHERE user_id = ? /
 * WHERE account_id = ? / a source_ref deterministically built from this
 * account + its own report's device_key + id) — it can never reach another
 * account's rows, and `accountId` must come from the caller's authenticated
 * session, never from request input.
 *
 * Does NOT touch users/sessions/consent state itself — a full account
 * deletion's caller (DELETE /api/auth/me) removes those separately, in its
 * own transaction, only after this function returns; the developer
 * rooms-reset caller (POST /api/developer/reset-rooms) deliberately keeps
 * the account, its sessions, and its consent exactly as they were and only
 * wants the report/room state cleared.
 *
 * Safe to retry: every statement here is a plain DELETE (a no-op, not an
 * error, against a row already gone), and both row sets are queried fresh on
 * every call rather than from a stale precomputed list — a retry after a
 * partial failure simply finds fewer remaining rows and finishes the job.
 * Calling it again once the account already has zero reports is a clean
 * no-op that returns { reportsDeleted: 0, identitiesProcessed: 0 }.
 *
 * options.preserveActivelyPromotedRepresentations is forwarded verbatim to
 * every deleteReportDocumentData call (see that function's header comment).
 * The developer rooms-reset endpoint sets it so a promoted corpus-matching
 * source is never removed as a side effect of clearing the developer's own
 * rooms; the account-deletion path (deleteAccountData below) deliberately
 * leaves it unset, keeping its behavior byte-for-byte identical to before —
 * in the live product no report ever has a corpus_submission_references row
 * at all (recordSubmissionReference has no production caller), so that path
 * never reaches the representation-deletion branch this option guards
 * regardless.
 */
export async function deleteAllReportDataForAccount(
  client: Client,
  accountId: string,
  options: { preserveActivelyPromotedRepresentations?: boolean } = {},
): Promise<DeleteAccountDataResult> {
  const reportsResult = await client.execute({
    sql: "SELECT device_key, id FROM saved_reports WHERE user_id = ?",
    args: [accountId],
  });
  const reports = reportsResult.rows as unknown as { device_key: string; id: string }[];
  for (const report of reports) {
    await deleteHistoricalMatchSnapshot(client, { reportDeviceKey: report.device_key, reportId: report.id });
    await client.execute({
      sql: "DELETE FROM saved_reports WHERE device_key = ? AND id = ?",
      args: [report.device_key, report.id],
    });
    // Corpus-admission cleanup, scoped to this exact (account, deviceKey,
    // report id) — see lib/corpus-admission-report-integration.ts's own
    // comment for why source_ref is built this way, never from
    // document_identity_id, so this can never remove a different report's
    // (this account's or any other account's) retained admission data.
    await deleteReportCorpusAdmissionData(client, { accountId, deviceKey: report.device_key, reportId: report.id });
  }

  const identitiesResult = await client.execute({
    sql: "SELECT id FROM document_identities WHERE account_id = ?",
    args: [accountId],
  });
  const identities = identitiesResult.rows as unknown as { id: string }[];
  for (const identity of identities) {
    await deleteReportDocumentData(client, identity.id, options);
  }

  return { reportsDeleted: reports.length, identitiesProcessed: identities.length };
}

/**
 * Account deletion's dependent-cleanup phase — a thin, stable alias kept for
 * DELETE /api/auth/me (and its tests), which call this immediately before
 * invalidateSessionsAndDeleteUser. See deleteAllReportDataForAccount for the
 * full contract; this name is retained only so account-deletion call sites
 * read as "account data" rather than the more general report/room cleanup
 * the developer rooms-reset endpoint reuses.
 */
export async function deleteAccountData(client: Client, accountId: string): Promise<DeleteAccountDataResult> {
  return deleteAllReportDataForAccount(client, accountId);
}

/**
 * The final, small, fixed-size step: invalidate every active session and
 * delete the user row itself, atomically — either both happen or neither
 * does, avoiding the one inconsistency that matters most (a session left
 * valid for an account whose row is gone, or vice versa). Deliberately NOT
 * wrapped around deleteAccountData above: that function's own statement
 * count scales with how many reports/identities the account has, and this
 * codebase has no need to hold one open transaction across a variable,
 * potentially large number of round trips when every one of those
 * statements is already independently safe to retry. users.
 * corpus_reuse_consented_at (the account's consent state) needs no separate
 * cleanup step — it is a column on the users row itself, removed the moment
 * that row is.
 */
export async function invalidateSessionsAndDeleteUser(client: Client, accountId: string): Promise<void> {
  const tx = await client.transaction("write");
  try {
    await tx.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [accountId] });
    await tx.execute({ sql: "DELETE FROM users WHERE id = ?", args: [accountId] });
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    tx.close();
  }
}
