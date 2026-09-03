import type { Client } from "@libsql/client";
import { isRepresentationActivelyPromoted } from "./user-submission-corpus";

/**
 * Privacy hardening (production audit fix): completes report deletion by
 * also removing the document-identity/shingle/family/corpus rows a report's
 * OWN submission created — see db/schema.ts's saved_reports.document_identity_id
 * comment for why this requires that exact link rather than a hash-based
 * guess. Called from app/api/reports/[id]/route.ts's DELETE handler, right
 * after (or before — order does not matter, since neither delete depends on
 * the other's completion) the saved_reports row itself is deleted.
 *
 * A document_identities row belongs to at most one saved_reports row, ever:
 * captureDocumentIdentityAndFamily() (lib/document-family.ts) is only called
 * when isFirstSaveOfThisReport is true, which is keyed on (device_key, id) —
 * a distinct value per report, never shared across two different reports
 * even when their text is byte-identical. So fully deleting the identity row
 * here can never orphan or corrupt a *different* still-live report.
 *
 * What this does NOT delete, and why:
 *  - corpus_document_representations.canonical_text: only deleted when this
 *    was the LAST corpus_submission_references row pointing at it (checked
 *    after the identity delete, since that delete cascades the reference
 *    away first). The same text can legitimately be shared by another
 *    account's still-live report (EXACT_CANONICAL_DUPLICATE) or by a
 *    different report of this same account — deleting shared text out from
 *    under a live reference would be the exact bug this function exists to
 *    avoid on the other end. With
 *    options.preserveActivelyPromotedRepresentations set (the developer
 *    "Clear my rooms" debug reset — app/api/developer/reset-rooms/route.ts),
 *    a representation that is ALSO backed by a live, non-revoked 'indexed'
 *    corpus-admission promotion is additionally kept even when it has no
 *    remaining corpus_submission_references row: an ACCEPTed + promoted
 *    representation is durable corpus content (lib/corpus-admission-promotion.ts),
 *    still matched against via corpus_admission_promotions (never via a
 *    submission reference — a promoted representation structurally never has
 *    one), so removing it would silently drop a live matching source and
 *    would also hit corpus_admission_promotions.representation_id's
 *    ON DELETE NO ACTION constraint. Default (unset) keeps the exact prior
 *    behavior for the DELETE /api/reports/[id] and account-deletion paths.
 *  - provenance_sources / discovery_attempts rows whose document_identity_id
 *    pointed here: ON DELETE SET NULL per their own schema definition
 *    (db/schema.ts) — they describe EXTERNAL candidate sources, never this
 *    user's own submitted text, so retaining them with the link nulled out
 *    is correct, not a privacy gap.
 *  - document_families: an emptied family (its last member removed) is left
 *    as an empty row — harmless clutter (id + timestamps only, no text, no
 *    account reference), not a privacy concern, so cleaning it up is out of
 *    scope for a text-retention fix.
 *  - historical_match_shadow_evaluations: no DB-level FOREIGN KEY to
 *    document_identities (see db/schema.ts's own comment on that table) and
 *    no document/passage text in it — same "ids, enums, and timestamps only"
 *    shape as report_historical_match_snapshots, which the DELETE handler
 *    already explicitly cleans up separately. Left untouched here to keep
 *    this change scoped to actual text retention; a dangling id in it is not
 *    a text leak. (reuse_context_declarations, from the removed E8S
 *    reuse-context workflow, has the same id-only shape and the same
 *    non-issue; its table is retained but dormant — see
 *    drizzle/0022_reuse_context_declarations.sql.)
 */
export type DeleteReportDocumentDataResult = {
  /** True if a document_identities row was found and deleted for this id. */
  identityDeleted: boolean;
  /** True if an orphaned corpus_document_representations row (its last reference just removed) was also deleted. */
  representationDeleted: boolean;
};

export async function deleteReportDocumentData(
  client: Client,
  documentIdentityId: string | null,
  options: { preserveActivelyPromotedRepresentations?: boolean } = {},
): Promise<DeleteReportDocumentDataResult> {
  if (!documentIdentityId) {
    return { identityDeleted: false, representationDeleted: false };
  }

  const referenceResult = await client.execute({
    sql: "SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?",
    args: [documentIdentityId],
  });
  const representationId = (referenceResult.rows[0] as unknown as { representation_id: string } | undefined)?.representation_id ?? null;

  const deleted = await client.execute({
    sql: "DELETE FROM document_identities WHERE id = ?",
    args: [documentIdentityId],
  });
  const identityDeleted = deleted.rowsAffected > 0;

  let representationDeleted = false;
  if (identityDeleted && representationId) {
    const remaining = await client.execute({
      sql: "SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE representation_id = ?",
      args: [representationId],
    });
    const remainingCount = Number((remaining.rows[0] as unknown as { cnt: number | bigint }).cnt);
    if (remainingCount === 0) {
      // Debug-reset guard: never remove a representation that is still a
      // live promoted corpus-matching source just because this developer's
      // own (now-deleted) submission reference was its last one — see this
      // function's own header comment.
      const keepAsPromoted =
        options.preserveActivelyPromotedRepresentations === true &&
        (await isRepresentationActivelyPromoted(client, representationId));
      if (!keepAsPromoted) {
        const representationDelete = await client.execute({
          sql: "DELETE FROM corpus_document_representations WHERE id = ?",
          args: [representationId],
        });
        representationDeleted = representationDelete.rowsAffected > 0;
      }
    }
  }

  return { identityDeleted, representationDeleted };
}
