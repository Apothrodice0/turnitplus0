import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { REPORT_ROOM_COUNT, type RoomIndexEntry } from '../../../../lib/report-rooms';

/**
 * The 10-room architecture's index: ONE lightweight query returning a count
 * and most-recent-timestamp per room — never the reports themselves. This is
 * the only thing "opening My Reports" fetches from the network (client-side
 * cached for 24h — see lib/report-rooms-cache.ts); a specific room's actual
 * report summaries are only ever requested by GET /api/reports?room=N, and
 * only when the user opens that room.
 *
 * Meaningless for an anonymous caller (no account, no rooms) — returns an
 * empty index rather than an error, since this route's existence is not a
 * secret the way /api/developer/* is.
 */

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function GET(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return new NextResponse(JSON.stringify({ rooms: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const result = await client.execute({
        sql: `SELECT CAST(id AS INTEGER) % ${REPORT_ROOM_COUNT} as room, COUNT(*) as cnt, MAX(report_created_at) as most_recent
              FROM saved_reports WHERE user_id = ?
              GROUP BY room`,
        args: [sessionUser.id],
      });

      // Every room 0-9 is always present in the response, even with count 0
      // — the UI renders 10 tiles unconditionally, so it never has to
      // special-case "this room doesn't exist yet" versus "this room is
      // just empty."
      const byRoom = new Map<number, { count: number; mostRecentAt: string | null }>();
      for (const row of result.rows as unknown as { room: number | bigint; cnt: number | bigint; most_recent: string | null }[]) {
        byRoom.set(Number(row.room), { count: Number(row.cnt), mostRecentAt: row.most_recent });
      }
      const rooms: RoomIndexEntry[] = Array.from({ length: REPORT_ROOM_COUNT }, (_, room) => ({
        room,
        count: byRoom.get(room)?.count ?? 0,
        mostRecentAt: byRoom.get(room)?.mostRecentAt ?? null,
      }));

      return new NextResponse(JSON.stringify({ rooms }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
