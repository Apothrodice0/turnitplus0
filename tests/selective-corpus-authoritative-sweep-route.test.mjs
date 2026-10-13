import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as sweepRoute from '../app/api/internal/selective-corpus-authoritative-sweep/route.ts';
import { resetAuthRateForTest } from '../lib/rate-limit.js';

/**
 * FAILURE-PATH coverage for the Selective Corpus authoritative recovery
 * sweep route (app/api/internal/selective-corpus-authoritative-sweep/route.ts).
 *
 * Production returned an isolated HTTP 500 from this route six times
 * (three on each of two deployments) with no log line at all, so the failing
 * step could not be identified. Every failure this route can answer with a
 * 500 happens BEFORE any claimed report is finalized (rate-limit check,
 * opening the database, the atomic claim). These tests inject a fault at
 * each of those three steps and prove:
 *   - the 500 now names its stage in exactly one structured error line;
 *   - a failed sweep leaves a pending report completely untouched;
 *   - the next sweep claims that report exactly once, and the one after it
 *     claims nothing (no duplicate processing).
 * Every fixture here is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_selective_corpus_authoritative_sweep_route.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
const GOOD_URL = `file:${dbFile}`;
const BAD_URL = `file:${path.join(repo, 'test_selective_sweep_missing_directory', 'unreachable.db')}`;
process.env.TURSO_DATABASE_URL = GOOD_URL;

const setupClient = createClient({ url: GOOD_URL });
await setupClient.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(setupClient, drizzleDir);

const REAL_SECRET = 'selective-sweep-route-test-secret-9f8e7d6c';
const originalSecret = process.env.CRON_SECRET;
const originalRateUrl = process.env.RATE_LIMIT_TEST_DB_URL;
process.env.CRON_SECRET = REAL_SECRET;

test.after(() => {
  setupClient.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
  delete process.env.TURSO_DATABASE_URL;
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalRateUrl === undefined) delete process.env.RATE_LIMIT_TEST_DB_URL;
  else process.env.RATE_LIMIT_TEST_DB_URL = originalRateUrl;
});

/** Runs fn with console.error / console.log captured, restoring both. */
async function capturingConsole(fn) {
  const errors = [];
  const infos = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  console.log = (...args) => { infos.push(args.map(String).join(' ')); };
  try {
    const value = await fn();
    return { value, errors, infos };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

let ipCounter = 0;
async function callSweep({ authorized = true, resetRate = true } = {}) {
  ipCounter += 1;
  const ip = `selective-sweep-route-test-${ipCounter}`;
  if (resetRate) await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/internal/selective-corpus-authoritative-sweep', {
    method: 'GET',
    headers: { 'x-forwarded-for': ip, ...(authorized ? { authorization: `Bearer ${REAL_SECRET}` } : {}) },
  });
  return sweepRoute.GET(req);
}

function failureEvents(errors) {
  return errors
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry && entry.event === 'selective_corpus_authoritative_sweep_failed');
}
function completionEvents(infos) {
  return infos
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry && entry.event === 'selective_corpus_authoritative_sweep');
}

let seq = 0;
async function seedStalePendingReport() {
  seq += 1;
  const id = `sweep-route-report-${seq}`;
  const deviceKey = `sweep-route-device-${seq}`;
  const text = 'Synthetic body text for a stale pending report awaiting the recovery sweep.';
  const payload = JSON.stringify({
    version: 11, id: 1, submissionId: `sub-${id}`, title: 'Sweep route fixture',
    text, wordCount: 12, score: 0, archiveScore: 0, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [],
    selectiveCorpusAuthoritativeStatus: 'pending',
  });
  await setupClient.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, `sub-${id}`, 'Sweep route fixture', new Date(Date.now() - 30 * 60 * 1000).toISOString(), 12, 0, 'Low', payload, null, null],
  });
  return { id, deviceKey };
}
async function payloadJson(report) {
  const row = await setupClient.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [report.deviceKey, report.id] });
  return String(row.rows[0].payload_json);
}

test('a successful sweep with nothing pending answers 200 and logs one completion line with the claimed count and timings', async () => {
  const { value: res, errors, infos } = await capturingConsole(() => callSweep());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, claimedCount: 0, outcomeSummary: {} });
  assert.equal(failureEvents(errors).length, 0);
  const done = completionEvents(infos);
  assert.equal(done.length, 1, 'exactly one completion line per sweep');
  assert.equal(done[0].claimedCount, 0);
  assert.equal(typeof done[0].elapsedMs, 'number');
  assert.equal(typeof done[0].claimMs, 'number');
});

test('an unauthorized request stays a silent 404 (no failure line, no completion line)', async () => {
  const { value: res, errors, infos } = await capturingConsole(() => callSweep({ authorized: false }));
  assert.equal(res.status, 404);
  assert.equal(failureEvents(errors).length, 0);
  assert.equal(completionEvents(infos).length, 0);
});

test('a failure in the rate-limit check answers 500 and names stage "rate-limit"', async () => {
  process.env.RATE_LIMIT_TEST_DB_URL = BAD_URL;
  try {
    const { value: res, errors } = await capturingConsole(() => callSweep({ resetRate: false }));
    assert.equal(res.status, 500);
    const failed = failureEvents(errors);
    assert.equal(failed.length, 1, 'exactly one structured failure line');
    assert.equal(failed[0].stage, 'rate-limit');
    assert.equal(typeof failed[0].elapsedMs, 'number');
    assert.ok(failed[0].message.length > 0);
  } finally {
    if (originalRateUrl === undefined) delete process.env.RATE_LIMIT_TEST_DB_URL;
    else process.env.RATE_LIMIT_TEST_DB_URL = originalRateUrl;
  }
});

test('a failure opening the report database answers 500 and names stage "open-database"', async () => {
  // The rate limiter keeps a reachable database; only the route's own
  // connection is unreachable.
  process.env.RATE_LIMIT_TEST_DB_URL = GOOD_URL;
  process.env.TURSO_DATABASE_URL = BAD_URL;
  try {
    const { value: res, errors } = await capturingConsole(() => callSweep({ resetRate: false }));
    assert.equal(res.status, 500);
    const failed = failureEvents(errors);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stage, 'open-database');
  } finally {
    process.env.TURSO_DATABASE_URL = GOOD_URL;
    if (originalRateUrl === undefined) delete process.env.RATE_LIMIT_TEST_DB_URL;
    else process.env.RATE_LIMIT_TEST_DB_URL = originalRateUrl;
  }
});

test('a failure in the atomic claim answers 500, names stage "claim", leaves the pending report untouched, and the next sweep claims it exactly once', async () => {
  const report = await seedStalePendingReport();
  const before = await payloadJson(report);

  // Fault: the claim's own SELECT cannot run.
  await setupClient.execute('ALTER TABLE saved_reports RENAME TO saved_reports_fault_injected');
  let failedSweep;
  try {
    failedSweep = await capturingConsole(() => callSweep());
  } finally {
    await setupClient.execute('ALTER TABLE saved_reports_fault_injected RENAME TO saved_reports');
  }
  assert.equal(failedSweep.value.status, 500);
  const failed = failureEvents(failedSweep.errors);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stage, 'claim');
  assert.equal(completionEvents(failedSweep.infos).length, 0);

  // Nothing was claimed, nothing was written.
  assert.equal(await payloadJson(report), before, 'a failed sweep must leave the pending report byte-identical');

  // The next sweep recovers it exactly once ...
  const next = await capturingConsole(() => callSweep());
  assert.equal(next.value.status, 200);
  const nextBody = await next.value.json();
  assert.equal(nextBody.claimedCount, 1, 'the report skipped by the failed sweep is claimed by the next one');
  assert.equal(completionEvents(next.infos)[0].claimedCount, 1);
  const after = JSON.parse(await payloadJson(report));
  assert.ok(
    after.selectiveCorpusAuthoritativeStatus !== 'pending' || typeof after.selectiveCorpusAuthoritativeClaimedAt === 'string',
    'the report is either finalized or holds a fresh claim',
  );

  // ... and the sweep after that does not process it a second time.
  const third = await capturingConsole(() => callSweep());
  assert.equal(third.value.status, 200);
  assert.equal((await third.value.json()).claimedCount, 0, 'no duplicate claim');
});
