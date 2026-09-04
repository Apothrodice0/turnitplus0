import type { InStatement } from '@libsql/client';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate, checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser, clearSessionCookie } from '../../../../lib/auth-session';
import { verifyPassword } from '../../../../lib/auth-crypto';
import { deleteAccountData, invalidateSessionsAndDeleteUser, ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '../../../../lib/account-deletion';
import { revokeConsentAndCancelPendingAdmissionJobs } from '../../../../lib/corpus-admission-report-integration';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../lib/same-origin';
import { resolveSignupIdentity } from '../../../../lib/account-identity-signup';
import { readAccountIdentityProfile, accountIdentityProfileUpsertStatement } from '../../../../lib/account-identity-repo';
import { resolveGeonamesCity } from '../../../../lib/geonames-cities';
import { isoCountryByAlpha2 } from '../../../../lib/iso-3166-1-countries';

/**
 * Shape one account's stored identity profile for the OWNER's own settings
 * view. Deliberately narrow: account type, residence, city (resolved name from
 * the bundled dataset), institution ROR id, phone (the owner's own E.164) and
 * phone region. NEVER a fingerprint, an owner-link/SELF signal, a cross-account
 * match, or a verification flag beyond the plain "unverified" resting state.
 */
type ProfileRow = Awaited<ReturnType<typeof readAccountIdentityProfile>>;
function identityView(profile: NonNullable<ProfileRow>) {
  const city = profile.cityGeonamesId != null ? resolveGeonamesCity(profile.cityGeonamesId) : null;
  return {
    accountType: profile.accountType,
    fullName: profile.fullName,
    countryCode: profile.countryCode,
    countryName: profile.countryCode ? isoCountryByAlpha2(profile.countryCode)?.name ?? null : null,
    city: city
      ? { geonamesId: city.geonamesId, name: city.name, countryCode: city.countryCode }
      : profile.cityGeonamesId != null
        ? { geonamesId: profile.cityGeonamesId, name: null, countryCode: null }
        : null,
    institution:
      profile.institutionStatus === 'ROR'
        ? { status: 'ROR' as const, rorId: profile.institutionRorId }
        : { status: 'NONE' as const },
    phoneE164: profile.phoneE164,
    phoneRegion: profile.phoneRegion,
    emailVerified: profile.emailVerifiedAt != null,
    phoneVerified: profile.phoneVerifiedAt != null,
    institutionVerified: profile.institutionVerifiedAt != null,
  };
}

export const dynamic = 'force-dynamic';

const MAX_EMAIL_LENGTH = 254;
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

    // Grandfathering: an account created before A2 has no identity profile.
    // identity: null just means "profile not completed" — it never blocks login
    // or anything else.
    let identity: ReturnType<typeof identityView> | null = null;
    const profileClient = await getReportsDbClient();
    try {
      const profile = await readAccountIdentityProfile(profileClient, sessionUser.id);
      if (profile) identity = identityView(profile);
    } catch {
      identity = null;
    } finally {
      profileClient.close();
    }

    return new NextResponse(
      JSON.stringify({
        user: { username: sessionUser.username, email: sessionUser.email, corpusReuseConsent: sessionUser.corpusReuseConsented },
        identity,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    // Same-origin guard (defence in depth alongside SameSite=Lax) — this route
    // changes the account's identity fields.
    if (isCrossOriginBrowserRequest(request)) {
      return new NextResponse(JSON.stringify(CROSS_ORIGIN_REJECTED), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

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

    // Identity profile edit (A2). Present only when the settings form submits the
    // full identity object; a plain username/email/consent PATCH omits it and an
    // account with no profile (grandfathered) is unaffected. Same server-
    // authoritative validation as signup: canonical country, RE-RESOLVED
    // GeoNames city (name never trusted), RE-RESOLVED ROR institution,
    // libphonenumber-js phone, everything UNVERIFIED, no fingerprints. Validated
    // BEFORE any write — a failure returns 400 and changes nothing.
    const rawIdentity = (body as { identity?: unknown }).identity;
    const identityResult = rawIdentity != null ? await resolveSignupIdentity(rawIdentity as Record<string, unknown>) : null;
    if (identityResult && !identityResult.ok) {
      return new NextResponse(
        JSON.stringify({ error: 'Some of your details could not be verified. Please review the highlighted fields.', fields: identityResult.errors }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
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

      const now = Date.now();
      const profileStatement: InStatement | null =
        identityResult && identityResult.ok
          ? accountIdentityProfileUpsertStatement(sessionUser.id, identityResult.identity.normalized, now)
          : null;

      try {
      if (corpusReuseConsent !== undefined) {
        // Corpus-admission consent revocation (production audit fix):
        // synchronous, in this same request — not deferred, for the same
        // durability reason app/api/reports/route.ts's job creation is not
        // deferred (see lib/corpus-admission-report-integration.ts's own
        // header comment). Only fires on an actual true->false transition;
        // granting consent, or a no-op PATCH that leaves it unchanged, never
        // triggers this and takes the plain single-statement path below.
        //
        // On a real revocation, the profile-fields UPDATE deliberately does
        // NOT touch corpus_reuse_consented_at at all — that write happens
        // atomically, together with cancelling this account's still-
        // pending/failed admission jobs, inside
        // revokeConsentAndCancelPendingAdmissionJobs's own transaction, so
        // there is never a window where consent has been flipped but
        // cancellation has not (or vice versa). Already-accepted corpus
        // content is untouched either way — see that function's own header
        // comment.
        if (corpusReuseConsent === false && sessionUser.corpusReuseConsented === true) {
          await client.execute({
            sql: 'UPDATE users SET username = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            args: [trimmedUsername, normalizedEmail, sessionUser.id],
          });
          if (profileStatement) await client.execute(profileStatement);
          await revokeConsentAndCancelPendingAdmissionJobs(sessionUser.id, () => getReportsDbClient());
        } else {
          const userUpdate: InStatement = {
            sql: 'UPDATE users SET username = ?, email = ?, corpus_reuse_consented_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            args: [trimmedUsername, normalizedEmail, corpusReuseConsent ? new Date().toISOString() : null, sessionUser.id],
          };
          if (profileStatement) await client.batch([userUpdate, profileStatement], 'write');
          else await client.execute(userUpdate);
        }
      } else {
        const userUpdate: InStatement = {
          sql: 'UPDATE users SET username = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          args: [trimmedUsername, normalizedEmail, sessionUser.id],
        };
        if (profileStatement) await client.batch([userUpdate, profileStatement], 'write');
        else await client.execute(userUpdate);
      }
      } catch (writeErr) {
        const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
        if (/UNIQUE constraint failed: users\.email/i.test(message)) {
          return new NextResponse(JSON.stringify({ error: 'An account with this email already exists.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
        // A profile CHECK failure or other write error — the batch rolled back.
        return new NextResponse(
          JSON.stringify({ error: 'Some of your details could not be verified. Please review the highlighted fields.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const resolvedConsent = corpusReuseConsent !== undefined ? corpusReuseConsent : sessionUser.corpusReuseConsented;
      const storedProfile = await readAccountIdentityProfile(client, sessionUser.id);
      return new NextResponse(
        JSON.stringify({
          user: { username: trimmedUsername, email: normalizedEmail, corpusReuseConsent: resolvedConsent },
          identity: storedProfile ? identityView(storedProfile) : null,
        }),
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
