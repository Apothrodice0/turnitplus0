import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';
import { REPORT_ROOM_COUNT, reportRoomForId } from '../lib/report-rooms.ts';

// Verifies the 10-room architecture's server-side pieces: the room index is
// lightweight and account-scoped, a room-scoped GET /api/reports?room=N only
// ever touches that one partition (never the whole account), room
// membership is a stable function of a report's own id (no migration/
// schema needed), and a resave never perturbs a room's count. See
// lib/report-rooms.ts's own header comment for why CAST(id AS INTEGER) % 10
// is the room boundary.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_rooms.db');
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
  const ip = `report-rooms-signup-${++ipCounter}`;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return signupRoute.POST(req);
}

async function login(body) {
  const ip = `report-rooms-login-${++ipCounter}`;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return loginRoute.POST(req);
}

function samplePayload(id, overrides = {}) {
  return {
    version: 11,
    id,
    submissionId: String(id).slice(-10),
    title: `report-${id}.pdf`,
    created: new Date().toISOString(),
    score: 3,
    wordCount: 400,
    text: `sample extracted text for report ${id}`,
    ...overrides,
  };
}

/** `id` is a caller-chosen numeric string so tests can target a specific, known room deterministically (room = Number(id) % 10) rather than relying on real timestamps. */
async function postReport(deviceKey, id, { cookie, payloadOverrides = {} } = {}) {
  const ip = `report-rooms-post-${++ipCounter}`;
  await resetRateForTest(ip);
  const payload = samplePayload(id, payloadOverrides);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: String(id),
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
  return reportsRoute.POST(req);
}

async function getRoomIndex(cookie) {
  const ip = `report-rooms-index-${++ipCounter}`;
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports/rooms', { headers });
  return roomsRoute.GET(req);
}

async function getRoom(cookie, room) {
  const ip = `report-rooms-room-${++ipCounter}`;
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request(`http://localhost/api/reports?room=${room}`, { headers });
  return reportsRoute.GET(req);
}

// 1. reportRoomForId (the pure client-side helper) agrees with a room id's
// own definition (Number(id) % 10) — sanity-checking the one thing that
// must never drift out of sync with the server's SQL.
{
  assert.equal(reportRoomForId('1000000000000'), 0);
  assert.equal(reportRoomForId('1000000000003'), 3);
  assert.equal(reportRoomForId('1787338956119'), 9);
  console.log('reportRoomForId agrees with plain Number(id) % 10');
}

// 2. The room index is lightweight (counts + most-recent only, never the
// reports themselves), always reports exactly 10 rooms, and is empty for
// an anonymous caller.
{
  const signupRes = await signup({ email: 'rooms-index@example.com', password: 'correct-horse-1', username: 'roomsindex', deviceKey: 'device-idx-1' });
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  // Post one report per room (room 0..9), all for this account.
  for (let room = 0; room < REPORT_ROOM_COUNT; room++) {
    const id = 2000000000000 + room; // Number(id) % 10 === room by construction
    const res = await postReport('device-idx-1', id, { cookie });
    assert.equal(res.status, 200);
  }

  const indexRes = await getRoomIndex(cookie);
  assert.equal(indexRes.status, 200);
  const body = await indexRes.json();
  assert.equal(body.rooms.length, REPORT_ROOM_COUNT, 'the index must always report exactly 10 rooms');
  const keys = Object.keys(body.rooms[0]).sort();
  assert.deepEqual(keys, ['count', 'mostRecentAt', 'room'], 'the index must be lightweight — no report content, just count/room/mostRecentAt');
  for (let room = 0; room < REPORT_ROOM_COUNT; room++) {
    const entry = body.rooms.find((r) => r.room === room);
    assert.ok(entry, `room ${room} must be present in the index`);
    assert.equal(entry.count, 1, `room ${room} should have exactly the 1 report posted into it`);
  }

  const anonIndexRes = await getRoomIndex(null);
  assert.equal(anonIndexRes.status, 200);
  const anonBody = await anonIndexRes.json();
  assert.deepEqual(anonBody, { rooms: [] }, 'an anonymous caller has no rooms at all');

  console.log('room index is lightweight, complete (10 rooms), and empty for anonymous callers');
}

// 3. A room-scoped GET only ever returns that room's reports — never other
// rooms', never the whole account's history in one call.
{
  const signupRes = await signup({ email: 'rooms-scope@example.com', password: 'correct-horse-2', username: 'roomsscope', deviceKey: 'device-scope-1' });
  const cookie = extractCookie(signupRes);

  const room3IdA = 3000000000003;
  const room3IdB = 3000000000013; // also % 10 === 3
  const room7Id = 3000000000007;
  await postReport('device-scope-1', room3IdA, { cookie });
  await postReport('device-scope-1', room3IdB, { cookie });
  await postReport('device-scope-1', room7Id, { cookie });

  const room3Res = await getRoom(cookie, 3);
  assert.equal(room3Res.status, 200);
  const room3Body = await room3Res.json();
  assert.equal(room3Body.reports.length, 2, 'room 3 must contain exactly its own 2 reports');
  assert.deepEqual(room3Body.reports.map((r) => r.id).sort(), [String(room3IdA), String(room3IdB)].sort());
  assert.ok(!room3Body.reports.some((r) => r.id === String(room7Id)), 'room 3 must never include room 7\'s report');

  const room7Res = await getRoom(cookie, 7);
  const room7Body = await room7Res.json();
  assert.equal(room7Body.reports.length, 1);
  assert.equal(room7Body.reports[0].id, String(room7Id));

  // Out-of-range / malformed room values are rejected, not silently coerced.
  const invalidRes = await getRoom(cookie, REPORT_ROOM_COUNT);
  assert.equal(invalidRes.status, 400);
  const negativeRes = await getRoom(cookie, -1);
  assert.equal(negativeRes.status, 400);

  console.log('room-scoped GET only returns that room\'s reports, and validates the room parameter');
}

// 4. Resaving/updating an existing report never changes its room's count —
// only a genuinely new (device_key, id) does.
{
  const signupRes = await signup({ email: 'rooms-resave@example.com', password: 'correct-horse-3', username: 'roomsresave', deviceKey: 'device-resave-rooms-1' });
  const cookie = extractCookie(signupRes);
  const id = 4000000000004;

  await postReport('device-resave-rooms-1', id, { cookie, payloadOverrides: { title: 'first.pdf' } });
  await postReport('device-resave-rooms-1', id, { cookie, payloadOverrides: { title: 'first.pdf (re-saved)' } });

  const room = id % REPORT_ROOM_COUNT;
  const indexRes = await getRoomIndex(cookie);
  const indexBody = await indexRes.json();
  const entry = indexBody.rooms.find((r) => r.room === room);
  assert.equal(entry.count, 1, 'resaving the same report must not increment its room\'s count');

  const roomRes = await getRoom(cookie, room);
  const roomBody = await roomRes.json();
  assert.equal(roomBody.reports.length, 1);
  assert.equal(roomBody.reports[0].title, 'first.pdf (re-saved)', 'the resaved content must be reflected, not duplicated');

  console.log('a resave never perturbs its room\'s count, and updates the existing row in place');
}

// 5. The room system works identically for a role=admin account — not just
// unlimited uploads (a separate feature), the room browsing itself.
{
  process.env.ADMIN_EMAIL = 'rooms-admin@example.com';
  const signupRes = await signup({ email: 'rooms-admin@example.com', password: 'correct-horse-4', username: 'roomsadmin', deviceKey: 'device-admin-rooms-1' });
  const cookie = extractCookie(signupRes);
  delete process.env.ADMIN_EMAIL;

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT role FROM users WHERE email = ?', args: ['rooms-admin@example.com'] });
  assert.equal(userRow.rows[0].role, 'admin');
  client.close();

  const id = 5000000000002;
  await postReport('device-admin-rooms-1', id, { cookie });

  const indexRes = await getRoomIndex(cookie);
  assert.equal(indexRes.status, 200);
  const indexBody = await indexRes.json();
  assert.equal(indexBody.rooms.length, REPORT_ROOM_COUNT);
  const room = id % REPORT_ROOM_COUNT;
  assert.equal(indexBody.rooms.find((r) => r.room === room).count, 1);

  const roomRes = await getRoom(cookie, room);
  const roomBody = await roomRes.json();
  assert.equal(roomBody.reports.length, 1);
  assert.equal(roomBody.reports[0].id, String(id));

  console.log('the room system works the same way for an admin account\'s own reports');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All report-rooms server-side tests passed');
