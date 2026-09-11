import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  classifySourceCoverageCase,
  unionVerifiedWordCount,
  SourceCoverageInputError,
  SourceCoverageSpanValidationError,
} from "../tools/source-coverage-classifier/classify.ts";
import {
  ALL_FIXTURE_CASES,
  ACADEMIC_SEARCH_FIXTURE_CASES,
  SELECTIVE_CORPUS_FIXTURE_CASES,
  SUBMISSION_TEXT,
  buildEmptyFixtureArtifact,
} from "../tools/source-coverage-classifier/fixtures.ts";
import { assertWithinAllowedDrive } from "../tools/source-coverage-classifier/cli.ts";

// Test-only imports of the REAL frozen thresholds/config, to pin the
// classifier's behavior against production and to snapshot for the
// no-mutation structural tests. Never imported by the classifier's own
// runtime logic for this literal purpose (academic-search-lane.ts DOES
// import DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG itself now — see the B2 tests
// below for why that is the fix, not the defect).
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../lib/academic-search/orchestrator.ts";
import { DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";
import { SELECTIVE_CORPUS_STRICT_SPAN, SELECTIVE_CORPUS_FAMILY_GUARD } from "../lib/selective-corpus/constants.ts";
import { tokens } from "../lib/similarity-core.ts";

const CLASSIFIER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "source-coverage-classifier");
const MANUSCRIPT_WORD_COUNT = tokens(SUBMISSION_TEXT).length;

function byId(cases, caseId) {
  const found = cases.find((c) => c.caseId === caseId);
  assert.ok(found, `fixture case "${caseId}" not found`);
  return found;
}
function classifyAs(caseId) {
  const fixture = byId(ACADEMIC_SEARCH_FIXTURE_CASES, caseId);
  return classifySourceCoverageCase({ lane: "ACADEMIC_SEARCH", ...fixture });
}
function classifySc(caseId) {
  const fixture = byId(SELECTIVE_CORPUS_FIXTURE_CASES, caseId);
  return classifySourceCoverageCase({ lane: "SELECTIVE_CORPUS", ...fixture });
}
function classifierSourceFiles() {
  return readdirSync(CLASSIFIER_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, content: readFileSync(join(CLASSIFIER_DIR, name), "utf8") }));
}

// =====================================================================
// 1-8: one required outcome per case (updated fixture ids where the
// repair changed the discovery/retrieval shape)
// =====================================================================

test("1. explicit known source absent (academic-search) => SOURCE_ABSENT", () => {
  const r = classifyAs("as-01-source-absent");
  assert.equal(r.outcome, "SOURCE_ABSENT");
  assert.equal(r.failureStage, "ground-truth");
  assert.equal(r.verifiedMatchedWordCount, 0);
});
test("1b. explicit known source absent (selective-corpus) => SOURCE_ABSENT", () => {
  const r = classifySc("sc-01-source-absent");
  assert.equal(r.outcome, "SOURCE_ABSENT");
  assert.equal(r.failureStage, "ground-truth");
  assert.equal(r.verifiedMatchedWordCount, 0);
});

test("2. expected source not discovered at all => CANDIDATE_MISSED (reasonCode CANDIDATE_NOT_DISCOVERED)", () => {
  const r = classifyAs("as-02-candidate-missed");
  assert.equal(r.outcome, "CANDIDATE_MISSED");
  assert.equal(r.failureStage, "discovery");
  assert.equal(r.reasonCode, "CANDIDATE_NOT_DISCOVERED");
});
test("2b. present in artifact but Stage A does not surface it => CANDIDATE_MISSED", () => {
  const r = classifySc("sc-02-candidate-missed");
  assert.equal(r.outcome, "CANDIDATE_MISSED");
  assert.equal(r.failureStage, "discovery");
});

test("3. candidate discovered but text unavailable (network cause) => RETRIEVAL_FAILED", () => {
  const r = classifyAs("as-03-retrieval-failed");
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
  assert.equal(r.retrievalSource, "unavailable");
  assert.equal(r.reasonCode, "NETWORK_ERROR");
});
test("3b. candidate discovered but text unavailable => RETRIEVAL_FAILED (selective-corpus)", () => {
  const r = classifySc("sc-03-retrieval-failed");
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
});

test("4. real production extraction-failure signal (httpRetrievalStatus EXTRACTION_FAILED) => EXTRACTION_FAILED, not RETRIEVAL_FAILED", () => {
  const r = classifyAs("as-04-extraction-failed");
  assert.equal(r.outcome, "EXTRACTION_FAILED");
  assert.equal(r.failureStage, "extraction");
  assert.equal(r.retrievalSource, "unavailable"); // production nests this INSIDE "unavailable" — confirmed still surfaced as EXTRACTION_FAILED at the outcome level
  assert.equal(r.verifiedMatchedWordCount, 0);
});

test("5. retrieved usable source but insufficient verified correspondence (academic-search) => MATCHER_FAILED", () => {
  const r = classifyAs("as-05-matcher-failed");
  assert.equal(r.outcome, "MATCHER_FAILED");
  assert.equal(r.matcherDiagnostics.ran, true);
  assert.equal(r.verifiedMatchedWordCount, 0);
});
test("5b. source text retrieved but strict-span verification fails (selective-corpus) => MATCHER_FAILED", () => {
  const r = classifySc("sc-05-matcher-failed");
  assert.equal(r.outcome, "MATCHER_FAILED");
  assert.equal(r.admissionDiagnostics.strictSpanPass, false);
  assert.equal(r.verifiedMatchedWordCount, 0);
});

test("6. correspondence passes matcher but FAMILY_GUARD blocks authority (stopFraction path) => ADMISSION_OR_ATTRIBUTION_FAILED", () => {
  const r = classifySc("sc-06-admission-attribution-failed-stopfraction-path");
  assert.equal(r.outcome, "ADMISSION_OR_ATTRIBUTION_FAILED");
  assert.equal(r.admissionDiagnostics.strictSpanPass, true);
  assert.equal(r.admissionDiagnostics.familyGuardActivated, true);
  assert.equal(r.admissionDiagnostics.dominantSpanBoilerplate, true);
  assert.equal(r.admissionDiagnostics.admitted, false);
  assert.equal(r.verifiedMatchedWordCount, 0);
});

test("7. academic source successfully verified => VERIFIED_RECOVERED", () => {
  const r = classifyAs("as-06-verified-recovered");
  assert.equal(r.outcome, "VERIFIED_RECOVERED");
  assert.ok(r.verifiedMatchedWordCount > 0);
});
test("8. selective-corpus source successfully verified => VERIFIED_RECOVERED", () => {
  const r = classifySc("sc-08-verified-recovered");
  assert.equal(r.outcome, "VERIFIED_RECOVERED");
  assert.equal(r.admissionDiagnostics.admitted, true);
  assert.ok(r.verifiedMatchedWordCount > 0);
});

test("9. no candidate without explicit absence proof MUST NOT become SOURCE_ABSENT (academic-search)", () => {
  const r = classifyAs("as-09-no-candidate-not-absent");
  assert.notEqual(r.outcome, "SOURCE_ABSENT");
  assert.equal(r.outcome, "CANDIDATE_MISSED");
});
test("9b. no candidate without explicit absence proof MUST NOT become SOURCE_ABSENT (selective-corpus)", () => {
  const r = classifySc("sc-09-no-candidate-not-absent");
  assert.notEqual(r.outcome, "SOURCE_ABSENT");
  assert.equal(r.outcome, "CANDIDATE_MISSED");
});
test("9c. SOURCE_ABSENT is unreachable without a groundTruthAbsent field, across every non-absent fixture", () => {
  for (const c of ALL_FIXTURE_CASES) {
    if (c.groundTruthAbsent) continue;
    const r = classifySourceCoverageCase(c);
    assert.notEqual(r.outcome, "SOURCE_ABSENT", `case "${c.caseId}" produced SOURCE_ABSENT without ground truth`);
  }
});

// =====================================================================
// 10-11: verifiedMatchedWordCount exactness (post span-validation repair)
// =====================================================================

test("10. verifiedMatchedWordCount exactly reconciles matcher positions for a recovered academic-search fixture", () => {
  const r = classifyAs("as-06-verified-recovered");
  const spans = r.diagnostics.comparison.matchedPassages.map((p) => ({ start: p.submittedWordStart, end: p.submittedWordEnd }));
  const expected = unionVerifiedWordCount(spans, MANUSCRIPT_WORD_COUNT);
  assert.equal(r.verifiedMatchedWordCount, expected);
  assert.ok(expected > 0);
  assert.equal(r.matcherDiagnostics.rawMatchedWordCount, r.verifiedMatchedWordCount);
});
test("10b. verifiedMatchedWordCount exactly reconciles admitted spans for a recovered selective-corpus fixture", () => {
  const r = classifySc("sc-08-verified-recovered");
  const admittedSpans = r.diagnostics.admission.spans;
  const expected = unionVerifiedWordCount(admittedSpans.map((s) => ({ start: s.start, end: s.end })), MANUSCRIPT_WORD_COUNT);
  assert.equal(r.verifiedMatchedWordCount, expected);
});

test("11. duplicate, overlapping, nested, and adjacent spans are unioned exactly once per word", () => {
  const n = 100;
  assert.equal(unionVerifiedWordCount([{ start: 5, end: 10 }, { start: 5, end: 10 }], n), 6); // duplicate
  assert.equal(unionVerifiedWordCount([{ start: 0, end: 10 }, { start: 5, end: 15 }], n), 16); // overlapping, 0..15
  assert.equal(unionVerifiedWordCount([{ start: 0, end: 20 }, { start: 5, end: 10 }], n), 21); // nested, 0..20
  assert.equal(unionVerifiedWordCount([{ start: 0, end: 9 }, { start: 10, end: 19 }], n), 20); // adjacent, 0..19
  assert.equal(unionVerifiedWordCount([{ start: 20, end: 25 }, { start: 0, end: 5 }], n), 12); // disjoint, simply sums
  assert.equal(unionVerifiedWordCount([], n), 0); // no spans, real zero
  assert.equal(unionVerifiedWordCount(null, n), null); // no position data at all -> null, never fabricated
  assert.equal(unionVerifiedWordCount(undefined, n), null);
});

test("11b. malformed spans fail closed instead of being silently repaired", () => {
  const n = 100;
  assert.throws(() => unionVerifiedWordCount([{ start: 10, end: 5 }], n), SourceCoverageSpanValidationError); // reversed -> reject, never swapped
  assert.throws(() => unionVerifiedWordCount([{ start: -1, end: 5 }], n), SourceCoverageSpanValidationError); // negative start -> reject
  assert.throws(() => unionVerifiedWordCount([{ start: 0, end: 100 }], n), SourceCoverageSpanValidationError); // end === n -> out of range (valid max index is n-1)
  assert.throws(() => unionVerifiedWordCount([{ start: 0, end: 500 }], n), SourceCoverageSpanValidationError); // far out of range -> reject, never clamped
  assert.throws(() => unionVerifiedWordCount([{ start: 0.5, end: 5 }], n), SourceCoverageSpanValidationError); // non-integer start -> reject
  assert.throws(() => unionVerifiedWordCount([{ start: 0, end: 5.5 }], n), SourceCoverageSpanValidationError); // non-integer end -> reject
});
test("11c. malformed manuscriptWordCount fails closed", () => {
  assert.throws(() => unionVerifiedWordCount([], -1), SourceCoverageSpanValidationError);
  assert.throws(() => unionVerifiedWordCount([], 1.5), SourceCoverageSpanValidationError);
  assert.doesNotThrow(() => unionVerifiedWordCount(null, 0)); // 0 is a valid manuscript word count
});
test("11d. a span exactly at the last valid index (end === manuscriptWordCount - 1) is accepted", () => {
  assert.equal(unionVerifiedWordCount([{ start: 89, end: 89 }], 90), 1);
});

// =====================================================================
// 12-13: lane isolation
// =====================================================================

test("12. an academic-search fixture is never evaluated with Selective Corpus's 60/25 policy", () => {
  const r = classifyAs("as-12-lane-isolation-40-words");
  assert.equal(r.outcome, "VERIFIED_RECOVERED");
  assert.ok(r.matcherDiagnostics.similarity >= DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity);
  assert.ok(r.verifiedMatchedWordCount < SELECTIVE_CORPUS_STRICT_SPAN.minMatchedWords, "sanity: below the Selective Corpus STRICT_SPAN word floor");
});
test("13. a Selective Corpus fixture is not misclassified using academic-search-only semantics", () => {
  const r = classifySc("sc-13-lane-isolation-40-words");
  assert.equal(r.outcome, "MATCHER_FAILED");
  assert.equal(r.admissionDiagnostics.strictSpanPass, false);
});

// =====================================================================
// Repair item 1 (B1): real academic extraction-failure semantics
// =====================================================================

test("B1a. httpRetrievalStatus EXTRACTION_FAILED classifies as EXTRACTION_FAILED, not RETRIEVAL_FAILED", () => {
  const r = classifyAs("as-04-extraction-failed");
  assert.equal(r.outcome, "EXTRACTION_FAILED");
});
test("B1b. HTTP_ERROR (a non-extraction unavailable status) classifies as RETRIEVAL_FAILED", () => {
  const r = classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "b1b-http-error", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "unavailable", httpRetrievalStatus: "HTTP_ERROR" },
  });
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
  assert.equal(r.reasonCode, "HTTP_ERROR");
});
test("B1c. TIMEOUT classifies as RETRIEVAL_FAILED", () => {
  const r = classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "b1c-timeout", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "unavailable", httpRetrievalStatus: "TIMEOUT" },
  });
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
});
test("B1d. NETWORK_ERROR classifies as RETRIEVAL_FAILED", () => {
  const r = classifyAs("as-03-retrieval-failed");
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
});
test("B1e. NO_CONTENT classifies as RETRIEVAL_FAILED", () => {
  const r = classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "b1e-no-content", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "unavailable", httpRetrievalStatus: "NO_CONTENT" },
  });
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
});
test("B1f. unavailable with no httpRetrievalStatus at all (no candidate URL) still classifies as RETRIEVAL_FAILED", () => {
  const r = classifyAs("as-03b-retrieval-failed-no-http-status");
  assert.equal(r.outcome, "RETRIEVAL_FAILED");
  assert.equal(r.reasonCode, "TEXT_RETRIEVAL_UNAVAILABLE");
});

// =====================================================================
// Repair item 2 (B2): canonical threshold, not a duplicated literal
// =====================================================================

test("B2a. academic-search-lane.ts imports the canonical config and never assigns the threshold to a local numeric literal", () => {
  const source = readFileSync(join(CLASSIFIER_DIR, "academic-search-lane.ts"), "utf8");
  assert.match(source, /import\s*\{\s*DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/academic-search\/orchestrator["']/);
  assert.doesNotMatch(source, /minEvidenceSimilarity\s*[:=]\s*\d/, "must not assign the threshold to a locally-duplicated numeric literal");
  assert.doesNotMatch(source, /ACADEMIC_SEARCH_MIN_EVIDENCE_SIMILARITY/, "the old duplicated constant must be fully removed");
});
test("B2b. the classification boundary tracks the real, live DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity value", () => {
  assert.equal(DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity, 15); // pins the assumption the rest of this suite relies on
  const r = classifyAs("as-06-verified-recovered");
  assert.ok(r.matcherDiagnostics.similarity >= DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.minEvidenceSimilarity);
  assert.equal(r.outcome, "VERIFIED_RECOVERED");
});
test("B2c. importing the canonical academic-search config triggers no network call, at import or classification time", () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => { called = true; throw new Error("network call attempted"); };
  try {
    for (const c of ACADEMIC_SEARCH_FIXTURE_CASES) classifyAs(c.caseId);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(called, false);
});

// =====================================================================
// Repair item 3: ranked-outside-retrieval-budget representation
// =====================================================================

test("3-budget. expected candidate not discovered at all => CANDIDATE_MISSED / CANDIDATE_NOT_DISCOVERED", () => {
  const r = classifyAs("as-02-candidate-missed");
  assert.equal(r.outcome, "CANDIDATE_MISSED");
  assert.equal(r.reasonCode, "CANDIDATE_NOT_DISCOVERED");
  assert.equal(r.candidateRank, null);
});
test("3-budget2. expected candidate discovered and ranked but outside maxCandidatesToRetrieve => CANDIDATE_MISSED / RANKED_OUTSIDE_RETRIEVAL_BUDGET, distinct reasonCode and a real candidateRank", () => {
  const r = classifyAs("as-02b-ranked-outside-retrieval-budget");
  assert.equal(r.outcome, "CANDIDATE_MISSED");
  assert.equal(r.reasonCode, "RANKED_OUTSIDE_RETRIEVAL_BUDGET");
  assert.equal(r.candidateRank, 7);
  assert.notEqual(r.reasonCode, "CANDIDATE_NOT_DISCOVERED", "the two real causes must never share a reason code");
});

// =====================================================================
// Repair item 5: contradictory diagnostic states fail closed
// =====================================================================

test("5-contra. academic-search: groundTruthAbsent + discovered is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "bad-as-1", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    groundTruthAbsent: { reasonCode: "X", detail: "X" },
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "provider" }, retrievedExternalText: "foo bar baz",
  }), SourceCoverageInputError);
});
test("5-contra2. academic-search: SELECTED_FOR_RETRIEVAL without a retrieval outcome is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "bad-as-2", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
  }), SourceCoverageInputError);
});
test("5-contra3. academic-search: retrieval unavailable + retrievedExternalText also supplied is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "bad-as-3", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "unavailable" }, retrievedExternalText: "foo bar baz",
  }), SourceCoverageInputError);
});
test("5-contra4. academic-search: retrieval succeeded but no retrievedExternalText is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "bad-as-4", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "provider" },
  }), SourceCoverageInputError);
});
test("5-contra5. academic-search: retrieval supplied for a not-discovered candidate is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "ACADEMIC_SEARCH", caseId: "bad-as-5", expectedSourceId: "x", submittedText: SUBMISSION_TEXT,
    discovery: { status: "NOT_DISCOVERED" },
    retrieval: { source: "unavailable" },
  }), SourceCoverageInputError);
});
test("5-contra6. selective-corpus: groundTruthAbsent + surfaced is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "SELECTIVE_CORPUS", caseId: "bad-sc-1", expectedSourceId: "x", submissionText: SUBMISSION_TEXT,
    groundTruthAbsent: { reasonCode: "X", detail: "X" },
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: "foo bar baz" },
    artifact: buildEmptyFixtureArtifact(),
  }), SourceCoverageInputError);
});
test("5-contra7. selective-corpus: surfaced without a sourceText outcome is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "SELECTIVE_CORPUS", caseId: "bad-sc-2", expectedSourceId: "x", submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
  }), SourceCoverageInputError);
});
test("5-contra8. selective-corpus: sourceText.available true but no text supplied is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "SELECTIVE_CORPUS", caseId: "bad-sc-3", expectedSourceId: "x", submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true },
  }), SourceCoverageInputError);
});
test("5-contra9. selective-corpus: sourceText.available true but no artifact supplied is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "SELECTIVE_CORPUS", caseId: "bad-sc-4", expectedSourceId: "x", submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: "foo bar baz" },
  }), SourceCoverageInputError);
});
test("5-contra10. selective-corpus: sourceText/artifact supplied for a not-surfaced candidate is rejected", () => {
  assert.throws(() => classifySourceCoverageCase({
    lane: "SELECTIVE_CORPUS", caseId: "bad-sc-5", expectedSourceId: "x", submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: false, candidateRank: null },
    sourceText: { available: false },
  }), SourceCoverageInputError);
});
test("5-contra11. SOURCE_ABSENT is unaffected by the new validation layer — still requires explicit ground truth only", () => {
  const r = classifyAs("as-01-source-absent");
  assert.equal(r.outcome, "SOURCE_ABSENT");
});

// =====================================================================
// Repair item 6: both real FAMILY_GUARD paths
// =====================================================================

test("6a. FAMILY_GUARD stopFraction path => ADMISSION_OR_ATTRIBUTION_FAILED after strict-span passes", () => {
  const r = classifySc("sc-06-admission-attribution-failed-stopfraction-path");
  assert.equal(r.outcome, "ADMISSION_OR_ATTRIBUTION_FAILED");
  assert.equal(r.admissionDiagnostics.strictSpanPass, true);
  assert.equal(r.admissionDiagnostics.familyGuardActivated, true);
});
test("6b. FAMILY_GUARD postings (distinctDocs>=3) path => ADMISSION_OR_ATTRIBUTION_FAILED after strict-span passes, using only local in-memory postings", () => {
  const r = classifySc("sc-06b-admission-attribution-failed-postings-path");
  assert.equal(r.outcome, "ADMISSION_OR_ATTRIBUTION_FAILED");
  assert.equal(r.admissionDiagnostics.strictSpanPass, true);
  assert.equal(r.admissionDiagnostics.familyGuardActivated, true);
  assert.equal(r.admissionDiagnostics.dominantSpanBoilerplate, true);
});
test("6c. the two FAMILY_GUARD fixtures exercise genuinely different artifact mechanisms (stopHashes vs postings)", () => {
  const stopFractionFixture = byId(SELECTIVE_CORPUS_FIXTURE_CASES, "sc-06-admission-attribution-failed-stopfraction-path");
  const postingsFixture = byId(SELECTIVE_CORPUS_FIXTURE_CASES, "sc-06b-admission-attribution-failed-postings-path");
  assert.ok(stopFractionFixture.artifact.stopHashes.size > 0);
  assert.equal(postingsFixture.artifact.stopHashes.size, 0, "the postings-path fixture must NOT rely on stopHashes");
});

// =====================================================================
// Repair item 7: remaining missing negative tests
// =====================================================================

test("7a. selective-corpus matcherDiagnostics.similarity is honestly null — the real admission result does not expose it", () => {
  const r = classifySc("sc-08-verified-recovered");
  assert.equal(r.matcherDiagnostics.similarity, null);
  assert.equal(r.matcherDiagnostics.strongMatch, null);
  assert.equal(r.matcherDiagnostics.exactMatch, null);
});
test("7b. ADMISSION_OR_ATTRIBUTION_FAILED is structurally absent from academic-search-lane.ts's own source", () => {
  const source = readFileSync(join(CLASSIFIER_DIR, "academic-search-lane.ts"), "utf8");
  assert.doesNotMatch(source, /ADMISSION_OR_ATTRIBUTION_FAILED/);
});
test("7c. no academic-search fixture ever produces ADMISSION_OR_ATTRIBUTION_FAILED (behavioral confirmation)", () => {
  for (const c of ACADEMIC_SEARCH_FIXTURE_CASES) {
    const r = classifySourceCoverageCase({ lane: "ACADEMIC_SEARCH", ...c });
    assert.notEqual(r.outcome, "ADMISSION_OR_ATTRIBUTION_FAILED");
  }
});

// =====================================================================
// Structural safety
// =====================================================================

test("structural: classifier performs no network calls across every fixture case", () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => { called = true; throw new Error("network call attempted"); };
  try {
    for (const c of ALL_FIXTURE_CASES) classifySourceCoverageCase(c);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(called, false);
});

test("structural: no source file imports a DB/Turso/Drizzle client", () => {
  const forbidden = [/\bdrizzle\b/i, /\blibsql\b/i, /getReportsDbClient/, /\bturso\b/i, /createClient\s*\(/];
  for (const file of classifierSourceFiles()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(file.content, pattern, `${file.name} appears to reference a DB client (${pattern})`);
    }
  }
});

test("structural: no source file imports from app/", () => {
  for (const file of classifierSourceFiles()) {
    assert.doesNotMatch(file.content, /from\s+["'][^"']*\/app\//, `${file.name} imports from app/`);
  }
});

test("structural: no source file imports the dead discovery/provenance/E7 pipeline or the dead retrieval persistence layer", () => {
  const forbidden = [
    /from\s+["'][^"']*\/lib\/discovery-/,
    /from\s+["'][^"']*\/lib\/retrieval-repository/,
    /from\s+["'][^"']*\/lib\/retrieval-correspondence-bridge/,
    /from\s+["'][^"']*\/lib\/provenance-/,
    /from\s+["'][^"']*source-discovery-workflow/,
    /from\s+["'][^"']*\/lib\/e7-/,
  ];
  for (const file of classifierSourceFiles()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(file.content, pattern, `${file.name} imports the dead subsystem (${pattern})`);
    }
  }
});

test("structural: the only lib/retrieval-*.ts dependency anywhere in the classifier is the shared, already-live lib/retrieval-types.ts vocabulary", () => {
  for (const file of classifierSourceFiles()) {
    const matches = file.content.match(/from\s+["'][^"']*\/lib\/retrieval-[a-zA-Z-]+["']/g) ?? [];
    for (const m of matches) {
      assert.match(m, /\/lib\/retrieval-types["']$/, `${file.name}: unexpected lib/retrieval-* import "${m}" — only lib/retrieval-types.ts (type-only) is allowed`);
    }
  }
});

test("structural: no source file imports raw network transport modules or third-party discovery providers", () => {
  const forbidden = [
    /from\s+["']node:http["']/, /from\s+["']node:https["']/, /from\s+["']node:net["']/, /from\s+["']node:tls["']/,
    /from\s+["']undici["']/, /require\(\s*["']undici["']\s*\)/,
    /providers\/openaire/i, /providers\/europe-pmc/i, /providers\/core["']/i,
    /createOpenAireAcademicSearchProvider|createEuropePmcAcademicSearchProvider/,
    /crossref/i, /\basjp\b/i,
  ];
  for (const file of classifierSourceFiles()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(file.content, pattern, `${file.name} references a network transport module or third-party provider (${pattern})`);
    }
  }
});

test("structural: no source file references DEV80, SEALED20, the current benchmark corpus, or the future ~600 batch", () => {
  const forbidden = [/dev80/i, /sealed20/i, /new100/i, /corps above 321/i, /corpus\/similarity\//i];
  for (const file of classifierSourceFiles()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(file.content, pattern, `${file.name} references a forbidden dataset (${pattern})`);
    }
  }
});

test("structural: no source file writes or references a C: path", () => {
  for (const file of classifierSourceFiles()) {
    assert.doesNotMatch(file.content, /C:[\\/]/, `${file.name} references a C: path`);
  }
});

test("structural: classifier does not mutate the frozen matcher/admission constants", () => {
  const before = {
    correspondence: JSON.stringify(DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS),
    strictSpan: JSON.stringify(SELECTIVE_CORPUS_STRICT_SPAN),
    familyGuard: JSON.stringify(SELECTIVE_CORPUS_FAMILY_GUARD),
    academicSearchConfig: JSON.stringify(DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG),
  };
  for (const c of ALL_FIXTURE_CASES) classifySourceCoverageCase(c);
  assert.equal(JSON.stringify(DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS), before.correspondence);
  assert.equal(JSON.stringify(SELECTIVE_CORPUS_STRICT_SPAN), before.strictSpan);
  assert.equal(JSON.stringify(SELECTIVE_CORPUS_FAMILY_GUARD), before.familyGuard);
  assert.equal(JSON.stringify(DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG), before.academicSearchConfig);
});

test("structural: refuses to write outside D:", () => {
  assert.throws(() => assertWithinAllowedDrive("C:\\Users\\someone\\AppData\\Local\\Temp\\out.json"));
  assert.doesNotThrow(() => assertWithinAllowedDrive("D:\\TurnitPlusTemp\\source-coverage-classifier\\out.json"));
});

test("structural: every fixture case is fully deterministic (identical classification across repeated runs)", () => {
  const first = ALL_FIXTURE_CASES.map((c) => JSON.stringify(classifySourceCoverageCase(c)));
  const second = ALL_FIXTURE_CASES.map((c) => JSON.stringify(classifySourceCoverageCase(c)));
  assert.deepEqual(first, second);
});
