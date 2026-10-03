import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { tokens } from "../lib/similarity-core.ts";
import { primaryMatchedWordCount, primarySimilarityScore, stripServerInternalReportFields } from "../lib/report-types.ts";
import {
  buildReportEvidenceInterpretation,
  resolveReportCompletion,
  unknownExtractionDiagnostic,
} from "../lib/evidence-interpretation/index.ts";
import {
  buildReportV2ViewModel,
  completionStatusLabel,
  resolveCompletionView,
  resolveUncertainPassages,
  UNCERTAIN_MATCH_LEGEND,
  VERIFIED_MATCH_LEGEND,
} from "../lib/report-v2-view.ts";
import {
  ReportV2PrintManuscriptPages,
  ReportV2PrintOverview,
  ReportV2Workspace,
} from "../components/report/report-v2/report-v2-view.tsx";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";
import {
  refreshSelectiveCorpusCompletionSignal,
  stripClientEvidenceInterpretation,
  withEvidenceInterpretation,
} from "../lib/report-evidence-interpretation.ts";
import {
  academicFailureReasonForHttpStatus,
  analyzeAcademicEvidence,
  enrichReportWithAcademicEvidence,
} from "../lib/document-check-pipeline.ts";
import { getExternalAcademicEvidence } from "../lib/academic-evidence-integration.ts";
import { selectSelectiveCorpusFinalizationEvidence } from "../lib/selective-corpus-authoritative.ts";

/**
 * PARTIAL SEARCH + POSSIBLE (YELLOW) MATCHES.
 *
 *  1. A partial search names its exact channel + reason (machine-readable,
 *     admin-only on the wire) and reads as a precise yellow "Partial search",
 *     never the vague "Needs attention".
 *  2. The live-academic and Selective Corpus reasons survive from where they
 *     happen (browser fetch / route / finalizer) to the completion diagnostics.
 *  3. YELLOW possible matches never touch the score, never cover a verified
 *     word, render the same in the browser workspace and the printed (PDF)
 *     manuscript, and a report without them renders exactly as before.
 */

// ── fixtures (same shape tests/report-v2-ui.test.mjs uses) ───────────────
function makeText(n) {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function mkReport(over = {}) {
  const text = over.text ?? makeText(600);
  return {
    version: 11,
    id: 1,
    submissionId: "0000000001",
    title: "fixture.txt",
    author: "Guest submission",
    assignment: "x",
    created: "2026-10-03T00:00:00.000Z",
    score: 9,
    archiveScore: 9,
    wordCount: tokens(text).length,
    characterCount: text.length,
    pageCount: 2,
    fileSize: "3 KB",
    databaseSize: 230,
    corpusVersion: "archive-v5-230-x",
    scoreBand: "Low",
    riskStatus: "Lower",
    riskTarget: 0,
    riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: {
      maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0,
      referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0,
      detectedLanguage: "en",
    },
    excludedDocuments: 0,
    matchedWordCount: 51,
    archiveMatchedPositions: range(20, 70),
    sources: [{ name: "Example source", type: "Internet", percent: 9, matches: 1, matchedWords: 51, phrases: [], color: "#0" }],
    repeats: [],
    text,
    ...over,
  };
}

function withV2(report, completionInput = {}) {
  const evidenceInterpretation = buildReportEvidenceInterpretation(report, {});
  const reportCompletion = resolveReportCompletion({
    academicSearch: report.academicEvidenceStatus ?? null,
    extraction: unknownExtractionDiagnostic(),
    verifiedSimilarityPercent: primarySimilarityScore(report),
    ...completionInput,
  });
  return { ...report, evidenceInterpretation, reportCompletion, extractionDiagnostic: unknownExtractionDiagnostic() };
}

const UNCERTAIN = {
  passages: [
    // straddles the verified run 20..70: only 71..90 may turn yellow
    { wordStart: 60, wordEnd: 90, reason: "SOURCE_TEXT_UNVERIFIED" },
    { wordStart: 200, wordEnd: 210, reason: "NON_SCORING_EVIDENCE" },
    // runs past the end of the document: clipped to the last word
    { wordStart: 590, wordEnd: 9999, reason: "SOURCE_TEXT_UNVERIFIED" },
  ],
};

const renderWorkspace = (report) => renderToStaticMarkup(React.createElement(ReportV2Workspace, { report, onDownloadReport: () => {} }));
const renderPrintManuscript = (report) => renderToStaticMarkup(React.createElement(ReportV2PrintManuscriptPages, { report }));
const renderPrintOverview = (report) => renderToStaticMarkup(React.createElement(ReportV2PrintOverview, { report }));

// ── 1. completion: precise partial search + diagnostics ─────────────────
test("a failed live academic search with a recorded reason is a precise PARTIAL search with an exact channel + reason", () => {
  const c = resolveReportCompletion({ academicSearch: "FAILED", academicSearchFailureReason: "RATE_LIMITED", verifiedSimilarityPercent: 1 });
  assert.equal(c.state, "PARTIAL");
  assert.equal(c.headline, "Partial search: some sources were unavailable.");
  assert.equal(c.detail, "The 1% shown is a verified lower bound. Completed searches still produced valid evidence; sources we could not reach are not counted.");
  assert.deepEqual(c.diagnostics, [{ channel: "LIVE_ACADEMIC_SEARCH", reason: "RATE_LIMITED" }]);
  assert.equal(completionStatusLabel(c.state), "Partial search");
});

test("every contributing channel gets exactly one diagnostic, in a fixed order; unknown reasons are NOT_RECORDED, never guessed", () => {
  const c = resolveReportCompletion({
    academicSearch: "FAILED",
    academicSearchFailureReason: "<script>alert(1)</script>",
    selectiveCorpus: "PARTIAL",
    selectiveCorpusIncompleteReason: "TIMEOUT",
    userSuppliedReference: "PARTIAL",
    unverifiedCandidateCount: 2,
  });
  assert.equal(c.state, "PARTIAL");
  assert.deepEqual(c.diagnostics, [
    { channel: "LIVE_ACADEMIC_SEARCH", reason: "NOT_RECORDED" },
    { channel: "SELECTIVE_CORPUS", reason: "TIMEOUT" },
    { channel: "USER_SUPPLIED_REFERENCES", reason: "REFERENCE_FILE_UNREADABLE" },
    { channel: "SOURCE_TEXT_VERIFICATION", reason: "CANDIDATE_TEXT_UNAVAILABLE" },
  ]);
  const completed = resolveReportCompletion({ academicSearch: "COMPLETE_NO_MATCHES" });
  assert.equal(completed.state, "COMPLETED");
  assert.deepEqual(completed.diagnostics, []);
});

test("a completion saved with the old vague copy and no diagnostics renders the current partial-search copy and NOT_RECORDED diagnostics", () => {
  const legacy = {
    state: "PARTIAL",
    headline: "Some source searches were unavailable. Results may be incomplete.",
    detail: "The 1% shown is a lower bound — a source we could not reach may add more.",
    reasons: ["the live academic-source search could not complete"],
    signals: { academicSearch: "FAILED", selectiveCorpus: null, extraction: "UNKNOWN", unverifiedCandidateCount: 0, userSuppliedReference: null },
  };
  const view = resolveCompletionView(legacy, undefined, 1);
  assert.equal(view.state, "PARTIAL", "machine-readable state preserved");
  assert.equal(view.statusLabel, "Partial search");
  assert.equal(view.headline, "Partial search: some sources were unavailable.");
  assert.match(view.detail, /^The 1% shown is a verified lower bound\./);
  assert.deepEqual(view.diagnostics, [{ channel: "LIVE_ACADEMIC_SEARCH", reason: "NOT_RECORDED" }]);
});

test("no browser or printed surface says 'Needs attention' for any completion state; the label is precise per state", () => {
  const expected = { COMPLETED: "Completed", PARTIAL: "Partial search", SOURCE_UNAVAILABLE: "Source not verified", EXTRACTION_PARTIAL: "Partial document" };
  const inputs = {
    COMPLETED: {},
    PARTIAL: { academicSearch: "FAILED" },
    SOURCE_UNAVAILABLE: { unverifiedCandidateCount: 1 },
    EXTRACTION_PARTIAL: { extraction: { completeness: "PARTIAL", analyzableWordCount: 600, skipped: { unit: "pages", total: 4, read: 3 }, extractor: "pdf" } },
  };
  for (const [state, input] of Object.entries(inputs)) {
    const report = withV2(mkReport(), input);
    if (state === "EXTRACTION_PARTIAL") report.extractionDiagnostic = input.extraction;
    assert.equal(report.reportCompletion.state, state);
    for (const html of [renderWorkspace(report), renderPrintOverview(report)]) {
      assert.doesNotMatch(html, /Needs attention/, `${state}: the vague label is gone`);
      assert.match(html, new RegExp(`>${expected[state]}<`), `${state}: shows "${expected[state]}"`);
    }
  }
  const partialHtml = renderWorkspace(withV2(mkReport(), inputs.PARTIAL));
  assert.match(partialHtml, /rv2ws-toolbar-status-attention/, "yellow warning pill, not an error state");
  assert.match(partialHtml, /rv2-completion-attention/);
});

// ── 2. live academic search: the reason travels from fetch to the report ─
test("route failure classes map to precise reasons", () => {
  assert.equal(academicFailureReasonForHttpStatus(429), "RATE_LIMITED");
  assert.equal(academicFailureReasonForHttpStatus(504), "ROUTE_TIMEOUT");
  assert.equal(academicFailureReasonForHttpStatus(408), "ROUTE_TIMEOUT");
  assert.equal(academicFailureReasonForHttpStatus(500), "SERVER_ERROR");
  assert.equal(academicFailureReasonForHttpStatus(503), "SERVER_ERROR");
  assert.equal(academicFailureReasonForHttpStatus(413), "REQUEST_REJECTED");
  assert.equal(academicFailureReasonForHttpStatus(400), "REQUEST_REJECTED");
});

test("analyzeAcademicEvidence keeps every failure path apart instead of one bare FAILED (and never throws)", async () => {
  const realFetch = globalThis.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const cases = [
    ["429", async () => json({ error: "Too many requests" }, 429), "FAILED", "RATE_LIMITED"],
    ["504", async () => new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504 }), "FAILED", "ROUTE_TIMEOUT"],
    ["500", async () => json({ error: "Internal error" }, 500), "FAILED", "SERVER_ERROR"],
    ["413", async () => json({ error: "text is too long" }, 413), "FAILED", "REQUEST_REJECTED"],
    ["network", async () => { throw new TypeError("Failed to fetch"); }, "FAILED", "NETWORK_ERROR"],
    ["bad json", async () => new Response("<html>", { status: 200 }), "FAILED", "MALFORMED_RESPONSE"],
    ["no status", async () => json({ evidence: [] }), "FAILED", "MALFORMED_RESPONSE"],
    ["server FAILED + reason", async () => json({ evidence: [], status: "FAILED", academicSearchDiagnosticsId: 7, failureReason: "ALL_PROVIDER_CALLS_FAILED" }), "FAILED", "ALL_PROVIDER_CALLS_FAILED"],
    ["older server FAILED", async () => json({ evidence: [], status: "FAILED", academicSearchDiagnosticsId: 7 }), "FAILED", null],
    ["complete", async () => json({ evidence: [], status: "COMPLETE_NO_MATCHES", academicSearchDiagnosticsId: 8 }), "COMPLETE_NO_MATCHES", null],
  ];
  try {
    for (const [label, fetchImpl, status, failureReason] of cases) {
      globalThis.fetch = fetchImpl;
      const result = await analyzeAcademicEvidence("x".repeat(200));
      assert.equal(result.status, status, `${label}: status`);
      assert.equal(result.failureReason ?? null, failureReason, `${label}: failureReason`);
      assert.deepEqual(result.evidence, [], `${label}: no evidence`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the reason is stamped on the report only beside FAILED, and a later success clears it", () => {
  const failed = enrichReportWithAcademicEvidence(mkReport(), { evidence: [], status: "FAILED", academicSearchDiagnosticsId: null, failureReason: "ROUTE_TIMEOUT" });
  assert.equal(failed.academicEvidenceStatus, "FAILED");
  assert.equal(failed.academicEvidenceFailureReason, "ROUTE_TIMEOUT");
  const recovered = enrichReportWithAcademicEvidence(failed, { evidence: [], status: "COMPLETE_NO_MATCHES", academicSearchDiagnosticsId: 3, failureReason: null });
  assert.equal(recovered.academicEvidenceStatus, "COMPLETE_NO_MATCHES");
  assert.equal("academicEvidenceFailureReason" in recovered, false);
});

test("server side: a total provider outage is ALL_PROVIDER_CALLS_FAILED; a run with a real answer has no failure reason", async () => {
  const text = "Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages under variable nutrient stress conditions. Quantum entanglement based key distribution protocols promise theoretically unconditional security guarantees against passive eavesdropping attempts.";
  const broken = (id) => ({ id, async search() { throw new Error("timeout"); } });
  const outage = await getExternalAcademicEvidence(text, [broken("a"), broken("b")]);
  assert.equal(outage.status, "FAILED");
  assert.equal(outage.failureReason, "ALL_PROVIDER_CALLS_FAILED");
  const answering = { id: "ok", async search() { return []; } };
  const quiet = await getExternalAcademicEvidence(text, [answering]);
  assert.equal(quiet.status, "COMPLETE_NO_MATCHES");
  assert.equal(quiet.failureReason, null);
});

test("server wiring: the report's academic reason reaches reportCompletion.diagnostics, sanitized", () => {
  const withReason = withEvidenceInterpretation(mkReport({ academicEvidenceStatus: "FAILED", academicEvidenceFailureReason: "RATE_LIMITED" }));
  assert.equal(withReason.reportCompletion.state, "PARTIAL");
  assert.deepEqual(withReason.reportCompletion.diagnostics, [{ channel: "LIVE_ACADEMIC_SEARCH", reason: "RATE_LIMITED" }]);
  const forged = withEvidenceInterpretation(mkReport({ academicEvidenceStatus: "FAILED", academicEvidenceFailureReason: "anything the browser liked" }));
  assert.deepEqual(forged.reportCompletion.diagnostics, [{ channel: "LIVE_ACADEMIC_SEARCH", reason: "NOT_RECORDED" }]);
});

// ── 3. Selective Corpus: the incomplete reason ──────────────────────────
test("the finalizer's evidence selection names why a run is incomplete", () => {
  const base = { evaluatorVersion: "v", verifiedEvidence: [] };
  assert.equal(selectSelectiveCorpusFinalizationEvidence({ ...base, state: "COMPLETED" }).incompleteReason, null);
  assert.equal(selectSelectiveCorpusFinalizationEvidence({ ...base, state: "PARTIAL" }).incompleteReason, "PARTIAL_INDEX");
  for (const state of ["TIMEOUT", "ARTIFACT_UNAVAILABLE", "FAILED", "DISABLED"]) {
    const selection = selectSelectiveCorpusFinalizationEvidence({ state, evaluatorVersion: "v" });
    assert.equal(selection.terminalStatus, "incomplete");
    assert.equal(selection.incompleteReason, state);
  }
});

test("response time: the persisted incomplete reason reaches the diagnostics; ordinary viewers get neither it nor the diagnostics", () => {
  const report = withV2(mkReport());
  report.selectiveCorpusAuthoritativeStatus = "incomplete";
  report.selectiveCorpusAuthoritativeIncompleteReason = "ARTIFACT_UNAVAILABLE";
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion.state, "PARTIAL");
  assert.deepEqual(report.reportCompletion.diagnostics, [{ channel: "SELECTIVE_CORPUS", reason: "ARTIFACT_UNAVAILABLE" }]);

  const adminCopy = structuredClone(report);
  stripServerInternalReportFields(adminCopy, { viewerIsAdmin: true });
  assert.equal(adminCopy.selectiveCorpusAuthoritativeIncompleteReason, undefined);
  assert.deepEqual(adminCopy.reportCompletion.diagnostics, [{ channel: "SELECTIVE_CORPUS", reason: "ARTIFACT_UNAVAILABLE" }]);

  const customerCopy = structuredClone(report);
  stripServerInternalReportFields(customerCopy);
  assert.equal(customerCopy.selectiveCorpusAuthoritativeIncompleteReason, undefined);
  assert.equal(customerCopy.reportCompletion.state, "PARTIAL");
  assert.equal("diagnostics" in customerCopy.reportCompletion, false);
  assert.doesNotMatch(JSON.stringify(customerCopy.reportCompletion), /ARTIFACT_UNAVAILABLE|TIMEOUT|FAILED/);
});

test("an already-PARTIAL completion whose Selective Corpus reason was not yet known is refreshed once the reason exists", () => {
  const report = withV2(mkReport(), { selectiveCorpus: "PARTIAL" });
  assert.deepEqual(report.reportCompletion.diagnostics, [{ channel: "SELECTIVE_CORPUS", reason: "NOT_RECORDED" }]);
  report.selectiveCorpusAuthoritativeStatus = "incomplete";
  report.selectiveCorpusAuthoritativeIncompleteReason = "PARTIAL_INDEX";
  refreshSelectiveCorpusCompletionSignal(report);
  assert.deepEqual(report.reportCompletion.diagnostics, [{ channel: "SELECTIVE_CORPUS", reason: "PARTIAL_INDEX" }]);
  const before = report.reportCompletion;
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion, before, "no-op once signal and diagnostic are current");
});

test("admin diagnostics render only for an admin viewer; ordinary copy stays concise", () => {
  const report = withV2(mkReport(), { academicSearch: "FAILED", academicSearchFailureReason: "ROUTE_TIMEOUT" });
  const customer = renderWorkspace(report);
  assert.doesNotMatch(customer, /rv2-completion-diagnostics|ROUTE_TIMEOUT|LIVE_ACADEMIC_SEARCH/);
  const admin = renderWorkspace({ ...report, viewerIsAdmin: true });
  assert.match(admin, /rv2-completion-diagnostics/);
  assert.match(admin, /<code>LIVE_ACADEMIC_SEARCH<\/code> · <code>ROUTE_TIMEOUT<\/code>/);
});

// ── 4. YELLOW possible matches ──────────────────────────────────────────
test("yellow possible matches never change the score, the matched-word count or the evidence interpretation", () => {
  const plain = mkReport();
  const withYellow = mkReport({ uncertainEvidence: UNCERTAIN });
  assert.equal(primarySimilarityScore(withYellow), primarySimilarityScore(plain));
  assert.equal(primaryMatchedWordCount(withYellow), primaryMatchedWordCount(plain));
  assert.deepEqual(buildReportEvidenceInterpretation(withYellow, {}), buildReportEvidenceInterpretation(plain, {}));

  const vmPlain = buildReportV2ViewModel(withV2(plain));
  const vmYellow = buildReportV2ViewModel(withV2(withYellow));
  assert.equal(vmYellow.summary.verifiedSimilarityPercent, vmPlain.summary.verifiedSimilarityPercent);
  assert.equal(vmYellow.summary.matchedWordCount, vmPlain.summary.matchedWordCount);
  assert.equal(vmYellow.summary.distinctVerifiedSources, vmPlain.summary.distinctVerifiedSources);
  assert.deepEqual(vmYellow.passages, vmPlain.passages, "red verified passages are untouched");
  assert.ok(vmYellow.uncertainPassages.length > 0);
});

test("a client can never inject possible matches: uncertainEvidence is on the client-untrusted strip list", () => {
  const forged = mkReport({ uncertainEvidence: UNCERTAIN });
  assert.equal("uncertainEvidence" in stripClientEvidenceInterpretation(forged), false);
  assert.equal("uncertainEvidence" in withEvidenceInterpretation(forged), false);
});

test("yellow runs never cover a verified word: split around red, clipped to the document, merged", () => {
  const report = mkReport({ uncertainEvidence: UNCERTAIN });
  const runs = resolveUncertainPassages(report);
  assert.deepEqual(runs.map((r) => [r.wordStart, r.wordEnd, r.reason]), [
    [71, 90, "SOURCE_TEXT_UNVERIFIED"],
    [200, 210, "NON_SCORING_EVIDENCE"],
    [590, 599, "SOURCE_TEXT_UNVERIFIED"],
  ]);
  const verified = new Set(report.archiveMatchedPositions);
  for (const r of runs) for (let w = r.wordStart; w <= r.wordEnd; w += 1) assert.equal(verified.has(w), false, `word ${w} is verified`);
  assert.equal(report.text.slice(runs[0].charStart, runs[0].charEnd), range(71, 90).map((i) => `word${i}`).join(" "));
  assert.deepEqual(resolveUncertainPassages(mkReport()), [], "no uncertainEvidence -> no runs");
});

test("shared highlighter (printed manuscript + legacy tab): red stays red and scoring, yellow is a separate never-overlapping kind", () => {
  const report = withV2(mkReport({ uncertainEvidence: UNCERTAIN }));
  const ranges = findHighlightRanges(report, { includeWikipedia: false });
  const red = ranges.filter((r) => r.kind !== "uncertain");
  const yellow = ranges.filter((r) => r.kind === "uncertain");
  assert.equal(yellow.length, 3);
  assert.ok(red.length > 0);
  for (const y of yellow) {
    assert.equal(y.color, "#f3d477");
    for (const r of red) assert.ok(y.end <= r.start || y.start >= r.end, "yellow never overlaps red");
  }
  const redPlain = findHighlightRanges(withV2(mkReport()), { includeWikipedia: false });
  assert.deepEqual(red, redPlain, "the red ranges are exactly what they were without possible matches");
});

test("browser workspace and printed (PDF) manuscript both show the same yellow runs with the explicit legend; red marks unchanged", () => {
  const report = withV2(mkReport({ uncertainEvidence: UNCERTAIN }));
  const yellowText = range(71, 90).map((i) => `word${i}`).join(" ");

  const screen = renderWorkspace(report);
  assert.match(screen, /class="rv2ws-mark-uncertain"/);
  assert.ok(screen.includes(`${yellowText}<span class="rv2-sr-only">`), "screen: the yellow run's own text");
  assert.ok(screen.includes(VERIFIED_MATCH_LEGEND) && screen.includes(UNCERTAIN_MATCH_LEGEND), "screen legend explains red and yellow");

  const pdf = renderPrintManuscript(report);
  assert.match(pdf, /submission-uncertain-match/);
  assert.ok(pdf.includes(`>${yellowText}<span`), "print: the same yellow run");
  assert.ok(pdf.includes(UNCERTAIN_MATCH_LEGEND), "print legend uses the same explicit copy");
  assert.match(pdf, /yellow marks possible matches that are not counted/);

  const screenYellow = (screen.match(/rv2ws-mark-uncertain/g) ?? []).length;
  const pdfYellow = (pdf.match(/submission-uncertain-match/g) ?? []).length;
  assert.equal(screenYellow, 3);
  assert.equal(pdfYellow, 3, "browser and PDF agree on the yellow runs");

  const plain = withV2(mkReport());
  assert.equal((screen.match(/class="rv2-mark /g) ?? []).length, (renderWorkspace(plain).match(/class="rv2-mark /g) ?? []).length, "same number of red marks");
});

test("an old report with no possible matches renders exactly as before — no yellow, no new legend", () => {
  const plain = withV2(mkReport());
  const empty = withV2(mkReport({ uncertainEvidence: { passages: [] } }));
  for (const [render, label] of [[renderWorkspace, "workspace"], [renderPrintManuscript, "print manuscript"], [renderPrintOverview, "print overview"]]) {
    const a = render(plain);
    const b = render(empty);
    assert.equal(b, a, `${label}: identical markup`);
    assert.doesNotMatch(a, /uncertain|Possible match|rv2-match-legend/, `${label}: nothing yellow`);
  }
  assert.match(renderPrintManuscript(plain), /Red marks the text contributing to the similarity result/, "legacy legend wording unchanged");
});
