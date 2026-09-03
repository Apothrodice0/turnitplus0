import { getReportsDbClient } from '../../../../lib/reports-db';
import { getOrComputeHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { isCorpusSourceMatchingEnabled } from '../../../../lib/corpus-source-matching-flag';
import { confirmReuseContext, getDeclarationsReferencingSubmission } from '../../../../lib/reuse-context-declarations';
import { buildReuseContextEnvelope, resolveCallerOwnedReportBinding } from '../../../../lib/reuse-context-report-binding';
import { isWellFormedActionRef, matchReuseContextActionRef } from '../../../../lib/reuse-context-action-ref';
import { guardReuseContextRequest, resolveReuseContextSession, reuseContextJson } from '../../../../lib/reuse-context-mutation-guard';

/**
 * POST /api/reuse-context/confirm  { reportId, actionRef }
 *
 * The ORIGINAL submitter confirms a reuse-context declaration made against
 * one of their own submissions. `reportId` is the original submitter's own
 * caller-owned report; the server resolves its exact document_identity_id
 * and enumerates the declarations referencing it. The submitted actionRef
 * selects one candidate (constant-time; loop never early-returns).
 *
 * The candidate list deliberately includes already-MUTUALLY_CONFIRMED active
 * rows so a racing / double confirm reaches confirmReuseContext's own
 * idempotent ALREADY_CONFIRMED path. The ordinary UI panel
 * (reuseContext.confirm.pending[]) only ever lists SELF_ASSERTED_UNVERIFIED
 * rows; confirmed ones move to reuseContext.confirm.confirmed[].
 *
 * confirmReuseContext re-resolves `confirmer == original submitting account`
 * fresh on every call — the actionRef is only a selector, never authority.
 *
 * Checkpoint order: rate -> same-origin (hidden 404) -> body validation ->
 * session + allowlist -> session key -> resolution. Always no-store.
 */

export const dynamic = 'force-dynamic';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const requestGuard = await guardReuseContextRequest(request);
    if (!requestGuard.ok) return reuseContextJson(requestGuard.body, requestGuard.status, requestGuard.headers);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return reuseContextJson({ error: 'Invalid JSON' }, 400);
    const { reportId, actionRef } = body as Record<string, unknown>;
    if (!isNonEmptyString(reportId)) return reuseContextJson({ error: 'reportId is required' }, 400);
    if (!isWellFormedActionRef(actionRef)) return reuseContextJson({ error: 'Not found.' }, 404);

    const client = await getReportsDbClient();
    try {
      const session = await resolveReuseContextSession(request, client);
      if (!session.ok) return reuseContextJson(session.body, session.status);

      const binding = await resolveCallerOwnedReportBinding(client, { reportId, accountId: session.sessionUser.id });
      if (binding.status === 'NOT_FOUND' || binding.status === 'AMBIGUOUS') return reuseContextJson({ error: 'Not found.' }, 404);
      if (binding.status === 'REUSE_CONTEXT_UNAVAILABLE') return reuseContextJson({ status: 'REUSE_CONTEXT_UNAVAILABLE' }, 409);

      const candidates = await getDeclarationsReferencingSubmission(client, { documentIdentityId: binding.documentIdentityId });
      const matchedId = matchReuseContextActionRef(session.sessionKey, actionRef, candidates.map((c) => c.id));
      if (matchedId === null) return reuseContextJson({ error: 'Not found.' }, 404);

      const result = await confirmReuseContext(client, { declarationId: Number(matchedId), confirmingAccountId: session.sessionUser.id });
      if (result.status === 'NOT_ORIGINAL_SUBMITTER' || result.status === 'ORIGINAL_SUBMISSION_UNRESOLVABLE' || result.status === 'NOT_FOUND') {
        return reuseContextJson({ error: 'Not found.' }, 404);
      }
      if (result.status === 'SELF_CONFIRMATION_REJECTED') {
        return reuseContextJson({ status: result.status }, 409);
      }

      const historicalSubmissionMatch = await getOrComputeHistoricalMatchSnapshot(client, {
        reportDeviceKey: binding.deviceKey,
        reportId,
        accountId: session.sessionUser.id,
        rawText: binding.rawText,
        excludeAccountId: session.sessionUser.id,
        corpusSourceMatchingEnabled: isCorpusSourceMatchingEnabled(),
      });
      const reuseContext = await buildReuseContextEnvelope(client, {
        reportId,
        documentIdentityId: binding.documentIdentityId,
        accountId: session.sessionUser.id,
        sessionKey: session.sessionKey,
        historicalSubmissionMatch,
      });
      // CONFIRMED / ALREADY_CONFIRMED / ALREADY_REVOKED all converge on "no
      // longer an open decision"; the fresh envelope reflects the real state.
      return reuseContextJson({ status: result.status, reuseContext }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return reuseContextJson({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
