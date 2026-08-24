import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewReport } from '../components/report/similarity-report-papers.tsx';
import { ReportHistoryRow } from '../components/reports/report-history-row.tsx';
import { SimilarityMetricTile } from '../app/reports/rooms/[room]/room-page-shell.tsx';

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

// --- SIM-04 (acceptance-check hardening): room tile render-level coverage ----
// Release-hardening audit finding SIM-04 (acceptance-check hardening): the
// room card's Similarity tile previously rendered
// `occupant.report.primaryScore ?? occupant.report.archiveScore`
// unconditionally, with no regard for similarityStatus at all — a real gap
// (findRoomOccupant already fell back to archiveScore correctly while
// stale/pending, but this tile then showed that fallback as if it were
// final). Extracted into SimilarityMetricTile (app/reports/rooms/[room]/
// room-page-shell.tsx) specifically so it could be covered by a real render
// test instead of the weaker structural source-count assertion this section
// used to have — SimilarityMetricTile itself takes no hooks (it's a plain
// presentational function despite living in a "use client" file), so
// renderToStaticMarkup exercises the exact same component RoomPageShell
// renders in production, at both its "ready" and "failed" call sites.

function renderSimilarityTile(summary) {
  return renderToStaticMarkup(React.createElement(SimilarityMetricTile, { report: summary, room: 0 }));
}

function baseRoomSummary(overrides = {}) {
  return {
    id: 'room-tile-fixture-1', submissionId: 'sub-room-tile-fixture-1', title: 'room-tile-fixture.pdf',
    createdAt: new Date().toISOString(), wordCount: 500, archiveScore: 0,
    scoreBand: 'Low', aiScore: null, aiTone: null,
    ...overrides,
  };
}

test('SIM-04 ROOM TILE: a current, resolved unified result shows 100% immediately, as a working link into the full report — no neutral placeholder once resolution is genuinely current', () => {
  const summary = baseRoomSummary({ archiveScore: 0, primaryScore: 100, isUnified: true, similarityStatus: 'resolved' });
  const html = renderSimilarityTile(summary);
  assert.match(html, /<strong class="room-metric-value">100%<\/strong>/);
  assert.doesNotMatch(html, /Updating…|Calculating…/);
  assert.match(html, new RegExp(`href="/reports/${summary.id}\\?room=0"`), 'the ready-state tile must always link into the full report');
});

test('SIM-04 ROOM TILE: a deterministic flag-off archive-only result shows 0% immediately — "resolved" does not mean "must be nonzero," a genuine 0% is allowed to render right away', () => {
  const html = renderSimilarityTile(baseRoomSummary({ archiveScore: 0, primaryScore: 0, isUnified: false, similarityStatus: 'resolved' }));
  assert.match(html, /<strong class="room-metric-value">0%<\/strong>/);
  assert.doesNotMatch(html, /Updating…|Calculating…/);
});

test('SIM-04 ROOM TILE: a generation-stale result shows neutral "Updating…" text — neither the old persisted 100% nor the archive-only 0% ever renders', () => {
  // archiveScore=0, and this fixture also carries what the OLD persisted
  // number would have been (primaryScore=100, isUnified=true) — simulating
  // a caller that forgot to re-derive them for a stale status — to prove
  // the tile itself never reads primaryScore/isUnified at all once
  // similarityStatus isn't "resolved" (the discriminated union backing this
  // means it structurally cannot, but this is the rendered proof of that).
  const html = renderSimilarityTile(baseRoomSummary({ archiveScore: 0, primaryScore: 100, isUnified: true, similarityStatus: 'stale' }));
  assert.match(html, /Updating…/);
  assert.doesNotMatch(html, /0%/, 'must never show the archive-only fallback while stale');
  assert.doesNotMatch(html, /100%/, 'must never show the old persisted number while stale');
});

test('SIM-04 ROOM TILE: a flag-roll-forward stale result (CORPUS_SOURCE_MATCHING_ENABLED just turned back on) renders identically to a generation-stale one — every "stale" origin gets the same neutral treatment, never leaking which kind it was', () => {
  const html = renderSimilarityTile(baseRoomSummary({ archiveScore: 0, primaryScore: 0, isUnified: false, similarityStatus: 'stale' }));
  assert.match(html, /Updating…/);
  assert.doesNotMatch(html, /0%/);
  assert.doesNotMatch(html, /100%/);
});

test('SIM-04 ROOM TILE: a pending result (finalization never completed, e.g. a write-time timeout/failure) shows neutral "Calculating…" text — the save still succeeded, but nothing here pretends a number was ever computed', () => {
  const html = renderSimilarityTile(baseRoomSummary({ archiveScore: 0, similarityStatus: 'pending' }));
  assert.match(html, /Calculating…/);
  assert.doesNotMatch(html, /0%/);
  assert.doesNotMatch(html, /100%/);
});

test('LIFECYCLE-06 ROOM TILE: a genuine, persisted terminal similarity failure shows "Unavailable" — a real completed state, distinct from the still-in-progress "···" pending/stale placeholder, and never a number even when a stale primaryScore/archiveScore is also present on the summary', () => {
  // Mirrors the "generation-stale" test above's own discipline: this
  // fixture ALSO carries what a leftover/stale primaryScore/archiveScore
  // might look like, to prove the tile never reads them once
  // similarityStatus is "failed" (the discriminated union backing this
  // means it structurally cannot; this is the rendered proof).
  const html = renderSimilarityTile(baseRoomSummary({ archiveScore: 0, primaryScore: 100, isUnified: true, similarityStatus: 'failed' }));
  assert.match(html, /<div class="room-metric room-metric-unavailable">/, 'REQUIRED: must render the same non-link "Unavailable" treatment the AI tile already uses for its own genuine failure state');
  assert.match(html, /<strong class="room-metric-value">—<\/strong>/);
  assert.match(html, /<span class="room-metric-sub">Unavailable<\/span>/);
  assert.doesNotMatch(html, /···|Calculating…|Updating…/, 'must not be confused with the still-in-progress placeholder — this is a terminal, completed state');
  assert.doesNotMatch(html, /0%|100%/, 'must never show a number, stale or otherwise');
  assert.doesNotMatch(html, /<a\b|href=/, 'REQUIRED: unlike the pending/stale tile, the failed tile must not be a link — matches the AI-unavailable tile\'s own non-link treatment, since there is no further detail to click through to');
});

test('SIM-04 ROOM TILE: an absent similarityStatus (a caller predating this field) is treated as resolved, not neutral — legacy summaries keep rendering exactly as before', () => {
  const html = renderSimilarityTile(baseRoomSummary({ archiveScore: 42 }));
  assert.match(html, /<strong class="room-metric-value">42%<\/strong>/);
  assert.doesNotMatch(html, /Updating…|Calculating…/);
});

// --- Structural coverage for surfaces that cannot be rendered directly --------
// app/reports/[id]/report-detail-shell.tsx and
// app/reports/rooms/[room]/room-page-shell.tsx's own top-level exported
// components are stateful "use client" components (useState/useEffect/
// useRouter) not safely renderable via renderToStaticMarkup — matching
// tests/report-detail-route.test.mjs's own established convention, these
// assert on the source text directly. SimilarityMetricTile above is the one
// piece of room-page-shell.tsx that IS safely renderable (no hooks of its
// own), which is exactly why it was extracted.

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

test('SIM-04/LIFECYCLE-05 ROOM CARD (structural): only the fully-revealed "ready" and "failed" occupant states render Similarity through SimilarityMetricTile — the not-yet-revealed branch hardcodes its own neutral tile instead', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/rooms/[room]/room-page-shell.tsx'), 'utf8');
  const occurrences = shell.match(/<SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>/g) ?? [];
  // Release-hardening audit finding LIFECYCLE-05 (superseding LIFECYCLE-03):
  // "reveal AI score, unified similarity score, and receipt together" —
  // SimilarityMetricTile's own real percentage/link must never render until
  // isFullyRevealed(occupant) is true, so it is back to exactly 2 call
  // sites (the "ready" and "failed" branches, both now additionally gated
  // on isFullyRevealed) — see tests/room-processing-navigation.test.mjs for
  // the dedicated coverage of the not-revealed branch's own hardcoded,
  // non-clickable placeholder.
  assert.equal(occurrences.length, 2, 'expected exactly 2 call sites: the fully-revealed "ready" and "failed" occupant states');
  // The old inline `primaryScore ?? archiveScore` pattern must be gone from
  // the occupant-status blocks entirely — SimilarityMetricTile's own gating
  // on similarityStatus is now the ONLY place that decision is made (see the
  // SIM-04 ROOM TILE render tests above for its actual behavior).
  assert.doesNotMatch(shell, /occupant\.report\.primaryScore \?\? occupant\.report\.archiveScore/, 'the raw fallback expression must no longer appear inline at any call site');
});

test('SIM-01 RECEIPT (structural): downloadReceipt passes primarySimilarityScore/hasUnifiedSimilarity into the receipt, and receipt-pdf.ts labels the archive component as a clearly separate breakdown row, never the overall result', async () => {
  const pipeline = await fs.promises.readFile(path.join(repo, 'lib/document-check-pipeline.ts'), 'utf8');
  assert.match(pipeline, /const primaryScore = primarySimilarityScore\(report\);/);
  assert.match(pipeline, /hasUnifiedSimilarity\(report\)/);

  const receipt = await fs.promises.readFile(path.join(repo, 'lib/receipt-pdf.ts'), 'utf8');
  assert.match(receipt, /rows\.push\(\["TurnitPlus Similarity", `\$\{report\.unified\.score\}% - \$\{report\.unified\.label\}`\]\);/, 'the receipt\'s headline row must be the unified/combined result when present');
  assert.match(receipt, /rows\.push\(\["Similarity result \(component\)", `\$\{report\.archiveScore \?\? report\.score\}% - \$\{report\.scoreBand\}`\]\);/, 'the archive score must appear only as a row explicitly labeled "(component)" — never presented as the overall result, per requirement 3');
});

// --- SIM-02, refined by SIM-04: never a transient archive-only number while
// resolution is pending, and never the stale persisted number while it is
// known outdated ---
// Regression coverage for a second, related production bug: a room card
// permanently showed 0% (lib/reports-repo.ts's findRoomOccupant had no
// access to the combined result at all — covered directly against a real DB
// in tests/report-primary-similarity.test.mjs), and opening a report first
// flashed 0% before settling on the real 100% once background enrichment
// resolved. OverviewReport's own `similarityStatus` prop (default
// "resolved", so every existing call site/test above is unaffected) is the
// mechanism app/reports/[id]/report-detail-shell.tsx now uses to suppress
// that flash, and — since SIM-04 — to suppress a known-outdated persisted
// score too, showing "Updating similarity…" in its place instead.

function renderPending(report, similarityStatus) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report, similarityStatus }));
}

test('SIM-02 (2): while pending, OverviewReport never renders the archive-only score, even when it is a plausible-looking 0%', () => {
  const html = renderPending(baseReport({ archiveScore: 0, matchedWordCount: 0 }), 'pending');
  const headingSection = html.match(/<section class="similarity-heading[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(headingSection, 'the similarity-heading section must be found');
  assert.doesNotMatch(headingSection, /%/, 'no percentage of any kind may render in the headline section while pending');
  assert.doesNotMatch(html, /Similarity result|TurnitPlus Similarity/, 'neither the archive-only label nor the unified label may render anywhere while pending — only the pending state itself');
  assert.match(html, /Calculating similarity…/);
});

test('SIM-02 (2): while pending, OverviewReport never renders the archive-only score even when the real (not-yet-known) unified result would be 100%', () => {
  // The report already HAS a real, correct unifiedSimilarity attached in
  // this fixture (simulating "the server actually finished, but the caller
  // hasn\'t updated its own status yet") — pending must still win: the
  // caller is the one asserting resolution is not final yet, and
  // OverviewReport must not second-guess that by reading report fields.
  const html = renderPending(baseReport({
    archiveScore: 0,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }), 'pending');
  assert.match(html, /Calculating similarity…/);
  // Everything derived from unifiedSimilarity/historicalSubmissionMatch —
  // UnifiedSimilaritySection's own "TurnitPlus Similarity" heading and the
  // "Previously submitted content" historical-match block — must be
  // entirely absent while pending, not merely unlabeled. (MatchGroups and
  // CategorySummary further down the page legitimately render their own
  // unrelated archive-scoped "0%" figures regardless of pending — this
  // assertion is scoped to only the matching-derived sections, not the
  // whole page, for exactly that reason.)
  assert.doesNotMatch(html, /TurnitPlus Similarity|Previously submitted content|corpus reference source/);
});

test('SIM-04: while stale, OverviewReport shows "Updating similarity…" — never the old persisted score alongside it, and never the pending wording', () => {
  const html = renderPending(baseReport({
    archiveScore: 0,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }), 'stale');
  const headingSection = html.match(/<section class="similarity-heading[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(headingSection, 'the similarity-heading section must be found');
  assert.doesNotMatch(headingSection, /%/, 'no percentage — old or new — may render in the headline section while stale');
  assert.match(html, /Updating similarity…/, 'stale must use its own distinct wording, not the pending one');
  assert.doesNotMatch(html, /Calculating similarity…/, 'stale and pending must never share wording — the user needs to know a real result already exists and is only being refreshed');
  assert.doesNotMatch(html, /TurnitPlus Similarity|Previously submitted content|corpus reference source/, 'the old, now-untrusted unifiedSimilarity/historicalSubmissionMatch content must not render either');
});

test('LIFECYCLE-06: while failed, OverviewReport shows "Similarity unavailable" — a distinct, non-busy terminal placeholder, never the pending/stale wording, never a score, and never the matching-derived sections', () => {
  const html = renderPending(baseReport({
    archiveScore: 0,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }), 'failed');
  const headingSection = html.match(/<section class="similarity-heading[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(headingSection, 'the similarity-heading section must be found');
  assert.doesNotMatch(headingSection, /%/, 'no percentage may render in the headline section while failed');
  assert.match(html, /Similarity unavailable/, 'failed must use its own distinct wording, not pending/stale');
  assert.doesNotMatch(html, /Calculating similarity…|Updating similarity…/, 'failed and pending/stale must never share wording — the user needs to know this will not resolve on its own');
  // Terminal, not still-working: aria-busy must be false and no skeleton
  // spinner rendered, unlike the pending/stale placeholder.
  assert.doesNotMatch(headingSection, /aria-busy="true"/, 'REQUIRED: a terminal failure is not "still working" — aria-busy must not claim otherwise');
  assert.doesNotMatch(headingSection, /similarity-skeleton/, 'REQUIRED: no loading spinner for a terminal, completed-but-unavailable state');
  assert.doesNotMatch(html, /TurnitPlus Similarity|Previously submitted content|corpus reference source/, 'the old, now-untrusted unifiedSimilarity/historicalSubmissionMatch content must not render either');
});

test('SIM-02 (3): once settled, a genuine unified 0% still renders as a real 0% — pending never masks a truthful zero', () => {
  const html = renderPending(baseReport({
    archiveScore: 0,
    unifiedSimilarity: unified({ unifiedScore: 0, uniqueMatchedWords: 0, archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0 }),
  }), 'resolved');
  assert.match(html, /<span>0%<\/span> TurnitPlus Similarity/, 'a genuinely settled 0% (unified computed, nothing matched) must render exactly as 0%, not be hidden or blocked');
  assert.doesNotMatch(html, /Calculating similarity…/);
});

test('SIM-02 (3): once settled, the real resolved 100% renders normally — "resolved" is the only status that unblocks it', () => {
  const html = renderPending(baseReport({
    archiveScore: 0,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }), 'resolved');
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/);
  assert.doesNotMatch(html, /Calculating similarity…/);
});

test('SIM-04: a live flag-off rollback renders the archive-only 0% immediately as "Similarity result," never "TurnitPlus Similarity" and never a neutral placeholder — matching what app/reports/[id]/page.tsx actually hands OverviewReport (unifiedSimilarity stripped, status "resolved")', () => {
  // Mirrors loadOwnedReport's own documented behavior exactly: a "resolved"
  // + archive-only display.status deletes payload.unifiedSimilarity before
  // this component ever sees the report (see app/reports/[id]/page.tsx's
  // own comment) — so the fixture here has NO unifiedSimilarity at all,
  // just like the real report object would.
  const html = renderPending(baseReport({ archiveScore: 0, matchedWordCount: 0 }), 'resolved');
  assert.match(html, /<span>0%<\/span> Similarity result/, 'the archive-only 0% must render immediately and honestly — "resolved" never means "wait," even at 0%');
  assert.doesNotMatch(html, /TurnitPlus Similarity/, 'must never claim the unified label — this report never had a trustworthy unified result once the flag rolled back');
  assert.doesNotMatch(html, /Calculating similarity…|Updating similarity…/);
});

test('SIM-02: similarityStatus defaults to "resolved" — every pre-existing caller of OverviewReport (print bundle, every other test fixture in this codebase) renders exactly as before', () => {
  const html = renderToStaticMarkup(React.createElement(OverviewReport, { report: baseReport({ archiveScore: 42 }) }));
  assert.match(html, /<span>42%<\/span> Similarity result/);
  assert.doesNotMatch(html, /Calculating similarity…/);
});

test('SIM-04/LIFECYCLE-04 SIDEBAR/WIRING (structural): report-detail-shell.tsx still tracks the similarityStatus tri-state, seeded from the server-computed initialSimilarityStatus, and every exit point of both background effects resolves it — but the tri-state itself now only ever feeds a single combined reveal gate (lib/report-detail-poll.ts\'s computeDetailRevealState), not scattered per-surface pending/stale ternaries', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/[id]/report-detail-shell.tsx'), 'utf8');
  assert.match(
    shell,
    /const \[similarityStatus, setSimilarityStatus\] = useState<DetailSimilarityStatus>\(\s*mode !== "similarity"\s*\?\s*"resolved"\s*:\s*\(initialSimilarityStatus \?\? \(initialReport !== null && hasUnifiedSimilarity\(initialReport\) \? "resolved" : "pending"\)\),\s*\);/,
    'must start from the server-computed initialSimilarityStatus when present, never unconditionally "pending" for similarity mode',
  );
  // Release-hardening audit finding LIFECYCLE-04: the OLD design derived
  // similarityPending/similarityStale/similarityNotResolved from this same
  // tri-state and threaded them through the summary strip, sidebar, AND
  // OverviewReport individually — three independently-gated surfaces that
  // could in principle drift apart. The NEW design collapses all of that
  // into ONE combined reveal gate (lib/report-detail-poll.ts's
  // computeDetailRevealState) guarding the entire report render as a
  // single unit — see the "one stable loading screen" structural test
  // below for that gate itself.
  assert.doesNotMatch(shell, /const similarityPending = /, 'the old scattered per-surface pending flag must be gone — the shared reveal gate is the only one now');
  assert.doesNotMatch(shell, /const similarityNotResolved = /, 'the old scattered per-surface not-resolved flag must be gone');
  // Every exit point of both background effects must still resolve the
  // status — not only the "we got real data" branch (an explicit archive
  // fallback, never endless loading/staleness). The anonymous path's two
  // settle points still call setSimilarityStatus("resolved") literally (no
  // failure concept for that client-only-generated path — see this
  // component's own comment on why); the authenticated poll's own settle
  // point now computes the real status (resolved/failed/pending) into
  // resolvedSimilarityStatus first — see the dedicated LIFECYCLE-06 test
  // below for that specific call site.
  const setResolvedCount = (shell.match(/setSimilarityStatus\("resolved"\)/g) ?? []).length;
  assert.ok(setResolvedCount >= 2, `expected at least 2 literal call sites resolving the status for the anonymous path (local+remote settle, remote-only settle) — found ${setResolvedCount}`);
  assert.match(shell, /setSimilarityStatus\(resolvedSimilarityStatus\);/, 'the authenticated poll path must resolve the REAL status (resolved/failed/pending), not hardcode "resolved" — see this file\'s own LIFECYCLE-06 tests for what resolvedSimilarityStatus is derived from');
});

test('LIFECYCLE-04/06 SIDEBAR/WIRING (structural): the ENTIRE report render — summary strip, tabs, OverviewReport, sidebar, print bundle — is gated behind the ONE shared reveal decision (computeDetailRevealState, imported from lib/report-detail-poll.ts); nothing downstream needs its own per-surface pending/stale ternary, and there is no local reimplementation of the terminal/exhaustion logic', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/[id]/report-detail-shell.tsx'), 'utf8');
  assert.match(shell, /import \{\s*\n\s*computeDetailRevealState,\s*\n\s*startBoundedPoll,\s*\n\s*type DetailAiStatus,\s*\n\s*type DetailSimilarityStatus,\s*\n\s*\} from "@\/lib\/report-detail-poll";/, 'REQUIRED: the reveal/poll logic must be imported from the shared, independently-tested module, not reimplemented inline');
  assert.match(shell, /const revealState = computeDetailRevealState\(\{ aiStatus, similarityStatus: effectiveSimilarityStatus, pollExhausted \}\);/);
  assert.match(shell, /const bothReady = revealState\.screen === "revealed";/, 'REQUIRED: reveal AI score, unified similarity score, and receipt together — one combined gate, not two independent ones');
  assert.match(shell, /if \(revealState\.screen === "still-processing"\) \{/);
  assert.match(shell, /if \(revealState\.screen === "loading"\) \{/, 'the entire render must return a loading/still-processing screen unless revealState.screen is "revealed", before any score/section renders at all');

  // Release-hardening audit finding LIFECYCLE-06 (corrected, then
  // extended): an earlier version of this fix let poll exhaustion
  // synthesize a fake "similarity unavailable" terminal state and unblock
  // a partial reveal — that specific bug is gone (see
  // tests/report-detail-poll.test.mjs's own proof that pollExhausted alone
  // can never produce "revealed"). But a REAL terminal-failure signal now
  // exists (lib/report-primary-similarity.ts's resolvePrimarySimilaritySummary
  // itself failing, propagated as DetailSimilarityStatus "failed"), so
  // "revealed" no longer strictly implies "resolved" the way it did right
  // after the correction — OverviewReport must be told the real status
  // explicitly again, this time backed by genuine pipeline state rather
  // than poll timing.
  const overviewReportCalls = (shell.match(/<OverviewReport report=\{report\} similarityStatus=\{effectiveSimilarityStatus\} \/>/g) ?? []).length;
  assert.equal(overviewReportCalls, 3, 'expected 3 call sites: full-report-preview, the standalone overview tab, and the print bundle, each passing the real status explicitly');
  // The summary-strip chip and sidebar score render primaryScore only once
  // revealState.similarityUnavailable is ruled out — never a guessed
  // number for a similarity that genuinely, terminally failed.
  assert.match(shell, /revealState\.similarityUnavailable \? "Unavailable" : `\$\{primaryScore\}% \$\{primaryLabel\}`/, 'the summary-strip score chip must show literal Unavailable text, never a number, when similarity genuinely, terminally failed');
  assert.doesNotMatch(shell, /similarityStatusLabel/, 'the old pending/stale label variable must be gone entirely — revealState.similarityUnavailable is the only gate now');
});

// --- SIM-04 NO-FLASH: the detail page's own two-frame transition -------------
// "The report detail must also avoid briefly flashing 0% before changing to
// 100%." report-detail-shell.tsx itself can't be mounted/re-rendered here
// (no hooks lifecycle in this test environment — see the structural-coverage
// note above), so this is proven two ways: (1) a render-level check of the
// exact TWO frames the shell can ever produce — its first paint (seeded
// from the server-computed initialSimilarityStatus) and its settled paint
// (after the background fetch resolves) — each rendered through the SAME
// OverviewReport component the shell itself calls, confirming neither frame
// individually shows a stray percentage; and (2) a structural check that the
// two state updates driving that transition (setSimilarityStatus("resolved")
// and setReport(...)) are synchronous, adjacent statements in the same
// .then() callback with no await between them, which is what makes React
// batch them into ONE commit — ruling out a THIRD, intermediate frame where
// status has already flipped to "resolved" but the report still carries the
// old (or absent) unifiedSimilarity.

test('SIM-04 NO-FLASH: first paint while stale shows no percentage in the similarity headline at all, and the settled paint after the background fetch lands directly on the real 100% — never an intermediate 0%', () => {
  const before = renderPending(baseReport({ archiveScore: 0, matchedWordCount: 0 }), 'stale');
  const beforeHeadline = before.match(/<section class="similarity-heading[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(beforeHeadline, 'the similarity-heading section must be found');
  assert.doesNotMatch(beforeHeadline, /%/, 'REQUIRED: no percentage — old or new, 0% or otherwise — may appear in the headline on first paint while stale');
  assert.match(beforeHeadline, /Updating similarity…/);

  const after = renderPending(baseReport({
    archiveScore: 0,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified(),
  }), 'resolved');
  const afterHeadline = after.match(/<section class="similarity-heading[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(afterHeadline);
  assert.match(afterHeadline, /<span>100%<\/span> TurnitPlus Similarity/, 'REQUIRED: the settled paint must be the real 100%');
  // (?<!\d)0% — a bare "0%" not preceded by another digit, so this does not
  // false-positive on the trailing "0%" inside the real "100%" above.
  assert.doesNotMatch(afterHeadline, /(?<!\d)0%/, 'the settled headline must never show a standalone 0% either — the fixture\'s own archiveScore is 0, so this catches any code path that fell back to it instead of the real unified result');
});

test('LIFECYCLE-04/06 NO-FLASH (structural): setSimilarityStatus(resolvedSimilarityStatus) and setReport(...) are still synchronous, adjacent statements inside checkOnce — no await between them, so React batches both into one commit and a "resolved/failed but still showing the old report" frame cannot occur, even now that checkOnce is called repeatedly by the poll loop and resolves a genuine failed state too', async () => {
  const shell = await fs.promises.readFile(path.join(repo, 'app/reports/[id]/report-detail-shell.tsx'), 'utf8');
  const checkOnceFn = shell.match(/async function checkOnce\(\): Promise<boolean> \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
  assert.ok(checkOnceFn, 'the authenticated poll loop\'s checkOnce function must be found');
  // resolvedSimilarityStatus itself must be computed BEFORE these two
  // adjacent statements (so its own derivation — a plain ternary, never a
  // promise — cannot introduce an await boundary), and the two setState
  // calls must remain adjacent with nothing async between them.
  assert.match(checkOnceFn, /const resolvedSimilarityStatus: DetailSimilarityStatus = enriched\.unifiedSimilarityFailed\s*\?\s*"failed"\s*:\s*hasUnifiedSimilarity\(enriched\)\s*\?\s*"resolved"\s*:\s*"pending";/, 'resolvedSimilarityStatus must be derived from the real, persisted unifiedSimilarityFailed/hasUnifiedSimilarity signals, never hardcoded');
  assert.match(
    checkOnceFn,
    /setSimilarityStatus\(resolvedSimilarityStatus\);\s*setReport\(/,
    'setSimilarityStatus and setReport must be adjacent synchronous statements — any await/promise boundary inserted between them would let React commit the new status on its own frame first',
  );
  // REQUIRED (LIFECYCLE-04): a genuinely failed poll response must never be
  // treated as a resolution — checkOnce must return before touching either
  // piece of state at all, not just skip the ai_status branches.
  assert.match(checkOnceFn, /if \(!enriched\) return false;/, 'a failed/inconclusive poll must bail out before setSimilarityStatus is ever called');
});
