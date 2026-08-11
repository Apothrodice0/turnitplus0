import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applyMigrations, ingestDocument } from '../lib/ingest.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbPath = path.join(repo, 'test_ingest.db');

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);
applyMigrations(db, drizzleDir);
db.close();

// Test 1: successful ingestion
const text = `This is a short document used to test the ingestion pipeline. It contains several words and repeats some phrases. This is a short document used to test the ingestion pipeline.`;
const res1 = ingestDocument(dbPath, { text, contributionPolicyVersion: 'policy-v1' });
console.log('ingest result 1', res1);
assert(res1.created === true, 'Document should be newly created');
assert(typeof res1.documentId === 'string' && res1.documentId.length > 0, 'documentId set');
assert(typeof res1.contributionId === 'string' && res1.contributionId.length > 0, 'contributionId set');
assert(res1.chunkCount >= 1, 'should have at least one chunk');
assert(typeof res1.provenanceSha256 === 'string' && res1.provenanceSha256.length === 64, 'provenance sha');
assert(res1.uniqueShingleCount >= 0, 'unique shingles counted');

// Check DB contents: no raw text stored in document_chunks
const db2 = new Database(dbPath);
const doc = db2.prepare('SELECT * FROM documents WHERE id = ?').get(res1.documentId);
assert(doc, 'document row exists');
const chunkRow = db2.prepare('SELECT * FROM document_chunks WHERE document_id = ?').get(res1.documentId);
assert(chunkRow, 'chunk exists');
assert(!('text' in chunkRow), 'chunk row should not contain raw text column');

// Check fingerprints exist
const fpCount = db2.prepare('SELECT COUNT(*) as cnt FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?').get(res1.documentId).cnt;
assert(fpCount > 0, 'fingerprints stored');

// Test 2: duplicate detection
const res2 = ingestDocument(dbPath, { text, contributionPolicyVersion: 'policy-v1' });
console.log('ingest result 2', res2);
assert(res2.created === false, 'should detect duplicate and return existing');
assert(res2.documentId === res1.documentId, 'same documentId returned for duplicate');

// Test 3: transaction rollback. simulateFailureAfterChunkIndex: 0 throws
// inside ingestDocument's transaction AFTER insertDocument.run(...) and
// insertChunk.run(...) for chunk 0 have already executed, so this only
// proves rollback works if the assertions below check that those specific
// earlier writes did not survive (not just a coarse row count).
const rollbackId = 'ingest-test-rollback-doc';
const rollbackText = 'This rollback-only text is never ingested successfully elsewhere in this file, so its provenance hash is unique.';
try {
  ingestDocument(dbPath, { id: rollbackId, text: rollbackText, contributionPolicyVersion: 'policy-v1' }, { simulateFailureAfterChunkIndex: 0 });
  assert(false, 'simulated ingestion failure should have thrown');
} catch (err) {
  assert.match(String(err.message), /Simulated failure after chunk insert/, 'threw the expected simulated error');
}
const documentRow = db2.prepare('SELECT id FROM documents WHERE id = ?').get(rollbackId);
assert.equal(documentRow, undefined, 'the insertDocument write that ran before the throw must not survive');
const rollbackChunkCount = db2.prepare('SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?').get(rollbackId).cnt;
assert.equal(rollbackChunkCount, 0, 'the insertChunk write that ran before the throw must not survive');

// Clean up
try {
  fs.unlinkSync(dbPath);
} catch (err) {
  console.warn('Could not remove test DB, it may be locked:', err.message);
}

console.log('All ingestion tests passed.');
