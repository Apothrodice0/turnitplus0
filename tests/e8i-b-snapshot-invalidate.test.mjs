import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { E8I_CLEANUP_TARGETS, E8I_LEGITIMATE_CLUSTER } from '../lib/e8i-cleanup-targets.ts';
import { E8I_B_SNAPSHOT_TARGETS } from '../lib/e8i-b-snapshot-targets.ts';
import {
  verifySnapshotTarget,
  planSnapshotInvalidation,
  renderSnapshotDryRunReport,
} from '../lib/e8i-b-snapshot-runner.ts';
import { maskId } from '../lib/e8i-cleanup-runner.ts';
import {
  applyVerifiedSnapshotInvalidation,
  applyAllVerifiedSnapshotInvalidations,
} from '../lib/e8i-b-snapshot-apply.ts';
import { computeDryRun, runPostCleanupVerification } from '../tools/e8i-b-snapshot-invalidate.ts';

/**
 * Phase E8I-B: tests for the stale historical-match-snapshot invalidation
 * toolset. Everything runs against local, disposable SQLite files — nothing
 * here ever touches a real Turso database, production or otherwise.
 */

const repo = path.resolve('.');

function freshDbPath(name) {
  return path.join(repo, `test_e8i_b_snapshot_${name}.db`);
}
function cleanupDbFile(dbFile) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
}

const ALL_TEST_NAMES = ['a', 'b', 'c-missing', 'd-status', 'e-report-missing', 'f-extra', 'g-apply', 'apply-refusal', 'h-readonly', 'i-mask', 'j-post'];
test.after(() => {
  for (const name of ALL_TEST_NAMES) cleanupDbFile(freshDbPath(name));
});

async function freshMigratedClient(name) {
  const dbFile = freshDbPath(name);
  cleanupDbFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, path.join(repo, 'drizzle'));
  return client;
}

async function insertUser(client, id, email) {
  await client.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [id, email, email.split('@')[0], 'x'] });
}
async function insertSavedReport(client, { id, deviceKey, title, userId }) {
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, `sub-${id}`, title, '2026-08-14 00:00:00', 100, 0, 'Low', '{}', userId],
  });
}
async function insertSnapshot(client, { deviceKey, reportId, status, computedAt }) {
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, computed_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [deviceKey, reportId, status, 'v1', 'v1', 'v1', computedAt],
  });
}

/** Seeds the legitimate repeat-submission cluster's own rows (representation, 2 identities, 2 references, 2 saved_reports) — only needed by the test that exercises post-cleanup verification's check 4. */
async function seedLegitimateClusterMinimal(client) {
  // Real data: E8I_LEGITIMATE_CLUSTER shares its account with E8I_CLEANUP_TARGETS[3] (both "account B") — buildFullFixture already created that user row, so this must not collide with it.
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [E8I_LEGITIMATE_CLUSTER.accountId, 'legit-account@example.test', 'legit', 'x'] });
  await client.execute({
    sql: `INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, canonicalization_version) VALUES (?,?,?,?,?)`,
    args: [E8I_LEGITIMATE_CLUSTER.representationId, 'legit-hash', 'placeholder', 10, 'canonical-text-v1'],
  });
  const [legitA, legitB] = E8I_LEGITIMATE_CLUSTER.identityIds;
  const createdAts = ['2026-08-14 04:08:26', '2026-08-14 04:13:45'];
  const refIds = [901, 902];
  for (const [i, id] of [legitA, legitB].entries()) {
    await client.execute({
      sql: `INSERT INTO document_identities (id, account_id, title, raw_sha256, canonical_sha256, created_at) VALUES (?,?,?,?,?,?)`,
      args: [id, E8I_LEGITIMATE_CLUSTER.accountId, E8I_LEGITIMATE_CLUSTER.title, 'legit-raw', 'legit-hash', createdAts[i]],
    });
    await client.execute({
      sql: `INSERT INTO corpus_submission_references (id, representation_id, document_identity_id, link_type, created_at) VALUES (?,?,?,?,?)`,
      args: [refIds[i], E8I_LEGITIMATE_CLUSTER.representationId, id, i === 0 ? 'NEW_CONTENT_REPRESENTATION' : 'EXACT_CANONICAL_DUPLICATE', createdAts[i]],
    });
    await insertSavedReport(client, { id: E8I_LEGITIMATE_CLUSTER.savedReportsIds[i], deviceKey: 'legit-device-key', title: E8I_LEGITIMATE_CLUSTER.title, userId: E8I_LEGITIMATE_CLUSTER.accountId });
    await client.execute({ sql: 'UPDATE saved_reports SET updated_at = ? WHERE id = ?', args: [createdAts[i], E8I_LEGITIMATE_CLUSTER.savedReportsIds[i]] });
  }
}

/** Seeds a saved_reports + MATCHED snapshot row for every one of the 4 real E8I-B targets — the fully valid, happy-path fixture. */
async function buildFullFixture(name) {
  const client = await freshMigratedClient(name);
  const accountA = E8I_CLEANUP_TARGETS[0].accountId;
  const accountB = E8I_CLEANUP_TARGETS[3].accountId;
  await insertUser(client, accountA, 'a@example.test');
  await insertUser(client, accountB, 'b@example.test');
  for (const t of E8I_B_SNAPSHOT_TARGETS) {
    const owningAccount = E8I_CLEANUP_TARGETS.find((c) => c.cluster === t.cluster).accountId;
    await insertSavedReport(client, { id: t.reportId, deviceKey: t.deviceKey, title: t.title, userId: owningAccount });
    await insertSnapshot(client, { deviceKey: t.deviceKey, reportId: t.reportId, status: 'MATCHED', computedAt: t.expectedComputedAtObservedDuringE8HAudit });
  }
  return client;
}

// --- allowlist derivation -----------------------------------------------------

test('allowlist: E8I_B_SNAPSHOT_TARGETS has exactly 4 entries, one per E8I_CLEANUP_TARGETS cluster, sharing the exact same reportId/deviceKey', () => {
  assert.equal(E8I_B_SNAPSHOT_TARGETS.length, 4);
  for (const t of E8I_CLEANUP_TARGETS) {
    const match = E8I_B_SNAPSHOT_TARGETS.find((s) => s.cluster === t.cluster);
    assert.ok(match, `no snapshot target for cluster ${t.cluster}`);
    assert.equal(match.reportId, t.expectedReportId);
    assert.equal(match.deviceKey, t.expectedDeviceKey);
    assert.equal(match.title, t.title);
    assert.equal(match.expectedStatus, 'MATCHED');
  }
});

// --- happy path ----------------------------------------------------------------

test('B: all 4 targets pass verification against a database with matching MATCHED snapshots and existing saved_reports rows', async () => {
  const client = await buildFullFixture('b');
  const plan = await planSnapshotInvalidation(client);
  assert.equal(plan.allVerified, true, JSON.stringify(plan.entries.filter((e) => !e.verification.ok), null, 2));
  assert.equal(plan.summary.snapshotsToDelete, 4);
  for (const entry of plan.entries) {
    assert.equal(entry.plannedAction, 'DELETE_SNAPSHOT');
    assert.equal(entry.computedAtDrifted, false);
  }
  client.close();
});

// --- refusal: missing snapshot --------------------------------------------------

test('C: a missing snapshot row refuses that target only', async () => {
  const client = await buildFullFixture('c-missing');
  const t = E8I_B_SNAPSHOT_TARGETS[0];
  await client.execute({ sql: 'DELETE FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: [t.deviceKey, t.reportId] });

  const verification = await verifySnapshotTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'SNAPSHOT_EXISTS' && !c.ok));

  const plan = await planSnapshotInvalidation(client);
  assert.equal(plan.allVerified, false);
  assert.equal(plan.entries.find((e) => e.cluster === t.cluster).plannedAction, 'NONE');
  for (const other of E8I_B_SNAPSHOT_TARGETS.filter((x) => x.cluster !== t.cluster)) {
    assert.equal(plan.entries.find((e) => e.cluster === other.cluster).verification.ok, true, `cluster ${other.cluster} should be unaffected`);
  }
  client.close();
});

// --- refusal: unexpected status --------------------------------------------------

test('D: a snapshot whose status is not MATCHED refuses', async () => {
  const client = await buildFullFixture('d-status');
  const t = E8I_B_SNAPSHOT_TARGETS[1];
  await client.execute({ sql: 'UPDATE report_historical_match_snapshots SET status = ? WHERE report_device_key = ? AND report_id = ?', args: ['NO_HISTORICAL_MATCH', t.deviceKey, t.reportId] });

  const verification = await verifySnapshotTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'STATUS_MATCHED' && !c.ok));
  assert.equal(verification.observedStatus, 'NO_HISTORICAL_MATCH');
  client.close();
});

// --- refusal: report missing -----------------------------------------------------

test('E: a deleted saved_reports row refuses', async () => {
  const client = await buildFullFixture('e-report-missing');
  const t = E8I_B_SNAPSHOT_TARGETS[2];
  await client.execute({ sql: 'DELETE FROM saved_reports WHERE id = ? AND device_key = ?', args: [t.reportId, t.deviceKey] });

  const verification = await verifySnapshotTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'REPORT_STILL_EXISTS' && !c.ok));
  client.close();
});

// --- refusal: extra/unrelated snapshot for the same report_id -------------------

test('F: an unrelated snapshot row sharing the same report_id under a different device_key refuses', async () => {
  const client = await buildFullFixture('f-extra');
  const t = E8I_B_SNAPSHOT_TARGETS[3];
  await insertSnapshot(client, { deviceKey: 'some-other-device-key', reportId: t.reportId, status: 'MATCHED', computedAt: '2026-08-14T00:00:00.000Z' });

  const verification = await verifySnapshotTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'NO_EXTRA_SNAPSHOT_MATCH' && !c.ok));
  client.close();
});

// --- apply deletes exactly the 4 rows and nothing else ---------------------------

test('G: applyAllVerifiedSnapshotInvalidations deletes exactly the 4 targeted rows, leaving an unrelated snapshot untouched, and post-cleanup verification passes end-to-end', async () => {
  const client = await buildFullFixture('g-apply');
  try {
    await seedLegitimateClusterMinimal(client);
    // An unrelated snapshot for some other report entirely — must survive.
    await insertUser(client, 'unrelated-user', 'unrelated@example.test');
    await insertSavedReport(client, { id: 'unrelated-report', deviceKey: 'unrelated-device', title: 'unrelated.docx', userId: 'unrelated-user' });
    await insertSnapshot(client, { deviceKey: 'unrelated-device', reportId: 'unrelated-report', status: 'MATCHED', computedAt: '2026-08-14T00:00:00.000Z' });

    const before = await client.execute('SELECT COUNT(*) AS n FROM report_historical_match_snapshots');
    assert.equal(Number(before.rows[0].n), 5);
    const beforeSnapshotKeys = new Set((await client.execute('SELECT report_device_key, report_id FROM report_historical_match_snapshots')).rows.map((r) => `${r.report_device_key}::${r.report_id}`));
    const repCountBefore = Number((await client.execute('SELECT COUNT(*) AS n FROM corpus_document_representations')).rows[0].n);
    const refCountBefore = Number((await client.execute('SELECT COUNT(*) AS n FROM corpus_submission_references')).rows[0].n);

    const outcomes = await applyAllVerifiedSnapshotInvalidations(client);
    assert.ok(outcomes.every((o) => o.status === 'deleted'), JSON.stringify(outcomes));

    const after = await client.execute('SELECT report_device_key, report_id FROM report_historical_match_snapshots');
    assert.equal(after.rows.length, 1, 'exactly the unrelated row must remain');
    assert.equal(after.rows[0].report_id, 'unrelated-report');

    for (const t of E8I_B_SNAPSHOT_TARGETS) {
      const gone = await client.execute({ sql: 'SELECT 1 FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: [t.deviceKey, t.reportId] });
      assert.equal(gone.rows.length, 0);
    }

    const postOk = await runPostCleanupVerification(client, {
      snapshotKeys: beforeSnapshotKeys,
      representationCount: repCountBefore,
      referenceCount: refCountBefore,
    });
    assert.equal(postOk, true, 'the exact same post-cleanup verification the CLI runs must pass end-to-end');
  } finally {
    client.close();
  }
});

// --- apply-time re-verification refuses a target that changed after planning ----

test('apply-time re-verification refuses (writes nothing) if the target changed after the plan was computed', async () => {
  const client = await buildFullFixture('apply-refusal');
  try {
    const t = E8I_B_SNAPSHOT_TARGETS[0];
    const planBefore = await planSnapshotInvalidation(client);
    assert.ok(planBefore.entries.find((e) => e.cluster === t.cluster).verification.ok);

    await client.execute({ sql: 'DELETE FROM saved_reports WHERE id = ? AND device_key = ?', args: [t.reportId, t.deviceKey] });

    const outcome = await applyVerifiedSnapshotInvalidation(client, t);
    assert.equal(outcome.status, 'refused');

    const stillThere = await client.execute({ sql: 'SELECT 1 FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: [t.deviceKey, t.reportId] });
    assert.equal(stillThere.rows.length, 1, 'refused apply must not have deleted the snapshot');
  } finally {
    client.close();
  }
});

// --- dry-run performs zero writes -------------------------------------------------

test('H (structural): lib/e8i-b-snapshot-runner.ts contains no write-statement keywords', () => {
  const source = fs.readFileSync(path.join(repo, 'lib/e8i-b-snapshot-runner.ts'), 'utf8');
  assert.doesNotMatch(source, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(source, /\bDROP\s+(TABLE|INDEX)\b/i);
  assert.doesNotMatch(source, /\bALTER\s+TABLE\b/i);
});

test('H (behavioral): planSnapshotInvalidation issues only SELECT statements — proven with a read-only-guard client', async () => {
  const client = await buildFullFixture('h-readonly');
  const guarded = {
    execute: async (stmt) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      assert.match(sql.trim(), /^SELECT\b/i, `dry-run path issued a non-SELECT statement: ${sql}`);
      return client.execute(stmt);
    },
  };
  const plan = await planSnapshotInvalidation(guarded);
  assert.equal(plan.allVerified, true);
  client.close();
});

// --- production confirmation gate --------------------------------------------------

test('production requires BOTH --execute and the exact confirm string; local only needs --execute', () => {
  assert.equal(computeDryRun('production', {}), true);
  assert.equal(computeDryRun('production', { execute: true }), true);
  assert.equal(computeDryRun('production', { execute: true, confirm: 'WRONG' }), true);
  assert.equal(computeDryRun('production', { execute: true, confirm: 'E8I-SNAPSHOT-INVALIDATE-PRODUCTION' }), false);
  assert.equal(computeDryRun('local', {}), true);
  assert.equal(computeDryRun('local', { execute: true }), false);
});

// --- masked output / no credential logging -----------------------------------------

test('I (structural): tools/e8i-b-snapshot-invalidate.ts never logs a raw token/url, only the derived hostnameLabel', () => {
  const source = fs.readFileSync(path.join(repo, 'tools/e8i-b-snapshot-invalidate.ts'), 'utf8');
  const consoleCalls = source.split(/\r?\n/).filter((l) => /console\.(log|error)/.test(l));
  for (const line of consoleCalls) {
    assert.doesNotMatch(line, /\bauthToken\b/, `must never log authToken directly: "${line.trim()}"`);
    if (/\burl\b/.test(line)) {
      assert.match(line, /hostnameLabel\(url\)/, `"url" must only ever be logged via hostnameLabel(): "${line.trim()}"`);
    }
  }
});

test('I (functional): the dry-run report masks the device key but shows the report id in full', async () => {
  const client = await buildFullFixture('i-mask');
  const plan = await planSnapshotInvalidation(client);
  const report = renderSnapshotDryRunReport(plan);
  for (const t of E8I_B_SNAPSHOT_TARGETS) {
    assert.doesNotMatch(report, new RegExp(t.deviceKey), `full device key ${t.deviceKey} must never appear unmasked`);
    assert.match(report, new RegExp(maskId(t.deviceKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(report, new RegExp(t.reportId), 'report id is shown in full, by design');
  }
  client.close();
});
