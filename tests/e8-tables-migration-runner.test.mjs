import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import {
  TARGET_MIGRATIONS,
  EXPECTED_TABLES_BY_MIGRATION,
  EXPECTED_COLUMNS_BY_MIGRATION,
  ALL_TARGET_TABLES,
  EXPECTED_LEGACY_TABLES,
  EXPECTED_MIGRATION_SHA256,
  APPROVED_DESTRUCTIVE_STATEMENTS,
  scanForDestructiveStatements,
  stripSqlLineComments,
  splitStatements,
  sha256,
  checkPreflight,
  tableSetState,
  columnSetState,
  runTargetMigrations,
} from '../lib/e8-tables-migration-runner.ts';
import { loadEnvFile, hostnameLabel, parseArgs } from '../tools/apply-e8-tables-migration.ts';

/**
 * Phase E8E-D.1: tests for the isolated 0012-0024 migration runner.
 * Everything here runs against local, disposable SQLite files created and
 * destroyed within this file — nothing here ever touches a real Turso
 * database, production or otherwise. See lib/e8-tables-migration-runner.ts's
 * own header comment for why this is a separate module from
 * lib/ingest.ts's applyMigrationsLibsql().
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');

function freshDbPath(name) {
  return path.join(repo, `test_e8_runner_${name}.db`);
}

function cleanupDbFile(dbFile) {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
}

/** Builds the pre-0012 legacy baseline (migrations 0000-0011 only, via a filtered temp copy) against a fresh local db file — this is section 9's mandatory disposable-database reproduction of "the relevant pre-0012 schema state." */
async function buildPreMigrationDb(dbFile) {
  cleanupDbFile(dbFile);
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-legacy-'));
  const legacyFiles = fs.readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => {
      const idx = Number(f.slice(0, 4));
      return idx <= 11;
    });
  assert.equal(legacyFiles.length, 12, 'expected exactly migrations 0000-0011 (12 files)');
  for (const f of legacyFiles) fs.copyFileSync(path.join(drizzleDir, f), path.join(legacyDir, f));

  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, legacyDir);
  fs.rmSync(legacyDir, { recursive: true, force: true });
  return client;
}

async function seedRepresentativeLegacyRows(client) {
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: ['legacy-user-1', 'legacy-user-1@example.test', 'legacy-user-1', 'not-a-real-hash'],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: ['legacy-report-1', 'legacy-device-1', 'legacy-sub-1', 'legacy.pdf', new Date().toISOString(), 100, 5, 'Low', '{}', 'legacy-user-1'],
  });
  // An anonymous (never-claimed) legacy report — 0027's room_number backfill
  // is scoped to `user_id IS NOT NULL` only (rooms are an authenticated-
  // account concept), so this row's room_number must stay NULL.
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: ['legacy-report-2', 'legacy-device-2', 'legacy-sub-2', 'legacy2.pdf', new Date().toISOString(), 100, 5, 'Low', '{}', null],
  });
  await client.execute({
    sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    args: ['legacy-session-hash-1', 'legacy-user-1', Date.now(), Date.now() + 86400000],
  });
  await client.execute({
    sql: `INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)`,
    args: ['legacy-doc-1', 'Legacy Document', 'a'.repeat(64), 'Publication', 500, 42],
  });
}

async function snapshotLegacyRows(client) {
  const tables = ['users', 'saved_reports', 'sessions', 'documents'];
  const snapshot = {};
  for (const t of tables) {
    const result = await client.execute(`SELECT * FROM ${t} ORDER BY rowid`);
    snapshot[t] = result.rows.map((r) => ({ ...r }));
  }
  return snapshot;
}

test.after(() => {
  for (const name of [
    'a', 'b', 'b2', 'c', 'd', 'e', 'e2', 'f', 'g', 'h', 'i', 'j', 'k', 'happy', 'idempotent',
    'g2-real', 'g2-extra', 'g2-wrong-file', 'g2-near-miss', 'g2-unrelated',
    'upgrade-0028', 'interrupted', 'schema-0032',
  ]) {
    cleanupDbFile(freshDbPath(name));
  }
});

// --- A: explicit allowlist ------------------------------------------------

test('A: TARGET_MIGRATIONS is an explicit allowlist of exactly 0012-0036, in order, never touching 0000-0011', () => {
  assert.deepEqual(TARGET_MIGRATIONS, [
    '0012_document_identities.sql',
    '0013_document_families.sql',
    '0014_provenance.sql',
    '0015_provenance_evidence.sql',
    '0016_provenance_verification_decisions.sql',
    '0017_discovery_attempts.sql',
    '0018_source_retrievals.sql',
    '0019_user_submission_corpus.sql',
    '0020_report_historical_match_snapshots.sql',
    '0021_historical_match_shadow_evaluations.sql',
    '0022_reuse_context_declarations.sql',
    '0023_privacy_consent_and_report_identity_link.sql',
    '0024_rate_limit_buckets.sql',
    '0025_users_role.sql',
    '0026_academic_search_run_diagnostics.sql',
    '0027_saved_reports_room_number.sql',
    '0028_saved_reports_ai_status.sql',
    '0029_corpus_admission_decisions.sql',
    '0030_corpus_admission_accepted_representations.sql',
    '0031_corpus_admission_report_jobs.sql',
    '0032_corpus_admission_accepted_representations_revocation.sql',
    '0033_corpus_admission_admin_audit_log.sql',
    '0034_corpus_admission_promotions.sql',
    '0035_report_historical_match_snapshots_partial.sql',
    '0036_corpus_match_generation.sql',
  ]);
  // Phase E8S Step 8: 0022_reuse_context_declarations.sql added
  // reuse_context_declarations, bringing the 15 E1-E8P tables across the
  // original 10 migrations to 16 across 11. Privacy hardening's
  // 0023_privacy_consent_and_report_identity_link.sql adds zero new tables
  // (it only adds columns to the already-existing saved_reports/users
  // tables — see EXPECTED_COLUMNS_BY_MIGRATION), so that stayed 16. Durable
  // rate limiting's 0024_rate_limit_buckets.sql creates one genuinely new
  // table (rate_limit_buckets), using plain EXPECTED_TABLES_BY_MIGRATION
  // tracking like every migration before 0023 — bringing this to 17.
  // Developer/admin authorization's 0025_users_role.sql adds zero new
  // tables (only users.role — same column-state mechanism as 0023), so that
  // stayed 17. Developer-diagnostics capture's
  // 0026_academic_search_run_diagnostics.sql creates one genuinely new table
  // (academic_search_run_diagnostics) — bringing this to 18. Room/slot
  // ownership's 0027_saved_reports_room_number.sql adds zero new tables
  // (only saved_reports.room_number — same column-state mechanism as 0023/
  // 0025), so that stays 18. The genuine AI-lifecycle status column's
  // 0028_saved_reports_ai_status.sql (production audit fix) likewise adds
  // zero new tables (only saved_reports.ai_status), so that stays 18 across
  // all 17 target migrations. The corpus-admission release then adds 8 more
  // migrations (0029-0036): 0029 creates 2 tables (decisions, content
  // store) — 20; 0030 creates 2 (accepted representations, accepted
  // shingles) — 22; 0031 creates 1 (report jobs) — 23; 0032 creates zero
  // (index swap + one column on an already-in-this-batch table — see
  // EXPECTED_COLUMNS_BY_MIGRATION) — stays 23; 0033 creates 1 (admin audit
  // log) — 24; 0034 creates 1 (promotions) — 25; 0035 creates zero (one
  // column on report_historical_match_snapshots) — stays 25; 0036 creates 1
  // (corpus_match_generation, plus a column on the same snapshots table —
  // see EXPECTED_TABLES_BY_MIGRATION's own comment on why table-existence
  // alone is sufficient for that hybrid case) — 26, across 25 target
  // migrations total.
  assert.equal(ALL_TARGET_TABLES.length, 26, 'expected exactly 26 tables across all 25 target migrations');
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0023_privacy_consent_and_report_identity_link.sql'],
    [],
    '0023 must be declared as creating zero new tables',
  );
  assert.deepEqual(
    EXPECTED_COLUMNS_BY_MIGRATION['0023_privacy_consent_and_report_identity_link.sql'],
    [
      { table: 'saved_reports', column: 'document_identity_id' },
      { table: 'users', column: 'corpus_reuse_consented_at' },
    ],
    '0023 must be declared as adding exactly these two columns',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0024_rate_limit_buckets.sql'],
    ['rate_limit_buckets'],
    '0024 must be declared as creating exactly one new table, tracked via the table-state mechanism',
  );
  assert.equal(
    EXPECTED_COLUMNS_BY_MIGRATION['0024_rate_limit_buckets.sql'],
    undefined,
    '0024 must NOT use the column-state mechanism — it creates a table, not columns on an existing one',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0025_users_role.sql'],
    [],
    '0025 must be declared as creating zero new tables',
  );
  assert.deepEqual(
    EXPECTED_COLUMNS_BY_MIGRATION['0025_users_role.sql'],
    [{ table: 'users', column: 'role' }],
    '0025 must be declared as adding exactly this one column',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0026_academic_search_run_diagnostics.sql'],
    ['academic_search_run_diagnostics'],
    '0026 must be declared as creating exactly one new table, tracked via the table-state mechanism',
  );
  assert.equal(
    EXPECTED_COLUMNS_BY_MIGRATION['0026_academic_search_run_diagnostics.sql'],
    undefined,
    '0026 must NOT use the column-state mechanism — it creates a table, not columns on an existing one',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0027_saved_reports_room_number.sql'],
    [],
    '0027 must be declared as creating zero new tables',
  );
  assert.deepEqual(
    EXPECTED_COLUMNS_BY_MIGRATION['0027_saved_reports_room_number.sql'],
    [{ table: 'saved_reports', column: 'room_number' }],
    '0027 must be declared as adding exactly this one column',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0028_saved_reports_ai_status.sql'],
    [],
    '0028 must be declared as creating zero new tables',
  );
  assert.deepEqual(
    EXPECTED_COLUMNS_BY_MIGRATION['0028_saved_reports_ai_status.sql'],
    [{ table: 'saved_reports', column: 'ai_status' }],
    '0028 must be declared as adding exactly this one column',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0029_corpus_admission_decisions.sql'],
    ['corpus_admission_decisions', 'corpus_admission_content_store'],
    '0029 must be declared as creating exactly these two new tables',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0030_corpus_admission_accepted_representations.sql'],
    ['corpus_admission_accepted_representations', 'corpus_admission_accepted_shingles'],
    '0030 must be declared as creating exactly these two new tables',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0031_corpus_admission_report_jobs.sql'],
    ['corpus_admission_report_jobs'],
    '0031 must be declared as creating exactly one new table',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0032_corpus_admission_accepted_representations_revocation.sql'],
    [],
    '0032 must be declared as creating zero new tables',
  );
  assert.deepEqual(
    EXPECTED_COLUMNS_BY_MIGRATION['0032_corpus_admission_accepted_representations_revocation.sql'],
    [{ table: 'corpus_admission_accepted_representations', column: 'revoked_at' }],
    '0032 must be declared as adding exactly this one column',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0033_corpus_admission_admin_audit_log.sql'],
    ['corpus_admission_admin_audit_log'],
    '0033 must be declared as creating exactly one new table',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0034_corpus_admission_promotions.sql'],
    ['corpus_admission_promotions'],
    '0034 must be declared as creating exactly one new table',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0035_report_historical_match_snapshots_partial.sql'],
    [],
    '0035 must be declared as creating zero new tables',
  );
  assert.deepEqual(
    EXPECTED_COLUMNS_BY_MIGRATION['0035_report_historical_match_snapshots_partial.sql'],
    [{ table: 'report_historical_match_snapshots', column: 'is_partial' }],
    '0035 must be declared as adding exactly this one column',
  );
  assert.deepEqual(
    EXPECTED_TABLES_BY_MIGRATION['0036_corpus_match_generation.sql'],
    ['corpus_match_generation'],
    '0036 must be declared as creating exactly one new table (its report_historical_match_snapshots.corpus_generation column is tracked implicitly — see that entry\'s own comment)',
  );
});

// --- F: no execution of 0000-0011 (structural) ----------------------------

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('F: the runner module never does an unfiltered directory scan — no readdirSync, no import of applyMigrationsLibsql', () => {
  // stripComments avoids the recurring self-referential false positive:
  // this module's own header comment explains, by name, why it is
  // different from applyMigrationsLibsql — see every prior E7/E8 phase
  // report for the same pattern.
  const source = stripComments(fs.readFileSync(path.join(repo, 'lib/e8-tables-migration-runner.ts'), 'utf8'));
  assert.doesNotMatch(source, /readdirSync/, 'the runner must only ever read the explicit TARGET_MIGRATIONS allowlist, never scan the directory');
  assert.doesNotMatch(source, /applyMigrationsLibsql/, 'the runner must be independent of the unsafe replay-everything function');
});

// --- G: destructive SQL detection -----------------------------------------

test('G: scanForDestructiveStatements finds real destructive statements and finds none, or exactly the one approved exception, in the actual 25 target migration files', () => {
  assert.deepEqual(scanForDestructiveStatements('CREATE TABLE IF NOT EXISTS x (id TEXT);'), []);
  assert.ok(scanForDestructiveStatements('DROP TABLE document_chunks;').length > 0);
  assert.ok(scanForDestructiveStatements('DELETE FROM users WHERE 1=1;').length > 0);
  assert.ok(scanForDestructiveStatements('ALTER TABLE users DROP COLUMN email;').length > 0);
  assert.ok(scanForDestructiveStatements('TRUNCATE TABLE users;').length > 0);
  // a comment merely mentioning the word must not trigger a false positive
  assert.deepEqual(scanForDestructiveStatements('-- this migration never uses DROP TABLE or DELETE FROM\nCREATE TABLE IF NOT EXISTS x (id TEXT);'), []);

  const approvedException = '0032_corpus_admission_accepted_representations_revocation.sql';
  for (const file of TARGET_MIGRATIONS) {
    const content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    const destructive = scanForDestructiveStatements(content);
    if (file === approvedException) {
      // The one deliberate, reviewed exception (requirement 2 of this
      // hardening pass): 0032 must contain EXACTLY the approved DROP INDEX
      // statement and nothing else destructive — proving the exception is
      // as narrow as APPROVED_DESTRUCTIVE_STATEMENTS' own header comment
      // claims, not a blanket pass for this file.
      assert.deepEqual(
        destructive,
        APPROVED_DESTRUCTIVE_STATEMENTS[approvedException],
        `${file} must contain exactly its one approved destructive statement, and nothing else destructive`,
      );
    } else {
      assert.deepEqual(destructive, [], `${file} must contain zero destructive statements`);
    }
    assert.equal(sha256(content), EXPECTED_MIGRATION_SHA256[file], `${file}'s pinned hash must match its current content`);
  }
});

// --- G2: the destructive-statement exception is narrow, per-file, per-exact-statement ---

test('G2: checkPreflight accepts the real 0032 file (its one destructive statement is the approved exception)', async () => {
  const dbFile = freshDbPath('g2-real');
  const client = await buildPreMigrationDb(dbFile);

  const result = await checkPreflight(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(result.ok, true, 'the real, unmodified migration set (including 0032\'s approved DROP INDEX) must pass preflight');

  client.close();
});

test('G2: checkPreflight refuses an unapproved destructive statement in 0032 even when the approved statement is ALSO present', async () => {
  const dbFile = freshDbPath('g2-extra');
  const client = await buildPreMigrationDb(dbFile);

  const tempDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-g2-extra-'));
  const manifest = {};
  for (const file of TARGET_MIGRATIONS) {
    let content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    if (file === '0032_corpus_admission_accepted_representations_revocation.sql') {
      // Smuggle in a second, unreviewed destructive statement alongside the
      // approved one — the allowlist must not treat "this file has an
      // approved exception" as "this file's destructive scanning is off."
      content += '\nDELETE FROM corpus_admission_accepted_representations WHERE 1=1;\n';
    }
    fs.writeFileSync(path.join(tempDrizzleDir, file), content);
    manifest[file] = sha256(content);
  }

  const result = await checkPreflight(client, tempDrizzleDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: manifest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DESTRUCTIVE_STATEMENT_DETECTED');
  assert.match(result.message, /DELETE FROM corpus_admission_accepted_representations/);
  // The approved statement itself must not be re-flagged alongside the real violation.
  assert.doesNotMatch(result.message, /DROP INDEX IF EXISTS ux_corpus_admission_accepted_representations_canonical_sha256/);

  client.close();
  fs.rmSync(tempDrizzleDir, { recursive: true, force: true });
});

test('G2: checkPreflight refuses 0032\'s approved statement text if it appears, unapproved, in a DIFFERENT file', async () => {
  const dbFile = freshDbPath('g2-wrong-file');
  const client = await buildPreMigrationDb(dbFile);

  const tempDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-g2-wrong-file-'));
  const manifest = {};
  for (const file of TARGET_MIGRATIONS) {
    let content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    if (file === '0033_corpus_admission_admin_audit_log.sql') {
      // The exact text approved for 0032, verbatim, but in 0033 instead —
      // the allowlist is keyed by filename, so this must still be refused.
      content += '\nDROP INDEX IF EXISTS ux_corpus_admission_accepted_representations_canonical_sha256;\n';
    }
    fs.writeFileSync(path.join(tempDrizzleDir, file), content);
    manifest[file] = sha256(content);
  }

  const result = await checkPreflight(client, tempDrizzleDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: manifest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DESTRUCTIVE_STATEMENT_DETECTED');
  assert.equal(result.details.file, '0033_corpus_admission_admin_audit_log.sql');

  client.close();
  fs.rmSync(tempDrizzleDir, { recursive: true, force: true });
});

test('G2: checkPreflight refuses a near-miss variant of 0032\'s approved statement (different index name)', async () => {
  const dbFile = freshDbPath('g2-near-miss');
  const client = await buildPreMigrationDb(dbFile);

  const tempDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-g2-near-miss-'));
  const manifest = {};
  for (const file of TARGET_MIGRATIONS) {
    let content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    if (file === '0032_corpus_admission_accepted_representations_revocation.sql') {
      content = content.replace(
        'DROP INDEX IF EXISTS ux_corpus_admission_accepted_representations_canonical_sha256;',
        'DROP INDEX IF EXISTS some_other_index_entirely;',
      );
    }
    fs.writeFileSync(path.join(tempDrizzleDir, file), content);
    manifest[file] = sha256(content);
  }

  const result = await checkPreflight(client, tempDrizzleDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: manifest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DESTRUCTIVE_STATEMENT_DETECTED');
  assert.match(result.message, /DROP INDEX IF EXISTS some_other_index_entirely/);

  client.close();
  fs.rmSync(tempDrizzleDir, { recursive: true, force: true });
});

test('G2: checkPreflight still refuses unrelated destructive statements in unrelated files (0032\'s exception grants nothing globally)', async () => {
  const dbFile = freshDbPath('g2-unrelated');
  const client = await buildPreMigrationDb(dbFile);

  const tempDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-g2-unrelated-'));
  const manifest = {};
  for (const file of TARGET_MIGRATIONS) {
    let content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    if (file === '0029_corpus_admission_decisions.sql') {
      content += '\nDROP TABLE corpus_admission_decisions;\n';
    }
    fs.writeFileSync(path.join(tempDrizzleDir, file), content);
    manifest[file] = sha256(content);
  }

  const result = await checkPreflight(client, tempDrizzleDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: manifest,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DESTRUCTIVE_STATEMENT_DETECTED');
  assert.equal(result.details.file, '0029_corpus_admission_decisions.sql');

  client.close();
  fs.rmSync(tempDrizzleDir, { recursive: true, force: true });
});

test('splitStatements correctly splits a real multi-statement migration file into individually executable statements', () => {
  const content = fs.readFileSync(path.join(drizzleDir, '0019_user_submission_corpus.sql'), 'utf8');
  const statements = splitStatements(content);
  assert.ok(statements.length >= 8, 'expected at least 8 individual CREATE statements');
  for (const s of statements) {
    assert.doesNotMatch(s, /^--/, 'no statement should be a leftover comment line');
    assert.ok(/^CREATE/i.test(s), 'every statement in these 10 files is a CREATE TABLE/INDEX');
  }
});

test('splitStatements correctly splits 0023 (the first target migration to use ALTER TABLE, not just CREATE)', () => {
  const content = fs.readFileSync(path.join(drizzleDir, '0023_privacy_consent_and_report_identity_link.sql'), 'utf8');
  const statements = splitStatements(content);
  assert.equal(statements.length, 3, 'expected exactly 2 ALTER TABLE statements + 1 CREATE INDEX');
  for (const s of statements) assert.doesNotMatch(s, /^--/, 'no statement should be a leftover comment line');
  assert.ok(/^ALTER TABLE saved_reports ADD COLUMN document_identity_id/i.test(statements[0]));
  assert.ok(/^ALTER TABLE users ADD COLUMN corpus_reuse_consented_at/i.test(statements[1]));
  assert.ok(/^CREATE INDEX/i.test(statements[2]));
});

test('splitStatements correctly splits 0025 (a single ALTER TABLE, like 0023 but only one column)', () => {
  const content = fs.readFileSync(path.join(drizzleDir, '0025_users_role.sql'), 'utf8');
  const statements = splitStatements(content);
  assert.equal(statements.length, 1, 'expected exactly 1 ALTER TABLE statement');
  assert.doesNotMatch(statements[0], /^--/, 'no statement should be a leftover comment line');
  assert.ok(/^ALTER TABLE users ADD COLUMN role/i.test(statements[0]));
});

test('splitStatements correctly splits 0026 (one CREATE TABLE plus two CREATE INDEX statements)', () => {
  const content = fs.readFileSync(path.join(drizzleDir, '0026_academic_search_run_diagnostics.sql'), 'utf8');
  const statements = splitStatements(content);
  assert.equal(statements.length, 3, 'expected exactly 1 CREATE TABLE + 2 CREATE INDEX statements');
  for (const s of statements) assert.doesNotMatch(s, /^--/, 'no statement should be a leftover comment line');
  assert.ok(/^CREATE TABLE IF NOT EXISTS academic_search_run_diagnostics/i.test(statements[0]));
  assert.ok(/^CREATE INDEX/i.test(statements[1]));
  assert.ok(/^CREATE INDEX/i.test(statements[2]));
});

test('splitStatements correctly splits 0027 (one ALTER TABLE, one backfill UPDATE, one CREATE INDEX)', () => {
  const content = fs.readFileSync(path.join(drizzleDir, '0027_saved_reports_room_number.sql'), 'utf8');
  const statements = splitStatements(content);
  assert.equal(statements.length, 3, 'expected exactly 1 ALTER TABLE + 1 UPDATE + 1 CREATE INDEX');
  for (const s of statements) assert.doesNotMatch(s, /^--/, 'no statement should be a leftover comment line');
  assert.ok(/^ALTER TABLE saved_reports ADD COLUMN room_number/i.test(statements[0]));
  assert.ok(/^UPDATE saved_reports/i.test(statements[1]));
  assert.ok(/^CREATE INDEX/i.test(statements[2]));
});

test('splitStatements correctly splits 0028 (a single ALTER TABLE, like 0025 but on saved_reports)', () => {
  const content = fs.readFileSync(path.join(drizzleDir, '0028_saved_reports_ai_status.sql'), 'utf8');
  const statements = splitStatements(content);
  assert.equal(statements.length, 1, 'expected exactly 1 ALTER TABLE statement');
  assert.doesNotMatch(statements[0], /^--/, 'no statement should be a leftover comment line');
  assert.ok(/^ALTER TABLE saved_reports ADD COLUMN ai_status/i.test(statements[0]));
});

// --- Section 9: disposable local DB — full happy-path run ------------------

test('SECTION 9: fresh pre-0012 database — the runner applies all 25 migrations in order, creates all 26 tables, adds every column-only migration\'s columns, and preserves legacy row VALUES exactly', async () => {
  const dbFile = freshDbPath('happy');
  const client = await buildPreMigrationDb(dbFile);
  await seedRepresentativeLegacyRows(client);
  const before = await snapshotLegacyRows(client);

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.steps.map((s) => s.file), TARGET_MIGRATIONS, 'E: migrations must run in exactly the declared order');
  assert.ok(result.steps.every((s) => s.status === 'applied'));

  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(tables.rows.map((r) => String(r.name)));
  for (const t of ALL_TARGET_TABLES) assert.ok(tableNames.has(t), `expected table ${t} to exist after migration`);
  for (const t of EXPECTED_LEGACY_TABLES) assert.ok(tableNames.has(t), `legacy table ${t} must still exist`);

  // J: legacy row preservation. Unlike every other target migration
  // (0012-0022, which only ever create brand-new tables), 0023 additively
  // alters the pre-existing legacy tables saved_reports/users themselves —
  // so a bare deepEqual(after, before) on `SELECT *` rows would now fail on
  // shape alone (two new nullable columns appear) even though nothing about
  // the ORIGINAL data changed. Assert what actually matters instead: every
  // column/value present before migration is byte-identical after, and the
  // two newly-added columns exist and are NULL (a migration must never
  // populate them — only application code does, on its own separate write
  // path).
  const after = await snapshotLegacyRows(client);
  for (const table of Object.keys(before)) {
    assert.equal(after[table].length, before[table].length, `${table} row count must be unchanged by migration`);
    for (let i = 0; i < before[table].length; i++) {
      for (const [column, value] of Object.entries(before[table][i])) {
        assert.equal(after[table][i][column], value, `${table}.${column} (row ${i}) must be unchanged by migration`);
      }
    }
  }
  const savedReportRow = after.saved_reports.find((r) => r.id === 'legacy-report-1');
  assert.equal(savedReportRow.document_identity_id, null, "0023 must add document_identity_id as NULL to a pre-existing row, never populate it");
  const userRow = after.users.find((r) => r.id === 'legacy-user-1');
  assert.equal(userRow.corpus_reuse_consented_at, null, "0023 must add corpus_reuse_consented_at as NULL to a pre-existing row, never populate it");
  // 0025's column differs from 0023's: `role` has NOT NULL DEFAULT 'user',
  // so a pre-existing row gets backfilled to the same default value a
  // brand-new signup would get (see db/schema.ts's own comment on this
  // column) — the correct behavior here is the default, not NULL.
  assert.equal(userRow.role, 'user', "0025 must backfill role to the column's own default ('user') on a pre-existing row, never leave it unset or grant admin");
  // 0027's column differs from both: it backfills a *computed* value
  // (CAST(id AS INTEGER) % 10), and only for rows with a non-NULL user_id —
  // legacy-report-1 (id: 'legacy-report-1', user_id set) casts to 0 (SQLite
  // CASTs a non-numeric TEXT to INTEGER as 0), so 0 % 10 = 0. legacy-report-2
  // (user_id NULL, anonymous) must be left NULL — rooms are an
  // authenticated-account concept only.
  assert.equal(savedReportRow.room_number, 0, "0027 must backfill room_number to CAST(id AS INTEGER) % 10 for a pre-existing authenticated row");
  const anonymousReportRow = after.saved_reports.find((r) => r.id === 'legacy-report-2');
  assert.equal(anonymousReportRow.room_number, null, "0027 must leave room_number NULL for a pre-existing anonymous (user_id IS NULL) row");
  // 0028 (production audit fix) is a plain additive column with no backfill
  // at all — every pre-existing row, authenticated or anonymous, must get
  // NULL, deferring entirely to deriveRoomStatus's own ai_score-based
  // fallback for legacy rows (see lib/report-rooms.ts).
  assert.equal(savedReportRow.ai_status, null, "0028 must add ai_status as NULL to a pre-existing row, never populate it");
  assert.equal(anonymousReportRow.ai_status, null, "0028 must add ai_status as NULL to a pre-existing anonymous row too");

  client.close();
});

// --- I: idempotent re-run ---------------------------------------------------

test('I: re-running the runner against an already-fully-migrated database is a safe no-op', async () => {
  const dbFile = freshDbPath('idempotent');
  const client = await buildPreMigrationDb(dbFile);
  await seedRepresentativeLegacyRows(client);

  const first = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(first.status, 'success');
  const before = await snapshotLegacyRows(client);

  const second = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(second.status, 'already-fully-applied');
  assert.ok(second.steps.every((s) => s.status === 'already-applied'));

  const after = await snapshotLegacyRows(client);
  assert.deepEqual(after, before, 'a safe no-op re-run must not touch legacy rows either');

  client.close();
});

// --- UPGRADE: the real release path — a populated 0028 database, not fresh ---

test('UPGRADE: a populated database already at 0028 upgrades cleanly through 0036, preserving existing 0012-0028 corpus/report data exactly', async () => {
  const dbFile = freshDbPath('upgrade-0028');
  const client = await buildPreMigrationDb(dbFile);
  await seedRepresentativeLegacyRows(client);

  // Simulate "this is where production actually is today": apply only
  // 0012-0028 (via a filtered temp copy, same technique as test K's own
  // inScopeFiles), never touching 0029-0036 yet.
  const only0028Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-upgrade-0028-'));
  // buildPreMigrationDb already applied 0000-0011 — only copy 0012-0028
  // here, or applyMigrationsLibsql would try to recreate 0000-0011's
  // tables and fail on "already exists."
  const filesThrough0028 = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql') && f.slice(0, 4) >= '0012' && f.slice(0, 4) <= '0028').sort();
  for (const f of filesThrough0028) fs.copyFileSync(path.join(drizzleDir, f), path.join(only0028Dir, f));
  await applyMigrationsLibsql(client, only0028Dir);
  fs.rmSync(only0028Dir, { recursive: true, force: true });

  // Seed representative REAL usage data in the exact tables 0029-0036 sit
  // next to / reference (corpus_admission_promotions FK-references
  // corpus_document_representations; the snapshot cache is what 0035/0036
  // add columns to) — this is what a real upgrade must never disturb.
  const repId = 'upgrade-test-representation-1';
  await client.execute({
    sql: `INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version)
          VALUES (?,?,?,?,?,?,?)`,
    args: [repId, 'b'.repeat(64), 'some pre-existing canonical corpus text', 250, 'en', 'v1', 'v1'],
  });
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: ['upgrade-test-device-1', 'upgrade-test-report-1', 'NO_HISTORICAL_MATCH', 'v1', 'v1', 'v1', '{}', 0, 5],
  });

  const before = {
    representation: { ...(await client.execute({ sql: 'SELECT * FROM corpus_document_representations WHERE id = ?', args: [repId] })).rows[0] },
    snapshot: { ...(await client.execute({ sql: 'SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: ['upgrade-test-device-1', 'upgrade-test-report-1'] })).rows[0] },
  };

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });

  assert.equal(result.status, 'success', 'a populated 0028 database must upgrade successfully, not refuse or fail');
  const stepsByFile = Object.fromEntries(result.steps.map((s) => [s.file, s.status]));
  for (const file of TARGET_MIGRATIONS.filter((f) => f.slice(0, 4) <= '0028')) {
    assert.equal(stepsByFile[file], 'already-applied', `${file} was already applied before this run and must be recognized as such, not reapplied`);
  }
  for (const file of TARGET_MIGRATIONS.filter((f) => f.slice(0, 4) >= '0029')) {
    assert.equal(stepsByFile[file], 'applied', `${file} must be newly applied by this upgrade run`);
  }

  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(tables.rows.map((r) => String(r.name)));
  for (const t of [
    'corpus_admission_decisions', 'corpus_admission_content_store',
    'corpus_admission_accepted_representations', 'corpus_admission_accepted_shingles',
    'corpus_admission_report_jobs', 'corpus_admission_admin_audit_log',
    'corpus_admission_promotions', 'corpus_match_generation',
  ]) {
    assert.ok(tableNames.has(t), `expected new table ${t} to exist after upgrade`);
  }

  const after = {
    representation: { ...(await client.execute({ sql: 'SELECT * FROM corpus_document_representations WHERE id = ?', args: [repId] })).rows[0] },
    snapshot: { ...(await client.execute({ sql: 'SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: ['upgrade-test-device-1', 'upgrade-test-report-1'] })).rows[0] },
  };
  for (const [column, value] of Object.entries(before.representation)) {
    assert.equal(after.representation[column], value, `corpus_document_representations.${column} must be unchanged by the 0029-0036 upgrade`);
  }
  for (const [column, value] of Object.entries(before.snapshot)) {
    assert.equal(after.snapshot[column], value, `report_historical_match_snapshots.${column} must be unchanged by the 0029-0036 upgrade`);
  }
  // 0035/0036 add is_partial/corpus_generation as NOT NULL DEFAULT 0 columns
  // — a pre-existing row must be backfilled to that default, not left NULL
  // or unset, matching each migration's own "common case for every existing
  // row" header comment.
  assert.equal(after.snapshot.is_partial, 0, '0035 must backfill is_partial to 0 for a pre-existing snapshot row');
  assert.equal(after.snapshot.corpus_generation, 0, '0036 must backfill corpus_generation to 0 for a pre-existing snapshot row');

  const repInfo = await client.execute("PRAGMA table_info('corpus_admission_accepted_representations')");
  assert.ok(repInfo.rows.some((r) => String(r.name) === 'revoked_at'), '0032 must add revoked_at to corpus_admission_accepted_representations');

  const generationRow = await client.execute('SELECT id, generation FROM corpus_match_generation WHERE id = 1');
  assert.equal(generationRow.rows.length, 1, '0036 must seed exactly one corpus_match_generation row');
  assert.equal(generationRow.rows[0].generation, 0, '0036 must seed the initial generation at 0');

  client.close();
});

// --- INTERRUPTED: recovery from a run that failed partway through --------

test('INTERRUPTED: a run that fails partway through the 0029-0036 range can be safely resumed to completion', async () => {
  const dbFile = freshDbPath('interrupted');
  const client = await buildPreMigrationDb(dbFile);

  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-interrupted-'));
  const manifest = {};
  for (const file of TARGET_MIGRATIONS) {
    let content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    if (file === '0034_corpus_admission_promotions.sql') {
      // Genuinely invalid SQL (real syntax error, not a mocked failure) —
      // client.migrate() must reject this for real, same technique as
      // test H's own simulated failure.
      content = content.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLEX IF NOT EXISTS');
    }
    fs.writeFileSync(path.join(brokenDir, file), content);
    manifest[file] = sha256(content);
  }

  const interrupted = await runTargetMigrations(client, brokenDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: manifest,
  });
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.failedMigration, '0034_corpus_admission_promotions.sql');
  const appliedBeforeInterruption = interrupted.steps.filter((s) => s.status === 'applied').map((s) => s.file);
  assert.deepEqual(
    appliedBeforeInterruption,
    TARGET_MIGRATIONS.filter((f) => f.slice(0, 4) <= '0033'),
    'every migration before the simulated interruption at 0034 must have succeeded',
  );
  fs.rmSync(brokenDir, { recursive: true, force: true });

  // Recovery: rerun against the REAL, uncorrupted migration set, reusing
  // the SAME client/database the interrupted run left behind — nothing
  // rolled back or reset by hand, exactly what an operator would do after
  // fixing whatever caused the interruption (a real bug, a network drop
  // mid-run, a killed process — this runner cannot tell those apart from
  // "some migrations already succeeded," and does not need to).
  const recovered = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(recovered.status, 'success', 'resuming after an interruption must complete successfully');
  const recoveredByFile = Object.fromEntries(recovered.steps.map((s) => [s.file, s.status]));
  for (const file of TARGET_MIGRATIONS.filter((f) => f.slice(0, 4) <= '0033')) {
    assert.equal(recoveredByFile[file], 'already-applied', `${file} succeeded before the interruption and must be recognized as already-applied on resume`);
  }
  for (const file of TARGET_MIGRATIONS.filter((f) => f.slice(0, 4) >= '0034')) {
    assert.equal(recoveredByFile[file], 'applied', `${file} must be applied during the resumed run`);
  }

  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(tables.rows.map((r) => String(r.name)));
  assert.ok(tableNames.has('corpus_admission_promotions'), '0034 must have succeeded on the resumed run');
  assert.ok(tableNames.has('corpus_match_generation'), '0036 must have succeeded on the resumed run');

  client.close();
});

// --- SCHEMA: 0032's exact index-swap outcome ------------------------------

test('SCHEMA: after full migration, 0032\'s old plain unique index is gone and its replacement partial index has the exact expected definition', async () => {
  const dbFile = freshDbPath('schema-0032');
  const client = await buildPreMigrationDb(dbFile);

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(result.status, 'success');

  const indexes = await client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'corpus_admission_accepted_representations'");
  const byName = Object.fromEntries(indexes.rows.map((r) => [String(r.name), r.sql === null ? null : String(r.sql)]));

  assert.equal(
    byName['ux_corpus_admission_accepted_representations_canonical_sha256'],
    undefined,
    '0032 must have dropped the original plain unique index — it must not exist in the final schema',
  );
  assert.ok(
    byName['ux_corpus_admission_accepted_representations_canonical_sha256_active'],
    "0032's replacement partial unique index must exist",
  );
  assert.match(
    byName['ux_corpus_admission_accepted_representations_canonical_sha256_active'],
    /WHERE revoked_at IS NULL/i,
    'the replacement index must be scoped to active (non-revoked) rows only, not a plain unique index',
  );
  assert.ok(
    byName['idx_corpus_admission_accepted_representations_revoked_at'],
    "0032's plain index on revoked_at must also exist",
  );

  client.close();
});

// --- C: refusal when production is not in expected pre-0012 state ----------

test('C: refuses on a database missing the expected legacy tables entirely', async () => {
  const dbFile = freshDbPath('c');
  cleanupDbFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` }); // completely empty — no migrations at all

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason.code, 'MISSING_LEGACY_TABLE');

  client.close();
});

// --- B: refusal when a target migration is partially applied ---------------

test('B: refuses when a target migration\'s tables exist in a mixed state (some but not all) — a same-name-different-shape table', async () => {
  const dbFile = freshDbPath('b');
  const client = await buildPreMigrationDb(dbFile);
  // Pre-create only ONE of migration 0013's three tables — an "unexpected"
  // partial state no legitimate prior run of this runner could produce
  // (each migration is applied as a single client.migrate() transaction).
  await client.execute('CREATE TABLE document_families (id TEXT PRIMARY KEY)');

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failedMigration, '0013_document_families.sql');
  assert.match(result.error, /partially applied/);
  // 0012 (unrelated, unaffected) must still have been applied before the refusal
  assert.ok(result.steps.some((s) => s.file === '0012_document_identities.sql' && s.status === 'applied'));

  client.close();
});

// --- B2: refusal when 0023's columns exist in a mixed state ----------------

test('B2: refuses when 0023\'s columns exist in a mixed state (one of the two added columns present, not both)', async () => {
  const dbFile = freshDbPath('b2');
  const client = await buildPreMigrationDb(dbFile);

  // Apply exactly 0012-0022 for real (via a temp dir excluding 0023 and
  // anything after it — filtered explicitly by filename prefix, not by
  // position, so this stays correct as later migrations get appended to
  // TARGET_MIGRATIONS), then hand-add only ONE of 0023's two columns — an
  // "unexpected" partial state no legitimate prior run of this runner
  // could produce (0023 applies as a single client.migrate() transaction,
  // same as every other target migration).
  const only0012to0022 = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-b2-'));
  for (const file of TARGET_MIGRATIONS.filter((f) => f.slice(0, 4) <= '0022')) {
    fs.copyFileSync(path.join(drizzleDir, file), path.join(only0012to0022, file));
  }
  await applyMigrationsLibsql(client, only0012to0022);
  await client.execute('ALTER TABLE users ADD COLUMN corpus_reuse_consented_at TEXT');
  // Deliberately omit saved_reports.document_identity_id — the partial state.

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failedMigration, '0023_privacy_consent_and_report_identity_link.sql');
  assert.match(result.error, /partially applied/);
  assert.match(result.error, /saved_reports\.document_identity_id/);
  // every migration before 0023 (unrelated, unaffected) must still have succeeded
  assert.ok(result.steps.some((s) => s.file === '0022_reuse_context_declarations.sql' && s.status === 'already-applied'));

  client.close();
  fs.rmSync(only0012to0022, { recursive: true, force: true });
});

// --- D: refusal when migration content differs from the pinned version -----

test('D: refuses when a target migration file\'s content does not match the pinned/reviewed hash', async () => {
  const dbFile = freshDbPath('d');
  const client = await buildPreMigrationDb(dbFile);

  const result = await checkPreflight(client, drizzleDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: { ...EXPECTED_MIGRATION_SHA256, '0012_document_identities.sql': '0'.repeat(64) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HASH_MISMATCH');

  client.close();
});

// --- F (env gate) + additional environment-label safety --------------------

test('F/precondition: refuses immediately when environmentLabel does not match the caller\'s expected value, before touching the database', async () => {
  const dbFile = freshDbPath('f');
  cleanupDbFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` }); // deliberately empty/unmigrated

  const result = await runTargetMigrations(client, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'production' });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason.code, 'ENVIRONMENT_LABEL_MISMATCH');

  client.close();
});

// --- H: stop-on-error behavior ----------------------------------------------

test('H: stops immediately on the first genuinely failing migration, reports which one, and does not attempt subsequent migrations', async () => {
  const dbFile = freshDbPath('h');
  const client = await buildPreMigrationDb(dbFile);

  const tempDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-broken-'));
  const manifest = {};
  for (const file of TARGET_MIGRATIONS) {
    let content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    if (file === '0015_provenance_evidence.sql') {
      // Genuinely invalid SQL (real syntax error, not a mocked failure) —
      // client.migrate() must reject this for real.
      content = content.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLEX IF NOT EXISTS');
    }
    fs.writeFileSync(path.join(tempDrizzleDir, file), content);
    manifest[file] = sha256(content);
  }

  const result = await runTargetMigrations(client, tempDrizzleDir, {
    environmentLabel: 'local-test',
    expectedEnvironmentLabel: 'local-test',
    migrationShaManifest: manifest,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failedMigration, '0015_provenance_evidence.sql');
  const appliedBeforeFailure = result.steps.filter((s) => s.status === 'applied').map((s) => s.file);
  assert.deepEqual(appliedBeforeFailure, ['0012_document_identities.sql', '0013_document_families.sql', '0014_provenance.sql'], 'exactly the migrations before the failing one must have succeeded');
  assert.ok(!result.steps.some((s) => s.file === '0016_provenance_verification_decisions.sql'), 'no migration after the failure must have been attempted');

  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(tables.rows.map((r) => String(r.name)));
  assert.ok(!tableNames.has('provenance_evidence'), 'the failed migration must not have left a partially-created table');
  assert.ok(tableNames.has('provenance_sources'), 'migrations before the failure must remain applied — no cross-file rollback');

  fs.rmSync(tempDrizzleDir, { recursive: true, force: true });
  client.close();
});

// --- K: schema verification (structural equivalence to a fully-migrated reference DB) ---

test('K: the selectively-migrated database is structurally identical to a database fully migrated by the existing, already-verified mechanism', async () => {
  const selectiveDbFile = freshDbPath('k');
  const referenceDbFile = freshDbPath('k-reference');
  cleanupDbFile(referenceDbFile);

  const selectiveClient = await buildPreMigrationDb(selectiveDbFile);
  const runResult = await runTargetMigrations(selectiveClient, drizzleDir, { environmentLabel: 'local-test', expectedEnvironmentLabel: 'local-test' });
  assert.equal(runResult.status, 'success');

  // Reference DB is built from exactly the migrations TARGET_MIGRATIONS
  // currently covers, not "every .sql file in drizzleDir" — drizzleDir can
  // (and, over this project's history, repeatedly has) contained newer
  // migration files that exist on disk but are deliberately NOT yet in
  // TARGET_MIGRATIONS (that allowlist is a pinned, reviewed, production-
  // controlled-apply scope — see this runner's own header comment and
  // EXPECTED_MIGRATION_SHA256; extending it is its own separate, deliberate
  // decision, not an implicit side effect of adding a new migration file).
  // Deriving the boundary from TARGET_MIGRATIONS itself (maxTargetPrefix
  // below), rather than hardcoding a specific migration number here, keeps
  // this test's actual invariant meaningful ("selective apply == full apply,
  // for the migrations both mechanisms agree are in scope") permanently —
  // it never needs updating just because TARGET_MIGRATIONS grows, and never
  // asserts anything about migrations it hasn't been extended to yet.
  const maxTargetPrefix = TARGET_MIGRATIONS[TARGET_MIGRATIONS.length - 1].slice(0, 4);
  const inScopeFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql') && f.slice(0, 4) <= maxTargetPrefix).sort();
  const tempReferenceDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-k-reference-'));
  for (const file of inScopeFiles) {
    fs.copyFileSync(path.join(drizzleDir, file), path.join(tempReferenceDrizzleDir, file));
  }

  const referenceClient = createClient({ url: `file:${referenceDbFile}` });
  await applyMigrationsLibsql(referenceClient, tempReferenceDrizzleDir); // full 0000-0021 in one shot, the same mechanism every other test in this repo already trusts

  // Structural equivalence, not incidental-text equivalence: runTargetMigrations()
  // submits each statement via splitStatements(), which strips `--` comments
  // (including ones embedded mid-CREATE-TABLE, between column definitions —
  // several of the corpus-admission migrations use this style heavily)
  // before calling client.migrate(); applyMigrationsLibsql() instead submits
  // each file's raw, unmodified text via client.executeMultiple(), so SQLite
  // stores the ORIGINAL comment text verbatim in sqlite_master.sql for the
  // reference DB. Both are equally valid SQL — the actual columns,
  // constraints, and index definitions are identical either way — so
  // stripSqlLineComments() is applied here to both sides before comparing,
  // normalizing away exactly (and only) that incidental difference. A real
  // structural drift (a missing column, a changed type, a different
  // constraint) still fails this comparison, since only comment TEXT is
  // stripped, nothing else.
  const schemaOf = async (client) => {
    const result = await client.execute("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name != 'sqlite_sequence' ORDER BY name");
    return result.rows.map((r) => `${r.name}::${stripSqlLineComments(String(r.sql))}`).sort();
  };

  assert.deepEqual(await schemaOf(selectiveClient), await schemaOf(referenceClient), 'applying 0000-0011 then 0012-0036 via this runner must produce a structurally identical schema to applying 0000-0036 all at once');

  selectiveClient.close();
  referenceClient.close();
  cleanupDbFile(referenceDbFile);
  fs.rmSync(tempReferenceDrizzleDir, { recursive: true, force: true });
});

// --- L: no credential logging -----------------------------------------------

test('L (structural): the CLI wrapper never logs a raw token/url variable, only the derived hostnameLabel', () => {
  const source = fs.readFileSync(path.join(repo, 'tools/apply-e8-tables-migration.ts'), 'utf8');
  const consoleCalls = source.split(/\r?\n/).filter((l) => /console\.(log|error)/.test(l));
  for (const line of consoleCalls) {
    assert.doesNotMatch(line, /\bauthToken\b/, `must never log authToken directly: "${line.trim()}"`);
    // The only place `url` may appear in a console call is inside hostnameLabel(url) — never bare.
    if (/\burl\b/.test(line)) {
      assert.match(line, /hostnameLabel\(url\)/, `"url" must only ever be logged via hostnameLabel(): "${line.trim()}"`);
    }
  }
});

test('L (functional): loadEnvFile correctly reads a value, and hostnameLabel never returns the token', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-env-'));
  const fakeSecret = 'super-secret-fake-value-should-never-leak-xyz123';
  fs.writeFileSync(path.join(tempDir, 'fake.env'), `SOME_FAKE_TOKEN=${fakeSecret}\nSOME_FAKE_URL=libsql://myapp-prod-org.turso.io\n`);

  const readSecret = loadEnvFile(tempDir, 'fake.env', 'SOME_FAKE_TOKEN');
  assert.equal(readSecret, fakeSecret, 'loadEnvFile must correctly read the value (proving the negative claim above is meaningful, not vacuous)');

  const readUrl = loadEnvFile(tempDir, 'fake.env', 'SOME_FAKE_URL');
  const label = hostnameLabel(readUrl);
  assert.equal(label, 'myapp-prod-org');
  assert.doesNotMatch(label, new RegExp(fakeSecret), 'hostnameLabel must never contain the secret');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('parseArgs correctly parses CLI flags used by the tool', () => {
  assert.deepEqual(parseArgs(['--env=production', '--execute', '--confirm=APPLY-TO-PRODUCTION']), {
    env: 'production',
    execute: true,
    confirm: 'APPLY-TO-PRODUCTION',
  });
  assert.deepEqual(parseArgs(['--env=local', '--db-file=/tmp/x.db']), { env: 'local', 'db-file': '/tmp/x.db' });
});

// --- tableSetState unit coverage --------------------------------------------

test('tableSetState correctly distinguishes none/all/partial', async () => {
  const dbFile = freshDbPath('e');
  const client = await buildPreMigrationDb(dbFile);
  assert.equal(await tableSetState(client, ['document_identities']), 'none');
  await client.execute('CREATE TABLE document_identities (id TEXT PRIMARY KEY)');
  assert.equal(await tableSetState(client, ['document_identities']), 'all');
  assert.equal(await tableSetState(client, ['document_identities', 'document_families']), 'partial');
  client.close();
});

test('columnSetState correctly distinguishes none/all/partial, and treats an empty column list as vacuously "all"', async () => {
  const dbFile = freshDbPath('e2');
  const client = await buildPreMigrationDb(dbFile);
  const columns = [
    { table: 'saved_reports', column: 'document_identity_id' },
    { table: 'users', column: 'corpus_reuse_consented_at' },
  ];
  assert.equal(await columnSetState(client, columns), 'none');
  await client.execute('ALTER TABLE saved_reports ADD COLUMN document_identity_id TEXT');
  assert.equal(await columnSetState(client, columns), 'partial');
  await client.execute('ALTER TABLE users ADD COLUMN corpus_reuse_consented_at TEXT');
  assert.equal(await columnSetState(client, columns), 'all');
  assert.equal(await columnSetState(client, []), 'all', 'a migration declaring zero columns has nothing left to apply');
  client.close();
});
