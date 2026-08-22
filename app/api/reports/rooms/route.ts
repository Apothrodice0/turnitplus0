import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { getRoomCountForRole, isWithinActiveCycle, roomCycleEndsAt, type RoomIndexEntry } from '../../../../lib/report-rooms';

/**
 * The room/slot architecture's index: ONE lightweight query returning each
 * room's status (empty/processing/ready) and, when occupied, its occupant's
 * timestamps — never the report itself. This is the only thing "opening My
 * Reports" fetches from the network (client-side cached for 24h — see
 * lib/report-rooms-cache.ts); a specific room's actual current report is
 * only ever requested by GET /api/reports?room=N, and only when the user
 * opens that room.
 *
 * "processing" (occupied, but ai_score not yet recorded — see
 * lib/report-rooms.ts's own header comment for why this genuinely happens)
 * is derived here from the ai_score column alone, without parsing
 * payload_json — cheap enough to keep this index a single, lightweight
 * query. This can't distinguish "AI analysis still in flight" from "AI
 * analysis permanently failed" (both leave ai_score NULL) — that finer
 * distinction only matters once a room is actually opened, and belongs to
 * app/reports/rooms/[room]/room-page-shell.tsx, which has the full
 * payload to check.
 *
 * The number of rooms returned depends on the account's role
 * (getRoomCountForRole) but "role" itself is never sent to the client here —
 * only however many room entries the array happens to contain. The client
 * renders whatever it's given without needing to know why.
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

      const roomCount = getRoomCountForRole(sessionUser.role);

      // One row per room that has ever held a report, its single most
      // recent occupant's timestamp and ai_score — never the report content
      // itself, and never more than roomCount rows matter (any legacy
      // room_number a demoted admin/expanded-then-shrunk account might have
      // beyond its current roomCount is simply not rendered as a row,
      // matching this index's own "however many entries it returns"
      // contract). `ai_score` here is a bare (non-aggregated) column
      // alongside a single MAX() aggregate — SQLite's documented behavior
      // (see "bare columns in a min()/max() query" in its own SELECT docs)
      // takes it from the SAME row that produced the max, i.e. the current
      // occupant's own ai_score, not an arbitrary row in the group.
      const result = await client.execute({
        sql: `SELECT room_number, MAX(report_created_at) as most_recent, ai_score
              FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL
              GROUP BY room_number`,
        args: [sessionUser.id],
      });

      const occupantByRoom = new Map<number, { mostRecent: string; aiScore: number | bigint | null }>();
      for (const row of result.rows as unknown as { room_number: number | bigint; most_recent: string; ai_score: number | bigint | null }[]) {
        occupantByRoom.set(Number(row.room_number), { mostRecent: row.most_recent, aiScore: row.ai_score });
      }

      const rooms: RoomIndexEntry[] = Array.from({ length: roomCount }, (_, room) => {
        const occupant = occupantByRoom.get(room);
        if (occupant && isWithinActiveCycle(occupant.mostRecent)) {
          const status = occupant.aiScore === null ? 'processing' : 'ready';
          return { room, status, mostRecentAt: occupant.mostRecent, cycleEndsAt: roomCycleEndsAt(occupant.mostRecent) };
        }
        return { room, status: 'empty', mostRecentAt: null, cycleEndsAt: null };
      });

      return new NextResponse(JSON.stringify({ rooms }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
