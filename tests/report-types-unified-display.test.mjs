import assert from "node:assert/strict";
import test from "node:test";
import {
  primarySimilarityScore,
  hasUnifiedSimilarity,
  unifiedEvidenceSummary,
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
  assert.equal(summary, "archive");
});

test("EVIDENCE SUMMARY: archive plus live academic sources", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 100, liveAcademicOnlyWords: 40, previousUploadOnlyWords: 0, overlapWords: 0 }));
  assert.equal(summary, "archive, live academic sources");
});

test("EVIDENCE SUMMARY: all three sources plus overlap still lists archive once", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 10, liveAcademicOnlyWords: 10, previousUploadOnlyWords: 10, overlapWords: 5 }));
  assert.equal(summary, "archive, live academic sources, a prior submission");
});

test("EVIDENCE SUMMARY: no matched words at all never renders a blank string", () => {
  const summary = unifiedEvidenceSummary(unified({ archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0 }));
  assert.equal(summary, "no matched sources");
});
