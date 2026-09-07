import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import * as sendRoute from '../app/api/auth/email-verification/send/route.ts';
import * as verifyRoute from '../app/api/auth/email-verification/verify/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetEmailVerificationRateForTest, resetEmailVerificationAttemptRateForTest } from '../lib/rate-limit.js';
import { __setEmailDeliveryProviderForTest } from '../lib/mail/email-delivery.ts';
import {
  hashEmailVerificationCode,
  revokeEmailVerificationChallengeByIdStatement,
  upsertVerifiedEmailFingerprintIfChallengeConsumedStatement,
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW,
} from '../lib/email-verification.ts';
import { accountIdentityFingerprint, ACCOUNT_IDENTITY_HMAC_KEY_ENV, ACCOUNT_IDENTITY_KEY_VERSION } from '../lib/account-identity.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * A3 / A3b / A3c — email-verification challenge system.
 *
 * A3b adapted the challenge from a 256-bit link token to a 6-digit numeric
 * code (see lib/email-verification.ts's own header comment for why the
 * digest and lookup strategy both had to change with it — in short: a code
 * has too little entropy to be its own bearer credential, so
 * POST .../verify now REQUIRES A SESSION and only ever looks up the CALLER's
 * own current challenge, never a global digest lookup).
 *
 * Authoritative verified state is users.email_verified_at (works for EVERY
 * account, profile or not). account_identity_profiles.email_verified_at is
 * deprecated/vestigial and is asserted to stay NULL.
 *
 * A3c: a winning verify additionally upserts a VERIFIED_EMAIL row in
 * account_identity_fingerprints, atomically with the challenge consume and
 * the users.email_verified_at write (see lib/email-verification.ts's
 * upsertVerifiedEmailFingerprintIfChallengeConsumedStatement). This file pins
 * that the fingerprint is exactly what lib/account-identity.ts's
 * accountIdentityFingerprint('VERIFIED_EMAIL', ...) would independently
 * compute, that it is ACCOUNT_IDENTITY_HMAC_KEY-gated fail-closed (a missing
 * key must leave verification wholly unattempted, not partially applied),
 * and that email-change removes it atomically with clearing
 * users.email_verified_at.
 *
 * The mail provider is a fake injected here; NO real mail is ever sent, and
 * the default provider's fail-closed behaviour is proven in a dedicated case.
 * lib/mail/resend-email-provider.ts itself is covered by
 * tests/mail-resend-provider.test.mjs, not here.
 *
 * REMOVED (A3b): the "HOSTILE HOST" / trusted-Vercel-host tests that used to
 * live in this file. They protected a token-bearing URL from being minted
 * for a spoofed Host header — with a 6-digit code there is no URL and no
 * bearer credential in the message at all, so lib/request-origin.ts and its
 * host-trust gate were deleted outright (see the send/signup routes, which
 * no longer resolve or depend on a base URL).
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_email_verification.db');
for (const suffix of ['', '-wal', '-shm']) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = 'a3-admin@example.com';
// Test-only HMAC key so emailVerificationCodeSecretConfigured() (and every
// route gated on it) is exercised end-to-end. A dedicated "unset" test below
// removes it for exactly one case, then restores it.
process.env.EMAIL_VERIFICATION_CODE_SECRET = 'test-only-email-verification-code-secret';
// A3c — test-only identity root key so verifiedEmailFingerprintForChallenge
// (and every verify call gated on it) is exercised end-to-end. A dedicated
// "unset" test below removes it for exactly one case, then restores it.
// Deliberately a DIFFERENT string from EMAIL_VERIFICATION_CODE_SECRET above —
// the two must never be conflated.
process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = 'test-only-account-identity-hmac-key';
// Belt-and-braces: make sure a real Resend provider never activates in this
// file — every test here injects a fake provider explicitly, and provider
// selection must stay deterministic regardless of the host machine's shell.
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_VERIFICATION_FROM_ADDRESS;

const setup = createClient({ url: `file:${dbFile}` });
await setup.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(setup, drizzleDir);

// ---- fake mail provider ----------------------------------------------
const sentMessages = [];
const fakeProvider = {
  async sendEmailVerification(message) {
    sentMessages.push(message);
  },
};
__setEmailDeliveryProviderForTest(fakeProvider);
function codeFromLastMessage() {
  return sentMessages.at(-1)?.code ?? null;
}

// ---- helpers --------------------------------------------------------
let ipSeq = 0;
const nextIp = (label) => `ev-${label}-${++ipSeq}`;
const cookieOf = (res) => {
  const raw = res.headers.get('set-cookie');
  const m = raw && raw.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
};

async function signup(
  email,
  { username = 'evuser', password = 'correct-horse-1', url = 'http://localhost/api/auth/signup', extraHeaders = {} } = {},
) {
  const ip = nextIp('signup');
  await resetAuthRateForTest(ip);
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...extraHeaders },
    body: JSON.stringify(withTestIdentity({ email, password, username, deviceKey: `dk-${ip}` })),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: cookieOf(res) };
}

async function callSend(cookie, { url = 'http://localhost/api/auth/email-verification/send', extraHeaders = {} } = {}) {
  const ip = nextIp('send');
  await resetEmailVerificationRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip, ...extraHeaders };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return sendRoute.POST(new Request(url, { method: 'POST', headers }));
}

async function callVerify(cookie, code, { ip, userIdForAttemptReset } = {}) {
  const useIp = ip ?? nextIp('verify');
  await resetEmailVerificationRateForTest(useIp);
  if (userIdForAttemptReset) await resetEmailVerificationAttemptRateForTest(userIdForAttemptReset);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': useIp };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return verifyRoute.POST(
    new Request('http://localhost/api/auth/email-verification/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
    }),
  );
}

async function callMe(cookie) {
  const ip = nextIp('me');
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return meRoute.GET(new Request('http://localhost/api/auth/me', { headers }));
}

async function callPatch(cookie, body) {
  const ip = nextIp('patch');
  await resetRateForTest(ip);
  return meRoute.PATCH(
    new Request('http://localhost/api/auth/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
      body: JSON.stringify(body),
    }),
  );
}

const db = createClient({ url: `file:${dbFile}` });
await db.execute('PRAGMA foreign_keys = ON');
const userIdByEmail = async (email) => {
  const r = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email.toLowerCase()] });
  return r.rows[0] ? String(r.rows[0].id) : null;
};
const challengesFor = async (userId) =>
  (await db.execute({
    sql: 'SELECT id, email, token_digest, created_at, expires_at, consumed_at, revoked_at FROM email_verification_challenges WHERE user_id = ? ORDER BY created_at',
    args: [userId],
  })).rows;
// A3c — this account's account_identity_fingerprints rows (any kind).
const fingerprintsFor = async (userId) =>
  (await db.execute({
    sql: 'SELECT id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at FROM account_identity_fingerprints WHERE user_id = ? ORDER BY fingerprint_kind',
    args: [userId],
  })).rows;
// The independently-computed expected VERIFIED_EMAIL digest for one address —
// same canonical normalization auth already uses everywhere (.trim().toLowerCase()).
const expectedVerifiedEmailFingerprint = (email) =>
  accountIdentityFingerprint('VERIFIED_EMAIL', email.trim().toLowerCase(), { verified: true });
// THE authoritative marker.
const userEmailVerifiedAt = async (userId) => {
  const r = await db.execute({ sql: 'SELECT email_verified_at FROM users WHERE id = ?', args: [userId] });
  return r.rows[0] ? r.rows[0].email_verified_at : undefined;
};
// The deprecated/vestigial column — must never be written.
const profileEmailVerifiedAt = async (userId) => {
  const r = await db.execute({ sql: 'SELECT email_verified_at FROM account_identity_profiles WHERE user_id = ?', args: [userId] });
  return r.rows[0] ? r.rows[0].email_verified_at : undefined; // undefined = no profile row
};
const hasProfile = async (userId) =>
  Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM account_identity_profiles WHERE user_id = ?', args: [userId] })).rows[0].c) > 0;
// Push a user's challenges past the resend cooldown so /send will actually issue.
const clearCooldown = (userId) =>
  db.execute({
    sql: 'UPDATE email_verification_challenges SET created_at = created_at - ? WHERE user_id = ?',
    args: [EMAIL_VERIFICATION_RESEND_COOLDOWN_MS + 5000, userId],
  });
// A code that is guaranteed NOT to equal the real one (mod 10 on the last digit).
const wrongCodeFor = (realCode) => {
  const lastDigit = (Number(realCode[5]) + 1) % 10;
  return realCode.slice(0, 5) + String(lastDigit);
};

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n       ') : err}`);
  }
}

// ====================================================================

await test('signup: account created, users.email_verified_at stays NULL, exactly one challenge issued, a 6-digit code dispatched, nothing leaked', async () => {
  sentMessages.length = 0;
  const { res } = await signup('user1@example.com');
  assert.equal(res.status, 201);
  const bodyText = JSON.stringify(await res.json());
  assert.equal(/token|digest|"challenge/i.test(bodyText), false, 'signup response says nothing about the challenge');

  const uid = await userIdByEmail('user1@example.com');
  assert.equal(await userEmailVerifiedAt(uid), null);
  const rows = await challengesFor(uid);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].email), 'user1@example.com');
  assert.equal(rows[0].consumed_at, null);
  assert.equal(rows[0].revoked_at, null);
  assert.equal(Number(rows[0].expires_at) - Number(rows[0].created_at), EMAIL_VERIFICATION_TTL_MS);
  assert.equal(sentMessages.length, 1, 'signup requested one verification code through the provider');
  assert.equal(sentMessages[0].to, 'user1@example.com');
  assert.match(sentMessages[0].code, /^[0-9]{6}$/, 'the dispatched code is exactly 6 numeric digits');
  assert.equal(sentMessages[0].verificationUrl, undefined, 'A3b: no more link/URL in the message');
});

await test('the raw code is NEVER stored in plaintext — only its keyed HMAC digest, in no column anywhere', async () => {
  sentMessages.length = 0;
  await signup('user2@example.com');
  const rawCode = codeFromLastMessage();
  assert.match(rawCode, /^[0-9]{6}$/);

  const uid = await userIdByEmail('user2@example.com');
  const row = (await challengesFor(uid))[0];
  assert.notEqual(String(row.token_digest), rawCode);
  assert.equal(String(row.token_digest).length, 64, 'still a 64-char hex digest — the column is reused unchanged');
  assert.equal(String(row.token_digest), hashEmailVerificationCode(String(row.id), rawCode));

  for (const r of (await db.execute('SELECT * FROM email_verification_challenges')).rows) {
    for (const v of Object.values(r)) assert.notEqual(String(v ?? ''), rawCode, 'no column holds the raw code');
  }
});

await test('valid verification succeeds once, sets users.email_verified_at, and /api/auth/me reflects it', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user3@example.com');
  const code = codeFromLastMessage();
  const uid = await userIdByEmail('user3@example.com');

  let meBody = await (await callMe(cookie)).json();
  assert.equal(meBody.emailVerification.status, 'unverified');
  assert.equal(meBody.identity.emailVerified, undefined, 'identity carries no email-verification flag');

  const res = await callVerify(cookie, code);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'verified' });
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0, 'users.email_verified_at is set');
  assert.equal(await profileEmailVerifiedAt(uid), null, 'the vestigial profile column stays NULL');
  assert.ok(Number((await challengesFor(uid))[0].consumed_at) > 0);
  assert.equal((await fingerprintsFor(uid)).length, 1, 'A3c: exactly one fingerprint written alongside the verify');

  meBody = await (await callMe(cookie)).json();
  assert.equal(meBody.emailVerification.status, 'verified');
});

await test('wrong code fails and does not consume or verify the real challenge, and writes no fingerprint', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user-wrongcode@example.com');
  const realCode = codeFromLastMessage();
  const uid = await userIdByEmail('user-wrongcode@example.com');

  const res = await callVerify(cookie, wrongCodeFor(realCode));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /doesn't match/i);
  assert.equal(await userEmailVerifiedAt(uid), null);
  assert.equal((await challengesFor(uid))[0].consumed_at, null, 'the real challenge is still unconsumed after a wrong guess');
  assert.equal((await fingerprintsFor(uid)).length, 0, 'no fingerprint from a wrong guess');

  // and the REAL code still works afterward
  assert.equal((await callVerify(cookie, realCode)).status, 200);
  assert.equal((await fingerprintsFor(uid)).length, 1, 'the real code does write one');
});

await test('replay: a consumed code cannot verify again, and the replay does not touch the fingerprint', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user4@example.com');
  const code = codeFromLastMessage();
  const uid = await userIdByEmail('user4@example.com');
  assert.equal((await callVerify(cookie, code)).status, 200);
  const fpAfterFirst = (await fingerprintsFor(uid))[0];
  const replay = await callVerify(cookie, code);
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /already been used/i);
  const rows = await fingerprintsFor(uid);
  assert.equal(rows.length, 1, 'the replay did not add a second row');
  assert.equal(rows[0].id, fpAfterFirst.id, 'and did not touch the existing one');
  assert.equal(rows[0].source_verified_at, fpAfterFirst.source_verified_at, 'timestamp unchanged by the failed replay');
});

await test('expired: a code past its TTL cannot verify and does not set verified state', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user5@example.com');
  const code = codeFromLastMessage();
  const uid = await userIdByEmail('user5@example.com');
  await db.execute({
    sql: 'UPDATE email_verification_challenges SET created_at = ?, expires_at = ? WHERE user_id = ?',
    args: [Date.now() - 60_000, Date.now() - 30_000, uid],
  });
  const res = await callVerify(cookie, code);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /expired/i);
  assert.equal(await userEmailVerifiedAt(uid), null);
  assert.equal((await fingerprintsFor(uid)).length, 0, 'no fingerprint from an expired code');
});

await test('revoked: a revoked code cannot verify, and writes no fingerprint', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user6@example.com');
  const code = codeFromLastMessage();
  const uid = await userIdByEmail('user6@example.com');
  await db.execute({ sql: 'UPDATE email_verification_challenges SET revoked_at = ? WHERE user_id = ?', args: [Date.now(), uid] });
  const res = await callVerify(cookie, code);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no longer valid/i);
  assert.equal((await fingerprintsFor(uid)).length, 0, 'no fingerprint from a revoked code');
});

await test('malformed code fails with a generic message, and needs no session (rejected before any DB work)', async () => {
  for (const bad of [undefined, null, '', 'abcdef', '12345', '1234567', '12a456', 123456, '00000o']) {
    const res = await callVerify(null, bad);
    assert.equal(res.status, 400, `rejected: ${String(bad)}`);
    assert.match((await res.json()).error, /6-digit code/i);
  }
});

await test('a challenge whose target address no longer matches the current email is rejected even without an explicit revoke', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user8@example.com', { username: 'user8' });
  const code = codeFromLastMessage();
  const uid = await userIdByEmail('user8@example.com');
  await db.execute({ sql: 'UPDATE users SET email = ? WHERE id = ?', args: ['user8-elsewhere@example.com', uid] });
  const res = await callVerify(cookie, code);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /email address changed/i);
  assert.equal((await fingerprintsFor(uid)).length, 0, 'no fingerprint from a stale-address code');
});

await test('resend cooldown: a second send inside the window is 429; allowed again after it', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user9@example.com');
  const uid = await userIdByEmail('user9@example.com');
  await clearCooldown(uid);

  assert.equal((await callSend(cookie)).status, 200);
  const second = await callSend(cookie);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).status, 'cooldown');
  assert.ok(Number(second.headers.get('Retry-After')) >= 1);

  await clearCooldown(uid);
  assert.equal((await callSend(cookie)).status, 200);
});

await test('resend revokes the previous outstanding challenge — only the latest code ever verifies', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user-resend@example.com');
  const firstCode = codeFromLastMessage();
  const uid = await userIdByEmail('user-resend@example.com');
  await clearCooldown(uid);

  assert.equal((await callSend(cookie)).status, 200);
  const secondCode = codeFromLastMessage();
  assert.notEqual(firstCode, secondCode, 'sanity: two independently generated codes collided in this test run');

  const rows = await challengesFor(uid);
  assert.equal(rows.length, 2);
  assert.ok(Number(rows[0].revoked_at) > 0, 'the first (superseded) challenge is revoked');
  assert.equal(rows[1].revoked_at, null, 'the second (current) challenge is still live');

  // The stale code is compared against the account's CURRENT (most recent)
  // challenge — the row it actually belonged to is revoked at the DB level
  // (asserted above), but the lookup never reaches that row at all, so this
  // surfaces as an ordinary code mismatch rather than a "revoked" message.
  const oldAttempt = await callVerify(cookie, firstCode);
  assert.equal(oldAttempt.status, 400);
  assert.match((await oldAttempt.json()).error, /doesn't match/i);

  assert.equal((await callVerify(cookie, secondCode)).status, 200);
});

await test('bounded issuance: once the per-window cap is reached, send is rejected', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user10@example.com');
  const uid = await userIdByEmail('user10@example.com');
  const now = Date.now();
  for (let i = 0; i < EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW; i++) {
    await db.execute({
      sql: 'INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES (?,?,?,?,?,?)',
      args: [`cap-${uid}-${i}`, uid, 'user10@example.com', String(i).padStart(64, '0'), now - 600_000 - i * 1000, now + 600_000],
    });
  }
  await db.execute({ sql: `DELETE FROM email_verification_challenges WHERE user_id = ? AND id NOT LIKE 'cap-%'`, args: [uid] });
  const res = await callSend(cookie);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).status, 'cooldown');
});

await test('concurrent verification: exactly one of two simultaneous verifies succeeds, and re-processing the race writes exactly one fingerprint', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user11@example.com');
  const code = codeFromLastMessage();
  const uid = await userIdByEmail('user11@example.com');
  const [a, b] = await Promise.all([callVerify(cookie, code, { ip: 'race-a' }), callVerify(cookie, code, { ip: 'race-b' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0);
  const rows = await fingerprintsFor(uid);
  assert.equal(rows.length, 1, 'A3c: the losing concurrent attempt did not also write (or duplicate) a fingerprint');
  assert.equal(String(rows[0].fingerprint), expectedVerifiedEmailFingerprint('user11@example.com'));
});

await test('A3c: successful verification writes exactly one VERIFIED_EMAIL fingerprint matching the pure-function digest; the vestigial profile column stays NULL', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user12@example.com');
  const uid = await userIdByEmail('user12@example.com');
  assert.equal((await fingerprintsFor(uid)).length, 0, 'nothing before verification');

  const res = await callVerify(cookie, codeFromLastMessage());
  assert.equal(res.status, 200);

  const rows = await fingerprintsFor(uid);
  assert.equal(rows.length, 1, 'exactly one fingerprint row');
  const row = rows[0];
  assert.equal(String(row.fingerprint_kind), 'VERIFIED_EMAIL');
  assert.equal(Number(row.key_version), ACCOUNT_IDENTITY_KEY_VERSION);
  assert.ok(Number(row.source_verified_at) > 0);
  assert.ok(Number(row.created_at) > 0);
  assert.match(String(row.fingerprint), /^[0-9a-f]{64}$/, 'a 64-char hex HMAC digest');
  assert.equal(String(row.fingerprint), expectedVerifiedEmailFingerprint('user12@example.com'), 'matches the independently-computed keyed HMAC');

  // plaintext email is not stored anywhere in the fingerprint row
  for (const v of Object.values(row)) {
    assert.equal(String(v ?? '').toLowerCase().includes('user12@example.com'), false, 'no column holds the raw email');
  }

  assert.equal(await profileEmailVerifiedAt(uid), null, 'account_identity_profiles.email_verified_at is never written');
});

await test('A3c: different accounts/emails produce different VERIFIED_EMAIL fingerprints', async () => {
  sentMessages.length = 0;
  const { cookie: cookieA } = await signup('fp-a@example.com', { username: 'fpusera' });
  assert.equal((await callVerify(cookieA, codeFromLastMessage())).status, 200);
  const uidA = await userIdByEmail('fp-a@example.com');

  sentMessages.length = 0;
  const { cookie: cookieB } = await signup('fp-b@example.com', { username: 'fpuserb' });
  assert.equal((await callVerify(cookieB, codeFromLastMessage())).status, 200);
  const uidB = await userIdByEmail('fp-b@example.com');

  const fpA = String((await fingerprintsFor(uidA))[0].fingerprint);
  const fpB = String((await fingerprintsFor(uidB))[0].fingerprint);
  assert.notEqual(fpA, fpB, 'different verified emails -> different digests');
  assert.equal(fpA, expectedVerifiedEmailFingerprint('fp-a@example.com'));
  assert.equal(fpB, expectedVerifiedEmailFingerprint('fp-b@example.com'));
});

await test('A3c: re-applying the guarded fingerprint-upsert statement for the same winning consume updates in place — no duplicate row', async () => {
  // Directly exercises the statement the verify route puts in its
  // client.batch (upsertVerifiedEmailFingerprintIfChallengeConsumedStatement),
  // simulating "successful re-processing" of the SAME winning write (e.g. a
  // retried batch after a transient SQLITE_BUSY on a later statement, or any
  // other reason the same guarded write is applied more than once). Bypasses
  // the HTTP layer deliberately: POST /send itself refuses to mint a second
  // code once an account is already verified (see send/route.ts), so this
  // scenario cannot be reached by calling /send twice — the guarantee that
  // matters lives in the SQL upsert semantics, not in there being no route
  // that could ever call it twice.
  const uid = 'reprocess-fp-user';
  await db.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [uid, 'reprocess@example.com', 'reprocess', 'h'] });
  const now = Date.now();
  const challengeId = 'reprocess-challenge-1';
  await db.execute({
    sql: 'INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?)',
    args: [challengeId, uid, 'reprocess@example.com', 'x'.repeat(64), now - 1000, now + 600_000, now],
  });
  const fp = expectedVerifiedEmailFingerprint('reprocess@example.com');

  await db.execute(upsertVerifiedEmailFingerprintIfChallengeConsumedStatement('fp-row-a', uid, fp, challengeId, now));
  const afterFirst = await fingerprintsFor(uid);
  assert.equal(afterFirst.length, 1);
  assert.equal(String(afterFirst[0].fingerprint), fp);

  // re-apply the SAME guarded write again, with a different candidate row id
  await db.execute(upsertVerifiedEmailFingerprintIfChallengeConsumedStatement('fp-row-b', uid, fp, challengeId, now));
  const afterSecond = await fingerprintsFor(uid);
  assert.equal(afterSecond.length, 1, 'still exactly one row — the ON CONFLICT DO UPDATE upserted in place, not a duplicate');
  assert.equal(afterSecond[0].id, 'fp-row-a', "the ORIGINAL row's id survives — ON CONFLICT DO UPDATE never touches id");

  // and the guard itself: a write claiming a DIFFERENT (never-consumed)
  // challenge id is a no-op, even for an otherwise-identical fingerprint.
  await db.execute(upsertVerifiedEmailFingerprintIfChallengeConsumedStatement('fp-row-c', uid, fp, 'no-such-challenge', now));
  assert.equal((await fingerprintsFor(uid)).length, 1, 'an unguarded/unmatched challenge id writes nothing');
});

await test('A3c: fingerprint secret missing fails closed BEFORE any write — verification is never partial', async () => {
  const saved = process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
  sentMessages.length = 0;
  const { cookie } = await signup('user-nofpkey@example.com');
  const uid = await userIdByEmail('user-nofpkey@example.com');
  const code = codeFromLastMessage();
  delete process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
  try {
    const res = await callVerify(cookie, code);
    assert.equal(res.status, 500, 'refuses rather than verifying without evidence');
    assert.equal(await userEmailVerifiedAt(uid), null, 'NOT marked verified — no partial success');
    assert.equal((await challengesFor(uid))[0].consumed_at, null, 'the challenge itself was NOT consumed');
    assert.equal((await fingerprintsFor(uid)).length, 0, 'no fingerprint row exists');
    assert.equal((await res.json()).error, 'Something went wrong. Please try again.', 'a generic message only — no secret or internal detail leaks');
  } finally {
    process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = saved;
  }

  // and once the key is restored, the SAME still-live code verifies normally
  const recovered = await callVerify(cookie, code);
  assert.equal(recovered.status, 200);
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0);
  assert.equal((await fingerprintsFor(uid)).length, 1);
});

await test('a verified address matching ADMIN_EMAIL still does NOT gain the admin role', async () => {
  sentMessages.length = 0;
  assert.equal(process.env.ADMIN_EMAIL, 'a3-admin@example.com');
  const { cookie } = await signup('a3-admin@example.com', { username: 'a3admin' });
  const uid = await userIdByEmail('a3-admin@example.com');
  assert.equal(String((await db.execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [uid] })).rows[0].role), 'user');
  assert.equal((await callVerify(cookie, codeFromLastMessage())).status, 200);
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0, 'the admin email IS verified');
  assert.equal(
    String((await db.execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [uid] })).rows[0].role),
    'user',
    'verifying the configured admin email must NOT grant admin',
  );
});

await test('LEGACY (profile-less) account: can request AND complete verification, stays profile-less, no synthetic fields', async () => {
  const legacyId = 'legacy-acct-1';
  await db.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [legacyId, 'legacy@example.com', 'legacy', 'h'] });
  const sessionToken = 'legacy-session-token-value-for-this-test-only';
  await db.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: [createHash('sha256').update(sessionToken, 'utf8').digest('hex'), legacyId, Date.now(), Date.now() + 3_600_000],
  });

  assert.equal(await hasProfile(legacyId), false, 'precondition: no identity profile');

  sentMessages.length = 0;
  const meBefore = await (await callMe(sessionToken)).json();
  assert.equal(meBefore.emailVerification.status, 'unverified');
  assert.equal(meBefore.identity, null);

  // request verification
  const sendRes = await callSend(sessionToken);
  assert.equal(sendRes.status, 200);
  assert.equal((await sendRes.json()).status, 'sent');
  const code = codeFromLastMessage();
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM email_verification_challenges WHERE user_id = ?', args: [legacyId] })).rows[0].c), 1);

  // verify
  const verifyRes = await callVerify(sessionToken, code);
  assert.equal(verifyRes.status, 200);

  assert.ok(Number(await userEmailVerifiedAt(legacyId)) > 0, 'users.email_verified_at is now set for the legacy account');
  assert.equal(await hasProfile(legacyId), false, 'STILL profile-less — no synthetic profile row was created');
  assert.equal((await fingerprintsFor(legacyId)).length, 1, 'A3c: a profile-less account still gets a VERIFIED_EMAIL fingerprint - it keys off users.id, not the profile');
  const meAfter = await (await callMe(sessionToken)).json();
  assert.equal(meAfter.emailVerification.status, 'verified');
  assert.equal(meAfter.identity, null, 'still no identity profile — verification did not fabricate a full name / account type');
});

await test('the DEFAULT mail provider is fail-closed: /send returns 503 (never fake success) and leaves no live challenge', async () => {
  __setEmailDeliveryProviderForTest(null);
  try {
    sentMessages.length = 0;
    const { cookie } = await signup('user13@example.com');
    const uid = await userIdByEmail('user13@example.com');
    await clearCooldown(uid);
    const res = await callSend(cookie);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).status, 'delivery_failed');
    const live = (await challengesFor(uid)).filter((r) => r.consumed_at == null && r.revoked_at == null && Number(r.expires_at) > Date.now());
    assert.equal(live.length, 0, 'no live-but-undeliverable challenge remains');
  } finally {
    __setEmailDeliveryProviderForTest(fakeProvider);
  }
});

await test('absent EMAIL_VERIFICATION_CODE_SECRET fails closed: /send returns 503, no challenge row is created, signup still succeeds', async () => {
  const saved = process.env.EMAIL_VERIFICATION_CODE_SECRET;
  delete process.env.EMAIL_VERIFICATION_CODE_SECRET;
  try {
    sentMessages.length = 0;
    const { res, cookie } = await signup('user-nosecret@example.com');
    assert.equal(res.status, 201, 'signup still succeeds with no code secret configured');
    assert.ok(cookie, 'a session cookie was still issued');
    const uid = await userIdByEmail('user-nosecret@example.com');
    assert.equal((await challengesFor(uid)).length, 0, 'no challenge was ever generated or stored');
    assert.equal(sentMessages.length, 0, 'nothing was dispatched');

    const sendRes = await callSend(cookie);
    assert.equal(sendRes.status, 503);
    assert.equal((await sendRes.json()).status, 'unavailable');
    assert.equal((await challengesFor(uid)).length, 0);

    const meBody = await (await callMe(cookie)).json();
    assert.equal(meBody.user.email, 'user-nosecret@example.com');
    assert.equal(meBody.emailVerification.status, 'unverified');
  } finally {
    process.env.EMAIL_VERIFICATION_CODE_SECRET = saved;
  }
});

await test('send/verify/me responses leak nothing internal (digest / challenge id / fingerprint / user id / the actual fingerprint value)', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user14@example.com');
  const uid = await userIdByEmail('user14@example.com');
  await clearCooldown(uid);
  const sendBody = JSON.stringify(await (await callSend(cookie)).json());
  const verifyBody = JSON.stringify(await (await callVerify(cookie, codeFromLastMessage())).json());
  const meBody = JSON.stringify(await (await callMe(cookie)).json());
  const actualFingerprint = String((await fingerprintsFor(uid))[0].fingerprint);
  for (const blob of [sendBody, verifyBody, meBody]) {
    for (const forbidden of ['token_digest', 'digest', 'challengeid', 'challenge_id', 'fingerprint', 'ownerlink', 'user_id', uid.toLowerCase(), actualFingerprint.toLowerCase()]) {
      assert.equal(blob.toLowerCase().includes(forbidden), false, `${forbidden} must not appear in ${blob}`);
    }
  }
});

// ---- session / ownership requirements (A3b) -------------------------

await test('verify requires a session — a signed-out request is rejected even with a correct-shaped code', async () => {
  sentMessages.length = 0;
  await signup('user15@example.com');
  const code = codeFromLastMessage();
  const res = await callVerify(null, code);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /not signed in/i);
});

await test('non-owner cannot verify another account: entering account A\'s code while signed in as account B fails, and neither account is affected', async () => {
  sentMessages.length = 0;
  const { cookie: cookieA } = await signup('owner-a@example.com', { username: 'ownera' });
  const codeA = codeFromLastMessage();
  const uidA = await userIdByEmail('owner-a@example.com');

  sentMessages.length = 0;
  const { cookie: cookieB } = await signup('owner-b@example.com', { username: 'ownerb' });
  const uidB = await userIdByEmail('owner-b@example.com');

  // B is signed in, but presents A's code — B's lookup only ever considers
  // B's own most recent challenge, so this can only ever be a wrong-code
  // mismatch, never a successful cross-account verify.
  const res = await callVerify(cookieB, codeA);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /doesn't match/i);

  assert.equal(await userEmailVerifiedAt(uidA), null, "A's account was not verified by B's request");
  assert.equal(await userEmailVerifiedAt(uidB), null, "B's own account was not accidentally verified either");
  assert.equal((await fingerprintsFor(uidA)).length, 0, "B's request did not create a fingerprint for A");
  assert.equal((await fingerprintsFor(uidB)).length, 0, "B's request did not create a fingerprint for B either");

  // and A's real code still works for A.
  assert.equal((await callVerify(cookieA, codeA)).status, 200);
  const fpA = await fingerprintsFor(uidA);
  assert.equal(fpA.length, 1, "A's own successful verify does write A's fingerprint");
  assert.equal(String(fpA[0].fingerprint), expectedVerifiedEmailFingerprint('owner-a@example.com'));
  assert.equal((await fingerprintsFor(uidB)).length, 0, "B still has none");
});

// ---- guessing / attempt protection (A3b) -----------------------------

await test('attempt cap: repeated wrong guesses against one account are rate-limited, independent of the coarse per-IP bucket', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user-attempts@example.com');
  const realCode = codeFromLastMessage();
  const uid = await userIdByEmail('user-attempts@example.com');
  await resetEmailVerificationAttemptRateForTest(uid);

  let sawRateLimited = false;
  let lastStatus = null;
  for (let i = 0; i < 12; i++) {
    // A fresh IP every call so the OUTER per-IP bucket (12/min) never fires —
    // isolates the per-ACCOUNT attempt bucket this test is pinning.
    const res = await callVerify(cookie, wrongCodeFor(realCode), { ip: `attempt-${uid}-${i}` });
    lastStatus = res.status;
    if (res.status === 429) {
      sawRateLimited = true;
      assert.ok(Number(res.headers.get('Retry-After')) >= 1);
      break;
    }
    assert.equal(res.status, 400, 'a wrong guess under the cap is a plain invalid-code rejection, not a 500');
  }
  assert.ok(sawRateLimited, `expected the per-account attempt bucket to eventually return 429 (last status was ${lastStatus})`);

  // Even the CORRECT code is blocked while the account's attempt bucket is exhausted.
  const stillBlocked = await callVerify(cookie, realCode, { ip: `attempt-${uid}-final` });
  assert.equal(stillBlocked.status, 429);
  assert.equal(await userEmailVerifiedAt(uid), null);

  // and once the bucket is reset (simulating time passing), the real code works.
  await resetEmailVerificationAttemptRateForTest(uid);
  assert.equal((await callVerify(cookie, realCode, { ip: `attempt-${uid}-after-reset` })).status, 200);
});

// ---- email-change interaction ----------------------------------------

await test('email change: UPDATE users (email + email_verified_at NULL), challenge revoke, and VERIFIED_EMAIL fingerprint removal land atomically; old code cannot verify the new email', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user7@example.com', { username: 'user7' });
  assert.equal((await callVerify(cookie, codeFromLastMessage())).status, 200);
  const uid = await userIdByEmail('user7@example.com');
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0);
  assert.equal((await fingerprintsFor(uid)).length, 1, 'precondition: verified with a fingerprint');
  assert.equal(String((await fingerprintsFor(uid))[0].fingerprint), expectedVerifiedEmailFingerprint('user7@example.com'));

  await clearCooldown(uid);
  assert.equal((await callSend(cookie)).status, 200);
  const staleCode = codeFromLastMessage();

  const patch = await callPatch(cookie, { username: 'user7', email: 'user7-new@example.com' });
  assert.equal(patch.status, 200);
  const patchBody = await patch.json();
  assert.equal(patchBody.user.email, 'user7-new@example.com');
  assert.equal(patchBody.emailVerification.status, 'unverified');

  assert.equal(await userEmailVerifiedAt(uid), null, 'users.email_verified_at cleared by the email change');
  const rows = await challengesFor(uid);
  assert.equal(rows.every((r) => r.revoked_at != null || r.consumed_at != null), true, 'every prior challenge is revoked or already consumed');
  assert.equal((await fingerprintsFor(uid)).length, 0, 'the old VERIFIED_EMAIL fingerprint was removed atomically with the email change');

  const res = await callVerify(cookie, staleCode);
  assert.equal(res.status, 400);
  assert.equal(await userEmailVerifiedAt(uid), null);
  assert.equal((await fingerprintsFor(uid)).length, 0, 'still nothing — the stale code cannot resurrect it');

  // verifying the NEW email writes a REPLACEMENT fingerprint for the new address
  await clearCooldown(uid);
  assert.equal((await callSend(cookie)).status, 200);
  const newCode = codeFromLastMessage();
  assert.equal((await callVerify(cookie, newCode)).status, 200);
  const after = await fingerprintsFor(uid);
  assert.equal(after.length, 1, 'exactly one fingerprint for the new email');
  assert.equal(String(after[0].fingerprint), expectedVerifiedEmailFingerprint('user7-new@example.com'));
  assert.notEqual(String(after[0].fingerprint), expectedVerifiedEmailFingerprint('user7@example.com'), 'different from the old email\'s digest');
});

// ---- signup challenge-delivery invariant --------------------------

await test('signup + provider SUCCESS: the challenge stays ACTIVE', async () => {
  sentMessages.length = 0;
  const { res, cookie } = await signup('deliver1@example.com');
  assert.equal(res.status, 201);
  const uid = await userIdByEmail('deliver1@example.com');
  const rows = await challengesFor(uid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].consumed_at, null);
  assert.equal(rows[0].revoked_at, null, 'delivered challenge is still active');
  assert.equal(sentMessages.length, 1);
  // and it actually verifies
  assert.equal((await callVerify(cookie, codeFromLastMessage())).status, 200);
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0);
});

await test('signup + provider FAILURE: that exact challenge is REVOKED; account + session still succeed', async () => {
  __setEmailDeliveryProviderForTest({
    async sendEmailVerification() {
      throw new Error('provider exploded');
    },
  });
  try {
    sentMessages.length = 0;
    const { res, cookie } = await signup('deliver2@example.com');
    assert.equal(res.status, 201, 'signup still succeeds');
    assert.ok(cookie && cookie.length > 20, 'a session cookie was still issued');
    const bodyText = JSON.stringify(await res.json());
    assert.equal(/token|digest|revoked/i.test(bodyText), false, 'nothing about the challenge leaks into the response');

    const uid = await userIdByEmail('deliver2@example.com');
    const rows = await challengesFor(uid);
    assert.equal(rows.length, 1, 'the challenge row still exists (created in the atomic signup batch)');
    assert.ok(Number(rows[0].revoked_at) > 0, 'but it was revoked because delivery failed');
    assert.equal(rows[0].consumed_at, null);

    // the session actually works
    const meBody = await (await callMe(cookie)).json();
    assert.equal(meBody.user.email, 'deliver2@example.com');
    assert.equal(meBody.emailVerification.status, 'unverified');
  } finally {
    __setEmailDeliveryProviderForTest(fakeProvider);
  }
});

await test('the failed-delivery revoke targets ONE exact challenge id — never a broad per-account sweep', async () => {
  // Directly exercise the statement used by both signup and /send on a failed
  // dispatch: it must revoke exactly the id it is given and leave every other
  // still-outstanding challenge for the same account alone (the "concurrent
  // resend" safety property).
  const uid = 'precise-revoke-user';
  await db.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [uid, 'precise@example.com', 'precise', 'h'] });
  const now = Date.now();
  for (const id of ['pc-a', 'pc-b', 'pc-c']) {
    await db.execute({
      sql: 'INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES (?,?,?,?,?,?)',
      args: [id, uid, 'precise@example.com', id.padEnd(64, '0'), now, now + 600_000],
    });
  }
  const stmt = revokeEmailVerificationChallengeByIdStatement('pc-b', now + 1);
  await db.execute(stmt);

  const rows = await challengesFor(uid);
  const byId = Object.fromEntries(rows.map((r) => [String(r.id), r]));
  assert.equal(byId['pc-a'].revoked_at, null, 'pc-a untouched');
  assert.ok(Number(byId['pc-b'].revoked_at) > 0, 'pc-b revoked (the exact id)');
  assert.equal(byId['pc-c'].revoked_at, null, 'pc-c untouched');

  // and it is a no-op on an already-revoked / consumed row
  await db.execute({ sql: 'UPDATE email_verification_challenges SET consumed_at = ? WHERE id = ?', args: [now, 'pc-a'] });
  await db.execute(revokeEmailVerificationChallengeByIdStatement('pc-a', now + 2));
  assert.equal((await db.execute({ sql: 'SELECT revoked_at FROM email_verification_challenges WHERE id = ?', args: ['pc-a'] })).rows[0].revoked_at, null, 'a consumed challenge is not retro-revoked');
});

// ====================================================================

setup.close();
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}

if (failures > 0) {
  console.error(`\nemail-verification: ${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll email-verification tests passed');
