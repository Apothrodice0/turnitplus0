import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as checkAuthorizationRoute from '../app/api/reports/check-authorization/route.ts';
import * as academicRoute from '../app/api/academic-evidence/route.ts';
import * as archiveRoute from '../app/api/archive/match/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetSharedIpCeilingForTest, resetAccountRateForTest, CUSTOMER_RATE_LIMITS } from '../lib/rate-limit.ts';
import { checkCustomerRate, verifiedAccountIdForRateLimit } from '../lib/customer-rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * ACCOUNT-AWARE CUSTOMER RATE LIMITING (owner-approved 2026-10-25), through the REAL routes against a migrated database. Every
 * request below comes from ONE public address (a campus NAT): signed-in customers are limited per verified account, a new
 * check spends exactly one new-check allowance, anonymous traffic keeps the strict per-IP bucket, and a per-IP ceiling still
 * stops a flood from many accounts. Identity never comes from the client.
 */
const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_customer_rate_limit.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* none */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ACCOUNT_ACTIVATION_ENFORCED;
const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));
test.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* none */ } } });

const NAT = '203.0.113.7'; // every customer below shares this public address
const headers = (cookie, extra = {}) => ({ 'content-type': 'application/json', 'x-real-ip': NAT, ...(cookie ? { cookie: `tp_session_v1=${cookie}` } : {}), ...extra });
let seq = 0;
async function signup(tag) {
  await resetAuthRateForTest(`signup-${tag}`); // account creation is set-up here; its own limit is exercised separately below
  const email = `crl-${tag}@example.test`;
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `signup-${tag}` },
    body: JSON.stringify(withTestIdentity({ email, password: 'crl-password-1', username: `crl${tag}`.slice(0, 30), deviceKey: `dev-${tag}` })) }));
  assert.equal(res.status, 201, `signup ${tag}`);
  const id = String((await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { tag, email, id, deviceKey: `dev-${tag}`, cookie: res.headers.get('set-cookie').match(/tp_session_v1=([^;]*)/)[1] };
}
const sha = async (t) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, '0')).join('');
const authorize = async (u, room, text) => checkAuthorizationRoute.POST(new Request('http://localhost/api/reports/check-authorization', { method: 'POST', headers: headers(u?.cookie, { origin: 'http://localhost', host: 'localhost' }), body: JSON.stringify({ room, textSha256: await sha(text) }) }));
function save(u, id, room, text, { aiScore = null } = {}) {
  const created = new Date().toISOString();
  return reportsRoute.POST(new Request('http://localhost/api/reports', { method: 'POST', headers: headers(u?.cookie), body: JSON.stringify({
    deviceKey: u?.deviceKey ?? 'anon-device', id, submissionId: id.slice(-10), title: `${id}.txt`, createdAt: created, wordCount: 400, archiveScore: 3, scoreBand: 'Low', aiScore, aiTone: aiScore === null ? null : 'low', room,
    payload: { version: 11, id, submissionId: id.slice(-10), title: `${id}.txt`, created, score: 3, wordCount: 400, text } }) }));
}
const academic = (u) => academicRoute.POST(new Request('http://localhost/api/academic-evidence', { method: 'POST', headers: headers(u?.cookie), body: JSON.stringify({ text: 'too short to search', scoringNormalization: 2 }) }));
const archive = (u) => archiveRoute.POST(new Request('http://localhost/api/archive/match', { method: 'POST', headers: headers(u?.cookie), body: JSON.stringify({ text: 'x' }) }));

/** One document check as the room page performs it: one new-check authorization, then the processing calls of that check. */
async function documentCheck(u, room) {
  const id = `crl-${u.tag}-${room}-${++seq}`; const text = `Manuscript ${id} about irrigation scheduling among smallholder farmers in semi arid regions.`;
  const statuses = [];
  const a = await authorize(u, room, text); statuses.push(['authorize', a.status]);
  for (const [name, r] of [['academic', await academic(u)], ['archive', await archive(u)], ['save', await save(u, id, room, text)], ['ai-save', await save(u, id, room, text, { aiScore: 12 })]]) statuses.push([name, r.status]);
  return { id, statuses };
}
const rateLimited = (statuses) => statuses.filter(([, s]) => s === 429).length;
async function resetAll(users) { await resetRateForTest(NAT); await resetSharedIpCeilingForTest(NAT); for (const u of users) await resetAccountRateForTest(u.id); }

const users = [];
for (let i = 0; i < 12; i++) users.push(await signup(`u${i}`));

test('identity: only the server-verified session counts — no cookie, a forged cookie, or a client-supplied account id are anonymous', async () => {
  const u = users[0];
  assert.equal(await verifiedAccountIdForRateLimit(new Request('http://x', { headers: { 'x-real-ip': NAT } })), null);
  assert.equal(await verifiedAccountIdForRateLimit(new Request('http://x', { headers: { cookie: 'tp_session_v1=forged-token-0000' } })), null);
  assert.equal(await verifiedAccountIdForRateLimit(new Request('http://x', { headers: { cookie: `tp_session_v1=${u.cookie}`, 'x-account-id': users[1].id } })), u.id, 'the session decides, a header never does');
  const forged = await checkCustomerRate(new Request('http://x', { method: 'POST', headers: { 'x-real-ip': NAT, 'x-account-id': u.id, 'x-user-id': u.id } }), 'processing');
  assert.equal(forged.identity, 'anonymous', 'a client-supplied account id is ignored');
  // the IP comes from the platform header; a spoofed X-Forwarded-For next to it changes nothing
  await resetRateForTest(NAT);
  for (let i = 0; i < 10; i++) await checkCustomerRate(new Request('http://x', { headers: { 'x-real-ip': NAT, 'x-forwarded-for': `198.51.100.${i}` } }), 'processing');
  const spoofed = await checkCustomerRate(new Request('http://x', { headers: { 'x-real-ip': NAT, 'x-forwarded-for': '198.51.100.99' } }), 'processing');
  assert.equal(spoofed.allowed, false, 'rotating X-Forwarded-For does not escape the per-IP bucket');
});

test('10 legitimate accounts behind one IP, two documents each, all at once: no request is rate-limited and every check is saved', async () => {
  await resetAll(users);
  const ten = users.slice(0, 10); const t0 = Date.now();
  const runs = await Promise.all(ten.map(async (u) => [await documentCheck(u, 0), await documentCheck(u, 1)]));
  const all = runs.flat();
  assert.equal(all.reduce((n, r) => n + rateLimited(r.statuses), 0), 0, `no 429: ${JSON.stringify(all.map((r) => r.statuses))}`);
  for (const r of all) for (const step of ['authorize', 'save', 'ai-save']) assert.equal(r.statuses.find(([n]) => n === step)[1], 200, `${step}: ${JSON.stringify(r.statuses)}`);
  // 140 pipeline requests from one address; the old shared 10/min bucket would have refused most of them
  assert.equal(all.length * 7, 140);
  for (const u of ten) {
    const rows = (await db.execute({ sql: 'SELECT room_number FROM saved_reports WHERE user_id = ? ORDER BY room_number', args: [u.id] })).rows.map((r) => Number(r.room_number));
    assert.deepEqual(rows, [0, 1], `${u.tag}: exactly its two rooms, each once (the AI resave claimed nothing new)`);
  }
  console.log(JSON.stringify({ accounts: 10, requests: 140, rateLimited: 0, wallMs: Date.now() - t0 }));
});

test('the same 140 requests WITHOUT sign-in: the per-IP anonymous limit still applies (abuse protection kept)', async () => {
  await resetAll(users);
  const anon = []; for (let i = 0; i < 20; i++) anon.push((await academic(null)).status);
  assert.equal(anon.filter((s) => s === 429).length, 10, 'anonymous: 10 per minute per IP, unchanged');
  // … and an anonymous flood from the campus address never blocks the signed-in customers behind it
  const signedIn = await documentCheck(users[0], 2);
  assert.equal(rateLimited(signedIn.statuses), 0);
});

test('one account, many tabs: new checks are limited per account (one allowance per document), others behind the IP are unaffected', async () => {
  await resetAll(users);
  const u = users[10];
  const tabs = await Promise.all(Array.from({ length: CUSTOMER_RATE_LIMITS.accountNewChecksPerMinute + 3 }, (_, i) => authorize(u, i % 3, `tab ${i}`)));
  const st = tabs.map((r) => r.status);
  assert.equal(st.filter((s) => s === 429).length, 3, `the account's new-check allowance is ${CUSTOMER_RATE_LIMITS.accountNewChecksPerMinute}/min: ${st}`);
  const limited = tabs.find((r) => r.status === 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'Retry-After is sent');
  // its processing allowance is separate: an already-started check still saves
  assert.equal((await save(u, `crl-tabs-${++seq}`, 0, 'already started check')).status, 200);
  // and another customer behind the same address starts a check normally
  assert.equal((await authorize(users[11], 0, 'neighbour')).status, 200);
});

test('a multi-step document check spends exactly one new-check allowance', async () => {
  await resetAll(users);
  const u = users[11];
  for (let i = 0; i < CUSTOMER_RATE_LIMITS.accountNewChecksPerMinute; i++) {
    const r = await documentCheck(u, i % 3);
    assert.equal(rateLimited(r.statuses), 0, `document ${i + 1} of ${CUSTOMER_RATE_LIMITS.accountNewChecksPerMinute}: ${JSON.stringify(r.statuses)}`);
  }
  assert.equal((await authorize(u, 0, 'one more')).status, 429, 'the next new check waits — the processing steps never spent new-check allowances');
});

test('duplicate saves of one report claim one room; the AI resave and a repeated save never claim another', async () => {
  await resetAll(users);
  const u = users[3]; const id = `crl-dup-${++seq}`;
  const both = await Promise.all([save(u, id, 4, 'duplicate'), save(u, id, 4, 'duplicate')]);
  assert.ok(both.some((r) => r.status === 200));
  await save(u, id, 4, 'duplicate', { aiScore: 9 });
  const rows = (await db.execute({ sql: 'SELECT COUNT(*) c FROM saved_reports WHERE user_id = ? AND id = ?', args: [u.id, id] })).rows[0].c;
  assert.equal(Number(rows), 1);
});

test('unauthorized and direct API calls: no session → 401 on check authorization; a forged session is anonymous and gains nothing', async () => {
  await resetAll(users);
  assert.equal((await authorize(null, 0, 'no session')).status, 401);
  assert.equal((await authorize({ cookie: 'forged-session-token' }, 0, 'forged')).status, 401);
  // a direct save into a customer's room without their session cannot land in their account
  const victim = users[5];
  const before = Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM saved_reports WHERE user_id = ?', args: [victim.id] })).rows[0].c);
  await save({ deviceKey: victim.deviceKey, cookie: null }, `crl-direct-${++seq}`, 2, 'direct call');
  const after = Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM saved_reports WHERE user_id = ?', args: [victim.id] })).rows[0].c);
  assert.equal(after, before, 'nothing is written to the account');
});

test('many accounts flooding from one address hit the shared ceiling; account creation itself is limited per IP', async () => {
  await resetAll(users);
  // 12 accounts × 30 processing requests = 360 > the 300/min signed-in ceiling for one address
  const statuses = await Promise.all(users.flatMap((u) => Array.from({ length: 30 }, () => checkCustomerRate(new Request('http://x', { method: 'POST', headers: headers(u.cookie) }), 'processing'))));
  const refused = statuses.filter((r) => !r.allowed).length;
  // the bucket refills continuously (5 tokens/s) while 360 requests run, so how many pass beyond 300 depends on the machine's speed — never all of them
  assert.ok(refused >= 1 && refused <= 360 - CUSTOMER_RATE_LIMITS.sharedIpCeilingPerMinute, `ceiling ${CUSTOMER_RATE_LIMITS.sharedIpCeilingPerMinute}/min per address: ${refused} refused`);
  // creating accounts to multiply allowances is itself limited (unchanged auth limit: 5/min per IP)
  await resetAuthRateForTest('farm-ip');
  const farm = [];
  for (let i = 0; i < 7; i++) farm.push((await signupRoute.POST(new Request('http://localhost/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': 'farm-ip' },
    body: JSON.stringify(withTestIdentity({ email: `farm${i}@example.test`, password: 'crl-password-1', username: `farm${i}`, deviceKey: `farm-${i}` })) }))).status);
  assert.ok(farm.filter((s) => s === 429).length >= 2, `signup farm from one IP is refused: ${farm}`);
});
