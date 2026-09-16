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
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

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
    body: JSON.stringify(withTestIdentity(body)),
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

// Room/slot architecture: an authenticated first save must name an
// available room (see app/api/reports/route.ts) — a resave (same id again)
// or an anonymous save ignores this entirely, so `room` only matters for
// the genuinely-new-upload cases below, which pass explicit, distinct room
// numbers so a sequence of new uploads to the same account never collides
// with itself (a fixed default would make the 2nd+ genuinely new upload in
// a loop fail with "room already occupied" instead of exercising the quota
// this file is actually about).
async function postReport(deviceKey, { id, cookie, payloadOverrides = {}, room = 0 } = {}) {
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
      room,
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

// report_save_rejected telemetry (lib/report-save-telemetry.ts) --
// deliberately minimal: captures console.warn only for the duration of
// `fn`, restores it unconditionally, and never touches console.log/error
// (the shadow-telemetry lines this file's own reports already emit stay
// untouched and unfiltered).
async function captureConsoleWarn(fn) {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => calls.push(args);
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.warn = original;
  }
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
    const { res } = await postReport('device-ten-1', { id: `ten-quota-${i}`, cookie, room: i - 1 });
    assert.equal(res.status, 200, `upload ${i}/${DAILY_UPLOAD_LIMIT} should succeed`);
  }

  const { result: { res: eleventh }, calls: warnCalls } = await captureConsoleWarn(() =>
    postReport('device-ten-1', { id: 'ten-quota-11', cookie, room: 0 }),
  );
  assert.equal(eleventh.status, 429, 'the 11th genuinely new upload must be rejected');
  const body = await eleventh.json();
  assert.equal(body.limit, DAILY_UPLOAD_LIMIT);
  assert.equal(body.uploadsToday, DAILY_UPLOAD_LIMIT);
  assert.ok(typeof body.resetsAt === 'string' && !Number.isNaN(Date.parse(body.resetsAt)), 'resetsAt must be a real, parseable timestamp');
  assert.ok(/limit/i.test(body.error), 'the error message must clearly describe the limit');
  const retryAfter = eleventh.headers.get('Retry-After');
  assert.ok(retryAfter && Number(retryAfter) > 0, 'Retry-After must be present and positive');

  // report_save_rejected telemetry: exactly one DAILY_UPLOAD_QUOTA/429 event,
  // authMode "authenticated" (this branch only ever runs for a signed-in,
  // non-admin session -- see route.ts's own gate), no customer data.
  const telemetryCalls = warnCalls.filter((args) => {
    try { return JSON.parse(args[0]).event === 'report_save_rejected'; } catch { return false; }
  });
  assert.equal(telemetryCalls.length, 1, 'exactly one report_save_rejected event for the 11th rejected upload');
  const telemetryEvent = JSON.parse(telemetryCalls[0][0]);
  assert.deepEqual(telemetryEvent, { event: 'report_save_rejected', reason: 'DAILY_UPLOAD_QUOTA', status: 429, authMode: 'authenticated' });

  console.log('10 uploads allowed, 11th rejected with a clear 429 including reset info, and telemetry recorded correctly');
}

// 3. Admin (role=admin) accounts are unlimited — well beyond 10 in the same day.
{
  process.env.ADMIN_EMAIL = 'admin-quota@example.com';
  const signupRes = await signup({ email: 'admin-quota@example.com', password: 'correct-horse-3', username: 'adminquota', deviceKey: 'device-admin-1' });
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);
  await grantTestAdmin(dbFile);
  delete process.env.ADMIN_EMAIL;

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT role FROM users WHERE email = ?', args: ['admin-quota@example.com'] });
  assert.equal(userRow.rows[0].role, 'admin', 'the signed-up account must actually be role=admin for this test to mean anything');
  client.close();

  for (let i = 1; i <= DAILY_UPLOAD_LIMIT + 3; i++) {
    // room: i - 1 gives 13 distinct rooms (0-12) — well within the admin
    // account's much larger room space (see lib/report-rooms.ts's
    // ADMIN_ROOM_COUNT), so none of these collide with each other.
    const { res } = await postReport('device-admin-1', { id: `admin-quota-${i}`, cookie, room: i - 1 });
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

  const { res: firstSave } = await postReport('device-resave-1', { id: 'resave-report-1', cookie, room: 0, payloadOverrides: { title: 'first-version.pdf' } });
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
    const { res } = await postReport('device-resave-1', { id: `resave-quota-new-${i}`, cookie, room: i - 1 });
    assert.equal(res.status, 200);
  }
  const { res: blockedNew } = await postReport('device-resave-1', { id: 'resave-quota-new-11', cookie, room: 0 });
  assert.equal(blockedNew.status, 429, 'a genuinely new upload must now be blocked');

  const { res: resaveAtLimit } = await postReport('device-resave-1', { id: 'resave-report-1', cookie, payloadOverrides: { title: 'first-version.pdf (updated again)' } });
  assert.equal(resaveAtLimit.status, 200, 'resaving an existing report must succeed even once the account is already at its daily limit');

  console.log('resaving/updating an existing report never consumes a new upload, even at the limit');
}

// 5. Unauthenticated (anonymous) uploads — AUTH GATE (tightened, product
// requirement): a report save is now an authenticated-account action only,
// full stop — first save AND resave alike (see app/api/reports/route.ts's
// own "AUTH GATE" comment). "Anonymous uploads are entirely unaffected by
// this quota" (this file's own header comment above) is no longer a
// reachable public behavior at all: there is no such thing as an anonymous
// upload (new or resaved) any more for the quota to be unaffected FOR. This
// scenario now proves the auth gate itself rejects every anonymous write —
// new or resave — before the quota system is ever consulted, and that the
// quota's own "a resave never consumes a slot" semantics still hold for the
// one write path that remains reachable: an AUTHENTICATED resave.
{
  for (let i = 1; i <= DAILY_UPLOAD_LIMIT + 5; i++) {
    const { res } = await postReport('device-anon-1', { id: `anon-quota-${i}` });
    assert.equal(res.status, 401, `a genuinely new anonymous upload ${i} must be rejected by the auth gate, never reach (or be limited by) the quota system`);
  }

  // A pre-existing anonymous report — inserted directly via the real
  // production SAVE_REPORT_SQL, matching this codebase's own established
  // "legacy row" pattern (see tests/report-write-time-finalization.test.mjs's
  // own insertLegacyRow).
  const legacyId = 'anon-legacy-resave-report';
  const legacyClient = createClient({ url: `file:${dbFile}` });
  await legacyClient.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [legacyId, 'device-anon-legacy', 'sub-' + legacyId, 'legacy-anonymous.pdf', new Date().toISOString(), 10, 0, 'Low', null, null, null, JSON.stringify({ note: 'legacy-anonymous.pdf' }), null, null],
  });
  legacyClient.close();

  // An ANONYMOUS resave of that pre-existing report is now rejected exactly
  // like an anonymous first save — by the auth gate, at 401, never even
  // reaching the (irrelevant here) quota check.
  const anonResave = await postReport('device-anon-legacy', { id: legacyId, payloadOverrides: { title: 'ANON-REWRITE-ATTEMPT' } });
  assert.equal(anonResave.res.status, 401, 'an anonymous resave of a pre-existing anonymous report must now be rejected — anonymous writes are gone entirely, not just anonymous creation');

  // The only way left to touch that row is an AUTHENTICATED resave (which
  // legitimately claims it — see tests/api-reports-account-scoping.test.mjs's
  // own dedicated "claim by resave" coverage). Proving the quota's real
  // subject — "a resave never consumes a slot" — now has to go through this
  // path, since no anonymous write path survives at all. Fills a fresh
  // account up to its daily limit first, so the resave-still-succeeds check
  // is meaningful (not just coincidentally under the limit), mirroring
  // scenario 4's own "resave at the limit" shape.
  const legacyClaimSignupRes = await signup({ email: 'legacy-claim-quota@example.com', password: 'correct-horse-5', username: 'legacyclaimquota', deviceKey: 'device-legacy-claim' });
  const legacyClaimCookie = extractCookie(legacyClaimSignupRes);
  assert.ok(legacyClaimCookie);
  for (let i = 1; i <= DAILY_UPLOAD_LIMIT; i++) {
    const { res } = await postReport('device-legacy-claim', { id: `legacy-claim-new-${i}`, cookie: legacyClaimCookie, room: i - 1 });
    assert.equal(res.status, 200);
  }
  const { res: blockedNewForClaimAccount } = await postReport('device-legacy-claim', { id: 'legacy-claim-new-11', cookie: legacyClaimCookie, room: 0 });
  assert.equal(blockedNewForClaimAccount.status, 429, 'sanity: this account is genuinely at its daily limit');

  const resaveAtLimitAuthed = await postReport('device-anon-legacy', { id: legacyId, cookie: legacyClaimCookie, payloadOverrides: { title: 'claimed-by-resave-while-at-limit.pdf' } });
  assert.equal(resaveAtLimitAuthed.res.status, 200, 'an authenticated resave (claiming a pre-existing anonymous report) must still succeed even when the account is already at its daily limit — resaves are never metered');

  const statusRes = await getUploadLimit(null);
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.deepEqual(statusBody, { authenticated: false });

  console.log('unauthenticated new-upload AND resave attempts are both rejected by the auth gate; an authenticated resave remains exempt from the quota even at the daily limit');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All upload-limit tests passed');
