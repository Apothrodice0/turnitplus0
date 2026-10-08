import assert from "node:assert/strict";
import test from "node:test";
import { tokenSpans } from "../lib/similarity-core.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";

/**
 * GOLD HIGHLIGHT EXACTNESS — an Archive source's highlights come from its
 * scorer-attributed word ranges, not from re-matching its phrases. Phrases
 * miss scored words (a stable-union remainder shorter than one shingle has no
 * phrase; the tolerant span extension adds words without a phrase) and paint
 * unscored repeats of the same wording. On the environmental Gold DOCX 3 of
 * 360 scored words went unhighlighted; on 97 independent documents 270 scored
 * words did, and 88 carried another source's label.
 */

const TEXT = [
  "Law No. 03-10 on environmental protection within the framework of sustainable development.",
  "Article 3, in particular, enshrined general principles of the environmental code.",
  "A later paragraph repeats environmental protection within the framework of sustainable development once more.",
].join(" ");

const source = (name, phrases, attributedRanges) => ({
  name,
  type: "Publication",
  color: "#d7263d",
  matches: attributedRanges?.length ?? phrases.length,
  matchedWords: 0,
  percent: 0,
  phrases,
  ...(attributedRanges ? { attributedRanges } : {}),
});

const report = (sources) => ({ text: TEXT, sources, scoringNormalizationVersion: 2 });

function highlighted(value) {
  const spans = tokenSpans(value.text, 2);
  const ranges = findHighlightRanges(value, { includeWikipedia: false }).filter((range) => range.kind !== "uncertain");
  const words = new Map();
  spans.forEach((span, index) => {
    const range = ranges.find((candidate) => span.start >= candidate.start && span.end <= candidate.end);
    if (range) words.set(index, range.label);
  });
  return words;
}

const span = (start, end) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset);

test("a scored remainder shorter than one shingle is highlighted under its own source", () => {
  // words 4..12 "on environmental … development" owned by A; 13..14 "article 3" owned by B (no phrase: < 5 words)
  const words = highlighted(report([
    source("Source A", ["on environmental protection within the framework of sustainable development"], [[4, 12]]),
    source("Source B", [], [[13, 14]]),
  ]));
  assert.deepEqual([...words.keys()].sort((a, b) => a - b), span(4, 14));
  for (const position of span(4, 12)) assert.equal(words.get(position), "Source A");
  for (const position of span(13, 14)) assert.equal(words.get(position), "Source B");
});

test("words the span extension added after the phrases were built are highlighted", () => {
  const words = highlighted(report([
    source("Source A", ["on environmental protection within the framework"], [[4, 14]]),
  ]));
  assert.deepEqual([...words.keys()].sort((a, b) => a - b), span(4, 14));
});

test("an unscored repeat of a scored source's wording is not highlighted", () => {
  const words = highlighted(report([
    source("Source A", ["environmental protection within the framework of sustainable development"], [[5, 12]]),
  ]));
  assert.deepEqual([...words.keys()].sort((a, b) => a - b), span(5, 12));
});

test("an unscored word between two runs of one source stays unhighlighted", () => {
  // "of sustainable development" [10..12] and "3 in particular" [14..16]; "article" (13) is not scored
  const words = highlighted(report([source("Source A", [], [[10, 12], [14, 16]])]));
  assert.equal(words.has(13), false);
  assert.deepEqual([...words.keys()].sort((a, b) => a - b), [...span(10, 12), ...span(14, 16)]);
});

test("reports without attributedRanges, or with ranges outside the text, keep phrase highlighting", () => {
  const phrase = "environmental protection within the framework of sustainable development";
  const legacy = highlighted(report([source("Source A", [phrase])]));
  const invalid = highlighted(report([source("Source A", [phrase], [[5, 9999]])]));
  // the phrase regex paints both occurrences, exactly as before
  assert.equal(legacy.size, 16);
  assert.deepEqual([...invalid.keys()], [...legacy.keys()]);
});
