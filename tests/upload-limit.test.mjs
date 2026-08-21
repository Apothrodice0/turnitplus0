import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as uploadLimitRoute from '../app/api/upload-limit/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';
import { DAILY_UPLOAD_LIMIT, checkUploadLimit, countUploadsToday, getUploadLimitStatus } from '../lib/upload-limit.ts';

// Verifies the daily upload quota: 10 new uploads/day for authenticated
// non-admin accounts, unlimited for role="admin", enforced server-side at
// the actual save boundary (POST /api/reports) — never relying on frontend
// UI. A resave of an already-saved (device_key, id) never consumes a slot
// (see lib/upload-limit.ts's own header comment for why saved_reports.
// saved_at is the "genuinely new" signal). Anonymous requests are entirely
// unaffected — they remain governed only by the existing IP rate limiter.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_upload_limit.db');
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

let ipCounter = 0;
async function signup(body) {
  const ip = `upload-limit-signup-${++ipCounter}`;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return signupRoute.POST(req);
}

function samplePayload(overrides = {}) {
  return {
    version: 11,
    id: overrides.id ?? Date.now(),
    submissionId: '1234567890',
    title: 'upload-limit-sample.pdf',
    created: new Date().toISOString(),
    score: 3,
    wordCount: 400,
    text: 'sample extracted text for upload-limit testing',
    ...overrides,
  };
}

async function postReport(deviceKey, { id, cookie, payloadOverrides = {} } = {}) {
  const ip = `upload-limit-post-${++ipCounter}`;
  await resetRateForTest(ip);
  const payload = samplePayload({ id: id ?? Date.now(), ...payloadOverrides });
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: String(payload.id),
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

async function getUploadLimit(cookie) {
  const ip = `upload-limit-status-${++ipCounter}`;
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/upload-limit', { headers });
  return uploadLimitRoute.GET(req);
}

// 1. Unit: countUploadsToday/checkUploadLimit/getUploadLimitStatus behave correctly in isolation.
{
  const client = createClient({ url: `file:${dbFile}` });
  const signupRes = await signup({ email: 'unit-quota@example.com', password: 'correct-horse-1', username: 'unitquota', deviceKey: 'device-unit-1' });
  const userRow = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['unit-quota@example.com'] });
  const userId = userRow.rows[0].id;
  assert.equal(signupRes.status, 201);

  assert.equal(await countUploadsToday(client, userId), 0);
  const initialCheck = await checkUploadLimit(client, userId);
  assert.deepEqual(initialCheck, { allowed: true });

  const status = await getUploadLimitStatus(client, userId, false);
  assert.deepEqual(status, { unlimited: false, uploadsToday: 0, limit: DAILY_UPLOAD_LIMIT });

  const adminStatus = await getUploadLimitStatus(client, userId, true);
  assert.deepEqual(adminStatus, { unlimited: true });

  client.close();
  console.log('unit-level quota helpers behave correctly');
}

// 2. 10 new uploads succeed; the 11th is rejected with a clear 429 including reset info.
{
  const signupRes = await signup({ email: 'ten-quota@example.com', password: 'correct-horse-2', username: 'tenquota', deviceKey: 'device-ten-1' });
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  for (let i = 1; i <= DAILY_UPLOAD_LIMIT; i++) {
    const { res } = await postReport('device-ten-1', { id: `ten-quota-${i}`, cookie });
    assert.equal(res.status, 200, `upload ${i}/${DAILY_UPLOAD_LIMIT} should succeed`);
  }

  const { res: eleventh } = await postReport('device-ten-1', { id: 'ten-quota-11', cookie });
  assert.equal(eleventh.status, 429, 'the 11th genuinely new upload must be rejected');
  const body = await eleventh.json();
  assert.equal(body.limit, DAILY_UPLOAD_LIMIT);
  assert.equal(body.uploadsToday, DAILY_UPLOAD_LIMIT);
  assert.ok(typeof body.resetsAt === 'string' && !Number.isNaN(Date.parse(body.resetsAt)), 'resetsAt must be a real, parseable timestamp');
  assert.ok(/limit/i.test(body.error), 'the error message must clearly describe the limit');
  const retryAfter = eleventh.headers.get('Retry-After');
  assert.ok(retryAfter && Number(retryAfter) > 0, 'Retry-After must be present and positive');

  console.log('10 uploads allowed, 11th rejected with a clear 429 including reset info');
}

// 3. Admin (role=admin) accounts are unlimited — well beyond 10 in the same day.
{
  process.env.ADMIN_EMAIL = 'admin-quota@example.com';
  const signupRes = await signup({ email: 'admin-quota@example.com', password: 'correct-horse-3', username: 'adminquota', deviceKey: 'device-admin-1' });
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);
  delete process.env.ADMIN_EMAIL;

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT role FROM users WHERE email = ?', args: ['admin-quota@example.com'] });
  assert.equal(userRow.rows[0].role, 'admin', 'the signed-up account must actually be role=admin for this test to mean anything');
  client.close();

  for (let i = 1; i <= DAILY_UPLOAD_LIMIT + 3; i++) {
    const { res } = await postReport('device-admin-1', { id: `admin-quota-${i}`, cookie });
    assert.equal(res.status, 200, `admin upload ${i} (beyond the normal limit of ${DAILY_UPLOAD_LIMIT}) must still succeed`);
  }

  const statusRes = await getUploadLimit(cookie);
  const statusBody = await statusRes.json();
  assert.deepEqual(statusBody, { authenticated: true, unlimited: true }, 'the admin upload-limit status must report unlimited, with no count/limit fields');

  console.log('admin accounts are unlimited, confirmed via both enforcement and the display endpoint');
}

// 4. Updating/resaving the SAME report never consumes a new upload — even once already at the limit.
{
  const signupRes = await signup({ email: 'resave-quota@example.com', password: 'correct-horse-4', username: 'resavequota', deviceKey: 'device-resave-1' });
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  const { res: firstSave } = await postReport('device-resave-1', { id: 'resave-report-1', cookie, payloadOverrides: { title: 'first-version.pdf' } });
  assert.equal(firstSave.status, 200);
  const { res: resave } = await postReport('device-resave-1', { id: 'resave-report-1', cookie, payloadOverrides: { title: 'first-version.pdf (Wikipedia-enriched)' } });
  assert.equal(resave.status, 200, 'resaving the identical (device_key, id) must succeed and not be treated as a new upload');

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['resave-quota@example.com'] });
  const userId = userRow.rows[0].id;
  assert.equal(await countUploadsToday(client, userId), 1, 'the resave must not have incremented the daily upload count');
  client.close();

  // Fill up to the limit with genuinely new uploads, then confirm the
  // already-at-limit account can still resave its existing report.
  for (let i = 2; i <= DAILY_UPLOAD_LIMIT; i++) {
    const { res } = await postReport('device-resave-1', { id: `resave-quota-new-${i}`, cookie });
    assert.equal(res.status, 200);
  }
  const { res: blockedNew } = await postReport('device-resave-1', { id: 'resave-quota-new-11', cookie });
  assert.equal(blockedNew.status, 429, 'a genuinely new upload must now be blocked');

  const { res: resaveAtLimit } = await postReport('device-resave-1', { id: 'resave-report-1', cookie, payloadOverrides: { title: 'first-version.pdf (updated again)' } });
  assert.equal(resaveAtLimit.status, 200, 'resaving an existing report must succeed even once the account is already at its daily limit');

  console.log('resaving/updating an existing report never consumes a new upload, even at the limit');
}

// 5. Unauthenticated (anonymous) uploads are entirely unaffected by this quota.
{
  for (let i = 1; i <= DAILY_UPLOAD_LIMIT + 5; i++) {
    const { res } = await postReport('device-anon-1', { id: `anon-quota-${i}` });
    assert.equal(res.status, 200, `anonymous upload ${i} (beyond the authenticated limit of ${DAILY_UPLOAD_LIMIT}) must succeed — no account to meter`);
  }

  const statusRes = await getUploadLimit(null);
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.deepEqual(statusBody, { authenticated: false });

  console.log('unauthenticated uploads are entirely unaffected by the daily quota');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All upload-limit tests passed');
