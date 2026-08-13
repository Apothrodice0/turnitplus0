import type { Client } from "@libsql/client";
import { findFamilyForIdentity, findFamilyMembers, type FamilyMember } from "./document-family";

/**
 * Phase C: submitter-relationship classification. This is the account-based
 * layer on top of Phase B's text-based family grouping — deliberately kept
 * in its own module because text determines family membership, while
 * account identity determines SELF vs PRIOR_SUBMISSION (frozen architecture
 * Hard Rule #5: title/author/account never decide family membership by
 * themselves; here, symmetrically, family membership never decides account
 * relationship by itself — the two are computed independently and only
 * combined by the caller).
 *
 * Only two of the frozen architecture's three categories exist here:
 * SELF and PRIOR_SUBMISSION. VERIFIED_SOURCE is not implemented anywhere in
 * this codebase yet — nothing here should be read as a step toward it.
 *
 * Nothing in this module is wired into similarity scoring, AI scoring, or
 * report display. It is a queryable capability: given a document identity,
 * what is its relationship to each other member of its family, if any.
 */

export type SubmitterRelationship = "SELF" | "PRIOR_SUBMISSION";

/**
 * SELF requires *proof* of shared identity: both account ids present and
 * equal. Anything else — a genuinely different account, or either side
 * anonymous (account_id null) — falls through to PRIOR_SUBMISSION. This is
 * deliberately the conservative direction: an anonymous submission can never
 * claim SELF-exclusion for anything, because there is no account to prove
 * "self" against. Under-excluding is safe; over-excluding (Hard Rule #1:
 * SELF "must never inflate the user's similarity result") is the failure
 * mode this asymmetry avoids.
 */
export function classifySubmitterRelationship(
  targetAccountId: string | null,
  otherAccountId: string | null,
): SubmitterRelationship {
  if (targetAccountId !== null && otherAccountId !== null && targetAccountId === otherAccountId) {
    return "SELF";
  }
  return "PRIOR_SUBMISSION";
}

export type FamilyRelationship = FamilyMember & { relationship: SubmitterRelationship };

/**
 * For `documentIdentityId`, classifies every *other* member of its family
 * (if it has one) as SELF or PRIOR_SUBMISSION relative to it. Returns []
 * when the identity has no family yet (nothing to classify against) — this
 * is not itself a NO_MATCH/error signal, just "no relationships exist yet."
 * Computed live from already-stored, immutable account_id values (an
 * identity's account never changes after creation) rather than persisted on
 * document_family_members, so there is no staleness to manage and no new
 * migration was needed for this capability.
 */
export async function classifyFamilyRelationships(client: Client, documentIdentityId: string): Promise<FamilyRelationship[]> {
  const own = await findFamilyForIdentity(client, documentIdentityId);
  if (!own) return [];

  const targetResult = await client.execute({
    sql: "SELECT account_id FROM document_identities WHERE id = ?",
    args: [documentIdentityId],
  });
  const targetRow = targetResult.rows[0] as unknown as { account_id: string | null } | undefined;
  const targetAccountId = targetRow?.account_id ?? null;

  const members = await findFamilyMembers(client, own.family.id);
  return members
    .filter((member) => member.documentIdentityId !== documentIdentityId)
    .map((member) => ({
      ...member,
      relationship: classifySubmitterRelationship(targetAccountId, member.accountId),
    }));
}
