import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkPasswordResetEmailRate, checkPasswordResetRequestRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../../lib/same-origin';
import { resolveTrustedAppBaseUrl } from '../../../../../lib/trusted-app-origin';
import { getEmailDeliveryProvider, isEmailDeliveryConfigured } from '../../../../../lib/mail/email-delivery';
import {
  countRecentPasswordResetTokens,
  generatePasswordResetToken,
  issuePasswordResetTokenStatements,
  passwordResetTableExists,
  PASSWORD_RESET_MAX_PER_WINDOW,
  PASSWORD_RESET_MESSAGES,
  revokePasswordResetTokenByIdStatement,
} from '../../../../../lib/password-reset';

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

/**
 * Request a password-reset link for an email address. No session. The answer is the SAME for an address with an account
 * and one without (status "requested", the same neutral message, the same rate limits), so this route cannot be used to
 * learn whether an account exists. It answers "unavailable" (503) for everyone, without touching any account, when the
 * link cannot be delivered at all: no email provider configured, an untrusted host for the link, or migration 0054 not
 * applied — never a false "sent". A delivery failure for one real account revokes that link and still answers
 * "requested" (answering differently would reveal the account); it is logged without the address or the link.
 */
export async function POST(request: Request) {
  try {
    if (isCrossOriginBrowserRequest(request)) return json(CROSS_ORIGIN_REJECTED, 403);

    const rate = await checkPasswordResetRequestRate(clientIpFrom(request));
    if (!rate.allowed) return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });

    const body = await request.json().catch(() => null);
    const rawEmail = body && typeof body === 'object' ? (body as { email?: unknown }).email : undefined;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return json({ error: 'Enter the email address you use to sign in.' }, 400);
    }

    const emailRate = await checkPasswordResetEmailRate(createHash('sha256').update(email, 'utf8').digest('hex'));
    if (!emailRate.allowed) return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(emailRate.retryAfter) });

    const baseUrl = resolveTrustedAppBaseUrl(request);
    if (!baseUrl || !isEmailDeliveryConfigured()) {
      return json({ status: 'unavailable', error: PASSWORD_RESET_MESSAGES.unavailable }, 503);
    }

    const client = await getReportsDbClient();
    try {
      if (!(await passwordResetTableExists(client))) {
        return json({ status: 'unavailable', error: PASSWORD_RESET_MESSAGES.unavailable }, 503);
      }
      const user = (await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0] as unknown as { id: string } | undefined;
      if (user && (await countRecentPasswordResetTokens(client, user.id)) < PASSWORD_RESET_MAX_PER_WINDOW) {
        const token = generatePasswordResetToken();
        await client.batch(issuePasswordResetTokenStatements(user.id, token), 'write');
        try {
          await getEmailDeliveryProvider().sendPasswordReset({
            to: email,
            resetUrl: `${baseUrl}/reset-password#token=${token.rawToken}`,
            expiresAt: token.expiresAt,
          });
        } catch {
          await client.execute(revokePasswordResetTokenByIdStatement(token.id));
          console.error('password reset: email could not be delivered; the link was revoked');
        }
      }
      return json({ status: 'requested', message: PASSWORD_RESET_MESSAGES.requested }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('password reset request failed:', err instanceof Error ? err.name : 'unknown');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
