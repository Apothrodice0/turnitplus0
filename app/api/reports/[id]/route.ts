import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';

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
    try {
      const sessionUser = await getSessionUser(request, client);
      if (sessionUser) {
        // id alone is only unique per (device_key, id) at the schema level,
        // not per (user_id, id) — report ids are client-generated timestamps,
        // so a same-millisecond id from two of one account's devices is
        // theoretically possible. Resolve deterministically rather than
        // returning an arbitrary row.
        const result = await client.execute({
          sql: 'SELECT payload_json FROM saved_reports WHERE id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1',
          args: [id, sessionUser.id],
        });
        row = result.rows[0];
      } else {
        const url = new URL(request.url);
        const deviceKey = url.searchParams.get('deviceKey');
        if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
          return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
        }
        const result = await client.execute({
          sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ? AND user_id IS NULL',
          args: [deviceKey, id],
        });
        row = result.rows[0];
      }
    } finally {
      client.close();
    }

    if (!row) {
      return new NextResponse(JSON.stringify({ error: 'Report not found' }), { status: 404 });
    }

    const payload = JSON.parse(String(row.payload_json));
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
