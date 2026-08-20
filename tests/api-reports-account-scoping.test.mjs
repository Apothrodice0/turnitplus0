import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_api_reports_account_scoping.db');
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
  return `scoping-report-${counter}`;
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function postReport(deviceKey, { cookie, id, title = 'scoping.pdf' } = {}) {
  await resetRateForTest('scoping-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'scoping-post' };
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
  await resetRateForTest('scoping-list');
  const headers = { 'x-forwarded-for': 'scoping-list' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}` : 'http://localhost/api/reports';
  const req = new Request(url, { headers });
  return reportsRoute.GET(req);
}

async function getReport(id, { deviceKey, cookie } = {}) {
  await resetRateForTest('scoping-get');
  const headers = { 'x-forwarded-for': 'scoping-get' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('scoping-signup');
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'scoping-signup' },
    body: JSON.stringify({ email, password: 'scoping-password-1', username: 'scopeuser', deviceKey }),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function login(email, deviceKey) {
  await resetAuthRateForTest('scoping-login');
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'scoping-login' },
    body: JSON.stringify({ email, password: 'scoping-password-1', deviceKey }),
  });
  const res = await loginRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

// Scenario A: signup claims a device's existing anonymous reports, and the
// leak-fix regression — the raw device_key path must stop seeing them.
const deviceA = 'scoping-device-A';
const { id: reportA } = await postReport(deviceA);
{
  const anonBefore = await listReports({ deviceKey: deviceA });
  const anonBeforeBody = await anonBefore.json();
  assert.equal(anonBeforeBody.reports.length, 1, 'anonymous device A should see its own report before signup');

  const { res: signupRes, cookie: cookieA } = await signup('scope-a@example.com', deviceA);
  assert.equal(signupRes.status, 201);
  assert.ok(cookieA);

  const authedList = await listReports({ cookie: cookieA });
  const authedBody = await authedList.json();
  assert.equal(authedBody.reports.length, 1, 'authenticated list must show the claimed report');
  assert.equal(authedBody.reports[0].id, reportA);

  const anonAfter = await listReports({ deviceKey: deviceA });
  const anonAfterBody = await anonAfter.json();
  assert.equal(anonAfterBody.reports.length, 0, 'REGRESSION: claimed reports must no longer be visible via the raw device_key path (shared-computer leak)');

  const anonGetAfter = await getReport(reportA, { deviceKey: deviceA });
  assert.equal(anonGetAfter.status, 404, 'REGRESSION: a claimed report must not be fetchable via the raw device_key path either');

  const authedGet = await getReport(reportA, { cookie: cookieA });
  assert.equal(authedGet.status, 200, 'the authenticated owner must still be able to fetch the claimed report');

  console.log('scenario A (signup claim + leak-fix regression) passed');

  // Scenario D: an anonymous re-save of an already-claimed report must not
  // un-claim it (COALESCE(excluded.user_id, saved_reports.user_id)).
  const { res: reSaveRes } = await postReport(deviceA, { id: reportA, title: 'scoping-updated.pdf' });
  assert.equal(reSaveRes.status, 200);
  const authedListAfterResave = await listReports({ cookie: cookieA });
  const authedListAfterResaveBody = await authedListAfterResave.json();
  assert.equal(authedListAfterResaveBody.reports.length, 1, 'an anonymous re-save must not unclaim the report');
  assert.equal(authedListAfterResaveBody.reports[0].title, 'scoping-updated.pdf', 'the anonymous re-save should still update the report content');
  const anonListAfterResave = await listReports({ deviceKey: deviceA });
  const anonListAfterResaveBody = await anonListAfterResave.json();
  assert.equal(anonListAfterResaveBody.reports.length, 0, 'the report must remain invisible via the anonymous path after the re-save');
  console.log('scenario D (upsert preserves an existing claim) passed');

  // Scenario B: a second device belonging to the same account, claimed via
  // login rather than signup, and the resulting cross-device list.
  const deviceB = 'scoping-device-B';
  const { id: reportB } = await postReport(deviceB);
  const anonBBefore = await listReports({ deviceKey: deviceB });
  assert.equal((await anonBBefore.json()).reports.length, 1);

  const { res: loginRes, cookie: cookieB } = await login('scope-a@example.com', deviceB);
  assert.equal(loginRes.status, 200);
  assert.ok(cookieB);

  const crossDeviceList = await listReports({ cookie: cookieB });
  const crossDeviceBody = await crossDeviceList.json();
  const ids = crossDeviceBody.reports.map((r) => r.id).sort();
  assert.deepEqual(ids, [reportA, reportB].sort(), 'logging in on a second device must claim its anonymous reports AND show the full cross-device list');

  const anonBAfter = await listReports({ deviceKey: deviceB });
  assert.equal((await anonBAfter.json()).reports.length, 0, 'device B\'s reports must also disappear from its own raw device_key path after login-claim');

  console.log('scenario B (login claims a second device + cross-device list) passed');
}

// Scenario C: a device that never authenticates is completely unaffected by
// any of the above.
{
  const deviceC = 'scoping-device-C';
  const { id: reportC } = await postReport(deviceC);
  const listC = await listReports({ deviceKey: deviceC });
  const bodyC = await listC.json();
  assert.equal(bodyC.reports.length, 1);
  assert.equal(bodyC.reports[0].id, reportC);
  console.log('scenario C (never-authenticated device unaffected) passed');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All account-scoping tests passed');
