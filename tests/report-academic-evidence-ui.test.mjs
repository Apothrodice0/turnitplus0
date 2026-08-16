import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcademicEvidenceSection, OverviewReport, dedupeExternalAcademicEvidence } from '../components/report/similarity-report-papers.tsx';

/**
 * Phase 3 STEP 9: report/UI integration tests for the "External Academic
 * Sources" section. Same no-jsdom, renderToStaticMarkup convention as
 * tests/e8s-report-ui.test.mjs — see that file's own header comment for why
 * (this repo has no jsdom/click-simulation infrastructure; nothing here
 * needs one, since the section is pure presentational, driven entirely by
 * report.externalAcademicEvidence).
 */

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: 'sub-p3-1',
    title: 'phase3-fixture.pdf',
    author: '',
    assignment: '',
    created: new Date().toISOString(),
    score: 24,
    archiveScore: 24,
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

function evidenceItem(overrides = {}) {
  return {
    provider: 'openaire',
    providerId: 'ext-1',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    publication: 'NeurIPS',
    year: 2017,
    doi: '10.48550/arxiv.1706.03762',
    url: 'https://arxiv.org/abs/1706.03762',
    matchedPassages: [{ submittedText: 'The Transformer is based solely on attention mechanisms.', submittedWordStart: 0, submittedWordEnd: 9, matchedWordCount: 9 }],
    similarity: 97,
    ...overrides,
  };
}

function renderOverview(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}
function renderSection(report) {
  return renderToStaticMarkup(React.createElement(AcademicEvidenceSection, { report }));
}

// --- 1: no external evidence -> existing report unchanged -----------------

test('1: a report with no externalAcademicEvidence field renders no academic-evidence section at all', () => {
  const html = renderOverview(baseReport());
  assert.doesNotMatch(html, /External Academic Sources/);
  assert.doesNotMatch(html, /academic-evidence-block/);
});

test('1b: an explicit empty array also renders nothing (not an empty shell)', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [] }));
  assert.doesNotMatch(html, /External Academic Sources/);
  assert.equal(renderSection(baseReport({ externalAcademicEvidence: [] })), '');
});

// --- 2: one external source -> section renders -----------------------------

test('2: a report with one external source renders the section with its title and overlap', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem()] }));
  assert.match(html, /External Academic Sources/);
  assert.match(html, /Attention Is All You Need/);
  assert.match(html, /97% passage overlap/);
  assert.match(html, /Potential match/);
  assert.doesNotMatch(html, /Plagiarism Score/i, 'must never be labeled as a score');
});

// --- 3: multiple external sources -> all render -----------------------------

test('3: three distinct external sources all render as separate cards', () => {
  const items = [
    evidenceItem({ providerId: 'a-1', doi: '10.1/a', title: 'Paper A' }),
    evidenceItem({ providerId: 'b-1', doi: '10.1/b', title: 'Paper B' }),
    evidenceItem({ providerId: 'c-1', doi: '10.1/c', title: 'Paper C' }),
  ];
  const html = renderOverview(baseReport({ externalAcademicEvidence: items }));
  assert.match(html, /Paper A/);
  assert.match(html, /Paper B/);
  assert.match(html, /Paper C/);
  assert.match(html, /3 potential external academic sources/);
});

// --- 4: duplicate DOI from two providers -> one source only ----------------

test('4: two evidence entries sharing a DOI (one from each provider) render as ONE card', () => {
  const items = [
    evidenceItem({ provider: 'openaire', providerId: 'openaire-1', doi: '10.9/shared', title: 'Shared Work' }),
    evidenceItem({ provider: 'europe-pmc', providerId: 'PMC12345', doi: '10.9/SHARED', title: 'Shared Work' }),
  ];
  const deduped = dedupeExternalAcademicEvidence(items);
  assert.equal(deduped.length, 1, 'DOI comparison must be case-insensitive, matching the orchestrator\'s own normalization');

  const html = renderOverview(baseReport({ externalAcademicEvidence: items }));
  const occurrences = html.match(/Shared Work/g) ?? [];
  assert.equal(occurrences.length, 1);
  assert.match(html, /1 potential external academic source[^s]/, 'singular wording for exactly one deduped source');
});

test('4b: two entries with no DOI but the same URL still dedupe to one', () => {
  const items = [
    evidenceItem({ provider: 'openaire', providerId: 'x-1', doi: null, url: 'https://example.test/paper', title: 'No-DOI Work' }),
    evidenceItem({ provider: 'europe-pmc', providerId: 'x-2', doi: null, url: 'https://example.test/paper', title: 'No-DOI Work' }),
  ];
  assert.equal(dedupeExternalAcademicEvidence(items).length, 1);
});

test('4c: two entries with neither DOI nor URL, but different provider ids, are NOT collapsed (no shared identity to dedupe on)', () => {
  const items = [
    evidenceItem({ provider: 'openaire', providerId: 'x-1', doi: null, url: null, title: 'Untitled A' }),
    evidenceItem({ provider: 'europe-pmc', providerId: 'x-2', doi: null, url: null, title: 'Untitled A' }),
  ];
  assert.equal(dedupeExternalAcademicEvidence(items).length, 2);
});

// --- 10: long titles/authors/excerpts --------------------------------------

test('10: a very long title, author list, and excerpt render fully without truncation logic breaking', () => {
  const longTitle = 'A '.repeat(40) + 'Very Long Title About Something Extremely Specific and Detailed';
  const manyAuthors = Array.from({ length: 12 }, (_, i) => `Author Number ${i + 1}`);
  const longExcerpt = 'This is a very long matching passage. '.repeat(20).trim();
  const html = renderOverview(baseReport({
    externalAcademicEvidence: [evidenceItem({
      title: longTitle,
      authors: manyAuthors,
      matchedPassages: [{ submittedText: longExcerpt, submittedWordStart: 0, submittedWordEnd: 100, matchedWordCount: 100 }],
    })],
  }));
  assert.match(html, /Very Long Title About Something Extremely Specific and Detailed/);
  assert.match(html, /Author Number 1/);
  // Only the first 3 authors plus "et al." are shown — STEP 6 gracefully summarizing, not omitting authorship entirely.
  assert.match(html, /et al\./);
  assert.doesNotMatch(html, /Author Number 12/, 'more than 3 authors should be summarized, not all listed inline');
  assert.match(html, new RegExp(longExcerpt.slice(0, 50).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// --- 11: missing DOI ---------------------------------------------------------

test('11: a source with no DOI omits the DOI line gracefully rather than inventing one', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem({ doi: null })] }));
  assert.doesNotMatch(html, /DOI: null/);
  assert.doesNotMatch(html, /DOI: undefined/);
  assert.doesNotMatch(html, /DOI:/);
});

test('11b: a source missing authors/publication/year omits the meta line entirely rather than rendering empty punctuation', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem({ authors: null, publication: null, year: null })] }));
  assert.doesNotMatch(html, /·\s*<\/p>/, 'no dangling separator with nothing on either side');
  assert.doesNotMatch(html, /\(\)/, 'no empty year parentheses');
});

test('11c: a source missing everything but a title still renders a usable card', () => {
  const html = renderOverview(baseReport({
    externalAcademicEvidence: [evidenceItem({ authors: null, publication: null, year: null, doi: null, url: null, matchedPassages: [] })],
  }));
  assert.match(html, /Attention Is All You Need/);
  assert.doesNotMatch(html, /View source/, 'no link should render when url is absent');
});

test('11d: a source with a null title falls back to a generic label rather than rendering nothing', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem({ title: null })] }));
  assert.match(html, /Untitled external source/);
});

// --- 12: missing full text (no matched passages) ----------------------------

test('12: a source with no matched passages omits the excerpt block gracefully', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem({ matchedPassages: [] })] }));
  assert.doesNotMatch(html, /academic-evidence-excerpt/);
});

// --- 13/14: overlap values ---------------------------------------------------

test('13: 100% overlap renders exactly as such, not clamped or reformatted', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem({ similarity: 100 })] }));
  assert.match(html, /100% passage overlap/);
});

test('14: a low overlap value (e.g. 15%) still renders — no hidden threshold in the UI layer', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem({ similarity: 15 })] }));
  assert.match(html, /15% passage overlap/);
});

// --- 15: old report without the field ---------------------------------------

test('15: a report shaped exactly like a pre-Phase-3 saved payload (no externalAcademicEvidence key at all) renders identically to one with an empty array', () => {
  const oldReport = baseReport();
  delete oldReport.externalAcademicEvidence;
  const withEmpty = baseReport({ externalAcademicEvidence: [] });
  assert.equal(renderOverview(oldReport), renderOverview(withEmpty));
});

// --- never a score ------------------------------------------------------------

test('the section never uses similarity-verdict styling classes or "Plagiarism Score" language', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem()] }));
  assert.doesNotMatch(html, /similarity-verdict-(low|review|high)"[^>]*>[^<]*academic/i);
  assert.doesNotMatch(html, /Plagiarism Score/i);
});

// --- fluid layout (structural stand-in for mobile verification; see report) --

test('the section markup has no inline fixed-pixel width styles that could overflow a narrow viewport', () => {
  const html = renderOverview(baseReport({ externalAcademicEvidence: [evidenceItem(), evidenceItem({ providerId: 'x-2', doi: '10.1/x2', title: 'Second Paper' })] }));
  assert.doesNotMatch(html, /style="[^"]*width:\s*\d{3,}px/);
});
