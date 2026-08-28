import { NextResponse } from 'next/server';
import type { Client } from '@libsql/client';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import { deleteAllReportDataForAccount } from '../../../../lib/account-deletion';

/**
 * Debug workspace — "Clear account rooms". Lets an authenticated admin enter
 * ONE exact account email and clear only THAT account's saved reports / room
 * occupancy. Distinct from POST /api/developer/reset-rooms ("Clear my
 * rooms"), which is unchanged and always targets the caller's own account.
 *
 * Authorization (identical to every other /api/developer/* route):
 * getAdminSessionUser resolves the session cookie server-side and returns
 * null for both "not signed in" and "signed in but not an admin"; this route
 * collapses both into the same plain 404 (never 401/403, never a body),
 * checked BEFORE any body validation so the route's existence is never
 * revealed to a non-admin. The email in the body is a TARGET SELECTOR ONLY —
 * it never grants authority. Authority is the admin session, full stop.
 * `userId` / `accountId` / `deviceKey` from the client are never read: the
 * account id passed to deletion is ALWAYS resolved server-side from the
 * email lookup below, and the destructive request re-resolves it fresh.
 *
 * Email match:
 *  - Normalization is `email.trim().toLowerCase()` — byte-identical to what
 *    app/api/auth/signup/route.ts, login, PATCH /api/auth/me, and
 *    lib/admin-role.ts all apply before writing/comparing users.email (unique
 *    index ux_users_email, drizzle/0009). This is NOT a second rule; it is
 *    the same one.
 *  - Match is exact equality (`WHERE email = ?`, parameterized) — never LIKE,
 *    prefix, substring, fuzzy, or wildcard. A "*"/"%" in the input is inert:
 *    it is compared as a literal and simply resolves to no account.
 *  - 0 accounts -> a safe { found: false } 200 to the authenticated admin
 *    (zero writes). >1 accounts (impossible under ux_users_email, guarded
 *    anyway) -> 409, never a guess.
 *
 * Two-step by contract:
 *  - { email, dryRun: true }  -> canonical accountEmail + report count +
 *    affected rooms. ZERO writes. No token of any kind.
 *  - { email, dryRun: false, confirmEmail } -> the admin must re-enter the
 *    exact target email; the server canonicalizes BOTH the same way and
 *    refuses (400, zero writes) unless they are equal, then re-resolves the
 *    account by that canonical email and deletes only that account. Stateless
 *    and instance-independent by design — nothing from the dry run needs to
 *    survive to the destructive call.
 *
 * Deletion scope: reuses deleteAllReportDataForAccount(accountId, {
 * preserveActivelyPromotedRepresentations: true }) — EXACTLY the same
 * account-scoped cleanup "Clear my rooms" uses. Clears the target account's
 * saved_reports / room occupancy / historical-match snapshots / document
 * identities / admission jobs / non-ACCEPTed admission state, and nothing
 * else. Never touches the target's users row, sessions, or consent state; is
 * not account deletion, a corpus reset, or consent revocation; and leaves
 * ACCEPTed / promoted corpus content (decisions, retained text, fingerprints,
 * indexed promotions, promoted representations + shingles) fully intact and
 * matchable.
 */

const MAX_EMAIL_LENGTH = 254;
// Same shape check signup/login apply before persisting users.email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ResetAccountRoomsBody = { email?: unknown; dryRun?: unknown; confirmEmail?: unknown };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function jsonResponse(body: unknown, status: number): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** THE existing canonical account-email rule — see this file's header comment. */
function canonicalizeAccountEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Account-scoped room occupancy — mirrors affectedRoomsForAccount in
 * app/api/developer/reset-rooms/route.ts (kept as its own copy so that
 * "Clear my rooms" route stays byte-for-byte unchanged by this feature).
 */
async function accountRoomOccupancy(client: Client, accountId: string): Promise<{ reportCount: number; rooms: number[] }> {
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

type ResolveResult =
  | { kind: 'found'; accountId: string }
  | { kind: 'none' }
  | { kind: 'conflict'; count: number };

async function resolveExactlyOneAccount(client: Client, canonicalEmail: string): Promise<ResolveResult> {
  const result = await client.execute({
    sql: 'SELECT id FROM users WHERE email = ?',
    args: [canonicalEmail],
  });
  if (result.rows.length === 0) return { kind: 'none' };
  if (result.rows.length > 1) return { kind: 'conflict', count: result.rows.length };
  return { kind: 'found', accountId: String((result.rows[0] as unknown as { id: string }).id) };
}

export async function POST(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      // Auth BEFORE body validation — a non-admin/anonymous caller always
      // gets the same plain 404, never a 400 that would confirm the route.
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      }

      const body = (await request.json().catch(() => null)) as ResetAccountRoomsBody | null;
      if (!body || typeof body !== 'object') {
        return jsonResponse({ error: 'Invalid JSON' }, 400);
      }
      if (!isNonEmptyString(body.email) || body.email.length > MAX_EMAIL_LENGTH) {
        return jsonResponse({ error: 'A valid account email is required.' }, 400);
      }
      if (typeof body.dryRun !== 'boolean') {
        return jsonResponse({ error: 'dryRun must be a boolean' }, 400);
      }
      const dryRun = body.dryRun;
      // Canonicalize (trim + lowercase — THE existing rule) BEFORE the shape
      // check, so validation and lookup both see exactly what is stored in
      // users.email.
      const targetEmail = canonicalizeAccountEmail(body.email);
      if (!EMAIL_PATTERN.test(targetEmail)) {
        return jsonResponse({ error: 'A valid account email is required.' }, 400);
      }

      // Destructive requests require an exact re-entered confirmation email,
      // canonicalized the SAME way and compared BEFORE any lookup or write.
      if (!dryRun) {
        if (!isNonEmptyString(body.confirmEmail) || body.confirmEmail.length > MAX_EMAIL_LENGTH) {
          return jsonResponse({ error: 'confirmEmail is required for a destructive reset — re-enter the exact target email.' }, 400);
        }
        const confirmEmail = canonicalizeAccountEmail(body.confirmEmail);
        if (confirmEmail !== targetEmail) {
          return jsonResponse({ error: 'confirmEmail does not match the target email.' }, 400);
        }
      }

      const resolved = await resolveExactlyOneAccount(client, targetEmail);
      if (resolved.kind === 'conflict') {
        return jsonResponse(
          { error: 'Multiple accounts share this normalized email — refusing to guess a deletion target.', accountEmail: targetEmail, conflict: true },
          409,
        );
      }
      if (resolved.kind === 'none') {
        // Safe, admin-only "not found" — no distinction between dry run and
        // destructive, and ZERO writes either way.
        return jsonResponse({ dryRun, accountEmail: targetEmail, found: false }, 200);
      }

      // Server-derived. The request body never supplies a deletion id.
      const accountId = resolved.accountId;

      if (dryRun) {
        const { reportCount, rooms } = await accountRoomOccupancy(client, accountId);
        return jsonResponse(
          {
            dryRun: true,
            accountEmail: targetEmail,
            found: true,
            reportsToDelete: reportCount,
            roomsAffected: rooms,
            acceptedCorpusContentAffected: false,
          },
          200,
        );
      }

      const { rooms } = await accountRoomOccupancy(client, accountId);
      const result = await deleteAllReportDataForAccount(client, accountId, {
        preserveActivelyPromotedRepresentations: true,
      });

      return jsonResponse(
        {
          dryRun: false,
          accountEmail: targetEmail,
          found: true,
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
