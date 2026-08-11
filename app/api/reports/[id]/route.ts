import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';

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
    const url = new URL(request.url);
    const deviceKey = url.searchParams.get('deviceKey');
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });
    if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
      return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
    }

    const client = getReportsDbClient();
    let row;
    try {
      const result = await client.execute({
        sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
        args: [deviceKey, id],
      });
      row = result.rows[0];
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
    const url = new URL(request.url);
    const deviceKey = url.searchParams.get('deviceKey');
    if (!isNonEmptyString(id)) return new NextResponse(JSON.stringify({ error: 'id is required' }), { status: 400 });
    if (!isNonEmptyString(deviceKey) || deviceKey.length > MAX_DEVICE_KEY_LENGTH) {
      return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
    }

    const client = getReportsDbClient();
    try {
      await client.execute({
        sql: 'DELETE FROM saved_reports WHERE device_key = ? AND id = ?',
        args: [deviceKey, id],
      });
    } finally {
      client.close();
    }

    return new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
