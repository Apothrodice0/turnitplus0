import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { runCorpusEngineCandidateVerification } from '../lib/corpus-engine/index.ts';
import { CORPUS_ENGINE_V1_FLAG } from '../lib/corpus-engine/flag.ts';
import { DEFAULT_DICTIONARY_CACHE_BYTES, DictionaryBlockCache } from '../lib/corpus-engine/dictionary-cache.ts';
import { generationPrefix, segmentPrefix } from '../lib/corpus-engine/generation.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { FaultInjectingObjectStore, LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import {
  CORPUS_ENGINE_DICTIONARY_CACHE_BYTES_ENV,
  CORPUS_ENGINE_GENERATION_ID_ENV,
  CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES,
  CORPUS_ENGINE_LAUNCH_GENERATION,
  CORPUS_ENGINE_STORAGE_ROOT_ENV,
  SERVABLE_CORPUS_ENGINE_GENERATIONS,
  corpusEngineProcessDictionaryCache,
  resolveCorpusEngineDictionaryCacheBytes,
  resolveCorpusEngineServingConfig,
  runCorpusEngineLane,
} from '../lib/corpus-engine-serving.ts';
import { runWithScoringNormalization } from '../lib/scoring-normalization-scope.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';

/**
 * The application's server-side Corpus Engine serving adapter
 * (lib/corpus-engine-serving.ts): configuration comes from the server
 * environment and the reviewed servable-generation record only, the flag
 * stays OFF by default, the configured dictionary cache budget reaches the
 * reader, and every failure is DISABLED / UNAVAILABLE / FAILED / PARTIAL —
 * never a COMPLETE result with zero evidence.
 */

const scratch = corpusEngineScratch('serving');
const B = inventedText(600, 1200);
const noise = Array.from({ length: 12 }, (_, index) => inventedText(900 + index, 400));
const sources = [fixtureSource('B', B), ...noise.map((text, index) => fixtureSource(`noise-${index}`, text))];
const submission = [inventedText(41_000, 150), sliceWords(B, 100, 300), inventedText(41_001, 150)].join(' ');
assert.equal(wordsOf(submission).length, 600);

const root = path.join(scratch, 'root');
const built = await runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits: 1, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', sources)]);
const probeStore = new LocalDirectoryObjectStore(root);
const identity = (await CorpusGenerationReader.open({ store: probeStore, generationId: built.generationId, dictionaryCacheBytes: 0 })).identity();
await probeStore.close();

const fixtureGeneration = {
  generationId: built.generationId,
  logicalManifestSha256: identity.logicalManifestSha256,
  revocationAnchor: null,
  normalization: { kind: 'BUILT_UNDER', version: 2, proof: 'test fixture built under v2' },
  documents: sources.length,
};
const servable = [fixtureGeneration];
const env = (overrides = {}) => ({
  [CORPUS_ENGINE_STORAGE_ROOT_ENV]: root,
  [CORPUS_ENGINE_GENERATION_ID_ENV]: built.generationId,
  [CORPUS_ENGINE_DICTIONARY_CACHE_BYTES_ENV]: String(CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES),
  ...overrides,
});
const lane = (options = {}) => runWithScoringNormalization(2, () => runCorpusEngineLane(submission, { env: env(), servable, ...options }));

const originalFlag = process.env[CORPUS_ENGINE_V1_FLAG];
const setFlag = (value) => { if (value === undefined) delete process.env[CORPUS_ENGINE_V1_FLAG]; else process.env[CORPUS_ENGINE_V1_FLAG] = value; };

test.after(() => {
  setFlag(originalFlag);
  removeScratch(scratch);
});

test('the launch record pins the accepted 1M generation and is the only servable generation', () => {
  assert.deepEqual(SERVABLE_CORPUS_ENGINE_GENERATIONS.map((generation) => generation.generationId), ['gen-661b4f55ffec338591224fca']);
  assert.equal(CORPUS_ENGINE_LAUNCH_GENERATION.logicalManifestSha256.slice(0, 24), 'gen-661b4f55ffec338591224fca'.slice(4));
  assert.equal(CORPUS_ENGINE_LAUNCH_GENERATION.documents, 1_062_380);
  assert.deepEqual(CORPUS_ENGINE_LAUNCH_GENERATION.normalization.kind, 'BUILT_UNDER');
  assert.equal(CORPUS_ENGINE_LAUNCH_GENERATION.normalization.version, 2);
  assert.equal(CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES, 1073741824);
  // a generation id configured for the real process must be one of these
  const other = resolveCorpusEngineServingConfig({ [CORPUS_ENGINE_STORAGE_ROOT_ENV]: root, [CORPUS_ENGINE_GENERATION_ID_ENV]: built.generationId });
  assert.equal(other.ok, false);
  assert.equal(other.failureCode, 'GENERATION_NOT_SERVABLE');
  const launch = resolveCorpusEngineServingConfig({ [CORPUS_ENGINE_STORAGE_ROOT_ENV]: root, [CORPUS_ENGINE_GENERATION_ID_ENV]: 'gen-661b4f55ffec338591224fca' });
  assert.equal(launch.ok, true);
  assert.equal(launch.generation, CORPUS_ENGINE_LAUNCH_GENERATION);
});

test('the dictionary cache budget is parsed strictly; anything invalid falls back to the library default', () => {
  assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes('1073741824'), { bytes: 1073741824, source: 'configured' });
  assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes(' 1073741824 '), { bytes: 1073741824, source: 'configured' });
  assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes('0'), { bytes: 0, source: 'configured' });
  assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes(undefined), { bytes: DEFAULT_DICTIONARY_CACHE_BYTES, source: 'default' });
  assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes(''), { bytes: DEFAULT_DICTIONARY_CACHE_BYTES, source: 'default' });
  for (const value of ['-1', '1.5', '1e9', 'abc', '1GiB', '0x40000000', '4294967297', '99999999999999999999']) {
    assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes(value), { bytes: DEFAULT_DICTIONARY_CACHE_BYTES, source: 'invalid-fallback' }, value);
  }
  assert.deepEqual(resolveCorpusEngineDictionaryCacheBytes('4294967296'), { bytes: 4294967296, source: 'configured' });
});

test('configuration failures are UNAVAILABLE, and there is no default storage location', () => {
  const cases = [
    [{ [CORPUS_ENGINE_STORAGE_ROOT_ENV]: undefined }, 'STORAGE_ROOT_UNSET'],
    [{ [CORPUS_ENGINE_STORAGE_ROOT_ENV]: '  ' }, 'STORAGE_ROOT_UNSET'],
    [{ [CORPUS_ENGINE_STORAGE_ROOT_ENV]: 'relative/corpus' }, 'STORAGE_ROOT_NOT_ABSOLUTE'],
    [{ [CORPUS_ENGINE_GENERATION_ID_ENV]: undefined }, 'GENERATION_UNSET'],
    [{ [CORPUS_ENGINE_GENERATION_ID_ENV]: 'latest' }, 'GENERATION_NOT_SERVABLE'],
  ];
  for (const [overrides, code] of cases) {
    const config = resolveCorpusEngineServingConfig(env(overrides), servable);
    assert.equal(config.ok, false);
    assert.equal(config.failureCode, code);
  }
});

test('flag OFF (the default): DISABLED before configuration is read or storage is touched', async () => {
  const store = new FaultInjectingObjectStore(new LocalDirectoryObjectStore(root));
  for (const value of [undefined, '', '1', 'TRUE', 'yes', ' true']) {
    setFlag(value);
    store.resetStats?.();
    assert.deepEqual(await lane({ store }), { state: 'DISABLED' });
    assert.deepEqual(await runWithScoringNormalization(2, () => runCorpusEngineLane(submission, { env: {}, store })), { state: 'DISABLED' });
    const stats = store.stats();
    assert.equal(stats.rangeReads + stats.wholeReads + stats.sizeProbes, 0, `flag ${JSON.stringify(value)} touched storage`);
  }
  await store.close();
});

test('flag ON with valid configuration: the lane runs the pinned generation and returns verified evidence only', async () => {
  setFlag('true');
  const result = await lane();
  assert.equal(result.state, 'COMPLETE');
  assert.deepEqual(result.identity, identity);
  assert.deepEqual(result.diagnostics, { dictionaryCacheBytes: 1073741824, dictionaryCacheSource: 'configured' });
  // exactly what the engine entry point returns for the same pinned request
  const store = new LocalDirectoryObjectStore(root);
  const direct = await runWithScoringNormalization(2, () => runCorpusEngineCandidateVerification({ store, generationId: built.generationId, logicalManifestSha256: identity.logicalManifestSha256, submissionText: submission }));
  await store.close();
  assert.deepEqual(result.verification.matchedPositions, direct.verification.matchedPositions);
  assert.ok(result.verification.matchedPositions.length >= 290, 'the 300 copied words are found');
  assert.ok(result.verification.matchedPositions.every((position) => position >= 150 && position < 450), 'nothing outside the copied passage');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].sourceId, `corpus-engine:${built.generationId}:${result.evidence[0].docId}`);
  // the evidence unions with another lane through the existing formula, unchanged
  const archiveMatchedPositions = Array.from({ length: 50 }, (_, index) => 500 + index);
  const unified = computeUnifiedSimilarity({ wordCount: 600, archiveMatchedPositions, selectiveCorpusEvidence: result.evidence });
  assert.equal(unified.uniqueMatchedWords, result.verification.matchedPositions.length + 50);
});

test('the configured 1 GiB budget reaches the reader as one process-wide cache that persists across requests', async () => {
  setFlag('true');
  const cache = corpusEngineProcessDictionaryCache(CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES);
  assert.ok(cache instanceof DictionaryBlockCache);
  assert.equal(cache.maxBytes, 1073741824);
  const first = await lane();
  assert.equal(first.state, 'COMPLETE');
  assert.equal(corpusEngineProcessDictionaryCache(CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES), cache, 'the same cache object serves every request');
  assert.equal(cache.boundIdentity, DictionaryBlockCache.identityOf(built.generationId, identity.logicalManifestSha256));
  const hitsBefore = cache.stats().hits;
  const second = await lane();
  assert.deepEqual(second.verification.matchedPositions, first.verification.matchedPositions);
  assert.ok(cache.stats().hits > hitsBefore, 'the second request is served from the cache the first one filled');
  // another budget replaces the cache; 0 runs uncached; neither changes an answer
  const uncached = await lane({ env: env({ [CORPUS_ENGINE_DICTIONARY_CACHE_BYTES_ENV]: '0' }) });
  assert.deepEqual(uncached.diagnostics, { dictionaryCacheBytes: 0, dictionaryCacheSource: 'configured' });
  assert.deepEqual(uncached.verification.matchedPositions, first.verification.matchedPositions);
  const fallback = await lane({ env: env({ [CORPUS_ENGINE_DICTIONARY_CACHE_BYTES_ENV]: '-5' }) });
  assert.deepEqual(fallback.diagnostics, { dictionaryCacheBytes: DEFAULT_DICTIONARY_CACHE_BYTES, dictionaryCacheSource: 'invalid-fallback' });
  assert.deepEqual(fallback.verification.matchedPositions, first.verification.matchedPositions);
});

test('a report under another scoring-normalization contract is refused before any read, never a completed zero', async () => {
  setFlag('true');
  const store = new FaultInjectingObjectStore(new LocalDirectoryObjectStore(root));
  const refused = await runWithScoringNormalization(1, () => runCorpusEngineLane(submission, { env: env(), servable, store }));
  assert.equal(refused.state, 'UNAVAILABLE');
  assert.equal(refused.failureCode, 'NORMALIZATION_INCOMPATIBLE');
  const stats = store.stats();
  assert.equal(stats.rangeReads + stats.wholeReads + stats.sizeProbes, 0);
  // defence in depth: a record that wrongly claims v1 is still refused by the engine's own contract check
  const mislabelled = [{ ...fixtureGeneration, normalization: { kind: 'BUILT_UNDER', version: 1, proof: 'wrong on purpose' } }];
  const engineRefused = await runWithScoringNormalization(1, () => runCorpusEngineLane(submission, { env: env(), servable: mislabelled, store }));
  assert.equal(engineRefused.state, 'FAILED');
  assert.equal(engineRefused.failureCode, 'NORMALIZATION_CONTRACT_MISMATCH');
  // an unknown identity is incompatible with every contract
  const unknown = [{ ...fixtureGeneration, normalization: { kind: 'UNKNOWN', reason: 'no record' } }];
  assert.equal((await lane({ servable: unknown })).failureCode, 'NORMALIZATION_INCOMPATIBLE');
  await store.close();
});

test('an unavailable or wrongly pinned generation is FAILED, never COMPLETE', async () => {
  setFlag('true');
  const empty = path.join(scratch, 'empty-root');
  fs.mkdirSync(empty, { recursive: true });
  const missingRoot = await lane({ env: env({ [CORPUS_ENGINE_STORAGE_ROOT_ENV]: empty }) });
  assert.equal(missingRoot.state, 'FAILED');
  assert.equal(missingRoot.identity, null);
  const absentGeneration = [{ ...fixtureGeneration, generationId: 'gen-000000000000000000000000' }];
  const absent = await lane({ env: env({ [CORPUS_ENGINE_GENERATION_ID_ENV]: 'gen-000000000000000000000000' }), servable: absentGeneration });
  assert.equal(absent.state, 'FAILED');
  const wrongPin = await lane({ servable: [{ ...fixtureGeneration, logicalManifestSha256: '0'.repeat(64) }] });
  assert.equal(wrongPin.state, 'FAILED');
  assert.equal(wrongPin.failureCode, 'GENERATION_PIN_MISMATCH');
});

test('a damaged generation is FAILED or PARTIAL with only verified evidence, never COMPLETE', async () => {
  setFlag('true');
  const inner = new LocalDirectoryObjectStore(root);
  const store = new FaultInjectingObjectStore(inner);
  // damaged manifest: the generation cannot be opened at all
  store.setFault(`${generationPrefix(built.generationId)}/manifest.json`, 'corrupt', 10);
  const corruptManifest = await lane({ store });
  assert.equal(corruptManifest.state, 'FAILED');
  store.clearFaults();
  // one segment missing its dictionary: the rest is searched, the result says it is incomplete
  const reader = await CorpusGenerationReader.open({ store: inner, generationId: built.generationId, dictionaryCacheBytes: 0 });
  const segmentIds = reader.slots.map((slot) => slot.segmentId);
  assert.ok(segmentIds.length >= 2);
  for (const segmentId of segmentIds) {
    store.clearFaults();
    store.setFault(`${segmentPrefix(segmentId)}/dict.bin`, 'missing');
    const damaged = await lane({ store });
    assert.notEqual(damaged.state, 'COMPLETE', `missing ${segmentId} reported COMPLETE`);
    assert.ok(damaged.state === 'PARTIAL' || damaged.state === 'FAILED');
    if (damaged.state === 'PARTIAL') {
      const full = await (store.clearFaults(), lane({ store }));
      for (const position of damaged.verification.matchedPositions) assert.ok(full.verification.matchedPositions.includes(position), 'a damaged run credited a position the intact run does not');
    }
  }
  store.clearFaults();
  await store.close();
});

test('a failed Corpus Engine lane contributes nothing to the union, and the other lanes are untouched', async () => {
  setFlag('true');
  const failed = await lane({ servable: [{ ...fixtureGeneration, logicalManifestSha256: '0'.repeat(64) }] });
  assert.equal(failed.state, 'FAILED');
  assert.equal('evidence' in failed, false);
  const archiveMatchedPositions = [1, 2, 3, 4, 5];
  const unified = computeUnifiedSimilarity({ wordCount: 600, archiveMatchedPositions, selectiveCorpusEvidence: failed.evidence ?? [] });
  assert.equal(unified.uniqueMatchedWords, 5);
  // and an Archive lane that produced nothing does not create Corpus Engine evidence either
  const ok = await lane();
  const ceOnly = computeUnifiedSimilarity({ wordCount: 600, archiveMatchedPositions: [], selectiveCorpusEvidence: ok.evidence });
  assert.equal(ceOnly.uniqueMatchedWords, ok.verification.matchedPositions.length);
});
