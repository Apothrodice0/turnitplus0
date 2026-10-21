import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../../../lib/reports-db';
import { checkReadRate } from '../../../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../../../lib/client-ip';
import { findReportRowForUser } from '../../../../../../../lib/reports-repo';
import { getSessionUser } from '../../../../../../../lib/auth-session';
import { DOCUMENT_LAYOUT_LIMITS, DOCUMENT_LAYOUT_MEDIA_TYPES } from '../../../../../../../lib/report-document-layout';
import { readReportDocumentMedia } from '../../../../../../../lib/report-document-layout-repo';

/**
 * One image of a report's saved document layout (see ../route.ts). Owner only — a session is required and the
 * report must belong to it; anyone else gets 404. Served privately (never cached by shared caches).
 */

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const rate = await checkReadRate(clientIpFrom(request));
  if (!rate.allowed) return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
  const { id, index } = await params;
  const n = Number(index);
  if (!id || !Number.isInteger(n) || n < 0 || n >= DOCUMENT_LAYOUT_LIMITS.mediaCount) return notFound();
  const client = await getReportsDbClient();
  try {
    const user = await getSessionUser(request, client);
    if (!user) return new NextResponse(JSON.stringify({ error: 'Sign in to view this report.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!(await findReportRowForUser(client, id, user.id))) return notFound();
    const media = await readReportDocumentMedia(client, id, user.id, n);
    if (!media || !(DOCUMENT_LAYOUT_MEDIA_TYPES as readonly string[]).includes(media.contentType)) return notFound();
    return new NextResponse(media.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': media.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    console.error('document layout image read failed', error instanceof Error ? error.name : 'error');
    return new NextResponse(JSON.stringify({ error: 'Image temporarily unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } finally {
    client.close();
  }
}
