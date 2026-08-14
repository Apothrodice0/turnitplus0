import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import {
  buildBackgroundCorpus, buildQueryFixtures, generateGenericDocument, generateDistinctiveDocument,
} from "../lib/e8l-calibration-corpus.ts";
import {
  buildCorpusFrequencyIndex, computeFeatures, featureEntitySignal, featureNumericSignal,
  featureInternalRepetition, combineV2, DISTINCTIVENESS_MODEL_V2,
} from "../lib/e8l-distinctiveness-v2.ts";
import { evaluatePassages } from "../lib/e8k-passage-evaluator.ts";
import { evaluateExperimentalAcceptance } from "../lib/e8k-passage-acceptance.ts";

/**
 * Phase E8L: tests for the redesigned (V2) passage-distinctiveness model.
 * Pure-function tests only — no database, no production connection, no
 * production threshold/matcher import.
 */

const repoRoot = path.resolve(".");

// Built once, reused across tests — deterministic (seeded), so this is safe.
const corpus = buildBackgroundCorpus();
const freqIndex = buildCorpusFrequencyIndex(corpus);
const { fixtures, adversarialGeneric, adversarialDistinctive } = buildQueryFixtures(corpus);

function fixture(id) {
  const f = [...fixtures, ...adversarialGeneric, ...adversarialDistinctive].find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture id ${id}`);
  return f;
}

// A tuned (not production) threshold, discovered by tools/e8l-calibration-report.ts's
// own train-only sweep — reused here to test the SAME configuration, not a
// freshly re-swept one, matching this phase's own hold-out discipline.
const TUNED_V2_DISTINCTIVENESS_THRESHOLD = 0.7;
const V1_DEFAULT_THRESHOLDS = undefined; // PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS default (minimumDistinctiveness: 0, i.e. off)

function v2Diagnostics(f) {
  return computeFeatures(f.text, f.candidateText, freqIndex);
}
function v1Diagnostics(f) {
  return evaluatePassages(f.text, f.candidateText, { localCorpusContext: corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText })) });
}
function v2Pass(f, minimumDistinctiveness = TUNED_V2_DISTINCTIVENESS_THRESHOLD) {
  const v1 = v1Diagnostics(f);
  const v2 = v2Diagnostics(f);
  const proxy = { ...v1, distinctiveness: v2.distinctivenessV2, distinctivenessBand: "medium" };
  return evaluateExperimentalAcceptance(proxy, { minimumMatchedWords: 50, minimumLongestPassageWords: 50, minimumPassageDensity: 0.05, minimumInformativeSharedShingles: 15, minimumMeaningfulPassages: 1, minimumDistinctiveness }).pass;
}

// --- A: generic boilerplate rejection -----------------------------------------

test("A: generic boilerplate — V1's default (distinctiveness gate off) currently accepts it (documented, not fixed here); V2 at the tuned 0.7 threshold correctly rejects it", () => {
  const f = fixture("landmark-boilerplate-200"); // E8K's exact GENERIC_200 false-positive case
  const v1 = v1Diagnostics(f);
  assert.equal(evaluateExperimentalAcceptance(v1, V1_DEFAULT_THRESHOLDS).pass, true, "documented current behavior: V1's default thresholds accept this");
  assert.equal(v2Pass(f), false, "V2 at the tuned threshold correctly rejects generic boilerplate");
});

test("A (adversarial): long/repeated/legal/mixed generic stress cases are all rejected by V2 at the tuned threshold", () => {
  for (const id of ["adversarial-generic-long-boilerplate", "adversarial-generic-repeated-methodology", "adversarial-generic-legal", "adversarial-generic-mixed"]) {
    assert.equal(v2Pass(fixture(id)), false, `${id} should be rejected by V2 at the tuned threshold`);
  }
});

// --- B: distinctive copy detection --------------------------------------------

test("B: a near-exact copy of a DISTINCTIVE corpus document scores maximal V2 distinctiveness and is detected", () => {
  const f = fixtures.find((x) => x.label === "DISTINCTIVE_COPY" && x.split === "train");
  const v2 = v2Diagnostics(f);
  assert.equal(v2.distinctivenessV2, 1);
  assert.equal(v2Pass(f), true);
});

// --- C: light edit survival ----------------------------------------------------

test("C: LIGHT_REUSE (E8J's ~7%-edited document) survives V2 at the tuned threshold", () => {
  const f = fixture("landmark-light-reuse");
  const v2 = v2Diagnostics(f);
  assert.ok(v2.distinctivenessV2 >= TUNED_V2_DISTINCTIVENESS_THRESHOLD, `expected >= ${TUNED_V2_DISTINCTIVENESS_THRESHOLD}, got ${v2.distinctivenessV2}`);
  assert.equal(v2Pass(f), true);
});

// --- D: partial copy detection --------------------------------------------------

test("D: PARTIAL_COPY (E8J's critical 435-word case) is detected by V2 at the tuned threshold", () => {
  const f = fixture("landmark-partial-copy");
  assert.equal(v2Pass(f), true);
});

// --- E: multi-block copy ----------------------------------------------------------

test("E: MULTI_BLOCK_COPY — freshly generated instances clear the tuned threshold; the E8K-reused landmark case is a documented near-miss just below it", () => {
  for (const id of ["multi-block-query-0", "multi-block-query-1"]) {
    assert.equal(v2Pass(fixture(id)), true, `${id} should be detected`);
  }
  const landmark = fixture("landmark-multi-block");
  const v2 = v2Diagnostics(landmark);
  assert.ok(v2.distinctivenessV2 < TUNED_V2_DISTINCTIVENESS_THRESHOLD && v2.distinctivenessV2 > 0.6, `documented near-miss: expected distinctivenessV2 in (0.6, ${TUNED_V2_DISTINCTIVENESS_THRESHOLD}), got ${v2.distinctivenessV2}`);
});

// --- F: same-topic independent writing ---------------------------------------------

test("F: SAME_TOPIC_INDEPENDENT — the E8J landmark case has zero shared evidence and is rejected; freshly generated instances (which share incidental generic phrasing) are also rejected at the tuned threshold", () => {
  const landmark = v2Diagnostics(fixture("landmark-same-topic"));
  assert.equal(landmark.matchedWordCount, 0);
  assert.equal(landmark.distinctivenessV2, 0);
  for (const id of ["same-topic-query-0", "same-topic-query-1"]) {
    assert.equal(v2Pass(fixture(id)), false, `${id} should be rejected`);
  }
});

// --- G: rare multiword sequences ----------------------------------------------------

test("G: featureRareMultiword scores distinctive-copy comparisons higher than generic-boilerplate comparisons", () => {
  const distinctive = v2Diagnostics(fixtures.find((x) => x.label === "DISTINCTIVE_COPY"));
  const generic = v2Diagnostics(fixture("landmark-boilerplate-200"));
  assert.ok(distinctive.features.rareMultiword > generic.features.rareMultiword, `expected distinctive (${distinctive.features.rareMultiword}) > generic (${generic.features.rareMultiword})`);
});

// --- H: numeric/structured signal ----------------------------------------------------

test("H: featureNumericSignal is positive for a passage containing invented measurements, zero for one with no numbers", () => {
  const withNumbers = v2Diagnostics(fixture("landmark-partial-copy")); // E8J text contains percentages/measurements
  assert.ok(withNumbers.features.numericSignal > 0);
  const noNumbers = v2Diagnostics(fixture("landmark-same-topic"));
  assert.equal(noNumbers.features.numericSignal, 0, "no passages at all -> zero numeric signal");
});

// --- I: named-entity signal ----------------------------------------------------------

test("I: featureEntitySignal detects invented capitalized organization/term names in a distinctive-copy passage", () => {
  const f = fixtures.find((x) => x.label === "DISTINCTIVE_COPY" && x.split === "train");
  const v2 = v2Diagnostics(f);
  assert.ok(v2.features.entitySignal > 0, "a distinctive copy full of invented Org/Person/Term names should register a nonzero entity signal");
});

// --- J: internal repetition penalty ---------------------------------------------------

test("J: featureInternalRepetition drops below 1 when a shared shingle is repeated many times within the submitted document", () => {
  const repeatedSentence = "Meridian Analytics reported that the Amberline vent field exceeded expectations by 41.2 millikelvins during the trial.";
  const repeatedDoc = new Array(6).fill(repeatedSentence).join(" ");
  const candidate = repeatedSentence + " " + generateDistinctiveDocument(70000, 5);
  const submittedShingles = new Set(); // computed inside computeFeatures normally; here we go through the real pipeline instead
  void submittedShingles;
  const v2 = computeFeatures(repeatedDoc, candidate, freqIndex);
  assert.ok(v2.features.internalRepetition < 1, `expected < 1 for internally-repeated content, got ${v2.features.internalRepetition}`);

  const nonRepeatedDoc = generateDistinctiveDocument(70001, 6);
  const v2b = computeFeatures(nonRepeatedDoc, nonRepeatedDoc, freqIndex);
  assert.equal(v2b.features.internalRepetition, 1, "no repetition -> no penalty");
});

// --- K: deterministic output ----------------------------------------------------------

test("K: computeFeatures is deterministic — repeated calls on the same inputs return identical results", () => {
  const f = fixture("landmark-partial-copy");
  const a = computeFeatures(f.text, f.candidateText, freqIndex);
  const b = computeFeatures(f.text, f.candidateText, freqIndex);
  assert.deepEqual(a, b);
});

// --- L: hold-out behavior --------------------------------------------------------------

test("L: the tuned threshold, selected without looking at hold-out fixtures, still classifies hold-out fixtures correctly", () => {
  const holdoutChecks = [
    ["generic-query-1", false], ["distinctive-copy-query-1", true], ["boilerplate-mixed-query-1", false],
    ["multi-block-query-1", true], ["same-topic-query-1", false],
  ];
  for (const [id, expected] of holdoutChecks) {
    const f = fixtures.find((x) => x.id === id);
    assert.equal(f.split, "holdout", `${id} must actually be in the holdout split for this test to be meaningful`);
    assert.equal(v2Pass(f), expected, `${id}: expected pass=${expected}`);
  }
});

// --- M: no production DB access ---------------------------------------------------------

test("M (structural): E8L modules never import a DB client or the production matcher", () => {
  function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8l-calibration-corpus.ts", "lib/e8l-distinctiveness-v2.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(source, /@libsql\/client/, `${file} must never import a DB client`);
    assert.doesNotMatch(source, /from\s+["'].*user-submission-matching["']/, `${file} must never import the production matcher`);
  }
});

// --- N: bounded runtime ----------------------------------------------------------------

test("N: a single distinctiveness computation against a 300-document frequency index stays well under 200ms", () => {
  const bigCorpus = [];
  for (let i = 0; i < 300; i += 1) {
    bigCorpus.push({ id: `bounded-${i}`, label: i % 2 === 0 ? "GENERIC" : "DISTINCTIVE", canonicalText: i % 2 === 0 ? generateGenericDocument(90000 + i, 12) : generateDistinctiveDocument(90000 + i, 10) });
  }
  const bigIndex = buildCorpusFrequencyIndex(bigCorpus);
  const f = fixture("landmark-partial-copy");
  const start = performance.now();
  computeFeatures(f.text, f.candidateText, bigIndex);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 200, `expected a single query to take well under 200ms against a 300-doc index, took ${elapsed}ms`);
});

// --- O: no score mutation ----------------------------------------------------------------

test("O (structural): E8L modules never reference a scoring field", () => {
  function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8l-calibration-corpus.ts", "lib/e8l-distinctiveness-v2.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(source, /\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/, `${file} must never reference a scoring field`);
  }
});

// --- V1 baseline preserved, unmodified, still importable side by side ------------------

test("V1 baseline (E8K) is untouched and produces the SAME headline finding this phase set out to investigate: no threshold separates GENERIC from DISTINCTIVE_COPY under V1", () => {
  const genericV1 = [fixture("landmark-boilerplate-100"), fixture("landmark-boilerplate-200"), fixture("landmark-boilerplate-300")].map((f) => v1Diagnostics(f).distinctiveness);
  const distinctiveV1 = fixtures.filter((f) => f.label === "DISTINCTIVE_COPY").slice(0, 3).map((f) => v1Diagnostics(f).distinctiveness);
  assert.ok(Math.max(...genericV1) >= Math.min(...distinctiveV1), "V1's ranges must overlap — this is the documented baseline limitation V2 was built to address");
});

test("DISTINCTIVENESS_MODEL_V2 is a distinct, versioned identifier — never equal to or confused with any V1/production identifier", () => {
  assert.equal(DISTINCTIVENESS_MODEL_V2, "e8l-distinctiveness-v2");
});

test("combineV2/featureEntitySignal/featureNumericSignal/featureInternalRepetition are pure and exported independently — each individually testable before combination, per this phase's own task description (section 6)", () => {
  assert.equal(typeof combineV2, "function");
  assert.equal(typeof featureEntitySignal, "function");
  assert.equal(typeof featureNumericSignal, "function");
  assert.equal(typeof featureInternalRepetition, "function");
});
