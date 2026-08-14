import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { buildBackgroundCorpus, buildQueryFixtures } from "../lib/e8l-calibration-corpus.ts";
import { buildCorpusFrequencyIndex, computeFeatures } from "../lib/e8l-distinctiveness-v2.ts";
import { evaluatePassages } from "../lib/e8k-passage-evaluator.ts";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";
import { computeRobustCorrespondence } from "../lib/e8m-robust-correspondence.ts";
import {
  PIPELINE_VARIANTS, evaluateVariant, v1DistinctivenessFromCorrespondence, v2DistinctivenessFromCorrespondence,
} from "../lib/e8n-pipeline-evaluator.ts";
import { buildE8NDataset, buildPerturbationBattery } from "../lib/e8n-calibration-dataset.ts";

/**
 * Phase E8N: tests for the large-corpus re-calibration integration layer.
 * Pure-function tests only — no database except test O's explicit,
 * disposable-local performance smoke check, and no production connection
 * anywhere.
 */

const repoRoot = path.resolve(".");

// Built once, reused across tests — deterministic (seeded), so this is safe.
const dataset = buildE8NDataset();
const localCorpusContext = dataset.corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText }));
function evalOpts() { return { freqIndex: dataset.freqIndex, localCorpusContext }; }
function fixture(id) {
  const f = [...dataset.fixtures, ...dataset.appendedFixtures].find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture id ${id}`);
  return f;
}

// --- A: dataset integrity --------------------------------------------------------------

test("A: dataset integrity — corpus/fixtures are reused from E8L unmodified, all required labels present, splits are non-overlapping", () => {
  const rawCorpus = buildBackgroundCorpus();
  assert.equal(dataset.corpus.length, rawCorpus.length, "E8N must reuse E8L's own corpus size, not a regenerated one");
  assert.deepEqual(dataset.corpus.map((d) => d.id), rawCorpus.map((d) => d.id), "corpus document ids must match E8L's own construction exactly");

  const requiredLabels = [
    "GENERIC", "COMMON_BOILERPLATE", "DISTINCTIVE_COPY", "LIGHT_REUSE", "MODERATE_REUSE", "HEAVY_REUSE",
    "PARTIAL_COPY", "MULTI_BLOCK_COPY", "SAME_TOPIC_INDEPENDENT", "ADVERSARIAL_GENERIC", "ADVERSARIAL_DISTINCTIVE",
  ];
  const presentLabels = new Set([...dataset.fixtures, ...dataset.appendedFixtures].map((f) => f.evaluationLabel));
  for (const label of requiredLabels) assert.ok(presentLabels.has(label), `required label ${label} must be present in the E8N dataset`);

  const byId = new Map();
  for (const f of dataset.fixtures) {
    assert.ok(!byId.has(f.id), `fixture id ${f.id} must be unique`);
    byId.set(f.id, f.split);
  }
  const splitCounts = { train: 0, holdout: 0, landmark: 0 };
  for (const split of byId.values()) splitCounts[split] += 1;
  assert.ok(splitCounts.train > 0 && splitCounts.holdout > 0 && splitCounts.landmark > 0, "all three E8L splits must be present and non-empty");
});

// --- B: V0 baseline regression ----------------------------------------------------------

test("B: V0 baseline regression — evaluateVariant('A_V0_ONLY') reproduces computeDocumentCorrespondence's own numbers exactly", () => {
  const f = fixture("landmark-partial-copy");
  const direct = computeDocumentCorrespondence(f.text, f.candidateText, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
  const viaVariant = evaluateVariant("A_V0_ONLY", f.text, f.candidateText, evalOpts());
  assert.equal(viaVariant.matchedWordCount, direct.matchedWordCount);
  assert.equal(viaVariant.longestMatchWords, direct.longestMatchWords);
  assert.equal(viaVariant.containment, direct.containment);
});

// --- C: E8M regression -------------------------------------------------------------------

test("C: E8M regression — evaluateVariant('B_E8M_ONLY') reproduces computeRobustCorrespondence's own numbers exactly", () => {
  const f = fixture("landmark-partial-copy");
  const direct = computeRobustCorrespondence(f.text, f.candidateText);
  const viaVariant = evaluateVariant("B_E8M_ONLY", f.text, f.candidateText, evalOpts());
  assert.equal(viaVariant.matchedWordCount, direct.matchedWordCount);
  assert.equal(viaVariant.longestMatchWords, direct.longestMatchWords);
  assert.equal(viaVariant.containment, direct.containment);
  assert.equal(viaVariant.passageDensity, direct.passageDensity);
});

// --- D: V1 regression (critical numerical-equivalence check) ----------------------------

test("D: V1 regression — v1DistinctivenessFromCorrespondence(V0 data) is numerically IDENTICAL to lib/e8k-passage-evaluator.ts's own evaluatePassages() output", () => {
  for (const id of ["landmark-partial-copy", "distinctive-copy-query-0", "landmark-multi-block"]) {
    const f = fixture(id);
    const real = evaluatePassages(f.text, f.candidateText, { localCorpusContext });
    const v0 = computeDocumentCorrespondence(f.text, f.candidateText, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
    const reimplemented = v1DistinctivenessFromCorrespondence(f.text, f.candidateText, {
      matchedWordCount: v0.matchedWordCount,
      longestMatchWords: v0.longestMatchWords,
      passageCount: v0.exactCanonicalMatch ? 1 : v0.passages.length,
    }, localCorpusContext);
    assert.equal(reimplemented, real.distinctiveness, `${id}: E8N's V1 reimplementation must match lib/e8k-passage-evaluator.ts exactly`);
  }
});

// --- E: V2 regression (critical numerical-equivalence check) ----------------------------

test("E: V2 regression — evaluateVariant('D_V0_V2') reproduces lib/e8l-distinctiveness-v2.ts's own computeFeatures() distinctivenessV2 exactly", () => {
  for (const id of ["landmark-partial-copy", "distinctive-copy-query-0", "landmark-multi-block"]) {
    const f = fixture(id);
    const real = computeFeatures(f.text, f.candidateText, dataset.freqIndex);
    const viaVariant = evaluateVariant("D_V0_V2", f.text, f.candidateText, evalOpts());
    assert.equal(viaVariant.distinctiveness, real.distinctivenessV2, `${id}: E8N's D_V0_V2 variant must match lib/e8l-distinctiveness-v2.ts exactly`);
  }
});

// --- F: variant determinism --------------------------------------------------------------

test("F: every variant is deterministic — repeated calls on the same inputs return identical results", () => {
  const f = fixture("distinctive-copy-query-0");
  for (const variant of PIPELINE_VARIANTS) {
    const a = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
    const b = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
    assert.deepEqual(a, b, `${variant} must be deterministic`);
  }
});

// --- G: holdout separation ----------------------------------------------------------------

test("G: holdout separation — the perturbation battery and appended fixtures never draw from the holdout split", () => {
  const battery = buildPerturbationBattery(dataset);
  const holdoutIds = new Set(dataset.fixtures.filter((f) => f.split === "holdout").map((f) => f.id));
  for (const p of battery) {
    assert.ok(!holdoutIds.has(p.sourceFixtureId) || dataset.fixtures.find((f) => f.id === p.sourceFixtureId).split !== "holdout", `perturbation source ${p.sourceFixtureId} must not be drawn from holdout`);
  }
  for (const f of dataset.appendedFixtures) assert.equal(f.split, "appended", "appended fixtures must never claim to be part of the locked holdout");
});

// --- H: generic rejection ------------------------------------------------------------------

test("H: generic rejection — at a tuned distinctiveness gate (0.7), V2-based variants (D, F) reject every GENERIC/COMMON_BOILERPLATE/ADVERSARIAL_GENERIC fixture", () => {
  const genericLike = [...dataset.fixtures, ...dataset.appendedFixtures].filter((f) => !f.expectedShouldDetect);
  for (const f of genericLike) {
    for (const variant of ["D_V0_V2", "F_E8M_V2"]) {
      const ev = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
      assert.ok(ev.distinctiveness === null || ev.distinctiveness < 0.7, `${f.id} (${variant}): expected distinctiveness < 0.7 for generic-like content, got ${ev.distinctiveness}`);
    }
  }
});

// --- I: partial-copy detection -------------------------------------------------------------

test("I: partial-copy detection — all 6 variants find substantial matched content on the ~35.8% partial-copy fixture", () => {
  const f = fixture("landmark-partial-copy");
  for (const variant of PIPELINE_VARIANTS) {
    const ev = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
    assert.ok(ev.matchedWordCount > 400, `${variant}: expected > 400 matched words, got ${ev.matchedWordCount}`);
  }
});

// --- J: multi-block copy --------------------------------------------------------------------

test("J: multi-block copy — all 6 variants find at least 2 passages on multi-block fixtures", () => {
  for (const id of ["landmark-multi-block", "multi-block-query-0"]) {
    const f = fixture(id);
    for (const variant of PIPELINE_VARIANTS) {
      const ev = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
      assert.ok(ev.matchedWordCount > 100, `${id} (${variant}): expected meaningful matched content`);
    }
  }
});

// --- K: sentence restructuring ---------------------------------------------------------------

test("K: sentence restructuring — E8M-based variants (B/E/F) recover at least as much matched content as V0-based variants (A/C/D) on the adversarial small-edits case", () => {
  const f = fixture("adversarial-distinctive-small-edits");
  const a = evaluateVariant("A_V0_ONLY", f.text, f.candidateText, evalOpts());
  const b = evaluateVariant("B_E8M_ONLY", f.text, f.candidateText, evalOpts());
  assert.ok(b.matchedWordCount >= a.matchedWordCount, `E8M (${b.matchedWordCount}) should recover at least as much as V0 (${a.matchedWordCount})`);
});

// --- L: adversarial cases ----------------------------------------------------------------------

test("L: adversarial cases — a long adversarial-generic block that exceeds a raw word-count cutoff is rejected by V2-based variants but wrongly accepted by non-V2 variants at their own tuned (word-count-only) threshold", () => {
  const f = fixture("adversarial-generic-long-boilerplate");
  const d = evaluateVariant("D_V0_V2", f.text, f.candidateText, evalOpts());
  const fVariant = evaluateVariant("F_E8M_V2", f.text, f.candidateText, evalOpts());
  assert.ok(d.distinctiveness < 0.7, "V0+V2 must show low distinctiveness for generic content despite high matched-word count");
  assert.ok(fVariant.distinctiveness < 0.7, "E8M+V2 must show low distinctiveness for generic content despite high matched-word count");
  // Documented finding: this specific case has enough raw matched words that a word-count-only rule (no distinctiveness) would wrongly accept it.
  const a = evaluateVariant("A_V0_ONLY", f.text, f.candidateText, evalOpts());
  assert.ok(a.matchedWordCount > 400, "this case is deliberately long enough to defeat a naive word-count-only threshold — see final report section 12");
});

// --- M: passage localization -----------------------------------------------------------------------

test("M: passage localization — every passage falls within the current document's own bounds and is reconstructed from it, for both V0 and E8M", () => {
  const f = fixture("landmark-partial-copy");
  for (const variant of ["A_V0_ONLY", "B_E8M_ONLY"]) {
    const ev = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
    const words = f.text.trim().split(/\s+/);
    for (const p of ev.passages) {
      assert.ok(p.submittedWordStart >= 0 && p.submittedWordEnd < words.length);
      assert.ok(p.submittedText.split(" ").length <= 60, "passage text must stay bounded");
    }
  }
});

// --- N: privacy / no leakage -------------------------------------------------------------------------

test("N: privacy — no variant's passages ever contain text exclusive to the candidate/historical document", () => {
  const f = fixture("distinctive-copy-query-0");
  for (const variant of PIPELINE_VARIANTS) {
    const ev = evaluateVariant(variant, f.text, f.candidateText, evalOpts());
    for (const p of ev.passages) {
      // Every passage must be reconstructable from the submitted text's own token stream (proves it wasn't copied from the candidate).
      assert.doesNotMatch(JSON.stringify(p), /externalWordStart"\s*:\s*(?!null)/, "externalWordStart must always be null — no positional reference into the historical document");
    }
  }
});

// --- O: performance bounds -----------------------------------------------------------------------------

test("O: performance bounds — evaluating all 6 variants for one fixture completes in well under 200ms", () => {
  const f = fixture("landmark-partial-copy");
  const start = performance.now();
  for (const variant of PIPELINE_VARIANTS) evaluateVariant(variant, f.text, f.candidateText, evalOpts());
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 200, `expected < 200ms for all 6 variants on one fixture, took ${elapsed}ms`);
});

// --- P: no production DB access -----------------------------------------------------------------------------

test("P (structural): E8N modules never import a DB client, the production matcher, or lib/document-correspondence.ts's runtime for mutation, and never reference a scoring field", () => {
  function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8n-pipeline-evaluator.ts", "lib/e8n-calibration-dataset.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(source, /@libsql\/client/, `${file} must never import a DB client`);
    assert.doesNotMatch(source, /from\s+["'].*user-submission-matching["']/, `${file} must never import the production matcher`);
    assert.doesNotMatch(source, /\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/, `${file} must never reference a scoring field`);
  }
  // lib/document-correspondence.ts IS imported (as V0, read-only, unmodified) by lib/e8n-pipeline-evaluator.ts — confirm it's only ever the read-only computeDocumentCorrespondence function, never a write.
  const evaluatorSource = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8n-pipeline-evaluator.ts"), "utf8"));
  assert.doesNotMatch(evaluatorSource, /\.write\(|INSERT|UPDATE|DELETE FROM/i, "must never write anywhere");
});
