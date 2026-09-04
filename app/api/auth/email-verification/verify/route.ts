import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkEmailVerificationRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../../lib/same-origin';
import {
  isWellFormedEmailVerificationToken,
  findEmailVerificationChallengeByToken,
  classifyEmailVerificationChallenge,
  consumeEmailVerificationChallengeStatement,
  setUserEmailVerifiedIfChallengeConsumedStatement,
  usersHaveEmailVerifiedAtColumn,
  type EmailVerificationRejectReason,
} from '../../../../../lib/email-verification';

export const dynamic = 'force-dynamic';

// A generic message for every "can't tell you exactly why" case — an unknown or
// malformed token must not reveal whether a challenge with that shape exists.
const GENERIC_REJECT = 'This verification link is invalid or has expired.';

const REJECT_MESSAGE: Record<EmailVerificationRejectReason, string> = {
  MALFORMED: GENERIC_REJECT,
  UNKNOWN: GENERIC_REJECT,
  EXPIRED: 'This verification link has expired. Request a new one from your account page.',
  CONSUMED: 'This verification link has already been used.',
  REVOKED: 'This verification link is no longer valid. Request a new verification email from your account page.',
  EMAIL_CHANGED: 'This verification link is no longer valid because your email address changed. Request a new one.',
};

function json(body: unknown, status: number) {
  return new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const isSqliteBusy = (err: unknown) => err instanceof Error && /SQLITE_BUSY/i.test(err.message);
const MAX_WRITE_RETRIES = 5;

/**
 * A3 — consume an email-verification challenge and mark the account's email
 * verified, atomically.
 *
 * Safe against: replay / double-use (single atomic conditional consume,
 * rowsAffected must be 1), expired token, revoked token (email change),
 * malformed token (rejected before any DB work), and a token whose target
 * address no longer matches the account's current email.
 *
 * No session is required — the 256-bit single-use token IS the proof of
 * mailbox control, exactly as an email link works when opened logged-out.
 */
export async function POST(request: Request) {
  try {
    if (isCrossOriginBrowserRequest(request)) {
      return json(CROSS_ORIGIN_REJECTED, 403);
    }

    const rate = await checkEmailVerificationRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter), 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => null);
    const token = body && typeof body === 'object' ? (body as { token?: unknown }).token : null;

    if (!isWellFormedEmailVerificationToken(token)) {
      return json({ error: GENERIC_REJECT }, 400);
    }

    // --- read + classify -------------------------------------------------
    const readClient = await getReportsDbClient();
    let challengeId: string;
    let challengeUserId: string;
    try {
      // Deploy-ordering safety: the challenge table + users.email_verified_at
      // arrive with migration 0046. Without it no token can be valid — treat it
      // as an invalid link, not a 500.
      if (!(await usersHaveEmailVerifiedAtColumn(readClient))) {
        return json({ error: GENERIC_REJECT }, 400);
      }

      const challenge = await findEmailVerificationChallengeByToken(readClient, token);
      if (!challenge) {
        return json({ error: GENERIC_REJECT }, 400);
      }

      const userRow = await readClient.execute({ sql: 'SELECT email FROM users WHERE id = ?', args: [challenge.userId] });
      if (userRow.rows.length === 0) {
        return json({ error: GENERIC_REJECT }, 400);
      }
      const currentEmail = String((userRow.rows[0] as unknown as { email: string }).email);

      const reject = classifyEmailVerificationChallenge(challenge, currentEmail, Date.now());
      if (reject) {
        return json({ error: REJECT_MESSAGE[reject] }, 400);
      }

      // No profile check: verified-email state lives on users.email_verified_at,
      // which every account has — a grandfathered profile-less account verifies
      // exactly like any other.
      challengeId = challenge.id;
      challengeUserId = challenge.userId;
    } finally {
      readClient.close();
    }

    // --- atomic consume + mark verified --------------------------------
    // ONE transaction (client.batch): the conditional consume and a
    // SELF-GUARDED UPDATE of users.email_verified_at — the UPDATE only fires
    // when THIS request's consume set consumed_at to exactly `now`, so a
    // concurrent verify of the same token can never also flip the marker. The
    // consume's rowsAffected is the authoritative "did I win" signal. Retried on
    // SQLITE_BUSY with a fresh connection each time, matching this codebase's
    // concurrent-write convention (see app/api/reports/route.ts
    // insertReportWithRoomCheck).
    let won = false;
    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const now = Date.now();
      const writeClient = await getReportsDbClient();
      try {
        const results = await writeClient.batch(
          [
            consumeEmailVerificationChallengeStatement(challengeId, now),
            setUserEmailVerifiedIfChallengeConsumedStatement(challengeUserId, challengeId, now),
          ],
          'write',
        );
        won = Number(results[0].rowsAffected) === 1;
        break;
      } catch (writeErr) {
        if (!isSqliteBusy(writeErr) || attempt === MAX_WRITE_RETRIES) throw writeErr;
        await new Promise((r) => setTimeout(r, 25 * attempt + Math.floor(Math.random() * 25)));
      } finally {
        writeClient.close();
      }
    }

    if (won) {
      return json({ status: 'verified' }, 200);
    }
    // Lost the race, or the challenge changed state between our read and the
    // write. "Already used" is the overwhelmingly common cause and a safe
    // generic here.
    return json({ error: REJECT_MESSAGE.CONSUMED }, 400);
  } catch (err) {
    console.error('email verification verify error:', err instanceof Error ? err.message : String(err));
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
