import assert from "node:assert/strict";
import test from "node:test";

import {
  withEvidenceInterpretation,
  stripClientEvidenceInterpretation,
} from "../lib/report-evidence-interpretation.ts";
import { EVIDENCE_INTERPRETATION_KINDS, buildReportEvidenceInterpretation } from "../lib/evidence-interpretation/index.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";

/**
 * ACTIVATION-GATE FIX — Imported Similarity Evidence V1's customer-facing
 * "Imported reference match" card.
 *
 * Before this fix, `withEvidenceInterpretation` (lib/report-evidence-
 * interpretation.ts) — the ONE live production caller of
 * buildReportEvidenceInterpretation (app/api/reports/route.ts's
 * finalizeReportJson, inside the POST handler) — never derived or passed
 * `importedSimilarityAdmittedSources`, even though:
 *   - lib/evidence-interpretation/adapters.ts's normalizeImportedSimilarityEvidence
 *     was already fully implemented, and
 *   - lib/evidence-interpretation/build-report-interpretation.ts's
 *     BuildReportEvidenceInterpretationOptions already accepted the option.
 * So a package could affect unifiedScore (via lib/unified-similarity.ts's
 * "imported_similarity_evidence" contributions) with NO corresponding
 * customer-facing explanation ever reaching the report.
 *
 * These tests exercise `withEvidenceInterpretation` directly — the exact
 * production entry point — with a synthetic `report.unifiedSimilarity.
 * contributions` array shaped exactly as lib/unified-similarity.ts's own
 * computeUnifiedSimilarity() writes it for this channel (see that file's
 * "Source: Imported Similarity Evidence V1" block), so no DB / real package /
 * HTTP route is needed to prove the wiring itself.
 */

const WORD_COUNT = 200;
const DOC_TEXT = Array.from({ length: WORD_COUNT }, (_, i) => `word${i}`).join(" ");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const reconciles = (ei) => {
  const total = Object.values(ei.countsByKind).reduce((a, b) => a + b, 0);
  const all = [];
  for (const k of EVIDENCE_INTERPRETATION_KINDS) all.push(...ei.positionsByKind[k]);
  return total === ei.matchedWordCount && all.length === new Set(all).size;
};

/** One imported-evidence contribution, exactly as computeUnifiedSimilarity's
 *  own "Source: Imported Similarity Evidence V1" block writes it. */
function importedContribution({ sourceId = "imported-similarity-evidence:PU0001", start, end, state }) {
  return {
    sourceType: "imported_similarity_evidence",
    sourceId,
    submittedWordStart: start,
    submittedWordEnd: end,
    matchedWordCount: end - start + 1,
    evidenceStatus: "included",
    ...(state ? { importedSourceAttributionState: state } : {}),
  };
}

function baseReport(overrides = {}) {
  return {
    id: 1, text: DOC_TEXT, wordCount: WORD_COUNT, score: 0, sources: [], repeats: [],
    ...overrides,
  };
}

// ── 1-4: imported evidence reaches withEvidenceInterpretation, neutral label,
//         positions preserved, correct source/passage association ──────────
test("1-4: imported evidence in unifiedSimilarity.contributions produces a neutral, position-correct card through withEvidenceInterpretation", () => {
  const report = baseReport({
    unifiedSimilarity: {
      matchedPositions: range(10, 40),
      previousUploadPositions: [],
      importedSimilarityEvidenceOnlyWords: 31,
      importedSimilarityEvidencePositions: range(10, 40),
      contributions: [importedContribution({ start: 10, end: 40, state: "TURNITIN_SOURCE_MARKER_ONLY" })],
    },
  });
  const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
  const ei = wired.evidenceInterpretation;
  assert.ok(reconciles(ei));
  assert.equal(ei.matchedWordCount, 31);

  const card = ei.sources.find((s) => s.sourceType === "imported-similarity-evidence");
  assert.ok(card, "an imported-similarity-evidence card must exist");
  assert.equal(card.label, "Imported reference match");
  assert.equal(card.link, null);
  assert.equal(card.doi, null);
  assert.equal(card.year, null);
  assert.match(card.id, /^src-\d+$/, "report-local opaque id only");

  // positions/passage association — the same highlighting system every other
  // channel uses (STEP 6: matched spans must be visible/highlight-capable).
  assert.ok(card.passageRefs.length > 0);
  const passage = ei.passages.find((p) => card.passageRefs.includes(p.id));
  assert.ok(passage, "referenced passage exists");
  assert.equal(passage.wordStart, 10);
  assert.equal(passage.wordEnd, 40);
  assert.ok(passage.sourceIds.includes(card.id));
});

// ── 5-8: every non-owned attribution state stays neutral; VERIFIED too ─────
test("5-8: every source-attribution state (including ORIGINAL_SOURCE_VERIFIED) renders the same neutral card — no provenance overclaim", () => {
  for (const state of [
    "ORIGINAL_SOURCE_VERIFIED",
    "ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED",
    "TURNITIN_SOURCE_MARKER_ONLY",
    "REPORT_DERIVED_REFERENCE",
  ]) {
    const report = baseReport({
      unifiedSimilarity: {
        matchedPositions: range(0, 10),
        previousUploadPositions: [],
        contributions: [importedContribution({ start: 0, end: 10, state })],
      },
    });
    const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
    const card = wired.evidenceInterpretation.sources[0];
    assert.equal(card.label, "Imported reference match", `state=${state}`);
    assert.equal(card.link, null, `state=${state} must not fabricate a URL`);
    assert.equal(card.doi, null, `state=${state} must not fabricate a DOI`);
    assert.equal(card.namedSources, undefined, `state=${state} must not fabricate named sources`);
  }
});

// ── 9-10: no package / corrupt package => no card, nothing throws ─────────
test("9-10: absent, empty, or missing unifiedSimilarity.contributions => no imported card and no throw (no-package / corrupt-package parity)", () => {
  for (const unifiedSimilarity of [
    undefined,
    { matchedPositions: [], previousUploadPositions: [] },
    { matchedPositions: [], previousUploadPositions: [], contributions: [] },
    { matchedPositions: [], previousUploadPositions: [], contributions: undefined },
  ]) {
    const report = baseReport({ unifiedSimilarity });
    let wired;
    assert.doesNotThrow(() => { wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null }); });
    assert.equal(wired.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence").length, 0);
  }
});

// ── 11-12: overlap with archive — no double count, both explainable ───────
test("11-12: imported evidence overlapping archive evidence unions positions once, but both sources remain individually explainable", () => {
  const report = baseReport({
    archiveMatchedPositions: range(0, 20),
    sources: [{ name: "Archive Ref", type: "Internet", percent: 10, matches: 1, matchedWords: 21, phrases: [], color: "#0" }],
    unifiedSimilarity: {
      matchedPositions: range(0, 20), // the authoritative union — 21 words, not 21+11
      previousUploadPositions: [],
      contributions: [importedContribution({ start: 10, end: 20, state: "TURNITIN_SOURCE_MARKER_ONLY" })],
    },
  });
  const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
  const ei = wired.evidenceInterpretation;
  assert.equal(ei.matchedWordCount, 21, "SCORE_DOUBLE_COUNT = NO: overlap counted once in the headline union");
  assert.ok(reconciles(ei));
  assert.equal(ei.sources.length, 2, "REPORT_CAN_EXPLAIN_IMPORTED_MATCH = YES: both sources still get their own card");
  const importedCard = ei.sources.find((s) => s.sourceType === "imported-similarity-evidence");
  const archiveCard = ei.sources.find((s) => s.sourceType === "internet");
  assert.ok(importedCard && archiveCard);
  const overlapPassage = ei.passages.find((p) => p.wordStart <= 10 && p.wordEnd >= 10);
  assert.ok(overlapPassage, "the overlapping word must land in some passage");
  assert.ok(overlapPassage.sourceIds.includes(importedCard.id) && overlapPassage.sourceIds.includes(archiveCard.id),
    "the overlapping passage names both contributing sources — truthful, not hidden");
});

// ── 13: recompute/resave does not duplicate imported cards ────────────────
test("13: re-wiring the same persisted report (simulating a resave) is idempotent — no duplicate imported cards", () => {
  const report = baseReport({
    unifiedSimilarity: {
      matchedPositions: range(5, 25),
      previousUploadPositions: [],
      contributions: [importedContribution({ start: 5, end: 25, state: "REPORT_DERIVED_REFERENCE" })],
    },
  });
  const first = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
  // A resave feeds the PREVIOUSLY persisted (already-wired) report back in —
  // stripClientEvidenceInterpretation is applied first, exactly like the real
  // POST path's finalizeReportJson does.
  const second = withEvidenceInterpretation(stripClientEvidenceInterpretation(first), { selectiveCorpusBranch: null });
  const importedOf = (ei) => ei.sources.filter((s) => s.sourceType === "imported-similarity-evidence");
  assert.equal(importedOf(first.evidenceInterpretation).length, 1);
  assert.equal(importedOf(second.evidenceInterpretation).length, 1, "resave must not duplicate the card");
  assert.deepEqual(second.evidenceInterpretation, first.evidenceInterpretation, "re-wiring is deterministic/idempotent");
});

// ── 14: no private provenance leaks to the customer-facing payload ────────
test("14: no evidence-unit id, evidence-set id, report SHA, or attribution-state string leaks into the customer-facing evidenceInterpretation", () => {
  const report = baseReport({
    unifiedSimilarity: {
      matchedPositions: range(0, 10),
      previousUploadPositions: [],
      contributions: [importedContribution({
        sourceId: "imported-similarity-evidence:PU-SECRET-0001",
        start: 0, end: 10,
        state: "ORIGINAL_SOURCE_VERIFIED",
      })],
    },
  });
  const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
  const blob = JSON.stringify(wired.evidenceInterpretation);
  for (const bad of [
    "PU-SECRET-0001", "imported-similarity-evidence:", "ORIGINAL_SOURCE_VERIFIED",
    "evidenceUnitId", "evidenceSetId", "reportSha256", "goldSpanIds", "originalManuscriptTokenPositions",
  ]) {
    assert.equal(blob.includes(bad), false, `must not leak: ${bad}`);
  }
  for (const s of wired.evidenceInterpretation.sources) assert.match(s.id, /^src-\d+$/);
});

// ── 17: existing (non-imported) channels are completely unaffected ────────
test("17: a report with no imported-evidence contributions is byte-identical to buildReportEvidenceInterpretation without the option at all", () => {
  const report = baseReport({
    archiveMatchedPositions: range(0, 30),
    sources: [{ name: "Ref", type: "Internet", percent: 20, matches: 1, matchedWords: 31, phrases: [], color: "#0" }],
    unifiedSimilarity: { matchedPositions: range(0, 30), previousUploadPositions: [], contributions: [{ sourceType: "archive", sourceId: "x", submittedWordStart: 0, submittedWordEnd: 30, matchedWordCount: 31, evidenceStatus: "included" }] },
  });
  const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
  assert.equal(wired.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence").length, 0);
  assert.equal(wired.evidenceInterpretation.matchedWordCount, 31);
  assert.ok(reconciles(wired.evidenceInterpretation));
  // The literal claim: identical to what the builder produces when the
  // imported option is never supplied at all (i.e. the pre-fix behavior).
  assert.deepEqual(wired.evidenceInterpretation, buildReportEvidenceInterpretation(report, { userSuppliedReferences: [] }));
});

// ── 16: the customer view-model surfaces the card and a real highlight range ──
test("16: buildReportV2ViewModel surfaces the imported card as a generic 'Imported reference match' and resolves a real highlight range for its passage", () => {
  const report = baseReport({
    unifiedSimilarity: {
      matchedPositions: range(10, 40),
      previousUploadPositions: [],
      unifiedScore: 16,
      contributions: [importedContribution({ start: 10, end: 40, state: "REPORT_DERIVED_REFERENCE" })],
    },
  });
  const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });
  const vm = buildReportV2ViewModel(wired);
  assert.ok(vm, "view model must build for a report carrying evidenceInterpretation");

  const card = vm.sources.find((s) => s.sourceType === "imported-similarity-evidence");
  assert.ok(card, "the imported card reaches the customer view model");
  assert.equal(card.badge, "Imported reference match");
  assert.equal(card.label, "Imported reference match");
  assert.equal(card.isGeneric, true, "generic/non-attributable bucket — never a named or linked source");
  assert.equal(card.link, null);
  assert.equal(card.doi, null);

  // The passage the card points at resolves to a REAL character range over the
  // manuscript text — this is what the highlighter draws — and that range is
  // exactly the matched words 10..40, not some recomputed approximation.
  const passage = vm.passages.find((p) => card.passageRefs.includes(p.id));
  assert.ok(passage, "card's passageRef resolves to a view-model passage");
  assert.notEqual(passage.charStart, null);
  assert.notEqual(passage.charEnd, null);
  assert.equal(passage.highlightText, DOC_TEXT.split(" ").slice(10, 41).join(" "));
  assert.ok(passage.sourceIds.includes(card.id));
});
