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
import { resetAuthRateForTest, resetRateForTest, resetEmailVerificationRateForTest } from '../lib/rate-limit.js';
import { __setEmailDeliveryProviderForTest } from '../lib/mail/email-delivery.ts';
import {
  hashEmailVerificationToken,
  revokeEmailVerificationChallengeByIdStatement,
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW,
} from '../lib/email-verification.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * A3 — email-verification foundation.
 *
 * Authoritative verified state is users.email_verified_at (works for EVERY
 * account, profile or not). account_identity_profiles.email_verified_at is
 * deprecated/vestigial and is asserted to stay NULL.
 *
 * The mail provider is a fake injected here; NO real mail is ever sent, and the
 * default provider's fail-closed behaviour is proven in a dedicated case.
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
// Belt-and-braces: make sure no Vercel system host is inherited into this run —
// the trusted-host policy must fall back to "localhost only".
delete process.env.VERCEL;
delete process.env.VERCEL_URL;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

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
function tokenFromLastMessage() {
  const url = sentMessages.at(-1)?.verificationUrl ?? '';
  const m = url.match(/[?&]token=([0-9a-f]{64})\b/);
  return m ? m[1] : null;
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

async function callVerify(token, { ip } = {}) {
  const useIp = ip ?? nextIp('verify');
  await resetEmailVerificationRateForTest(useIp);
  return verifyRoute.POST(
    new Request('http://localhost/api/auth/email-verification/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': useIp },
      body: JSON.stringify({ token }),
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

await test('signup: account created, users.email_verified_at stays NULL, exactly one challenge issued, nothing leaked', async () => {
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
  assert.equal(sentMessages.length, 1, 'signup requested one verification email through the provider');
  assert.equal(sentMessages[0].to, 'user1@example.com');
  assert.match(sentMessages[0].verificationUrl, /^http:\/\/localhost\/verify-email\?token=[0-9a-f]{64}$/, 'link points at the trusted local host only');
});

await test('the raw token is NEVER stored — only its SHA-256 digest, in no column anywhere', async () => {
  sentMessages.length = 0;
  await signup('user2@example.com');
  const rawToken = tokenFromLastMessage();
  assert.match(rawToken, /^[0-9a-f]{64}$/);

  const uid = await userIdByEmail('user2@example.com');
  const row = (await challengesFor(uid))[0];
  assert.notEqual(String(row.token_digest), rawToken);
  assert.equal(String(row.token_digest), createHash('sha256').update(rawToken, 'utf8').digest('hex'));
  assert.equal(String(row.token_digest), hashEmailVerificationToken(rawToken));

  for (const r of (await db.execute('SELECT * FROM email_verification_challenges')).rows) {
    for (const v of Object.values(r)) assert.notEqual(String(v ?? ''), rawToken, 'no column holds the raw token');
  }
});

await test('valid verification succeeds once, sets users.email_verified_at, and /api/auth/me reflects it', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user3@example.com');
  const token = tokenFromLastMessage();
  const uid = await userIdByEmail('user3@example.com');

  let meBody = await (await callMe(cookie)).json();
  assert.equal(meBody.emailVerification.status, 'unverified');
  assert.equal(meBody.identity.emailVerified, undefined, 'identity carries no email-verification flag');

  const res = await callVerify(token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'verified' });
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0, 'users.email_verified_at is set');
  assert.equal(await profileEmailVerifiedAt(uid), null, 'the vestigial profile column stays NULL');
  assert.ok(Number((await challengesFor(uid))[0].consumed_at) > 0);

  meBody = await (await callMe(cookie)).json();
  assert.equal(meBody.emailVerification.status, 'verified');
});

await test('replay: a consumed token cannot verify again', async () => {
  sentMessages.length = 0;
  await signup('user4@example.com');
  const token = tokenFromLastMessage();
  assert.equal((await callVerify(token)).status, 200);
  const replay = await callVerify(token);
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /already been used/i);
});

await test('expired: a token past its TTL cannot verify and does not set verified state', async () => {
  sentMessages.length = 0;
  await signup('user5@example.com');
  const token = tokenFromLastMessage();
  const uid = await userIdByEmail('user5@example.com');
  await db.execute({
    sql: 'UPDATE email_verification_challenges SET created_at = ?, expires_at = ? WHERE user_id = ?',
    args: [Date.now() - 60_000, Date.now() - 30_000, uid],
  });
  const res = await callVerify(token);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /expired/i);
  assert.equal(await userEmailVerifiedAt(uid), null);
});

await test('revoked: a revoked token cannot verify', async () => {
  sentMessages.length = 0;
  await signup('user6@example.com');
  const token = tokenFromLastMessage();
  const uid = await userIdByEmail('user6@example.com');
  await db.execute({ sql: 'UPDATE email_verification_challenges SET revoked_at = ? WHERE user_id = ?', args: [Date.now(), uid] });
  const res = await callVerify(token);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no longer valid/i);
});

await test('malformed token fails with a generic message', async () => {
  for (const bad of [undefined, null, '', 'not-hex', 'abc', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65), 123]) {
    const res = await callVerify(bad);
    assert.equal(res.status, 400, `rejected: ${String(bad)}`);
    assert.match((await res.json()).error, /invalid or has expired/i);
  }
});

await test('email change: UPDATE users (email + email_verified_at NULL) and challenge revoke land atomically; old token cannot verify the new email', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user7@example.com', { username: 'user7' });
  assert.equal((await callVerify(tokenFromLastMessage())).status, 200);
  const uid = await userIdByEmail('user7@example.com');
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0);

  await clearCooldown(uid);
  assert.equal((await callSend(cookie)).status, 200);
  const staleToken = tokenFromLastMessage();

  const patch = await callPatch(cookie, { username: 'user7', email: 'user7-new@example.com' });
  assert.equal(patch.status, 200);
  const patchBody = await patch.json();
  assert.equal(patchBody.user.email, 'user7-new@example.com');
  assert.equal(patchBody.emailVerification.status, 'unverified');

  assert.equal(await userEmailVerifiedAt(uid), null, 'users.email_verified_at cleared by the email change');
  const rows = await challengesFor(uid);
  assert.equal(rows.every((r) => r.revoked_at != null || r.consumed_at != null), true, 'every prior challenge is revoked or already consumed');

  const res = await callVerify(staleToken);
  assert.equal(res.status, 400);
  assert.equal(await userEmailVerifiedAt(uid), null);
});

await test('a challenge whose target address no longer matches the current email is rejected even without an explicit revoke', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user8@example.com', { username: 'user8' });
  const token = tokenFromLastMessage();
  const uid = await userIdByEmail('user8@example.com');
  await db.execute({ sql: 'UPDATE users SET email = ? WHERE id = ?', args: ['user8-elsewhere@example.com', uid] });
  assert.equal((await callVerify(token)).status, 400);
  void cookie;
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

await test('concurrent verification: exactly one of two simultaneous verifies succeeds', async () => {
  sentMessages.length = 0;
  await signup('user11@example.com');
  const token = tokenFromLastMessage();
  const uid = await userIdByEmail('user11@example.com');
  const [a, b] = await Promise.all([callVerify(token, { ip: 'race-a' }), callVerify(token, { ip: 'race-b' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.ok(Number(await userEmailVerifiedAt(uid)) > 0);
});

await test('no identity fingerprint is ever created by verification; the vestigial profile column stays NULL', async () => {
  sentMessages.length = 0;
  const before = Number((await db.execute('SELECT COUNT(*) c FROM account_identity_fingerprints')).rows[0].c);
  const { cookie } = await signup('user12@example.com');
  const uid = await userIdByEmail('user12@example.com');
  await callVerify(tokenFromLastMessage());
  const after = Number((await db.execute('SELECT COUNT(*) c FROM account_identity_fingerprints')).rows[0].c);
  assert.equal(after, before);
  assert.equal(after, 0);
  assert.equal(await profileEmailVerifiedAt(uid), null, 'account_identity_profiles.email_verified_at is never written');
  void cookie;
});

await test('a verified address matching ADMIN_EMAIL still does NOT gain the admin role', async () => {
  sentMessages.length = 0;
  assert.equal(process.env.ADMIN_EMAIL, 'a3-admin@example.com');
  await signup('a3-admin@example.com', { username: 'a3admin' });
  const uid = await userIdByEmail('a3-admin@example.com');
  assert.equal(String((await db.execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [uid] })).rows[0].role), 'user');
  assert.equal((await callVerify(tokenFromLastMessage())).status, 200);
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
  const token = tokenFromLastMessage();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM email_verification_challenges WHERE user_id = ?', args: [legacyId] })).rows[0].c), 1);

  // verify
  const verifyRes = await callVerify(token);
  assert.equal(verifyRes.status, 200);

  assert.ok(Number(await userEmailVerifiedAt(legacyId)) > 0, 'users.email_verified_at is now set for the legacy account');
  assert.equal(await hasProfile(legacyId), false, 'STILL profile-less — no synthetic profile row was created');
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

await test('send/verify responses leak nothing internal (digest / challenge id / fingerprint / user id)', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('user14@example.com');
  const uid = await userIdByEmail('user14@example.com');
  await clearCooldown(uid);
  const sendBody = JSON.stringify(await (await callSend(cookie)).json());
  const verifyBody = JSON.stringify(await (await callVerify(tokenFromLastMessage())).json());
  for (const blob of [sendBody, verifyBody]) {
    for (const forbidden of ['token_digest', 'digest', 'challengeid', 'challenge_id', 'fingerprint', 'ownerlink', 'user_id', uid.toLowerCase()]) {
      assert.equal(blob.toLowerCase().includes(forbidden), false, `${forbidden} must not appear in ${blob}`);
    }
  }
});

await test('verify requires no session — the token alone is the proof', async () => {
  sentMessages.length = 0;
  await signup('user15@example.com');
  const token = tokenFromLastMessage();
  const res = await callVerify(token);
  assert.equal(res.status, 200);
});

// ---- trusted-host policy -------------------------------------------

await test('HOSTILE HOST: a spoofed X-Forwarded-Host never leaks into the verification URL', async () => {
  sentMessages.length = 0;
  const { cookie } = await signup('host1@example.com');
  const uid = await userIdByEmail('host1@example.com');
  await clearCooldown(uid);
  const res = await callSend(cookie, { extraHeaders: { 'x-forwarded-host': 'attacker.example.com' } });
  assert.equal(res.status, 200);
  assert.match(sentMessages.at(-1).verificationUrl, /^http:\/\/localhost\//, 'the spoofed host was ignored; only the trusted request host is used');
  assert.equal(sentMessages.at(-1).verificationUrl.includes('attacker.example.com'), false);
});

await test('HOSTILE HOST: a request whose canonical host is untrusted is REFUSED — no URL minted, no NEW challenge', async () => {
  const { cookie } = await signup('host2@example.com');
  const uid = await userIdByEmail('host2@example.com');
  await clearCooldown(uid);
  sentMessages.length = 0; // ignore the signup dispatch — we only care about the hostile /send call
  const challengeCountBefore = (await challengesFor(uid)).length;
  // The whole request appears to come from attacker.example.com.
  const hostIp = nextIp('host');
  await resetEmailVerificationRateForTest(hostIp);
  const req = new Request('https://attacker.example.com/api/auth/email-verification/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': hostIp,
      'x-forwarded-host': 'attacker.example.com',
      host: 'attacker.example.com',
      cookie: `tp_session_v1=${cookie}`,
    },
  });
  const res = await sendRoute.POST(req);
  assert.equal(res.status, 503, 'ambiguous/untrusted host → refuse rather than mint a token URL');
  assert.equal(sentMessages.length, 0, 'no verification message was produced');
  assert.equal((await challengesFor(uid)).length, challengeCountBefore, 'the refused request issued no new challenge');
});

await test('HOST POLICY: an exact Vercel system host is trusted; an arbitrary *.vercel.app is not', async () => {
  process.env.VERCEL = '1';
  process.env.VERCEL_URL = 'turnitplus-a3.vercel.app';
  try {
    sentMessages.length = 0;
    const { cookie } = await signup('host3@example.com');
    const uid = await userIdByEmail('host3@example.com');
    await clearCooldown(uid);

    // exact match against VERCEL_URL -> trusted, https
    const okRes = await callSend(cookie, {
      url: 'https://turnitplus-a3.vercel.app/api/auth/email-verification/send',
      extraHeaders: { 'x-forwarded-host': 'turnitplus-a3.vercel.app', host: 'turnitplus-a3.vercel.app' },
    });
    assert.equal(okRes.status, 200);
    assert.match(sentMessages.at(-1).verificationUrl, /^https:\/\/turnitplus-a3\.vercel\.app\/verify-email\?token=/);

    await clearCooldown(uid);
    // a DIFFERENT *.vercel.app is NOT trusted just for the suffix
    sentMessages.length = 0;
    const badRes = await callSend(cookie, {
      url: 'https://evil-a3.vercel.app/api/auth/email-verification/send',
      extraHeaders: { 'x-forwarded-host': 'evil-a3.vercel.app', host: 'evil-a3.vercel.app' },
    });
    assert.equal(badRes.status, 503, 'an arbitrary *.vercel.app host is refused');
    assert.equal(sentMessages.length, 0);
  } finally {
    delete process.env.VERCEL;
    delete process.env.VERCEL_URL;
  }
});

await test('HOST POLICY: VERCEL_BRANCH_URL exact host is trusted; a similar/spoofed branch host and an arbitrary *.vercel.app are not', async () => {
  process.env.VERCEL = '1';
  process.env.VERCEL_BRANCH_URL = 'turnitplus-git-test-corpus-admission-team.vercel.app';
  try {
    const { cookie } = await signup('host4@example.com');
    const uid = await userIdByEmail('host4@example.com');

    // exact VERCEL_BRANCH_URL host -> accepted (https)
    await clearCooldown(uid);
    sentMessages.length = 0;
    const okRes = await callSend(cookie, {
      url: 'https://turnitplus-git-test-corpus-admission-team.vercel.app/api/auth/email-verification/send',
      extraHeaders: {
        'x-forwarded-host': 'turnitplus-git-test-corpus-admission-team.vercel.app',
        host: 'turnitplus-git-test-corpus-admission-team.vercel.app',
      },
    });
    assert.equal(okRes.status, 200);
    assert.match(sentMessages.at(-1).verificationUrl, /^https:\/\/turnitplus-git-test-corpus-admission-team\.vercel\.app\/verify-email\?token=/);

    // a SIMILAR / spoofed branch host (prefix, suffix, typo) -> refused
    for (const spoof of [
      'turnitplus-git-test-corpus-admission-team.vercel.app.evil.com',
      'evil-turnitplus-git-test-corpus-admission-team.vercel.app',
      'turnitplus-git-test-corpus-admission-team-x.vercel.app',
      'turnitplus-git-test-corpus-admission-tea.vercel.app',
    ]) {
      await clearCooldown(uid);
      sentMessages.length = 0;
      const res = await callSend(cookie, {
        url: `https://${spoof}/api/auth/email-verification/send`,
        extraHeaders: { 'x-forwarded-host': spoof, host: spoof },
      });
      assert.equal(res.status, 503, `similar/spoofed branch host "${spoof}" must be refused`);
      assert.equal(sentMessages.length, 0);
    }

    // an unrelated *.vercel.app -> refused
    await clearCooldown(uid);
    sentMessages.length = 0;
    const arb = await callSend(cookie, {
      url: 'https://something-else.vercel.app/api/auth/email-verification/send',
      extraHeaders: { 'x-forwarded-host': 'something-else.vercel.app', host: 'something-else.vercel.app' },
    });
    assert.equal(arb.status, 503, 'an arbitrary *.vercel.app is not trusted for the suffix');
    assert.equal(sentMessages.length, 0);
  } finally {
    delete process.env.VERCEL;
    delete process.env.VERCEL_BRANCH_URL;
  }
});

// ---- signup challenge-delivery invariant --------------------------

await test('signup + provider SUCCESS: the challenge stays ACTIVE', async () => {
  sentMessages.length = 0;
  const { res } = await signup('deliver1@example.com');
  assert.equal(res.status, 201);
  const uid = await userIdByEmail('deliver1@example.com');
  const rows = await challengesFor(uid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].consumed_at, null);
  assert.equal(rows[0].revoked_at, null, 'delivered challenge is still active');
  assert.equal(sentMessages.length, 1);
  // and it actually verifies
  assert.equal((await callVerify(tokenFromLastMessage())).status, 200);
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

await test('signup + UNTRUSTED HOST: no URL minted, that exact challenge is REVOKED; account + session still succeed', async () => {
  sentMessages.length = 0;
  const { res, cookie } = await signup('deliver3@example.com', {
    url: 'https://attacker.example.com/api/auth/signup',
    extraHeaders: { 'x-forwarded-host': 'attacker.example.com', host: 'attacker.example.com' },
  });
  assert.equal(res.status, 201, 'signup still succeeds');
  assert.ok(cookie && cookie.length > 20, 'session cookie issued');
  assert.equal(sentMessages.length, 0, 'no verification message — the host was not trusted');

  const uid = await userIdByEmail('deliver3@example.com');
  const rows = await challengesFor(uid);
  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0].revoked_at) > 0, 'the undeliverable challenge was revoked');
  assert.equal(rows[0].consumed_at, null);

  const meBody = await (await callMe(cookie)).json();
  assert.equal(meBody.user.email, 'deliver3@example.com');
  assert.equal(meBody.emailVerification.status, 'unverified');
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
