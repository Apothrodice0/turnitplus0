import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as checkAuthorizationRoute from '../app/api/reports/check-authorization/route.ts';
import { canonicalizeText } from '../lib/canonical-text.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import * as reportByIdRoute from '../app/api/reports/[id]/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as planRoute from '../app/api/account/plan/route.ts';
import * as uploadLimitRoute from '../app/api/upload-limit/route.ts';
import * as lookupRoute from '../app/api/admin/account-activation/lookup/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import * as accountsRoute from '../app/api/admin/account-activation/accounts/route.ts';
import * as academicEvidenceRoute from '../app/api/academic-evidence/route.ts';
import * as archiveMatchRoute from '../app/api/archive/match/route.ts';
import { checkWorkRefusal } from '../lib/account-entitlements.ts';
import { planBlockMessage } from '../lib/account-plan.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { ADMIN_ROOM_COUNT, NORMAL_ROOM_COUNT, ROOM_CYCLE_MS } from '../lib/report-rooms.ts';
import { DAY_MS } from '../lib/account-plan.ts';
import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '../lib/account-deletion.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

// Manual subscriptions (drizzle/0057, lib/account-entitlements.ts, lib/account-activation-admin.ts): the owner
// activates a registered, VERIFIED customer for any 1–3650 days (presets 30/60/90/180/360) with N rooms; with
// ACCOUNT_ACTIVATION_ENFORCED on, the plan is what lets a customer start new checks (rooms 1..N, each on its own 24 h
// cooldown, no daily cap), and with it off nothing changes. Every scenario below goes through the real route handlers
// against a real migrated database. Owner decision 2026-10-29: no free checking for ANY customer account once
// enforcement is on — accounts registered before enforcement included (the retired legacy grace logic is off by
// default and has its own suite, account-subscription-grace). The check-work routes (/api/academic-evidence,
// /api/archive/match) refuse the same accounts.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_account_activation.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
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
const ip = (tag) => `aa-${tag}-${++n}`;
function cookieOf(response) {
  const match = (response.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email) {
  const addr = ip('signup');
  await resetAuthRateForTest(addr);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username: email.split('@')[0].slice(0, 30), deviceKey: `dev-${email}` })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return { email, cookie: cookieOf(res), deviceKey: `dev-${email}` };
}

async function markVerified(email) {
  await db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE email = ?', args: [Date.now(), email] });
}

function adminHeaders(cookie, { sameOrigin = true } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip('admin'), host: 'localhost' };
  if (sameOrigin) headers.origin = 'http://localhost';
  else headers.origin = 'https://evil.example';
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return headers;
}

async function adminPost(route, url, cookie, body, opts) {
  const headers = adminHeaders(cookie, opts);
  await resetAdminRateForTest(headers['x-forwarded-for']);
  const res = await route.POST(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const lookup = (cookie, email, opts) => adminPost(lookupRoute, 'http://localhost/api/admin/account-activation/lookup', cookie, { email }, opts);
const preview = (cookie, body, opts) => adminPost(applyRoute, 'http://localhost/api/admin/account-activation/apply', cookie, { ...body, dryRun: true }, opts);
const commit = (cookie, body, opts) => adminPost(applyRoute, 'http://localhost/api/admin/account-activation/apply', cookie, { ...body, dryRun: false }, opts);
async function listAccounts(cookie, query = '') {
  const headers = adminHeaders(cookie);
  await resetAdminRateForTest(headers['x-forwarded-for']);
  const res = await accountsRoute.GET(new Request(`http://localhost/api/admin/account-activation/accounts?${query}`, { headers }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Preview, then commit with the preview's version — what the console does. */
async function grant(adminCookie, body) {
  const p = await preview(adminCookie, body);
  assert.equal(p.status, 200, `preview ${body.action} ${body.email}: ${JSON.stringify(p.body)}`);
  const operationId = crypto.randomUUID();
  const c = await commit(adminCookie, { ...body, operationId, expectedVersion: p.body.preview.expectedVersion, expectedUserId: p.body.preview.expectedUserId });
  assert.equal(c.status, 200, `commit ${body.action} ${body.email}: ${JSON.stringify(c.body)}`);
  return { preview: p.body.preview, result: c.body, operationId };
}

async function postReport(user, id, { room, createdAt, aiScore = 12, text: manuscript, checkAuthorization } = {}) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = createdAt ?? new Date().toISOString();
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` },
    body: JSON.stringify({
      deviceKey: user.deviceKey, id: String(id), submissionId: String(id).slice(-10), title: `report-${id}.pdf`, createdAt: created,
      wordCount: 400, archiveScore: 3, scoreBand: 'Low', aiScore, aiTone: 'low', room,
      payload: { version: 11, id: String(id), submissionId: String(id).slice(-10), title: `report-${id}.pdf`, created, score: 3, wordCount: 400, text: manuscript ?? `sample extracted text for report ${id}` },
      ...(checkAuthorization ? { checkAuthorization } : {}),
    }),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The browser's own hash (lib/reports-remote.ts requestCheckAuthorization): SHA-256 of the canonical text, via WebCrypto. */
async function browserTextSha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeText(text))));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function issueAuthorization(user, room, text, { textSha256 } = {}) {
  const addr = ip('auth');
  await resetRateForTest(addr);
  const res = await checkAuthorizationRoute.POST(new Request('http://localhost/api/reports/check-authorization', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` },
    body: JSON.stringify({ room, textSha256: textSha256 ?? (await browserTextSha256(text)) }),
  }));
  return { status: res.status, body: await res.json() };
}

async function getJson(route, url, cookie, params) {
  const addr = ip('get');
  await resetReadRateForTest(addr);
  await resetRateForTest(addr);
  const headers = { 'x-forwarded-for': addr };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const res = params ? await route.GET(new Request(url, { headers }), { params: Promise.resolve(params) }) : await route.GET(new Request(url, { headers }));
  return { status: res.status, body: await res.json() };
}
const roomIndex = (user) => getJson(roomsRoute, 'http://localhost/api/reports/rooms', user.cookie);
const planOf = (user) => getJson(planRoute, 'http://localhost/api/account/plan', user.cookie);

async function userIdOf(email) {
  const r = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return r.rows[0] ? String(r.rows[0].id) : null;
}

async function entitlementRow(email) {
  const r = await db.execute({ sql: 'SELECT e.* FROM account_entitlements e JOIN users u ON u.id = e.user_id WHERE u.email = ?', args: [email] });
  return r.rows[0] ?? null;
}
async function eventCount(email) {
  const r = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM account_entitlement_events e JOIN users u ON u.id = e.user_id WHERE u.email = ?', args: [email] });
  return Number(r.rows[0].c);
}

const results = [];
function pass(name) {
  results.push(name);
  console.log(`ok - ${name}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────
const admin = await signup('owner-admin@example.com');
await grantTestAdmin(dbFile, admin.email);
const alice = await signup('alice@example.com');
await markVerified(alice.email);
const bob = await signup('bob@example.com');
await markVerified(bob.email);
const carol = await signup('carol@example.com');
const dave = await signup('dave@example.com');
const erin = await signup('erin@example.com');
// Final corrections: activating an UNVERIFIED account needs an explicit admin confirmation. These fixtures were
// incidental to their scenarios, so they are verified; the unverified path has its own account and scenario (14).
for (const user of [carol, dave, erin]) await markVerified(user.email);
const frank = await signup('frank@example.com');
await markVerified(frank.email);
const unverified = await signup('unverified@example.com');
const freeUser = await signup('free-user@example.com');
const gina = await signup('gina@example.com');
const hank = await signup('hank@example.com');
const ivan = await signup('ivan@example.com');
const leaver = await signup('leaver@example.com');
for (const user of [gina, hank, ivan, leaver]) await markVerified(user.email);

// ── 13. Non-admin and anonymous callers are denied (404, nothing revealed); cross-origin admin POST is refused ────
{
  for (const cookie of [alice.cookie, null]) {
    assert.equal((await lookup(cookie, alice.email)).status, 404);
    assert.equal((await preview(cookie, { email: alice.email, action: 'activate', planDays: 30, rooms: 5 })).status, 404);
    assert.equal((await commit(cookie, { email: alice.email, action: 'activate', planDays: 30, rooms: 5, operationId: crypto.randomUUID(), expectedVersion: 0 })).status, 404);
    assert.equal((await listAccounts(cookie)).status, 404);
  }
  const cross = await commit(admin.cookie, { email: alice.email, action: 'activate', planDays: 30, rooms: 5, operationId: crypto.randomUUID(), expectedVersion: 0 }, { sameOrigin: false });
  assert.equal(cross.status, 404, 'a cross-origin POST with a real admin cookie is refused');
  assert.equal(await entitlementRow(alice.email), null, 'nothing was written by any denied request');
  pass('13 non-admin, anonymous and cross-origin requests are denied with no writes');
}

// ── 14. Nonexistent and unverified accounts ─────────────────────────────────────────────────────────────────────
{
  const missing = await lookup(admin.cookie, '  Nobody@Example.com ');
  assert.equal(missing.status, 200);
  assert.deepEqual({ found: missing.body.found, email: missing.body.email }, { found: false, email: 'nobody@example.com' });
  const missingPreview = await preview(admin.cookie, { email: 'nobody@example.com', action: 'activate', planDays: 30, rooms: 5 });
  assert.equal(missingPreview.status, 404);
  assert.equal(missingPreview.body.error, 'No account found for this email. Ask the customer to register first.');
  const missingCommit = await commit(admin.cookie, { email: 'nobody@example.com', action: 'activate', planDays: 30, rooms: 5, operationId: crypto.randomUUID(), expectedVersion: 0, expectedUserId: 'no-such-id' });
  assert.equal(missingCommit.status, 404);
  const users = await db.execute({ sql: "SELECT COUNT(*) AS c FROM users WHERE email = 'nobody@example.com'", args: [] });
  assert.equal(Number(users.rows[0].c), 0, 'no account is ever created');

  const u = await lookup(admin.cookie, 'UNVERIFIED@example.com');
  assert.equal(u.body.found, true);
  assert.equal(u.body.account.email, 'unverified@example.com', 'case-insensitive, canonical match');
  assert.equal(u.body.account.emailVerified, false);
  assert.equal(u.body.state, 'none');
  assert.equal(JSON.stringify(u.body).includes('password'), false, 'no password material in the lookup');
  assert.equal(u.body.account.userId, await userIdOf(unverified.email), 'the lookup names the stable account id');
  const up = await preview(admin.cookie, { email: unverified.email, action: 'activate', planDays: 30, rooms: 2 });
  assert.equal(up.status, 409, 'an unverified account cannot even be previewed for activation');
  assert.equal(up.body.code, 'UNVERIFIED_EMAIL');
  const unverifiedId = await userIdOf(unverified.email);
  for (const extra of [{}, { confirmUnverifiedEmail: true }]) {
    const c = await commit(admin.cookie, { email: unverified.email, action: 'activate', planDays: 30, rooms: 2, operationId: crypto.randomUUID(), expectedVersion: 0, expectedUserId: unverifiedId, ...extra });
    assert.equal(c.status, 409, 'refused, with or without any client-side "confirmation"');
    assert.equal(c.body.code, 'UNVERIFIED_EMAIL');
  }
  assert.equal(await entitlementRow(unverified.email), null, 'no plan was written for the unverified account');
  assert.equal(await eventCount(unverified.email), 0, 'and no audit row');
  const stillUnverified = await db.execute({ sql: "SELECT email_verified_at FROM users WHERE email = 'unverified@example.com'", args: [] });
  assert.equal(stillUnverified.rows[0].email_verified_at, null, 'the email is never marked verified by the console');
  const verifiedEvent = (await grant(admin.cookie, { email: frank.email, action: 'activate', planDays: 30, rooms: 3 })).result.event;
  assert.equal(verifiedEvent.targetEmailVerified, true, 'a verified account is activated and recorded as verified');

  const adminTarget = await preview(admin.cookie, { email: admin.email, action: 'activate', planDays: 30, rooms: 5 });
  assert.equal(adminTarget.status, 409, 'administrator accounts are never activated');
  pass('14 nonexistent accounts are refused (no account created); unverified accounts are shown as such and can never be activated');
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  for (const planDays of [0, -1, 3651, 30.5, '30', null, 1e9]) {
    const r = await preview(admin.cookie, { email: carol.email, action: 'activate', planDays, rooms: 5 });
    assert.equal(r.status, 400, `planDays ${planDays} refused`);
  }
  for (const rooms of [0, -1, 101, 2.5, '5', null]) {
    const r = await preview(admin.cookie, { email: carol.email, action: 'activate', planDays: 30, rooms });
    assert.equal(r.status, 400, `rooms ${rooms} refused`);
  }
  assert.equal((await commit(admin.cookie, { email: carol.email, action: 'activate', planDays: 30, rooms: 5, operationId: 'not-a-uuid', expectedVersion: 0 })).status, 400);
  assert.equal((await commit(admin.cookie, { email: carol.email, action: 'activate', planDays: 30, rooms: 5, operationId: crypto.randomUUID() })).status, 400, 'expectedVersion is required');
  assert.equal((await commit(admin.cookie, { email: carol.email, action: 'activate', planDays: 30, rooms: 5, operationId: crypto.randomUUID(), expectedVersion: 0 })).status, 400, 'expectedUserId is required');
  // The database enforces the same bounds as the server (drizzle/0057 CHECK constraints).
  for (const [days, rooms] of [[0, 5], [3651, 5], [30, 0], [30, 101]]) {
    await assert.rejects(
      db.execute({ sql: "INSERT INTO account_entitlements (user_id, status, plan_days, rooms, activated_at, expires_at, version, created_at, updated_at) VALUES ('x-check', 'active', ?, ?, 0, 1, 1, 0, 0)", args: [days, rooms] }),
      /CHECK/,
      `the database refuses ${days} days / ${rooms} rooms`,
    );
  }
  assert.equal((await preview(admin.cookie, { email: carol.email, action: 'make_unlimited' })).status, 400);
  assert.equal(await entitlementRow(carol.email), null);
  pass('server + database validation: whole days 1–3650, whole rooms 1–100, UUID operation id, reviewed version and account id');
}

// ── 1 + 2 + 3. Activations store exact UTC expirations ──────────────────────────────────────────────────────────
{
  const before = Date.now();
  const a = await grant(admin.cookie, { email: alice.email, action: 'activate', planDays: 30, rooms: 5 });
  const after = Date.now();
  const row = await entitlementRow(alice.email);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.plan_days), 30);
  assert.equal(Number(row.rooms), 5);
  assert.ok(Number(row.activated_at) >= before && Number(row.activated_at) <= after, 'activation time is the server clock');
  assert.equal(Number(row.expires_at) - Number(row.activated_at), 30 * DAY_MS, 'exactly 30 × 24 h');
  assert.equal(a.result.outcome, 'applied');
  assert.equal(a.result.state, 'active');

  const ev = await db.execute({ sql: 'SELECT * FROM account_entitlement_events WHERE operation_id = ?', args: [a.operationId] });
  assert.equal(ev.rows.length, 1);
  assert.equal(ev.rows[0].action, 'activate');
  assert.equal(ev.rows[0].admin_email, admin.email);
  assert.equal(ev.rows[0].target_email, alice.email);
  assert.equal(ev.rows[0].previous_json, null);
  assert.equal(JSON.parse(ev.rows[0].new_json).rooms, 5);
  pass('1 verified account activated for 30 days / 5 rooms, audit row recorded (admin, target, previous → new, operation id)');

  await grant(admin.cookie, { email: bob.email, action: 'activate', planDays: 90, rooms: 20 });
  const b = await entitlementRow(bob.email);
  assert.equal(Number(b.rooms), 20);
  assert.equal(Number(b.expires_at) - Number(b.activated_at), 90 * DAY_MS);
  assert.equal(Number((await entitlementRow(alice.email)).rooms), 5, 'a different account is untouched');
  pass('2 a different account activated for 90 days / 20 rooms');

  await grant(admin.cookie, { email: carol.email, action: 'activate', planDays: 180, rooms: 10 });
  await grant(admin.cookie, { email: dave.email, action: 'activate', planDays: 360, rooms: 50 });
  const c = await entitlementRow(carol.email);
  const d = await entitlementRow(dave.email);
  assert.equal(Number(c.expires_at) - Number(c.activated_at), 180 * DAY_MS);
  assert.equal(Number(d.expires_at) - Number(d.activated_at), 360 * DAY_MS);
  pass('3 180-day and 360-day activations store exact expirations');

  await grant(admin.cookie, { email: gina.email, action: 'activate', planDays: 60, rooms: 10 });
  await grant(admin.cookie, { email: hank.email, action: 'activate', planDays: 45, rooms: 7 });
  await grant(admin.cookie, { email: ivan.email, action: 'activate', planDays: 3650, rooms: 40 });
  for (const [user, days, rooms] of [[gina, 60, 10], [hank, 45, 7], [ivan, 3650, 40]]) {
    const row = await entitlementRow(user.email);
    assert.equal(Number(row.plan_days), days);
    assert.equal(Number(row.rooms), rooms);
    assert.equal(Number(row.expires_at) - Number(row.activated_at), days * DAY_MS, `exactly ${days} × 24 h`);
  }
  const oneDay = await preview(admin.cookie, { email: leaver.email, action: 'activate', planDays: 1, rooms: 1 });
  assert.equal(oneDay.status, 200, 'the 1-day minimum is accepted');
  assert.equal(oneDay.body.preview.next.expiresAt - oneDay.body.preview.next.activatedAt, DAY_MS);
  assert.equal(await entitlementRow(leaver.email), null, 'a preview writes nothing');
  pass('3b the 60-day preset, a custom 45-day plan and the 3650-day maximum store exact expirations; 1 day is the minimum');
}

// ── 22 (feature off). Nothing changes for customers while the switch is off ─────────────────────────────────────
{
  enforce(false);
  const idx = await roomIndex(alice);
  assert.equal(idx.body.rooms.length, NORMAL_ROOM_COUNT, 'baseline 10 rooms even though alice has a 5-room plan');
  assert.deepEqual(Object.keys(idx.body), ['rooms'], 'no notice field');
  assert.deepEqual(Object.keys(idx.body.rooms[0]).sort(), ['cycleEndsAt', 'mostRecentAt', 'room', 'status'], 'index entries keep their exact shape');
  assert.deepEqual((await planOf(freeUser)).body, { authenticated: true, enforced: false });
  const limit = await getJson(uploadLimitRoute, 'http://localhost/api/upload-limit', freeUser.cookie);
  assert.deepEqual(limit.body, { authenticated: true, unlimited: false, uploadsToday: 0, limit: 10 });
  const r = await postReport(freeUser, 3100000000001, { room: 7 });
  assert.equal(r.status, 200, 'an account without a plan uploads exactly as before');
  const claims = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM account_room_claims', args: [] });
  assert.equal(Number(claims.rows[0].c), 0, 'no room claim is written while the switch is off');
  const start = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM account_activation_enforcement', args: [] });
  assert.equal(Number(start.rows[0].c), 0, 'no enforcement start is recorded while the switch is off');
  pass('22 feature off: 10 rooms, daily cap, unchanged responses, no claims, no enforcement start, accounts without a plan upload as before');
}

// Every account above was registered BEFORE enforcement is switched on here: with the retired legacy grace off
// (its default — ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED is not set), none of them gets any free checking.
delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
enforce(true);

// ── no plan / admin while enforced ──────────────────────────────────────────────────────────────────────────────
{
  const r = await postReport(freeUser, 3100000000002, { room: 0 });
  assert.equal(r.status, 403, 'an existing account (registered before enforcement) gets no free check');
  assert.equal(r.body.code, 'ACTIVATION_REQUIRED');
  assert.equal(r.body.error, 'You need an active subscription before you can check documents. Please contact TurnitPlus to activate your plan.');
  assert.equal((await planOf(freeUser)).body.graceEndsAt, null, 'no free-access period');
  const idx = await roomIndex(freeUser);
  assert.equal(typeof idx.body.notice, 'string');
  assert.deepEqual(idx.body.lock, { title: 'Subscription required', message: 'You need an active subscription before you can check documents.', secondary: 'Contact TurnitPlus to activate your plan.', detail: null }, 'the structured notice for My Reports');
  assert.deepEqual(idx.body.rooms.map((r) => [r.room, r.status]), [[7, 'ready']], 'only the room holding a report is listed (room 8), with its report — no usable-looking empty rooms');
  const brandNew = await signup('brand-new@example.com');
  const newIdx = await roomIndex(brandNew);
  assert.equal(newIdx.body.rooms.length, 1, 'an account with no plan and no reports still sees one (locked) room, never an empty list');
  assert.equal(typeof newIdx.body.notice, 'string');
  assert.equal((await postReport(brandNew, 3100000000004, { room: 0 })).status, 403, 'and cannot use it');
  const existing = await getJson(reportByIdRoute, `http://localhost/api/reports/3100000000001?deviceKey=${encodeURIComponent(freeUser.deviceKey)}`, freeUser.cookie, { id: '3100000000001' });
  assert.equal(existing.status, 200, 'an existing report stays readable without a plan');
  const room7 = await getJson(reportsRoute, 'http://localhost/api/reports?room=7', freeUser.cookie);
  assert.equal(room7.status, 200);
  assert.equal(room7.body.status, 'ready', 'and stays in its room');

  const adminIdx = await roomIndex(admin);
  assert.equal(adminIdx.body.rooms.length, ADMIN_ROOM_COUNT, 'administrators keep their 40 rooms');
  assert.equal('notice' in adminIdx.body, false);
  assert.equal((await postReport(admin, 3100000000003, { room: 30 })).status, 200, 'administrators are never blocked');
  assert.deepEqual((await planOf(admin)).body, { authenticated: true, enforced: true, exempt: true });
  pass('enforced: no plan blocks new checks (403 ACTIVATION_REQUIRED) but keeps reports readable; admins unrestricted');
}

// ── HISTORY: old reports stay listed, readable and untouched; activation shows exactly the purchased rooms ───────────
{
  const historian = await signup('historian@example.com');
  await markVerified(historian.email);
  enforce(false);
  assert.equal((await postReport(historian, 3150000000001, { room: 5 })).status, 200, 'a report saved before enforcement, in room 6');
  enforce(true);
  const historianId = await userIdOf(historian.email);
  const monthAgo = new Date(Date.now() - 30 * DAY_MS).toISOString();
  await db.execute({ sql: "UPDATE saved_reports SET report_created_at = ? WHERE id = '3150000000001'", args: [monthAgo] });
  const reportRow = async () => (await db.execute({ sql: "SELECT id, room_number, report_created_at FROM saved_reports WHERE user_id = ?", args: [historianId] })).rows.map((r) => [String(r.id), Number(r.room_number), String(r.report_created_at)]);
  const original = await reportRow();

  const blocked = await roomIndex(historian);
  assert.deepEqual(blocked.body.rooms.map((r) => [r.room, r.status, r.historical === true]), [[5, 'ready', true]], 'unsubscribed: only the history room, with its month-old report');
  const blockedRoom = await getJson(reportsRoute, 'http://localhost/api/reports?room=5', historian.cookie);
  assert.equal(blockedRoom.body.report?.id, '3150000000001', 'the room still opens on its earlier report');
  const read = await getJson(reportByIdRoute, `http://localhost/api/reports/3150000000001?deviceKey=${encodeURIComponent(historian.deviceKey)}`, historian.cookie, { id: '3150000000001' });
  assert.equal(read.status, 200, 'and the report itself is readable');
  assert.equal((await postReport(historian, 3150000000002, { room: 5 })).status, 403, 'no new check in the history room');
  assert.equal((await postReport(historian, 3150000000003, { room: 0 })).status, 403, 'nor anywhere else');

  await grant(admin.cookie, { email: historian.email, action: 'activate', planDays: 30, rooms: 3 });
  const active = await roomIndex(historian);
  assert.deepEqual(
    active.body.rooms.map((r) => [r.room, r.status, r.outsidePlan === true, r.historical === true]),
    [[0, 'empty', false, false], [1, 'empty', false, false], [2, 'empty', false, false], [5, 'ready', true, true]],
    'activated for 3 rooms: exactly rooms 1–3 usable, plus the history room (outside the plan, read-only)',
  );
  assert.equal('notice' in active.body, false);
  assert.equal((await getJson(reportsRoute, 'http://localhost/api/reports?room=5', historian.cookie)).body.report?.id, '3150000000001', 'the history room still shows its report');
  const outside = await postReport(historian, 3150000000004, { room: 5 });
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, 'ROOM_NOT_IN_PLAN', 'the history room never takes a new check');
  assert.equal((await postReport(historian, 3150000000005, { room: 0 })).status, 200, 'a purchased room does');
  const after = (await reportRow()).filter(([id]) => id === '3150000000001');
  assert.deepEqual(after, original, 'the historical report is never deleted, renumbered or overwritten');
  pass('history: unsubscribed accounts list only their report rooms (readable, locked); activation shows exactly the purchased rooms plus read-only history; old reports untouched');
}

// ── 4 + 5 + 6. Rooms appear, are used under the room rules, balance shown correctly ─────────────────────────────
{
  const plan = (await planOf(alice)).body;
  assert.equal(plan.state, 'active');
  assert.equal(plan.planDays, 30);
  assert.deepEqual(plan.rooms, { allocated: 5, available: 5, cooling: 0 });
  const idx = await roomIndex(alice);
  assert.equal(idx.body.rooms.length, 5, 'the room list shows exactly the plan rooms');
  pass('4 the selected number of rooms appears in the customer account (5 rooms, 5 available)');

  assert.equal((await postReport(alice, 3200000000001, { room: 0 })).status, 200);
  assert.equal((await postReport(alice, 3200000000002, { room: 1 })).status, 200);
  assert.deepEqual((await planOf(alice)).body.rooms, { allocated: 5, available: 3, cooling: 2 });
  const idx2 = await roomIndex(alice);
  assert.equal(idx2.body.rooms[0].status, 'ready');
  assert.equal(idx2.body.rooms[2].status, 'empty');
  pass('5+6 the customer uses rooms under the existing rules; available rooms go 5 → 3 after two checks');

  const occupied = await postReport(alice, 3200000000003, { room: 0 });
  assert.equal(occupied.status, 409, 'a room in its 24 h cycle refuses a second check (existing rule)');
  const outside = await postReport(alice, 3200000000004, { room: 5 });
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, 'ROOM_NOT_IN_PLAN');
  pass('rooms keep one-report-per-24h; a room outside the plan is refused (ROOM_NOT_IN_PLAN)');
}

// ── 7 + 16. Retries / resaves never take another room ───────────────────────────────────────────────────────────
{
  const resave = await postReport(alice, 3200000000001, { room: 3, aiScore: 40 });
  assert.equal(resave.status, 200, 'the AI-result resave of an existing report succeeds');
  const claims = await db.execute({ sql: "SELECT room_number FROM account_room_claims c JOIN users u ON u.id = c.user_id WHERE u.email = 'alice@example.com' ORDER BY room_number", args: [] });
  assert.deepEqual(claims.rows.map((r) => Number(r.room_number)), [0, 1], 'a resave claims no room (room is immutable after the first save)');
  assert.deepEqual((await planOf(alice)).body.rooms, { allocated: 5, available: 3, cooling: 2 });

  // The same first save sent twice at once (a retried request racing its original).
  const twice = await Promise.all([postReport(alice, 3200000000005, { room: 2 }), postReport(alice, 3200000000005, { room: 2 })]);
  assert.ok(twice.some((r) => r.status === 200), 'one of them saves');
  const rows = await db.execute({ sql: "SELECT COUNT(*) AS c FROM saved_reports WHERE id = '3200000000005'", args: [] });
  assert.equal(Number(rows.rows[0].c), 1, 'one report row');
  assert.deepEqual((await planOf(alice)).body.rooms, { allocated: 5, available: 2, cooling: 3 }, 'exactly one room taken');
  pass('7+16 resaves (AI result, background retries) and a duplicated first save never take a second room');
}

// ── 8. Concurrent checks cannot beat the room limit ─────────────────────────────────────────────────────────────
{
  const race = await Promise.all([3, 3, 3, 3].map((room, i) => postReport(alice, 3200000000010 + i, { room })));
  const statuses = race.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409], 'four different checks racing for one room: exactly one wins');
  const lastRoom = await Promise.all([postReport(alice, 3200000000020, { room: 4 }), postReport(alice, 3200000000021, { room: 4 })]);
  assert.deepEqual(lastRoom.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual((await planOf(alice)).body.rooms, { allocated: 5, available: 0, cooling: 5 });
  pass('8 concurrent checks cannot exceed the plan: one winner per room');
}

// ── 9. Exhausted rooms block new checks; cooldown bypasses are closed ───────────────────────────────────────────
{
  for (const room of [0, 1, 2, 3, 4]) assert.equal((await postReport(alice, 3200000000030 + room, { room })).status, 409, `room ${room} busy`);
  // Delete the report in room 0 and try again immediately: the server-clock claim keeps the room cooling down.
  const del = await reportByIdRoute.DELETE(new Request(`http://localhost/api/reports/3200000000001?deviceKey=${encodeURIComponent(alice.deviceKey)}`, {
    method: 'DELETE', headers: { 'x-forwarded-for': ip('del'), cookie: `tp_session_v1=${alice.cookie}` },
  }), { params: Promise.resolve({ id: '3200000000001' }) });
  assert.equal(del.status, 200, 'the customer can delete a report');
  const afterDelete = await postReport(alice, 3200000000040, { room: 0 });
  assert.equal(afterDelete.status, 409, 'deleting a report does not free its room early');
  const idx = await roomIndex(alice);
  assert.equal(idx.body.rooms[0].status, 'empty');
  assert.equal(typeof idx.body.rooms[0].availableAt, 'string', 'the emptied room shows when it is available again');
  // A back-dated createdAt (client-supplied) on a fresh room cannot fake an elapsed cycle either.
  await db.execute({ sql: "DELETE FROM account_room_claims WHERE room_number = 4 AND user_id = (SELECT id FROM users WHERE email = 'bob@example.com')", args: [] });
  assert.equal((await postReport(bob, 3300000000001, { room: 4, createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString() })).status, 200);
  assert.equal((await postReport(bob, 3300000000002, { room: 4 })).status, 409, 'a back-dated report still holds its room for 24 h by the server clock');
  // Once the cooldown really has passed, the room is reusable (existing replace-expired-occupant rule).
  await db.execute({ sql: "UPDATE account_room_claims SET claimed_at = claimed_at - ? WHERE user_id = (SELECT id FROM users WHERE email = 'alice@example.com') AND room_number = 2", args: [ROOM_CYCLE_MS + 1000] });
  await db.execute({ sql: "UPDATE saved_reports SET report_created_at = ? WHERE id = '3200000000005'", args: [new Date(Date.now() - ROOM_CYCLE_MS - 1000).toISOString()] });
  assert.equal((await postReport(alice, 3200000000041, { room: 2 })).status, 200, 'after 24 h the room accepts a new check');
  pass('9 all rooms busy blocks new checks; delete-and-reupload and back-dated createdAt cannot skip the 24 h cooldown');
}

// ── 20. Activated customers are not limited by the 10-per-day cap ───────────────────────────────────────────────
{
  for (let room = 0; room < 12; room += 1) {
    const r = await postReport(dave, 3400000000000 + room, { room });
    assert.equal(r.status, 200, `upload ${room + 1} of 12 today`);
  }
  assert.deepEqual((await getJson(uploadLimitRoute, 'http://localhost/api/upload-limit', dave.cookie)).body, { authenticated: true, plan: true });
  pass('20 an activated customer makes 12 checks in one UTC day (the old cap of 10 does not apply)');
}

// ── 10 + 15. Expired plans block new checks; existing reports and resaves still work ────────────────────────────
{
  await db.execute({ sql: "UPDATE account_entitlements SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'bob@example.com')", args: [Date.now() - 1000] });
  const r = await postReport(bob, 3300000000010, { room: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PLAN_EXPIRED');
  assert.equal((await postReport(bob, 3300000000001, { room: 4, aiScore: 55 })).status, 200, 'a check that already started still finishes (resave)');
  const read = await getJson(reportByIdRoute, `http://localhost/api/reports/3300000000001?deviceKey=${encodeURIComponent(bob.deviceKey)}`, bob.cookie, { id: '3300000000001' });
  assert.equal(read.status, 200, 'saved reports stay accessible');
  const plan = (await planOf(bob)).body;
  assert.equal(plan.state, 'expired');
  assert.equal(plan.rooms.available, 0);
  const bobRooms = (await db.execute({ sql: "SELECT DISTINCT room_number FROM saved_reports WHERE user_id = (SELECT id FROM users WHERE email = 'bob@example.com') ORDER BY room_number", args: [] })).rows.map((r) => Number(r.room_number));
  assert.deepEqual((await roomIndex(bob)).body.rooms.map((r) => r.room), bobRooms, 'exactly the rooms that hold his reports stay listed');
  pass('10+15 expired plan: new checks 403 PLAN_EXPIRED, running checks finish, reports stay accessible');
}

// ── 11. Renewal, activation after expiry, room adjustment ───────────────────────────────────────────────────────
{
  const before = await entitlementRow(carol.email);
  const r = await grant(admin.cookie, { email: carol.email, action: 'renew', planDays: 90 });
  const after = await entitlementRow(carol.email);
  assert.equal(r.preview.extensionStartsAt, Number(before.expires_at), 'the renewal starts at the current expiry');
  assert.equal(Number(after.expires_at), Number(before.expires_at) + 90 * DAY_MS, 'no paid day is lost');
  assert.equal(Number(after.activated_at), Number(before.activated_at), 'the activation date is kept');
  assert.equal(Number(after.rooms), 10, 'rooms are kept unless a new number is entered');
  assert.equal(Number(after.plan_days), 90);
  const withRooms = await grant(admin.cookie, { email: carol.email, action: 'renew', planDays: 30, rooms: 15 });
  assert.equal(withRooms.result.event.next.rooms, 15);

  const blockedActivate = await preview(admin.cookie, { email: carol.email, action: 'activate', planDays: 30, rooms: 5 });
  assert.equal(blockedActivate.status, 409, 'an active plan is never silently overwritten by an activation');

  const renewExpired = await preview(admin.cookie, { email: bob.email, action: 'renew', planDays: 30 });
  assert.equal(renewExpired.status, 409, 'an expired plan is activated again, not renewed');
  const t0 = Date.now();
  await grant(admin.cookie, { email: bob.email, action: 'activate', planDays: 30, rooms: 20 });
  const bobRow = await entitlementRow(bob.email);
  assert.ok(Number(bobRow.activated_at) >= t0, 'a new activation after expiry starts now');
  assert.equal(Number(bobRow.expires_at) - Number(bobRow.activated_at), 30 * DAY_MS);
  assert.equal((await postReport(bob, 3300000000020, { room: 0 })).status, 200, 'the reactivated customer can check again');

  const noReason = await preview(admin.cookie, { email: alice.email, action: 'adjust_rooms', rooms: 8 });
  assert.equal(noReason.status, 400, 'a room correction requires a reason');
  const adj = await grant(admin.cookie, { email: alice.email, action: 'adjust_rooms', rooms: 8, reason: 'Customer paid for 3 more rooms' });
  assert.equal(adj.result.event.previous.rooms, 5);
  assert.equal(adj.result.event.next.rooms, 8);
  assert.equal((await roomIndex(alice)).body.rooms.length, 8);
  const shrink = await preview(admin.cookie, { email: alice.email, action: 'adjust_rooms', rooms: 2, reason: 'Correction' });
  assert.ok(shrink.body.preview.busyRoomsAboveNewCount >= 1, 'the confirmation warns about current reports above the new count');
  pass('11 renewal extends from the current expiry and keeps rooms; activation after expiry starts now; room adjustment needs a reason');
}

// ── 12. Double-click / retry never grants twice; stale reviews are refused ──────────────────────────────────────
{
  const p = await preview(admin.cookie, { email: erin.email, action: 'activate', planDays: 30, rooms: 5 });
  const body = { email: erin.email, action: 'activate', planDays: 30, rooms: 5, operationId: crypto.randomUUID(), expectedVersion: p.body.preview.expectedVersion, expectedUserId: p.body.preview.expectedUserId };
  const both = await Promise.all([commit(admin.cookie, body), commit(admin.cookie, body)]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.deepEqual(both.map((r) => r.body.outcome).sort(), ['applied', 'replayed']);
  const again = await commit(admin.cookie, body);
  assert.equal(again.body.outcome, 'replayed');
  assert.equal(Number((await entitlementRow(erin.email)).version), 1, 'applied exactly once');
  assert.equal(await eventCount(erin.email), 1, 'one audit row');

  const rp = await preview(admin.cookie, { email: erin.email, action: 'renew', planDays: 30 });
  const renewBody = { email: erin.email, action: 'renew', planDays: 30, expectedVersion: rp.body.preview.expectedVersion, expectedUserId: rp.body.preview.expectedUserId };
  const r1 = await commit(admin.cookie, { ...renewBody, operationId: crypto.randomUUID() });
  const r2 = await commit(admin.cookie, { ...renewBody, operationId: crypto.randomUUID() });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 409, 'a second confirmation of the same reviewed plan (another tab) is refused as stale');
  assert.equal(r2.body.code, 'STALE');
  const erinRow = await entitlementRow(erin.email);
  assert.equal(Number(erinRow.expires_at) - Number(erinRow.activated_at), 60 * DAY_MS, 'extended once, not twice');

  const reused = await commit(admin.cookie, { ...body, email: alice.email, expectedUserId: await userIdOf(alice.email) });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, 'OPERATION_REUSED');
  const retargeted = await commit(admin.cookie, { ...body, email: alice.email, operationId: crypto.randomUUID() });
  assert.equal(retargeted.status, 409, 'a confirmation reviewed for one account never applies to another');
  assert.equal(retargeted.body.code, 'ACCOUNT_CHANGED');
  pass('12 double-click / retry is applied once; a stale second tab cannot extend twice; an operation id cannot be reused or re-targeted');
}

// ── 12b. The plan is bound to the reviewed account id, not to whoever holds the email at confirmation time ─────────
{
  const original = await signup('swap@example.com');
  await markVerified(original.email);
  const p = await preview(admin.cookie, { email: original.email, action: 'activate', planDays: 30, rooms: 3 });
  assert.equal(p.status, 200);
  const reviewedId = p.body.preview.expectedUserId;
  assert.equal(reviewedId, await userIdOf(original.email));
  // Between the review and the confirmation the address moves to a different account.
  await db.execute({ sql: "UPDATE users SET email = 'swap-old@example.com' WHERE id = ?", args: [reviewedId] });
  const newcomer = await signup('swap@example.com');
  await markVerified(newcomer.email);
  const c = await commit(admin.cookie, { email: 'swap@example.com', action: 'activate', planDays: 30, rooms: 3, operationId: crypto.randomUUID(), expectedVersion: 0, expectedUserId: reviewedId });
  assert.equal(c.status, 409);
  assert.equal(c.body.code, 'ACCOUNT_CHANGED');
  const plans = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM account_entitlements WHERE user_id IN (?, ?)', args: [reviewedId, await userIdOf('swap@example.com')] });
  assert.equal(Number(plans.rows[0].c), 0, 'neither account received a plan');
  pass('12b a confirmation applies only to the account id that was reviewed; an email that changed hands is refused (ACCOUNT_CHANGED)');
}

// ── suspend / reactivate ────────────────────────────────────────────────────────────────────────────────────────
{
  assert.equal((await preview(admin.cookie, { email: erin.email, action: 'suspend' })).status, 400, 'a suspension needs a reason');
  await grant(admin.cookie, { email: erin.email, action: 'suspend', reason: 'Payment dispute' });
  const r = await postReport(erin, 3500000000001, { room: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'ACCOUNT_SUSPENDED');
  assert.equal((await planOf(erin)).body.state, 'suspended');
  const expiry = Number((await entitlementRow(erin.email)).expires_at);
  await grant(admin.cookie, { email: erin.email, action: 'reactivate' });
  assert.equal(Number((await entitlementRow(erin.email)).expires_at), expiry, 'reactivation keeps the original expiry');
  assert.equal((await postReport(erin, 3500000000001, { room: 0 })).status, 200);
  pass('suspend blocks new checks (ACCOUNT_SUSPENDED); reactivate restores them with the original expiry');
}

// ── CHECK WORK: the routes that compute a check before its save refuse unsubscribed accounts too (no API bypass) ────
{
  const checkText = 'Subscription gate manuscript. Groundwater recharge estimates for semi-arid basins depend on careful seasonal accounting.';
  async function checkWork(route, pathName, user, text = checkText) {
    const addr = ip('work');
    await resetRateForTest(addr);
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': addr, ...(user ? { cookie: `tp_session_v1=${user.cookie}` } : {}) };
    const res = await route.POST(new Request(`http://localhost${pathName}`, { method: 'POST', headers, body: JSON.stringify({ text, scoringNormalization: 2 }) }));
    const body = await res.text();
    return { status: res.status, body: body ? JSON.parse(body) : null };
  }
  const archive = (user, text) => checkWork(archiveMatchRoute, '/api/archive/match', user, text);
  const academic = (user, text) => checkWork(academicEvidenceRoute, '/api/academic-evidence', user, text);
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = 'true';
  try {
    // Expired and suspended fixtures for this section (restored at the end).
    const hankId = await userIdOf(hank.email);
    const hankExpiry = Number((await entitlementRow(hank.email)).expires_at);
    await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [Date.now() - 1000, hankId] });
    await grant(admin.cookie, { email: gina.email, action: 'suspend', reason: 'Check-work gate test' });

    for (const [label, user, status, code] of [
      ['signed out', null, 401, 'SIGN_IN_REQUIRED'],
      ['no subscription', freeUser, 403, 'ACTIVATION_REQUIRED'],
      ['expired subscription', hank, 403, 'PLAN_EXPIRED'],
      ['suspended subscription', gina, 403, 'ACCOUNT_SUSPENDED'],
    ]) {
      for (const [routeName, call] of [['archive/match', archive], ['academic-evidence', academic]]) {
        const r = await call(user);
        assert.equal(r.status, status, `${routeName}: ${label} -> ${status}`);
        assert.equal(r.body.code, code, `${routeName}: ${label} -> ${code}`);
      }
    }
    assert.equal((await archive(freeUser)).body.error, planBlockMessage('ACTIVATION_REQUIRED', null));
    const allowed = await archive(alice);
    assert.equal(allowed.status, 200, 'an active subscription runs its check work');
    assert.ok(allowed.body.result, 'and gets the archive result');
    assert.equal((await archive(admin)).status, 200, 'administrators are unaffected');
    // academic-evidence's allowed path would query live academic providers, so its gate is checked directly.
    const aliceSession = { id: await userIdOf(alice.email), email: alice.email, username: 'alice', role: 'user', corpusReuseConsented: true };
    assert.equal(await checkWorkRefusal(db, aliceSession, canonicalSha256(checkText)), null, 'academic-evidence gate: active subscription passes');
    pass('check work: signed-out 401; no / expired / suspended subscription 403 on /api/archive/match and /api/academic-evidence; active plan and admin pass');

    // A check that started while the plan was active may finish its remaining check work after the plan expires:
    // only for the exact manuscript its open authorization was issued for.
    await grant(admin.cookie, { email: gina.email, action: 'reactivate' });
    const auth = await issueAuthorization(gina, 0, checkText);
    assert.equal(auth.status, 200);
    const ginaId = await userIdOf(gina.email);
    const issuedAt = Number((await db.execute({ sql: 'SELECT issued_at FROM account_check_authorizations WHERE id = ?', args: [auth.body.authorization] })).rows[0].issued_at);
    const ginaExpiry = Number((await entitlementRow(gina.email)).expires_at);
    await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [issuedAt + 1, ginaId] });
    assert.equal((await archive(gina)).status, 200, 'the authorized manuscript finishes its check work after expiry');
    const other = await archive(gina, `${checkText} A different manuscript.`);
    assert.equal(other.status, 403, 'any other manuscript is refused');
    assert.equal(other.body.code, 'PLAN_EXPIRED');
    pass('check work: a check authorized while the plan was active finishes after expiry, for its own manuscript only');

    await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [ginaExpiry, ginaId] });
    await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [hankExpiry, hankId] });
    await db.execute({ sql: 'DELETE FROM account_check_authorizations WHERE user_id = ?', args: [ginaId] });

    enforce(false);
    assert.equal((await archive(null)).status, 200, 'enforcement off: the route behaves exactly as before (no sign-in needed)');
    enforce(true);
    pass('check work: with enforcement off, the check-work routes are unchanged');
  } finally {
    delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  }
}

// ── EXPIRY BOUNDARY: a check authorized before expiry may save once; nothing else may ──────────────────────────────
{
  const frankId = String((await db.execute({ sql: "SELECT id FROM users WHERE email = 'frank@example.com'", args: [] })).rows[0].id);
  const setPlan = (fields) => db.execute({
    sql: `UPDATE account_entitlements SET expires_at = ?, status = ? WHERE user_id = ?`,
    args: [fields.expiresAt, fields.status ?? 'active', frankId],
  });
  const reactivate = () => setPlan({ expiresAt: Date.now() + 30 * DAY_MS });
  /** The plan ends right after the authorization was issued (the analysis outlived the plan). */
  const expireAfter = async (authorizationId) => {
    const row = (await db.execute({ sql: 'SELECT issued_at FROM account_check_authorizations WHERE id = ?', args: [authorizationId] })).rows[0];
    await setPlan({ expiresAt: Number(row.issued_at) + 1 });
  };
  const authRow = async (id) => (await db.execute({ sql: 'SELECT * FROM account_check_authorizations WHERE id = ?', args: [id] })).rows[0];
  const claimCount = async () => Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM account_room_claims WHERE user_id = ?', args: [frankId] })).rows[0].c);
  const T = (n) => `Manuscript ${n}. Groundwater recharge estimates for semi-arid basins depend on careful seasonal accounting across catchments.`;

  // The browser's hash and the server's hash of the same text agree (including whitespace/line-ending variants).
  assert.equal(await browserTextSha256(T(1)), canonicalSha256(T(1)));
  assert.equal(await browserTextSha256(`  ${T(1)}\r\n`), canonicalSha256(T(1)));

  // B1 — the normal path: issued while active, the plan expires during the analysis, the save is still accepted.
  const a1 = await issueAuthorization(frank, 0, T(1));
  assert.equal(a1.status, 200);
  assert.equal(a1.body.required, true);
  assert.match(a1.body.authorization, /^[0-9a-f]{32}$/);
  assert.ok(Date.parse(a1.body.expiresAt) - Date.now() <= 60 * 60 * 1000 + 5000, 'bounded validity (60 min)');
  await expireAfter(a1.body.authorization);
  assert.equal((await postReport(frank, 3600000000001, { room: 0, text: T(9) })).status, 403, 'a NEW check after expiry without an authorization stays blocked');
  const saved = await postReport(frank, 3600000000002, { room: 0, text: T(1), checkAuthorization: a1.body.authorization });
  assert.equal(saved.status, 200, 'a check authorized before expiry saves after expiry');
  const consumed = await authRow(a1.body.authorization);
  assert.ok(Number(consumed.consumed_at) > 0);
  assert.equal(consumed.report_id, '3600000000002');
  assert.equal(await claimCount(), 1, 'it still takes its room (cooldown applies)');
  pass('B1 a check authorized before expiry saves after the plan expires, takes its room once, and consumes its authorization');

  // B2 — background retries / resaves of that report after expiry: allowed, never another room.
  assert.equal((await postReport(frank, 3600000000002, { room: 0, text: T(1), aiScore: 44 })).status, 200);
  assert.equal((await postReport(frank, 3600000000002, { room: 0, text: T(1), aiScore: 45, checkAuthorization: a1.body.authorization })).status, 200, 'a resave carrying the spent id is still just a resave');
  assert.equal(await claimCount(), 1);
  pass('B2 resaves and background retries of the authorized report succeed after expiry and take no extra room');

  // B3 — the spent authorization can never start another check: other report, other room, other text.
  for (const [id, room, text] of [[3600000000003, 0, T(1)], [3600000000004, 1, T(1)], [3600000000005, 1, T(2)]]) {
    const r = await postReport(frank, id, { room, text, checkAuthorization: a1.body.authorization });
    assert.ok(r.status === 403 || r.status === 409, `replay ${id} refused (${r.status})`);
  }
  assert.equal(await claimCount(), 1);
  // And no new authorization can be obtained after expiry.
  const late = await issueAuthorization(frank, 1, T(3));
  assert.equal(late.status, 403);
  assert.equal(late.body.code, 'PLAN_EXPIRED');
  pass('B3 a used authorization cannot be replayed (same or other document/room), and none is issued after expiry');

  // B4 — bound to the document, the room and the account.
  await reactivate();
  const a4 = await issueAuthorization(frank, 1, T(4));
  await expireAfter(a4.body.authorization);
  assert.equal((await postReport(frank, 3600000000010, { room: 1, text: T(5), checkAuthorization: a4.body.authorization })).status, 403, 'another document');
  assert.equal((await postReport(frank, 3600000000011, { room: 2, text: T(4), checkAuthorization: a4.body.authorization })).status, 403, 'another room');
  assert.equal((await postReport(alice, 3600000000012, { room: 1, text: T(4), checkAuthorization: a4.body.authorization })).status === 200 ? 'leak' : 'ok', 'ok', 'another account');
  assert.equal((await authRow(a4.body.authorization)).consumed_at, null, 'refused attempts do not use it up');
  assert.equal((await postReport(frank, 3600000000013, { room: 1, text: T(4), checkAuthorization: a4.body.authorization })).status, 200, 'the right document still saves');
  pass('B4 an authorization only ever permits its own account, room and document');

  // B5 — bounded in time; issued-after-expiry rows are never honoured; a suspension is never overridden.
  await reactivate();
  const a5 = await issueAuthorization(frank, 2, T(6));
  await expireAfter(a5.body.authorization);
  await db.execute({ sql: 'UPDATE account_check_authorizations SET expires_at = ? WHERE id = ?', args: [Date.now() - 1, a5.body.authorization] });
  assert.equal((await postReport(frank, 3600000000020, { room: 2, text: T(6), checkAuthorization: a5.body.authorization })).status, 403, 'a timed-out authorization is not honoured');
  await db.execute({ sql: 'UPDATE account_check_authorizations SET expires_at = ?, issued_at = ? WHERE id = ?', args: [Date.now() + 60000, Date.now(), a5.body.authorization] });
  assert.equal((await postReport(frank, 3600000000021, { room: 2, text: T(6), checkAuthorization: a5.body.authorization })).status, 403, 'issued after the plan ended: not honoured');
  await reactivate();
  const a5b = await issueAuthorization(frank, 2, T(7));
  await setPlan({ expiresAt: Date.now() + DAY_MS, status: 'suspended' });
  const susp = await postReport(frank, 3600000000022, { room: 2, text: T(7), checkAuthorization: a5b.body.authorization });
  assert.equal(susp.status, 403);
  assert.equal(susp.body.code, 'ACCOUNT_SUSPENDED', 'a suspension is never overridden');
  pass('B5 authorizations time out, are never honoured if issued after expiry, and never override a suspension');

  // B6 — concurrency: one authorization, two saves at once → exactly one new report.
  await reactivate();
  const a6 = await issueAuthorization(frank, 2, T(8));
  await expireAfter(a6.body.authorization);
  const race = await Promise.all([3600000000030, 3600000000031].map((id) => postReport(frank, id, { room: 2, text: T(8), checkAuthorization: a6.body.authorization })));
  assert.deepEqual(race.map((r) => r.status === 200).filter(Boolean).length, 1, `exactly one wins (${race.map((r) => r.status)})`);
  const reports = await db.execute({ sql: "SELECT COUNT(*) AS c FROM saved_reports WHERE id IN ('3600000000030', '3600000000031')", args: [] });
  assert.equal(Number(reports.rows[0].c), 1);
  pass('B6 two concurrent saves with one authorization create exactly one report');

  // B7 — issuance itself follows the plan and the room rules.
  await reactivate();
  const busy = await issueAuthorization(frank, 0, T(10));
  assert.equal(busy.status, 409, 'a room in its 24 h cooldown gets no authorization');
  assert.equal(busy.body.code, 'ROOM_COOLING_DOWN');
  const outside = await issueAuthorization(frank, 3, T(10));
  assert.equal(outside.status, 403);
  assert.equal(outside.body.code, 'ROOM_NOT_IN_PLAN');
  const noPlan = await issueAuthorization(freeUser, 0, T(10));
  assert.equal(noPlan.status, 403);
  assert.equal(noPlan.body.code, 'ACTIVATION_REQUIRED');
  assert.equal((await issueAuthorization(admin, 5, T(10))).body.required, false, 'administrators need none');
  const badHash = await issueAuthorization(frank, 1, null, { textSha256: 'not-a-hash' });
  assert.equal(badHash.status, 400);
  const anon = await checkAuthorizationRoute.POST(new Request('http://localhost/api/reports/check-authorization', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip('auth') }, body: JSON.stringify({ room: 0, textSha256: canonicalSha256(T(1)) }),
  }));
  assert.equal(anon.status, 401);
  const cross = await checkAuthorizationRoute.POST(new Request('http://localhost/api/reports/check-authorization', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip('auth'), origin: 'https://evil.example', host: 'localhost', cookie: `tp_session_v1=${frank.cookie}` },
    body: JSON.stringify({ room: 1, textSha256: canonicalSha256(T(1)) }),
  }));
  assert.equal(cross.status, 403, 'cross-site requests are refused');
  pass('B7 authorizations are issued only for an active plan, a room inside it and free, to the signed-in same-site customer');

  // B8 — feature OFF: nothing is issued and a stray id changes nothing.
  enforce(false);
  const off = await issueAuthorization(freeUser, 1, T(11));
  assert.deepEqual(off.body, { required: false });
  assert.equal((await postReport(freeUser, 3600000000040, { room: 1, text: T(11), checkAuthorization: 'f'.repeat(32) })).status, 200, 'baseline save');
  enforce(true);
  pass('B8 with the feature off no authorization is issued or needed and saves behave as before');
}

// ── admin list + search + pagination ────────────────────────────────────────────────────────────────────────────
{
  const all = await listAccounts(admin.cookie);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 10, 'alice, bob, carol, dave, erin, frank, gina, hank, ivan, historian');
  const keys = Object.keys(all.body.rows[0]).sort();
  assert.deepEqual(keys, ['activatedAt', 'email', 'emailVerified', 'expiresAt', 'planDays', 'rooms', 'roomsAvailable', 'state', 'userId', 'username']);
  await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [Date.now() - 1000, await userIdOf(hank.email)] });
  const expired = await listAccounts(admin.cookie, 'filter=expired');
  assert.deepEqual(expired.body.rows.map((r) => [r.email, r.state]), [['hank@example.com', 'expired']], 'an expired subscription is listed under its own filter');
  const activeNow = await listAccounts(admin.cookie, 'filter=active');
  assert.equal(activeNow.body.rows.some((r) => r.email === 'hank@example.com'), false, 'and no longer as active');
  const search = await listAccounts(admin.cookie, 'q=ALICE');
  assert.deepEqual(search.body.rows.map((r) => r.email), ['alice@example.com']);
  const wildcard = await listAccounts(admin.cookie, 'q=%25');
  assert.equal(wildcard.body.total, 0, 'LIKE wildcards are literal');
  const active = await listAccounts(admin.cookie, 'filter=active');
  assert.ok(active.body.rows.every((r) => r.state === 'active'));
  const page2 = await listAccounts(admin.cookie, 'page=2');
  assert.equal(page2.body.rows.length, 0);
  assert.equal(page2.body.page, 2);
  pass('admin list: search by email (wildcards literal), status filter, pagination, no secrets in rows');
}

// ── 0057 missing while enforced fails closed; account deletion removes the plan ─────────────────────────────────
{
  await grant(admin.cookie, { email: leaver.email, action: 'activate', planDays: 30, rooms: 2 });
  const me = await meRoute.DELETE(new Request('http://localhost/api/auth/me', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip('me'), cookie: `tp_session_v1=${leaver.cookie}` },
    body: JSON.stringify({ password: 'correct-horse-1', confirm: ACCOUNT_DELETION_CONFIRMATION_PHRASE }),
  }));
  assert.equal(me.status, 200, 'account deletion still works');
  assert.equal(await entitlementRow(leaver.email), null);
  for (const table of ['account_entitlements', 'account_room_claims', 'account_check_authorizations']) {
    const leftovers = await db.execute({ sql: `SELECT COUNT(*) AS c FROM ${table} WHERE user_id NOT IN (SELECT id FROM users)`, args: [] });
    assert.equal(Number(leftovers.rows[0].c), 0, `${table} rows go with the account`);
  }
  const audit = await db.execute({ sql: "SELECT * FROM account_entitlement_events WHERE target_email = 'leaver@example.com' ORDER BY created_at", args: [] });
  assert.deepEqual(audit.rows.map((r) => r.action), ['activate', 'account_deleted'], 'the admin audit trail is kept and ends with the deletion');
  const deletion = audit.rows[1];
  assert.equal(deletion.admin_user_id, null);
  assert.equal(deletion.new_json, null);
  assert.equal(JSON.parse(deletion.previous_json).rooms, 2, 'the plan held at deletion');
  assert.deepEqual(
    Object.keys(deletion).sort(),
    ['action', 'admin_email', 'admin_user_id', 'created_at', 'new_json', 'operation_id', 'previous_json', 'reason', 'target_email', 'target_email_verified', 'user_id'],
    'a minimal record: no other field exists',
  );
  const everything = JSON.stringify(audit.rows);
  for (const forbidden of ['password', 'scrypt', 'token', 'sample extracted text', leaver.cookie]) {
    assert.equal(everything.includes(forbidden), false, `no ${forbidden} in the retained audit`);
  }
  // An account that never had a plan leaves no audit record.
  const plain = await signup('never-activated@example.com');
  const del2 = await meRoute.DELETE(new Request('http://localhost/api/auth/me', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip('me'), cookie: `tp_session_v1=${plain.cookie}` },
    body: JSON.stringify({ password: 'correct-horse-1', confirm: ACCOUNT_DELETION_CONFIRMATION_PHRASE }),
  }));
  assert.equal(del2.status, 200);
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM account_entitlement_events WHERE target_email = 'never-activated@example.com'", args: [] })).rows[0].c), 0);
  pass('account deletion removes the plan, room claims and authorizations; a minimal admin audit record is kept, with no manuscript, password or secret');
}

// ── roles: no subscription action ever makes a customer an administrator ──────────────────────────────────────────
{
  const admins = await db.execute({ sql: "SELECT email FROM users WHERE role = 'admin'", args: [] });
  assert.deepEqual(admins.rows.map((r) => r.email), [admin.email], 'the only administrator is the one the test granted');
  const others = await db.execute({ sql: "SELECT COUNT(*) AS c FROM users WHERE role != 'user' AND role != 'admin'", args: [] });
  assert.equal(Number(others.rows[0].c), 0);
  pass('roles: after every activation, renewal, adjustment, suspension and reactivation, no customer became an administrator');
}

enforce(false);
db.close();
console.log(`\n${results.length} account-activation scenarios passed`);
