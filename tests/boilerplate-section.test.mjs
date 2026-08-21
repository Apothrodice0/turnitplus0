import assert from "node:assert/strict";
import test from "node:test";
import { findBoilerplateSections, stripBoilerplateSections } from "../lib/boilerplate-section.ts";

/**
 * Metadata-relevance investigation ISSUE A — direct unit coverage for the
 * boilerplate-section detector, mirroring tests/reference-section.test.mjs's
 * own structure (that module's sibling/precedent). Covers synthetic
 * declaration paragraphs plus the REAL extracted text (verbatim, captured
 * during this investigation) that first exposed the contamination this
 * module exists to fix — see this module's own header comment.
 */

// Verbatim excerpt from the real, normalized text extraction of a genuine
// BayesValidRox release-note PDF (the exact document that exposed the
// boilerplate-contamination bug in the metadata-relevance offline
// experiment) -- not paraphrased, not synthetic. Deliberately includes the
// "multiple competing models" false-positive case (ordinary technical
// prose using "competing" in ordinary technical prose using "competing" in
// its non-boilerplate sense) immediately before the real
// Acknowledgment/Competing-Interests/References run, exactly as it
// appears in the real extraction (PDF-extracted text has no reliable
// paragraph breaks -- see lib/reference-section.ts's own header comment on
// why this module must not depend on newline structure either).
const REAL_BAYESVALIDROX_EXCERPT =
  "For inference, posterior samples can be generated with either rejection sampling [3] or Markov-Chain Monte Carlo (MCMC) sampling. If multiple competing models are given, Bayesian multi-model comparison can be performed with the class BMC via pairwise comparison of the model BMEs, the calculation of model weights or the generation of a confusion matrix [2, 11, 4, 5]. For a detailed description of the methods we refer to the work in [5]. Acknowledgment The development of BayesValidRox is primarily funded by the Collaborative Research Centre SFB 1313, Project Number 327154368. Additional funding was received from the Bundesgesellschaft für Entlagerung as part of the project URS and the Cluster of Excellence “Data-Integrated Simulation Science” (EXC 2075 – 390740016). Competing Interests The authors declare that they have no known competing financial interests or personal relationships that could have appeared to influence the work reported in this paper. References [1] J. Beck and S. Guillas. Sequential design with mutual information for computer experiments (MICE): Emulation of a time";

test("REAL FIXTURE: the genuine BayesValidRox Acknowledgment + Competing Interests paragraphs are stripped, real technical content is preserved", () => {
  const stripped = stripBoilerplateSections(REAL_BAYESVALIDROX_EXCERPT);

  assert.match(stripped, /rejection sampling/, "real technical content before the boilerplate must survive");
  assert.match(stripped, /multiple competing models/, "the false-positive 'competing' usage must survive — it is ordinary technical prose, not a boilerplate heading");
  assert.doesNotMatch(stripped, /primarily funded by the Collaborative Research Centre/, "the real funding/acknowledgment sentence must be removed");
  assert.doesNotMatch(stripped, /no known competing financial interests/, "the real competing-interest declaration must be removed");
  // References itself is a different module's job (lib/reference-section.ts) — this module only needs to stop before it, not strip it.
  assert.match(stripped, /References/, "this module must not reach into the reference section itself — that is reference-section.ts's job");
});

test("REAL FIXTURE: findBoilerplateSections reports both sections in document order with the correct category", () => {
  const sections = findBoilerplateSections(REAL_BAYESVALIDROX_EXCERPT);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].category, "acknowledgment");
  assert.equal(sections[1].category, "competing-interest");
  assert.ok(sections[0].end <= sections[1].start, "sections must be reported in non-overlapping document order");
});

// --- False-positive guards (the whole reason this needs corroboration, not bare keyword matching) ---

test("FALSE POSITIVE GUARD: 'competing' used in ordinary technical prose alone is never stripped", () => {
  const text = "If multiple competing models are given, Bayesian model comparison can be performed via pairwise comparison of the model evidence.";
  assert.equal(findBoilerplateSections(text).length, 0);
  assert.equal(stripBoilerplateSections(text), text);
});

test("FALSE POSITIVE GUARD: 'acknowledge' used in ordinary prose, with no corroborating thanks/funding vocabulary nearby, is never stripped", () => {
  const text = "We acknowledge that this approach has real limitations when generalizing across domains not represented in the training data.";
  assert.equal(findBoilerplateSections(text).length, 0);
  assert.equal(stripBoilerplateSections(text), text);
});

test("FALSE POSITIVE GUARD: 'funding' as genuine subject matter (an economics/policy submission) is never stripped", () => {
  const text = "The paper examines government funding for social programs during the crisis period, drawing on historical budget allocation data across three decades.";
  assert.equal(findBoilerplateSections(text).length, 0, "a real economics paper's own subject matter must never be treated as administrative boilerplate");
  assert.equal(stripBoilerplateSections(text), text);
});

test("FALSE POSITIVE GUARD: an isolated mention of 'grant' in ordinary prose, with no funding-heading keyword present, is never stripped", () => {
  const text = "The city council did not grant the permit request, citing zoning restrictions that had been in place since the original ordinance was passed.";
  assert.equal(findBoilerplateSections(text).length, 0);
});

// --- Synthetic positive cases (one per category, each requiring its own corroboration) ---

test("SYNTHETIC: a standalone Acknowledgments section with thanks/support vocabulary is stripped", () => {
  const text = "The results confirm the hypothesis. Acknowledgments We would like to thank our colleagues at the institute for their support throughout this research. Conclusion The findings have broad implications.";
  const stripped = stripBoilerplateSections(text);
  assert.match(stripped, /results confirm the hypothesis/);
  assert.match(stripped, /findings have broad implications/);
  assert.doesNotMatch(stripped, /thank our colleagues/);
});

test("SYNTHETIC: a standalone Funding section with grant/support vocabulary is stripped", () => {
  const text = "The study concludes here. Funding This work was supported by a grant from the National Science Foundation under award number 12345. Discussion follows.";
  const stripped = stripBoilerplateSections(text);
  assert.match(stripped, /study concludes here/);
  assert.match(stripped, /Discussion follows/);
  assert.doesNotMatch(stripped, /National Science Foundation/);
});

test("SYNTHETIC: a standalone Conflict of Interest declaration is stripped without needing separate corroboration", () => {
  const text = "The model achieves state-of-the-art accuracy. Conflict of Interest The authors declare no conflict of interest. The dataset is publicly available.";
  const stripped = stripBoilerplateSections(text);
  assert.match(stripped, /state-of-the-art accuracy/);
  assert.match(stripped, /dataset is publicly available/);
  assert.doesNotMatch(stripped, /declare no conflict of interest/);
});

test("SYNTHETIC: 'Declaration of Competing Interest' (the alternate common heading phrasing) is also detected", () => {
  const text = "End of results. Declaration of Competing Interest The authors declare that they have no known competing financial interests. Next section begins here.";
  const stripped = stripBoilerplateSections(text);
  assert.doesNotMatch(stripped, /no known competing financial interests/);
  assert.match(stripped, /Next section begins here/);
});

// --- Structural properties ---

test("FORMAT-AGNOSTIC: detection does not depend on newlines being present (PDF-style space-joined text)", () => {
  const withNewlines = "Results are strong.\n\nFunding This work was funded by a national research grant.\n\nDiscussion continues.";
  const withoutNewlines = "Results are strong.  Funding This work was funded by a national research grant.  Discussion continues.";
  assert.doesNotMatch(stripBoilerplateSections(withNewlines), /national research grant/);
  assert.doesNotMatch(stripBoilerplateSections(withoutNewlines), /national research grant/, "PDF-style space-joined text (no newlines) must still be detected");
});

test("a document with no boilerplate section at all is returned completely unchanged", () => {
  const text = "This is a short document with no acknowledgments, funding statement, or competing-interest declaration of any kind, just plain body prose from start to finish.";
  assert.equal(findBoilerplateSections(text).length, 0);
  assert.equal(stripBoilerplateSections(text), text);
});

test("excised spans are replaced with a space, never gluing the surrounding words together", () => {
  const text = "wordbefore. Funding This work was supported by a grant. wordafter";
  const stripped = stripBoilerplateSections(text);
  assert.doesNotMatch(stripped, /wordbeforewordafter/);
  assert.match(stripped, /wordbefore\.\s+wordafter/);
});
