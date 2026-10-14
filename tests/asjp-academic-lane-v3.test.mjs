import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { ASJP_PROVIDER, asjpSourceCards, legalForm, repetitionForm, runAsjpAcademicLane, structuralForm } from '../lib/asjp-academic-lane.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';

/**
 * ASJP lane v3: verbatim rescue, structural boilerplate classifier, legal / shared-text annotations, and several
 * overlapping sources in one manuscript. Invented text only. The build finishes before the first test() is registered.
 */
const scratch = corpusEngineScratch('asjp-lane-v3');
const url = (id) => `https://asjp.cerist.dz/en/article/${id}`;
const asjp = (id, text, title = `title ${id}`) => fixtureSource(String(id), text, { provider: ASJP_PROVIDER, dataset: 'asjp-english-fulltext', canonicalUrl: url(id), title, sourceType: 'journal-article', language: 'en' });
const tok = (text) => tokensForScoringNormalization(text, 2);

// the manuscript's own published version (3001), an independent source with a citation (3002), two articles holding the same
// passage (3003, 3004), a source whose passage the verifier fragments at its in-text references (3005), a statute
// quotation (3007)
const OWN = inventedText(100, 900);
const PB = inventedText(101, 80);
const PC = inventedText(102, 80);
const REF1 = 'smith j 2015 journal of economics vol 12 no 3 pp 45 67';
const REF2 = 'brown k 2018 review of finance vol 4 no 2 pp 101 120';
const REF3 = 'ali m 2020 bulletin of statistics vol 9 no 1 pp 7 19';
const PE = [inventedText(104, 10), REF1, inventedText(105, 10), REF2, inventedText(108, 10), REF3, inventedText(109, 10)].join(' ');
const LAW = 'article 12 of the law shall apply to every contract concluded under the provisions of this code and the parties shall '
  + inventedText(106, 50);
const CITATION = 'official journal of the republic no 47 of 12 june 2005 p 4 and official gazette no 13 vol 2 pp 33 41 press university of algiers review no 3 2009';
const B = [inventedText(110, 400), PB, inventedText(111, 300), CITATION, inventedText(112, 300)].join(' ');
const C = [inventedText(120, 400), PC, inventedText(121, 400)].join(' ');
const D1 = [inventedText(130, 400), PC, inventedText(131, 400)].join(' ');
const E = [inventedText(140, 400), PE, inventedText(141, 400)].join(' ');
const L = [inventedText(150, 400), LAW, inventedText(151, 400)].join(' ');
const OWN_TITLE = 'vanoleri pastu mekorin tavisa';

const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 2, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', [
  asjp(3001, OWN, OWN_TITLE), asjp(3002, B), asjp(3003, C), asjp(3004, D1), asjp(3005, E), asjp(3007, L),
  ...Array.from({ length: 20 }, (_, index) => fixtureSource(`noise-${index}`, inventedText(300 + index, 500))),
])]);
const store = new LocalDirectoryObjectStore(root);
const entry = (id, title) => ({ articleId: String(id), canonicalUrl: url(id), title, authors: ['Author, A.'], journal: 'J', issn: null, publicationDate: '2024-01-01', doi: null, license: 'CC BY', licenseBasis: 'ARTICLE_PDF', licenceStatus: 'PERMITTED', reusePermitted: true, withdrawn: false });
const catalog = (id) => (Number(id) === 3001 ? entry(id, OWN_TITLE) : Number(id) >= 3002 && Number(id) <= 3007 ? entry(id, `title ${id}`) : null);
const run = (text, extra = {}) => runAsjpAcademicLane({ store, generationId: built.generationId, submissionText: text, catalog, ignoreFlag: true, ...extra });
const filler = (seed, n) => inventedText(70_000 + seed, n);
const at = (parts, index) => wordsOf(parts.slice(0, index).join(' ')).length;
const range = (start, n) => Array.from({ length: n }, (_, i) => start + i);
test.after(() => removeScratch(scratch));

// manuscript: 400 words of its own published version, then PB, the citation, PC, PE and the quoted statute between fillers
const parts = [sliceWords(OWN, 100, 400), filler(1, 200), PB, filler(2, 200), CITATION, filler(3, 200), PC, filler(4, 200), PE, filler(5, 200), `"${LAW}"`, filler(6, 200)];
const manuscript = parts.join(' ');
const v3 = await run(manuscript, { submissionTitle: OWN_TITLE });
const v2 = await run(manuscript, { submissionTitle: OWN_TITLE, corrections: { verbatimRescue: false, runMerge: false, structuralFilter: false, annotations: false } });
const source = (r, id) => r.sources.find((s) => s.sourceId === `asjp:${id}`);

test('v3 multi-source: the own published version and every independent source are credited, the union counts each word once', () => {
  for (const id of [3001, 3002, 3003, 3007]) assert.equal(source(v3, id).credited, true, `asjp:${id} credited`);
  assert.equal(source(v3, 3001).relationship, 'SAME_WORK_PUBLISHED_VERSION');
  assert.equal(source(v3, 3002).relationship, 'INDEPENDENT_PUBLICATION');
  const credited = new Set(v3.creditedPositions);
  assert.equal(credited.size, v3.creditedPositions.length, 'no position counted twice');
  for (const [index, n] of [[0, 400], [2, 80], [6, 80]]) assert.ok(range(at(parts, index), n).every((q) => credited.has(q)), `part ${index} credited`);
});

test('v3 multi-source: two articles holding the same passage are both credited and annotated as shared text', () => {
  const c = source(v3, 3003), d = source(v3, 3004);
  assert.equal(c.credited, true);
  assert.equal(d.credited, true);
  for (const s of [c, d]) assert.ok(s.annotations.some((a) => a.kind === 'SHARED_TEXT' && a.otherArticles >= 1) || s.matchedWordCount >= 60, 'shared or long');
  const pc = range(at(parts, 6), 80);
  assert.equal(pc.filter((q) => v3.creditedPositions.includes(q)).length, 80, 'counted once in the union');
});

test('v3 verbatim rescue: a passage the verifier fragments at its references is credited with exact offsets; off reproduces v2', () => {
  const e3 = source(v3, 3005), e2 = source(v2, 3005);
  assert.equal(e2.credited, false);
  assert.equal(e2.notCreditedReason, 'NOT_ADMITTED_BY_VERIFIER', 'the verifier fragments it: every piece is under 25 words');
  assert.equal(e3.credited, true);
  assert.equal(e3.admittedBy, 'VERBATIM_RESCUE');
  const passage = e3.matchedPassages.find((p) => p.matchedWordCount >= 60);
  assert.ok(passage, 'one run covers the whole passage');
  assert.deepEqual(tok(E.slice(passage.sourceCharStart, passage.sourceCharEnd)), tok(PE).slice(0, passage.matchedWordCount));
  assert.ok(range(at(parts, 8), wordsOf(PE).length).every((q) => v3.creditedPositions.includes(q)));
});

test('v3 verbatim rescue keeps the frozen thresholds: two 24-word verbatim pieces (48 words) are not credited', async () => {
  const pieces = [filler(20, 300), sliceWords(C, 10, 24), filler(21, 30), sliceWords(C, 200, 24), filler(22, 300)].join(' ');
  const r = await run(pieces);
  assert.deepEqual(r.creditedPositions, []);
  assert.ok(r.sources.every((s) => s.admittedBy !== 'VERBATIM_RESCUE'));
});

test('v3 structural filter: a short citation-form cluster is set aside with evidence; without the filter it is credited', async () => {
  const b3 = source(v3, 3002), b2 = source(await run(manuscript, { submissionTitle: OWN_TITLE, corrections: { structuralFilter: false } }), 3002);
  const start = at(parts, 4), n = wordsOf(CITATION).length;
  const sc = b3.structuralClusters.find((c) => c.submittedWordStart >= start && c.submittedWordEnd < start + n);
  assert.ok(sc, 'the citation cluster is classified');
  assert.equal(sc.category, 'BIBLIOGRAPHIC_CITATION');
  assert.ok(sc.evidence.numbers >= 2 && sc.evidence.bibliographicWords >= 2);
  assert.ok(!v3.creditedPositions.includes(start + 2));
  assert.ok(b2.matchedPassages.some((p) => p.submittedWordStart === start && p.submittedWordEnd === start + n - 1), 'run merge makes it one anchored run');
  assert.equal(source(v2, 3002).isolatedWords, n - 1, 'v2: the verifier returned it in pieces too short to anchor');
  assert.ok(range(at(parts, 2), 80).every((q) => v3.creditedPositions.includes(q)), 'the copied passage of the same source stays credited');
});

test('v3 legal annotation: a quoted provision stays in the score, annotated, and is reported as a separate subtotal', () => {
  const l = source(v3, 3007);
  assert.equal(l.credited, true);
  const a = l.annotations.find((x) => x.kind === 'LEGAL_PRIMARY_TEXT');
  assert.ok(a);
  assert.equal(a.quoted, true);
  assert.ok(a.markers.includes('shall') && a.markers.includes('law'));
  const law = range(at(parts, 10), wordsOf(LAW).length);
  assert.ok(law.every((q) => v3.creditedPositions.includes(q)), 'still credited');
  assert.ok(v3.legalAnnotatedPositions.length >= 60 && v3.legalAnnotatedPositions.every((q) => v3.creditedPositions.includes(q)));
  const card = asjpSourceCards(v3).find((c) => c.sourceId === 'asjp:3007');
  assert.ok(card.legalWords >= 60);
});

test('v3 with every v3 correction off: no rescue, no structural clusters, no annotations', () => {
  for (const s of v2.sources) { assert.deepEqual(s.structuralClusters, []); assert.deepEqual(s.annotations, []); }
  assert.ok(v2.sources.every((s) => s.admittedBy !== 'VERBATIM_RESCUE'));
});

test('structuralForm: form features, not phrases', () => {
  const rep = tok('please insert the title here please insert the title here please insert the title here please insert the title here');
  assert.equal(structuralForm(rep, '')?.category, 'PLACEHOLDER_REPETITION');
  assert.equal(structuralForm(tok(CITATION), CITATION)?.category, 'BIBLIOGRAPHIC_CITATION');
  const t = 'The Impact Of Foreign Direct Investment On Economic Growth In Emerging Markets Evidence From Panel Data';
  assert.equal(structuralForm(tok(t), t)?.category, 'NAME_OR_TITLE');
  const g = 'where AIC SC HQ FPE LR denote the criteria selected by each test at the five percent level';
  assert.equal(structuralForm(tok(g), g)?.category, 'ABBREVIATION_LEGEND');
  const prose = 'the results show that the effect of the policy on firms was weaker than expected in the first two years of the reform';
  assert.equal(structuralForm(tok(prose), prose), null);
});

test('legalForm: two distinct legal words make the form; quotation marks at the edges are recorded', () => {
  const quote = 'everyone charged with a penal offence has the right to be presumed innocent until proved guilty';
  // quoted, with the instrument named just before it
  const q = legalForm(tok(quote), ' “', '” ', `Article 11, paragraph 1 of the Universal Declaration states that ${quote}`);
  assert.equal(q.quoted, true);
  assert.equal(q.markers[0], 'article 11');
  // the same words, quoted, but no instrument referred to: not legal text
  assert.equal(legalForm(tok(quote), ' “', '” ', `as one author put it ${quote}`), null);
  // an instrument named, no quotation marks, ordinary prose: not annotated
  assert.equal(legalForm(tok('the effect was weaker than expected in the first years'), ' ', '. ', 'the constitution of 2020 changed it; the effect was weaker than expected in the first years'), null);
  // statutory text without quotation marks: >= 2 distinct legal words making >= 6% of the words, an instrument named
  const statute = 'unless otherwise provided a person shall be criminally responsible and liable for punishment for a crime within the jurisdiction of the court';
  const s = legalForm(tok(statute), ' ', ' ', `Article 30(1) of the Rome Statute provides that ${statute}`);
  assert.equal(s.quoted, false);
  assert.ok(s.markers.includes('shall') && s.markers.includes('jurisdiction'));
});

test('repetitionForm: a template unit repeated at any length is placeholder text; prose and tables are not', () => {
  const unit = 'enter your abstract here an abstract is a brief comprehensive summary of the contents of the article';
  assert.equal(repetitionForm(tok(Array.from({ length: 7 }, () => unit).join(' ')))?.category, 'PLACEHOLDER_REPETITION');
  // extraction artefacts split words ("th e", "a bstract") and shift each repeat: still the same template
  const broken = [unit, unit.replace('the contents', 'th e contents'), unit.replace('abstract is', 'a bstract is'), unit, unit.replace('comprehensive', 'c omprehensive'), unit].join(' ');
  assert.equal(repetitionForm(tok(broken))?.category, 'PLACEHOLDER_REPETITION');
  // a numeric table that repeats its values is not text filler
  assert.equal(repetitionForm(tok(Array.from({ length: 20 }, () => '0 000 0 000 1 00 0 05').join(' '))), null);
  assert.equal(repetitionForm(tok(inventedText(900, 200))), null);
  const table = Array.from({ length: 30 }, (_, i) => `row ${i} 0 ${(i * 37) % 97} 0 ${(i * 13) % 89}`).join(' ');
  assert.equal(repetitionForm(tok(table)), null, 'rows with different values do not repeat');
});
