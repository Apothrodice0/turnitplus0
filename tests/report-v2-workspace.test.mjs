import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { tokens } from "../lib/similarity-core.ts";
import { primaryMatchedWordCount, primarySimilarityScore } from "../lib/report-types.ts";
import {
  buildReportEvidenceInterpretation,
  resolveReportCompletion,
  unknownExtractionDiagnostic,
} from "../lib/evidence-interpretation/index.ts";
import {
  buildReportV2ViewModel,
  resolveWorkspacePassageSelection,
  stepWorkspaceSelection,
} from "../lib/report-v2-view.ts";
import { ReportV2Workspace } from "../components/report/report-v2/report-v2-view.tsx";

/**
 * Screen-redesign test matrix (task items A-L): the interactive workspace
 * is a stateful client component with no DOM-interaction test harness in
 * this codebase (see tests/report-v2-ui.test.mjs's own header comment for
 * why every report UI test here follows one of two patterns instead:
 * render-to-static-markup for what a given state renders, or reading the
 * real source structurally for what pure logic/CSS/wiring guarantees).
 * Item E/F/G (match IDs, source->match mapping, next/previous bounds) are
 * exercised directly against resolveWorkspacePassageSelection/
 * stepWorkspaceSelection (lib/report-v2-view.ts) — the exact same pure
 * functions the component itself calls, extracted specifically so this
 * logic does not need a click simulation to verify.
 */

const repo = path.resolve(".");
const readSource = (relPath) => fs.readFileSync(path.join(repo, relPath), "utf8");

// ── fixtures (same conventions as tests/report-v2-ui.test.mjs) ───────────
function makeText(n) {
  const words = [];
  for (let i = 0; i < n; i += 1) words.push(`word${i}`);
  return words.join(" ");
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
    author: "test@example.com",
    assignment: "",
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

function withV2(report) {
  const ei = buildReportEvidenceInterpretation(report, {});
  const extractionDiagnostic = unknownExtractionDiagnostic();
  const reportCompletion = resolveReportCompletion({
    academicSearch: report.academicEvidenceStatus ?? null,
    selectiveCorpus: null,
    extraction: extractionDiagnostic,
    unverifiedCandidateCount: 0,
    verifiedSimilarityPercent: primarySimilarityScore(report),
  });
  return { ...report, evidenceInterpretation: ei, reportCompletion, extractionDiagnostic };
}

const renderWorkspace = (report) => renderToStaticMarkup(React.createElement(ReportV2Workspace, { report }));

// ── E/F/G: pure selection logic — no rendering needed ─────────────────────
test("E/F (stable ids, source -> match mapping): clicking a manuscript passage resolves the SAME source + the passage's own sorted position within that source's passageRefs", () => {
  const vm = {
    sources: [
      { id: "src-1", passageRefs: [5, 2, 9] },
      { id: "src-2", passageRefs: [4] },
    ],
    passages: [
      { id: 2, sourceIds: ["src-1"] },
      { id: 4, sourceIds: ["src-2"] },
      { id: 5, sourceIds: ["src-1"] },
      { id: 9, sourceIds: ["src-1"] },
    ],
  };
  // src-1's own passageRefs sorted: [2, 5, 9] -> passage 9 is index 2.
  assert.deepEqual(resolveWorkspacePassageSelection(vm, 9), { sourceId: "src-1", passageIndex: 2 });
  assert.deepEqual(resolveWorkspacePassageSelection(vm, 2), { sourceId: "src-1", passageIndex: 0 });
  // A different source's own passage resolves to ITS OWN indexing, never src-1's.
  assert.deepEqual(resolveWorkspacePassageSelection(vm, 4), { sourceId: "src-2", passageIndex: 0 });
});

test("E (stable ids, defensive): an unresolvable passage/source id never throws, returns null rather than a guessed selection", () => {
  const vm = { sources: [{ id: "src-1", passageRefs: [1] }], passages: [{ id: 1, sourceIds: ["src-1"] }] };
  assert.equal(resolveWorkspacePassageSelection(vm, 999), null, "unknown passage id");
  const vmOrphanPassage = { sources: [], passages: [{ id: 1, sourceIds: ["src-missing"] }] };
  assert.equal(resolveWorkspacePassageSelection(vmOrphanPassage, 1), null, "source the passage points to no longer exists in vm.sources");
});

test("G (next/previous bounds): stepWorkspaceSelection never moves outside [0, refCount-1], and is a no-op on a null selection", () => {
  assert.equal(stepWorkspaceSelection(null, 5, 1), null, "no active selection -> no-op");
  const first = { sourceId: "src-1", passageIndex: 0 };
  assert.deepEqual(stepWorkspaceSelection(first, 3, -1), first, "Previous at the first match must not move (this is what disables the button)");
  const mid = { sourceId: "src-1", passageIndex: 1 };
  assert.deepEqual(stepWorkspaceSelection(mid, 3, 1), { sourceId: "src-1", passageIndex: 2 }, "Next moves forward one match");
  const last = { sourceId: "src-1", passageIndex: 2 };
  assert.deepEqual(stepWorkspaceSelection(last, 3, 1), last, "Next at the last match must not move (this is what disables the button)");
});

// ── A/C/D/H/I/L: rendered output of the canonical workspace ──────────────
test("A/C: the canonical workspace renders ONE authoritative score (matching primarySimilarityScore), no interactive filter bar, no legacy tab chrome", () => {
  const report = withV2(mkReport({
    text: makeText(500),
    archiveMatchedPositions: range(0, 100),
    sources: [{ name: "Wikipedia — “Fixture”", type: "Internet", percent: 20, matches: 1, matchedWords: 101, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 100), previousUploadPositions: [], unifiedScore: 20, uniqueMatchedWords: 101 },
    score: 20,
  }));
  const html = renderWorkspace(report);
  assert.equal(html.match(/rv2ws-score(?!-metrics|-low|-review|-high)/g)?.length, 1, "exactly one score card");
  assert.match(html, new RegExp(`${primarySimilarityScore(report)}%`), "shows the SAME authoritative score selector every other surface uses");
  assert.doesNotMatch(html, /rv2-filter-bar/, "no interactive filter bar (screen-only card-wall UI) inside the canonical workspace");
  assert.doesNotMatch(html, /report-tabs/, "no legacy tab chrome rendered by the workspace itself");
});

test("D: source numbers are stable and derived from vm.sources' own order (1-based, matching array index)", () => {
  const text = makeText(700);
  const toks = tokens(text);
  const qs = toks.indexOf("word500");
  const qe = toks.indexOf("word560");
  const report = withV2(mkReport({
    text,
    archiveMatchedPositions: range(0, 140),
    sources: [
      { name: "Wikipedia — “First source”", type: "Internet", percent: 20, matches: 1, matchedWords: 141, phrases: [], color: "#0" },
      { name: "openstax.org — Second source", type: "Internet", percent: 8, matches: 1, matchedWords: 60, phrases: [], color: "#1" },
    ],
    externalAcademicEvidence: [{
      provider: "epmc", providerId: "epmc", title: "Third source paper", authors: null, publication: "PLOS", year: 2022, doi: "10.1371/y",
      url: "https://journals.plos.org/article?id=10.1371/y", similarity: 55,
      matchedPassages: [{ submittedText: "", submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }],
    }],
    unifiedSimilarity: { matchedPositions: range(0, qe), previousUploadPositions: [], unifiedScore: 30, uniqueMatchedWords: qe + 1 },
    score: 30,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.ok(vm.sources.length >= 2, "test setup sanity: multiple verified sources");
  const html = renderWorkspace(report);
  // The first two sources in vm.sources' own order must appear as badges 1/2.
  const firstBadge = html.indexOf(`>1</span>`);
  const secondBadge = html.indexOf(`>2</span>`);
  assert.ok(firstBadge > -1 && secondBadge > firstBadge, "source badges 1 and 2 both render, in vm.sources' own order");
});

test("H: a highlighted manuscript mark's text is exactly the SAME verified character range buildReportV2ViewModel already resolved — never recomputed", () => {
  const text = makeText(300);
  const report = withV2(mkReport({
    text,
    archiveMatchedPositions: range(10, 60),
    sources: [{ name: "Wikipedia — “Fixture”", type: "Internet", percent: 17, matches: 1, matchedWords: 51, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(10, 60), previousUploadPositions: [], unifiedScore: 17, uniqueMatchedWords: 51 },
    score: 17,
  }));
  const vm = buildReportV2ViewModel(report);
  const resolved = vm.passages.find((p) => p.charStart !== null);
  assert.ok(resolved, "test setup sanity: at least one passage resolved real character offsets");
  const expectedSlice = text.slice(resolved.charStart, resolved.charEnd);
  const html = renderWorkspace(report);
  assert.match(html, new RegExp(`id="rv2ws-mark-${resolved.id}"`), "the mark carries the passage's own stable id");
  assert.ok(html.includes(expectedSlice), "the rendered mark's text is exactly report.text.slice(charStart, charEnd) — the same verified range the view model computed, not a re-derived one");
});

test("I: the workspace's own rendered sources are exactly vm.sources (the authoritative, deduplicated set) — the legacy raw report.sources array is never surfaced here", () => {
  const componentSource = readSource("components/report/report-v2/report-v2-view.tsx");
  const workspaceStart = componentSource.indexOf("export function ReportV2Workspace");
  const workspaceEnd = componentSource.indexOf("\nexport function", workspaceStart + 1);
  const workspaceBody = componentSource.slice(workspaceStart, workspaceEnd === -1 ? undefined : workspaceEnd);
  const manuscriptStart = componentSource.indexOf("function WorkspaceManuscript");
  const manuscriptBody = componentSource.slice(manuscriptStart, workspaceStart);
  assert.doesNotMatch(workspaceBody, /report\.sources\b/, "REQUIRED: the workspace panel never reads the legacy raw report.sources array — only vm.sources (see this redesign's own 333-vs-229 fix)");
  assert.doesNotMatch(manuscriptBody, /report\.sources\b/, "REQUIRED: the manuscript highlighter never reads the legacy raw report.sources array either");
});

test("L: <1% is preserved — a genuine positive overlap that rounds to 0 never renders as a bare 0% in the workspace score card", () => {
  const text = makeText(500);
  const report = withV2(mkReport({
    text,
    archiveMatchedPositions: range(0, 60),
    sources: [{ name: "Wikipedia — “Fixture”", type: "Internet", percent: 0, matches: 1, matchedWords: 61, phrases: [], color: "#0" }],
    // unifiedScore pinned to 0 directly (this is what the workspace's score
    // card actually reads — primarySimilarityScore(report), independent of
    // the interpreter's own admission threshold) while a real, non-trivial
    // evidenceInterpretation.matchedWordCount is still admitted below (61
    // words clears the frozen STRICT_SPAN admission floor), so this
    // isolates the display-rounding policy under test from that unrelated,
    // frozen admission rule.
    unifiedSimilarity: { matchedPositions: range(0, 60), previousUploadPositions: [], unifiedScore: 0, uniqueMatchedWords: 61 },
    score: 0,
  }));
  const vm = buildReportV2ViewModel(report);
  assert.ok(vm.summary.matchedWordCount > 0, "test setup sanity: the real interpreter admitted a genuine positive overlap");
  assert.equal(vm.summary.verifiedSimilarityPercent, 0, "test setup sanity: the authoritative score is exactly 0 (rounded from a tiny real fraction)");
  const html = renderWorkspace(report);
  // renderToStaticMarkup HTML-escapes text content, so the literal "<1%"
  // string appears as the entity "&lt;1%" in the raw markup.
  assert.match(html, /&lt;1%/, "REQUIRED: shows <1%, matching the report/receipt's own formatSimilarityPercent policy");
  assert.doesNotMatch(html, />0%</, "REQUIRED: never a bare 0% for this same case");
});

test("K (RTL/mixed-direction preserved): a highlighted passage over Arabic text renders the exact original Arabic substring, unmodified, through the same rv2-doc/rv2-mark base classes the existing (unchanged) V2 highlighter already uses", () => {
  const arabicWords = Array.from({ length: 60 }, (_, i) => `كلمة${i}`);
  const text = `${arabicWords.slice(0, 20).join(" ")} English words mixed in here for good measure ${arabicWords.slice(20).join(" ")}`;
  const toks = tokens(text);
  // Pick a purely-Arabic word range for the matched span so the assertion
  // below can check the exact Arabic substring survives unmodified.
  const start = toks.indexOf("كلمة2");
  const end = toks.indexOf("كلمة10");
  const report = withV2(mkReport({
    text,
    archiveMatchedPositions: range(start, end),
    sources: [{ name: "Wikipedia — “Fixture”", type: "Internet", percent: 10, matches: 1, matchedWords: end - start + 1, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(start, end), previousUploadPositions: [], unifiedScore: 10, uniqueMatchedWords: end - start + 1 },
    score: 10,
  }));
  const vm = buildReportV2ViewModel(report);
  const resolved = vm.passages.find((p) => p.charStart !== null);
  assert.ok(resolved, "test setup sanity: the Arabic-range passage resolved real character offsets");
  const expectedArabic = text.slice(resolved.charStart, resolved.charEnd);
  assert.match(expectedArabic, /[؀-ۿ]/, "test setup sanity: the resolved range is genuinely Arabic script");
  const html = renderWorkspace(report);
  assert.ok(html.includes(expectedArabic), "REQUIRED: the exact Arabic substring renders unmodified — no re-encoding/reordering introduced by the workspace's own highlighter");
  assert.match(html, /class="rv2-doc rv2ws-manuscript"/, "REQUIRED: reuses the SAME .rv2-doc base class the existing (unchanged) V2 document renderer already uses, not a new one");
});

// ── B/J: structural (source/CSS) checks for what render-to-static-markup can't reach ──
test("B: legacy fallback is preserved — the canonical-workspace gate requires hasV2, so a report with no V2 payload always takes the existing tabs/content path unchanged", () => {
  const shell = readSource("app/reports/[id]/report-detail-shell.tsx");
  assert.match(
    shell,
    /const isOrdinaryV2Workspace = mode === "similarity" && hasV2 && !\(canSeeSourceBreakdown && showLegacyForAdmin\);/,
    "REQUIRED: the workspace gate is hasV2-dependent — a non-V2 report can never resolve to the new workspace, only the existing legacy tabs/content",
  );
  // The full legacy tabs + full-report-preview + standalone-tab block must
  // still exist verbatim (not deleted) for that non-V2 / admin-legacy path.
  assert.match(shell, /<nav className="report-tabs" aria-label="Report sections">/);
  assert.match(shell, /<div className="full-report-preview">/);
});

test("B (admin compatibility): only an authorized viewer (the same canSeeSourceBreakdown/viewerIsAdmin signal every other admin-only surface in this file already uses) can ever reach the legacy views for a V2 report — never a plain UI toggle available to everyone", () => {
  const shell = readSource("app/reports/[id]/report-detail-shell.tsx");
  assert.match(shell, /onShowLegacy=\{canSeeSourceBreakdown \? \(\) => setShowLegacyForAdmin\(true\) : undefined\}/, "REQUIRED: the legacy-views affordance is passed only when canSeeSourceBreakdown is true");
});

test("J: the source/evidence panel is a collapsible drawer at mobile/tablet widths, never a permanent side-by-side column — the manuscript takes the full single column instead", () => {
  const css = readSource("app/globals.css");
  // indexOf-based, not a multi-line regex spanning newlines: robust
  // regardless of this file's own CRLF/LF line endings.
  const start = css.indexOf("@media (max-width: 900px) {");
  assert.ok(start > -1, "the workspace's own mobile/tablet breakpoint block must exist");
  const end = css.indexOf("@media (prefers-reduced-motion: reduce) {", start);
  assert.ok(end > start, "the block must end before the next media block");
  const block = css.slice(start, end);
  assert.match(block, /\.rv2ws-body \{\s*grid-template-columns: minmax\(0, 1fr\);/, "REQUIRED: single column (manuscript full width) below the breakpoint — no permanent 360px side panel");
  const panelStart = block.indexOf(".rv2ws-panel {");
  const panelOpenStart = block.indexOf(".rv2ws-panel-open {");
  assert.ok(panelStart > -1 && panelOpenStart > panelStart, "both the collapsed and open panel rules must exist, in that order");
  const panelRule = block.slice(panelStart, panelOpenStart);
  assert.match(panelRule, /position: fixed;/, "REQUIRED: the panel becomes an overlay (drawer/bottom sheet), not an inline column");
  assert.match(panelRule, /transform: translateY\(100%\);/, "REQUIRED: collapsed (off-screen) by default");
  const panelOpenRule = block.slice(panelOpenStart, block.indexOf("}", panelOpenStart));
  assert.match(panelOpenRule, /visibility: visible;/);
  assert.match(panelOpenRule, /transform: translateY\(0\);/, "REQUIRED: opens only on explicit user action (the mobile bar's Sources toggle), never permanently visible");
  assert.match(block, /\.rv2ws-mobile-bar \{/, "REQUIRED: a persistent compact bar (score + match nav + a way to open the drawer) stays reachable");
});

test("print isolation: the canonical workspace is hidden during print, exactly like the legacy .report-workspace/.report-tabs it replaces on screen — the PDF still comes only from .print-report-bundle, never both at once", () => {
  const css = readSource("app/globals.css");
  const printBlockMatch = css.match(/@media print \{[\s\S]*?\.report-workspace,[\s\S]*?\}/);
  assert.ok(printBlockMatch, "the existing screen-hide print block must be found");
  assert.match(printBlockMatch[0], /\.rv2ws,/, "REQUIRED: .rv2ws is hidden during print in the SAME rule that already hides .report-tabs/.report-workspace");
});
