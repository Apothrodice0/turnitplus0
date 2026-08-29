import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import * as developerReportsRoute from '../app/api/developer/reports/route.ts';
import * as developerReportIdRoute from '../app/api/developer/reports/[id]/route.ts';
import * as developerLookupRoute from '../app/api/developer/lookup/route.ts';
import * as developerDeviceShadowRoute from '../app/api/developer/device-provenance-shadow/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';

// Verifies the developer/admin role mechanism end to end:
//  - a brand-new account defaults to role="user" and never gets developer access
//  - ADMIN_EMAIL (read in exactly one place — lib/admin-role.ts) is the only
//    way an account is ever promoted, is scoped to that one exact address,
//    is idempotent, and does not itself demote when unset later
//  - every /api/developer/* route returns a plain 404 (never 401/403,
//    never any body) for both "no session" and "signed in but not admin" —
//    so the route's existence is never revealed to an ordinary account
//  - /api/auth/me never leaks the role field to the client

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_developer_role_authorization.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(body, ip) {
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return signupRoute.POST(req);
}

async function login(body, ip) {
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return loginRoute.POST(req);
}

async function me(cookieValue, ip) {
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookieValue) headers['cookie'] = `tp_session_v1=${cookieValue}`;
  return meRoute.GET(new Request('http://localhost/api/auth/me', { headers }));
}

function developerRequest(url, cookieValue, ip) {
  const headers = { 'x-forwarded-for': ip };
  if (cookieValue) headers['cookie'] = `tp_session_v1=${cookieValue}`;
  return new Request(url, { headers });
}

async function roleOf(email) {
  const client = createClient({ url: `file:${dbFile}` });
  const result = await client.execute({ sql: 'SELECT role FROM users WHERE email = ?', args: [email] });
  client.close();
  return result.rows[0]?.role ?? null;
}

// 1. A brand-new account defaults to role="user" with ADMIN_EMAIL unset.
{
  const res = await signup({ email: 'plain-user@example.com', password: 'correct-horse-1', username: 'plainuser', deviceKey: 'device-plain-1' }, 'dev-role-signup-plain');
  assert.equal(res.status, 201);
  assert.equal(await roleOf('plain-user@example.com'), 'user', 'a fresh signup must default to role=user');
  console.log('fresh signup defaults to role=user');
}

// 2. Signing up with the exact ADMIN_EMAIL address promotes the account to admin immediately.
{
  process.env.ADMIN_EMAIL = 'Developer@Example.com';
  const res = await signup({ email: 'developer@example.com', password: 'correct-horse-2', username: 'devaccount', deviceKey: 'device-dev-1' }, 'dev-role-signup-admin');
  assert.equal(res.status, 201);
  assert.equal(await roleOf('developer@example.com'), 'admin', 'signup with the configured ADMIN_EMAIL must promote the account to admin, case-insensitively');
  console.log('signup with ADMIN_EMAIL promotes to admin');
}

// 3. Promotion is scoped to the exact configured address — a different account never gets promoted.
{
  const res = await signup({ email: 'someone-else@example.com', password: 'correct-horse-3', username: 'someoneelse', deviceKey: 'device-other-1' }, 'dev-role-signup-other');
  assert.equal(res.status, 201);
  assert.equal(await roleOf('someone-else@example.com'), 'user', 'ADMIN_EMAIL must never promote any account other than the exact configured address');
  console.log('promotion is scoped to the exact configured address');
}

// 4. Idempotent: logging in again with the admin address does not error and role stays admin.
{
  const res = await login({ email: 'developer@example.com', password: 'correct-horse-2', deviceKey: 'device-dev-1' }, 'dev-role-login-admin-1');
  assert.equal(res.status, 200);
  assert.equal(await roleOf('developer@example.com'), 'admin', 'repeated login must not error and must leave role=admin unchanged');
  console.log('repeated admin login is idempotent');
}

// 5. Unsetting ADMIN_EMAIL later does not itself demote an already-promoted account.
{
  delete process.env.ADMIN_EMAIL;
  const res = await login({ email: 'developer@example.com', password: 'correct-horse-2', deviceKey: 'device-dev-1' }, 'dev-role-login-admin-2');
  assert.equal(res.status, 200);
  assert.equal(await roleOf('developer@example.com'), 'admin', 'unsetting ADMIN_EMAIL must not demote an already-promoted account');
  console.log('unsetting ADMIN_EMAIL does not demote an existing admin');
}

// 6. /api/auth/me never leaks the role field, for either a plain user or the admin account.
{
  const plainLogin = await login({ email: 'plain-user@example.com', password: 'correct-horse-1', deviceKey: 'device-plain-1' }, 'dev-role-me-plain');
  const plainCookie = extractCookie(plainLogin);
  const plainMe = await me(plainCookie, 'dev-role-me-plain-2');
  const plainMeBody = await plainMe.json();
  assert.deepEqual(Object.keys(plainMeBody.user).sort(), ['corpusReuseConsent', 'email', 'username'], '/api/auth/me must never include a role field');

  const adminLogin = await login({ email: 'developer@example.com', password: 'correct-horse-2', deviceKey: 'device-dev-1' }, 'dev-role-me-admin');
  const adminCookie = extractCookie(adminLogin);
  const adminMe = await me(adminCookie, 'dev-role-me-admin-2');
  const adminMeBody = await adminMe.json();
  assert.deepEqual(Object.keys(adminMeBody.user).sort(), ['corpusReuseConsent', 'email', 'username'], '/api/auth/me must never include a role field, even for an admin account');
  console.log('/api/auth/me never leaks the role field');
}

// 7. Every /api/developer/* route: no session -> 404, non-admin session -> 404, admin session -> 200.
{
  const plainLogin = await login({ email: 'plain-user@example.com', password: 'correct-horse-1', deviceKey: 'device-plain-1' }, 'dev-role-routes-plain');
  const plainCookie = extractCookie(plainLogin);
  const adminLogin = await login({ email: 'developer@example.com', password: 'correct-horse-2', deviceKey: 'device-dev-1' }, 'dev-role-routes-admin');
  const adminCookie = extractCookie(adminLogin);

  await resetRateForTest('dev-role-routes-noauth-1');
  await resetRateForTest('dev-role-routes-noauth-2');
  await resetRateForTest('dev-role-routes-noauth-3');
  await resetRateForTest('dev-role-routes-noauth-4');
  const noSessionReports = await developerReportsRoute.GET(developerRequest('http://localhost/api/developer/reports', null, 'dev-role-routes-noauth-1'));
  const noSessionReportId = await developerReportIdRoute.GET(developerRequest('http://localhost/api/developer/reports/whatever?deviceKey=x', null, 'dev-role-routes-noauth-2'), { params: Promise.resolve({ id: 'whatever' }) });
  const noSessionLookup = await developerLookupRoute.GET(developerRequest('http://localhost/api/developer/lookup?q=whatever', null, 'dev-role-routes-noauth-3'));
  const noSessionDeviceShadow = await developerDeviceShadowRoute.GET(developerRequest('http://localhost/api/developer/device-provenance-shadow', null, 'dev-role-routes-noauth-4'));
  assert.equal(noSessionReports.status, 404, 'no session must 404, not 401');
  assert.equal(noSessionReportId.status, 404);
  assert.equal(noSessionLookup.status, 404);
  assert.equal(noSessionDeviceShadow.status, 404, 'device-provenance-shadow measurement must 404 for no session');
  assert.equal((await noSessionDeviceShadow.text()).length, 0, 'no body for a non-admin');

  await resetRateForTest('dev-role-routes-plain-1');
  await resetRateForTest('dev-role-routes-plain-2');
  await resetRateForTest('dev-role-routes-plain-3');
  await resetRateForTest('dev-role-routes-plain-4');
  const plainReports = await developerReportsRoute.GET(developerRequest('http://localhost/api/developer/reports', plainCookie, 'dev-role-routes-plain-1'));
  const plainReportId = await developerReportIdRoute.GET(developerRequest('http://localhost/api/developer/reports/whatever?deviceKey=x', plainCookie, 'dev-role-routes-plain-2'), { params: Promise.resolve({ id: 'whatever' }) });
  const plainLookup = await developerLookupRoute.GET(developerRequest('http://localhost/api/developer/lookup?q=whatever', plainCookie, 'dev-role-routes-plain-3'));
  const plainDeviceShadow = await developerDeviceShadowRoute.GET(developerRequest('http://localhost/api/developer/device-provenance-shadow', plainCookie, 'dev-role-routes-plain-4'));
  assert.equal(plainReports.status, 404, 'a signed-in non-admin must also 404, indistinguishable from no session');
  assert.equal(plainReportId.status, 404);
  assert.equal(plainLookup.status, 404);
  assert.equal(plainDeviceShadow.status, 404, 'a signed-in non-admin must not reach the device-provenance-shadow measurement');
  assert.equal((await plainDeviceShadow.text()).length, 0);

  await resetRateForTest('dev-role-routes-admin-1');
  await resetRateForTest('dev-role-routes-admin-2');
  await resetRateForTest('dev-role-routes-admin-3');
  const adminReports = await developerReportsRoute.GET(developerRequest('http://localhost/api/developer/reports', adminCookie, 'dev-role-routes-admin-1'));
  assert.equal(adminReports.status, 200, 'an admin session must be able to reach the developer overview route');
  const adminReportsBody = await adminReports.json();
  assert.ok(Array.isArray(adminReportsBody.reports), 'the developer overview route must return a reports array for an admin');

  const adminLookup = await developerLookupRoute.GET(developerRequest('http://localhost/api/developer/lookup?q=plain-user', adminCookie, 'dev-role-routes-admin-2'));
  assert.equal(adminLookup.status, 200, 'an admin session must be able to reach the lookup route');

  const adminDeviceShadow = await developerDeviceShadowRoute.GET(developerRequest('http://localhost/api/developer/device-provenance-shadow', adminCookie, 'dev-role-routes-admin-3'));
  assert.equal(adminDeviceShadow.status, 200, 'an admin session must be able to reach the device-provenance-shadow measurement');
  const adminDeviceShadowBody = await adminDeviceShadow.json();
  assert.equal(typeof adminDeviceShadowBody.totals.evaluations, 'number', 'the measurement route must return a totals object for an admin');

  console.log('/api/developer/* routes are gated correctly (404/404/200)');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All developer role authorization tests passed');
