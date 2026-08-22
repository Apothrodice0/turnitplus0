import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { isCorpusPromotionEnabled, runCorpusAdmissionPromotionSweep } from '../../../../lib/corpus-admission-promotion';

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
      const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection: () => getReportsDbClient() });
      const summary = sweep.results.reduce(
        (acc, r) => {
          acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
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
