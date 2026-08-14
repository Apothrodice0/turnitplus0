import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { tokens } from "../lib/similarity-core.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";
import { evaluatePassages } from "../lib/e8k-passage-evaluator.ts";
import { evaluateExperimentalAcceptance, sweepThresholds, PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS } from "../lib/e8k-passage-acceptance.ts";
import {
  E8J_BASE_DOCUMENT, E8J_FIXTURES, LOCAL_HISTORICAL_CORPUS,
  HIST_DISTINCTIVE_DOCUMENT, HIST_GENERIC_DOCUMENT,
  FILLER_PARAGRAPHS, E8K_FIXTURES,
} from "../lib/e8k-calibration-fixtures.ts";
import { PARTIAL_COPY_DOCUMENT } from "../lib/e8j-calibration-fixtures.ts";

/**
 * Phase E8K: tests for the experimental passage-level acceptance prototype.
 * Everything here is a pure-function test — no database, no production
 * connection, no production threshold import, no production matcher import.
 */

const repoRoot = path.resolve(".");

function fixture(category) {
  const f = E8J_FIXTURES.find((x) => x.category === category) ?? E8K_FIXTURES.find((x) => x.category === category);
  if (!f) throw new Error(`unknown fixture category ${category}`);
  return f;
}
function evaluate(submitted, candidate) {
  return evaluatePassages(submitted, candidate, { localCorpusContext: LOCAL_HISTORICAL_CORPUS });
}

// --- A: exact copy -------------------------------------------------------------

test("A: EXACT_COPY -> isExactCanonicalMatch, one full-document passage, experimental PASS", () => {
  const diag = evaluate(fixture("EXACT_COPY").text, E8J_BASE_DOCUMENT);
  assert.equal(diag.isExactCanonicalMatch, true);
  assert.equal(diag.passageCount, 1, "an exact match must read as one full-document passage, not zero passages");
  assert.equal(diag.passageDensity, 1);
  assert.equal(diag.wholeDocumentContainment, 1);
  const { pass } = evaluateExperimentalAcceptance(diag);
  assert.equal(pass, true, "the passage path must not disagree with the obvious exact match");
});

// --- B: formatting-only ----------------------------------------------------------

test("B: FORMATTING_ONLY -> canonical hash identical to base, isExactCanonicalMatch true, experimental PASS", () => {
  const f = fixture("FORMATTING_ONLY");
  assert.equal(canonicalizeText(f.text), canonicalizeText(E8J_BASE_DOCUMENT));
  const diag = evaluate(f.text, E8J_BASE_DOCUMENT);
  assert.equal(diag.isExactCanonicalMatch, true);
  const { pass } = evaluateExperimentalAcceptance(diag);
  assert.equal(pass, true);
});

// --- C: light edit ------------------------------------------------------------

test("C: LIGHT_EDIT -> multiple fragmented passages, high matched-word coverage, experimental PASS", () => {
  const diag = evaluate(fixture("LIGHT_EDIT").text, E8J_BASE_DOCUMENT);
  assert.equal(diag.isExactCanonicalMatch, false);
  assert.ok(diag.passageCount > 1, "scattered small edits should fragment the match into multiple passages");
  assert.ok(diag.passageCoverage > 0.8, "a ~7%-edited document should still show very high passage coverage");
  const { pass } = evaluateExperimentalAcceptance(diag);
  assert.equal(pass, true);
});

// --- D: moderate edit -----------------------------------------------------------

test("D: MODERATE_EDIT -> fewer, longer surviving passages, meaningful evidence, experimental PASS", () => {
  const diag = evaluate(fixture("MODERATE_EDIT").text, E8J_BASE_DOCUMENT);
  assert.ok(diag.passageCount >= 1 && diag.passageCount <= 10);
  assert.ok(diag.longestMatchWords > 100, "block-rewrite edit pattern should leave at least one long surviving verbatim run");
  const { pass } = evaluateExperimentalAcceptance(diag);
  assert.equal(pass, true);
});

// --- E: heavy edit ------------------------------------------------------------

test("E: HEAVY_EDIT -> whole-document containment is fragile (near the production threshold) but passage evidence still identifies surviving blocks", () => {
  const diag = evaluate(fixture("HEAVY_EDIT").text, E8J_BASE_DOCUMENT);
  assert.ok(diag.wholeDocumentContainment < 0.6, "heavy edits should sit close to (not comfortably above) the production 0.5 threshold");
  assert.ok(diag.matchedWordCount > 0 && diag.passageCount > 0, "passage-level evidence must still be visible even as whole-document evidence weakens");
  // Deliberately no assertion on evaluateExperimentalAcceptance's pass/fail here — this phase's own task description (section 9) explicitly does not require a PASS/MATCH decision for this fixture.
});

// --- F: partial copy — the critical test -----------------------------------------

test("F: PARTIAL_COPY -> whole-document containment stays below the production 0.5 threshold (confirms the E8J finding persists), but the passage evaluator DOES detect the copied passage, correctly localized", () => {
  const partial = fixture("PARTIAL_COPY");
  const diag = evaluate(partial.text, E8J_BASE_DOCUMENT);
  assert.ok(diag.wholeDocumentContainment > 0.3 && diag.wholeDocumentContainment < 0.4, `expected whole-document containment in (0.3, 0.4), got ${diag.wholeDocumentContainment}`);
  assert.equal(diag.passageCount, 1);
  assert.ok(diag.matchedWordCount > 400);
  assert.equal(diag.passageDensity, 1, "the one passage found is fully contiguous");

  const { pass, checks } = evaluateExperimentalAcceptance(diag);
  assert.equal(pass, true, "the experimental passage-level path SHOULD detect this case, unlike the production whole-document matcher");
  assert.ok(checks.every((c) => c.ok));

  // The passage must fall entirely within the known-copied zone (the first
  // 4 paragraphs of the PARTIAL_COPY fixture, per lib/e8j-calibration-fixtures.ts).
  const copiedZoneWordCount = tokens(PARTIAL_COPY_DOCUMENT.split("\n\n").slice(0, 4).join("\n\n")).length;
  for (const p of diag.passages) {
    assert.ok(p.submittedWordEnd < copiedZoneWordCount, `passage [${p.submittedWordStart}-${p.submittedWordEnd}] must fall within the copied zone (0-${copiedZoneWordCount - 1})`);
  }
});

// --- G-J: small distinctive passages of increasing size --------------------------

const FILLER_PREFIX_WORDS = tokens(`${FILLER_PARAGRAPHS[0]} ${FILLER_PARAGRAPHS[1]}`).length;

function assertSmallPassage(category, expectedApproxWords, shouldDetectByDefault) {
  const f = fixture(category);
  const diag = evaluate(f.text, f.candidateText);
  assert.ok(Math.abs(diag.matchedWordCount - expectedApproxWords) <= 20, `expected matchedWordCount near ${expectedApproxWords}, got ${diag.matchedWordCount}`);
  assert.equal(diag.passageCount, 1);
  assert.equal(diag.passageDensity, 1, "a single contiguous copied excerpt must be maximally dense");
  // The passage must start at (or very near) the known filler-prefix boundary — proves correct localization, not a false hit inside the filler.
  assert.ok(diag.passages[0].submittedWordStart >= FILLER_PREFIX_WORDS - 5 && diag.passages[0].submittedWordStart <= FILLER_PREFIX_WORDS + 5);
  const { pass } = evaluateExperimentalAcceptance(diag);
  assert.equal(pass, shouldDetectByDefault, `${category}: experimental pass under default thresholds`);
}

test("G: 100-word distinctive passage -> detected locally, but below default experimental thresholds", () => {
  assertSmallPassage("SMALL_PASSAGE_100", 100, false);
});
test("H: 150-word distinctive passage -> detected and passes default experimental thresholds", () => {
  assertSmallPassage("SMALL_PASSAGE_150", 150, true);
});
test("I: 250-word distinctive passage -> detected and passes", () => {
  assertSmallPassage("SMALL_PASSAGE_250", 250, true);
});
test("J: 500-word distinctive passage -> detected and passes, high whole-document containment too since the query document is short", () => {
  assertSmallPassage("SMALL_PASSAGE_500", 500, true);
});

// --- K: generic text — documented current behavior, not fixed in this phase -------

test("K: generic academic text — documented finding: 100 words correctly rejected, but 200/300 words currently PASS despite being entirely generic (a real false-positive risk, not fixed in this phase)", () => {
  const g100 = evaluate(fixture("GENERIC_100").text, HIST_GENERIC_DOCUMENT);
  assert.equal(evaluateExperimentalAcceptance(g100).pass, false, "100 generic words: correctly rejected (insufficient matched words)");

  const g200 = evaluate(fixture("GENERIC_200").text, HIST_GENERIC_DOCUMENT);
  const g300 = evaluate(fixture("GENERIC_300").text, HIST_GENERIC_DOCUMENT);
  assert.equal(evaluateExperimentalAcceptance(g200).pass, true, "DOCUMENTED FALSE POSITIVE: 200 generic words currently pass the default experimental thresholds — see final report section 11");
  assert.equal(evaluateExperimentalAcceptance(g300).pass, true, "DOCUMENTED FALSE POSITIVE: 300 generic words currently pass the default experimental thresholds — see final report section 11");
  // Distinctiveness is measurably lower for generic text than for genuine distinctive reuse, even though it isn't low enough to flip the default decision — this is the mechanism partially working, not completely absent.
  const partialDiag = evaluate(fixture("PARTIAL_COPY").text, E8J_BASE_DOCUMENT);
  assert.ok(g300.distinctiveness < partialDiag.distinctiveness, "generic text's distinctiveness score must be measurably lower than genuine distinctive reuse, even though not low enough to flip the default decision");
});

// --- L: many short common overlaps ------------------------------------------------

test("L: many short common overlaps -> low density, fragmented into several passages, correctly rejected by default thresholds", () => {
  const diag = evaluate(fixture("MANY_SHORT_COMMON").text, HIST_GENERIC_DOCUMENT);
  assert.ok(diag.passageCount > 1, "many separate short snippets should produce multiple passages, not one");
  assert.ok(diag.passageDensity < 0.5, "scattered short matches across a large envelope should show low density");
  assert.equal(evaluateExperimentalAcceptance(diag).pass, false);
});

// --- M: several medium distinctive overlaps ---------------------------------------

test("M: several medium distinctive overlaps -> exactly 2 passages, passes default thresholds", () => {
  const diag = evaluate(fixture("SEVERAL_MEDIUM_DISTINCTIVE").text, HIST_DISTINCTIVE_DOCUMENT);
  assert.equal(diag.passageCount, 2);
  assert.equal(evaluateExperimentalAcceptance(diag).pass, true);
});

// --- N: same-topic, different wording ---------------------------------------------

test("N: SAME_TOPIC_DIFFERENT_WORDING -> zero passage evidence, correctly rejected (topic similarity alone must never manufacture passage evidence)", () => {
  const diag = evaluate(fixture("SAME_TOPIC_DIFFERENT_WORDING").text, E8J_BASE_DOCUMENT);
  assert.equal(diag.matchedWordCount, 0);
  assert.equal(diag.passageCount, 0);
  assert.equal(evaluateExperimentalAcceptance(diag).pass, false);
});

// --- O: deterministic results ------------------------------------------------------

test("O: evaluatePassages is deterministic — repeated calls on the same inputs return identical diagnostics", () => {
  const a = evaluate(fixture("MODERATE_EDIT").text, E8J_BASE_DOCUMENT);
  const b = evaluate(fixture("MODERATE_EDIT").text, E8J_BASE_DOCUMENT);
  assert.deepEqual(a, b);
});

// --- P: bounded passages -------------------------------------------------------------

test("P: every returned passage's reconstructed TEXT stays within maxPassageWords, and passage count stays within maxPassages — no new unbounded behavior introduced", () => {
  // Note: a passage's matchedWordCount is the full accepted-span length
  // (used for scoring) and, per lib/document-correspondence.ts's own
  // existing behavior, is deliberately NOT capped at maxPassageWords — only
  // the reconstructed submittedText excerpt itself is capped (bounded
  // display text, distinct from the span-length metric). This test checks
  // the actual bounded property: the TEXT, not the metadata.
  for (const category of ["LIGHT_EDIT", "MODERATE_EDIT", "HEAVY_EDIT"]) {
    const diag = evaluate(fixture(category).text, E8J_BASE_DOCUMENT);
    assert.ok(diag.passages.length <= DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassages);
    for (const p of diag.passages) {
      assert.ok(p.submittedText.split(" ").length <= DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassageWords);
    }
  }
});

// --- Q: no historical-document leakage ---------------------------------------------

test("Q: every passage is reconstructed from the CURRENT submission's own words only — never the candidate/historical text, and externalWordStart is always null", () => {
  const diag = evaluate(fixture("SMALL_PASSAGE_500").text, HIST_DISTINCTIVE_DOCUMENT);
  const submittedWords = tokens(fixture("SMALL_PASSAGE_500").text);
  for (const p of diag.passages) {
    assert.equal(p.externalWordStart, null);
    // Reconstruct what the passage text SHOULD be from the submitted document's own normalized token stream at the claimed offset, and require an exact match — a real check, not just a length comparison.
    const passageWordCount = p.submittedText.split(" ").length;
    const expectedText = submittedWords.slice(p.submittedWordStart, p.submittedWordStart + passageWordCount).join(" ");
    assert.equal(p.submittedText, expectedText, "passage text must be an exact reconstruction of the submitted document's own tokens at the claimed position");
  }
});

// --- R: score invariance -------------------------------------------------------------

test("R (structural): the E8K evaluator/acceptance modules never reference a scoring field, never import the production matcher, and never import a DB client", () => {
  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  for (const file of ["lib/e8k-passage-evaluator.ts", "lib/e8k-passage-acceptance.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(source, /\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/, `${file} must never reference a scoring field`);
    assert.doesNotMatch(source, /from\s+["'].*user-submission-matching["']/, `${file} must never import the production matcher`);
    assert.doesNotMatch(source, /@libsql\/client/, `${file} must never import a DB client — pure functions only`);
  }
});

test("R (functional): evaluateExperimentalAcceptance and sweepThresholds are pure — never accept a database client argument, verified by TypeScript's own signature plus a runtime smoke check with a plain object", () => {
  const diag = evaluate(fixture("MODERATE_EDIT").text, E8J_BASE_DOCUMENT);
  const result = evaluateExperimentalAcceptance(diag, PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS);
  assert.equal(typeof result.pass, "boolean");
  const sweep = sweepThresholds(
    [{ category: "MODERATE_EDIT", diagnostics: diag, expectedShouldDetect: true }],
    { minimumMatchedWordsOptions: [100], minimumLongestPassageWordsOptions: [50], minimumPassageDensityOptions: [0.1] },
  );
  assert.equal(sweep.length, 1);
});
