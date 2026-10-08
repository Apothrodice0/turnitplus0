import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, hashTree, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { assembleCompactedGeneration, compactPartition, compactPartitionSegment } from '../lib/corpus-engine/compaction.ts';
import { normalizeForCorpus } from '../lib/corpus-engine/fingerprints.ts';
import { publishGeneration, validateGeneration } from '../lib/corpus-engine/generation.ts';
import { deriveDocId, partitionOfDocId } from '../lib/corpus-engine/ids.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { decodeRecordPackRow, RECORD_PACK_INDEX_HEADER_BYTES, RECORD_PACK_INDEX_ROW_BYTES } from '../lib/corpus-engine/record-pack.ts';
import { retrieveCandidates } from '../lib/corpus-engine/retrieval.ts';
import { appendRevocation } from '../lib/corpus-engine/revocation.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';

/**
 * Corpus Engine v1 — manual compaction: several incremental segments of a
 * partition become one, deterministically, and a revoked document is
 * physically removed. All builds finish before the first test() is registered.
 */

const scratch = corpusEngineScratch('compaction');
const texts = Array.from({ length: 36 }, (_, index) => inventedText(3000 + index, 300 + (index % 5) * 70));
const docIdOf = (text) => deriveDocId(normalizeForCorpus(text).normalizedContentSha256);
const source = (index) => fixtureSource(`doc-${String(index).padStart(2, '0')}`, texts[index], { title: `Title ${index}` });
const lateAlias = fixtureSource('late-04', `${texts[4]}  `, { provider: 'late-mirror', dataset: 'late-set' });
const batches = [
  Array.from({ length: 12 }, (_, index) => source(index)),
  Array.from({ length: 12 }, (_, index) => source(12 + index)),
  [...Array.from({ length: 12 }, (_, index) => source(24 + index)), lateAlias],
];

// three increments -> up to three segments per partition
const root = path.join(scratch, 'incremental');
let generationId = null;
for (const [index, batch] of batches.entries()) {
  const result = await runCorpusBuild({ corpusRoot: root, buildId: `batch-${index}`, parentGenerationId: generationId, partitionBits: index === 0 ? 1 : undefined, runBufferTuples: 4000 }, [new InMemorySourceAdapter(`batch-${index}`, batch)]);
  generationId = result.generationId;
}
const incrementalGenerationId = generationId;

// the same sources in ONE build, elsewhere
const single = await runCorpusBuild({ corpusRoot: path.join(scratch, 'single'), buildId: 'all', parentGenerationId: null, partitionBits: 1 }, [new InMemorySourceAdapter('all', batches.flat())]);

const store = new LocalDirectoryObjectStore(root);
const before = await CorpusGenerationReader.open({ store, generationId: incrementalGenerationId });
const queries = [3, 4, 13, 20, 27, 35].map((index) => sliceWords(texts[index], 15, 180));
const rankingBefore = [];
for (const query of queries) rankingBefore.push(await retrieveCandidates(before, query));
const treeBefore = hashTree(path.join(root, 'segments'));

// compact both partitions, one after the other
const compactedZero = await compactPartition({ corpusRoot: root, generationId: incrementalGenerationId, partition: 0 });
const compactedBoth = await compactPartition({ corpusRoot: root, generationId: compactedZero.generationId, partition: 1 });
const validation = await validateGeneration(store, compactedBoth.generationId);
const after = await CorpusGenerationReader.open({ store, generationId: compactedBoth.generationId, verify: 'sha256' });

// the same two partitions as independent segment compactions (any order) + ONE generation
const segmentOne = await compactPartitionSegment({ corpusRoot: root, generationId: incrementalGenerationId, partition: 1 });
const segmentZero = await compactPartitionSegment({ corpusRoot: root, generationId: incrementalGenerationId, partition: 0 });
const assembled = await assembleCompactedGeneration({ corpusRoot: root, generationId: incrementalGenerationId, compacted: [segmentOne, segmentZero] });
const assembledValidation = await validateGeneration(store, assembled.generationId);

// revoke one document, then compact its partition again: it must be physically gone
const victim = docIdOf(texts[20]);
const victimPartition = partitionOfDocId(victim, 1);
appendRevocation(root, { docId: victim, normalizedContentSha256: normalizeForCorpus(texts[20]).normalizedContentSha256, reason: 'test', revokedAt: '2026-10-06T00:00:00.000Z' });
const purged = await compactPartition({ corpusRoot: root, generationId: compactedBoth.generationId, partition: victimPartition });
const purgedValidation = await validateGeneration(store, purged.generationId);

test.after(async () => {
  await store.close();
  removeScratch(scratch);
});

test('compaction turns a partition\'s incremental segments into one, as a new candidate generation', () => {
  assert.ok(before.manifest.partitions.every((partition) => partition.segmentIds.length === 3));
  assert.equal(compactedZero.replacedSegmentIds.length, 3);
  assert.equal(compactedZero.parentGenerationId, incrementalGenerationId);
  assert.deepEqual(compactedBoth.manifest.partitions.map((partition) => partition.segmentIds.length), [1, 1]);
  assert.equal(compactedBoth.manifest.documentCount, 36);
  assert.equal(compactedBoth.manifest.aliasCount, 1);
  assert.equal(compactedBoth.manifest.postingsCount, before.manifest.postingsCount);
  assert.equal(compactedBoth.manifest.tokenCount, before.manifest.tokenCount);
  assert.equal(compactedZero.documentsPhysicallyRemoved + compactedBoth.documentsPhysicallyRemoved, 0);
  assert.equal(validation.ok, true, validation.errors.join(' | '));
});

test('partitions compacted independently and assembled once equal the partition-by-partition chain', async () => {
  assert.equal(assembledValidation.ok, true, assembledValidation.errors.join('; '));
  assert.equal(assembled.parentGenerationId, incrementalGenerationId);
  assert.deepEqual(assembled.manifest.partitions.map((partition) => partition.segmentIds), compactedBoth.manifest.partitions.map((partition) => partition.segmentIds));
  assert.deepEqual(assembled.manifest.segments, compactedBoth.manifest.segments);
  assert.deepEqual(assembled.manifest.documentFrequency, compactedBoth.manifest.documentFrequency);
  for (const key of ['documentCount', 'aliasCount', 'logicalSourceCount', 'tokenCount', 'distinctFingerprintCount', 'postingsCount', 'maxPostingsLength']) {
    assert.equal(assembled.manifest[key], compactedBoth.manifest[key], key);
  }
  // a segment compacted from another generation is refused, not grafted
  await assert.rejects(
    assembleCompactedGeneration({ corpusRoot: root, generationId: compactedBoth.generationId, compacted: [segmentZero] }),
    (error) => error.code === 'PARTITION_MISMATCH',
  );
});

test('compaction leaves the input generation and every one of its segments untouched', async () => {
  const treeAfter = hashTree(path.join(root, 'segments'));
  for (const [file, hash] of Object.entries(treeBefore)) assert.equal(treeAfter[file], hash, `${file} changed`);
  const stillThere = await CorpusGenerationReader.open({ store, generationId: incrementalGenerationId, verify: 'sha256' });
  assert.equal(stillThere.slots.length, 6);
  assert.equal((await validateGeneration(store, incrementalGenerationId)).ok, true);
});

test('retrieval over the compacted generation is identical: same candidates, weights and hit counts', async () => {
  for (const [index, query] of queries.entries()) {
    const result = await retrieveCandidates(after, query);
    const strip = (retrieval) => retrieval.candidates.map((candidate) => [candidate.docIdDecimal, candidate.globalWeight, candidate.fingerprintHits, candidate.regionsSupported, candidate.rank]);
    assert.deepEqual(strip(result), strip(rankingBefore[index]));
    assert.equal(result.state, 'COMPLETE');
    assert.equal(result.stats.segmentsQueried, 2);
    assert.equal(rankingBefore[index].stats.segmentsQueried, 6);
  }
  for (const index of [0, 11, 12, 23, 24, 35]) assert.equal((await after.fetchText(docIdOf(texts[index]))).text, texts[index]);
});

test('an alias that arrived in a later build is folded into the document\'s own record', async () => {
  const beforeRecord = await before.fetchMetadata(docIdOf(texts[4]));
  assert.equal(beforeRecord.metadata.aliases.length, 0);
  assert.equal(beforeRecord.laterAliases.length, 1);
  const afterRecord = await after.fetchMetadata(docIdOf(texts[4]));
  assert.equal(afterRecord.laterAliases.length, 0);
  assert.equal(afterRecord.metadata.aliases.length, 1);
  assert.equal(afterRecord.metadata.aliases[0].provider, 'late-mirror');
  assert.equal(afterRecord.metadata.duplicateCluster.memberCount, 2);
  assert.equal(afterRecord.metadata.canonicalSource.title, 'Title 4');
});

test('compaction is deterministic: incremental + compacted equals one build of the same sources, byte for byte', () => {
  assert.deepEqual(
    compactedBoth.manifest.partitions.map((partition) => partition.segmentIds[0]),
    single.manifest.partitions.map((partition) => partition.segmentIds[0]),
  );
  for (const partition of single.manifest.partitions) {
    const segmentId = partition.segmentIds[0];
    assert.deepEqual(hashTree(path.join(root, 'segments', segmentId)), hashTree(path.join(scratch, 'single', 'segments', segmentId)));
  }
  // Only the recorded lineage differs between the two generations.
  const { parentGenerationId: compactedParent, ...compactedContent } = compactedBoth.manifest;
  const { parentGenerationId: singleParent, ...singleContent } = single.manifest;
  assert.deepEqual(compactedContent, singleContent);
  assert.equal(singleParent, null);
  assert.equal(compactedParent, compactedZero.generationId);
});

test('compacting after a revocation physically removes the document: postings, text and metadata', async () => {
  assert.equal(purged.documentsPhysicallyRemoved, 1);
  assert.equal(purged.manifest.documentCount, 35);
  assert.equal(purgedValidation.ok, true, purgedValidation.errors.join(' | '));
  const reader = await CorpusGenerationReader.open({ store, generationId: purged.generationId, verify: 'sha256' });
  // not merely hidden by the revocation list: no segment of this generation holds the id at all
  for (const slot of reader.slots) assert.equal(slot.reader.ordinalOf(victim), -1);
  const segmentDirectory = path.join(root, 'segments', purged.compactedSegmentId);
  const index = fs.readFileSync(path.join(segmentDirectory, 'text.pidx'));
  for (let offset = RECORD_PACK_INDEX_HEADER_BYTES; offset < index.length; offset += RECORD_PACK_INDEX_ROW_BYTES) {
    assert.notEqual(decodeRecordPackRow(index, offset).docId, victim);
  }
  assert.equal(purged.manifest.postingsCount, compactedBoth.manifest.postingsCount - before.slots.reduce((total, slot) => {
    const ordinal = slot.reader.ordinalOf(victim);
    return ordinal >= 0 ? slot.reader.fingerprintCounts[ordinal] : total;
  }, 0));
  // the older generation still physically holds it — and the revocation list still hides it there
  assert.ok(after.locate(victim));
  const olderReader = await CorpusGenerationReader.open({ store, generationId: compactedBoth.generationId });
  assert.equal((await olderReader.fetchText(victim)).state, 'REVOKED');
  // every other document survives intact
  assert.equal((await reader.fetchText(docIdOf(texts[21]))).text, texts[21]);
  assert.equal((await publishGeneration(root, purged.generationId, { activatedAt: '2026-10-06T00:00:00.000Z' })).published, true);
});

test('compaction refuses a damaged input rather than copying it forward', async () => {
  const target = compactedBoth.manifest.partitions[1 - victimPartition].segmentIds[0];
  const file = path.join(root, 'segments', target, 'postings.bin');
  const original = fs.readFileSync(file);
  const damaged = Buffer.from(original);
  damaged[damaged.length - 5] ^= 0x5a;
  fs.writeFileSync(file, damaged);
  try {
    await assert.rejects(compactPartition({ corpusRoot: root, generationId: purged.generationId, partition: 1 - victimPartition }), /does not match its recorded hash/);
  } finally {
    fs.writeFileSync(file, original);
  }
});
