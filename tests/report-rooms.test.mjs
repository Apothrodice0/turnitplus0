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
import { NORMAL_ROOM_COUNT, ADMIN_ROOM_COUNT, ROOM_CYCLE_MS } from '../lib/report-rooms.ts';

// Verifies the room/slot architecture's server-side pieces: a room is a
// real upload SLOT (at most one current report, an explicit fact recorded
// at upload time via room_number — never derived from the report's own
// id), the room index is lightweight and account-scoped, a room-scoped GET
// only ever touches that one slot, a room already holding an active (<24h)
// report refuses a second upload with 409, a resave never perturbs a room's
// occupancy, and an admin account gets a much larger room space (>= 40, per
// this feature's own explicit requirement) while a normal account gets 10.

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

/** `id` is a caller-chosen numeric string so tests can identify a specific report deterministically — room is now an explicit parameter, never derived from id. */
async function postReport(deviceKey, id, { cookie, room, payloadOverrides = {}, createdAt } = {}) {
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
      createdAt: createdAt ?? payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room,
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

// 1. The room index is lightweight (status + timestamps only, never the
// report itself), always reports exactly NORMAL_ROOM_COUNT rooms for a
// normal account, and is empty for an anonymous caller.
{
  const signupRes = await signup({ email: 'rooms-index@example.com', password: 'correct-horse-1', username: 'roomsindex', deviceKey: 'device-idx-1' });
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  const postRes = await postReport('device-idx-1', 2000000000003, { cookie, room: 3 });
  assert.equal(postRes.status, 200);

  const indexRes = await getRoomIndex(cookie);
  assert.equal(indexRes.status, 200);
  const body = await indexRes.json();
  assert.equal(body.rooms.length, NORMAL_ROOM_COUNT, 'the index must report exactly this account\'s room count');
  const keys = Object.keys(body.rooms[0]).sort();
  assert.deepEqual(keys, ['cycleEndsAt', 'mostRecentAt', 'room', 'status'], 'the index must be lightweight — no report content, just status/room/timestamps');

  const room3 = body.rooms.find((r) => r.room === 3);
  assert.equal(room3.status, 'ready');
  assert.ok(typeof room3.mostRecentAt === 'string');
  assert.ok(typeof room3.cycleEndsAt === 'string');

  for (const entry of body.rooms) {
    if (entry.room === 3) continue;
    assert.equal(entry.status, 'empty', `room ${entry.room} must be empty`);
    assert.equal(entry.mostRecentAt, null);
    assert.equal(entry.cycleEndsAt, null);
  }

  const anonIndexRes = await getRoomIndex(null);
  assert.equal(anonIndexRes.status, 200);
  const anonBody = await anonIndexRes.json();
  assert.deepEqual(anonBody, { rooms: [] }, 'an anonymous caller has no rooms at all');

  console.log('room index is lightweight, status-based, correctly sized, and empty for anonymous callers');
}

// 2. A room-scoped GET only ever returns that ONE room's current occupant —
// never other rooms', never more than one report.
{
  const signupRes = await signup({ email: 'rooms-scope@example.com', password: 'correct-horse-2', username: 'roomsscope', deviceKey: 'device-scope-1' });
  const cookie = extractCookie(signupRes);

  const room3Report = await postReport('device-scope-1', 3000000000003, { cookie, room: 3 });
  assert.equal(room3Report.status, 200);
  const room7Report = await postReport('device-scope-1', 3000000000007, { cookie, room: 7 });
  assert.equal(room7Report.status, 200);

  const room3Res = await getRoom(cookie, 3);
  assert.equal(room3Res.status, 200);
  const room3Body = await room3Res.json();
  assert.equal(room3Body.status, 'ready');
  assert.equal(room3Body.report.id, '3000000000003');

  const room7Res = await getRoom(cookie, 7);
  const room7Body = await room7Res.json();
  assert.equal(room7Body.status, 'ready');
  assert.equal(room7Body.report.id, '3000000000007');
  assert.notEqual(room7Body.report.id, room3Body.report.id, 'room 7 must never return room 3\'s report');

  const emptyRoomRes = await getRoom(cookie, 5);
  const emptyRoomBody = await emptyRoomRes.json();
  assert.deepEqual(emptyRoomBody, { status: 'empty', report: null, cycleEndsAt: null });

  // Out-of-range / malformed room values are rejected, not silently coerced.
  const invalidRes = await getRoom(cookie, NORMAL_ROOM_COUNT);
  assert.equal(invalidRes.status, 400);
  const negativeRes = await getRoom(cookie, -1);
  assert.equal(negativeRes.status, 400);

  console.log('room-scoped GET returns only that room\'s single current report, and validates the room parameter');
}

// 3. A room already holding an active (<24h) report refuses a second
// upload — this is the real fix for "Room 1 contains 2 reports": a room is
// a slot, not a bucket unlimited reports can accumulate in.
{
  const signupRes = await signup({ email: 'rooms-occupied@example.com', password: 'correct-horse-3', username: 'roomsoccupied', deviceKey: 'device-occupied-1' });
  const cookie = extractCookie(signupRes);

  const first = await postReport('device-occupied-1', 4000000000001, { cookie, room: 2 });
  assert.equal(first.status, 200);

  const second = await postReport('device-occupied-1', 4000000000002, { cookie, room: 2 });
  assert.equal(second.status, 409, 'a second, genuinely new upload into an already-occupied room must be refused');
  const secondBody = await second.json();
  assert.ok(typeof secondBody.cycleEndsAt === 'string' && !Number.isNaN(Date.parse(secondBody.cycleEndsAt)));

  const roomRes = await getRoom(cookie, 2);
  const roomBody = await roomRes.json();
  assert.equal(roomBody.report.id, '4000000000001', 'the room must still show only the FIRST report — the rejected second upload must never have been persisted');

  // The server re-validates room availability itself — an invalid/missing
  // room on a genuinely new authenticated upload is rejected outright, not
  // silently defaulted.
  const noRoom = await postReport('device-occupied-1', 4000000000009, { cookie, room: undefined });
  assert.equal(noRoom.status, 400, 'a genuinely new authenticated upload with no room specified must be rejected');
  const outOfRange = await postReport('device-occupied-1', 4000000000008, { cookie, room: NORMAL_ROOM_COUNT });
  assert.equal(outOfRange.status, 400, 'a room number beyond this account\'s room count must be rejected');

  console.log('a room already holding an active report refuses a second upload (409), and never silently accepts a missing/invalid room');
}

// 4. Resaving/updating an existing report never perturbs its room, and
// room_number is immutable after the first insert (a resave can never
// smuggle a different room in).
{
  const signupRes = await signup({ email: 'rooms-resave@example.com', password: 'correct-horse-4', username: 'roomsresave', deviceKey: 'device-resave-rooms-1' });
  const cookie = extractCookie(signupRes);
  const id = 5000000000005;

  const first = await postReport('device-resave-rooms-1', id, { cookie, room: 5, payloadOverrides: { title: 'first.pdf' } });
  assert.equal(first.status, 200);
  // A resave passes a DIFFERENT room number — this must be silently ignored
  // (room_number is set once, at first insert, and never updated).
  const resave = await postReport('device-resave-rooms-1', id, { cookie, room: 9, payloadOverrides: { title: 'first.pdf (re-saved)' } });
  assert.equal(resave.status, 200);

  const room5Res = await getRoom(cookie, 5);
  const room5Body = await room5Res.json();
  assert.equal(room5Body.status, 'ready');
  assert.equal(room5Body.report.title, 'first.pdf (re-saved)', 'the resaved content must be reflected, not duplicated');

  const room9Res = await getRoom(cookie, 9);
  const room9Body = await room9Res.json();
  assert.equal(room9Body.status, 'empty', 'a resave must never move a report to a different room, even if the resave request names one');

  console.log('a resave never perturbs its room, updates the existing row in place, and can never smuggle a different room_number in');
}

// 5. Deleting a room's current report frees the slot immediately (does not
// wait for the 24h cycle) — the occupancy check re-derives from
// saved_reports on every request, never a separately cached "occupied" flag.
{
  const signupRes = await signup({ email: 'rooms-delete@example.com', password: 'correct-horse-5', username: 'roomsdelete', deviceKey: 'device-delete-1' });
  const cookie = extractCookie(signupRes);
  const id = 6000000000006;

  const first = await postReport('device-delete-1', id, { cookie, room: 4 });
  assert.equal(first.status, 200);
  const occupied = await postReport('device-delete-1', 6000000000016, { cookie, room: 4 });
  assert.equal(occupied.status, 409);

  const deleteReq = new Request(`http://localhost/api/reports/${id}`, { method: 'DELETE', headers: { cookie: `tp_session_v1=${cookie}` } });
  const reportIdRoute = await import('../app/api/reports/[id]/route.ts');
  const deleteRes = await reportIdRoute.DELETE(deleteReq, { params: Promise.resolve({ id: String(id) }) });
  assert.equal(deleteRes.status, 200);

  const freed = await postReport('device-delete-1', 6000000000026, { cookie, room: 4 });
  assert.equal(freed.status, 200, 'deleting the room\'s current report must free the slot for a new upload immediately');

  console.log('deleting a room\'s current report frees the slot immediately, without waiting for the 24h cycle');
}

// 6. The room system gives an admin (role=admin) account a much larger
// room space (>= 40, this feature's own explicit requirement) while a
// normal account gets NORMAL_ROOM_COUNT — and "role" itself is never a
// field in the index response.
{
  process.env.ADMIN_EMAIL = 'rooms-admin@example.com';
  const signupRes = await signup({ email: 'rooms-admin@example.com', password: 'correct-horse-6', username: 'roomsadmin', deviceKey: 'device-admin-rooms-1' });
  const cookie = extractCookie(signupRes);
  delete process.env.ADMIN_EMAIL;

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT role FROM users WHERE email = ?', args: ['rooms-admin@example.com'] });
  assert.equal(userRow.rows[0].role, 'admin');
  client.close();

  assert.ok(ADMIN_ROOM_COUNT >= 40, 'admin accounts must get at least 40 rooms per this feature\'s own explicit requirement');

  const indexRes = await getRoomIndex(cookie);
  assert.equal(indexRes.status, 200);
  const indexBody = await indexRes.json();
  assert.equal(indexBody.rooms.length, ADMIN_ROOM_COUNT, 'an admin account must see its full, much larger room space');
  assert.ok(!('role' in indexBody), 'the role itself must never be sent to the client — only however many room entries the array contains');

  // A room number valid for admin (>= NORMAL_ROOM_COUNT) but invalid for a
  // normal account must actually work for this admin account.
  const highRoomId = 7000000000030;
  const highRoomRes = await postReport('device-admin-rooms-1', highRoomId, { cookie, room: 30 });
  assert.equal(highRoomRes.status, 200, 'an admin account must be able to use a room number beyond the normal 10-room range');

  const room30Res = await getRoom(cookie, 30);
  const room30Body = await room30Res.json();
  assert.equal(room30Body.report.id, String(highRoomId));

  console.log('an admin account gets a much larger room space (>= 40), and role is never exposed through the room index');
}

// 7. The 24h cycle: a report older than 24h no longer occupies its room —
// the room reports itself as "empty" (available for a new upload) both in
// the index and in the room-scoped fetch, exactly matching "reset/reopen
// for a new upload according to the 24-hour room cycle" — without deleting
// the aged-out report itself.
{
  const signupRes = await signup({ email: 'rooms-cycle@example.com', password: 'correct-horse-7', username: 'roomscycle', deviceKey: 'device-cycle-1' });
  const cookie = extractCookie(signupRes);
  const id = 8000000000008;

  const oldCreatedAt = new Date(Date.now() - ROOM_CYCLE_MS - 60_000).toISOString();
  const first = await postReport('device-cycle-1', id, { cookie, room: 6, createdAt: oldCreatedAt });
  assert.equal(first.status, 200);

  const roomRes = await getRoom(cookie, 6);
  const roomBody = await roomRes.json();
  assert.deepEqual(roomBody, { status: 'empty', report: null, cycleEndsAt: null }, 'a room whose only report is older than 24h must report itself as empty/available, not show the aged report');

  const indexRes = await getRoomIndex(cookie);
  const indexBody = await indexRes.json();
  const room6 = indexBody.rooms.find((r) => r.room === 6);
  assert.equal(room6.status, 'empty');

  // The room is genuinely available again — a new upload succeeds.
  const reopened = await postReport('device-cycle-1', 8000000000018, { cookie, room: 6 });
  assert.equal(reopened.status, 200, 'a room whose previous occupant has aged out of its cycle must accept a new upload');

  // The aged-out report itself was never deleted — still reachable directly.
  const client = createClient({ url: `file:${dbFile}` });
  const stillThere = await client.execute({ sql: 'SELECT id FROM saved_reports WHERE id = ?', args: [String(id)] });
  assert.equal(stillThere.rows.length, 1, 'an aged-out report must never be deleted — only no longer its room\'s CURRENT occupant');
  client.close();

  console.log('a report past its 24h cycle frees its room for a new upload without ever being deleted');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All report-rooms server-side tests passed');
