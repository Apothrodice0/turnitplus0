import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportByIdRoute from '../app/api/reports/[id]/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { listEarlierRoomReports } from '../lib/reports-repo.ts';
import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '../lib/account-deletion.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

// REPORT HISTORY RETENTION (lib/report-history.ts, owner decision 2026-10-29): behind REPORT_HISTORY_RETENTION_ENABLED,
// a room reused after its 24 h cycle KEEPS its earlier report; the room's current report and its cycle come from the
// server's saved_at, never the browser's createdAt. The cooldown, purchased room limits and deletion paths are
// unchanged. Every scenario goes through the real route handlers against a real migrated database.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_report_history_retention.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;
delete process.env.ACCOUNT_ACTIVATION_ENFORCED;
delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
delete process.env.REPORT_HISTORY_RETENTION_ENABLED;

const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));
const retain = (on) => (on ? (process.env.REPORT_HISTORY_RETENTION_ENABLED = '1') : delete process.env.REPORT_HISTORY_RETENTION_ENABLED);
const enforce = (on) => (on ? (process.env.ACCOUNT_ACTIVATION_ENFORCED = '1') : delete process.env.ACCOUNT_ACTIVATION_ENFORCED);

let n = 0;
const ip = (tag) => `hist-${tag}-${++n}`;
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
async function signup(email) {
  const addr = ip('signup');
  await resetAuthRateForTest(addr);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username: email.split('@')[0], deviceKey: `dev-${email}` })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  const id = String((await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  await db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE id = ?', args: [Date.now(), id] });
  return { id, email, cookie: cookieOf(res), deviceKey: `dev-${email}` };
}
async function postReport(user, id, { room, createdAt, aiScore = 12, text } = {}) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = createdAt ?? new Date().toISOString();
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` },
    body: JSON.stringify({
      deviceKey: user.deviceKey, id: String(id), submissionId: String(id).slice(-10), title: `report-${id}.pdf`, createdAt: created,
      wordCount: 400, archiveScore: 7, scoreBand: 'Low', aiScore, aiTone: 'low', room,
      payload: { version: 11, id: String(id), submissionId: String(id).slice(-10), title: `report-${id}.pdf`, created, score: 7, wordCount: 400, text: text ?? `history manuscript ${id}` },
    }),
  }));
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
}
async function getJson(route, url, cookie, params) {
  const addr = ip('get');
  await resetReadRateForTest(addr);
  await resetRateForTest(addr);
  const headers = { 'x-forwarded-for': addr, ...(cookie ? { cookie: `tp_session_v1=${cookie}` } : {}) };
  const res = params ? await route.GET(new Request(url, { headers }), { params: Promise.resolve(params) }) : await route.GET(new Request(url, { headers }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const roomIndex = (u) => getJson(roomsRoute, 'http://localhost/api/reports/rooms', u.cookie);
const roomNow = (u, room) => getJson(reportsRoute, `http://localhost/api/reports?room=${room}`, u.cookie);
const reportById = (u, id) => getJson(reportByIdRoute, `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(u.deviceKey)}`, u.cookie, { id: String(id) });
async function deleteReport(u, id) {
  const res = await reportByIdRoute.DELETE(new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(u.deviceKey)}`, {
    method: 'DELETE', headers: { 'x-forwarded-for': ip('del'), cookie: `tp_session_v1=${u.cookie}` },
  }), { params: Promise.resolve({ id: String(id) }) });
  return res.status;
}
/** Make a saved report (and its room claim) look `hours` older by the SERVER clock — the only clock the room trusts. */
async function ageReport(u, id, hours) {
  await db.execute({ sql: "UPDATE saved_reports SET saved_at = datetime(saved_at, ?) WHERE id = ?", args: [`-${hours} hours`, String(id)] });
  await db.execute({ sql: 'UPDATE account_room_claims SET claimed_at = claimed_at - ? WHERE user_id = ?', args: [hours * 3600000, u.id] });
}
const rowsOf = async (u) => (await db.execute({ sql: 'SELECT id, room_number FROM saved_reports WHERE user_id = ? ORDER BY rowid', args: [u.id] })).rows.map((r) => [String(r.id), Number(r.room_number)]);
async function grant(adminCookie, body) {
  const call = async (b) => {
    const addr = ip('admin');
    await resetAdminRateForTest(addr);
    const res = await applyRoute.POST(new Request('http://localhost/api/admin/account-activation/apply', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, host: 'localhost', origin: 'http://localhost', cookie: `tp_session_v1=${adminCookie}` }, body: JSON.stringify(b),
    }));
    return { status: res.status, body: await res.json() };
  };
  const p = await call({ ...body, dryRun: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await call({ ...body, dryRun: false, operationId: crypto.randomUUID(), expectedVersion: p.body.preview.expectedVersion, expectedUserId: p.body.preview.expectedUserId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
}

const results = [];
const pass = (name) => { results.push(name); console.log(`ok - ${name}`); };

const admin = await signup('history-admin@example.com');
await grantTestAdmin(dbFile, admin.email);

// ── R0. Flag OFF: the existing behaviour — a reused room replaces (deletes) its earlier report ─────────────────────────
{
  const u = await signup('legacy-replace@example.com');
  assert.equal((await postReport(u, 5000000000001, { room: 0 })).status, 200);
  await ageReport(u, 5000000000001, 25);
  await db.execute({ sql: "UPDATE saved_reports SET report_created_at = ? WHERE id = '5000000000001'", args: [new Date(Date.now() - 25 * 3600000).toISOString()] });
  assert.equal((await postReport(u, 5000000000002, { room: 0 })).status, 200);
  assert.deepEqual(await rowsOf(u), [['5000000000002', 0]], 'flag off: the earlier report is replaced, exactly as before');
  pass('R0 retention off: room reuse still replaces the earlier report (unchanged behaviour)');
}

retain(true);

// ── R1. Several reports in one room: all kept, newest by the server clock is current, earlier ones listed and readable ─
let u1;
{
  u1 = await signup('history-customer@example.com');
  for (const id of [5100000000001, 5100000000002, 5100000000003]) {
    assert.equal((await postReport(u1, id, { room: 2, text: `kept manuscript ${id} with its own evidence` })).status, 200, `check ${id}`);
    if (id !== 5100000000003) {
      assert.equal((await postReport(u1, id + 100, { room: 2 })).status, 409, 'the 24 h cooldown is unchanged');
      await ageReport(u1, id, 25);
    }
  }
  assert.deepEqual((await rowsOf(u1)).map(([id]) => id), ['5100000000001', '5100000000002', '5100000000003'], 'all three reports are kept');
  const current = await roomNow(u1, 2);
  assert.equal(current.body.report.id, '5100000000003', 'the newest (server clock) is the current report');
  const idx = await roomIndex(u1);
  assert.equal(idx.body.rooms.find((r) => r.room === 2).status, 'ready');
  const earlier = await listEarlierRoomReports(db, u1.id, 2, '5100000000003');
  assert.deepEqual(earlier.map((r) => r.id), ['5100000000002', '5100000000001'], 'the room history lists the earlier reports, newest first');
  for (const id of ['5100000000001', '5100000000002']) {
    const r = await reportById(u1, id);
    assert.equal(r.status, 200, `earlier report ${id} opens by its own link`);
    assert.ok(JSON.stringify(r.body).includes(`kept manuscript ${id} with its own evidence`), `report ${id} keeps its full saved content (evidence, highlights, AI result — the receipt is generated from it)`);
  }
  pass('R1 three checks in one room: all kept; the newest by saved_at is current; the earlier two are listed newest-first and open in full');
}

// ── R2. Browser dates are never trusted for order or cooldown ───────────────────────────────────────────────────────
{
  const u = await signup('backdater@example.com');
  const r1 = await postReport(u, 5200000000001, { room: 0 });
  assert.equal(r1.status, 200);
  const backdated = await postReport(u, 5200000000002, { room: 0, createdAt: new Date(Date.now() - 3 * 86400000).toISOString() });
  assert.equal(backdated.status, 409, 'a back-dated createdAt cannot fake an elapsed cycle: the room is busy by the server clock');
  await ageReport(u, 5200000000001, 25);
  assert.equal((await postReport(u, 5200000000003, { room: 0, createdAt: new Date(Date.now() - 10 * 86400000).toISOString() })).status, 200);
  assert.equal((await roomNow(u, 0)).body.report.id, '5200000000003', 'the newest SAVE is current even though its browser date is older');
  assert.equal((await postReport(u, 5200000000004, { room: 0 })).status, 409, 'and it holds the room for 24 h from when the server saved it');
  pass('R2 order and cooldown follow saved_at: a back-dated browser date can neither free a room nor hide the newest report');
}

// ── R3. Direct links stay private ────────────────────────────────────────────────────────────────────────────────────
{
  const stranger = await signup('stranger@example.com');
  const r = await getJson(reportByIdRoute, `http://localhost/api/reports/5100000000001?deviceKey=${encodeURIComponent(stranger.deviceKey)}`, stranger.cookie, { id: '5100000000001' });
  assert.equal(r.status, 404, "another account cannot open a customer's earlier report");
  const anon = await getJson(reportByIdRoute, 'http://localhost/api/reports/5100000000001?deviceKey=dev-history-customer%40example.com', null, { id: '5100000000001' });
  assert.notEqual(anon.status, 200, 'nor can a signed-out caller who guesses the device key');
  assert.deepEqual(await listEarlierRoomReports(db, stranger.id, 2, null), [], "and nobody else's history is ever listed");
  pass('R3 earlier reports open only for their own signed-in account');
}

enforce(true);

// ── R4. Active subscriber: purchased rooms and cooldown unchanged; reuse keeps history ───────────────────────────────
let sub;
{
  sub = await signup('history-subscriber@example.com');
  await grant(admin.cookie, { email: sub.email, action: 'activate', planDays: 30, rooms: 2 });
  assert.equal((await postReport(sub, 5300000000001, { room: 0 })).status, 200);
  assert.equal((await postReport(sub, 5300000000002, { room: 0 })).status, 409, '24 h cooldown unchanged');
  const outside = await postReport(sub, 5300000000003, { room: 2 });
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, 'ROOM_NOT_IN_PLAN', 'purchased room limit unchanged');
  await ageReport(sub, 5300000000001, 25);
  assert.equal((await postReport(sub, 5300000000004, { room: 0 })).status, 200, 'the room is reusable after 24 h by the server clock');
  assert.deepEqual((await rowsOf(sub)).map(([id]) => id), ['5300000000001', '5300000000004'], 'and its earlier report is kept');
  pass('R4 active subscriber: rooms 1–2 only, 24 h cooldown, reuse after 24 h keeps the earlier report');
}

// ── R5. Suspension and expiry: no report access, nothing new starts, nothing deleted by access control alone ────────────────────────────────────────────
{
  await grant(admin.cookie, { email: sub.email, action: 'suspend', reason: 'History retention test' });
  const suspended = await roomIndex(sub);
  assert.deepEqual(suspended.body.rooms, [], 'suspended: no room is listed (owner decision 2026-10-30)');
  assert.equal((await roomNow(sub, 0)).status, 403, 'the room poll refuses');
  assert.equal((await reportById(sub, '5300000000001')).status, 403, 'and so does every report');
  assert.deepEqual((await rowsOf(sub)).map(([id]) => id), ['5300000000001', '5300000000004'], 'both are kept while the suspension can be reversed');
  assert.equal((await postReport(sub, 5300000000005, { room: 1 })).status, 403, 'no new check while suspended');
  await db.execute({ sql: 'UPDATE account_entitlements SET status = ?, suspended_at = NULL, expires_at = ? WHERE user_id = ?', args: ['active', Date.now() - 1000, sub.id] });
  assert.equal((await reportById(sub, '5300000000001')).status, 403, 'expired: refused at once, with or without cleanup');
  assert.equal((await roomNow(sub, 0)).status, 403);
  const expired = await postReport(sub, 5300000000006, { room: 1 });
  assert.equal(expired.body.code, 'PLAN_EXPIRED', 'no new check after expiry');
  pass('R5 suspended or expired: no room, no report, no new check; a suspended plan keeps its reports');
}

// ── R6. Administrators: unrestricted, and their history is kept too ──────────────────────────────────────────────────
{
  assert.equal((await postReport(admin, 5400000000001, { room: 30 })).status, 200, 'admin room 31');
  await ageReport(admin, 5400000000001, 25);
  assert.equal((await postReport(admin, 5400000000002, { room: 30 })).status, 200);
  assert.deepEqual((await rowsOf(admin)).map(([id]) => id), ['5400000000001', '5400000000002']);
  pass('R6 administrators stay unrestricted (room 31) and keep their history');
}

// ── R7. Explicit deletion and account deletion still remove exactly what they should ────────────────────────────────
{
  assert.equal(await deleteReport(u1, '5100000000002'), 200, 'the customer deletes one earlier report');
  assert.deepEqual((await rowsOf(u1)).map(([id]) => id), ['5100000000001', '5100000000003'], 'only that report is gone');
  assert.equal((await reportById(u1, '5100000000002')).status, 403, 'this account has no subscription: every report id answers the same refusal');
  assert.deepEqual((await listEarlierRoomReports(db, u1.id, 2, '5100000000003')).map((r) => r.id), ['5100000000001']);
  assert.equal(await deleteReport(u1, '5100000000003'), 200, 'then the current one');
  assert.equal((await roomNow(u1, 2)).status, 403, 'the room (no subscription) stays refused');
  assert.deepEqual((await rowsOf(u1)).map(([id]) => id), ['5100000000001'], 'the remaining earlier report is untouched');
  const identitiesBefore = Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', args: [u1.id] })).rows[0].c);
  const me = await meRoute.DELETE(new Request('http://localhost/api/auth/me', {
    method: 'DELETE', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip('me'), cookie: `tp_session_v1=${u1.cookie}` },
    body: JSON.stringify({ password: 'correct-horse-1', confirm: ACCOUNT_DELETION_CONFIRMATION_PHRASE }),
  }));
  assert.equal(me.status, 200, 'account deletion works');
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', args: [u1.id] })).rows[0].c), 0, 'every kept report goes with the account');
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', args: [u1.id] })).rows[0].c), 0, `and their document identities (${identitiesBefore} before)`);
  pass('R7 deleting one report removes only it; deleting the account removes every kept report and its document data');
}

retain(false);
enforce(false);
db.close();
console.log(`\n${results.length} report-history retention scenarios passed`);
