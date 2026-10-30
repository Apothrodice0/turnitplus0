import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportRoute from '../app/api/reports/[id]/route.ts';
import * as system2Route from '../app/api/reports/[id]/system2/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { getSessionUserByToken } from '../lib/auth-session.ts';
import { resolveSystem2Access } from '../lib/system2-access.ts';
import { storedSystem2Estimate } from '../lib/system2-estimate-record.ts';
import { unifySimilarity } from '../lib/system2-unified.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';
import { minimalDocx, reportTextOf } from './helpers/minimal-docx.mjs';

// INTEGRATION (feature/subscriptions-system2-integration-20261029; owner launch requirement 2026-10-30): every verified
// customer with an ACTIVE subscription gets BOTH systems, automatically, for a Word document checked in a room of their
// plan — one similarity percentage, max(System 1, System 2), stored with the report so the room, the report and the
// receipt agree. Administrators keep it. Unsubscribed, expired, suspended, unverified and signed-out accounts never run
// System 2 (plain 404), nobody can run it on another account's report or attach another document's estimate, and it
// stays off in production until its own switch is set. Real routes, a real database, a local stub inference backend.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_integration_subscription_system2.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;
const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));

// ---- local stub inference backend: the frozen model's response shape, estimate 8 (counts every call)
let backendCalls = 0;
let backendDelayMs = 0;
const backend = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    backendCalls += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'CONSERVATIVE_WITHIN_RANGE', estimate_shown: true, research_only: true, conservative_estimate_percent: 8, final_text: 'Conservative estimate: about 8%.', language_check: { clearly_english: true } }));
    }, backendDelayMs);
  });
});
await new Promise((r) => backend.listen(0, '127.0.0.1', r));

// The protected Preview configuration: subscriptions enforced, retention on, System 2 on for administrators AND subscribers.
process.env.ACCOUNT_ACTIVATION_ENFORCED = '1';
process.env.REPORT_HISTORY_RETENTION_ENABLED = '1';
process.env.S2_RESEARCH_ENABLED = '1';
process.env.S2_SUBSCRIBERS_ENABLED = '1';
process.env.S2_RESEARCH_OWNER_EMAILS = '';
process.env.S2_INFERENCE_URL = `http://127.0.0.1:${backend.address().port}/api/analyze`;
process.env.S2_INFERENCE_KEY = 'k'.repeat(40);
process.env.VERCEL_ENV = 'preview';
delete process.env.S2_PRODUCTION_ENABLED;

let n = 0;
const ip = (t) => `int-${t}-${++n}`;
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
async function signup(email) {
  const addr = ip('signup');
  await resetAuthRateForTest(addr);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
    body: JSON.stringify(withTestIdentity({ email, password: 'correct-horse-1', username: email.split('@')[0], deviceKey: `dev-${email}` })),
  }));
  assert.equal(res.status, 201);
  const id = String((await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  await db.execute({ sql: 'UPDATE users SET email_verified_at = ? WHERE id = ?', args: [Date.now(), id] });
  return { id, email, cookie: cookieOf(res), deviceKey: `dev-${email}` };
}

// Each report is one real Word document; the saved report text is what the browser extracts from it.
const docs = new Map();
async function docFor(id) {
  const key = String(id);
  if (!docs.has(key)) {
    const bytes = await minimalDocx([`Integration manuscript ${key}.`, 'An ordinary English paragraph about research methods and results.']);
    docs.set(key, { bytes, text: await reportTextOf(bytes) });
  }
  return docs.get(key);
}
async function postReport(u, id, room, extra = {}) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = new Date().toISOString();
  const { text } = await docFor(id);
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${u.cookie}` },
    body: JSON.stringify({ deviceKey: u.deviceKey, id: String(id), submissionId: String(id).slice(-10), title: `r-${id}.docx`, createdAt: created, wordCount: 400, archiveScore: 6, scoreBand: 'Low', aiScore: 'aiScore' in extra ? extra.aiScore : 10, aiTone: 'aiScore' in extra && extra.aiScore === null ? null : 'low', room,
      payload: { version: 11, id: String(id), submissionId: String(id).slice(-10), title: `r-${id}.docx`, created, score: 6, archiveScore: 6, wordCount: 400, text, ...(extra.payload ?? {}) } }),
  }));
  return res.status;
}
async function system2(u, reportId, { bytes, notSent } = {}) {
  const body = notSent ? undefined : bytes ?? (await docFor(reportId)).bytes;
  const res = await system2Route.POST(new Request(`http://localhost/api/reports/${reportId}/system2`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip('s2'), host: 'localhost', origin: 'http://localhost', 'x-s2-consent': 'granted', 'content-type': 'application/octet-stream', 'x-file-extension': '.docx', ...(notSent ? { 'x-s2-not-sent': notSent } : {}), ...(u ? { cookie: `tp_session_v1=${u.cookie}` } : {}) },
    body,
  }), { params: Promise.resolve({ id: String(reportId) }) });
  return { status: res.status, body: await res.json() };
}
const storedPayload = async (id) => JSON.parse(String((await db.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE id = ?', args: [String(id)] })).rows[0].payload_json));
async function access(u, room) {
  const user = u ? await getSessionUserByToken(u.cookie, db) : null;
  return (await resolveSystem2Access(db, user, room === undefined ? {} : { room })).reason;
}

const admin = await signup('owner@example.com');
await grantTestAdmin(dbFile, admin.email);
const subscriber = await signup('subscriber@example.com');
const subscriber2 = await signup('subscriber2@example.com');
const unsubscribed = await signup('unsubscribed@example.com');
const expired = await signup('expired@example.com');
const suspended = await signup('suspended@example.com');
const unverified = await signup('unverified@example.com');

async function grant(body) {
  const call = async (b) => {
    const addr = ip('admin');
    await resetAdminRateForTest(addr);
    const res = await applyRoute.POST(new Request('http://localhost/api/admin/account-activation/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, host: 'localhost', origin: 'http://localhost', cookie: `tp_session_v1=${admin.cookie}` }, body: JSON.stringify(b) }));
    return { status: res.status, body: await res.json() };
  };
  const p = await call({ ...body, dryRun: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await call({ ...body, dryRun: false, operationId: crypto.randomUUID(), expectedVersion: p.body.preview.expectedVersion, expectedUserId: p.body.preview.expectedUserId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
}
for (const u of [subscriber, subscriber2, expired, suspended, unverified]) await grant({ email: u.email, action: 'activate', planDays: 30, rooms: 2 });

// Reports saved while each plan was active; the plan then ends (or the email stops being verified) before System 2 runs.
assert.equal(await postReport(expired, 7200000000001, 0), 200);
assert.equal(await postReport(suspended, 7200000000002, 0), 200);
assert.equal(await postReport(unverified, 7200000000003, 0), 200);
await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [Date.now() - 60_000, expired.id] });
await grant({ email: suspended.email, action: 'suspend', reason: 'integration test' });
await db.execute({ sql: 'UPDATE users SET email_verified_at = NULL WHERE id = ?', args: [unverified.id] });

const results = [];
const pass = (name) => { results.push(name); console.log(`ok - ${name}`); };

{
  assert.equal(await access(subscriber, 0), 'SUBSCRIBER');
  assert.equal(await access(subscriber, 1), 'SUBSCRIBER');
  assert.equal(await access(subscriber, 2), 'ROOM_NOT_IN_PLAN', 'never beyond the purchased rooms');
  assert.equal(await access(admin, 35), 'ADMIN');
  assert.equal(await access(unsubscribed, 0), 'NO_SUBSCRIPTION');
  assert.equal(await access(expired, 0), 'EXPIRED');
  assert.equal(await access(suspended, 0), 'SUSPENDED');
  assert.equal(await access(unverified, 0), 'UNVERIFIED');
  assert.equal(await access(null, 0), 'SIGNED_OUT');
  // the legacy free-access grace is never a subscription (its policy is the unenforced baseline)
  const subUser = await getSessionUserByToken(subscriber.cookie, db);
  const gracePolicy = { enforced: false, visibleRoomCount: 10, uploadRoomCount: 10, dailyCapApplies: true, block: null, usesRoomClaims: false, entitlement: null, state: 'none', grace: { endsAt: Date.now() + 1e9 } };
  assert.equal((await resolveSystem2Access(db, subUser, { policy: gracePolicy })).reason, 'SUBSCRIPTIONS_OFF');
  pass('eligibility: active verified subscribers (rooms in plan) and administrators; never unsubscribed, expired, suspended, unverified, grace or signed out');
}
{
  backendCalls = 0;
  assert.equal(await postReport(subscriber, 7100000000001, 0), 200, 'System 1: the subscriber checks a Word document in a purchased room');
  const s2 = await system2(subscriber, 7100000000001);
  assert.equal(s2.status, 200); assert.equal(s2.body.persisted, true); assert.equal(s2.body.conservative_estimate_percent, 8);
  assert.equal(backendCalls, 1, 'System 2 ran on the real route, server-to-server');
  const payload = await storedPayload(7100000000001);
  assert.equal(payload.system2Estimate.conservative_estimate_percent, 8, 'stored with the report');
  assert.equal(unifySimilarity(6, storedSystem2Estimate(payload)).percent, 8, 'one percentage: max(System 1 6%, System 2 8%)');
  // reopening: the room read and the report read (any device: the session, not the device key) carry the stored estimate
  const room = await reportsRoute.GET(new Request('http://localhost/api/reports?room=0', { headers: { cookie: `tp_session_v1=${subscriber.cookie}`, 'x-forwarded-for': ip('room') } }));
  assert.equal(room.status, 200);
  assert.equal(JSON.stringify(await room.json()).includes('"system2EstimatePercent":8'), true, 'room summary carries the stored estimate');
  const reopened = await reportRoute.GET(new Request('http://localhost/api/reports/7100000000001', { headers: { cookie: `tp_session_v1=${subscriber.cookie}`, 'x-forwarded-for': ip('read') } }), { params: Promise.resolve({ id: '7100000000001' }) });
  assert.equal(reopened.status, 200);
  const reopenedBody = await reopened.json();
  const reopenedReport = reopenedBody.payload ?? reopenedBody.report ?? reopenedBody;
  assert.equal(storedSystem2Estimate(reopenedReport)?.conservative_estimate_percent, 8, 'the reopened report (and so its receipt) reads the same stored estimate');
  pass('an active subscriber gets BOTH systems: System 1 report, System 2 stored with it, one unified 8% on room and report reads');
}
{
  backendCalls = 0; backendDelayMs = 150;
  assert.equal(await postReport(subscriber, 7100000000002, 1, { aiScore: null }), 200, 'saved while the AI check is still running');
  // two System 2 requests and the AI-result resave, all at once
  const [a, b, resave] = await Promise.all([system2(subscriber, 7100000000002), system2(subscriber, 7100000000002), postReport(subscriber, 7100000000002, 1, { aiScore: 22 })]);
  backendDelayMs = 0;
  assert.equal(resave, 200);
  assert.equal([a, b].filter((r) => r.body.persisted === true).length, 1, 'exactly one estimate is stored');
  const payload = await storedPayload(7100000000002);
  assert.equal(payload.system2Estimate.conservative_estimate_percent, 8, 'the AI resave did not drop the estimate');
  assert.equal(Number((await db.execute({ sql: 'SELECT ai_score FROM saved_reports WHERE id = ?', args: ['7100000000002'] })).rows[0].ai_score), 22, 'the estimate did not drop the AI resave');
  const late = await system2(subscriber, 7100000000002);
  assert.equal(late.status, 409, 'later requests never replace it');
  pass('concurrency: two System 2 requests + an AI resave at once — one estimate stored, AI result kept, nothing overwritten');
}
{
  backendCalls = 0;
  for (const [u, id, label] of [[expired, 7200000000001, 'expired'], [suspended, 7200000000002, 'suspended'], [unverified, 7200000000003, 'unverified']]) {
    assert.equal((await system2(u, id)).status, 404, `${label}: System 2 route is 404 on its own report`);
  }
  process.env.S2_RESEARCH_OWNER_EMAILS = expired.email;
  assert.equal((await system2(expired, 7200000000001)).status, 404, 'expired: the owner allowlist does not reopen a refused report');
  process.env.S2_RESEARCH_OWNER_EMAILS = '';
  assert.equal(await postReport(unsubscribed, 7100000000003, 0), 403, 'no subscription: no check at all');
  assert.equal((await system2(null, 7100000000001)).status, 404, 'signed out: 404');
  assert.equal((await system2(subscriber2, 7100000000001)).status, 404, "another customer's report: 404");
  assert.equal((await system2(admin, 7100000000001)).status, 404, "even an administrator cannot run it on a customer's report");
  assert.equal(await postReport(subscriber, 7100000000004, 2), 403, 'room outside the plan: no check');
  assert.equal(backendCalls, 0, 'no ineligible request ever reached the backend');
  pass('unsubscribed, expired, suspended, unverified, signed-out and cross-account requests never reach System 2 (404)');
}
{
  backendCalls = 0;
  assert.equal(await postReport(subscriber2, 7100000000005, 0), 200);
  const forged = await postReport(subscriber2, 7100000000006, 1, { payload: { system2Estimate: { state: 'X', estimate_shown: true, final_text: '', conservative_estimate_percent: 20 } } });
  assert.equal(forged, 200);
  assert.equal((await storedPayload(7100000000006)).system2Estimate, undefined, 'a browser-supplied estimate is dropped');
  const other = await docFor('unrelated-document');
  const mismatch = await system2(subscriber2, 7100000000005, { bytes: other.bytes });
  assert.equal(mismatch.status, 422); assert.equal(mismatch.body.state, 'DOCUMENT_MISMATCH');
  const pdf = await system2(subscriber2, 7100000000005, { notSent: 'UNSUPPORTED_FILE_TYPE' });
  assert.equal(pdf.status, 200); assert.equal(pdf.body.state, 'UNSUPPORTED_FILE_TYPE');
  assert.equal(backendCalls, 0);
  assert.equal((await storedPayload(7100000000005)).system2Estimate, undefined, 'System 1 stays the result');
  pass('no self-submitted estimates: client copies dropped, another document refused, unsupported files stay on System 1');
}
{
  assert.equal(await postReport(admin, 7100000000010, 35), 200, 'admin unrestricted (room 36)');
  const s2 = await system2(admin, 7100000000010);
  assert.equal(s2.status, 200); assert.equal(s2.body.persisted, true, 'administrators keep System 2');
  process.env.VERCEL_ENV = 'production';
  assert.equal(await access(admin, 35), 'OFF', 'production without S2_PRODUCTION_ENABLED: off for everyone');
  assert.equal((await system2(subscriber2, 7100000000005)).status, 404, 'production: route 404');
  process.env.S2_PRODUCTION_ENABLED = '1';
  assert.equal(await access(subscriber2, 0), 'SUBSCRIBER', 'production with its own switch: the same rules');
  delete process.env.S2_PRODUCTION_ENABLED;
  process.env.VERCEL_ENV = 'preview';
  delete process.env.S2_SUBSCRIBERS_ENABLED;
  assert.equal(await access(subscriber, 0), 'SUBSCRIBERS_OFF', 'without S2_SUBSCRIBERS_ENABLED: administrators only');
  assert.equal(await access(admin, 0), 'ADMIN');
  process.env.S2_SUBSCRIBERS_ENABLED = '1';
  pass('administrators keep System 2; production stays off until S2_PRODUCTION_ENABLED; subscribers need S2_SUBSCRIBERS_ENABLED');
}

db.close();
backend.close();
console.log(`\n${results.length} integration scenarios passed`);
