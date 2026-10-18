// Truthful logout and account-switch revocation (security fix).
// L0–L6 are the regression cases of the logout-defect investigation (2026-10-18): on the
// unfixed code L1–L6 failed (catch-all {ok:true}, shared 429, no `revoked`, old session left
// live by a re-login). Local libsql file fixtures only; L2 uses a closed loopback port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as logoutRoute from '../app/api/auth/logout/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { hashToken } from '../lib/auth-session.ts';
import { checkRate, checkLogoutRate, resetAuthRateForTest, resetRateForTest, resetLogoutRateForTest } from '../lib/rate-limit.js';
import { withTestIdentity } from './helpers/test-signup.mjs';

// All database setup resolves before the first test() is registered (see the
// node:test top-level-await race these suites are prone to).
const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_auth_logout_revocation.db');
const otherDbFile = path.join(repo, 'test_auth_logout_revocation_other.db');
function removeDb(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(`${file}${suffix}`); } catch { /* absent */ }
  }
}
removeDb(dbFile);
removeDb(otherDbFile);
const dbUrl = `file:${dbFile}`;
const otherDbUrl = `file:${otherDbFile}`;
process.env.TURSO_DATABASE_URL = dbUrl;
for (const url of [dbUrl, otherDbUrl]) {
  const setup = createClient({ url });
  await applyMigrationsLibsql(setup, drizzleDir);
  setup.close();
}

after(() => {
  removeDb(dbFile);
  removeDb(otherDbFile);
});

async function sql(query, args = [], url = dbUrl) {
  const client = createClient({ url });
  try {
    return (await client.execute({ sql: query, args })).rows;
  } finally {
    client.close();
  }
}

function cookieFrom(response) {
  return (response.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
}

function expiresCookie(response) {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return /tp_session_v1=;/.test(setCookie) && /Max-Age=0/i.test(setCookie);
}

let seq = 0;
function request(pathname, { method = 'POST', ip, cookie, body, host = 'localhost' } = {}) {
  const headers = { 'x-forwarded-for': ip ?? `logout-rev-${++seq}` };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://${host}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function signup({ cookie } = {}) {
  const n = ++seq;
  const account = { email: `rev-${n}@example.com`, password: `correct-horse-${n}`, username: `rev${n}` };
  const ip = `logout-rev-signup-${n}`;
  await resetAuthRateForTest(ip);
  const res = await signupRoute.POST(request('/api/auth/signup', { ip, cookie, body: withTestIdentity({ ...account, deviceKey: `rev-device-${n}` }) }));
  return { res, ...account, cookie: cookieFrom(res) };
}

async function newAccount() {
  const created = await signup();
  assert.equal(created.res.status, 201, 'fixture signup');
  return created;
}

async function login(email, password, { cookie } = {}) {
  const ip = `logout-rev-login-${++seq}`;
  await resetAuthRateForTest(ip);
  const res = await loginRoute.POST(request('/api/auth/login', { ip, cookie, body: { email, password, deviceKey: `rev-login-${seq}`, remember: true } }));
  return { res, cookie: cookieFrom(res) };
}

async function logout(cookie, { ip, resetRate = true, host } = {}) {
  const clientIp = ip ?? `logout-rev-out-${++seq}`;
  if (resetRate) await resetLogoutRateForTest(clientIp);
  const res = await logoutRoute.POST(request('/api/auth/logout', { ip: clientIp, cookie, host }));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { res, status: res.status, body, text, setCookie: res.headers.get('set-cookie'), expires: expiresCookie(res) };
}

async function signedInUser(cookie) {
  const ip = `logout-rev-me-${++seq}`;
  await resetRateForTest(ip);
  const res = await meRoute.GET(request('/api/auth/me', { method: 'GET', ip, cookie }));
  return (await res.json()).user ?? null;
}

async function sessionRow(token, url = dbUrl) {
  return (await sql('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', [hashToken(token)], url))[0] ?? null;
}

async function withTrigger(ddl, name, fn) {
  const client = createClient({ url: dbUrl });
  await client.execute(ddl);
  try {
    return await fn();
  } finally {
    await client.execute(`DROP TRIGGER ${name}`);
    client.close();
  }
}

async function captureConsoleError(fn) {
  const captured = [];
  const original = console.error;
  console.error = (...args) => { captured.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), logs: captured.join('\n') };
  } finally {
    console.error = original;
  }
}

function assertNoInternalDetail(r, token) {
  for (const leak of [token, hashToken(token), 'injected', 'sqlite', 'libsql', 'SQLITE', '127.0.0.1', 'ECONNREFUSED', 'Error:']) {
    assert.ok(!r.text.includes(leak), `response must not expose ${JSON.stringify(leak.slice(0, 12))}: ${r.text}`);
  }
}

const FAILED_BODY = { ok: false, revoked: false, outcome: 'failed', error: 'Sign-out could not be completed. Please try again.' };
const deleteFailure = ['CREATE TRIGGER logout_rev_delete_fails BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, \'injected delete failure\'); END', 'logout_rev_delete_fails'];
const insertFailure = ['CREATE TRIGGER logout_rev_insert_fails BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, \'injected insert failure\'); END', 'logout_rev_insert_fails'];

test('L0 same-host logout revokes the live session and expires the cookie', async () => {
  const a = await newAccount();
  assert.ok(await sessionRow(a.cookie));
  const r = await logout(a.cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, revoked: true, outcome: 'revoked' });
  assert.ok(r.expires, 'cookie expired');
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.equal(await sessionRow(a.cookie), null);
  assert.equal(await signedInUser(a.cookie), null, 'the old token no longer authenticates');
});

test('L1 a failed session DELETE is a 503, keeps the cookie and the session, and leaks nothing', async () => {
  const a = await newAccount();
  const { result: r, logs } = await captureConsoleError(() => withTrigger(...deleteFailure, () => logout(a.cookie)));
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, FAILED_BODY);
  assert.equal(r.setCookie, null, 'no Set-Cookie: the cookie stays for a retry');
  assertNoInternalDetail(r, a.cookie);
  assert.match(logs, /logout failed \(session delete\)/, 'the failure is still logged server-side');
  assert.ok(!logs.includes(a.cookie) && !logs.includes(hashToken(a.cookie)), 'the server log never carries the token');
  assert.ok(await signedInUser(a.cookie), 'fact: the session is still valid, so success must not be claimed');
  const retry = await logout(a.cookie);
  assert.deepEqual(retry.body, { ok: true, revoked: true, outcome: 'revoked' }, 'the kept cookie lets a retry revoke it');
});

test('L2 an unreachable database is a 503 that keeps the cookie and leaks nothing', async () => {
  const a = await newAccount();
  const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.RATE_LIMIT_TEST_DB_URL = dbUrl;
  process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:9';
  process.env.TURSO_AUTH_TOKEN = 'offline-test-placeholder';
  let r;
  try {
    ({ result: r } = await captureConsoleError(() => logout(a.cookie)));
  } finally {
    process.env.TURSO_DATABASE_URL = saved.url;
    delete process.env.RATE_LIMIT_TEST_DB_URL;
    if (saved.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = saved.token;
  }
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, FAILED_BODY);
  assert.equal(r.setCookie, null);
  assertNoInternalDetail(r, a.cookie);
  assert.ok(await signedInUser(a.cookie), 'session still valid');
});

test('L2b a failing rate-limit store is a 503 too, never a silent success', async () => {
  const a = await newAccount();
  process.env.RATE_LIMIT_TEST_DB_URL = 'http://127.0.0.1:9';
  let r;
  try {
    ({ result: r } = await captureConsoleError(() => logout(a.cookie, { resetRate: false })));
  } finally {
    delete process.env.RATE_LIMIT_TEST_DB_URL;
  }
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, FAILED_BODY);
  assert.equal(r.setCookie, null);
  assert.ok(await sessionRow(a.cookie));
});

test('L3 heavy dashboard/API traffic on the general bucket does not block logout', async () => {
  const a = await newAccount();
  const ip = 'logout-rev-dashboard';
  await resetRateForTest(ip);
  for (let i = 0; i < 25; i++) await checkRate(ip);
  assert.equal((await checkRate(ip)).allowed, false, 'precondition: the general bucket is exhausted');
  const r = await logout(a.cookie, { ip });
  assert.equal(r.status, 200);
  assert.equal(r.body.revoked, true);
  assert.equal(await sessionRow(a.cookie), null);
});

test('L3b only the dedicated logout bucket can rate-limit logout; a 429 keeps cookie and session', async () => {
  const a = await newAccount();
  const ip = 'logout-rev-runaway';
  await resetLogoutRateForTest(ip);
  for (let i = 0; i < 30; i++) assert.equal((await checkLogoutRate(ip)).allowed, true, `logout token ${i + 1}/30`);
  const r = await logout(a.cookie, { ip, resetRate: false });
  assert.equal(r.status, 429);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.outcome, 'rate_limited');
  assert.ok(Number(r.res.headers.get('retry-after')) > 0);
  assert.equal(r.setCookie, null);
  assert.ok(await signedInUser(a.cookie));
  assert.equal((await checkRate(`${ip}-general`)).allowed, true, 'the general bucket is untouched by logout');
});

test('L4 no cookie (another hostname / lost cookie): explicit revoked:false, idempotent 200', async () => {
  const a = await newAccount();
  const r = await logout(undefined);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, revoked: false, outcome: 'no_active_session' });
  assert.ok(await signedInUser(a.cookie), 'a session held elsewhere is untouched');
});

test('L5 revoked:true only when a live row was deleted; repeated logout is a safe no-op', async () => {
  const a = await newAccount();
  const first = await logout(a.cookie);
  assert.deepEqual(first.body, { ok: true, revoked: true, outcome: 'revoked' });
  for (let i = 0; i < 3; i++) {
    const again = await logout(a.cookie);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, revoked: false, outcome: 'no_active_session' }, `repeat ${i + 1}`);
    assert.ok(again.expires);
  }
});

test('L5b malformed, unknown and expired tokens are never reported as a revoked active session', async () => {
  const malformed = await logout('not-a-session-token');
  assert.deepEqual(malformed.body, { ok: true, revoked: false, outcome: 'no_active_session' });
  assert.ok(malformed.expires, 'a junk cookie is expired too');

  const unknown = await logout(randomBytes(32).toString('hex'));
  assert.deepEqual(unknown.body, { ok: true, revoked: false, outcome: 'no_active_session' });

  const a = await newAccount();
  const userId = (await sessionRow(a.cookie)).user_id;
  const expiredToken = randomBytes(32).toString('hex');
  await sql('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', [hashToken(expiredToken), userId, Date.now() - 2_000, Date.now() - 1_000]);
  const expired = await logout(expiredToken);
  assert.deepEqual(expired.body, { ok: true, revoked: false, outcome: 'no_active_session' });
  assert.equal(await sessionRow(expiredToken), null, 'the dead row is removed anyway');
  assert.ok(await signedInUser(a.cookie), 'the account\'s other session is untouched');
});

test('L5c concurrent logouts of one cookie: exactly one revocation, both succeed', async () => {
  const a = await newAccount();
  const results = await Promise.all([logout(a.cookie), logout(a.cookie)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.deepEqual(results.map((r) => r.body.revoked).sort(), [false, true]);
  assert.equal(await sessionRow(a.cookie), null);
});

test('L6 signing in as another account revokes the browser\'s previous session only', async () => {
  const a = await newAccount();
  const b = await newAccount();
  const aOtherBrowser = await login(a.email, a.password);
  const switched = await login(b.email, b.password, { cookie: a.cookie });
  assert.equal(switched.res.status, 200);
  assert.ok(switched.cookie && switched.cookie !== a.cookie);
  assert.equal(await sessionRow(a.cookie), null, 'the replaced session is revoked');
  assert.equal((await signedInUser(switched.cookie))?.email, b.email);
  assert.equal((await signedInUser(aOtherBrowser.cookie))?.email, a.email, 'account A\'s session in another browser is untouched');
  assert.equal((await signedInUser(b.cookie))?.email, b.email, 'account B\'s pre-existing session is untouched');
});

test('L6b re-login as the same account rotates the session; a junk cookie is ignored', async () => {
  const a = await newAccount();
  const again = await login(a.email, a.password, { cookie: a.cookie });
  assert.equal(again.res.status, 200);
  assert.equal(await sessionRow(a.cookie), null);
  assert.ok(await sessionRow(again.cookie));
  const junk = await login(a.email, a.password, { cookie: 'garbage' });
  assert.equal(junk.res.status, 200);
  assert.ok(await sessionRow(again.cookie), 'an unrelated session is never touched by a junk cookie');
});

test('L6c a failed replacement write fails the login and leaves the previous session exactly as it was', async () => {
  const a = await newAccount();
  const b = await newAccount();
  const { result: r } = await captureConsoleError(() => withTrigger(...insertFailure, () => login(b.email, b.password, { cookie: a.cookie })));
  assert.equal(r.res.status, 500);
  assert.equal(r.res.headers.get('set-cookie'), null, 'no new cookie, no switch claimed');
  const text = await r.res.text();
  assert.ok(!/injected|sqlite|libsql/i.test(text), `no internal detail: ${text}`);
  assert.equal((await signedInUser(a.cookie))?.email, a.email, 'the batch rolled back: A\'s session was not revoked');
});

test('L6d wrong password with a session cookie changes nothing', async () => {
  const a = await newAccount();
  const b = await newAccount();
  const r = await login(b.email, 'wrong-password', { cookie: a.cookie });
  assert.equal(r.res.status, 401);
  assert.ok(await sessionRow(a.cookie), 'a failed login never revokes the current session');
});

test('L6e signup while signed in revokes the previous session atomically; a failed signup keeps it', async () => {
  const a = await newAccount();
  const created = await signup({ cookie: a.cookie });
  assert.equal(created.res.status, 201);
  assert.equal(await sessionRow(a.cookie), null);
  assert.ok(await sessionRow(created.cookie));

  const c = await newAccount();
  await resetAuthRateForTest('logout-rev-dup');
  const duplicate = await signupRoute.POST(request('/api/auth/signup', { ip: 'logout-rev-dup', cookie: c.cookie, body: withTestIdentity({ email: c.email, password: 'another-password-1', username: 'dupe1', deviceKey: 'rev-dup' }) }));
  assert.equal(duplicate.status, 409);
  assert.ok(await sessionRow(c.cookie), 'a rejected signup keeps the current session');

  const { result: failed } = await captureConsoleError(() => withTrigger(...insertFailure, () => signup({ cookie: c.cookie })));
  assert.notEqual(failed.res.status, 201);
  assert.equal(failed.res.headers.get('set-cookie'), null);
  assert.ok(await sessionRow(c.cookie), 'the rolled-back batch did not revoke the current session');
});

test('L6f concurrent account switches and a racing logout never leave the replaced session live', async () => {
  const a = await newAccount();
  const b = await newAccount();
  const [first, second, out] = await Promise.all([
    login(b.email, b.password, { cookie: a.cookie }),
    login(b.email, b.password, { cookie: a.cookie }),
    logout(a.cookie),
  ]);
  assert.deepEqual([first.res.status, second.res.status, out.status], [200, 200, 200]);
  assert.equal(await sessionRow(a.cookie), null, 'the replaced session is gone whichever request won');
  assert.ok(await signedInUser(first.cookie) && await signedInUser(second.cookie), 'both replacement sessions are valid (documented limitation: the browser keeps only the last cookie)');
});

test('distinct hostnames and databases: each sign-out only revokes the session it can see', async () => {
  const a = await newAccount();
  const b = await newAccount();
  // Another hostname of the same database: the browser sends that host's own cookie only.
  const onOtherHost = await logout(b.cookie, { host: 'turnitplus-git-branch.example.app' });
  assert.equal(onOtherHost.body.revoked, true);
  assert.ok(await signedInUser(a.cookie), 'host A\'s session survives a sign-out on host B');
  // A different deployment database (e.g. Production vs Preview): the token is unknown there.
  process.env.TURSO_DATABASE_URL = otherDbUrl;
  let r;
  try {
    r = await logout(a.cookie);
  } finally {
    process.env.TURSO_DATABASE_URL = dbUrl;
  }
  assert.deepEqual(r.body, { ok: true, revoked: false, outcome: 'no_active_session' }, 'truthfully reports nothing revoked');
  assert.ok(await signedInUser(a.cookie), 'the session in the other database is untouched');
});

test.todo('L8 DEFERRED (owner policy decision): a remember=false browser-session cookie still gets a 30-day server session');
