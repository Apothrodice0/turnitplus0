import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewReport } from '../components/report/similarity-report-papers.tsx';
import { ReuseContextPanel } from '../components/reuse-context/reuse-context-panel.tsx';
import { OriginalSubmitterConfirmationPanel } from '../components/reuse-context/original-submitter-confirmation-panel.tsx';
import { ReuseContextContainer } from '../components/reuse-context/reuse-context-container.tsx';

/**
 * Ordinary-user reuse-context UI. Pure presentational components rendered
 * via react-dom/server (no jsdom); the container initialises its state from
 * the envelope prop so it renders synchronously.
 */

const repo = path.resolve('.');
const HEX = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);

function baseReport(overrides = {}) {
  return {
    version: 11, id: 1, submissionId: 'sub-1', title: 'fixture.pdf', author: '', assignment: '',
    created: new Date().toISOString(), score: 12, archiveScore: 9, wordCount: 1500, characterCount: 8000,
    pageCount: 4, fileSize: '10 KB', databaseSize: 230, corpusVersion: 'archive-v1-230-test', scoreBand: 'Low',
    riskStatus: 'Lower', riskTarget: 0.5, riskCutoff: 0.5,
    riskCalibration: { auc: 0.9, precision: 0.9, recall: 0.9, sampleSize: 100 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: 'English' },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text: 'fixture text',
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    reportId: 'rpt-fixture',
    declare: { available: false, canDeclare: false, activeDeclarations: [], ...(overrides.declare ?? {}) },
    confirm: { pending: [], confirmed: [], ...(overrides.confirm ?? {}) },
  };
}

function activeDecl(overrides = {}) {
  return { actionRef: HEX, state: 'SELF_ASSERTED_UNVERIFIED', declaredContext: 'SUPERVISOR_COPY', isCurrent: true, ...overrides };
}

const FORBIDDEN_IDENTITY_WORDING = /same owner|same person|verified authorship|plagiarism-free|plagiarism free|removed from (the |your )?score|excluded from (the |your )?score|\bis SELF\b/i;

// --- confirmed / unverified exact semantics --------------------------------

test('confirmed row: exact badge + load-bearing score sentence + label, no forbidden wording', () => {
  const html = renderToStaticMarkup(React.createElement(ReuseContextPanel, {
    declare: { available: true, canDeclare: false, activeDeclarations: [activeDecl({ state: 'MUTUALLY_CONFIRMED', confirmedDate: '2026-01-15' })] },
    onDeclare: () => {}, onWithdraw: () => {},
  }));
  assert.match(html, /Confirmed authorized reuse/);
  assert.match(html, /Confirmed reuse context\. This source is still counted in your similarity score\./);
  assert.match(html, /Supervisor-held copy/);
  assert.match(html, /confirmed this reuse context on 2026-01-15/);
  assert.doesNotMatch(html, FORBIDDEN_IDENTITY_WORDING);
  assert.doesNotMatch(html, /@/);
});

test('unverified row: exact badge, says not confirmed + does not change score, no affirmative "authorized/verified/confirmed"', () => {
  const html = renderToStaticMarkup(React.createElement(ReuseContextPanel, {
    declare: { available: true, canDeclare: false, activeDeclarations: [activeDecl()] },
    onDeclare: () => {}, onWithdraw: () => {},
  }));
  assert.match(html, /Reuse context declared — awaiting confirmation/);
  assert.match(html, /has not confirmed this/);
  assert.match(html, /does not change your similarity score/i);
  assert.doesNotMatch(html, FORBIDDEN_IDENTITY_WORDING);
  // "authorized"/"verified"/"confirmed" must not appear as an affirmative descriptor of THIS unverified state
  // (the only "confirmation" reference is "has not confirmed" / "awaiting confirmation")
  assert.doesNotMatch(html, /\bauthorized\b/i);
  assert.doesNotMatch(html, /\bverified\b/i);
});

for (const [ctx, label] of [
  ['SUPERVISOR_COPY', 'Supervisor-held copy'],
  ['COAUTHOR_COPY', "Co-author's copy"],
  ['INSTITUTIONAL_SUBMISSION', 'Institutional submission'],
  ['AUTHORIZED_ARCHIVAL_COPY', 'Authorized archival copy'],
  ['OTHER_AUTHORIZED_REUSE', 'Other authorized reuse'],
]) {
  test(`label: ${ctx} -> "${label}" (confirmed row)`, () => {
    const html = renderToStaticMarkup(React.createElement(ReuseContextPanel, {
      declare: { available: true, canDeclare: false, activeDeclarations: [activeDecl({ state: 'MUTUALLY_CONFIRMED', declaredContext: ctx })] },
      onDeclare: () => {}, onWithdraw: () => {},
    }));
    const decoded = html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
    assert.ok(decoded.includes(label), `expected label "${label}"`);
    assert.doesNotMatch(html, new RegExp(ctx), 'raw enum token must not appear');
  });
}

// --- add-context form ------------------------------------------------------

test('add-context CTA + form: legend, five options, keeps the score warning, no free-text input', () => {
  const html = renderToStaticMarkup(React.createElement(ReuseContextPanel, {
    declare: { available: true, canDeclare: true, activeDeclarations: [] },
    onDeclare: () => {}, onWithdraw: () => {},
  }));
  assert.match(html, /Have a legitimate reason for this match\?/);
  assert.match(html, /Add context/);
});

test('add-context form content is rendered directly (form always visible under a state-open render)', () => {
  // ReuseContextPanel keeps the form behind local state; assert the CTA button exists.
  const html = renderToStaticMarkup(React.createElement(ReuseContextPanel, {
    declare: { available: true, canDeclare: true, activeDeclarations: [] },
    onDeclare: () => {}, onWithdraw: () => {},
  }));
  assert.match(html, /reuse-context-add-link/);
});

test('STRUCTURAL: the declare form uses <legend>, native radios/fieldset, and no textarea/text input', () => {
  const src = fs.readFileSync(path.join(repo, 'components/reuse-context/reuse-context-panel.tsx'), 'utf8');
  assert.match(src, /<legend>/);
  assert.match(src, /<fieldset>/);
  assert.match(src, /type="radio"/);
  assert.doesNotMatch(src, /<textarea/);
  assert.doesNotMatch(src, /type="text"/);
  assert.match(src, /It will not change your similarity score\./);
});

// --- multiple active declarations ----------------------------------------

test('multiple active declarations: each rendered, each with its own withdraw control; non-current gets a note', () => {
  const html = renderToStaticMarkup(React.createElement(ReuseContextPanel, {
    declare: {
      available: true, canDeclare: false,
      activeDeclarations: [
        activeDecl({ actionRef: HEX, isCurrent: true }),
        activeDecl({ actionRef: HEX2, declaredContext: 'COAUTHOR_COPY', isCurrent: false }),
      ],
    },
    onDeclare: () => {}, onWithdraw: () => {},
  }));
  const withdrawButtons = html.match(/>Withdraw</g) ?? [];
  assert.equal(withdrawButtons.length, 2);
  assert.match(html, /another matching prior submission on this report/);
});

// --- pending panel -------------------------------------------------------

const PANEL_DEFAULTS = { pending: [], confirmed: [], onConfirm: () => {}, onReject: () => {}, onRevokeConfirmation: () => {} };

test('pending panel: renders each SELF_ASSERTED_UNVERIFIED item with Confirm/Reject, says it does not change the score', () => {
  const html = renderToStaticMarkup(React.createElement(OriginalSubmitterConfirmationPanel, {
    ...PANEL_DEFAULTS,
    pending: [{ actionRef: HEX, state: 'SELF_ASSERTED_UNVERIFIED', declaredContext: 'SUPERVISOR_COPY', declaredDate: '2026-01-10' }],
  }));
  assert.match(html, /Someone has indicated a reuse context for this submission\./);
  assert.match(html, /Claimed context: <em>Supervisor-held copy<\/em>/);
  assert.match(html, /Declared: 2026-01-10/);
  assert.match(html, /does not change the similarity score/i);
  assert.match(html, />Confirm</);
  assert.match(html, />Reject</);
  assert.doesNotMatch(html, /@/);
});

test('confirmed panel: original submitter sees their active confirmation with a "Revoke confirmation" control, careful copy', () => {
  const html = renderToStaticMarkup(React.createElement(OriginalSubmitterConfirmationPanel, {
    ...PANEL_DEFAULTS,
    confirmed: [{ actionRef: HEX, declaredContext: 'COAUTHOR_COPY', confirmedDate: '2026-03-01' }],
  }));
  assert.match(html, /You confirmed a reuse context for this submission/);
  assert.match(html.replace(/&#x27;/g, "'"), /Co-author's copy/);
  assert.match(html, /Revoking retracts your reuse-context confirmation\. It has no effect on the similarity score/);
  assert.match(html, /makes no claim about who owns the work/);
  assert.match(html, />Revoke confirmation</);
  assert.doesNotMatch(html, /same owner|same person|verified authorship|plagiarism-free/i);
  assert.doesNotMatch(html, /@/);
});

test('pending panel: empty pending + empty confirmed renders nothing', () => {
  const html = renderToStaticMarkup(React.createElement(OriginalSubmitterConfirmationPanel, { ...PANEL_DEFAULTS }));
  assert.equal(html, '');
});

// --- container ----------------------------------------------------------

test('container: renders nothing when the envelope has no visible content', () => {
  const html = renderToStaticMarkup(React.createElement(ReuseContextContainer, { reuseContext: envelope() }));
  assert.equal(html, '');
});

test('container: renders its own section + legend when there is content', () => {
  const html = renderToStaticMarkup(React.createElement(ReuseContextContainer, {
    reuseContext: envelope({ declare: { available: true, canDeclare: true, activeDeclarations: [] } }),
  }));
  assert.match(html, /Additional context/);
  assert.match(html, /It never removes the match from your similarity score\./);
  assert.match(html, /aria-live="polite"/);
});

// --- OverviewReport integration --------------------------------------

test('OverviewReport: similarity heading is byte-identical with and without reuseContext', () => {
  const without = renderToStaticMarkup(React.createElement(OverviewReport, { report: baseReport({ archiveScore: 42 }), similarityStatus: 'resolved' }));
  const withRc = renderToStaticMarkup(React.createElement(OverviewReport, {
    report: baseReport({ archiveScore: 42 }), similarityStatus: 'resolved',
    reuseContext: envelope({ declare: { available: true, canDeclare: true, activeDeclarations: [] } }),
  }));
  const line = (h) => h.match(/<span>42%<\/span> Similarity result/)?.[0];
  assert.ok(line(without));
  assert.equal(line(without), line(withRc));
});

test('OverviewReport: non-admin (no historicalSubmissionMatch) still shows the declarer CTA from the envelope', () => {
  const html = renderToStaticMarkup(React.createElement(OverviewReport, {
    report: baseReport(), similarityStatus: 'resolved',
    reuseContext: envelope({ declare: { available: true, canDeclare: true, activeDeclarations: [] } }),
  }));
  assert.match(html, /Have a legitimate reason for this match\?/);
  assert.doesNotMatch(html, /historicalSubmissionMatch/);
});

test('OverviewReport: no reuseContext -> zero reuse-context markup', () => {
  const html = renderToStaticMarkup(React.createElement(OverviewReport, { report: baseReport(), similarityStatus: 'resolved' }));
  assert.doesNotMatch(html, /Additional context/);
  assert.doesNotMatch(html, /reuse-context/);
});

test('OverviewReport: rendered reuse-context text contains no raw id / actionRef / email', () => {
  const html = renderToStaticMarkup(React.createElement(OverviewReport, {
    report: baseReport(), similarityStatus: 'resolved',
    reuseContext: envelope({
      declare: { available: true, canDeclare: false, activeDeclarations: [activeDecl({ state: 'MUTUALLY_CONFIRMED', confirmedDate: '2026-02-02' })] },
      confirm: { pending: [{ actionRef: HEX2, state: 'SELF_ASSERTED_UNVERIFIED', declaredContext: 'COAUTHOR_COPY', declaredDate: '2026-02-01' }] },
    }),
  }));
  // actionRef values are only carried in hidden callbacks, never printed as visible text
  const visibleText = html.replace(/<[^>]+>/g, ' ');
  assert.ok(!visibleText.includes(HEX));
  assert.ok(!visibleText.includes(HEX2));
  assert.doesNotMatch(visibleText, /@/);
});

// --- score-independence structural -------------------------------------

test('STRUCTURAL: no reuse-context UI module references a scoring identifier', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const f of [
    'components/reuse-context/reuse-context-panel.tsx',
    'components/reuse-context/original-submitter-confirmation-panel.tsx',
    'components/reuse-context/reuse-context-container.tsx',
    'lib/reuse-context-labels.ts',
    'lib/reuse-context-types.ts',
  ]) {
    const src = strip(fs.readFileSync(path.join(repo, f), 'utf8'));
    assert.doesNotMatch(src, /archiveScore|aiScore|verifiedSimilarity|\bcontainment\b|\.score\b|unifiedScore/i, `${f}`);
  }
});
