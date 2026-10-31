import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkPasswordResetConfirmRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../../lib/same-origin';
import { clearSessionCookie } from '../../../../../lib/auth-session';
import { hashPassword } from '../../../../../lib/auth-crypto';
import {
  classifyPasswordResetToken,
  isWellFormedPasswordResetToken,
  passwordResetTableExists,
  passwordResetTokenDigest,
  redeemPasswordResetStatements,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_MESSAGES,
} from '../../../../../lib/password-reset';

const MAX_WRITE_RETRIES = 4;
const isSqliteBusy = (err: unknown) => err instanceof Error && /SQLITE_BUSY/i.test(err.message);

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

/**
 * Redeem a reset link: { token, password } sets a new password; { token, checkOnly: true } only reports whether the link
 * is still usable (so the page can say "expired" before the customer types a new password). No session is needed or
 * created: after a reset EVERY session of the account is revoked (this browser's cookie is cleared too) and the
 * customer signs in with the new password. The raw token is never logged.
 */
export async function POST(request: Request) {
  try {
    if (isCrossOriginBrowserRequest(request)) return json(CROSS_ORIGIN_REJECTED, 403);

    const rate = await checkPasswordResetConfirmRate(clientIpFrom(request));
    if (!rate.allowed) return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });

    const body = (await request.json().catch(() => null)) as { token?: unknown; password?: unknown; checkOnly?: unknown } | null;
    const token = body?.token;
    if (!isWellFormedPasswordResetToken(token)) return json({ status: 'INVALID', error: PASSWORD_RESET_MESSAGES.INVALID }, 400);
    const checkOnly = body?.checkOnly === true;
    const password = body?.password;
    if (!checkOnly && (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)) {
      return json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` }, 400);
    }

    const digest = passwordResetTokenDigest(token);
    const readClient = await getReportsDbClient();
    try {
      if (!(await passwordResetTableExists(readClient))) {
        return json({ status: 'unavailable', error: PASSWORD_RESET_MESSAGES.unavailable }, 503);
      }
      const state = await classifyPasswordResetToken(readClient, digest);
      if (state !== 'VALID') return json({ status: state, error: PASSWORD_RESET_MESSAGES[state] }, 400);
      if (checkOnly) return json({ status: 'VALID' }, 200);
    } finally {
      readClient.close();
    }

    const newPasswordHash = await hashPassword(password as string);
    const redemptionId = randomUUID();
    let won = false;
    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const writeClient = await getReportsDbClient();
      try {
        const results = await writeClient.batch(redeemPasswordResetStatements(digest, newPasswordHash, redemptionId, Date.now()), 'write');
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
      const response = json({ status: 'reset', message: PASSWORD_RESET_MESSAGES.reset }, 200);
      clearSessionCookie(response);
      return response;
    }
    // Lost a concurrent redemption, or the link changed state between the check and the write.
    const finalClient = await getReportsDbClient();
    try {
      const state = await classifyPasswordResetToken(finalClient, digest);
      const reason = state === 'VALID' ? 'USED' : state;
      return json({ status: reason, error: PASSWORD_RESET_MESSAGES[reason] }, 400);
    } finally {
      finalClient.close();
    }
  } catch (err) {
    console.error('password reset confirm failed:', err instanceof Error ? err.name : 'unknown');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
