import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportByIdRoute from '../app/api/reports/[id]/route.ts';
import * as aiRetryRoute from '../app/api/reports/[id]/ai-retry/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import * as sweepRoute from '../app/api/internal/subscription-expiry-sweep/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { deleteAllReportDataForAccount } from '../lib/account-deletion.ts';
import { applyActivationAction } from '../lib/account-activation-admin.ts';
import { cleanupExpiredSubscriptionReports, expiryCleanupAllowedFor, expiryCleanupMode, runSubscriptionExpirySweep, sqliteTimestamp } from '../lib/subscription-expiry-cleanup.ts';
import { PERSIST_SYSTEM2_ESTIMATE_SQL } from '../lib/system2-estimate-record.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

// SUBSCRIPTION EXPIRY CLEANUP (lib/subscription-expiry-cleanup.ts, owner decision 2026-10-30): access is refused the
// moment a plan ends; an expired plan's reports and report-specific document data are really deleted (rows counted here,
// not just hidden); suspension keeps them; a renewal starts empty; nothing of another account or a shared corpus record
// is touched. Every scenario goes through the real route handlers against a real migrated database.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_subscription_expiry_cleanup.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;
delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
process.env.ACCOUNT_ACTIVATION_ENFORCED = '1';
process.env.REPORT_HISTORY_RETENTION_ENABLED = '1';
process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'on';
process.env.CRON_SECRET = 'expiry-sweep-test-secret';

const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));

let n = 0;
const ip = (tag) => `expiry-${tag}-${++n}`;
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
async function signup(email) {
  const addr = ip('signup');
  await resetAuthRateForTest(addr);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username: email.split('@')[0].slice(0, 30), deviceKey: `dev-${email}` })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  const id = String((await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  await db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE id = ?', args: [Date.now(), id] });
  return { id, email, cookie: cookieOf(res), deviceKey: `dev-${email}` };
}
let seq = 7100000000000;
async function postReport(user, { room, id = String(++seq), text } = {}) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = new Date().toISOString();
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` },
    body: JSON.stringify({
      deviceKey: user.deviceKey, id, submissionId: id.slice(-10), title: `report-${id}.docx`, createdAt: created,
      wordCount: 400, archiveScore: 7, scoreBand: 'Low', aiScore: 12, aiTone: 'low', room,
      payload: { version: 11, id, submissionId: id.slice(-10), title: `report-${id}.docx`, created, score: 7, wordCount: 400, text: text ?? `expiry manuscript ${id} on groundwater recharge accounting across semi-arid basins and seasons` },
    }),
  }));
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null, id };
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
const reportById = (u, id) => getJson(reportByIdRoute, `http://localhost/api/reports/${id}`, u.cookie, { id: String(id) });
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
const count = async (sql, ...args) => Number((await db.execute({ sql, args })).rows[0].c);
const dataOf = async (u) => ({
  reports: await count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', u.id),
  identities: await count('SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', u.id),
  shingles: await count('SELECT COUNT(*) AS c FROM document_identity_shingles WHERE document_identity_id IN (SELECT id FROM document_identities WHERE account_id = ?)', u.id),
});
const adminRecords = async (u) => ({
  user: await count('SELECT COUNT(*) AS c FROM users WHERE id = ?', u.id),
  plan: await count('SELECT COUNT(*) AS c FROM account_entitlements WHERE user_id = ?', u.id),
  events: await count('SELECT COUNT(*) AS c FROM account_entitlement_events WHERE user_id = ?', u.id),
});
const expire = (u) => db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [Date.now() - 1000, u.id] });
const account = (u) => ({ id: u.id, email: u.email });
const freeRoom = async (u, room) => {
  await db.execute({ sql: "UPDATE saved_reports SET saved_at = datetime(saved_at, '-25 hours'), report_created_at = datetime(report_created_at, '-25 hours') WHERE user_id = ? AND room_number = ?", args: [u.id, room] });
  await db.execute({ sql: 'UPDATE account_room_claims SET claimed_at = claimed_at - ? WHERE user_id = ? AND room_number = ?', args: [25 * 3600000, u.id, room] });
};

const results = [];
const pass = (name) => { results.push(name); console.log(`ok - ${name}`); };

const admin = await signup('expiry-admin@example.com');
await grantTestAdmin(dbFile, admin.email);
const activate = (u, rooms = 3) => grant(admin.cookie, { email: u.email, action: 'activate', planDays: 30, rooms });

// ── E1. The switch: off by default; "synthetic-only" reaches only @example.test accounts ─────────────────────────────
{
  assert.equal(expiryCleanupMode({}), 'off');
  assert.equal(expiryCleanupMode({ SUBSCRIPTION_EXPIRY_CLEANUP: 'nonsense' }), 'off');
  assert.equal(expiryCleanupMode({ SUBSCRIPTION_EXPIRY_CLEANUP: ' ON ' }), 'on');
  assert.equal(expiryCleanupMode({ SUBSCRIPTION_EXPIRY_CLEANUP: 'synthetic-only' }), 'synthetic-only');
  assert.equal(expiryCleanupAllowedFor('a@example.test', 'synthetic-only'), true);
  assert.equal(expiryCleanupAllowedFor('a@gmail.com', 'synthetic-only'), false);
  assert.equal(expiryCleanupAllowedFor('a@example.test.evil.com', 'synthetic-only'), false);
  assert.equal(expiryCleanupAllowedFor('a@example.test', 'off'), false);
  assert.equal(expiryCleanupAllowedFor('a@gmail.com', 'on'), true);
  pass('E1 cleanup is off by default; synthetic-only reaches only @example.test accounts');
}

// ── E2. Expiry: access refused at once; the report data is really deleted; the account and its records stay ─────────
{
  const u = await signup('e2@example.com');
  await activate(u);
  const r1 = await postReport(u, { room: 0 });
  const r2 = await postReport(u, { room: 1 });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  await db.execute({ sql: "INSERT OR IGNORE INTO report_historical_match_snapshots (report_device_key, report_id, status) VALUES (?, ?, 'complete')", args: [u.deviceKey, r1.id] });
  assert.ok(await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ?', u.deviceKey) >= 1, 'a match snapshot exists');
  const before = await dataOf(u);
  assert.equal(before.reports, 2);
  assert.ok(before.identities >= 2, 'each report has its document identity');
  assert.ok(before.shingles > 0, 'and its shingles');
  const records = await adminRecords(u);

  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'off';
  await expire(u);
  const refused = await reportById(u, r1.id);
  assert.equal(refused.status, 403, 'refused the moment the plan ends, with no cleanup having run');
  assert.equal(refused.body.code, 'PLAN_EXPIRED');
  assert.equal(JSON.stringify(refused.body).includes('manuscript'), false, 'no report content in the refusal');
  assert.equal((await roomNow(u, 0)).status, 403);
  assert.equal((await dataOf(u)).reports, 2, 'cleanup off: nothing deleted, still refused');
  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'on';

  const idx = await roomIndex(u);
  assert.deepEqual(idx.body.rooms, [], 'My Reports: no room');
  assert.equal(idx.body.lock.title, 'Subscription required');
  assert.deepEqual(await dataOf(u), { reports: 0, identities: 0, shingles: 0 }, 'the next visit deleted the reports, identities and shingles');
  assert.equal(await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ?', u.deviceKey), 0, 'and the match snapshot');
  assert.deepEqual(await adminRecords(u), records, 'the account, plan and audit trail are intact');
  assert.equal((await reportById(u, r1.id)).status, 403, 'a deleted report answers the same refusal');
  pass('E2 expiry: refused immediately; next visit really deletes reports, identities, shingles and snapshots; account, plan and audit stay');
}

// ── E3. Idempotent; a late resave never brings a report back; a straggling save is removed on the next run ──────────
{
  const u = await signup('e3@example.com');
  await activate(u);
  const r = await postReport(u, { room: 0 });
  await expire(u);
  const first = await cleanupExpiredSubscriptionReports(db, account(u));
  assert.equal(first.ran, true); assert.equal(first.reportsDeleted, 1);
  const second = await cleanupExpiredSubscriptionReports(db, account(u));
  assert.deepEqual(second, { ran: true, reportsDeleted: 0, identitiesProcessed: 0 }, 'a second run is a clean no-op');
  const resave = await postReport(u, { room: 0, id: r.id });
  assert.equal(resave.status, 403, 'the AI result of a check that was still running is refused');
  assert.equal((await dataOf(u)).reports, 0, 'and brings nothing back');
  await db.execute({
    sql: "INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number) VALUES ('straggler-e3', ?, 's', 't', ?, 1, 0, 'Low', '{}', ?, 0)",
    args: [u.deviceKey, new Date().toISOString(), u.id],
  });
  assert.equal((await reportById(u, 'straggler-e3')).status, 403, 'a save that slipped past its gate is never readable');
  await cleanupExpiredSubscriptionReports(db, account(u), Date.now() + 2000);
  assert.equal((await dataOf(u)).reports, 0, 'and the next run removes it');
  pass('E3 cleanup is idempotent; a late resave is refused and recreates nothing; a straggler is removed by the next run');
}

// ── E3b. Report-specific rows no report id leads to, and writes that arrive after cleanup ───────────────────────────
{
  const u = await signup('e3b@example.com');
  const neighbour = await signup('e3b-neighbour@example.com');
  await activate(u); await activate(neighbour);
  const r = await postReport(u, { room: 0 });
  const kept = await postReport(neighbour, { room: 0 });
  const snapshot = (device, id, at = '2026-01-01 00:00:00') => db.execute({ sql: "INSERT OR IGNORE INTO report_historical_match_snapshots (report_device_key, report_id, status, created_at) VALUES (?, ?, 'complete', ?)", args: [device, id, at] });
  await db.execute({ sql: 'UPDATE saved_reports SET device_key = ? WHERE id = ?', args: [u.deviceKey, kept.id] });
  await snapshot(u.deviceKey, kept.id);
  await snapshot(u.deviceKey, 'refused-save-never-stored');
  await snapshot(neighbour.deviceKey, 'other-device-orphan');
  await expire(u);
  await cleanupExpiredSubscriptionReports(db, account(u));
  const left = async (device, id) => count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', device, id);
  assert.equal(await left(u.deviceKey, 'refused-save-never-stored'), 0, 'a snapshot with no report behind it goes too');
  assert.equal(await left(u.deviceKey, kept.id), 1, "another account's report on the same device keeps its snapshot");
  assert.equal(await left(neighbour.deviceKey, 'other-device-orphan'), 1, 'and another device is never touched');
  assert.equal(await count('SELECT COUNT(*) AS c FROM saved_reports WHERE id = ?', kept.id), 1);
  const late = await db.execute({ sql: PERSIST_SYSTEM2_ESTIMATE_SQL, args: ['{"estimate":1}', u.deviceKey, r.id, u.id] });
  assert.equal(Number(late.rowsAffected), 0, 'a System 2 estimate arriving after cleanup has no row to write to');
  assert.equal((await dataOf(u)).reports, 0, 'and recreates nothing');
  pass('E3b orphaned snapshots go, a shared device keeps its neighbour\'s, and a late System 2 estimate recreates nothing');
}

// ── E4. Renewal after expiry starts empty, and no later cleanup touches the new plan's reports ──────────────────────
{
  const u = await signup('e4@example.com');
  await activate(u);
  const old = await postReport(u, { room: 0 });
  await expire(u);
  // No visit, no sweep: the owner re-activates straight away. The old history must still not come back.
  assert.equal((await dataOf(u)).reports, 1);
  await activate(u);
  assert.equal((await dataOf(u)).reports, 0, 'activating an expired account clears the expired plan first');
  assert.equal((await reportById(u, old.id)).status, 404, 'the old report is gone');
  assert.ok((await roomIndex(u)).body.rooms.every((r) => r.status === 'empty'), 'history starts empty');
  await freeRoom(u, 0);
  const fresh = await postReport(u, { room: 0 });
  assert.equal(fresh.status, 200, 'the new plan works');
  assert.deepEqual(await cleanupExpiredSubscriptionReports(db, account(u)), { ran: false, reason: 'not-expired' }, 'a late cleanup finds the plan active and stops');
  assert.equal((await runSubscriptionExpirySweep(db)).reportsDeleted, 0);
  assert.equal((await reportById(u, fresh.id)).status, 200, 'the new report is untouched');
  pass('E4 renewal after expiry starts with an empty history; later cleanups never touch the new plan');
}

// ── E5. The cutoff: a cleanup that lost a race with a renewal cannot reach anything saved after it ───────────────────
{
  const u = await signup('e5@example.com');
  await activate(u);
  const oldReport = await postReport(u, { room: 0 });
  const newReport = await postReport(u, { room: 1 });
  await db.execute({ sql: "UPDATE saved_reports SET saved_at = '2026-01-01 00:00:00' WHERE id = ?", args: [oldReport.id] });
  await db.execute({ sql: "UPDATE document_identities SET created_at = '2026-01-01 00:00:00' WHERE id = (SELECT document_identity_id FROM saved_reports WHERE id = ?)", args: [oldReport.id] });
  const result = await deleteAllReportDataForAccount(db, u.id, { preserveActivelyPromotedRepresentations: true, savedAtOrBefore: sqliteTimestamp(Date.UTC(2026, 5, 1)) });
  assert.equal(result.reportsDeleted, 1);
  assert.equal(result.identitiesProcessed, 1);
  const left = (await db.execute({ sql: 'SELECT id FROM saved_reports WHERE user_id = ?', args: [u.id] })).rows.map((r) => String(r.id));
  assert.deepEqual(left, [newReport.id], 'only the report from before the cutoff went');
  assert.equal((await dataOf(u)).identities, 1, 'the newer report keeps its document identity');
  assert.equal((await reportById(u, newReport.id)).status, 200);
  pass('E5 the cutoff keeps every report and identity newer than the moment the plan was confirmed expired');
}

// ── E6. Never another customer's data, and never a shared corpus record still in use ────────────────────────────────
{
  const a = await signup('e6a@example.com'), b = await signup('e6b@example.com');
  await activate(a); await activate(b);
  await postReport(a, { room: 0 }); const bReport = await postReport(b, { room: 0 });
  const aIdentity = String((await db.execute({ sql: 'SELECT id FROM document_identities WHERE account_id = ? LIMIT 1', args: [a.id] })).rows[0].id);
  const bIdentity = String((await db.execute({ sql: 'SELECT id FROM document_identities WHERE account_id = ? LIMIT 1', args: [b.id] })).rows[0].id);
  const rep = async (id) => db.execute({ sql: "INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, canonicalization_version) VALUES (?, ?, 'text', 1, 'v1')", args: [id, id] });
  await rep('rep-shared'); await rep('rep-only-a');
  const ref = async (repId, identity) => db.execute({ sql: "INSERT INTO corpus_submission_references (representation_id, document_identity_id, link_type) VALUES (?, ?, 'test')", args: [repId, identity] });
  await ref('rep-shared', aIdentity); await ref('rep-shared', bIdentity);
  const aReportsIdentity2 = (await postReport(a, { room: 1 })).id;
  const secondIdentity = String((await db.execute({ sql: 'SELECT document_identity_id AS d FROM saved_reports WHERE id = ?', args: [aReportsIdentity2] })).rows[0].d);
  await ref('rep-only-a', secondIdentity);
  const bBefore = await dataOf(b);
  await expire(a);
  await cleanupExpiredSubscriptionReports(db, account(a));
  assert.deepEqual(await dataOf(a), { reports: 0, identities: 0, shingles: 0 });
  assert.deepEqual(await dataOf(b), bBefore, 'the other customer is untouched');
  assert.equal((await reportById(b, bReport.id)).status, 200, 'and still reads their report');
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = 'rep-shared'"), 1, 'a corpus record the other customer still references stays');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_submission_references WHERE document_identity_id = ?', bIdentity), 1, 'with their reference');
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = 'rep-only-a'"), 0, "a corpus record only this customer's document used goes");
  pass("E6 cleanup never touches another customer's reports or a shared corpus record still in use");
}

// ── E7. Suspension: refused but preserved; reactivation restores; expiring while suspended cleans up ────────────────
{
  const u = await signup('e7@example.com');
  await activate(u);
  const r = await postReport(u, { room: 0 });
  await grant(admin.cookie, { email: u.email, action: 'suspend', reason: 'Payment query' });
  assert.equal((await reportById(u, r.id)).body.code, 'ACCOUNT_SUSPENDED');
  assert.deepEqual((await roomIndex(u)).body.rooms, []);
  assert.deepEqual(await cleanupExpiredSubscriptionReports(db, account(u)), { ran: false, reason: 'not-expired' }, 'a suspended plan within its term is never cleaned');
  assert.equal((await runSubscriptionExpirySweep(db)).reportsDeleted, 0);
  assert.equal((await dataOf(u)).reports, 1, 'its report is preserved');
  await grant(admin.cookie, { email: u.email, action: 'reactivate' });
  assert.equal((await reportById(u, r.id)).status, 200, 'reactivation restores access to the same report');
  await grant(admin.cookie, { email: u.email, action: 'suspend', reason: 'Payment query again' });
  await expire(u);
  assert.equal((await reportById(u, r.id)).body.code, 'PLAN_EXPIRED', 'a suspended plan that reaches its end is expired');
  assert.equal((await dataOf(u)).reports, 0, 'and is cleaned up normally');
  pass('E7 suspension refuses but preserves; reactivation restores; a suspended plan that expires is cleaned up');
}

// ── E8. Never-activated accounts: nothing readable, nothing deleted ─────────────────────────────────────────────────
{
  process.env.ACCOUNT_ACTIVATION_ENFORCED = '';
  const u = await signup('e8@example.com');
  const r = await postReport(u, { room: 0 });
  assert.equal(r.status, 200, 'a report saved before enforcement');
  process.env.ACCOUNT_ACTIVATION_ENFORCED = '1';
  assert.equal((await reportById(u, r.id)).body.code, 'ACTIVATION_REQUIRED');
  assert.deepEqual((await roomIndex(u)).body.rooms, []);
  assert.deepEqual(await cleanupExpiredSubscriptionReports(db, account(u)), { ran: false, reason: 'not-expired' });
  assert.equal((await dataOf(u)).reports, 1, 'never activated is not expired: refused, not deleted');
  pass('E8 a never-activated account reads nothing and loses nothing');
}

// ── E9. Every other report path refuses too ─────────────────────────────────────────────────────────────────────────
{
  const u = await signup('e9@example.com');
  await activate(u);
  const r = await postReport(u, { room: 0 });
  await expire(u);
  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'off';
  const addr = ip('retry');
  await resetRateForTest(addr);
  const retry = await aiRetryRoute.POST(new Request(`http://localhost/api/reports/${r.id}/ai-retry`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${u.cookie}` }, body: JSON.stringify({ aiStatus: 'failed', aiScore: null, aiTone: null, payload: { aiScore: null, aiAnalysis: { status: 'error' } } }),
  }), { params: Promise.resolve({ id: r.id }) });
  assert.equal(retry.status, 403, 'AI retry');
  assert.equal((await getJson(reportsRoute, 'http://localhost/api/reports', u.cookie)).status, 403, 'the report list');
  assert.equal((await reportById(u, r.id)).status, 403, 'the report GET that feeds the page, print view and receipt');
  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'on';
  const roomPage = await readFile(new URL('../app/reports/rooms/[room]/page.tsx', import.meta.url), 'utf8');
  assert.ok(roomPage.indexOf('reportAccessRefusal(policy)') < roomPage.indexOf('findRoomOccupant(client'), 'the room page decides before reading any report');
  const reportPage = await readFile(new URL('../app/reports/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(reportPage.indexOf('reportAccessRefusal(policy)') < reportPage.indexOf('await findReportRowForUser('), 'the report page (and its print view) too');
  pass('E9 AI retry, the report list, the report API and both pages refuse before reading a report');
}

// ── E10. The sweep: expired accounts only, honours the switch, protected like every internal sweep ──────────────────
{
  const expired = await signup('e10-real@example.com');
  const synthetic = await signup('e10-synthetic@example.test');
  const active = await signup('e10-active@example.test');
  for (const u of [expired, synthetic, active]) { await activate(u); await postReport(u, { room: 0 }); }
  await expire(expired); await expire(synthetic);
  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'off';
  assert.equal((await runSubscriptionExpirySweep(db)).accounts, 0, 'off: nothing');
  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'synthetic-only';
  const syntheticRun = await runSubscriptionExpirySweep(db);
  assert.equal(syntheticRun.cleaned, 1);
  assert.equal((await dataOf(synthetic)).reports, 0, 'synthetic-only: the synthetic expired account is cleaned');
  assert.equal((await dataOf(expired)).reports, 1, 'a real account is never touched in this mode');
  assert.equal((await reportById(expired, 'anything')).status, 403, 'though it is still refused');
  assert.equal((await dataOf(expired)).reports, 1, 'and its visit does not delete anything either');
  process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'on';
  const call = (headers) => sweepRoute.GET(new Request('http://localhost/api/internal/subscription-expiry-sweep', { headers: { 'x-forwarded-for': ip('sweep'), ...headers } }));
  assert.equal((await call({})).status, 404, 'no secret: looks like nothing is there');
  assert.equal((await call({ authorization: 'Bearer wrong-secret-of-same-size!!' })).status, 404);
  const ok = await call({ authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.cleaned >= 1);
  assert.equal((await dataOf(expired)).reports, 0, 'on: the sweep reaches an expired customer who never comes back');
  assert.equal((await dataOf(active)).reports, 1, 'an active account is never touched');
  pass('E10 the sweep reaches only expired accounts, honours off / synthetic-only / on, and is protected by CRON_SECRET');
}

// ── E11. Concurrency and failure ────────────────────────────────────────────────────────────────────────────────────
{
  const u = await signup('e11@example.com');
  await activate(u);
  await postReport(u, { room: 0 }); await postReport(u, { room: 1 });
  await expire(u);
  const conns = [0, 1, 2].map(() => createClient({ url: `file:${dbFile}` }));
  await Promise.allSettled(conns.map((c) => cleanupExpiredSubscriptionReports(c, account(u))));
  conns.forEach((c) => c.close());
  await cleanupExpiredSubscriptionReports(db, account(u));
  assert.deepEqual(await dataOf(u), { reports: 0, identities: 0, shingles: 0 }, 'three cleanups at once, plus a finishing run: everything gone, nothing broken');

  // A cleanup that fails refuses the activation (retryable) instead of granting a plan on top of the old history.
  const v = await signup('e11b@example.com');
  await activate(v);
  await postReport(v, { room: 0 });
  await expire(v);
  const version = Number((await db.execute({ sql: 'SELECT version FROM account_entitlements WHERE user_id = ?', args: [v.id] })).rows[0].version);
  let failed = 0;
  const failing = () => {
    const real = createClient({ url: `file:${dbFile}` });
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'execute') return async (stmt) => {
          if (String(stmt.sql ?? stmt).includes('DELETE FROM report_historical_match_snapshots')) { failed += 1; throw new Error('simulated outage'); }
          return target.execute(stmt);
        };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const adminUser = { id: admin.id, email: admin.email, username: 'expiry-admin', role: 'admin', corpusReuseConsented: true };
  const result = await applyActivationAction(failing, adminUser, { email: v.email, expectedUserId: v.id, operationId: crypto.randomUUID(), expectedVersion: version, action: 'activate', planDays: 30, rooms: 3 });
  assert.equal(failed, 1);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.code, 'EXPIRY_CLEANUP_FAILED');
  assert.equal(Number((await db.execute({ sql: 'SELECT version FROM account_entitlements WHERE user_id = ?', args: [v.id] })).rows[0].version), version, 'no plan was granted');
  await activate(v);
  assert.equal((await dataOf(v)).reports, 0, 'the retry clears the history and grants the plan');
  pass('E11 concurrent cleanups converge; a failed cleanup refuses the activation so it can be retried');
}

// ── E12. Active subscribers and administrators are unchanged ────────────────────────────────────────────────────────
{
  const u = await signup('e12@example.com');
  await activate(u);
  const r = await postReport(u, { room: 0 });
  assert.equal((await reportById(u, r.id)).status, 200, 'an active subscriber reads their report');
  assert.equal((await roomNow(u, 0)).body.report?.id, r.id);
  assert.equal((await roomIndex(u)).body.rooms.length, 3);
  const a = await postReport(admin, { room: 30 });
  assert.equal(a.status, 200);
  assert.equal((await reportById(admin, a.id)).status, 200, 'an administrator is never refused');
  assert.equal('notice' in (await roomIndex(admin)).body, false);
  pass('E12 active subscribers and administrators are unchanged');
}

db.close();
for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* still open */ }
console.log(`\n${results.length} subscription expiry cleanup scenarios passed`);
process.exit(0); // the native database driver can crash during normal teardown, after everything above has passed
