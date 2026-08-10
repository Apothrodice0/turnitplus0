import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOpenAlexSignal } from "../tools/openalex-signal.ts";

function document(id) {
  return {
    id,
    roles: ["similarity-calibration"],
    text: "sample text",
    provenance: { sha256: `${id}-hash` },
  };
}

function observation(id, phrasesMatched, outcomes = null) {
  const phraseCount = 20;
  const resolvedOutcomes = outcomes ?? {
    matched: phrasesMatched,
    "no-match": phraseCount - phrasesMatched,
    throttled: 0,
    "timed-out": 0,
    failed: 0,
  };
  return {
    id,
    textSha256: `${id}-hash`,
    checkedAt: "2026-08-08T00:00:00.000Z",
    queryMethod: "openalex-fulltext-search-exact-v1",
    result: {
      status: "complete",
      provider: "OpenAlex",
      phrasesSampled: phraseCount,
      phrasesMatched,
      matches: Array.from({ length: phraseCount }, (_, index) => ({
        phrase: `phrase ${index}`,
        normalizedPhrase: `phrase ${index}`,
        sampleIndex: index + 1,
        wordStart: index * 100,
        wordEnd: index * 100 + 9,
        outcome: index < phrasesMatched ? "matched" : "no-match",
        matched: index < phrasesMatched,
        sources: [],
      })),
      checkedAt: "2026-08-08T00:00:00.000Z",
      errorCount: 0,
      outcomes: resolvedOutcomes,
    },
  };
}

test("records the 60-document OpenAlex match distribution beside Wikipedia evidence", () => {
  const documents = Array.from({ length: 60 }, (_, index) => document(`doc-${index}`));
  const observations = documents.map((row, index) => observation(row.id, index % 3));
  const result = summarizeOpenAlexSignal(documents, observations);
  assert.equal(result.collectionStatus, "complete");
  assert.equal(result.sampleSize, 60);
  assert.equal(result.requestCount, 1_200);
  assert.deepEqual(result.matchDistribution.histogram, { 0: 20, 1: 20, 2: 20 });
  assert.equal(result.outcomeTotals.matched, 60);
  assert.equal(result.outcomeTotals["no-match"], 1_140);
  assert.equal(result.concentration.documentsWithMatches, 40);
  assert.equal(result.concentration.maximumMatchesInOneDocument, 2);
  assert.equal(result.concentration.topThreeMatchShare, 0.1);
  assert.equal(result.phrasePositionDistribution.sampleIndexHistogram["1"], 40);
  assert.equal(result.phrasePositionDistribution.sampleIndexHistogram["2"], 20);
  assert.deepEqual(result.phrasePositionDistribution.thirds, { early: 60, middle: 0, late: 0 });
});

test("refuses to summarize throttling as a zero-match observation", () => {
  const documents = [document("doc-1")];
  const bad = observation("doc-1", 0, {
    matched: 0,
    "no-match": 19,
    throttled: 1,
    "timed-out": 0,
    failed: 0,
  });
  bad.result.status = "partial";
  bad.result.errorCount = 1;
  assert.throws(
    () => summarizeOpenAlexSignal(documents, [bad]),
    /Incomplete OpenAlex observation/,
  );
});
