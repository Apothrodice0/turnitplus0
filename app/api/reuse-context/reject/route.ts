import { getReportsDbClient } from '../../../../lib/reports-db';
import { getOrComputeHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { isCorpusSourceMatchingEnabled } from '../../../../lib/corpus-source-matching-flag';
import { getDeclarationsReferencingSubmission, revokeReuseContext } from '../../../../lib/reuse-context-declarations';
import { buildReuseContextEnvelope, resolveCallerOwnedReportBinding } from '../../../../lib/reuse-context-report-binding';
import { isWellFormedActionRef, matchReuseContextActionRef } from '../../../../lib/reuse-context-action-ref';
import { guardReuseContextRequest, resolveReuseContextSession, reuseContextJson } from '../../../../lib/reuse-context-mutation-guard';

/**
 * POST /api/reuse-context/reject  { reportId, actionRef }
 *
 * The ORIGINAL submitter declines a reuse-context declaration they never
 * confirmed. Same report-bound + actionRef selection as /confirm. At the
 * database level this is the same state change as a withdrawal
 * (verification_state -> REVOKED via revokeReuseContext, whose authority
 * check allows the validated original submitter), but this route refuses
 * (409 USE_REVOKE) when the matched declaration is already
 * MUTUALLY_CONFIRMED — reject must never silently undo a real mutual
 * confirmation. Retracting a confirmed attestation goes through
 * /api/reuse-context/revoke.
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

      const matched = candidates.find((c) => Number(c.id) === Number(matchedId));
      if (matched && matched.verificationState === 'MUTUALLY_CONFIRMED') {
        return reuseContextJson({ status: 'USE_REVOKE' }, 409);
      }

      const result = await revokeReuseContext(client, { declarationId: Number(matchedId), revokedByAccountId: session.sessionUser.id });
      if (result.status === 'NOT_AUTHORIZED_TO_REVOKE' || result.status === 'NOT_FOUND') {
        return reuseContextJson({ error: 'Not found.' }, 404);
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
      return reuseContextJson({ status: result.status, reuseContext }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return reuseContextJson({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
