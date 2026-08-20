import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';

export const dynamic = 'force-dynamic';

const MAX_EMAIL_LENGTH = 254;
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

// A missing/invalid/expired session is a normal "signed out" state, not an
// error — the client polls this at mount to hydrate the account UI.
export async function GET(request: Request) {
  try {
    const client = await getReportsDbClient();
    let sessionUser;
    try {
      sessionUser = await getSessionUser(request, client);
    } finally {
      client.close();
    }

    if (!sessionUser) {
      return new NextResponse(JSON.stringify({ user: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new NextResponse(
      JSON.stringify({ user: { username: sessionUser.username, email: sessionUser.email, corpusReuseConsent: sessionUser.corpusReuseConsented } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { username, email, corpusReuseConsent } = body as Record<string, unknown>;

    if (!isNonEmptyString(username) || username.trim().length < MIN_USERNAME_LENGTH || username.trim().length > MAX_USERNAME_LENGTH) {
      return new NextResponse(JSON.stringify({ error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters.` }), { status: 400 });
    }
    if (!isNonEmptyString(email) || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return new NextResponse(JSON.stringify({ error: 'A valid email address is required.' }), { status: 400 });
    }
    // Privacy hardening: optional — omitting the field leaves existing
    // consent state untouched (a plain profile-only update never silently
    // revokes or grants it). When present it must be a real boolean; this
    // is the only place users.corpus_reuse_consented_at is ever written.
    if (corpusReuseConsent !== undefined && typeof corpusReuseConsent !== 'boolean') {
      return new NextResponse(JSON.stringify({ error: 'corpusReuseConsent must be a boolean.' }), { status: 400 });
    }

    const trimmedUsername = username.trim();
    const normalizedEmail = email.trim().toLowerCase();

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return new NextResponse(JSON.stringify({ error: 'Not signed in.' }), { status: 401 });
      }

      if (normalizedEmail !== sessionUser.email) {
        const existing = await client.execute({ sql: 'SELECT id FROM users WHERE email = ? AND id != ?', args: [normalizedEmail, sessionUser.id] });
        if (existing.rows.length > 0) {
          return new NextResponse(JSON.stringify({ error: 'An account with this email already exists.' }), { status: 409 });
        }
      }

      if (corpusReuseConsent !== undefined) {
        await client.execute({
          sql: 'UPDATE users SET username = ?, email = ?, corpus_reuse_consented_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          args: [trimmedUsername, normalizedEmail, corpusReuseConsent ? new Date().toISOString() : null, sessionUser.id],
        });
      } else {
        await client.execute({
          sql: 'UPDATE users SET username = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          args: [trimmedUsername, normalizedEmail, sessionUser.id],
        });
      }

      const resolvedConsent = corpusReuseConsent !== undefined ? corpusReuseConsent : sessionUser.corpusReuseConsented;
      return new NextResponse(
        JSON.stringify({ user: { username: trimmedUsername, email: normalizedEmail, corpusReuseConsent: resolvedConsent } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
