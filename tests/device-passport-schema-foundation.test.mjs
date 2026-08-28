import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';

/**
 * Device Passport — Phase 1 SCHEMA FOUNDATION guard. Verifies the exact
 * shape drizzle/0038-0040 establish, and — just as importantly — the shapes
 * they must NOT establish:
 *   - per-passport provenance generation (a COLUMN on device_passports),
 *     never a global singleton table;
 *   - the snapshot staleness column on report_historical_match_snapshots;
 *   - device provenance kept PER ADMISSION BACKING
 *     (corpus_admission_decision_device_provenance, keyed on decision_id),
 *     never on the deduplicated corpus_document_representations;
 *   - no account / device / email / IP identity column leaking onto
 *     corpus_document_representations.
 *
 * Phase 1 is schema only: this test asserts structure, never behavior.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_device_passport_schema_foundation.db');

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
}

cleanup();
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);
// Re-assert after migrations: some migration files toggle foreign_keys OFF
// for a table rebuild (0007), and the behavioral FK checks below need it ON.
await client.execute('PRAGMA foreign_keys = ON');

async function tableNames() {
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  return new Set(result.rows.map((r) => String(r.name)));
}

async function columnNames(table) {
  const result = await client.execute(`PRAGMA table_info('${table}')`);
  return new Set(result.rows.map((r) => String(r.name)));
}

async function indexNames(table) {
  const result = await client.execute(`PRAGMA index_list('${table}')`);
  return new Set(result.rows.map((r) => String(r.name)));
}

async function foreignKeys(table) {
  const result = await client.execute(`PRAGMA foreign_key_list('${table}')`);
  return result.rows.map((r) => ({ from: String(r.from), table: String(r.table), onDelete: String(r.on_delete).toUpperCase() }));
}

const tables = await tableNames();

// --- 1. Per-passport provenance generation is a COLUMN, not a table -------
{
  assert.ok(tables.has('device_passports'), 'device_passports table must exist');
  const cols = await columnNames('device_passports');
  assert.ok(cols.has('provenance_generation'), 'device_passports.provenance_generation (PER-PASSPORT counter) must exist');
  assert.ok(cols.has('public_key_spki'), 'device_passports.public_key_spki must exist');
  assert.ok(cols.has('revoked_at'), 'device_passports.revoked_at must exist');
  assert.ok(!cols.has('private_key') && !cols.has('private_key_pkcs8'), 'device_passports must never store a private key');

  // provenance_generation defaults to 0 for a freshly inserted passport.
  await client.execute({
    sql: 'INSERT INTO device_passports (id, public_key_spki, created_at) VALUES (?,?,?)',
    args: ['passport-a', Buffer.from('fake-spki-a'), Date.now()],
  });
  const row = await client.execute({ sql: 'SELECT provenance_generation FROM device_passports WHERE id = ?', args: ['passport-a'] });
  assert.equal(Number(row.rows[0].provenance_generation), 0, 'a new passport starts at provenance_generation 0');
}

// --- 2. NO global device_provenance_generation table --------------------
{
  assert.ok(
    !tables.has('device_provenance_generation'),
    'there must be NO global device_provenance_generation table — the counter is per-passport on device_passports',
  );
  // Nothing else generation-shaped for devices either (only the existing
  // corpus_match_generation singleton and the per-passport column are legit).
  for (const name of tables) {
    if (/device.*generation|generation.*device/i.test(name)) {
      assert.fail(`unexpected device-generation-shaped table: ${name}`);
    }
  }
}

// --- 3. Snapshot staleness column ---------------------------------------
{
  assert.ok(tables.has('report_historical_match_snapshots'), 'report_historical_match_snapshots must exist');
  const cols = await columnNames('report_historical_match_snapshots');
  assert.ok(cols.has('device_provenance_generation'), 'report_historical_match_snapshots.device_provenance_generation must exist');

  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots (report_device_key, report_id, status, computed_at) VALUES (?,?,?,?)`,
    args: ['dk-1', 'r-1', 'NO_HISTORICAL_MATCH', new Date().toISOString()],
  });
  const row = await client.execute({
    sql: 'SELECT device_provenance_generation FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?',
    args: ['dk-1', 'r-1'],
  });
  assert.equal(Number(row.rows[0].device_provenance_generation), 0, 'a snapshot with no verified upload passport rests at device_provenance_generation 0');
}

// --- 4. Device provenance is PER ADMISSION BACKING ---------------------
{
  assert.ok(
    tables.has('corpus_admission_decision_device_provenance'),
    'corpus_admission_decision_device_provenance (per-admission-backing link) must exist',
  );
  const cols = await columnNames('corpus_admission_decision_device_provenance');
  assert.deepEqual(
    [...cols].sort(),
    ['decision_id', 'device_passport_id', 'verified_at'].sort(),
    'corpus_admission_decision_device_provenance holds exactly decision_id + device_passport_id + verified_at',
  );

  const fks = await foreignKeys('corpus_admission_decision_device_provenance');
  const decisionFk = fks.find((f) => f.from === 'decision_id');
  const passportFk = fks.find((f) => f.from === 'device_passport_id');
  assert.ok(decisionFk, 'decision_id must be a foreign key');
  assert.equal(decisionFk.table, 'corpus_admission_decisions');
  assert.equal(decisionFk.onDelete, 'CASCADE', 'decision_id -> corpus_admission_decisions must be ON DELETE CASCADE');
  assert.ok(passportFk, 'device_passport_id must be a foreign key');
  assert.equal(passportFk.table, 'device_passports');
  assert.equal(passportFk.onDelete, 'RESTRICT', 'device_passport_id -> device_passports must be ON DELETE RESTRICT');

  // decision_id is the PRIMARY KEY: at most one verified device per decision.
  const info = await client.execute("PRAGMA table_info('corpus_admission_decision_device_provenance')");
  const pkCol = info.rows.find((r) => Number(r.pk) > 0);
  assert.equal(String(pkCol?.name), 'decision_id', 'decision_id must be the primary key (one verified device per admission decision)');

  // Behavioral: RESTRICT actually blocks removing a referenced passport.
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: ['decision-1', 'report-upload:account=acc:device=dk:report=r', 'v1', 'ACCEPT', '[]', 1, '[]', 0],
  });
  await client.execute({
    sql: 'INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)',
    args: ['decision-1', 'passport-a', Date.now()],
  });
  await assert.rejects(
    () => client.execute({ sql: 'DELETE FROM device_passports WHERE id = ?', args: ['passport-a'] }),
    /FOREIGN KEY constraint failed/,
    'a passport referenced by a promoted backing cannot be removed (RESTRICT)',
  );

  // Behavioral: CASCADE removes provenance when its decision is removed.
  await client.execute({ sql: 'DELETE FROM corpus_admission_decisions WHERE id = ?', args: ['decision-1'] });
  const after = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', args: ['decision-1'] });
  assert.equal(Number(after.rows[0].c), 0, 'removing the decision cascade-removes its device provenance');
}

// --- 5. The deduplicated representation table gains NO identity column --
{
  const cols = await columnNames('corpus_document_representations');
  for (const forbidden of [
    'device_passport_id', 'verified_device_passport_id', 'account_id', 'user_id',
    'email', 'ip', 'ip_address', 'submitter_name', 'author_name', 'device_key',
  ]) {
    assert.ok(!cols.has(forbidden), `corpus_document_representations must NOT gain a "${forbidden}" column — it is deduplicated and may have many independent backings`);
  }
}

// --- 6. verified_device_passport_id columns + partial index ------------
{
  const savedReportCols = await columnNames('saved_reports');
  assert.ok(savedReportCols.has('verified_device_passport_id'), 'saved_reports.verified_device_passport_id must exist');
  const jobCols = await columnNames('corpus_admission_report_jobs');
  assert.ok(jobCols.has('verified_device_passport_id'), 'corpus_admission_report_jobs.verified_device_passport_id must exist');

  const savedReportIndexes = await indexNames('saved_reports');
  assert.ok(savedReportIndexes.has('idx_saved_reports_verified_device_passport'), 'the partial index on saved_reports(verified_device_passport_id) must exist');

  // Immutability is enforced by application code (a later phase), not the
  // schema — but the column must accept NULL for every existing/anonymous
  // report, which is the resting state this phase ships.
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: ['sr-1', 'dk-1', 'sub-1', 'title', new Date().toISOString(), 10, 0, 'Low', '{}'],
  });
  const row = await client.execute({ sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE id = ? AND device_key = ?', args: ['sr-1', 'dk-1'] });
  assert.equal(row.rows[0].verified_device_passport_id, null, 'a report saved without a verified passport rests at NULL');
}

// --- 7. Challenge table shape ----------------------------------------
{
  assert.ok(tables.has('device_passport_challenges'), 'device_passport_challenges must exist');
  const cols = await columnNames('device_passport_challenges');
  for (const expected of ['id', 'nonce_hash', 'account_id', 'session_token_hash', 'issued_at', 'expires_at', 'consumed_at']) {
    assert.ok(cols.has(expected), `device_passport_challenges.${expected} must exist`);
  }
  assert.ok(!cols.has('nonce') && !cols.has('nonce_plaintext'), 'the raw challenge nonce must never be stored — only nonce_hash');
  const idx = await indexNames('device_passport_challenges');
  assert.ok(idx.has('idx_device_passport_challenges_expiry'), 'the challenge-expiry cleanup index must exist');
}

client.close();
cleanup();
console.log('device-passport schema foundation: per-passport generation column, no global table, snapshot column, per-backing provenance, no representation identity column — all verified');
