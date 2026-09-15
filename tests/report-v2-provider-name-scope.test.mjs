import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPLETION_SCOPE_LINE, buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { ReportV2View } from "../components/report/report-v2/report-v2-view.tsx";
import { withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { tokens } from "../lib/similarity-core.ts";

/**
 * Tiny UX cleanup slice — Report V2's customer-facing completion scope line
 * (COMPLETION_SCOPE_LINE, lib/report-v2-view.ts) named "OpenAIRE, Europe
 * PMC" directly to ordinary customers (no viewerIsAdmin/canSeeSourceBreakdown
 * gate protects it — see CompletionStrip in components/report/report-v2/
 * report-v2-view.tsx and hasV2's plain data-presence check in
 * app/reports/[id]/report-detail-shell.tsx). This proves the constant no
 * longer names either provider while still describing the same two checked
 * pools, that every completion state still renders through the unchanged
 * resolveCompletionView/resolveReportCompletion pipeline, and that the
 * SEPARATE, already-admin-gated provider strings in components/report/
 * similarity-report-papers.tsx are untouched by this slice.
 */

const FORBIDDEN = /OpenAIRE|Europe PMC|\bV4\b|Archive-321|Selective Corpus|authoritative|\bmatcher\b|\bBlob\b/;

// ── A + B: the constant itself ──────────────────────────────────────────
test("A: COMPLETION_SCOPE_LINE no longer names OpenAIRE or Europe PMC", () => {
  assert.doesNotMatch(COMPLETION_SCOPE_LINE, /OpenAIRE/);
  assert.doesNotMatch(COMPLETION_SCOPE_LINE, /Europe PMC/);
});

test("B: COMPLETION_SCOPE_LINE still communicates TurnitPlus's reference collection and live academic sources", () => {
  assert.match(COMPLETION_SCOPE_LINE, /reference collection/i);
  assert.match(COMPLETION_SCOPE_LINE, /live academic sources/i);
});

// ── C: completion states unchanged end-to-end through Report V2 ─────────
function reportWithCompletion(state, overrides = {}) {
  const SHARED = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");
  const text = `report body ${SHARED} tail`;
  const base = withEvidenceInterpretation(
    { id: 1, text, wordCount: tokens(text).length, archiveMatchedPositions: [], sources: [], scoreBand: "Low" },
    {},
  );
  const completionByState = {
    COMPLETED: { state: "COMPLETED", headline: "Search completed within the available TurnitPlus source scope.", detail: null, reasons: [], signals: { academicSearch: null, selectiveCorpus: null, extraction: "COMPLETE", unverifiedCandidateCount: 0, userSuppliedReference: null } },
    PARTIAL: { state: "PARTIAL", headline: "Some source searches were unavailable. Results may be incomplete.", detail: "The 14% shown is a lower bound — a source we could not reach may add more.", reasons: ["the live academic-source search could not complete"], signals: { academicSearch: "FAILED", selectiveCorpus: null, extraction: "COMPLETE", unverifiedCandidateCount: 0, userSuppliedReference: null } },
    SOURCE_UNAVAILABLE: { state: "SOURCE_UNAVAILABLE", headline: "A candidate source was identified but its text could not be verified.", detail: "1 possible source is listed separately as “identified, not verified” and is not included in the 5%.", reasons: ["1 candidate source could not be text-verified"], signals: { academicSearch: null, selectiveCorpus: null, extraction: "COMPLETE", unverifiedCandidateCount: 1, userSuppliedReference: null } },
    EXTRACTION_PARTIAL: { state: "EXTRACTION_PARTIAL", headline: "Part of the uploaded document could not be analyzed.", detail: "About 2 pages of the file could not be read and were skipped. Re-upload a text-based copy for a complete result.", reasons: ["document extraction reported unread content"], signals: { academicSearch: null, selectiveCorpus: null, extraction: "PARTIAL", unverifiedCandidateCount: 0, userSuppliedReference: null } },
  };
  const extractionDiagnostic = state === "EXTRACTION_PARTIAL"
    ? { completeness: "PARTIAL", analyzableWordCount: base.wordCount, skipped: { unit: "pages", total: 10, read: 8 }, extractor: "pdf" }
    : base.extractionDiagnostic;
  return { ...base, reportCompletion: completionByState[state], extractionDiagnostic, ...overrides };
}

for (const state of ["COMPLETED", "PARTIAL", "SOURCE_UNAVAILABLE", "EXTRACTION_PARTIAL"]) {
  test(`C: ${state} still renders through Report V2's completion strip with its existing headline, provider names never reappearing`, () => {
    const report = reportWithCompletion(state);
    const vm = buildReportV2ViewModel(report);
    assert.ok(vm, "view model still builds for every completion state");
    assert.equal(vm.summary.completion.state, state, "resolveCompletionView's state selection is unchanged");
    assert.equal(vm.summary.completion.headline, report.reportCompletion.headline, "existing customer-safe headline wording is unchanged");
    const html = renderToStaticMarkup(React.createElement(ReportV2View, { report }));
    assert.doesNotMatch(html, FORBIDDEN, `${state} rendered output must stay customer-safe after the provider-name removal`);
    assert.match(html, /available live academic sources/, "the generic scope wording still renders in the strip");
  });
}

// ── D: legacy completion notice remains provider-name-free ──────────────
test("D: the legacy completion notice (components/report/similarity-report-papers.tsx) does not reuse scopeLine and stays provider-name-free", async () => {
  const src = await readFile(new URL("../components/report/similarity-report-papers.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /scopeLine/, "CompletionNotice must never read/render the V2 scope line");
});

// ── E: admin-only provider strings elsewhere are NOT removed ────────────
test("E: admin-only provider-name strings in similarity-report-papers.tsx are untouched by this slice", async () => {
  const src = await readFile(new URL("../components/report/similarity-report-papers.tsx", import.meta.url), "utf8");
  assert.match(src, /OpenAIRE and Europe PMC could not be/, "the canSeeSourceBreakdown-gated admin copy still names providers");
  assert.match(src, /Checked OpenAIRE and Europe PMC/, "the admin-only 'no matches' copy still names providers");
});
