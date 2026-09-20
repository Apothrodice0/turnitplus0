import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { tokens } from "../lib/similarity-core.ts";
import {
  loadImportedSimilarityEvidencePackage,
  resetImportedSimilarityEvidencePackageCacheForTest,
  resolveImportedSimilarityEvidenceForUnifiedSimilarity,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from "../lib/imported-similarity-evidence/index.ts";
import { buildImportedSimilarityEvidencePackageFile } from "../lib/imported-similarity-evidence/package.ts";
import { makeUnitRecord } from "./helpers/imported-similarity-evidence-fixtures.mjs";

const ANCHOR = "the distinctive constitutional framework governing judicial review procedures";
const MASK = [0, 1, 2, 4, 5, 6, 7];

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function resetCaches() {
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
}

function writeTempPackage(unitRecords, setOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "imported-similarity-evidence-test-"));
  const evidenceSetId = setOverrides.evidenceSetId ?? "ES-TEST00000001";
  const totalScoreMaskWords = unitRecords.reduce((sum, u) => sum + u.scoreMaskWordCount, 0);
  const evidenceSets = [{
    evidenceSetId,
    provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    reportedSimilarityPercent: 49,
    normalizationVersion: unitRecords[0]?.normalizationVersion ?? "imported-similarity-evidence-v1",
    manuscriptIdentitySha256: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    unitCount: unitRecords.length,
    totalScoreMaskWords,
    ...setOverrides,
  }];
  const pkg = buildImportedSimilarityEvidencePackageFile(evidenceSets, unitRecords);
  const path = join(dir, "package.json");
  writeFileSync(path, JSON.stringify(pkg));
  return { dir, path };
}

// ── STEP 13.12 — missing package = no imported matches ──────────────────
test("STEP 13.12: no IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH configured => resolves to [] and computeUnifiedSimilarity is unaffected", () => {
  resetCaches();
  withEnv("IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH", undefined, () => {
    const state = loadImportedSimilarityEvidencePackage();
    assert.equal(state.status, "not_configured");
    const matched = resolveImportedSimilarityEvidenceForUnifiedSimilarity("some manuscript text here");
    assert.deepEqual(matched, []);
  });
  resetCaches();
});

test("STEP 13.14 (config layer): a path pointing at a nonexistent/corrupt file fails closed — resolves to [], never throws", () => {
  resetCaches();
  withEnv("IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH", "D:/definitely/not/a/real/path/package.json", () => {
    const state = loadImportedSimilarityEvidencePackage();
    assert.equal(state.status, "failed");
    assert.doesNotThrow(() => resolveImportedSimilarityEvidenceForUnifiedSimilarity("some manuscript text"));
    assert.deepEqual(resolveImportedSimilarityEvidenceForUnifiedSimilarity("some manuscript text"), []);
  });
  resetCaches();
});

test("STEP 20 — MISSING_PACKAGE_CHANGES_EXISTING_SCORE = NO: computeUnifiedSimilarity output is byte-identical whether importedSimilarityEvidence is absent, null, or []", () => {
  const base = { wordCount: 200, archiveMatchedPositions: [1, 2, 3, 4, 5] };
  const withoutField = computeUnifiedSimilarity(base);
  assert.deepEqual(computeUnifiedSimilarity({ ...base, importedSimilarityEvidence: undefined }), withoutField);
  assert.deepEqual(computeUnifiedSimilarity({ ...base, importedSimilarityEvidence: null }), withoutField);
  assert.deepEqual(computeUnifiedSimilarity({ ...base, importedSimilarityEvidence: [] }), withoutField);
  assert.equal(withoutField.importedSimilarityEvidenceOnlyWords, 0);
  assert.deepEqual(withoutField.importedSimilarityEvidencePositions, []);
});

// ── end-to-end through the real file-backed loader ───────────────────────
test("end-to-end: a real file-backed package resolves through resolveImportedSimilarityEvidenceForUnifiedSimilarity into computeUnifiedSimilarity's score", () => {
  resetCaches();
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const { dir, path } = writeTempPackage([unit]);
  try {
    withEnv("IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH", path, () => {
      const submission = `padding words go here first. ${ANCHOR} then more trailing padding continues onward for a while.`;
      const matched = resolveImportedSimilarityEvidenceForUnifiedSimilarity(submission);
      assert.equal(matched.length, 1);
      const wordCount = tokens(submission).length;
      const result = computeUnifiedSimilarity({ wordCount, importedSimilarityEvidence: matched });
      assert.equal(result.importedSimilarityEvidenceOnlyWords, MASK.length);
      assert.equal(result.uniqueMatchedWords, MASK.length);
      assert.ok(result.unifiedScore > 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetCaches();
  }
});

// ── STEP 13.11 / STEP 20 — imported + Archive positions do not double count ──
test("STEP 13.11: imported evidence overlapping archive-matched positions counts ONCE in the union, never summed", () => {
  const wordCount = 50;
  const archivePositions = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const importedSimilarityEvidence = [{
    sourceId: "PU0001",
    matchedPassages: [{ submittedWordStart: 15, submittedWordEnd: 24, matchedWordCount: 10 }],
    sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY",
  }];
  const archiveOnly = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions: archivePositions });
  const combined = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions: archivePositions, importedSimilarityEvidence });

  // Union of [10..19] and [15..24] = [10..24] = 15 distinct words.
  assert.equal(combined.uniqueMatchedWords, 15);
  assert.equal(combined.matchedPositions.length, 15);
  // Never a plain sum (10 + 10 = 20) — that would be double counting.
  assert.notEqual(combined.uniqueMatchedWords, archivePositions.length + 10);
  // The overlapping [15..19] (5 words) must be reported as overlap, not
  // double-attributed to both archiveOnlyWords and importedSimilarityEvidenceOnlyWords.
  assert.equal(combined.overlapWords, 5);
  assert.equal(combined.archiveOnlyWords, 5); // [10..14]
  assert.equal(combined.importedSimilarityEvidenceOnlyWords, 5); // [20..24]
  assert.ok(combined.unifiedScore >= archiveOnly.unifiedScore);
});

test("STEP 20 — PERCENTAGES_SUMMED = NO: two fully-disjoint channels never exceed 100 and reflect only real word coverage", () => {
  const wordCount = 20;
  const archivePositions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const importedSimilarityEvidence = [{
    sourceId: "PU0001",
    matchedPassages: [{ submittedWordStart: 10, submittedWordEnd: 19, matchedWordCount: 10 }],
    sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY",
  }];
  const result = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions: archivePositions, importedSimilarityEvidence });
  assert.equal(result.unifiedScore, 100); // 20/20 words covered — not archive's 50% + imported's 50% summed into something wrong, but the real 100% is correct here since they are disjoint and together cover everything.
  assert.equal(result.uniqueMatchedWords, 20);
  assert.equal(result.overlapWords, 0);
});

// ── source attribution preserved through the full pipeline ───────────────
test("STEP 13.15 (full pipeline): importedSourceAttributionState is preserved on the contribution and never claims verification it doesn't have", () => {
  const wordCount = 30;
  const importedSimilarityEvidence = [{
    sourceId: "PU0001",
    matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 5, matchedWordCount: 6 }],
    sourceAttributionState: "REPORT_DERIVED_REFERENCE",
  }];
  const result = computeUnifiedSimilarity({ wordCount, importedSimilarityEvidence });
  const contribution = result.contributions.find((c) => c.sourceType === "imported_similarity_evidence");
  assert.ok(contribution);
  assert.equal(contribution.importedSourceAttributionState, "REPORT_DERIVED_REFERENCE");
  assert.equal(contribution.evidenceStatus, "included");
});

// ── STEP 20 — GRAM_HIT_DIRECTLY_SCORES = NO / ANCHOR_VERIFICATION_REQUIRED = YES ──
test("STEP 20: computeUnifiedSimilarity itself has no notion of a 'gram hit' — only already-verified matchedPassages can ever contribute; malformed/garbage passages are clamped or dropped, never trusted blindly", () => {
  const wordCount = 10;
  const importedSimilarityEvidence = [{
    sourceId: "PU0001",
    matchedPassages: [{ submittedWordStart: -5, submittedWordEnd: 500, matchedWordCount: 999 }],
    sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY",
  }];
  const result = computeUnifiedSimilarity({ wordCount, importedSimilarityEvidence });
  // Out-of-range positions are clamped into [0, wordCount).
  assert.ok(result.importedSimilarityEvidenceOnlyWords <= wordCount);
  assert.ok(result.matchedPositions.every((p) => p >= 0 && p < wordCount));
});
