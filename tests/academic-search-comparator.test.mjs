import assert from "node:assert/strict";
import test from "node:test";
import { compareSubmissionToExternalText } from "../lib/academic-search/comparator.ts";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";

const SHARED_PASSAGE =
  "deep sea plankton colonies exhibit synchronized bioluminescent flashing that propagates across a colony far faster than any individual organisms own reaction time would allow observations collected across multiple expeditions suggest";

test("exact phrase matching: identical whole-document text is an exact canonical match", () => {
  const text =
    "Researchers observed unusual migratory behavior patterns among arctic tern populations during the summer breeding season near the coastal wetlands.";
  const result = compareSubmissionToExternalText(text, text);
  assert.equal(result.exactMatch, true);
  assert.equal(result.similarity, 100);
  assert.equal(result.strongMatch, true);
});

test("REGRESSION (ISSUE 2): an exact canonical match still reports at least one matched passage, not an empty array", () => {
  // computeDocumentCorrespondence's canonical-hash short-circuit (see
  // lib/document-correspondence.ts's own emptyResult() helper) returns the
  // full matchedWordCount but an empty passages array by design — the same
  // gap lib/unified-similarity.ts's previousUploadPassageRanges() already
  // had to work around for its own caller. Since computeUnifiedSimilarity()
  // only ever reads matchedPassages (never the standalone similarity
  // percentage), an unpatched empty array here means a perfectly confirmed
  // 100%-similarity academic match would silently contribute nothing to the
  // unified score. Reproduced live against a real bioRxiv preprint whose
  // own retrieved full text matched itself exactly.
  const text =
    "Researchers observed unusual migratory behavior patterns among arctic tern populations during the summer breeding season near the coastal wetlands.";
  const result = compareSubmissionToExternalText(text, text);
  assert.equal(result.exactMatch, true);
  assert.ok(result.matchedPassages.length > 0, "an exact canonical match must synthesize a passage instead of returning []");
  const totalMatchedWords = result.matchedPassages.reduce((sum, passage) => sum + passage.matchedWordCount, 0);
  assert.ok(totalMatchedWords > 0, "the synthesized passage must carry the real matched word count, not zero");
});

test("near-match handling: a long shared passage embedded in otherwise different surrounding text is detected", () => {
  const submitted = `${SHARED_PASSAGE} in my own analysis this extends further.`;
  const external = `${SHARED_PASSAGE} however the mechanism remains unclear today.`;

  const result = compareSubmissionToExternalText(submitted, external);
  assert.equal(result.exactMatch, false);
  assert.ok(result.similarity > 0, "expected nonzero similarity for a long shared passage");
  assert.ok(result.matchedPassages.length > 0, "expected at least one matched passage");
  assert.equal(result.strongMatch, true, "a 20+ word verbatim shared passage should cross the strong-correspondence floor");
});

test("no-result handling: completely unrelated texts produce zero similarity", () => {
  const submitted = "The committee approved the annual budget after a lengthy discussion about infrastructure spending priorities.";
  const external = "Coral reef ecosystems depend on a delicate balance of temperature, salinity, and light penetration to sustain symbiotic algae.";
  const result = compareSubmissionToExternalText(submitted, external);
  assert.equal(result.similarity, 0);
  assert.deepEqual(result.matchedPassages, []);
  assert.equal(result.strongMatch, false);
  assert.equal(result.exactMatch, false);
});

test("handles empty text without throwing", () => {
  const result = compareSubmissionToExternalText("", "some external text that is otherwise perfectly normal");
  assert.equal(result.similarity, 0);
  assert.deepEqual(result.matchedPassages, []);
});

test("REGRESSION (Accuracy & Coverage Benchmark, 2026-08-21): a match fragmented into more than maxPassages spans is not undercounted", () => {
  // Confirmed live: a genuine full-text exact copy scored comparisonSimilarity
  // 100 but only 59/100 in the unified report, because
  // lib/document-correspondence.ts's `passages` field (thresholds.maxPassages
  // = 10) was the SOLE source this comparator drew matched word positions
  // from — any span beyond the 10 longest was silently dropped from
  // matchedPassages, even though computeDocumentCorrespondence's own
  // matchedWordCount (acceptedPositions.size) already counted it correctly.
  // Reproduce the fragmentation directly: 14 distinct, individually
  // distinctive passages (each far more than the 8-word minimum passage
  // length), separated in the SUBMITTED text by unique unshared filler so
  // acceptedSimilaritySpans never merges them into fewer, larger spans.
  const PHRASE_COUNT = 14;
  const phrases = Array.from({ length: PHRASE_COUNT }, (_, i) => (
    `phrase${i} concerning distinctive polymer crystallization dynamics under cryogenic pressure gradient conditions observed independently`
  ));
  const submitted = phrases
    .map((phrase, i) => `${phrase} unrelatedfillerword${i}a unrelatedfillerword${i}b unrelatedfillerword${i}c`)
    .join(" ");
  const external = phrases.join(" and, separately, elsewhere in the source document, ");

  const correspondence = computeDocumentCorrespondence(submitted, external, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
  assert.ok(
    correspondence.allMatchedPassages.length > DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassages,
    `fixture must exceed maxPassages to reproduce the bug — got ${correspondence.allMatchedPassages.length} spans`,
  );

  const result = compareSubmissionToExternalText(submitted, external);
  const totalMatchedWords = result.matchedPassages.reduce((sum, passage) => sum + passage.matchedWordCount, 0);
  assert.equal(
    totalMatchedWords,
    correspondence.matchedWordCount,
    "every accepted span's words must reach the comparator's matchedPassages, not just the top maxPassages(10)",
  );
  assert.ok(result.matchedPassages.length > DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassages, "matchedPassages must not be truncated to maxPassages");
});

test("a shared phrase shorter than the minimum passage length never becomes a reportable matched passage", () => {
  const submitted =
    "Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages under variable nutrient stress conditions rarely documented in prior literature.";
  const external =
    "Distinctive biochemical pathway analysis reveals nothing else in common with the submitted text whatsoever, since every other word differs substantially from this point onward across several unrelated paragraphs describing an entirely different subject.";
  const result = compareSubmissionToExternalText(submitted, external);
  assert.equal(result.matchedPassages.length, 0, "a 5-word shared prefix is below the 8-word minimum passage length and should not surface as a passage");
});
