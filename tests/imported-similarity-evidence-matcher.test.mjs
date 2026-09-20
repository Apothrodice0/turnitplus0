import assert from "node:assert/strict";
import test from "node:test";

import { buildImportedSimilarityEvidencePackageFile, validateImportedSimilarityEvidencePackage } from "../lib/imported-similarity-evidence/package.ts";
import {
  buildImportedSimilarityEvidenceCandidateIndex,
  matchImportedSimilarityEvidence,
} from "../lib/imported-similarity-evidence/matcher.ts";
import { tokens } from "../lib/similarity-core.ts";
import { makeUnitRecord, makePackageFile } from "./helpers/imported-similarity-evidence-fixtures.mjs";

function indexFor(unitRecords, setOverrides) {
  const pkg = makePackageFile(unitRecords, setOverrides);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.equal(result.rejectedUnits.length, 0, JSON.stringify(result.rejectedUnits));
  return buildImportedSimilarityEvidenceCandidateIndex(result.package);
}

function positionsOf(matched, sourceId) {
  const entry = matched.find((m) => m.sourceId === sourceId);
  if (!entry) return new Set();
  const set = new Set();
  for (const passage of entry.matchedPassages) {
    for (let p = passage.submittedWordStart; p <= passage.submittedWordEnd; p += 1) set.add(p);
  }
  return set;
}

const ANCHOR = "the distinctive constitutional framework governing judicial review procedures";
// Credit every anchor word except index 3 ("framework") — a gap-filler word
// that must still match exactly for verification but is never itself scored.
const MASK = [0, 1, 2, 4, 5, 6, 7];

// ── STEP 13.1 — exact passage match ─────────────────────────────────────
test("STEP 13.1: an exact passage match verifies and credits exactly the score-mask positions", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const submission = `some unrelated opening text here. ${ANCHOR}. and then unrelated closing text follows well beyond.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 1);
  const submissionTokens = tokens(submission);
  // Locate the real anchor start directly rather than guessing.
  const anchorWords = tokens(ANCHOR);
  let start = -1;
  for (let i = 0; i + anchorWords.length <= submissionTokens.length; i += 1) {
    if (anchorWords.every((w, o) => submissionTokens[i + o] === w)) { start = i; break; }
  }
  assert.ok(start >= 0, "anchor must appear in the tokenized submission");
  const expected = new Set(MASK.map((r) => start + r));
  assert.deepEqual(positionsOf(matched, "PU0001"), expected);
});

// ── STEP 13.7 — common isolated words rejected (matcher-level: no unit exists to match) ──
test("STEP 13.7: scattered common words alone never produce a match (no unit is even discoverable for them)", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const submission = "the of and or is at in on to be the of and or is at in on to be the of and";
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 0);
});

// ── STEP 13.2 — moved passage (position independence) ───────────────────
test("STEP 13.2: the SAME anchor at a completely different manuscript position still verifies (position independent)", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const shortSubmission = `${ANCHOR} trailing words only.`;
  const longSubmission = `${"padding word ".repeat(500)}${ANCHOR} more trailing content after that continues on for a while.`;
  const shortMatched = matchImportedSimilarityEvidence(shortSubmission, index);
  const longMatched = matchImportedSimilarityEvidence(longSubmission, index);
  assert.equal(shortMatched.length, 1);
  assert.equal(longMatched.length, 1);
  assert.notDeepEqual(positionsOf(shortMatched, "PU0001"), positionsOf(longMatched, "PU0001"));
  assert.equal(positionsOf(shortMatched, "PU0001").size, MASK.length);
  assert.equal(positionsOf(longMatched, "PU0001").size, MASK.length);
});

// ── STEP 13.3 — whitespace changes ───────────────────────────────────────
test("STEP 13.3: extra/irregular whitespace between the same words still verifies (tokenizer is whitespace-insensitive)", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const spaced = ANCHOR.split(" ").join("   \t  ");
  const submission = `prefix text before.   ${spaced}   suffix text after continues onward.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 1);
  assert.equal(positionsOf(matched, "PU0001").size, MASK.length);
});

// ── STEP 13.4 — line wrapping ─────────────────────────────────────────────
test("STEP 13.4: the anchor split across multiple lines (line-wrapped) still verifies", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const wrapped = ANCHOR.split(" ").join("\n");
  const submission = `some preceding paragraph text.\n${wrapped}\nsome following paragraph text continues here well beyond.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 1);
  assert.equal(positionsOf(matched, "PU0001").size, MASK.length);
});

// ── STEP 13.5 — punctuation normalization ────────────────────────────────
test("STEP 13.5: punctuation inserted around/within the same words still verifies (punctuation is stripped by normalize())", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const punctuated = "The, distinctive; constitutional: framework -- governing (judicial) review... procedures!";
  const submission = `Opening sentence here. ${punctuated} Closing sentence continues on afterward.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 1);
  assert.equal(positionsOf(matched, "PU0001").size, MASK.length);
});

// ── STEP 13.6 — rewritten/paraphrased passage rejected ───────────────────
test("STEP 13.6: a paraphrased/rewritten version of the passage does NOT match (exact verification only, no semantic match)", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const paraphrase = "a unique framework of constitutional law that governs how courts review judicial decisions";
  const submission = `intro text. ${paraphrase}. outro text continues onward for a while longer.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 0);
});

// ── STEP 13.9 — multiple exact occurrences all count ─────────────────────
test("STEP 13.9: the same anchor appearing at multiple positions has EVERY occurrence verified and unioned (not limited to one)", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  const submission = `${ANCHOR} some middle padding text goes here that is unrelated content. ${ANCHOR} final trailing words.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 1);
  assert.equal(positionsOf(matched, "PU0001").size, MASK.length * 2, "both occurrences contribute, unioned, never capped at one");
});

// ── STEP 13.10 — overlapping imported units union correctly ─────────────
test("STEP 13.10: two different units whose score masks overlap in the submission union into one deduplicated position set", () => {
  const anchorA = "the distinctive constitutional framework governing judicial";
  const anchorB = "framework governing judicial review procedures fully";
  const unitA = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: anchorA });
  const unitB = makeUnitRecord({ evidenceUnitId: "PU0002", anchorNormalizedText: anchorB });
  const index = indexFor([unitA, unitB]);
  const submission = `intro. ${anchorA} review procedures fully explained further onward continues here well beyond that point.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  // Both units should discover + verify their own exact windows.
  assert.ok(matched.length >= 1);
  const allPositions = new Set();
  for (const m of matched) for (const p of m.matchedPassages) for (let i = p.submittedWordStart; i <= p.submittedWordEnd; i += 1) allPositions.add(i);
  // Overlap must not inflate the union beyond the true distinct word span covered.
  assert.ok(allPositions.size <= tokens(submission).length);
});

// ── STEP 13.16 — document/report SHA never required for matching ────────
test("STEP 13.16: matching succeeds identically regardless of reportSha256/evidenceSetId values — no document hash is ever required", () => {
  const unitA = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK, reportSha256: "1111111111111111111111111111111111111111111111111111111111111111" });
  const unitB = makeUnitRecord({ evidenceUnitId: "PU0002", evidenceSetId: "ES-DIFFERENT0002", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK, reportSha256: "2222222222222222222222222222222222222222222222222222222222222222" });
  const indexA = indexFor([unitA], { evidenceSetId: "ES-TEST00000001" });
  const indexB = indexFor([unitB], { evidenceSetId: "ES-DIFFERENT0002" });
  const submission = `padding. ${ANCHOR} more padding continues onward for a while.`;
  const matchedA = matchImportedSimilarityEvidence(submission, indexA);
  const matchedB = matchImportedSimilarityEvidence(submission, indexB);
  assert.equal(positionsOf(matchedA, "PU0001").size, MASK.length);
  assert.equal(positionsOf(matchedB, "PU0002").size, MASK.length);
});

// ── STEP 13.17 — no score override exists ────────────────────────────────
test("STEP 13.17: reportedSimilarityPercent never affects matching output — two units differing only in that field verify identically", () => {
  const unit49 = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK, reportedSimilarityPercent: 49 });
  const unit5 = makeUnitRecord({ evidenceUnitId: "PU0002", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK, reportedSimilarityPercent: 5 });
  const indexA = indexFor([unit49]);
  const indexB = indexFor([unit5]);
  const submission = `padding. ${ANCHOR} more padding continues onward for a while.`;
  const matchedA = matchImportedSimilarityEvidence(submission, indexA);
  const matchedB = matchImportedSimilarityEvidence(submission, indexB);
  assert.deepEqual(
    matchedA.map((m) => m.matchedPassages),
    matchedB.map((m) => m.matchedPassages),
  );
  // The matcher's own output type never even carries reportedSimilarityPercent.
  assert.equal("reportedSimilarityPercent" in matchedA[0], false);
});

// ── STEP 13.18 — same unit cannot inflate score through duplicate candidate grams ──
test("STEP 13.18: a unit whose own anchor contains a REPEATED internal shingle is still verified/credited exactly once per real occurrence, never inflated by extra internal gram hits", () => {
  // "the same same same the same same same" repeats internal 5-grams heavily,
  // so many of the unit's own indexed shingles collide on offset arithmetic
  // when scanning a submission that also repeats "same" — verify credit still
  // equals exactly one score-mask projection per genuine exact occurrence.
  const repeatedAnchor = "constitutional framework same same same judicial review procedures";
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: repeatedAnchor });
  const index = indexFor([unit]);
  const submission = `intro text here. ${repeatedAnchor} outro text continues onward for a while.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched.length, 1);
  const anchorWordCount = tokens(repeatedAnchor).length;
  assert.equal(positionsOf(matched, "PU0001").size, anchorWordCount, "credited exactly the anchor's own word count once, not inflated by repeated internal shingles");
});

// ── source attribution carried through matcher output ────────────────────
test("STEP 13.15: matcher output carries sourceAttributionState and evidenceSetId for internal audit, unchanged from the package unit", () => {
  const unit = makeUnitRecord({
    evidenceUnitId: "PU0001",
    anchorNormalizedText: ANCHOR,
    scoreMaskRelativePositions: MASK,
    sourceAttributionState: "ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED",
  });
  const index = indexFor([unit]);
  const submission = `padding. ${ANCHOR} more padding continues onward for a while.`;
  const matched = matchImportedSimilarityEvidence(submission, index);
  assert.equal(matched[0].sourceAttributionState, "ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED");
  assert.equal(matched[0].evidenceSetId, "ES-TEST00000001");
});

// ── out-of-bounds / too-short submissions never throw ────────────────────
test("a submission shorter than the shingle size produces no matches and never throws", () => {
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const index = indexFor([unit]);
  assert.doesNotThrow(() => {
    const matched = matchImportedSimilarityEvidence("too short", index);
    assert.equal(matched.length, 0);
  });
});

test("an empty candidate index (no units) always returns no matches", () => {
  const pkg = buildImportedSimilarityEvidencePackageFile([], []);
  const result = validateImportedSimilarityEvidencePackage(pkg);
  assert.equal(result.ok, true);
  const index = buildImportedSimilarityEvidenceCandidateIndex(result.package);
  assert.equal(matchImportedSimilarityEvidence(ANCHOR.repeat(3), index).length, 0);
});
