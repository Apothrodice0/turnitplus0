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

  // 0023, 0025, 0027 and 0046 also excluded here: unlike every migration from
  // 0012-0022 (which only ever *reference* users(id) declaratively inside a
  // new CREATE TABLE — never checked by SQLite until an actual insert, so
  // those are fine without users existing yet), 0023/0025/0046 all do
  // `ALTER TABLE users ADD COLUMN`, and 0027 both alters saved_reports AND
  // reads its own user_id column in its backfill UPDATE — all require
  // users/saved_reports.user_id to already physically exist. In any real
  // migration run this is a non-issue (files always apply in filename
  // order, so 0009-0011 always run before any of them) — this exclusion
  // only matters for this test's own artificial "simulate a pre-Phase-2A
  // database" scenario, which none of them have any bearing on and is not
  // what this block is verifying.
  applyMigrationsExcluding(db, drizzleDir, ['0009_users.sql', '0010_sessions.sql', '0011_saved_reports_user_id.sql', '0023_privacy_consent_and_report_identity_link.sql', '0025_users_role.sql', '0027_saved_reports_room_number.sql', '0046_email_verification_challenges.sql']);

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

// --- Section G: Device Passport actor-usage ledger (drizzle/0041) — fresh
// migrate proof on both engines that the append-only device_passport_actor_usage
// table (composite PK + RESTRICT FK + per-passport index) and the additive
// device_passports.actor_usage_tracking_version column (NOT NULL DEFAULT 0,
// backfilling every existing passport to 0) all land, and that device_passports
// is only ADDED to, never restructured. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_actor_ledger_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, drizzleDir);

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  assert(tables.has('device_passport_actor_usage'), '[sqlite] 0041 must create device_passport_actor_usage');

  const cols = db.prepare(`PRAGMA table_info('device_passport_actor_usage')`).all();
  assert.deepEqual(
    cols.map((c) => c.name).sort(),
    ['actor_key', 'actor_key_version', 'device_passport_id', 'first_observed_at', 'is_anonymous', 'last_observed_at', 'observation_count'].sort(),
    '[sqlite] device_passport_actor_usage has exactly the drizzle/0041 columns',
  );
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  assert.deepEqual(pk, ['device_passport_id', 'actor_key_version', 'actor_key'], '[sqlite] composite primary key (passport, key version, key)');

  const passportCols = new Set(db.prepare(`PRAGMA table_info('device_passports')`).all().map((r) => r.name));
  assert(passportCols.has('actor_usage_tracking_version'), '[sqlite] 0041 must add device_passports.actor_usage_tracking_version');
  // additive only — the pre-0041 device_passports columns all still exist
  for (const stable of ['id', 'public_key_spki', 'algorithm', 'created_at', 'last_seen_at', 'revoked_at', 'provenance_generation']) {
    assert(passportCols.has(stable), `[sqlite] device_passports.${stable} must be preserved by 0041`);
  }

  // Every existing passport row backfills to actor_usage_tracking_version 0.
  db.prepare(`INSERT INTO device_passports (id, public_key_spki, created_at) VALUES (?,?,?)`).run('al-p1', Buffer.from('spki'), Date.now());
  assert.equal(
    db.prepare(`SELECT actor_usage_tracking_version FROM device_passports WHERE id = ?`).get('al-p1').actor_usage_tracking_version,
    0,
    '[sqlite] a passport with no explicit tracking version rests at 0 (history not proven complete)',
  );

  // FK is ON DELETE RESTRICT, and observation_count defaults to 1.
  const fk = db.prepare(`PRAGMA foreign_key_list('device_passport_actor_usage')`).all().find((r) => r.from === 'device_passport_id');
  assert.equal(fk.table, 'device_passports');
  assert.equal(fk.on_delete, 'RESTRICT', '[sqlite] device_passport_id -> device_passports must be ON DELETE RESTRICT');
  db.prepare(`INSERT INTO device_passport_actor_usage (device_passport_id, actor_key_version, actor_key, first_observed_at, last_observed_at) VALUES (?,?,?,?,?)`)
    .run('al-p1', 1, '__anonymous__', 1000, 1000);
  assert.equal(
    db.prepare(`SELECT observation_count, is_anonymous FROM device_passport_actor_usage WHERE device_passport_id = ?`).get('al-p1').observation_count,
    1,
    '[sqlite] observation_count defaults to 1',
  );
  assert.throws(
    () => db.prepare(`DELETE FROM device_passports WHERE id = ?`).run('al-p1'),
    /FOREIGN KEY constraint failed/,
    '[sqlite] a passport referenced by a usage observation cannot be removed (RESTRICT)',
  );

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] Device Passport actor-usage ledger: table + column land, composite PK, RESTRICT FK, defaults, no device_passports restructure');
}

{
  const dbFile = path.join(repo, 'test_migration_integrity_actor_ledger_libsql.db');
  cleanupSqliteFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, drizzleDir);
  await client.execute('PRAGMA foreign_keys = ON');

  const tableRows = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  assert(new Set(tableRows.rows.map((r) => String(r.name))).has('device_passport_actor_usage'), '[libsql] 0041 must create device_passport_actor_usage');

  const passportInfo = await client.execute("PRAGMA table_info('device_passports')");
  assert(passportInfo.rows.some((r) => String(r.name) === 'actor_usage_tracking_version'), '[libsql] 0041 must add device_passports.actor_usage_tracking_version');

  // Append-only UPSERT semantics behaviourally: repeat triple preserves
  // first_observed_at, advances last_observed_at, increments observation_count.
  await client.execute({ sql: 'INSERT INTO device_passports (id, public_key_spki, created_at, actor_usage_tracking_version) VALUES (?,?,?,1)', args: ['al-lp1', Buffer.from('k'), Date.now()] });
  const upsert = `INSERT INTO device_passport_actor_usage (device_passport_id, actor_key_version, actor_key, is_anonymous, first_observed_at, last_observed_at, observation_count)
                  VALUES (?,?,?,?,?,?,1)
                  ON CONFLICT (device_passport_id, actor_key_version, actor_key) DO UPDATE SET
                    last_observed_at = max(device_passport_actor_usage.last_observed_at, excluded.last_observed_at),
                    observation_count = device_passport_actor_usage.observation_count + 1`;
  await client.execute({ sql: upsert, args: ['al-lp1', 1, 'actor-x', 0, 100, 100] });
  await client.execute({ sql: upsert, args: ['al-lp1', 1, 'actor-x', 0, 250, 250] });
  const row = (await client.execute({ sql: 'SELECT * FROM device_passport_actor_usage WHERE device_passport_id = ? AND actor_key = ?', args: ['al-lp1', 'actor-x'] })).rows[0];
  assert.equal(Number(row.first_observed_at), 100, '[libsql] first_observed_at preserved across the repeat observation');
  assert.equal(Number(row.last_observed_at), 250, '[libsql] last_observed_at advanced');
  assert.equal(Number(row.observation_count), 2, '[libsql] observation_count incremented, no duplicate row');

  await assert.rejects(
    () => client.execute({ sql: 'DELETE FROM device_passports WHERE id = ?', args: ['al-lp1'] }),
    /FOREIGN KEY constraint failed/,
    '[libsql] RESTRICT blocks removing a passport with a usage observation',
  );

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] Device Passport actor-usage ledger: table/column land; append-only UPSERT + RESTRICT enforced');
}

// --- Section H: Account Identity foundation (drizzle/0045) — fresh-migrate
// proof on both engines that the two additive tables (account_identity_profiles
// 1:1 with users via a PRIMARY-KEY foreign key, account_identity_fingerprints)
// land with their CHECK constraints and ON DELETE CASCADE, and that `users` and
// every other pre-existing table are only depended on, never restructured. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_account_identity_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  // Apply everything EXCEPT 0046 so this section proves 0045's effect in
  // isolation (0046 is the migration that adds users.email_verified_at — see
  // Section I).
  applyMigrationsExcluding(db, drizzleDir, ['0046_email_verification_challenges.sql']);

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of ['account_identity_profiles', 'account_identity_fingerprints']) {
    assert(tables.has(t), `[sqlite] 0045 must create ${t}`);
  }

  // users is only depended on — never altered by 0045.
  const userCols = db.prepare(`PRAGMA table_info('users')`).all().map((r) => r.name).sort();
  assert.deepEqual(
    userCols,
    ['corpus_reuse_consented_at', 'created_at', 'email', 'id', 'password_hash', 'role', 'updated_at', 'username'].sort(),
    '[sqlite] 0045 must not add any column to users',
  );

  // profile is 1:1 with users and CASCADE-cleaned.
  const profFk = db.prepare(`PRAGMA foreign_key_list('account_identity_profiles')`).all().find((r) => r.from === 'user_id');
  assert.equal(profFk.table, 'users');
  assert.equal(profFk.on_delete, 'CASCADE', '[sqlite] profile.user_id -> users is ON DELETE CASCADE');
  const profPk = db.prepare(`PRAGMA table_info('account_identity_profiles')`).all().filter((r) => r.pk > 0).map((r) => r.name);
  assert.deepEqual(profPk, ['user_id'], '[sqlite] user_id is the 1:1 primary key');

  db.prepare(`INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)`).run('mi-ai-1', 'mi-ai-1@e.test', 'mi-ai-1', 'h');
  // full_name is NOT NULL
  assert.throws(
    () => db.prepare(`INSERT INTO account_identity_profiles (user_id, account_type, institution_status, city_status, normalization_version, created_at, updated_at) VALUES ('mi-ai-1','student','NONE','NONE',1,1,1)`).run(),
    /NOT NULL constraint failed/,
    '[sqlite] full_name is NOT NULL',
  );
  // account_type CHECK
  assert.throws(
    () => db.prepare(`INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, normalization_version, created_at, updated_at) VALUES ('mi-ai-1','wizard','n','NONE','NONE',1,1,1)`).run(),
    /CHECK constraint failed/,
    '[sqlite] account_type CHECK rejects an unknown type',
  );
  // E.164 backstop CHECK rejects a value GLOB '+[1-9]*' alone would accept
  assert.throws(
    () => db.prepare(`INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, phone_e164, normalization_version, created_at, updated_at) VALUES ('mi-ai-1','student','n','NONE','NONE','+1abcdefg',1,1,1)`).run(),
    /CHECK constraint failed/,
    '[sqlite] E.164 CHECK rejects non-digit characters after the +',
  );
  // valid row, verification columns rest at NULL
  db.prepare(`INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, phone_e164, phone_region, normalization_version, created_at, updated_at) VALUES ('mi-ai-1','student','Test Name','NONE','NONE','+14155552671','US',1,1,1)`).run();
  const restRow = db.prepare(`SELECT email_verified_at, phone_verified_at, institution_verified_at FROM account_identity_profiles WHERE user_id = 'mi-ai-1'`).get();
  assert.equal(restRow.email_verified_at, null);
  assert.equal(restRow.phone_verified_at, null);
  assert.equal(restRow.institution_verified_at, null);
  // fingerprint FK + CASCADE
  db.prepare(`INSERT INTO account_identity_fingerprints (id, user_id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at) VALUES ('mi-fp-1','mi-ai-1','VERIFIED_EMAIL','abc',1,1,1)`).run();
  db.prepare(`DELETE FROM users WHERE id = 'mi-ai-1'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM account_identity_profiles WHERE user_id = 'mi-ai-1'`).get().c, 0, '[sqlite] profile CASCADE-deletes with the account');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM account_identity_fingerprints WHERE user_id = 'mi-ai-1'`).get().c, 0, '[sqlite] fingerprints CASCADE-delete with the account');

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] Account Identity foundation: 2 tables land, users unchanged, 1:1 PK-FK, full_name NOT NULL, account_type + E.164 CHECK + CASCADE enforced');
}

{
  const dbFile = path.join(repo, 'test_migration_integrity_account_identity_libsql.db');
  cleanupSqliteFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, drizzleDir);
  await client.execute('PRAGMA foreign_keys = ON');

  const tableRows = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set(tableRows.rows.map((r) => String(r.name)));
  for (const t of ['account_identity_profiles', 'account_identity_fingerprints']) {
    assert(tables.has(t), `[libsql] 0045 must create ${t}`);
  }

  await client.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: ['li-ai-1', 'li-ai-1@e.test', 'li-ai-1', 'h'] });
  // consistency CHECK: a NONE institution status cannot carry a ror id
  await assert.rejects(
    () => client.execute({
      sql: `INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, institution_ror_id, city_status, normalization_version, created_at, updated_at) VALUES ('li-ai-1','student','n','NONE','03vek6s52','NONE',1,1,1)`,
    }),
    /CHECK constraint failed/,
    '[libsql] institution consistency CHECK rejects NONE + ror id',
  );
  // E.164 backstop CHECK: '++1234567' passes GLOB '+[1-9]*' (the '+' after position 1 is swallowed by '*') but must be rejected
  await assert.rejects(
    () => client.execute({
      sql: `INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, phone_e164, normalization_version, created_at, updated_at) VALUES ('li-ai-1','student','n','NONE','NONE','++1234567',1,1,1)`,
    }),
    /CHECK constraint failed/,
    '[libsql] E.164 CHECK rejects a doubled leading +',
  );
  await client.execute({ sql: `INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, normalization_version, created_at, updated_at) VALUES ('li-ai-1','instructor','Test Name','NONE','NONE',1,1,1)` });
  // 1:1
  await assert.rejects(
    () => client.execute({ sql: `INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, normalization_version, created_at, updated_at) VALUES ('li-ai-1','student','n','NONE','NONE',1,1,1)` }),
    /UNIQUE constraint failed|PRIMARY KEY/,
    '[libsql] a second profile row for one account is rejected',
  );
  await client.execute({ sql: `DELETE FROM users WHERE id = 'li-ai-1'` });
  assert.equal(Number((await client.execute("SELECT COUNT(*) c FROM account_identity_profiles WHERE user_id = 'li-ai-1'")).rows[0].c), 0, '[libsql] profile CASCADE-deletes with the account');

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] Account Identity foundation: tables land; full_name NOT NULL, consistency + E.164 CHECK, 1:1 + CASCADE enforced');
}

// --- Section I: Email Verification foundation (drizzle/0046) — proof on both
// engines that 0046 (a) adds EXACTLY users.email_verified_at (nullable, the new
// authoritative marker), (b) creates email_verification_challenges with its
// user_id -> users ON DELETE CASCADE, UNIQUE token_digest index and CHECK
// constraints, (c) leaves account_identity_profiles.email_verified_at in place
// but VESTIGIAL, and (d) restructures nothing else. Upgrade-path style
// (0000..0045 first, then 0046) so the users column delta is measured. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_email_verification_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  applyMigrationsExcluding(db, drizzleDir, ['0046_email_verification_challenges.sql']);

  // pre-0046 users shape
  const usersBefore = db.prepare(`PRAGMA table_info('users')`).all().map((r) => r.name).sort();
  assert.deepEqual(
    usersBefore,
    ['corpus_reuse_consented_at', 'created_at', 'email', 'id', 'password_hash', 'role', 'updated_at', 'username'].sort(),
    '[sqlite] pre-0046 users shape baseline',
  );
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).includes('email_verification_challenges'), '[sqlite] challenge table absent before 0046');

  db.exec(fs.readFileSync(path.join(drizzleDir, '0046_email_verification_challenges.sql'), 'utf8'));

  // (a) 0046 added EXACTLY users.email_verified_at, nullable.
  const usersAfter = db.prepare(`PRAGMA table_info('users')`).all();
  const newUserCols = usersAfter.map((r) => r.name).filter((n) => !usersBefore.includes(n));
  assert.deepEqual(newUserCols, ['email_verified_at'], '[sqlite] 0046 adds exactly users.email_verified_at');
  assert.equal(usersAfter.find((r) => r.name === 'email_verified_at').notnull, 0, '[sqlite] users.email_verified_at is nullable');
  db.prepare(`INSERT INTO users (id, email, username, password_hash) VALUES ('mi-ev-baseline','mi-ev-baseline@e.test','mib','h')`).run();
  assert.equal(db.prepare(`SELECT email_verified_at FROM users WHERE id = 'mi-ev-baseline'`).get().email_verified_at, null, '[sqlite] a fresh account defaults to unverified (NULL)');

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  assert(tables.has('email_verification_challenges'), '[sqlite] 0046 must create email_verification_challenges');

  const cols = db.prepare(`PRAGMA table_info('email_verification_challenges')`).all();
  assert.deepEqual(
    cols.map((c) => c.name).sort(),
    ['consumed_at', 'created_at', 'email', 'expires_at', 'id', 'revoked_at', 'token_digest', 'user_id'].sort(),
    '[sqlite] email_verification_challenges has exactly the drizzle/0046 columns',
  );
  for (const notNull of ['id', 'user_id', 'email', 'token_digest', 'created_at', 'expires_at']) {
    assert.equal(cols.find((c) => c.name === notNull).notnull, 1, `[sqlite] email_verification_challenges.${notNull} is NOT NULL`);
  }
  for (const nullable of ['consumed_at', 'revoked_at']) {
    assert.equal(cols.find((c) => c.name === nullable).notnull, 0, `[sqlite] email_verification_challenges.${nullable} is nullable`);
  }

  // (c) account_identity_profiles is otherwise untouched — its now-vestigial
  // email_verified_at column is still present (kept for schema compatibility).
  const profCols = db.prepare(`PRAGMA table_info('account_identity_profiles')`).all().map((r) => r.name);
  assert(profCols.includes('email_verified_at'), '[sqlite] account_identity_profiles.email_verified_at is retained (deprecated, not dropped)');
  assert(!profCols.includes('email_verification_challenge_id'), '[sqlite] 0046 must not add a column to account_identity_profiles');

  const fk = db.prepare(`PRAGMA foreign_key_list('email_verification_challenges')`).all().find((r) => r.from === 'user_id');
  assert.equal(fk.table, 'users');
  assert.equal(fk.on_delete, 'CASCADE', '[sqlite] user_id -> users must be ON DELETE CASCADE');

  const idxList = db.prepare(`PRAGMA index_list('email_verification_challenges')`).all();
  const uxDigest = idxList.find((r) => r.name === 'ux_email_verification_challenges_token_digest');
  assert(uxDigest && uxDigest.unique === 1, '[sqlite] token_digest index must be UNIQUE');
  assert(idxList.some((r) => r.name === 'idx_email_verification_challenges_user_created'), '[sqlite] the (user_id, created_at) lookup index must exist');

  // CHECK: token_digest length must be 64.
  db.prepare(`INSERT INTO users (id, email, username, password_hash) VALUES ('mi-ev-1','mi-ev-1@e.test','mi-ev-1','h')`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES ('c1','mi-ev-1','mi-ev-1@e.test','tooshort',1,2)`).run(),
    /CHECK constraint failed/,
    '[sqlite] token_digest length CHECK rejects a non-64-char digest',
  );
  // CHECK: expires_at must be after created_at.
  assert.throws(
    () => db.prepare(`INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES ('c2','mi-ev-1','mi-ev-1@e.test','${'a'.repeat(64)}',10,10)`).run(),
    /CHECK constraint failed/,
    '[sqlite] expires_at > created_at CHECK rejects a non-future expiry',
  );
  // valid row, consumed_at / revoked_at rest at NULL
  db.prepare(`INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES ('c3','mi-ev-1','mi-ev-1@e.test','${'a'.repeat(64)}',10,20)`).run();
  const restRow = db.prepare(`SELECT consumed_at, revoked_at FROM email_verification_challenges WHERE id = 'c3'`).get();
  assert.equal(restRow.consumed_at, null);
  assert.equal(restRow.revoked_at, null);
  // UNIQUE token_digest
  assert.throws(
    () => db.prepare(`INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES ('c4','mi-ev-1','mi-ev-1@e.test','${'a'.repeat(64)}',10,20)`).run(),
    /UNIQUE constraint failed/,
    '[sqlite] a duplicate token_digest is rejected',
  );
  // CASCADE on account delete
  db.prepare(`DELETE FROM users WHERE id = 'mi-ev-1'`).run();
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM email_verification_challenges WHERE user_id = 'mi-ev-1'`).get().c,
    0,
    '[sqlite] challenges CASCADE-delete with the account',
  );

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] Email Verification foundation: users.email_verified_at added, challenge table lands, profile column vestigial, CASCADE + UNIQUE digest + CHECKs enforced');
}

{
  const dbFile = path.join(repo, 'test_migration_integrity_email_verification_libsql.db');
  cleanupSqliteFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, drizzleDir);
  await client.execute('PRAGMA foreign_keys = ON');

  const tableRows = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  assert(new Set(tableRows.rows.map((r) => String(r.name))).has('email_verification_challenges'), '[libsql] 0046 must create email_verification_challenges');
  const userInfo = await client.execute("PRAGMA table_info('users')");
  assert(userInfo.rows.some((r) => String(r.name) === 'email_verified_at'), '[libsql] 0046 adds users.email_verified_at');

  await client.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: ['li-ev-1', 'li-ev-1@e.test', 'li-ev-1', 'h'] });
  assert.equal((await client.execute("SELECT email_verified_at FROM users WHERE id = 'li-ev-1'")).rows[0].email_verified_at, null, '[libsql] fresh account is unverified');
  const digest = 'b'.repeat(64);
  // single-use behavioural proof: the atomic conditional consume flips exactly once.
  await client.execute({
    sql: `INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES (?,?,?,?,?,?)`,
    args: ['li-c1', 'li-ev-1', 'li-ev-1@e.test', digest, 1000, 9_999_999_999_999],
  });
  const consume = `UPDATE email_verification_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`;
  const first = await client.execute({ sql: consume, args: [2000, 'li-c1', 2000] });
  const second = await client.execute({ sql: consume, args: [3000, 'li-c1', 3000] });
  assert.equal(Number(first.rowsAffected), 1, '[libsql] first consume succeeds');
  assert.equal(Number(second.rowsAffected), 0, '[libsql] a second consume is a no-op (single-use)');

  // revoked challenge cannot be consumed
  await client.execute({
    sql: `INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?)`,
    args: ['li-c2', 'li-ev-1', 'li-ev-1@e.test', 'c'.repeat(64), 1000, 9_999_999_999_999, 1500],
  });
  const revokedConsume = await client.execute({ sql: consume, args: [4000, 'li-c2', 4000] });
  assert.equal(Number(revokedConsume.rowsAffected), 0, '[libsql] a revoked challenge cannot be consumed');

  // atomic verify: consume + set users.email_verified_at land together;
  // a subsequent users.email change clears it and revokes challenges.
  await client.execute({
    sql: `INSERT INTO email_verification_challenges (id, user_id, email, token_digest, created_at, expires_at) VALUES (?,?,?,?,?,?)`,
    args: ['li-c3', 'li-ev-1', 'li-ev-1@e.test', 'd'.repeat(64), 1000, 9_999_999_999_999],
  });
  await client.batch(
    [
      { sql: consume, args: [5000, 'li-c3', 5000] },
      { sql: `UPDATE users SET email_verified_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM email_verification_challenges WHERE id = ? AND consumed_at = ?)`, args: [5000, 'li-ev-1', 'li-c3', 5000] },
    ],
    'write',
  );
  assert.equal(Number((await client.execute("SELECT email_verified_at FROM users WHERE id = 'li-ev-1'")).rows[0].email_verified_at), 5000, '[libsql] verify set users.email_verified_at');
  await client.batch(
    [
      { sql: `UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?`, args: ['li-ev-1-new@e.test', 'li-ev-1'] },
      { sql: `UPDATE email_verification_challenges SET revoked_at = ? WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`, args: [6000, 'li-ev-1'] },
    ],
    'write',
  );
  assert.equal((await client.execute("SELECT email_verified_at FROM users WHERE id = 'li-ev-1'")).rows[0].email_verified_at, null, '[libsql] email change cleared users.email_verified_at');

  await client.execute({ sql: `DELETE FROM users WHERE id = 'li-ev-1'` });
  assert.equal(
    Number((await client.execute("SELECT COUNT(*) c FROM email_verification_challenges WHERE user_id = 'li-ev-1'")).rows[0].c),
    0,
    '[libsql] challenges CASCADE-delete with the account',
  );

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] Email Verification foundation: users.email_verified_at authoritative; single-use consume + verify-atomicity + email-change clear + revoked-block + CASCADE enforced');
}

// --- Section J: built-in-archive parity foundation (0048) + 100k-scale
// scalable archive index (0049) — fresh-migrate proof on BOTH engines that:
// (a) 0048 creates archive_document_representations; (b) 0049 creates the
// three ordinary tables (archive_document_fingerprints, archive_hash_df_bands,
// archive_phrase_fts_map) with their indexes / composite PK / FK+CASCADE, and
// the archive_phrase_fts FTS5 virtual table + its shadow tables; (c) the
// contentless FTS index is queryable, joins the rowid bridge back to
// representation_id, and returns NULL for its own column; (d) a representation
// delete CASCADEs to the derived fingerprint and bridge rows; (e) nothing
// pre-existing is restructured — in particular corpus_document_shingles is
// only depended on, never altered. ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_archive_index_sqlite.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, drizzleDir);

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of [
    'archive_document_representations',
    'archive_document_fingerprints', 'archive_hash_df_bands', 'archive_phrase_fts_map',
    'archive_phrase_fts', 'archive_phrase_fts_data', 'archive_phrase_fts_idx', 'archive_phrase_fts_config',
  ]) {
    assert(tables.has(t), `[sqlite] 0048/0049 must create ${t}`);
  }

  // corpus_document_shingles is only depended on — 0049 adds no column to it.
  const shingleCols = db.prepare(`PRAGMA table_info('corpus_document_shingles')`).all().map((r) => r.name).sort();
  assert.deepEqual(
    shingleCols,
    ['created_at', 'fingerprint_version', 'id', 'representation_id', 'shingle_hash'].sort(),
    '[sqlite] 0049 must not alter corpus_document_shingles',
  );

  // archive_hash_df_bands: composite PK, WITHOUT ROWID uniqueness.
  const dfPk = db.prepare(`PRAGMA table_info('archive_hash_df_bands')`).all().filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
  assert.deepEqual(dfPk, ['shingle_hash', 'policy_version'], '[sqlite] archive_hash_df_bands composite PK (shingle_hash, policy_version)');
  db.prepare(`INSERT INTO archive_hash_df_bands (shingle_hash, df_bucket, policy_version) VALUES ('h1', 15, 'p1')`).run();
  db.prepare(`INSERT INTO archive_hash_df_bands (shingle_hash, df_bucket, policy_version) VALUES ('h1', 21, 'p2')`).run(); // same hash, different policy — allowed
  assert.throws(
    () => db.prepare(`INSERT INTO archive_hash_df_bands (shingle_hash, df_bucket, policy_version) VALUES ('h1', 18, 'p1')`).run(),
    /UNIQUE constraint failed|PRIMARY KEY/,
    '[sqlite] a duplicate (shingle_hash, policy_version) is rejected',
  );

  // A representation + its derived fingerprint / phrase-index rows.
  db.prepare(`INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, canonicalization_version) VALUES (?,?,?,?,?)`)
    .run('mi-arc-1', 'mi-arc-sha-1', 'a coastal aquaculture monitoring initiative recorded shellfish density', 8, 'v1');
  db.prepare(`INSERT INTO archive_document_representations (archive_article_id, representation_id, title, corpus_version, fingerprint_version) VALUES (?,?,?,?,?)`)
    .run('mi-arc-article-1', 'mi-arc-1', 'MI Archive Doc', 'corpus-v1', 'archive-shingle-v1');
  db.prepare(`INSERT INTO archive_document_fingerprints (representation_id, fingerprint_hash, optional_position, fingerprint_version) VALUES (?,?,?,?)`)
    .run('mi-arc-1', 'deadbeefdeadbeef', 3, 'archive-compact-fp-v1');
  assert.throws(
    () => db.prepare(`INSERT INTO archive_document_fingerprints (representation_id, fingerprint_hash, optional_position, fingerprint_version) VALUES (?,?,?,?)`)
      .run('mi-arc-1', 'deadbeefdeadbeef', 99, 'archive-compact-fp-v1'),
    /UNIQUE constraint failed/,
    '[sqlite] ux_archive_document_fingerprints_repr_version_hash rejects a duplicate (repr, version, hash)',
  );

  // FTS entry via the rowid bridge; exact-phrase MATCH; contentless NULL.
  const mapId = db.prepare(`INSERT INTO archive_phrase_fts_map(representation_id) VALUES (?)`).run('mi-arc-1').lastInsertRowid;
  db.prepare(`INSERT INTO archive_phrase_fts(rowid, body) VALUES (?, ?)`).run(mapId, 'a coastal aquaculture monitoring initiative recorded shellfish density');
  const ftsHit = db.prepare(`SELECT m.representation_id AS r FROM archive_phrase_fts f JOIN archive_phrase_fts_map m ON m.fts_rowid = f.rowid WHERE f.archive_phrase_fts MATCH ?`).all('"aquaculture monitoring initiative"');
  assert.deepEqual(ftsHit.map((x) => x.r), ['mi-arc-1'], '[sqlite] an exact-phrase MATCH joins the bridge back to representation_id');
  assert.equal(db.prepare(`SELECT body FROM archive_phrase_fts LIMIT 1`).get().body, null, '[sqlite] contentless FTS5 returns NULL for its indexed column');

  // Representation delete CASCADEs to fingerprints + the bridge.
  db.prepare(`DELETE FROM corpus_document_representations WHERE id = ?`).run('mi-arc-1');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM archive_document_fingerprints WHERE representation_id = 'mi-arc-1'`).get().c, 0, '[sqlite] fingerprints CASCADE-delete with the representation');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM archive_phrase_fts_map WHERE representation_id = 'mi-arc-1'`).get().c, 0, '[sqlite] the phrase-index bridge CASCADE-deletes with the representation');

  db.close();
  cleanupSqliteFile(dbPath);
  console.log('[sqlite] Scalable archive index: 0048/0049 tables + FTS5 virtual table land, composite PK + unique fingerprint index + FK CASCADE + contentless-NULL all verified');
}

{
  const dbFile = path.join(repo, 'test_migration_integrity_archive_index_libsql.db');
  cleanupSqliteFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, drizzleDir);
  await client.execute('PRAGMA foreign_keys = ON');

  const tableRows = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set(tableRows.rows.map((r) => String(r.name)));
  for (const t of ['archive_document_fingerprints', 'archive_hash_df_bands', 'archive_phrase_fts_map', 'archive_phrase_fts']) {
    assert(tables.has(t), `[libsql] 0049 must create ${t}`);
  }

  // The exact per-doc seed shape client.batch produces: a bridge row (auto
  // rowid) then the FTS row bound to that rowid via a subquery in the SAME
  // transaction.
  await client.execute({
    sql: "INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, canonicalization_version) VALUES (?,?,?,?,?)",
    args: ['li-arc-1', 'li-arc-sha-1', 'cooperative credit unions in the kabylie highlands adopted a tiered collateral model', 12, 'v1'],
  });
  await client.batch([
    { sql: "INSERT INTO archive_phrase_fts_map(representation_id) VALUES (?)", args: ['li-arc-1'] },
    { sql: "INSERT INTO archive_phrase_fts(rowid, body) SELECT fts_rowid, ? FROM archive_phrase_fts_map WHERE representation_id = ?", args: ['cooperative credit unions in the kabylie highlands adopted a tiered collateral model', 'li-arc-1'] },
  ], 'write');
  const hit = await client.execute({
    sql: "SELECT m.representation_id r FROM archive_phrase_fts f JOIN archive_phrase_fts_map m ON m.fts_rowid = f.rowid WHERE f.archive_phrase_fts MATCH ?",
    args: ['"tiered collateral model"'],
  });
  assert.deepEqual(hit.rows.map((x) => String(x.r)), ['li-arc-1'], '[libsql] the per-doc batch insert shape yields a joinable phrase entry');

  // fan-out COUNT (the DF-oracle query the phrase fallback uses).
  const fanOut = await client.execute({ sql: "SELECT COUNT(*) n FROM archive_phrase_fts f WHERE f.archive_phrase_fts MATCH ?", args: ['"kabylie highlands adopted"'] });
  assert.equal(Number(fanOut.rows[0].n), 1, '[libsql] a phrase fan-out COUNT works (== that phrase\'s document frequency)');

  // FTS5 'delete-all' clears the contentless index without DROP.
  await client.execute("INSERT INTO archive_phrase_fts(archive_phrase_fts) VALUES('delete-all')");
  await client.execute("DELETE FROM archive_phrase_fts_map");
  const afterClear = await client.execute({ sql: "SELECT COUNT(*) n FROM archive_phrase_fts f WHERE f.archive_phrase_fts MATCH ?", args: ['"tiered collateral model"'] });
  assert.equal(Number(afterClear.rows[0].n), 0, "[libsql] 'delete-all' + bridge wipe clears the phrase index for a clean rebuild");

  client.close();
  cleanupSqliteFile(dbFile);
  console.log('[libsql] Scalable archive index: per-doc batch insert shape, exact-phrase MATCH, fan-out COUNT, and delete-all rebuild all verified');
}

console.log('Migration schema integrity tests passed');
