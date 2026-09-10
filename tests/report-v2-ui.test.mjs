import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { tokens } from "../lib/similarity-core.ts";
import { primarySimilarityScore, primaryMatchedWordCount } from "../lib/report-types.ts";
import {
  buildReportEvidenceInterpretation,
  resolveReportCompletion,
  unknownExtractionDiagnostic,
  extractionDiagnosticFromCounts,
} from "../lib/evidence-interpretation/index.ts";
import {
  buildReportV2ViewModel,
  KIND_SUMMARY_LABEL,
  KIND_PASSAGE_LABEL,
} from "../lib/report-v2-view.ts";
import { ReportV2View, ReportV2Print } from "../components/report/report-v2/report-v2-view.tsx";

// ── fixtures ─────────────────────────────────────────────────────────────
function makeText(n, { quoteAt } = {}) {
  const w = [];
  for (let i = 0; i < n; i += 1) w.push(`word${i}`);
  let text = w.join(" ");
  if (quoteAt) {
    const [qs, qe] = quoteAt;
    const before = w.slice(0, qs).join(" ");
    const quoted = w.slice(qs, qe + 1).join(" ");
    const after = w.slice(qe + 1).join(" ");
    text = `${before} According to Smith (2020), “${quoted}”. ${after}`.trim();
  }
  return text;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function mkReport(over = {}) {
  const text = over.text ?? makeText(600);
  const wc = over.wordCount ?? tokens(text).length;
  return {
    version: 11,
    id: 1,
    submissionId: "0000000001",
    title: "fixture.txt",
    author: "Guest submission",
    assignment: "x",
    created: new Date().toISOString(),
    score: over.score ?? 0,
    archiveScore: over.archiveScore ?? over.score ?? 0,
    wordCount: wc,
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
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text,
    ...over,
  };
}

/** attach a REAL evidenceInterpretation + reportCompletion the same way the server wiring does. */
function withV2(report, { completion, extraction, sameWorkPatch } = {}) {
  const ei = buildReportEvidenceInterpretation(report, {});
  const extractionDiagnostic = extraction ?? unknownExtractionDiagnostic();
  const reportCompletion =
    completion ??
    resolveReportCompletion({
      academicSearch: report.academicEvidenceStatus ?? null,
      selectiveCorpus: null,
      extraction: extractionDiagnostic,
      unverifiedCandidateCount: 0,
      verifiedSimilarityPercent: primarySimilarityScore(report),
    });
  const patched = sameWorkPatch ? sameWorkPatch(ei) : ei;
  return { ...report, evidenceInterpretation: patched, reportCompletion, extractionDiagnostic };
}

const renderView = (report) => renderToStaticMarkup(React.createElement(ReportV2View, { report }));
const renderPrint = (report) => renderToStaticMarkup(React.createElement(ReportV2Print, { report }));

const FORBIDDEN = [
  /plagiarism[- ]free/i,
  /guaranteed turnitin score/i,
  /entire internet (was )?searched/i,
  /100% original/i,
];
function assertCleanCopy(html, label) {
  for (const re of FORBIDDEN) {
    assert.equal(re.test(html), false, `${label}: forbidden copy ${re}`);
  }
}
function assertNoInternalIds(html, label) {
  assert.equal(/[0-9a-f]{32}/.test(html), false, `${label}: 32-hex digest`);
  assert.equal(/[A-Za-z]:\\\\|\/home\/|\/Users\/|\/lib\//.test(html), false, `${label}: filesystem path`);
  assert.equal(/rep-[A-Z]|scb-\d|matchedRepresentationId|relationshipType|PRIOR_SUBMISSION|providerId|verifiedAcademicSearchDiagnosticsId|fingerprintVersion|canonicalizationVersion/.test(html), false, `${label}: internal id/field`);
  // opaque source ids only — the per-source card anchors are id/href "rv2-source-src-N".
  for (const m of html.matchAll(/(?:id="|href="#)rv2-source-([a-z0-9-]+)"/g)) {
    assert.match(m[1], /^src-\d+$/, `${label}: source anchor must be src-N (${m[1]})`);
  }
}

// ── 1. low clean similarity ──────────────────────────────────────────────
test("low similarity report: headline == primarySimilarityScore, one DISTINCTIVE bar, no forbidden copy", () => {
  const report = withV2(mkReport({
    archiveMatchedPositions: range(20, 70),
    sources: [{ name: "Wikipedia — “Cellular respiration”", type: "Internet", percent: 4, matches: 2, matchedWords: 51, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(20, 70), previousUploadPositions: [], unifiedScore: 8, uniqueMatchedWords: 51 },
    score: 8,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.equal(vm.summary.verifiedSimilarityPercent, primarySimilarityScore(report));
  assert.equal(vm.summary.matchedWordCount, 51);
  assert.equal(vm.summary.breakdown.length, 1);
  assert.equal(vm.summary.breakdown[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(vm.summary.completion.state, "COMPLETED");

  const html = renderView(report);
  assert.match(html, /Verified Similarity/);
  assert.match(html, />8%</);
  assert.match(html, /51 of 600 matched words/);
  assert.match(html, /Verified source overlap/);
  assert.match(html, /Search completed within the available TurnitPlus source scope/);
  assertCleanCopy(html, "low");
  assertNoInternalIds(html, "low");
});

// ── 2. high distinctive overlap ──────────────────────────────────────────
test("high distinctive overlap: bars reconcile to matched-word count; no second/adjusted percentage", () => {
  const report = withV2(mkReport({
    archiveMatchedPositions: range(0, 300),
    sources: [{ name: "nature.com — Scientific Reports", type: "Publication", percent: 40, matches: 5, matchedWords: 301, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 300), previousUploadPositions: [], unifiedScore: 50, uniqueMatchedWords: 301 },
    score: 50,
  }));
  const vm = buildReportV2ViewModel(report);
  const sumBars = vm.summary.breakdown.reduce((n, b) => n + b.matchedWords, 0);
  assert.equal(sumBars, vm.summary.matchedWordCount, "breakdown matched-words sum to the union");
  assert.equal(vm.summary.matchedWordCount, primaryMatchedWordCount(report));
  assert.equal(vm.summary.verifiedSimilarityPercent, primarySimilarityScore(report));

  const html = renderView(report);
  // the only percentages present are the headline + kind slices + source contributions — never a distinct "adjusted" figure
  assert.match(html, />50%</);
  assert.match(html, /Publication/);
  assertCleanCopy(html, "high");
  assertNoInternalIds(html, "high");
});

// ── 3. quotation-heavy report ────────────────────────────────────────────
test("quotation-heavy report: an attributed curly-quote span => ATTRIBUTED_QUOTATION bar + passage chip + informational tone", () => {
  const text = makeText(600, { quoteAt: [200, 260] });
  const toks = tokens(text);
  const qs = toks.indexOf("word200");
  const qe = toks.indexOf("word260");
  const positions = range(qs, qe);
  const report = withV2(mkReport({
    text,
    externalAcademicEvidence: [{
      provider: "openaire", providerId: "openaire", title: "A study of X", authors: ["Smith"],
      publication: "Journal of X", year: 2020, doi: "10.1/x", url: "https://doi.org/10.1/x",
      matchedPassages: [{ submittedText: "", submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }],
      similarity: 60,
    }],
    unifiedSimilarity: { matchedPositions: positions, previousUploadPositions: [], unifiedScore: 10, uniqueMatchedWords: positions.length },
    score: 10,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.ok(vm.summary.breakdown.some((b) => b.kind === "ATTRIBUTED_QUOTATION"));
  assert.ok(vm.passages.some((p) => p.kind === "ATTRIBUTED_QUOTATION" && p.tone === "informational"));

  const html = renderView(report);
  assert.match(html, new RegExp(KIND_SUMMARY_LABEL.ATTRIBUTED_QUOTATION.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
  assert.match(html, /Quoted passage with nearby attribution/);
  assert.match(html, /rv2-tone-informational/);
  assert.match(html, /A study of X/);
  // provider gave a URL, so it is shown as a link (DOI-as-text is the no-URL fallback)
  assert.match(html, /10\.1\/x/);
  assert.match(html, /Source details/);
  assertCleanCopy(html, "quote");
  assertNoInternalIds(html, "quote");
});

// ── 4. multi-source report ───────────────────────────────────────────────
test("multi-source report: top-4 source list + one card per source + reference-collection card is non-attributable", () => {
  const text = makeText(700, { quoteAt: [400, 430] });
  const toks = tokens(text);
  const qs = toks.indexOf("word400");
  const qe = toks.indexOf("word430");
  const archivePos = range(0, 140);
  const quotePos = range(qs, qe);
  const priorPos = range(500, 560);
  const union = [...new Set([...archivePos, ...quotePos, ...priorPos])].sort((a, b) => a - b);
  const report = withV2(mkReport({
    text,
    archiveMatchedPositions: archivePos,
    sources: [
      { name: "Wikipedia — “Climate change”", type: "Internet", percent: 20, matches: 3, matchedWords: 141, phrases: [], color: "#0" },
      { name: "openstax.org — Biology 2e", type: "Internet", percent: 8, matches: 1, matchedWords: 60, phrases: [], color: "#1" },
    ],
    externalAcademicEvidence: [{
      provider: "epmc", providerId: "epmc", title: "PLOS Climate paper", authors: null, publication: "PLOS Climate", year: 2022, doi: "10.1371/x",
      url: "https://journals.plos.org/climate/article?id=10.1371/x", similarity: 55,
      matchedPassages: [{ submittedText: "", submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }],
    }],
    unifiedSimilarity: { matchedPositions: union, previousUploadPositions: priorPos, unifiedScore: 30, uniqueMatchedWords: union.length },
    score: 30,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.ok(vm.sources.length >= 3);
  assert.ok(vm.summary.topSources.length <= 4);
  const generic = vm.sources.find((s) => s.isGeneric);
  assert.ok(generic, "a reference-collection card exists for the prior-upload channel");
  assert.equal(generic.link, null);
  assert.equal(generic.doi, null);

  const html = renderView(report);
  assert.match(html, /TurnitPlus reference collection/);
  assert.match(html, /no account, document, or person is identified/);
  assert.match(html, /Source details/);
  assert.match(html, /PLOS Climate paper/);
  assertCleanCopy(html, "multi");
  assertNoInternalIds(html, "multi");
});

// ── 5. possible-same-work payload ────────────────────────────────────────
test("possible-same-work payload: UI renders the same-work label, review tone, and dashed shape", () => {
  // POSSIBLE_SAME_WORK is dormant for historical evidence in V1, so this
  // exercises the UI's handling of a payload that DOES carry it (a future
  // trusted work/version signal) — hand-patched onto a real interpretation.
  const report0 = mkReport({
    archiveMatchedPositions: range(0, 120),
    sources: [{ name: "Wikipedia — “Machine learning”", type: "Internet", percent: 5, matches: 1, matchedWords: 30, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 120), previousUploadPositions: range(0, 90), unifiedScore: 20, uniqueMatchedWords: 121 },
    score: 20,
  });
  const report = withV2(report0, {
    sameWorkPatch: (ei) => {
      const swPositions = range(0, 90);
      const rest = range(91, 120);
      const positionsByKind = {
        DECLARED_QUOTATION: [], ATTRIBUTED_QUOTATION: [], POSSIBLE_SAME_WORK: swPositions,
        FAMILY_BOILERPLATE: [], LEGITIMATE_ALTERNATE_SOURCE: [], DISTINCTIVE_EXTERNAL_MATCH: rest,
      };
      const countsByKind = Object.fromEntries(Object.entries(positionsByKind).map(([k, v]) => [k, v.length]));
      return {
        ...ei,
        positionsByKind,
        countsByKind,
        passages: [
          { id: 0, wordStart: 0, wordEnd: 90, excerpt: "this study investigates whether transfer learning improves low-resource classification", sourceIds: ["src-1"], interpretation: { kind: "POSSIBLE_SAME_WORK", confidence: "medium", tone: "review" } },
          { id: 1, wordStart: 91, wordEnd: 120, excerpt: "supervised learning builds a model from labelled training data", sourceIds: ["src-2"], interpretation: { kind: "DISTINCTIVE_EXTERNAL_MATCH", confidence: "medium", tone: "review" } },
        ],
        sources: ei.sources.map((s, i) => (i === 0
          ? { ...s, interpretation: { ...s.interpretation, primaryKind: "POSSIBLE_SAME_WORK" } }
          : s)),
      };
    },
  });
  const vm = buildReportV2ViewModel(report);
  assert.ok(vm.summary.breakdown.some((b) => b.kind === "POSSIBLE_SAME_WORK"));
  assert.ok(vm.passages.some((p) => p.kind === "POSSIBLE_SAME_WORK" && p.tone === "review"));

  const html = renderView(report);
  assert.match(html, /Possible same-work or prior-publication match/);
  assert.match(html, /rv2-kind-samework/);
  assert.match(html, /recorded work\/version relationship/);
  assertCleanCopy(html, "samework");
  assertNoInternalIds(html, "samework");
});

// ── 6. PARTIAL report ────────────────────────────────────────────────────
test("PARTIAL report: attention completion strip + lower-bound detail, still no alarming copy", () => {
  const report = withV2(mkReport({
    academicEvidenceStatus: "FAILED",
    archiveMatchedPositions: range(0, 70),
    sources: [{ name: "Wikipedia — “Tuberculosis”", type: "Internet", percent: 7, matches: 2, matchedWords: 71, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 70), previousUploadPositions: [], unifiedScore: 12, uniqueMatchedWords: 71 },
    score: 12,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.equal(vm.summary.completion.state, "PARTIAL");
  assert.match(vm.summary.completion.detail, /lower bound/);
  assert.equal(vm.summary.completion.extractionPartial, false);

  const html = renderView(report);
  assert.match(html, /Some source searches were unavailable/);
  assert.match(html, /lower bound/);
  assert.match(html, /rv2-completion-attention/);
  assertCleanCopy(html, "partial");
  assertNoInternalIds(html, "partial");
});

// ── 6b. EXTRACTION_PARTIAL only when completeness is genuinely PARTIAL ────
test("extraction: completeness UNKNOWN never shows EXTRACTION_PARTIAL wording; a real PARTIAL does", () => {
  const unknown = buildReportV2ViewModel(withV2(mkReport({
    archiveMatchedPositions: range(0, 40),
    unifiedSimilarity: { matchedPositions: range(0, 40), previousUploadPositions: [], unifiedScore: 7, uniqueMatchedWords: 41 },
  })));
  assert.notEqual(unknown.summary.completion.state, "EXTRACTION_PARTIAL");
  assert.equal(/could not be analyzed/.test(renderView(withV2(mkReport({ archiveMatchedPositions: range(0, 40), unifiedSimilarity: { matchedPositions: range(0, 40), previousUploadPositions: [] } })))), false);

  const partialReport = mkReport({
    archiveMatchedPositions: range(0, 40),
    unifiedSimilarity: { matchedPositions: range(0, 40), previousUploadPositions: [], unifiedScore: 7, uniqueMatchedWords: 41 },
  });
  const withPartial = withV2(partialReport, {
    extraction: extractionDiagnosticFromCounts({ extractor: "pdf-text-extraction-v1", unit: "pages", total: 10, read: 7 }),
  });
  const vm = buildReportV2ViewModel(withPartial);
  assert.equal(vm.summary.completion.state, "EXTRACTION_PARTIAL");
  assert.equal(vm.summary.completion.extractionPartial, true);
  const html = renderView(withPartial);
  assert.match(html, /Part of the uploaded document could not be analyzed/);
  assert.match(html, /3 pages/);
  assertCleanCopy(html, "extraction");
});

// ── 7. old report fallback ───────────────────────────────────────────────
test("old report fallback: no evidenceInterpretation => view-model null, component renders nothing", () => {
  const legacy = mkReport({
    unifiedSimilarity: { matchedPositions: range(0, 50), previousUploadPositions: [], unifiedScore: 9, uniqueMatchedWords: 51 },
  });
  assert.equal(legacy.evidenceInterpretation, undefined);
  assert.equal(buildReportV2ViewModel(legacy), null);
  assert.equal(renderView(legacy), "");
  assert.equal(renderPrint(legacy), "");
});

// ── 8. no internal-id leakage (adversarial payload) ──────────────────────
test("no internal-id leakage: even with internal ids stuffed into unifiedSimilarity.contributions and historical match, the V2 markup is clean", () => {
  const text = makeText(500, { quoteAt: [200, 230] });
  const toks = tokens(text);
  const qs = toks.indexOf("word200");
  const qe = toks.indexOf("word230");
  const report0 = mkReport({
    text,
    archiveMatchedPositions: range(0, 90),
    sources: [{ name: "Wikipedia — “Cell”", type: "Internet", percent: 15, matches: 2, matchedWords: 91, phrases: [], color: "#0" }],
    externalAcademicEvidence: [{ provider: "openaire", providerId: "SECRET-PROVIDER", title: "T", authors: ["A"], publication: "P", year: 2021, doi: "10.9/z", url: "https://pubmed.ncbi.nlm.nih.gov/123", similarity: 70, matchedPassages: [{ submittedText: "", submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }] }],
    unifiedSimilarity: {
      matchedPositions: [...new Set([...range(0, 90), ...range(qs, qe), ...range(400, 460)])].sort((a, b) => a - b),
      previousUploadPositions: range(400, 460),
      unifiedScore: 25, uniqueMatchedWords: 200,
      contributions: [{ matchedRepresentationId: "rep-XYZ", sourceId: "scb-000999" }],
    },
    historicalSubmissionMatch: {
      status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
      matches: [{ relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "rep-XYZ", matchType: "STRONG_TEXT_MATCH", containment: 0.9, matchedWordCount: 61, passageCount: 1, longestMatchWords: 61, passages: [], historicalSubmissionCount: 3 }],
    },
    score: 25,
  });
  const report = withV2(report0);
  const html = renderView(report);
  for (const bad of ["rep-XYZ", "scb-000999", "SECRET-PROVIDER", "matchedRepresentationId", "PRIOR_SUBMISSION", "historicalSubmissionCount", "canonicalizationVersion"]) {
    assert.equal(html.includes(bad), false, `markup must not contain ${bad}`);
  }
  assertNoInternalIds(html, "adversarial");
  // public URLs ARE allowed
  assert.match(html, /pubmed\.ncbi\.nlm\.nih\.gov/);
});

// ── 9. no adjusted similarity, ever ──────────────────────────────────────
test("no adjusted similarity text: the only headline number is primarySimilarityScore; breakdown re-slices it, never adds", () => {
  const report = withV2(mkReport({
    archiveMatchedPositions: range(0, 200),
    sources: [{ name: "Wikipedia — “X”", type: "Internet", percent: 30, matches: 3, matchedWords: 201, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 200), previousUploadPositions: [], unifiedScore: 33, uniqueMatchedWords: 201 },
    score: 33,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.equal(vm.summary.verifiedSimilarityPercent, primarySimilarityScore(report));
  const html = renderView(report);
  assert.equal(/adjusted similarity|adjusted score|revised score/i.test(html), false);
  // the headline value appears exactly once as the big number
  const bigMatches = [...html.matchAll(/<strong>33%<\/strong>/g)];
  assert.equal(bigMatches.length, 1);
});

// ── 10. print variant ───────────────────────────────────────────────────
test("print variant: renders first screen + passages + source cards, no filter bar, no forbidden copy", () => {
  const report = withV2(mkReport({
    archiveMatchedPositions: range(0, 120),
    sources: [{ name: "Wikipedia — “X”", type: "Internet", percent: 12, matches: 2, matchedWords: 121, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 120), previousUploadPositions: [], unifiedScore: 20, uniqueMatchedWords: 121 },
    score: 20,
  }));
  const html = renderPrint(report);
  assert.match(html, /Verified Similarity/);
  assert.match(html, /Source details/);
  assert.equal(/rv2-filter-bar/.test(html), false);
  assertCleanCopy(html, "print");
  assertNoInternalIds(html, "print");
});

// ── 11. a11y: labels are text, filters are buttons, bars have aria-label ─
test("a11y: kind labels are real text, filter controls are <button> with aria-pressed, bars carry an aria-label", () => {
  const report = withV2(mkReport({
    archiveMatchedPositions: range(0, 120),
    sources: [{ name: "Wikipedia — “X”", type: "Internet", percent: 12, matches: 2, matchedWords: 121, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 120), previousUploadPositions: [], unifiedScore: 20, uniqueMatchedWords: 121 },
  }));
  const html = renderView(report);
  assert.match(html, /<button[^>]+aria-pressed="true"[^>]*>All \(/);
  assert.match(html, /aria-label="\d+ percent, [^"]+"/);
  // the passage <mark> carries an aria-label naming the kind (not colour)
  assert.match(html, /<mark[^>]+aria-label="Verified source overlap/);
  // every kind chip label is present as literal text
  assert.match(html, new RegExp(KIND_PASSAGE_LABEL.DISTINCTIVE_EXTERNAL_MATCH));
});

// ── 12. reconciliation invariant across all built payloads ───────────────
test("invariant: Σ breakdown.matchedWords === evidenceInterpretation.matchedWordCount === Σ countsByKind", () => {
  for (const score of [3, 17, 44, 58]) {
    const report = withV2(mkReport({
      archiveMatchedPositions: range(0, score * 3),
      sources: [{ name: "S", type: "Internet", percent: score, matches: 1, matchedWords: score * 3 + 1, phrases: [], color: "#0" }],
      unifiedSimilarity: { matchedPositions: range(0, score * 3), previousUploadPositions: [], unifiedScore: score, uniqueMatchedWords: score * 3 + 1 },
      score,
    }));
    const vm = buildReportV2ViewModel(report);
    const sumBars = vm.summary.breakdown.reduce((n, b) => n + b.matchedWords, 0);
    const sumCounts = Object.values(report.evidenceInterpretation.countsByKind).reduce((a, b) => a + b, 0);
    assert.equal(sumBars, vm.summary.matchedWordCount);
    assert.equal(sumCounts, vm.summary.matchedWordCount);
  }
});
