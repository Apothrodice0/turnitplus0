import type { Client } from "@libsql/client";
import { canonicalSha256, findPriorSubmissionsForAccount } from "./document-identity";
import { isE8sReuseContextAllowlisted } from "./e8s-visibility";
import type { ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * Phase E8S Step 11: the read-time enrichment that lets
 * components/report/similarity-report-papers.tsx know whether — and with
 * which ids — to even ATTEMPT talking to the E8S reuse-context routes
 * (app/api/reuse-context/*). Deliberately mirrors lib/e8p-visibility.ts's
 * own role for E8P.3 exactly: isE8sReuseContextAllowlisted() is checked
 * first and returns instantly for every non-allowlisted account, so this
 * is a no-op for ordinary traffic, and never throws past this function
 * (same non-fatal guarantee as historicalSubmissionMatch/
 * experimentalHistoricalMatch's own read-time enrichment).
 *
 * Never modifies lib/report-historical-match.ts or
 * lib/user-submission-matching.ts — documentIdentityId is resolved the
 * same way lib/report-historical-match.ts's own
 * getOrComputeHistoricalMatchSnapshot already resolves it internally
 * (findPriorSubmissionsForAccount + the most recent own identity row for
 * this canonical hash), duplicated here rather than exposed from that
 * file, exactly like lib/e8p-shadow-evaluation.ts and lib/e8p-visibility.ts
 * already duplicate the same candidate-search glue rather than touching
 * the production matcher. representationId is taken directly from the
 * ALREADY-COMPUTED historicalSubmissionMatch passed in — never recomputed,
 * never re-run through the matcher.
 *
 * This function does NOT decide whether the "Add context" affordance
 * should render — that is GET /api/reuse-context/status's own job
 * (canDeclareReuseContext), fetched fresh client-side once mounted (E8S
 * Step 11 requirement 9: "use fresh server state... before displaying
 * action buttons"). This function only decides whether the client should
 * even attempt that fetch at all — for a non-allowlisted account, or one
 * whose own identity can't be resolved, the result is undefined and the
 * client makes zero E8S API requests, exactly like the CTA/panel
 * components already behave when handed no eligibility data.
 */

export type ReuseContextEligibility = {
  /** This report's own document identity — used for both the CTA/badge flow (paired with representationId) and the original-submitter pending-declarations panel, which applies regardless of this report's own historical-match relationship. */
  documentIdentityId: string;
  /** Present only when historicalSubmissionMatch is a real production PRIOR_SUBMISSION match — the representation the "Add context" affordance would apply to. Null otherwise (still lets the pending panel work). */
  representationId: string | null;
};

export async function getReuseContextEligibility(
  client: Client,
  params: { accountId: string | null; rawText: string; historicalSubmissionMatch: ReportHistoricalSubmissionMatch | undefined },
): Promise<ReuseContextEligibility | undefined> {
  if (!isE8sReuseContextAllowlisted(params.accountId)) return undefined;
  try {
    const accountId = params.accountId as string; // isE8sReuseContextAllowlisted already proved this is non-null
    const ownIdentities = await findPriorSubmissionsForAccount(client, accountId, canonicalSha256(params.rawText));
    const documentIdentityId = ownIdentities.length > 0 ? ownIdentities[ownIdentities.length - 1].id : null;
    if (!documentIdentityId) return undefined;

    const primaryMatch = params.historicalSubmissionMatch?.status === "MATCHED" ? params.historicalSubmissionMatch.matches?.[0] : undefined;
    const representationId = primaryMatch?.relationshipType === "PRIOR_SUBMISSION" ? primaryMatch.matchedRepresentationId : null;

    return { documentIdentityId, representationId };
  } catch (error) {
    console.error("getReuseContextEligibility failed (non-fatal):", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
