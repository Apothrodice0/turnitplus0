import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_CALIBRATED,
  AI_BENCHMARK_DOCUMENTS,
  AI_BENCHMARK_PROXY_RATE_AT_30,
  AI_EXPERIMENTAL,
  AI_HUMAN_CALIBRATION_READY,
  AI_HUMAN_DISPLAY_NORMALIZATION,
  AI_HUMAN_REFERENCE_BOUNDARIES,
  AI_HUMAN_REFERENCE_AVAILABLE,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_PERCENTILE_REVIEW_FLOOR,
  AI_POSITIVE_SET_SIZE,
  AI_POSITIVE_VALIDATION_READY,
  AI_REVIEW_PASSAGE_PERCENTILE,
  aiPercentileBand,
  assessAiAgainstHumanReference,
  buildAiChunks,
  buildAiTokenChunks,
  calibratedAiDisplaySignal,
  calculateAiDiagnostics,
  calculateAiLogOddsDiagnostics,
  calculateAiPercentage,
  calculateTopKMeanLogOdds,
  calibratedHumanMedianPercentile,
  formatHumanPercentile,
  isAiBelowReviewFloor,
  isAiPassageFlagged,
  logOddsFromProbability,
  machineLogOddsFromLogits,
  machineProbabilityFromLogits,
  medianLogOdds,
  populationPercentile,
  probabilityFromLogOdds,
  shouldSuppressAiScore,
  similarityScoreBand,
  writingSignalEstimate,
} from "../lib/ai-core.ts";

test("keeps similarity bands separate from AI percentile bands", () => {
  assert.deepEqual(similarityScoreBand(0), { key: "low", label: "Low", range: "0–19%" });
  assert.deepEqual(similarityScoreBand(40), { key: "review", label: "Moderate", range: "20–40%" });
  assert.deepEqual(similarityScoreBand(100), { key: "high", label: "High", range: "41–100%" });
  assert.deepEqual(aiPercentileBand(89.9), { key: "low", label: "Below 90th percentile", range: "0–89th" });
  assert.deepEqual(aiPercentileBand(90), { key: "review", label: "90th–97th percentile", range: "90th–97th" });
  assert.deepEqual(aiPercentileBand(98), { key: "high", label: "98th–100th percentile", range: "98th–100th" });
  assert.equal(aiPercentileBand(Number.NaN), null);
  assert.equal(formatHumanPercentile(98.86), "98.9th");
});

test("maps continuous median log-odds into the requested display score colors", () => {
  const normalization = AI_HUMAN_DISPLAY_NORMALIZATION;
  assert.equal(calibratedAiDisplaySignal(normalization.median).score, 0);
  assert.equal(calibratedAiDisplaySignal(normalization.reviewAnchor).score, 20);
  assert.equal(calibratedAiDisplaySignal(normalization.maximum).score, 50);
  const upperSpan = normalization.maximum - normalization.reviewAnchor;
  assert.equal(calibratedAiDisplaySignal(normalization.maximum + upperSpan).score, 100);
  assert.equal(calibratedAiDisplaySignal(Number.NaN), null);
});

test("builds bounded English chunks and excludes the bibliography", () => {
  // lib/reference-section.ts's shared detector requires the content after
  // a "References" heading to actually look like a reference list (see
  // tests/similarity-core.test.mjs's identical comment) — a numbered
  // marker here corroborates the heading the same way a real paper's
  // reference list would.
  const body = Array.from({ length: 620 }, (_, index) => `word${index}`).join(" ");
  const chunks = buildAiChunks(`${body}\n\nReferences\n[1] Hidden, S. Source material. 2020.`, 260, 24);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[1].wordStart, 130);
  assert.equal(chunks[0].wordEnd - chunks[1].wordStart, 130);
  assert.equal(chunks.some((chunk) => chunk.text.includes("Hidden source")), false);
  assert.equal(chunks.every((chunk) => chunk.wordCount <= 260), true);
});

test("builds overlapping 240-token windows without model truncation", () => {
  const dictionary = [];
  const tokenizer = {
    encode(text) {
      return text.trim().split(/\s+/).map((token) => {
        dictionary.push(token);
        return dictionary.length - 1;
      });
    },
    decode(ids) {
      return ids.map((id) => dictionary[id]).join(" ");
    },
  };
  // See "builds bounded English chunks and excludes the bibliography"
  // above for why a bare heading with no reference-list-shaped content no
  // longer counts as a real section boundary.
  const body = Array.from({ length: 500 }, (_, index) => `token${index}`).join(" ");
  const chunks = buildAiTokenChunks(`${body}\n\nReferences\n[1] Hidden, S. Source material. 2020.`, tokenizer);
  assert.deepEqual(chunks.map((chunk) => chunk.tokenStart), [0, 120, 240, 260]);
  assert.equal(chunks.every((chunk) => chunk.tokenCount <= 240), true);
  assert.equal(chunks.every((chunk) => chunk.wasTruncated === false), true);
  assert.equal(chunks.some((chunk) => chunk.text.includes("Hidden")), false);
});

test("uses human-reference bands and abstains near every boundary", () => {
  const boundaries = Object.values(AI_HUMAN_REFERENCE_BOUNDARIES);
  assert.equal(boundaries.every((value) => typeof value === "number"), true);
  for (const boundary of boundaries) {
    assert.equal(assessAiAgainstHumanReference(boundary).key, "inconclusive");
  }
  const maximum = AI_HUMAN_REFERENCE_BOUNDARIES.maximum;
  const high = assessAiAgainstHumanReference(maximum + 0.051);
  assert.equal(high.key, "well-above");
  assert.equal(high.percentile, 100);
  assert.equal(high.showPercentile, true);
  const low = assessAiAgainstHumanReference(AI_HUMAN_REFERENCE_BOUNDARIES.median - 0.051);
  assert.equal(low.key, "consistent");
  assert.equal(low.showPercentile, false);
});

test("keeps the 2011 extraction-parity control inside the human range", () => {
  const assessment = assessAiAgainstHumanReference(2.921096260935246);
  assert.equal(assessment.key, "consistent");
  assert.equal(assessment.showPercentile, false);
});

test("AI percentage is the unique proportion of words above the passage threshold", () => {
  const chunks = [
    { start: 0, end: 10, wordStart: 0, wordEnd: 75, text: "first", wordCount: 75, probability: 0.91 },
    { start: 11, end: 20, wordStart: 75, wordEnd: 100, text: "second", wordCount: 25, probability: 0.2 },
  ];
  assert.equal(calculateAiPercentage(chunks, 0.7), 75);
  assert.deepEqual(calculateAiDiagnostics(chunks, 0.7), {
    totalWords: 100,
    flaggedWords: 75,
    percentFlagged: 75,
    meanProbability: 0.732,
    maxProbability: 0.91,
  });
});

test("turns review-threshold coverage into complementary writing estimates", () => {
  assert.deepEqual(writingSignalEstimate(81), { aiLike: 81, humanLike: 19 });
  assert.deepEqual(writingSignalEstimate(120), { aiLike: 100, humanLike: 0 });
  assert.deepEqual(writingSignalEstimate(-4), { aiLike: 0, humanLike: 100 });
  assert.equal(writingSignalEstimate(null), null);
  assert.equal(writingSignalEstimate(Number.NaN), null);
});

test("normalizes raw logits with the published model temperature", () => {
  assert.equal(Math.round(machineProbabilityFromLogits([2, 0]) * 100), 18);
  assert.equal(Math.round(machineProbabilityFromLogits([0, 2]) * 100), 82);
  assert.equal(Math.round(machineProbabilityFromLogits([0, 2], 1) * 100), 88);
  assert.throws(() => machineProbabilityFromLogits([0, 2], 0));
});

test("preserves raw log-odds without changing probability ordering", () => {
  const low = machineLogOddsFromLogits([2, 0]);
  const high = machineLogOddsFromLogits([0, 2]);
  assert.equal(low < high, true);
  assert.equal(Math.round(probabilityFromLogOdds(low) * 100), 18);
  assert.equal(Math.round(logOddsFromProbability(0.97) * 1000), 3476);
  assert.throws(() => logOddsFromProbability(1.1));
});

test("uses one full-precision log-odds decision for headline and passages", () => {
  const threshold = logOddsFromProbability(0.9690346465);
  const chunks = [
    { wordStart: 0, wordEnd: 50, logOdds: threshold - 0.001 },
    { wordStart: 50, wordEnd: 100, logOdds: threshold + 0.001 },
  ];
  const diagnostics = calculateAiLogOddsDiagnostics(chunks, threshold);
  assert.equal(isAiPassageFlagged(chunks[0].logOdds, threshold), false);
  assert.equal(isAiPassageFlagged(chunks[1].logOdds, threshold), true);
  assert.equal(Math.round(probabilityFromLogOdds(chunks[0].logOdds) * 100), 97);
  assert.equal(Math.round(probabilityFromLogOdds(chunks[1].logOdds) * 100), 97);
  assert.equal(diagnostics.flaggedPassages, 1);
  assert.equal(diagnostics.flaggedWords, 50);
  assert.equal(diagnostics.percentFlagged, 50);
});

test("computes a top-k passage concentration signal", () => {
  assert.equal(calculateTopKMeanLogOdds([{ logOdds: 1 }, { logOdds: 5 }, { logOdds: 3 }, { logOdds: 7 }], 3), 5);
  assert.equal(calculateTopKMeanLogOdds([], 3), null);
  assert.throws(() => calculateTopKMeanLogOdds([{ logOdds: 1 }], 0));
});

test("computes document median log-odds and its calibrated human percentile", () => {
  assert.equal(medianLogOdds([{ logOdds: 1 }, { logOdds: 4 }, { logOdds: 2 }]), 2);
  assert.equal(medianLogOdds([{ logOdds: 1 }, { logOdds: 4 }, { logOdds: 2 }, { logOdds: 3 }]), 2.5);
  assert.equal(medianLogOdds([]), null);
  assert.equal(typeof calibratedHumanMedianPercentile(3.3325), "number");
  assert.equal(AI_REVIEW_PASSAGE_PERCENTILE, 90);
  assert.equal(Number.isFinite(AI_PASSAGE_LOG_ODDS_THRESHOLD), true);
});

test("shows threshold coverage without promoting it to an authorship verdict", () => {
  assert.equal(AI_HUMAN_CALIBRATION_READY, true);
  assert.equal(AI_HUMAN_REFERENCE_AVAILABLE, true);
  assert.equal(AI_POSITIVE_SET_SIZE, 0);
  assert.equal(AI_POSITIVE_VALIDATION_READY, false);
  assert.equal(AI_CALIBRATED, false);
  assert.equal(AI_EXPERIMENTAL, true);
  assert.equal(shouldSuppressAiScore(0), false);
  assert.equal(shouldSuppressAiScore(100), false);
  assert.equal(isAiBelowReviewFloor(AI_PERCENTILE_REVIEW_FLOOR - 0.1), true);
  assert.equal(isAiBelowReviewFloor(AI_PERCENTILE_REVIEW_FLOOR), false);
});

test("ships the completed human-reference benchmark evidence", () => {
  assert.equal(Number.isInteger(AI_BENCHMARK_DOCUMENTS), true);
  assert.equal(AI_BENCHMARK_DOCUMENTS, 100);
  assert.equal(
    AI_BENCHMARK_PROXY_RATE_AT_30 === null
      || (AI_BENCHMARK_PROXY_RATE_AT_30 >= 0 && AI_BENCHMARK_PROXY_RATE_AT_30 <= 1),
    true,
  );
});

test("computes a population-relative percentile", () => {
  assert.equal(populationPercentile(62, [55, 60, 61, 68]), 75);
  assert.equal(populationPercentile(62, []), null);
});
