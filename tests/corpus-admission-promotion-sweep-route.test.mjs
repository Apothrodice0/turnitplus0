import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as promotionSweepRoute from '../app/api/internal/corpus-admission-promotion-sweep/route.ts';
import { resetAuthRateForTest } from '../lib/rate-limit.js';

/**
 * AUTHORIZATION coverage for app/api/internal/corpus-admission-promotion-sweep/route.ts
 * — same shape as tests/corpus-admission-sweep-route.test.mjs (that file's
 * own header comment covers the reasoning), plus B1C-adjacent coverage:
 * this route now records its own outcome into corpus_admission_sweep_runs
 * (lib/corpus-admission-sweep-state.ts, sweep_kind 'promotion') — only when the
 * promotion flag is actually on and a real attempt ran. Every fixture here
 * is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_corpus_admission_promotion_sweep_route.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await setupClient.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(setupClient, drizzleDir);

const REAL_SECRET = 'promotion-sweep-route-test-secret-a1b2c3d4';

const originalSecret = process.env.CRON_SECRET;
const originalFlag = process.env.CORPUS_PROMOTION_ENABLED;
test.after(() => {
  setupClient.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED;
  else process.env.CORPUS_PROMOTION_ENABLED = originalFlag;
});

let ipCounter = 0;
async function callSweep(method, headers) {
  ipCounter += 1;
  const ip = `promotion-sweep-route-test-${ipCounter}`;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/internal/corpus-admission-promotion-sweep', {
    method,
    headers: { 'x-forwarded-for': ip, ...headers },
  });
  return method === 'GET' ? promotionSweepRoute.GET(req) : promotionSweepRoute.POST(req);
}

async function insertAcceptedDecision(text) {
  const decisionId = randomUUID();
  const hash = randomUUID();
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `promotion-sweep-route-test-${randomUUID()}`, 'v1', 'ACCEPT', JSON.stringify([]),
      1, JSON.stringify([]), 'txt', 50, 'English', 0.95, hash, 'v1', null, 80, 'v1',
      JSON.stringify({}), JSON.stringify({}), 'v1', 0.9, 'v1', 'NONE', null, null,
      JSON.stringify({ kind: 'PER_USER_CONSENT', consented: true }), 0,
    ],
  });
  const acceptedRepId = randomUUID();
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepId, decisionId, hash, 50, 'v1'],
  });
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, 'v1', 'LICENSED_REUSE'],
  });
  return decisionId;
}

async function sweepRunRow(kind) {
  const result = await setupClient.execute({ sql: 'SELECT last_status, last_summary_json FROM corpus_admission_sweep_runs WHERE sweep_kind = ?', args: [kind] });
  return result.rows[0] ?? null;
}

for (const method of ['GET', 'POST']) {
  test(`AUTHORIZATION (${method}): no Authorization header at all -> 404`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    const res = await callSweep(method, {});
    assert.equal(res.status, 404);
  });

  test(`AUTHORIZATION (${method}): fails CLOSED when CRON_SECRET is unset`, async () => {
    delete process.env.CRON_SECRET;
    const res = await callSweep(method, { authorization: 'Bearer anything-at-all' });
    assert.equal(res.status, 404);
  });

  test(`AUTHORIZATION (${method}): the correct secret is accepted, and the endpoint reports enabled:false without doing any work while the feature flag is off`, async () => {
    process.env.CRON_SECRET = REAL_SECRET;
    delete process.env.CORPUS_PROMOTION_ENABLED;

    const res = await callSweep(method, { authorization: `Bearer ${REAL_SECRET}` });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, enabled: false, claimedCount: 0 });
  });
}

test('SWEEP-STATE: while the flag is disabled, no promotion row is written and no prior real run is overwritten', async () => {
  await recordRealSuccessfulRun();
  const beforeDisabledCall = await sweepRunRow('promotion');

  process.env.CRON_SECRET = REAL_SECRET;
  delete process.env.CORPUS_PROMOTION_ENABLED;
  await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });

  const afterDisabledCall = await sweepRunRow('promotion');
  assert.deepEqual(afterDisabledCall, beforeDisabledCall, 'REQUIRED: a disabled-flag invocation must never write a fake run or overwrite the last real one');
});

async function recordRealSuccessfulRun() {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_PROMOTION_ENABLED = 'true';
  await insertAcceptedDecision(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '));
  const res = await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
}

test('SWEEP-STATE: a real, enabled run records last_status=success with a numeric-only summary, as a singleton row (never appended)', async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_PROMOTION_ENABLED = 'true';

  await insertAcceptedDecision(Array.from({ length: 61 }, (_, i) => `sweepword${i}`).join(' '));
  const res = await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.ok(body.claimedCount >= 1);

  const row = await sweepRunRow('promotion');
  assert.ok(row, 'REQUIRED: a real enabled run must persist a sweep-state row');
  assert.equal(row.last_status, 'success');
  const summary = JSON.parse(row.last_summary_json);
  assert.equal(typeof summary.claimedCount, 'number');
  for (const value of Object.values(summary)) {
    assert.equal(typeof value, 'number', 'REQUIRED: every persisted summary field must be a plain number — no id, no text, no nested object');
  }

  const rowCount = await setupClient.execute("SELECT COUNT(*) AS c FROM corpus_admission_sweep_runs WHERE sweep_kind = 'promotion'");
  assert.equal(Number(rowCount.rows[0].c), 1, 'REQUIRED: singleton row — a second real run must overwrite, never append');
});

test('PRIVACY: the persisted sweep-run row for a real run never contains a decision id, representation id, or any text from the swept content', async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_PROMOTION_ENABLED = 'true';
  const secretMarker = 'privacy-marker-should-never-be-persisted-in-sweep-runs';
  const decisionId = await insertAcceptedDecision(`${secretMarker} ${Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')}`);

  await callSweep('GET', { authorization: `Bearer ${REAL_SECRET}` });

  const row = await sweepRunRow('promotion');
  assert.ok(row);
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(decisionId), 'the swept decision id must never appear in the persisted sweep-run row');
  assert.ok(!serialized.includes(secretMarker), 'no swept content text must ever appear in the persisted sweep-run row');
});
