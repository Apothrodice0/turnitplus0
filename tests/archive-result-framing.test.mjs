import assert from "node:assert/strict";
import test from "node:test";
import { frameArchiveResult } from "../lib/archive-result-framing.ts";
import { detectLanguage, grams, normalize, tokens } from "../lib/similarity-core.ts";

/**
 * Slice 2E, Phase 6 — the browser worker's risk / quotation / reference-list /
 * repeated-phrase framing is part of the PROTECTED output contract. These
 * tests pin frameArchiveResult against:
 *
 *   1. an inline copy of app/similarity-worker.ts's OLD analyze() tail (the
 *      exact statements that used to live there) — proves the extraction is
 *      byte-identical, so the browser path is unchanged;
 *   2. determinism + every score-band boundary, the archive cutoff, raw score
 *      0, the maximum score, and representative source combinations;
 *   3. browser == server: frameArchiveResult is a pure function of
 *      (text, ArchiveScoringResult, config), so both call sites (the worker
 *      and lib/archive-server-analysis.ts) get identical output for identical
 *      inputs.
 */

const SCORE_BANDS = [
  { label: "Low", minimum: 0, maximum: 5 },
  { label: "Moderate", minimum: 6, maximum: 15 },
  { label: "High", minimum: 16, maximum: 100 },
];
const RISK = { targetThreshold: 15, archiveCutoff: 7, auc: 0.782, precision: 0.4815, recall: 0.7324, sampleSize: 284 };
const CONFIG = { scoreBands: SCORE_BANDS, corpusVersion: "archive-v5-321-48e64e70ec", risk: RISK };

// The exact tail of the pre-2E app/similarity-worker.ts analyze(), reproduced
// here verbatim so a drift in the extracted helper fails this test.
function legacyFraming(text, result, search, risk) {
  const words = tokens(text);
  const triples = grams(words, 3);
  const frequency = triples.reduce((total, gram) => {
    total[gram] = (total[gram] ?? 0) + 1;
    return total;
  }, {});
  const repeats = Object.entries(frequency)
    .filter(([gram, count]) => count >= 3 && !/^(the|and|for|with|that|this|from|into|have|has|was|were)\b/.test(gram))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  const scoreBand = search.scoreBands.find(
    (candidate) => result.score >= candidate.minimum && result.score <= candidate.maximum,
  )?.label ?? "High";
  const completeWordCount = normalize(text).split(" ").filter(Boolean).length;
  const referenceListRatio = Math.max(0, (completeWordCount - result.wordCount) / Math.max(1, completeWordCount));
  const quotedWordCount = [...text.matchAll(/["“«]([\s\S]*?)["”»]/g)]
    .reduce((total, match) => total + tokens(match[1]).length, 0);
  const quotationDensity = quotedWordCount / Math.max(1, completeWordCount);
  const riskStatus = result.score >= risk.archiveCutoff ? "Elevated" : "Lower";
  return {
    wordCount: result.wordCount,
    databaseSize: result.databaseSize,
    excludedDocuments: result.excludedDocuments,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    score: result.score,
    scoreBand,
    riskStatus,
    riskTarget: risk.targetThreshold,
    riskCutoff: risk.archiveCutoff,
    riskCalibration: { auc: risk.auc, precision: risk.precision, recall: risk.recall, sampleSize: risk.sampleSize },
    features: {
      maxSourceContainment: result.maxSourceContainment,
      longestMatchedSpan: result.longestMatchedSpan,
      quotationDensity: Math.round(quotationDensity * 1000) / 1000,
      referenceListRatio: Math.round(referenceListRatio * 1000) / 1000,
      highFrequencyShingleCount: result.highFrequencyShingleCount,
      repeatedThreeGramCount: repeats.length,
      detectedLanguage: detectLanguage(text),
    },
    corpusVersion: search.corpusVersion,
    sources: result.sources.map(({ sourceIndex: _sourceIndex, ...source }) => source),
    repeats,
  };
}

function scoringResult(overrides = {}) {
  return {
    wordCount: 900,
    databaseSize: 320,
    excludedDocuments: 1,
    matchedWordCount: 40,
    archiveMatchedPositions: [10, 11, 12, 13, 40, 41, 42],
    score: 8,
    sources: [
      { sourceIndex: 7, name: "Some Journal Article", type: "Publication", color: "#d7263d", matches: 2, matchedWords: 30, phrases: ["a distinctive shared phrase here"], percent: 3 },
      { sourceIndex: 21, name: "Another Publication", type: "Publication", color: "#d7263d", matches: 1, matchedWords: 10, phrases: ["second distinctive phrase"], percent: 1 },
    ],
    maxSourceContainment: 0.123,
    longestMatchedSpan: 7,
    highFrequencyShingleCount: 4,
    ...overrides,
  };
}

const SAMPLE_TEXT = `An unrelated framing sentence about a wholly different subject precedes this excerpt.
"A short quoted passage inside the document appears here for the quotation density feature."
The distinctive shared phrase here recurs. The distinctive shared phrase here recurs again.
The distinctive shared phrase here recurs a third time. A separate closing remark follows.`;

test("Phase 6: frameArchiveResult reproduces the pre-2E worker framing byte-for-byte", () => {
  for (const score of [0, 1, 5, 6, 7, 8, 15, 16, 50, 100]) {
    const result = scoringResult({ score });
    const framed = frameArchiveResult(SAMPLE_TEXT, result, CONFIG);
    const legacy = legacyFraming(SAMPLE_TEXT, result, { scoreBands: SCORE_BANDS, corpusVersion: CONFIG.corpusVersion }, RISK);
    assert.deepEqual(framed, legacy, `framing drift at score=${score}`);
  }
});

test("Phase 6: score-band boundaries + the archive cutoff", () => {
  const band = (score) => frameArchiveResult(SAMPLE_TEXT, scoringResult({ score }), CONFIG).scoreBand;
  const risk = (score) => frameArchiveResult(SAMPLE_TEXT, scoringResult({ score }), CONFIG).riskStatus;
  assert.equal(band(0), "Low");
  assert.equal(band(5), "Low");
  assert.equal(band(6), "Moderate");
  assert.equal(band(15), "Moderate");
  assert.equal(band(16), "High");
  assert.equal(band(100), "High");
  // cutoff = 7: >= is Elevated
  assert.equal(risk(6), "Lower");
  assert.equal(risk(7), "Elevated");
  assert.equal(risk(8), "Elevated");
});

test("Phase 6: raw score 0 and maximum score 100", () => {
  const zero = frameArchiveResult(SAMPLE_TEXT, scoringResult({ score: 0, matchedWordCount: 0, sources: [], archiveMatchedPositions: [] }), CONFIG);
  assert.equal(zero.score, 0);
  assert.equal(zero.scoreBand, "Low");
  assert.equal(zero.riskStatus, "Lower");
  assert.deepEqual(zero.sources, []);
  const max = frameArchiveResult(SAMPLE_TEXT, scoringResult({ score: 100 }), CONFIG);
  assert.equal(max.scoreBand, "High");
  assert.equal(max.riskStatus, "Elevated");
});

test("Phase 6: sources are passed through with sourceIndex stripped, nothing else", () => {
  const framed = frameArchiveResult(SAMPLE_TEXT, scoringResult(), CONFIG);
  assert.equal(framed.sources.length, 2);
  for (const s of framed.sources) {
    assert.ok(!("sourceIndex" in s), "sourceIndex must be stripped");
    assert.deepEqual(new Set(Object.keys(s)), new Set(["color", "matches", "matchedWords", "name", "percent", "phrases", "type"]));
  }
  assert.equal(framed.sources[0].name, "Some Journal Article");
});

test("Phase 6: deterministic — same inputs, same output", () => {
  const a = frameArchiveResult(SAMPLE_TEXT, scoringResult(), CONFIG);
  const b = frameArchiveResult(SAMPLE_TEXT, scoringResult(), CONFIG);
  assert.deepEqual(a, b);
});

test("Phase 6: browser == server — identical ArchiveScoringResult + config => identical framed result", () => {
  // The worker and lib/archive-server-analysis.ts both call this same pure
  // function; the only way their outputs can differ is different inputs.
  const result = scoringResult({ score: 12 });
  const viaWorkerCallSite = frameArchiveResult(SAMPLE_TEXT, { ...result }, { ...CONFIG });
  const viaServerCallSite = frameArchiveResult(SAMPLE_TEXT, { ...result }, { ...CONFIG });
  assert.deepEqual(viaWorkerCallSite, viaServerCallSite);
  assert.equal(viaWorkerCallSite.scoreBand, "Moderate");
  assert.equal(viaWorkerCallSite.corpusVersion, "archive-v5-321-48e64e70ec");
});

test("Phase 6: quotation density + reference-list ratio + repeated-3-gram count are computed from text", () => {
  const framed = frameArchiveResult(SAMPLE_TEXT, scoringResult({ wordCount: 30 }), CONFIG);
  assert.ok(framed.features.quotationDensity > 0, "the quoted passage should register");
  assert.ok(framed.features.referenceListRatio > 0, "wordCount < completeWordCount => positive ratio");
  assert.equal(framed.features.repeatedThreeGramCount, framed.repeats.length);
  assert.ok(framed.repeats.some(([g]) => g.startsWith("distinctive shared")), "the thrice-repeated phrase is caught");
});
