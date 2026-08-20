import type { Client } from "@libsql/client";

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
 *    avoid on the other end.
 *  - provenance_sources / discovery_attempts rows whose document_identity_id
 *    pointed here: ON DELETE SET NULL per their own schema definition
 *    (db/schema.ts) — they describe EXTERNAL candidate sources, never this
 *    user's own submitted text, so retaining them with the link nulled out
 *    is correct, not a privacy gap.
 *  - document_families: an emptied family (its last member removed) is left
 *    as an empty row — harmless clutter (id + timestamps only, no text, no
 *    account reference), not a privacy concern, so cleaning it up is out of
 *    scope for a text-retention fix.
 *  - reuse_context_declarations / historical_match_shadow_evaluations: no
 *    DB-level FOREIGN KEY to document_identities (see db/schema.ts's own
 *    comment on both tables) and no document/passage text in either — same
 *    "ids, enums, and timestamps only" shape as report_historical_match_
 *    snapshots, which the DELETE handler already explicitly cleans up
 *    separately. Left untouched here to keep this change scoped to actual
 *    text retention; a dangling id in either is not a text leak.
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
      const representationDelete = await client.execute({
        sql: "DELETE FROM corpus_document_representations WHERE id = ?",
        args: [representationId],
      });
      representationDeleted = representationDelete.rowsAffected > 0;
    }
  }

  return { identityDeleted, representationDeleted };
}
