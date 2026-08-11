import { NextResponse } from 'next/server';
import path from 'path';
import { createHash } from 'node:crypto';
import { ingestDocument } from '../../../lib/ingest';
import { checkRate } from '../../../lib/rate-limit';

const MAX_BYTES = 200_000; // 200KB request size limit

function sha256Hex(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function POST(request: Request) {
  try {
    // Rate limiting
    const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const clientIp = forwarded.split(',')[0].trim();
    const rate = checkRate(clientIp);
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    // Reject large payloads using Content-Length if present
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    const { text, contributionPolicyVersion, provenanceSha256, id, title } = body as any;
    if (!contributionPolicyVersion || typeof contributionPolicyVersion !== 'string') {
      return new NextResponse(JSON.stringify({ error: 'contributionPolicyVersion is required' }), { status: 400 });
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return new NextResponse(JSON.stringify({ error: 'text is required' }), { status: 400 });
    }
    if (text.length > MAX_BYTES) {
      return new NextResponse(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
    }

    // Validate optional provenanceSha256
    const computed = sha256Hex(text);
    if (provenanceSha256 && provenanceSha256 !== computed) {
      return new NextResponse(JSON.stringify({ error: 'provenanceSha256 mismatch' }), { status: 400 });
    }

    // DB path from env for flexibility in tests
    const dbPath = process.env.INGEST_DB_PATH || path.join(process.cwd(), 'data', 'turnitplus.db');

    // Call ingestDocument; do not pass any test-only options
    const result = ingestDocument(dbPath, { id, title, text, contributionPolicyVersion });

    const status = result.created ? 201 : 200;
    return new NextResponse(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
