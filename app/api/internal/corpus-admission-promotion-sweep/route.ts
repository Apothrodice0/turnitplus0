import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { isCorpusPromotionEnabled, runCorpusAdmissionPromotionSweep } from '../../../../lib/corpus-admission-promotion';
import { recordSweepRun } from '../../../../lib/corpus-admission-sweep-state';

/**
 * Protected scheduled/internal trigger for
 * lib/corpus-admission-promotion.ts's runCorpusAdmissionPromotionSweep —
 * same shape as app/api/internal/corpus-admission-sweep/route.ts (that
 * file's own header comment covers the reasoning for GET+POST, the
 * CRON_SECRET bearer check, and fail-closed-on-unset-secret; not repeated
 * here). Kept as its OWN route, deliberately separate from that one, so
 * promotion can be toggled/rolled back independently of the already-relied-
 * upon report-admission retry sweep without touching its cron entry.
 *
 * Gated by its own isCorpusPromotionEnabled() flag — independent of
 * CORPUS_ADMISSION_ENABLED. Short-circuits to a no-op 200 while unset,
 * exactly like the existing sweep route does for its own flag, so this
 * route is safe to deploy and put on a cron schedule while fully dark.
 *
 * Admin status-strip support: records this attempt's own outcome into
 * corpus_admission_sweep_runs (lib/corpus-admission-sweep-state.ts, sweep_kind
 * 'promotion') — only when the flag above is actually on and a real
 * attempt ran (the short-circuit above returns before this is ever
 * reached, so a disabled flag never writes a fake successful run nor
 * overwrites real prior history). A telemetry-write failure is logged and
 * swallowed, never allowed to change this route's own response.
 */

function isAuthorizedSweepRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get('authorization');
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);

  const providedBuf = Buffer.from(provided);
  const secretBuf = Buffer.from(secret);
  if (providedBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(providedBuf, secretBuf);
}

async function handleSweepRequest(request: Request): Promise<Response> {
  try {
    const rate = await checkAuthRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    if (!isAuthorizedSweepRequest(request)) {
      return new NextResponse(null, { status: 404 });
    }

    if (!isCorpusPromotionEnabled()) {
      return new NextResponse(
        JSON.stringify({ ok: true, enabled: false, claimedCount: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const client = await getReportsDbClient();
    try {
      let sweep;
      try {
        sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection: () => getReportsDbClient() });
      } catch (err) {
        // Operational telemetry only — see lib/corpus-admission-sweep-state.ts's own
        // header comment on why this write is swallowed (never re-thrown,
        // never allowed to mask or replace the real error below) and why
        // it happens only here, after a real attempt actually ran.
        await recordSweepRun(client, 'promotion', { status: 'failed' }).catch((telemetryErr) => {
          console.error('corpus-admission-promotion-sweep: recordSweepRun(failed) itself threw (non-fatal):', telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr));
        });
        throw err;
      }
      const summary = sweep.results.reduce(
        (acc, r) => {
          acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      await recordSweepRun(client, 'promotion', { status: 'success', summary: { claimedCount: sweep.claimedPromotionIds.length, ...summary } }).catch((telemetryErr) => {
        console.error('corpus-admission-promotion-sweep: recordSweepRun(success) itself threw (non-fatal):', telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr));
      });
      return new NextResponse(
        JSON.stringify({ ok: true, enabled: true, claimedCount: sweep.claimedPromotionIds.length, outcomeSummary: summary }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleSweepRequest(request);
}

export async function POST(request: Request) {
  return handleSweepRequest(request);
}
