import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as system2Route from '../app/api/reports/[id]/system2/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { isSystem2ResearchUser } from '../lib/system2-research.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

// INTEGRATION (feature/subscriptions-system2-integration-20261029): manual subscriptions + report history retention +
// the owner-only System 2. A paying subscriber gets exactly their purchased rooms and the normal single check — and
// NEVER System 2: its route answers 404 to every account except the allowlisted owner, and never in production.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_integration_subscription_system2.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;
const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));

// The Preview configuration: subscriptions enforced, retention on, System 2 on for the owner only.
process.env.ACCOUNT_ACTIVATION_ENFORCED = '1';
process.env.REPORT_HISTORY_RETENTION_ENABLED = '1';
process.env.S2_RESEARCH_ENABLED = '1';
process.env.S2_RESEARCH_OWNER_EMAILS = 'owner@example.com';
process.env.S2_INFERENCE_URL = 'https://s2.invalid/api/analyze';
process.env.S2_INFERENCE_KEY = 'k'.repeat(40);
process.env.VERCEL_ENV = 'preview';

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
async function postReport(u, id, room) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = new Date().toISOString();
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${u.cookie}` },
    body: JSON.stringify({ deviceKey: u.deviceKey, id: String(id), submissionId: String(id).slice(-10), title: `r-${id}.docx`, createdAt: created, wordCount: 400, archiveScore: 6, scoreBand: 'Low', aiScore: 10, aiTone: 'low', room,
      payload: { version: 11, id: String(id), submissionId: String(id).slice(-10), title: `r-${id}.docx`, created, score: 6, wordCount: 400, text: `integration manuscript ${id}` } }),
  }));
  return res.status;
}
async function system2(u, reportId) {
  const res = await system2Route.POST(new Request(`http://localhost/api/reports/${reportId}/system2`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip('s2'), host: 'localhost', origin: 'http://localhost', 'x-s2-consent': 'granted', 'content-type': 'application/octet-stream', 'x-file-extension': '.docx', ...(u ? { cookie: `tp_session_v1=${u.cookie}` } : {}) },
    body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  }), { params: Promise.resolve({ id: String(reportId) }) });
  return res.status;
}

const owner = await signup('owner@example.com');
await grantTestAdmin(dbFile, owner.email);
const subscriber = await signup('subscriber@example.com');
const unsubscribed = await signup('unsubscribed@example.com');

async function grant(body) {
  const call = async (b) => {
    const addr = ip('admin');
    await resetAdminRateForTest(addr);
    const res = await applyRoute.POST(new Request('http://localhost/api/admin/account-activation/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, host: 'localhost', origin: 'http://localhost', cookie: `tp_session_v1=${owner.cookie}` }, body: JSON.stringify(b) }));
    return { status: res.status, body: await res.json() };
  };
  const p = await call({ ...body, dryRun: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await call({ ...body, dryRun: false, operationId: crypto.randomUUID(), expectedVersion: p.body.preview.expectedVersion, expectedUserId: p.body.preview.expectedUserId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
}
await grant({ email: subscriber.email, action: 'activate', planDays: 30, rooms: 2 });

const results = [];
const pass = (name) => { results.push(name); console.log(`ok - ${name}`); };

{
  assert.equal(isSystem2ResearchUser(owner), true, 'the allowlisted owner');
  assert.equal(isSystem2ResearchUser(subscriber), false, 'never a paying subscriber');
  assert.equal(isSystem2ResearchUser(unsubscribed), false);
  pass('System 2 is enabled for the allowlisted owner only — never for paying or unsubscribed customers');
}
{
  assert.equal(await postReport(subscriber, 7100000000001, 0), 200, 'the subscriber checks a document in a purchased room');
  assert.equal(await postReport(subscriber, 7100000000002, 2), 403, 'never beyond the purchased rooms');
  assert.equal(await system2(subscriber, 7100000000001), 404, "the subscriber's own report: System 2 route is 404");
  assert.equal(await postReport(unsubscribed, 7100000000003, 0), 403, 'no subscription: no check');
  assert.equal(await system2(null, 7100000000001), 404, 'signed out: 404');
  assert.equal(await system2(owner, 7100000000001), 404, "even the owner cannot run System 2 on a customer's report");
  pass('subscribers check documents in their rooms only, and System 2 stays closed to them (404), signed out, and on other accounts’ reports');
}
{
  assert.equal(await postReport(owner, 7100000000010, 35), 200, 'admin unrestricted (room 36)');
  process.env.VERCEL_ENV = 'production';
  assert.equal(isSystem2ResearchUser(owner), false, 'production: off even for the owner');
  assert.equal(await system2(owner, 7100000000010), 404, 'production: route 404');
  process.env.VERCEL_ENV = 'preview';
  pass('admin unrestricted; System 2 always off in production, even for the owner');
}

db.close();
console.log(`\n${results.length} integration scenarios passed`);
