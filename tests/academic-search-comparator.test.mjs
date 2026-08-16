import assert from "node:assert/strict";
import test from "node:test";
import { compareSubmissionToExternalText } from "../lib/academic-search/comparator.ts";

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

test("a shared phrase shorter than the minimum passage length never becomes a reportable matched passage", () => {
  const submitted =
    "Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages under variable nutrient stress conditions rarely documented in prior literature.";
  const external =
    "Distinctive biochemical pathway analysis reveals nothing else in common with the submitted text whatsoever, since every other word differs substantially from this point onward across several unrelated paragraphs describing an entirely different subject.";
  const result = compareSubmissionToExternalText(submitted, external);
  assert.equal(result.matchedPassages.length, 0, "a 5-word shared prefix is below the 8-word minimum passage length and should not surface as a passage");
});
