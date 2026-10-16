import { getReportsDbClient } from '../../../../../../lib/reports-db';
import { checkAdminRate } from '../../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../../lib/auth-session';
import { isSameOriginRequest } from '../../../../../../lib/same-origin';
import { adminJsonResponse } from '../../../../../../lib/admin-http';
import { asjpSixwordOverlapDisplayEnabled } from '../../../../../../lib/report-asjp-sixword-evidence';
import { retractSixwordForReport, runSixwordForReport, sixwordViewForReport } from '../../../../../../lib/asjp-sixword-report';

/**
 * Developer-only INFORMATIONAL six-word overlap of a saved report (experiment; ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED,
 * default off — then this route answers 404 like any non-existent route).
 *   GET  ?deviceKey=…                         the stored record's developer view (verified for this report and owner)
 *   POST {deviceKey, action: "run"}           runs the search NOW (explicit request only) and stores a signed record
 *   POST {deviceKey, action: "retract"}       retracts the stored record (nothing shown afterwards)
 * Admin session + same-origin + admin rate limit, as every app/api/admin route. It never writes the saved report, its
 * score or its highlights, and never returns an exception message (it could quote manuscript text).
 */
const KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

// GET is read-only (like the other app/api/admin GET routes: rate limit + admin session; browsers send no Origin on a
// same-origin GET). POST changes state and additionally requires a same-origin Origin (CSRF), as every admin POST does.
async function guard(request: Request, method: 'GET' | 'POST') {
  const rate = await checkAdminRate(clientIpFrom(request));
  if (!rate.allowed) return { response: adminJsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) }) };
  if (!asjpSixwordOverlapDisplayEnabled() || (method === 'POST' && !isSameOriginRequest(request))) return { response: adminJsonResponse(null, 404) };
  return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const blocked = await guard(request, 'GET');
    if (blocked) return blocked.response;
    const { id } = await params;
    const deviceKey = new URL(request.url).searchParams.get('deviceKey') ?? '';
    if (!KEY.test(id) || !KEY.test(deviceKey)) return adminJsonResponse(null, 404);
    const client = await getReportsDbClient();
    try {
      if (!(await getAdminSessionUser(request, client))) return adminJsonResponse(null, 404);
      const view = await sixwordViewForReport(client, { deviceKey, reportId: id });
      return view ? adminJsonResponse({ view }, 200) : adminJsonResponse(null, 404);
    } finally { client.close(); }
  } catch {
    return adminJsonResponse({ error: 'Internal error' }, 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const blocked = await guard(request, 'POST');
    if (blocked) return blocked.response;
    const { id } = await params;
    let body: { deviceKey?: unknown; action?: unknown; reason?: unknown };
    try { body = await request.json(); } catch { return adminJsonResponse({ error: 'Bad request' }, 400); }
    const deviceKey = typeof body.deviceKey === 'string' ? body.deviceKey : '';
    if (!KEY.test(id) || !KEY.test(deviceKey) || (body.action !== 'run' && body.action !== 'retract')) return adminJsonResponse({ error: 'Bad request' }, 400);
    const client = await getReportsDbClient();
    try {
      if (!(await getAdminSessionUser(request, client))) return adminJsonResponse(null, 404);
      const key = { deviceKey, reportId: id };
      const result = body.action === 'run' ? await runSixwordForReport(client, key) : await retractSixwordForReport(client, key, typeof body.reason === 'string' ? body.reason.replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 64) || 'RETRACTED_BY_DEVELOPER' : 'RETRACTED_BY_DEVELOPER');
      if (result.outcome === 'NOT_ELIGIBLE' && result.reason === 'NO_REPORT') return adminJsonResponse(null, 404);
      return adminJsonResponse(result, 200);
    } finally { client.close(); }
  } catch {
    return adminJsonResponse({ error: 'Internal error' }, 500);
  }
}
