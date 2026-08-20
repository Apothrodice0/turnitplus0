import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as logoutRoute from '../app/api/auth/logout/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_api_auth.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(body, ip = 'auth-test-signup') {
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return signupRoute.POST(req);
}

async function login(body, ip = 'auth-test-login') {
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return loginRoute.POST(req);
}

async function me(cookieValue, ip = 'auth-test-me') {
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookieValue) headers['cookie'] = `tp_session_v1=${cookieValue}`;
  const req = new Request('http://localhost/api/auth/me', { headers });
  return meRoute.GET(req);
}

async function logout(cookieValue, ip = 'auth-test-logout') {
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookieValue) headers['cookie'] = `tp_session_v1=${cookieValue}`;
  const req = new Request('http://localhost/api/auth/logout', { method: 'POST', headers });
  return logoutRoute.POST(req);
}

// 1. Signup happy path
{
  const res = await signup({ email: 'Alice@Example.com', password: 'correct-horse-1', username: 'alice', deviceKey: 'device-signup-1' });
  assert.equal(res.status, 201, 'signup should succeed');
  const body = await res.json();
  assert.deepEqual(body, { user: { username: 'alice', email: 'alice@example.com', corpusReuseConsent: false } }, 'response must only contain username/email/corpusReuseConsent, never a password or token');
  const cookie = extractCookie(res);
  assert.ok(cookie && cookie.length > 20, 'a session cookie must be set');

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT email, username, password_hash FROM users WHERE email = ?', args: ['alice@example.com'] });
  assert.equal(userRow.rows.length, 1, 'a user row must be created');
  assert.notEqual(userRow.rows[0].password_hash, 'correct-horse-1', 'password must never be stored in plain text');
  const sessionRow = await client.execute({ sql: 'SELECT token_hash FROM sessions WHERE token_hash = ?', args: [createHash('sha256').update(cookie, 'utf8').digest('hex')] });
  assert.equal(sessionRow.rows.length, 1, 'a session row must be created matching the issued cookie');
  client.close();

  const meRes = await me(cookie);
  const meBody = await meRes.json();
  assert.deepEqual(meBody, { user: { username: 'alice', email: 'alice@example.com', corpusReuseConsent: false } }, '/api/auth/me must reflect the new session');
  console.log('signup happy path passed');
}

// 2. Duplicate email signup
{
  const res = await signup({ email: 'alice@example.com', password: 'another-password-1', username: 'alice2', deviceKey: 'device-signup-2' });
  assert.equal(res.status, 409, 'duplicate email must be rejected');
  console.log('duplicate email signup rejected');
}

// 3 & 4. Login happy path, wrong password, unknown email (identical error)
{
  const good = await login({ email: 'alice@example.com', password: 'correct-horse-1', deviceKey: 'device-login-1' });
  assert.equal(good.status, 200);
  const goodBody = await good.json();
  assert.deepEqual(goodBody, { user: { username: 'alice', email: 'alice@example.com', corpusReuseConsent: false } });
  const goodCookie = extractCookie(good);
  assert.ok(goodCookie, 'login must set a session cookie');

  const wrongPassword = await login({ email: 'alice@example.com', password: 'totally-wrong', deviceKey: 'device-login-1' });
  const unknownEmail = await login({ email: 'nobody-here@example.com', password: 'whatever-1', deviceKey: 'device-login-1' });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  const wrongBody = await wrongPassword.json();
  const unknownBody = await unknownEmail.json();
  assert.deepEqual(wrongBody, unknownBody, 'wrong-password and unknown-email must return byte-identical error bodies (no enumeration signal)');
  assert.equal(wrongBody.error, 'Invalid email or password.');
  console.log('login happy path + identical error responses verified');
}

// 5. Logout clears the session row and cookie
{
  const loginRes = await login({ email: 'alice@example.com', password: 'correct-horse-1', deviceKey: 'device-logout-1' });
  const cookie = extractCookie(loginRes);

  const beforeClient = createClient({ url: `file:${dbFile}` });
  const before = await beforeClient.execute({ sql: 'SELECT token_hash FROM sessions WHERE token_hash = ?', args: [createHash('sha256').update(cookie, 'utf8').digest('hex')] });
  assert.equal(before.rows.length, 1);
  beforeClient.close();

  const logoutRes = await logout(cookie);
  assert.equal(logoutRes.status, 200);
  const setCookieHeader = logoutRes.headers.get('set-cookie') ?? '';
  assert.match(setCookieHeader, /Max-Age=0/, 'logout must clear the cookie');

  const afterClient = createClient({ url: `file:${dbFile}` });
  const after = await afterClient.execute({ sql: 'SELECT token_hash FROM sessions WHERE token_hash = ?', args: [createHash('sha256').update(cookie, 'utf8').digest('hex')] });
  assert.equal(after.rows.length, 0, 'the session row must be deleted on logout');
  afterClient.close();

  const meAfter = await me(cookie);
  assert.equal(meAfter.status, 200);
  const meAfterBody = await meAfter.json();
  assert.deepEqual(meAfterBody, { user: null }, 'a logged-out cookie must no longer resolve to a user');
  console.log('logout clears session row and cookie');
}

// 6. /api/auth/me is always well-behaved: no cookie, garbage cookie, expired cookie
{
  const noCookie = await me(null);
  assert.equal(noCookie.status, 200);
  assert.deepEqual(await noCookie.json(), { user: null });

  const garbageCookie = await me('not-a-real-token-at-all');
  assert.equal(garbageCookie.status, 200);
  assert.deepEqual(await garbageCookie.json(), { user: null });

  // Manually insert an already-expired session for a real user.
  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['alice@example.com'] });
  const userId = userRow.rows[0].id;
  const expiredToken = 'expired-raw-token-for-testing-only';
  const expiredHash = createHash('sha256').update(expiredToken, 'utf8').digest('hex');
  await client.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: [expiredHash, userId, Date.now() - 1000, Date.now() - 500],
  });
  client.close();

  const expiredRes = await me(expiredToken);
  assert.equal(expiredRes.status, 200);
  assert.deepEqual(await expiredRes.json(), { user: null }, 'an expired session must resolve as signed out, not 500');

  const cleanupClient = createClient({ url: `file:${dbFile}` });
  const remaining = await cleanupClient.execute({ sql: 'SELECT token_hash FROM sessions WHERE token_hash = ?', args: [expiredHash] });
  assert.equal(remaining.rows.length, 0, 'an expired session row must be opportunistically deleted on read');
  cleanupClient.close();

  console.log('/api/auth/me handles no/garbage/expired cookies without ever 500ing');
}

// 7. Auth rate limiting. Builds requests directly (not via the login()
// helper, which resets the bucket on every call to keep other sections
// independent) so attempts actually accumulate against the same bucket.
{
  const ip = 'auth-rate-limit-test';
  await resetAuthRateForTest(ip);
  let sawLimit = false;
  for (let i = 0; i < 10; i++) {
    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-1', deviceKey: 'device-rate-1' }),
    });
    const res = await loginRoute.POST(req);
    if (res.status === 429) {
      sawLimit = true;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(sawLimit, 'repeated login attempts from the same client must eventually be rate limited');
  console.log('auth rate limiting verified');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All auth API tests passed');
