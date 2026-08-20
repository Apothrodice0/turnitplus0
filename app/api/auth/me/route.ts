import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate, checkAuthRate } from '../../../../lib/rate-limit';
import { getSessionUser, clearSessionCookie } from '../../../../lib/auth-session';
import { verifyPassword } from '../../../../lib/auth-crypto';
import { deleteAccountData, invalidateSessionsAndDeleteUser, ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '../../../../lib/account-deletion';

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
    const rate = await checkRate(clientIpFrom(request));
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

// Account deletion (production audit fix — no such endpoint existed before
// this). checkAuthRate (the stricter, 5/min bucket), not checkRate: this
// endpoint verifies a password like login/signup do, making it the same
// class of brute-force/enumeration target — see lib/rate-limit.ts's own
// comment on why those two get the tighter limit.
export async function DELETE(request: Request) {
  try {
    const rate = await checkAuthRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { password, confirm } = body as Record<string, unknown>;

    // Explicit confirmation, checked server-side regardless of what the UI
    // already enforced — a second, deliberate signal alongside the password
    // itself (see lib/account-deletion.ts's own comment on why this exists
    // as a literal phrase rather than a bare boolean, which a buggy client
    // could send unintentionally as `true`).
    if (confirm !== ACCOUNT_DELETION_CONFIRMATION_PHRASE) {
      return new NextResponse(JSON.stringify({ error: `Confirmation phrase must be exactly "${ACCOUNT_DELETION_CONFIRMATION_PHRASE}".` }), { status: 400 });
    }
    if (!isNonEmptyString(password)) {
      return new NextResponse(JSON.stringify({ error: 'Password is required.' }), { status: 400 });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return new NextResponse(JSON.stringify({ error: 'Not signed in.' }), { status: 401 });
      }

      // Password re-entry: every account in this product is password-
      // authenticated today (no OAuth/SSO exists), so this check always
      // applies. Re-fetched here rather than trusted from the session,
      // exactly like login's own verifyPassword call — SessionUser never
      // carries password_hash.
      const userRow = await client.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [sessionUser.id] });
      const passwordHash = (userRow.rows[0] as unknown as { password_hash: string } | undefined)?.password_hash;
      if (!passwordHash || !(await verifyPassword(password, passwordHash))) {
        return new NextResponse(JSON.stringify({ error: 'Incorrect password.' }), { status: 401 });
      }

      // Dependent cleanup first (this user's own reports + document
      // identity/shingle/family/corpus data, preserving anything still
      // referenced by another account — see lib/account-deletion.ts's own
      // header comment), THEN the account itself, only once that succeeds.
      // Both steps are independently safe to retry (see that file's own
      // comment) — a request that fails partway and is retried with the
      // same still-valid session simply resumes and completes.
      await deleteAccountData(client, sessionUser.id);
      await invalidateSessionsAndDeleteUser(client, sessionUser.id);

      // Deliberately just {ok:true} — no counts, no per-item results. This
      // account's own data is gone either way; returning e.g. "N documents
      // were kept because another account still references them" would leak
      // a cross-account signal (see this route's own requirement docs).
      const response = new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      clearSessionCookie(response);
      return response;
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
