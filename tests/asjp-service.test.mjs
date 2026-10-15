import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { ASJP_PROVIDER, asjpPublicationEvidenceOf, asjpSourceCards, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';
import { openAsjpCatalog } from '../lib/asjp-catalog-store.ts';
import { startAsjpService, asjpServiceConfigFromEnv, workerEnv, ASJP_SECRET_ENV } from '../services/asjp-matching/server.ts';
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
// Phase 7 remediation: every service credential must be strong (>= 32 characters, >= 12 distinct)
const { randomBytes } = await import('node:crypto');
const token = randomBytes(32).toString('hex');
const adminToken = randomBytes(32).toString('hex');
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
  // A1: weak credentials refuse to start
  await assert.rejects(() => startAsjpService({ ...base, port: ++port, token: 'test-token' }), /service token is too weak/);
  await assert.rejects(() => startAsjpService({ ...base, port: ++port, adminToken: 'b'.repeat(40) }), /admin token is too weak/);
  await assert.rejects(() => startAsjpService({ ...base, port: ++port, requestSigningKey: 'x' }), /request-signing key is too weak/);
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
  const answer = { state: 'COMPLETE', licencePolicy: 'permitted-only', normalization: 2, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordCount: direct.submissionWordCount, asjpPublicationEvidence: asjpPublicationEvidenceOf(direct), cards: asjpSourceCards(direct) };
  const expected = { generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordCount: direct.submissionWordCount };
  assert.equal(acceptAsjpAnswer(answer, expected, false).status, 'DISABLED');
  assert.equal(acceptAsjpAnswer({ ...answer, generationId: 'gen-other' }, expected, true).reason, 'GENERATION_MISMATCH');
  assert.equal(acceptAsjpAnswer({ state: 'TIMEOUT', failureCode: 'ASJP_TIMEOUT' }, expected, true).reason, 'ASJP_TIMEOUT');
  assert.equal(acceptAsjpAnswer({ ...answer, licencePolicy: 'local-research-all' }, expected, true).reason, 'LICENCE_POLICY_NOT_ALLOWED');
  assert.equal(acceptAsjpAnswer({ ...answer, wordCount: null }, expected, true).reason, 'WORD_COUNT_MISMATCH');
  // Phase 6.5: the evidence is derived from the cards — an answer whose cards do not carry it is refused
  assert.equal(acceptAsjpAnswer({ ...answer, cards: [] }, expected, true).reason, 'EVIDENCE_CARD_MISMATCH');
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

test('Phase 6.5 credentials: tokens only from the environment / token files, never in a worker env, an answer or health', async () => {
  const tokenFile = path.join(scratch, 'svc.token'), adminFile = path.join(scratch, 'adm.token'), genFile = path.join(scratch, 'gen.json');
  const fileToken = `file-service-${randomBytes(24).toString('hex')}`, fileAdmin = `file-admin-${randomBytes(24).toString('hex')}`;
  fs.writeFileSync(tokenFile, `${fileToken}\n`); fs.writeFileSync(adminFile, `${fileAdmin}\n`); fs.writeFileSync(genFile, JSON.stringify(generation));
  const p = ++port;
  const env = { ASJP_SERVICE_TOKEN_FILE: tokenFile, ASJP_ADMIN_TOKEN_FILE: adminFile, ASJP_GENERATION_CONFIG: genFile, ASJP_ALLOWED_ROOTS: scratch, ASJP_SERVICE_PORT: String(p), ASJP_SERVICE_WORKERS: '1' };
  const config = asjpServiceConfigFromEnv(env);
  assert.equal(config.token, fileToken); assert.equal(config.adminToken, fileAdmin);
  assert.deepEqual(config.generation.features, { numericTables: false, shortSignal: null }, 'both experiments default off');
  assert.throws(() => asjpServiceConfigFromEnv({ ...env, ASJP_SERVICE_TOKEN_FILE: undefined }), /ASJP_SERVICE_TOKEN/);
  // a worker never receives a credential
  const saved = Object.fromEntries(ASJP_SECRET_ENV.map((k) => [k, process.env[k]]));
  for (const k of ASJP_SECRET_ENV) process.env[k] = 'secret-value';
  try { for (const k of ASJP_SECRET_ENV) assert.equal(workerEnv()[k], undefined); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const svc = await startAsjpService(config);
  try {
    const u = `http://127.0.0.1:${p}`;
    assert.equal((await fetch(`${u}/health`, { headers: { authorization: `Bearer ${fileToken.slice(0, -1)}` } })).status, 401, 'a token prefix is refused');
    assert.equal((await fetch(`${u}/admin/refresh`, { method: 'POST', headers: { authorization: `Bearer ${fileToken}` } })).status, 401, 'the service token is not an admin token');
    const health = await (await fetch(`${u}/health`, { headers: { authorization: `Bearer ${fileToken}` } })).text();
    const answer = JSON.stringify(await requestAsjpAnswer(u, fileToken, { text: manuscript }));
    for (const body of [health, answer]) assert.ok(!body.includes(fileToken) && !body.includes(fileAdmin));
    assert.deepEqual(JSON.parse(health).features, { numericTables: false, shortSignal: false });
  } finally { svc.close(); }
});

test('review 9/13: a worker env is an allowlist (no other secret reaches it); a switch never changes features or corrections', async () => {
  const saved = { OTHER_SECRET: process.env.OTHER_SECRET, DATABASE_PASSWORD: process.env.DATABASE_PASSWORD };
  process.env.OTHER_SECRET = 'x'; process.env.DATABASE_PASSWORD = 'y';
  try {
    const env = workerEnv();
    assert.equal(env.OTHER_SECRET, undefined); assert.equal(env.DATABASE_PASSWORD, undefined);
    for (const k of ASJP_SECRET_ENV) assert.equal(env[k], undefined);
    assert.ok(env.PATH || env.Path, 'what Node needs is kept');
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const p = ++port; const svc = await startAsjpService({ ...base, workers: 1, port: p });
  try {
    const u = `http://127.0.0.1:${p}`;
    const r = await fetch(`${u}/admin/switch`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ generation: { ...generation, features: { numericTables: true, shortSignal: { wordDfPath: path.join(scratch, 'x.json') } }, corrections: { repetitionRemoval: true } } }) });
    assert.equal(r.status, 200);
    const health = await (await fetch(`${u}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(health.features, { numericTables: false, shortSignal: false }, 'the switch kept the service features');
  } finally { svc.close(); }
});

test('Phase 7: a serving host can require golden answers (ASJP_GOLDEN_FILE / ASJP_REQUIRE_GOLDEN)', () => {
  const tokenFile = path.join(scratch, 'g.token'), adminFile = path.join(scratch, 'g-admin.token'), genFile = path.join(scratch, 'g-gen.json'), goldenFile = path.join(scratch, 'golden.json'), bad = path.join(scratch, 'golden-bad.json');
  fs.writeFileSync(tokenFile, 'a'.repeat(40)); fs.writeFileSync(adminFile, 'b'.repeat(40)); fs.writeFileSync(genFile, JSON.stringify(generation));
  fs.writeFileSync(goldenFile, JSON.stringify([{ text: 'x', title: null, digest: 'c'.repeat(64) }])); fs.writeFileSync(bad, JSON.stringify([{ text: 'x' }]));
  const env = { ASJP_SERVICE_TOKEN_FILE: tokenFile, ASJP_ADMIN_TOKEN_FILE: adminFile, ASJP_GENERATION_CONFIG: genFile, ASJP_ALLOWED_ROOTS: scratch };
  assert.equal(asjpServiceConfigFromEnv(env).golden, undefined);
  assert.throws(() => asjpServiceConfigFromEnv({ ...env, ASJP_REQUIRE_GOLDEN: 'true' }), /ASJP_GOLDEN_FILE is required/);
  assert.throws(() => asjpServiceConfigFromEnv({ ...env, ASJP_GOLDEN_FILE: bad }), /non-empty array/);
  assert.equal(asjpServiceConfigFromEnv({ ...env, ASJP_GOLDEN_FILE: goldenFile, ASJP_REQUIRE_GOLDEN: 'true' }).golden.length, 1);
});

test('Phase 7 PC hosting: signed-only /match (replay refused) and admin endpoints refused through a tunnel', async () => {
  const p = ++port;
  const key = randomBytes(32).toString('hex');
  const svc = await startAsjpService({ ...base, workers: 1, port: p, requestSigningKey: key, adminLocalOnly: true });
  try {
    const u = `http://127.0.0.1:${p}`;
    const unsigned = await requestAsjpAnswer(u, token, { text: manuscript }, 60_000);
    assert.equal(unsigned.error, 'unauthorized', 'a bearer token alone is not enough when signing is required');
    // protocol v2: attest (no manuscript, no bearer), then the signed match, whose signed answer the client verifies
    const signed = await requestAsjpAnswer(u, token, { text: manuscript }, 60_000, {}, key);
    assert.equal(signed.state, 'COMPLETE');
    assert.deepEqual(signed.creditedPositions, direct.creditedPositions);
    assert.equal((await requestAsjpAnswer(u, token, { text: manuscript }, 60_000, {}, randomBytes(32).toString('hex'))).failureCode, 'SERVICE_NOT_AUTHENTICATED', 'a client with another key gets nothing');
    // a captured request replayed verbatim is refused (same nonce)
    const { asjpRequestMac, sha256Hex } = await import('../lib/asjp-service-protocol.ts');
    const raw = JSON.stringify({ text: 'x' }); const ts = String(Date.now()); const nonce = 'f'.repeat(32);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-asjp-timestamp': ts, 'x-asjp-nonce': nonce, 'x-asjp-signature': asjpRequestMac(key, { method: 'POST', path: '/match', host: `127.0.0.1:${p}`, ts, nonce, bodySha256: sha256Hex(raw) }) };
    const first = await fetch(`${u}/match`, { method: 'POST', headers, body: raw });
    assert.equal(first.status, 200); assert.match(first.headers.get('x-asjp-response-signature') ?? '', /^[0-9a-f]{64}$/, 'the answer is signed');
    assert.equal((await fetch(`${u}/match`, { method: 'POST', headers, body: raw })).status, 401, 'replay refused');
    // admin: allowed locally, refused when the request came through a tunnel/proxy — A3: even an EMPTY proxy header
    assert.equal((await fetch(`${u}/admin/refresh`, { method: 'POST', headers: admin })).status, 200);
    assert.equal((await fetch(`${u}/admin/refresh`, { method: 'POST', headers: { ...admin, 'cf-connecting-ip': '203.0.113.9' } })).status, 403);
    assert.equal((await fetch(`${u}/admin/refresh`, { method: 'POST', headers: { ...admin, 'x-forwarded-for': '203.0.113.9' } })).status, 403);
    assert.equal((await fetch(`${u}/admin/refresh`, { method: 'POST', headers: { ...admin, 'x-forwarded-for': '' } })).status, 403, 'A3: an empty forwarded header');
    assert.equal((await fetch(`${u}/admin/refresh`, { method: 'POST', headers: { ...admin, 'cf-connecting-ip': '' } })).status, 403, 'A3: an empty cf-connecting-ip');
  } finally { svc.close(); }
});

test('E1: the deadline counts queue time; a queued request whose client left is dropped; degradation settles the queue', async () => {
  // A. the only worker is killed, so the request waits in the queue for its replacement: it is answered ASJP_TIMEOUT at
  //    the deadline (counted from arrival), never served late
  const a = await startAsjpService({ ...base, workers: 1, port: ++port, deadlineMs: 500 });
  try {
    a.pool().workers[0].child.kill();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    const r = await requestAsjpAnswer(`http://127.0.0.1:${port}`, token, { text: manuscript }, 30_000);
    assert.equal(r.failureCode, 'ASJP_TIMEOUT');
    assert.ok(Date.now() - t0 < 2_000, `answered at the deadline, not after the worker restart (${Date.now() - t0} ms)`);
    assert.equal(a.pool().counters.queueTimeouts, 1);
  } finally { a.close(); }
  // B. a client that disconnects while its request is queued: the request is removed (never processed)
  const b = await startAsjpService({ ...base, workers: 1, port: ++port, deadlineMs: 30_000 });
  try {
    b.pool().workers[0].child.kill();
    await new Promise((r) => setTimeout(r, 20));
    const ctrl = new AbortController();
    const gone = fetch(`http://127.0.0.1:${port}/match`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: manuscript }), signal: ctrl.signal }).catch(() => null);
    for (let i = 0; i < 100 && b.pool().queue.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    ctrl.abort(); await gone;
    for (let i = 0; i < 100 && b.pool().queue.length > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.pool().queue.length, 0); assert.equal(b.pool().counters.cancelled, 1);
  } finally { b.close(); }
});

test('E1: RESTART_LIMIT is recovered after a cooldown (fresh workers, golden answers re-checked), bounded per hour; reports never wait on it', async () => {
  const probe = await startAsjpService({ ...base, workers: 1, port: ++port });
  const digest = (await requestAsjpAnswer(`http://127.0.0.1:${port}`, token, { text: manuscript })).digest;
  probe.close();
  // deadline 1 ms: every request times out and its worker is killed -> RESTART_LIMIT after maxRestartsPerMinute
  const svc = await startAsjpService({ ...base, workers: 1, port: ++port, deadlineMs: 1, maxRestartsPerMinute: 2, recoveryCooldownMs: 1_500, maxRecoveriesPerHour: 2, golden: [] });
  const u = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 20 && !svc.pool().degraded; i += 1) { await requestAsjpAnswer(u, token, { text: manuscript }, 10_000); await new Promise((r) => setTimeout(r, 300)); }
    assert.equal(svc.pool().degraded, 'RESTART_LIMIT');
    const t0 = Date.now();
    const during = await requestAsjpAnswer(u, token, { text: manuscript }, 10_000);
    assert.equal(during.failureCode, 'RESTART_LIMIT'); assert.ok(Date.now() - t0 < 1_000, 'answered at once while degraded');
    // the pool recovers by itself (cooldown, fresh workers); with a normal deadline it would then serve again
    svc.pool().config.deadlineMs = 30_000;
    svc.pool().config.golden = [{ text: manuscript, digest }];
    for (let i = 0; i < 300 && svc.pool().degraded; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(svc.pool().degraded, null, 'recovered without restarting the service');
    assert.equal(svc.pool().counters.recoveries, 1);
    const after = await requestAsjpAnswer(u, token, { text: manuscript }, 30_000);
    assert.equal(after.state, 'COMPLETE'); assert.equal(after.digest, digest);
  } finally { svc.close(); }
});

test('B3: excludeSourceIds — a report\'s withdrawn article is treated as withdrawn by the lane (never credited); malformed lists refused', async () => {
  const svc = await startAsjpService({ ...base, workers: 1, port: ++port });
  const u = `http://127.0.0.1:${port}`;
  try {
    const all = await requestAsjpAnswer(u, token, { text: manuscript });
    assert.ok(all.cards.some((c) => c.sourceId === 'asjp:5002'));
    const without = await requestAsjpAnswer(u, token, { text: manuscript, excludeSourceIds: ['asjp:5002'] });
    assert.equal(without.state, 'COMPLETE');
    assert.ok(!without.cards.some((c) => c.sourceId === 'asjp:5002'), 'the excluded article is not credited');
    assert.ok(without.cards.some((c) => c.sourceId === 'asjp:5001'), 'the others still are');
    const bad = await fetch(`${u}/match`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a b', excludeSourceIds: ['DROP TABLE'] }) });
    assert.equal(bad.status, 400);
  } finally { svc.close(); }
});

test('Phase 7 no-leak: a malformed or oversized request gets a generic error that never quotes the body', async () => {
  const p = ++port;
  const svc = await startAsjpService({ ...base, workers: 1, port: p, maxBodyBytes: 10_000 });
  try {
    const u = `http://127.0.0.1:${p}`;
    const secretText = 'CONTROLLED-MANUSCRIPT-FRAGMENT-' + 'z'.repeat(40);
    const bad = await fetch(`${u}/match`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: `{"text": "${secretText}` });
    const badBody = await bad.text();
    assert.equal(bad.status, 400); assert.equal(badBody.includes('CONTROLLED-MANUSCRIPT'), false);
    const big = await fetch(`${u}/match`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: secretText.repeat(400) }) }).catch(() => null);
    if (big) { const t = await big.text(); assert.equal(t.includes('CONTROLLED-MANUSCRIPT'), false); }
  } finally { svc.close(); }
});
