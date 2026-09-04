import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkEmailVerificationRate, checkEmailVerificationAttemptRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getSessionUser } from '../../../../../lib/auth-session';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../../lib/same-origin';
import {
  isWellFormedEmailVerificationCode,
  mostRecentEmailVerificationChallenge,
  classifyEmailVerificationChallenge,
  emailVerificationCodeMatches,
  consumeEmailVerificationChallengeStatement,
  setUserEmailVerifiedIfChallengeConsumedStatement,
  usersHaveEmailVerifiedAtColumn,
  type EmailVerificationRejectReason,
} from '../../../../../lib/email-verification';

export const dynamic = 'force-dynamic';

// A generic message for every "can't tell you exactly why" case.
const GENERIC_REJECT = 'This verification code is invalid or has expired.';

const REJECT_MESSAGE: Record<EmailVerificationRejectReason, string> = {
  MALFORMED: 'Enter the 6-digit code exactly as it appears in the email.',
  UNKNOWN: 'Request a verification code from your account page first.',
  EXPIRED: 'This code has expired. Request a new one from your account page.',
  CONSUMED: 'This code has already been used.',
  REVOKED: 'This code is no longer valid. Request a new one from your account page.',
  EMAIL_CHANGED: 'This code is no longer valid because your email address changed. Request a new one.',
  WRONG_CODE: "That code doesn't match. Check the digits and try again.",
};

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const isSqliteBusy = (err: unknown) => err instanceof Error && /SQLITE_BUSY/i.test(err.message);
const MAX_WRITE_RETRIES = 5;

/**
 * A3b — consume the signed-in account's current email-verification code and
 * mark the account's email verified, atomically.
 *
 * REQUIRES A SESSION (A3b change from the link-token design, which needed
 * none: a 256-bit token was itself unguessable proof of mailbox control, but
 * a 6-digit code is not). The lookup is always the CALLER's own most recent
 * challenge (lib/email-verification.ts's mostRecentEmailVerificationChallenge)
 * — never a global digest lookup — so there is no way for one account to even
 * address another account's challenge, let alone verify it.
 *
 * Safe against: replay / double-use (single atomic conditional consume,
 * rowsAffected must be 1), expired code, revoked code (email change or a
 * newer resend), malformed code (rejected before any DB work), a code whose
 * target address no longer matches the account's current email, and
 * brute-force guessing (checkEmailVerificationAttemptRate — a code is only
 * ~1e6 possibilities, unlike the old 256-bit token).
 */
export async function POST(request: Request) {
  try {
    if (isCrossOriginBrowserRequest(request)) {
      return json(CROSS_ORIGIN_REJECTED, 403);
    }

    const rate = await checkEmailVerificationRate(clientIpFrom(request));
    if (!rate.allowed) {
      return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });
    }

    const body = await request.json().catch(() => null);
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null;

    if (!isWellFormedEmailVerificationCode(code)) {
      return json({ error: REJECT_MESSAGE.MALFORMED }, 400);
    }

    // --- session + per-account guess-rate + read + classify -------------
    const readClient = await getReportsDbClient();
    let challengeId: string;
    let challengeUserId: string;
    try {
      // Deploy-ordering safety: the challenge table + users.email_verified_at
      // arrive with migration 0046. Without it no code can be valid — treat it
      // as an invalid code, not a 500.
      if (!(await usersHaveEmailVerifiedAtColumn(readClient))) {
        return json({ error: GENERIC_REJECT }, 400);
      }

      const sessionUser = await getSessionUser(request, readClient);
      if (!sessionUser) {
        return json({ error: 'Not signed in.' }, 401);
      }

      const attemptRate = await checkEmailVerificationAttemptRate(sessionUser.id);
      if (!attemptRate.allowed) {
        return json(
          { error: 'Too many attempts. Please wait a moment or request a new code.' },
          429,
          { 'Retry-After': String(attemptRate.retryAfter) },
        );
      }

      const challenge = await mostRecentEmailVerificationChallenge(readClient, sessionUser.id);
      if (!challenge) {
        return json({ error: REJECT_MESSAGE.UNKNOWN }, 400);
      }

      const reject = classifyEmailVerificationChallenge(challenge, sessionUser.email, Date.now());
      if (reject) {
        return json({ error: REJECT_MESSAGE[reject] }, 400);
      }

      if (!emailVerificationCodeMatches(challenge.id, code, challenge.codeDigest)) {
        return json({ error: REJECT_MESSAGE.WRONG_CODE }, 400);
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
    // concurrent verify of the same code can never also flip the marker. The
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
