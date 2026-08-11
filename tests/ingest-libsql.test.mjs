import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql, ingestDocumentLibsql } from '../lib/ingest.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_ingest_libsql.db');
const dbUrl = `file:${dbFile}`;

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const setupClient = createClient({ url: dbUrl });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

// 1) Raw atomicity proof for the installed @libsql/client version.
// Requirement: verify client.batch(..., "write") actually rolls back earlier
// statements when a later statement in the same batch fails, rather than
// trusting the documented behavior.
//
// Uses the documents.id PRIMARY KEY (defined directly in the original
// CREATE TABLE and never touched by any later migration) as the guaranteed
// constraint, rather than the document_chunks(document_id, chunk_index)
// unique index — that index is created by drizzle/0003_indexes_and_uniques.sql
// but is silently dropped one file later by drizzle/0004_phase2.sql's
// `DROP TABLE document_chunks` + rename, a pre-existing gap in the migration
// files (present for the better-sqlite3 path too) discovered while building
// this test. Out of scope to fix here; flagged separately.
{
  const client = createClient({ url: dbUrl });
  const rawId = 'raw-atomicity-doc';
  let batchError = null;
  try {
    await client.batch(
      [
        {
          sql: 'INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count, contribution_policy_version) VALUES (?,?,?,?,?,?,?)',
          args: [rawId, 'Raw atomicity doc', 'raw-atomicity-prov-1', 'Publication', 5, 0, 'policy-v1'],
        },
        {
          sql: 'INSERT INTO document_chunks (document_id, chunk_index, token_count, token_start) VALUES (?,?,?,?)',
          args: [rawId, 0, 5, 0],
        },
        // Deliberately violates the documents.id PRIMARY KEY — same id
        // inserted a second time with a different provenance hash.
        {
          sql: 'INSERT INTO documents (id, title, provenance_sha256, source_type, word_count, unique_shingle_count, contribution_policy_version) VALUES (?,?,?,?,?,?,?)',
          args: [rawId, 'Raw atomicity doc dupe', 'raw-atomicity-prov-2', 'Publication', 5, 0, 'policy-v1'],
        },
      ],
      'write',
    );
    assert(false, 'batch with a constraint-violating statement should have rejected');
  } catch (err) {
    batchError = err;
  }
  assert(batchError, 'batch() must reject when a later statement fails');

  const docCheck = await client.execute({ sql: 'SELECT id FROM documents WHERE id = ?', args: [rawId] });
  assert.equal(docCheck.rows.length, 0, 'earlier statement in a failed batch must not persist (rollback proof)');
  const chunkCheck = await client.execute({ sql: 'SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?', args: [rawId] });
  assert.equal(Number(chunkCheck.rows[0].cnt), 0, 'chunk rows from a failed batch must not persist');
  client.close();
  console.log('libSQL batch() atomicity verified: failed batch left zero rows');
}

// 2) Successful ingestion via ingestDocumentLibsql
const text = `This is a short document used to test the libSQL ingestion pipeline. It contains several words and repeats some phrases. This is a short document used to test the libSQL ingestion pipeline.`;
const res1 = await ingestDocumentLibsql({ url: dbUrl }, { text, contributionPolicyVersion: 'policy-v1' });
console.log('libsql ingest result 1', res1);
assert(res1.created === true, 'Document should be newly created');
assert(typeof res1.documentId === 'string' && res1.documentId.length > 0, 'documentId set');
assert(typeof res1.contributionId === 'string' && res1.contributionId.length > 0, 'contributionId set');
assert(res1.chunkCount >= 1, 'should have at least one chunk');
assert(typeof res1.provenanceSha256 === 'string' && res1.provenanceSha256.length === 64, 'provenance sha');
assert(res1.uniqueShingleCount >= 0, 'unique shingles counted');

// 3) Duplicate SHA-256 detection
const res2 = await ingestDocumentLibsql({ url: dbUrl }, { text, contributionPolicyVersion: 'policy-v1' });
console.log('libsql ingest result 2', res2);
assert(res2.created === false, 'should detect duplicate and return existing');
assert(res2.documentId === res1.documentId, 'same documentId returned for duplicate');

// 4) Ingestion-level rollback proof: reuse res1's document id with different
// text/provenance so the provenance dedup check does not short-circuit; the
// batch must fail on the documents.id PRIMARY KEY collision, and none of the
// new attempt's chunk/fingerprint rows should be added on top of res1's.
const verifyClient = createClient({ url: dbUrl });
const chunkCountBefore = await verifyClient.execute({ sql: 'SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?', args: [res1.documentId] });
const fingerprintCountBefore = await verifyClient.execute({
  sql: 'SELECT COUNT(*) as cnt FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?',
  args: [res1.documentId],
});

let rollbackError = null;
try {
  await ingestDocumentLibsql(
    { url: dbUrl },
    { id: res1.documentId, text: 'completely different text that produces a different provenance hash for this rollback check', contributionPolicyVersion: 'policy-v1' },
  );
  assert(false, 'ingesting a duplicate id with a new provenance should have thrown');
} catch (err) {
  rollbackError = err;
}
assert(rollbackError, 'ingestDocumentLibsql must throw when the batch fails');

const chunkCountAfter = await verifyClient.execute({ sql: 'SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?', args: [res1.documentId] });
const fingerprintCountAfter = await verifyClient.execute({
  sql: 'SELECT COUNT(*) as cnt FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?',
  args: [res1.documentId],
});
assert.equal(Number(chunkCountAfter.rows[0].cnt), Number(chunkCountBefore.rows[0].cnt), 'failed ingestion must not add extra chunk rows');
assert.equal(Number(fingerprintCountAfter.rows[0].cnt), Number(fingerprintCountBefore.rows[0].cnt), 'failed ingestion must not add extra fingerprint rows');
verifyClient.close();

// cleanup
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('libSQL ingestion tests passed');
