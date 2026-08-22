import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { isCorpusAdmissionEnabled, runReportAdmissionRetrySweep } from '../../../../lib/corpus-admission-report-integration';

/**
 * Protected scheduled/internal trigger for
 * lib/corpus-admission-report-integration.ts's runReportAdmissionRetrySweep
 * (blocker 2's recovery mechanism) — this is the caller that was
 * deliberately left unbuilt (a callable library function with nothing
 * wired to it) when the sweep itself was implemented. Meant to be invoked
 * by Vercel Cron (see vercel.json's "crons" entry for this path) — NOT by
 * a browser session, so authorization here is a shared bearer secret, not
 * a signed-in admin check.
 *
 * GET, using CRON_SECRET: Vercel Cron Jobs always issue a GET request, and
 * Vercel automatically attaches `Authorization: Bearer <CRON_SECRET>` when
 * a CRON_SECRET environment variable is configured on the project — see
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs. GET here is
 * therefore not a REST-purity violation so much as the one invocation
 * shape Vercel Cron can actually produce; there is no way to configure it
 * to send POST instead.
 * POST is also supported, using the SAME secret and the SAME
 * authorization check, for any other trusted internal caller (a manual
 * trigger, a different scheduler) that can send a real POST — both methods
 * share one handler below.
 *
 * Fails closed, always: if CRON_SECRET is unset, every request 404s — an
 * unconfigured secret must never mean "open to anyone," the opposite of
 * every other env-var-gated default in this codebase. A present-but-wrong
 * Authorization header also 404s (never 401/403), same "don't reveal this
 * endpoint exists" discipline as app/api/developer/reports/route.ts's own
 * getAdminSessionUser check. Comparison is timing-safe
 * (crypto.timingSafeEqual on same-length buffers; a length mismatch alone
 * is rejected without ever touching timingSafeEqual, which throws on
 * unequal lengths rather than returning false) — this is a bearer
 * credential, not a password a legitimate user mistypes, so guarding
 * against timing side-channels is warranted the way it would not be for,
 * say, an email-uniqueness check elsewhere in this codebase.
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

    if (!isCorpusAdmissionEnabled()) {
      return new NextResponse(
        JSON.stringify({ ok: true, enabled: false, claimedCount: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const client = await getReportsDbClient();
    try {
      const sweep = await runReportAdmissionRetrySweep(client, { openConnection: () => getReportsDbClient() });
      const summary = sweep.results.reduce(
        (acc, r) => {
          acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      return new NextResponse(
        JSON.stringify({ ok: true, enabled: true, claimedCount: sweep.claimedJobIds.length, outcomeSummary: summary }),
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
