import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser } from '../../../../lib/auth-session';
import { deriveRoomStatus, isWithinActiveCycle, ROOM_CYCLE_MS, roomCycleEndsAt, type RoomIndexEntry } from '../../../../lib/report-rooms';
import { readActiveRoomClaims, reportAccessRefusal, resolveRoomPolicy } from '../../../../lib/account-entitlements';
import { scheduleExpiryCleanupAfterRefusal } from '../../../../lib/subscription-expiry-cleanup';
import { subscriptionNoticeFor } from '../../../../lib/account-plan';
import { roomTimeSql } from '../../../../lib/report-history';

/**
 * The room/slot architecture's index: ONE lightweight query returning each
 * room's status (empty/processing/ready/failed) and, when occupied, its
 * occupant's timestamps — never the report itself. This is the only thing
 * "opening My Reports" fetches from the network (client-side cached for
 * 24h — see lib/report-rooms-cache.ts); a specific room's actual current
 * report is only ever requested by GET /api/reports?room=N, and only when
 * the user opens that room.
 *
 * Status is derived here from the bare ai_score/ai_status columns alone
 * (lib/report-rooms.ts's deriveRoomStatus), without parsing payload_json —
 * cheap enough to keep this index a single, lightweight query. "processing"
 * vs "failed" (production audit fix) is a real, persisted distinction as
 * of ai_status, not something this index has to infer — a genuinely failed
 * AI check shows as "failed" here directly, the same as it does once the
 * room is actually opened.
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

export async function GET(request: Request) {
  try {
    const rate = await checkReadRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return new NextResponse(JSON.stringify({ rooms: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Manual account activation (lib/account-entitlements.ts): with it off, exactly getRoomCountForRole's count and
      // the same response as before; with it on, the plan's rooms (plus any room that still holds a report).
      const policy = await resolveRoomPolicy(client, sessionUser);
      const roomCount = policy.visibleRoomCount;

      // Manual subscriptions (lib/account-entitlements.ts REPORT ACCESS, owner decision 2026-10-30): no subscription,
      // expired or suspended — no room and no report at all, only the subscription-required screen's notice (My Reports
      // and the account navigation show no history). Nothing about the account's reports is read; an expired plan's
      // report data is deleted after the response.
      const accessRefusal = reportAccessRefusal(policy);
      if (accessRefusal) {
        await scheduleExpiryCleanupAfterRefusal(accessRefusal.code, sessionUser);
        const lock = subscriptionNoticeFor(accessRefusal.code, policy.entitlement?.expiresAt ?? null);
        return new NextResponse(JSON.stringify({ rooms: [], notice: accessRefusal.message, lock }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

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
        // Room time (lib/report-history.ts): the server's saved_at with report history retention on, so a room's
        // current report and its 24 h cycle never depend on a browser-supplied date; report_created_at otherwise.
        sql: `SELECT room_number, MAX(${roomTimeSql()}) as most_recent, ai_score, ai_status
              FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL
              GROUP BY room_number`,
        args: [sessionUser.id],
      });

      const occupantByRoom = new Map<number, { mostRecent: string; aiScore: number | bigint | null; aiStatus: string | null }>();
      for (const row of result.rows as unknown as { room_number: number | bigint; most_recent: string; ai_score: number | bigint | null; ai_status: string | null }[]) {
        occupantByRoom.set(Number(row.room_number), { mostRecent: row.most_recent, aiScore: row.ai_score, aiStatus: row.ai_status });
      }

      if (!policy.enforced) {
        const rooms: RoomIndexEntry[] = Array.from({ length: roomCount }, (_, room) => {
          const occupant = occupantByRoom.get(room);
          if (occupant && isWithinActiveCycle(occupant.mostRecent)) {
            const status = deriveRoomStatus(occupant.aiScore === null ? null : Number(occupant.aiScore), occupant.aiStatus);
            return { room, status, mostRecentAt: occupant.mostRecent, cycleEndsAt: roomCycleEndsAt(occupant.mostRecent) };
          }
          return { room, status: 'empty', mostRecentAt: null, cycleEndsAt: null };
        });

        return new NextResponse(JSON.stringify({ rooms }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const now = Date.now();
      // No new check allowed for another reason (new checks unavailable — the plan tables are missing): list only the rooms that hold a report — each with its
      // latest report, however old, so the customer can still open and read it — and nothing that looks usable. An
      // account with no reports at all gets one locked placeholder room. Room numbers are the reports' own.
      if (policy.block) {
        const historyRooms = [...occupantByRoom.keys()].filter((room) => room < roomCount).sort((a, b) => a - b);
        const rooms: RoomIndexEntry[] = historyRooms.map((room) => {
          const occupant = occupantByRoom.get(room)!;
          const status = deriveRoomStatus(occupant.aiScore === null ? null : Number(occupant.aiScore), occupant.aiStatus);
          const current = isWithinActiveCycle(occupant.mostRecent, now);
          const entry: RoomIndexEntry = { room, status, mostRecentAt: occupant.mostRecent, cycleEndsAt: current ? roomCycleEndsAt(occupant.mostRecent) : null };
          if (!current) entry.historical = true;
          return entry;
        });
        if (rooms.length === 0) rooms.push({ room: 0, status: 'empty', mostRecentAt: null, cycleEndsAt: null });
        const lock = subscriptionNoticeFor(policy.block.code, policy.entitlement?.expiresAt ?? null);
        return new NextResponse(JSON.stringify({ rooms, notice: policy.block.message, lock }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Enforced plan: a room is busy until the later of its report's 24 h cycle and its server-clock claim, so a
      // deleted or back-dated report never shows its room as free before the server will accept a new check in it.
      const claims = policy.usesRoomClaims ? await readActiveRoomClaims(client, sessionUser.id, now) : new Map<number, number>();
      const rooms: RoomIndexEntry[] = Array.from({ length: roomCount }, (_, room) => {
        const occupant = occupantByRoom.get(room);
        const claimedAt = claims.get(room);
        const claimEndsAt = claimedAt === undefined ? null : new Date(claimedAt + ROOM_CYCLE_MS).toISOString();
        if (occupant && (isWithinActiveCycle(occupant.mostRecent, now) || claimEndsAt)) {
          const status = deriveRoomStatus(occupant.aiScore === null ? null : Number(occupant.aiScore), occupant.aiStatus);
          const cycleEndsAt = isWithinActiveCycle(occupant.mostRecent, now) ? roomCycleEndsAt(occupant.mostRecent) : null;
          const endsAt = [cycleEndsAt, claimEndsAt].filter((v): v is string => v !== null).sort().pop() as string;
          return { room, status, mostRecentAt: occupant.mostRecent, cycleEndsAt: endsAt };
        }
        if (room >= policy.uploadRoomCount) {
          // Beyond the purchased rooms: listed only for an earlier report (readable, never a new check); otherwise hidden,
          // so the list shows exactly the plan's room allowance.
          if (!occupant) return null;
          const status = deriveRoomStatus(occupant.aiScore === null ? null : Number(occupant.aiScore), occupant.aiStatus);
          return { room, status, mostRecentAt: occupant.mostRecent, cycleEndsAt: null, outsidePlan: true, historical: true } satisfies RoomIndexEntry;
        }
        const entry: RoomIndexEntry = { room, status: 'empty', mostRecentAt: null, cycleEndsAt: null };
        if (claimEndsAt) entry.availableAt = claimEndsAt;
        return entry;
      }).filter((entry): entry is RoomIndexEntry => entry !== null);

      return new NextResponse(JSON.stringify({ rooms }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
