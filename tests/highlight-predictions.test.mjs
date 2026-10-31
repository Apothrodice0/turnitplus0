import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportByIdRoute from '../app/api/reports/[id]/route.ts';
import * as applyRoute from '../app/api/admin/account-activation/apply/route.ts';
import * as sweepRoute from '../app/api/internal/highlight-prediction-sweep/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest, resetAdminRateForTest } from '../lib/rate-limit.js';
import { cleanupExpiredSubscriptionReports } from '../lib/subscription-expiry-cleanup.ts';
import { processHighlightPrediction, resetHighlightPredictionTableCacheForTest, runHighlightPredictionSweep, highlightPredictionTextHash } from '../lib/highlight-predictions.ts';
import { highlightModelConfig } from '../lib/highlight-model.ts';
import { deleteAllReportDataForAccount, deleteAccountData } from '../lib/account-deletion.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

// HIGHLIGHT PREDICTIONS for paying customers (lib/highlight-predictions.ts), through the real routes against a real
// migrated database with a stand-in model service: one automatic run per report, a stored result on every later view,
// the verified report untouched by any failure, and rows that follow the report's own permissions and deletion rules.

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_highlight_predictions.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;
delete process.env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
process.env.ACCOUNT_ACTIVATION_ENFORCED = '1';
process.env.REPORT_HISTORY_RETENTION_ENABLED = '1';
process.env.SUBSCRIPTION_EXPIRY_CLEANUP = 'on';
process.env.CRON_SECRET = 'highlight-sweep-test-secret';
const MODEL = 'v1-test-t0775-m4';
process.env.HIGHLIGHT_MODEL_ENABLED = '1';
process.env.HIGHLIGHT_MODEL_URL = 'http://model.test/predict';
process.env.HIGHLIGHT_MODEL_KEY = 'k'.repeat(40);
process.env.HIGHLIGHT_MODEL_VERSION = MODEL;
process.env.HIGHLIGHT_MODEL_SUBSCRIBERS_ENABLED = '1';

const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));

// The stand-in service: counts calls, answers as told. Anything else goes to the real fetch.
const realFetch = globalThis.fetch;
let modelCalls = 0;
let modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 12 }], modelVersion: MODEL, words: 3 }), { status: 200 });
let lastAuth = null;
globalThis.fetch = async (url, init) => {
  if (String(url) !== process.env.HIGHLIGHT_MODEL_URL) return realFetch(url, init);
  modelCalls += 1;
  lastAuth = init.headers.Authorization;
  return modelAnswer(JSON.parse(init.body).text);
};
const quietly = async (work) => { const error = console.error; console.error = () => {}; try { return await work(); } finally { console.error = error; } };

let n = 0;
const ip = (tag) => `hp-${tag}-${++n}`;
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
let seq = 7400000000000;
const manuscript = (tag) => `Groundwater recharge accounting in semi-arid basins ${tag}. The second sentence of this manuscript discusses seasonal storage across catchments.`;
async function postReport(user, { room = 0, id = String(++seq), text = manuscript(id), language = 'English', aiStatus, aiScore = 12 } = {}) {
  const addr = ip('post');
  await resetRateForTest(addr);
  const created = new Date().toISOString();
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` },
    body: JSON.stringify({
      deviceKey: user.deviceKey, id, submissionId: id.slice(-10), title: `report-${id}.docx`, createdAt: created,
      wordCount: 20, archiveScore: 7, scoreBand: 'Low', aiScore, aiTone: 'low', aiStatus, room,
      payload: { version: 11, id, submissionId: id.slice(-10), title: `report-${id}.docx`, created, score: 7, wordCount: 20, text, features: { detectedLanguage: language } },
    }),
  }));
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null, id };
}
async function getReport(user, id) {
  const addr = ip('get');
  await resetReadRateForTest(addr);
  await resetRateForTest(addr);
  const res = await reportByIdRoute.GET(new Request(`http://localhost/api/reports/${id}`, { headers: { 'x-forwarded-for': addr, cookie: `tp_session_v1=${user.cookie}` } }), { params: Promise.resolve({ id: String(id) }) });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json?.payload ?? json };
}
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
const rowOf = async (id) => (await db.execute({ sql: 'SELECT * FROM report_highlight_predictions WHERE report_id = ?', args: [id] })).rows[0];
const count = async (sql, ...args) => Number((await db.execute({ sql, args })).rows[0].c);
const predictionRows = (u) => count('SELECT COUNT(*) AS c FROM report_highlight_predictions WHERE account_id = ?', u.id);
const key = (u, id) => ({ deviceKey: u.deviceKey, reportId: id });
const makeDue = (id) => db.execute({ sql: 'UPDATE report_highlight_predictions SET next_attempt_at = ? WHERE report_id = ?', args: [Date.now() - 1, id] });

const results = [];
const pass = (name) => { results.push(name); console.log(`ok - ${name}`); };

const admin = await signup('hp-admin@example.com');
await grantTestAdmin(dbFile, admin.email);
const subscriber = async (email, rooms = 4) => { const u = await signup(email); await grant(admin.cookie, { email, action: 'activate', planDays: 30, rooms }); return u; };

// ── P1. One upload: one automatic run; every later view reads the stored result ────────────────────────────────────
{
  const u = await subscriber('p1@example.com');
  modelCalls = 0;
  const r = await postReport(u);
  assert.equal(r.status, 200);
  assert.equal(modelCalls, 1, 'the save ran the model once, with nothing else asked of the customer');
  assert.equal(lastAuth, `Bearer ${process.env.HIGHLIGHT_MODEL_KEY}`);
  const row = await rowOf(r.id);
  assert.equal(row.status, 'complete');
  assert.equal(row.model_version, MODEL);
  assert.equal(row.text_sha256, highlightPredictionTextHash(manuscript(r.id)));
  for (let i = 0; i < 4; i += 1) {
    const read = await getReport(u, r.id);
    assert.deepEqual(read.body.predictedHighlights, [{ start: 0, end: 12 }]);
    assert.equal(read.body.predictedHighlightsPending, undefined);
  }
  assert.equal((await postReport(u, { id: r.id, aiScore: 33 })).status, 200, 'the AI result arrives as a resave');
  assert.equal(modelCalls, 1, 'reopening and resaving never run the model again');
  const stored = (await db.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE id = ?', args: [r.id] })).rows[0].payload_json;
  assert.equal(stored.includes('predictedHighlights'), false, 'nothing is added to the saved report');
  const withPrediction = (await getReport(u, r.id)).body;
  process.env.HIGHLIGHT_MODEL_ENABLED = '';
  const without = (await getReport(u, r.id)).body;
  process.env.HIGHLIGHT_MODEL_ENABLED = '1';
  const { predictedHighlights: added, ...rest } = withPrediction;
  assert.ok(added);
  assert.deepEqual(rest, without, 'with the prediction the report is otherwise identical, field for field');
  pass('P1 one automatic run per report; reopening and resaving read the stored result; the saved report and its figures are untouched');
}

// ── P2. Who and what gets a prediction ──────────────────────────────────────────────────────────────────────────────
{
  const u = await subscriber('p2@example.com');
  modelCalls = 0;
  const french = await postReport(u, { room: 0, language: 'French' });
  assert.equal(french.status, 200);
  assert.equal(await rowOf(french.id), undefined, 'the model reads English only');
  const long = await postReport(u, { room: 1, text: 'word '.repeat(60_100) });
  assert.equal(long.status, 200);
  assert.equal(await rowOf(long.id), undefined, 'over the word limit the verified report stands alone');
  process.env.HIGHLIGHT_MODEL_SUBSCRIBERS_ENABLED = '';
  const off = await postReport(u, { room: 2 });
  assert.equal(off.status, 200);
  assert.equal(await rowOf(off.id), undefined, 'subscribers are switched on separately');
  const adminReport = await postReport(admin, { room: 30 });
  assert.equal((await rowOf(adminReport.id)).status, 'complete', 'an administrator still gets one');
  process.env.HIGHLIGHT_MODEL_SUBSCRIBERS_ENABLED = '1';
  assert.equal(modelCalls, 1);
  assert.equal(highlightModelConfig({ ...process.env, VERCEL_ENV: 'production' }).enabled, false, 'never on a production deployment by default');
  assert.equal(highlightModelConfig({ ...process.env, VERCEL_ENV: 'production', HIGHLIGHT_MODEL_PRODUCTION_ENABLED: '1' }).enabled, true);
  pass('P2 English only, a word limit, subscribers behind their own switch, and off on Production unless explicitly enabled');
}

// ── P3. The service fails: the verified report is unaffected and the prediction retries with backoff ───────────────
{
  const u = await subscriber('p3@example.com');
  modelAnswer = () => new Response('down', { status: 503 });
  modelCalls = 0;
  const r = await quietly(() => postReport(u));
  assert.equal(r.status, 200, 'the save never depends on the model');
  assert.equal(modelCalls, 1);
  assert.equal((await rowOf(r.id)).status, 'pending');
  const waiting = await getReport(u, r.id);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.predictedHighlights, undefined);
  assert.equal(waiting.body.predictedHighlightsPending, true, 'the page knows to check again');
  assert.equal(modelCalls, 1, 'a read inside the backoff does not call the model');
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 3, end: 9 }], modelVersion: MODEL }), { status: 200 });
  await makeDue(r.id);
  await getReport(u, r.id);
  assert.equal(modelCalls, 2, 'a read after the backoff lets it run, after the response');
  assert.deepEqual((await getReport(u, r.id)).body.predictedHighlights, [{ start: 3, end: 9 }]);
  assert.equal(modelCalls, 2);
  pass('P3 a service failure leaves the report usable; a read inside the backoff waits; a due read retries once and the result is kept');
}

// ── P4. Failures that cannot heal stop, and retries are bounded ─────────────────────────────────────────────────────
{
  const u = await subscriber('p4@example.com');
  modelAnswer = () => new Response('', { status: 404 });
  modelCalls = 0;
  const r = await quietly(() => postReport(u, { room: 0 }));
  assert.equal((await rowOf(r.id)).status, 'failed', 'a 404 is not retried');
  await makeDue(r.id);
  await getReport(u, r.id);
  assert.equal(modelCalls, 1);
  const tooLarge = await (async () => { modelAnswer = () => new Response('', { status: 413 }); return quietly(() => postReport(u, { room: 1 })); })();
  assert.equal((await rowOf(tooLarge.id)).status, 'failed', 'a 413 is not retried');
  modelAnswer = () => new Response(JSON.stringify({ ranges: [], modelVersion: 'another-model' }), { status: 200 });
  const other = await quietly(() => postReport(u, { room: 2 }));
  assert.equal((await rowOf(other.id)).status, 'failed', 'a result from another model is never stored');
  assert.equal((await rowOf(other.id)).ranges_json, null);
  modelAnswer = () => new Response('', { status: 500 });
  modelCalls = 0;
  const flaky = await quietly(() => postReport(u, { room: 3 }));
  for (let i = 0; i < 10; i += 1) { await makeDue(flaky.id); await quietly(() => processHighlightPrediction(key(u, flaky.id))); }
  assert.equal(modelCalls, 5, 'five attempts in all');
  assert.equal((await rowOf(flaky.id)).status, 'failed');
  assert.equal((await getReport(u, flaky.id)).body.predictedHighlightsPending, undefined, 'a finished failure stops the page checking');
  pass('P4 404, 413 and a wrong model version stop at once; server errors stop after five attempts');
}

// ── P5. Concurrency: one worker per report, and a lost worker cannot overwrite a newer result ──────────────────────
{
  const u = await subscriber('p5@example.com');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  modelAnswer = () => new Response('', { status: 503 });
  const r = await quietly(() => postReport(u, { room: 0 }));
  await makeDue(r.id);
  modelCalls = 0;
  modelAnswer = async () => { await gate; return new Response(JSON.stringify({ ranges: [{ start: 1, end: 2 }] }), { status: 200 }); };
  const conns = [0, 1, 2, 3].map(() => createClient({ url: `file:${dbFile}` }));
  const running = conns.map((c) => processHighlightPrediction(key(u, r.id), { openClient: async () => createClient({ url: `file:${dbFile}` }) }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await Promise.all(running);
  conns.forEach((c) => c.close());
  assert.equal(modelCalls, 1, 'four triggers at once, one model call');
  assert.equal((await rowOf(r.id)).status, 'complete');

  // A worker past its lease: another takes over, and the first one's late answer is ignored.
  modelAnswer = () => new Response('', { status: 503 });
  const r2 = await quietly(() => postReport(u, { room: 1 }));
  await makeDue(r2.id);
  let lateRelease;
  const lateGate = new Promise((resolve) => { lateRelease = resolve; });
  modelAnswer = async () => { await lateGate; return new Response(JSON.stringify({ ranges: [{ start: 0, end: 1 }] }), { status: 200 }); };
  const slow = processHighlightPrediction(key(u, r2.id));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await db.execute({ sql: 'UPDATE report_highlight_predictions SET lease_until = ? WHERE report_id = ?', args: [Date.now() - 1, r2.id] });
  const answerNow = modelAnswer;
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 5, end: 7 }] }), { status: 200 });
  await processHighlightPrediction(key(u, r2.id));
  modelAnswer = answerNow;
  lateRelease();
  await slow;
  assert.equal((await rowOf(r2.id)).ranges_json, JSON.stringify([{ start: 5, end: 7 }]), 'the newer result stands');
  pass('P5 concurrent triggers collapse to one model call; a worker past its lease cannot overwrite the result');
}

// ── P6. Isolation: reuse stays inside one account ───────────────────────────────────────────────────────────────────
{
  const a = await subscriber('p6a@example.com');
  const b = await subscriber('p6b@example.com');
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 5 }], modelVersion: MODEL }), { status: 200 });
  const shared = manuscript('same document');
  modelCalls = 0;
  const first = await postReport(a, { room: 0, text: shared });
  assert.equal(modelCalls, 1);
  const again = await postReport(a, { room: 1, text: shared });
  assert.equal(modelCalls, 1, 'the same text again in the same account reuses the result');
  assert.deepEqual((await getReport(a, again.id)).body.predictedHighlights, [{ start: 0, end: 5 }]);
  const other = await postReport(b, { room: 0, text: shared });
  assert.equal(modelCalls, 2, 'another account never reuses it');
  assert.equal((await getReport(b, first.id)).status, 404, "another customer's report stays out of reach");
  assert.deepEqual((await getReport(b, other.id)).body.predictedHighlights, [{ start: 0, end: 5 }]);
  pass('P6 the same document reuses a result inside an account and never across accounts');
}

// ── P7. Deletion: report, expiry, late results and whole accounts ───────────────────────────────────────────────────
{
  const u = await subscriber('p7@example.com');
  const r1 = await postReport(u, { room: 0 });
  const r2 = await postReport(u, { room: 1 });
  assert.equal(await predictionRows(u), 2);
  const addr = ip('del');
  await resetRateForTest(addr);
  const del = await reportByIdRoute.DELETE(new Request(`http://localhost/api/reports/${r1.id}`, { method: 'DELETE', headers: { 'x-forwarded-for': addr, cookie: `tp_session_v1=${u.cookie}` } }), { params: Promise.resolve({ id: r1.id }) });
  assert.ok(del.status < 300);
  assert.equal(await rowOf(r1.id), undefined, 'deleting a report deletes its prediction');
  assert.equal(await predictionRows(u), 1);

  // Expiry while a prediction is running: the row goes, and the late answer writes nothing back.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  modelAnswer = () => new Response('', { status: 503 });
  const r3 = await quietly(() => postReport(u, { room: 2 }));
  await makeDue(r3.id);
  modelAnswer = async () => { await gate; return new Response(JSON.stringify({ ranges: [{ start: 0, end: 4 }] }), { status: 200 }); };
  const running = processHighlightPrediction(key(u, r3.id));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await db.execute({ sql: 'UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?', args: [Date.now() - 1000, u.id] });
  const cleaned = await cleanupExpiredSubscriptionReports(db, { id: u.id, email: u.email });
  assert.equal(cleaned.ran, true);
  release();
  await running;
  assert.equal(await predictionRows(u), 0, 'expiry cleanup removes every prediction, and the late answer recreates nothing');
  assert.equal(await count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', u.id), 0);
  assert.equal((await getReport(u, r2.id)).status, 403);

  const v = await subscriber('p7b@example.com');
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 4 }] }), { status: 200 });
  await postReport(v, { room: 0 });
  const keep = await postReport(v, { room: 1 });
  await db.execute({ sql: "UPDATE saved_reports SET saved_at = '2026-01-01 00:00:00' WHERE user_id = ? AND id <> ?", args: [v.id, keep.id] });
  await deleteAllReportDataForAccount(db, v.id, { savedAtOrBefore: '2026-06-01 00:00:00' });
  assert.equal(await predictionRows(v), 1, 'a cutoff keeps the prediction of a report that stays');
  assert.equal((await rowOf(keep.id)).status, 'complete');
  await deleteAccountData(db, v.id);
  assert.equal(await predictionRows(v), 0, 'deleting the account removes the rest');
  pass('P7 predictions go with their report: single delete, expiry cleanup, a late result, a cutoff and account deletion');
}

// ── P8. A stored result answers only for its own model and text; the switch hides everything ───────────────────────
{
  const u = await subscriber('p8@example.com');
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 4 }], modelVersion: MODEL }), { status: 200 });
  const r = await postReport(u, { room: 0 });
  process.env.HIGHLIGHT_MODEL_VERSION = 'v2-later';
  assert.equal((await getReport(u, r.id)).body.predictedHighlights, undefined, 'another model version shows nothing');
  process.env.HIGHLIGHT_MODEL_VERSION = MODEL;
  await db.execute({ sql: "UPDATE report_highlight_predictions SET text_sha256 = 'other' WHERE report_id = ?", args: [r.id] });
  assert.equal((await getReport(u, r.id)).body.predictedHighlights, undefined, 'another text shows nothing');
  await db.execute({ sql: 'UPDATE report_highlight_predictions SET text_sha256 = ? WHERE report_id = ?', args: [highlightPredictionTextHash(manuscript(r.id)), r.id] });
  process.env.HIGHLIGHT_MODEL_ENABLED = '';
  assert.equal((await getReport(u, r.id)).body.predictedHighlights, undefined, 'turning the model off hides stored results at once');
  process.env.HIGHLIGHT_MODEL_ENABLED = '1';
  assert.deepEqual((await getReport(u, r.id)).body.predictedHighlights, [{ start: 0, end: 4 }]);
  pass('P8 a result shows only for its own model and text, and the switch hides stored results at once');
}

// ── P9. The sweep finishes what no read will; it is protected like every internal sweep ────────────────────────────
{
  const u = await subscriber('p9@example.com');
  modelAnswer = () => new Response('', { status: 503 });
  const r = await quietly(() => postReport(u, { room: 0 }));
  const exhausted = await quietly(() => postReport(u, { room: 1 }));
  await db.execute({ sql: "UPDATE report_highlight_predictions SET status = 'running', attempts = 5, lease_until = ? WHERE report_id = ?", args: [Date.now() - 1, exhausted.id] });
  await makeDue(r.id);
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 6 }] }), { status: 200 });
  const call = (headers) => sweepRoute.GET(new Request('http://localhost/api/internal/highlight-prediction-sweep', { headers: { 'x-forwarded-for': ip('sweep'), ...headers } }));
  assert.equal((await call({})).status, 404, 'no secret: nothing is there');
  assert.equal((await call({ authorization: 'Bearer wrong-secret-of-the-same-size' })).status, 404);
  const ok = await call({ authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(ok.status, 200);
  assert.equal((await rowOf(r.id)).status, 'complete');
  assert.equal((await rowOf(exhausted.id)).status, 'failed', 'a job that died on its last attempt is closed');
  assert.deepEqual(await runHighlightPredictionSweep(db), { due: 0 });
  pass('P9 the sweep finishes due predictions, closes exhausted ones, and is protected by CRON_SECRET');
}

// ── P11. A worker stopped mid-call (function time limit) never leaves a report waiting forever, even with no sweep ──
{
  const u = await subscriber('p11@example.com');
  modelAnswer = () => new Response('', { status: 503 });
  const last = await quietly(() => postReport(u, { room: 0 }));
  const earlier = await quietly(() => postReport(u, { room: 1 }));
  const stop = (id, attempts) => db.execute({ sql: "UPDATE report_highlight_predictions SET status = 'running', attempts = ?, lease_until = ? WHERE report_id = ?", args: [attempts, Date.now() - 1, id] });
  await stop(last.id, 5);
  await stop(earlier.id, 2);
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 6 }] }), { status: 200 });
  modelCalls = 0;
  const lastView = await getReport(u, last.id);
  assert.equal(lastView.body.predictedHighlightsPending, undefined, 'a stopped last attempt is finished, not pending');
  assert.equal(lastView.body.predictedHighlights, undefined);
  assert.equal(modelCalls, 0, 'and it is never called again');
  const earlierView = await getReport(u, earlier.id);
  assert.equal(earlierView.body.predictedHighlightsPending, true, 'a stopped earlier attempt is retried on open');
  assert.equal(modelCalls, 1);
  assert.equal((await rowOf(earlier.id)).status, 'complete');
  assert.equal(Number((await rowOf(earlier.id)).attempts), 3);
  pass('P11 a stopped last attempt reads as finished; a stopped earlier attempt is retried once on open');
}

// ── P12. The daily word ceiling stops calls at once; a deferred prediction keeps its attempts and runs the next day ──
{
  const u = await subscriber('p12@example.com');
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = async () => Number((await db.execute({ sql: 'SELECT COALESCE(SUM(words), 0) AS w FROM highlight_model_usage_daily WHERE day = ?', args: [today] })).rows[0].w);
  const before = await usedToday();
  assert.ok(before > 0, 'earlier calls today were counted');
  process.env.HIGHLIGHT_MODEL_DAILY_WORD_LIMIT = String(before + 25);
  modelAnswer = () => new Response(JSON.stringify({ ranges: [{ start: 0, end: 6 }], modelVersion: MODEL }), { status: 200 });
  modelCalls = 0;
  const fits = await postReport(u, { room: 0 });
  const over = await quietly(() => postReport(u, { room: 1 }));
  assert.equal(modelCalls, 1, 'the call that would pass the ceiling is never made');
  assert.equal((await rowOf(fits.id)).status, 'complete');
  const waiting = await rowOf(over.id);
  assert.equal(waiting.status, 'pending');
  assert.equal(Number(waiting.attempts), 0, 'waiting for the ceiling uses up no attempt');
  assert.ok(Number(waiting.next_attempt_at) > Date.now() + 60_000, 'it waits for the next UTC day');
  assert.ok((await usedToday()) <= before + 25);
  const view = await quietly(() => getReport(u, over.id));
  assert.equal(view.body.predictedHighlightsPending, true);
  assert.equal(modelCalls, 1, 'a read on the same day does not call');
  await db.execute({ sql: 'DELETE FROM highlight_model_usage_daily WHERE day = ?', args: [today] }); // a new day
  await makeDue(over.id);
  await getReport(u, over.id);
  assert.equal(modelCalls, 2, 'the next day it runs');
  assert.equal((await rowOf(over.id)).status, 'complete');
  delete process.env.HIGHLIGHT_MODEL_DAILY_WORD_LIMIT;
  pass('P12 the daily word ceiling stops calls at once; a deferred prediction keeps its attempts and runs the next day');
}

// ── P10. A database without the table behaves exactly as before ─────────────────────────────────────────────────────
{
  const u = await subscriber('p10@example.com');
  await db.execute('ALTER TABLE report_highlight_predictions RENAME TO report_highlight_predictions_hidden');
  resetHighlightPredictionTableCacheForTest();
  modelCalls = 0;
  const r = await postReport(u);
  assert.equal(r.status, 200, 'saving works');
  assert.equal(modelCalls, 0);
  assert.equal((await getReport(u, r.id)).status, 200, 'reading works');
  await deleteAllReportDataForAccount(db, u.id);
  await db.execute('ALTER TABLE report_highlight_predictions_hidden RENAME TO report_highlight_predictions');
  resetHighlightPredictionTableCacheForTest();
  pass('P10 before the migration is applied, saving, reading and deleting work as they did');
}

globalThis.fetch = realFetch;
db.close();
for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* still open */ }
console.log(`\n${results.length} highlight prediction scenarios passed`);
process.exit(0); // the native database driver can crash during normal teardown, after everything above has passed
