import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import { applyMigrations, applyMigrationsLibsql } from '../lib/ingest.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');

const UNIQUE_INDEXES = [
  { name: 'ux_document_chunks_document_chunk_idx', table: 'document_chunks', columns: ['document_id', 'chunk_index'] },
  { name: 'ux_documents_provenance_sha256', table: 'documents', columns: ['provenance_sha256'] },
  { name: 'ux_index_versions_corpus_version', table: 'index_versions', columns: ['corpus_version'] },
];

function cleanupSqliteFile(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${file}${suffix}`); } catch (e) { /* ignore */ }
  }
}

// Test-local helper (not part of lib/ingest.ts): applies every drizzle/*.sql
// file except the ones named in `excludeFiles`, used only to reconstruct the
// pre-fix "0000-0004 applied, 0005 missing" state for the idempotency check.
function applyMigrationsExcluding(db, dir, excludeFiles) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !excludeFiles.includes(f)).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec(sql);
  }
}

// --- Section A: better-sqlite3, full fresh migration sequence ------------
{
  const dbPath = path.join(repo, 'test_migration_integrity_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  applyMigrations(db, drizzleDir);

  for (const idx of UNIQUE_INDEXES) {
    const indexList = db.prepare(`PRAGMA index_list('${idx.table}')`).all();
    const found = indexList.find((row) => row.name === idx.name);
    assert(found, `[sqlite] index ${idx.name} should exist on ${idx.table} after full migration`);
    assert.equal(found.unique, 1, `[sqlite] index ${idx.name} should be unique`);
    const indexInfo = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
    assert.deepEqual(indexInfo.map((row) => row.name), idx.columns, `[sqlite] index ${idx.name} should cover ${idx.columns.join(', ')}`);
  }

  // Behavioral proof: document_chunks(document_id, chunk_index) rejects duplicates
  db.prepare(`INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)`)
    .run('sqlite-doc-1', 'doc', 'sqlite-prov-1', 'Publication', 10, 0);
  db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)`)
    .run('sqlite-doc-1', 0, 10, 0);
  assert.throws(
    () => db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)`).run('sqlite-doc-1', 0, 10, 0),
    /UNIQUE constraint failed/,
    '[sqlite] duplicate (document_id, chunk_index) must be rejected',
  );

  // Behavioral proof: documents(provenance_sha256) rejects duplicates
  assert.throws(
    () => db.prepare(`INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)`)
      .run('sqlite-doc-2', 'doc2', 'sqlite-prov-1', 'Publication', 10, 0),
    /UNIQUE constraint failed/,
    '[sqlite] duplicate provenance_sha256 must be rejected',
  );

  // Behavioral proof: index_versions(corpus_version) rejects duplicates
  db.prepare(`INSERT INTO index_versions (corpus_version) VALUES (?)`).run('sqlite-corpus-v1');
  assert.throws(
    () => db.prepare(`INSERT INTO index_versions (corpus_version) VALUES (?)`).run('sqlite-corpus-v1'),
    /UNIQUE constraint failed/,
    '[sqlite] duplicate corpus_version must be rejected',
  );

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] full migration sequence: all three unique indexes present and enforced');
}

// --- Section B: libSQL, full fresh migration sequence ---------------------
{
  const dbFile = path.join(repo, 'test_migration_integrity_libsql.db');
  cleanupSqliteFile(dbFile);
  const dbUrl = `file:${dbFile}`;

  const client = createClient({ url: dbUrl });
  await applyMigrationsLibsql(client, drizzleDir);

  for (const idx of UNIQUE_INDEXES) {
    const indexList = await client.execute(`PRAGMA index_list('${idx.table}')`);
    const found = indexList.rows.find((row) => row.name === idx.name);
    assert(found, `[libsql] index ${idx.name} should exist on ${idx.table} after full migration`);
    assert.equal(Number(found.unique), 1, `[libsql] index ${idx.name} should be unique`);
    const indexInfo = await client.execute(`PRAGMA index_info('${idx.name}')`);
    assert.deepEqual(indexInfo.rows.map((row) => row.name), idx.columns, `[libsql] index ${idx.name} should cover ${idx.columns.join(', ')}`);
  }

  await client.execute({
    sql: 'INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)',
    args: ['libsql-doc-1', 'doc', 'libsql-prov-1', 'Publication', 10, 0],
  });
  await client.execute({
    sql: 'INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)',
    args: ['libsql-doc-1', 0, 10, 0],
  });
  await assert.rejects(
    () => client.execute({
      sql: 'INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)',
      args: ['libsql-doc-1', 0, 10, 0],
    }),
    /UNIQUE constraint failed/,
    '[libsql] duplicate (document_id, chunk_index) must be rejected',
  );

  await assert.rejects(
    () => client.execute({
      sql: 'INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)',
      args: ['libsql-doc-2', 'doc2', 'libsql-prov-1', 'Publication', 10, 0],
    }),
    /UNIQUE constraint failed/,
    '[libsql] duplicate provenance_sha256 must be rejected',
  );

  await client.execute({ sql: 'INSERT INTO index_versions (corpus_version) VALUES (?)', args: ['libsql-corpus-v1'] });
  await assert.rejects(
    () => client.execute({ sql: 'INSERT INTO index_versions (corpus_version) VALUES (?)', args: ['libsql-corpus-v1'] }),
    /UNIQUE constraint failed/,
    '[libsql] duplicate corpus_version must be rejected',
  );

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] full migration sequence: all three unique indexes present and enforced');
}

// --- Section C: upgrade path — 0005 layered onto an already-migrated,
// pre-fix database, proving the fix and its idempotency. 0007's own table
// rebuild also recreates this index defensively (so it isn't lost a second
// time if 0005 were ever skipped), so 0007 must be excluded too here or the
// "pre-fix" baseline would not actually reproduce the missing-index bug this
// section is specifically testing for.
{
  const dbPath = path.join(repo, 'test_migration_integrity_upgrade.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);

  applyMigrationsExcluding(db, drizzleDir, ['0005_restore_document_chunks_unique_index.sql', '0007_document_chunks_cascade.sql']);

  const beforeFix = db.prepare(`PRAGMA index_list('document_chunks')`).all();
  assert(
    !beforeFix.some((row) => row.name === 'ux_document_chunks_document_chunk_idx'),
    'pre-fix (0000-0004 only) database should reproduce the missing-index bug',
  );

  const fixSql = fs.readFileSync(path.join(drizzleDir, '0005_restore_document_chunks_unique_index.sql'), 'utf8');
  db.exec(fixSql);

  const afterFix = db.prepare(`PRAGMA index_list('document_chunks')`).all();
  const restored = afterFix.find((row) => row.name === 'ux_document_chunks_document_chunk_idx');
  assert(restored, '0005 must add the missing index to an already-migrated database');
  assert.equal(restored.unique, 1, 'restored index must be unique');

  // Re-applying 0005 a second time must not error (IF NOT EXISTS).
  assert.doesNotThrow(() => db.exec(fixSql), '0005 must be safe to re-apply');

  db.prepare(`INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)`)
    .run('upgrade-doc-1', 'doc', 'upgrade-prov-1', 'Publication', 10, 0);
  db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)`)
    .run('upgrade-doc-1', 0, 10, 0);
  assert.throws(
    () => db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)`).run('upgrade-doc-1', 0, 10, 0),
    /UNIQUE constraint failed/,
    'index restored via the upgrade path must actually be enforced',
  );

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[upgrade path] 0005 correctly restores and enforces the index on a pre-fix database, and is idempotent');
}

// --- Section D: upgrade path — 0007 layered onto an already-migrated,
// pre-fix (0000-0006, no cascade) database, proving the FK fix, the
// behavioral cascade-delete, and that the index survives this second table
// rebuild too. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_cascade.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);

  applyMigrationsExcluding(db, drizzleDir, ['0007_document_chunks_cascade.sql']);

  const beforeFix = db.prepare(`PRAGMA foreign_key_list('document_chunks')`).all();
  const beforeFk = beforeFix.find((row) => row.table === 'documents');
  assert.equal(beforeFk.on_delete, 'NO ACTION', 'pre-fix database should reproduce the missing-cascade regression');

  const fixSql = fs.readFileSync(path.join(drizzleDir, '0007_document_chunks_cascade.sql'), 'utf8');
  db.exec(fixSql);

  const afterFix = db.prepare(`PRAGMA foreign_key_list('document_chunks')`).all();
  const afterFk = afterFix.find((row) => row.table === 'documents');
  assert.equal(afterFk.on_delete, 'CASCADE', '0007 must set document_chunks.document_id to ON DELETE CASCADE');

  const indexList = db.prepare(`PRAGMA index_list('document_chunks')`).all();
  const restoredIndex = indexList.find((row) => row.name === 'ux_document_chunks_document_chunk_idx');
  assert(restoredIndex, '0007\'s table rebuild must not drop the unique index a second time');
  assert.equal(restoredIndex.unique, 1, 'index must still be unique after 0007');

  // Re-applying 0007 a second time must not error (IF NOT EXISTS on the index; CREATE TABLE IF NOT EXISTS on the rebuild target).
  assert.doesNotThrow(() => db.exec(fixSql), '0007 must be safe to re-apply');

  db.prepare(`INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count) VALUES (?,?,?,?,?,?)`)
    .run('cascade-doc-1', 'doc', 'cascade-prov-1', 'Publication', 5, 1);
  db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)`)
    .run('cascade-doc-1', 0, 5, 0);
  const chunkId = db.prepare(`SELECT id FROM document_chunks WHERE document_id = ?`).get('cascade-doc-1').id;
  db.prepare(`INSERT INTO chunk_fingerprints (chunk_id, shingle_hash, position) VALUES (?,?,?)`).run(chunkId, 'cascade-hash', 0);

  db.pragma('foreign_keys = ON');
  db.prepare(`DELETE FROM documents WHERE id = ?`).run('cascade-doc-1');

  const chunkCountAfterDelete = db.prepare(`SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?`).get('cascade-doc-1').cnt;
  const fingerprintCountAfterDelete = db.prepare(`SELECT COUNT(*) as cnt FROM chunk_fingerprints WHERE chunk_id = ?`).get(chunkId).cnt;
  assert.equal(chunkCountAfterDelete, 0, 'deleting the document must cascade-delete its chunks');
  assert.equal(fingerprintCountAfterDelete, 0, 'deleting the document must transitively cascade-delete its fingerprints via the chunk cascade');

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[upgrade path] 0007 correctly restores CASCADE, preserves the unique index, and cascade-deletes chunks + fingerprints');
}

// --- Section E: Phase 2A auth tables (0009 users, 0010 sessions, 0011
// saved_reports.user_id) — fresh-migrate proof on both engines, plus an
// upgrade-path proof that a pre-existing anonymous saved_reports row
// (inserted before 0011 added the user_id column) survives layering
// 0009-0011 on top and round-trips with user_id = NULL. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_auth_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, drizzleDir);

  // users.email unique index
  db.prepare(`INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)`)
    .run('sqlite-user-1', 'auth-sqlite@example.com', 'authuser', 'hash1');
  assert.throws(
    () => db.prepare(`INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)`)
      .run('sqlite-user-2', 'auth-sqlite@example.com', 'authuser2', 'hash2'),
    /UNIQUE constraint failed/,
    '[sqlite] duplicate users.email must be rejected',
  );

  // sessions.user_id cascades on user delete
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)`)
    .run('sqlite-session-1', 'sqlite-user-1', Date.now(), Date.now() + 1000);
  db.prepare(`DELETE FROM users WHERE id = ?`).run('sqlite-user-1');
  const sessionCount = db.prepare(`SELECT COUNT(*) as cnt FROM sessions WHERE token_hash = ?`).get('sqlite-session-1').cnt;
  assert.equal(sessionCount, 0, '[sqlite] deleting a user must cascade-delete its sessions');

  // saved_reports.user_id sets to NULL on user delete
  db.prepare(`INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)`)
    .run('sqlite-user-2', 'auth-sqlite-2@example.com', 'authuser2', 'hash2');
  db.prepare(`INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('sqlite-report-1', 'sqlite-device-1', 'sub-1', 'title', new Date().toISOString(), 10, 0, 'Low', '{}', 'sqlite-user-2');
  db.prepare(`DELETE FROM users WHERE id = ?`).run('sqlite-user-2');
  const reportUserId = db.prepare(`SELECT user_id FROM saved_reports WHERE id = ? AND device_key = ?`).get('sqlite-report-1', 'sqlite-device-1').user_id;
  assert.equal(reportUserId, null, '[sqlite] deleting a user must SET NULL on saved_reports.user_id, not cascade-delete the report');

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] Phase 2A auth tables: unique email, session cascade, saved_reports SET NULL all verified');
}

{
  const dbFile = path.join(repo, 'test_migration_integrity_auth_libsql.db');
  cleanupSqliteFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute('PRAGMA foreign_keys = ON');
  await applyMigrationsLibsql(client, drizzleDir);

  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
    args: ['libsql-user-1', 'auth-libsql@example.com', 'authuser', 'hash1'],
  });
  await assert.rejects(
    () => client.execute({
      sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
      args: ['libsql-user-2', 'auth-libsql@example.com', 'authuser2', 'hash2'],
    }),
    /UNIQUE constraint failed/,
    '[libsql] duplicate users.email must be rejected',
  );

  await client.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: ['libsql-session-1', 'libsql-user-1', Date.now(), Date.now() + 1000],
  });
  await client.execute({ sql: 'DELETE FROM users WHERE id = ?', args: ['libsql-user-1'] });
  const sessionResult = await client.execute({ sql: 'SELECT COUNT(*) as cnt FROM sessions WHERE token_hash = ?', args: ['libsql-session-1'] });
  assert.equal(Number(sessionResult.rows[0].cnt), 0, '[libsql] deleting a user must cascade-delete its sessions');

  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
    args: ['libsql-user-2', 'auth-libsql-2@example.com', 'authuser2', 'hash2'],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: ['libsql-report-1', 'libsql-device-1', 'sub-1', 'title', new Date().toISOString(), 10, 0, 'Low', '{}', 'libsql-user-2'],
  });
  await client.execute({ sql: 'DELETE FROM users WHERE id = ?', args: ['libsql-user-2'] });
  const reportResult = await client.execute({ sql: 'SELECT user_id FROM saved_reports WHERE id = ? AND device_key = ?', args: ['libsql-report-1', 'libsql-device-1'] });
  assert.equal(reportResult.rows[0].user_id, null, '[libsql] deleting a user must SET NULL on saved_reports.user_id');

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] Phase 2A auth tables: unique email, session cascade, saved_reports SET NULL all verified');
}

{
  const dbPath = path.join(repo, 'test_migration_integrity_auth_upgrade.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);

  // 0023, 0025, and 0027 also excluded here: unlike every migration from
  // 0012-0022 (which only ever *reference* users(id) declaratively inside a
  // new CREATE TABLE — never checked by SQLite until an actual insert, so
  // those are fine without users existing yet), 0023/0025 both do
  // `ALTER TABLE users ADD COLUMN`, and 0027 both alters saved_reports AND
  // reads its own user_id column in its backfill UPDATE — all three require
  // users/saved_reports.user_id to already physically exist. In any real
  // migration run this is a non-issue (files always apply in filename
  // order, so 0009-0011 always run before any of them) — this exclusion
  // only matters for this test's own artificial "simulate a pre-Phase-2A
  // database" scenario, which none of them have any bearing on and is not
  // what this block is verifying.
  applyMigrationsExcluding(db, drizzleDir, ['0009_users.sql', '0010_sessions.sql', '0011_saved_reports_user_id.sql', '0023_privacy_consent_and_report_identity_link.sql', '0025_users_role.sql', '0027_saved_reports_room_number.sql']);

  // Old-shape row: inserted before user_id existed on this table at all.
  db.prepare(`INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('upgrade-auth-report-1', 'upgrade-auth-device-1', 'sub-1', 'title', new Date().toISOString(), 10, 0, 'Low', '{}');

  for (const file of ['0009_users.sql', '0010_sessions.sql', '0011_saved_reports_user_id.sql']) {
    db.exec(fs.readFileSync(path.join(drizzleDir, file), 'utf8'));
  }

  const columns = db.prepare(`PRAGMA table_info('saved_reports')`).all();
  assert(columns.some((c) => c.name === 'user_id'), '0011 must add the user_id column to an already-migrated database');

  const row = db.prepare(`SELECT user_id FROM saved_reports WHERE id = ? AND device_key = ?`).get('upgrade-auth-report-1', 'upgrade-auth-device-1');
  assert.equal(row.user_id, null, 'a pre-existing anonymous row must round-trip with user_id = NULL after the upgrade, not be lost or errored on');

  // Re-applying all three is safe (IF NOT EXISTS / ALTER TABLE guarded by column absence isn't idempotent for ADD COLUMN in raw SQLite,
  // so only the CREATE TABLE/INDEX statements are re-checked here for idempotency; 0011's ADD COLUMN is intentionally not re-run twice).
  assert.doesNotThrow(() => db.exec(fs.readFileSync(path.join(drizzleDir, '0009_users.sql'), 'utf8')), '0009 must be safe to re-apply');
  assert.doesNotThrow(() => db.exec(fs.readFileSync(path.join(drizzleDir, '0010_sessions.sql'), 'utf8')), '0010 must be safe to re-apply');

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[upgrade path] 0009-0011 layer cleanly onto an already-migrated database; pre-existing saved_reports rows survive with user_id = NULL');
}

// --- Section F: Device Passport foundation (drizzle/0038-0040) — fresh
// migrate proof on both engines that the three additive tables, the two
// verified_device_passport_id columns, and the snapshot
// device_provenance_generation column all land, and that the immediately-
// adjacent legacy tables (saved_reports, report_historical_match_snapshots,
// corpus_admission_report_jobs) are only ADDED to, never restructured. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_device_passport_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, drizzleDir);

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of ['device_passports', 'device_passport_challenges', 'corpus_admission_decision_device_provenance']) {
    assert(tables.has(t), `[sqlite] 0038/0039 must create ${t}`);
  }
  assert(!tables.has('device_provenance_generation'), '[sqlite] there must be NO global device_provenance_generation table');

  const passportCols = new Set(db.prepare(`PRAGMA table_info('device_passports')`).all().map((r) => r.name));
  assert(passportCols.has('provenance_generation'), '[sqlite] device_passports.provenance_generation (per-passport counter) must exist');

  const snapshotCols = new Set(db.prepare(`PRAGMA table_info('report_historical_match_snapshots')`).all().map((r) => r.name));
  assert(snapshotCols.has('device_provenance_generation'), '[sqlite] 0040 must add report_historical_match_snapshots.device_provenance_generation');

  const savedReportCols = new Set(db.prepare(`PRAGMA table_info('saved_reports')`).all().map((r) => r.name));
  assert(savedReportCols.has('verified_device_passport_id'), '[sqlite] 0039 must add saved_reports.verified_device_passport_id');
  const jobCols = new Set(db.prepare(`PRAGMA table_info('corpus_admission_report_jobs')`).all().map((r) => r.name));
  assert(jobCols.has('verified_device_passport_id'), '[sqlite] 0039 must add corpus_admission_report_jobs.verified_device_passport_id');

  // The deduplicated representation table must gain no identity column.
  const repCols = new Set(db.prepare(`PRAGMA table_info('corpus_document_representations')`).all().map((r) => r.name));
  for (const forbidden of ['device_passport_id', 'verified_device_passport_id', 'account_id', 'user_id', 'email']) {
    assert(!repCols.has(forbidden), `[sqlite] corpus_document_representations must NOT gain "${forbidden}"`);
  }

  // FK actions on the per-backing provenance table.
  const provFks = db.prepare(`PRAGMA foreign_key_list('corpus_admission_decision_device_provenance')`).all();
  const decFk = provFks.find((r) => r.from === 'decision_id');
  const passFk = provFks.find((r) => r.from === 'device_passport_id');
  assert.equal(decFk.table, 'corpus_admission_decisions');
  assert.equal(decFk.on_delete, 'CASCADE', '[sqlite] decision_id -> corpus_admission_decisions must be ON DELETE CASCADE');
  assert.equal(passFk.table, 'device_passports');
  assert.equal(passFk.on_delete, 'RESTRICT', '[sqlite] device_passport_id -> device_passports must be ON DELETE RESTRICT');

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] Device Passport foundation: 3 tables + 3 columns land, no global generation table, no representation identity column, FK actions correct');
}

{
  const dbFile = path.join(repo, 'test_migration_integrity_device_passport_libsql.db');
  cleanupSqliteFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, drizzleDir);
  await client.execute('PRAGMA foreign_keys = ON');

  const tableRows = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set(tableRows.rows.map((r) => String(r.name)));
  for (const t of ['device_passports', 'device_passport_challenges', 'corpus_admission_decision_device_provenance']) {
    assert(tables.has(t), `[libsql] 0038/0039 must create ${t}`);
  }
  assert(!tables.has('device_provenance_generation'), '[libsql] there must be NO global device_provenance_generation table');

  const snapshotInfo = await client.execute("PRAGMA table_info('report_historical_match_snapshots')");
  assert(snapshotInfo.rows.some((r) => String(r.name) === 'device_provenance_generation'), '[libsql] 0040 must add device_provenance_generation');

  // Behavioral: RESTRICT blocks removing a referenced passport.
  await client.execute({ sql: 'INSERT INTO device_passports (id, public_key_spki, created_at) VALUES (?,?,?)', args: ['p-1', Buffer.from('spki'), Date.now()] });
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run) VALUES (?,?,?,?,?,?,?,?)`,
    args: ['d-1', 'src', 'v1', 'ACCEPT', '[]', 1, '[]', 0],
  });
  await client.execute({ sql: 'INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)', args: ['d-1', 'p-1', Date.now()] });
  await assert.rejects(
    () => client.execute({ sql: 'DELETE FROM device_passports WHERE id = ?', args: ['p-1'] }),
    /FOREIGN KEY constraint failed/,
    '[libsql] a passport referenced by a promoted backing cannot be removed (RESTRICT)',
  );
  await client.execute({ sql: 'DELETE FROM corpus_admission_decisions WHERE id = ?', args: ['d-1'] });
  const remaining = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', args: ['d-1'] });
  assert.equal(Number(remaining.rows[0].c), 0, '[libsql] removing the decision cascade-removes its device provenance');

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] Device Passport foundation: tables/columns land; RESTRICT + CASCADE FK actions enforced');
}

console.log('Migration schema integrity tests passed');
