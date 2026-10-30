import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { runHighlightPredictionSweep } from '../../../../lib/highlight-predictions';

/**
 * Protected scheduled trigger for lib/highlight-predictions.ts's runHighlightPredictionSweep: finishes predictions a
 * save could not (the service was down, the job was cut off) for customers who never reopen their report. Vercel Cron
 * (vercel.json) calls it hourly with `Authorization: Bearer <CRON_SECRET>`; GET and POST share one handler, exactly like
 * app/api/internal/subscription-expiry-sweep/route.ts, and it fails closed the same way: no CRON_SECRET, or a wrong one,
 * is a 404. Does nothing while the highlight model is off.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorizedSweepRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization');
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const providedBuf = Buffer.from(header.slice(prefix.length));
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
    if (!isAuthorizedSweepRequest(request)) return new NextResponse(null, { status: 404 });
    const client = await getReportsDbClient();
    try {
      const result = await runHighlightPredictionSweep(client);
      return new NextResponse(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('highlight-prediction-sweep failed:', err instanceof Error ? err.name : 'unknown');
    return new NextResponse(JSON.stringify({ error: 'Sweep failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export async function GET(request: Request) {
  return handleSweepRequest(request);
}

export async function POST(request: Request) {
  return handleSweepRequest(request);
}
