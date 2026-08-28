import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as resetAccountRoomsRoute from '../app/api/developer/reset-account-rooms/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.js';
import { deleteAllReportDataForAccount } from '../lib/account-deletion.ts';
import { statusLabel } from '../components/reports/report-rooms.tsx';

/**
 * BUG: after a report is deleted (developer "Clear account rooms" by email,
 * account deletion, or single-report delete), the affected rooms must
 * render EXACTLY like a never-used empty room — no green accent, no "Report
 * ready", no stale last-checked date. This proves the AUTHORITATIVE layer:
 * GET /api/reports/rooms is derived purely from saved_reports and returns a
 * canonical empty room the moment its report is gone. Real DB, real routes.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_rooms_empty_after_reset.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const ADMIN_EMAIL = 'admin@roomsempty.test';
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = ADMIN_EMAIL;

const db = createClient({ url: `file:${dbFile}` });
await db.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(db, drizzleDir);

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const PASSWORD = 'rooms-empty-after-reset-pw-1';

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie && setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  const ip = 'rear-signup-' + email;
  await resetAuthRateForTest(ip);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: PASSWORD, username: email.split('@')[0].replace(/[^a-z0-9]/gi, ''), deviceKey }),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}

let seq = 0;
/** Posts a report already in a terminal READY state (ai_score set). */
async function postReadyReport(deviceKey, cookie, room, text) {
  const ip = 'rear-post';
  await resetRateForTest(ip);
  const reportId = `rear-report-${seq++}-${randomUUID()}`;
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey, id: reportId, submissionId: 'sub-' + reportId, title: reportId + '.pdf',
      createdAt: new Date().toISOString(), wordCount: 90, archiveScore: 4, scoreBand: 'Low',
      aiScore: 12, aiTone: 'human', aiStatus: 'ready', room,
      payload: {
        version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title: reportId + '.pdf', author: '',
        assignment: '', created: new Date().toISOString(), score: 4, archiveScore: 4, text,
        wordCount: 90, characterCount: 700, pageCount: 1, fileSize: '1 KB', databaseSize: 230,
        corpusVersion: 'test', scoreBand: 'Low', aiScore: 12,
      },
    }),
  }));
  assert.equal(res.status, 200, `postReadyReport ${reportId} (${res.status})`);
  return { reportId, deviceKey };
}

async function roomIndex(cookie) {
  const ip = 'rear-rooms-' + (seq++);
  await resetRateForTest(ip);
  await resetReadRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const res = await roomsRoute.GET(new Request('http://localhost/api/reports/rooms', { headers }));
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

async function deleteReport(cookie, reportId) {
  const ip = 'rear-del-' + (seq++);
  await resetRateForTest(ip);
  const res = await reportIdRoute.DELETE(
    new Request(`http://localhost/api/reports/${reportId}`, {
      method: 'DELETE',
      headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
    }),
    { params: Promise.resolve({ id: reportId }) },
  );
  assert.equal(res.status, 200, `deleteReport ${reportId} (${res.status})`);
}

async function callReset(cookie, body) {
  const ip = 'rear-reset-' + (seq++);
  await resetRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const res = await resetAccountRoomsRoute.POST(new Request('http://localhost/api/developer/reset-account-rooms', {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function userIdFor(email) {
  const r = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return r.rows[0] ? String(r.rows[0].id) : null;
}

/** The exact structural invariant: NO CURRENT SAVED REPORT => canonical EMPTY room. */
function assertCanonicalEmptyRoom(entry, roomNumber) {
  assert.equal(entry.room, roomNumber);
  assert.equal(entry.status, 'empty', `Room ${roomNumber + 1} must be status:'empty' (no ready/processing/failed)`);
  assert.equal(entry.mostRecentAt, null, `Room ${roomNumber + 1} must have no stale last-checked timestamp`);
  assert.equal(entry.cycleEndsAt, null, `Room ${roomNumber + 1} must have no lifecycle cycle`);
  assert.ok(!('reportId' in entry) && !('id' in entry), `Room ${roomNumber + 1} must expose no report id`);
  // UI-derived: className + label + the "Last checked" date condition.
  assert.equal(`report-room-row-${entry.status}`, 'report-room-row-empty', `Room ${roomNumber + 1} must not get the green .report-room-row-ready class`);
  assert.equal(statusLabel(entry.status), 'Ready for a new check', `Room ${roomNumber + 1} label must be "Ready for a new check"`);
  assert.equal(Boolean(entry.mostRecentAt), false, 'the " · Last checked …" suffix condition (entry.mostRecentAt) must be falsy');
}

function assertReadyRoom(entry, roomNumber) {
  assert.equal(entry.room, roomNumber);
  assert.equal(entry.status, 'ready');
  assert.ok(entry.mostRecentAt, 'a ready room carries its occupant timestamp');
  assert.ok(entry.cycleEndsAt);
  assert.equal(`report-room-row-${entry.status}`, 'report-room-row-ready');
  assert.equal(statusLabel(entry.status), 'Report ready');
}

// --- Fixtures ------------------------------------------------------

const cookieAdmin = await signup(ADMIN_EMAIL, 'device-rear-admin');
const cookieT = await signup('target@roomsempty.test', 'device-rear-t');
const idT = await userIdFor('target@roomsempty.test');
const cookieO = await signup('other@roomsempty.test', 'device-rear-o');
const cookieP = await signup('direct@roomsempty.test', 'device-rear-p');
const idP = await userIdFor('direct@roomsempty.test');

// T: ready reports in rooms 1 and 4 (displayed as "Room 2" / "Room 5").
await postReadyReport('device-rear-t', cookieT, 1, 'Target report about tidal marsh sediment accretion under sea-level rise.');
await postReadyReport('device-rear-t', cookieT, 4, 'Target report about boreal peatland methane flux across a burn chronosequence.');

// O: a ready report in room 0 and one in room 3.
const oRoom0 = await postReadyReport('device-rear-o', cookieO, 0, 'Other account report about coral bleaching recovery trajectories.');
await postReadyReport('device-rear-o', cookieO, 3, 'Other account report about alpine treeline advance rates over fifty years.');

// P: ready reports in rooms 2 and 6, deleted via the helper directly.
await postReadyReport('device-rear-p', cookieP, 2, 'Direct-helper report about seagrass meadow carbon burial rates.');
await postReadyReport('device-rear-p', cookieP, 6, 'Direct-helper report about mangrove propagule dispersal distances.');

// --- 4: room list reports those rooms as occupied/ready BEFORE deletion

test('BEFORE: T\'s rooms 1 and 4 are "ready" with occupant timestamps', async () => {
  const rooms = await roomIndex(cookieT);
  assertReadyRoom(rooms[1], 1);
  assertReadyRoom(rooms[4], 4);
  // every other room is already a canonical empty room
  for (const entry of rooms) {
    if (entry.room !== 1 && entry.room !== 4) assertCanonicalEmptyRoom(entry, entry.room);
  }
});

// --- 5,6,7: delete via developer "Clear account rooms" by email, recompute

test('THE BUG FIX: after "Clear account rooms" by email, EVERY one of T\'s rooms is a canonical empty room', async () => {
  const preview = await callReset(cookieAdmin, { email: 'target@roomsempty.test', dryRun: true });
  assert.equal(preview.body.reportsToDelete, 2);
  assert.deepEqual(preview.body.roomsAffected, [1, 4]);

  const del = await callReset(cookieAdmin, { email: 'target@roomsempty.test', dryRun: false, confirmEmail: 'target@roomsempty.test' });
  assert.equal(del.status, 200);
  assert.equal(del.body.reportsDeleted, 2);

  const rooms = await roomIndex(cookieT);
  assert.equal(rooms.length > 4, true);
  // Rooms 1 and 4 — the ones that looked green/"Report ready"/"Last checked" — are now indistinguishable from a never-used room.
  assertCanonicalEmptyRoom(rooms[1], 1);
  assertCanonicalEmptyRoom(rooms[4], 4);
  // And NOT ONE room in T's whole list is non-empty any more.
  assert.equal(rooms.every((entry) => entry.status === 'empty'), true, 'no room may still look occupied for an account with zero reports');
  assert.equal(rooms.every((entry) => entry.mostRecentAt === null && entry.cycleEndsAt === null), true);
});

// --- account isolation

test('ISOLATION: the reset for T never changed account O\'s room summaries', async () => {
  const rooms = await roomIndex(cookieO);
  assertReadyRoom(rooms[0], 0);
  assertReadyRoom(rooms[3], 3);
});

// --- normal single-report deletion still reconciles + a live room stays occupied

test('SINGLE-REPORT DELETE: deleting O\'s room-0 report empties room 0 while room 3 stays "ready"', async () => {
  await deleteReport(cookieO, oRoom0.reportId);
  const rooms = await roomIndex(cookieO);
  assertCanonicalEmptyRoom(rooms[0], 0);
  assertReadyRoom(rooms[3], 3);
});

// --- requirement 5 verbatim: the SAME underlying account-scoped cleanup helper

test('DIRECT HELPER: deleteAllReportDataForAccount (the cleanup developer reset calls) empties P\'s rooms to canonical', async () => {
  const before = await roomIndex(cookieP);
  assertReadyRoom(before[2], 2);
  assertReadyRoom(before[6], 6);

  const result = await deleteAllReportDataForAccount(db, idP, { preserveActivelyPromotedRepresentations: true });
  assert.equal(result.reportsDeleted, 2);

  const after = await roomIndex(cookieP);
  assertCanonicalEmptyRoom(after[2], 2);
  assertCanonicalEmptyRoom(after[6], 6);
  assert.equal(after.every((entry) => entry.status === 'empty'), true);
});

// --- account/session survives the reset (existing account-reset semantics unchanged)

test('the reset did not delete T\'s account — the room list is served to a still-valid T session', async () => {
  assert.equal(await userIdFor('target@roomsempty.test'), idT, 'T users row intact');
  const rooms = await roomIndex(cookieT); // would 200 with [] only if the session were gone; here it 200s with real (empty) rooms
  assert.ok(rooms.length >= 10, 'T still has a full room list (session valid, account intact)');
});
