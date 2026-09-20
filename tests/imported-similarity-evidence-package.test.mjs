import assert from "node:assert/strict";
import test from "node:test";

import {
  validateImportedSimilarityEvidencePackage,
  validateImportedSimilarityEvidenceUnitRecord,
  IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION,
} from "../lib/imported-similarity-evidence/package.ts";
import { IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION } from "../lib/imported-similarity-evidence/types.ts";
import { makeUnitRecord, makePackageFile } from "./helpers/imported-similarity-evidence-fixtures.mjs";

const VALID_ANCHOR = "the distinctive constitutional framework governing judicial review procedures";

// ── package round-trip ──────────────────────────────────────────────────
test("a well-formed package built by the shared builder validates cleanly", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const pkg = makePackageFile([unit]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.package.units.length, 1);
  assert.equal(result.rejectedUnits.length, 0);
  assert.deepEqual(result.package.units[0].anchorTokens, VALID_ANCHOR.split(" "));
});

// ── STEP 13.13 — wrong normalization version fails closed (whole package) ──
test("STEP 13.13: a package declaring an incompatible normalizationVersion fails the WHOLE package closed", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const pkg = makePackageFile([unit]);
  pkg.metadata.normalizationVersion = "some-other-normalization-v9";
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, false);
  assert.match(result.reason, /normalizationVersion/);
});

test("a package declaring an incompatible formatVersion fails the WHOLE package closed", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const pkg = makePackageFile([unit]);
  pkg.metadata.formatVersion = "some-future-format-v2";
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, false);
  assert.match(result.reason, /formatVersion/);
});

// ── STEP 13.14 — corrupt package fails closed ───────────────────────────
test("STEP 13.14: a tampered contentSha256 (corrupt/mismatched payload) fails the WHOLE package closed", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const pkg = makePackageFile([unit]);
  // Tamper the anchor text after the integrity hash was stamped — simulates
  // any bit-level corruption of the payload.
  pkg.units[0].anchorNormalizedText = "a completely different tampered anchor text here";
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, false);
  assert.match(result.reason, /contentSha256/);
});

test("a unitCount/evidenceSetCount mismatch against metadata fails the WHOLE package closed", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const pkg = makePackageFile([unit]);
  pkg.metadata.unitCount = 2;
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, false);
});

// ── STEP 13.8 — anchor found but malformed score mask rejected (unit-level, not whole package) ──
test("STEP 13.8: an out-of-bounds scoreMaskRelativePositions entry rejects only that unit — the rest of the package still loads", () => {
  const good = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const bad = makeUnitRecord({
    evidenceUnitId: "PU0002",
    anchorNormalizedText: VALID_ANCHOR,
    scoreMaskRelativePositions: [0, 1, 999],
  });
  const pkg = makePackageFile([good, bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, true, "whole package still loads");
  assert.equal(result.package.units.length, 1, "only the malformed unit is dropped");
  assert.equal(result.package.units[0].evidenceUnitId, "PU0001");
  assert.equal(result.rejectedUnits.length, 1);
  assert.equal(result.rejectedUnits[0].evidenceUnitId, "PU0002");
  assert.match(result.rejectedUnits[0].reason, /out of bounds/);
});

test("an empty scoreMaskRelativePositions is rejected", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR, scoreMaskRelativePositions: [] });
  const pkg = makePackageFile([bad]);
  pkg.metadata.unitCount = 1; // keep metadata consistent with the raw (pre-validation) record count
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /empty or invalid scoreMaskRelativePositions/);
});

// ── duplicate unit ids ───────────────────────────────────────────────────
test("duplicate evidenceUnitId within a package: the second occurrence is rejected, the first is kept", () => {
  const first = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const second = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: "another distinctive judicial constitutional passage entirely" });
  const pkg = makePackageFile([first, second]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.package.units.length, 1);
  assert.equal(result.rejectedUnits.some((r) => r.reason === "duplicate evidenceUnitId"), true);
});

// ── invalid attribution state / provenance / confidence ─────────────────
test("an invalid sourceAttributionState rejects only that unit", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR, overrides: { sourceAttributionState: "FULLY_VERIFIED_AND_OWNED" } });
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /sourceAttributionState/);
});

test("an invalid provenanceType rejects only that unit — no report/document SHA shortcut exists to bypass this", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR, overrides: { provenanceType: "SOME_OTHER_IMPORT" } });
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /provenanceType/);
});

test("an invalid confidence value rejects only that unit", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR, confidence: "LOW" });
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /confidence/);
});

// ── empty anchor / too-short anchor / no informative content ────────────
test("an empty anchor is rejected", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: "placeholder" });
  bad.anchorNormalizedText = "";
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /empty anchor/);
});

test("STEP 13.7 (package-level floor): an anchor shorter than MIN_ANCHOR_WINDOW is rejected — common isolated fragments can never become a unit at all", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: "the of and" });
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /MIN_ANCHOR_WINDOW/);
});

test("an anchor with only common/short words (no informative gram) is rejected even if long enough", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: "the a of and or is at in on to be" });
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /no informative gram/);
});

// ── integrity / tokenizer parity ─────────────────────────────────────────
test("a tampered anchorTextSha256 (anchor text edited without updating its hash) rejects only that unit", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  bad.anchorNormalizedText = "a different constitutional judicial framework passage entirely swapped";
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /anchorTextSha256 mismatch/);
});

test("a fabricated anchorTokenCount that disagrees with re-tokenization rejects only that unit (tokenizer parity gate)", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  bad.anchorTokenCount = bad.anchorTokenCount + 3;
  const pkg = makePackageFile([bad]);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /tokenizer parity mismatch/);
});

test("a unit referencing an evidenceSetId not declared in evidenceSets[] is rejected", () => {
  const bad = makeUnitRecord({ evidenceUnitId: "PU0001", evidenceSetId: "ES-NONEXISTENT", anchorNormalizedText: VALID_ANCHOR });
  const pkg = makePackageFile([bad], { evidenceSetId: "ES-TEST00000001" });
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.package.units.length, 0);
  assert.match(result.rejectedUnits[0].reason, /not declared in evidenceSets/);
});

// ── direct unit-record validator (used by the importer's own second gate) ──
test("validateImportedSimilarityEvidenceUnitRecord is the exact same gate the importer runs post-transform", () => {
  const good = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: VALID_ANCHOR });
  const result = validateImportedSimilarityEvidenceUnitRecord(good, new Set(["ES-TEST00000001"]));
  assert.equal(result.ok, true);
  assert.equal(result.unit.anchorTokens.length, result.unit.anchorTokenCount);
});

test("IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION and NORMALIZATION_VERSION are independent, non-empty, and distinct from each other", () => {
  assert.equal(typeof IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION, "string");
  assert.equal(typeof IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION, "string");
  assert.notEqual(IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_FORMAT_VERSION, IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION);
  assert.notEqual(IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION, "archive-compact-fp-v4");
});
