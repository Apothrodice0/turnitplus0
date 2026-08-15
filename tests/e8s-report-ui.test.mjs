import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewReport } from '../components/report/similarity-report-papers.tsx';
import { ReuseContextPanel, AddContextForm } from '../components/reuse-context/reuse-context-panel.tsx';
import { OriginalSubmitterConfirmationPanel } from '../components/reuse-context/original-submitter-confirmation-panel.tsx';
import { ReuseContextContainer } from '../components/reuse-context/reuse-context-container.tsx';

/**
 * Phase E8S Step 11: tests for the live report-page UI integration.
 *
 * ReuseContextPanel/AddContextForm/OriginalSubmitterConfirmationPanel are
 * pure presentational (no fetch, no effects) and are rendered directly with
 * explicit props via react-dom/server's renderToStaticMarkup — the same
 * no-jsdom convention this repo's report-component tests already use.
 *
 * ReuseContextContainer DOES fetch inside useEffect, which never runs
 * during a static server render — renderToStaticMarkup of it therefore
 * always shows its own "not yet loaded" state (it deliberately renders
 * null until both its fetches resolve), which is itself a real, useful
 * guarantee to test: the server-rendered HTML never contains any
 * reuse-context content before the client-side, allowlist-gated fetch
 * completes. Its actual fetch/mutation behavior is verified structurally
 * (source-level assertions) rather than by execution — this repo has no
 * jsdom/click-simulation infrastructure (see the pre-existing "J" test in
 * tests/report-historical-ui-consolidation.test.mjs for the same
 * documented limitation).
 */

const repo = path.resolve('.');

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: 'sub-e8s11-1',
    title: 'e8s11-fixture.pdf',
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

function renderReport(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}
function renderPanel(el) {
  return renderToStaticMarkup(el);
}

const SELF_MATCH = {
  status: 'MATCHED',
  computedAt: new Date().toISOString(),
  matcherVersion: 'user-submission-match-v1',
  fingerprintVersion: 'corpus-shingle-v1',
  canonicalizationVersion: 'canonical-text-v1',
  matches: [{
    relationshipType: 'SELF',
    matchedRepresentationId: 'rep-self-1',
    matchType: 'EXACT_CANONICAL_MATCH',
    containment: 1, matchedWordCount: 1463, passageCount: 1, longestMatchWords: 1463,
    passages: [{ submittedText: 'a bounded excerpt of the current document only', submittedWordStart: 0, submittedWordEnd: 8, matchedWordCount: 8 }],
    historicalSubmissionCount: 0,
  }],
};

const PRIOR_SUBMISSION_MATCH = {
  ...SELF_MATCH,
  matches: [{ ...SELF_MATCH.matches[0], relationshipType: 'PRIOR_SUBMISSION', historicalSubmissionCount: 1 }],
};

const NO_MATCH = { status: 'NO_HISTORICAL_MATCH', computedAt: new Date().toISOString(), matcherVersion: 'v', fingerprintVersion: 'v', canonicalizationVersion: 'v' };

function declaration(overrides = {}) {
  return {
    id: 1,
    representationId: 'rep-1',
    declaredContext: 'SUPERVISOR_COPY',
    verificationState: 'SELF_ASSERTED_UNVERIFIED',
    declaredAt: '2026-08-15T00:00:00.000Z',
    confirmedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

// --- A: baseline CTA ---------------------------------------------------------

test('A: PRIOR_SUBMISSION + no declaration -> "Have a legitimate reason" + Add context CTA', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, { affordance: { canDeclare: true }, activeDeclaration: null }));
  assert.match(html, /Have a legitimate reason for this match\?/);
  assert.match(html, /Add context/);
});

// --- B: form content (open-state content, since click simulation needs jsdom this repo doesn't have) ---

test('B: the add-context form renders its full required content', () => {
  const html = renderPanel(React.createElement(AddContextForm, { onSubmit: () => {} }));
  assert.match(html, /Why is this content already in TurnitPlus\?/);
  for (const choice of [
    'My supervisor submitted this',
    'A coauthor submitted this',
    'This was submitted through my institution/instructor',
    'This is an authorized archival copy',
    'Other authorized reuse',
  ]) {
    assert.match(html, new RegExp(choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /This is your own claim\. The original submitter will be asked to confirm it\. It will not change your score\./);
  assert.match(html, /Add context<\/button>/);
  assert.doesNotMatch(html, />Submit</, 'the submit button must say "Add context", not the old placeholder "Submit"');
});

test('B2: no free-text input exists anywhere in the form', () => {
  const html = renderPanel(React.createElement(AddContextForm, { onSubmit: () => {} }));
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /type="text"/);
});

// --- C-G: each declared_context choice, relationship-specific unverified copy ---

const CONTEXT_CASES = [
  ['SUPERVISOR_COPY', 'supervisor copy'],
  ['COAUTHOR_COPY', 'coauthor copy'],
  ['INSTITUTIONAL_SUBMISSION', 'institutional submission'],
  ['AUTHORIZED_ARCHIVAL_COPY', 'authorized archival copy'],
  ['OTHER_AUTHORIZED_REUSE', 'authorized reuse'],
];
const CASE_LETTERS = ['C', 'D', 'E', 'F', 'G'];

for (let i = 0; i < CONTEXT_CASES.length; i++) {
  const [value, label] = CONTEXT_CASES[i];
  test(`${CASE_LETTERS[i]}: ${value} renders relationship-specific unverified copy`, () => {
    const html = renderPanel(React.createElement(ReuseContextPanel, {
      affordance: { canDeclare: false, reason: 'ALREADY_ACTIVE' },
      activeDeclaration: declaration({ declaredContext: value }),
    }));
    assert.match(html, new RegExp(`You indicated this is a ${label}\\.`));
    assert.match(html, /The original submitter has not confirmed it yet\./);
  });
}

// --- H: SELF_ASSERTED_UNVERIFIED ---------------------------------------------

test('H: SELF_ASSERTED_UNVERIFIED shows the Unverified badge and a Withdraw action', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, {
    affordance: { canDeclare: false, reason: 'ALREADY_ACTIVE' },
    activeDeclaration: declaration(),
    onWithdraw: () => {},
  }));
  assert.match(html, /Unverified/);
  assert.match(html, />Withdraw</);
  assert.doesNotMatch(html, />Confirmed</);
});

// --- I: MUTUALLY_CONFIRMED ----------------------------------------------------

test('I: MUTUALLY_CONFIRMED shows the Confirmed badge and generic copy', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, {
    affordance: { canDeclare: false, reason: 'ALREADY_ACTIVE' },
    activeDeclaration: declaration({ verificationState: 'MUTUALLY_CONFIRMED', confirmedAt: '2026-08-15T01:00:00.000Z' }),
    onWithdraw: () => {},
  }));
  assert.match(html, /Confirmed/);
  assert.match(html, /The original submitter has confirmed this reuse context\./);
  assert.match(html, />Revoke</);
});

// --- J/K: rejected / revoked outcomes -----------------------------------------

test('J: rejected outcome shows the exact required copy', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, {
    affordance: { canDeclare: true },
    activeDeclaration: null,
    lastOutcome: 'REJECTED',
  }));
  assert.match(html, /This context was not confirmed by the original submitter\./);
});

test('K: revoked outcome shows the exact required copy, and a fresh declaration remains possible', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, {
    affordance: { canDeclare: true },
    activeDeclaration: null,
    lastOutcome: 'REVOKED',
  }));
  assert.match(html, /This context is no longer active\./);
  assert.match(html, /Have a legitimate reason for this match\?/, 'the CTA must still be offered so a fresh declaration is possible after revocation');
});

test('never shows who rejected/revoked, no account ids, no emails', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, { affordance: { canDeclare: true }, activeDeclaration: null, lastOutcome: 'REVOKED' }));
  assert.doesNotMatch(html, /@/);
  assert.doesNotMatch(html, /acct-|account/i);
});

// --- L: ambiguous -> no actionable CTA ----------------------------------------

test('L: ambiguous pair shows the explanatory note but never an actionable Add context control', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, { affordance: { canDeclare: false, reason: 'AMBIGUOUS' }, activeDeclaration: null }));
  assert.match(html, /This content matches multiple prior submissions/);
  assert.doesNotMatch(html, /<button[^>]*>Add context/);
});

// --- M: SELF -> no CTA ---------------------------------------------------------

test('M: SELF relationship renders nothing actionable at all', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, { affordance: { canDeclare: false, reason: 'SELF_RELATIONSHIP' }, activeDeclaration: null }));
  assert.doesNotMatch(html, /Add context/);
  assert.doesNotMatch(html, /Unverified|Confirmed/);
});

test('third party (not submission owner) renders nothing actionable', () => {
  const html = renderPanel(React.createElement(ReuseContextPanel, { affordance: { canDeclare: false, reason: 'NOT_SUBMISSION_OWNER' }, activeDeclaration: null }));
  assert.equal(html, '');
});

// --- N: non-allowlisted -> no E8S UI / no API fetch ---------------------------

test('N: report.reuseContext absent -> OverviewReport renders zero reuse-context content, zero mount point for the container', () => {
  const html = renderReport(baseReport({ historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH })); // no reuseContext at all
  assert.doesNotMatch(html, /Have a legitimate reason/);
  assert.doesNotMatch(html, /reuse-context/);
});

test('N2: ReuseContextContainer server-renders nothing before its effects run (no SSR content leak ahead of the client-gated fetch)', () => {
  const html = renderPanel(React.createElement(ReuseContextContainer, { documentIdentityId: 'doc-1', representationId: 'rep-1' }));
  assert.equal(html, '', 'must render nothing until both status and pending fetches resolve client-side');
});

test('N3 (structural): similarity-report-papers.tsx never renders ReuseContextContainer without a report.reuseContext guard', () => {
  const source = fs.readFileSync(path.join(repo, 'components/report/similarity-report-papers.tsx'), 'utf8');
  const usages = source.split('<ReuseContextContainer').slice(1);
  assert.ok(usages.length >= 3, 'expected the container to be referenced in all three placement branches (UNAVAILABLE, MATCHED, standalone)');
  // Every occurrence must be preceded on the same JSX-conditional line/block by "report.reuseContext &&" or "report.reuseContext)" (the standalone branch's compound condition).
  const guarded = source.match(/report\.reuseContext\s*&&[\s\S]{0,200}?<ReuseContextContainer/g) || [];
  assert.equal(guarded.length, usages.length, 'every ReuseContextContainer render must be gated behind report.reuseContext');
});

// --- O: original-submitter pending panel --------------------------------------

test('O: pending panel shows the exact required copy and both actions', () => {
  const html = renderPanel(React.createElement(OriginalSubmitterConfirmationPanel, { pending: [declaration()], onConfirm: () => {}, onReject: () => {} }));
  assert.match(html, /Someone has indicated a reuse context for this submission\./);
  assert.match(html, /Claimed context: <em>Supervisor copy<\/em>/);
  assert.match(html, /This claim has not been verified\. You can confirm it if it.s accurate, or reject it\./);
  assert.match(html, />Confirm</);
  assert.match(html, />Reject</);
});

test('O2: after confirm, transient "Confirmed." note is shown for that item', () => {
  const html = renderPanel(React.createElement(OriginalSubmitterConfirmationPanel, {
    pending: [declaration({ verificationState: 'MUTUALLY_CONFIRMED' })],
    lastAction: { declarationId: 1, outcome: 'CONFIRMED' },
  }));
  assert.match(html, />Confirmed\.</);
});

test('O3: after reject, transient rejection note is shown once the item is gone from pending', () => {
  const html = renderPanel(React.createElement(OriginalSubmitterConfirmationPanel, {
    pending: [], // rejected items no longer appear in the active list
    lastAction: { declarationId: 1, outcome: 'REJECTED' },
  }));
  assert.match(html, /You.ve indicated this context is not confirmed\./);
});

test('O4: empty pending list with no lastAction renders nothing', () => {
  const html = renderPanel(React.createElement(OriginalSubmitterConfirmationPanel, { pending: [] }));
  assert.equal(html, '');
});

// --- P: third party cannot see panel/declaration (backend-enforced; UI-level shape check here) ---

test('P: the pending panel and CTA panel never render an account id, email, or username under any state', () => {
  const states = [
    { affordance: { canDeclare: true }, activeDeclaration: null },
    { affordance: { canDeclare: false, reason: 'ALREADY_ACTIVE' }, activeDeclaration: declaration() },
    { affordance: { canDeclare: false, reason: 'ALREADY_ACTIVE' }, activeDeclaration: declaration({ verificationState: 'MUTUALLY_CONFIRMED' }) },
  ];
  for (const props of states) {
    const html = renderPanel(React.createElement(ReuseContextPanel, props));
    assert.doesNotMatch(html, /@/);
  }
  const pendingHtml = renderPanel(React.createElement(OriginalSubmitterConfirmationPanel, { pending: [declaration()] }));
  assert.doesNotMatch(pendingHtml, /@/);
});

// --- Q: score/archiveScore/aiScore unchanged ----------------------------------

test('Q: Archive overlap heading is byte-identical with and without report.reuseContext present', () => {
  const withoutReuseContext = renderReport(baseReport({ archiveScore: 42, historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH }));
  const withReuseContext = renderReport(baseReport({ archiveScore: 42, historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH, reuseContext: { documentIdentityId: 'doc-1', representationId: 'rep-self-1' } }));
  const archiveLine = (html) => html.match(/<span>42%<\/span> Archive overlap/)?.[0];
  assert.ok(archiveLine(withoutReuseContext));
  assert.equal(archiveLine(withoutReuseContext), archiveLine(withReuseContext));
});

// --- R: existing SELF consolidation unchanged ---------------------------------

test('R: SELF consolidation block renders identically whether or not report.reuseContext is present', () => {
  const withoutReuseContext = renderReport(baseReport({ historicalSubmissionMatch: SELF_MATCH }));
  const withReuseContext = renderReport(baseReport({ historicalSubmissionMatch: SELF_MATCH, reuseContext: { documentIdentityId: 'doc-1', representationId: null } }));
  for (const html of [withoutReuseContext, withReuseContext]) {
    assert.match(html, /Previously submitted content — your own work/);
    assert.match(html, /This is a self-match and is not evidence of plagiarism\./);
  }
  // The SELF block's own markup must be byte-identical between the two renders (only the surrounding reuse-context container's own -- empty until loaded -- output may differ).
  const selfBlock = (html) => html.match(/<div class="historical-match-entry historical-match-entry-self">[\s\S]*?<\/div>/)?.[0];
  assert.equal(selfBlock(withoutReuseContext), selfBlock(withReuseContext));
});

// --- S: E8P experimental block unchanged --------------------------------------

test('S: E8P.3 experimental block renders identically whether or not the new standalone reuse-context section is also present', () => {
  const experimental = {
    status: 'HISTORICAL_PARTIAL_MATCH',
    relationship: 'PRIOR_SUBMISSION',
    evidence: 'MULTIPLE_DISTINCTIVE_PASSAGES',
    matchedWordCount: 320,
    containment: 0.4,
    passageCount: 2,
    passages: [{ submittedText: 'experimental fixture passage', submittedWordStart: 0, submittedWordEnd: 4, matchedWordCount: 4 }],
    disclaimer: 'This is historical submission evidence only, not a plagiarism verdict.',
  };
  const withoutReuseContext = renderReport(baseReport({ historicalSubmissionMatch: NO_MATCH, experimentalHistoricalMatch: experimental }));
  const withReuseContext = renderReport(baseReport({ historicalSubmissionMatch: NO_MATCH, experimentalHistoricalMatch: experimental, reuseContext: { documentIdentityId: 'doc-1', representationId: null } }));
  const expBlock = (html) => html.match(/<section class="historical-match-block historical-match-block-experimental">[\s\S]*?<\/section>/)?.[0];
  assert.ok(expBlock(withoutReuseContext));
  assert.equal(expBlock(withoutReuseContext), expBlock(withReuseContext), 'the E8P.3 block itself must be byte-identical regardless of the new standalone reuse-context section');
});

// --- T: mobile/layout -----------------------------------------------------------

test('T (structural): no new E8S UI file hardcodes a fixed pixel width', () => {
  for (const file of [
    'components/reuse-context/reuse-context-panel.tsx',
    'components/reuse-context/original-submitter-confirmation-panel.tsx',
    'components/reuse-context/reuse-context-container.tsx',
  ]) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.doesNotMatch(source, /style=\{?["'][^"']*width:\s*\d+px/, `${file} must not hardcode a fixed pixel width`);
  }
});

test('T2: the report layout structure (existing sections) is unaffected by the new standalone section placement', () => {
  const html = renderReport(baseReport({ historicalSubmissionMatch: PRIOR_SUBMISSION_MATCH, reuseContext: { documentIdentityId: 'doc-1', representationId: 'rep-self-1' } }));
  assert.match(html, /Filtered from the Report/);
  assert.match(html, /Match Groups/);
  assert.match(html, /Archive overlap/);
});

// --- U: no account/email/document-text leakage --------------------------------

test('U (structural): ReuseContextContainer request bodies only ever include the exact allowed fields', () => {
  const source = fs.readFileSync(path.join(repo, 'components/reuse-context/reuse-context-container.tsx'), 'utf8');
  const bodies = [...source.matchAll(/JSON\.stringify\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 4, 'expected at least 4 POST body literals (declare, revoke, confirm, reject)');
  const forbidden = /accountId|email|session|token|declaredByAccountId|confirmingAccountId|revokedByAccountId/i;
  for (const body of bodies) {
    assert.doesNotMatch(body, forbidden, `request body must never include: ${body}`);
  }
});

test('U2 (structural): no new E8S UI file references email/password/canonical text', () => {
  // stripComments avoids the recurring self-referential false positive seen
  // elsewhere in this repo (e.g. reuse-context-container.tsx's own header
  // comment names "email" to explain what's deliberately never sent).
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }
  for (const file of [
    'lib/e8s-report-integration.ts',
    'components/reuse-context/reuse-context-panel.tsx',
    'components/reuse-context/original-submitter-confirmation-panel.tsx',
    'components/reuse-context/reuse-context-container.tsx',
  ]) {
    const source = stripComments(fs.readFileSync(path.join(repo, file), 'utf8'));
    assert.doesNotMatch(source, /password_hash|canonical_text|raw_sha256|\bemail\b/i, `${file} must never reference email/password/canonical text`);
  }
});

// --- V: stale mutation handling (structural: every handler unconditionally re-fetches) ---

test('V (structural): every mutation handler in ReuseContextContainer unconditionally re-fetches fresh state afterward', () => {
  const source = fs.readFileSync(path.join(repo, 'components/reuse-context/reuse-context-container.tsx'), 'utf8');
  const handlers = ['handleDeclare', 'handleWithdraw', 'handleConfirm', 'handleReject'];
  for (const handler of handlers) {
    const match = source.match(new RegExp(`async function ${handler}[\\s\\S]*?\\n  \\}`));
    assert.ok(match, `${handler} must exist`);
    const body = match[0];
    assert.match(body, /await (refreshStatus|refreshPending)\(\)/, `${handler} must unconditionally re-fetch fresh state after its API call, not assume success from the click`);
  }
});

// --- W: structural score-independence of every new UI module -------------------

test('W (structural): no new E8S Step 11 file references score/archiveScore/aiScore/verifiedSimilarity as a code identifier', () => {
  const CODE_IDENTIFIER_PATTERN = /archiveScore|aiScore|verifiedSimilarity|matchedWordCount|\bcontainment\b|\.score\b|\bscore\s*[:=]/i;
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }
  for (const file of [
    'lib/e8s-report-integration.ts',
    'components/reuse-context/reuse-context-panel.tsx',
    'components/reuse-context/original-submitter-confirmation-panel.tsx',
    'components/reuse-context/reuse-context-container.tsx',
  ]) {
    const source = stripComments(fs.readFileSync(path.join(repo, file), 'utf8'));
    assert.doesNotMatch(source, CODE_IDENTIFIER_PATTERN, `${file} must never reference score/archiveScore/aiScore/verifiedSimilarity/containment/matchedWordCount as a code identifier`);
  }
});
