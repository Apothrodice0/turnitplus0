import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';
import { __setEmailDeliveryProviderForTest } from '../lib/mail/email-delivery.ts';
import { __resetUsersEmailVerifiedAtColumnCacheForTest } from '../lib/email-verification.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * Regression for the A3 Preview bug: a logged-in account rendered "Complete
 * your identity profile" with blank fields even though it had a full identity
 * profile, and the email-verification control was missing.
 *
 * Root cause (fixed here): /api/auth/me GET read users.email_verified_at in the
 * SAME try/catch as the profile read, BEFORE it. When A3 code is live in an
 * environment where migration 0046 has not added that column, the SELECT threw
 * "no such column", the shared catch zeroed `identity`, and the profile read
 * never ran — for EVERY account, profiled or not.
 *
 * The two reads are now fully independent, and every users.email_verified_at /
 * challenge-table access degrades gracefully when 0046 is not applied. These
 * tests pin the /api/auth/me response contract — which is exactly what
 * app/page.tsx keys the "Edit information" vs "Complete your identity profile"
 * heading and the "Email not verified / Verify email" vs "Email verified" badge
 * off — for a profiled account AND a legacy profile-less account, in BOTH
 * schema states (0046 applied / not applied).
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');

__setEmailDeliveryProviderForTest({ async sendEmailVerification() { /* swallow */ } });

function freshDb(name) {
  const file = path.join(repo, name);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${file}${s}`); } catch { /* ignore */ } }
  return file;
}
function cleanupDb(file) {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${file}${s}`); } catch { /* ignore */ } }
}
async function applyMigrationsExcept(client, exclude) {
  const files = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql') && !exclude.includes(f)).sort();
  for (const f of files) await client.executeMultiple(fs.readFileSync(path.join(drizzleDir, f), 'utf8'));
}

let ipSeq = 0;
const nextIp = (l) => `me-id-${l}-${++ipSeq}`;
const cookieOf = (res) => {
  const m = (res.headers.get('set-cookie') || '').match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
};

async function signupWithCookie(email, opts) {
  const ip = nextIp('signup');
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username: opts?.username ?? 'meiduser', deviceKey: `dk-${ip}` })),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: cookieOf(res) };
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
  return meRoute.PATCH(new Request('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify(body),
  }));
}

// Insert a grandfathered account: users row + live session, NO identity profile.
async function seedLegacyAccount(dbFile, { id, email }) {
  const c = createClient({ url: `file:${dbFile}` });
  try {
    await c.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [id, email, `legacy-${id}`, 'not-a-hash'] });
    const rawToken = `legacy-token-${id}`;
    await c.execute({
      sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
      args: [createHash('sha256').update(rawToken, 'utf8').digest('hex'), id, Date.now(), Date.now() + 3_600_000],
    });
    return rawToken;
  } finally { c.close(); }
}

// ---- frontend-contract assertions (mirror app/page.tsx) ----------------
function assertRendersEditInformation(meBody, msg) {
  assert.ok(meBody.identity && typeof meBody.identity === 'object', `${msg}: identity must be a populated object -> heading "Identity details" / "Edit information"`);
  assert.ok(typeof meBody.identity.accountType === 'string' && meBody.identity.accountType.length > 0, `${msg}: identity.accountType present`);
}
function assertRendersCompletionState(meBody, msg) {
  assert.equal(meBody.identity, null, `${msg}: identity must be null -> heading "Complete your identity profile"`);
}
function assertEmailUnverifiedControl(meBody, msg) {
  assert.ok(meBody.emailVerification && meBody.emailVerification.status === 'unverified', `${msg}: emailVerification.status === "unverified" -> "Email not verified / Verify email"`);
}
function assertEmailVerifiedControl(meBody, msg) {
  assert.equal(meBody.emailVerification.status, 'verified', `${msg}: emailVerification.status === "verified" -> "Email verified"`);
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n       ') : e}`); }
}

// ======================================================================
// SECTION A — migration 0046 APPLIED (full schema)
// ======================================================================
{
  const dbFile = freshDb('test_me_identity_full.db');
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  __resetUsersEmailVerifiedAtColumnCacheForTest();
  const setup = createClient({ url: `file:${dbFile}` });
  await setup.execute('PRAGMA foreign_keys = ON');
  await applyMigrationsLibsql(setup, drizzleDir);
  setup.close();
  const db = createClient({ url: `file:${dbFile}` });
  await db.execute('PRAGMA foreign_keys = ON');

  await test('[0046 applied] profiled account -> me returns a populated identity + emailVerification, renders "Edit information" + "Email not verified"', async () => {
    const { res, cookie } = await signupWithCookie('profiled-full@example.com');
    assert.equal(res.status, 201);
    const meBody = await (await callMe(cookie)).json();
    assertRendersEditInformation(meBody, 'profiled/full');
    assert.equal(meBody.identity.accountType, 'independent');
    assert.equal(meBody.identity.emailVerified, undefined, 'identity carries no email-verification flag');
    assertEmailUnverifiedControl(meBody, 'profiled/full');
  });

  await test('[0046 applied] legacy profile-less account -> me returns identity: null + emailVerification, renders the completion state + "Email not verified"', async () => {
    const token = await seedLegacyAccount(dbFile, { id: 'legacy-full-1', email: 'legacy-full@example.com' });
    const meBody = await (await callMe(token)).json();
    assertRendersCompletionState(meBody, 'legacy/full');
    assert.equal(meBody.user.email, 'legacy-full@example.com');
    assertEmailUnverifiedControl(meBody, 'legacy/full');
  });

  await test('[0046 applied] a verified account renders the verified state', async () => {
    const token = await seedLegacyAccount(dbFile, { id: 'verified-1', email: 'verified@example.com' });
    await db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE id = ?', args: [Date.now(), 'verified-1'] });
    const meBody = await (await callMe(token)).json();
    assertEmailVerifiedControl(meBody, 'verified/full');
  });

  db.close();
  cleanupDb(dbFile);
}

// ======================================================================
// SECTION B — migration 0046 NOT APPLIED (users.email_verified_at + the
// challenge table are absent). This is the exact Preview failure window.
// ======================================================================
{
  const dbFile = freshDb('test_me_identity_pre46.db');
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  __resetUsersEmailVerifiedAtColumnCacheForTest();
  const setup = createClient({ url: `file:${dbFile}` });
  await setup.execute('PRAGMA foreign_keys = ON');
  await applyMigrationsExcept(setup, ['0046_email_verification_challenges.sql']);
  // sanity: the column/table really are absent
  const uc = (await setup.execute("PRAGMA table_info('users')")).rows.map((r) => String(r.name));
  assert.equal(uc.includes('email_verified_at'), false, 'precondition: users.email_verified_at absent');
  const tbls = (await setup.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='email_verification_challenges'")).rows;
  assert.equal(tbls.length, 0, 'precondition: email_verification_challenges table absent');
  setup.close();

  await test('[pre-0046] signup still creates the account + session (challenge INSERT omitted, no 400/500)', async () => {
    __resetUsersEmailVerifiedAtColumnCacheForTest();
    const { res, cookie } = await signupWithCookie('signup-pre46@example.com');
    assert.equal(res.status, 201, 'signup must not fail because 0046 is not applied');
    assert.ok(cookie && cookie.length > 20, 'a session cookie was still issued');
    const meBody = await (await callMe(cookie)).json();
    assert.equal(meBody.user.email, 'signup-pre46@example.com');
  });

  await test('[pre-0046] profiled account STILL renders "Edit information" — the profile read is not blocked by the missing column', async () => {
    __resetUsersEmailVerifiedAtColumnCacheForTest();
    const { res, cookie } = await signupWithCookie('profiled-pre46@example.com', { username: 'prof46' });
    assert.equal(res.status, 201);
    const meRes = await callMe(cookie);
    assert.equal(meRes.status, 200, 'me must not 500 when users.email_verified_at is missing');
    const meBody = await meRes.json();
    assertRendersEditInformation(meBody, 'profiled/pre-0046');  // <-- the regression that broke on Preview
    assert.equal(meBody.identity.accountType, 'independent');
    assertEmailUnverifiedControl(meBody, 'profiled/pre-0046');  // gracefully "unverified"
  });

  await test('[pre-0046] legacy profile-less account -> me: 200, identity null, emailVerification unverified', async () => {
    __resetUsersEmailVerifiedAtColumnCacheForTest();
    const token = await seedLegacyAccount(dbFile, { id: 'legacy-pre46-1', email: 'legacy-pre46@example.com' });
    const meRes = await callMe(token);
    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assertRendersCompletionState(meBody, 'legacy/pre-0046');
    assertEmailUnverifiedControl(meBody, 'legacy/pre-0046');
  });

  await test('[pre-0046] me PATCH (username + email change) succeeds without 500 and updates the email', async () => {
    __resetUsersEmailVerifiedAtColumnCacheForTest();
    const { cookie } = await signupWithCookie('patch-pre46@example.com', { username: 'patch46' });
    const patchRes = await callPatch(cookie, { username: 'patch46', email: 'patch-pre46-new@example.com' });
    assert.equal(patchRes.status, 200, 'PATCH must not 500 on the missing email_verified_at column');
    const patchBody = await patchRes.json();
    assert.equal(patchBody.user.email, 'patch-pre46-new@example.com', 'the email change still applied');
    assert.equal(patchBody.emailVerification.status, 'unverified');
    // and me still reflects it
    const meBody = await (await callMe(cookie)).json();
    assert.equal(meBody.user.email, 'patch-pre46-new@example.com');
    assertRendersEditInformation(meBody, 'patch/pre-0046');
  });

  cleanupDb(dbFile);
}

// ======================================================================
// SECTION C — structural: app/page.tsx keys the two UI states off exactly
// the fields the API returns.
// ======================================================================
{
  const src = fs.readFileSync(path.join(repo, 'app/page.tsx'), 'utf8');
  await test('STRUCTURAL: page.tsx heading is driven by `accountIdentity` truthiness, and the email badge by `emailVerification?.status` (see tests/account-page-email-verification-render.test.mjs for the real render + the login/signup re-hydration wiring)', () => {
    const componentSrc = fs.readFileSync(path.join(repo, 'components/account/email-verification-status.tsx'), 'utf8');
    assert.match(src, /accountIdentity \? "Identity details" : "Complete your identity profile"/, 'heading toggles on accountIdentity');
    assert.match(src, /<EmailVerificationStatus\s+status=\{emailVerification\?\.status \?\? null\}/, 'the account hero drives the extracted component from emailVerification.status');
    assert.match(componentSrc, /status === "verified"/, 'verified badge branch');
    assert.match(componentSrc, /status === "unverified"/, 'unverified branch with the Verify email button');
    assert.match(src, /setEmailVerification\(result\.emailVerification \?\? null\)/, 'me response emailVerification is stored into state');
    assert.match(src, /setAccountIdentity\(result\.identity \?\? null\)/, 'me response identity is stored into state');
  });
}

// ======================================================================
if (failures > 0) {
  console.error(`\naccount-me-identity-rendering: ${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll account-me-identity-rendering tests passed');
