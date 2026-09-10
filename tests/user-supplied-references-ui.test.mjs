import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  addReferenceFiles,
  removeReferenceFile,
  markReferencesChecked,
  referenceFileType,
  MAX_REFERENCE_FILES,
  REFERENCE_ACCEPT_ATTR,
  REFERENCE_STATUS_LABEL,
} from "../lib/user-supplied-reference-constants.ts";
import { extractReferenceInputs } from "../lib/document-check-pipeline.ts";
import { ReferenceFilesPanel } from "../components/reports/reference-files-panel.tsx";
import { DocumentUploadPanel } from "../components/reports/document-upload-panel.tsx";
import { ReportV2View } from "../components/report/report-v2/report-v2-view.tsx";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { tokens } from "../lib/similarity-core.ts";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — a browser File is duck-typed { name, size, text() } for the
// non-pdf/docx extraction path; extractReferenceInputs takes an injectable
// extractor so the pdf/docx dynamic imports are never needed here.
// ─────────────────────────────────────────────────────────────────────────
const fileOf = (name, size = 1024) => ({ name, size });
const entryOf = (over = {}) => ({
  id: over.id ?? `ref-x-${Math.random().toString(36).slice(2)}`,
  file: over.file ?? fileOf(over.displayName ?? "source.pdf"),
  displayName: over.displayName ?? "source.pdf",
  fileType: over.fileType ?? "pdf",
  sizeLabel: over.sizeLabel ?? "1.0 KB",
  status: over.status ?? "ready",
  note: over.note ?? null,
});
const okExtractor = (text) => async () => ({
  text,
  extraction: { completeness: "COMPLETE", analyzableWordCount: tokens(text).length, skipped: null, extractor: "x" },
});
const throwingExtractor = async () => { throw new Error("could not read"); };

// ── 1 — add one PDF ─────────────────────────────────────────────────────
test("1: adding one PDF produces a single ready entry with a basename display name", () => {
  const { entries, rejected } = addReferenceFiles([], [fileOf("Final Thesis.pdf", 4096)]);
  assert.equal(entries.length, 1);
  assert.equal(rejected.length, 0);
  assert.equal(entries[0].displayName, "Final Thesis.pdf");
  assert.equal(entries[0].fileType, "pdf");
  assert.equal(entries[0].status, "ready");
  assert.match(entries[0].id, /^ref-/);
});

// ── 2 — add DOCX + TXT ─────────────────────────────────────────────────
test("2: adding a DOCX and a TXT together yields two entries of the right types", () => {
  const { entries } = addReferenceFiles([], [fileOf("notes.docx"), fileOf("appendix.txt")]);
  assert.deepEqual(entries.map((e) => e.fileType), ["docx", "txt"]);
  assert.equal(referenceFileType("x.DOCX"), "docx", "type detection is case-insensitive");
});

// ── 3 — remove one file ────────────────────────────────────────────────
test("3: removing one entry by id leaves the others untouched", () => {
  const { entries } = addReferenceFiles([], [fileOf("a.pdf"), fileOf("b.pdf"), fileOf("c.pdf")]);
  const next = removeReferenceFile(entries, entries[1].id);
  assert.deepEqual(next.map((e) => e.displayName), ["a.pdf", "c.pdf"]);
});

// ── 4 — clear all ──────────────────────────────────────────────────────
test("4: the panel exposes a 'Clear all' control whenever entries exist", () => {
  const html = renderToStaticMarkup(
    React.createElement(ReferenceFilesPanel, {
      entries: [entryOf()], rejections: [], inputRef: { current: null },
      onAdd() {}, onRemove() {}, onClear() {}, onDismissRejections() {},
    }),
  );
  assert.match(html, /Clear all/);
});

// ── 5 — reject unsupported type ────────────────────────────────────────
test("5: an unsupported type is rejected locally with a reason and never blocks the valid files", () => {
  const { entries, rejected } = addReferenceFiles([], [fileOf("slides.pptx"), fileOf("ok.pdf"), fileOf("sheet.csv")]);
  assert.deepEqual(entries.map((e) => e.displayName), ["ok.pdf"], "the valid PDF still lands");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => /unsupported/i.test(r.reason)));
  assert.equal(referenceFileType("sheet.csv"), null, "csv is manuscript-only, not a reference type");
});

// ── 6 — enforce backend file-count limit ──────────────────────────────
test("6: the backend's MAX_REFERENCE_FILES limit is enforced; extra files are rejected", () => {
  const many = Array.from({ length: MAX_REFERENCE_FILES + 3 }, (_, i) => fileOf(`ref${i}.pdf`));
  const { entries, rejected } = addReferenceFiles([], many);
  assert.equal(entries.length, MAX_REFERENCE_FILES);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((r) => new RegExp(String(MAX_REFERENCE_FILES)).test(r.reason)));
});

// ── 7 — one extraction failure + one valid reference ──────────────────
test("7: one reference fails extraction (empty text input, failed status) while the other stays valid", async () => {
  const good = entryOf({ id: "g", displayName: "good.txt", fileType: "txt" });
  const bad = entryOf({ id: "b", displayName: "bad.txt", fileType: "txt" });
  let lastStatuses = [];
  const extract = (file) =>
    file === bad.file ? throwingExtractor() : okExtractor("distinctive verifiable overlap text here and more")();
  const inputs = await extractReferenceInputs([good, bad], (next) => { lastStatuses = next; }, extract);

  assert.equal(inputs.length, 2, "a failed reference is still SENT (empty text) so the server marks the channel PARTIAL");
  assert.equal(inputs[0].extractedText.length > 0, true);
  assert.equal(inputs[1].extractedText, "");
  assert.equal(inputs[1].extraction, null);
  assert.equal(lastStatuses.find((e) => e.id === "b").status, "failed");
  assert.equal(lastStatuses.find((e) => e.id === "g").status, "checking");
});

// ── 8 + 10 — the client sends ONLY the raw safe input, no derived evidence ─
test("8/10: extractReferenceInputs emits exactly { fileName, fileType, extractedText, extraction } — no matched positions / % / admission / interpretation", async () => {
  const inputs = await extractReferenceInputs(
    [entryOf({ displayName: "src.txt", fileType: "txt" })],
    () => {},
    okExtractor("some reference body text for the check"),
  );
  assert.equal(inputs.length, 1);
  assert.deepEqual(Object.keys(inputs[0]).sort(), ["extractedText", "extraction", "fileName", "fileType"]);
  for (const forbidden of ["matchedWords", "matchedPositions", "contributionPercent", "admitted", "admissionReason", "interpretation", "verifiedPassages", "completion", "key", "safeLabel"]) {
    assert.equal(forbidden in inputs[0], false, `client input must not carry a server-derived field: ${forbidden}`);
  }
});

// ── 9 — no references => nothing sent ─────────────────────────────────
test("9: with no references chosen, extractReferenceInputs returns [] (the save sends no sibling — byte-identical to today)", async () => {
  const inputs = await extractReferenceInputs([], () => {});
  assert.deepEqual(inputs, []);
});

// ── 11 + 12 — Report V2 presentation is 'Supplied reference', never independent ─
function reportWithSuppliedReference() {
  const SHARED = Array.from({ length: 90 }, (_, i) => `distinctivephrase${i}`).join(" ");
  const text = `Author framing sentence one two three. ${SHARED} Author closing remarks here.`;
  const wc = tokens(text).length;
  const base = {
    version: 11, id: 42, submissionId: "0000000042", title: "manuscript.pdf",
    author: "Guest submission", assignment: "x", created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: wc, characterCount: text.length, pageCount: 1,
    fileSize: "3 KB", databaseSize: 1, corpusVersion: "x", scoreBand: "Low",
    riskStatus: "Lower", riskTarget: 0, riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "en" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text,
  };
  const firstShared = tokens(text).findIndex((w) => w === "distinctivephrase0");
  const evidence = [{
    key: "user-supplied-reference:0", safeLabel: "reading-list-item.pdf", fileType: "pdf",
    extractionStatus: "COMPLETE", analyzableWordCount: 120, matchedWords: 90, contributionPercent: 80,
    admitted: true, admissionReason: "STRICT_SPAN pass",
    verifiedPassages: [{ submittedWordStart: firstShared, submittedWordEnd: firstShared + 89, matchedWordCount: 90 }],
  }];
  const channel = { state: "COMPLETE", suppliedCount: 1, checkedCount: 1, failedCount: 0 };
  return withEvidenceInterpretation(base, {
    userSuppliedReferenceEvidence: evidence,
    userSuppliedReferenceChannel: channel,
  });
}

test("11: Report V2 renders the supplied-reference source card with the 'Supplied reference' badge", () => {
  const report = reportWithSuppliedReference();
  const vm = buildReportV2ViewModel(report);
  assert.ok(vm, "view model builds");
  const card = vm.sources.find((s) => s.sourceType === "user-supplied-reference");
  assert.ok(card, "a supplied-reference source card exists");
  assert.equal(card.badge, "Supplied reference");
  assert.equal(card.label, "reading-list-item.pdf", "safe basename label");
  assert.equal(card.link, null, "a local reference file is NEVER a link");
  assert.notEqual(card.primaryKind, "POSSIBLE_SAME_WORK", "supplied + high overlap never becomes a same-work claim");

  const html = renderToStaticMarkup(React.createElement(ReportV2View, { report }));
  assert.match(html, /Supplied reference/);
});

test("12: no user-facing string presents a supplied reference as independently discovered or authenticated", async () => {
  // The user-facing copy modules — comments are stripped first so a module
  // header that legitimately quotes the RULE it enforces is not a false hit.
  const files = [
    "components/reports/reference-files-panel.tsx",
    "components/reports/document-upload-panel.tsx",
    "lib/report-v2-view.ts",
  ];
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const forbidden = /independently verified|independently authenticated|discovered source|external source verified|verified by TurnitPlus/i;
  for (const rel of files) {
    const src = stripComments(await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));
    assert.doesNotMatch(src, forbidden, `${rel} must not claim independent discovery/authentication for a supplied reference`);
  }
  // The real surface: the rendered Report V2 markup for a supplied reference.
  const html = renderToStaticMarkup(React.createElement(ReportV2View, { report: reportWithSuppliedReference() }));
  assert.doesNotMatch(html, forbidden);
  assert.match(html, /Supplied reference/);
});

// ── 13 — markReferencesChecked drives the post-save 'Checked' state ────
test("13: after the save completes, references that were 'checking' become 'checked' (no file resend needed)", () => {
  const entries = [
    entryOf({ id: "1", status: "checking" }),
    entryOf({ id: "2", status: "failed" }),
  ];
  const next = markReferencesChecked(entries);
  assert.equal(next.find((e) => e.id === "1").status, "checked");
  assert.equal(next.find((e) => e.id === "2").status, "failed", "a failed reference stays failed");
});

// ── 14 — privacy: no path / fakepath / digest leak in the panel markup ──
test("14: the panel renders only the basename — never a path, C:\\fakepath, upload id, or content digest", () => {
  const entries = [entryOf({ displayName: "Chapter 3 — Methods.pdf", fileType: "pdf" })];
  const html = renderToStaticMarkup(
    React.createElement(ReferenceFilesPanel, {
      entries, rejections: [], inputRef: { current: null },
      onAdd() {}, onRemove() {}, onClear() {}, onDismissRejections() {},
    }),
  );
  assert.match(html, /Chapter 3 — Methods\.pdf/);
  assert.doesNotMatch(html, /fakepath/i);
  assert.doesNotMatch(html, /[A-Za-z]:\\\\|\/home\/|\/Users\//);
  assert.doesNotMatch(html, /[a-f0-9]{64}/i, "no sha256-style digest");
  assert.doesNotMatch(html, /manuscriptDigest|userSuppliedReferenceGuard/);
});

// ── 15 — mobile-safe / accessible markup ──────────────────────────────
test("15: the panel uses semantic buttons with labels, wrapping filenames, and no fixed-width inline styles", () => {
  const entries = [entryOf({ displayName: "averyverylongreferencefilenamewithoutspaces-thatmustwrap.pdf" })];
  const html = renderToStaticMarkup(
    React.createElement(ReferenceFilesPanel, {
      entries, rejections: [{ fileName: "x.pptx", reason: "Unsupported type" }], inputRef: { current: null },
      onAdd() {}, onRemove() {}, onClear() {}, onDismissRejections() {},
    }),
  );
  assert.match(html, /<button type="button"[^>]*>Browse files<\/button>/);
  assert.match(html, /aria-label="Remove averyverylong/);
  assert.match(html, /aria-label="Dismiss these messages"/);
  assert.match(html, /<ul class="reference-files-list">/);
  assert.doesNotMatch(html, /style="[^"]*width:\s*\d+px/i, "no hard-coded pixel widths inline");
  assert.equal(REFERENCE_ACCEPT_ATTR, ".pdf,.docx,.txt");
  assert.equal(REFERENCE_STATUS_LABEL.checked, "Checked");
});

// ── 16 — the existing flow is untouched when no references are wired ───
test("16: DocumentUploadPanel with no `references` prop renders no reference section (old flow unchanged)", () => {
  const html = renderToStaticMarkup(
    React.createElement(DocumentUploadPanel, {
      file: null, isGeneratingReport: false, progress: 0, processingLabel: "Reading",
      fileInputRef: { current: null }, onChooseFile() {}, onGenerate() {},
    }),
  );
  assert.doesNotMatch(html, /Reference files/);
  assert.match(html, /Generate free report/, "the manuscript upload UI is intact");
});

test("16b: a report saved before this feature still builds a Report V2 view model (no reference fields required)", () => {
  const SHARED = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");
  const text = `legacy report body ${SHARED} legacy tail`;
  const legacy = withEvidenceInterpretation(
    { id: 7, text, wordCount: tokens(text).length, archiveMatchedPositions: [1, 2, 3], sources: [], scoreBand: "Low" },
    {},
  );
  assert.equal(legacy.userSuppliedReferenceEvidence, undefined);
  assert.equal(legacy.reportCompletion.signals.userSuppliedReference, null);
  const vm = buildReportV2ViewModel(legacy);
  assert.ok(vm, "legacy report still renders in Report V2");
});

// ─────────────────────────────────────────────────────────────────────────
// STRUCTURAL WIRING — app/page.tsx + room-page-shell.tsx are full client
// components (no React test harness — see room-lifecycle-reconciliation.test.mjs);
// verify the reference intake is wired at both new-check sites.
// ─────────────────────────────────────────────────────────────────────────
async function read(rel) {
  return readFile(new URL(`../${rel}`, import.meta.url), "utf8");
}

for (const rel of ["app/page.tsx", "app/reports/rooms/[room]/room-page-shell.tsx"]) {
  test(`wiring (${rel}): reference state + extraction + sibling submission + post-save 'checked'`, async () => {
    const src = await read(rel);
    assert.match(src, /useState<ReferenceIntakeEntry\[\]>\(\[\]\)/, "reference entry list state");
    assert.match(src, /extractReferenceInputs\(referenceEntries,/, "references are extracted through Extraction V2 at submit time");
    assert.match(src, /\{ \.\.\.report, userSuppliedReferences[^}]*\}/, "the raw text rides as a sibling of the report, merged for the remote save only");
    assert.match(src, /markReferencesChecked/, "post-save the per-file state becomes 'checked'");
    assert.match(src, /references=\{\{/, "the reference panel is wired into DocumentUploadPanel");
    // PHASE 6 — the long-lived `report` (used by the AI-completion resave) must
    // never be the object that carries userSuppliedReferences.
    assert.doesNotMatch(src, /report = \{ \.\.\.report, userSuppliedReferences/, "references must not be merged into the long-lived report object");
  });
}

test("wiring (app/page.tsx): starting a new check clears any chosen reference files", async () => {
  const src = await read("app/page.tsx");
  const body = src.match(/function startNewCheck\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(body, /setReferenceEntries\(\[\]\)/);
  assert.match(body, /setReferenceRejections\(\[\]\)/);
});
