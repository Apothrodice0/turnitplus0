import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { verifyPassword, verifyAgainstDummy } from '../../../../lib/auth-crypto';
import { createSession, setSessionCookie, claimAnonymousReports } from '../../../../lib/auth-session';

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200;
const GENERIC_ERROR = 'Invalid email or password.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function POST(request: Request) {
  try {
    const rate = checkAuthRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { email, password, deviceKey, remember } = body as Record<string, unknown>;

    if (!isNonEmptyString(email) || email.length > MAX_EMAIL_LENGTH || !isNonEmptyString(password) || password.length > MAX_PASSWORD_LENGTH) {
      return new NextResponse(JSON.stringify({ error: GENERIC_ERROR }), { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const client = await getReportsDbClient();
    try {
      const result = await client.execute({ sql: 'SELECT id, username, password_hash FROM users WHERE email = ?', args: [normalizedEmail] });
      const row = result.rows[0] as unknown as { id: string; username: string; password_hash: string } | undefined;

      if (!row) {
        // Run a dummy derivation so response timing doesn't reveal whether
        // this email exists, then return the exact same error/status as a
        // wrong-password mismatch below.
        await verifyAgainstDummy(password);
        return new NextResponse(JSON.stringify({ error: GENERIC_ERROR }), { status: 401 });
      }

      const passwordMatches = await verifyPassword(password, row.password_hash);
      if (!passwordMatches) {
        return new NextResponse(JSON.stringify({ error: GENERIC_ERROR }), { status: 401 });
      }

      await claimAnonymousReports(client, row.id, deviceKey);

      const token = await createSession(client, row.id);
      const response = new NextResponse(
        JSON.stringify({ user: { username: row.username, email: normalizedEmail } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
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
