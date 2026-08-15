import type { Client } from "@libsql/client";

/**
 * Phase E8S Step 3: resolves whether a historical match between a current
 * submission (documentIdentityId) and a matched corpus representation
 * (representationId — the same id already exposed today as
 * HistoricalSubmissionMatchEntry.matchedRepresentationId) can be traced to
 * exactly one specific prior corpus_submission_references row. This is the
 * precision anchor Step 2's reuse_context_declarations design calls
 * matched_submission_reference_id, and which lib/user-submission-corpus.ts's
 * summarizeSubmissionOwnership deliberately cannot provide — that function
 * returns only a same-account boolean and an other-account count, by
 * design, never a resolvable reference id (see its own comment).
 *
 * Structurally MORE private than summarizeSubmissionOwnership, not less:
 * this function never joins to document_identities or users at all. It
 * only ever counts and returns corpus_submission_references.id values,
 * which are opaque integers carrying no account/email/text information on
 * their own. It is therefore relationship-blind by construction — it does
 * not know, and does not need to know, whether a candidate reference
 * belongs to the same account as documentIdentityId or a different one.
 * See this file's own tests C/D (same-account vs cross-account fixtures
 * resolving through the identical code path) for why that blindness is
 * intentional and verified, not an oversight — and see Step 3's own task
 * requirement 6: this module never touches, imports, or duplicates
 * lib/user-submission-matching.ts's relationshipType classification
 * (SELF/PRIOR_SUBMISSION/UNKNOWN_RELATIONSHIP are computed there, exactly
 * as before, and this file has no opinion about them).
 *
 * Never guesses. The only signal used is exact corpus_submission_references
 * row identity after excluding the caller's own current documentIdentityId
 * — never title, timestamp, device key, filename, or any text-similarity
 * score (Step 3's own requirement 5). If more than one candidate reference
 * remains after that exclusion, the result is ambiguous=true with no
 * reference id — never a best guess among them.
 *
 * Read-only. No schema change. Not called from any live route yet — a
 * pure, additive, testable primitive for the eventual reuse-context
 * declaration write path (see this phase's own final report for the
 * proposed shape of that layer). Never reads or writes
 * score/archiveScore/aiScore/verifiedSimilarity.
 */

export type MatchPairResolution = {
  representationId: string;
  /** Set only when exactly one candidate reference exists; null otherwise (whether zero or many). */
  referenceId: number | null;
  /** true iff two or more distinct corpus_submission_references rows remain after excluding the caller's own documentIdentityId. */
  ambiguous: boolean;
};

export async function resolveExactMatchPairReference(
  client: Client,
  params: { documentIdentityId: string; representationId: string },
): Promise<MatchPairResolution> {
  const result = await client.execute({
    sql: `SELECT id FROM corpus_submission_references
          WHERE representation_id = ? AND document_identity_id != ?`,
    args: [params.representationId, params.documentIdentityId],
  });
  const referenceIds = (result.rows as unknown as { id: number | bigint }[]).map((row) => Number(row.id));

  if (referenceIds.length === 0) {
    return { representationId: params.representationId, referenceId: null, ambiguous: false };
  }
  if (referenceIds.length > 1) {
    return { representationId: params.representationId, referenceId: null, ambiguous: true };
  }
  return { representationId: params.representationId, referenceId: referenceIds[0], ambiguous: false };
}
