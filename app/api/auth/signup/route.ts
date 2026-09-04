import { randomUUID } from 'node:crypto';
import type { InStatement } from '@libsql/client';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAuthRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { hashPassword } from '../../../../lib/auth-crypto';
import { newSession, setSessionCookie, claimAnonymousReports } from '../../../../lib/auth-session';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../lib/same-origin';
import { resolveSignupIdentity } from '../../../../lib/account-identity-signup';
import { accountIdentityProfileUpsertStatement } from '../../../../lib/account-identity-repo';
import { resolveTrustedVerificationBaseUrl } from '../../../../lib/request-origin';
import {
  generateEmailVerificationChallenge,
  emailVerificationChallengeInsertStatement,
  revokeEmailVerificationChallengeByIdStatement,
  usersHaveEmailVerifiedAtColumn,
} from '../../../../lib/email-verification';
import { dispatchEmailVerificationMessage } from '../../../../lib/email-verification-dispatch';
import { EmailDeliveryUnavailableError } from '../../../../lib/mail/email-delivery';

const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function badRequest(error: string, extra?: Record<string, unknown>) {
  return new NextResponse(JSON.stringify({ error, ...extra }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(request: Request) {
  try {
    // Same-origin guard (defence in depth alongside the SameSite=Lax cookie).
    if (isCrossOriginBrowserRequest(request)) {
      return new NextResponse(JSON.stringify(CROSS_ORIGIN_REJECTED), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const rate = await checkAuthRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return badRequest('Invalid JSON');

    const { email, password, username, deviceKey, remember } = body as Record<string, unknown>;

    if (!isNonEmptyString(email) || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return badRequest('A valid email address is required.');
    }
    if (!isNonEmptyString(password) || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (!isNonEmptyString(username) || username.trim().length < MIN_USERNAME_LENGTH || username.trim().length > MAX_USERNAME_LENGTH) {
      return badRequest(`Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters.`);
    }

    // Structured identity — server-authoritative. The client sends a canonical
    // ISO country code, a canonical GeoNames city id and (when applicable) a
    // canonical ROR id; the server RE-RESOLVES the city and institution and
    // ignores any client-supplied names or verification state. `identity` may
    // be nested or the fields may be sent flat — accept both.
    const identityInput = (body as { identity?: unknown }).identity ?? body;
    const identityResult = await resolveSignupIdentity(identityInput as Record<string, unknown>);
    if (!identityResult.ok) {
      return badRequest('Some of your details could not be verified. Please review the highlighted fields.', {
        fields: identityResult.errors,
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const trimmedUsername = username.trim();

    const client = await getReportsDbClient();
    try {
      const existing = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [normalizedEmail] });
      if (existing.rows.length > 0) {
        return new NextResponse(JSON.stringify({ error: 'An account with this email already exists.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }

      const userId = randomUUID();
      const passwordHash = await hashPassword(password);
      const now = Date.now();
      const session = newSession(userId, now);
      // A3: an email-verification challenge is minted and persisted AS PART OF
      // account creation, so "challenge issued" is guaranteed the moment the
      // account exists. email_verified_at itself stays NULL — only consuming
      // this challenge (POST /api/auth/email-verification/verify) ever sets it.
      // The raw token never leaves this handler except to the mail layer below.
      //
      // Deploy-ordering safety: the challenge table (and users.email_verified_at)
      // arrive with migration 0046. If this A3 code is live before 0046 is
      // applied, the challenge INSERT is simply omitted from the batch — account
      // creation must NEVER fail because email verification is not yet wired.
      // The account can request verification later once 0046 lands.
      const verificationChallenge = generateEmailVerificationChallenge(now);
      const emailVerificationReady = await usersHaveEmailVerifiedAtColumn(client);

      // ATOMIC account creation: the users row, the 1:1 account_identity_profiles
      // row, the email-verification challenge (when 0046 is applied) and the
      // session are one write transaction. If the profile INSERT fails any CHECK
      // (or the email UNIQUE index races), the whole batch rolls back — no users
      // row, no profile row, no challenge, no session. NOTHING promotes the
      // account: there is no admin-promotion call here (or anywhere in the auth
      // routes) any more — a brand-new unverified account can never gain the
      // admin role from its email string, and verifying that email later does
      // not change this (see lib/admin-role.ts).
      const statements: InStatement[] = [
        {
          sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
          args: [userId, normalizedEmail, trimmedUsername, passwordHash],
        },
        accountIdentityProfileUpsertStatement(userId, identityResult.identity.normalized, now),
        ...(emailVerificationReady
          ? [emailVerificationChallengeInsertStatement(verificationChallenge, userId, normalizedEmail)]
          : []),
        session.statement,
      ];

      try {
        await client.batch(statements, 'write');
      } catch (batchErr) {
        const message = batchErr instanceof Error ? batchErr.message : String(batchErr);
        if (/UNIQUE constraint failed: users\.email/i.test(message)) {
          return new NextResponse(JSON.stringify({ error: 'An account with this email already exists.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
        // A profile CHECK failure or any other write error: nothing was
        // persisted (batch is all-or-nothing). Do not leak the raw message.
        console.error('signup atomic write failed:', message.replace(/\b\+?\d[\d\s().-]{6,}\b/g, '[phone]'));
        return badRequest('Some of your details could not be verified. Please review the highlighted fields.');
      }

      // Best-effort, post-commit — a data migration, not part of account creation.
      await claimAnonymousReports(client, userId, deviceKey);

      // Request the verification email (A3). Best-effort and post-commit: the
      // account already exists, so nothing here can fail signup — but the
      // DELIVERY INVARIANT is strict. The challenge stays ACTIVE only when ALL of
      //   (a) migration 0046 is applied (a challenge was actually persisted),
      //   (b) a trusted verification base URL resolved, AND
      //   (c) the provider accepted delivery.
      // Any other outcome (0046 not applied, untrusted/unresolvable host, or the
      // provider throwing) revokes THIS exact challenge by its id — never a
      // broad revoke that could catch a concurrently-issued resend — so no dead
      // or undeliverable link is ever left live. The raw token / URL are never
      // logged (and never appear in the signup response).
      const verificationBaseUrl = resolveTrustedVerificationBaseUrl(request);
      let verificationDelivered = false;
      if (emailVerificationReady && verificationBaseUrl) {
        try {
          await dispatchEmailVerificationMessage(verificationChallenge, normalizedEmail, verificationBaseUrl);
          verificationDelivered = true;
        } catch (sendErr) {
          // In A3 there is no provider, so EmailDeliveryUnavailableError is the
          // EXPECTED baseline — not worth a log line on every signup. Anything
          // else (a real provider failing, once one is wired) is surfaced.
          if (!(sendErr instanceof EmailDeliveryUnavailableError)) {
            console.error('signup email verification dispatch failed (non-fatal): delivery error');
          }
        }
      } else if (emailVerificationReady && !verificationBaseUrl) {
        // Untrusted / ambiguous request host — do NOT mint a token-bearing URL.
        console.error('signup: request host not trusted; verification email not dispatched');
      }
      if (emailVerificationReady && !verificationDelivered) {
        await client
          .execute(revokeEmailVerificationChallengeByIdStatement(verificationChallenge.id, Date.now()))
          .catch(() => {});
      }

      const { display } = identityResult.identity;
      const response = new NextResponse(
        JSON.stringify({
          user: { username: trimmedUsername, email: normalizedEmail, corpusReuseConsent: false },
          identity: {
            accountType: display.accountType,
            countryCode: display.countryCode,
            countryName: display.countryName,
            city: { geonamesId: display.city.geonamesId, name: display.city.name, countryName: display.city.countryName },
            institution:
              display.institution.status === 'ROR'
                ? { status: 'ROR', rorId: display.institution.rorId, name: display.institution.name, countryName: display.institution.countryName }
                : { status: 'NONE' },
            phoneRegion: display.phoneRegion,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
      setSessionCookie(response, session.token, remember === true);
      return response;
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('signup failed:', err instanceof Error ? err.message : String(err));
    return new NextResponse(JSON.stringify({ error: 'Something went wrong. Please try again.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
