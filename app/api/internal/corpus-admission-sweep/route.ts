import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { isCorpusAdmissionEnabled, runReportAdmissionRetrySweep } from '../../../../lib/corpus-admission-report-integration';
import { isCorpusRetentionEnabled, runCorpusAdmissionRetentionSweep } from '../../../../lib/corpus-admission-retention-sweep';

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
 *
 * Task B1B also runs lib/corpus-admission-retention-sweep.ts's daily
 * retention cleanup from this SAME invocation, behind its own independent
 * CORPUS_RETENTION_ENABLED flag — deliberately not a third cron entry (the
 * Vercel Hobby plan's 2 cron slots are already spent by this route and
 * app/api/internal/corpus-admission-promotion-sweep/route.ts; see
 * vercel.json). The two operations are otherwise unrelated and run
 * independently of each other's flag: retention cleanup proceeds even when
 * CORPUS_ADMISSION_ENABLED is off (old rows can still need aging out after
 * live intake is paused), and vice versa. Only when BOTH flags are off does
 * this route skip opening a database connection at all, exactly like it
 * already did for CORPUS_ADMISSION_ENABLED alone before this change.
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

    const admissionEnabled = isCorpusAdmissionEnabled();
    const retentionEnabled = isCorpusRetentionEnabled();
    const disabledRetention = { enabled: false, decisionsDeleted: 0, jobsDeleted: 0, skippedProtected: 0, failedPromotionsRetryable: 0 };

    if (!admissionEnabled && !retentionEnabled) {
      return new NextResponse(
        JSON.stringify({ ok: true, enabled: false, claimedCount: 0, retention: disabledRetention }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const client = await getReportsDbClient();
    try {
      const body: { ok: true; enabled: boolean; claimedCount: number; outcomeSummary?: Record<string, number>; retention: typeof disabledRetention & { enabled: boolean } } = {
        ok: true,
        enabled: admissionEnabled,
        claimedCount: 0,
        retention: disabledRetention,
      };

      if (admissionEnabled) {
        const sweep = await runReportAdmissionRetrySweep(client, { openConnection: () => getReportsDbClient() });
        body.claimedCount = sweep.claimedJobIds.length;
        body.outcomeSummary = sweep.results.reduce(
          (acc, r) => {
            acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );
      }

      if (retentionEnabled) {
        const retention = await runCorpusAdmissionRetentionSweep(client, { openConnection: () => getReportsDbClient() });
        body.retention = { enabled: true, ...retention };
      }

      return new NextResponse(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
