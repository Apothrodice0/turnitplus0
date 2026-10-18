import assert from "node:assert/strict";
import test from "node:test";
import { nominateRareSeedCandidates } from "../lib/archive-phrase-fallback.ts";

// A source passage the submission repeats: its 5-grams are resolved once (at
// their first occurrence) but are seeds at every unmatched occurrence, so the
// longest occurrence can carry the window support. Support counts DISTINCT
// grams, so a single repeated gram never nominates a document by itself.
const seed = (position, ids, hash) => ({ position, df: 1, representationIds: ids, hash });

test("one 5-gram repeated three times in a window does not nominate", () => {
  assert.deepEqual(nominateRareSeedCandidates([seed(10, ["x"], "h1"), seed(15, ["x"], "h1"), seed(20, ["x"], "h1")], []), []);
});

test("three distinct grams of a repeated passage nominate at the later occurrence", () => {
  // first occurrence (positions 10, 15) is too short; the second occurrence holds three distinct grams
  const seeds = [seed(10, ["x"], "a"), seed(15, ["x"], "b"), seed(400, ["x"], "a"), seed(405, ["x"], "b"), seed(410, ["x"], "c")];
  assert.deepEqual(nominateRareSeedCandidates(seeds, []), ["x"]);
});

test("a gram counted once per window still lets other distinct grams count", () => {
  const seeds = [seed(0, ["x"], "a"), seed(5, ["x"], "a"), seed(10, ["x"], "b"), seed(15, ["x"], "c")];
  assert.deepEqual(nominateRareSeedCandidates(seeds, []), ["x"]);
});

test("seeds without a hash keep the previous behaviour (each position distinct)", () => {
  const plain = (position) => ({ position, df: 1, representationIds: ["x"] });
  assert.deepEqual(nominateRareSeedCandidates([plain(10), plain(15), plain(20)], []), ["x"]);
  assert.deepEqual(nominateRareSeedCandidates([plain(10), plain(20)], []), []);
});
