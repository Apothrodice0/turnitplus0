import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkRate, checkReadRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { findReportRowForUser } from '../../../../../lib/reports-repo';
import { getSessionUser } from '../../../../../lib/auth-session';
import { CROSS_ORIGIN_REJECTED, isCrossOriginBrowserRequest } from '../../../../../lib/same-origin';
import { tryDecodeReportFromPersistence } from '../../../../../lib/report-persistence';
import { DOCUMENT_LAYOUT_LIMITS, DOCUMENT_LAYOUT_MEDIA_TYPES, parseStoredDocumentLayout } from '../../../../../lib/report-document-layout';
import { readReportDocumentLayout, saveReportDocumentLayout } from '../../../../../lib/report-document-layout-repo';

/**
 * SAVED DOCUMENT LAYOUT (2026-10-21) — the original document's formatting for one report, captured in the owner's
 * browser during the upload (lib/report-document-layout-client.ts) and read back for the printed report's
 * manuscript pages. Owner only: a session is required and the report must belong to it; anyone else gets 404.
 * Nothing about the document's content is logged.
 *
 *   PUT  multipart/form-data: "layout" (JSON, lib/report-document-layout.ts) + "media" parts in index order
 *   GET  {"layout": <stored layout>, "mediaIndexes": [...]}
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } as const;
const json = (status: number, body: unknown) => new NextResponse(JSON.stringify(body), { status, headers: NO_STORE });

function reportText(payloadJson: unknown): string | null {
  try {
    const decoded = tryDecodeReportFromPersistence(JSON.parse(String(payloadJson)), {});
    return decoded.ok ? decoded.report.text ?? '' : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rate = await checkReadRate(clientIpFrom(request));
  if (!rate.allowed) return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rate.retryAfter) } });
  const { id } = await params;
  if (!id) return json(400, { error: 'id is required' });
  const client = await getReportsDbClient();
  try {
    const user = await getSessionUser(request, client);
    if (!user) return json(401, { error: 'Sign in to view this report.' });
    const row = await findReportRowForUser(client, id, user.id);
    if (!row) return json(404, { error: 'Not found' });
    const saved = await readReportDocumentLayout(client, id, user.id);
    if (!saved) return json(404, { error: 'No saved layout' });
    // layout_json was validated when it was saved; it is sent as stored
    return new NextResponse(`{"layout":${saved.layoutJson},"mediaIndexes":${JSON.stringify(saved.mediaIndexes)}}`, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error('document layout read failed', error instanceof Error ? error.name : 'error');
    return json(500, { error: 'Layout temporarily unavailable' });
  } finally {
    client.close();
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossOriginBrowserRequest(request)) return json(403, CROSS_ORIGIN_REJECTED);
  const rate = await checkRate(clientIpFrom(request));
  if (!rate.allowed) return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rate.retryAfter) } });
  const { id } = await params;
  if (!id) return json(400, { error: 'id is required' });
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > DOCUMENT_LAYOUT_LIMITS.requestBytes) return json(413, { error: 'Layout too large' });

  const client = await getReportsDbClient();
  try {
    const user = await getSessionUser(request, client);
    if (!user) return json(401, { error: 'Sign in to save this layout.' });
    const row = await findReportRowForUser(client, id, user.id);
    if (!row) return json(404, { error: 'Not found' });

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, { error: 'Expected a multipart layout upload' });
    }
    const layoutPart = form.get('layout');
    if (!(layoutPart instanceof Blob) || layoutPart.size > DOCUMENT_LAYOUT_LIMITS.layoutBytes) return json(413, { error: 'Layout too large' });
    const layoutJson = await layoutPart.text();
    let stored;
    try {
      stored = parseStoredDocumentLayout(JSON.parse(layoutJson));
    } catch {
      stored = null;
    }
    if (!stored) return json(400, { error: 'Invalid layout' });

    // the layout must describe this report's own saved text
    const text = reportText(row.payload_json);
    if (text === null) return json(409, { error: 'Report unavailable' });
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== stored.textSha256) return json(409, { error: 'Layout does not match this report' });

    const parts = form.getAll('media');
    if (parts.length !== stored.media.length) return json(400, { error: 'Images do not match the layout' });
    const media: Array<{ contentType: string; bytes: Uint8Array }> = [];
    let total = layoutPart.size;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!(part instanceof Blob)) return json(400, { error: 'Invalid image' });
      const contentType = stored.media[i].contentType;
      if (!(DOCUMENT_LAYOUT_MEDIA_TYPES as readonly string[]).includes(part.type) || part.type !== contentType) return json(415, { error: 'Unsupported image type' });
      if (part.size > DOCUMENT_LAYOUT_LIMITS.mediaBytes) return json(413, { error: 'Image too large' });
      total += part.size;
      if (total > DOCUMENT_LAYOUT_LIMITS.requestBytes) return json(413, { error: 'Layout too large' });
      media.push({ contentType, bytes: new Uint8Array(await part.arrayBuffer()) });
    }

    try {
      await saveReportDocumentLayout(client, { reportId: id, userId: user.id, layoutVersion: stored.version, textSha256: stored.textSha256, layoutJson: JSON.stringify(stored), media });
    } catch (error) {
      // migration 0055 not applied in this environment: the report keeps its standard PDF
      if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return json(503, { error: 'Layout storage unavailable', code: 'LAYOUT_STORAGE_UNAVAILABLE' });
      throw error;
    }
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('document layout save failed', error instanceof Error ? error.name : 'error');
    return json(500, { error: 'Layout could not be saved' });
  } finally {
    client.close();
  }
}
