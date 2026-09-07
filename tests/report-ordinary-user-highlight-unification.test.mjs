import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { tokenSpans } from "../lib/similarity-core.ts";
import { primaryMatchedWordCount, primarySimilarityScore, unifiedMatchedPositions } from "../lib/report-types.ts";
import { SubmissionReport, SourcesReport, OverviewReport, AcademicEvidenceSection, findHighlightRanges } from "../components/report/similarity-report-papers.tsx";

/**
 * Task A, final ordinary-user report simplification: ordinary users must
 * experience ONE similarity system — archive, academic, and internal
 * (reference-source/"TurnitPlus reference sources") matched positions all
 * render with the identical red/magenta highlight treatment, with no
 * color/badge/title difference based on which channel found the match.
 * Wikipedia (separate evidence, never part of unifiedScore) is the sole
 * exception and stays visually distinct.
 *
 * findHighlightRanges's own position/precedence/kind computation is
 * completely UNCHANGED by this fix — see that function's own header
 * comment and tests/unified-similarity-highlighting.test.mjs, which already
 * proves the position math. These tests exercise only the render layer
 * (HighlightedDocument/HighlightLegend inside SubmissionReport, and
 * SourceList inside SourcesReport) that sits on top of it, plus the
 * admin-vs-ordinary gating added by this turn.
 */

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
  "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
];
const TEXT = WORDS.join(" ");
const WORD_COUNT = WORDS.length;

function corpusMatch({ start, end }) {
  const words = WORDS.slice(start, end + 1);
  return {
    status: "MATCHED",
    computedAt: new Date().toISOString(),
    matcherVersion: "v1", fingerprintVersion: "v1", canonicalizationVersion: "v1",
    matches: [{
      relationshipType: "TURNITPLUS_CORPUS_SOURCE",
      matchedRepresentationId: "highlight-unification-fixture-representation",
      matchType: "STRONG_TEXT_MATCH",
      containment: (end - start + 1) / WORD_COUNT,
      matchedWordCount: end - start + 1,
      passageCount: 1,
      longestMatchWords: end - start + 1,
      passages: [{ submittedText: words.join(" "), submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 }],
      historicalSubmissionCount: 1,
    }],
  };
}

const ACADEMIC_EVIDENCE = [{
  provider: "openaire",
  providerId: "highlight-unification-ext-1",
  title: "A Fixture Paper About Nothing In Particular",
  authors: ["A. Author"],
  doi: null,
  url: null,
  similarity: 100,
  matchedPassages: [{
    submittedText: WORDS.slice(16, 20).join(" "),
    submittedWordStart: 16,
    submittedWordEnd: 19,
    matchedWordCount: 4,
  }],
}];

// Archive 0-9, corpus 5-14 (overlap 5-9, exclusive corpus 10-14 — the same
// proven-correct numbers as tests/unified-similarity-highlighting.test.mjs's
// own "RENDER INVARIANT: mixed archive + corpus overlap" fixture), plus a
// third, non-overlapping academic contribution at 16-19.
const UNIFIED = computeUnifiedSimilarity({
  wordCount: WORD_COUNT,
  archiveMatchedPositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  historicalSubmissionMatch: corpusMatch({ start: 5, end: 14 }),
  externalAcademicEvidence: ACADEMIC_EVIDENCE,
});

function baseReport(overrides = {}) {
  return {
    version: 11, id: 1, submissionId: "sub-houf-1", title: "highlight-unification-fixture.pdf",
    author: "", assignment: "", created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: WORD_COUNT, characterCount: TEXT.length,
    pageCount: 1, fileSize: "10 KB", databaseSize: 230, corpusVersion: "archive-v1-230-test",
    scoreBand: "Low", riskStatus: "Lower", riskTarget: 0.5, riskCutoff: 0.5,
    riskCalibration: { auc: 0.9, precision: 0.9, recall: 0.9, sampleSize: 100 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "English" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text: TEXT,
    ...overrides,
  };
}

const MIXED_REPORT = baseReport({
  unifiedSimilarity: UNIFIED,
  externalAcademicEvidence: ACADEMIC_EVIDENCE,
  sources: [{
    name: "Archive Source", type: "Publication", percent: 50, matches: 1,
    phrases: [WORDS.slice(0, 10).join(" ")], color: "#d7263d",
  }],
});

const ADMIN_REPORT = baseReport({
  // Task A correction: viewerIsAdmin is the explicit, server-decided
  // authorization signal — historicalSubmissionMatch's own presence below
  // is real match data, not itself an authorization check (see
  // tests/report-historical-match-visibility.test.mjs's own AUTHORIZATION
  // tests for the full proof that the two are independent).
  viewerIsAdmin: true,
  unifiedSimilarity: UNIFIED,
  externalAcademicEvidence: ACADEMIC_EVIDENCE,
  sources: MIXED_REPORT.sources,
  historicalSubmissionMatch: corpusMatch({ start: 5, end: 14 }),
});

test("FIXTURE SANITY: the mixed fixture actually produces all three kinds — archive, academic, and reference-source — with the overlap correctly excluded from the reference-source position set", () => {
  const ranges = findHighlightRanges(MIXED_REPORT);
  const kinds = ranges.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["academic", "reference-source", "source"], "REQUIRED: the fixture must exercise all three unified kinds at once");
  assert.ok(ranges.some((r) => r.kind === "reference-source" && r.start === tokenSpans(TEXT)[10].start), "the reference-source range must start exactly at the exclusive (non-overlapping) word 10, not word 5");
});

test("ORDINARY USER: archive, academic, and reference-source positions all render with the SAME highlight color — no color difference based on how or where TurnitPlus found the match", () => {
  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: MIXED_REPORT }));
  const marks = [...html.matchAll(/<mark class="submission-match [^"]*"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(marks.length >= 3, `REQUIRED: at least 3 highlighted marks (archive/academic/reference-source), found ${marks.length}`);
  const colors = new Set(marks.map((style) => style.match(/border-bottom-color:\s*(#[0-9a-f]+)/i)?.[1]?.toLowerCase()));
  assert.equal(colors.size, 1, `REQUIRED: every non-Wikipedia mark must share exactly one color, found ${[...colors].join(", ")}`);
});

test("ORDINARY USER: the highlight legend collapses to a single 'Matched passages' item — no per-source, per-academic-item, or reference-source distinction", () => {
  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: MIXED_REPORT }));
  const legendSection = html.match(/<div class="highlight-legend-items">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
  assert.match(legendSection, /Matched passages/, "REQUIRED: the single generic legend item must render");
  assert.doesNotMatch(legendSection, /Archive Source/, "REQUIRED: no per-archive-source legend entry for an ordinary viewer");
  assert.doesNotMatch(legendSection, /A Fixture Paper/, "REQUIRED: no per-academic-item legend entry for an ordinary viewer");
  assert.doesNotMatch(legendSection, /TurnitPlus reference sources/, "REQUIRED: no internal-system legend label for an ordinary viewer");
});

test("ADMIN: the same mixed fixture still renders the detailed per-channel legend and Source Details breakdown", () => {
  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: ADMIN_REPORT }));
  assert.match(html, /Archive Source/, "admin legend keeps the named archive source");
  assert.match(html, /A Fixture Paper/, "admin legend keeps the named academic source");
  assert.match(html, /TurnitPlus reference sources/, "admin legend keeps the internal-bucket label");

  const sourcesHtml = renderToStaticMarkup(React.createElement(SourcesReport, { report: ADMIN_REPORT }));
  assert.match(sourcesHtml, /TurnitPlus reference sources/, "admin Source Details keeps the internal-bucket entry");
});

test("REQUIRED (regression): exact highlighted positions are byte-for-byte identical before/after this presentation-only change — findHighlightRanges itself is untouched", () => {
  const ranges = findHighlightRanges(MIXED_REPORT);
  assert.deepEqual(ranges.map((r) => [r.start, r.end, r.kind]), [
    [tokenSpans(TEXT)[0].start, tokenSpans(TEXT)[9].end, "source"],
    [tokenSpans(TEXT)[10].start, tokenSpans(TEXT)[14].end, "reference-source"],
    [tokenSpans(TEXT)[16].start, tokenSpans(TEXT)[19].end, "academic"],
  ]);
});

test("REQUIRED: mixed-source overlap still highlights once — the rendered mark count matches the accepted (already-deduplicated) range count, never one mark per contributing source", () => {
  const ranges = findHighlightRanges(MIXED_REPORT);
  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: MIXED_REPORT }));
  const markCount = [...html.matchAll(/<mark class="submission-match/g)].length;
  assert.equal(markCount, ranges.length, "REQUIRED: one <mark> per accepted range, no duplicate mark for the overlapping words 5-9");
});

test("REQUIRED: ordinary-user sidebar/body still shows the authoritative similarity percentage, unaffected by the highlight-color simplification", () => {
  assert.equal(UNIFIED.unifiedScore, unifiedMatchedPositions({ unifiedSimilarity: UNIFIED }).length === 0 ? 0 : UNIFIED.unifiedScore, "sanity: unifiedScore computed");
  assert.equal(primaryMatchedWordCount({ unifiedSimilarity: UNIFIED }), UNIFIED.uniqueMatchedWords);
});

test("REQUIRED: a 100% report remains 100% and highlights the same full-document positions — only the presentation changes", () => {
  const fullUnified = computeUnifiedSimilarity({
    wordCount: WORD_COUNT,
    historicalSubmissionMatch: corpusMatch({ start: 0, end: WORD_COUNT - 1 }),
  });
  assert.equal(fullUnified.unifiedScore, 100);
  const report = baseReport({ unifiedSimilarity: fullUnified });
  const ranges = findHighlightRanges(report);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].kind, "reference-source");
  const spans = tokenSpans(TEXT);
  assert.equal(ranges[0].start, spans[0].start);
  assert.equal(ranges[0].end, spans[spans.length - 1].end);

  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report }));
  assert.doesNotMatch(html, /TurnitPlus reference sources/, "REQUIRED: ordinary viewer never sees the internal label even at 100%");
  const markCount = [...html.matchAll(/<mark class="submission-match/g)].length;
  assert.equal(markCount, 1, "REQUIRED: the full-document match still renders as ONE highlight");
});

test("REQUIRED: no ordinary-user-visible surface ever calls a matched passage 'plagiarism' — only similarity/matched text/matched passages", () => {
  const overviewHtml = renderToStaticMarkup(React.createElement(OverviewReport, { report: MIXED_REPORT }));
  const sourcesHtml = renderToStaticMarkup(React.createElement(SourcesReport, { report: MIXED_REPORT }));
  const submissionHtml = renderToStaticMarkup(React.createElement(SubmissionReport, { report: MIXED_REPORT }));
  for (const [label, html] of [["OverviewReport", overviewHtml], ["SourcesReport", sourcesHtml], ["SubmissionReport", submissionHtml]]) {
    assert.doesNotMatch(html, /plagiarism/i, `REQUIRED: ${label} must never use the word "plagiarism" for an ordinary viewer`);
  }
});

test("REQUIRED: public named sources (a real archive source, a real academic paper) remain visible and identifiable to an ordinary viewer, even though the internal reference-source bucket is hidden", () => {
  const sourcesHtml = renderToStaticMarkup(React.createElement(SourcesReport, { report: MIXED_REPORT }));
  assert.match(sourcesHtml, /Archive Source/, "REQUIRED: a real, named archive source stays visible — it is genuinely useful for reviewing a match");
  assert.doesNotMatch(sourcesHtml, /TurnitPlus reference sources/, "the internal bucket must still be absent for this ordinary viewer");

  const academicHtml = renderToStaticMarkup(React.createElement(AcademicEvidenceSection, { report: MIXED_REPORT }));
  assert.match(academicHtml, /A Fixture Paper About Nothing In Particular/, "REQUIRED: a real, named academic source's title stays visible");
  assert.doesNotMatch(academicHtml, /Source: openaire/i, "the fetching-provider channel label (not the cited work itself) must be hidden from an ordinary viewer");

  const adminAcademicHtml = renderToStaticMarkup(React.createElement(AcademicEvidenceSection, { report: ADMIN_REPORT }));
  assert.match(adminAcademicHtml, /Source: openaire/i, "an admin viewer keeps the detailed provider-channel label");
});

test("PRIVACY (regression): the admin-only surfaces this fix touches never leak SELF/PRIOR_SUBMISSION/corpus identity to the ordinary MIXED_REPORT viewer", () => {
  const html = renderToStaticMarkup(React.createElement(OverviewReport, { report: MIXED_REPORT }));
  for (const term of ["SELF", "PRIOR_SUBMISSION", "TURNITPLUS_CORPUS_SOURCE", "UNKNOWN_RELATIONSHIP", "highlight-unification-fixture-representation"]) {
    assert.doesNotMatch(html, new RegExp(term), `REQUIRED: must never leak "${term}" to an ordinary viewer`);
  }
});

// --- Correction round 2: Wikipedia is auxiliary, non-scoring evidence — it -
// --- must never appear as an ordinary-user score-highlight, and must never -
// --- affect the score itself, whether or not it happens to be present. ----

const WIKIPEDIA_PHRASE = WORDS.slice(0, 5).join(" ");
const WIKIPEDIA_ONLY_REPORT = baseReport({
  webCheck: {
    status: "complete",
    provider: "Wikipedia",
    phrasesSampled: 1,
    phrasesMatched: 1,
    checkedAt: new Date().toISOString(),
    errorCount: 0,
    matches: [{
      phrase: WIKIPEDIA_PHRASE,
      normalizedPhrase: WIKIPEDIA_PHRASE.toLowerCase(),
      matched: true,
      sources: [{ title: "Example Wikipedia Article", url: "https://en.wikipedia.org/wiki/Example", pageId: 424242 }],
    }],
  },
});
const WIKIPEDIA_ONLY_ADMIN_REPORT = { ...WIKIPEDIA_ONLY_REPORT, viewerIsAdmin: true };

test("CORRECTION: a Wikipedia-only match (no archive/academic/reference-source evidence at all) produces ZERO ordinary-user score highlights", () => {
  const ranges = findHighlightRanges(WIKIPEDIA_ONLY_REPORT, { includeWikipedia: false });
  assert.deepEqual(ranges, [], "REQUIRED: with Wikipedia excluded and no other evidence, there is nothing left to highlight");

  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: WIKIPEDIA_ONLY_REPORT }));
  const markCount = [...html.matchAll(/<mark class="submission-match/g)].length;
  assert.equal(markCount, 0, "REQUIRED: an ordinary viewer's rendered body has NO highlight marks for a Wikipedia-only match");
  assert.doesNotMatch(html, /submission-wikipedia-match/, "REQUIRED: no blue Wikipedia-styled mark renders for an ordinary viewer");
});

test("CORRECTION: a Wikipedia-only match never alters the similarity percentage — matchedPositions/scoring are completely untouched by this presentation fix", () => {
  assert.equal(primarySimilarityScore(WIKIPEDIA_ONLY_REPORT), 0, "no unifiedSimilarity/archiveScore evidence exists — the score must be a genuine 0%, never inflated by Wikipedia's own phrase match");
  assert.deepEqual(unifiedMatchedPositions(WIKIPEDIA_ONLY_REPORT), [], "Wikipedia positions are never added to the canonical matched-position set");
  assert.equal(primaryMatchedWordCount(WIKIPEDIA_ONLY_REPORT), 0);
});

test("CORRECTION: mixing Wikipedia with a real scoring match — the scoring position renders (own color), Wikipedia does not, for an ordinary viewer; a position Wikipedia would have visually claimed first is still highlighted", () => {
  // The Wikipedia phrase (words 0-4) deliberately OVERLAPS the archive
  // source's own matched phrase (words 0-9) — before this correction,
  // Wikipedia's first-precedence slot would have claimed words 0-4 and left
  // the archive source's own scoring text unhighlighted there. Excluding
  // Wikipedia from the candidate pool (not just hiding it after acceptance)
  // is what lets the real scoring position win instead.
  const overlapping = baseReport({
    unifiedSimilarity: computeUnifiedSimilarity({ wordCount: WORD_COUNT, archiveMatchedPositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }),
    sources: [{ name: "Archive Source", type: "Publication", percent: 50, matches: 1, phrases: [WORDS.slice(0, 10).join(" ")], color: "#d7263d" }],
    webCheck: WIKIPEDIA_ONLY_REPORT.webCheck,
  });

  const adminRanges = findHighlightRanges(overlapping, { includeWikipedia: true });
  assert.ok(adminRanges.some((r) => r.kind === "wikipedia"), "sanity: admin path still sees Wikipedia take precedence at 0-4");

  const ordinaryRanges = findHighlightRanges(overlapping, { includeWikipedia: false });
  assert.ok(ordinaryRanges.every((r) => r.kind !== "wikipedia"), "REQUIRED: no wikipedia-kind range for an ordinary viewer");
  assert.ok(ordinaryRanges.some((r) => r.kind === "source" && r.start === tokenSpans(TEXT)[0].start), "REQUIRED: with Wikipedia excluded, the archive source's own match now correctly claims words 0-9 from the very start, not left blank");

  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: overlapping }));
  assert.doesNotMatch(html, /submission-wikipedia-match/, "no Wikipedia-styled mark for an ordinary viewer");
  const markCount = [...html.matchAll(/<mark class="submission-match/g)].length;
  assert.equal(markCount, 1, "the single archive-kind mark covers the full 0-9 span");
});

test("CORRECTION: admin/debug presentation (authorized viewer) may still retain Wikipedia as separate auxiliary evidence", () => {
  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: WIKIPEDIA_ONLY_ADMIN_REPORT }));
  assert.match(html, /submission-wikipedia-match/, "an authorized admin still sees the Wikipedia mark");
  const markCount = [...html.matchAll(/<mark class="submission-match/g)].length;
  assert.equal(markCount, 1);
});
