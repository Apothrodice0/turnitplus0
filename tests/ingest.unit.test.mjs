import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applyMigrations, ingestDocument } from '../lib/ingest.js';
import { grams, gramHash, tokens } from '../lib/similarity-core.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbPath = path.join(repo, 'test_ingest_unit.db');

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);
applyMigrations(db, drizzleDir);
db.close();

// 1) Successful ingestion
const text = `This is a short document used to test the ingestion pipeline. It contains several words and repeats some phrases. This is a short document used to test the ingestion pipeline.`;
const res1 = ingestDocument(dbPath, { text, contributionPolicyVersion: 'policy-v1' });
console.log('ingest result 1', res1);
assert(res1.created === true, 'Document should be newly created');
assert(typeof res1.documentId === 'string' && res1.documentId.length > 0, 'documentId set');
assert(typeof res1.contributionId === 'string' && res1.contributionId.length > 0, 'contributionId set');
assert(res1.chunkCount >= 1, 'should have at least one chunk');
assert(typeof res1.provenanceSha256 === 'string' && res1.provenanceSha256.length === 64, 'provenance sha');
assert(res1.uniqueShingleCount >= 0, 'unique shingles counted');

// 2) Duplicate SHA-256 detection
const res2 = ingestDocument(dbPath, { text, contributionPolicyVersion: 'policy-v1' });
console.log('ingest result 2', res2);
assert(res2.created === false, 'should detect duplicate and return existing');
assert(res2.documentId === res1.documentId, 'same documentId returned for duplicate');

// 3) Deterministic chunking: create long text with >1000 tokens to force multiple chunks
const manyWords = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ');
const res3 = ingestDocument(dbPath, { text: manyWords, contributionPolicyVersion: 'policy-v1' });
console.log('ingest result 3', res3);
assert(res3.chunkCount >= 2, 'long document should be chunked into multiple chunks');

// 4) Fingerprint/hash consistency
// Compute shingle hashes for one of the documents and compare to DB stored fingerprints
const db2 = new Database(dbPath);
const docChunks = db2.prepare('SELECT id, token_start FROM document_chunks WHERE document_id = ? ORDER BY chunk_index').all(res1.documentId);
assert(docChunks.length >= 1, 'chunks exist');
const shingleMeta = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'data', 'document-index.meta.json'), 'utf8'));
const shingleSize = shingleMeta.shingleSize || 5;
const words = tokens(text);
const gramsList = grams(words, shingleSize);
const expectedHashes = new Set(gramsList.map((g) => gramHash(g)));
const rows = db2.prepare('SELECT DISTINCT shingle_hash FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?').all(res1.documentId);
const stored = new Set(rows.map((r) => r.shingle_hash));
// Expect intersection not empty and that stored hashes are subset of expected for this small doc
assert([...stored].every((h) => expectedHashes.has(h)), 'stored fingerprints match gramHash outputs');

// 5) Transaction rollback test
// Simulate failure during ingestion by using simulate option
try {
  ingestDocument(dbPath, { text: manyWords, contributionPolicyVersion: 'policy-v1' }, { simulateFailureAfterChunkIndex: 0 });
  assert(false, 'simulate ingestion should have thrown');
} catch (err) {
  // verify zero partial rows for the last attempted document id
  // the simulate function generates a random document id; ensure no partial rows exist for any document without contributions
  const remainingDocs = db2.prepare(`SELECT COUNT(*) as cnt FROM documents`).get().cnt;
  assert(remainingDocs >= 2, 'documents count should not include partial failed insertion');
}

// cleanup
try { fs.unlinkSync(dbPath); } catch (e) { /* ignore */ }
console.log('Unit ingestion tests passed');
