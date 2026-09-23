import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity, grantTestAdmin, markTestAccountEmailVerified } from "./helpers/test-signup.mjs";
import { makeUnitRecord, makePackageFile } from "./helpers/imported-similarity-evidence-fixtures.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { encodeReportForPersistence, decodeReportFromPersistence, tryDecodeReportFromPersistence, ReportPersistenceDecodeError } from "../lib/report-persistence.ts";
import {
  compactEvidenceInterpretationForPersistence,
  expandEvidenceInterpretationFromPersistence,
  isCompactEvidenceInterpretation,
} from "../lib/evidence-interpretation/persistence.ts";
import {
  compactUnifiedSimilarityForPersistence,
  expandUnifiedSimilarityFromPersistence,
} from "../lib/unified-similarity-persistence.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { finalizeSelectiveCorpusAuthoritativeReport } from "../lib/selective-corpus-authoritative.ts";
import { persistSelectiveCorpusAuthoritativeFinalization } from "../lib/report-primary-similarity.ts";
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from "../lib/imported-similarity-evidence/index.ts";

/**
 * C2 — LOSSLESS PERSISTED-REPORT COMPACTION + FAIL-CLOSED INVARIANT.
 *
 * Synthetic fixtures only (no real report text, no real imported package).
 *
 *   A. codec units       — evidenceInterpretation + contributions round-trips (every channel,
 *                          overlaps, empty), verify-then-compact fallback, unknown/corrupt
 *                          compact forms fail safe, no marker/tuple ever survives decoding
 *   B. real routes       — POST persists the compact form; GET expands it (admin vs non-admin,
 *                          no leak); legacy rows still read; unknown versions fail safe;
 *                          resave compatibility; no-package behaviour unchanged
 *   C. the C2 regression — a fragment-heavy IMPORTED-channel report whose legacy form is over
 *                          the 2,000,000 limit now persists score + full explanation; the same
 *                          through the authoritative finalizer
 *   D. fail closed       — over the (unchanged) limit, neither the write-time route nor the
 *                          authoritative finalizer ever persists a score without its explanation
 */

// ────────────────────────────────────────────────────────────────────────────
// environment
// ────────────────────────────────────────────────────────────────────────────
const workDir = mkdtempSync(path.join(tmpdir(), "c2-compaction-"));
const dbFile = path.join(workDir, "c2.db");
const ENV_KEYS = [
  "TURSO_DATABASE_URL",
  "CORPUS_SOURCE_MATCHING_ENABLED",
  "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH",
  "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED",
  "SELECTIVE_CORPUS_SHADOW_ENABLED",
  "SELECTIVE_CORPUS_ARTIFACT_PATH",
  "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
// R2: compact WRITES are an opt-in rollout gate (default OFF). This file is about the compact form, so it opens the gate
// process-locally; the gate itself (default OFF, legacy writes, decoder independent of it) is tested in report-compact-read-safety.test.mjs.
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = "true";
for (const k of ["IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH", "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED", "SELECTIVE_CORPUS_ARTIFACT_PATH"]) delete process.env[k];

const db = createClient({ url: `file:${dbFile}` });
await db.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(db, path.resolve("drizzle"));

function configurePackage(filePath) {
  if (filePath) process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = filePath;
  else delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
}

test.after(() => {
  db.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ────────────────────────────────────────────────────────────────────────────
// A. fixtures + codec units
// ────────────────────────────────────────────────────────────────────────────
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const makeText = (n) => Array.from({ length: n }, (_, i) => `w${i}x`).join(" ");

function baseReport(text, over = {}) {
  const wordCount = tokens(text).length;
  return {
    version: 11, id: 1, submissionId: "s", title: "t", author: "a", assignment: "x", created: "2026-01-01T00:00:00.000Z",
    score: 0, wordCount, characterCount: text.length, pageCount: 1, fileSize: "1 KB", databaseSize: 230,
    corpusVersion: "x", scoreBand: "Low", riskStatus: "Lower", riskTarget: 0, riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "en" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text, ...over,
  };
}

const HSM = {
  status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
  matches: [
    // counted prior submission (feeds previousUploadPositions)
    { relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-A", containment: 0.9, matchedWordCount: 41, passageCount: 1, longestMatchWords: 41, passages: [{ submittedWordStart: 300, submittedWordEnd: 340, matchedWordCount: 41 }], historicalSubmissionCount: 0 },
    // effective same-device SELF (effectiveScoringRelationship / effectiveScoringReason on its contribution)
    { relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-B", containment: 0.9, matchedWordCount: 11, passageCount: 1, longestMatchWords: 11, passages: [{ submittedWordStart: 250, submittedWordEnd: 260, matchedWordCount: 11 }], historicalSubmissionCount: 0 },
    // genuine SELF
    { relationshipType: "SELF", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-C", containment: 0.9, matchedWordCount: 6, passageCount: 1, longestMatchWords: 6, passages: [{ submittedWordStart: 270, submittedWordEnd: 275, matchedWordCount: 6 }], historicalSubmissionCount: 0 },
  ],
};
const REF_EVIDENCE = [{
  key: "usr-ref:1", safeLabel: "my-reference.pdf", fileType: "pdf", extractionStatus: "EXTRACTED", analyzableWordCount: 500,
  matchedWords: 31, contributionPercent: 8, admitted: true, admissionReason: "ADMITTED",
  verifiedPassages: [{ submittedWordStart: 50, submittedWordEnd: 80, matchedWordCount: 31 }],
}];

/** One report carrying EVERY evidence channel, with overlaps (archive 10-60 x user-ref 50-80 x imported 55-62) and multi-fragment sources. */
function fullReport() {
  const text = makeText(420);
  const base = baseReport(text);
  const archive = [...range(10, 60), ...range(200, 230)];
  const scholarly = [{
    provider: "openaire", providerId: "openaire", title: "A study of X", authors: ["Smith"], publication: "Journal of X",
    year: 2020, doi: "10.1/x", url: "https://doi.org/10.1/x", similarity: 60,
    matchedPassages: [{ submittedText: "", submittedWordStart: 120, submittedWordEnd: 150, matchedWordCount: 31 }],
  }];
  const unifiedSimilarity = computeUnifiedSimilarity({
    wordCount: base.wordCount,
    archiveMatchedPositions: archive,
    externalAcademicEvidence: scholarly,
    historicalSubmissionMatch: HSM,
    effectiveDeviceSelfRepresentationIds: ["rep-B"],
    userSuppliedReferenceEvidence: [{ sourceId: "usr-ref:1", matchedPassages: REF_EVIDENCE[0].verifiedPassages }],
    selectiveCorpusEvidence: [{ sourceId: "S1", matchedPassages: [{ submittedWordStart: 350, submittedWordEnd: 380, matchedWordCount: 31 }] }],
    importedSimilarityEvidence: [
      { sourceId: "U-1", sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY", matchedPassages: [{ submittedWordStart: 160, submittedWordEnd: 165, matchedWordCount: 6 }, { submittedWordStart: 170, submittedWordEnd: 172, matchedWordCount: 3 }] },
      { sourceId: "U-2", sourceAttributionState: "REPORT_DERIVED_REFERENCE", matchedPassages: [{ submittedWordStart: 55, submittedWordEnd: 62, matchedWordCount: 8 }] },
      { sourceId: "U-3", matchedPassages: [{ submittedWordStart: 390, submittedWordEnd: 395, matchedWordCount: 6 }] },
    ],
  });
  return withEvidenceInterpretation(
    {
      ...base,
      archiveMatchedPositions: archive,
      sources: [{ name: "Wikipedia — “Photosynthesis”", type: "Internet", percent: 12, matches: 3, matchedWords: 51, phrases: [], color: "#000" }, { name: "Some Journal", type: "Publication", percent: 5, matches: 1, matchedWords: 31, phrases: [], color: "#111" }],
      externalAcademicEvidence: scholarly,
      historicalSubmissionMatch: HSM,
      unifiedSimilarity,
    },
    {
      historicalSubmissionMatch: HSM,
      selectiveCorpusBranch: null,
      userSuppliedReferenceEvidence: REF_EVIDENCE,
      selectiveCorpusAdmittedSources: [{ key: "sc-1", spans: [{ start: 350, end: 380, words: 31 }], familyGuardActivated: false, dominantSpanBoilerplate: false }],
    },
  );
}

/** runtime report -> persisted form -> JSON text -> parse. The wire round trip every stored row takes. */
function viaWire(report) {
  const persisted = encodeReportForPersistence(report);
  const json = JSON.stringify(persisted);
  return { persisted, json, parsed: JSON.parse(json) };
}
/** What a legacy (pre-compaction) row is: the fully expanded runtime report serialised as-is. */
const asLegacyRow = (report) => JSON.parse(JSON.stringify(report));
const jsonNormalised = (value) => JSON.parse(JSON.stringify(value));

const COMPACT_LEAK_MARKERS = ['"format":"compact"', "formatVersion", "passageInterpretations", "sourceShapes", '"strings":', '"rows":', "previousUploadPositionsEncoding"];
const assertNoCompactLeak = (text, label) => {
  for (const marker of COMPACT_LEAK_MARKERS) assert.equal(text.includes(marker), false, `${label}: no compact-format internals (${marker}) may appear`);
};

const FULL = fullReport();
/**
 * FULL as it would sit in a stored row. `historicalSubmissionMatch` is a fixture-only input here — in production it lives in its
 * own snapshot table and is never part of payload_json (GET only attaches it for an admin) — so seeded rows omit it.
 */
const { historicalSubmissionMatch: _fixtureOnlyHistoricalMatch, ...FULL_ROW } = FULL;

test("A1. interpretation compact round trip is exact for a report carrying EVERY channel (archive, scholarly, prior, user-reference, Selective Corpus, imported) with overlaps", () => {
  const { persisted, parsed } = viaWire(FULL);
  assert.equal(isCompactEvidenceInterpretation(persisted.evidenceInterpretation), true, "the persisted form is the compact form");
  const expansion = expandEvidenceInterpretationFromPersistence(parsed.evidenceInterpretation);
  assert.equal(expansion.status, "expanded");
  assert.deepEqual(expansion.value, jsonNormalised(FULL.evidenceInterpretation), "expand(compact(x)) === x, through real JSON serialisation");
  const types = new Set(FULL.evidenceInterpretation.sources.map((s) => s.sourceType));
  for (const expected of ["internet", "publication", "reference-collection", "user-supplied-reference", "selective-corpus", "imported-similarity-evidence"]) {
    assert.ok(types.has(expected), `fixture really carries the ${expected} channel`);
  }
});

test("A2. contributions compact round trip is exact (every optional field, every channel) and never leaks the compact tuple form", () => {
  const contributions = FULL.unifiedSimilarity.contributions;
  const fields = new Set(contributions.flatMap((c) => Object.keys(c)));
  for (const f of ["relationship", "effectiveScoringRelationship", "effectiveScoringReason", "importedSourceAttributionState"]) assert.ok(fields.has(f), `fixture exercises ${f}`);
  assert.ok(new Set(contributions.map((c) => c.sourceType)).size >= 5, "fixture spans many contribution channels");
  assert.ok(contributions.some((c) => c.evidenceStatus === "excluded_effective_device_self") && contributions.some((c) => c.evidenceStatus === "excluded_self"));

  const { persisted, parsed, json } = viaWire(FULL);
  assert.equal(Array.isArray(persisted.unifiedSimilarity.contributions), false, "persisted contributions are the compact form");
  assert.equal(persisted.unifiedSimilarity.contributions.format, "compact");
  const expanded = expandUnifiedSimilarityFromPersistence(parsed.unifiedSimilarity);
  assert.deepEqual(expanded.contributions, jsonNormalised(contributions));
  assert.deepEqual(expanded, jsonNormalised(FULL.unifiedSimilarity), "the whole unifiedSimilarity (positions included) round-trips");
  assert.ok(JSON.stringify(persisted.unifiedSimilarity.contributions).length < JSON.stringify(contributions).length, "and it is actually smaller");
  assert.ok(json.length < JSON.stringify(FULL).length, "the whole persisted report is smaller than the legacy report");
  assertNoCompactLeak(JSON.stringify(expanded), "expanded unifiedSimilarity");
});

test("A3. whole-report round trip: decode(parse(stringify(encode(report)))) deep-equals the runtime report, and no compact internals survive", () => {
  const { parsed } = viaWire(FULL);
  const decoded = decodeReportFromPersistence(parsed);
  assert.deepEqual(decoded, jsonNormalised(FULL));
  assertNoCompactLeak(JSON.stringify(decoded), "decoded report");
});

test("A4. compact EMPTY evidence: an empty interpretation and empty contributions round trip exactly", () => {
  const report = withEvidenceInterpretation(
    { ...baseReport(makeText(50)), unifiedSimilarity: computeUnifiedSimilarity({ wordCount: 50 }) },
    { selectiveCorpusBranch: null },
  );
  assert.equal(report.evidenceInterpretation.passages.length, 0);
  assert.equal(report.evidenceInterpretation.sources.length, 0);
  const { persisted, parsed } = viaWire(report);
  assert.deepEqual(persisted.unifiedSimilarity.contributions, [], "no contributions: left as the plain (legacy) empty array");
  assert.deepEqual(decodeReportFromPersistence(parsed), jsonNormalised(report));
  const expansion = expandEvidenceInterpretationFromPersistence(parsed.evidenceInterpretation);
  assert.deepEqual(expansion.value, jsonNormalised(report.evidenceInterpretation));
});

test("A5. multi-source passages and multi-passage sources survive (overlap relationships intact, passageRefs re-derived exactly)", () => {
  const ei = FULL.evidenceInterpretation;
  assert.ok(ei.passages.some((p) => p.sourceIds.length >= 2), "fixture has a passage explained by several sources (archive x user-reference x imported overlap)");
  assert.ok(ei.sources.some((s) => s.passageRefs.length >= 2), "fixture has a source with several passages");
  const expanded = expandEvidenceInterpretationFromPersistence(viaWire(FULL).parsed.evidenceInterpretation).value;
  for (let i = 0; i < ei.passages.length; i += 1) {
    assert.deepEqual(expanded.passages[i].sourceIds, ei.passages[i].sourceIds, `passage ${i}: source association (and order) preserved`);
    assert.equal(expanded.passages[i].id, i);
  }
  for (let i = 0; i < ei.sources.length; i += 1) assert.deepEqual(expanded.sources[i].passageRefs, ei.sources[i].passageRefs, `card ${ei.sources[i].id}: passageRefs preserved`);
  // reconciliation invariants of the ORIGINAL contract still hold after expansion
  const flat = Object.values(expanded.positionsByKind).flat();
  assert.equal(flat.length, new Set(flat).size, "no position partitioned twice");
  assert.equal(flat.length, expanded.matchedWordCount);
  assert.deepEqual([...flat].sort((a, b) => a - b), [...FULL.unifiedSimilarity.matchedPositions].sort((a, b) => a - b), "the partition is exactly the authoritative union");
});

test("A6. imported / archive / user-reference cards each survive compaction with their public fields intact", () => {
  const expanded = expandEvidenceInterpretationFromPersistence(viaWire(FULL).parsed.evidenceInterpretation).value;
  const byType = (type) => expanded.sources.filter((s) => s.sourceType === type);
  const imported = byType("imported-similarity-evidence");
  assert.equal(imported.length, 3, "one card per imported unit — never grouped");
  assert.ok(imported.every((c) => c.label === "Imported reference match" && c.link === null && c.doi === null && c.year === null));
  assert.equal(imported.reduce((n, c) => n + c.matchedWords, 0), 6 + 3 + 8 + 6);
  const archive = byType("internet")[0];
  assert.ok(archive.namedSources.length === 2 && archive.namedSources[0].label === "Wikipedia — “Photosynthesis”", "the archive aggregate card keeps its named sources");
  const ref = byType("user-supplied-reference")[0];
  assert.equal(ref.label, "my-reference.pdf");
  assert.equal(ref.matchedWords, 31);
  for (const card of expanded.sources) assert.match(card.id, /^src-\d+$/);
});

test("A7. the customer view model built from the DECODED report is identical to the one built from the runtime report (public shape unchanged)", () => {
  const decoded = decodeReportFromPersistence(viaWire(FULL).parsed);
  assert.deepEqual(buildReportV2ViewModel(decoded), buildReportV2ViewModel(jsonNormalised(FULL)));
  assert.ok(buildReportV2ViewModel(decoded).sources.length >= 6);
});

test("A8. scoring is not affected: every scoring field and position array is byte-identical across persistence", () => {
  const scenarios = [
    { archiveMatchedPositions: range(0, 90) },
    { historicalSubmissionMatch: HSM, effectiveDeviceSelfRepresentationIds: ["rep-B"] },
    { importedSimilarityEvidence: [{ sourceId: "U", matchedPassages: [{ submittedWordStart: 5, submittedWordEnd: 20, matchedWordCount: 16 }] }] },
    { userSuppliedReferenceEvidence: [{ sourceId: "r", matchedPassages: [{ submittedWordStart: 30, submittedWordEnd: 60, matchedWordCount: 31 }] }], selectiveCorpusEvidence: [{ sourceId: "s", matchedPassages: [{ submittedWordStart: 55, submittedWordEnd: 70, matchedWordCount: 16 }] }] },
    {},
  ];
  for (const params of scenarios) {
    const unified = computeUnifiedSimilarity({ wordCount: 420, ...params });
    const back = expandUnifiedSimilarityFromPersistence(JSON.parse(JSON.stringify(compactUnifiedSimilarityForPersistence(unified))));
    for (const key of ["unifiedScore", "uniqueMatchedWords", "archiveOnlyWords", "liveAcademicOnlyWords", "previousUploadOnlyWords", "overlapWords", "selfExcludedWords", "unknownExcludedWords", "deviceSelfExcludedWords", "userSuppliedReferenceOnlyWords", "selectiveCorpusOnlyWords", "importedSimilarityEvidenceOnlyWords"]) {
      assert.equal(back[key], unified[key], `${key} unchanged`);
    }
    assert.deepEqual(back, jsonNormalised(unified));
  }
});

test("A9. verify-then-compact: anything not EXACTLY representable is persisted in its original shape — never lossy, never dropped", () => {
  // (a) an unknown extra card field
  const withExtraCardField = structuredClone(FULL.evidenceInterpretation);
  withExtraCardField.sources[0].futureField = { anything: 1 };
  assert.equal(compactEvidenceInterpretationForPersistence(withExtraCardField), withExtraCardField, "extra card field -> original shape kept");
  // (b) a passage naming a card that does not exist
  const orphan = structuredClone(FULL.evidenceInterpretation);
  orphan.passages[0].sourceIds = ["src-999"];
  assert.equal(compactEvidenceInterpretationForPersistence(orphan), orphan);
  // (c) passage ids that are not their index
  const reindexed = structuredClone(FULL.evidenceInterpretation);
  reindexed.passages[0].id = 7;
  assert.equal(compactEvidenceInterpretationForPersistence(reindexed), reindexed);
  // (d) a positionsByKind that is not the partition of the passages
  const drifted = structuredClone(FULL.evidenceInterpretation);
  drifted.positionsByKind.DISTINCTIVE_EXTERNAL_MATCH = drifted.positionsByKind.DISTINCTIVE_EXTERNAL_MATCH.slice(1);
  assert.equal(compactEvidenceInterpretationForPersistence(drifted), drifted);
  // (e) contributions: an unknown extra field / a non-finite number keep the plain array
  const c1 = structuredClone(FULL.unifiedSimilarity);
  c1.contributions[0].futureField = "x";
  assert.equal(Array.isArray(compactUnifiedSimilarityForPersistence(c1).contributions), true);
  assert.deepEqual(compactUnifiedSimilarityForPersistence(c1).contributions, c1.contributions);
  const c2 = structuredClone(FULL.unifiedSimilarity);
  c2.contributions[0].submittedWordStart = Number.NaN;
  assert.equal(Array.isArray(compactUnifiedSimilarityForPersistence(c2).contributions), true);
  // and the original is never mutated by any compaction
  assert.deepEqual(FULL.evidenceInterpretation, expandEvidenceInterpretationFromPersistence(compactEvidenceInterpretationForPersistence(FULL.evidenceInterpretation)).value);
});

test("A10. UNKNOWN / CORRUPT compact forms FAIL CLOSED (R2): the structured decode refuses, the strict decode throws, nothing is fabricated or emptied, scores are never returned without their explanation, and the log carries a bounded reason only", () => {
  const logged = [];
  const spy = mock.method(console, "error", (...args) => { logged.push(args.join(" ")); });
  try {
    const wire = () => viaWire(FULL).parsed;

    // (1) an unsupported interpretation version: refused, with the bounded reason — not a report with the interpretation removed
    const futureVersion = wire();
    futureVersion.evidenceInterpretation.formatVersion = 2;
    assert.deepEqual(tryDecodeReportFromPersistence(futureVersion), { ok: false, reason: "unsupported_compact_format" });
    assert.throws(() => decodeReportFromPersistence(futureVersion), (error) => error instanceof ReportPersistenceDecodeError && error.reason === "unsupported_compact_format");
    assert.ok(logged.some((line) => /"event":"report_persistence_unreadable","reason":"unsupported_compact_format","detail":"UNSUPPORTED_FORMAT_VERSION","outcome":"refused"/.test(line)));

    // (2) every corruption is a refusal too (never "drop and continue")
    const corruptions = {
      MALFORMED_PASSAGE_RANGE: (ei) => { ei.passages[0][0] = "x"; },
      COUNT_MISMATCH: (ei) => { ei.countsByKind.DISTINCTIVE_EXTERNAL_MATCH += 1; },
      BAD_PASSAGE_SOURCE_INDEX: (ei) => { ei.passages[0].push(9999); },
      POSITION_OVERFLOW: (ei) => { ei.passages[0][1] = 1e9; },
      BAD_SOURCE_SHAPE_INDEX: (ei) => { ei.sources[0][1] = 99; },
      UNKNOWN_PASSAGE_KIND: (ei) => { ei.passageInterpretations[0].kind = "NOT_A_KIND"; },
      BAD_PASSAGE_INTERPRETATION_INDEX: (ei) => { ei.passages[0][2] = 50; },
    };
    for (const [detail, corrupt] of Object.entries(corruptions)) {
      const row = wire();
      corrupt(row.evidenceInterpretation);
      const expansion = expandEvidenceInterpretationFromPersistence(row.evidenceInterpretation);
      assert.deepEqual({ status: expansion.status, reason: expansion.reason }, { status: "unreadable", reason: detail }, detail);
      assert.deepEqual(tryDecodeReportFromPersistence(row), { ok: false, reason: "corrupt_evidence_interpretation" }, `${detail}: refused, not dropped`);
      assert.throws(() => decodeReportFromPersistence(row), ReportPersistenceDecodeError, detail);
    }

    // (3) an interpretation that is neither legacy nor compact v1 is not silently accepted as a "legacy" one
    for (const junk of ["not-an-object", 7, ["array"], { format: "packed", formatVersion: 1 }]) {
      const row = wire();
      row.evidenceInterpretation = junk;
      assert.equal(tryDecodeReportFromPersistence(row).ok, false, `unknown/garbage interpretation ${JSON.stringify(junk)} is refused`);
    }
    // ... whereas ABSENT (legacy / pre-Report-V2) stays a valid, distinct case
    const absent = wire();
    delete absent.evidenceInterpretation;
    const absentDecoded = tryDecodeReportFromPersistence(absent);
    assert.equal(absentDecoded.ok, true);
    assert.equal("evidenceInterpretation" in absentDecoded.report, false, "absent stays absent — nothing is fabricated");

    // (4) contributions: a viewer that is SERVED them (default) is refused; a viewer that never receives them is not
    const badContributions = [
      { format: "compact", formatVersion: 99, strings: [], rows: [] },
      { format: "compact", formatVersion: 1, strings: [], rows: [[0, 0, 1, 2, 3, 0]] },
      { format: "compact", formatVersion: 1, strings: "x", rows: [] },
      { format: "compact", formatVersion: 1, strings: ["a"], rows: [[0, 0, "a", 2, 3, 0]] },
      { format: "packed", formatVersion: 1 },
      "junk",
    ];
    for (const bad of badContributions) {
      const row = wire();
      row.unifiedSimilarity.contributions = bad;
      const required = tryDecodeReportFromPersistence(row);
      assert.equal(required.ok, false, `contributions required: ${JSON.stringify(bad).slice(0, 40)} is refused`);
      assert.match(required.reason, /^(unsupported_compact_format|corrupt_contributions)$/);
      const optional = tryDecodeReportFromPersistence(row, { requireContributions: false });
      assert.equal(optional.ok, true, "contributions not served: the customer-visible explanation is intact, so the report may be served");
      assert.deepEqual(optional.report.unifiedSimilarity.contributions, [], "absence-compatible [] (what a non-admin receives anyway)");
      assert.deepEqual(optional.report.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation), "the explanation is exactly the intact one");
      assert.equal(optional.report.unifiedSimilarity.unifiedScore, FULL.unifiedSimilarity.unifiedScore);
      assertNoCompactLeak(JSON.stringify(optional.report), "contributions-optional decode");
    }
    // ... and a corrupt INTERPRETATION is refused even when contributions are not required
    const bothBad = wire();
    bothBad.evidenceInterpretation.formatVersion = 2;
    assert.equal(tryDecodeReportFromPersistence(bothBad, { requireContributions: false }).ok, false);

    // (5) a non-object payload is a structured failure, not a TypeError
    for (const junk of [null, [], "x", 7, undefined]) assert.deepEqual(tryDecodeReportFromPersistence(junk), { ok: false, reason: "invalid_persisted_report" });

    assert.ok(logged.length > 0 && logged.every((line) => /^{"event":"report_persistence_unreadable","reason":"[a-z_]+","detail":"[A-Z_]+","outcome":"(refused|served_without_contributions)"}$/.test(line)), "every log line is the closed, bounded event");
    assert.ok(logged.every((line) => !/wd+x|my-reference|Photosynthesis/.test(line)), "logs carry a reason only, never report content");
  } finally {
    spy.mock.restore();
  }
});

test("A11. legacy (uncompressed) persisted forms are accepted unchanged and never mutated: decoding a legacy row is a no-op", () => {
  const legacy = asLegacyRow(FULL);
  const snapshot = JSON.stringify(legacy);
  const decoded = decodeReportFromPersistence(legacy);
  assert.equal(JSON.stringify(legacy), snapshot, "the input row is not mutated");
  assert.deepEqual(decoded, legacy);
  assert.equal(expandEvidenceInterpretationFromPersistence(legacy.evidenceInterpretation).status, "legacy");
  // a legacy row with NO interpretation / NO unifiedSimilarity (pre-Report-V2) stays exactly that
  const preV2 = { ...baseReport(makeText(20)) };
  assert.deepEqual(decodeReportFromPersistence(preV2), preV2);
  assert.equal("evidenceInterpretation" in decodeReportFromPersistence(preV2), false, "no interpretation is fabricated for a legacy row");
  // an old previousUploadPositionsEncoding row (the pre-C2 elision) still expands
  const u = computeUnifiedSimilarity({ wordCount: 420, historicalSubmissionMatch: HSM });
  assert.deepEqual(u.previousUploadPositions, u.matchedPositions, "fixture: the prior-submission channel is the only contributor");
  const oldStyle = { ...u, previousUploadPositions: undefined, previousUploadPositionsEncoding: "matchedPositions" };
  const expandedOld = expandUnifiedSimilarityFromPersistence(JSON.parse(JSON.stringify(oldStyle)));
  assert.deepEqual(expandedOld.previousUploadPositions, u.previousUploadPositions);
  assert.equal("previousUploadPositionsEncoding" in expandedOld, false);
});

// ────────────────────────────────────────────────────────────────────────────
// B. real routes
// ────────────────────────────────────────────────────────────────────────────
const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account({ admin = false } = {}) {
  uc += 1;
  const email = `c2-${uc}@example.test`;
  await resetAuthRateForTest("c2-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "c2-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email, password: "c2-pw-123456", username: `c2u${uc}`, deviceKey: `c2-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  if (admin) await grantTestAdmin(dbFile, email);
  await markTestAccountEmailVerified(dbFile, email);
  const userId = String((await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0].id);
  return { deviceKey: `c2-dev-${uc}`, cookie: cookieOf(res), tag: `c2-${uc}`, userId, email };
}

let idc = 0;
const nextId = (prefix) => `${prefix}-${(idc += 1)}`;

function reportRequestBody(acc, id, { text, archiveMatchedPositions, sources, padding, room = 0, payloadExtra = {} }) {
  const wordCount = tokens(text).length;
  return {
    deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "c2 fixture", createdAt: new Date().toISOString(),
    wordCount, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room,
    payload: {
      version: 11, id, submissionId: "sub-" + id, title: "c2 fixture", author: "", assignment: "", created: new Date().toISOString(),
      score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0, sources: sources ?? [], repeats: [], text,
      ...(archiveMatchedPositions ? { archiveMatchedPositions } : {}),
      ...(padding !== undefined ? { testPadding: padding } : {}),
      ...payloadExtra,
    },
  };
}
async function postBody(acc, body) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify(body),
  }));
}
const post = (acc, id, opts) => postBody(acc, reportRequestBody(acc, id, opts));
async function get(acc, id) {
  await resetReadRateForTest(acc.tag + "-get");
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}`, { headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` } }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, text, payload: res.status === 200 ? JSON.parse(text).payload : null };
}
async function rawRow(acc, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  return r.rows[0] ? String(r.rows[0].payload_json) : null;
}
async function seedRow(acc, id, payloadJson) {
  await db.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, acc.deviceKey, "sub-" + id, "seeded", new Date().toISOString(), 420, 0, "Low", payloadJson, acc.userId, null],
  });
}

test("B1. real POST persists the COMPACT form; real GET expands it back to the exact public shape (owner / non-admin), with no compact internals anywhere in the response", async () => {
  const acc = await account();
  const id = nextId("b1");
  const runs = 300;
  const text = makeText(runs * 4);
  const archive = range(0, runs * 4 - 1).filter((p) => p % 4 !== 3);
  const res = await post(acc, id, { text, archiveMatchedPositions: archive, sources: [{ name: "Src", type: "Internet", percent: 50, matches: 1, matchedWords: archive.length, phrases: [], color: "#000" }] });
  assert.equal(res.status, 200);

  const raw = JSON.parse(await rawRow(acc, id));
  assert.equal(isCompactEvidenceInterpretation(raw.evidenceInterpretation), true, "the stored interpretation is compact");
  assert.equal(raw.evidenceInterpretation.passages.length, runs, "one passage per matched run");

  const got = await get(acc, id);
  assert.equal(got.status, 200);
  assertNoCompactLeak(got.text, "GET response");
  const ei = got.payload.evidenceInterpretation;
  assert.equal(ei.passages.length, runs);
  assert.equal(ei.positionsByKind.DISTINCTIVE_EXTERNAL_MATCH.length, archive.length, "positionsByKind is regenerated on read");
  // independent oracle: a from-scratch rebuild from the GET payload equals what GET served
  const rebuilt = withEvidenceInterpretation(got.payload, { selectiveCorpusBranch: null }).evidenceInterpretation;
  assert.deepEqual(ei, jsonNormalised(rebuilt));
  assert.deepEqual(got.payload.unifiedSimilarity.contributions, [], "non-admin: contributions redacted");
});

test("B2. LEGACY uncompressed rows are served unchanged by the real GET (admin sees contributions, non-admin gets []), without any compact internals", async () => {
  const owner = await account();
  const admin = await account({ admin: true });
  const id = nextId("b2");
  const legacyJson = JSON.stringify(FULL_ROW);
  await seedRow(owner, id, legacyJson);
  await seedRow(admin, id, legacyJson);

  const asOwner = await get(owner, id);
  assert.equal(asOwner.status, 200);
  assert.deepEqual(asOwner.payload.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
  assert.deepEqual(asOwner.payload.unifiedSimilarity.contributions, []);
  assert.equal(asOwner.payload.unifiedSimilarity.unifiedScore, FULL.unifiedSimilarity.unifiedScore);
  assertNoCompactLeak(asOwner.text, "legacy GET (owner)");

  const asAdmin = await get(admin, id);
  assert.deepEqual(asAdmin.payload.unifiedSimilarity.contributions, jsonNormalised(FULL.unifiedSimilarity.contributions), "admin: legacy contributions unchanged");
  assert.deepEqual(asAdmin.payload.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
});

test("B3. COMPACT rows through the real GET: admin sees the exact contributions it always did; a non-admin never receives them; both see the identical, fully expanded interpretation", async () => {
  const owner = await account();
  const admin = await account({ admin: true });
  const id = nextId("b3");
  const compactJson = JSON.stringify(encodeReportForPersistence(FULL_ROW));
  assert.equal(isCompactEvidenceInterpretation(JSON.parse(compactJson).evidenceInterpretation), true);
  await seedRow(owner, id, compactJson);
  await seedRow(admin, id, compactJson);

  const asAdmin = await get(admin, id);
  assert.equal(asAdmin.status, 200);
  assert.deepEqual(asAdmin.payload.unifiedSimilarity.contributions, jsonNormalised(FULL.unifiedSimilarity.contributions), "admin compat: full contributions");
  assert.deepEqual(asAdmin.payload.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
  assertNoCompactLeak(asAdmin.text, "compact GET (admin)");

  const asOwner = await get(owner, id);
  assert.deepEqual(asOwner.payload.unifiedSimilarity.contributions, [], "non-admin never receives internal contributions");
  assert.deepEqual(asOwner.payload.evidenceInterpretation, asAdmin.payload.evidenceInterpretation);
  assertNoCompactLeak(asOwner.text, "compact GET (non-admin)");
  for (const privateBit of ["imported-similarity-evidence:", "U-1", "rep-A", "rep-B", "TURNITIN_SOURCE_MARKER_ONLY", "REPORT_DERIVED_REFERENCE", "excluded_effective_device_self"]) {
    assert.equal(asOwner.text.includes(privateBit), false, `a non-admin response must not contain ${privateBit}`);
  }
});

test("B4. GET/SSR PARITY: both read boundaries decode with the ONE shared helper before anything else touches the row (structural), and a decoded row equals what GET serves (behavioural)", async () => {
  const getSrc = fs.readFileSync("app/api/reports/[id]/route.ts", "utf8");
  const ssrSrc = fs.readFileSync("app/reports/[id]/page.tsx", "utf8");
  for (const [label, src, parseCall] of [["GET route", getSrc, /JSON\.parse\(String\(row\.payload_json\)\)/], ["SSR page", ssrSrc, /JSON\.parse\(row\.payload_json\)/]]) {
    assert.match(src, /from ['"](?:@\/lib|\.\.\/\.\.\/\.\.\/(?:\.\.\/)?lib)\/report-persistence['"]/, `${label} imports the shared decode helper`);
    assert.match(src, /tryDecodeReportFromPersistence\(JSON\.parse\(/, `${label} decodes (structured, fail-closed) at the point the row is parsed`);
    assert.match(src, /if \(!decoded\.ok\)/, `${label} checks the structured decode result before using the report`);
    assert.match(src, parseCall);
    assert.equal(/expandUnifiedSimilarityFromPersistence/.test(src), false, `${label} no longer carries a second, partial decoder`);
  }
  const owner = await account();
  const id = nextId("b4");
  await seedRow(owner, id, JSON.stringify(encodeReportForPersistence(FULL_ROW)));
  const raw = JSON.parse(await rawRow(owner, id));
  const ssrEquivalent = decodeReportFromPersistence(raw);
  const served = (await get(owner, id)).payload;
  assert.deepEqual(served.evidenceInterpretation, ssrEquivalent.evidenceInterpretation, "SSR-decoded interpretation === GET interpretation");
  assert.deepEqual({ ...served.unifiedSimilarity, contributions: [] }, { ...ssrEquivalent.unifiedSimilarity, contributions: [] });
  // the admin readers use the same helper too
  assert.match(fs.readFileSync("lib/developer-repo.ts", "utf8").replace(/\r/g, ""), /tryDecodeReportFromPersistence\(JSON\.parse\(raw\.payload_json\)/);
});

test("B5. an UNKNOWN compact version in a stored row FAILS CLOSED through the real GET (R2): a generic 503, never a 200 with the score and no explanation, and no compact internals or score in the body", async () => {
  const owner = await account();
  const admin = await account({ admin: true });
  const id = nextId("b5");
  const row = JSON.parse(JSON.stringify(encodeReportForPersistence(FULL_ROW)));
  row.evidenceInterpretation.formatVersion = 42;
  row.unifiedSimilarity.contributions.formatVersion = 42;
  await seedRow(owner, id, JSON.stringify(row));
  await seedRow(admin, id, JSON.stringify(row));
  const spy = mock.method(console, "error", () => {});
  try {
    for (const [label, acc] of [["owner", owner], ["admin", admin]]) {
      const got = await get(acc, id);
      assert.equal(got.status, 503, `${label}: refused, not served`);
      assert.deepEqual(JSON.parse(got.text), { error: "Report temporarily unavailable", code: "REPORT_TEMPORARILY_UNAVAILABLE" });
      assert.equal(got.payload, null);
      for (const leaked of ["unifiedScore", "evidenceInterpretation", "formatVersion", "unsupported_compact_format", "UNSUPPORTED", "passages", "matchedPositions"]) {
        assert.equal(got.text.includes(leaked), false, `${label}: the refusal must not contain ${leaked}`);
      }
      assertNoCompactLeak(got.text, `unknown-version GET (${label})`);
    }
  } finally {
    spy.mock.restore();
  }
});

test("B6. RESAVE compatibility: a report persisted compact can be re-saved from its own GET payload and stays compact, complete and identical", async () => {
  const acc = await account();
  const id = nextId("b6");
  const text = makeText(400);
  const archive = range(0, 399).filter((p) => p % 5 !== 4);
  const opts = { text, archiveMatchedPositions: archive };
  assert.equal((await post(acc, id, opts)).status, 200);
  const first = await get(acc, id);
  assert.ok(first.payload.evidenceInterpretation.passages.length > 0);

  // AI-completion style resave: the client echoes the GET payload (expanded shape) back
  const echoed = { ...first.payload };
  const res = await postBody(acc, { ...reportRequestBody(acc, id, opts), aiScore: 9, aiStatus: "ready", payload: { ...reportRequestBody(acc, id, opts).payload, ...echoed, aiScore: 9 } });
  assert.equal(res.status, 200);
  const rawAfter = JSON.parse(await rawRow(acc, id));
  assert.equal(isCompactEvidenceInterpretation(rawAfter.evidenceInterpretation), true, "still compact after a resave");
  const second = await get(acc, id);
  assert.deepEqual(second.payload.evidenceInterpretation, first.payload.evidenceInterpretation, "the explanation is unchanged by the resave");
  assert.equal(second.payload.unifiedSimilarity.unifiedScore, first.payload.unifiedSimilarity.unifiedScore);
});

test("B7. with NO imported package configured the route is unchanged: zero imported contribution, no imported card, contributions stay the plain empty array", async () => {
  configurePackage(null);
  const acc = await account();
  const id = nextId("b7");
  assert.equal((await post(acc, id, { text: makeText(200), archiveMatchedPositions: range(0, 39) })).status, 200);
  const raw = JSON.parse(await rawRow(acc, id));
  assert.equal(raw.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, 0);
  assert.deepEqual(raw.unifiedSimilarity.importedSimilarityEvidencePositions, []);
  assert.deepEqual(raw.unifiedSimilarity.contributions, [], "no contributions -> the legacy plain array, exactly as before the channel existed");
  const got = await get(acc, id);
  assert.equal(got.payload.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence").length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// C. THE C2 REGRESSION — a fragment-heavy IMPORTED-channel report
// ────────────────────────────────────────────────────────────────────────────
// Structure mirrors the real benchmark the audit measured (many short fragments, one card per unit):
// every unit is an 8-word anchor whose score mask credits 7 of the 8 words as two fragments (0-2, 4-7),
// followed by 6 filler words. UNITS units => 14*UNITS words, 2*UNITS passages, UNITS cards, 2*UNITS contributions.
const UNITS = 1500;
const WORDS_PER_UNIT = 14;
const MASK = [0, 1, 2, 4, 5, 6, 7];
const unitId = (i) => `PU${String(i).padStart(5, "0")}`;
// Token indexes start at 100: the package loader (correctly) rejects an anchor made of single-digit-indexed tokens
// ("isolated numeral" — no informative gram), which would silently shrink the fixture.
const anchorOf = (i) => "abcdefgh".split("").map((c) => `u${i + 100}${c}`).join(" ");
const fillerOf = (i) => "abcdef".split("").map((c) => `f${i + 100}${c}`).join(" ");
const IMPORTED_MANUSCRIPT = Array.from({ length: UNITS }, (_, i) => `${anchorOf(i)} ${fillerOf(i)}`).join(" ");

function writeScalePackage() {
  const units = Array.from({ length: UNITS }, (_, i) => makeUnitRecord({ evidenceUnitId: unitId(i), anchorNormalizedText: anchorOf(i), scoreMaskRelativePositions: MASK }));
  const filePath = path.join(workDir, "scale-package.json");
  fs.writeFileSync(filePath, JSON.stringify(makePackageFile(units)));
  return filePath;
}

let scaleCache = null;
/** ONE real POST of the scale report (admin account, so contributions can be inspected), shared by the C tests. */
async function scaleReport() {
  if (scaleCache) return scaleCache;
  configurePackage(writeScalePackage());
  const admin = await account({ admin: true });
  const id = nextId("scale");
  const t0 = performance.now();
  const res = await post(admin, id, { text: IMPORTED_MANUSCRIPT });
  const postMs = performance.now() - t0;
  const rawText = await rawRow(admin, id);
  scaleCache = { admin, id, res, rawText, postMs };
  return scaleCache;
}

test("C1. THE C2 REGRESSION: a report whose LEGACY form exceeds the 2,000,000 limit (which the old code persisted as 'score, no interpretation') now persists the score WITH its complete explanation, and the real GET serves it", async () => {
  const { admin, id, res, rawText } = await scaleReport();
  assert.equal(res.status, 200, "the save succeeds");
  const raw = JSON.parse(rawText);

  // (1) the scenario really is a former-drop case: expanded (== the old enriched form) is over the limit
  const decoded = decodeReportFromPersistence(raw);
  const legacyEnrichedBytes = JSON.stringify(decoded).length;
  assert.ok(legacyEnrichedBytes > MAX_REPORT_SAVE_REQUEST_BYTES, `legacy enriched form (${legacyEnrichedBytes}) is over the limit — the old finalizeReportJson would have DROPPED the interpretation here`);
  // (2) ... and the persisted compact form is comfortably under it, with the SAME limit constant
  assert.equal(MAX_REPORT_SAVE_REQUEST_BYTES, 2_000_000, "the limit constant is unchanged");
  assert.ok(rawText.length < MAX_REPORT_SAVE_REQUEST_BYTES * 0.5, `compact persisted form (${rawText.length}) is far below the limit`);
  assert.equal(isCompactEvidenceInterpretation(raw.evidenceInterpretation), true);
  assert.equal(raw.unifiedSimilarity.contributions.format, "compact");

  // (3) score present AND interpretation present AND cards present AND highlights present, via the real GET (admin)
  const got = await get(admin, id);
  assert.equal(got.status, 200);
  const { payload } = got;
  assert.equal(payload.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length * UNITS, "SCORE_PRESENT: every credited word is in the score");
  assert.equal(payload.unifiedSimilarity.unifiedScore, 50, "7 of every 14 words are credited");
  assert.ok(payload.evidenceInterpretation, "INTERPRETATION_PRESENT");
  const cards = payload.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence");
  assert.equal(cards.length, UNITS, "CARDS_PRESENT: one card per imported unit, never grouped");
  assert.equal(payload.evidenceInterpretation.passages.length, 2 * UNITS, "every fragment is an explained passage");
  assert.ok(cards.every((c) => c.label === "Imported reference match" && c.passageRefs.length === 2 && c.matchedWords === MASK.length));
  assert.equal(payload.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length, "the explanation reconciles with the score");
  const view = buildReportV2ViewModel(payload);
  assert.ok(view && view.sources.length === UNITS && view.passages.length === 2 * UNITS, "HIGHLIGHTS_PRESENT: the report view is built with every card and passage");
  assertNoCompactLeak(got.text, "scale GET");

  // (4) exact positions: an independent oracle (no codec involved) for every passage range
  const expectedRanges = new Set(Array.from({ length: UNITS }, (_, i) => [`${i * WORDS_PER_UNIT}-${i * WORDS_PER_UNIT + 2}`, `${i * WORDS_PER_UNIT + 4}-${i * WORDS_PER_UNIT + 7}`]).flat());
  assert.deepEqual(new Set(payload.evidenceInterpretation.passages.map((p) => `${p.wordStart}-${p.wordEnd}`)), expectedRanges, "same matched positions, exactly");
  assert.ok(payload.evidenceInterpretation.passages.every((p) => p.sourceIds.length === 1 && p.excerpt.length > 0));
  // admin contributions: exact, from the same independent oracle
  const contribs = payload.unifiedSimilarity.contributions;
  assert.equal(contribs.length, 2 * UNITS);
  assert.deepEqual(new Set(contribs.map((c) => c.sourceId)), new Set(Array.from({ length: UNITS }, (_, i) => `imported-similarity-evidence:${unitId(i)}`)));
  assert.ok(contribs.every((c) => c.sourceType === "imported_similarity_evidence" && c.evidenceStatus === "included" && c.importedSourceAttributionState === "TURNITIN_SOURCE_MARKER_ONLY"));
});

test("C2. a NON-ADMIN owner of that same report gets the explanation and the score but NEVER the contributions, unit ids, provenance or package details", async () => {
  const { rawText } = await scaleReport();
  const owner = await account();
  const id = nextId("scale-owner");
  await seedRow(owner, id, rawText);
  const got = await get(owner, id);
  assert.equal(got.status, 200);
  assert.equal(got.payload.evidenceInterpretation.sources.length, UNITS);
  assert.deepEqual(got.payload.unifiedSimilarity.contributions, []);
  assert.equal(got.payload.unifiedSimilarity.unifiedScore, 50);
  for (const bad of [unitId(0), unitId(UNITS - 1), "imported-similarity-evidence:", "TURNITIN_SOURCE_MARKER_ONLY", "ES-TEST00000001", "a1b2c3d4e5f6a1b2c3d4e5f6", "scale-package", "reportSha256", "evidenceUnitId"]) {
    assert.equal(got.text.includes(bad), false, `customer response must not contain ${bad}`);
  }
  assertNoCompactLeak(got.text, "scale GET (non-admin)");
});

test("C3. the AUTHORITATIVE FINALIZER at the same scale: the final score lands atomically WITH its complete compact explanation (the old finalizer removed the interpretation here)", async () => {
  const { admin, id, rawText } = await scaleReport();
  // a pending clone of that report: exactly the state the deferred finalizer is handed
  const pendingId = nextId("scale-pending");
  const p = decodeReportFromPersistence(JSON.parse(rawText));
  for (const k of ["unifiedSimilarity", "unifiedSimilarityGeneration", "corpusSourceMatchingEnabledAtComputation", "unifiedSimilarityFailed", "evidenceInterpretation"]) delete p[k];
  p.selectiveCorpusAuthoritativeStatus = "pending";
  await seedRow(admin, pendingId, JSON.stringify(p));

  const result = await finalizeSelectiveCorpusAuthoritativeReport(db, {
    reportDeviceKey: admin.deviceKey, reportId: pendingId, accountId: admin.userId, shadowResult: { state: "COMPLETED" },
  });
  assert.deepEqual(result, { outcome: "finalized", status: "completed" });
  const rawAfter = await rawRow(admin, pendingId);
  const row = JSON.parse(rawAfter);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, "completed");
  assert.equal(isCompactEvidenceInterpretation(row.evidenceInterpretation), true, "the CAS write carried the COMPACT interpretation");
  assert.equal(row.unifiedSimilarity.contributions.format, "compact");
  const final = decodeReportFromPersistence(row);
  assert.ok(JSON.stringify(final).length > MAX_REPORT_SAVE_REQUEST_BYTES, "the expanded final report is over the limit (old finalizer: interpretation removed)");
  assert.ok(rawAfter.length < MAX_REPORT_SAVE_REQUEST_BYTES, "the compact final row fits");
  assert.equal(final.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length * UNITS);
  assert.equal(final.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence").length, UNITS);
  assert.equal(final.evidenceInterpretation.passages.length, 2 * UNITS);
  assert.equal(final.evidenceInterpretation.matchedWordCount, final.unifiedSimilarity.matchedPositions.length);
});

// ────────────────────────────────────────────────────────────────────────────
// D. FAIL CLOSED above the limit — score-without-explanation is impossible
// ────────────────────────────────────────────────────────────────────────────
test("D1. WRITE-TIME over the limit fails closed: a save whose plain report fits but whose explained report does not is REJECTED (413), never persisted as a score without its interpretation; a resave leaves the prior row byte-identical", async () => {
  configurePackage(null);
  const acc = await account();
  const text = makeText(300);
  const archive = range(0, 299).filter((p) => p % 3 !== 2);
  const opts = { text, archiveMatchedPositions: archive };

  // Calibrate on an unpadded save: how big is the persisted report with and without its explanation?
  const calId = nextId("d1-cal");
  assert.equal((await post(acc, calId, opts)).status, 200);
  const calRaw = await rawRow(acc, calId);
  const calObj = JSON.parse(calRaw);
  const { evidenceInterpretation, reportCompletion, extractionDiagnostic, ...plainObj } = calObj;
  const plainBytes = JSON.stringify(plainObj).length;      // what the OLD code fell back to
  const explainedBytes = calRaw.length;                    // what must be persisted now
  assert.ok(explainedBytes - plainBytes > 300, "the explanation is a real block of bytes");

  // Pad so that PLAIN just fits and EXPLAINED does not. Old code: 200 + unexplained score. New code: 413.
  const pad = MAX_REPORT_SAVE_REQUEST_BYTES - 25 - plainBytes;
  assert.ok(plainBytes + pad <= MAX_REPORT_SAVE_REQUEST_BYTES && explainedBytes + pad > MAX_REPORT_SAVE_REQUEST_BYTES, "arithmetic: plain fits, explained does not");
  const paddedBody = (id, room) => reportRequestBody(acc, id, { ...opts, padding: "x".repeat(pad), room });
  assert.ok(JSON.stringify(paddedBody("probe", 0).payload).length <= MAX_REPORT_SAVE_REQUEST_BYTES, "the CLIENT payload passes the request guard, so the persistence guard is what is exercised");

  const firstId = nextId("d1-first");
  const res = await postBody(acc, paddedBody(firstId, 1));
  assert.equal(res.status, 413, "over the limit -> the existing 413, not a 200 with an unexplained score");
  assert.deepEqual(await res.json(), { error: "Payload too large" });
  assert.equal(await rawRow(acc, firstId), null, "nothing was persisted: no score without its explanation");

  // resave of an existing, explained report: it is left exactly as it was
  const before = await rawRow(acc, calId);
  const resave = await postBody(acc, paddedBody(calId, 0));
  assert.equal(resave.status, 413);
  assert.equal(await rawRow(acc, calId), before, "the prior persisted report is byte-identical after the rejected resave");
  const stillThere = await get(acc, calId);
  assert.ok(stillThere.payload.evidenceInterpretation && stillThere.payload.unifiedSimilarity, "the prior report is still complete (score AND explanation)");
});

test("D2. AUTHORITATIVE FINALIZER over the limit fails closed: nothing is written (no new score, no removed explanation), the outcome is explicit, and the pending row is byte-identical", async () => {
  const acc = await account();
  const id = nextId("d2");
  const text = makeText(200);
  const p = { ...baseReport(text), archiveMatchedPositions: range(0, 79), selectiveCorpusAuthoritativeStatus: "pending" };
  const pendingReport = withEvidenceInterpretation({ ...p, unifiedSimilarity: undefined }, { selectiveCorpusBranch: null });
  pendingReport.testPadding = "";
  const baseLen = JSON.stringify(pendingReport).length;
  pendingReport.testPadding = "x".repeat(MAX_REPORT_SAVE_REQUEST_BYTES - 100 - baseLen);
  await seedRow(acc, id, JSON.stringify(pendingReport));
  const before = await rawRow(acc, id);

  const result = await finalizeSelectiveCorpusAuthoritativeReport(db, {
    reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId,
    shadowResult: { state: "COMPLETED", verifiedEvidence: [{ sourceLabel: "S1", matchedPassages: [{ submittedWordStart: 100, submittedWordEnd: 120, matchedWordCount: 21 }] }] },
  });
  assert.deepEqual(result, { outcome: "persistence-limit-exceeded" });
  assert.equal(await rawRow(acc, id), before, "byte-identical: the CAS was never attempted");
  const after = JSON.parse(await rawRow(acc, id));
  assert.equal(after.selectiveCorpusAuthoritativeStatus, "pending");
  assert.equal(after.unifiedSimilarity, undefined, "AUTHORITATIVE_SCORE_WITHOUT_EXPLANATION is impossible");
});

test("D3. the CAS-guarded persist keeps its guarantees with a COMPACT interpretation: exactly one winner, the loser can never overwrite it, and `null` (remove the explanation) is rejected", async () => {
  const acc = await account();
  const id = nextId("d3");
  const pending = { ...baseReport(makeText(100)), selectiveCorpusAuthoritativeStatus: "pending" };
  await seedRow(acc, id, JSON.stringify(pending));
  const winnerUnified = computeUnifiedSimilarity({ wordCount: 100, archiveMatchedPositions: range(0, 39) });
  const winnerReport = withEvidenceInterpretation({ ...baseReport(makeText(100)), archiveMatchedPositions: range(0, 39), unifiedSimilarity: winnerUnified }, { selectiveCorpusBranch: null });
  const winnerCompact = compactEvidenceInterpretationForPersistence(winnerReport.evidenceInterpretation);
  assert.equal(isCompactEvidenceInterpretation(winnerCompact), true);
  const resolution = (extra) => ({ unifiedSimilarity: winnerUnified, corpusSourceMatchingEnabled: true, corpusGeneration: 0, terminalStatus: "completed", ...extra });

  await assert.rejects(() => persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: acc.deviceKey, reportId: id }, resolution({ evidenceInterpretation: null })), /refusing to write a final score while removing its evidenceInterpretation/);
  assert.equal(JSON.parse(await rawRow(acc, id)).unifiedSimilarity, undefined, "the rejected null wrote nothing");

  const win = await persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: acc.deviceKey, reportId: id }, resolution({ evidenceInterpretation: winnerCompact }));
  assert.equal(win.written, true);
  const loser = await persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: acc.deviceKey, reportId: id }, resolution({ terminalStatus: "incomplete", evidenceInterpretation: { ...winnerCompact, matchedWordCount: 999 } }));
  assert.equal(loser.written, false, "CAS: the loser is a clean no-op");
  const finalRow = decodeReportFromPersistence(JSON.parse(await rawRow(acc, id)));
  assert.deepEqual(finalRow.evidenceInterpretation, jsonNormalised(winnerReport.evidenceInterpretation), "the winner's explanation is intact");
  assert.equal(finalRow.selectiveCorpusAuthoritativeStatus, "completed");
});

test("D4. STRUCTURAL: the silent 'drop the interpretation, keep the score' fallbacks are gone, and the write-time size checks measure the ENCODED report", () => {
  const routeSrc = fs.readFileSync("app/api/reports/route.ts", "utf8");
  assert.equal(/report saved without it/.test(routeSrc), false, "no 'saved without it' fallback in the write-time path");
  assert.equal(/enriched\.length\s*<=\s*MAX_BYTES/.test(routeSrc), false, "no silent size-based interpretation drop");
  assert.match(routeSrc, /JSON\.stringify\(encodeReportForPersistence\(enriched \?\? obj\)\)/, "the persisted JSON is always the encoded (compact) report");
  assert.match(routeSrc, /PERSISTED_PAYLOAD_TOO_LARGE/, "the existing 413 failure semantics are kept");
  const wiring = fs.readFileSync("lib/report-evidence-interpretation.ts", "utf8");
  assert.match(wiring, /FinalizedReportInterpretationResult/, "the finalizer helper returns an explicit result");
  assert.equal(/\):\s*NonNullable<SimilarityReport\["evidenceInterpretation"\]>\s*\|\s*null/.test(wiring), false, "the finalizer helper no longer returns null ('drop it')");
  const finalizer = fs.readFileSync("lib/selective-corpus-authoritative.ts", "utf8");
  assert.match(finalizer, /persistence-limit-exceeded/);
  assert.match(finalizer, /if \(!prepared\.ok\)/, "the finalizer checks the result BEFORE the CAS write");
  assert.equal(/evidenceInterpretation:\s*null/.test(finalizer), false, "the finalizer never asks the CAS write to remove the interpretation");
});
