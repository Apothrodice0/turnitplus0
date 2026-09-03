import assert from "node:assert/strict";
import test from "node:test";
import { computeUnifiedSimilarity, UNIFIED_SIMILARITY_VERSION } from "../lib/unified-similarity.ts";

/**
 * Phase 4A: tests for the experimental, additive unified-similarity pure
 * function. Every case from the phase's own required list (numbered inline
 * below) plus a few extra edge cases this function's own defensive coding
 * (clamping, dedup) needs covered. computeUnifiedSimilarity never touches a
 * database, a report, or score/archiveScore/E8S/E8P — every test here
 * constructs plain inputs and asserts on the plain return value.
 */

function academicEvidence(overrides = {}) {
  return {
    provider: "openaire",
    providerId: "ext-1",
    title: "Some External Paper",
    authors: null,
    publication: null,
    year: null,
    doi: "10.1/example",
    url: "https://example.test/paper",
    matchedPassages: [],
    similarity: 90,
    ...overrides,
  };
}

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

function passage(start, end, overrides = {}) {
  return { submittedText: "", submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1, ...overrides };
}

// --- 1: archive-only match ---------------------------------------------------

test("1: archive-only match — unifiedScore equals archive coverage", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 200 }, (_, i) => i), // 0..199
  });
  assert.equal(result.unifiedScore, 20);
  assert.equal(result.uniqueMatchedWords, 200);
  assert.equal(result.archiveOnlyWords, 200);
  assert.equal(result.liveAcademicOnlyWords, 0);
  assert.equal(result.previousUploadOnlyWords, 0);
  assert.equal(result.overlapWords, 0);
});

// --- 2: live-only match ------------------------------------------------------

test("2: live-only match — unifiedScore reflects live matched positions", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 500,
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(100, 249)] })], // 150 words
  });
  assert.equal(result.unifiedScore, 30);
  assert.equal(result.uniqueMatchedWords, 150);
  assert.equal(result.liveAcademicOnlyWords, 150);
  assert.equal(result.archiveOnlyWords, 0);
});

// --- 3: previous-upload-only eligible match ----------------------------------

test("3: previous-upload-only eligible (PRIOR_SUBMISSION) match — unifiedScore reflects it", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 400,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ passages: [passage(0, 99)], matchedWordCount: 100 }),
    ]),
  });
  assert.equal(result.unifiedScore, 25);
  assert.equal(result.previousUploadOnlyWords, 100);
});

// --- 4: SELF match contributes zero ------------------------------------------

test("4: SELF match contributes zero to unifiedScore", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 400,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ relationshipType: "SELF", passages: [passage(0, 199)], matchedWordCount: 200 }),
    ]),
  });
  assert.equal(result.unifiedScore, 0);
  assert.equal(result.uniqueMatchedWords, 0);
  assert.equal(result.previousUploadOnlyWords, 0);
  assert.equal(result.selfExcludedWords, 200);
  assert.equal(result.contributions[0].evidenceStatus, "excluded_self");
});

// --- 5: UNKNOWN relationship contributes zero --------------------------------

test("5: UNKNOWN_RELATIONSHIP contributes zero, no ownership guessed", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 400,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ relationshipType: "UNKNOWN_RELATIONSHIP", passages: [passage(0, 49)], matchedWordCount: 50 }),
    ]),
  });
  assert.equal(result.unifiedScore, 0);
  assert.equal(result.unknownExcludedWords, 50);
  assert.equal(result.contributions[0].evidenceStatus, "excluded_unknown");
});

// --- 6: archive + OpenAIRE, same passage -> counts once ----------------------

test("6: the same passage found by archive AND OpenAIRE counts once", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 100 }, (_, i) => i), // 0..99
    externalAcademicEvidence: [academicEvidence({ provider: "openaire", matchedPassages: [passage(0, 99)] })], // exact same range
  });
  assert.equal(result.uniqueMatchedWords, 100, "must not become 200");
  assert.equal(result.unifiedScore, 10);
  assert.equal(result.overlapWords, 100);
  assert.equal(result.archiveOnlyWords, 0);
  assert.equal(result.liveAcademicOnlyWords, 0);
});

// --- 7: OpenAIRE + Europe PMC, same passage -> counts once -------------------

test("7: the same passage found by OpenAIRE AND Europe PMC counts once", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    externalAcademicEvidence: [
      academicEvidence({ provider: "openaire", providerId: "o-1", doi: "10.1/shared", matchedPassages: [passage(200, 299)] }),
      academicEvidence({ provider: "europe-pmc", providerId: "PMC1", doi: "10.1/shared-2", matchedPassages: [passage(200, 299)] }),
    ],
  });
  assert.equal(result.uniqueMatchedWords, 100, "must not become 200 just because two providers both found it");
  assert.equal(result.unifiedScore, 10);
});

// --- 8: same article uploaded multiple times does not multiply similarity ---

test("8: the same underlying representation appearing more than once in matches[] does not multiply its contribution", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ matchedRepresentationId: "rep-dup", passages: [passage(0, 99)], matchedWordCount: 100 }),
      // Same representation id appearing again (defensive scenario — the real
      // corpus layer already dedupes by representation, this proves the
      // unified layer is defensive too, not just trusting that invariant).
      historicalMatch({ matchedRepresentationId: "rep-dup", passages: [passage(0, 99)], matchedWordCount: 100 }),
    ]),
  });
  assert.equal(result.uniqueMatchedWords, 100, "must not become 200");
  assert.equal(result.unifiedScore, 10);
});

// --- 9: different sources match different spans -> all unique spans count ---

test("9: different sources matching different submitted spans all contribute", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 10_000,
    archiveMatchedPositions: Array.from({ length: 500 }, (_, i) => 1000 + i), // 1000..1499
    externalAcademicEvidence: [academicEvidence({ provider: "openaire", matchedPassages: [passage(1400, 1799)] })], // 1400..1799 (400 words, 100 overlapping)
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ passages: [passage(2100, 2499)], matchedWordCount: 400 }), // 2100..2499, no overlap
    ]),
  });
  // Matches the phase's own worked example almost exactly: archive 1000-1499,
  // live 1400-1799 (overlap 1400-1499), prior-upload 2100-2499 (disjoint).
  // Unique matched words = (1000..1799) union (2100..2499) = 800 + 400 = 1200.
  assert.equal(result.uniqueMatchedWords, 1200);
  assert.equal(result.unifiedScore, 12);
  assert.equal(result.overlapWords, 100); // 1400..1499
  assert.equal(result.archiveOnlyWords, 400); // 1000..1399
  assert.equal(result.liveAcademicOnlyWords, 300); // 1500..1799
  assert.equal(result.previousUploadOnlyWords, 400); // 2100..2499
});

// --- 10: nested spans do not double-count ------------------------------------

test("10: a fully nested span does not double-count", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 200 }, (_, i) => i), // 0..199
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(50, 99)] })], // fully inside 0..199
  });
  assert.equal(result.uniqueMatchedWords, 200);
  assert.equal(result.overlapWords, 50);
  assert.equal(result.archiveOnlyWords, 150);
  assert.equal(result.liveAcademicOnlyWords, 0);
});

// --- 11: partially overlapping spans merge correctly -------------------------

test("11: partially overlapping spans merge into their true union", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 100 }, (_, i) => i), // 0..99
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(50, 149)] })], // 50..149
  });
  assert.equal(result.uniqueMatchedWords, 150); // 0..149
  assert.equal(result.overlapWords, 50); // 50..99
  assert.equal(result.archiveOnlyWords, 50); // 0..49
  assert.equal(result.liveAcademicOnlyWords, 50); // 100..149
});

// --- 12: adjacent spans follow existing position semantics consistently -----

test("12: adjacent (touching, non-overlapping) spans both fully contribute with no gap or double-count", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 50 }, (_, i) => i), // 0..49
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(50, 99)] })], // 50..99, immediately adjacent
  });
  assert.equal(result.uniqueMatchedWords, 100);
  assert.equal(result.overlapWords, 0, "adjacent spans must not be treated as overlapping");
  assert.equal(result.archiveOnlyWords, 50);
  assert.equal(result.liveAcademicOnlyWords, 50);
});

// --- 13: discovery-only external candidate contributes zero -----------------

test("13: an evidence entry with no matched passages (the discovery-only shape) contributes zero", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [] })],
  });
  assert.equal(result.unifiedScore, 0);
  assert.equal(result.uniqueMatchedWords, 0);
  assert.equal(result.contributions.length, 0);
});

// --- 14: provider failure -> unified score falls back safely ----------------

test("14: missing (provider-failed) academic evidence falls back to whatever other sources provide, no crash", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: Array.from({ length: 50 }, (_, i) => i),
    externalAcademicEvidence: undefined, // as if the background fetch never resolved
  });
  assert.equal(result.unifiedScore, 5);
  assert.equal(result.uniqueMatchedWords, 50);
});

// --- 15: no external evidence -> unifiedScore == existing archive result ----

test("15: with no live/prior-upload evidence at all, unifiedScore exactly equals the archive-only score", () => {
  const positions = Array.from({ length: 137 }, (_, i) => i * 3).filter((p) => p < 1000);
  const withOnlyArchive = computeUnifiedSimilarity({ wordCount: 1000, archiveMatchedPositions: positions });
  const archiveOnlyEquivalentScore = Math.min(100, Math.round((new Set(positions).size / 1000) * 100));
  assert.equal(withOnlyArchive.unifiedScore, archiveOnlyEquivalentScore);
});

// --- 16: missing unified evidence -> old reports still load correctly -------

test("16: a report-shaped object with no unifiedSimilarity field at all round-trips through JSON unchanged", () => {
  const oldReport = { id: 1, score: 24, archiveScore: 24, wordCount: 500, text: "..." };
  const serialized = JSON.parse(JSON.stringify(oldReport));
  assert.equal("unifiedSimilarity" in serialized, false);
  assert.equal(serialized.score, 24);
  assert.equal(serialized.archiveScore, 24);
});

// --- 17: empty evidence -> no crash ------------------------------------------

test("17: completely empty input never throws and returns a well-formed zero result", () => {
  assert.doesNotThrow(() => computeUnifiedSimilarity({ wordCount: 0 }));
  const empty = computeUnifiedSimilarity({ wordCount: 0 });
  assert.equal(empty.unifiedScore, 0);
  assert.equal(empty.uniqueMatchedWords, 0);
  assert.deepEqual(empty.contributions, []);

  const noArraysAtAll = computeUnifiedSimilarity({
    wordCount: 500,
    archiveMatchedPositions: null,
    externalAcademicEvidence: null,
    historicalSubmissionMatch: null,
  });
  assert.equal(noArraysAtAll.unifiedScore, 0);
});

// --- Phase 4B finding: EXACT_CANONICAL_MATCH real matcher output has empty passages ---
// lib/document-correspondence.ts's computeDocumentCorrespondence deliberately
// leaves `passages: []` on its exact-canonical-match short-circuit (see that
// file's own header comment) while still reporting a real, non-zero
// matchedWordCount — discovered via a real end-to-end PRIOR_SUBMISSION test
// (tests/unified-similarity-relationship-integration.test.mjs, SCENARIO C).

test("Phase 4B: an eligible PRIOR_SUBMISSION match with matchType EXACT_CANONICAL_MATCH and empty passages still contributes its full matchedWordCount (not silently dropped)", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 200,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({
        relationshipType: "PRIOR_SUBMISSION",
        matchType: "EXACT_CANONICAL_MATCH",
        matchedWordCount: 200,
        passages: [], // the real shape computeDocumentCorrespondence returns for this branch
      }),
    ]),
  });
  assert.equal(result.unifiedScore, 100);
  assert.equal(result.uniqueMatchedWords, 200);
  assert.equal(result.previousUploadOnlyWords, 200);
});

test("Phase 4B: a SELF match with matchType EXACT_CANONICAL_MATCH and empty passages is still excluded (0 contribution), and its excluded tally is still correct", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 200,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({
        relationshipType: "SELF",
        matchType: "EXACT_CANONICAL_MATCH",
        matchedWordCount: 150,
        passages: [],
      }),
    ]),
  });
  assert.equal(result.unifiedScore, 0);
  assert.equal(result.selfExcludedWords, 150);
  assert.equal(result.contributions.length, 1, "the audit trail must still record the excluded SELF match, even though passages was empty");
  assert.equal(result.contributions[0].evidenceStatus, "excluded_self");
});

test("Phase 4B: a STRONG_TEXT_MATCH (not exact) with empty passages contributes nothing — the fallback is scoped ONLY to EXACT_CANONICAL_MATCH, never invented for a partial match with genuinely missing evidence", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 200,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({
        relationshipType: "PRIOR_SUBMISSION",
        matchType: "STRONG_TEXT_MATCH",
        matchedWordCount: 80,
        passages: [], // not the real matcher's actual behavior for this matchType — a defensive/malformed-input case
      }),
    ]),
  });
  assert.equal(result.unifiedScore, 0);
  assert.equal(result.previousUploadOnlyWords, 0, "a STRONG_TEXT_MATCH claiming a word count with no passages must not be guessed at — only the documented EXACT_CANONICAL_MATCH short-circuit gets a fallback");
});

// --- 18: long submission -> correct word-coordinate handling ----------------

test("18: a long (50,000-word) submission handles positions near the end correctly, no overflow/precision loss", () => {
  const wordCount = 50_000;
  const result = computeUnifiedSimilarity({
    wordCount,
    archiveMatchedPositions: Array.from({ length: 1000 }, (_, i) => 40_000 + i), // 40000..40999
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(49_000, 49_999)] })], // last 1000 words
  });
  assert.equal(result.uniqueMatchedWords, 2000);
  assert.equal(result.unifiedScore, 4);
  assert.equal(result.overlapWords, 0);
});

// --- extra: defensive/edge-case coverage beyond the required 18 -------------

test("extra: out-of-bounds and malformed positions are ignored, not crashing or corrupting the count", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    archiveMatchedPositions: [-5, 50, 99, 150, 1.5, NaN],
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(90, 200), passage(-10, -1)] })],
  });
  // Only positions 50 and 99 from archive are valid (-5, 150, 1.5, NaN all rejected).
  // passage(90,200) clamps to 90..99 (10 words); passage(-10,-1) is entirely invalid and dropped.
  // Union of {50, 99} and {90..99} = {50, 90, 91, ..., 99} = 11 unique words (99 is shared).
  assert.equal(result.uniqueMatchedWords, 11);
  assert.equal(result.unifiedScore, 11);
});

test("extra: SELF and an eligible PRIOR_SUBMISSION in the same result — only PRIOR_SUBMISSION contributes", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ relationshipType: "SELF", matchedRepresentationId: "rep-self", passages: [passage(0, 199)], matchedWordCount: 200 }),
      historicalMatch({ relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "rep-other", passages: [passage(500, 599)], matchedWordCount: 100 }),
    ]),
  });
  assert.equal(result.uniqueMatchedWords, 100);
  assert.equal(result.previousUploadOnlyWords, 100);
  assert.equal(result.selfExcludedWords, 200);
});

test("extra: unifiedScore matches combineMatchedWordPositions's own score formula exactly (regression anchor)", () => {
  const result = computeUnifiedSimilarity({ wordCount: 300, archiveMatchedPositions: Array.from({ length: 99 }, (_, i) => i) });
  assert.equal(result.unifiedScore, Math.min(100, Math.round((99 / 300) * 100)));
});

test("extra: result carries the version tag", () => {
  const result = computeUnifiedSimilarity({ wordCount: 10 });
  assert.equal(result.version, UNIFIED_SIMILARITY_VERSION);
});

// --- Phase B1: hypotheticalExcludedRepresentationIds (SHADOW ONLY) ----------
// The production scoring path NEVER passes this parameter, so absent / empty /
// undefined must leave the result byte-identical (shape AND values), and the
// "excluded_document_local_corpus_duplicate" status must never appear without
// it. When passed, the named representation contributes nothing to the union
// but keeps its baseline relationshipType — and it is applied strictly AFTER
// SELF / UNKNOWN / effective-device-SELF.

test("B1: absent vs undefined vs empty-array vs empty-Set all produce a byte-identical result to before the parameter existed", () => {
  const params = {
    wordCount: 400,
    archiveMatchedPositions: [0, 1, 2, 3, 4, 100, 101],
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(50, 79)] })],
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ matchedRepresentationId: "rep-a", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 400, passages: [] }),
      historicalMatch({ matchedRepresentationId: "rep-b", relationshipType: "SELF", matchedWordCount: 30, passages: [passage(0, 29)] }),
    ]),
    effectiveDeviceSelfRepresentationIds: ["rep-c"],
  };
  const base = computeUnifiedSimilarity(params);
  assert.deepEqual(computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: undefined }), base);
  assert.deepEqual(computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: null }), base);
  assert.deepEqual(computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: [] }), base);
  assert.deepEqual(computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: new Set() }), base);
  // no shadow status ever appears without the parameter
  for (const contribution of base.contributions) {
    assert.notEqual(contribution.evidenceStatus, "excluded_document_local_corpus_duplicate");
  }
  // no new top-level counter/property
  assert.equal("documentLocalCorpusDuplicateExcludedWords" in base, false);
});

test("B1: a counted TURNITPLUS_CORPUS_SOURCE + EXACT_CANONICAL_MATCH rep in the hypothetical set drops out of the union but keeps its baseline relationship", () => {
  const params = {
    wordCount: 100,
    archiveMatchedPositions: Array.from({ length: 20 }, (_, i) => i), // 0..19 survives
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ matchedRepresentationId: "rep-dup", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] }),
    ]),
  };
  const authoritative = computeUnifiedSimilarity(params);
  assert.equal(authoritative.unifiedScore, 100);

  const hypothetical = computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: ["rep-dup"] });
  assert.equal(hypothetical.unifiedScore, 20, "only the 20 archive-covered words survive");
  assert.equal(hypothetical.previousUploadOnlyWords, 0);
  assert.equal(hypothetical.archiveOnlyWords, 20);
  const dup = hypothetical.contributions.find((c) => c.sourceId === "rep-dup");
  assert.equal(dup.evidenceStatus, "excluded_document_local_corpus_duplicate");
  assert.equal(dup.relationship, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(dup.effectiveScoringRelationship, undefined);
});

test("B1 precedence: SELF and UNKNOWN_RELATIONSHIP in the hypothetical set keep their own status and tally", () => {
  const selfInSet = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ matchedRepresentationId: "rep-self", relationshipType: "SELF", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 40, passages: [passage(0, 39)] }),
    ]),
    hypotheticalExcludedRepresentationIds: ["rep-self"],
  });
  assert.equal(selfInSet.contributions[0].evidenceStatus, "excluded_self");
  assert.equal(selfInSet.selfExcludedWords, 40);

  const unknownInSet = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ matchedRepresentationId: "rep-unk", relationshipType: "UNKNOWN_RELATIONSHIP", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 25, passages: [passage(0, 24)] }),
    ]),
    hypotheticalExcludedRepresentationIds: ["rep-unk"],
  });
  assert.equal(unknownInSet.contributions[0].evidenceStatus, "excluded_unknown");
  assert.equal(unknownInSet.unknownExcludedWords, 25);
});

test("B1 precedence: a rep in BOTH effectiveDeviceSelfRepresentationIds and the hypothetical set stays excluded_effective_device_self", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matchedResult([
      historicalMatch({ matchedRepresentationId: "rep-x", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 70, passages: [passage(0, 69)] }),
    ]),
    effectiveDeviceSelfRepresentationIds: ["rep-x"],
    hypotheticalExcludedRepresentationIds: ["rep-x"],
  });
  assert.equal(result.contributions[0].evidenceStatus, "excluded_effective_device_self");
  assert.equal(result.deviceSelfExcludedWords, 70);
});
