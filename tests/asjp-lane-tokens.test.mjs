import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { docIdFromDecimal } from '../lib/corpus-engine/ids.ts';
import { ASJP_PROVIDER, openAsjpLaneSession, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';
import { LaneTokenStore, buildLaneTokens } from '../lib/asjp-lane-tokens.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';

/** Prepared lane tokens: exact tokens, identity refusal, and lane answers identical with and without the store. */
const scratch = corpusEngineScratch('asjp-lane-tokens');
test.after(() => removeScratch(scratch));
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const asjp = (id, text) => fixtureSource(String(id), text, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title: `title ${id}`, sourceType: 'journal-article', language: 'en' });
const REF = 'smith j 2015 journal of economics vol 12 no 3 pp 45 67';
const PE = [inventedText(204, 10), REF, inventedText(205, 10), REF.replace('smith', 'brown'), inventedText(208, 10), REF.replace('smith', 'ali'), inventedText(209, 10)].join(' ');
const texts = { 4001: [inventedText(210, 400), inventedText(211, 90), inventedText(212, 400)].join(' '), 4002: [inventedText(220, 400), PE, inventedText(221, 400)].join(' ') };
const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  ...Object.entries(texts).map(([id, t]) => asjp(id, t)), ...Array.from({ length: 20 }, (_, i) => fixtureSource(`noise-${i}`, inventedText(300 + i, 500))),
])]);
const store = new LocalDirectoryObjectStore(root);
const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId });
const tokensDir = path.join(scratch, 'lane-tokens');
const entry = (id) => ({ articleId: String(id), canonicalUrl: url(id), title: `title ${id}`, authors: ['A, B'], journal: 'J', issn: null, publicationDate: '2024-01-01', doi: null, license: 'CC BY', licenseBasis: 'ARTICLE_PDF', licenceStatus: 'PERMITTED', reusePermitted: true, withdrawn: false });
const catalog = (id) => (texts[id] ? entry(id) : null);
const manuscript = [inventedText(70_001, 300), sliceWords(texts[4001], 400, 90), inventedText(70_002, 300), PE, inventedText(70_003, 300)].join(' ');

test('build / open / read: exact lane tokens; another tokenization identity is refused', async () => {
  // the documents' docIds, from a plain lane run (every candidate the verifier saw)
  const r = await runAsjpAcademicLane({ store, generationId: built.generationId, submissionText: manuscript, catalog, ignoreFlag: true, corrections: { rescueMinVerifiedWords: 0 } });
  const ids = [...new Set(r.sources.map((s) => s.docId))];
  assert.ok(ids.length >= 2);
  async function* docs() { for (const d of ids) yield { docId: d, text: (await reader.fetchText(docIdFromDecimal(d))).text }; }
  const counts = await buildLaneTokens(tokensDir, 2, docs());
  assert.equal(counts.docs, ids.length);
  const lt = LaneTokenStore.open(tokensDir, 2);
  for (const d of ids) assert.deepEqual(lt.read(d), tokensForScoringNormalization((await reader.fetchText(docIdFromDecimal(d))).text, 2));
  assert.equal(lt.read('123'), null);
  lt.close();
  const id = JSON.parse(fs.readFileSync(path.join(tokensDir, 'identity.json'), 'utf8'));
  fs.writeFileSync(path.join(tokensDir, 'identity.json'), JSON.stringify({ ...id, probeSha256: '0'.repeat(64) }));
  assert.throws(() => LaneTokenStore.open(tokensDir, 2), /another tokenization/);
  fs.writeFileSync(path.join(tokensDir, 'identity.json'), JSON.stringify(id));
});

test('a lane session with prepared tokens gives the same answer as one without (rescue included)', async () => {
  const plain = await openAsjpLaneSession({ store, generationId: built.generationId });
  const prepared = await openAsjpLaneSession({ store, generationId: built.generationId, laneTokensDir: tokensDir });
  const run = (session) => runAsjpAcademicLane({ store, generationId: built.generationId, submissionText: manuscript, catalog, ignoreFlag: true, session });
  const a = await run(plain), b = await run(prepared);
  assert.deepEqual({ ...b, timings: undefined }, { ...a, timings: undefined });
  assert.ok(a.sources.some((s) => s.credited && s.admittedBy === 'VERBATIM_RESCUE'), 'the fixture exercises the rescue');
  assert.ok(prepared.laneTokens.reads > 0, 'the store was read');
});
