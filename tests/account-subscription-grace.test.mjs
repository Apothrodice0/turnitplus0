import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportByIdRoute from '../app/api/reports/[id]/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as planRoute from '../app/api/account/plan/route.ts';
import * as uploadLimitRoute from '../app/api/upload-limit/route.ts';
import * as checkAuthorizationRoute from '../app/api/reports/check-authorization/route.ts';
import * as lookupRoute from '../app/api/admin/account-activation/lookup/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { NORMAL_ROOM_COUNT } from '../lib/report-rooms.ts';
import { DAY_MS, LEGACY_GRACE_DAYS } from '../lib/account-plan.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { ensureEnforcementStart, readEnforcementStart, resetEntitlementTableCacheForTest, resolveRoomPolicy } from '../lib/account-entitlements.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

// RETIRED BEHAVIOUR (owner decision 2026-10-29: no free checking for any customer once enforcement is on). The legacy
// free-access logic is kept only behind ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED, which is OFF by default; G3 first proves
// that with the flag at its default a legacy account gets nothing, then this suite switches the flag ON to keep the
// preserved logic correct in case it is ever re-enabled.
//
// Legacy free access (owner decision 2026-10-28, lib/account-entitlements.ts): when ACCOUNT_ACTIVATION_ENFORCED is
// first switched on, the database records that moment once (account_activation_enforcement, drizzle/0057). Accounts
// registered before it keep today's free limits — 10 rooms, 10 uploads per UTC day, not paid access — for 30 days;
// accounts registered after it get none; after the 30 days an account without an active plan cannot start new checks
// but keeps its account and reports. The moment never moves: not on restart/redeploy, not when the flag is switched
// off and on again. Every scenario goes through the real route handlers against a real migrated database.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_account_subscription_grace.db');
const otherDbFile = path.join(repo, 'test_account_subscription_grace_race.db');
for (const file of [dbFile, otherDbFile]) {
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${file}${suffix}`)) fs.unlinkSync(`${file}${suffix}`);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;
delete process.env.ACCOUNT_ACTIVATION_ENFORCED;

const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));
const enforce = (on) => {
  if (on) process.env.ACCOUNT_ACTIVATION_ENFORCED = '1';
  else delete process.env.ACCOUNT_ACTIVATION_ENFORCED;
};

let n = 0;
const ip = (tag) => `grace-${tag}-${++n}`;
const cookieOf = (response) => (response.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)?.[1] ?? null;

async function signup(email) {
  const addr = ip('signup');
  await resetAuthRateForTest(addr);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username: email.split('@')[0].slice(0, 30), deviceKey: `dev-${email}` })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  const id = String((await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { id, email, cookie: cookieOf(res), deviceKey: `dev-${email}` };
}
/** An account registered well before enforcement (users.created_at is SQLite CURRENT_TIMESTAMP text, UTC). */
async function registeredDaysAgo(user, days) {
  await db.execute({ sql: "UPDATE users SET created_at = datetime('now', ?) WHERE id = ?", args: [`-${days} days`, user.id] });
}
const markVerified = (user) => db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE id = ?', args: [Date.now(), user.id] });
const asSessionUser = (user) => ({ id: user.id, email: user.email, username: user.email.split('@')[0], role: 'user', corpusReuseConsented: true });

async function getJson(route, url, cookie, params) {
  const addr = ip('get');
  await resetReadRateForTest(addr);
  await resetRateForTest(addr);
  const headers = { 'x-forwarded-for': addr, ...(cookie ? { cookie: `tp_session_v1=${cookie}` } : {}) };
  const res = params ? await route.GET(new Request(url, { headers }), { params: Promise.resolve(params) }) : await route.GET(new Request(url, { headers }));
  return { status: res.status, body: await res.json() };
}
const roomIndex = (user) => getJson(roomsRoute, 'http://localhost/api/reports/rooms', user.cookie);
const planOf = (user) => getJson(planRoute, 'http://localhost/api/account/plan', user.cookie);
const uploadLimit = (user) => getJson(uploadLimitRoute, 'http://localhost/api/upload-limit', user.cookie);

async function postReport(user, id, { room, aiScore = 12 } = {}) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = new Date().toISOString();
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` },
    body: JSON.stringify({
      deviceKey: user.deviceKey, id: String(id), submissionId: String(id).slice(-10), title: `report-${id}.pdf`, createdAt: created,
      wordCount: 400, archiveScore: 3, scoreBand: 'Low', aiScore, aiTone: 'low', room,
      payload: { version: 11, id: String(id), submissionId: String(id).slice(-10), title: `report-${id}.pdf`, created, score: 3, wordCount: 400, text: `grace sample text ${id}` },
    }),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function adminPost(route, url, cookie, body) {
  const addr = ip('admin');
  await resetAdminRateForTest(addr);
  const res = await route.POST(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, host: 'localhost', origin: 'http://localhost', cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function grant(adminCookie, body) {
  const p = await adminPost(applyRoute, 'http://localhost/api/admin/account-activation/apply', adminCookie, { ...body, dryRun: true });
  assert.equal(p.status, 200, `preview ${JSON.stringify(p.body)}`);
  const c = await adminPost(applyRoute, 'http://localhost/api/admin/account-activation/apply', adminCookie, {
    ...body, dryRun: false, operationId: crypto.randomUUID(), expectedVersion: p.body.preview.expectedVersion, expectedUserId: p.body.preview.expectedUserId,
  });
  assert.equal(c.status, 200, `commit ${JSON.stringify(c.body)}`);
}
const startRows = async () => (await db.execute({ sql: 'SELECT started_at, grace_ends_at FROM account_activation_enforcement', args: [] })).rows;
const claimCount = async (user) => Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM account_room_claims WHERE user_id = ?', args: [user.id] })).rows[0].c);

const results = [];
function pass(name) {
  results.push(name);
  console.log(`ok - ${name}`);
}

// ── fixtures: registered before enforcement is ever switched on ───────────────────────────────────────────────────
const admin = await signup('grace-owner@example.com');
await grantTestAdmin(dbFile, admin.email);
const legacy = await signup('legacy@example.com');
const legacyPaid = await signup('legacy-paid@example.com');
const legacyPaused = await signup('legacy-paused@example.com');
const legacyLapsed = await signup('legacy-lapsed@example.com');
for (const user of [legacy, legacyPaid, legacyPaused, legacyLapsed]) {
  await registeredDaysAgo(user, 90);
  await markVerified(user);
}

// ── G1. Enforcement OFF: nothing is recorded and nothing changes ──────────────────────────────────────────────────
{
  assert.equal((await postReport(legacy, 4100000000001, { room: 0 })).status, 200);
  assert.deepEqual((await planOf(legacy)).body, { authenticated: true, enforced: false });
  assert.equal((await startRows()).length, 0, 'no enforcement start while the switch is off');
  pass('G1 enforcement off: existing accounts behave exactly as today and no enforcement start is recorded');
}

// ── G2. The first enforced request fixes the start, once; it never moves afterwards ────────────────────────────────
enforce(true);
let start;
{
  const before = Date.now();
  const idx = await roomIndex(legacy);
  const after = Date.now();
  assert.equal(idx.status, 200);
  const rows = await startRows();
  assert.equal(rows.length, 1, 'the first enforced request records the start');
  start = { startedAt: Number(rows[0].started_at), graceEndsAt: Number(rows[0].grace_ends_at) };
  assert.ok(start.startedAt >= before && start.startedAt <= after, 'the start is the server clock at that request');
  assert.equal(start.graceEndsAt - start.startedAt, LEGACY_GRACE_DAYS * DAY_MS, 'grace is exactly 30 × 24 h');

  // More requests, a simulated restart/redeploy (process memory cleared), and the flag switched off and on again.
  await roomIndex(legacyPaid);
  resetEntitlementTableCacheForTest();
  enforce(false);
  await roomIndex(legacy);
  enforce(true);
  await roomIndex(legacy);
  assert.deepEqual(await readEnforcementStart(db), start, 'unchanged after restart and an off/on flip');
  assert.deepEqual(await ensureEnforcementStart(db, Date.now() + 365 * DAY_MS), start, 'a later "first" request cannot replace it');
  await assert.rejects(db.execute({ sql: 'UPDATE account_activation_enforcement SET started_at = ?', args: [Date.now()] }), /immutable/);
  await assert.rejects(db.execute({ sql: 'DELETE FROM account_activation_enforcement', args: [] }), /immutable/);
  await assert.rejects(db.execute({ sql: 'INSERT INTO account_activation_enforcement (id, started_at, grace_ends_at) VALUES (2, 0, 0)', args: [] }), /CHECK/);
  assert.equal((await startRows()).length, 1);

  // Concurrent first requests on a fresh database: one start, and every caller sees the same one.
  const other = createClient({ url: `file:${otherDbFile}` });
  await applyMigrationsLibsql(other, path.join(repo, 'drizzle'));
  resetEntitlementTableCacheForTest();
  const t = Date.now();
  const raced = await Promise.all([t, t + 5000, t + 9000].map((ms) => ensureEnforcementStart(other, ms)));
  const otherRows = (await other.execute({ sql: 'SELECT started_at FROM account_activation_enforcement', args: [] })).rows;
  assert.equal(otherRows.length, 1);
  assert.ok(raced.every((r) => r.startedAt === Number(otherRows[0].started_at)), 'every concurrent caller gets the single recorded start');
  other.close();
  resetEntitlementTableCacheForTest();
  pass('G2 the first enforced request records the start once; restarts, off/on flips, later writers, UPDATE and DELETE cannot move it');
}

// ── G3. Default (grace flag OFF): a legacy account gets NO free access; with the flag on it keeps the free limits ──────
{
  delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
  const refused = await postReport(legacy, 4100000000005, { room: 1 });
  assert.equal(refused.status, 403, 'with the retired grace flag at its default, a legacy account cannot start a check');
  assert.equal(refused.body.code, 'ACTIVATION_REQUIRED');
  assert.equal((await planOf(legacy)).body.graceEndsAt, null);
  assert.equal(typeof (await roomIndex(legacy)).body.notice, 'string', 'and its room list says so');
  assert.equal(await claimCount(legacy), 0);
  process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED = '1';

  const idx = await roomIndex(legacy);
  assert.equal(idx.body.rooms.length, NORMAL_ROOM_COUNT, '10 rooms');
  assert.deepEqual(Object.keys(idx.body), ['rooms'], 'exactly the pre-feature response: no notice');
  const plan = (await planOf(legacy)).body;
  assert.equal(plan.enforced, true);
  assert.equal(plan.state, 'none');
  assert.equal(plan.graceEndsAt, start.graceEndsAt);
  assert.match(plan.message, /free access \(10 rooms, 10 uploads per day\) continues until/);
  assert.deepEqual((await uploadLimit(legacy)).body, { authenticated: true, unlimited: false, uploadsToday: 1, limit: 10 }, 'the daily cap is shown and applies');
  const auth = await checkAuthorizationRoute.POST(new Request('http://localhost/api/reports/check-authorization', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip('auth'), host: 'localhost', origin: 'http://localhost', cookie: `tp_session_v1=${legacy.cookie}` },
    body: JSON.stringify({ room: 1, textSha256: canonicalSha256('grace text') }),
  }));
  assert.deepEqual(await auth.json(), { required: false }, 'free access needs no plan check authorization');

  for (let room = 1; room < 10; room += 1) {
    assert.equal((await postReport(legacy, 4100000000010 + room, { room })).status, 200, `upload ${room + 1} of 10 today`);
  }
  const eleventh = await postReport(legacy, 4100000000099, { room: 3 });
  assert.equal(eleventh.status, 429, 'the 11th upload of the UTC day is refused by the existing daily cap');
  assert.notEqual((await postReport(legacy, 4100000000098, { room: 10 })).status, 200, 'room 11 does not exist for a free account');
  assert.equal(await claimCount(legacy), 0, 'free access writes no plan room claims');
  pass('G3 grace flag off (default): a legacy account is refused (403). Flag on: 10 rooms, the 10-per-day cap (11th refused), no claims');
}

// ── G4. An account registered after enforcement began gets no free access ──────────────────────────────────────────
{
  const newcomer = await signup('newcomer@example.com');
  await markVerified(newcomer);
  const r = await postReport(newcomer, 4200000000001, { room: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'ACTIVATION_REQUIRED');
  const plan = (await planOf(newcomer)).body;
  assert.equal(plan.graceEndsAt, null);
  assert.equal(typeof (await roomIndex(newcomer)).body.notice, 'string');
  // Same-second registration counts as new (users.created_at has one-second precision).
  await db.execute({ sql: 'UPDATE users SET created_at = ? WHERE id = ?', args: [new Date(start.startedAt).toISOString().slice(0, 19).replace('T', ' '), newcomer.id] });
  assert.equal((await postReport(newcomer, 4200000000002, { room: 0 })).status, 403, 'registered in the same second as the start: not legacy');
  // And the owner can activate them as usual.
  await grant(admin.cookie, { email: newcomer.email, action: 'activate', planDays: 30, rooms: 5 });
  assert.equal((await postReport(newcomer, 4200000000003, { room: 0 })).status, 200);
  pass('G4 an account registered at or after the start has no free access (403 ACTIVATION_REQUIRED) until activated');
}

// ── G5–G7. Legacy accounts with a plan: active → paid rules; suspended → blocked; expired → free access again ──────
{
  await grant(admin.cookie, { email: legacyPaid.email, action: 'activate', planDays: 30, rooms: 15 });
  assert.equal((await roomIndex(legacyPaid)).body.rooms.length, 15, 'an active plan wins over free access: plan rooms');
  for (let room = 0; room < 12; room += 1) assert.equal((await postReport(legacyPaid, 4300000000000 + room, { room })).status, 200, `paid upload ${room + 1}`);
  assert.deepEqual((await uploadLimit(legacyPaid)).body, { authenticated: true, plan: true }, 'no daily cap under a plan');
  assert.equal(await claimCount(legacyPaid), 12, 'plan rules: server-clock room claims');
  pass('G5 a legacy account with an active plan gets the plan (15 rooms, 12 checks in a day), not the free limits');

  await grant(admin.cookie, { email: legacyPaused.email, action: 'activate', planDays: 30, rooms: 5 });
  await grant(admin.cookie, { email: legacyPaused.email, action: 'suspend', reason: 'Payment dispute' });
  const paused = await postReport(legacyPaused, 4400000000001, { room: 0 });
  assert.equal(paused.status, 403);
  assert.equal(paused.body.code, 'ACCOUNT_SUSPENDED', 'free access never overrides an owner suspension');
  assert.equal((await planOf(legacyPaused)).body.graceEndsAt, null);
  pass('G6 a legacy account whose plan is suspended stays blocked during grace (ACCOUNT_SUSPENDED)');

  await grant(admin.cookie, { email: legacyLapsed.email, action: 'activate', planDays: 30, rooms: 20 });
  assert.equal((await postReport(legacyLapsed, 4500000000015, { room: 15 })).status, 200, 'a report in plan room 16');
  await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [Date.now() - 1000, legacyLapsed.id] });
  const lapsedIdx = await roomIndex(legacyLapsed);
  assert.equal(lapsedIdx.body.rooms.length, 20, 'rooms holding reports from the expired plan stay listed');
  assert.equal((await postReport(legacyLapsed, 4500000000001, { room: 0 })).status, 200, 'free access again while grace lasts');
  assert.notEqual((await postReport(legacyLapsed, 4500000000016, { room: 16 })).status, 200, 'but only within the 10 free rooms');
  assert.equal((await planOf(legacyLapsed)).body.graceEndsAt, start.graceEndsAt);
  pass('G7 a legacy account whose plan expired falls back to the free limits until grace ends, keeping its old rooms visible');
}

// ── G8. The boundary is exact ──────────────────────────────────────────────────────────────────────────────────────
{
  const justBefore = await resolveRoomPolicy(db, asSessionUser(legacy), start.graceEndsAt - 1);
  assert.equal(justBefore.enforced, false);
  assert.deepEqual(justBefore.grace, { endsAt: start.graceEndsAt });
  const atEnd = await resolveRoomPolicy(db, asSessionUser(legacy), start.graceEndsAt);
  assert.equal(atEnd.enforced, true);
  assert.equal(atEnd.block?.code, 'ACTIVATION_REQUIRED');
  assert.equal(atEnd.grace, null);
  delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
  const flagOff = await resolveRoomPolicy(db, asSessionUser(legacy), start.graceEndsAt - 1);
  assert.equal(flagOff.block?.code, 'ACTIVATION_REQUIRED', 'with the retired flag off, even inside the window there is no free access');
  assert.equal(flagOff.grace, null);
  process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED = '1';
  pass('G8 (flag on) free access applies until the last millisecond before grace_ends_at and not at it; (flag off) never');
}

// ── G9. After grace: no checks and no report access without a plan; the account and its reports are kept ───────────
{
  // Simulate the 30 days passing: the row is immutable by design, so the test lifts its guard to back-date it.
  await db.execute({ sql: 'DROP TRIGGER trg_account_activation_enforcement_no_update', args: [] });
  await db.execute({ sql: 'UPDATE account_activation_enforcement SET started_at = ?, grace_ends_at = ?', args: [start.startedAt - 31 * DAY_MS, start.graceEndsAt - 31 * DAY_MS] });
  resetEntitlementTableCacheForTest();

  const r = await postReport(legacy, 4100000000200, { room: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'ACTIVATION_REQUIRED');
  const read = await getJson(reportByIdRoute, `http://localhost/api/reports/4100000000011?deviceKey=${encodeURIComponent(legacy.deviceKey)}`, legacy.cookie, { id: '4100000000011' });
  assert.equal(read.status, 403, 'existing reports are refused without a plan (owner decision 2026-10-30)');
  assert.equal((await postReport(legacy, 4100000000011, { room: 1, aiScore: 61 })).status, 403, 'and so is a resave');
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM saved_reports WHERE id = '4100000000011'", args: [] })).rows[0].c), 1, 'refused, not deleted: this account never had an expired plan');
  const plan = (await planOf(legacy)).body;
  assert.equal(plan.graceEndsAt, null);
  assert.equal(plan.state, 'none');
  assert.equal(typeof (await roomIndex(legacy)).body.notice, 'string');
  assert.equal((await postReport(legacyLapsed, 4500000000300, { room: 1 })).status, 403, 'the lapsed plan account is blocked too (PLAN_EXPIRED)');

  await grant(admin.cookie, { email: legacy.email, action: 'activate', planDays: 60, rooms: 10 });
  assert.equal((await postReport(legacy, 4100000000201, { room: 5 })).status, 409, 'room 6 is still in its 24 h cycle from today');
  await db.execute({ sql: 'UPDATE saved_reports SET report_created_at = ? WHERE user_id = ?', args: [new Date(Date.now() - 2 * DAY_MS).toISOString(), legacy.id] });
  assert.equal((await postReport(legacy, 4100000000202, { room: 5 })).status, 200, 'once activated, the customer checks again');
  pass('G9 after grace: no plan → 403 for new checks, reports and resaves; nothing is deleted; activation restores access');
}

// ── G10. Roles are never touched ───────────────────────────────────────────────────────────────────────────────────
{
  const admins = await db.execute({ sql: "SELECT email FROM users WHERE role = 'admin'", args: [] });
  assert.deepEqual(admins.rows.map((row) => row.email), [admin.email]);
  pass('G10 grace and subscriptions never change account roles');
}

delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
enforce(false);
db.close();
console.log(`\n${results.length} account-subscription grace scenarios passed`);
