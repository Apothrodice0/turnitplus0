import type { InStatement } from '@libsql/client';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate, checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser, clearSessionCookie } from '../../../../lib/auth-session';
import { verifyPassword } from '../../../../lib/auth-crypto';
import { deleteAccountData, invalidateSessionsAndDeleteUser, ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '../../../../lib/account-deletion';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../lib/same-origin';
import { resolveSignupIdentity } from '../../../../lib/account-identity-signup';
import {
  readAccountIdentityProfile,
  accountIdentityProfileUpsertStatement,
  deleteAccountIdentityFingerprintStatement,
} from '../../../../lib/account-identity-repo';
import { resolveGeonamesCity } from '../../../../lib/geonames-cities';
import { isoCountryByAlpha2 } from '../../../../lib/iso-3166-1-countries';
import {
  revokeOutstandingEmailVerificationChallengesStatement,
  clearUserEmailVerifiedStatement,
  usersHaveEmailVerifiedAtColumn,
} from '../../../../lib/email-verification';

/**
 * Shape one account's stored identity profile for the OWNER's own settings
 * view. Deliberately narrow: account type, residence, city (resolved name from
 * the bundled dataset), institution ROR id, phone (the owner's own E.164) and
 * phone region. NEVER a fingerprint, an owner-link/SELF signal, a cross-account
 * match, or an email-verification flag — email verification is a property of
 * the login credential (users.email_verified_at), NOT of this profile, and is
 * reported separately as `emailVerification.status`.
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
    phoneVerified: profile.phoneVerifiedAt != null,
    institutionVerified: profile.institutionVerifiedAt != null,
  };
}

/**
 * The email-verification state the account UI needs — a single plain enum from
 * the AUTHORITATIVE users.email_verified_at (never a challenge id, token, or
 * digest). Every account can be verified, so there is no "unavailable" state.
 */
type EmailVerificationStatus = 'verified' | 'unverified';
function emailVerificationStatusFor(userEmailVerifiedAt: number | null): EmailVerificationStatus {
  return userEmailVerifiedAt != null ? 'verified' : 'unverified';
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
    //
    // The identity (profile) read and the email-verification read are FULLY
    // INDEPENDENT: a failure of one must never zero out the other. In
    // particular, when this A3 code is live in an environment where migration
    // 0046 has not yet added users.email_verified_at, the verification read is
    // simply skipped ("unverified") — the profile, and so "Edit information" vs
    // "Complete your identity profile", is unaffected.
    let identity: ReturnType<typeof identityView> | null = null;
    let emailVerificationStatus: EmailVerificationStatus = 'unverified';
    const profileClient = await getReportsDbClient();
    try {
      try {
        const profile = await readAccountIdentityProfile(profileClient, sessionUser.id);
        if (profile) identity = identityView(profile);
      } catch {
        identity = null;
      }

      try {
        if (await usersHaveEmailVerifiedAtColumn(profileClient)) {
          const userRow = await profileClient.execute({ sql: 'SELECT email_verified_at FROM users WHERE id = ?', args: [sessionUser.id] });
          const verifiedAt = (userRow.rows[0] as unknown as { email_verified_at: number | null } | undefined)?.email_verified_at ?? null;
          emailVerificationStatus = emailVerificationStatusFor(verifiedAt);
        }
      } catch {
        emailVerificationStatus = 'unverified';
      }
    } finally {
      profileClient.close();
    }

    return new NextResponse(
      JSON.stringify({
        user: { username: sessionUser.username, email: sessionUser.email, corpusReuseConsent: sessionUser.corpusReuseConsented },
        identity,
        // A3: a plain enum for the account UI's "Verify email / Email verified"
        // state, from users.email_verified_at only. Never a challenge id, token,
        // or digest.
        emailVerification: { status: emailVerificationStatus },
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
    // Product decision: cross-account TurnitPlus corpus checking is
    // mandatory for every authenticated account and carries no account
    // preference — there is no UI control that sends this field any more
    // (see app/page.tsx). Accepted here only for request-shape back-compat
    // with any caller still sending it: validated if present, then
    // completely ignored — it is never written to
    // users.corpus_reuse_consented_at (that column is now a vestigial
    // historical timestamp, see db/schema.ts) and can no longer grant,
    // revoke, or block anything.
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

      // Deploy-ordering safety: the users.email_verified_at column and the
      // email_verification_challenges table both arrive with migration 0046. If
      // 0046 is not applied here, skip every statement that touches them — a
      // plain username/email/profile PATCH must still succeed.
      const emailVerifiedColumnExists = await usersHaveEmailVerifiedAtColumn(client);

      // A3 — changing the login email VOIDS the account's verified-email state
      // (users.email_verified_at -> NULL) and kills every outstanding
      // verification link, and both must land atomically with the users.email
      // UPDATE itself (no window where the address moved but an old link still
      // verifies, or the account still reads "verified"). A3c additionally
      // revokes the now-stale VERIFIED_EMAIL identity fingerprint in the same
      // transaction — a changed email must never leave evidence for an address
      // the account no longer controls; verifying the new address later writes
      // a fresh fingerprint (see the email-verification route). Since every
      // statement here goes into ONE client.batch transaction below, the
      // effects commit together. The revoke/delete are no-ops when there is
      // nothing to revoke/delete. A profile edit that does NOT change the
      // email never runs these — editing your city must not un-verify your
      // email or touch its fingerprint.
      const emailChanged = normalizedEmail !== sessionUser.email;
      const emailChangeStatements: InStatement[] =
        emailChanged && emailVerifiedColumnExists
          ? [
              clearUserEmailVerifiedStatement(sessionUser.id),
              revokeOutstandingEmailVerificationChallengesStatement(sessionUser.id, now),
              deleteAccountIdentityFingerprintStatement(sessionUser.id, 'VERIFIED_EMAIL'),
            ]
          : [];

      // Run one user-facing UPDATE plus whatever profile / email-change
      // statements apply, atomically. A single statement goes through execute();
      // anything more becomes one client.batch transaction.
      const applyAccountWrites = async (userUpdate: InStatement) => {
        const statements = [userUpdate, ...(profileStatement ? [profileStatement] : []), ...emailChangeStatements];
        if (statements.length === 1) await client.execute(statements[0]);
        else await client.batch(statements, 'write');
      };

      try {
        // corpusReuseConsent (if the request body sent it at all) is
        // intentionally never applied to any write — see the validation
        // comment above. Every PATCH takes this one plain path regardless.
        await applyAccountWrites({
          sql: 'UPDATE users SET username = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          args: [trimmedUsername, normalizedEmail, sessionUser.id],
        });
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

      const storedProfile = await readAccountIdentityProfile(client, sessionUser.id);
      let storedVerifiedAt: number | null = null;
      if (emailVerifiedColumnExists) {
        try {
          const verifiedRow = await client.execute({ sql: 'SELECT email_verified_at FROM users WHERE id = ?', args: [sessionUser.id] });
          storedVerifiedAt = (verifiedRow.rows[0] as unknown as { email_verified_at: number | null } | undefined)?.email_verified_at ?? null;
        } catch {
          storedVerifiedAt = null;
        }
      }
      return new NextResponse(
        JSON.stringify({
          // Always true — see the validation comment above.
          user: { username: trimmedUsername, email: normalizedEmail, corpusReuseConsent: true },
          identity: storedProfile ? identityView(storedProfile) : null,
          // A3 — from the authoritative users.email_verified_at, re-read after
          // the write: an email change here cleared it, so this returns
          // 'unverified' in the same response.
          emailVerification: { status: emailVerificationStatusFor(storedVerifiedAt) },
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
