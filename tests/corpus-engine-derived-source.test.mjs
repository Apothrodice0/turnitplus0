import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import {
  buildSegmentSidecar,
  derivedSourceEntryOf,
  derivedSourceIdentity,
  derivedSourceIdentitySha256,
  DerivedSourceSidecarSet,
  DERIVED_SOURCE_SIDECAR_FORMAT_VERSION,
  sidecarPrefix,
  SIDECAR_BIN_FILE,
  SIDECAR_MANIFEST_FILE,
} from '../lib/corpus-engine/derived-source.ts';
import { comparePreparedSubmissionToCandidate, comparePreparedSubmissionToDerived, prepareSubmissionForVerification } from '../lib/corpus-engine/prepared-verifier.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { verifyCandidatesWithExistingVerifier } from '../lib/corpus-engine/verifier-adapter.ts';
import { runWithScoringNormalization } from '../lib/scoring-normalization-scope.ts';

/**
 * Corpus Engine v1 — the derived-source sidecar (derived-source-sidecar-v1).
 *
 * Its entries must equal what the verifier derives from the text, a
 * verification fed from it must equal one fed from the text, a sidecar of
 * another identity or segment must be refused, and a missing or damaged one
 * must leave verification exactly as it is without a sidecar.
 *
 * Builds finish before the first test() is registered.
 */

const scratch = corpusEngineScratch('derived-source');

// Real-language material as well as invented words: common words, short words, accents, Arabic, a reference list.
const english = 'The committee reviewed the evidence in detail and concluded that the proposed approach would not change the outcome. '.repeat(3)
  + 'Researchers measured groundwater recharge across seventeen catchments during three consecutive drought seasons and compared the results with satellite estimates.';
const french = "L'évolution de l'occupation des sols de la commune peut être observée sur les différentes représentations cartographiques du territoire, notamment la carte de Cassini et la carte d'état-major.";
const arabic = 'تعتبر المدينة من أقدم المدن في المنطقة وقد شهدت تطورا كبيرا في القرن العشرين بفضل موقعها الجغرافي المتميز على ساحل البحر.';
const withReferences = `${inventedText(9001, 300)}\n\nReferences\nSmith, J. (2019). A study of things. Journal of Studies, 12(3), 45-67.\nDupont, A. (2021). Une étude. Revue, 8(1), 1-20.`;
const texts = [
  inventedText(9000, 1500),
  `${english} ${inventedText(9002, 200)}`,
  `${french} ${inventedText(9003, 200)}`,
  `${arabic} ${inventedText(9004, 200)}`,
  withReferences,
  'short text of six words',
  ...Array.from({ length: 12 }, (_, index) => inventedText(9100 + index, 400)),
];
const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 1, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', texts.map((text, index) => fixtureSource(`doc-${index}`, text)))]);
const store = new LocalDirectoryObjectStore(root);
const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId });
const builds = [];
for (const slot of reader.slots) builds.push(await buildSegmentSidecar(root, reader, slot.segmentId));
const rebuilt = await buildSegmentSidecar(root, reader, reader.slots[0].segmentId);
const sidecars = await DerivedSourceSidecarSet.open(reader);
const everyDocument = [...reader.allDocumentIds()];
const submission = [inventedText(70_000, 100), sliceWords(texts[0], 200, 300), english, inventedText(70_001, 80), sliceWords(texts[4], 0, 200), french, arabic, texts[5]].join(' ');
const prepared = prepareSubmissionForVerification(submission);

test('every sidecar entry equals what the verifier derives from the text', async () => {
  assert.equal(sidecars.refusals.length, 0);
  assert.equal(sidecars.segmentsServed, reader.slots.length);
  assert.equal(rebuilt.skipped, true);
  for (const docId of everyDocument) {
    const location = reader.locate(docId);
    const fetched = await reader.fetchText(docId);
    const fromText = derivedSourceEntryOf(fetched.text);
    const entry = await sidecars.read(location);
    assert.equal(entry.wordCount, fromText.wordCount);
    assert.equal(entry.canonicalSha256, fromText.canonicalSha256);
    const hexes = Array.from(entry.hi, (hi, index) => `${hi.toString(16).padStart(8, '0')}${entry.lo[index].toString(16).padStart(8, '0')}`);
    assert.deepEqual(hexes, [...fromText.shingles].sort());
  }
});

test('a comparison fed from the sidecar is deep-equal to one fed from the text, matching or not', async () => {
  let matching = 0;
  for (const docId of everyDocument) {
    const fetched = await reader.fetchText(docId);
    const fromText = comparePreparedSubmissionToCandidate(prepared, fetched.text);
    const fromSidecar = comparePreparedSubmissionToDerived(prepared, await sidecars.read(reader.locate(docId)), sidecars.identity);
    assert.deepEqual(fromSidecar, fromText);
    assert.equal(JSON.stringify(fromSidecar), JSON.stringify(fromText));
    if (fromText.matchedPassages.length > 0) matching += 1;
  }
  assert.ok(matching >= 3);
  // the exact-document branch
  const exact = prepareSubmissionForVerification(texts[1]);
  for (const id of everyDocument) {
    const fetched = await reader.fetchText(id);
    assert.deepEqual(comparePreparedSubmissionToDerived(exact, await sidecars.read(reader.locate(id)), sidecars.identity), comparePreparedSubmissionToCandidate(exact, fetched.text));
  }
});

test('verification with the sidecar equals verification without it, and reads no text', async () => {
  const withText = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument);
  const withSidecar = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument, { sidecars });
  assert.deepEqual(withSidecar.matchedPositions, withText.matchedPositions);
  assert.equal(withSidecar.unifiedScore, withText.unifiedScore);
  assert.deepEqual(withSidecar.verifiedSources, withText.verifiedSources);
  assert.deepEqual(withSidecar.familyResolutions, withText.familyResolutions);
  assert.equal(withSidecar.totals.candidatesFromSidecar, everyDocument.length);
  assert.equal(withSidecar.totals.textCompressedBytesRead, 0);
  assert.ok(withText.unifiedScore > 0);
});

test('the identity names every dependency, and the reader refuses a sidecar of another identity or segment', async () => {
  const identity = derivedSourceIdentity(2);
  assert.equal(identity.artifactFormat, DERIVED_SOURCE_SIDECAR_FORMAT_VERSION);
  for (const field of ['normalization', 'referenceStrip', 'shingleSize', 'gramHash', 'informativeGramPolicy', 'canonicalization', 'thresholdsVersion', 'derivationProbeSha256']) assert.ok(identity[field] !== undefined, field);
  assert.match(identity.derivationProbeSha256, /^[0-9a-f]{64}$/);
  // deriving under another ambient normalization is refused outright
  assert.throws(() => runWithScoringNormalization(1, () => derivedSourceIdentity(2)), /NORMALIZATION|normalization/);

  const segmentId = reader.slots[0].segmentId;
  const manifestPath = path.join(root, ...sidecarPrefix(derivedSourceIdentitySha256(identity), segmentId).split('/'), SIDECAR_MANIFEST_FILE);
  const original = fs.readFileSync(manifestPath, 'utf8');
  try {
    const manifest = JSON.parse(original);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, identity: { ...manifest.identity, shingleSize: 4 } }));
    let refused = await DerivedSourceSidecarSet.open(reader);
    assert.deepEqual(refused.refusals.map((refusal) => refusal.code), ['SIDECAR_IDENTITY_MISMATCH']);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, segmentManifestSha256: '0'.repeat(64) }));
    refused = await DerivedSourceSidecarSet.open(reader);
    assert.deepEqual(refused.refusals.map((refusal) => refusal.code), ['SIDECAR_SEGMENT_MISMATCH']);
    fs.rmSync(manifestPath);
    refused = await DerivedSourceSidecarSet.open(reader);
    assert.deepEqual(refused.refusals.map((refusal) => refusal.code), ['SIDECAR_MISSING']);
    // a refused segment is verified from its text: same answer
    const withText = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument);
    const partial = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument, { sidecars: refused });
    assert.deepEqual(partial.matchedPositions, withText.matchedPositions);
    assert.ok(partial.totals.candidatesFromSidecar < everyDocument.length);
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
});

test('a damaged sidecar entry is never used: verification falls back to the text', async () => {
  const segmentId = reader.slots[0].segmentId;
  const binPath = path.join(root, ...sidecarPrefix(sidecars.identitySha256, segmentId).split('/'), SIDECAR_BIN_FILE);
  const original = fs.readFileSync(binPath);
  try {
    const damaged = Buffer.from(original);
    for (let offset = 40; offset < damaged.length; offset += 97) damaged[offset] ^= 0xff;
    fs.writeFileSync(binPath, damaged);
    const withText = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument);
    const withDamaged = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument, { sidecars });
    assert.deepEqual(withDamaged.matchedPositions, withText.matchedPositions);
    assert.equal(withDamaged.unifiedScore, withText.unifiedScore);
    assert.ok(withDamaged.totals.candidatesFromSidecar < everyDocument.length);
  } finally {
    fs.writeFileSync(binPath, original);
  }
});

test.after(async () => {
  await store.close();
  removeScratch(scratch);
  void builds;
});
