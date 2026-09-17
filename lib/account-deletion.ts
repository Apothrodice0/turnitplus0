import type { Client } from "@libsql/client";
import { buildReportAdmissionSourceRef } from "./corpus-admission-source-ref";

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
 * Reset-workspace performance fix: every statement below is SET-BASED or
 * CHUNKED-BULK, never per-row. The original implementation (still exactly
 * mirrored here, table for table, guard for guard — see each phase's own
 * comment for the line-by-line correspondence) ran lib/report-deletion.ts's
 * deleteReportDocumentData, lib/report-historical-match.ts's
 * deleteHistoricalMatchSnapshot, and lib/corpus-admission-report-
 * integration.ts's deleteReportCorpusAdmissionData once per report/identity
 * — for an 83-report account that meant several hundred sequential Turso
 * round trips (the confirmed cause of the reset-workspace 504). This
 * function now performs the IDENTICAL set of checks and deletes, batched
 * into CHUNK_SIZE-sized statements, so a normal account (a handful of rooms)
 * completes in roughly a dozen round trips regardless of report count, and
 * even a large legacy-accumulation account scales as reports/CHUNK_SIZE, not
 * 1:1 with report count.
 *
 * RESET_BULK_CHUNK_SIZE (200) is deliberately conservative: even the
 * two-column (device_key, report_id) row-value chunks below bind at most
 * 400 parameters per statement, comfortably under every SQLite/libsql
 * variable-count limit this project has ever run against (old and new), and
 * every chunk is still small enough to stay well short of "one giant SQL
 * statement."
 *
 * Deletes everything the given account exclusively owns: every saved_reports
 * row it owns (+ that report's historical-match snapshot + its corpus-
 * admission job/decision bookkeeping) and every document_identities row
 * attributed to it (+ cascaded shingles/family rows via PRAGMA foreign_keys,
 * and any corpus_document_representation that becomes fully unreferenced as
 * a result). Preserves exactly what the original per-row implementation
 * preserved:
 *  - a corpus_document_representation is only ever deleted once its LAST
 *    remaining corpus_submission_references row is gone (checked AFTER the
 *    identities are deleted, using the representation ids collected BEFORE
 *    that delete — the bulk equivalent of the original's per-identity
 *    "remaining count === 0" check), so another account's still-live report
 *    keeps its evidence exactly as lib/report-deletion.ts already guarantees
 *    for the single-report case;
 *  - a decision row (and its cascaded content/fingerprint) is removed ONLY
 *    when it was never ACCEPTed with retained content (checked in bulk
 *    against corpus_admission_content_store, mirroring
 *    deleteReportCorpusAdmissionData's own per-row hasAcceptedContent check
 *    exactly) — accepted/promoted corpus content is durable and this
 *    function can never erode it;
 *  - with options.preserveActivelyPromotedRepresentations set, an otherwise-
 *    orphaned representation that is still a live, non-revoked 'indexed'
 *    corpus-admission promotion survives (the bulk equivalent of
 *    isRepresentationActivelyPromoted, mirroring lib/report-deletion.ts's own
 *    per-representation check exactly).
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
 * Safe to retry: every statement here is a plain, set-based DELETE (a no-op,
 * not an error, against rows already gone), and every row set — reports,
 * identities, candidate representations, accepted/promoted status — is
 * queried FRESH on every call rather than from a stale precomputed list, in
 * the same dependency order the original per-row version used (historical
 * snapshots and admission bookkeeping before saved_reports; candidate
 * representation ids captured before document_identities so the cascade
 * cannot hide them). A retry after a partial failure (e.g. the process died
 * between phase 1 and phase 2) simply finds fewer remaining rows in whichever
 * phase didn't finish and completes the job; nothing here holds a
 * transaction open across phases, so a genuinely interrupted run leaves no
 * torn intermediate state beyond "some of this account's rows are already
 * gone," which the next call resolves correctly either way. Calling it again
 * once the account already has zero reports is a clean no-op that returns
 * { reportsDeleted: 0, identitiesProcessed: 0 }.
 *
 * options.preserveActivelyPromotedRepresentations is forwarded verbatim to
 * the bulk orphan-representation check below (see that phase's own comment).
 * The developer rooms-reset endpoint sets it so a promoted corpus-matching
 * source is never removed as a side effect of clearing the developer's own
 * rooms; the account-deletion path (deleteAccountData below) deliberately
 * leaves it unset, keeping its behavior byte-for-byte identical to before —
 * in the live product no report ever has a corpus_submission_references row
 * at all (recordSubmissionReference has no production caller), so that path
 * never reaches the representation-deletion branch this option guards
 * regardless.
 */
const RESET_BULK_CHUNK_SIZE = 200;

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export async function deleteAllReportDataForAccount(
  client: Client,
  accountId: string,
  options: { preserveActivelyPromotedRepresentations?: boolean } = {},
): Promise<DeleteAccountDataResult> {
  // ---- Phase 1: reports — historical snapshots, corpus-admission
  // bookkeeping, then the saved_reports rows themselves. Order mirrors the
  // original (snapshot + admission cleanup before the report row goes) even
  // though none of these three ever depends on saved_reports still existing
  // — each is keyed entirely by (device_key, report_id) / source_ref values
  // already captured below, never by a live lookup against saved_reports.
  const reportsResult = await client.execute({
    sql: "SELECT device_key, id FROM saved_reports WHERE user_id = ?",
    args: [accountId],
  });
  const reports = reportsResult.rows as unknown as { device_key: string; id: string }[];

  // 1a. Historical-match snapshots — bulk delete by (device_key, report_id)
  // pairs, the same composite key deleteHistoricalMatchSnapshot always used.
  for (const chunk of chunksOf(reports, RESET_BULK_CHUNK_SIZE)) {
    const valuesPlaceholders = chunk.map(() => "(?,?)").join(",");
    await client.execute({
      sql: `DELETE FROM report_historical_match_snapshots WHERE (report_device_key, report_id) IN (VALUES ${valuesPlaceholders})`,
      args: chunk.flatMap((r) => [r.device_key, r.id]),
    });
  }

  // 1b. Corpus-admission bookkeeping — same source_ref format
  // deleteReportCorpusAdmissionData always used, same accepted-content guard
  // (a decision survives iff it has a corpus_admission_content_store row),
  // just resolved in bulk instead of once per report.
  const sourceRefs = reports.map((r) => buildReportAdmissionSourceRef({ accountId, deviceKey: r.device_key, reportId: r.id }));
  const acceptedSourceRefs = new Set<string>();
  for (const chunk of chunksOf(sourceRefs, RESET_BULK_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await client.execute({
      sql: `SELECT DISTINCT d.source_ref AS source_ref FROM corpus_admission_decisions d
            JOIN corpus_admission_content_store cs ON cs.decision_id = d.id
            WHERE d.source_ref IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows as unknown as { source_ref: string }[]) acceptedSourceRefs.add(row.source_ref);
  }
  for (const chunk of chunksOf(sourceRefs, RESET_BULK_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    // The job-tracking row always goes — it exists only to track THIS
    // report's own processing status, moot once the report is gone,
    // regardless of whether its decision was accepted.
    await client.execute({ sql: `DELETE FROM corpus_admission_report_jobs WHERE source_ref IN (${placeholders})`, args: chunk });
    const nonAccepted = chunk.filter((ref) => !acceptedSourceRefs.has(ref));
    if (nonAccepted.length > 0) {
      const nonAcceptedPlaceholders = nonAccepted.map(() => "?").join(",");
      await client.execute({ sql: `DELETE FROM corpus_admission_decisions WHERE source_ref IN (${nonAcceptedPlaceholders})`, args: nonAccepted });
    }
  }

  // 1c. The saved_reports rows themselves — one set-based statement,
  // replacing what was previously one DELETE per report.
  await client.execute({ sql: "DELETE FROM saved_reports WHERE user_id = ?", args: [accountId] });

  // ---- Phase 2: document identities + orphaned, non-promoted
  // representations. Candidate representation ids are captured BEFORE the
  // identities are deleted (the delete cascades corpus_submission_references
  // away with them via PRAGMA foreign_keys), exactly mirroring the original
  // per-identity code's own "read representation_id, then delete the
  // identity, then check what's left" ordering — just batched.
  const identitiesResult = await client.execute({ sql: "SELECT id FROM document_identities WHERE account_id = ?", args: [accountId] });
  const identityIds = (identitiesResult.rows as unknown as { id: string }[]).map((r) => r.id);

  const candidateRepresentationIds = new Set<string>();
  for (const chunk of chunksOf(identityIds, RESET_BULK_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await client.execute({
      sql: `SELECT DISTINCT representation_id FROM corpus_submission_references WHERE document_identity_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows as unknown as { representation_id: string }[]) candidateRepresentationIds.add(row.representation_id);
  }

  // One set-based delete for every document_identities row this account
  // owns — PRAGMA foreign_keys=ON (lib/reports-db.ts) cascades
  // document_identity_shingles, document_family_members, and
  // corpus_submission_references automatically, replacing what was
  // previously one DELETE per identity.
  await client.execute({ sql: "DELETE FROM document_identities WHERE account_id = ?", args: [accountId] });

  // Of the candidates, exclude any representation still referenced by
  // ANOTHER account's still-live report — the bulk form of the original's
  // per-identity "remaining count === 0" check.
  const candidates = [...candidateRepresentationIds];
  const stillReferenced = new Set<string>();
  for (const chunk of chunksOf(candidates, RESET_BULK_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await client.execute({
      sql: `SELECT DISTINCT representation_id FROM corpus_submission_references WHERE representation_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows as unknown as { representation_id: string }[]) stillReferenced.add(row.representation_id);
  }
  const orphanCandidates = candidates.filter((id) => !stillReferenced.has(id));

  // Of the truly-orphaned candidates, exclude any that are actively promoted
  // when the caller asked to preserve them — the bulk form of
  // isRepresentationActivelyPromoted.
  let deletableRepresentationIds = orphanCandidates;
  if (options.preserveActivelyPromotedRepresentations && orphanCandidates.length > 0) {
    const promoted = new Set<string>();
    for (const chunk of chunksOf(orphanCandidates, RESET_BULK_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => "?").join(",");
      const result = await client.execute({
        sql: `SELECT DISTINCT p.representation_id AS representation_id FROM corpus_admission_promotions p
              JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
              WHERE p.representation_id IN (${placeholders}) AND p.status = 'indexed' AND ar.revoked_at IS NULL`,
        args: chunk,
      });
      for (const row of result.rows as unknown as { representation_id: string }[]) promoted.add(row.representation_id);
    }
    deletableRepresentationIds = orphanCandidates.filter((id) => !promoted.has(id));
  }

  for (const chunk of chunksOf(deletableRepresentationIds, RESET_BULK_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    await client.execute({ sql: `DELETE FROM corpus_document_representations WHERE id IN (${placeholders})`, args: chunk });
  }

  return { reportsDeleted: reports.length, identitiesProcessed: identityIds.length };
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
