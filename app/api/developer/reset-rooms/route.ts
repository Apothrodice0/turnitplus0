import { NextResponse } from 'next/server';
import type { Client } from '@libsql/client';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import { deleteAllReportDataForAccount } from '../../../../lib/account-deletion';

/**
 * Debug workspace — "Clear my rooms". Deletes every saved report the
 * CURRENTLY AUTHENTICATED developer owns (and all of that report's own
 * dependent data), so debugging can start from an empty room list.
 *
 * Authorization: exactly the same gate every other /api/developer/* route
 * uses — getAdminSessionUser resolves the session cookie server-side and
 * returns null for both "not signed in" and "signed in but not an admin",
 * and this route collapses both into the same plain 404 (never 401/403,
 * never a body) so its existence is not revealed to a non-admin caller. The
 * account whose data is cleared is ALWAYS admin.id from that resolved
 * session — the request body carries no account/user id, and if one were
 * added it would be ignored. There is no "all users" mode: deleteAllReport-
 * DataForAccount is scoped to a single accountId on every query and write.
 *
 * Two-step by contract:
 *   { dryRun: true }  -> report count + affected room numbers, ZERO writes.
 *   { dryRun: false } -> performs the deletion, returns the deleted count.
 * `dryRun` must be an explicit boolean; anything else is a 400.
 *
 * Corpus rule: this resets the developer's reports/rooms only. It is NOT a
 * corpus reset. deleteAllReportDataForAccount reuses the exact single-report
 * delete lifecycle, which leaves already-ACCEPTED / promoted corpus
 * representations and retained admission content intact (a representation is
 * only removed once its LAST reference is gone; an accepted admission
 * decision + its content store + its accepted_representations fingerprint
 * are never touched) — see that function's own header comment.
 */

type ResetRoomsBody = { dryRun?: unknown };

function jsonResponse(body: unknown, status: number): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function affectedRoomsForAccount(
  client: Client,
  accountId: string,
): Promise<{ reportCount: number; rooms: number[] }> {
  const countResult = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?',
    args: [accountId],
  });
  const reportCount = Number((countResult.rows[0] as unknown as { c: number | bigint }).c);

  const roomsResult = await client.execute({
    sql: 'SELECT DISTINCT room_number FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL ORDER BY room_number',
    args: [accountId],
  });
  const rooms = (roomsResult.rows as unknown as { room_number: number | bigint }[]).map((row) => Number(row.room_number));

  return { reportCount, rooms };
}

export async function POST(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      // Authorization BEFORE body validation: a non-admin or anonymous
      // caller always gets the same plain 404 (never a 400 that would
      // confirm the route exists by validating its body), matching the
      // "existence not revealed to a non-admin" intent every /api/developer/*
      // route is built around.
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      }

      const body = (await request.json().catch(() => null)) as ResetRoomsBody | null;
      if (!body || typeof body !== 'object') {
        return jsonResponse({ error: 'Invalid JSON' }, 400);
      }
      if (typeof body.dryRun !== 'boolean') {
        return jsonResponse({ error: 'dryRun must be a boolean' }, 400);
      }
      // Identity is admin.id from the resolved session ONLY. The body is read
      // exclusively for `dryRun`; any account/user/device id a caller adds to
      // it is ignored — there is deliberately no code path that reads one.
      const dryRun = body.dryRun;

      if (dryRun) {
        const { reportCount, rooms } = await affectedRoomsForAccount(client, admin.id);
        return jsonResponse(
          {
            dryRun: true,
            reportsToDelete: reportCount,
            roomsAffected: rooms,
            acceptedCorpusContentAffected: false,
          },
          200,
        );
      }

      // Capture the affected rooms BEFORE deletion so the client can refresh
      // exactly those room tiles; the count returned is the authoritative
      // one from the deletion itself.
      const { rooms } = await affectedRoomsForAccount(client, admin.id);
      // preserveActivelyPromotedRepresentations: this is a room/report debug
      // reset, never a corpus reset — a representation that is still a live,
      // non-revoked promoted matching source must survive even if this
      // developer's own submission reference was its last one. Accepted
      // admission decisions / retained text / fingerprints are already kept
      // by deleteReportCorpusAdmissionData's own accepted-content guard.
      const result = await deleteAllReportDataForAccount(client, admin.id, {
        preserveActivelyPromotedRepresentations: true,
      });

      return jsonResponse(
        {
          dryRun: false,
          reportsDeleted: result.reportsDeleted,
          roomsCleared: rooms,
        },
        200,
      );
    } finally {
      client.close();
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
