import type { Client } from "@libsql/client";
import { E8I_CLEANUP_TARGETS, type CleanupTarget } from "./e8i-cleanup-targets";
import { verifyTarget, type TargetVerification } from "./e8i-cleanup-runner";

/**
 * Phase E8I: the ONLY module in the whole E8I toolset that issues a write
 * statement — deliberately isolated from lib/e8i-cleanup-runner.ts (planning
 * /verification, read-only) so a structural test can prove the dry-run code
 * path never writes (see tests/e8i-cleanup.test.mjs). This module never
 * reads process.env either; it only ever receives an already-constructed
 * Client from its caller (tools/e8i-cleanup.ts, or a test's own disposable
 * local database).
 *
 * applyVerifiedDeletion() re-runs verifyTarget() itself, immediately before
 * writing — it never accepts a previously-computed TargetVerification from
 * a caller, so a plan object computed minutes (or a full CLI invocation)
 * earlier can never be replayed against a database that has since changed
 * underneath it. Every one of the checks in lib/e8i-cleanup-runner.ts's
 * verifyTarget() must still pass or this function performs zero writes for
 * that target.
 *
 * Deletes corpus_submission_references explicitly, then document_identities
 * — the identity delete cascades (drizzle/0013_document_families.sql,
 * drizzle/0019_user_submission_corpus.sql) to document_identity_shingles and
 * the target's own document_family_members row, and SET NULLs any
 * matched_against_identity_id / provenance_sources.document_identity_id
 * pointing at it. This function never touches
 * corpus_document_representations, saved_reports,
 * report_historical_match_snapshots, provenance_sources rows themselves,
 * archive/documents tables, or discovery/ASJP/Crossref tables — see this
 * phase's own task description for why each of those is explicitly
 * out of scope.
 */

export type ApplyOutcome =
  | { status: "applied"; cluster: number; deletedReferenceId: number; deletedIdentityId: string }
  | { status: "refused"; cluster: number; verification: TargetVerification };

export async function applyVerifiedDeletion(client: Client, target: CleanupTarget): Promise<ApplyOutcome> {
  const verification = await verifyTarget(client, target);
  if (!verification.ok) {
    return { status: "refused", cluster: target.cluster, verification };
  }

  await client.execute({
    sql: "DELETE FROM corpus_submission_references WHERE id = ? AND document_identity_id = ?",
    args: [target.deleteSubmissionReferenceId, target.deleteIdentityId],
  });
  await client.execute({
    sql: "DELETE FROM document_identities WHERE id = ?",
    args: [target.deleteIdentityId],
  });

  return {
    status: "applied",
    cluster: target.cluster,
    deletedReferenceId: target.deleteSubmissionReferenceId,
    deletedIdentityId: target.deleteIdentityId,
  };
}

/** Applies each target independently in allowlist order — one target's refusal does not block the others, since they touch disjoint rows. Returns one outcome per target, in order. */
export async function applyAllVerifiedDeletions(
  client: Client,
  targets: readonly CleanupTarget[] = E8I_CLEANUP_TARGETS,
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await applyVerifiedDeletion(client, target));
  }
  return outcomes;
}
