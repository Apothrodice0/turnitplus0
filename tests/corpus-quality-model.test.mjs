import assert from "node:assert/strict";
import test from "node:test";
import { computeCorpusFeatureVector } from "../lib/corpus-quality-signals.ts";
import { computeCorpusQualityScore, CORPUS_QUALITY_WEIGHTS } from "../lib/corpus-quality-model.ts";

function distinctWords(count, prefix = "word") {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

function sentence(n) {
  const words = ["the", "study", "examined", "several", "important", "factors", "affecting", "outcomes", "across", "many", "distinct", "regions", "over", "time"];
  return Array.from({ length: n }, (_, i) => words[i % words.length]).join(" ") + ".";
}

function plausibleArticle(paragraphs = 20, sentencesPerParagraph = 6) {
  return Array.from({ length: paragraphs }, () =>
    Array.from({ length: sentencesPerParagraph }, () => sentence(12 + Math.floor(Math.random() * 15))).join(" "),
  ).join("\n\n");
}

test("every weight in CORPUS_QUALITY_WEIGHTS is structurally ENGINEERING_DEFAULT — no invented 'calibrated' number", () => {
  for (const [key, weight] of Object.entries(CORPUS_QUALITY_WEIGHTS)) {
    assert.equal(weight.status, "ENGINEERING_DEFAULT", `weight for "${key}" must be ENGINEERING_DEFAULT pending calibration`);
    assert.ok(weight.rationale.length > 0, `weight for "${key}" must carry a rationale`);
  }
});

test("component scores and overall qualityScore are always within [0,100]", () => {
  const vector = computeCorpusFeatureVector(plausibleArticle());
  const result = computeCorpusQualityScore(vector);
  assert.ok(result.qualityScore >= 0 && result.qualityScore <= 100);
  for (const [key, score] of Object.entries(result.componentScores)) {
    assert.ok(score >= 0 && score <= 100, `component "${key}" score ${score} out of [0,100]`);
  }
});

test("a plausible, well-structured English article scores meaningfully higher than gibberish symbol noise", () => {
  const article = plausibleArticle();
  const gibberish = "%%%$$$ ###@@@ !!!*** )))((( &&&^^^ ~~~```".repeat(200);
  const articleScore = computeCorpusQualityScore(computeCorpusFeatureVector(article)).qualityScore;
  const gibberishScore = computeCorpusQualityScore(computeCorpusFeatureVector(gibberish)).qualityScore;
  assert.ok(articleScore > gibberishScore + 20, `expected article (${articleScore}) to clearly outscore gibberish (${gibberishScore})`);
});

test("a legitimate table-heavy article lands in a moderate-to-good band, not near zero, on its articleComposition component alone", () => {
  const body = plausibleArticle(10);
  const table = Array.from({ length: 30 }, (_, i) => `${i}\t${i * 2}\t${i * 3}\t${i * 4}\t${i * 5}`).join("\n");
  const vector = computeCorpusFeatureVector(`${body}\n\n${table}\n\n${body}`);
  const result = computeCorpusQualityScore(vector);
  assert.ok(result.componentScores.articleComposition > 30, `table-heavy legitimate content should not be scored near zero for composition, got ${result.componentScores.articleComposition}`);
});

test("a legitimate bibliography-heavy paper is not driven to a near-zero overall score by references alone", () => {
  const body = plausibleArticle(15);
  const references = Array.from({ length: 60 }, (_, i) => `${i + 1}. Author${i}, X. (20${10 + (i % 15)}). Title of study number ${i}. Journal of Examples, ${i}, ${i * 2}-${i * 2 + 10}.`).join("\n");
  const vector = computeCorpusFeatureVector(`${body}\n\nReferences\n${references}`);
  const result = computeCorpusQualityScore(vector);
  assert.ok(result.qualityScore > 30, `bibliography-heavy legitimate paper should not collapse to a near-zero score, got ${result.qualityScore}`);
});
