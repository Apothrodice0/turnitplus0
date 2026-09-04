import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';
import { __setEmailDeliveryProviderForTest } from '../lib/mail/email-delivery.ts';
import { EmailVerificationStatus } from '../components/account/email-verification-status.tsx';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * Regression for the REAL bug (confirmed against the deployed commit cc30b87
 * on the exact READY Preview build): the account page's "Email not verified /
 * Verify email" control was never a server/API/deployment problem — /api/auth/me
 * always returned `emailVerification`. The bug is in app/page.tsx's CLIENT
 * STATE WIRING: POST /api/auth/login and /api/auth/signup return only `user`;
 * the in-page auth-submit handler did `setAccount(data.user)` and nothing else,
 * so `emailVerification` (and `accountIdentity`) stayed at their logged-out
 * `null` value for the rest of the session — the /api/auth/me fetch that would
 * have populated them only ran once, in a `useEffect(..., [])` at page MOUNT,
 * before the user had signed in. A hard refresh (which re-runs the mount
 * effect) "fixed" it, which is why it looked like a deployment/staleness issue.
 *
 * Fix: app/page.tsx now re-hydrates `account` + `accountIdentity` +
 * `emailVerification` from /api/auth/me immediately after a successful
 * login/signup (see hydrateAccountFromServer / its call in the auth-submit
 * handler), not only at mount.
 *
 * This file exercises the REAL render path for the email-verification control
 * (components/account/email-verification-status.tsx, extracted from
 * app/page.tsx's account hero so it can be rendered in isolation — the repo has
 * no jsdom/click-simulation infra to mount the full client page) fed with the
 * REAL /api/auth/me JSON produced by the real routes against a real DB, for:
 *   - a legacy, profile-less account
 *   - a profiled (structured-signup) account
 *   - a verified account
 * plus a minimal structural check that page.tsx actually wires the two
 * together (which the render-only tests above cannot see, since they render
 * the extracted component directly rather than mounting <Home/>).
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_account_page_email_verification_render.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

__setEmailDeliveryProviderForTest({ async sendEmailVerification() { /* swallow — not under test here */ } });

const setup = createClient({ url: `file:${dbFile}` });
await setup.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(setup, drizzleDir);
setup.close();

const db = createClient({ url: `file:${dbFile}` });
await db.execute('PRAGMA foreign_keys = ON');

let ipSeq = 0;
const nextIp = (l) => `me-render-${l}-${++ipSeq}`;
const cookieOf = (res) => {
  const m = (res.headers.get('set-cookie') || '').match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
};

async function signup(email, username) {
  const ip = nextIp('signup');
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username, deviceKey: `dk-${ip}` })),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: cookieOf(res), body: await res.clone().json() };
}
async function login(email, password) {
  const ip = nextIp('login');
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  });
  const res = await loginRoute.POST(req);
  return { res, cookie: cookieOf(res), body: await res.clone().json() };
}
async function callMe(cookie) {
  const ip = nextIp('me');
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const res = await meRoute.GET(new Request('http://localhost/api/auth/me', { headers }));
  return res.json();
}
async function seedLegacyAccount({ id, email }) {
  await db.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [id, email, `legacy-${id}`, 'not-a-hash'] });
  const rawToken = `legacy-render-token-${id}`;
  await db.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: [createHash('sha256').update(rawToken, 'utf8').digest('hex'), id, Date.now(), Date.now() + 3_600_000],
  });
  return rawToken;
}

// Render the REAL component with the REAL API-derived status — exactly what
// app/page.tsx's account hero passes it.
function renderStatus(status) {
  return renderToStaticMarkup(
    React.createElement(EmailVerificationStatus, { status, onVerify: () => {}, sending: false, notice: null }),
  );
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n       ') : e}`); }
}

// ======================================================================

await test('the /api/auth/login response carries only `user` — no emailVerification, no identity (this is WHY the old client code that only did setAccount(data.user) broke)', async () => {
  await signup('login-contract@example.com', 'logincontract');
  const { res, body } = await login('login-contract@example.com', 'correct-horse-1');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['user']);
  assert.equal(body.emailVerification, undefined);
  assert.equal(body.identity, undefined);
});

await test('LEGACY / profile-less account, unverified: /api/auth/me -> real render shows "Email not verified" + "Verify email"', async () => {
  const token = await seedLegacyAccount({ id: 'render-legacy-1', email: 'render-legacy@example.com' });
  const meBody = await callMe(token);
  assert.equal(meBody.identity, null, 'precondition: genuinely profile-less');
  assert.equal(meBody.emailVerification.status, 'unverified');

  const html = renderStatus(meBody.emailVerification.status);
  assert.match(html, /Email not verified/);
  assert.match(html, />\s*Verify email\s*<\/button>|Verify email/);
  assert.doesNotMatch(html, /Email verified\b/);
});

await test('PROFILED (structured-signup) account, unverified: /api/auth/me -> real render STILL shows "Email not verified" + "Verify email" — the profile must not suppress it', async () => {
  const { cookie } = await signup('render-profiled@example.com', 'renderprofiled');
  const meBody = await callMe(cookie);
  assert.ok(meBody.identity && meBody.identity.accountType, 'precondition: genuinely profiled');
  assert.equal(meBody.emailVerification.status, 'unverified');

  const html = renderStatus(meBody.emailVerification.status);
  assert.match(html, /Email not verified/);
  assert.match(html, /Verify email/);
  assert.doesNotMatch(html, /Email verified\b/);
});

await test('VERIFIED account: /api/auth/me -> real render shows "Email verified", no Verify-email button', async () => {
  const { cookie, body: signupBody } = await signup('render-verified@example.com', 'renderverified');
  void signupBody;
  const uid = (await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['render-verified@example.com'] })).rows[0].id;
  await db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE id = ?', args: [Date.now(), uid] });

  const meBody = await callMe(cookie);
  assert.equal(meBody.emailVerification.status, 'verified');

  const html = renderStatus(meBody.emailVerification.status);
  assert.match(html, /Email verified/);
  assert.doesNotMatch(html, /Verify email/);
  assert.doesNotMatch(html, /<button/);
});

await test('the null (not-yet-hydrated) state renders nothing — proves the control depends on a populated status, not merely "logged in"', () => {
  const html = renderStatus(null);
  assert.equal(html, '', 'no verification line, no button, until emailVerification is actually populated');
});

// ---- structural: the wiring page.tsx must have so the above is reachable ----
await test('STRUCTURAL: page.tsx re-hydrates identity + emailVerification from /api/auth/me after login/signup (not only at mount), and the account hero renders the real component', () => {
  const src = fs.readFileSync(path.join(repo, 'app/page.tsx'), 'utf8');

  // The auth-submit handler must not stop at setAccount(data.user) — it must
  // also pull identity/emailVerification from the server, since the login/
  // signup response does not carry them (proven above).
  const setAccountIdx = src.indexOf('setAccount(data.user as LocalAccount);');
  assert.ok(setAccountIdx >= 0, 'expected the post-auth setAccount(data.user) call');
  const afterSetAccount = src.slice(setAccountIdx, setAccountIdx + 700);
  assert.match(afterSetAccount, /hydrateAccountFromServer\(\)/, 'the auth-submit handler must re-hydrate from /api/auth/me after setAccount(data.user)');

  // hydrateAccountFromServer itself must populate all three from /api/auth/me.
  const hydrateIdx = src.indexOf('async function hydrateAccountFromServer(');
  assert.ok(hydrateIdx >= 0, 'expected a hydrateAccountFromServer function');
  const hydrateBody = src.slice(hydrateIdx, hydrateIdx + 1200);
  assert.match(hydrateBody, /fetch\("\/api\/auth\/me"\)/);
  assert.match(hydrateBody, /setAccountIdentity\(result\.identity \?\? null\)/);
  assert.match(hydrateBody, /setEmailVerification\(result\.emailVerification \?\? null\)/);

  // The mount effect must use the SAME hydration path (single source of truth).
  assert.match(src, /await hydrateAccountFromServer\(\)/);

  // And the account hero renders the real, extracted component — not a
  // reimplementation — driven by that same state.
  assert.match(src, /<EmailVerificationStatus\s+status=\{emailVerification\?\.status \?\? null\}/);
});

// ======================================================================

db.close();
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }

if (failures > 0) {
  console.error(`\naccount-page-email-verification-render: ${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll account-page-email-verification-render tests passed');
