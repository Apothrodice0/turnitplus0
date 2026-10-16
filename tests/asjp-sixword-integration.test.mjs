import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { docIdFromDecimal } from '../lib/corpus-engine/ids.ts';
import { ASJP_PROVIDER, asjpPublicationEvidenceOf, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';
import { AsjpCatalogSource } from '../lib/asjp-catalog-snapshot.ts';
import { buildLaneTokens } from '../lib/asjp-lane-tokens.ts';
import { tokensForScoringNormalization, tokenSpans } from '../lib/similarity-core.ts';
import { buildSixwordIndex } from '../lib/asjp-sixword-index.ts';
import { computeSixwordOverlap, openSixwordOverlapSession } from '../lib/asjp-sixword-overlap.ts';
import { ASJP_SIXWORD_OVERLAP_LABEL, SIXWORD_LIMITS, sixwordOverlapProblem } from '../lib/asjp-sixword-contract.ts';
import { redactWithdrawnHolders, retractSixwordRecord, signSixwordRecord, sixwordAdminView, sixwordRecordFromAnswer, trustedSixwordRecord } from '../lib/report-asjp-sixword-evidence.ts';
import { asjpEvidenceRecordFromAnswer } from '../lib/asjp-report-evidence.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';
import { startAsjpService } from '../services/asjp-matching/server.ts';

/**
 * Six-word overlap integration (local fixtures): exact retrieval, source gates, bounded presentation, scoring
 * isolation, outage, refresh, retraction and report persistence, and the service with the feature off and on.
 */
const scratch = corpusEngineScratch('asjp-sixword-integration');
test.after(async () => { await new Promise((r) => setTimeout(r, 2000)); removeScratch(scratch); });
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const P = { U1: inventedText(801, 18), U2: inventedText(802, 18), U3: inventedText(803, 18), U4: inventedText(804, 18), C: inventedText(900, 9), S: inventedText(901, 14), N: inventedText(902, 12), L: inventedText(903, 90) };
const filler = (seed, n = 300) => inventedText(seed, n);
const art = { 7001: [filler(1), P.U1, filler(2), P.L, filler(3)], 7002: [filler(4), P.U2, filler(5)], 7003: [filler(6), P.U3, filler(7)], 7004: [filler(8), P.U4, filler(9)], 7030: [filler(10), P.S, filler(11)], 7031: [filler(12), P.S, filler(13)] };
for (let k = 0; k < 12; k += 1) art[7010 + k] = [filler(20 + k), P.C, filler(40 + k)];
const texts = Object.fromEntries(Object.entries(art).map(([id, parts]) => [id, parts.join(' ')]));
const meta = (id) => ({ date: id === '7002' ? '2026-06-01' : '2020-01-01', licence: id === '7003' ? 'RESTRICTED' : 'PERMITTED' });
const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  ...Object.entries(texts).map(([id, t]) => fixtureSource(id, t, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title: `title ${id}`, sourceType: 'journal-article', language: 'en' })),
  ...Array.from({ length: 3 }, (_, i) => fixtureSource(`noise-${i}`, `${filler(60 + i)} ${P.N} ${filler(70 + i)}`)),
])]);
const catalogPath = path.join(scratch, 'catalog.sqlite');
{
  const db = new DatabaseSync(catalogPath);
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE journals (journal_id INTEGER PRIMARY KEY, name TEXT, eissn TEXT);
    CREATE TABLE articles (article_id INTEGER PRIMARY KEY, journal_id INTEGER, canonical_url TEXT, title TEXT, authors_json TEXT, publication_date TEXT, doi TEXT);
    CREATE TABLE article_versions (article_id INTEGER, indexed INTEGER, licence TEXT, licence_version TEXT, licence_basis TEXT, licence_status TEXT, reuse_permitted INTEGER, withdrawn INTEGER);
    INSERT INTO journals VALUES (1, 'J', NULL);`);
  for (const id of Object.keys(texts)) {
    db.prepare('INSERT INTO articles VALUES (?, 1, ?, ?, ?, ?, NULL)').run(Number(id), url(id), `title ${id}`, JSON.stringify(['A, B']), meta(id).date);
    db.prepare("INSERT INTO article_versions VALUES (?, 1, 'CC BY', '4.0', 'ARTICLE_PDF', ?, ?, 0)").run(Number(id), meta(id).licence, meta(id).licence === 'PERMITTED' ? 1 : 0);
  }
  db.close();
}
const store = new LocalDirectoryObjectStore(root);
const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId, expectedLogicalManifestSha256: built.logicalManifestSha256 });
const tokensDir = path.join(scratch, 'lane-tokens'), indexDir = path.join(scratch, 'sixword');
async function* docs() { for (const d of reader.allDocumentIds()) yield { docId: String(d), text: (await reader.fetchText(d)).text }; }
await buildLaneTokens(tokensDir, 2, docs());
await buildSixwordIndex({ laneTokensDir: tokensDir, outDir: indexDir, tmpDir: path.join(scratch, 'six-tmp'), partitions: 2, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256 });
const wordDfPath = path.join(scratch, 'word-df.json');
fs.writeFileSync(wordDfPath, JSON.stringify({ documents: 21, df: {} }));
const wordDf = JSON.parse(fs.readFileSync(wordDfPath, 'utf8'));
const pieces = [filler(1001), P.U1, filler(1002), P.U2, filler(1003), P.U3, filler(1004), P.U4, filler(1005), P.C, filler(1006), P.S, filler(1007), P.N, filler(1008), P.L, filler(1009)];
const manuscript = pieces.join(' ');
const words = tokensForScoringNormalization(manuscript, 2);
const startOf = (k) => tokensForScoringNormalization(pieces.slice(0, k).join(' '), 2).length;
const at = { U1: startOf(1), U2: startOf(3), U3: startOf(5), U4: startOf(7), C: startOf(9), S: startOf(11), N: startOf(13), L: startOf(15) };
const catalog = await AsjpCatalogSource.open(catalogPath, { immutable: false });
const session = await openSixwordOverlapSession({ indexDir, reader, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordDf });
const fetchText = async (docId) => { const f = await reader.fetchText(docIdFromDecimal(docId)); return f.state === 'OK' ? f.text : null; };
const lane = await runAsjpAcademicLane({ store, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, submissionText: manuscript, catalog: catalog.entry, ignoreFlag: true, licencePolicy: 'permitted-only' });
const overlap = (extra = {}) => computeSixwordOverlap(session, { text: manuscript, referenceDate: '2025-01-01', licencePolicy: 'permitted-only', catalog: catalog.entry, catalogDigest: catalog.current.digest, creditedPositions: lane.creditedPositions ?? [], fetchText, ...extra });
const matchAt = (r, s) => r.matches.find((m) => m.submittedWordStart <= s && m.submittedWordEnd >= s);

test('exact retrieval: verified spans and offsets; gates; no origin claim; the contract validator accepts the answer', async () => {
  const r = await overlap();
  assert.equal(r.state, 'COMPLETE');
  assert.equal(r.scored, false);
  assert.equal(r.label, ASJP_SIXWORD_OVERLAP_LABEL);
  assert.equal(sixwordOverlapProblem(r, words.length), null);
  for (const m of r.matches) {
    assert.equal(m.scored, false); assert.equal(m.originEstablished, false);
    for (const h of m.holders) {
      const articleId = h.sourceId.replace('asjp:', '');
      assert.equal(r.sources[h.sourceId].articleId, articleId);
      const src = tokensForScoringNormalization(texts[articleId], 2);
      assert.deepEqual(src.slice(h.sourceWordStart, h.sourceWordEnd + 1), words.slice(m.submittedWordStart, m.submittedWordEnd + 1), 'word positions verified');
      if (h.sourceCharStart !== null) assert.deepEqual(tokensForScoringNormalization(texts[articleId].slice(h.sourceCharStart, h.sourceCharEnd), 2), words.slice(m.submittedWordStart, m.submittedWordEnd + 1), 'char offsets verified');
    }
  }
  const u1 = matchAt(r, at.U1);
  assert.deepEqual([u1.submittedWordStart, u1.submittedWordEnd], [at.U1, at.U1 + 17]);
  assert.deepEqual(u1.holders.map((h) => h.sourceId), ['asjp:7001']);
  assert.equal(u1.commonness, 'UNIQUE');
  assert.equal(matchAt(r, at.U2), undefined, 'a holder published after the reference date is never shown');
  assert.equal(matchAt(r, at.U3), undefined, 'a non-permitted holder is never shown under permitted-only');
  assert.equal(matchAt(r, at.N), undefined, 'a document without ASJP identity is never a source');
  assert.ok(r.summary.withoutEligibleHolder >= 3);
  const s = matchAt(r, at.S);
  assert.equal(s.commonness, 'SHARED'); assert.deepEqual(s.holders.map((h) => h.sourceId).sort(), ['asjp:7030', 'asjp:7031']);
  const local = await overlap({ referenceDate: null, licencePolicy: 'local-research-all' });
  assert.deepEqual(matchAt(local, at.U2).holders.map((h) => h.sourceId), ['asjp:7002']);
  assert.deepEqual(matchAt(local, at.U3).holders.map((h) => h.sourceId), ['asjp:7003']);
});

test('bounded presentation: a phrase held by 12 articles lists 8, counts the rest, and caps never hide counts', async () => {
  const r = await overlap();
  const c = matchAt(r, at.C);
  assert.equal(c.commonness, 'COMMON'); assert.equal(c.holdersInIndex, 12); assert.equal(c.eligibleHolders, 12);
  assert.equal(c.holders.length, SIXWORD_LIMITS.maxHoldersShown); assert.equal(c.holdersOmitted, 4);
  assert.equal(r.truncation.matchesWithHoldersOmitted, 1);
  const tight = await overlap({ limits: { maxMatchesShown: 1, maxCommonShown: 0, maxOffsetArticles: 0 } });
  assert.equal(tight.matches.length, 1);
  assert.equal(tight.matches[0].submittedWordStart, at.L, 'UNIQUE first, longest first');
  assert.equal(tight.truncation.matchesOmitted, r.matches.length - 1);
  assert.ok(tight.matches[0].holders.every((h) => h.sourceCharStart === null && h.sourceCharEnd === null), 'past the offset budget: word positions only, never a guessed offset');
  assert.equal(tight.summary.matches, r.summary.matches, 'retrieval stays complete');
});

test('scoring isolation: lane-credited words are reported, the score and the scored ASJP record are unchanged', async () => {
  const r = await overlap();
  const l = matchAt(r, at.L);
  assert.equal(l.wordsAlreadyCreditedByLane, 90, 'the 90-word passage is the lane\'s scored evidence');
  const score = () => JSON.stringify(computeUnifiedSimilarity({ wordCount: words.length, archiveMatchedPositions: [], asjpPublicationEvidence: asjpPublicationEvidenceOf(lane) }));
  const before = score();
  const answer = { state: 'COMPLETE', generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, licencePolicy: 'permitted-only', normalization: 2, wordCount: words.length, cards: [], asjpPublicationEvidence: [] };
  const expected = { generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordCount: words.length, text: manuscript };
  const a = asjpEvidenceRecordFromAnswer(answer, expected, true), b = asjpEvidenceRecordFromAnswer({ ...answer, research: { sixwordOverlap: r } }, expected, true);
  assert.deepEqual({ ...a, checkedAt: 0 }, { ...b, checkedAt: 0 }, 'the scored record never carries the six-word block');
  assert.equal(score(), before);
  for (const f of ['lib/unified-similarity.ts', 'lib/report-primary-similarity.ts', 'lib/asjp-report-evidence.ts', 'lib/report-asjp-evidence.ts', 'lib/asjp-academic-lane.ts']) assert.ok(!/sixword/i.test(fs.readFileSync(f, 'utf8')), `${f} never reads six-word data`);
});

test('outage: missing index, other generation, pair and time budgets — coded, never partial', async () => {
  const open = (o) => openSixwordOverlapSession({ indexDir, reader, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, wordDf, ...o });
  await assert.rejects(open({ indexDir: path.join(scratch, 'nope') }), /INDEX_UNAVAILABLE/);
  await assert.rejects(open({ logicalManifestSha256: '0'.repeat(64) }), /GENERATION_MISMATCH/);
  const pairs = await overlap({ limits: { maxPairs: 1 } });
  assert.deepEqual([pairs.state, pairs.reason, pairs.matches.length], ['INCOMPLETE_BUDGET', 'PAIRS_BUDGET', 0]);
  const time = await overlap({ limits: { timeBudgetMs: -1 } });
  assert.deepEqual([time.state, time.matches.length], ['INCOMPLETE_BUDGET', 0]);
  assert.equal(sixwordOverlapProblem(time, words.length), null);
  const record = sixwordRecordFromAnswer(time, { text: manuscript, wordCount: words.length, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256 });
  assert.deepEqual([record.status, record.reason, record.matches.length], ['UNAVAILABLE', 'INCOMPLETE_BUDGET_TIME_BUDGET', 0]);
});

test('refresh (takedown): a withdrawn article stops being a holder after the catalog refresh', async () => {
  try {
    const db = new DatabaseSync(catalogPath); db.exec('UPDATE article_versions SET withdrawn = 1 WHERE article_id = 7004'); db.close();
    assert.ok(matchAt(await overlap(), at.U4), 'before the refresh the snapshot still holds it');
    assert.equal(await catalog.refresh(), true);
    assert.equal(matchAt(await overlap(), at.U4), undefined);
    assert.equal(matchAt(await overlap({ licencePolicy: 'local-research-all' }), at.U4), undefined, 'withdrawn under every policy');
  } finally { const db = new DatabaseSync(catalogPath); db.exec('UPDATE article_versions SET withdrawn = 0'); db.close(); await catalog.refresh(); }
});

test('report persistence: signed for one report and owner; tamper, move or no key -> never shown; retraction; redaction; admin view only', async () => {
  const r = await overlap();
  const expected = { text: manuscript, wordCount: words.length, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256 };
  const key = 'k'.repeat(40), binding = { reportDeviceKey: 'dev-1', reportId: 'rep-1', accountId: 'acct-1' };
  const record = signSixwordRecord(sixwordRecordFromAnswer(r, expected), binding, key);
  assert.equal(record.status, 'ACCEPTED'); assert.equal(record.scored, false);
  assert.ok(trustedSixwordRecord(record, binding, key));
  assert.equal(trustedSixwordRecord(record, { ...binding, reportId: 'rep-2' }, key), null, 'moved to another report');
  assert.equal(trustedSixwordRecord(record, { ...binding, accountId: 'acct-2' }, key), null, 'another owner');
  assert.equal(trustedSixwordRecord(record, binding, null), null, 'no key: fail closed');
  const forged = JSON.parse(JSON.stringify(record)); forged.sources[forged.matches[0].holders[0].sourceId].title = 'forged';
  assert.equal(trustedSixwordRecord(forged, binding, key), null, 'tampered');
  const reloaded = JSON.parse(JSON.stringify(record));
  assert.deepEqual(trustedSixwordRecord(reloaded, binding, key), record, 'deterministic reload');
  assert.equal(sixwordRecordFromAnswer({ ...r, pins: { ...r.pins, generationId: 'gen-other' } }, expected).reason, 'GENERATION_MISMATCH');
  assert.equal(sixwordRecordFromAnswer({ ...r, matches: [{ ...r.matches[0], scored: true }] }, expected).reason, 'MALFORMED_MATCH_NOT_INFORMATIONAL');
  assert.equal(sixwordRecordFromAnswer(r, { ...expected, wordCount: words.length + 1 }).status, 'UNAVAILABLE');
  const redacted = signSixwordRecord(redactWithdrawnHolders(record, (a) => a === '7001'), binding, key);
  assert.ok(!redacted.matches.some((m) => m.holders.some((h) => h.sourceId === 'asjp:7001')));
  assert.equal(redacted.sources['asjp:7001'], undefined, 'no orphan source facts remain');
  assert.ok(redacted.truncation.redactedHolders >= 1);
  const retracted = signSixwordRecord(retractSixwordRecord(record, 'ROLLBACK'), binding, key);
  assert.deepEqual([retracted.status, retracted.matches.length], ['RETRACTED', 0]);
  const env = { ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED: 'true' };
  assert.equal(sixwordAdminView(record, binding, {}, key), null, 'display flag off: nothing');
  const view = sixwordAdminView(record, binding, env, key);
  assert.ok(view.items.length > 0 && view.items.every((i) => i.scored === false && i.label === ASJP_SIXWORD_OVERLAP_LABEL && /original source not established/.test(i.held)));
  assert.deepEqual(sixwordAdminView(retracted, binding, env, key).items, []);
  // byte bound: a record larger than the cap is trimmed (COMMON first, then the shortest) and says so
  const m0 = r.matches[0];
  const bigMatches = Array.from({ length: 150 }, (_, k) => ({ ...m0, submittedWordStart: k, submittedWordEnd: k + m0.words - 1, holders: [{ ...m0.holders[0], sourceId: `asjp:${90000 + k}` }], eligibleHolders: 1, holdersOmitted: 0 })).filter((m) => m.submittedWordEnd < words.length);
  const big = { ...r, matches: bigMatches, sources: Object.fromEntries(bigMatches.map((m) => [m.holders[0].sourceId, { sourceId: m.holders[0].sourceId, articleId: m.holders[0].sourceId.slice(5), title: 'x'.repeat(2000), journal: null, publicationDate: null, canonicalUrl: null }])) };
  assert.equal(sixwordOverlapProblem(big, words.length), null);
  const trimmed = sixwordRecordFromAnswer(big, expected);
  assert.ok(trimmed.truncation.recordTrimmedMatches > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= SIXWORD_LIMITS.maxRecordBytes);
  assert.equal(Object.keys(trimmed.sources).length, trimmed.matches.length, 'sources pruned with their matches');
});

test('service: /match is identical with the feature off or on; /sixword only on request; a broken index never touches /match', async () => {
  process.env.ASJP_SERVICE_ENABLED = 'true';
  const generation = { root, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, catalogPath, catalogImmutable: false, licencePolicy: 'permitted-only', laneTokensDir: tokensDir };
  const T1 = 'f'.repeat(0) + '0123456789abcdef'.repeat(3), A1 = 'fedcba9876543210'.repeat(3);
  const base = { token: T1, adminToken: A1, workers: 1, queueLimit: 8, deadlineMs: 30_000, maxWords: 60_000, allowedRoots: [scratch] };
  let port = 47_620;
  const post = async (p, url, body) => { const r = await fetch(`http://127.0.0.1:${p}${url}`, { method: 'POST', headers: { authorization: `Bearer ${T1}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const run = async (features) => {
    const p = ++port; const svc = await startAsjpService({ ...base, port: p, generation: { ...generation, features } });
    try {
      const match = (await post(p, '/match', { text: manuscript, referenceDate: '2025-01-01' })).body;
      const six = await post(p, '/sixword', { text: manuscript, referenceDate: '2025-01-01', creditedPositions: match.creditedPositions });
      const bad = await post(p, '/sixword', { text: manuscript, creditedPositions: ['x'] });
      return { match, six, bad };
    } finally { svc.close(); }
  };
  const strip = (m) => ({ ...m, id: 0, workerMs: 0, totalMs: 0, laneTimings: null, rssMb: 0, catalogLoadedAt: 0 });
  const off = await run({ numericTables: false, shortSignal: null });
  const on = await run({ numericTables: false, shortSignal: null, sixwordOverlap: { indexDir, wordDfPath } });
  const broken = await run({ numericTables: false, shortSignal: null, sixwordOverlap: { indexDir: path.join(scratch, 'six-tmp'), wordDfPath } });
  assert.equal(off.six.status, 404, 'off: /sixword does not exist');
  assert.deepEqual(strip(on.match), strip(off.match), '/match is byte-for-byte the same answer (timings aside) with the feature on');
  assert.deepEqual(strip(broken.match), strip(off.match));
  assert.equal(on.match.research, undefined);
  assert.equal(on.six.status, 200, JSON.stringify(on.six.body).slice(0, 300)); assert.equal(on.six.body.state, 'COMPLETE');
  assert.equal(sixwordOverlapProblem(on.six.body, on.match.wordCount), null);
  assert.equal(matchAt(on.six.body, at.L).wordsAlreadyCreditedByLane, 90, 'credited positions supplied by the caller are honoured');
  assert.equal(on.bad.status, 400);
  assert.deepEqual([broken.six.status, broken.six.body.state, broken.six.body.reason], [200, 'UNAVAILABLE', 'INDEX_UNAVAILABLE']);
  await assert.rejects(startAsjpService({ ...base, port: ++port, generation: { ...generation, features: { sixwordOverlap: { indexDir: 'C:/elsewhere', wordDfPath } } } }), /outside the allowed roots/);
});

test('protocol v2 on /sixword: signed attest + signed answer accepted; a wrong key gets no manuscript; size and date limits hold', async () => {
  const { requestSixwordOverlap } = await import('../lib/asjp-sixword-report.ts');
  process.env.ASJP_SERVICE_ENABLED = 'true';
  const T1 = '0123456789abcdef'.repeat(3), A1 = 'fedcba9876543210'.repeat(3), RK = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const generation = { root, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, catalogPath, catalogImmutable: false, licencePolicy: 'permitted-only', laneTokensDir: tokensDir, features: { numericTables: false, shortSignal: null, sixwordOverlap: { indexDir, wordDfPath } } };
  const port = 47_690;
  const svc = await startAsjpService({ token: T1, adminToken: A1, requestSigningKey: RK, workers: 1, queueLimit: 8, deadlineMs: 30_000, maxWords: 5_000, allowedRoots: [scratch], port, generation });
  try {
    const config = { url: `http://127.0.0.1:${port}`, token: T1, generationId: built.generationId, logicalManifestSha256: built.logicalManifestSha256, laneVersion: null, timeoutMs: 30_000, allowLocalResearchPolicy: false, accessHeaders: {}, requestSigningKey: RK };
    const ok = await requestSixwordOverlap(config, { text: manuscript, referenceDate: '2025-01-01', creditedPositions: [], excludeSourceIds: ['asjp:7001'] });
    assert.equal(ok.state, 'COMPLETE', JSON.stringify(ok).slice(0, 200));
    assert.equal(sixwordOverlapProblem(ok, words.length), null);
    assert.equal(matchAt(ok, at.U1), undefined, 'a withdrawn (excluded) article is never a holder');
    const wrong = await requestSixwordOverlap({ ...config, requestSigningKey: 'ffffeeeeddddccccbbbbaaaa99998888777766665555' }, { text: manuscript, referenceDate: null, creditedPositions: [], excludeSourceIds: [] });
    assert.deepEqual(wrong, { state: 'UNAVAILABLE', failureCode: 'SERVICE_NOT_AUTHENTICATED' });
    const tooLong = await requestSixwordOverlap(config, { text: inventedText(5, 6_000), referenceDate: null, creditedPositions: [], excludeSourceIds: [] });
    assert.deepEqual([tooLong.state, tooLong.failureCode], ['REJECTED', 'TOO_LONG']);
    const badDate = await requestSixwordOverlap(config, { text: 'a b c', referenceDate: '2025-1-1', creditedPositions: [], excludeSourceIds: [] });
    assert.equal(badDate.error, 'referenceDate must be YYYY-MM-DD');
  } finally { svc.close(); }
});
