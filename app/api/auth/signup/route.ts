import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { hashPassword } from '../../../../lib/auth-crypto';
import { createSession, setSessionCookie, claimAnonymousReports } from '../../../../lib/auth-session';
import { maybePromoteToAdmin } from '../../../../lib/admin-role';

const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const rate = await checkAuthRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { email, password, username, deviceKey, remember } = body as Record<string, unknown>;

    if (!isNonEmptyString(email) || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return new NextResponse(JSON.stringify({ error: 'A valid email address is required.' }), { status: 400 });
    }
    if (!isNonEmptyString(password) || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return new NextResponse(JSON.stringify({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }), { status: 400 });
    }
    if (!isNonEmptyString(username) || username.trim().length < MIN_USERNAME_LENGTH || username.trim().length > MAX_USERNAME_LENGTH) {
      return new NextResponse(JSON.stringify({ error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters.` }), { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const trimmedUsername = username.trim();

    const client = await getReportsDbClient();
    try {
      const existing = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [normalizedEmail] });
      if (existing.rows.length > 0) {
        return new NextResponse(JSON.stringify({ error: 'An account with this email already exists.' }), { status: 409 });
      }

      const userId = randomUUID();
      const passwordHash = await hashPassword(password);
      await client.execute({
        sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
        args: [userId, normalizedEmail, trimmedUsername, passwordHash],
      });

      await claimAnonymousReports(client, userId, deviceKey);
      await maybePromoteToAdmin(client, userId, normalizedEmail);

      const token = await createSession(client, userId);
      // corpusReuseConsent is always false for a brand-new account — the
      // column this reflects (users.corpus_reuse_consented_at) has no
      // default other than NULL, and there is no signup-time consent input.
      const response = new NextResponse(
        JSON.stringify({ user: { username: trimmedUsername, email: normalizedEmail, corpusReuseConsent: false } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
      setSessionCookie(response, token, remember === true);
      return response;
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
