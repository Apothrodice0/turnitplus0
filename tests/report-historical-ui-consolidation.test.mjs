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
  // The section-level "Previously submitted content" heading (h3) still
  // appears once; the SELF sub-heading below is a *different* string
  // ("... — your own work") that happens to start with the same substring,
  // so it is checked separately, not folded into this count.
  const headingCount = (html.match(/<h3>Previously submitted content<\/h3>/g) || []).length;
  assert.equal(headingCount, 1, 'exactly one occurrence of the consolidated section heading');
  assert.match(html, /Previously submitted content — your own work/, 'SELF sub-heading must say "your own work"');
  assert.match(html, /your previous TurnitPlus submission/, 'SELF body must say "your previous TurnitPlus submission"');
  assert.match(html, /self-match/, 'SELF body must explicitly say "self-match"');
  assert.match(html, /100%<\/strong> of this submission matches your previous TurnitPlus submission/);
  assert.match(html, /1,463 matched words/);
  assert.match(html, /not evidence of plagiarism/);
  assert.doesNotMatch(html, /matches content you previously submitted to TurnitPlus/, 'old SELF wording must be gone');
  assert.doesNotMatch(html, /This submission overlaps with your own prior submission/, 'old SELF wording must be gone');
  // Must not accidentally pick up PRIOR_SUBMISSION's own wording.
  assert.doesNotMatch(html, /matches content previously submitted to TurnitPlus/, 'SELF must not render PRIOR_SUBMISSION wording');
  assert.doesNotMatch(html, /not proof of plagiarism/, 'SELF must not render PRIOR_SUBMISSION\'s disclaimer wording');
});

test('A2: SELF dynamic values track containment/matchedWordCount exactly', () => {
  const half = { ...SELF_MATCH, matches: [{ ...SELF_MATCH.matches[0], containment: 0.526, matchedWordCount: 1033 }] };
  const html = render(baseReport({ historicalSubmissionMatch: half }));
  assert.match(html, /<strong>53%<\/strong> of this submission matches your previous TurnitPlus submission/, 'containment must be rounded and rendered dynamically, not hardcoded');
  assert.match(html, /1,033 matched words/, 'matchedWordCount must be rendered dynamically, not hardcoded');
});

test('B: PRIOR_SUBMISSION renders exactly one historical section, with PRIOR_SUBMISSION-specific wording, unchanged by the E8R-SELF-UI phase', () => {
  const html = render(baseReport({ historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH }));
  const headingCount = (html.match(/Previously submitted content/g) || []).length;
  assert.equal(headingCount, 1);
  assert.match(html, /100%<\/strong> of this submission matches content previously submitted to TurnitPlus/);
  assert.doesNotMatch(html, /you previously submitted to TurnitPlus/, 'PRIOR_SUBMISSION wording must not claim the viewer submitted it');
  assert.doesNotMatch(html, /Previously submitted content was found/, 'old PRIOR_SUBMISSION wording must be gone');
  assert.doesNotMatch(html, /your own work/i, 'PRIOR_SUBMISSION must never claim the content is the viewer\'s own work');
  assert.doesNotMatch(html, /self-match/i, 'PRIOR_SUBMISSION must never be labeled a self-match');
});

test('B2: UNKNOWN_RELATIONSHIP makes no ownership/authorship claim', () => {
  const UNKNOWN_MATCH = { ...SELF_MATCH, matches: [{ ...SELF_MATCH.matches[0], relationshipType: 'UNKNOWN_RELATIONSHIP', historicalSubmissionCount: 1 }] };
  const html = render(baseReport({ historicalSubmissionMatch: UNKNOWN_MATCH }));
  assert.match(html, /ownership could not be determined/);
  assert.doesNotMatch(html, /your own work/i, 'UNKNOWN_RELATIONSHIP must never claim the content is the viewer\'s own work');
  assert.doesNotMatch(html, /self-match/i, 'UNKNOWN_RELATIONSHIP must never be labeled a self-match');
  assert.doesNotMatch(html, /you previously submitted/i, 'UNKNOWN_RELATIONSHIP must not claim the viewer submitted it');
  assert.doesNotMatch(html, /matches content previously submitted to TurnitPlus/, 'UNKNOWN_RELATIONSHIP must not render PRIOR_SUBMISSION wording either');
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
  // "reuses the existing heading" assertion. Phase E8R-SELF-UI added a
  // fourth: the per-match SELF sub-heading ("... — your own work") is a
  // deliberately different string that happens to start with the same
  // substring, so it also matches this permissive regex.
  assert.equal(headingOccurrences, 4, 'exactly the UNAVAILABLE, MATCHED, E8P.3-experimental, and E8R SELF sub-heading occurrences');
});

test('K: SELF-specific presentation change does not touch matcher/scoring/E8P/E8O code', () => {
  const matcherSource = fs.readFileSync(path.join(repo, 'lib/user-submission-matching.ts'), 'utf8');
  const e8mSource = fs.readFileSync(path.join(repo, 'lib/e8m-robust-correspondence.ts'), 'utf8');
  const e8lSource = fs.readFileSync(path.join(repo, 'lib/e8l-distinctiveness-v2.ts'), 'utf8');
  const e8pShadowSource = fs.readFileSync(path.join(repo, 'lib/e8p-shadow-evaluation.ts'), 'utf8');
  const e8pVisibilitySource = fs.readFileSync(path.join(repo, 'lib/e8p-visibility.ts'), 'utf8');
  for (const source of [matcherSource, e8mSource, e8lSource, e8pShadowSource, e8pVisibilitySource]) {
    assert.doesNotMatch(source, /your own work|self-match/i, 'E8R-SELF-UI wording must live only in the report component, never in matcher/E8P source');
  }
});

// --- I: receipt PDF unaffected -----------------------------------------------

test('I: lib/receipt-pdf.ts is untouched by this phase — no historical-match fields, no matchClassification reference', () => {
  const source = fs.readFileSync(path.join(repo, 'lib/receipt-pdf.ts'), 'utf8');
  assert.doesNotMatch(source, /historicalSubmissionMatch|matchClassification/, 'the lightweight receipt must remain unaware of either historical-match mechanism, exactly as before this phase');
});

// --- J: responsive-safe structure (best-effort — no jsdom/viewport test infrastructure exists in this repo) ---

test('I2: score/archiveScore/aiScore are unaffected by the SELF wording change, and the component never reads aiScore at all', () => {
  const withoutMatch = render(baseReport({ score: 12, archiveScore: 9 }));
  const withSelfMatch = render(baseReport({ score: 12, archiveScore: 9, historicalSubmissionMatch: SELF_MATCH }));
  assert.match(withoutMatch, /<span>9%<\/span> Archive overlap/);
  assert.match(withSelfMatch, /<span>9%<\/span> Archive overlap/);
  const source = fs.readFileSync(path.join(repo, 'components/report/similarity-report-papers.tsx'), 'utf8');
  assert.doesNotMatch(source, /\.aiScore\b/, 'OverviewReport must never read aiScore — AI scoring is rendered by a separate component, untouched by this phase');
});

test('I3: non-historical sections of the report render unchanged alongside a SELF match', () => {
  const html = render(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  assert.match(html, /Filtered from the Report/);
  assert.match(html, /Match Groups/);
  assert.match(html, /Archive overlap/);
});

test('J: the consolidated section uses plain semantic markup with no fixed-width inline styling that would break on mobile', () => {
  const html = render(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  const sectionMatch = html.match(/<section class="historical-match-block">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, 'the historical-match-block section must be present');
  assert.doesNotMatch(sectionMatch[0], /style="[^"]*width:\s*\d+px/, 'no fixed pixel width should be hardcoded into the historical section markup');
  assert.match(sectionMatch[0], /<h3>/, 'heading hierarchy (h3, matching this paper\'s other sections) must be preserved');
});

// =============================================================================
// Phase E8R-SELF-UI.2: consolidate multiple SELF matches into one block
// (one heading, one entry per SELF match, one disclaimer) instead of
// repeating the full heading/disclaimer per match. Letters below (L-U)
// correspond to this phase's own task letters (A-J) — offset to avoid
// colliding with the E8R-SELF-UI.1 tests already above.
// =============================================================================

function selfMatch(overrides = {}) {
  return { ...SELF_MATCH.matches[0], ...overrides };
}

const TWO_SELF_MATCHES = {
  ...SELF_MATCH,
  matches: [
    selfMatch({ matchedRepresentationId: 'rep-self-1', containment: 1, matchedWordCount: 1190, passages: [{ submittedText: 'self match one fixture passage', submittedWordStart: 0, submittedWordEnd: 5, matchedWordCount: 5 }] }),
    selfMatch({ matchedRepresentationId: 'rep-self-2', containment: 1, matchedWordCount: 966, passages: [{ submittedText: 'self match two fixture passage', submittedWordStart: 20, submittedWordEnd: 25, matchedWordCount: 5 }] }),
  ],
};

const THREE_SELF_MATCHES = {
  ...SELF_MATCH,
  matches: [
    selfMatch({ matchedRepresentationId: 'rep-self-1', containment: 1, matchedWordCount: 1190 }),
    selfMatch({ matchedRepresentationId: 'rep-self-2', containment: 0.9958, matchedWordCount: 966 }),
    selfMatch({ matchedRepresentationId: 'rep-self-3', containment: 0.75, matchedWordCount: 500 }),
  ],
};

// Count only genuine SELF sub-heading occurrences (not the shared section h3).
function selfHeadingCount(html) {
  return (html.match(/Previously submitted content — your own work/g) || []).length;
}
function selfDisclaimerCount(html) {
  const singular = (html.match(/This is a self-match and is not evidence of plagiarism\./g) || []).length;
  const plural = (html.match(/These are self-matches and are not evidence of plagiarism\./g) || []).length;
  return singular + plural;
}
function selfEntryCount(html) {
  return (html.match(/class="historical-match-self-item"/g) || []).length;
}

test('L (task A): one SELF match -> one SELF heading, one entry, one (singular) disclaimer', () => {
  const html = render(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  assert.equal(selfHeadingCount(html), 1);
  assert.equal(selfEntryCount(html), 1);
  assert.equal(selfDisclaimerCount(html), 1);
  assert.match(html, /This is a self-match and is not evidence of plagiarism\./, 'a single SELF match keeps the singular disclaimer');
  assert.doesNotMatch(html, /These are self-matches/, 'a single SELF match must not use the plural disclaimer');
});

test('M (task B): two SELF matches -> one heading, two entries, one (plural) disclaimer', () => {
  const html = render(baseReport({ historicalSubmissionMatch: TWO_SELF_MATCHES }));
  assert.equal(selfHeadingCount(html), 1, 'the SELF heading must be emitted exactly once, not once per match');
  assert.equal(selfEntryCount(html), 2, 'each SELF match gets its own entry underneath the shared heading');
  assert.equal(selfDisclaimerCount(html), 1, 'the disclaimer must be emitted exactly once, after all SELF entries');
  assert.match(html, /These are self-matches and are not evidence of plagiarism\./);
  assert.doesNotMatch(html, /This is a self-match and is not evidence of plagiarism\./, 'two matches must use the plural disclaimer, not the singular one');
  assert.match(html, /<strong>100%<\/strong> of this submission matches your previous TurnitPlus submission \(1,190 matched words\)/);
  assert.match(html, /<strong>100%<\/strong> of this submission matches another previous TurnitPlus submission \(966 matched words\)/);
});

test('N (task C): three+ SELF matches -> one heading, all entries preserved in order, one disclaimer', () => {
  const html = render(baseReport({ historicalSubmissionMatch: THREE_SELF_MATCHES }));
  assert.equal(selfHeadingCount(html), 1);
  assert.equal(selfEntryCount(html), 3);
  assert.equal(selfDisclaimerCount(html), 1);
  const firstIdx = html.indexOf('1,190 matched words');
  const secondIdx = html.indexOf('966 matched words');
  const thirdIdx = html.indexOf('500 matched words');
  assert.ok(firstIdx > -1 && secondIdx > -1 && thirdIdx > -1, 'all three matched-word counts must appear');
  assert.ok(firstIdx < secondIdx && secondIdx < thirdIdx, 'entries must render in their original array order');
  assert.match(html, /<strong>100%<\/strong> of this submission matches your previous TurnitPlus submission \(1,190 matched words\)/);
  assert.match(html, /<strong>100%<\/strong> of this submission matches another previous TurnitPlus submission \(966 matched words\)/);
  assert.match(html, /<strong>75%<\/strong> of this submission matches another previous TurnitPlus submission \(500 matched words\)/);
});

test('O (task D): mixed SELF + PRIOR_SUBMISSION -> one SELF block, PRIOR_SUBMISSION rendering unchanged', () => {
  const mixed = { ...SELF_MATCH, matches: [selfMatch({ matchedRepresentationId: 'rep-self-1' }), { ...PRIOR_SUBMISSION_MATCH.matches[0], matchedRepresentationId: 'rep-prior-1' }] };
  const html = render(baseReport({ historicalSubmissionMatch: mixed }));
  assert.equal(selfHeadingCount(html), 1);
  assert.equal(selfEntryCount(html), 1);
  assert.equal(selfDisclaimerCount(html), 1);
  assert.match(html, /100%<\/strong> of this submission matches content previously submitted to TurnitPlus/, 'PRIOR_SUBMISSION entry renders exactly as before');
  assert.match(html, /not proof of plagiarism/);
});

test('P (task E): SELF + UNKNOWN_RELATIONSHIP -> one SELF block, UNKNOWN behavior unchanged', () => {
  const mixed = { ...SELF_MATCH, matches: [selfMatch({ matchedRepresentationId: 'rep-self-1' }), { ...SELF_MATCH.matches[0], relationshipType: 'UNKNOWN_RELATIONSHIP', matchedRepresentationId: 'rep-unknown-1', historicalSubmissionCount: 1 }] };
  const html = render(baseReport({ historicalSubmissionMatch: mixed }));
  assert.equal(selfHeadingCount(html), 1);
  assert.equal(selfEntryCount(html), 1);
  assert.equal(selfDisclaimerCount(html), 1);
  assert.match(html, /ownership could not be determined/);
  assert.doesNotMatch(html, /UNKNOWN_RELATIONSHIP.*your own work|your own work.*UNKNOWN_RELATIONSHIP/is);
});

test('Q (task F): no SELF matches -> no SELF block at all', () => {
  const html = render(baseReport({ historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH }));
  assert.equal(selfHeadingCount(html), 0);
  assert.equal(selfEntryCount(html), 0);
  assert.equal(selfDisclaimerCount(html), 0);
  assert.doesNotMatch(html, /your own work/i);
});

test('R (task G): dynamic percentages/word counts are correct across multiple SELF entries, not hardcoded', () => {
  const custom = {
    ...SELF_MATCH,
    matches: [
      selfMatch({ matchedRepresentationId: 'rep-self-1', containment: 0.526, matchedWordCount: 1033 }),
      selfMatch({ matchedRepresentationId: 'rep-self-2', containment: 0.333, matchedWordCount: 42 }),
    ],
  };
  const html = render(baseReport({ historicalSubmissionMatch: custom }));
  assert.match(html, /<strong>53%<\/strong> of this submission matches your previous TurnitPlus submission \(1,033 matched words\)/);
  assert.match(html, /<strong>33%<\/strong> of this submission matches another previous TurnitPlus submission \(42 matched words\)/);
});

test('S (task H): no score/archiveScore/aiScore changes from multi-SELF consolidation', () => {
  const withoutMatch = render(baseReport({ score: 12, archiveScore: 9 }));
  const withMultiSelf = render(baseReport({ score: 12, archiveScore: 9, historicalSubmissionMatch: THREE_SELF_MATCHES }));
  assert.match(withoutMatch, /<span>9%<\/span> Archive overlap/);
  assert.match(withMultiSelf, /<span>9%<\/span> Archive overlap/);
});

test('T (task I): the existing E8P.3 experimental partial-match UI is unaffected by the SELF-consolidation change', () => {
  const experimental = {
    status: 'HISTORICAL_PARTIAL_MATCH',
    relationship: 'SELF',
    evidence: 'MULTIPLE_DISTINCTIVE_PASSAGES',
    matchedWordCount: 320,
    containment: 0.4,
    passageCount: 2,
    passages: [{ submittedText: 'experimental fixture passage', submittedWordStart: 0, submittedWordEnd: 4, matchedWordCount: 4 }],
    disclaimer: 'This is historical submission evidence only, not a plagiarism verdict.',
  };
  const html = render(baseReport({
    historicalSubmissionMatch: { status: 'NO_HISTORICAL_MATCH', computedAt: new Date().toISOString(), matcherVersion: 'v', fingerprintVersion: 'v', canonicalizationVersion: 'v' },
    experimentalHistoricalMatch: experimental,
  }));
  assert.match(html, /Historical submission evidence \(experimental\)/);
  assert.match(html, /You previously submitted this content\./);
  assert.match(html, /320 matched words across 2 passages/);
  // The E8R-SELF-UI.2 consolidated block/heading must never appear here —
  // this is a completely separate code path (renderHistoricalMatchEntries
  // is never called when historicalSubmissionMatch.matches is empty).
  assert.equal(selfHeadingCount(html), 0);
  assert.equal(selfEntryCount(html), 0);
});

test('U (task J, structural): matcher/scoring/E8P/E8O source is untouched by the multi-SELF consolidation', () => {
  const matcherSource = fs.readFileSync(path.join(repo, 'lib/user-submission-matching.ts'), 'utf8');
  const e8mSource = fs.readFileSync(path.join(repo, 'lib/e8m-robust-correspondence.ts'), 'utf8');
  const e8lSource = fs.readFileSync(path.join(repo, 'lib/e8l-distinctiveness-v2.ts'), 'utf8');
  const e8pShadowSource = fs.readFileSync(path.join(repo, 'lib/e8p-shadow-evaluation.ts'), 'utf8');
  const e8pVisibilitySource = fs.readFileSync(path.join(repo, 'lib/e8p-visibility.ts'), 'utf8');
  const e8oSource = fs.readFileSync(path.join(repo, 'lib/e8o-historical-match-policy.ts'), 'utf8');
  const snapshotSource = fs.readFileSync(path.join(repo, 'lib/report-historical-match.ts'), 'utf8');
  for (const source of [matcherSource, e8mSource, e8lSource, e8pShadowSource, e8pVisibilitySource, e8oSource, snapshotSource]) {
    assert.doesNotMatch(source, /your own work|self-match|another previous TurnitPlus submission/i, 'E8R-SELF-UI.2 grouping/wording must live only in the report component');
  }
  // The grouping helper itself must exist only in the UI component, never
  // duplicated into a matching/scoring module.
  const uiSource = fs.readFileSync(path.join(repo, 'components/report/similarity-report-papers.tsx'), 'utf8');
  assert.match(uiSource, /function renderHistoricalMatchEntries/, 'the consolidation helper must exist in the report component');
});
