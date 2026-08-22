import assert from "node:assert/strict";
import test from "node:test";
import { computeCorpusFeatureVector } from "../lib/corpus-quality-signals.ts";

function distinctWords(count, prefix = "word") {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

test("MATTR is length-resistant: repeating the same vocabulary 5x barely moves MATTR, while naive uniqueWords/totalWords collapses", () => {
  const base = distinctWords(300) + ". " + distinctWords(300, "term"); // ~600 distinct-ish words, well over the 50-word window
  const padded = `${base} ${base} ${base} ${base} ${base}`; // same content repeated 5x — a padding/duplication scenario

  const baseVector = computeCorpusFeatureVector(base);
  const paddedVector = computeCorpusFeatureVector(padded);

  const baseWords = base.trim().split(/\s+/);
  const paddedWords = padded.trim().split(/\s+/);
  const naiveBase = new Set(baseWords.map((w) => w.toLowerCase())).size / baseWords.length;
  const naivePadded = new Set(paddedWords.map((w) => w.toLowerCase())).size / paddedWords.length;

  assert.ok(naiveBase / naivePadded > 3, `naive TTR should collapse dramatically under padding (base=${naiveBase}, padded=${naivePadded})`);
  assert.ok(
    Math.abs(baseVector.linguisticQuality.mattr - paddedVector.linguisticQuality.mattr) < 0.1,
    `MATTR should stay roughly stable under padding (base=${baseVector.linguisticQuality.mattr}, padded=${paddedVector.linguisticQuality.mattr})`,
  );
});

test("URL-heavy text produces a high urlDensityPer1000Words", () => {
  const urls = Array.from({ length: 20 }, (_, i) => `See https://example.com/article/${i} for details.`).join(" ");
  const vector = computeCorpusFeatureVector(urls + " " + distinctWords(200));
  assert.ok(vector.contamination.urlCount >= 20);
  assert.ok(vector.contamination.urlDensityPer1000Words > 0);
});

test("leftover markup tags are detected as contamination", () => {
  const text = `<div class="wrapper"><p>${distinctWords(300)}</p></div> <span>more</span>`;
  const vector = computeCorpusFeatureVector(text);
  assert.ok(vector.contamination.markupTagCount >= 3);
});

test("padded code-like content produces high codeTokenDensityPer1000Words", () => {
  const code = Array.from({ length: 50 }, (_, i) => `function calc${i}() { return ${i} == 0; }`).join(" ");
  const vector = computeCorpusFeatureVector(code);
  assert.ok(vector.contamination.codeTokenDensityPer1000Words > 100);
});

test("repeated paragraphs are detected via repeatedParagraphRatio", () => {
  const paragraph = "This exact paragraph appears more than once in the same document on purpose for this test.";
  const text = [paragraph, "A distinct unrelated paragraph about something else entirely for contrast.", paragraph, paragraph].join("\n\n");
  const vector = computeCorpusFeatureVector(text);
  assert.ok(vector.redundancy.repeatedParagraphRatio > 0);
});

test("a repeated 5-10 word shingle is detected via repeatedShingleRatio", () => {
  const phrase = "the quick brown fox jumps over the lazy dog repeatedly";
  const text = `${phrase} in a field. Later that same day, ${phrase} again near the barn. Eventually, ${phrase} once more at dusk.`;
  const vector = computeCorpusFeatureVector(text);
  assert.ok(vector.redundancy.repeatedShingleRatio > 0);
});

test("dominant token frequency is detected when one informative word is repeated far more than any other", () => {
  const spam = "aardvarkoutlier ".repeat(400) + distinctWords(100);
  const vector = computeCorpusFeatureVector(spam);
  assert.ok(vector.redundancy.dominantTokenFrequencyRatio > 0.5);
});

test("a long identical character run (padded/duplicated text) is detected, and the detector completes quickly on a large document", () => {
  const block = "x".repeat(300);
  const text = distinctWords(2000) + " " + block + " " + distinctWords(2000) + " " + block;
  const startedAt = Date.now();
  const vector = computeCorpusFeatureVector(text);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(vector.redundancy.longestIdenticalRunChars >= 200, `expected a long identical run to be found, got ${vector.redundancy.longestIdenticalRunChars}`);
  assert.ok(elapsedMs < 3000, `feature-vector computation on a ~10k-word document took ${elapsedMs}ms, expected well under 3000ms`);
});

test("performance: a large (~300k character) document completes feature-vector computation in bounded time — the O(n) rolling-hash design, not O(n^2)", () => {
  const large = distinctWords(40000);
  const startedAt = Date.now();
  computeCorpusFeatureVector(large);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5000, `large-document feature-vector computation took ${elapsedMs}ms, expected under 5000ms`);
});

test("article composition: a genuine reference section is detected and excluded from body proportion", () => {
  const body = distinctWords(400);
  const references = [
    "References",
    "1. Smith, J. (2020). A study of migratory patterns. Journal of Field Studies, 12(3), 45-67.",
    "2. Doe, A. and Roe, B. (2019). Observations on coastal ecosystems. Proceedings of Ecology, 5, 10-20.",
    "3. Lee, C. (2021). Climate variability review. Annual Review of Climate, 8, 100-130.",
  ].join("\n");
  const vector = computeCorpusFeatureVector(`${body}\n\n${references}`);
  assert.ok(vector.articleComposition.referenceSectionProportion > 0, "a real reference section should be detected");
  assert.ok(vector.articleComposition.bodyTextProportion < 1);
});

test("a table-heavy region increases tableProportion", () => {
  const body = distinctWords(300);
  const table = Array.from({ length: 10 }, (_, i) => `${i}\t${i * 2}\t${i * 3}\t${i * 4}`).join("\n");
  const vector = computeCorpusFeatureVector(`${body}\n\n${table}`);
  assert.ok(vector.articleComposition.tableProportion > 0);
});

test("word count is language-agnostic (Arabic script counted correctly)", () => {
  const arabic = "مرحبا بكم في هذا المقال العلمي الذي يتناول موضوعا مهما جدا في هذا المجال الواسع";
  const vector = computeCorpusFeatureVector(arabic);
  assert.ok(vector.linguisticQuality.wordCount > 0);
  assert.equal(vector.linguisticQuality.detectedLanguage, "Arabic");
});
