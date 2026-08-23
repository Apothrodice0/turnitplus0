import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewReport } from '../components/report/similarity-report-papers.tsx';
import { ReportHistoryRow } from '../components/reports/report-history-row.tsx';

/**
 * Release-hardening audit finding SIM-01: regression coverage for a real
 * production Preview report where the corpus-source match, the right
 * sidebar, and the "TurnitPlus Similarity" section all showed 100%, but the
 * main "Similarity result" headline said 0% with "30 matched words" —
 * because OverviewReport (components/report/similarity-report-papers.tsx)
 * read archiveOverlapScore/archiveMatchedWordCount directly instead of the
 * already-correct primarySimilarityScore/primaryMatchedWordCount selectors
 * (lib/report-types.ts), which app/reports/[id]/report-detail-shell.tsx's
 * sidebar score card already used. tests/report-types-unified-display.test.mjs
 * covers the underlying pure selectors directly; this file covers the
 * rendered surfaces (OverviewReport's headline/band/banner, the room/history
 * card, and — via structural source assertions, matching this codebase's
 * existing convention for "use client" components with hooks that can't be
 * rendered via renderToStaticMarkup, see tests/report-detail-route.test.mjs
 * — the sidebar and the room page's own inline score tile).
 */

const repo = path.resolve('.');

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: 'sub-sim01-1',
    title: 'sim01-fixture.pdf',
    author: '',
    assignment: '',
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 10000,
    characterCount: 60000,
    pageCount: 20,
    fileSize: '80 KB',
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
    matchedWordCount: 30,
    sources: [],
    repeats: [],
    text: 'fixture text not used by OverviewReport directly',
    ...overrides,
  };
}

function unified(overrides = {}) {
  return {
    version: 'unified-similarity-v1',
    wordCount: 10000,
    unifiedScore: 100,
    uniqueMatchedWords: 9895,
    archiveOnlyWords: 30,
    liveAcademicOnlyWords: 0,
    previousUploadOnlyWords: 9865,
    overlapWords: 0,
    selfExcludedWords: 0,
    unknownExcludedWords: 0,
    contributions: [],
    ...overrides,
  };
}

// The exact real-world scenario: a corpus-source match (relationshipType
// TURNITPLUS_CORPUS_SOURCE — no account or report is ever associated with
// it, per lib/user-submission-matching.ts's own RelationshipType comment)
// is what drove unifiedScore to 100% while archiveScore stayed 0.
const CORPUS_SOURCE_MATCH = {
  status: 'MATCHED',
  computedAt: new Date().toISOString(),
  matcherVersion: 'user-submission-match-v1',
  fingerprintVersion: 'corpus-shingle-v1',
  canonicalizationVersion: 'canonical-text-v1',
  matches: [
    {
      relationshipType: 'TURNITPLUS_CORPUS_SOURCE',
      matchedRepresentationId: 'rep-corpus-source-1',
      matchType: 'EXACT_CANONICAL_MATCH',
      containment: 1,
      matchedWordCount: 9865,
      passageCount: 1,
      longestMatchWords: 9865,
      passages: [{ submittedText: 'a bounded excerpt of the current document only', submittedWordStart: 0, submittedWordEnd: 9864, matchedWordCount: 9865 }],
      historicalSubmissionCount: 0,
    },
  ],
};

function render(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}

// --- (a) archive score 0% + corpus source 100% -------------------------------

test('SIM-01 (a): archive 0% + corpus-source 100% — the headline shows 100% TurnitPlus Similarity, never the archive-only 0%', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/, 'the main headline must show the combined 100% result under the unified label');
  assert.doesNotMatch(html, /<span>0%<\/span> Similarity result/, 'the archive-only 0% must never be what the headline shows when a unified result exists');
});

test('SIM-01 (a): the headline band matches a 100% score (High), not the archive-only 0% (which would render no band at all above the low/high thresholds oddly, or Low)', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  assert.match(html, /similarity-verdict-high/, 'a 100% combined score must render the High-similarity verdict class');
  assert.doesNotMatch(html, /similarity-verdict-low/, 'must not render the Low verdict that a 0% archive score alone would produce');
});

// --- (b) archive overlap plus corpus overlap, deduplicated total -------------

test('SIM-01 (b): archive overlap plus corpus overlap at the same submitted passage — the banner cites the deduplicated total, never a naive double-counted sum', () => {
  const html = render(baseReport({
    matchedWordCount: 200,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified({
      unifiedScore: 20,
      uniqueMatchedWords: 200,
      archiveOnlyWords: 50,
      previousUploadOnlyWords: 50,
      liveAcademicOnlyWords: 0,
      overlapWords: 100, // the same passage matched by both archive and corpus-source — counted once
    }),
  }));
  assert.match(html, /TurnitPlus found 200 matched words across identified sources/, 'must cite the already-deduplicated 200, not 300 (50+50+100+100 double-counted) or 30 (archive-only)');
});

// --- (c) every overall-score surface agrees -----------------------------------

test('SIM-01 (c): within one rendered report, the headline percentage and the TurnitPlus Similarity section percentage are identical', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  const headlineMatch = html.match(/<span>(\d+)%<\/span> TurnitPlus Similarity/);
  const sectionMatch = html.match(/<span>(\d+)%<\/span> TurnitPlus Similarity<\/h2>/) ?? html.match(/(\d+)%<\/span> TurnitPlus Similarity/g);
  assert.ok(headlineMatch, 'the headline must render a percentage next to "TurnitPlus Similarity"');
  // UnifiedSimilaritySection (rendered directly below the headline) uses the
  // exact same "<span>{unified.unifiedScore}%</span> TurnitPlus Similarity"
  // markup shape as the headline itself — both must report the identical
  // figure computed from the SAME report.unifiedSimilarity, proving there is
  // only one authoritative combined number on the page, not two that could
  // silently drift apart.
  const allPercents = [...html.matchAll(/<span>(\d+)%<\/span> TurnitPlus Similarity/g)].map((m) => m[1]);
  assert.equal(allPercents.length, 2, 'exactly two surfaces on this page report "TurnitPlus Similarity": the headline and UnifiedSimilaritySection');
  assert.equal(allPercents[0], allPercents[1], 'the headline and the TurnitPlus Similarity section must show the identical percentage');
});

test('SIM-01 (c): a report with no unifiedSimilarity computed renders the archive-only fallback identically labeled everywhere on the page (no partial/contradicting unified mentions)', () => {
  const html = render(baseReport({ archiveScore: 18, matchedWordCount: 40 }));
  assert.match(html, /<span>18%<\/span> Similarity result/);
  assert.doesNotMatch(html, /TurnitPlus Similarity/, 'the unified label/section must never appear when no unified result was computed');
});

// --- (d) archive-only breakdown remains correctly labeled ---------------------

test('SIM-01 (d): the archive-only Match Groups breakdown still reflects the archive component specifically, distinct from and never overwritten by the unified headline', () => {
  const html = render(baseReport({
    archiveScore: 3,
    matchedWordCount: 30,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/, 'headline must still be the combined 100%');
  assert.match(html, /Not Cited or Quoted/, 'the archive-scoped Match Groups breakdown must still render');
  // MatchGroups' own "Not Cited or Quoted" tile uses archiveOverlapScore
  // directly (3%, this report's archive component) — it must keep doing so,
  // clearly scoped to its own "Match Groups" heading, never silently
  // switched to the unified 100% (which would make an archive-specific
  // classification breakdown lie about what it actually measures).
  const matchGroupsSection = html.match(/<h3>Match Groups<\/h3>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(matchGroupsSection, />3%</, 'Match Groups must still show the archive-only 3% figure, not the unified 100%');
});

test('SIM-01 (d): UnifiedSimilaritySection\'s own evidence breakdown clearly attributes words to their source, never presenting the corpus-source contribution as an unlabeled archive figure', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  assert.match(html, /9,865 words? from an eligible previous TurnitPlus submission/, 'the corpus-source contribution must be labeled as such, not folded into an unlabeled total');
  assert.match(html, /30 words? from TurnitPlus&#x27;s own reference material|30 words? from TurnitPlus's own reference material/, 'the small archive contribution must remain separately, clearly labeled');
});

// --- (e) ordinary users receive no identity information -----------------------

test('SIM-01 (e): the corpus-source match wording is preserved verbatim — no account or report is ever associated with a TURNITPLUS_CORPUS_SOURCE match', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  assert.match(html, /This is not another user&#x27;s submission — no account or report is associated with this match\./, 'the existing de-identified corpus wording must be unchanged by this fix');
});

test('SIM-01 (e): no account identifier, email, or representation id ever appears in the rendered output for an ordinary viewer, even at the exact 100%/0% scenario that triggered this fix', () => {
  const html = render(baseReport({
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }));
  assert.doesNotMatch(html, /@/, 'no email-shaped string should ever appear in a report render');
  assert.doesNotMatch(html, /accountId|account_id/i);
  assert.doesNotMatch(html, /rep-corpus-source-1/, 'the internal representation id must never leak into the rendered output');
});

// --- Room/history card consistency --------------------------------------------

test('SIM-01 ROOM CARD: ReportHistoryRow shows the combined result and the matching label when the summary carries primaryScore/isUnified', () => {
  const summary = {
    id: '1', submissionId: 'sub-1', title: 'sim01-room.pdf', createdAt: new Date().toISOString(),
    wordCount: 10000, archiveScore: 0, primaryScore: 100, isUnified: true,
    scoreBand: 'High', aiScore: null, aiTone: null,
  };
  const html = renderToStaticMarkup(React.createElement(ReportHistoryRow, { report: summary, onDownloadReceipt: async () => {} }));
  assert.match(html, /<strong>100%<\/strong>/, 'the room/history card must show the combined 100%, not the archive-only 0%');
  assert.match(html, /<span>TurnitPlus Similarity<\/span>/);
  assert.doesNotMatch(html, /<strong>0%<\/strong>/);
});

test('SIM-01 ROOM CARD: ReportHistoryRow falls back honestly to archiveScore + "Similarity result" when primaryScore/isUnified are absent (the lightweight DB-only room/history path)', () => {
  const summary = {
    id: '2', submissionId: 'sub-2', title: 'legacy-room.pdf', createdAt: new Date().toISOString(),
    wordCount: 1000, archiveScore: 18, scoreBand: 'Low', aiScore: null, aiTone: null,
  };
  const html = renderToStaticMarkup(React.createElement(ReportHistoryRow, { report: summary, onDownloadReceipt: async () => {} }));
  assert.match(html, /<strong>18%<\/strong>/);
  assert.match(html, /<span>Similarity result<\/span>/);
  assert.doesNotMatch(html, /TurnitPlus Similarity/, 'must never claim the unified label when no unified data was ever attached to this summary');
});

// --- Structural coverage for surfaces that cannot be rendered directly --------
// app/reports/[id]/report-detail-shell.tsx and
// app/reports/rooms/[room]/room-page-shell.tsx are stateful "use client"
// components (useState/useEffect/useRouter) not safely renderable via
// renderToStaticMarkup — matching tests/report-detail-route.test.mjs's own
// established convention, these assert on the source text directly.

test('SIM-01 SIDEBAR (structural): report-detail-shell.tsx\'s Report notes paragraph cites primaryMatchedWordCount, not archiveMatchedWordCount', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/[id]/report-detail-shell.tsx'), 'utf8');
  assert.match(shell, /import \{[\s\S]*?primaryMatchedWordCount[\s\S]*?\} from "@\/lib\/report-types";/, 'must import primaryMatchedWordCount');
  assert.doesNotMatch(shell, /archiveMatchedWordCount/, 'must never read the archive-only word count directly — this is exactly the SIM-01 sidebar inconsistency (correct % next to a stale archive-only count)');
  assert.match(shell, /\{primaryMatchedWordCount\(report\)\.toLocaleString\(\)\} words were matched/);
});

test('SIM-01 SIDEBAR (structural): the score card and the Report notes paragraph both derive from the same primaryScore/primaryLabel/isUnified selectors', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/[id]/report-detail-shell.tsx'), 'utf8');
  assert.match(shell, /const primaryScore = primarySimilarityScore\(report\);/);
  assert.match(shell, /const isUnified = hasUnifiedSimilarity\(report\);/);
  assert.match(shell, /const primaryLabel = primaryResultLabel\(report\);/);
});

test('SIM-01 ROOM CARD (structural): room-page-shell.tsx\'s own inline Similarity tile prefers primaryScore over the archive-only value, in both the ready and failed states', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/rooms/[room]/room-page-shell.tsx'), 'utf8');
  const occurrences = shell.match(/occupant\.report\.primaryScore \?\? occupant\.report\.archiveScore/g) ?? [];
  assert.equal(occurrences.length, 6, 'expected three uses (verdict class, value, verdict label) inside the shared Similarity tile markup, present in both the "ready" and "failed" occupant states (3 x 2 = 6)');
});

test('SIM-01 RECEIPT (structural): downloadReceipt passes primarySimilarityScore/hasUnifiedSimilarity into the receipt, and receipt-pdf.ts labels the archive component as a clearly separate breakdown row, never the overall result', async () => {
  const pipeline = await fs.promises.readFile(path.join(repo, 'lib/document-check-pipeline.ts'), 'utf8');
  assert.match(pipeline, /const primaryScore = primarySimilarityScore\(report\);/);
  assert.match(pipeline, /hasUnifiedSimilarity\(report\)/);

  const receipt = await fs.promises.readFile(path.join(repo, 'lib/receipt-pdf.ts'), 'utf8');
  assert.match(receipt, /rows\.push\(\["TurnitPlus Similarity", `\$\{report\.unified\.score\}% - \$\{report\.unified\.label\}`\]\);/, 'the receipt\'s headline row must be the unified/combined result when present');
  assert.match(receipt, /rows\.push\(\["Similarity result \(component\)", `\$\{report\.archiveScore \?\? report\.score\}% - \$\{report\.scoreBand\}`\]\);/, 'the archive score must appear only as a row explicitly labeled "(component)" — never presented as the overall result, per requirement 3');
});
