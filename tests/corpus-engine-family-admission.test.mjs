import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import {
  CORPUS_FAMILY_ADMISSION_V2,
  DEFAULT_FAMILY_ADMISSION_POLICY,
  FAMILY_ADMISSION_POLICY_AWARE_V2,
  FAMILY_ADMISSION_POLICY_GUARD_V1,
  FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY,
  genericFamilyDocuments,
  resolveFamilyRepresentatives,
} from '../lib/corpus-engine/family-admission.ts';
import { normalizeForCorpus } from '../lib/corpus-engine/fingerprints.ts';
import { deriveDocId, docIdToDecimal } from '../lib/corpus-engine/ids.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { verifyCandidatesWithExistingVerifier } from '../lib/corpus-engine/verifier-adapter.ts';
import { SELECTIVE_CORPUS_FAMILY_GUARD, SELECTIVE_CORPUS_STOP_DF } from '../lib/selective-corpus/constants.ts';

/**
 * Corpus Engine v1 — corpus-family-admission-v2.
 *
 * A passage held by a family of documents keeps its verified positions
 * through ONE representative (v1 dropped them), text held by a generic share
 * of the corpus is still suppressed, a specific source is still admitted, and
 * the outcome does not depend on candidate order.
 *
 * Builds finish before the first test() is registered.
 */

const scratch = corpusEngineScratch('family-admission');
const docIdOf = (text) => deriveDocId(normalizeForCorpus(text).normalizedContentSha256);
const decimalOf = (text) => docIdToDecimal(docIdOf(text));

// ── corpus ──────────────────────────────────────────────────────────────────
// SHARED      a 200-word passage held verbatim by a FAMILY of 5 documents (each with its own other text)
// COMMON      a 120-word passage held by 20 documents — at or above the generic bound of a corpus this size
// UNIQUE      one source the submission copies 300 words from
// noise       unrelated documents
const SHARED = inventedText(5000, 200);
const COMMON = inventedText(5001, 120);
const UNIQUE = inventedText(5002, 900);
const familyMembers = Array.from({ length: 5 }, (_, index) => `${inventedText(5100 + index, 300)} ${SHARED} ${inventedText(5200 + index, 300)}`);
const commonHolders = Array.from({ length: 20 }, (_, index) => `${inventedText(5300 + index, 250)} ${COMMON} ${inventedText(5400 + index, 250)}`);
const noise = Array.from({ length: 30 }, (_, index) => inventedText(5500 + index, 400));
const sources = [
  fixtureSource('unique', UNIQUE),
  ...familyMembers.map((text, index) => fixtureSource(`family-${index}`, text)),
  ...commonHolders.map((text, index) => fixtureSource(`common-${String(index).padStart(2, '0')}`, text)),
  ...noise.map((text, index) => fixtureSource(`noise-${String(index).padStart(2, '0')}`, text)),
];

// submission: original | 300 words of UNIQUE | original | SHARED | original | COMMON | original
const filler = (seed, count) => inventedText(60_000 + seed, count);
const submission = [filler(1, 150), sliceWords(UNIQUE, 100, 300), filler(2, 150), SHARED, filler(3, 150), COMMON, filler(4, 150)].join(' ');
const sharedStart = 150 + 300 + 150;
const commonStart = sharedStart + 200 + 150;

const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 1, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', sources)]);
const store = new LocalDirectoryObjectStore(root);
const uncached = await CorpusGenerationReader.open({ store, generationId: built.generationId });
const everyDocument = [...uncached.allDocumentIds()];
const documentCount = uncached.manifest.documentCount;

const verifyUnder = (familyPolicy, candidates = everyDocument) => verifyCandidatesWithExistingVerifier(uncached, submission, candidates, { familyPolicy });
const v1 = await verifyUnder(FAMILY_ADMISSION_POLICY_GUARD_V1);
const v2 = await verifyUnder(FAMILY_ADMISSION_POLICY_AWARE_V2);
const strictOnly = await verifyUnder(FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY);
const v2Reversed = await verifyUnder(FAMILY_ADMISSION_POLICY_AWARE_V2, [...everyDocument].reverse());

const positionsIn = (positions, start, count) => positions.filter((position) => position >= start && position < start + count).length;

test('the generic bound is the frozen 13-per-5,054 share of the generation, never below 13', () => {
  assert.equal(CORPUS_FAMILY_ADMISSION_V2.genericStopDocuments, SELECTIVE_CORPUS_STOP_DF);
  assert.equal(CORPUS_FAMILY_ADMISSION_V2.familyDocuments, SELECTIVE_CORPUS_FAMILY_GUARD.dominantSpanFamilyDocThreshold);
  assert.equal(CORPUS_FAMILY_ADMISSION_V2.independentWords, SELECTIVE_CORPUS_FAMILY_GUARD.additionalSourceSpecificWords);
  assert.equal(genericFamilyDocuments(0), 13);
  assert.equal(genericFamilyDocuments(56), 13);
  assert.equal(genericFamilyDocuments(5054), 13);
  assert.equal(genericFamilyDocuments(5055), 14);
  assert.equal(genericFamilyDocuments(100_890), 260);
  assert.equal(genericFamilyDocuments(1_000_000), 2573);
  assert.equal(genericFamilyDocuments(5_000_000), 12_862);
  assert.throws(() => genericFamilyDocuments(-1), RangeError);
  assert.equal(DEFAULT_FAMILY_ADMISSION_POLICY, FAMILY_ADMISSION_POLICY_AWARE_V2);
});

test('v1 drops a family-held passage from the report; v2 keeps it through one representative', () => {
  assert.ok(genericFamilyDocuments(documentCount) > 5, 'the fixture family must sit below the generic bound');
  const familyIds = new Set(familyMembers.map(decimalOf));
  // v1: all five holders are suppressed, so the passage's positions are gone
  assert.equal(positionsIn(v1.matchedPositions, sharedStart, 200), 0);
  assert.ok(!v1.verifiedSources.some((source) => familyIds.has(source.docId)));
  // v2: exactly one family member is attributed, as a representative, and carries the whole passage
  const representatives = v2.verifiedSources.filter((source) => familyIds.has(source.docId));
  assert.equal(representatives.length, 1);
  assert.equal(representatives[0].familyRepresentative, true);
  assert.ok(positionsIn(v2.matchedPositions, sharedStart, 200) >= 195);
  assert.equal(v2.familyResolutions.filter((entry) => entry.role === 'REPRESENTATIVE' && familyIds.has(entry.docId)).length, 1);
  assert.equal(v2.familyResolutions.filter((entry) => entry.role === 'COLLAPSED' && familyIds.has(entry.docId)).length, 4);
  for (const entry of v2.familyResolutions.filter((item) => item.role === 'COLLAPSED')) assert.equal(entry.representedBy, representatives[0].docId);
  // STRICT_SPAN alone would attribute the passage to all five
  assert.equal(strictOnly.verifiedSources.filter((source) => familyIds.has(source.docId)).length, 5);
  assert.ok(v2.unifiedScore > v1.unifiedScore);
});

test('v2 still suppresses text held by a generic share of the corpus, and still admits a specific source', () => {
  const commonIds = new Set(commonHolders.map(decimalOf));
  assert.ok(commonHolders.length >= genericFamilyDocuments(documentCount));
  assert.ok(!v2.verifiedSources.some((source) => commonIds.has(source.docId)));
  assert.equal(positionsIn(v2.matchedPositions, commonStart, 120), 0);
  assert.equal(positionsIn(v1.matchedPositions, commonStart, 120), 0);
  assert.ok(positionsIn(strictOnly.matchedPositions, commonStart, 120) > 100);
  const unique = v2.verifiedSources.find((source) => source.docId === decimalOf(UNIQUE));
  assert.ok(unique && !unique.familyRepresentative);
  assert.deepEqual(positionsIn(v2.matchedPositions, 150, 300), positionsIn(v1.matchedPositions, 150, 300));
});

test('v2 does not depend on the order candidates are verified in', () => {
  assert.deepEqual(v2Reversed.matchedPositions, v2.matchedPositions);
  assert.equal(v2Reversed.unifiedScore, v2.unifiedScore);
  assert.deepEqual(v2Reversed.familyResolutions, v2.familyResolutions);
  assert.deepEqual(new Set(v2Reversed.verifiedSources.map((source) => source.docId)), new Set(v2.verifiedSources.map((source) => source.docId)));
});

test('the canonical representative: more credited words, then the longer span, then the lower id', () => {
  const span = (start, end) => ({ start, end, words: end - start + 1 });
  const members = [
    { docId: '300', creditedSpans: [span(0, 99)] },
    { docId: '200', creditedSpans: [span(0, 99)] },
    { docId: '1000', creditedSpans: [span(0, 119)] },
    { docId: '50', creditedSpans: [span(500, 559)] },
  ];
  const resolved = resolveFamilyRepresentatives([], members);
  assert.deepEqual(resolved.map((entry) => [entry.docId, entry.role]), [['1000', 'REPRESENTATIVE'], ['200', 'COLLAPSED'], ['300', 'COLLAPSED'], ['50', 'REPRESENTATIVE']]);
  assert.equal(resolved[1].representedBy, '1000');
  // a member whose positions an attributed source already covers is collapsed into that source
  const covered = resolveFamilyRepresentatives([{ docId: '7', creditedSpans: [span(0, 200)] }], members);
  assert.deepEqual(covered.filter((entry) => entry.role === 'REPRESENTATIVE').map((entry) => entry.docId), ['50']);
  assert.equal(covered.find((entry) => entry.docId === '1000').representedBy, '7');
  assert.deepEqual(resolveFamilyRepresentatives([], [...members].reverse()), resolved);
});

test.after(async () => {
  await store.close();
  removeScratch(scratch);
});

