import assert from "node:assert/strict";
import test from "node:test";
import {
  compactUnifiedSimilarityForPersistence,
  expandUnifiedSimilarityFromPersistence,
  PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
} from "../lib/unified-similarity-persistence.ts";

/**
 * Pre-launch hardening fix — measured 2MB report-transport-ceiling
 * characterization. Direct, focused coverage of the persistence helper
 * itself (compaction eligibility + expansion), isolated from the real
 * server routes/DB (tests/report-transport-size-growth.test.mjs exercises
 * this end to end through the real POST/GET routes). See
 * lib/unified-similarity-persistence.ts's own header comment for the full
 * root-cause account.
 */

function baseResult(overrides = {}) {
  return {
    version: "unified-similarity-v1",
    wordCount: 1000,
    unifiedScore: 42,
    uniqueMatchedWords: 100,
    archiveOnlyWords: 0,
    liveAcademicOnlyWords: 0,
    previousUploadOnlyWords: 100,
    overlapWords: 0,
    selfExcludedWords: 0,
    unknownExcludedWords: 0,
    deviceSelfExcludedWords: 0,
    userSuppliedReferenceOnlyWords: 0,
    selectiveCorpusOnlyWords: 0,
    contributions: [{ sourceType: "previous_upload", sourceId: "repr-1", submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100, evidenceStatus: "included" }],
    matchedPositions: [],
    previousUploadPositions: [],
    userSuppliedReferencePositions: [],
    selectiveCorpusPositions: [],
    ...overrides,
  };
}

function largeSortedArray(length) {
  return Array.from({ length }, (_, i) => i * 3 + 1);
}

test("1. large identical arrays -> compacts", () => {
  const positions = largeSortedArray(5000);
  const result = baseResult({ matchedPositions: positions, previousUploadPositions: [...positions] });
  const compacted = compactUnifiedSimilarityForPersistence(result);
  assert.equal(compacted.previousUploadPositionsEncoding, PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS);
  assert.equal("previousUploadPositions" in compacted, false, "the duplicate array must be OMITTED, not merely nulled");
  assert.deepEqual(compacted.matchedPositions, positions, "matchedPositions itself is never altered");
  const compactedBytes = Buffer.byteLength(JSON.stringify(compacted), "utf8");
  const expandedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(compactedBytes < expandedBytes, `compaction must actually shrink the payload (${compactedBytes} vs ${expandedBytes})`);
});

test("2. different arrays -> does NOT compact", () => {
  const matchedPositions = largeSortedArray(500);
  const previousUploadPositions = largeSortedArray(500).map((p) => p + 1); // every value shifted -- genuinely different
  const result = baseResult({ matchedPositions, previousUploadPositions });
  const compacted = compactUnifiedSimilarityForPersistence(result);
  assert.equal(compacted.previousUploadPositionsEncoding, undefined);
  assert.deepEqual(compacted.previousUploadPositions, previousUploadPositions, "the real, distinct array must be persisted unchanged");
});

test("3. proper subset -> does NOT compact", () => {
  const matchedPositions = largeSortedArray(500);
  const previousUploadPositions = matchedPositions.slice(0, 400); // a genuine, real-world exclusive-subset shape
  const result = baseResult({ matchedPositions, previousUploadPositions });
  const compacted = compactUnifiedSimilarityForPersistence(result);
  assert.equal(compacted.previousUploadPositionsEncoding, undefined, "a proper subset is NOT the same value as matchedPositions -- must never be compacted (this is the ordinary, common case)");
  assert.deepEqual(compacted.previousUploadPositions, previousUploadPositions);
});

test("4. same values but different ordering -> does NOT compact", () => {
  const matchedPositions = [1, 5, 9, 20, 33];
  const previousUploadPositions = [33, 20, 9, 5, 1]; // same SET, deliberately reversed order
  const result = baseResult({ matchedPositions, previousUploadPositions });
  const compacted = compactUnifiedSimilarityForPersistence(result);
  assert.equal(compacted.previousUploadPositionsEncoding, undefined, "ordered (not merely set) equality is required -- computeUnifiedSimilarity always emits sorted-ascending arrays, so a differently-ordered array is never a legitimate compaction target");
  assert.deepEqual(compacted.previousUploadPositions, previousUploadPositions, "the out-of-order array must be persisted exactly as given, never silently reordered");
});

test("5. empty arrays -> compaction is skipped because the marker would be LARGER than the array it replaces", () => {
  const result = baseResult({ matchedPositions: [], previousUploadPositions: [] });
  const compacted = compactUnifiedSimilarityForPersistence(result);
  assert.equal(compacted.previousUploadPositionsEncoding, undefined, "an empty array must retain its expanded representation -- the marker string costs more bytes than []");
  assert.deepEqual(compacted.previousUploadPositions, []);
  const compactedBytes = Buffer.byteLength(JSON.stringify({ previousUploadPositions: [] }), "utf8");
  const markerBytes = Buffer.byteLength(JSON.stringify({ previousUploadPositionsEncoding: PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS }), "utf8");
  assert.ok(markerBytes > compactedBytes, "sanity: the marker really is larger than an empty array, confirming why compaction correctly declines here");
});

test("6. compact -> expand round trip produces exact original runtime semantics", () => {
  const positions = largeSortedArray(2000);
  const original = baseResult({ matchedPositions: positions, previousUploadPositions: [...positions] });
  const compacted = compactUnifiedSimilarityForPersistence(original);
  const roundTripped = expandUnifiedSimilarityFromPersistence(compacted);
  assert.deepEqual(roundTripped.matchedPositions, original.matchedPositions);
  assert.deepEqual(roundTripped.previousUploadPositions, original.previousUploadPositions);
  assert.equal(roundTripped.previousUploadPositionsEncoding, undefined, "the marker must never leak into the expanded runtime shape");
  // every OTHER field must be byte-for-byte untouched by the round trip
  const { matchedPositions: _mp, previousUploadPositions: _pup, ...restOriginal } = original;
  const { matchedPositions: _mp2, previousUploadPositions: _pup2, ...restRoundTripped } = roundTripped;
  assert.deepEqual(restRoundTripped, restOriginal, "unifiedScore/uniqueMatchedWords/contributions/every sibling field must be identical");
});

test("7. old expanded report (no marker, real array already present) -> expansion is a true no-op", () => {
  const matchedPositions = [2, 4, 6];
  const previousUploadPositions = [2, 4]; // a genuine, real, pre-existing partial array -- exactly what every historical row already has
  const legacy = baseResult({ matchedPositions, previousUploadPositions });
  const expanded = expandUnifiedSimilarityFromPersistence(legacy);
  assert.deepEqual(expanded, legacy, "a row that already has the full expanded shape and no marker must pass through completely unchanged");
});

test("8. malformed marker without valid matchedPositions -> fails closed, no crash, no invented evidence", () => {
  const malformed = baseResult({
    matchedPositions: "not-an-array", // corrupt/malformed persisted data
    previousUploadPositionsEncoding: PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
  });
  delete malformed.previousUploadPositions; // simulates the real compact-on-disk shape (omitted)
  assert.doesNotThrow(() => expandUnifiedSimilarityFromPersistence(malformed));
  const expanded = expandUnifiedSimilarityFromPersistence(malformed);
  assert.deepEqual(expanded.previousUploadPositions, [], "malformed matchedPositions must reconstruct to an empty array -- the same absence-tolerant convention every existing accessor already uses -- never a guess/invented array");
  assert.equal(expanded.previousUploadPositionsEncoding, undefined, "the marker must still be stripped from the runtime shape even on the fail-closed path");
});

test("9. the compact marker never appears in the expanded/customer-runtime shape, for either the compacted or already-legacy case", () => {
  const positions = largeSortedArray(200);
  const compacted = compactUnifiedSimilarityForPersistence(baseResult({ matchedPositions: positions, previousUploadPositions: [...positions] }));
  assert.equal(compacted.previousUploadPositionsEncoding, PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS, "sanity: this fixture must actually compact first");
  const expandedFromCompact = expandUnifiedSimilarityFromPersistence(compacted);
  assert.equal("previousUploadPositionsEncoding" in expandedFromCompact, false);

  const legacy = baseResult({ matchedPositions: positions, previousUploadPositions: [10, 20] });
  const expandedFromLegacy = expandUnifiedSimilarityFromPersistence(legacy);
  assert.equal("previousUploadPositionsEncoding" in expandedFromLegacy, false);
});

test("compactUnifiedSimilarityForPersistence never mutates its input", () => {
  const positions = largeSortedArray(200);
  const original = baseResult({ matchedPositions: positions, previousUploadPositions: [...positions] });
  const snapshot = JSON.parse(JSON.stringify(original));
  compactUnifiedSimilarityForPersistence(original);
  assert.deepEqual(original, snapshot, "the input object must never be mutated in place");
});

test("expandUnifiedSimilarityFromPersistence never mutates its input", () => {
  const positions = largeSortedArray(200);
  const compacted = compactUnifiedSimilarityForPersistence(baseResult({ matchedPositions: positions, previousUploadPositions: [...positions] }));
  const snapshot = JSON.parse(JSON.stringify(compacted));
  expandUnifiedSimilarityFromPersistence(compacted);
  assert.deepEqual(compacted, snapshot, "the input object must never be mutated in place");
});
