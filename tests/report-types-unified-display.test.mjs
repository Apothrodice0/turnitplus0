import assert from "node:assert/strict";
import test from "node:test";
import {
  primarySimilarityScore,
  primaryMatchedWordCount,
  primaryResultLabel,
  hasUnifiedSimilarity,
  unifiedEvidenceSummary,
  buildReportSummary,
} from "../lib/report-types.ts";

/**
 * Phase 7.1 TASK 3: regression coverage for the archive-only/legacy fallback
 * that lets a report saved before Phase 6/7 (no unifiedSimilarity field at
 * all) keep working identically to before, alongside a report that now has
 * a real, persisted unified result (Phase 7.1 TASK 1's
 * attachUnifiedSimilarity in app/page.tsx). Deliberately plain fixtures, no
 * database, no network — these two functions are pure selectors over
 * whatever SimilarityReport shape they are handed.
 */

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: "sub-1",
    title: "doc.pdf",
    author: "Author",
    assignment: "Assignment",
    created: new Date().toISOString(),
    score: 18,
    archiveScore: 18,
    wordCount: 1000,
    databaseSize: 230,
    corpusVersion: "archive-v1-230-test",
    scoreBand: "Low",
    riskStatus: "Lower",
    riskTarget: 40,
    riskCutoff: 40,
    riskCalibration: { auc: 0.9, precision: 0.8, recall: 0.8, sampleSize: 100 },
    features: {
      maxSourceContainment: 0.1,
      longestMatchedSpan: 10,
      quotationDensity: 0.01,
      referenceListRatio: 0.02,
      highFrequencyShingleCount: 1,
      repeatedThreeGramCount: 1,
      detectedLanguage: "English",
    },
    excludedDocuments: 0,
    matchedWordCount: 180,
    sources: [],
    repeats: [],
    text: "sample text",
    ...overrides,
  };
}

function unified(overrides = {}) {
  return {
    version: "unified-similarity-v1",
    wordCount: 1000,
    unifiedScore: 24,
    uniqueMatchedWords: 240,
    archiveOnlyWords: 180,
    liveAcademicOnlyWords: 60,
    previousUploadOnlyWords: 0,
    overlapWords: 0,
    selfExcludedWords: 0,
    unknownExcludedWords: 0,
    contributions: [],
    ...overrides,
  };
}

test("LEGACY: a report with no unifiedSimilarity field falls back to archiveScore exactly as before", () => {
  const report = baseReport();
  assert.equal(hasUnifiedSimilarity(report), false);
  assert.equal(primarySimilarityScore(report), 18);
});

test("LEGACY: a report with no archiveScore falls back to score", () => {
  const report = baseReport({ archiveScore: undefined, score: 9 });
  assert.equal(hasUnifiedSimilarity(report), false);
  assert.equal(primarySimilarityScore(report), 9);
});

test("NEW: a report with a persisted unifiedSimilarity shows the unified score, not archiveScore", () => {
  const report = baseReport({ unifiedSimilarity: unified() });
  assert.equal(hasUnifiedSimilarity(report), true);
  assert.equal(primarySimilarityScore(report), 24);
  assert.notEqual(primarySimilarityScore(report), report.archiveScore);
});

test("SCORE ISOLATION: primarySimilarityScore never mutates or reads back into score/archiveScore", () => {
  const report = baseReport({ unifiedSimilarity: unified({ unifiedScore: 55 }) });
  primarySimilarityScore(report);
  assert.equal(report.score, 18);
  assert.equal(report.archiveScore, 18);
});

test("EVIDENCE SUMMARY: archive-only contribution", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 100, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0 }));
  assert.equal(summary, "own reference material");
});

test("EVIDENCE SUMMARY: archive plus live academic sources", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 100, liveAcademicOnlyWords: 40, previousUploadOnlyWords: 0, overlapWords: 0 }));
  assert.equal(summary, "own reference material, live academic sources");
});

test("EVIDENCE SUMMARY: all three sources plus overlap still lists archive once", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 10, liveAcademicOnlyWords: 10, previousUploadOnlyWords: 10, overlapWords: 5 }));
  assert.equal(summary, "own reference material, live academic sources, a prior submission");
});

test("EVIDENCE SUMMARY: no matched words at all never renders a blank string", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0 }));
  assert.equal(summary, "no matched sources");
});

/**
 * Release-hardening audit finding SIM-01: regression coverage for the
 * archive-only headline/matched-word-count bug — a real production report
 * showed 100% via corpus-source match (unifiedSimilarity.unifiedScore) on
 * every surface EXCEPT the main "Similarity result" headline and its
 * matched-word-count sentence, which read archiveOverlapScore/
 * archiveMatchedWordCount directly (0% and 30 words) instead of
 * primarySimilarityScore/primaryMatchedWordCount. These tests cover the two
 * new selectors this fix adds; tests/similarity-result-consistency.test.mjs
 * covers the rendered components that now use them.
 */

test("SIM-01 archive 0% + corpus source 100%: primarySimilarityScore reflects the unified corpus-source result, never the archive-only 0%", () => {
  const report = baseReport({
    score: 0,
    archiveScore: 0,
    matchedWordCount: 0,
    unifiedSimilarity: unified({
      unifiedScore: 100,
      uniqueMatchedWords: 1000,
      archiveOnlyWords: 0,
      liveAcademicOnlyWords: 0,
      previousUploadOnlyWords: 1000,
      overlapWords: 0,
    }),
  });
  assert.equal(primarySimilarityScore(report), 100);
  assert.notEqual(primarySimilarityScore(report), report.archiveScore);
});

test("SIM-01 MATCHED-WORD COUNT: primaryMatchedWordCount falls back to archiveMatchedWordCount when no unifiedSimilarity is present", () => {
  const report = baseReport({ matchedWordCount: 30 });
  assert.equal(hasUnifiedSimilarity(report), false);
  assert.equal(primaryMatchedWordCount(report), 30);
});

test("SIM-01 MATCHED-WORD COUNT: primaryMatchedWordCount reflects the unified, already-deduplicated total, not the tiny archive-only figure", () => {
  // Mirrors the real observed case: archive alone only matched 30 words, but
  // the combined/deduplicated result (archive + a corpus-source match) is
  // 9,895 — the number a matched-word sentence next to a 100% headline must
  // cite, not 30.
  const report = baseReport({
    matchedWordCount: 30,
    unifiedSimilarity: unified({ unifiedScore: 100, uniqueMatchedWords: 9895, archiveOnlyWords: 30, previousUploadOnlyWords: 9865, liveAcademicOnlyWords: 0, overlapWords: 0 }),
  });
  assert.equal(primaryMatchedWordCount(report), 9895);
});

test("SIM-01 DEDUPLICATED TOTAL: archive overlap plus corpus overlap at the same positions counts once in primaryMatchedWordCount, never double-counted", () => {
  // overlapWords > 0 here means computeUnifiedSimilarity already found the
  // same submitted passage via more than one source and counted it once —
  // uniqueMatchedWords (200) is deliberately less than the naive sum of
  // every bucket (archiveOnlyWords 50 + previousUploadOnlyWords 50 +
  // overlapWords 100 = 200, vs. a wrong double-count of 300 if overlap were
  // added twice). This proves the display layer surfaces the already-
  // deduplicated figure rather than re-summing the per-source breakdown.
  const report = baseReport({
    unifiedSimilarity: unified({
      unifiedScore: 20,
      uniqueMatchedWords: 200,
      archiveOnlyWords: 50,
      previousUploadOnlyWords: 50,
      liveAcademicOnlyWords: 0,
      overlapWords: 100,
    }),
  });
  assert.equal(primaryMatchedWordCount(report), 200);
});

test("SIM-01 LABEL: primaryResultLabel is 'Similarity result' for the archive-only fallback and 'TurnitPlus Similarity' once unified is computed", () => {
  const legacy = baseReport();
  const withUnified = baseReport({ unifiedSimilarity: unified() });
  assert.equal(primaryResultLabel(legacy), "Similarity result");
  assert.equal(primaryResultLabel(withUnified), "TurnitPlus Similarity");
});

test("SIM-01 ROOM/HISTORY SUMMARY: buildReportSummary carries the combined result additively — primaryScore/isUnified reflect corpus-source evidence, archiveScore stays the pure archive value untouched", () => {
  const report = baseReport({
    score: 0,
    archiveScore: 0,
    unifiedSimilarity: unified({ unifiedScore: 100, uniqueMatchedWords: 1000, previousUploadOnlyWords: 1000, archiveOnlyWords: 0, liveAcademicOnlyWords: 0, overlapWords: 0 }),
  });
  const summary = buildReportSummary(report);
  assert.equal(summary.archiveScore, 0, "the persisted archive_score column must keep receiving the pure archive value — other readers (lib/developer-repo.ts) depend on this");
  assert.equal(summary.primaryScore, 100);
  assert.equal(summary.isUnified, true);
});

test("SIM-01 ROOM/HISTORY SUMMARY: a legacy/archive-only report gets primaryScore equal to archiveScore and isUnified false, never a contradicting value", () => {
  const report = baseReport({ archiveScore: 18 });
  const summary = buildReportSummary(report);
  assert.equal(summary.archiveScore, 18);
  assert.equal(summary.primaryScore, 18);
  assert.equal(summary.isUnified, false);
});
