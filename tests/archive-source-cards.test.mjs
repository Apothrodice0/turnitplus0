import assert from "node:assert/strict";
import test from "node:test";

import { normalizeArchiveEvidence } from "../lib/evidence-interpretation/index.ts";
import { archiveSourceAccounting, archiveSourceCountLabel } from "../lib/evidence-interpretation/archive-source-accounting.ts";
import { SOURCE_TYPE_BADGE, matchingEvidenceEntriesLabel } from "../lib/report-v2-view.ts";

// Archive union: words 0..19 and 30..39 (30 words). Each source owns a disjoint part of it.
const UNION = [...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 30 + i)];
const source = (name, ranges) => ({
  name,
  type: "Publication",
  color: "#d7263d",
  matches: ranges.length,
  matchedWords: ranges.reduce((t, [a, b]) => t + b - a + 1, 0),
  attributedRanges: ranges,
  phrases: [],
  percent: 0,
});
const report = (sources) => ({ wordCount: 100, archiveMatchedPositions: UNION, sources });
const words = (s) => s.matchedWordCount;
const total = (ss) => ss.reduce((t, s) => t + s.matchedWordCount, 0);

test("each attributed Archive source gets its own card with only its own words", () => {
  const out = normalizeArchiveEvidence(report([source("A", [[0, 9]]), source("B", [[10, 19], [30, 34]]), source("C", [[35, 39]])]));
  assert.deepEqual(out.map((s) => [s.labelParts.title, words(s)]), [["A", 10], ["B", 15], ["C", 5]]);
  assert.equal(total(out), UNION.length, "cards sum exactly to the Archive union");
  assert.ok(out.every((s) => s.disjointAttributionGroup === "archive"));
});

test("the top source is never credited with other sources' words", () => {
  const out = normalizeArchiveEvidence(report([source("Top", [[0, 19]]), source("Other", [[30, 39]])]));
  assert.equal(out.find((s) => s.labelParts.title === "Top").matchedWordCount, 20);
  assert.equal(out.find((s) => s.labelParts.title === "Other").matchedWordCount, 10);
});

test("union words owned by unlisted sources go to an honest remainder card", () => {
  const out = normalizeArchiveEvidence(report([source("A", [[0, 9]]), source("B", [[10, 19]])]));
  assert.equal(out.length, 3);
  const rest = out[2];
  assert.equal(rest.matchedWordCount, 10);
  assert.match(rest.labelParts.title, /not listed individually/);
  assert.equal(total(out), UNION.length);
});

test("a report without attributed ranges keeps ONE aggregate card named by source count, not by its top source", () => {
  const legacy = report([{ name: "Top", type: "Publication", matchedWords: 20, percent: 20 }, { name: "Other", type: "Publication", matchedWords: 10, percent: 10 }]);
  const out = normalizeArchiveEvidence(legacy);
  assert.equal(out.length, 1);
  assert.equal(out[0].matchedWordCount, UNION.length);
  assert.notEqual(out[0].labelParts.title, "Top");
  assert.equal(out[0].labelParts.title, archiveSourceCountLabel(2, true));
});

test("malformed or overlapping ranges fall back to the aggregate card (never a wrong per-source split)", () => {
  const overlapping = report([source("A", [[0, 12]]), source("B", [[10, 19], [30, 39]])]);
  assert.equal(archiveSourceAccounting(overlapping).mode, "aggregate");
  const outside = report([source("A", [[0, 25]])]);
  assert.equal(archiveSourceAccounting(outside).mode, "aggregate");
  assert.equal(normalizeArchiveEvidence(overlapping).length, 1);
});

test("no Archive positions -> no Archive card", () => {
  assert.deepEqual(normalizeArchiveEvidence({ wordCount: 10, archiveMatchedPositions: [], sources: [] }), []);
});

test("overview count label says matching evidence entries; imported matches are never badged as publications", () => {
  assert.equal(matchingEvidenceEntriesLabel(1), "1 matching evidence entry");
  assert.equal(matchingEvidenceEntriesLabel(10), "10 matching evidence entries");
  assert.equal(SOURCE_TYPE_BADGE["imported-similarity-evidence"], "Imported reference match");
  assert.notEqual(SOURCE_TYPE_BADGE["imported-similarity-evidence"], SOURCE_TYPE_BADGE.publication);
});
