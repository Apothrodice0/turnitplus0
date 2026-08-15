import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { findReportRowForDeviceKey, findReportRowForUser } from '../../../../lib/reports-repo';
import { classifyReportMatches } from '../../../../lib/report-classification';
import { getOrComputeHistoricalMatchSnapshot, deleteHistoricalMatchSnapshot } from '../../../../lib/report-historical-match';
import { runHistoricalMatchShadowEvaluation } from '../../../../lib/e8p-shadow-evaluation';
import { getExperimentalHistoricalMatchForDisplay } from '../../../../lib/e8p-visibility';
import { runAfterResponse } from '../../../../lib/run-after-response';
import type { SimilarityReport } from '../../../../lib/report-types';

const MAX_DEVICE_KEY_LENGTH = 200;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const { id } = await params;
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });

    const client = await getReportsDbClient();
    let row;
    let payload: SimilarityReport | undefined;
    try {
      const sessionUser = await getSessionUser(request, client);
      const accountId = sessionUser ? sessionUser.id : null;
      if (sessionUser) {
        row = await findReportRowForUser(client, id, sessionUser.id);
      } else {
        const url = new URL(request.url);
        const deviceKey = url.searchParams.get('deviceKey');
        if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
        }
        row = await findReportRowForDeviceKey(client, id, deviceKey);
      }

      if (!row) {
        return new NextResponse(JSON.stringify({ error: 'Report not found' }), { status: 404 });
      }

      payload = JSON.parse(String(row.payload_json)) as SimilarityReport;
      // Phase D: read-time enrichment only — see app/reports/[id]/page.tsx's
      // identical comment. Best-effort: never turns a successful fetch into
      // an error response.
      try {
        payload.matchClassification = await classifyReportMatches(client, { rawText: payload.text, accountId });
      } catch (err) {
        console.error('classifyReportMatches failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
      // Phase E8C: same read-time-enrichment discipline as Phase D just
      // above, and the same non-fatal guarantee — see
      // lib/report-historical-match.ts's own header comment. This one is
      // already internally best-effort (it persists a "FAILED" snapshot
      // rather than throwing), so this try/catch is a second, outer safety
      // net for anything unexpected (e.g. a database error on the snapshot
      // read/write itself), not the primary error handling.
      try {
        const historicalSubmissionMatch = await getOrComputeHistoricalMatchSnapshot(client, {
          reportDeviceKey: row.device_key,
          reportId: id,
          accountId,
          rawText: payload.text,
        });
        payload.historicalSubmissionMatch = historicalSubmissionMatch;
        // Phase E8P.3: the experimental, allowlist-gated display value — see
        // lib/e8p-visibility.ts's own header comment. Synchronous (unlike the
        // shadow telemetry write below) because it must be part of THIS
        // response to render at all; isE8pVisibilityAllowlisted() is checked
        // first inside that function and returns instantly for every
        // non-allowlisted account, so this is a no-op for ordinary traffic.
        // Never throws past this function; best-effort exactly like
        // historicalSubmissionMatch's own read-time enrichment above.
        payload.experimentalHistoricalMatch = await getExperimentalHistoricalMatchForDisplay(client, {
          accountId,
          rawText: payload.text,
          productionResult: historicalSubmissionMatch,
        }) ?? undefined;
        // Phase E8P: production shadow evaluation — measurement only, never
        // changes historicalSubmissionMatch above (already resolved and
        // reused as-is, never recomputed). Deferred via runAfterResponse,
        // same pattern as app/api/reports/route.ts's own corpus-indexing
        // callback, with its own DB connection since `client` here is closed
        // in `finally` before after() fires. Best-effort by construction
        // (lib/e8p-shadow-evaluation.ts never throws), so no try/catch needed
        // around this call itself. Plain local values (not `payload`) are
        // captured into the closure to keep it independent of the outer
        // request's own object.
        const deviceKeyForShadow = row.device_key;
        const rawTextForShadow = payload.text;
        await runAfterResponse(async () => {
          const deferredClient = await getReportsDbClient();
          try {
            await runHistoricalMatchShadowEvaluation(deferredClient, {
              reportDeviceKey: deviceKeyForShadow,
              reportId: id,
              accountId,
              rawText: rawTextForShadow,
              productionResult: historicalSubmissionMatch,
            });
          } finally {
            deferredClient.close();
          }
        });
      } catch (err) {
        console.error('getOrComputeHistoricalMatchSnapshot failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ payload }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const { id } = await params;
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (sessionUser) {
        // Phase E8C: report_historical_match_snapshots has no DB-level
        // FOREIGN KEY (see db/schema.ts's own comment on that table), so its
        // cleanup is this explicit lookup-then-delete instead of an
        // automatic CASCADE. deviceKey is looked up here rather than
        // trusted from the client, matching this route's existing
        // authorization discipline (id + user_id both required either way).
        const owned = await client.execute({
          sql: 'SELECT device_key FROM saved_reports WHERE id = ? AND user_id = ?',
          args: [id, sessionUser.id],
        });
        const deviceKey = owned.rows[0]?.device_key;
        if (deviceKey) await deleteHistoricalMatchSnapshot(client, { reportDeviceKey: String(deviceKey), reportId: id });
        await client.execute({
          sql: 'DELETE FROM saved_reports WHERE id = ? AND user_id = ?',
          args: [id, sessionUser.id],
        });
      } else {
        const url = new URL(request.url);
        const deviceKey = url.searchParams.get('deviceKey');
        if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
        }
        await deleteHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId: id });
        await client.execute({
          sql: 'DELETE FROM saved_reports WHERE device_key = ? AND id = ? AND user_id IS NULL',
          args: [deviceKey, id],
        });
      }
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
