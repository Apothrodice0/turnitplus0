import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import {
  ASJP_ACADEMIC_LANE_VERSION,
  ASJP_PROVIDER,
  anchoredPassages,
  openAsjpLaneSession,
  publicationTimingOf,
  asjpPublicationEvidenceOf,
  asjpSourceCards,
  runAsjpAcademicLane,
} from '../lib/asjp-academic-lane.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';

/**
 * ASJP academic-publication lane: a source earns credit only when its indexed text supports the manuscript passage
 * AND its identity and licence are confirmed. All text here is invented; nothing reads a real corpus.
 * The build finishes before the first test() is registered.
 */

const scratch = corpusEngineScratch('asjp-lane');
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const asjp = (id, text, title) => fixtureSource(String(id), text, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title, sourceType: 'journal-article', language: 'en' });

const OWN = inventedText(11, 1500); // 1001: the manuscript's own published version
const INDEPENDENT = inventedText(12, 1500); // 1002: an independent article the manuscript copies from
const HELD = inventedText(13, 1500); // 1003: indexed, but the catalog holds it for licensing
const UNKNOWN = inventedText(14, 1500); // 1004: in the generation, absent from the catalog
const FOREIGN = inventedText(15, 1500); // not an ASJP record at all
const WITHDRAWN = inventedText(16, 1500); // 1006: withdrawn after indexing
const MOVED = inventedText(17, 1500); // 1007: the catalog's URL differs from the generation's
const TITLE_1002 = inventedText(912, 8); // stands in no article's text
const TITLE_1001 = sliceWords(OWN, 0, 7); // the own article opens with its title

const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  asjp(1001, OWN, TITLE_1001),
  asjp(1002, INDEPENDENT, TITLE_1002),
  asjp(1003, HELD, inventedText(913, 8)),
  asjp(1004, UNKNOWN, inventedText(914, 8)),
  fixtureSource('foreign-1', FOREIGN, { canonicalUrl: 'https://example.org/foreign-1', title: 'foreign' }),
  asjp(1006, WITHDRAWN, inventedText(916, 8)),
  asjp(1007, MOVED, inventedText(917, 8)),
  ...Array.from({ length: 20 }, (_, index) => fixtureSource(`noise-${index}`, inventedText(300 + index, 500))),
])]);
const store = new LocalDirectoryObjectStore(root);

const entry = (id, title, overrides = {}) => ({
  articleId: String(id), canonicalUrl: url(id), title, authors: ['Author, A.'], journal: 'Fixture Journal', issn: '0000-0000', publicationDate: '2024-06-30', doi: null,
  license: 'CC BY 4.0', licenseBasis: 'ARTICLE_PDF', reusePermitted: true, withdrawn: false, ...overrides,
});
const CATALOG = new Map([
  ['1001', entry(1001, TITLE_1001, { doi: '10.1234/own.1001' })],
  ['1002', entry(1002, TITLE_1002)],
  ['1003', entry(1003, 'held', { license: 'CC BY-NC 4.0', licenceStatus: 'RESTRICTED', reusePermitted: false })],
  ['1006', entry(1006, 'withdrawn', { withdrawn: true })],
  ['1007', entry(1007, 'moved', { canonicalUrl: 'https://asjp.cerist.dz/en/article/9999' })],
]);
const catalog = (id) => CATALOG.get(id) ?? null;
const filler = (seed, count) => inventedText(50_000 + seed, count);
const run = (submissionText, extra = {}) => runAsjpAcademicLane({ store, generationId: built.generationId, submissionText, catalog, ignoreFlag: true, ...extra });
const byId = (result, id) => result.sources.find((source) => source.sourceId === id);

// words 0-299 original · 300-389 from 1002 · 390-689 original · 690-779 from 1003 · 780-1079 original · 1080-1169 from
// 1004 · 1170-1469 original · 1470-1559 from the foreign record · 1560-1859 original · 1860-1949 from 1006 ·
// 1950-2249 original · 2250-2339 from 1007 · 2340-2639 original
const copying = [
  filler(1, 300), sliceWords(INDEPENDENT, 400, 90), filler(2, 300), sliceWords(HELD, 400, 90), filler(3, 300), sliceWords(UNKNOWN, 400, 90),
  filler(4, 300), sliceWords(FOREIGN, 400, 90), filler(5, 300), sliceWords(WITHDRAWN, 400, 90), filler(6, 300), sliceWords(MOVED, 400, 90), filler(7, 300),
].join(' ');
const copyingResult = await run(copying);

test.after(() => removeScratch(scratch));

test('ASJP lane: disabled unless ASJP_ACADEMIC_LANE_ENABLED is "true"', async () => {
  const before = process.env.ASJP_ACADEMIC_LANE_ENABLED;
  delete process.env.ASJP_ACADEMIC_LANE_ENABLED;
  try {
    assert.deepEqual(await runAsjpAcademicLane({ store, generationId: built.generationId, submissionText: copying, catalog }), { version: ASJP_ACADEMIC_LANE_VERSION, state: 'DISABLED' });
  } finally {
    if (before !== undefined) process.env.ASJP_ACADEMIC_LANE_ENABLED = before;
  }
});

test('ASJP lane: a verbatim passage of an indexed, licensed article is credited at its exact manuscript and source positions', () => {
  assert.equal(copyingResult.state, 'COMPLETE');
  const source = byId(copyingResult, 'asjp:1002');
  assert.ok(source, 'the copied article is a source');
  assert.equal(source.credited, true);
  assert.equal(source.relationship, 'INDEPENDENT_PUBLICATION');
  assert.equal(source.unsupportedWords, 0);
  const covered = new Set();
  for (const passage of source.matchedPassages) for (let position = passage.submittedWordStart; position <= passage.submittedWordEnd; position += 1) covered.add(position);
  assert.deepEqual([...covered].sort((a, b) => a - b), Array.from({ length: 90 }, (_, index) => 300 + index));
  const manuscript = wordsOf(copying);
  const article = wordsOf(INDEPENDENT);
  for (const passage of source.matchedPassages) {
    assert.equal(passage.sourceWordStart - 400, passage.submittedWordStart - 300, 'the source position is where the words stand in the article');
    assert.deepEqual(manuscript.slice(passage.submittedWordStart, passage.submittedWordEnd + 1), article.slice(passage.sourceWordStart, passage.sourceWordEnd + 1));
    assert.equal(INDEPENDENT.slice(passage.sourceCharStart, passage.sourceCharEnd), article.slice(passage.sourceWordStart, passage.sourceWordEnd + 1).join(' '));
  }
});

test('ASJP lane: identity and licence gates — held, unknown, foreign, withdrawn and moved sources earn nothing', () => {
  assert.equal(byId(copyingResult, 'asjp:1003').notCreditedReason, 'LICENCE_NOT_PERMITTING');
  assert.equal(byId(copyingResult, 'asjp:1004').notCreditedReason, 'NOT_IN_CATALOG');
  assert.equal(byId(copyingResult, 'asjp:1006').notCreditedReason, 'WITHDRAWN');
  assert.equal(byId(copyingResult, 'asjp:1007').notCreditedReason, 'UNVERIFIED_SOURCE_IDENTITY');
  const foreign = copyingResult.sources.filter((source) => source.sourceId.startsWith('asjp-doc:'));
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].notCreditedReason, 'UNVERIFIED_SOURCE_IDENTITY');
  assert.equal(copyingResult.sources.filter((source) => source.credited).length, 1);
  assert.deepEqual(copyingResult.creditedPositions, Array.from({ length: 90 }, (_, index) => 300 + index));
  assert.deepEqual(asjpPublicationEvidenceOf(copyingResult).map((source) => source.sourceId), ['asjp:1002']);
});

test('ASJP lane: the local-research licence policy credits a non-permitted article and labels its status; the default does not', async () => {
  const local = await run(copying, { licencePolicy: 'local-research-all' });
  const held = byId(local, 'asjp:1003');
  assert.equal(held.credited, true);
  assert.equal(held.publication.licenceStatus, 'RESTRICTED');
  const card = asjpSourceCards(local).find((x) => x.sourceId === 'asjp:1003');
  assert.equal(card.licenceStatus, 'RESTRICTED');
  // identity, withdrawal and catalog gates still apply under the local policy
  assert.equal(byId(local, 'asjp:1004').notCreditedReason, 'NOT_IN_CATALOG');
  assert.equal(byId(local, 'asjp:1006').notCreditedReason, 'WITHDRAWN');
  assert.equal(byId(local, 'asjp:1007').notCreditedReason, 'UNVERIFIED_SOURCE_IDENTITY');
  assert.equal(byId(copyingResult, 'asjp:1003').credited, false, 'default policy');
});

test('ASJP lane: a title alone, or a short phrase, is not a text match', async () => {
  const titleOnly = await run([filler(21, 400), TITLE_1002, filler(22, 400)].join(' '));
  assert.equal(titleOnly.state, 'COMPLETE');
  assert.equal(titleOnly.sources.filter((source) => source.credited).length, 0);
  assert.deepEqual(titleOnly.creditedPositions, []);
  const shortPhrase = await run([filler(23, 400), sliceWords(INDEPENDENT, 700, 15), filler(24, 400)].join(' '));
  assert.equal(shortPhrase.sources.filter((source) => source.credited).length, 0);
  assert.deepEqual(shortPhrase.creditedPositions, []);
  assert.deepEqual(asjpSourceCards(shortPhrase), []);
});

test('ASJP lane: the manuscript\'s own published version counts, attributed as previously published work; "exclude" reproduces a benchmark', async () => {
  const manuscript = [OWN, filler(31, 100)].join(' ');
  const counted = await run(manuscript);
  const published = byId(counted, 'asjp:1001');
  assert.equal(published.relationship, 'SAME_WORK_PUBLISHED_VERSION');
  assert.equal(published.sameWorkBasis, 'CONTAINMENT');
  assert.equal(published.credited, true, 'previously published work is scored by default');
  assert.ok(counted.creditedPositions.length >= 1400);
  assert.equal(asjpSourceCards(counted)[0].attribution, 'PREVIOUSLY_PUBLISHED_WORK');
  const excluded = await run(manuscript, { sameWorkPolicy: 'exclude' });
  const own = byId(excluded, 'asjp:1001');
  assert.equal(own.relationship, 'SAME_WORK_PUBLISHED_VERSION');
  assert.equal(own.credited, false);
  assert.equal(own.notCreditedReason, 'SAME_WORK_EXCLUDED_BY_POLICY');
  assert.deepEqual(excluded.creditedPositions, []);
  const cards = asjpSourceCards(excluded);
  assert.equal(cards.length, 1);
  // v5: a card also carries its passages (exact source offsets), labels and admission path
  assert.ok(cards[0].passages.length > 0 && cards[0].passages.every((p) => p.sourceCharStart >= 0 && p.sourceCharEnd > p.sourceCharStart));
  assert.equal(cards[0].admittedBy, 'VERIFIER');
  assert.deepEqual({ ...cards[0], matchedWordCount: undefined, passages: undefined, labels: undefined, admittedBy: undefined }, {
    kind: 'asjp_publication', sourceId: 'asjp:1001', title: TITLE_1001, journal: 'Fixture Journal', publicationDate: '2024-06-30', doi: '10.1234/own.1001',
    url: url(1001), authors: ['Author, A.'], license: 'CC BY 4.0', licenceStatus: 'PERMITTED', matchedWordCount: undefined, relationship: 'SAME_WORK_PUBLISHED_VERSION', scored: false, attribution: 'PREVIOUSLY_PUBLISHED_WORK',
    passages: undefined, labels: undefined, admittedBy: undefined,
  });
  const scored = await run(manuscript, { sameWorkPolicy: 'credit' });
  assert.equal(byId(scored, 'asjp:1001').credited, true);
  assert.ok(scored.creditedPositions.length >= 1400);
  assert.equal(asjpSourceCards(scored)[0].scored, true);
});

test('ASJP lane: time-aware comparison — an article published after the reference date, or at an uncertain date, is not credited', async () => {
  // catalog publication date of every fixture article: 2024-06-30
  const before = await run(copying, { referenceDate: '2025-01-15' });
  assert.equal(byId(before, 'asjp:1002').credited, true);
  assert.equal(byId(before, 'asjp:1002').publicationTiming, 'BEFORE');
  const after = await run(copying, { referenceDate: '2024-03-01' });
  assert.equal(byId(after, 'asjp:1002').credited, false);
  assert.equal(byId(after, 'asjp:1002').notCreditedReason, 'PUBLISHED_AFTER_REFERENCE_DATE');
  assert.ok(byId(after, 'asjp:1002').matchedPassages.length > 0, 'the candidate and its passages are kept');
  assert.deepEqual(after.creditedPositions, []);
  assert.equal(publicationTimingOf('2024/06/30', '2024-06-30'), 'BEFORE');
  assert.equal(publicationTimingOf('2024', '2024-06-30'), 'UNCERTAIN');
  assert.equal(publicationTimingOf('2024-06', '2024-07-01'), 'BEFORE');
  assert.equal(publicationTimingOf('2025', '2024-06-30'), 'AFTER');
  assert.equal(publicationTimingOf(null, '2024-06-30'), 'UNCERTAIN');
  assert.equal(publicationTimingOf('n.d.', '2024-06-30'), 'UNCERTAIN');
});

test('ASJP lane: a same title alone neither credits nor suppresses — an independent article is credited under any title', async () => {
  // the manuscript opens with article 1002's title but copies only 90 of its words (3% of the manuscript)
  const text = [TITLE_1002, filler(51, 300), sliceWords(INDEPENDENT, 400, 90), filler(52, 2400)].join(' ');
  const result = await run(text);
  const source = byId(result, 'asjp:1002');
  assert.equal(source.credited, true);
  assert.equal(source.relationship, 'INDEPENDENT_PUBLICATION', 'a matching title with little shared text is not same work');
  assert.equal(source.sameWorkBasis, null);
});

test('ASJP lane: a credited source gets one card with title, journal, date, DOI and canonical ASJP URL', () => {
  const cards = asjpSourceCards(copyingResult);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, TITLE_1002);
  assert.equal(cards[0].journal, 'Fixture Journal');
  assert.equal(cards[0].publicationDate, '2024-06-30');
  assert.equal(cards[0].doi, null);
  assert.equal(cards[0].url, url(1002));
  assert.equal(cards[0].matchedWordCount, 90);
  assert.equal(cards[0].scored, true);
});

test('ASJP lane: the union counts a position once across lanes, and a report without ASJP evidence is unchanged', () => {
  const wordCount = wordsOf(copying).length;
  const archiveMatchedPositions = Array.from({ length: 50 }, (_, index) => 300 + index); // the Archive already credits 300-349
  const imported = [{ sourceId: 'unit-1', matchedPassages: [{ submittedWordStart: 380, submittedWordEnd: 399, matchedWordCount: 20 }] }];
  const without = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, importedSimilarityEvidence: imported });
  const withAsjp = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, importedSimilarityEvidence: imported, asjpPublicationEvidence: asjpPublicationEvidenceOf(copyingResult) });
  assert.equal(without.uniqueMatchedWords, 70);
  assert.equal(withAsjp.uniqueMatchedWords, 100, 'union of 300-349 (archive), 300-389 (ASJP) and 380-399 (imported)');
  assert.equal(withAsjp.overlapWords, 60, '300-349 archive+ASJP and 380-389 imported+ASJP');
  assert.equal(withAsjp.asjpPublicationOnlyWords, 30);
  assert.deepEqual(withAsjp.asjpPublicationPositions, Array.from({ length: 30 }, (_, index) => 350 + index));
  assert.equal(withAsjp.archiveOnlyWords, 0);
  assert.equal(withAsjp.importedSimilarityEvidenceOnlyWords, 10);
  assert.deepEqual(withAsjp.matchedPositions, Array.from({ length: 100 }, (_, index) => 300 + index));
  assert.equal('asjpPublicationOnlyWords' in without, false);
  assert.equal('asjpPublicationPositions' in without, false);
  assert.deepEqual(computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, importedSimilarityEvidence: imported, asjpPublicationEvidence: [] }), without);
  assert.deepEqual(computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, importedSimilarityEvidence: imported, asjpPublicationEvidence: null }), without);
});

test('ASJP lane: an admitted article does not lend credit to an isolated short phrase elsewhere in the manuscript', async () => {
  // 1002 is admitted on a 90-word passage; 12 more of its words stand 25 words after it (context) and 400 words away (isolated)
  const near = sliceWords(INDEPENDENT, 900, 12);
  const far = sliceWords(INDEPENDENT, 1200, 12);
  const text = [filler(41, 300), sliceWords(INDEPENDENT, 400, 90), filler(42, 25), near, filler(43, 400), far, filler(44, 300)].join(' ');
  const result = await run(text);
  const source = byId(result, 'asjp:1002');
  assert.equal(source.credited, true);
  const nearStart = 300 + 90 + 25;
  const farStart = nearStart + 12 + 400;
  const credited = new Set(result.creditedPositions);
  assert.ok(Array.from({ length: 90 }, (_, index) => 300 + index).every((position) => credited.has(position)), 'the anchoring passage');
  assert.ok(Array.from({ length: 12 }, (_, index) => nearStart + index).every((position) => credited.has(position)), 'a short passage near it');
  assert.ok(Array.from({ length: 12 }, (_, index) => farStart + index).every((position) => !credited.has(position)), 'an isolated short passage');
});

test('ASJP lane: anchoredPassages keeps a cluster only when it holds a 25-word run', () => {
  const passage = (start, words) => ({ submittedWordStart: start, submittedWordEnd: start + words - 1, matchedWordCount: words });
  assert.deepEqual(anchoredPassages([passage(0, 30), passage(80, 10), passage(200, 12)]).map((p) => p.submittedWordStart), [0, 80]);
  assert.deepEqual(anchoredPassages([passage(0, 24), passage(30, 24)]), []);
  assert.deepEqual(anchoredPassages([passage(500, 10), passage(0, 25)]).map((p) => p.submittedWordStart), [0]);
});

test('ASJP lane: a reused session (reader kept open, sidecar requested) gives the same answer as a fresh request', async () => {
  const session = await openAsjpLaneSession({ store, generationId: built.generationId, useDerivedSourceSidecar: true });
  const strip = (r) => ({ ...r, timings: undefined });
  for (const text of [copying, [OWN, filler(31, 100)].join(' ')]) {
    assert.deepEqual(strip(await run(text, { session })), strip(await run(text)));
  }
  const mismatch = await run(copying, { session, generationId: 'gen-000000000000000000000000' });
  assert.equal(mismatch.state, 'FAILED');
});

test('ASJP lane: an unknown generation fails closed', async () => {
  const result = await run(copying, { generationId: 'gen-000000000000000000000000' });
  assert.equal(result.state, 'FAILED');
});
