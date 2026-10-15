import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { ASJP_PROVIDER, asjpPublicationEvidenceOf, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';
import { openAsjpCatalog } from '../lib/asjp-catalog-store.ts';
import { startAsjpService } from '../services/asjp-matching/server.ts';
import { acceptAsjpAnswer, requestAsjpAnswer } from '../lib/asjp-report-evidence.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';

/** The local ASJP matching service prototype end to end, on a fixture index and catalog. */
const scratch = corpusEngineScratch('asjp-service');
test.after(async () => { await new Promise((r) => setTimeout(r, 2000)); removeScratch(scratch); });
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const texts = { 5001: inventedText(501, 900), 5002: inventedText(502, 900) };
const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  ...Object.entries(texts).map(([id, t]) => fixtureSource(id, t, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title: `title ${id}`, sourceType: 'journal-article', language: 'en' })),
  ...Array.from({ length: 20 }, (_, i) => fixtureSource(`noise-${i}`, inventedText(600 + i, 500))),
])]);
const catalogPath = path.join(scratch, 'catalog.sqlite');
{
  const db = new DatabaseSync(catalogPath);
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE journals (journal_id INTEGER PRIMARY KEY, name TEXT, eissn TEXT);
    CREATE TABLE articles (article_id INTEGER PRIMARY KEY, journal_id INTEGER, canonical_url TEXT, title TEXT, authors_json TEXT, publication_date TEXT, doi TEXT);
    CREATE TABLE article_versions (article_id INTEGER, indexed INTEGER, licence TEXT, licence_version TEXT, licence_basis TEXT, licence_status TEXT, reuse_permitted INTEGER, withdrawn INTEGER);
    INSERT INTO journals VALUES (1, 'J', NULL);`);
  for (const id of Object.keys(texts)) { db.prepare('INSERT INTO articles VALUES (?, 1, ?, ?, ?, ?, NULL)').run(Number(id), url(id), `title ${id}`, JSON.stringify(['A, B']), '2024-01-01'); db.prepare("INSERT INTO article_versions VALUES (?, 1, 'CC BY', '4.0', 'ARTICLE_PDF', 'PERMITTED', 1, 0)").run(Number(id)); }
  db.close();
}
const generation = { root, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, catalogPath, catalogImmutable: false, licencePolicy: 'permitted-only' };
const manuscript = [inventedText(70_001, 300), sliceWords(texts[5001], 200, 120), inventedText(70_002, 300), sliceWords(texts[5002], 400, 90), inventedText(70_003, 200)].join(' ');
const token = 'test-token';
const adminToken = 'admin-token';
const admin = { authorization: `Bearer ${adminToken}` };
const base = { token, adminToken, workers: 2, queueLimit: 32, deadlineMs: 30_000, maxWords: 60_000, generation, allowedRoots: [scratch] };
process.env.ASJP_SERVICE_ENABLED = 'true';
let port = 47_310;
const directCatalog = openAsjpCatalog(catalogPath);
const direct = await runAsjpAcademicLane({ store: new LocalDirectoryObjectStore(root), generationId: built.generationId, submissionText: manuscript, catalog: directCatalog.entry, ignoreFlag: true });
directCatalog.close();

test('disabled unless ASJP_SERVICE_ENABLED=true; distinct tokens; the local-research policy refused', async () => {
  process.env.ASJP_SERVICE_ENABLED = 'false';
  await assert.rejects(() => startAsjpService({ ...base, port: ++port }), /disabled/);
  process.env.ASJP_SERVICE_ENABLED = 'true';
  await assert.rejects(() => startAsjpService({ ...base, port: ++port, adminToken: token }), /distinct/);
  await assert.rejects(() => startAsjpService({ ...base, port: ++port, generation: { ...generation, licencePolicy: 'local-research-all' } }), /local-research/);
});

test('answers equal the direct lane, under 8 concurrent requests; health, auth, busy, timeout with worker replacement', async () => {
  const svc = await startAsjpService({ ...base, port: ++port });
  const u = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${u}/health`)).status, 401, 'a token is required');
    const answers = await Promise.all(Array.from({ length: 8 }, () => requestAsjpAnswer(u, token, { text: manuscript })));
    for (const a of answers) {
      assert.equal(a.state, 'COMPLETE');
      assert.deepEqual(a.creditedPositions, direct.creditedPositions);
      assert.deepEqual(a.asjpPublicationEvidence, asjpPublicationEvidenceOf(direct));
    }
    const big = await fetch(`${u}/match`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x '.repeat(2_500_000) }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413, 'an oversized body is refused');
    const h = await (await fetch(`${u}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(h.ok, true); assert.equal(h.workersReady, 2); assert.equal(h.counters.served, 8);
  } finally { svc.close(); }
  const busy = await startAsjpService({ ...base, port: ++port, queueLimit: 0 });
  try { const a = await requestAsjpAnswer(`http://127.0.0.1:${port}`, token, { text: manuscript }); assert.equal(a.failureCode, 'ASJP_BUSY'); } finally { busy.close(); }
  const slow = await startAsjpService({ ...base, port: ++port, workers: 1, deadlineMs: 1 });
  try {
    const a = await requestAsjpAnswer(`http://127.0.0.1:${port}`, token, { text: manuscript });
    assert.equal(a.failureCode, 'ASJP_TIMEOUT');
    for (let i = 0; i < 200 && slow.pool().counters.restarts < 1; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(slow.pool().counters.restarts, 1, 'the stuck worker was replaced');
  } finally { slow.close(); }
});

test('golden answers gate service; blue/green switch keeps the old pool when the new one fails its golden answers', async () => {
  const probe = await startAsjpService({ ...base, port: ++port });
  const digest = (await requestAsjpAnswer(`http://127.0.0.1:${port}`, token, { text: manuscript })).digest;
  probe.close();
  const bad = await startAsjpService({ ...base, port: ++port, golden: [{ text: manuscript, digest: 'x'.repeat(64) }] });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } })).status, 503);
    assert.equal((await requestAsjpAnswer(`http://127.0.0.1:${port}`, token, { text: manuscript })).failureCode, 'GOLDEN_MISMATCH');
  } finally { bad.close(); }
  const svc = await startAsjpService({ ...base, port: ++port, golden: [{ text: manuscript, digest }] });
  const u = `http://127.0.0.1:${port}`;
  try {
    const rejected = await fetch(`${u}/admin/switch`, { method: 'POST', headers: admin, body: JSON.stringify({ generation, golden: [{ text: manuscript, digest: 'y'.repeat(64) }] }) });
    assert.equal(rejected.status, 409);
    assert.equal((await requestAsjpAnswer(u, token, { text: manuscript })).digest, digest, 'the old pool still serves');
    const outside = await fetch(`${u}/admin/switch`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: { ...generation, root: 'C:/Windows' }, golden: [{ text: manuscript, digest }] }) });
    assert.equal(outside.status, 400, 'a root outside the allowed roots is refused');
    assert.equal((await fetch(`${u}/admin/switch`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 401, 'the service token is not an admin token');
    const inflight = requestAsjpAnswer(u, token, { text: manuscript });
    const ok = await (await fetch(`${u}/admin/switch`, { method: 'POST', headers: admin, body: JSON.stringify({ generation, golden: [{ text: manuscript, digest }] }) })).json();
    assert.equal(ok.switched, true);
    assert.equal((await inflight).state, 'COMPLETE', 'a request in flight during the switch completes');
    assert.equal((await requestAsjpAnswer(u, token, { text: manuscript })).digest, digest);
  } finally { svc.close(); }
});

test('takedown: a withdrawn article stops being credited after a catalog refresh, without a restart', async () => {
  const svc = await startAsjpService({ ...base, port: ++port });
  const u = `http://127.0.0.1:${port}`;
  try {
    const before = await requestAsjpAnswer(u, token, { text: manuscript });
    assert.ok(before.cards.some((c) => c.sourceId === 'asjp:5002'));
    const db = new DatabaseSync(catalogPath); db.exec('UPDATE article_versions SET withdrawn = 1 WHERE article_id = 5002'); db.close();
    const r = await (await fetch(`${u}/admin/refresh`, { method: 'POST', headers: admin })).json();
    assert.ok(r.workers.every((w) => w.ok));
    const after = await requestAsjpAnswer(u, token, { text: manuscript });
    assert.ok(!after.cards.some((c) => c.sourceId === 'asjp:5002'));
    assert.ok(after.cards.some((c) => c.sourceId === 'asjp:5001'));
  } finally { svc.close(); const db = new DatabaseSync(catalogPath); db.exec('UPDATE article_versions SET withdrawn = 0'); db.close(); }
});

test('report adapter: only a complete, pinned answer is accepted; union scoring counts a shared word once; flag off changes nothing', () => {
  const answer = { state: 'COMPLETE', licencePolicy: 'permitted-only', normalization: 2, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordCount: direct.submissionWordCount, asjpPublicationEvidence: asjpPublicationEvidenceOf(direct), cards: [] };
  const expected = { generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordCount: direct.submissionWordCount };
  assert.equal(acceptAsjpAnswer(answer, expected, false).status, 'DISABLED');
  assert.equal(acceptAsjpAnswer({ ...answer, generationId: 'gen-other' }, expected, true).reason, 'GENERATION_MISMATCH');
  assert.equal(acceptAsjpAnswer({ state: 'TIMEOUT', failureCode: 'ASJP_TIMEOUT' }, expected, true).reason, 'ASJP_TIMEOUT');
  assert.equal(acceptAsjpAnswer({ ...answer, licencePolicy: 'local-research-all' }, expected, true).reason, 'LICENCE_POLICY_NOT_ALLOWED');
  assert.equal(acceptAsjpAnswer({ ...answer, wordCount: null }, expected, true).reason, 'WORD_COUNT_MISMATCH');
  const accepted = acceptAsjpAnswer(answer, expected, true);
  assert.equal(accepted.status, 'INCLUDED');
  // the Archive also holds the first 50 ASJP-credited words: they count once
  const archive = direct.creditedPositions.slice(0, 50);
  const without = computeUnifiedSimilarity({ wordCount: direct.submissionWordCount, archiveMatchedPositions: archive });
  const withAsjp = computeUnifiedSimilarity({ wordCount: direct.submissionWordCount, archiveMatchedPositions: archive, asjpPublicationEvidence: accepted.evidence.asjpPublicationEvidence });
  assert.equal(withAsjp.uniqueMatchedWords, new Set([...archive, ...direct.creditedPositions]).size);
  assert.equal(withAsjp.asjpPublicationOnlyWords, direct.creditedPositions.length - 50);
  assert.deepEqual(withAsjp.asjpPublicationPositions, direct.creditedPositions.slice(50));
  assert.equal(JSON.stringify(computeUnifiedSimilarity({ wordCount: direct.submissionWordCount, archiveMatchedPositions: archive, asjpPublicationEvidence: null })), JSON.stringify(without), 'no channel: byte-identical');
});
