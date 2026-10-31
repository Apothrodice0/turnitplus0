import assert from "node:assert/strict";
import test from "node:test";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { unifiedEvidenceSummary, selectiveCorpusMatchedPositions, hasIncompleteSelectiveCorpusCheck } from "../lib/report-types.ts";

/**
 * AUTHORITATIVE PROMOTION — pure, DB-free unit tests for
 * computeUnifiedSimilarity's new Selective Corpus V4 evidence channel, and
 * the small report-types.ts helpers built on top of it. Mirrors
 * tests/unified-similarity.test.mjs's own style/fixtures exactly — every
 * case constructs plain inputs and asserts on the plain return value; no
 * database, no report, no Selective Corpus matcher of any kind is touched.
 */

function historicalMatch(overrides = {}) {
  return {
    relationshipType: "PRIOR_SUBMISSION",
    matchedRepresentationId: "rep-1",
    matchType: "STRONG_TEXT_MATCH",
    containment: 0.6,
    matchedWordCount: 0,
    passageCount: 0,
    longestMatchWords: 0,
    passages: [],
    historicalSubmissionCount: 1,
    ...overrides,
  };
}

function matchedResult(matches) {
  return { status: "MATCHED", matches, computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v" };
}

function selectiveCorpusEvidence(sourceId, passages) {
  return [{ sourceId, matchedPassages: passages }];
}

// --- 1: verified V4 evidence enters the canonical matched-position union ----

test("1: verified Selective Corpus evidence enters the canonical matched-position union", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }]),
  });
  assert.equal(result.unifiedScore, 10);
  assert.equal(result.uniqueMatchedWords, 100);
  assert.equal(result.selectiveCorpusOnlyWords, 100);
  assert.deepEqual(result.selectiveCorpusPositions, Array.from({ length: 100 }, (_, i) => i));
  assert.deepEqual(result.matchedPositions, result.selectiveCorpusPositions);
});

// --- 2: Archive + V4 same position counts once ------------------------------

test("2: Archive + Selective Corpus overlapping the SAME position counts once in the numerator, never summed", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 200,
    archiveMatchedPositions: Array.from({ length: 50 }, (_, i) => i), // 0..49
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 0, submittedWordEnd: 49, matchedWordCount: 50 }]), // same 0..49
  });
  assert.equal(result.uniqueMatchedWords, 50, "identical overlapping ranges must count once, not 100");
  assert.equal(result.unifiedScore, 25);
  assert.equal(result.overlapWords, 50);
  assert.equal(result.archiveOnlyWords, 0);
  assert.equal(result.selectiveCorpusOnlyWords, 0);
});

// --- 3: V4 + a DIFFERENT source's partial overlap counts once ---------------

test("3: Selective Corpus overlapping a live-academic passage counts the shared words once", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 300,
    externalAcademicEvidence: [
      { provider: "openaire", providerId: "ext-1", title: "t", authors: null, publication: null, year: null, doi: "10.1/x", url: null, similarity: 90, matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }] },
    ],
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 50, submittedWordEnd: 149, matchedWordCount: 100 }]), // overlaps 50..99
  });
  // union(0..99, 50..149) = 0..149 = 150 unique words, not 100+100=200
  assert.equal(result.uniqueMatchedWords, 150);
  assert.equal(result.unifiedScore, 50);
  assert.equal(result.overlapWords, 50, "the shared 50..99 range");
  assert.equal(result.liveAcademicOnlyWords, 50, "0..49 only-live");
  assert.equal(result.selectiveCorpusOnlyWords, 50, "100..149 only-V4");
});

// --- 4: source unavailable contributes zero (absent evidence, not a fabricated zero-range) ---

test("4: no selectiveCorpusEvidence supplied contributes exactly zero, byte-identical to before this channel existed", () => {
  const withoutV4 = computeUnifiedSimilarity({ wordCount: 500, archiveMatchedPositions: [1, 2, 3] });
  const withEmptyV4 = computeUnifiedSimilarity({ wordCount: 500, archiveMatchedPositions: [1, 2, 3], selectiveCorpusEvidence: [] });
  const withNullV4 = computeUnifiedSimilarity({ wordCount: 500, archiveMatchedPositions: [1, 2, 3], selectiveCorpusEvidence: null });
  for (const result of [withoutV4, withEmptyV4, withNullV4]) {
    assert.equal(result.selectiveCorpusOnlyWords, 0);
    assert.deepEqual(result.selectiveCorpusPositions, []);
    assert.equal(result.unifiedScore, withoutV4.unifiedScore);
  }
});

// --- 5/6/7: TIMEOUT/ARTIFACT_UNAVAILABLE/FAILED are represented at the
// caller level as "no selectiveCorpusEvidence passed" — computeUnifiedSimilarity
// itself has no state awareness; this proves the zero-contribution behavior
// those states rely on is the SAME absent/empty case as test 4 above, and
// that lib/selective-corpus-authoritative.ts's own pure evidence-selection
// policy (tested separately) is what actually turns a terminal state into
// "pass null" before ever reaching this function.

test("5/6/7: a report scored with no V4 evidence (the TIMEOUT/ARTIFACT_UNAVAILABLE/FAILED shape) still scores normally from every other channel", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 400,
    archiveMatchedPositions: [0, 1, 2, 3, 4],
    historicalSubmissionMatch: matchedResult([historicalMatch({ matchedRepresentationId: "rep-a", matchedWordCount: 10, passages: [{ submittedWordStart: 10, submittedWordEnd: 19, matchedWordCount: 10 }] })]),
    selectiveCorpusEvidence: null,
  });
  assert.equal(result.selectiveCorpusOnlyWords, 0);
  assert.equal(result.archiveOnlyWords, 5);
  assert.equal(result.previousUploadOnlyWords, 10);
  assert.equal(result.uniqueMatchedWords, 15);
});

// --- 8: PARTIAL contributes only its real verified lower-bound evidence ----

test("8: a PARTIAL-shaped verified evidence set (fewer passages than a hypothetical COMPLETED run) still merges in as real, final evidence — never treated as zero", () => {
  // Simulates lib/selective-corpus-authoritative.ts's own PARTIAL policy: the
  // evidence passed in IS the shadow's real verifiedEvidence, just possibly
  // smaller because Stage A ran over an incomplete shard index. From
  // computeUnifiedSimilarity's own perspective this is indistinguishable from
  // any other real evidence — proving PARTIAL's lower bound genuinely scores.
  const result = computeUnifiedSimilarity({
    wordCount: 200,
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 0, submittedWordEnd: 19, matchedWordCount: 20 }]),
  });
  assert.equal(result.selectiveCorpusOnlyWords, 20);
  assert.equal(result.unifiedScore, 10);
});

// --- 9: SELF prior-upload exclusion unchanged -------------------------------

test("9: a SELF prior-upload match stays excluded from the score regardless of Selective Corpus evidence being present", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 300,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ relationshipType: "SELF", matchedRepresentationId: "rep-self", matchedWordCount: 100, passages: [{ submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }] }),
    ]),
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 150, submittedWordEnd: 199, matchedWordCount: 50 }]),
  });
  assert.equal(result.selfExcludedWords, 100, "SELF exclusion itself is completely unaffected by V4's presence");
  assert.equal(result.previousUploadOnlyWords, 0);
  assert.equal(result.selectiveCorpusOnlyWords, 50, "V4's own, independent evidence still contributes");
  assert.equal(result.unifiedScore, Math.round((50 / 300) * 100));
});

// --- 10: independent V4 evidence survives an unrelated SELF exclusion ------

test("10: independent Selective Corpus evidence survives a SELF exclusion elsewhere in the same report, exactly like independent archive evidence already does", () => {
  const withSelfOnly = computeUnifiedSimilarity({
    wordCount: 300,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ relationshipType: "SELF", matchedRepresentationId: "rep-self", matchedWordCount: 100, passages: [{ submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }] }),
    ]),
  });
  const withSelfAndV4 = computeUnifiedSimilarity({
    wordCount: 300,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ relationshipType: "SELF", matchedRepresentationId: "rep-self", matchedWordCount: 100, passages: [{ submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }] }),
    ]),
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 200, submittedWordEnd: 249, matchedWordCount: 50 }]),
  });
  assert.equal(withSelfOnly.unifiedScore, 0, "sanity: SELF alone contributes nothing");
  assert.equal(withSelfAndV4.unifiedScore, Math.round((50 / 300) * 100), "V4's own evidence still raises the score despite the unrelated SELF exclusion");
  assert.equal(withSelfAndV4.selfExcludedWords, 100, "the SELF tally itself is unaffected");
});

// --- 11: headline score still equals union(admitted positions) / eligible positions, never weighted ---

test("11: headline score is exactly union(admitted positions)/wordCount, not a weighted/significance-adjusted figure, with V4 in the mix", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 100 }, (_, i) => i), // 0..99
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [
      { submittedWordStart: 100, submittedWordEnd: 199, matchedWordCount: 100 }, // 100..199, disjoint
    ]),
  });
  const expectedUnion = 200; // 0..99 + 100..199, disjoint, no overlap
  assert.equal(result.uniqueMatchedWords, expectedUnion);
  assert.equal(result.unifiedScore, Math.round((expectedUnion / 1000) * 100));
  assert.deepEqual(result.matchedPositions, Array.from({ length: 200 }, (_, i) => i));
});

// --- 12: source attribution bucket appears only with verified contribution ---

test("12: unifiedEvidenceSummary/selectiveCorpusMatchedPositions surface the generic Selective Corpus bucket ONLY when it actually contributed", () => {
  const zero = computeUnifiedSimilarity({ wordCount: 500, archiveMatchedPositions: [1, 2, 3] });
  const withV4 = computeUnifiedSimilarity({
    wordCount: 500,
    archiveMatchedPositions: [1, 2, 3],
    selectiveCorpusEvidence: selectiveCorpusEvidence("S1", [{ submittedWordStart: 10, submittedWordEnd: 19, matchedWordCount: 10 }]),
  });
  assert.doesNotMatch(unifiedEvidenceSummary(zero), /supplementary reference sources/);
  assert.match(unifiedEvidenceSummary(withV4), /supplementary reference sources/);
  assert.deepEqual(selectiveCorpusMatchedPositions({ unifiedSimilarity: zero }), []);
  assert.deepEqual(selectiveCorpusMatchedPositions({ unifiedSimilarity: withV4 }), withV4.selectiveCorpusPositions);
});

// --- extra: hasIncompleteSelectiveCorpusCheck reads the persisted marker only ---

test("extra: hasIncompleteSelectiveCorpusCheck reads selectiveCorpusAuthoritativeStatus exactly, never inferring from evidence presence", () => {
  assert.equal(hasIncompleteSelectiveCorpusCheck({}), false, "no marker at all -> false");
  assert.equal(hasIncompleteSelectiveCorpusCheck({ selectiveCorpusAuthoritativeStatus: "pending" }), false);
  assert.equal(hasIncompleteSelectiveCorpusCheck({ selectiveCorpusAuthoritativeStatus: "completed" }), false);
  assert.equal(hasIncompleteSelectiveCorpusCheck({ selectiveCorpusAuthoritativeStatus: "incomplete" }), true);
});
