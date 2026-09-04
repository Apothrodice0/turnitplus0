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
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

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
    body: JSON.stringify(withTestIdentity(body)),
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

/**
 * `id` is a caller-chosen numeric string so tests can identify a specific
 * report deterministically — room is now an explicit parameter, never
 * derived from id. Defaults to a real, non-null aiScore/aiTone: most of
 * these scenarios are about room occupancy/isolation, not the AI-pending
 * window, so a genuinely complete report is the right default — pass
 * `aiScore: null` explicitly (see scenario 8) to exercise "processing".
 */
async function postReport(deviceKey, id, { cookie, room, payloadOverrides = {}, createdAt, aiScore = 12, aiTone = 'low', aiStatus } = {}) {
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
      aiScore,
      aiTone,
      aiStatus,
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
  await grantTestAdmin(dbFile);
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

// 8. "Processing": a room occupied by a report whose ai_score isn't
// recorded yet (the similarity-only first save has landed, the
// AI-enriched resave hasn't) reports itself as "processing" — never
// prematurely "ready" — in both the index and the room-scoped fetch, but
// still counts as occupied for 409 purposes. Once the enriched resave
// lands (a real aiScore), the same room flips to "ready".
{
  const signupRes = await signup({ email: 'rooms-processing@example.com', password: 'correct-horse-8', username: 'roomsprocessing', deviceKey: 'device-processing-1' });
  const cookie = extractCookie(signupRes);
  const id = 9000000000009;

  const first = await postReport('device-processing-1', id, { cookie, room: 9, aiScore: null, aiTone: null });
  assert.equal(first.status, 200);

  const roomRes = await getRoom(cookie, 9);
  const roomBody = await roomRes.json();
  assert.equal(roomBody.status, 'processing', 'a report with no ai_score yet must show as processing, never ready');
  assert.equal(roomBody.report.id, String(id), 'the report itself (similarity result) must still be returned while processing');
  assert.equal(roomBody.report.aiScore, null);
  assert.ok(typeof roomBody.cycleEndsAt === 'string', 'occupancy/cycle information must still be present while processing');

  const indexRes = await getRoomIndex(cookie);
  const indexBody = await indexRes.json();
  const room9 = indexBody.rooms.find((r) => r.room === 9);
  assert.equal(room9.status, 'processing');

  // Still occupied for 409 purposes — a second upload must still be refused.
  const second = await postReport('device-processing-1', 9000000000019, { cookie, room: 9, aiScore: null, aiTone: null });
  assert.equal(second.status, 409, 'a room mid-AI-analysis must still refuse a second upload — it is occupied, just not fully analyzed yet');

  // The AI-enriched resave lands (same id, same room, now a real aiScore) — the room flips to "ready".
  const resave = await postReport('device-processing-1', id, { cookie, room: 9, aiScore: 34, aiTone: 'review', payloadOverrides: { title: 'ai-enriched.pdf' } });
  assert.equal(resave.status, 200);

  const readyRoomRes = await getRoom(cookie, 9);
  const readyRoomBody = await readyRoomRes.json();
  assert.equal(readyRoomBody.status, 'ready', 'once ai_score is recorded, the room must flip to ready');
  assert.equal(readyRoomBody.report.aiScore, 34);
  assert.equal(readyRoomBody.report.aiTone, 'review');

  const readyIndexRes = await getRoomIndex(cookie);
  const readyIndexBody = await readyIndexRes.json();
  const readyRoom9 = readyIndexBody.rooms.find((r) => r.room === 9);
  assert.equal(readyRoom9.status, 'ready');

  console.log('a room mid-AI-analysis reports itself as processing (never a fake ready), still counts as occupied, and flips to ready once ai_score lands');
}

// 9. Production audit fix: a genuinely FAILED AI check (ai_status='failed',
// ai_score still null) is its own distinct status — never "processing"
// (which would leave it stuck-looking for the rest of the room's 24h
// cycle) and never silently "ready" with a blank score. This is a real,
// terminal outcome, distinguishable from "still running" (aiScore null,
// aiStatus 'processing' or unset) purely from the persisted columns — see
// lib/report-rooms.ts's deriveRoomStatus.
{
  const signupRes = await signup({ email: 'rooms-ai-failed@example.com', password: 'correct-horse-9', username: 'roomsaifailed', deviceKey: 'device-failed-1' });
  const cookie = extractCookie(signupRes);

  // The similarity-only first save: genuinely still processing.
  const id = 1100000000001;
  const first = await postReport('device-failed-1', id, { cookie, room: 1, aiScore: null, aiTone: null, aiStatus: 'processing' });
  assert.equal(first.status, 200);

  const processingRoomRes = await getRoom(cookie, 1);
  const processingRoomBody = await processingRoomRes.json();
  assert.equal(processingRoomBody.status, 'processing', 'an explicit aiStatus of "processing" must still read as processing, exactly like the legacy (unset) case');

  // The AI-enriched resave lands, but the AI check itself genuinely failed
  // (worker error / unsupported document) — ai_score stays null, but
  // ai_status now says so explicitly.
  const resave = await postReport('device-failed-1', id, { cookie, room: 1, aiScore: null, aiTone: 'unavailable', aiStatus: 'failed', payloadOverrides: { title: 'ai-failed.pdf' } });
  assert.equal(resave.status, 200);

  const failedRoomRes = await getRoom(cookie, 1);
  const failedRoomBody = await failedRoomRes.json();
  assert.equal(failedRoomBody.status, 'failed', 'a genuinely failed AI check must read as "failed", never "processing" or a fake "ready"');
  assert.equal(failedRoomBody.report.id, String(id));
  assert.equal(failedRoomBody.report.aiScore, null, 'a failed AI check must never carry a fabricated score');
  assert.equal(failedRoomBody.report.title, 'ai-failed.pdf', 'the similarity result itself must remain intact and unaffected by the AI failure');

  const failedIndexRes = await getRoomIndex(cookie);
  const failedIndexBody = await failedIndexRes.json();
  const failedRoom1 = failedIndexBody.rooms.find((r) => r.room === 1);
  assert.equal(failedRoom1.status, 'failed', 'the lightweight room index must also report "failed", not "processing", without needing to open the room');

  // A "failed" room still counts as occupied for 409 purposes — it is not
  // a free slot just because the AI half didn't produce a score.
  const secondUpload = await postReport('device-failed-1', 1100000000002, { cookie, room: 1 });
  assert.equal(secondUpload.status, 409, 'a room whose AI check failed must still refuse a second upload — the similarity result is a real, current occupant');

  // Retry: the AI check is re-run and this time succeeds — the room must
  // flip cleanly from "failed" to "ready", the same one-room-one-slot row
  // updated in place (never a duplicate).
  const retrySuccess = await postReport('device-failed-1', id, { cookie, room: 1, aiScore: 41, aiTone: 'review', aiStatus: 'ready', payloadOverrides: { title: 'ai-failed.pdf' } });
  assert.equal(retrySuccess.status, 200);

  const recoveredRoomRes = await getRoom(cookie, 1);
  const recoveredRoomBody = await recoveredRoomRes.json();
  assert.equal(recoveredRoomBody.status, 'ready', 'a retried AI check that succeeds must flip the room to ready');
  assert.equal(recoveredRoomBody.report.aiScore, 41);

  // Legacy/unset aiStatus (every pre-0028 row, and any client that never
  // sends the field) must still fall back to the original binary
  // ai_score-null-or-not derivation, completely unaffected by this feature.
  const legacyId = 1100000000009;
  const legacyProcessing = await postReport('device-failed-1', legacyId, { cookie, room: 2, aiScore: null, aiTone: null, aiStatus: undefined });
  assert.equal(legacyProcessing.status, 200);
  const legacyRoomRes = await getRoom(cookie, 2);
  const legacyRoomBody = await legacyRoomRes.json();
  assert.equal(legacyRoomBody.status, 'processing', 'a row with no aiStatus at all (legacy) must still resolve via the pre-existing ai_score-only fallback');

  console.log('a genuinely failed AI check is its own distinct "failed" status (never a stuck "processing" or a fake "ready"), stays occupied for 409 purposes, can recover to "ready" via retry, and legacy rows with no aiStatus fall back unchanged');
}

// 10. Production audit fix: two genuinely CONCURRENT new uploads targeting
// the SAME empty room (the same account open in two tabs, both starting a
// check within the same window) must never both succeed — the occupancy
// check and the insert are now one atomic transaction (see
// app/api/reports/route.ts's own comment), so exactly one wins and the
// other gets a real 409, instead of the room silently ending up with
// whichever row happened to be written last while the "loser" believes its
// own upload succeeded.
{
  const signupRes = await signup({ email: 'rooms-concurrent@example.com', password: 'correct-horse-10', username: 'roomsconcurrent', deviceKey: 'device-concurrent-1' });
  const cookie = extractCookie(signupRes);

  const idA = 1200000000001;
  const idB = 1200000000002;
  const [resA, resB] = await Promise.all([
    postReport('device-concurrent-1', idA, { cookie, room: 7, payloadOverrides: { title: 'concurrent-a.pdf' } }),
    postReport('device-concurrent-1', idB, { cookie, room: 7, payloadOverrides: { title: 'concurrent-b.pdf' } }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one concurrent upload into the same empty room must succeed and the other must be refused — never both 200');

  const roomRes = await getRoom(cookie, 7);
  const roomBody = await roomRes.json();
  assert.equal(roomBody.status, 'ready');
  const winnerId = resA.status === 200 ? String(idA) : String(idB);
  assert.equal(roomBody.report.id, winnerId, 'the room must hold exactly the winning upload, not the loser and not both');

  // The loser's row must never have been silently inserted into this room
  // either — confirm the DB itself holds only one row with room_number = 7
  // for this account, not two.
  const client = createClient({ url: `file:${dbFile}` });
  const roomRows = await client.execute({
    sql: 'SELECT id FROM saved_reports WHERE user_id = (SELECT id FROM users WHERE email = ?) AND room_number = 7',
    args: ['rooms-concurrent@example.com'],
  });
  client.close();
  assert.equal(roomRows.rows.length, 1, 'exactly one row may ever occupy room_number=7 for this account — the loser must never have been inserted at all');

  console.log('two genuinely concurrent uploads into the same empty room never both succeed — exactly one wins, the other gets a real 409, and only the winner is ever persisted');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All report-rooms server-side tests passed');
