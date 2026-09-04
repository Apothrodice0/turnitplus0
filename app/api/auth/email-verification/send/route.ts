import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkEmailVerificationRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getSessionUser } from '../../../../../lib/auth-session';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../../lib/same-origin';
import { resolveTrustedVerificationBaseUrl } from '../../../../../lib/request-origin';
import {
  generateEmailVerificationChallenge,
  emailVerificationChallengeInsertStatement,
  revokeOutstandingEmailVerificationChallengesStatement,
  revokeEmailVerificationChallengeByIdStatement,
  mostRecentEmailVerificationChallenge,
  countEmailVerificationChallengesSince,
  pruneExpiredEmailVerificationChallenges,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_ISSUANCE_WINDOW_MS,
  EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW,
} from '../../../../../lib/email-verification';
import { dispatchEmailVerificationMessage } from '../../../../../lib/email-verification-dispatch';
import { EmailDeliveryUnavailableError } from '../../../../../lib/mail/email-delivery';

export const dynamic = 'force-dynamic';

const STALE_CHALLENGE_MS = 24 * 60 * 60 * 1000;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * A3 — issue (or re-issue) an email-verification challenge for the CURRENTLY
 * SIGNED-IN account and hand it to the mail-delivery layer.
 *
 * There is deliberately NO email parameter: the challenge is always for the
 * session account's own current users.email, so this route has no
 * arbitrary-address surface and cannot be used to probe whether some other
 * address has an account.
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

    // The verification link's host must be one we explicitly trust — refuse to
    // mint a token-bearing URL for a spoofed Host / X-Forwarded-Host rather
    // than send it. Checked up front so nothing is issued when we can't
    // deliver a safe link.
    const baseUrl = resolveTrustedVerificationBaseUrl(request);
    if (!baseUrl) {
      console.error('email verification send: request host is not trusted; no verification URL minted');
      return json(
        { status: 'delivery_failed', error: 'We could not send the verification email right now. Please try again shortly.' },
        503,
      );
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return json({ error: 'Not signed in.' }, 401);
      }

      // Authoritative verified state: users.email_verified_at (works for EVERY
      // account, including grandfathered profile-less ones). The deprecated
      // account_identity_profiles.email_verified_at is never consulted.
      const userRow = await client.execute({
        sql: 'SELECT email_verified_at FROM users WHERE id = ?',
        args: [sessionUser.id],
      });
      if (userRow.rows.length === 0) {
        return json({ error: 'Not signed in.' }, 401);
      }
      if ((userRow.rows[0] as unknown as { email_verified_at: number | null }).email_verified_at != null) {
        return json({ status: 'verified' }, 200);
      }

      const now = Date.now();

      // Resend cooldown — measured against THIS account's own most recent
      // challenge, so it can't be used to probe other accounts.
      const recent = await mostRecentEmailVerificationChallenge(client, sessionUser.id);
      if (recent && now - recent.createdAt < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) {
        const retryAfter = Math.ceil((EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - (now - recent.createdAt)) / 1000);
        return json(
          { status: 'cooldown', error: 'Please wait a moment before requesting another verification email.' },
          429,
          { 'Retry-After': String(Math.max(retryAfter, 1)) },
        );
      }

      // Bounded issuance per rolling window (ceiling on top of the cooldown).
      const issuedInWindow = await countEmailVerificationChallengesSince(
        client,
        sessionUser.id,
        now - EMAIL_VERIFICATION_ISSUANCE_WINDOW_MS,
      );
      if (issuedInWindow >= EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW) {
        return json(
          { status: 'cooldown', error: 'Too many verification emails requested. Please try again later.' },
          429,
          { 'Retry-After': String(Math.ceil(EMAIL_VERIFICATION_ISSUANCE_WINDOW_MS / 1000)) },
        );
      }

      // Issue: revoke every prior outstanding challenge and insert the new one
      // in ONE transaction, so only the latest link is ever live.
      const challenge = generateEmailVerificationChallenge(now);
      await client.batch(
        [
          revokeOutstandingEmailVerificationChallengesStatement(sessionUser.id, now),
          emailVerificationChallengeInsertStatement(challenge, sessionUser.id, sessionUser.email),
        ],
        'write',
      );

      void pruneExpiredEmailVerificationChallenges(client, now - STALE_CHALLENGE_MS).catch(() => {});

      try {
        await dispatchEmailVerificationMessage(challenge, sessionUser.email, baseUrl);
      } catch (deliveryErr) {
        // The row exists but no message went out. Revoke THIS exact challenge
        // (by id, not a broad per-account revoke that could catch a concurrent
        // resend) so the account is not left holding a live-but-undelivered
        // link, and return a GENERIC "try later" — never surface "no provider
        // configured" to the client, and never log the URL/token.
        await client
          .execute(revokeEmailVerificationChallengeByIdStatement(challenge.id, Date.now()))
          .catch(() => {});
        // In A3 "no provider configured" is the expected baseline (the caller
        // already gets a clear 503). Only a genuine provider failure — once one
        // is wired — is worth logging here.
        if (!(deliveryErr instanceof EmailDeliveryUnavailableError)) {
          console.error('email verification send failed: delivery error');
        }
        return json(
          { status: 'delivery_failed', error: 'We could not send the verification email right now. Please try again shortly.' },
          503,
        );
      }

      return json({ status: 'sent' }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('email verification send error:', err instanceof Error ? err.message : String(err));
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
