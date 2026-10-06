import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, fixtureSource, inventedText, prng, removeScratch, sliceWords, wordsOf } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { computeQueryFingerprints, documentFingerprintHexes, normalizeForCorpus } from '../lib/corpus-engine/fingerprints.ts';
import { deriveDocId, docIdToDecimal } from '../lib/corpus-engine/ids.ts';
import { runCorpusEngineCandidateVerification } from '../lib/corpus-engine/index.ts';
import { CORPUS_ENGINE_V1_FLAG, isCorpusEngineV1Enabled } from '../lib/corpus-engine/flag.ts';
import { CorpusGenerationReader } from '../lib/corpus-engine/reader.ts';
import { DEFAULT_CANDIDATE_RANKING_POLICY, retrieveCandidates } from '../lib/corpus-engine/retrieval.ts';
import { appendRevocation } from '../lib/corpus-engine/revocation.ts';
import { InMemorySourceAdapter } from '../lib/corpus-engine/source-adapter.ts';
import { FaultInjectingObjectStore, LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';
import { admitCandidates, createVerifierArtifactView, verifyCandidatesWithExistingVerifier } from '../lib/corpus-engine/verifier-adapter.ts';
import { NORMALIZATION_PROBE_TEXT } from '../lib/corpus-engine/versions.ts';
import { SELECTIVE_CORPUS_STOP_DF, SELECTIVE_CORPUS_STRICT_SPAN } from '../lib/selective-corpus/constants.ts';
import { selectiveCorpusDocumentHashes, winnowSubmissionFingerprints } from '../lib/selective-corpus/fingerprint.ts';
import { admitSelectiveCorpusCandidate, selectiveCorpusSubmissionWords } from '../lib/selective-corpus/verify.ts';
import { runWithScoringNormalization } from '../lib/scoring-normalization-scope.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';

/**
 * Corpus Engine v1 — retrieval is part of similarity correctness.
 *
 * The verifier can reject a bad candidate; it cannot recover a true source
 * retrieval never returned. So this file compares, on one submission built to
 * provoke the failure, (a) the existing verifier run over EVERY document with
 * (b) the engine's candidates run through the same verifier — on matched
 * positions and score, not only on which ids came back.
 *
 * All builds finish before the first test() is registered.
 */

const scratch = corpusEngineScratch('retrieval');
const docIdOf = (text) => deriveDocId(normalizeForCorpus(text).normalizedContentSha256);

// ── corpus ──────────────────────────────────────────────────────────────────
// B        one unique, heavily copied source
// A        a source with 30 near-copies (a "family": every copy shares most of A's fingerprints)
// S1..S3   three sources that each contribute one short passage
// noise    unrelated documents
const B = inventedText(600, 1200);
const A = inventedText(500, 2400);
const replacement = prng(77);
const familyOf = (text, copies) => Array.from({ length: copies }, (_, copy) => {
  const words = wordsOf(text);
  for (let index = 20 + copy; index < words.length; index += 40) words[index] = `variant${copy}x${Math.floor(replacement() * 1e6)}`;
  return words.join(' ');
});
const family = familyOf(A, 30);
const S = [inventedText(701, 300), inventedText(702, 300), inventedText(703, 300)];
const noise = Array.from({ length: 40 }, (_, index) => inventedText(800 + index, 400));

const sources = [
  fixtureSource('B', B),
  fixtureSource('A', A),
  ...family.map((text, index) => fixtureSource(`A-family-${String(index).padStart(2, '0')}`, text)),
  ...S.map((text, index) => fixtureSource(`S${index + 1}`, text)),
  ...noise.map((text, index) => fixtureSource(`noise-${String(index).padStart(2, '0')}`, text)),
];

// ── submission ──────────────────────────────────────────────────────────────
// words    0- 799  copied from B            (regions 0-3)
//        800-1599  copied from A            (regions 4-7; 31 family documents all match here)
//       1600-1699  original
//       1700-1789  90 words of S1           (region 8)
//       1790-1899  original
//       1900-1989  90 words of S2           (region 9)
//       1990-2099  original
//       2100-2189  90 words of S3           (region 10)
//       2190-2299  original
const filler = (seed, count) => inventedText(40_000 + seed, count);
const submission = [
  sliceWords(B, 0, 800),
  sliceWords(A, 100, 800),
  filler(1, 100),
  sliceWords(S[0], 50, 90),
  filler(2, 110),
  sliceWords(S[1], 10, 90),
  filler(3, 110),
  sliceWords(S[2], 100, 90),
  filler(4, 110),
].join(' ');
assert.equal(wordsOf(submission).length, 2300);
const smallSourceIds = S.map(docIdOf);

async function build(root, partitionBits) {
  return runCorpusBuild({ corpusRoot: root, buildId: 'fixture', parentGenerationId: null, partitionBits, runBufferTuples: 20_000 }, [new InMemorySourceAdapter('fixture', sources)]);
}
const root = path.join(scratch, 'four-partitions');
const built = await build(root, 2);
const rootSingle = path.join(scratch, 'one-partition');
const builtSingle = await build(rootSingle, 0);

const store = new LocalDirectoryObjectStore(root);
const reader = await CorpusGenerationReader.open({ store, generationId: built.generationId });
const storeSingle = new LocalDirectoryObjectStore(rootSingle);
const readerSingle = await CorpusGenerationReader.open({ store: storeSingle, generationId: builtSingle.generationId });

// (a) the reference: the existing verifier over every document of the generation
const everyDocument = [...reader.allDocumentIds()];
const exhaustive = await verifyCandidatesWithExistingVerifier(reader, submission, everyDocument);

// (b) the engine at a deliberately tight budget, with and without region awareness
const tight = { candidateBudget: 20 };
const regionAware = await retrieveCandidates(reader, submission, tight);
const globalOnly = await retrieveCandidates(reader, submission, { ...tight, regionAware: false });
const regionAwareVerified = await verifyCandidatesWithExistingVerifier(reader, submission, regionAware.candidates.map((candidate) => candidate.docId));
const globalOnlyVerified = await verifyCandidatesWithExistingVerifier(reader, submission, globalOnly.candidates.map((candidate) => candidate.docId));

test.after(async () => {
  await store.close();
  await storeSingle.close();
  removeScratch(scratch);
});

test('fingerprints are the existing Selective Corpus representation, exactly — no new algorithm', () => {
  for (const text of [submission, A, S[0], NORMALIZATION_PROBE_TEXT, 'short text of exactly seven distinct words here', 'two words']) {
    const tokens = normalizeForCorpus(text).tokens;
    assert.deepEqual(documentFingerprintHexes(tokens), [...selectiveCorpusDocumentHashes(text)].sort(), 'document side');
    const existing = winnowSubmissionFingerprints(text);
    assert.equal(existing.trimmed, false);
    const query = computeQueryFingerprints(text, 200);
    assert.deepEqual(query.fingerprints.map((fingerprint) => fingerprint.hex), [...existing.fingerprints].sort(), 'submission side');
    assert.equal(query.tokenCount, tokens.length);
    // the only addition: where each fingerprint is, and the region that implies
    for (const fingerprint of query.fingerprints) {
      assert.deepEqual(fingerprint.regions, [...new Set(fingerprint.positions.map((position) => Math.floor(position / 200)))].sort((left, right) => left - right));
    }
  }
  assert.equal(computeQueryFingerprints(submission, 200).regionCount, 12);
});

test('the reference: the existing verifier, run over every document, admits B and the three small sources', () => {
  assert.equal(exhaustive.state, 'COMPLETE');
  assert.equal(exhaustive.candidatesVerified, sources.length);
  const admitted = new Set(exhaustive.verifiedSources.map((source) => source.docId));
  assert.ok(admitted.has(docIdToDecimal(docIdOf(B))));
  for (const id of smallSourceIds) assert.ok(admitted.has(docIdToDecimal(id)));
  // The A family is suppressed by the EXISTING verifier's FAMILY_GUARD (a span held by 31 documents is
  // shared-family boilerplate). That is existing semantics, reproduced here, not a choice of this engine.
  assert.ok(!admitted.has(docIdToDecimal(docIdOf(A))));
  assert.ok(exhaustive.familyGuardActivations >= 31);
  // every small passage is fully inside the union
  for (const start of [1700, 1900, 2100]) {
    for (let position = start + 2; position < start + 88; position += 1) assert.ok(exhaustive.matchedPositions.includes(position), `position ${position}`);
  }
  assert.ok(exhaustive.unifiedScore >= 45 && exhaustive.unifiedScore <= 50, `score ${exhaustive.unifiedScore}`);
});

test('whole-document ranking alone loses the small sources: dominant matches fill the budget', () => {
  assert.equal(globalOnly.state, 'COMPLETE');
  assert.equal(globalOnly.candidates.length, 20);
  // B, then members of the 31-document family — and nothing else fits
  assert.equal(globalOnly.candidates[0].docId, docIdOf(B));
  for (const id of smallSourceIds) assert.ok(!globalOnly.candidates.some((candidate) => candidate.docId === id));
  // so the verifier never sees them, and the final union and score are WRONG, silently
  assert.ok(globalOnlyVerified.matchedWordCount < exhaustive.matchedWordCount - 250);
  assert.ok(globalOnlyVerified.unifiedScore < exhaustive.unifiedScore - 10, `${globalOnlyVerified.unifiedScore} vs ${exhaustive.unifiedScore}`);
  assert.equal(globalOnlyVerified.state, 'COMPLETE', 'nothing failed — the loss is invisible without an exhaustive reference');
});

test('region-aware retrieval recovers them inside the same budget, and the verified result equals the exhaustive one', () => {
  assert.equal(regionAware.state, 'COMPLETE');
  assert.equal(regionAware.candidates.length, 20);
  for (const id of smallSourceIds) {
    const candidate = regionAware.candidates.find((entry) => entry.docId === id);
    assert.ok(candidate, 'small source missing');
    assert.equal(candidate.nominatedBy, 'region');
    assert.equal(candidate.bestRegionRank, 1);
    assert.equal(candidate.globalRank, null, 'it is outside the whole-document top list');
    assert.equal(candidate.regionsSupported, 1);
    assert.ok(candidate.rank <= regionAware.stats.queryRegions + 1, `rank ${candidate.rank}`);
  }
  assert.deepEqual(regionAwareVerified.matchedPositions, exhaustive.matchedPositions);
  assert.equal(regionAwareVerified.unifiedScore, exhaustive.unifiedScore);
  assert.deepEqual(
    regionAwareVerified.verifiedSources.map((source) => source.docId).sort(),
    exhaustive.verifiedSources.map((source) => source.docId).sort(),
  );
});

test('retrieval nominates only: positions and the score come from the existing verifier and union, unchanged', async () => {
  // Recompute B's evidence by calling the existing functions directly, with no engine code in between.
  const artifact = createVerifierArtifactView(reader, []);
  const direct = await admitSelectiveCorpusCandidate(submission, selectiveCorpusSubmissionWords(submission), B, artifact);
  assert.equal(direct.admitted, true);
  const fromAdapter = regionAwareVerified.verifiedSources.find((source) => source.docId === docIdToDecimal(docIdOf(B)));
  assert.equal(fromAdapter.totalMatchedWords, direct.totalMatchedWords);
  assert.equal(fromAdapter.longestSpan, direct.longestSpan);
  // the score is computeUnifiedSimilarity's, over exactly the adapter's evidence
  const unified = computeUnifiedSimilarity({
    wordCount: regionAwareVerified.submissionWordCount,
    selectiveCorpusEvidence: regionAwareVerified.verifiedSources.map((source) => ({ sourceId: source.docId, matchedPassages: source.matchedPassages })),
  });
  assert.equal(regionAwareVerified.unifiedScore, unified.unifiedScore);
  assert.deepEqual(regionAwareVerified.matchedPositions, unified.matchedPositions);
  assert.equal(unified.selectiveCorpusOnlyWords, regionAwareVerified.matchedWordCount);
  // candidates carry no positions and no score — only nomination figures
  for (const candidate of regionAware.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['bestRegion', 'bestRegionRank', 'docId', 'docIdDecimal', 'fingerprintHits', 'globalRank', 'globalWeight', 'nominatedBy', 'ordinal', 'partition', 'rank', 'regionsSupported', 'segmentId', 'tokenCount']);
  }
  // the verifier's own thresholds are the frozen ones
  assert.deepEqual(SELECTIVE_CORPUS_STRICT_SPAN, { minMatchedWords: 60, minLongestContiguousSpan: 25 });
});

test('a document score is complete and the merge deterministic: one partition and four give the same ranking', async () => {
  const single = await retrieveCandidates(readerSingle, submission, tight);
  assert.equal(readerSingle.slots.length, 1);
  assert.equal(reader.slots.length, 4);
  assert.deepEqual(single.candidates.map((candidate) => candidate.docIdDecimal), regionAware.candidates.map((candidate) => candidate.docIdDecimal));
  assert.deepEqual(single.candidates.map((candidate) => candidate.globalWeight), regionAware.candidates.map((candidate) => candidate.globalWeight));
  assert.deepEqual(single.candidates.map((candidate) => candidate.fingerprintHits), regionAware.candidates.map((candidate) => candidate.fingerprintHits));
  assert.equal(single.stats.touchedDocuments, regionAware.stats.touchedDocuments);
  // and repeating a query changes nothing
  const again = await retrieveCandidates(reader, submission, tight);
  assert.deepEqual(again.candidates, regionAware.candidates);
  // a smaller budget is a prefix of a larger one, so one retrieval serves every K
  const wide = await retrieveCandidates(reader, submission, { candidateBudget: 500 });
  assert.deepEqual(wide.candidates.slice(0, 20).map((candidate) => candidate.docIdDecimal), regionAware.candidates.map((candidate) => candidate.docIdDecimal));
  assert.ok(wide.candidates.length >= 35);
});

test('retrieval reads postings, not documents: the work is the query fingerprints and what they touch', () => {
  assert.equal(regionAware.stats.queryFingerprints > 200, true);
  assert.equal(regionAware.stats.touchedDocuments, 35, 'B + A + 30 family + 3 small sources');
  assert.equal(regionAware.stats.segmentsQueried, 4);
  assert.equal(regionAware.stats.partitionsQueried, 4);
  assert.ok(regionAware.stats.postingsDecoded > 0);
  assert.ok(regionAware.stats.indexBytesRead < built.manifest.postingsCount * 16);
  // candidates name their generation; so does everything derived from them
  assert.deepEqual(regionAware.identity, reader.identity());
  assert.deepEqual(regionAwareVerified.identity, reader.identity());
});

test('discovery-only suppression of common fingerprints changes which candidates are fetched, never how one is verified', async () => {
  const unsuppressed = await retrieveCandidates(reader, submission, { candidateBudget: 500 });
  const suppressed = await retrieveCandidates(reader, submission, { candidateBudget: 500, maxDiscoveryDocumentFrequency: SELECTIVE_CORPUS_STOP_DF - 1 });
  assert.equal(unsuppressed.stats.fingerprintsSuppressed, 0);
  assert.ok(suppressed.stats.fingerprintsSuppressed > 50);
  assert.ok(suppressed.stats.touchedDocuments < unsuppressed.stats.touchedDocuments);
  assert.ok(suppressed.stats.postingsDecoded < unsuppressed.stats.postingsDecoded / 2);
  assert.equal(suppressed.rankingPolicy.maxDiscoveryDocumentFrequency, 12);
  // the contributing sources are still nominated, and the verified result is identical
  const verified = await verifyCandidatesWithExistingVerifier(reader, submission, suppressed.candidates.map((candidate) => candidate.docId));
  assert.deepEqual(verified.matchedPositions, exhaustive.matchedPositions);
  assert.equal(verified.unifiedScore, exhaustive.unifiedScore);
  // a candidate retrieved under suppression is verified against its WHOLE text: same spans either way
  const one = await admitCandidates(reader, submission, [docIdOf(A)]);
  assert.equal(one.admissions[0].strictSpanPass, true, 'the common text is still matched by the verifier');
  assert.equal(one.admissions[0].familyGuardActivated, true);
});

test('the verifier view answers FAMILY_GUARD from the pinned generation: stop test at df 13, postings = holders', async () => {
  const failures = [];
  const artifact = createVerifierArtifactView(reader, failures);
  // count document frequency by brute force over the fixture
  const df = new Map();
  for (const source of sources) for (const hex of documentFingerprintHexes(normalizeForCorpus(source.text).tokens)) df.set(hex, (df.get(hex) ?? 0) + 1);
  let stop = 0;
  let checked = 0;
  for (const [hex, count] of [...df.entries()].filter((_, index) => index % 23 === 0)) {
    assert.equal(artifact.stopHashes.has(hex), count >= SELECTIVE_CORPUS_STOP_DF, `${hex} df ${count}`);
    const postings = await artifact.postingsAccessor.getPostings(hex);
    if (count >= SELECTIVE_CORPUS_STOP_DF) {
      stop += 1;
      assert.equal(postings, undefined, 'a stop hash has no postings, as in the packed artifact');
    } else {
      assert.equal(postings.length, count);
      assert.equal(new Set(postings).size, count);
    }
    checked += 1;
  }
  assert.ok(stop > 5 && checked > 100);
  assert.equal(artifact.stopHashes.has('00000000000000aa'), false);
  assert.equal(await artifact.postingsAccessor.getPostings('00000000000000aa'), undefined);
  assert.deepEqual(failures, []);
  assert.equal(artifact.corpusDigest, reader.logicalManifestSha256);
});

test('a candidate whose text cannot be fetched makes the verification PARTIAL — it is never counted as "did not match"', async () => {
  const faulty = new FaultInjectingObjectStore(new LocalDirectoryObjectStore(root));
  try {
    const faultyReader = await CorpusGenerationReader.open({ store: faulty, generationId: built.generationId });
    const location = faultyReader.locate(docIdOf(B));
    faulty.setFault(`segments/${location.segmentId}/text-0000.pack`, 'corrupt');
    const candidates = regionAware.candidates.map((candidate) => candidate.docId);
    const result = await verifyCandidatesWithExistingVerifier(faultyReader, submission, candidates);
    assert.equal(result.state, 'PARTIAL');
    assert.ok(result.failures.length >= 1);
    assert.ok(result.failures.every((failure) => failure.stage === 'text-fetch' && failure.segmentId === location.segmentId));
    assert.ok(result.failures.some((failure) => failure.docId === docIdToDecimal(docIdOf(B))));
    assert.ok(!result.verifiedSources.some((source) => source.docId === docIdToDecimal(docIdOf(B))));
    assert.ok(result.matchedWordCount < exhaustive.matchedWordCount);
    assert.ok(result.candidatesVerified < candidates.length);

    // FAMILY_GUARD losing part of the index is also reported
    faulty.clearFaults();
    const other = faultyReader.slots.find((slot) => slot.segmentId !== location.segmentId);
    faulty.setFault(`segments/${other.segmentId}/dict.bin`, 'unreadable');
    const guarded = await verifyCandidatesWithExistingVerifier(faultyReader, submission, candidates);
    assert.equal(guarded.state, 'PARTIAL');
    assert.ok(guarded.failures.some((failure) => failure.stage === 'family-guard' && failure.segmentId === other.segmentId));
  } finally {
    await faulty.close();
  }
});

test('the verifier refuses to run under a normalization contract the generation was not built with', async () => {
  const result = await runWithScoringNormalization(1, () => verifyCandidatesWithExistingVerifier(reader, submission, smallSourceIds));
  assert.equal(result.state, 'FAILED');
  assert.equal(result.failures[0].code, 'NORMALIZATION_CONTRACT_MISMATCH');
  assert.deepEqual(result.verifiedSources, []);
  assert.equal(result.unifiedScore, 0);
});

test('feature flag: default OFF returns DISABLED before anything is opened; only the exact string "true" enables it', async () => {
  const original = process.env[CORPUS_ENGINE_V1_FLAG];
  const request = { store, generationId: built.generationId, submissionText: submission, rankingPolicy: tight };
  try {
    delete process.env[CORPUS_ENGINE_V1_FLAG];
    assert.equal(isCorpusEngineV1Enabled(), false);
    store.resetStats();
    assert.deepEqual(await runCorpusEngineCandidateVerification(request), { state: 'DISABLED' });
    assert.deepEqual(await runCorpusEngineCandidateVerification({ ...request, generationId: 'not-even-valid' }), { state: 'DISABLED' });
    const idle = store.stats();
    assert.equal(idle.rangeReads + idle.wholeReads + idle.sizeProbes, 0, 'the disabled path touched storage');
    for (const value of ['1', 'TRUE', 'yes', 'on', ' true', '']) {
      process.env[CORPUS_ENGINE_V1_FLAG] = value;
      assert.equal((await runCorpusEngineCandidateVerification(request)).state, 'DISABLED', `enabled by ${JSON.stringify(value)}`);
    }

    process.env[CORPUS_ENGINE_V1_FLAG] = 'true';
    const enabled = await runCorpusEngineCandidateVerification(request);
    assert.equal(enabled.state, 'COMPLETE');
    assert.deepEqual(enabled.identity, reader.identity());
    assert.deepEqual(enabled.verification.matchedPositions, exhaustive.matchedPositions);
    assert.equal(enabled.verification.unifiedScore, exhaustive.unifiedScore);
    // a request must pin a real generation; "latest" is not a thing
    const unpinned = await runCorpusEngineCandidateVerification({ ...request, generationId: 'latest' });
    assert.equal(unpinned.state, 'FAILED');
    assert.equal(unpinned.failureCode, 'INVALID_GENERATION_ID');
    const wrongPin = await runCorpusEngineCandidateVerification({ ...request, logicalManifestSha256: '0'.repeat(64) });
    assert.equal(wrongPin.failureCode, 'GENERATION_PIN_MISMATCH');
  } finally {
    if (original === undefined) delete process.env[CORPUS_ENGINE_V1_FLAG];
    else process.env[CORPUS_ENGINE_V1_FLAG] = original;
  }
});

test('a revoked candidate handed to the verifier contributes nothing and its text is not read', async () => {
  // Runs last: it writes to this fixture root's revocation list.
  appendRevocation(root, { docId: smallSourceIds[1], reason: 'test', revokedAt: '2026-10-06T00:00:00.000Z' });
  const revokedReader = await CorpusGenerationReader.open({ store, generationId: built.generationId });
  const retrieval = await retrieveCandidates(revokedReader, submission, tight);
  assert.ok(!retrieval.candidates.some((candidate) => candidate.docId === smallSourceIds[1]));
  // even if a stale candidate list still names it
  const forced = await admitCandidates(revokedReader, submission, smallSourceIds);
  assert.deepEqual(forced.admissions.map((admission) => admission.outcome), ['ADMITTED', 'TEXT_REVOKED', 'ADMITTED']);
  assert.equal(forced.admissions[1].textCompressedBytesRead, 0);
  const verified = await verifyCandidatesWithExistingVerifier(revokedReader, submission, retrieval.candidates.map((candidate) => candidate.docId));
  assert.ok(!verified.matchedPositions.includes(1940));
  assert.ok(verified.matchedPositions.includes(1740) && verified.matchedPositions.includes(2140));
  assert.equal(verified.identity.revocationEpoch, revokedReader.identity().revocationEpoch);
  assert.notEqual(verified.identity.revocationEpoch, reader.identity().revocationEpoch);
  assert.equal(DEFAULT_CANDIDATE_RANKING_POLICY.regionAware, true);
});
