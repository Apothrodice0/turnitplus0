import { getReportsDbClient } from '../../../../lib/reports-db';
import { getOrComputeHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { isCorpusSourceMatchingEnabled } from '../../../../lib/corpus-source-matching-flag';
import { getActiveDeclarationsByDocumentIdentity, revokeReuseContext } from '../../../../lib/reuse-context-declarations';
import { buildReuseContextEnvelope, resolveCallerOwnedReportBinding } from '../../../../lib/reuse-context-report-binding';
import { isWellFormedActionRef, matchReuseContextActionRef } from '../../../../lib/reuse-context-action-ref';
import { guardReuseContextRequest, resolveReuseContextSession, reuseContextJson } from '../../../../lib/reuse-context-mutation-guard';

/**
 * POST /api/reuse-context/withdraw  { reportId, actionRef }  -- DECLARER side.
 *
 * The declarer withdraws one of THEIR OWN reuse-context declarations for
 * this report (either state). Withdrawal is NOT resolved from the current
 * first-eligible PRIOR_SUBMISSION — historical-match ordering can change
 * after a declaration was made — instead the server:
 *   1. resolves the caller-owned report -> exact document_identity_id
 *   2. enumerates EVERY non-revoked declaration for that identity
 *   3. recomputes the session-bound actionRef for each candidate
 *   4. constant-time matches the submitted ref (loop never early-returns)
 *   5. calls revokeReuseContext with the matched server-side id
 *
 * revokeReuseContext's own authority check (declarer / confirmer /
 * validated original submitter) is the final authority. A ref from a
 * different report, account, or session matches nothing -> generic 404.
 *
 * The ORIGINAL submitter retracts a MUTUALLY_CONFIRMED attestation through
 * /api/reuse-context/revoke instead (see that route).
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

      const candidates = await getActiveDeclarationsByDocumentIdentity(client, { documentIdentityId: binding.documentIdentityId });
      const matchedId = matchReuseContextActionRef(session.sessionKey, actionRef, candidates.map((c) => c.id));
      if (matchedId === null) return reuseContextJson({ error: 'Not found.' }, 404);

      const result = await revokeReuseContext(client, { declarationId: Number(matchedId), revokedByAccountId: session.sessionUser.id });
      if (result.status === 'NOT_AUTHORIZED_TO_REVOKE') return reuseContextJson({ error: 'Not found.' }, 404);

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
