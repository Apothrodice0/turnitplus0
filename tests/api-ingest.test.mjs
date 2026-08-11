import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applyMigrations, ingestDocument } from '../lib/ingest.js';
import * as route from '../app/api/ingest/route.ts';
import { resetRateForTest } from '../lib/rate-limit.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbPath = path.join(repo, 'test_ingest_api.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);
applyMigrations(db, drizzleDir);
db.close();
process.env.INGEST_DB_PATH = dbPath;

resetRateForTest('test-client');

async function callRoute(body, headers = {}) {
  const req = new Request('http://localhost/api/ingest', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  // spoof ip header
  req.headers.set('x-forwarded-for', 'test-client');
  const res = await route.POST(req);
  return res;
}

// valid ingestion
const text = 'Hello this is an api test document.';
let res = await callRoute({ text, contributionPolicyVersion: 'policy-v1' });
assert(res.status === 201 || res.status === 200, 'status is 201 or 200');
const json = await res.json();
assert(json.contributionId, 'contributionId present');
assert(!json.text, 'response does not expose text');

// invalid payload
res = await callRoute({}, {});
assert(res.status === 400, 'invalid payload rejected');

// empty text
res = await callRoute({ text: '', contributionPolicyVersion: 'policy-v1' });
assert(res.status === 400, 'empty text rejected');

// oversized payload
const big = 'a'.repeat(250000);
res = await callRoute({ text: big, contributionPolicyVersion: 'policy-v1' });
assert(res.status === 413, 'oversized payload rejected');

// duplicate document
res = await callRoute({ text, contributionPolicyVersion: 'policy-v1' });
assert(res.status === 200 || res.status === 201, 'duplicate returns OK');
const json2 = await res.json();
assert(json2.documentId, 'documentId present');

// mismatched supplied SHA-256
res = await callRoute({ text, contributionPolicyVersion: 'policy-v1', provenanceSha256: 'deadbeef' });
assert(res.status === 400, 'mismatched provenance rejected');

// rate limiting: make MAX_TOKENS+1 calls quickly
resetRateForTest('test-client');
for (let i = 0; i < 11; i++) {
  res = await callRoute({ text: `call ${i}`, contributionPolicyVersion: 'policy-v1' });
  if (i < 10) {
    assert(res.status === 201 || res.status === 200, 'within rate limit ok');
  } else {
    assert(res.status === 429, 'rate limited after threshold');
  }
}

// transaction rollback test
const rollbackText = 'rollback '.repeat(2000);
const rollbackId = 'rollback-doc';
try {
  ingestDocument(dbPath, { id: rollbackId, text: rollbackText, contributionPolicyVersion: 'policy-v1' }, { simulateFailureAfterChunkIndex: 0 });
  assert.fail('simulated ingestion failure should have thrown');
} catch (err) {
  assert.match(String(err.message), /Simulated failure after chunk insert/);
}

const dbAfterRollback = new Database(dbPath);
try {
  const documentRow = dbAfterRollback.prepare('SELECT id FROM documents WHERE id = ?').get(rollbackId);
  assert.equal(documentRow, undefined, 'document row should be rolled back');

  const chunkCount = dbAfterRollback.prepare('SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?').get(rollbackId).cnt;
  assert.equal(chunkCount, 0, 'chunk rows should be rolled back');

  const fingerprintCount = dbAfterRollback.prepare('SELECT COUNT(*) as cnt FROM chunk_fingerprints cf JOIN document_chunks dc ON cf.chunk_id = dc.id WHERE dc.document_id = ?').get(rollbackId).cnt;
  assert.equal(fingerprintCount, 0, 'fingerprint rows should be rolled back');
} finally {
  dbAfterRollback.close();
}

// cleanup
try { fs.unlinkSync(dbPath); } catch (e) {}
console.log('API ingestion tests passed');
