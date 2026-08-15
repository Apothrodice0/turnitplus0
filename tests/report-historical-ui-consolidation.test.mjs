import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewReport } from '../components/report/similarity-report-papers.tsx';

/**
 * Phase E8G: the report previously rendered TWO overlapping historical-
 * submission sections — Phase D's "Submission history" (matchClassification)
 * and E8C/E8D's "Prior submission evidence" (historicalSubmissionMatch).
 * This phase consolidates them into one section ("Previously submitted
 * content"), sourced only from historicalSubmissionMatch — matchClassification
 * is still computed server-side (untouched, see app/reports/[id]/page.tsx)
 * but is no longer read by this component at all. These tests render
 * components/report/similarity-report-papers.tsx's OverviewReport via
 * react-dom/server (no jsdom needed — static markup only) and assert on
 * the resulting HTML.
 */

const repo = path.resolve('.');

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: 'sub-e8g-1',
    title: 'e8g-fixture.pdf',
    author: '',
    assignment: '',
    created: new Date().toISOString(),
    score: 12,
    archiveScore: 9,
    wordCount: 1500,
    characterCount: 8000,
    pageCount: 4,
    fileSize: '10 KB',
    databaseSize: 230,
    corpusVersion: 'archive-v1-230-test',
    scoreBand: 'Low',
    riskStatus: 'Lower',
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
      detectedLanguage: 'English',
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: 'fixture text not used by OverviewReport directly',
    ...overrides,
  };
}

function render(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}

const SELF_MATCH = {
  status: 'MATCHED',
  computedAt: new Date().toISOString(),
  matcherVersion: 'user-submission-match-v1',
  fingerprintVersion: 'corpus-shingle-v1',
  canonicalizationVersion: 'canonical-text-v1',
  matches: [
    {
      relationshipType: 'SELF',
      matchedRepresentationId: 'rep-self-1',
      matchType: 'EXACT_CANONICAL_MATCH',
      containment: 1,
      matchedWordCount: 1463,
      passageCount: 1,
      longestMatchWords: 1463,
      passages: [{ submittedText: 'a bounded excerpt of the current document only', submittedWordStart: 0, submittedWordEnd: 8, matchedWordCount: 8 }],
      historicalSubmissionCount: 0,
    },
  ],
};

const PRIOR_SUBMISSION_MATCH = {
  ...SELF_MATCH,
  matches: [{ ...SELF_MATCH.matches[0], relationshipType: 'PRIOR_SUBMISSION', historicalSubmissionCount: 1 }],
};

// --- A/B: single consolidated section for SELF and PRIOR_SUBMISSION --------

test('A: SELF renders exactly one historical section, with SELF-specific wording', () => {
  const html = render(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  const headingCount = (html.match(/Previously submitted content/g) || []).length;
  assert.equal(headingCount, 1, 'exactly one occurrence of the consolidated heading text');
  assert.match(html, /100%<\/strong> of this submission matches content you previously submitted to TurnitPlus/);
  assert.match(html, /1,463 matched words/);
  assert.doesNotMatch(html, /This submission overlaps with your own prior submission/, 'old SELF wording must be gone');
});

test('B: PRIOR_SUBMISSION renders exactly one historical section, with PRIOR_SUBMISSION-specific wording', () => {
  const html = render(baseReport({ historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH }));
  const headingCount = (html.match(/Previously submitted content/g) || []).length;
  assert.equal(headingCount, 1);
  assert.match(html, /100%<\/strong> of this submission matches content previously submitted to TurnitPlus/);
  assert.doesNotMatch(html, /you previously submitted to TurnitPlus/, 'PRIOR_SUBMISSION wording must not claim the viewer submitted it');
  assert.doesNotMatch(html, /Previously submitted content was found/, 'old PRIOR_SUBMISSION wording must be gone');
});

// --- C: NO_HISTORICAL_MATCH / absent -> no section at all ------------------

test('C: NO_HISTORICAL_MATCH and absent historicalSubmissionMatch both render no historical section', () => {
  const htmlNoMatch = render(baseReport({ historicalSubmissionMatch: { status: 'NO_HISTORICAL_MATCH', computedAt: new Date().toISOString(), matcherVersion: 'v', fingerprintVersion: 'v', canonicalizationVersion: 'v' } }));
  assert.doesNotMatch(htmlNoMatch, /Previously submitted content/);
  assert.doesNotMatch(htmlNoMatch, /historical-match-block/);

  const htmlAbsent = render(baseReport({}));
  assert.doesNotMatch(htmlAbsent, /Previously submitted content/);
  assert.doesNotMatch(htmlAbsent, /historical-match-block/);
});

test('UNAVAILABLE still renders its own single section, distinct from MATCHED', () => {
  const html = render(baseReport({ historicalSubmissionMatch: { status: 'UNAVAILABLE', computedAt: new Date().toISOString(), matcherVersion: 'v', fingerprintVersion: 'v', canonicalizationVersion: 'v' } }));
  const headingCount = (html.match(/Previously submitted content/g) || []).length;
  assert.equal(headingCount, 1);
  assert.match(html, /Historical matching unavailable for this report\./);
});

// --- D/E: archive overlap and score unaffected ------------------------------

test('D: Archive overlap value is unaffected by historicalSubmissionMatch presence or relationship type', () => {
  const withoutMatch = render(baseReport({ archiveScore: 42 }));
  const withSelfMatch = render(baseReport({ archiveScore: 42, historicalSubmissionMatch: SELF_MATCH }));
  const archiveLine = (html) => html.match(/<span>42%<\/span> Archive overlap/)?.[0];
  assert.ok(archiveLine(withoutMatch));
  assert.equal(archiveLine(withoutMatch), archiveLine(withSelfMatch), 'the Archive overlap heading must render identically regardless of historicalSubmissionMatch');
});

test('E: the rendered archive overlap figure equals report.archiveScore exactly (score fields untouched by this phase)', () => {
  const html = render(baseReport({ score: 12, archiveScore: 31, historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH }));
  assert.match(html, /<span>31%<\/span> Archive overlap/, 'must reflect archiveScore, not score, and must be exactly the saved value');
});

// --- F: no account identity leakage -----------------------------------------

test('F: no account identifier, email, or matchClassification content ever appears in the rendered output', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH,
    // A canary in matchClassification — if this component still read/rendered
    // matchClassification in any form, this would leak into the output.
    matchClassification: { selfMatchPercent: null, priorSubmissionPercent: 77 },
  }));
  assert.doesNotMatch(html, /Submission history/, 'the old Phase D section heading must never render');
  assert.doesNotMatch(html, /77/, 'matchClassification.priorSubmissionPercent must never be read by this component anymore');
  assert.doesNotMatch(html, /@/, 'no email-shaped string should ever appear in a report render');
  assert.doesNotMatch(html, /accountId|account_id/i);
});

// --- G: current-document-only passages --------------------------------------

test('G: passage text rendered is exactly the current document\'s own submittedText, never any other field', () => {
  const html = render(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  assert.match(html, /a bounded excerpt of the current document only/);
});

// --- H: no duplicate historical section, structurally ------------------------

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('H (structural): the component source no longer reads matchClassification or renders a "Submission history" heading', () => {
  // stripComments avoids the recurring self-referential false positive:
  // this component's own E8G explanatory comment mentions
  // "matchClassification" by name to describe why it's no longer read —
  // see every prior E7/E8 phase report for the same pattern.
  const source = stripComments(fs.readFileSync(path.join(repo, 'components/report/similarity-report-papers.tsx'), 'utf8'));
  assert.doesNotMatch(source, /matchClassification/, 'the component must not read matchClassification at all anymore');
  assert.doesNotMatch(source, /Submission history/, 'the old duplicate heading text must not exist in source');
  const headingOccurrences = (source.match(/Previously submitted content/g) || []).length;
  // Phase E8P.3 added a third branch (the allowlist-gated experimental
  // partial-match block) that reuses this exact same heading text rather
  // than introducing a second section — see components/report/similarity-report-papers.tsx's
  // own E8P.3 comment and tests/e8p-visibility.test.mjs's own dedicated
  // "reuses the existing heading" assertion.
  assert.equal(headingOccurrences, 3, 'exactly the UNAVAILABLE, MATCHED, and E8P.3-experimental branches should reference the one consolidated heading');
});

// --- I: receipt PDF unaffected -----------------------------------------------

test('I: lib/receipt-pdf.ts is untouched by this phase — no historical-match fields, no matchClassification reference', () => {
  const source = fs.readFileSync(path.join(repo, 'lib/receipt-pdf.ts'), 'utf8');
  assert.doesNotMatch(source, /historicalSubmissionMatch|matchClassification/, 'the lightweight receipt must remain unaware of either historical-match mechanism, exactly as before this phase');
});

// --- J: responsive-safe structure (best-effort — no jsdom/viewport test infrastructure exists in this repo) ---

test('J: the consolidated section uses plain semantic markup with no fixed-width inline styling that would break on mobile', () => {
  const html = render(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  const sectionMatch = html.match(/<section class="historical-match-block">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, 'the historical-match-block section must be present');
  assert.doesNotMatch(sectionMatch[0], /style="[^"]*width:\s*\d+px/, 'no fixed pixel width should be hardcoded into the historical section markup');
  assert.match(sectionMatch[0], /<h3>/, 'heading hierarchy (h3, matching this paper\'s other sections) must be preserved');
});
