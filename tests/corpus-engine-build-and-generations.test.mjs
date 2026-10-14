import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, flipByte, hashTree, inventedText, removeScratch, sliceWords } from './helpers/corpus-engine-fixtures.mjs';
import { CorpusBuildError, runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { normalizeForCorpus } from '../lib/corpus-engine/fingerprints.ts';
import { CorpusGenerationError, loadGenerationManifest, publishGeneration, readActivePointer, validateGeneration } from '../lib/corpus-engine/generation.ts';
import { deriveDocId, docIdToDecimal, partitionOfDocId } from '../lib/corpus-engine/ids.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { retrieveCandidates } from '../lib/corpus-engine/retrieval.ts';
import { appendRevocation, REVOCATION_LIST_KEY } from '../lib/corpus-engine/revocation.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { FaultInjectingObjectStore, LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { currentProcessingIdentity } from '../lib/corpus-engine/versions.ts';

/**
 * Corpus Engine v1 — a small corpus taken through its whole life:
 * build, exact deduplication, deterministic rebuild, crash + resume,
 * an incremental segment, publication validation, rollback, revocation and
 * the COMPLETE / PARTIAL / FAILED retrieval contract.
 *
 * Every build and every piece of async setup finishes BEFORE the first test()
 * is registered (node:test starts a test as soon as it is registered).
 */

const scratch = corpusEngineScratch('build');

const texts = Array.from({ length: 40 }, (_, index) => inventedText(100 + index, 260 + (index % 7) * 60));
const docIdOf = (text) => deriveDocId(normalizeForCorpus(text).normalizedContentSha256);
const name = (index) => `doc-${String(index).padStart(2, '0')}`;

/** texts[5] as another provider would supply it: different case, punctuation and spacing, same words. */
const mirrorOfFive = texts[5].split(' ').map((word, index) => (index % 3 === 0 ? word.toUpperCase() : word)).join(',  \n ') + ' .';
assert.equal(normalizeForCorpus(mirrorOfFive).normalizedContentSha256, normalizeForCorpus(texts[5]).normalizedContentSha256);

const baseSources = [
  ...Array.from({ length: 25 }, (_, index) => fixtureSource(name(index), texts[index], { title: `Title ${index}`, canonicalUrl: `https://example.test/${index}`, rights: { license: 'CC BY 4.0', licenseUrl: null, usage: null, attribution: null } })),
  fixtureSource('mirror-05', mirrorOfFive, { provider: 'mirror-provider', dataset: 'mirror-set' }),
  fixtureSource('tiny', 'only three words'),
];
const secondBatch = [
  ...Array.from({ length: 15 }, (_, index) => fixtureSource(name(25 + index), texts[25 + index])),
  fixtureSource('late-mirror-03', `  ${texts[3]}  `, { provider: 'late-mirror', dataset: 'late-set' }),
];

const adapter = (id, sources) => new InMemorySourceAdapter(id, sources);
const shuffled = (items, seed) => {
  const copy = [...items];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const other = state % (index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
};

// ── build 1: the reference build (tiny run buffer => many commits and runs) ──
const rootA = path.join(scratch, 'root-a');
const clean = await runCorpusBuild(
  { corpusRoot: rootA, buildId: 'base', parentGenerationId: null, partitionBits: 2, runBufferTuples: 600, maxMergeFanIn: 3, keepBuildArtifacts: true },
  [adapter('fixture', baseSources)],
);

// ── build 2: same sources, different order, different commit boundaries, alias before its original ──
const rootB = path.join(scratch, 'root-b');
const reordered = await runCorpusBuild(
  { corpusRoot: rootB, buildId: 'other-name', parentGenerationId: null, partitionBits: 2, runBufferTuples: 50_000 },
  [adapter('fixture', [baseSources[25], ...shuffled(baseSources.filter((_, index) => index !== 25), 7)])],
);

// ── build 3: interrupted three ways, then resumed ──
const rootC = path.join(scratch, 'root-c');
class SimulatedCrash extends Error {}
const crashConfig = { corpusRoot: rootC, buildId: 'base', parentGenerationId: null, partitionBits: 2, runBufferTuples: 600, maxMergeFanIn: 3, keepBuildArtifacts: true };
const crashes = [];
// (1) dies mid-batch: text already staged, runs not spilled, ledger batch not written
let staged = 0;
await assert.rejects(runCorpusBuild({ ...crashConfig, faultInjection: (point, context) => {
  if (point === 'source-staged' && context.commits >= 2 && (staged += 1) === 3) throw new SimulatedCrash('mid-batch');
} }, [adapter('fixture', baseSources)]), SimulatedCrash);
crashes.push({ at: 'mid-batch', ledgerBytes: fs.statSync(path.join(rootC, 'builds', 'base', 'ledger.jsonl')).size, stagingBytes: fs.statSync(path.join(rootC, 'builds', 'base', 'staging', 'text.spans')).size });
// leave extra debris a real crash could: a torn ledger line and an unreferenced run file
fs.appendFileSync(path.join(rootC, 'builds', 'base', 'ledger.jsonl'), '{"type":"source","sourceKey":"torn');
fs.writeFileSync(path.join(rootC, 'builds', 'base', 'runs', 'c999999-p0000.run'), Buffer.alloc(32));
// (2) dies after runs are on disk but before the ledger batch that would reference them
let spills = 0;
const afterFirstResume = await runCorpusBuild({ ...crashConfig, faultInjection: (point) => {
  if (point === 'runs-spilled' && (spills += 1) === 2) throw new SimulatedCrash('after-spill');
} }, [adapter('fixture', baseSources)]).then(() => null, (error) => error);
assert.ok(afterFirstResume instanceof SimulatedCrash);
// (3) dies while writing the SECOND partition's segment (the first is already committed)
const afterSecondResume = await runCorpusBuild({ ...crashConfig, faultInjection: (point, context) => {
  if (point === 'segment-index-written' && context.partition === 1) throw new SimulatedCrash('mid-segment');
} }, [adapter('fixture', baseSources)]).then(() => null, (error) => error);
assert.ok(afterSecondResume instanceof SimulatedCrash);
const ledgerBeforeFinalResume = fs.readFileSync(path.join(rootC, 'builds', 'base', 'ledger.jsonl'), 'utf8');
const resumed = await runCorpusBuild(crashConfig, [adapter('fixture', baseSources)]);

// ── incremental: a second generation on root A that only adds ──
const segmentsBefore = Object.fromEntries(clean.newSegmentIds.map((segmentId) => [segmentId, hashTree(path.join(rootA, 'segments', segmentId))]));
const mtimesBefore = Object.fromEntries(clean.newSegmentIds.map((segmentId) => [segmentId, fs.statSync(path.join(rootA, 'segments', segmentId, 'dict.bin')).mtimeMs]));
const grown = await runCorpusBuild(
  { corpusRoot: rootA, buildId: 'add-15', parentGenerationId: clean.generationId, runBufferTuples: 3000 },
  [adapter('fixture-2', secondBatch)],
);

// ── publication: gen1, then a damaged gen2 candidate, then the repaired one, then rollback ──
const published1 = await publishGeneration(rootA, clean.generationId, { activatedAt: '2026-10-06T00:00:00.000Z' });
const damagedSegment = grown.newSegmentIds[0];
const restoreDamage = flipByte(path.join(rootA, 'segments', damagedSegment, 'postings.bin'), 40);
const refused = await publishGeneration(rootA, grown.generationId, { activatedAt: '2026-10-06T00:01:00.000Z' });
const activeAfterRefusal = readActivePointer(rootA);
const storeA = new LocalDirectoryObjectStore(rootA);
const gen1StillValid = await validateGeneration(storeA, clean.generationId);
const gen1ReaderDuringDamage = await CorpusGenerationReader.open({ store: storeA, generationId: clean.generationId });
const gen1QueryDuringDamage = await retrieveCandidates(gen1ReaderDuringDamage, sliceWords(texts[9], 30, 150));
restoreDamage();
const published2 = await publishGeneration(rootA, grown.generationId, { activatedAt: '2026-10-06T00:02:00.000Z' });

// a build that dies never produces a generation and never touches a published one
const treeBeforeFailedBuild = hashTree(path.join(rootA, 'generations'));
const segmentTreeBeforeFailedBuild = Object.fromEntries(Object.keys(grown.manifest.segments).map((segmentId) => [segmentId, hashTree(path.join(rootA, 'segments', segmentId))]));
const failedBuild = await runCorpusBuild(
  { corpusRoot: rootA, buildId: 'doomed', parentGenerationId: grown.generationId, faultInjection: (point) => {
    if (point === 'segment-index-written') throw new SimulatedCrash('doomed');
  } },
  [adapter('fixture-3', [fixtureSource('extra-1', inventedText(9001, 400)), fixtureSource('extra-2', inventedText(9002, 400))])],
).then(() => null, (error) => error);
const activeAfterFailedBuild = readActivePointer(rootA);
const treeAfterFailedBuild = hashTree(path.join(rootA, 'generations'));
const segmentTreeAfterFailedBuild = Object.fromEntries(Object.keys(grown.manifest.segments).map((segmentId) => [segmentId, hashTree(path.join(rootA, 'segments', segmentId))]));

const rollback = await publishGeneration(rootA, clean.generationId, { activatedAt: '2026-10-06T00:03:00.000Z' });
const republish = await publishGeneration(rootA, grown.generationId, { activatedAt: '2026-10-06T00:04:00.000Z' });

// ── revocation of document 7 (present in BOTH generations) ──
const revokedId = docIdOf(texts[7]);
const queryForSeven = sliceWords(texts[7], 10, 160);
const beforeRevocation = {};
for (const generationId of [clean.generationId, grown.generationId]) {
  const reader = await CorpusGenerationReader.open({ store: storeA, generationId });
  beforeRevocation[generationId] = { retrieval: await retrieveCandidates(reader, queryForSeven), text: await reader.fetchText(revokedId), epoch: reader.identity().revocationEpoch };
}
const revocation = appendRevocation(rootA, { docId: revokedId, normalizedContentSha256: normalizeForCorpus(texts[7]).normalizedContentSha256, reason: 'rights holder request', revokedBy: 'test', revokedAt: '2026-10-06T00:05:00.000Z' });
const afterRevocation = {};
for (const generationId of [clean.generationId, grown.generationId]) {
  const reader = await CorpusGenerationReader.open({ store: storeA, generationId });
  afterRevocation[generationId] = { retrieval: await retrieveCandidates(reader, queryForSeven), text: await reader.fetchText(revokedId), metadata: await reader.fetchMetadata(revokedId), epoch: reader.identity().revocationEpoch };
}
// rolling the served generation back does not bring the document back
const rollbackAfterRevocation = await publishGeneration(rootA, clean.generationId, { activatedAt: '2026-10-06T00:06:00.000Z' });
const rolledBackReader = await CorpusGenerationReader.open({ store: storeA, generationId: readActivePointer(rootA).generationId });
const rolledBackRetrieval = await retrieveCandidates(rolledBackReader, queryForSeven);
// re-ingesting the same content under a new source is refused
const reingest = await runCorpusBuild(
  { corpusRoot: rootA, buildId: 'reingest', parentGenerationId: grown.generationId },
  [adapter('fixture-4', [fixtureSource('seven-again', texts[7], { provider: 'someone-else', dataset: 'other' }), fixtureSource('brand-new', inventedText(9100, 500))])],
);
const reingestReader = await CorpusGenerationReader.open({ store: storeA, generationId: reingest.generationId });
const reingestRetrieval = await retrieveCandidates(reingestReader, queryForSeven);

// ── tests ────────────────────────────────────────────────────────────────────

test.after(async () => {
  await storeA.close();
  removeScratch(scratch);
});

test('build: counts separate documents, aliases and rejects, and every document lands in its own partition', async () => {
  assert.equal(clean.counts.newDocuments, 25);
  assert.equal(clean.counts.aliasesInBuild, 1);
  assert.equal(clean.counts.rejectedEmpty, 1);
  assert.equal(clean.counts.sourcesAccepted, 26);
  assert.equal(clean.manifest.documentCount, 25);
  assert.equal(clean.manifest.aliasCount, 1);
  assert.equal(clean.manifest.logicalSourceCount, 26);
  assert.equal(clean.manifest.partitions.length, 4);
  assert.ok(clean.metrics.commits > 3, `expected several commits, got ${clean.metrics.commits}`);
  assert.ok(clean.metrics.runFiles > 6, `expected several runs, got ${clean.metrics.runFiles}`);
  assert.ok(clean.metrics.mergePasses > 1, 'fan-in 3 over many runs must take more than one merge pass');
  assert.equal(clean.manifest.postingsCount, clean.counts.retainedFingerprints);
  const reader = await CorpusGenerationReader.open({ store: storeA, generationId: clean.generationId, verify: 'sha256' });
  for (let index = 0; index < 25; index += 1) {
    const location = reader.locate(docIdOf(texts[index]));
    assert.ok(location, `document ${index} not found`);
    assert.equal(location.partition, partitionOfDocId(docIdOf(texts[index]), 2));
  }
  assert.equal(reader.locate(docIdOf(texts[30])), null);
});

test('metadata: provenance is stored as supplied, aliases are kept, and nothing missing is invented', async () => {
  const reader = await CorpusGenerationReader.open({ store: storeA, generationId: clean.generationId });
  const five = await reader.fetchMetadata(docIdOf(texts[5]));
  assert.equal(five.state, 'OK');
  assert.equal(five.metadata.docId, docIdToDecimal(docIdOf(texts[5])));
  assert.equal(five.metadata.duplicateCluster.memberCount, 2);
  assert.equal(five.metadata.duplicateCluster.nearDuplicateClusterId, null);
  assert.equal(five.metadata.aliases.length, 1);
  // the stored text is the lexicographically smallest source key's, whatever order they arrived in
  assert.equal(five.metadata.canonicalSource.provider, 'fixture-provider');
  assert.equal(five.metadata.aliases[0].provider, 'mirror-provider');
  assert.equal(five.metadata.canonicalSource.title, 'Title 5');
  assert.equal(five.metadata.canonicalSource.rights.license, 'CC BY 4.0');
  // never fabricated: the fixture supplies no author, date, language or licence URL
  assert.equal(five.metadata.canonicalSource.authors, null);
  assert.equal(five.metadata.canonicalSource.publishedDate, null);
  assert.equal(five.metadata.canonicalSource.language, null);
  assert.equal(five.metadata.aliases[0].title, null);
  assert.equal(five.metadata.aliases[0].canonicalUrl, null);
  assert.match(five.metadata.canonicalSource.rawContentSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(five.metadata.canonicalSource.rawContentSha256, five.metadata.aliases[0].rawContentSha256);
  assert.equal(five.metadata.normalizationVersion, 2);
  // where it is stored is reported by the reader, not baked into the record
  assert.equal(five.location.generationId, clean.generationId);
  assert.ok(clean.newSegmentIds.includes(five.location.segmentId));
  assert.deepEqual(five.location.textPack, { base: 'text', recordNumber: five.location.ordinal });
  // the stored text round-trips and is the canonical source's
  const text = await reader.fetchText(docIdOf(texts[5]));
  assert.equal(text.state, 'OK');
  assert.equal(text.text, texts[5]);
  assert.deepEqual(text.identity, reader.identity());
});

test('determinism: another order, other commit boundaries and another build name give the same generation, byte for byte', () => {
  assert.equal(reordered.generationId, clean.generationId);
  assert.equal(reordered.logicalManifestSha256, clean.logicalManifestSha256);
  assert.deepEqual([...reordered.newSegmentIds].sort(), [...clean.newSegmentIds].sort());
  assert.notEqual(reordered.metrics.commits, clean.metrics.commits);
  // three independent roots (reference, reordered, crashed-and-resumed) hold identical segment bytes
  assert.deepEqual(hashTree(path.join(rootB, 'segments')), hashTree(path.join(rootC, 'segments')));
  for (const segmentId of clean.newSegmentIds) {
    assert.deepEqual(hashTree(path.join(rootB, 'segments', segmentId)), segmentsBefore[segmentId]);
  }
  const generationFiles = (root) => {
    const tree = hashTree(path.join(root, 'generations', clean.generationId));
    // build-event*.json is the only non-deterministic file, by design
    return Object.fromEntries(Object.entries(tree).filter(([file]) => !file.startsWith('build-event')));
  };
  assert.deepEqual(generationFiles(rootB), generationFiles(rootC));
  assert.ok(fs.existsSync(path.join(rootB, 'generations', clean.generationId, 'build-event.json')));
});

test('crash + resume: committed work is reused, nothing is ingested or posted twice, and the result equals the clean build', () => {
  assert.equal(resumed.generationId, clean.generationId);
  assert.equal(resumed.resumed, true);
  // the final run re-read every source and skipped all of them: ingestion was already complete
  assert.equal(resumed.metrics.sourcesSkippedAlreadyCommitted, baseSources.length);
  assert.equal(resumed.metrics.sourcesCommittedThisRun, 0);
  // partition 0's segment was committed before the third crash and was not rebuilt
  assert.equal(resumed.segmentsReusedFromLedger, 1);
  assert.deepEqual(resumed.counts, clean.counts);
  assert.deepEqual([...resumed.newSegmentIds].sort(), [...clean.newSegmentIds].sort());
  // the ledger records every source exactly once across all four runs
  const sourceLines = fs.readFileSync(path.join(rootC, 'builds', 'base', 'ledger.jsonl'), 'utf8').split('\n').filter((line) => line.includes('"type":"source"'));
  assert.equal(sourceLines.length, baseSources.length);
  assert.equal(new Set(sourceLines.map((line) => JSON.parse(line).sourceKey)).size, baseSources.length);
  // the debris left by the simulated crashes was removed, not trusted
  assert.ok(!ledgerBeforeFinalResume.includes('"sourceKey":"torn'));
  assert.ok(!fs.existsSync(path.join(rootC, 'builds', 'base', 'runs', 'c999999-p0000.run')));
  assert.ok(crashes[0].stagingBytes > 0 && crashes[0].ledgerBytes > 0);
});

test('crash + resume: a build cannot be resumed under a different parent or partitioning', async () => {
  await assert.rejects(
    runCorpusBuild({ corpusRoot: rootC, buildId: 'base', parentGenerationId: null, partitionBits: 3 }, [adapter('fixture', baseSources)]),
    (error) => error instanceof CorpusBuildError && error.code === 'BUILD_CONFIG_MISMATCH',
  );
});

test('incremental: new documents become new immutable segments; no existing segment is rewritten', async () => {
  assert.equal(grown.parentGenerationId, clean.generationId);
  assert.notEqual(grown.generationId, clean.generationId);
  assert.deepEqual(grown.inheritedSegmentIds, [...clean.newSegmentIds].sort());
  assert.ok(grown.newSegmentIds.length >= 1 && grown.newSegmentIds.length <= 4);
  assert.equal(grown.counts.newDocuments, 15);
  assert.equal(grown.counts.aliasesOfExisting, 1);
  assert.equal(grown.manifest.documentCount, 40);
  assert.equal(grown.manifest.aliasCount, 2);
  // only the 15 new documents were fingerprinted
  assert.equal(grown.counts.retainedFingerprints, grown.manifest.postingsCount - clean.manifest.postingsCount);
  for (const segmentId of clean.newSegmentIds) {
    assert.deepEqual(hashTree(path.join(rootA, 'segments', segmentId)), segmentsBefore[segmentId], `segment ${segmentId} changed`);
    assert.equal(fs.statSync(path.join(rootA, 'segments', segmentId, 'dict.bin')).mtimeMs, mtimesBefore[segmentId], `segment ${segmentId} was rewritten`);
  }
  for (const partition of grown.manifest.partitions) assert.ok(partition.segmentIds.length <= 2);

  const oldReader = await CorpusGenerationReader.open({ store: storeA, generationId: clean.generationId });
  const newReader = await CorpusGenerationReader.open({ store: storeA, generationId: grown.generationId, verify: 'sha256' });
  assert.equal(oldReader.locate(docIdOf(texts[30])), null);
  assert.ok(newReader.locate(docIdOf(texts[30])));
  assert.ok(newReader.locate(docIdOf(texts[2])));
  // the alias that arrived later for an old document is found through the new segment's addendum
  const three = await newReader.fetchMetadata(docIdOf(texts[3]));
  assert.equal(three.laterAliases.length, 1);
  assert.equal(three.laterAliases[0].provider, 'late-mirror');
  assert.equal((await oldReader.fetchMetadata(docIdOf(texts[3]))).laterAliases.length, 0);
  // a query pinned to the old generation cannot see a document added after it
  const query = sliceWords(texts[33], 20, 150);
  assert.equal((await retrieveCandidates(oldReader, query)).candidates.length, 0);
  assert.equal((await retrieveCandidates(newReader, query)).candidates[0].docId, docIdOf(texts[33]));
});

test('publication: only a validated generation becomes active; a damaged candidate leaves the previous one serving', () => {
  assert.equal(published1.published, true);
  assert.equal(published1.pointer.generationId, clean.generationId);
  assert.equal(published1.pointer.previousGenerationId, null);
  // the damaged candidate was refused, with a reason naming the segment
  assert.equal(refused.published, false);
  assert.ok(refused.validation.errors.some((message) => message.includes(damagedSegment)), refused.validation.errors.join(' | '));
  assert.equal(activeAfterRefusal.generationId, clean.generationId);
  assert.equal(activeAfterRefusal.activatedAt, '2026-10-06T00:00:00.000Z');
  // and the previously active generation is intact and fully searchable
  assert.equal(gen1StillValid.ok, true, gen1StillValid.errors.join(' | '));
  assert.ok(gen1StillValid.checks.filesHashed > 0 && gen1StillValid.checks.postingsChecked === clean.manifest.postingsCount);
  assert.equal(gen1QueryDuringDamage.state, 'COMPLETE');
  assert.equal(gen1QueryDuringDamage.candidates[0].docId, docIdOf(texts[9]));
  // once repaired it validates and activates
  assert.equal(published2.published, true);
  assert.equal(published2.pointer.generationId, grown.generationId);
  assert.equal(published2.pointer.previousGenerationId, clean.generationId);
  const log = fs.readFileSync(path.join(rootA, 'activation-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(log.slice(0, 3).map((entry) => entry.event), ['PUBLISHED', 'PUBLICATION_REFUSED', 'PUBLISHED']);
});

test('publication: a build that dies leaves no generation behind and changes nothing that was published', () => {
  assert.ok(failedBuild instanceof Error && failedBuild.message === 'doomed');
  assert.equal(activeAfterFailedBuild.generationId, grown.generationId);
  assert.deepEqual(treeAfterFailedBuild, treeBeforeFailedBuild);
  assert.deepEqual(segmentTreeAfterFailedBuild, segmentTreeBeforeFailedBuild);
  // its ledger exists (so it could be resumed) but records no generation
  const ledger = fs.readFileSync(path.join(rootA, 'builds', 'doomed', 'ledger.jsonl'), 'utf8');
  assert.ok(ledger.includes('"type":"commit"') && !ledger.includes('"type":"generation-built"'));
});

test('rollback: an older generation can be re-activated, and forward again', () => {
  assert.equal(rollback.published, true);
  assert.equal(rollback.pointer.generationId, clean.generationId);
  assert.equal(rollback.pointer.previousGenerationId, grown.generationId);
  assert.equal(republish.pointer.generationId, grown.generationId);
});

test('revocation: a revoked document disappears from retrieval and text fetch in EVERY generation, including after rollback', () => {
  assert.equal(revocation.sequence, 1);
  for (const generationId of [clean.generationId, grown.generationId]) {
    // before: it is the top candidate and its text is served
    assert.equal(beforeRevocation[generationId].retrieval.candidates[0].docId, revokedId);
    assert.equal(beforeRevocation[generationId].text.state, 'OK');
    // after: gone from candidates, text refused, metadata refused — same generation, same files
    assert.ok(!afterRevocation[generationId].retrieval.candidates.some((candidate) => candidate.docId === revokedId));
    assert.equal(afterRevocation[generationId].retrieval.state, 'COMPLETE');
    assert.equal(afterRevocation[generationId].text.state, 'REVOKED');
    assert.equal(afterRevocation[generationId].metadata.state, 'REVOKED');
    // and the identity every result carries shows which revocation list was applied
    assert.notEqual(afterRevocation[generationId].epoch, beforeRevocation[generationId].epoch);
    assert.equal(afterRevocation[generationId].retrieval.identity.revocationEpoch, afterRevocation[generationId].epoch);
  }
  assert.equal(rollbackAfterRevocation.published, true);
  assert.equal(rollbackAfterRevocation.pointer.revocationAnchor.sequence, 1);
  // the pointer written BEFORE the revocation anchors the empty list
  assert.equal(republish.pointer.revocationAnchor.sequence, 0);
  assert.equal(rolledBackReader.generationId, clean.generationId);
  assert.ok(!rolledBackRetrieval.candidates.some((candidate) => candidate.docId === revokedId));
});

test('revocation: the same content cannot be re-ingested under another source', () => {
  assert.equal(reingest.counts.rejectedRevoked, 1);
  assert.equal(reingest.counts.newDocuments, 1);
  assert.ok(!reingestRetrieval.candidates.some((candidate) => candidate.docId === revokedId));
  assert.equal(reingest.manifest.documentCount, 41);
});

test('revocation: a missing, damaged or stale list fails closed — it is never read as "nothing revoked"', async () => {
  const listFile = path.join(rootA, ...REVOCATION_LIST_KEY.split('/'));
  const open = (options = {}) => CorpusGenerationReader.open({ store: storeA, generationId: grown.generationId, ...options });
  const coded = (code) => (error) => error instanceof CorpusGenerationError && error.code === code;

  const anchor = readActivePointer(rootA).revocationAnchor;
  assert.equal(anchor.sequence, 1);
  await open({ revocationAnchor: anchor });
  // an anchor from before the revocation still accepts the longer list (it only pins history)
  await open({ revocationAnchor: republish.pointer.revocationAnchor });
  await assert.rejects(open({ revocationAnchor: { sequence: 2, lineSha256: anchor.lineSha256 } }), coded('REVOCATION_LIST_STALE'));

  const original = fs.readFileSync(listFile);
  try {
    fs.renameSync(listFile, `${listFile}.away`);
    await assert.rejects(open(), coded('REVOCATION_LIST_MISSING'));
    assert.equal((await validateGeneration(storeA, grown.generationId)).ok, false);
    fs.renameSync(`${listFile}.away`, listFile);

    // an edited entry — even the LAST one — no longer matches its own hash
    fs.writeFileSync(listFile, original.toString('utf8').replace('rights holder request', 'nothing to see here'));
    await assert.rejects(open(), coded('REVOCATION_LIST_CORRUPT'));
    // pointing the last entry at another document would un-revoke document 7: also caught
    fs.writeFileSync(listFile, original.toString('utf8').replace(`"docId":"${docIdToDecimal(revokedId)}"`, `"docId":"${docIdToDecimal(docIdOf(texts[8]))}"`));
    await assert.rejects(open(), coded('REVOCATION_LIST_CORRUPT'));
    // a list cut back to its header is internally consistent — only the anchor held outside it shows the loss
    fs.writeFileSync(listFile, `${original.toString('utf8').split('\n')[0]}\n`);
    await open();
    await assert.rejects(open({ revocationAnchor: anchor }), coded('REVOCATION_LIST_STALE'));
  } finally {
    fs.writeFileSync(listFile, original);
  }
  await open();
});

test('retrieval completion: COMPLETE only when everything answered; otherwise PARTIAL or FAILED, with what was not searched', async () => {
  const faulty = new FaultInjectingObjectStore(new LocalDirectoryObjectStore(rootA));
  const query = `${sliceWords(texts[2], 0, 150)} ${sliceWords(texts[12], 0, 150)} ${sliceWords(texts[20], 0, 150)} ${sliceWords(texts[31], 0, 150)}`;
  try {
    const healthy = await CorpusGenerationReader.open({ store: faulty, generationId: grown.generationId });
    const complete = await retrieveCandidates(healthy, query);
    assert.equal(complete.state, 'COMPLETE');
    assert.deepEqual(complete.failures, []);
    assert.equal(complete.candidates.length, 4);
    assert.equal(complete.stats.segmentsQueried, healthy.slots.length);
    assert.deepEqual(complete.identity, healthy.identity());

    // one segment's postings vanish AFTER the reader opened
    const victim = healthy.slots.find((slot) => slot.reader.ordinalOf(docIdOf(texts[12])) >= 0);
    faulty.setFault(`segments/${victim.segmentId}/postings.bin`, 'missing');
    const partial = await retrieveCandidates(healthy, query);
    assert.equal(partial.state, 'PARTIAL');
    assert.equal(partial.failures.length, 1);
    assert.deepEqual({ ...partial.failures[0], message: undefined }, { partition: victim.partition, segmentId: victim.segmentId, phase: 'score', artifact: 'postings.bin', code: 'MISSING', message: undefined });
    assert.ok(partial.candidates.length < 4 && partial.candidates.length > 0);
    assert.ok(!partial.candidates.some((candidate) => candidate.docId === docIdOf(texts[12])));
    faulty.clearFaults();

    // a corrupt dictionary block
    const fresh = await CorpusGenerationReader.open({ store: faulty, generationId: grown.generationId, dictionaryBlockCacheBlocks: 0 });
    faulty.setFault(`segments/${victim.segmentId}/dict.bin`, 'corrupt');
    const corrupt = await retrieveCandidates(fresh, query);
    assert.equal(corrupt.state, 'PARTIAL');
    assert.equal(corrupt.failures[0].phase, 'lookup');
    assert.equal(corrupt.failures[0].code, 'INTEGRITY_MISMATCH');
    assert.equal(corrupt.failures[0].segmentId, victim.segmentId);
    faulty.clearFaults();

    // a segment that cannot even be opened is reported on every query against that reader
    faulty.setFault(`segments/${victim.segmentId}/segment.json`, 'unreadable');
    const degraded = await CorpusGenerationReader.open({ store: faulty, generationId: grown.generationId });
    faulty.clearFaults();
    const degradedResult = await retrieveCandidates(degraded, query);
    assert.equal(degradedResult.state, 'PARTIAL');
    assert.equal(degradedResult.failures[0].phase, 'open');
    assert.equal((await degraded.fetchText(docIdOf(texts[12]))).state, 'FAILED', 'a document in an unopened segment is FAILED, never NOT_FOUND');
    // ...and such a generation cannot be published
    faulty.setFault(`segments/${victim.segmentId}/segment.json`, 'unreadable');
    assert.equal((await validateGeneration(faulty, grown.generationId)).ok, false);

    // nothing searchable at all
    for (const slot of healthy.slots) faulty.setFault(`segments/${slot.segmentId}/segment.json`, 'missing');
    const dead = await CorpusGenerationReader.open({ store: faulty, generationId: grown.generationId });
    const failed = await retrieveCandidates(dead, query);
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.candidates.length, 0);
    assert.equal(failed.failures.length, healthy.slots.length);
    faulty.clearFaults();

    // a submission with nothing to look up is a legitimate, COMPLETE, empty answer
    assert.equal((await retrieveCandidates(healthy, 'too short')).state, 'COMPLETE');
  } finally {
    await faulty.close();
  }
});

test('a generation is opened only by its exact id, and only if this build can reproduce its processing identity', async () => {
  const coded = (code) => (error) => error instanceof CorpusGenerationError && error.code === code;
  await assert.rejects(CorpusGenerationReader.open({ store: storeA, generationId: 'latest' }), coded('INVALID_GENERATION_ID'));
  await assert.rejects(CorpusGenerationReader.open({ store: storeA, generationId: 'gen-000000000000000000000000' }), coded('GENERATION_NOT_FOUND'));
  await assert.rejects(CorpusGenerationReader.open({ store: storeA, generationId: grown.generationId, expectedLogicalManifestSha256: 'f'.repeat(64) }), coded('GENERATION_PIN_MISMATCH'));
  // the manifest is self-certifying: one changed byte and it no longer hashes to its own id
  const manifestFile = path.join(rootA, 'generations', grown.generationId, 'manifest.json');
  const restore = flipByte(manifestFile, 30);
  await assert.rejects(loadGenerationManifest(storeA, grown.generationId), coded('GENERATION_MANIFEST_MISMATCH'));
  restore();

  // a generation recorded under another normalization probe is refused (simulated by rewriting a copy)
  const { manifest } = await loadGenerationManifest(storeA, grown.generationId);
  assert.deepEqual(manifest.processing, currentProcessingIdentity());
  const { canonicalJson, sha256Hex } = await import('../lib/corpus-engine/bytes.ts');
  const drifted = { ...manifest, processing: { ...manifest.processing, normalization: { ...manifest.processing.normalization, probeSha256: '0'.repeat(64) } } };
  const bytes = Buffer.from(canonicalJson(drifted), 'utf8');
  const driftedId = `gen-${sha256Hex(bytes).slice(0, 24)}`;
  fs.mkdirSync(path.join(rootA, 'generations', driftedId), { recursive: true });
  fs.writeFileSync(path.join(rootA, 'generations', driftedId, 'manifest.json'), bytes);
  await assert.rejects(CorpusGenerationReader.open({ store: storeA, generationId: driftedId }), coded('UNSUPPORTED_PROCESSING_IDENTITY'));
  const validation = await validateGeneration(storeA, driftedId);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((message) => message.includes('normalization.probeSha256')));
  assert.equal((await publishGeneration(rootA, driftedId)).published, false);
});
