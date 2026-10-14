import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { validateGeneration } from '../lib/corpus-engine/generation.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { retrieveCandidates } from '../lib/corpus-engine/retrieval.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { verifyCandidatesWithExistingVerifier } from '../lib/corpus-engine/verifier-adapter.ts';
import {
  CANDIDATE_RANKING_POLICY_VERSION,
  CORPUS_1M_ROOT_PARTITION_BITS,
  CORPUS_FORMAT_STATUS,
  CORPUS_FORMAT_VERSION,
  FROZEN_CORE_FORMATS,
  INDEX_FORMAT_VERSION,
  POSTINGS_CODEC_VERSION,
  RETRIEVAL_PROTOCOL_VERSION,
  TEXT_PACK_FORMAT_VERSION,
} from '../lib/corpus-engine/versions.ts';

/**
 * Corpus Engine v1 — the FROZEN core formats.
 *
 * A fixed set of documents built the same way must produce the same bytes
 * forever: every segment id is the hash of a segment.json that records the
 * sha256 of every file of the segment, and the generation id is the hash of
 * the manifest that pins every segment. So pinning those ids pins every byte
 * of the index, postings, document table, text packs, metadata packs and
 * manifest. If this test fails, a frozen format changed: that is a new
 * version string ("-v2") and a reader that refuses v1, never an edit of these
 * expected values.
 *
 * It also proves the 1M layout (partitionBits 4, 16 partitions) needs no
 * format change: the same documents at 0 and 4 bits give the same candidates
 * and the same verified result.
 */

const scratch = corpusEngineScratch('format-freeze');
const documents = Array.from({ length: 48 }, (_, index) => fixtureSource(`frozen-${String(index).padStart(2, '0')}`, inventedText(31_000 + index, 150 + 10 * index)));
const submission = [inventedText(32_000, 120), sliceWords(documents[3].text, 20, 120), inventedText(32_001, 90), sliceWords(documents[40].text, 100, 200), inventedText(32_002, 60)].join(' ');

async function build(partitionBits) {
  const root = path.join(scratch, `bits-${partitionBits}`);
  const built = await runCorpusBuild({ corpusRoot: root, buildId: 'frozen-fixture', parentGenerationId: null, partitionBits, runBufferTuples: 50_000 }, [new InMemorySourceAdapter('fixture', documents)]);
  const store = new LocalDirectoryObjectStore(root);
  const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId });
  return { root, built, store, reader };
}
const single = await build(0);
const sixteen = await build(CORPUS_1M_ROOT_PARTITION_BITS);

// The bytes the frozen v1 formats produce for this fixture.
//  - INDEX: sha256 over every segment's dict.bin, dict.idx, postings.bin and docs.bin hashes, in manifest order.
//    These files are not compressed, so this pin holds on every toolchain.
//  - GENERATION: the generation id, which also pins the zstd-compressed text and metadata packs. A different
//    zstd build may legitimately compress the same records to other bytes (the format and the decoded records
//    are unchanged), so this pin is asserted only under the zstd version it was recorded with.
const FROZEN_INDEX_DIGESTS = {
  0: '342d3eeb1d65a3f7a32b82e1be4eaf3430398f1476711399dd822b2cd990f0f6',
  4: 'dfcb4663d0a542f07a95c8453f908d1f96f0abe6d6af9beaf327e8df899ec0ce',
};
const FROZEN_GENERATION_IDS_ZSTD = '1.5.7';
const FROZEN_GENERATION_IDS = {
  0: 'gen-0575a0fa2bf11517027a2661',
  4: 'gen-56a12119422ae37d18fd7de5',
};
const INDEX_FILES = ['dict.bin', 'dict.idx', 'postings.bin', 'docs.bin'];

async function indexDigest(store, manifest) {
  const hash = crypto.createHash('sha256');
  for (const partition of manifest.partitions) {
    for (const segmentId of partition.segmentIds) {
      const segment = JSON.parse((await store.readAll(`segments/${segmentId}/segment.json`)).toString('utf8'));
      for (const name of INDEX_FILES) hash.update(`${partition.partition}:${name}:${segment.files[name].sha256}
`);
    }
  }
  return hash.digest('hex');
}

test('the core formats are frozen as v1', () => {
  assert.equal(CORPUS_FORMAT_STATUS, 'frozen');
  assert.deepEqual([...FROZEN_CORE_FORMATS], [CORPUS_FORMAT_VERSION, INDEX_FORMAT_VERSION, POSTINGS_CODEC_VERSION, TEXT_PACK_FORMAT_VERSION, 'generation-manifest-v1', RETRIEVAL_PROTOCOL_VERSION, CANDIDATE_RANKING_POLICY_VERSION]);
  for (const version of FROZEN_CORE_FORMATS) assert.match(version, /-v1$/);
  assert.equal(single.reader.manifest.processing.formatStatus, 'frozen');
});

test('a fixed build produces the frozen bytes (generation id pins every segment and file)', async () => {
  for (const { built, store, reader } of [single, sixteen]) {
    const validation = await validateGeneration(store, built.generationId);
    assert.deepEqual(validation.errors, []);
    const bits = reader.manifest.partitionBits;
    assert.equal(await indexDigest(store, reader.manifest), FROZEN_INDEX_DIGESTS[bits], `partitionBits ${bits}: the frozen index bytes changed`);
    if (process.versions.zstd === FROZEN_GENERATION_IDS_ZSTD) assert.equal(built.generationId, FROZEN_GENERATION_IDS[bits], `partitionBits ${bits}: the frozen bytes changed`);
  }
});

test('the 1M layout: 16 partitions, every one populated, no format change', () => {
  assert.equal(CORPUS_1M_ROOT_PARTITION_BITS, 4);
  const manifest = sixteen.reader.manifest;
  assert.equal(manifest.partitionBits, 4);
  assert.equal(manifest.partitions.length, 16);
  assert.equal(manifest.documentCount, single.reader.manifest.documentCount);
  assert.equal(manifest.postingsCount, single.reader.manifest.postingsCount);
  assert.equal(manifest.distinctFingerprintCount, single.reader.manifest.distinctFingerprintCount);
  assert.ok(manifest.partitions.filter((partition) => partition.segmentIds.length > 0).length >= 14);
  assert.deepEqual(manifest.processing, single.reader.manifest.processing);
});

test('the same documents at 0 and 4 partition bits give the same candidates and the same verified result', async () => {
  for (const budget of [5, 20, 100]) {
    const one = await retrieveCandidates(single.reader, submission, { candidateBudget: budget });
    const many = await retrieveCandidates(sixteen.reader, submission, { candidateBudget: budget });
    const strip = (candidate) => ({ docId: candidate.docIdDecimal, rank: candidate.rank, globalWeight: candidate.globalWeight, fingerprintHits: candidate.fingerprintHits, regionsSupported: candidate.regionsSupported, nominatedBy: candidate.nominatedBy });
    assert.deepEqual(many.candidates.map(strip), one.candidates.map(strip), `K=${budget}`);
    const verifiedOne = await verifyCandidatesWithExistingVerifier(single.reader, submission, one.candidates.map((candidate) => candidate.docId));
    const verifiedMany = await verifyCandidatesWithExistingVerifier(sixteen.reader, submission, many.candidates.map((candidate) => candidate.docId));
    assert.deepEqual(verifiedMany.matchedPositions, verifiedOne.matchedPositions);
    assert.equal(verifiedMany.unifiedScore, verifiedOne.unifiedScore);
    assert.deepEqual(verifiedMany.verifiedSources, verifiedOne.verifiedSources);
    assert.ok(verifiedOne.unifiedScore > 0);
  }
});

test.after(async () => {
  await single.store.close();
  await sixteen.store.close();
  removeScratch(scratch);
});
