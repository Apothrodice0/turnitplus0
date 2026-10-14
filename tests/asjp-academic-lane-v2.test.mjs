import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { ASJP_PROVIDER, asjpSourceCards, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';

/**
 * ASJP lane v2 corrections: corpus-grounded generic filter, verbatim completion, self-overlap labels.
 * Invented text only. The build finishes before the first test() is registered.
 */
const scratch = corpusEngineScratch('asjp-lane-v2');
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const asjp = (id, text) => fixtureSource(String(id), text, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title: `title ${id}`, sourceType: 'journal-article', language: 'en' });

const TEMPLATE = inventedText(70, 40); // a 40-word "journal template" sentence
const RARE = inventedText(71, 40); // a 40-word run only the source holds
const NUMBERS = Array.from({ length: 40 }, (_, i) => `${(i * 37) % 97} 0 ${(i * 13) % 89}`).join(' '); // 120 numeric tokens
const S = [inventedText(72, 600), TEMPLATE, inventedText(73, 300), RARE, inventedText(74, 300), NUMBERS, inventedText(75, 300)].join(' ');
const holders = Array.from({ length: 4 }, (_, k) => [inventedText(80 + k, 400), TEMPLATE, inventedText(90 + k, 400)].join(' '));

const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  asjp(2001, S), ...holders.map((text, k) => asjp(2010 + k, text)),
  ...Array.from({ length: 20 }, (_, index) => fixtureSource(`noise-${index}`, inventedText(300 + index, 500))),
])]);
const store = new LocalDirectoryObjectStore(root);
const entry = (id, authors) => ({ articleId: String(id), canonicalUrl: url(id), title: `title ${id}`, authors, journal: 'J', issn: null, publicationDate: '2024-01-01', doi: null, license: 'CC BY', licenseBasis: 'ARTICLE_PDF', licenceStatus: 'PERMITTED', reusePermitted: true, withdrawn: false });
const catalog = (id) => (Number(id) >= 2001 && Number(id) <= 2013 ? entry(id, ['Kherbouche, Amina']) : null);
const run = (text, extra = {}) => runAsjpAcademicLane({ store, generationId: built.generationId, submissionText: text, catalog, ignoreFlag: true, ...extra });
const filler = (seed, n) => inventedText(60_000 + seed, n);
const at = (parts, index) => wordsOf(parts.slice(0, index).join(' ')).length;
test.after(() => removeScratch(scratch));

// manuscript: 90 words of S (admits S) · gap · the TEMPLATE (in S + 4 others) · gap · RARE (only S) · gap · NUMBERS
const parts = [filler(1, 200), sliceWords(S, 50, 90), filler(2, 200), TEMPLATE, filler(3, 200), RARE, filler(4, 200), NUMBERS, filler(5, 200)];
const manuscript = parts.join(' ');
const range = (start, n) => Array.from({ length: n }, (_, i) => start + i);
const v2 = await run(manuscript);
const v1 = await run(manuscript, { corrections: { selfOverlapLabels: false, genericFilter: false, verbatimCompletion: false } });
const source = (r) => r.sources.find((s) => s.sourceId === 'asjp:2001');

test('v2 generic filter: a run that stands in >= 3 other indexed articles is not credited; a rare run is', () => {
  const credited = new Set(v2.creditedPositions);
  assert.ok(range(at(parts, 3), 40).every((q) => !credited.has(q)), 'the template run is not credited');
  assert.ok(range(at(parts, 5), 40).every((q) => credited.has(q)), 'the rare run stays credited');
  assert.ok(range(at(parts, 1), 90).every((q) => credited.has(q)), 'the copied passage stays credited');
  const s = source(v2);
  assert.equal(s.genericWords, 40);
  assert.ok(s.genericClusters[0].otherArticles >= 3);
  assert.ok(new Set(v1.creditedPositions).has(at(parts, 3)), 'without the filter the template is credited');
});

test('v2 verbatim completion: a long verbatim numeric run of an admitted article is credited', () => {
  const credited = new Set(v2.creditedPositions);
  const numbers = range(at(parts, 7), wordsOf(NUMBERS).length);
  assert.ok(numbers.every((q) => credited.has(q)));
  assert.ok(source(v2).completionWords >= 0);
  const passage = source(v2).matchedPassages.find((p) => p.submittedWordStart <= numbers[0] && p.submittedWordEnd >= numbers[0]);
  assert.equal(S.slice(passage.sourceCharStart, passage.sourceCharEnd).split(/\s+/).length, passage.matchedWordCount, 'source offsets cover the same words');
});

test('v2 labels: an article author in the manuscript byline marks SAME_AUTHORS_OTHER_WORK and the words stay credited', async () => {
  const withByline = `amina kherbouche university of somewhere ${manuscript}`;
  const r = await run(withByline);
  const s = source(r);
  assert.equal(s.relationship, 'SAME_AUTHORS_OTHER_WORK');
  assert.deepEqual(s.authorMatches, ['kherbouche']);
  assert.equal(s.credited, true);
  assert.equal(r.creditedPositions.length, v2.creditedPositions.length, 'the label changes nothing in the score');
  assert.equal(asjpSourceCards(r).find((c) => c.sourceId === 'asjp:2001').attribution, 'SELF_OVERLAP_SAME_AUTHORS');
  assert.equal(source(v2).relationship, 'INDEPENDENT_PUBLICATION', 'no byline, no label');
});

test('v2 with every correction off gives the v1 behaviour', () => {
  const s = source(v1);
  assert.equal(s.genericWords, 0);
  assert.equal(s.completionWords, 0);
  assert.deepEqual(s.authorMatches, []);
});
