import { NextResponse } from 'next/server';
import { checkRate } from '../../../lib/rate-limit';
import { getExternalAcademicEvidence } from '../../../lib/academic-evidence-integration';

/**
 * Phase 3: the one server endpoint the academic-search subsystem is reached
 * through. Exists only because lib/academic-search/'s HTTP-fallback text
 * retrieval (lib/retrieval-safety.ts) is Node-only (node:dns/node:net for
 * SSRF validation) — it cannot run in a browser or Worker the way
 * app/page.tsx's Wikipedia web-check does (see this phase's own report for
 * why that precedent could not simply be copied).
 *
 * Deliberately minimal: no auth requirement (this never touches a user's
 * saved-report data, only the raw text the client already has), no
 * persistence (the caller — app/page.tsx's generateReport() — is
 * responsible for merging the response into a report and re-saving it, the
 * same place Wikipedia enrichment is already merged and saved). A request
 * here can take several seconds (real network calls to two external APIs);
 * that cost is why this is called asynchronously and never awaited on the
 * main report-generation path — see lib/academic-evidence-integration.ts's
 * own header comment for the non-blocking, non-fatal contract every call
 * into lib/academic-search/ from this route already carries.
 */

const MAX_TEXT_LENGTH = 1_000_000;
const MIN_TEXT_LENGTH = 80;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function POST(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { text } = body as Record<string, unknown>;
    if (!isNonEmptyString(text)) return new NextResponse(JSON.stringify({ error: 'text is required' }), { status: 400 });
    if (text.length < MIN_TEXT_LENGTH) {
      // Nothing worth querying for — a property of the input, not a
      // provider outage, so this is COMPLETE_NO_MATCHES, not FAILED. See
      // AcademicSearchStatus's own header comment.
      return new NextResponse(JSON.stringify({ evidence: [], stats: null, status: 'COMPLETE_NO_MATCHES' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return new NextResponse(JSON.stringify({ error: 'text is too long' }), { status: 413 });
    }

    const { evidence, stats, status } = await getExternalAcademicEvidence(text);

    return new NextResponse(JSON.stringify({ evidence, stats, status }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    // getExternalAcademicEvidence is itself non-throwing (best-effort) — this
    // catch only guards request parsing/rate-limiting above it. Even here,
    // a 200 with empty evidence would be equally valid (the caller already
    // treats any non-ok response as "no evidence" — see
    // app/page.tsx's analyzeAcademicEvidence()); a real error status is kept
    // so genuine failures stay visible in logs/monitoring rather than
    // silently looking identical to "no sources found."
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
