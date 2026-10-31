import { NextResponse } from 'next/server';
import { checkCustomerRate } from '../../../../../lib/customer-rate-limit';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { getSessionUser } from '../../../../../lib/auth-session';
import { reportAccessRefusalFor } from '../../../../../lib/account-entitlements';
import { findReportRowForUser } from '../../../../../lib/reports-repo';
import { startHighlightPrediction } from '../../../../../lib/highlight-predictions';

/**
 * POST /api/reports/[id]/highlight-prediction: the opened report page starts a prediction the report never got, or the
 * owner starts a failed one again (lib/highlight-predictions.ts startHighlightPrediction). The report is only read; the
 * prediction runs after the response and the page picks it up as it does any pending one.
 *
 * Signed-in owner only: the report is found by (id, session user), so another account's report, an anonymous one and a
 * missing id are the same 404. 409 when there is nothing to start (not wanted for this report, pending, running, complete).
 */
export const dynamic = 'force-dynamic';
// The prediction runs after this response.
export const maxDuration = 300;

const NO_STORE_JSON = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new NextResponse(JSON.stringify(body), { status, headers: { ...NO_STORE_JSON, ...headers } });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkCustomerRate(request, 'processing');
    if (!rate.allowed) return json(429, { error: 'Too many requests' }, { 'Retry-After': String(rate.retryAfter) });
    const { id } = await params;
    if (typeof id !== 'string' || id.length === 0) return json(400, { error: 'id is required' });
    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) return json(401, { error: 'Log in to continue.' });
      const accessRefusal = await reportAccessRefusalFor(client, sessionUser);
      if (accessRefusal) return json(403, { error: accessRefusal.message, code: accessRefusal.code });
      const row = await findReportRowForUser(client, id, sessionUser.id);
      if (!row) return json(404, { error: 'Report not found' });
      const report = JSON.parse(row.payload_json) as { text?: unknown; features?: { detectedLanguage?: unknown } };
      const started = await startHighlightPrediction(client, sessionUser, { text: report.text, detectedLanguage: report.features?.detectedLanguage }, { deviceKey: row.device_key, reportId: id });
      return started ? json(202, { pending: true }) : json(409, { error: 'Nothing to retry' });
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('highlight prediction retry failed:', err instanceof Error ? err.name : 'unknown');
    return json(500, { error: 'Internal error' });
  }
}
