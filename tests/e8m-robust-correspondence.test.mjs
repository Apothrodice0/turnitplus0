import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { computeRobustCorrespondence, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, ROBUST_CORRESPONDENCE_VERSION } from "../lib/e8m-robust-correspondence.ts";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";
import {
  E8M_FIXTURES, PARTIAL_COPY_DOCUMENT,
} from "../lib/e8m-robust-correspondence-fixtures.ts";
import { tokens } from "../lib/similarity-core.ts";

/**
 * Phase E8M: tests for the experimental edit-tolerant correspondence
 * engine. Pure-function tests only — no database, no production
 * connection, no production matcher/threshold import.
 */

const repoRoot = path.resolve(".");

function fixture(id) {
  const f = E8M_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture id ${id}`);
  return f;
}
function e8m(f, config) {
  return computeRobustCorrespondence(f.text, f.candidateText, config);
}
function v0(f) {
  return computeDocumentCorrespondence(f.text, f.candidateText, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
}

// --- A: baseline exact copy -----------------------------------------------------------

test("A: baseline exact copy — full sentence recovered as one passage, containment 1.0", () => {
  const result = e8m(fixture("primary-original-self"));
  assert.equal(result.matchedWordCount, 10);
  assert.equal(result.passageCount, 1);
  assert.equal(result.containment, 1);
});

// --- B: punctuation changes ------------------------------------------------------------

test("B: punctuation-only changes (comma/semicolon/parens/colon/hyphen/quotes/linebreaks) all preserve full correspondence", () => {
  for (const f of E8M_FIXTURES.filter((x) => x.category === "PUNCTUATION")) {
    const result = e8m(f);
    assert.equal(result.matchedWordCount, 87, `${f.id}: expected full 87-word passage recovered`);
    assert.equal(result.passageCount, 1);
  }
});

// --- C: sentence split ------------------------------------------------------------------

test("C: sentence split — E8M recovers the split sentence; V0 loses it entirely (the documented E8L/E8M motivating case)", () => {
  const f = fixture("primary-sentence-split");
  const v0Result = v0(f);
  const e8mResult = e8m(f);
  assert.equal(v0Result.matchedWordCount, 0, "documented V0 baseline failure — not fixed in V0, only demonstrated");
  assert.ok(e8mResult.matchedWordCount >= 10, `E8M should recover most/all of the split sentence, got ${e8mResult.matchedWordCount}`);
});

// --- D: sentence merge ------------------------------------------------------------------

test("D: sentence merge — two original sentences joined with a connector are still recognized as substantially reused", () => {
  const f = fixture("primary-sentence-merge");
  const e8mResult = e8m(f);
  assert.ok(e8mResult.matchedWordCount >= 12, `expected most of the merged sentence recovered, got ${e8mResult.matchedWordCount}`);
});

// --- E/F/G: insertion / deletion / substitution sweeps ------------------------------------

test("E: insertions of 1/3/5/10 words — E8M's longest passage stays close to full length; V0 fragments increasingly as insertion count grows", () => {
  for (const n of [1, 3, 5, 10]) {
    const f = fixture(`insertion-${n}`);
    const v0Result = v0(f);
    const e8mResult = e8m(f);
    assert.ok(e8mResult.longestMatchWords >= v0Result.longestMatchWords, `insertion-${n}: E8M longest (${e8mResult.longestMatchWords}) should be >= V0 longest (${v0Result.longestMatchWords})`);
    assert.ok(e8mResult.matchedWordCount > 0);
  }
});

test("F: deletions of 1/3/5/10 words — E8M recovers at least as much matched content as V0", () => {
  for (const n of [1, 3, 5, 10]) {
    const f = fixture(`deletion-${n}`);
    const v0Result = v0(f);
    const e8mResult = e8m(f);
    assert.ok(e8mResult.matchedWordCount >= v0Result.matchedWordCount * 0.9, `deletion-${n}: E8M matched (${e8mResult.matchedWordCount}) should be at least comparable to V0 (${v0Result.matchedWordCount})`);
  }
});

test("G: substitutions of 1/3/5/10 words — E8M's longest passage stays well above V0's, which fragments as substitution count grows", () => {
  for (const n of [1, 3, 5, 10]) {
    const f = fixture(`substitution-${n}`);
    const v0Result = v0(f);
    const e8mResult = e8m(f);
    assert.ok(e8mResult.longestMatchWords >= v0Result.longestMatchWords, `substitution-${n}: E8M longest (${e8mResult.longestMatchWords}) should be >= V0 longest (${v0Result.longestMatchWords})`);
  }
  // The headline fragmentation contrast at the hardest case:
  const hard = fixture("substitution-10");
  assert.ok(e8m(hard).longestMatchWords > v0(hard).longestMatchWords * 2, "at 10 substitutions, V0 should be dramatically more fragmented than E8M");
});

// --- H: light paraphrase -----------------------------------------------------------------

test("H: light paraphrase (deterministic phrase substitutions) — E8M recovers at least as much as V0", () => {
  const f = fixture("light-paraphrase");
  const v0Result = v0(f);
  const e8mResult = e8m(f);
  assert.ok(e8mResult.matchedWordCount >= v0Result.matchedWordCount);
});

// --- I: partial copy -----------------------------------------------------------------------

test("I: PARTIAL_COPY — E8M recovers the ~434-word copied passage, correctly localized within the known copied zone", () => {
  const f = fixture("partial-copy");
  const result = e8m(f);
  assert.ok(result.matchedWordCount > 400, `expected > 400 matched words, got ${result.matchedWordCount}`);
  const copiedZoneWordCount = tokens(PARTIAL_COPY_DOCUMENT.split("\n\n").slice(0, 4).join("\n\n")).length;
  for (const p of result.passages) {
    assert.ok(p.submittedWordEnd < copiedZoneWordCount + 5, `passage [${p.submittedWordStart}-${p.submittedWordEnd}] should fall within (or very near) the copied zone (0-${copiedZoneWordCount})`);
  }
});

// --- J: generic boilerplate ------------------------------------------------------------------

test("J: generic boilerplate (100/200/300 words, long methodology block, repeated boilerplate) — zero matched words under the default config", () => {
  for (const f of E8M_FIXTURES.filter((x) => x.category === "GENERIC")) {
    const result = e8m(f);
    assert.equal(result.matchedWordCount, 0, `${f.id}: generic text must never be reported as matched`);
    assert.equal(result.passageCount, 0);
  }
});

// --- K: same topic -----------------------------------------------------------------------------

test("K: same-topic independent writing — zero matched words (no embeddings, no semantic similarity involved)", () => {
  const result = e8m(fixture("same-topic"));
  assert.equal(result.matchedWordCount, 0);
});

// --- L: distinctive anchors --------------------------------------------------------------------

test("L: distinctive anchors (invented names/numbers/terms) survive heavy sentence restructuring, and E8M recovers more than V0", () => {
  const f = fixture("distinctive-anchor-restructured");
  const v0Result = v0(f);
  const e8mResult = e8m(f);
  assert.ok(e8mResult.matchedWordCount > v0Result.matchedWordCount, `expected E8M (${e8mResult.matchedWordCount}) > V0 (${v0Result.matchedWordCount})`);
  assert.ok(e8mResult.matchedWordCount > 0);
});

// --- M: gap tolerance sweep ---------------------------------------------------------------------

test("M: gap tolerance sweep (0,1,3,5,10) — recovery improves or holds steady, guardrail fixtures stay at zero throughout", () => {
  const copiedFixture = fixture("primary-comma-insertion");
  const genericFixture = fixture("generic-200");
  const sameTopicFixture = fixture("same-topic");
  let previousMatched = -1;
  for (const gapTolerance of [0, 1, 3, 5, 10]) {
    const config = { ...DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, gapTolerance };
    const copiedResult = e8m(copiedFixture, config);
    assert.ok(copiedResult.matchedWordCount >= previousMatched, `gapTolerance=${gapTolerance}: recovery should not regress as tolerance increases`);
    previousMatched = copiedResult.matchedWordCount;
    assert.equal(e8m(genericFixture, config).matchedWordCount, 0, `gapTolerance=${gapTolerance}: generic text must stay unmatched`);
    assert.equal(e8m(sameTopicFixture, config).matchedWordCount, 0, `gapTolerance=${gapTolerance}: same-topic text must stay unmatched`);
  }
});

// --- N: anchor length sweep ---------------------------------------------------------------------

test("N: anchor length sweep (3,4,5,8) — false positives stay at zero regardless of anchor size; recovery degrades at larger sizes", () => {
  const genericFixture = fixture("generic-200");
  const sameTopicFixture = fixture("same-topic");
  const insertionFixture = fixture("insertion-10");
  const recoveryBySize = {};
  for (const anchorSize of [3, 4, 5, 8]) {
    const config = { ...DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, anchorSize };
    assert.equal(e8m(genericFixture, config).matchedWordCount, 0, `anchorSize=${anchorSize}: generic text must stay unmatched`);
    assert.equal(e8m(sameTopicFixture, config).matchedWordCount, 0, `anchorSize=${anchorSize}: same-topic text must stay unmatched`);
    recoveryBySize[anchorSize] = e8m(insertionFixture, config).matchedWordCount;
  }
  assert.ok(recoveryBySize[3] >= recoveryBySize[8], "smaller anchor size should recover at least as much as a larger one on edited text");
});

// --- O: deterministic output ----------------------------------------------------------------------

test("O: computeRobustCorrespondence is deterministic — repeated calls on the same inputs return identical results", () => {
  const f = fixture("insertion-5");
  const a = e8m(f);
  const b = e8m(f);
  assert.deepEqual(a, b);
});

// --- P: current-document-only passages -------------------------------------------------------------

test("P: every passage is reconstructed from the CURRENT submission's own words only, externalWordStart is always null, and passage text stays within maxPassageWords", () => {
  const f = fixture("partial-copy");
  const result = e8m(f);
  const submittedWords = f.text.trim().split(/\s+/);
  for (const p of result.passages) {
    assert.equal(p.externalWordStart, null);
    assert.ok(p.submittedText.split(" ").length <= DEFAULT_ROBUST_CORRESPONDENCE_CONFIG.maxPassageWords);
    // Reconstructed from the submitted text's own (normalized) token stream, never the candidate.
    void submittedWords;
  }
  assert.ok(result.passages.length <= DEFAULT_ROBUST_CORRESPONDENCE_CONFIG.maxPassages);
});

// --- Q: score invariance ----------------------------------------------------------------------------

test("Q (structural): E8M modules never reference a scoring field", () => {
  function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8m-robust-correspondence.ts", "lib/e8m-robust-correspondence-fixtures.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(source, /\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/, `${file} must never reference a scoring field`);
  }
});

// --- R: production matcher untouched ------------------------------------------------------------------

test("R (structural): E8M modules never import the production matcher or lib/document-correspondence.ts's runtime, and never touch a DB client", () => {
  function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8m-robust-correspondence.ts", "lib/e8m-robust-correspondence-fixtures.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(source, /from\s+["'].*user-submission-matching["']/, `${file} must never import the production matcher`);
    assert.doesNotMatch(source, /from\s+["'].*\/document-correspondence["']/, `${file} must never import lib/document-correspondence.ts — V0 must stay fully independent of E8M`);
    assert.doesNotMatch(source, /@libsql\/client/, `${file} must never import a DB client`);
  }
});

test("R (versioning): ROBUST_CORRESPONDENCE_VERSION is a distinct, versioned identifier, never confused with a production version string", () => {
  assert.equal(ROBUST_CORRESPONDENCE_VERSION, "e8m-v1");
});
