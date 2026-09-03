import { getReportsDbClient } from '../../../../lib/reports-db';
import { getOrComputeHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { isCorpusSourceMatchingEnabled } from '../../../../lib/corpus-source-matching-flag';
import { declareReuseContext, type DeclaredContext } from '../../../../lib/reuse-context-declarations';
import {
  buildReuseContextEnvelope,
  firstEligiblePriorSubmissionRepresentationId,
  resolveCallerOwnedReportBinding,
} from '../../../../lib/reuse-context-report-binding';
import { guardReuseContextRequest, resolveReuseContextSession, reuseContextJson } from '../../../../lib/reuse-context-mutation-guard';

/**
 * POST /api/reuse-context/declare  { reportId, declaredContext }
 *
 * Report-bound. The client supplies only the public report handle and the
 * declared context enum — never a document_identity_id or a
 * matched_representation_id. The server resolves the caller-owned report,
 * its exact saved_reports.document_identity_id (NULL => fail closed), and
 * the CURRENT first-eligible PRIOR_SUBMISSION representation from the
 * deterministic match order. declareReuseContext remains the final
 * authority (owner check, SELF-not-declarable, ambiguity).
 *
 * Checkpoint order: rate -> same-origin (hidden 404) -> body validation ->
 * session + allowlist -> session key -> resolution. Always no-store.
 */

export const dynamic = 'force-dynamic';

const DECLARED_CONTEXTS: readonly DeclaredContext[] = [
  'SUPERVISOR_COPY',
  'COAUTHOR_COPY',
  'INSTITUTIONAL_SUBMISSION',
  'AUTHORIZED_ARCHIVAL_COPY',
  'OTHER_AUTHORIZED_REUSE',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const requestGuard = await guardReuseContextRequest(request);
    if (!requestGuard.ok) return reuseContextJson(requestGuard.body, requestGuard.status, requestGuard.headers);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return reuseContextJson({ error: 'Invalid JSON' }, 400);
    const { reportId, declaredContext } = body as Record<string, unknown>;
    if (!isNonEmptyString(reportId)) return reuseContextJson({ error: 'reportId is required' }, 400);
    if (typeof declaredContext !== 'string' || !DECLARED_CONTEXTS.includes(declaredContext as DeclaredContext)) {
      return reuseContextJson({ error: `declaredContext must be one of ${DECLARED_CONTEXTS.join(', ')}` }, 400);
    }

    const client = await getReportsDbClient();
    try {
      const session = await resolveReuseContextSession(request, client);
      if (!session.ok) return reuseContextJson(session.body, session.status);

      const binding = await resolveCallerOwnedReportBinding(client, { reportId, accountId: session.sessionUser.id });
      if (binding.status === 'NOT_FOUND' || binding.status === 'AMBIGUOUS') return reuseContextJson({ error: 'Not found.' }, 404);
      if (binding.status === 'REUSE_CONTEXT_UNAVAILABLE') return reuseContextJson({ status: 'REUSE_CONTEXT_UNAVAILABLE' }, 409);

      const historicalSubmissionMatch = await getOrComputeHistoricalMatchSnapshot(client, {
        reportDeviceKey: binding.deviceKey,
        reportId,
        accountId: session.sessionUser.id,
        rawText: binding.rawText,
        excludeAccountId: session.sessionUser.id,
        corpusSourceMatchingEnabled: isCorpusSourceMatchingEnabled(),
      });

      const representationId = firstEligiblePriorSubmissionRepresentationId(historicalSubmissionMatch);
      if (representationId === null) return reuseContextJson({ status: 'NO_PRIOR_SUBMISSION_MATCH' }, 409);

      const result = await declareReuseContext(client, {
        documentIdentityId: binding.documentIdentityId,
        representationId,
        declaredByAccountId: session.sessionUser.id,
        declaredContext: declaredContext as DeclaredContext,
      });

      const reuseContext = await buildReuseContextEnvelope(client, {
        reportId,
        documentIdentityId: binding.documentIdentityId,
        accountId: session.sessionUser.id,
        sessionKey: session.sessionKey,
        historicalSubmissionMatch,
      });

      if (result.status === 'DECLARED' || result.status === 'ALREADY_ACTIVE') {
        return reuseContextJson({ status: result.status, reuseContext }, 200);
      }
      if (result.status === 'IDENTITY_NOT_FOUND' || result.status === 'REPRESENTATION_NOT_FOUND') {
        return reuseContextJson({ status: result.status }, 404);
      }
      if (result.status === 'DECLARER_NOT_SUBMISSION_OWNER') {
        return reuseContextJson({ status: result.status }, 403);
      }
      // NO_MATCH_PAIR / AMBIGUOUS_MATCH_PAIR / SELF_RELATIONSHIP_NOT_DECLARABLE
      return reuseContextJson({ status: result.status, reuseContext }, 409);
    } finally {
      client.close();
    }
  } catch (err) {
    return reuseContextJson({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
