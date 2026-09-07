import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as sweepRoute from '../app/api/internal/corpus-admission-sweep/route.ts';
import { resetAuthRateForTest } from '../lib/rate-limit.js';
import { createPendingReportAdmissionJob } from '../lib/corpus-admission-report-integration.ts';

/**
 * AUTHORIZATION coverage for the protected scheduled/internal sweep
 * trigger (app/api/internal/corpus-admission-sweep/route.ts) — the caller
 * for lib/corpus-admission-report-integration.ts's runReportAdmissionRetrySweep
 * that was deliberately left unbuilt until now. GET is the method Vercel
 * Cron actually issues (see vercel.json's "crons" entry for this path);
 * POST is also supported for any other trusted internal caller. Both
 * methods share the exact same CRON_SECRET-based authorization check, so
 * every AUTHORIZATION scenario below is run against both. Every fixture
 * here is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_corpus_admission_sweep_route.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await setupClient.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(setupClient, drizzleDir);

const REAL_SECRET = 'sweep-route-test-secret-a1b2c3d4e5f6';

const originalSecret = process.env.CRON_SECRET;
const originalFlag = process.env.CORPUS_ADMISSION_ENABLED;
test.after(() => {
  setupClient.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED;
  else process.env.CORPUS_ADMISSION_ENABLED = originalFlag;
});

let ipCounter = 0;
async function callSweep(method, headers) {
  ipCounter += 1;
  const ip = `sweep-route-test-${ipCounter}`;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/internal/corpus-admission-sweep', {
    method,
    headers: { 'x-forwarded-for': ip, ...headers },
  });
  return method === 'GET' ? sweepRoute.GET(req) : sweepRoute.POST(req);
}

let userCounter = 0;
async function ensureUser() {
  userCounter += 1;
  const accountId = `sweep-route-account-${userCounter}`;
  await setupClient.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)',
    args: [accountId, `${accountId}@example.test`, accountId, 'not-a-real-hash'],
  });
  return accountId;
}

// --- unauthorized requests: always 404, never 401/403 -------------------
// Run against both methods — the authorization check must be identical
// regardless of how the request arrives.

for (const method of ['GET', 'POST']) {
  test(`AUTHORIZATION (${method}): no Authorization header at all -> 404`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    const res = await callSweep(method, {});
    assert.equal(res.status, 404);
  });

  test(`AUTHORIZATION (${method}): a wrong/guessed bearer secret -> 404`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    const res = await callSweep(method, { authorization: 'Bearer totally-wrong-guess' });
    assert.equal(res.status, 404);
  });

  test(`AUTHORIZATION (${method}): a non-Bearer Authorization header -> 404`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    const res = await callSweep(method, { authorization: `Basic ${REAL_SECRET}` });
    assert.equal(res.status, 404);
  });

  test(`AUTHORIZATION (${method}): fails CLOSED when CRON_SECRET is unset — a correctly-guessed-looking header is still rejected`, async () => {
    delete process.env.CRON_SECRET;
    const res = await callSweep(method, { authorization: 'Bearer anything-at-all' });
    assert.equal(res.status, 404, 'an unconfigured secret must never mean "open to anyone"');
  });

  test(`AUTHORIZATION (${method}): the correct secret is accepted, and the endpoint reports enabled:false without doing any work while the feature flag is off`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    delete process.env.CORPUS_ADMISSION_ENABLED;

    const res = await callSweep(method, { authorization: `Bearer ${REAL_SECRET}` });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: true,
      enabled: false,
      claimedCount: 0,
      retention: { enabled: false, decisionsDeleted: 0, jobsDeleted: 0, skippedProtected: 0, failedPromotionsRetryable: 0 },
    });
  });
}

// --- authorized + enabled: the sweep actually runs, for each method ------

for (const method of ['GET', 'POST']) {
  test(`AUTHORIZATION (${method}): the correct secret triggers a real sweep once the feature flag is on`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    process.env.CORPUS_ADMISSION_ENABLED = 'true';

    const accountId = await ensureUser();
    const deviceKey = `sweep-route-device-${method}`;
    const reportId = `sweep-route-report-${method}`;
    const text = Array.from({ length: 3300 }, (_, i) => `word${i % 50}`).join(' ');
    await setupClient.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, updated_at)
            VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [reportId, deviceKey, `sub-${method}`, 'T', 3300, 10, 'low', JSON.stringify({ text }), accountId],
    });
    const created = await createPendingReportAdmissionJob(setupClient, { accountId, deviceKey, reportId });
    assert.ok(created?.jobId, 'sanity: the job must actually have been created for this test to be meaningful');

    const jobBefore = await setupClient.execute({ sql: 'SELECT status FROM corpus_admission_report_jobs WHERE id = ?', args: [created.jobId] });
    assert.equal(jobBefore.rows[0].status, 'pending');

    const res = await callSweep(method, { authorization: `Bearer ${REAL_SECRET}` });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, true);
    assert.ok(body.claimedCount >= 1, `expected at least the 1 seeded job to be claimed, got ${body.claimedCount}`);

    const jobAfter = await setupClient.execute({ sql: 'SELECT status FROM corpus_admission_report_jobs WHERE id = ?', args: [created.jobId] });
    assert.notEqual(jobAfter.rows[0].status, 'pending', `the sweep triggered through this authorized ${method} request must have actually processed the job`);
  });
}

// --- B1C-adjacent: independent sweep-state persistence (report_admission vs retention) ---

async function sweepRunRow(kind) {
  const result = await setupClient.execute({ sql: 'SELECT last_status, last_summary_json FROM corpus_admission_sweep_runs WHERE sweep_kind = ?', args: [kind] });
  return result.rows[0] ?? null;
}

test('SWEEP-STATE: with only CORPUS_ADMISSION_ENABLED on (retention off), only the report_admission row is written — retention stays absent', async () => {
  const originalRetentionFlag = process.env.CORPUS_RETENTION_ENABLED;
  delete process.env.CORPUS_RETENTION_ENABLED;
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_ADMISSION_ENABLED = 'true';

  const retentionBefore = await sweepRunRow('retention');

  const res = await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retention.enabled, false, 'test setup sanity: retention must genuinely be off for this test');

  const reportAdmissionRow = await sweepRunRow('report_admission');
  assert.ok(reportAdmissionRow, 'REQUIRED: report_admission must record its own row when its own flag is on and it actually ran');
  assert.equal(reportAdmissionRow.last_status, 'success');

  const retentionAfter = await sweepRunRow('retention');
  assert.deepEqual(retentionAfter, retentionBefore, 'REQUIRED: retention being disabled must mean its own row is completely untouched — no fake run, no overwrite');

  if (originalRetentionFlag === undefined) delete process.env.CORPUS_RETENTION_ENABLED;
  else process.env.CORPUS_RETENTION_ENABLED = originalRetentionFlag;
});

test('SWEEP-STATE: with only CORPUS_RETENTION_ENABLED on (admission off), only the retention row is written — report_admission stays untouched by this call', async () => {
  const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
  delete process.env.CORPUS_ADMISSION_ENABLED;
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_RETENTION_ENABLED = 'true';

  const reportAdmissionBefore = await sweepRunRow('report_admission');

  const res = await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, false, 'test setup sanity: admission must genuinely be off for this test');
  assert.equal(body.retention.enabled, true);

  const retentionRow = await sweepRunRow('retention');
  assert.ok(retentionRow, 'REQUIRED: retention must record its own row when its own flag is on and it actually ran');
  assert.equal(retentionRow.last_status, 'success');

  const reportAdmissionAfter = await sweepRunRow('report_admission');
  assert.deepEqual(reportAdmissionAfter, reportAdmissionBefore, 'REQUIRED: this call must never touch report_admission\'s own row while its flag is off');

  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED;
  else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
});

test('SWEEP-STATE: with BOTH flags on, both report_admission and retention record their own independent rows in the same invocation, each as a singleton (never appended)', async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  process.env.CORPUS_RETENTION_ENABLED = 'true';

  const res = await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.retention.enabled, true);

  const reportAdmissionRow = await sweepRunRow('report_admission');
  const retentionRow = await sweepRunRow('retention');
  assert.equal(reportAdmissionRow.last_status, 'success');
  assert.equal(retentionRow.last_status, 'success');

  for (const kind of ['report_admission', 'retention']) {
    const rowCount = await setupClient.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_sweep_runs WHERE sweep_kind = ?', args: [kind] });
    assert.equal(Number(rowCount.rows[0].c), 1, `REQUIRED: '${kind}' must remain a singleton row across every prior call in this file, never appended`);
  }
});

test('PRIVACY: the persisted report_admission sweep-run row never contains the swept job/account/report/device identifiers', async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_ADMISSION_ENABLED = 'true';

  const accountId = await ensureUser();
  const deviceKey = 'privacy-sweep-state-device';
  const reportId = 'privacy-sweep-state-report';
  const text = Array.from({ length: 3300 }, (_, i) => `pw${i % 50}`).join(' ');
  await setupClient.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, 'sub-privacy-sweep-state', 'T', 3300, 10, 'low', JSON.stringify({ text }), accountId],
  });
  const created = await createPendingReportAdmissionJob(setupClient, { accountId, deviceKey, reportId });
  assert.ok(created?.jobId);

  await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });

  const row = await sweepRunRow('report_admission');
  assert.ok(row);
  const serialized = JSON.stringify(row);
  for (const secret of [accountId, deviceKey, reportId, created.jobId]) {
    assert.ok(!serialized.includes(secret), `the persisted sweep-run row must never contain ${secret}`);
  }
});
