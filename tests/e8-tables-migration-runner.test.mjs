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
  scanForDestructiveStatements,
  splitStatements,
  sha256,
  checkPreflight,
  tableSetState,
  columnSetState,
  runTargetMigrations,
} from '../lib/e8-tables-migration-runner.ts';
import { loadEnvFile, hostnameLabel, parseArgs } from '../tools/apply-e8-tables-migration.ts';

/**
 * Phase E8E-D.1: tests for the isolated 0012-0023 migration runner.
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
  for (const name of ['a', 'b', 'b2', 'c', 'd', 'e', 'e2', 'f', 'g', 'h', 'i', 'j', 'k', 'happy', 'idempotent']) {
    cleanupDbFile(freshDbPath(name));
  }
});

// --- A: explicit allowlist ------------------------------------------------

test('A: TARGET_MIGRATIONS is an explicit allowlist of exactly 0012-0023, in order, never touching 0000-0011', () => {
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
  ]);
  // Phase E8S Step 8: 0022_reuse_context_declarations.sql added
  // reuse_context_declarations, bringing the 15 E1-E8P tables across the
  // original 10 migrations to 16 across 11. Privacy hardening's
  // 0023_privacy_consent_and_report_identity_link.sql adds zero new tables
  // (it only adds columns to the already-existing saved_reports/users
  // tables — see EXPECTED_COLUMNS_BY_MIGRATION), so this stays 16 across
  // all 12 target migrations, not 17.
  assert.equal(ALL_TARGET_TABLES.length, 16, 'expected exactly the 16 E1-E8S tables across all 12 target migrations');
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

test('G: scanForDestructiveStatements finds real destructive keywords and finds none in the actual 12 target migration files', () => {
  assert.deepEqual(scanForDestructiveStatements('CREATE TABLE IF NOT EXISTS x (id TEXT);'), []);
  assert.ok(scanForDestructiveStatements('DROP TABLE document_chunks;').length > 0);
  assert.ok(scanForDestructiveStatements('DELETE FROM users WHERE 1=1;').length > 0);
  assert.ok(scanForDestructiveStatements('ALTER TABLE users DROP COLUMN email;').length > 0);
  assert.ok(scanForDestructiveStatements('TRUNCATE TABLE users;').length > 0);
  // a comment merely mentioning the word must not trigger a false positive
  assert.deepEqual(scanForDestructiveStatements('-- this migration never uses DROP TABLE or DELETE FROM\nCREATE TABLE IF NOT EXISTS x (id TEXT);'), []);

  for (const file of TARGET_MIGRATIONS) {
    const content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
    assert.deepEqual(scanForDestructiveStatements(content), [], `${file} must contain zero destructive statements`);
    assert.equal(sha256(content), EXPECTED_MIGRATION_SHA256[file], `${file}'s pinned hash must match its current content`);
  }
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

// --- Section 9: disposable local DB — full happy-path run ------------------

test('SECTION 9: fresh pre-0012 database — the runner applies all 12 migrations in order, creates all 16 tables, adds 0023\'s columns, and preserves legacy row VALUES exactly', async () => {
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

  // Apply exactly 0012-0022 for real (via a temp dir excluding 0023), then
  // hand-add only ONE of 0023's two columns — an "unexpected" partial state
  // no legitimate prior run of this runner could produce (0023 applies as a
  // single client.migrate() transaction, same as every other target
  // migration).
  const only0012to0022 = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-b2-'));
  for (const file of TARGET_MIGRATIONS.slice(0, -1)) {
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
  // currently covers (0000-0021), not "every .sql file in drizzleDir" —
  // as of Phase E8S Step 4, drizzle/0022_reuse_context_declarations.sql
  // exists on disk but is deliberately NOT in TARGET_MIGRATIONS yet (that
  // allowlist is a pinned, reviewed, production-controlled-apply scope —
  // see this runner's own header comment and EXPECTED_MIGRATION_SHA256;
  // extending it is its own separate, deliberate decision, not an implicit
  // side effect of adding a new migration file). Copying only the in-scope
  // files into a temp dir keeps this test's actual invariant meaningful
  // ("selective apply == full apply, for the migrations both mechanisms
  // agree are in scope") without asserting anything about migrations
  // TARGET_MIGRATIONS hasn't been extended to yet.
  const maxTargetPrefix = TARGET_MIGRATIONS[TARGET_MIGRATIONS.length - 1].slice(0, 4);
  const inScopeFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql') && f.slice(0, 4) <= maxTargetPrefix).sort();
  const tempReferenceDrizzleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e8-k-reference-'));
  for (const file of inScopeFiles) {
    fs.copyFileSync(path.join(drizzleDir, file), path.join(tempReferenceDrizzleDir, file));
  }

  const referenceClient = createClient({ url: `file:${referenceDbFile}` });
  await applyMigrationsLibsql(referenceClient, tempReferenceDrizzleDir); // full 0000-0021 in one shot, the same mechanism every other test in this repo already trusts

  const schemaOf = async (client) => {
    const result = await client.execute("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name != 'sqlite_sequence' ORDER BY name");
    return result.rows.map((r) => `${r.name}::${r.sql}`).sort();
  };

  assert.deepEqual(await schemaOf(selectiveClient), await schemaOf(referenceClient), 'applying 0000-0011 then 0012-0021 via this runner must produce an identical schema to applying 0000-0021 all at once');

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
