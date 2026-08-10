import assert from "node:assert/strict";
import test from "node:test";
import { selectPhrases, summarizeWebCheck } from "../lib/web-check-core.ts";

const paragraphs = Array.from({ length: 24 }, (_, index) => (
  `Section ${index} examines Interdisciplinary constitutional accountability through `
  + `counterintuitive methodological evidence and independently reproducible observations `
  + `within transnational governance institutions and public administration systems.`
));
const longText = paragraphs.join("\n\n");

test("selects distinctive non-overlapping phrases across a document", () => {
  const phrases = selectPhrases(longText, longText, 10);
  assert.equal(phrases.length, 10);
  assert.equal(phrases.every((phrase) => phrase.text.length > 0 && phrase.normalized.split(" ").length === 9), true);
  assert.equal(phrases.every((phrase, index) => index === 0 || phrase.wordStart - phrases[index - 1].wordStart >= 9), true);
  assert.equal(phrases.at(-1).wordStart > phrases[0].wordStart + 100, true);
  assert.match(phrases[0].text, /Interdisciplinary|constitutional|accountability/);
});

test("does not turn short filler into web evidence", () => {
  assert.deepEqual(selectPhrases("of the study in the case of the study and the", undefined, 20), []);
});

test("summarizes sampled phrase counts without creating a percentage", () => {
  const summary = summarizeWebCheck({
    status: "complete",
    provider: "Wikipedia",
    phrasesSampled: 20,
    phrasesMatched: 4,
    matches: [],
    checkedAt: "2026-08-07T00:00:00.000Z",
    errorCount: 0,
  });
  assert.equal(summary, "4 of 20 sampled phrases found on Wikipedia");
  assert.equal(summary.includes("%"), false);
});
