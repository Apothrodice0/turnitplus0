import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import {
  computeCorpusDuplicateCounterfactual,
  CorpusDuplicateCounterfactualInvariantError,
  CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION,
} from "../lib/corpus-duplicate-counterfactual.ts";

/**
 * Phase B1 — tests for the PURE shadow counterfactual core, plus the
 * load-bearing proof that the authoritative computeUnifiedSimilarity result
 * SHAPE and VALUES are unchanged when the hypothetical exclusion set is
 * absent / empty / undefined, and that neither the counterfactual helper nor
 * the hypothetical call mutates its inputs.
 *
 * No DB, no env, no HTTP.
 */

// The exact top-level key set an authoritative UnifiedSimilarityResult carries.
// If Phase B1 ever adds a shadow-only property here, this test fails — which is
// the point (the task forbids it).
const AUTHORITATIVE_RESULT_KEYS = [
  "archiveOnlyWords",
  "contributions",
  "deviceSelfExcludedWords",
  "liveAcademicOnlyWords",
  "matchedPositions",
  "overlapWords",
  "previousUploadOnlyWords",
  "previousUploadPositions",
  "selfExcludedWords",
  "unifiedScore",
  "uniqueMatchedWords",
  "unknownExcludedWords",
  "version",
  "wordCount",
].sort();

function academicEvidence(overrides = {}) {
  return {
    provider: "openaire",
    providerId: "ext-1",
    title: "Some External Paper",
    authors: null,
    publication: null,
    year: null,
    doi: "10.1/example",
    url: "https://example.test/paper",
    matchedPassages: [],
    similarity: 90,
    ...overrides,
  };
}

function passage(start, end) {
  return { submittedText: "", submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 };
}

function match(overrides = {}) {
  return {
    relationshipType: "TURNITPLUS_CORPUS_SOURCE",
    matchedRepresentationId: "R1",
    matchType: "EXACT_CANONICAL_MATCH",
    containment: 1,
    matchedWordCount: 0,
    passageCount: 0,
    longestMatchWords: 0,
    passages: [],
    historicalSubmissionCount: 0,
    ...overrides,
  };
}

function matched(matches) {
  return {
    status: "MATCHED",
    matches,
    computedAt: new Date().toISOString(),
    matcherVersion: "v",
    fingerprintVersion: "v",
    canonicalizationVersion: "v",
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// --- Scenario A: task's core positional example -----------------------------

test("Scenario A: internal exact-canonical dup 0-99, archive 20-29, scholarly 70-79 → authoritative 100, hypothetical 20, delta 80", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    archiveMatchedPositions: Array.from({ length: 10 }, (_, i) => 20 + i), // 20..29
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(70, 79)] })],
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const authoritative = computeUnifiedSimilarity(inputs);
  assert.equal(authoritative.unifiedScore, 100, "setup sanity: whole doc covered authoritatively");

  const cf = computeCorpusDuplicateCounterfactual({
    ...inputs,
    authoritativeUnifiedSimilarity: authoritative,
    qualifyingRepresentationIds: ["R1"],
  });

  assert.equal(cf.version, CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION);
  assert.equal(cf.authoritativeScore, 100);
  assert.equal(cf.hypotheticalScore, 20);
  assert.equal(cf.scoreDelta, 80);
  assert.equal(cf.candidateMatchedWords, 100);
  assert.equal(cf.candidatesExcluded, 1);
  assert.equal(cf.uniqueMatchedWordsRemoved, 80);
  assert.equal(cf.archiveOnlyWordsSurviving, 10);
  assert.equal(cf.liveAcademicOnlyWordsSurviving, 10);
  assert.equal(cf.previousUploadOnlyWordsSurviving, 0);
  assert.equal(cf.overlapWordsSurviving, 0);
  // the surviving breakdown reconciles exactly to the hypothetical unique count
  assert.equal(
    cf.archiveOnlyWordsSurviving + cf.liveAcademicOnlyWordsSurviving + cf.previousUploadOnlyWordsSurviving + cf.overlapWordsSurviving,
    cf.hypotheticalUniqueMatchedWords,
  );
});

// --- Scenario B: overlapping external evidence unions once ------------------

test("Scenario B: archive 10-39, scholarly 30-49 → hypothetical union is 40 unique words, not 50", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    archiveMatchedPositions: Array.from({ length: 30 }, (_, i) => 10 + i), // 10..39
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(30, 49)] })], // 30..49
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchedWordCount: 100, passages: [] })]),
  };
  const authoritative = computeUnifiedSimilarity(inputs);
  const cf = computeCorpusDuplicateCounterfactual({
    ...inputs,
    authoritativeUnifiedSimilarity: authoritative,
    qualifyingRepresentationIds: new Set(["R1"]),
  });
  assert.equal(cf.hypotheticalUniqueMatchedWords, 40, "10..49 unique, NOT 30+20");
  assert.equal(cf.hypotheticalScore, 40);
  assert.equal(cf.archiveOnlyWordsSurviving, 20); // 10..29
  assert.equal(cf.liveAcademicOnlyWordsSurviving, 10); // 40..49
  assert.equal(cf.previousUploadOnlyWordsSurviving, 0);
  assert.equal(cf.overlapWordsSurviving, 10); // 30..39
  assert.equal(
    cf.archiveOnlyWordsSurviving + cf.liveAcademicOnlyWordsSurviving + cf.previousUploadOnlyWordsSurviving + cf.overlapWordsSurviving,
    40,
  );
});

// --- Scenario C: a different, non-candidate corpus representation survives --

test("Scenario C: excluded exact dup R1 (0-99), non-candidate corpus rep R2 covers 40-59 → R2 survives, hypothetical = 20%", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    historicalSubmissionMatch: matched([
      match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] }),
      match({ matchedRepresentationId: "R2", matchType: "STRONG_TEXT_MATCH", matchedWordCount: 20, passages: [passage(40, 59)] }),
    ]),
  };
  const authoritative = computeUnifiedSimilarity(inputs);
  assert.equal(authoritative.unifiedScore, 100, "setup sanity");

  const cf = computeCorpusDuplicateCounterfactual({
    ...inputs,
    authoritativeUnifiedSimilarity: authoritative,
    qualifyingRepresentationIds: ["R1"], // R2 is a STRONG_TEXT_MATCH — never a Phase-B candidate
  });
  assert.equal(cf.hypotheticalScore, 20, "R2's 40-59 survives the exclusion of R1");
  assert.equal(cf.previousUploadOnlyWordsSurviving, 20);
  assert.equal(cf.candidatesExcluded, 1);
  assert.equal(cf.candidateMatchedWords, 100);
  assert.equal(cf.uniqueMatchedWordsRemoved, 80);
  assert.equal(
    cf.archiveOnlyWordsSurviving + cf.liveAcademicOnlyWordsSurviving + cf.previousUploadOnlyWordsSurviving + cf.overlapWordsSurviving,
    cf.hypotheticalUniqueMatchedWords,
  );
});

// --- Word-count semantics (#7): candidateMatchedWords vs removed -----------

test("#7: a 100-word candidate with 20 independently-covered words → candidateMatchedWords 100, removed 80 (never 'report 100 removed')", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    archiveMatchedPositions: Array.from({ length: 20 }, (_, i) => i), // 0..19 — independently covered
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const authoritative = computeUnifiedSimilarity(inputs);
  const cf = computeCorpusDuplicateCounterfactual({
    ...inputs,
    authoritativeUnifiedSimilarity: authoritative,
    qualifyingRepresentationIds: ["R1"],
  });
  assert.equal(cf.candidateMatchedWords, 100);
  assert.equal(cf.hypotheticalUniqueMatchedWords, 20);
  assert.equal(cf.uniqueMatchedWordsRemoved, 80);
  assert.equal(cf.archiveOnlyWordsSurviving, 20);
});

// --- Reuse, never recompute, the authoritative result ---------------------

test("the helper NEVER recomputes the authoritative result — it echoes the supplied value verbatim", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const real = computeUnifiedSimilarity(inputs);
  // Deliberately inflate the supplied authoritative result UPWARD — a helper
  // that recomputes would ignore this; a helper that reuses must echo it. (An
  // upward corruption keeps the monotonicity invariant satisfied — a downward
  // one is covered by the invariant tests below.)
  const sentinel = { ...real, unifiedScore: 999, uniqueMatchedWords: 4242 };
  const cf = computeCorpusDuplicateCounterfactual({
    ...inputs,
    authoritativeUnifiedSimilarity: sentinel,
    qualifyingRepresentationIds: ["R1"],
  });
  assert.equal(cf.authoritativeScore, 999);
  assert.equal(cf.authoritativeUniqueMatchedWords, 4242);
  // direct subtraction, no clamp: 999 - 0 (the real hypothetical) = 999
  assert.equal(cf.scoreDelta, 999);
  assert.equal(cf.uniqueMatchedWordsRemoved, 4242);
});

// --- Monotonicity invariant: an impossible counterfactual is REJECTED -----
// Excluding representations can only shrink the scored union, so a hypothetical
// result larger than the authoritative one is impossible for consistent
// inputs. The helper must THROW a bounded internal error, never silently
// return a clamped-to-zero delta.

test("INVARIANT: an authoritative score LOWER than the real hypothetical → throws CorpusDuplicateCounterfactualInvariantError, never returns 0", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    archiveMatchedPositions: Array.from({ length: 20 }, (_, i) => i), // 0..19 survives the exclusion → hypothetical score 20
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const real = computeUnifiedSimilarity(inputs);
  const impossible = { ...real, unifiedScore: 5 }; // < the real hypothetical (20)

  assert.throws(
    () => computeCorpusDuplicateCounterfactual({
      ...inputs,
      authoritativeUnifiedSimilarity: impossible,
      qualifyingRepresentationIds: ["R1"],
    }),
    (err) => {
      assert.ok(err instanceof CorpusDuplicateCounterfactualInvariantError, "must be the typed invariant error");
      assert.match(err.message, /hypotheticalScore=20/);
      assert.match(err.message, /authoritativeScore=5/);
      // bounded: numeric fields only, no representation id / passage / document text
      assert.doesNotMatch(err.message, /\bR1\b|passage|document text/i);
      return true;
    },
  );
});

test("INVARIANT: an authoritative uniqueMatchedWords LOWER than the real hypothetical → throws (score alone can be within range)", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    archiveMatchedPositions: Array.from({ length: 20 }, (_, i) => i), // hypothetical unique = 20
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const real = computeUnifiedSimilarity(inputs);
  const impossible = { ...real, uniqueMatchedWords: 3 }; // score stays 100 (fine), but unique < hypothetical's 20

  assert.throws(
    () => computeCorpusDuplicateCounterfactual({
      ...inputs,
      authoritativeUnifiedSimilarity: impossible,
      qualifyingRepresentationIds: ["R1"],
    }),
    (err) => {
      assert.ok(err instanceof CorpusDuplicateCounterfactualInvariantError);
      assert.match(err.message, /hypotheticalUniqueMatchedWords=20/);
      assert.match(err.message, /authoritativeUniqueMatchedWords=3/);
      return true;
    },
  );
});

test("INVARIANT: a consistent authoritative result at the boundary (hypothetical == authoritative) does NOT throw and yields delta 0 via direct subtraction", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    // Everything the candidate covers is also independently archive-covered,
    // so excluding it removes nothing: hypothetical == authoritative exactly.
    archiveMatchedPositions: Array.from({ length: 100 }, (_, i) => i),
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const authoritative = computeUnifiedSimilarity(inputs);
  let cf;
  assert.doesNotThrow(() => {
    cf = computeCorpusDuplicateCounterfactual({
      ...inputs,
      authoritativeUnifiedSimilarity: authoritative,
      qualifyingRepresentationIds: ["R1"],
    });
  });
  assert.equal(cf.hypotheticalScore, 100);
  assert.equal(cf.scoreDelta, 0);
  assert.equal(cf.uniqueMatchedWordsRemoved, 0);
  assert.equal(cf.candidateMatchedWords, 100, "the candidate still CLAIMED 100 words even though none disappeared");
});

test("INVARIANT: scoreDelta and uniqueMatchedWordsRemoved are direct subtraction — no Math.max clamp in the module source", () => {
  const source = fs.readFileSync(path.resolve("lib/corpus-duplicate-counterfactual.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Math\.max\s*\(\s*0/, "delta must not be clamped to zero");
  assert.match(code, /authoritative\.unifiedScore - hypothetical\.unifiedScore/);
  assert.match(code, /authoritative\.uniqueMatchedWords - hypothetical\.uniqueMatchedWords/);
});

// --- Empty qualifying set: hypothetical == authoritative -------------------

test("empty qualifying set → hypothetical score equals authoritative, delta 0, nothing removed", () => {
  const wordCount = 100;
  const inputs = {
    wordCount,
    archiveMatchedPositions: [1, 2, 3],
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  };
  const authoritative = computeUnifiedSimilarity(inputs);
  const cf = computeCorpusDuplicateCounterfactual({
    ...inputs,
    authoritativeUnifiedSimilarity: authoritative,
    qualifyingRepresentationIds: [],
  });
  assert.equal(cf.hypotheticalScore, cf.authoritativeScore);
  assert.equal(cf.scoreDelta, 0);
  assert.equal(cf.uniqueMatchedWordsRemoved, 0);
  assert.equal(cf.candidatesExcluded, 0);
  assert.equal(cf.candidateMatchedWords, 0);
});

// --- LOAD-BEARING: authoritative result unchanged (shape + values) --------

test("AUTHORITATIVE ISOLATION: computeUnifiedSimilarity(params) deep-equals it with hypotheticalExcludedRepresentationIds undefined AND with []", () => {
  const params = {
    wordCount: 500,
    archiveMatchedPositions: [10, 11, 12, 200, 201],
    externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(100, 149)] })],
    historicalSubmissionMatch: matched([
      match({ matchedRepresentationId: "R1", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 500, passages: [] }),
      match({ matchedRepresentationId: "R2", relationshipType: "SELF", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 60, passages: [passage(0, 59)] }),
    ]),
    effectiveDeviceSelfRepresentationIds: ["R3"],
  };
  const base = computeUnifiedSimilarity(params);
  const withUndefined = computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: undefined });
  const withEmptyArray = computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: [] });
  const withEmptySet = computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: new Set() });

  assert.deepEqual(withUndefined, base);
  assert.deepEqual(withEmptyArray, base);
  assert.deepEqual(withEmptySet, base);
});

test("AUTHORITATIVE ISOLATION: an authoritative (no-param) result carries exactly the documented top-level keys — no shadow property leaks in", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
  });
  assert.deepEqual(Object.keys(result).sort(), AUTHORITATIVE_RESULT_KEYS);
  // And with an (inert) empty exclusion set, still exactly the same keys.
  const withEmpty = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matched([match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] })]),
    hypotheticalExcludedRepresentationIds: [],
  });
  assert.deepEqual(Object.keys(withEmpty).sort(), AUTHORITATIVE_RESULT_KEYS);
});

test("AUTHORITATIVE ISOLATION: 'excluded_document_local_corpus_duplicate' never appears in an authoritative (no-param) call's contributions", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matched([
      match({ matchedRepresentationId: "R1", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] }),
    ]),
  });
  for (const contribution of result.contributions) {
    assert.notEqual(contribution.evidenceStatus, "excluded_document_local_corpus_duplicate");
  }
});

test("AUTHORITATIVE ISOLATION: inputs are not mutated — deep-frozen inputs run through both the authoritative and the counterfactual path without throwing, and compare equal after", () => {
  const wordCount = 200;
  const archive = [1, 2, 3, 50, 51];
  const academic = [academicEvidence({ matchedPassages: [passage(20, 39)] })];
  const historical = matched([
    match({ matchedRepresentationId: "R1", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 200, passages: [] }),
  ]);
  const deviceSelf = ["R9"];

  const archiveClone = structuredClone(archive);
  const academicClone = structuredClone(academic);
  const historicalClone = structuredClone(historical);
  const deviceSelfClone = structuredClone(deviceSelf);

  deepFreeze(archive);
  deepFreeze(academic);
  deepFreeze(historical);
  deepFreeze(deviceSelf);

  const inputs = {
    wordCount,
    archiveMatchedPositions: archive,
    externalAcademicEvidence: academic,
    historicalSubmissionMatch: historical,
    effectiveDeviceSelfRepresentationIds: deviceSelf,
  };

  let authoritative;
  assert.doesNotThrow(() => { authoritative = computeUnifiedSimilarity(inputs); });
  assert.doesNotThrow(() => {
    computeCorpusDuplicateCounterfactual({
      ...inputs,
      authoritativeUnifiedSimilarity: authoritative,
      qualifyingRepresentationIds: ["R1"],
    });
  });

  assert.deepEqual(archive, archiveClone);
  assert.deepEqual(academic, academicClone);
  assert.deepEqual(historical, historicalClone);
  assert.deepEqual(deviceSelf, deviceSelfClone);
});

// --- Hypothetical call behaviour (precedence) -----------------------------

test("hypothetical call: the excluded rep's contribution keeps its BASELINE relationshipType and is tagged excluded_document_local_corpus_duplicate", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matched([
      match({ matchedRepresentationId: "R1", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 100, passages: [] }),
    ]),
    hypotheticalExcludedRepresentationIds: ["R1"],
  });
  const r1 = result.contributions.find((c) => c.sourceId === "R1");
  assert.ok(r1);
  assert.equal(r1.evidenceStatus, "excluded_document_local_corpus_duplicate");
  assert.equal(r1.relationship, "TURNITPLUS_CORPUS_SOURCE", "baseline relationship preserved verbatim");
  assert.equal(r1.effectiveScoringRelationship, undefined, "never rewritten to SELF");
  assert.equal(result.unifiedScore, 0, "with R1 excluded and no other evidence, the score is 0");
});

test("precedence: a SELF-relationship rep also named in the hypothetical set still gets excluded_self (SELF wins)", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matched([
      match({ matchedRepresentationId: "R1", relationshipType: "SELF", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 80, passages: [passage(0, 79)] }),
    ]),
    hypotheticalExcludedRepresentationIds: ["R1"],
  });
  const r1 = result.contributions.find((c) => c.sourceId === "R1");
  assert.equal(r1.evidenceStatus, "excluded_self");
  assert.equal(result.selfExcludedWords, 80);
});

test("precedence: an effective device SELF rep also named in the hypothetical set still gets excluded_effective_device_self (device SELF wins)", () => {
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    historicalSubmissionMatch: matched([
      match({ matchedRepresentationId: "R1", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 90, passages: [passage(0, 89)] }),
    ]),
    effectiveDeviceSelfRepresentationIds: ["R1"],
    hypotheticalExcludedRepresentationIds: ["R1"],
  });
  const r1 = result.contributions.find((c) => c.sourceId === "R1");
  assert.equal(r1.evidenceStatus, "excluded_effective_device_self");
  assert.equal(result.deviceSelfExcludedWords, 90);
});

// --- Structural: the counterfactual helper is pure ------------------------

test("structural: the counterfactual module is pure — no DB client, no env reads, no db calls, no persistence", () => {
  const source = fs.readFileSync(path.resolve("lib/corpus-duplicate-counterfactual.ts"), "utf8");
  const importLines = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(importLines, /@libsql\/client/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /\bclient\.(execute|batch)\b/);
  assert.doesNotMatch(source, /INSERT |UPDATE |DELETE /i);
});
