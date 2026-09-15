import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewReport } from "../components/report/similarity-report-papers.tsx";
import { resolveReportCompletion } from "../lib/evidence-interpretation/completion.ts";
import { resolveCompletionView } from "../lib/report-v2-view.ts";

/**
 * UX cleanup slice 2 — legacy/full report views ("Integrity Overview",
 * OverviewReport) previously never surfaced report.reportCompletion at all,
 * so a customer viewing that tab could not tell "0 qualifying overlap,
 * genuinely completed" apart from "some source checks were incomplete." This
 * proves the new CompletionNotice (components/report/similarity-report-
 * papers.tsx) reuses the EXACT same completion business logic
 * (resolveReportCompletion) and view mapping (resolveCompletionView, now
 * exported from lib/report-v2-view.ts) Report V2 already used — no second
 * copy of the wording, no new completion model.
 */

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: "sub-completion-notice-1",
    title: "fixture.pdf",
    author: "",
    assignment: "",
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 1000,
    characterCount: 6000,
    pageCount: 2,
    fileSize: "8 KB",
    databaseSize: 230,
    corpusVersion: "archive-v1-230-test",
    scoreBand: "Low",
    riskStatus: "Lower",
    riskTarget: 0.5,
    riskCutoff: 0.5,
    riskCalibration: { auc: 0.9, precision: 0.9, recall: 0.9, sampleSize: 100 },
    features: {
      maxSourceContainment: 0,
      longestMatchedSpan: 0,
      quotationDensity: 0,
      referenceListRatio: 0,
      highFrequencyShingleCount: 0,
      repeatedThreeGramCount: 0,
      detectedLanguage: "English",
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: "fixture text not used by OverviewReport directly",
    ...overrides,
  };
}

function render(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}

const FORBIDDEN_JARGON = /\bV4\b|Selective Corpus|OpenAIRE|Europe PMC|\bBlob\b|authoritative|candidate retrieval|\bmatcher\b|COMPLETED|PARTIAL|SOURCE_UNAVAILABLE|EXTRACTION_PARTIAL/;

// ── A: COMPLETED — no notice at all, including a genuine 0% ────────────────
test("A: COMPLETED (including 0 qualifying overlap) shows no incomplete-check notice", () => {
  const completion = resolveReportCompletion({});
  assert.equal(completion.state, "COMPLETED");
  const html = render(baseReport({ reportCompletion: completion }));
  assert.doesNotMatch(html, /report-completion-notice/, "no notice markup at all for a genuinely completed, uncluttered report");
});

// ── B: PARTIAL ──────────────────────────────────────────────────────────────
test("B: PARTIAL shows the existing customer-safe PARTIAL wording", () => {
  const completion = resolveReportCompletion({ academicSearch: "FAILED", verifiedSimilarityPercent: 14 });
  assert.equal(completion.state, "PARTIAL");
  const html = render(baseReport({ reportCompletion: completion, score: 14, archiveScore: 14 }));
  assert.match(html, /report-completion-notice/, "the notice renders for a non-COMPLETED state");
  assert.match(html, /Some source searches were unavailable\. Results may be incomplete\./);
});

// ── C: SOURCE_UNAVAILABLE ───────────────────────────────────────────────────
test("C: SOURCE_UNAVAILABLE shows the existing customer-safe source-unavailable wording", () => {
  const completion = resolveReportCompletion({ unverifiedCandidateCount: 2, verifiedSimilarityPercent: 5 });
  assert.equal(completion.state, "SOURCE_UNAVAILABLE");
  const html = render(baseReport({ reportCompletion: completion, score: 5, archiveScore: 5 }));
  assert.match(html, /report-completion-notice/);
  assert.match(html, /A candidate source was identified but its text could not be verified\./);
  assert.match(html, /2 possible sources are listed separately/);
});

// ── D: EXTRACTION_PARTIAL ────────────────────────────────────────────────────
test("D: EXTRACTION_PARTIAL shows the existing customer-safe extraction-partial wording", () => {
  const extraction = { completeness: "PARTIAL", analyzableWordCount: 800, skipped: { unit: "pages", total: 10, read: 8 }, extractor: "pdf" };
  const completion = resolveReportCompletion({ extraction });
  assert.equal(completion.state, "EXTRACTION_PARTIAL");
  const html = render(baseReport({ reportCompletion: completion, extractionDiagnostic: extraction }));
  assert.match(html, /report-completion-notice/);
  assert.match(html, /Part of the uploaded document could not be analyzed\./);
  assert.match(html, /About 2 pages of the file could not be read/);
});

// ── E: missing / legacy reportCompletion ────────────────────────────────────
test("E: a report with no reportCompletion at all (pre-existing field) renders safely with no fabricated warning", () => {
  const html = render(baseReport()); // no reportCompletion key
  assert.doesNotMatch(html, /report-completion-notice/, "absence of the field must never be treated as an incomplete state");
  assert.match(html, /Similarity result: 0%/, "the rest of the legacy headline still renders exactly as before");
});

// ── F: no raw enum names or internal jargon in any rendered wording ────────
test("F: none of the four states' rendered wording exposes a raw enum name, provider name, or corpus/matcher jargon", () => {
  const cases = [
    resolveReportCompletion({}),
    resolveReportCompletion({ academicSearch: "FAILED", verifiedSimilarityPercent: 14 }),
    resolveReportCompletion({ unverifiedCandidateCount: 2, verifiedSimilarityPercent: 5 }),
    resolveReportCompletion({ extraction: { completeness: "PARTIAL", analyzableWordCount: 800, skipped: { unit: "pages", total: 10, read: 8 }, extractor: "pdf" } }),
  ];
  for (const completion of cases) {
    const html = render(baseReport({ reportCompletion: completion, extractionDiagnostic: completion.state === "EXTRACTION_PARTIAL" ? { completeness: "PARTIAL", analyzableWordCount: 800, skipped: { unit: "pages", total: 10, read: 8 }, extractor: "pdf" } : undefined }));
    const noticeMatch = html.match(/<aside class="report-completion-notice"[^>]*>([\s\S]*?)<\/aside>/);
    if (noticeMatch) assert.doesNotMatch(noticeMatch[1], FORBIDDEN_JARGON, `state ${completion.state} notice text must be customer-safe`);
  }
});

// ── G: Report V2's own completion messaging is unaffected ──────────────────
test("G: lib/report-v2-view.ts's resolveCompletionView (now exported) is unchanged in behavior — same defaults, used by Report V2's own CompletionStrip", () => {
  assert.equal(typeof resolveCompletionView, "function", "resolveCompletionView must now be exported");
  const completed = resolveCompletionView(undefined, undefined, 0);
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.detail, null);
  // Report V2's own scope line is generated by this same function (see
  // tests/report-v2-provider-name-scope.test.mjs for its exact customer-
  // facing wording after the provider-name-removal slice) — the legacy
  // notice deliberately never reuses scopeLine at all, regardless of its
  // current wording.
  assert.match(completed.scopeLine, /Compared against/);
});
