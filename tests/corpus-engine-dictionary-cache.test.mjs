import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, prng, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { compactDictionaryBlock, DictionaryBlockCache, findInCompactBlock, keyHalves } from '../lib/corpus-engine/dictionary-cache.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { retrieveCandidates } from '../lib/corpus-engine/retrieval.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { verifyCandidatesWithExistingVerifier } from '../lib/corpus-engine/verifier-adapter.ts';

/**
 * Corpus Engine v1 — the reader's dictionary block cache.
 *
 * Every lookup and every retrieval returns exactly what the uncached reader
 * returns, at any budget (including one that evicts constantly), and a cache
 * bound to another generation is never read or filled.
 *
 * Builds finish before the first test() is registered.
 */

const scratch = corpusEngineScratch('dictionary-cache');
// a corpus with a family, a common passage, a unique source and noise — enough keys for many dictionary blocks
const SHARED = inventedText(5000, 200);
const COMMON = inventedText(5001, 120);
const UNIQUE = inventedText(5002, 900);
const sources = [
  fixtureSource('unique', UNIQUE),
  ...Array.from({ length: 5 }, (_, index) => fixtureSource(`family-${index}`, `${inventedText(5100 + index, 300)} ${SHARED} ${inventedText(5200 + index, 300)}`)),
  ...Array.from({ length: 20 }, (_, index) => fixtureSource(`common-${String(index).padStart(2, '0')}`, `${inventedText(5300 + index, 250)} ${COMMON} ${inventedText(5400 + index, 250)}`)),
  ...Array.from({ length: 30 }, (_, index) => fixtureSource(`noise-${String(index).padStart(2, '0')}`, inventedText(5500 + index, 400))),
];
const filler = (seed, count) => inventedText(60_000 + seed, count);
const submission = [filler(1, 150), sliceWords(UNIQUE, 100, 300), filler(2, 150), SHARED, filler(3, 150), COMMON, filler(4, 150)].join(' ');

const root = path.join(scratch, 'corpus');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 1, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', sources)]);
const store = new LocalDirectoryObjectStore(root);
const uncached = await CorpusGenerationReader.open({ store, generationId: built.generationId, dictionaryCacheBytes: 0 });
const cached = await CorpusGenerationReader.open({ store, generationId: built.generationId });
const everyDocument = [...uncached.allDocumentIds()];
const v2 = await verifyCandidatesWithExistingVerifier(uncached, submission, everyDocument);

test('the dictionary cache returns exactly the uncached lookup, at every budget', async () => {
  const random = prng(91);
  const present = [];
  for (const slot of uncached.slots) for await (const hit of slot.reader.iterateDictionary()) if (random() < 0.2) present.push(hit.fingerprint);
  const absent = Array.from({ length: 2000 }, () => (BigInt(Math.floor(random() * 2 ** 32)) << BigInt(32)) | BigInt(Math.floor(random() * 2 ** 32)));
  const keys = [...new Set([...present, ...absent, BigInt(0), (BigInt(1) << BigInt(64)) - BigInt(1)])].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const budget of [8 * 1024, 64 * 1024, 64 * 1024 * 1024]) {
    const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId, dictionaryCacheBytes: budget });
    for (let pass = 0; pass < 2; pass += 1) {
      for (let index = 0; index < reader.slots.length; index += 1) {
        // whole sorted batches, and one key at a time (the family-evidence path)
        assert.deepEqual(await reader.slots[index].reader.lookupDictionary(keys), await uncached.slots[index].reader.lookupDictionary(keys), `budget ${budget}, pass ${pass}`);
        for (const key of keys.slice(0, 300)) assert.deepEqual(await reader.slots[index].reader.lookupDictionary([key]), await uncached.slots[index].reader.lookupDictionary([key]));
      }
    }
    const stats = reader.dictionaryCache.stats();
    assert.ok(stats.residentBytes <= budget);
    if (budget === 64 * 1024 * 1024) assert.ok(stats.hits > 0 && stats.evictions === 0);
    if (budget === 8 * 1024) assert.ok(stats.evictions > 0);
  }
});

test('retrieval and verification are identical with and without the cache', async () => {
  for (let pass = 0; pass < 2; pass += 1) {
    const withCache = await retrieveCandidates(cached, submission, { candidateBudget: 50 });
    const without = await retrieveCandidates(uncached, submission, { candidateBudget: 50 });
    assert.deepEqual(withCache.candidates, without.candidates);
    assert.equal(withCache.stats.touchedDocuments, without.stats.touchedDocuments);
    assert.equal(withCache.stats.fingerprintsFound, without.stats.fingerprintsFound);
  }
  const verified = await verifyCandidatesWithExistingVerifier(cached, submission, everyDocument);
  assert.deepEqual(verified.matchedPositions, v2.matchedPositions);
  assert.deepEqual(verified.familyResolutions, v2.familyResolutions);
  assert.ok(cached.dictionaryCache.stats().hits > 0);
});

test('a cache serves one generation: binding another empties it, and a reader of the old one bypasses it', async () => {
  const shared = new DictionaryBlockCache(16 * 1024 * 1024);
  const first = await CorpusGenerationReader.open({ store, generationId: built.generationId, dictionaryCache: shared });
  await retrieveCandidates(first, submission);
  assert.ok(shared.stats().entries > 0);
  assert.equal(shared.boundIdentity, DictionaryBlockCache.identityOf(built.generationId, first.logicalManifestSha256));
  shared.bind('gen-000000000000000000000000:another-generation');
  assert.equal(shared.stats().entries, 0);
  assert.equal(shared.stats().invalidations, 1);
  const before = shared.stats().identityBypasses;
  const again = await retrieveCandidates(first, submission);
  const reference = await retrieveCandidates(uncached, submission);
  assert.deepEqual(again.candidates, reference.candidates);
  assert.equal(shared.stats().entries, 0, 'a reader of another generation must not fill the cache');
  assert.ok(shared.stats().identityBypasses > before);
  // re-opening the generation re-binds it
  await CorpusGenerationReader.open({ store, generationId: built.generationId, dictionaryCache: shared });
  assert.equal(shared.stats().invalidations, 2);
  await retrieveCandidates(first, submission);
  assert.ok(shared.stats().entries > 0);
});

test('a compact block finds every key it holds and no other, on both sides of the 32-bit boundary', () => {
  const keys = [BigInt('4294967295'), BigInt('4294967296'), BigInt('8589934591'), (BigInt(1) << BigInt(63)) + BigInt(5), (BigInt(1) << BigInt(64)) - BigInt(1)];
  const compact = compactDictionaryBlock(keys, [1, 2, 3, 4, 5], [1000, 1010, 1030, 1060, 1100], [10, 20, 30, 40, 50], 1000);
  const halves = keyHalves(keys);
  keys.forEach((key, index) => {
    const entry = findInCompactBlock(compact, halves.hi[index], halves.lo[index]);
    assert.equal(entry, index);
    assert.deepEqual([compact[10 + entry], compact[15 + entry], compact[20 + entry]], [index + 1, [0, 10, 30, 60, 100][index], 10 * (index + 1)]);
  });
  for (const absent of [BigInt(0), BigInt('4294967297'), (BigInt(1) << BigInt(63))]) {
    const absentHalves = keyHalves([absent]);
    assert.equal(findInCompactBlock(compact, absentHalves.hi[0], absentHalves.lo[0]), -1);
  }
  // a block whose postings would not fit a 32-bit relative offset is not compacted (served uncached instead)
  assert.equal(compactDictionaryBlock([BigInt(1)], [1], [2 ** 33], [1], 0), null);
});

test.after(async () => {
  await store.close();
  removeScratch(scratch);
});

