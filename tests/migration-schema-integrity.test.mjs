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

// --- Section A: better-sqlite3, full fresh 0000-0005 sequence ------------
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
  console.log('[sqlite] full 0000-0005 migration sequence: all three unique indexes present and enforced');
}

// --- Section B: libSQL, full fresh 0000-0005 sequence ---------------------
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
  console.log('[libsql] full 0000-0005 migration sequence: all three unique indexes present and enforced');
}

// --- Section C: upgrade path — 0005 layered onto an already-migrated,
// pre-fix (0000-0004 only) database, proving the fix and its idempotency ---
{
  const dbPath = path.join(repo, 'test_migration_integrity_upgrade.db');
  cleanupSqliteFile(dbPath);
  const db = new Database(dbPath);

  applyMigrationsExcluding(db, drizzleDir, ['0005_restore_document_chunks_unique_index.sql']);

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

console.log('Migration schema integrity tests passed');
