import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applyMigrations, ingestDocument } from '../lib/ingest.js';
import * as route from '../app/api/ingest/route.ts';

/**
 * Release-hardening audit finding INGEST-01: app/api/ingest/route.ts was
 * closed — no legitimate runtime caller existed anywhere in this codebase
 * (verified via Graphify and an exhaustive grep before this change) — see
 * that file's own header comment. This suite proves the CLOSED contract:
 * every method returns a bare 404 with no body, and — since the route file
 * no longer imports anything DB-related at all — a request can never reach
 * a database regardless of method, body, or headers. The underlying
 * reusable library (lib/ingest.ts's applyMigrations/ingestDocument) is
 * untouched and still exercised directly below, since offline tooling
 * (tools/build-index.ts and friends) still depends on it.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbPath = path.join(repo, 'test_ingest_api.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);
applyMigrations(db, drizzleDir);
db.close();

function countRows(table) {
  const d = new Database(dbPath);
  try {
    return d.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get().cnt;
  } finally {
    d.close();
  }
}

async function callRoute(method, body) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request('http://localhost/api/ingest', init);
  const handler = route[method];
  assert.ok(handler, `route must export a ${method} handler`);
  return handler(req);
}

// --- the route is closed: every method returns a bare 404, no DB access ---

for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  const before = countRows('documents');
  const body = method === 'GET' || method === 'DELETE' ? undefined : { text: 'anonymous write attempt', contributionPolicyVersion: 'policy-v1' };
  const res = await callRoute(method, body);
  assert.equal(res.status, 404, `${method} must return 404`);
  const bodyText = await res.text();
  assert.equal(bodyText, '', `${method} response body must be empty — reveals no implementation detail`);
  const after = countRows('documents');
  assert.equal(after, before, `${method} must never write a document row`);
  console.log(`${method} /api/ingest: 404, empty body, zero writes — verified`);
}

// A well-formed, legitimate-looking payload must ALSO be rejected outright —
// proves this isn't malformed-input rejection, the route is unconditionally closed.
{
  const before = countRows('documents');
  const res = await callRoute('POST', {
    text: 'looks like a totally valid ingest payload',
    contributionPolicyVersion: 'policy-v1',
    id: 'would-be-real-id',
  });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '');
  assert.equal(countRows('documents'), before, 'a well-formed payload must still write nothing');
  console.log('well-formed payload still rejected outright — route is unconditionally closed');
}

// --- structural: the closed route file imports nothing DB-related ---------

{
  const source = fs.readFileSync(path.join(repo, 'app/api/ingest/route.ts'), 'utf8');
  // Strip block/line comments first — this file's own header comment
  // legitimately narrates the old, now-removed DB-touching imports by name
  // as history; only the executable code must be free of them.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    withoutComments,
    /ingestDocument|checkRate|reports-db|createClient|process\.env\.TURSO/,
    'the closed route\'s executable code must not import or reference any DB-touching code — a request here structurally cannot reach a database',
  );
  console.log('closed route file structurally has no DB-touching imports');
}

// --- the underlying reusable library is untouched and still works ----------

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

// A normal, successful library-level ingest — proves the LIBRARY itself
// (unlike the closed route) still works end to end for offline tooling.
{
  const text = 'Hello this is a library-level ingest test document.';
  const result = ingestDocument(dbPath, { text, contributionPolicyVersion: 'policy-v1' });
  assert.ok(result.documentId, 'documentId present');
  assert.ok(result.contributionId, 'contributionId present');
  console.log('lib/ingest.ts library-level ingestion still works end to end');
}

// cleanup
try { fs.unlinkSync(dbPath); } catch (e) {}
console.log('API ingestion tests passed (route closed, library intact)');
