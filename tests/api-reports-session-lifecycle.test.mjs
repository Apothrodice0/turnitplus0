import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as logoutRoute from '../app/api/auth/logout/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';

// This file covers the session-lifecycle guarantees behind the logout/
// report-history bug fix: logging out must never delete server-side data,
// logging back in must restore exactly what was there, and two distinct
// accounts (not just two devices on the same account) must never see each
// other's reports. tests/api-reports-account-scoping.test.mjs already covers
// the claim mechanism and same-account cross-device access in depth; this
// file deliberately does not repeat that ground.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_api_reports_session_lifecycle.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

let counter = 0;
function nextId() {
  counter += 1;
  return `lifecycle-report-${counter}`;
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function postReport(deviceKey, { cookie, id, title = 'lifecycle.pdf' } = {}) {
  await resetRateForTest('lifecycle-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'lifecycle-post' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: 'sub-' + reportId,
      title,
      createdAt: new Date().toISOString(),
      wordCount: 10,
      archiveScore: 0,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload: { note: title },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function listReports({ deviceKey, cookie } = {}) {
  await resetRateForTest('lifecycle-list');
  const headers = { 'x-forwarded-for': 'lifecycle-list' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}` : 'http://localhost/api/reports';
  const req = new Request(url, { headers });
  return reportsRoute.GET(req);
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('lifecycle-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'lifecycle-signup-' + email },
    body: JSON.stringify({ email, password: 'lifecycle-password-1', username: 'lifecycleuser', deviceKey }),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function login(email, deviceKey) {
  await resetAuthRateForTest('lifecycle-login-' + email);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'lifecycle-login-' + email },
    body: JSON.stringify({ email, password: 'lifecycle-password-1', deviceKey }),
  });
  const res = await loginRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function logout(cookie) {
  await resetRateForTest('lifecycle-logout');
  const headers = { 'x-forwarded-for': 'lifecycle-logout' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/auth/logout', { method: 'POST', headers });
  return logoutRoute.POST(req);
}

// 1. Authenticated user sees their own reports; 3+4. logout does not delete
// server-side reports, and logging back in restores them exactly.
{
  const { cookie: cookieA1 } = await signup('lifecycle-a@example.com', 'lifecycle-device-a');
  const { id: reportA1 } = await postReport('lifecycle-device-a', { cookie: cookieA1, title: 'first.pdf' });
  const { id: reportA2 } = await postReport('lifecycle-device-a', { cookie: cookieA1, title: 'second.pdf' });

  const beforeLogout = await listReports({ cookie: cookieA1 });
  const beforeLogoutBody = await beforeLogout.json();
  assert.equal(beforeLogoutBody.reports.length, 2, 'authenticated user must see both of their reports');
  console.log('authenticated user sees their reports: passed');

  const logoutRes = await logout(cookieA1);
  assert.equal(logoutRes.status, 200);

  // The old cookie must no longer resolve to a session server-side: with no
  // deviceKey supplied, the route must fall through to requiring one, not
  // silently keep treating the request as authenticated.
  const afterLogoutWithOldCookie = await listReports({ cookie: cookieA1 });
  assert.equal(afterLogoutWithOldCookie.status, 400, 'a logged-out cookie must no longer authenticate the request');

  const { res: reLoginRes, cookie: cookieA2 } = await login('lifecycle-a@example.com', 'lifecycle-device-a');
  assert.equal(reLoginRes.status, 200);
  assert.ok(cookieA2 && cookieA2 !== cookieA1, 're-login must issue a fresh session token, not resurrect the old one');

  const afterReLogin = await listReports({ cookie: cookieA2 });
  const afterReLoginBody = await afterReLogin.json();
  const idsAfter = afterReLoginBody.reports.map((r) => r.id).sort();
  assert.deepEqual(idsAfter, [reportA1, reportA2].sort(), 'logging back in must restore exactly the same reports — logout must not have deleted anything server-side');
  console.log('logout preserves server-side reports, and re-login restores them: passed');
}

// 5. Two distinct accounts (not two devices on the same account) must never
// see each other's reports.
{
  const { cookie: cookieAlice } = await signup('lifecycle-alice@example.com', 'lifecycle-device-alice');
  const { id: aliceReport } = await postReport('lifecycle-device-alice', { cookie: cookieAlice, title: 'alice-report.pdf' });

  const { cookie: cookieBob } = await signup('lifecycle-bob@example.com', 'lifecycle-device-bob');
  const { id: bobReport } = await postReport('lifecycle-device-bob', { cookie: cookieBob, title: 'bob-report.pdf' });

  const aliceList = await listReports({ cookie: cookieAlice });
  const aliceBody = await aliceList.json();
  assert.deepEqual(aliceBody.reports.map((r) => r.id), [aliceReport], "account A's list must contain only account A's report");

  const bobList = await listReports({ cookie: cookieBob });
  const bobBody = await bobList.json();
  assert.deepEqual(bobBody.reports.map((r) => r.id), [bobReport], "account B's list must contain only account B's report");

  console.log("account A's reports don't appear for account B (and vice versa): passed");
}

// 6. An anonymous device's reports must not become attributed to an
// unrelated account that never touched that device.
{
  const anonymousDevice = 'lifecycle-device-anonymous';
  const { id: anonymousReport } = await postReport(anonymousDevice, { title: 'anonymous-only.pdf' });

  const { cookie: cookieCarol } = await signup('lifecycle-carol@example.com', 'lifecycle-device-carol');
  const carolList = await listReports({ cookie: cookieCarol });
  const carolBody = await carolList.json();
  assert.equal(carolBody.reports.length, 0, "an unrelated account must not inherit another device's anonymous reports");
  assert.ok(!carolBody.reports.some((r) => r.id === anonymousReport));

  // The anonymous device's report must still be exactly where it was.
  const anonList = await listReports({ deviceKey: anonymousDevice });
  const anonBody = await anonList.json();
  assert.deepEqual(anonBody.reports.map((r) => r.id), [anonymousReport]);

  console.log("anonymous/device reports don't become another user's account reports: passed");
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All session-lifecycle tests passed');
