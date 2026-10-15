import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { ASJP_ACADEMIC_LANE_VERSION, ASJP_PROVIDER, asjpSourceCards, asjpPublicationEvidenceOf, repetitionForm, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';

/**
 * ASJP lane v5 (Phase 6.5): repetition never removes verified words (a REPEATED_FORM label instead; v4 removed 14 of
 * 18 genuine repetitive copies on the second independent evaluation), shared labels for clusters of any length, and
 * co-credited text — words several credited articles hold — labelled shared even when extraction differences keep the
 * exact index probe from finding the other holders. Invented text only.
 */
const scratch = corpusEngineScratch('asjp-lane-v5');
test.after(() => removeScratch(scratch));
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const asjp = (id, text) => fixtureSource(String(id), text, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title: `title ${id}`, sourceType: 'journal-article', language: 'en' });
const tok = (t) => tokensForScoringNormalization(t, 2);
const names = inventedText(900, 40).split(' ');
// a genuine list of hypotheses: one sentence pattern repeated with different variables
const HYPOTHESES = Array.from({ length: 8 }, (_, k) => `h${k + 1} there is a statistically significant relationship between ${names[k]} and the level of job performance among the employees of the institution at the significance level`).join(' ');
// a 70-word passage two articles hold — the second with one word changed in its middle (an extraction difference)
const SHARED = inventedText(910, 70);
const sharedWords = SHARED.split(' ');
const SHARED_VARIANT = [...sharedWords.slice(0, 35), 'zzvariant', ...sharedWords.slice(36)].join(' ');
const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  asjp(7001, [inventedText(920, 400), HYPOTHESES, inventedText(921, 400)].join(' ')),
  asjp(7002, [inventedText(930, 400), SHARED, inventedText(931, 400)].join(' ')),
  asjp(7003, [inventedText(940, 400), SHARED_VARIANT, inventedText(941, 400)].join(' ')),
  ...Array.from({ length: 20 }, (_, i) => fixtureSource(`noise-${i}`, inventedText(950 + i, 500))),
])]);
const store = new LocalDirectoryObjectStore(root);
const entry = (id) => ({ articleId: String(id), canonicalUrl: url(id), title: `title ${id}`, authors: ['Author, A.'], journal: 'J', issn: null, publicationDate: '2024-01-01', doi: null, license: 'CC BY', licenseBasis: 'ARTICLE_PDF', licenceStatus: 'PERMITTED', reusePermitted: true, withdrawn: false });
const catalog = (id) => (Number(id) >= 7001 && Number(id) <= 7003 ? entry(id) : null);
const run = (text, extra = {}) => runAsjpAcademicLane({ store, generationId: built.generationId, submissionText: text, catalog, ignoreFlag: true, ...extra });
const filler = (seed, n) => inventedText(80_000 + seed, n);
const parts = [filler(1, 300), HYPOTHESES, filler(2, 300), SHARED, filler(3, 300)];
const manuscript = parts.join(' ');
const at = (index) => wordsOf(parts.slice(0, index).join(' ')).length;
const hypothesesStart = at(1), hypothesesWords = tok(HYPOTHESES).length, sharedStart = at(3);
const result = await run(manuscript);
const src = (id) => result.sources.find((s) => s.sourceId === `asjp:${id}`);

test('v5 is the lane version', () => assert.equal(ASJP_ACADEMIC_LANE_VERSION, 'asjp-academic-lane-v5'));

test('a copied list of hypotheses stays credited, labelled REPEATED_FORM (v4 removed it)', async () => {
  assert.ok(repetitionForm(tok(HYPOTHESES)), 'fixture sanity: the v4 repetition rule fires on it');
  const s = src(7001);
  assert.equal(s.credited, true);
  for (let q = hypothesesStart; q < hypothesesStart + hypothesesWords; q += 1) assert.ok(result.creditedPositions.includes(q), `word ${q} credited`);
  const label = s.annotations.find((a) => a.kind === 'REPEATED_FORM');
  assert.ok(label && label.category === 'PLACEHOLDER_REPETITION' && label.evidence.repeatedShare >= 0.8);
  assert.equal(s.structuralWords, 0);
  const card = asjpSourceCards(result).find((c) => c.sourceId === 'asjp:7001');
  assert.equal(card.repeatedFormWords, label.words);
  assert.equal(card.attribution, 'PUBLISHED_SOURCE', 'a repeated pattern alone is not shared text');
  // v4 reproduction on request: the same cluster is removed again
  const v4 = await run(manuscript, { corrections: { repetitionRemoval: true } });
  assert.equal(v4.sources.find((x) => x.sourceId === 'asjp:7001').credited, false);
  assert.equal(v4.sources.find((x) => x.sourceId === 'asjp:7001').notCreditedReason, 'STRUCTURAL_BOILERPLATE');
});

test('text two credited articles hold is labelled shared — even where the exact probe misses the other holder', () => {
  const a = src(7002), b = src(7003);
  assert.equal(a.credited, true); assert.equal(b.credited, true);
  for (const s of [a, b]) {
    const shared = s.annotations.find((x) => x.kind === 'SHARED_ACADEMIC_TEXT');
    assert.ok(shared && shared.otherArticles >= 1 && shared.originEstablished === false, `${s.sourceId} labelled shared`);
    assert.equal(asjpSourceCards(result).find((c) => c.sourceId === s.sourceId).attribution, 'SHARED_TEXT_ORIGIN_NOT_ESTABLISHED');
  }
  // labels only: the union still counts every word once
  const union = computeUnifiedSimilarity({ wordCount: result.submissionWordCount, archiveMatchedPositions: [], asjpPublicationEvidence: asjpPublicationEvidenceOf(result) });
  assert.equal(union.uniqueMatchedWords, result.creditedPositions.length);
  assert.ok(result.creditedPositions.includes(sharedStart));
});

test('every credited passage carries exact source offsets', () => {
  for (const s of result.sources.filter((x) => x.credited)) for (const p of s.matchedPassages) assert.ok(p.sourceCharStart >= 0 && p.sourceCharEnd > p.sourceCharStart, `${s.sourceId} offsets`);
});
