import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { tokens } from "../lib/similarity-core.ts";
import { primarySimilarityScore, primaryMatchedWordCount, formatSimilarityPercent } from "../lib/report-types.ts";
import {
  buildReportEvidenceInterpretation,
  resolveReportCompletion,
  unknownExtractionDiagnostic,
} from "../lib/evidence-interpretation/index.ts";
import { buildReportV2ViewModel, reportV2MatchedWordCount } from "../lib/report-v2-view.ts";
import {
  LegacyPrintManuscript,
  ReportV2PrintManuscriptPages,
  ReportV2PrintOverview,
  ReportV2PrintSourceAppendix,
  ReportV2Workspace,
} from "../components/report/report-v2/report-v2-view.tsx";

// The printed report is the on-screen report on paper (owner decision 2026-10-30): the same manuscript renderer, the same
// source numbers and percentage format, sheets that carry their header and footer, and no blank sheet. Rendered pixels
// are verified through real Print > Save as PDF runs; these pin the structure that produced them.

const makeText = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function mkReport(over = {}) {
  const text = over.text ?? makeText(600);
  return {
    version: 11, id: 1, submissionId: "0000000001", title: "fixture.txt", author: "test@example.com", assignment: "",
    created: new Date().toISOString(), score: over.score ?? 0, archiveScore: over.archiveScore ?? over.score ?? 0,
    wordCount: tokens(text).length, characterCount: text.length, pageCount: 2, fileSize: "3 KB", databaseSize: 230,
    corpusVersion: "archive-v5-230-x", scoreBand: "Low", riskStatus: "Lower", riskTarget: 0, riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "en" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text,
    ...over,
  };
}
function withV2(report) {
  const extractionDiagnostic = unknownExtractionDiagnostic();
  return {
    ...report,
    evidenceInterpretation: buildReportEvidenceInterpretation(report, {}),
    reportCompletion: resolveReportCompletion({ academicSearch: null, selectiveCorpus: null, extraction: extractionDiagnostic, unverifiedCandidateCount: 0, verifiedSimilarityPercent: primarySimilarityScore(report) }),
    extractionDiagnostic,
  };
}
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const source = (name, words, percent) => ({ name, type: "Internet", percent, matches: 1, matchedWords: words, phrases: [], color: "#0" });
const matched = (over = {}) => withV2(mkReport({
  text: makeText(500),
  archiveMatchedPositions: range(0, 100),
  sources: [source("Wikipedia — “Fixture”", 101, 20)],
  unifiedSimilarity: { matchedPositions: range(0, 100), previousUploadPositions: [], unifiedScore: 20, uniqueMatchedWords: 101 },
  score: 20,
  ...over,
}));
/** A view-model source list whose word-count ranking differs from its display order, as real reports' lists do. */
function outOfOrderSources(report) {
  const ei = report.evidenceInterpretation;
  const [first] = ei.sources;
  const clone = (id, label, matchedWords, contributionPercent) => ({ ...first, id, label, matchedWords, contributionPercent, passageRefs: [] });
  return { ...report, evidenceInterpretation: { ...ei, sources: [first, clone("s-b", "Small source", 13, 0), clone("s-c", "Big source", 67, 1)] } };
}

test("print manuscript: the screen's renderer and marks, static on paper, never the legacy dot highlight", () => {
  const report = matched();
  const print = render(ReportV2PrintManuscriptPages, { report });
  const screen = render(ReportV2Workspace, { report });
  assert.match(print, /class="rv2-doc rv2ws-manuscript"/);
  assert.match(print, /class="[^"]*rv2ws-mark[^"]*"/);
  assert.match(print, /class="rv2ws-mark-number"/, "the numbered source badge");
  assert.doesNotMatch(print, /submission-match|submission-copy|highlight-legend/, "not the legacy manuscript");
  assert.doesNotMatch(print, /role="button"|tabindex|aria-pressed|id="rv2ws-mark-/, "nothing on paper can act, and no id duplicates the screen's");
  assert.equal(print.match(/<mark /g).length, screen.match(/<mark /g).length, "the same passages are highlighted");
  assert.match(screen, /role="button"/, "the screen's marks stay interactive");
});

test("print manuscript: flows as one block, so a word-count page break cannot cut a sentence or strand a line", () => {
  const html = render(ReportV2PrintManuscriptPages, { report: matched({ text: makeText(1500) }) });
  assert.equal(html.match(/rv2ws-manuscript/g).length, 1);
  assert.equal(html.match(/word1499/g).length, 1, "the end of the text prints, once");
});

test("every printed section repeats its header and footer through a table, and no text is lost when there is no text", () => {
  const report = matched();
  for (const component of [ReportV2PrintOverview, ReportV2PrintManuscriptPages, ReportV2PrintSourceAppendix]) {
    const html = render(component, { report });
    assert.match(html, /<table class="rv2-print-sheet" role="presentation"><thead><tr><td><div class="paper-header">/);
    assert.match(html, /<tfoot><tr><td><div class="paper-footer">/);
  }
  assert.match(render(ReportV2PrintManuscriptPages, { report: matched({ text: "" }) }), /not available for inline highlighting/);
});

test("a number means the same source everywhere: page 1 keeps each source's place, it does not renumber the ranking", () => {
  const report = outOfOrderSources(matched());
  const vm = buildReportV2ViewModel(report);
  assert.deepEqual(vm.sources.map((s) => s.label).slice(1), ["Small source", "Big source"]);
  const overview = render(ReportV2PrintOverview, { report });
  const big = overview.indexOf("Big source");
  assert.ok(big > -1);
  const numberBeforeBig = [...overview.slice(0, big).matchAll(/rv2ws-source-number[^>]*>(\d+)</g)].at(-1)[1];
  assert.equal(numberBeforeBig, "3", "the third source on screen stays number 3 although it ranks second by words");
  const appendix = render(ReportV2PrintSourceAppendix, { report });
  assert.deepEqual([...appendix.matchAll(/rv2ws-source-number[^>]*>(\d+)</g)].map((m) => m[1]), ["1", "2", "3"]);
});

test("print uses the screen's percentage format: a real overlap under 1% never reads 0%", () => {
  const report = outOfOrderSources(matched());
  assert.equal(formatSimilarityPercent(0, 13), "<1%");
  const small = report.evidenceInterpretation.sources[1];
  assert.equal(small.contributionPercent, 0);
  const appendix = render(ReportV2PrintSourceAppendix, { report }).replaceAll("&lt;", "<");
  assert.match(appendix, /13 words · <1%/);
  assert.doesNotMatch(appendix, /\b0% contribution|\b0%/);
  assert.doesNotMatch(render(ReportV2PrintOverview, { report }), /% contribution/);
});

test("source details: nothing sits behind a disclosure paper cannot open, and references are kept", () => {
  const report = matched();
  const ei = report.evidenceInterpretation;
  const linked = { ...report, evidenceInterpretation: { ...ei, sources: ei.sources.map((s) => ({ ...s, sourceType: "publication", link: "https://example.org/paper/1", year: 2024, label: "A paper" })) } };
  const html = render(ReportV2PrintSourceAppendix, { report: linked });
  assert.doesNotMatch(html, /<details|<summary/);
  assert.match(html, /example\.org\/paper\/1/);
  assert.match(html, /· 2024/);
  const doi = { ...report, evidenceInterpretation: { ...ei, sources: ei.sources.map((s) => ({ ...s, sourceType: "publication", link: null, doi: "10.1000/xyz", label: "A paper" })) } };
  assert.match(render(ReportV2PrintSourceAppendix, { report: doi }), /DOI: 10\.1000\/xyz/);
});

test("0% report: no source section, and the section count says so", () => {
  const report = withV2(mkReport({ text: makeText(200) }));
  assert.equal(render(ReportV2PrintSourceAppendix, { report }), "");
  assert.match(render(ReportV2PrintOverview, { report }), /Section 1 of 2/);
  assert.match(render(ReportV2PrintManuscriptPages, { report }), /Section 2 of 2/);
  assert.match(render(ReportV2PrintOverview, { report: matched() }), /Section 1 of 3/);
});

test("the System 2 percentage reaches the printed overview through the same hero as the screen", () => {
  const report = matched();
  const html = render(ReportV2PrintOverview, { report, unified: { percent: 34, includesStatisticalEstimate: true, system1Percent: 20 } });
  assert.match(html, /class="rv2ws-hero"/);
  assert.match(html, /34%/);
  assert.doesNotMatch(html, /<span>20%<\/span> Similarity score/);
});

test("older reports keep their own figures and highlights: no V2 data, the legacy ranges in the printed sheet", () => {
  const report = mkReport({
    archiveMatchedPositions: range(0, 20),
    sources: [{ ...source("Old source", 21, 3), attributedRanges: [[0, 20]] }],
    unifiedSimilarity: { matchedPositions: range(0, 20), previousUploadPositions: [], unifiedScore: 3, uniqueMatchedWords: 21 },
    score: 3,
  });
  assert.equal(buildReportV2ViewModel(report), null, "nothing is invented for a report without an interpretation");
  const html = render(LegacyPrintManuscript, { report });
  assert.match(html, /class="report-paper rv2-print-paper submission-paper"/);
  assert.match(html, /<table class="rv2-print-sheet"/);
  assert.match(html, /submission-match/);
  assert.match(html, /word599/, "the whole text");
  const plain = render(LegacyPrintManuscript, { report: mkReport({}) });
  assert.doesNotMatch(plain, /submission-match/);
  assert.match(plain, /word599/);
});

test("the receipt counts matched words as the report does, so its under-1% wording agrees", async () => {
  const report = matched();
  const zeroScored = { ...report, unifiedSimilarity: { ...report.unifiedSimilarity, unifiedScore: 0, uniqueMatchedWords: 0 }, archiveScore: 0, score: 0 };
  assert.equal(primaryMatchedWordCount(zeroScored), 0);
  assert.equal(reportV2MatchedWordCount(zeroScored), report.evidenceInterpretation.matchedWordCount);
  assert.ok(reportV2MatchedWordCount(zeroScored) > 0, "the count the report shows");
  const pipeline = await readFile(new URL("../lib/document-check-pipeline.ts", import.meta.url), "utf8");
  assert.match(pipeline, /createReceiptPdf\(\{ \.\.\.report, unified, matchedWordCount: reportV2MatchedWordCount\(report\)/);
});

test("print CSS: only the bundle prints, sections start a sheet, and nothing forces a break after the last one", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.result-view\.report-detail-page:has\(\.print-report-bundle\) > :not\(\.print-report-bundle\) \{\s*display: none !important;/);
  assert.match(css, /\.rv2-print-flow \.report-paper \+ \.report-paper \{\s*break-before: page;/);
  assert.match(css, /\.rv2-print-flow \.report-paper \{\s*display: block;\s*min-height: 0;\s*break-after: auto;/);
  assert.doesNotMatch(css, /rv2-print-manuscript-page/, "no per-page forced break left behind");
  assert.doesNotMatch(css, /\.report-v2-print \.rv2-section \{ border: 1px solid #ccc/, "the old grey print border is gone");
});
