import assert from "node:assert/strict";
import test from "node:test";
import { tokens } from "../lib/similarity-core.ts";
import { scoreAgainstArchiveDetailed } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, archiveShingleHashes } from "../lib/archive-fingerprint.ts";
import { frameArchiveResult } from "../lib/archive-result-framing.ts";
import { buildReportEvidenceInterpretation } from "../lib/evidence-interpretation/index.ts";
import { archiveSourceAccounting } from "../lib/evidence-interpretation/archive-source-accounting.ts";
import {
  compactEvidenceInterpretationForPersistence,
  expandEvidenceInterpretationFromPersistence,
} from "../lib/evidence-interpretation/persistence.ts";
import { buildReportV2ViewModel, verifiedSourceCountText } from "../lib/report-v2-view.ts";

/**
 * GOLD GAP — Archive source accounting. A report whose Archive evidence came
 * from several verified documents must show one card per document (or say
 * how many it could not list), never one card titled after the top document
 * holding every Archive word. The union, the score and every matched position
 * stay exactly what the scorer produced. Synthetic fixtures only.
 */

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function memoryIndex(sourceTexts) {
  const hashSets = sourceTexts.map((text) => archiveShingleHashes(text, ARCHIVE_SHINGLE_SIZE));
  const postings = new Map();
  hashSets.forEach((set, sourceIndex) => {
    for (const hash of set) {
      const list = postings.get(hash);
      if (list) list.push(sourceIndex);
      else postings.set(hash, [sourceIndex]);
    }
  });
  return {
    shingleSize: ARCHIVE_SHINGLE_SIZE,
    documentCount: sourceTexts.length,
    maximumDocumentFrequency: 12,
    articles: sourceTexts.map((_, index) => ({ title: `Archive document ${index + 1}`, sourceType: "Publication", uniqueShingleCount: hashSets[index].size })),
    getPostings: (hash) => postings.get(hash) ?? [],
  };
}

// Submission: host / A (90) / host / B (70) / host / C (60) / host / D (50) / host.
// Source 0 holds A, source 1 holds the second half of A plus B (overlap with
// source 0), source 2 holds C, source 3 holds D.
const HOST = syn(900, 400);
const A = syn(201, 90);
const B = syn(202, 70);
const C = syn(203, 60);
const D = syn(204, 50);
const SUBMISSION = [...HOST.slice(0, 60), ...A, ...HOST.slice(60, 120), ...B, ...HOST.slice(120, 180), ...C, ...HOST.slice(180, 240), ...D, ...HOST.slice(240, 300)].join(" ");
const SOURCES = [
  `${A.join(" ")} ${syn(301, 300).join(" ")}`,
  `${A.slice(45).join(" ")} ${B.join(" ")} ${syn(302, 300).join(" ")}`,
  `${C.join(" ")} ${syn(303, 300).join(" ")}`,
  `${D.join(" ")} ${syn(304, 300).join(" ")}`,
];
const PARAMS = { minimumMatchedWords: 5, maximumDocumentFrequency: 6, minimumSourceContribution: 0.5, sourceWeighting: "raw" };
const uncapped = scoreAgainstArchiveDetailed(SUBMISSION, memoryIndex(SOURCES), { ...PARAMS, maximumContributingSources: 10 });
const capped = scoreAgainstArchiveDetailed(SUBMISSION, memoryIndex(SOURCES), { ...PARAMS, maximumContributingSources: 2 });

const expand = (ranges) => ranges.flatMap(([s, e]) => range(s, e));

function mkReport(result, over = {}) {
  return {
    version: 11, id: 1, submissionId: "0000000001", title: "t.docx", author: "Guest submission", assignment: "",
    created: "2026-10-07T00:00:00.000Z", score: result.score, archiveScore: result.score, wordCount: result.wordCount,
    characterCount: SUBMISSION.length, pageCount: 1, fileSize: "1 KB", databaseSize: 4, corpusVersion: "archive-test",
    scoreBand: "Low", riskStatus: "Lower", riskTarget: 0, riskCutoff: 0, riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "English" },
    excludedDocuments: 0, matchedWordCount: result.matchedWordCount, archiveMatchedPositions: result.archiveMatchedPositions,
    sources: result.sources.map(({ sourceIndex: _sourceIndex, ...source }) => source),
    archiveVerifiedSourceCount: result.verifiedSourceCount, repeats: [], text: SUBMISSION,
    ...over,
  };
}
const withoutAttribution = (report) => ({
  ...report,
  sources: report.sources.map(({ attributedRanges: _ranges, ...source }) => source),
  archiveVerifiedSourceCount: undefined,
});
const archiveCards = (interpretation) => interpretation.sources.filter((s) => s.sourceType === "publication" || s.sourceType === "internet");

test("scorer: each listed source carries its own attributed ranges — disjoint, inside the union, matchedWords in size", () => {
  const { result, contributingSourceIndexes } = uncapped;
  assert.equal(result.sources.length, 4);
  assert.equal(result.verifiedSourceCount, 4);
  assert.equal(contributingSourceIndexes.length, 4);
  const union = new Set(result.archiveMatchedPositions);
  const seen = new Set();
  for (const source of result.sources) {
    const own = expand(source.attributedRanges);
    assert.equal(own.length, source.matchedWords, source.name);
    for (const p of own) {
      assert.ok(union.has(p), `${source.name} lists ${p} outside the union`);
      assert.ok(!seen.has(p), `${p} is listed under two sources`);
      seen.add(p);
    }
  }
  assert.equal(seen.size, union.size, "uncapped: the listed sources own the whole union");
  // the overlap (second half of A) is owned by exactly one of sources 0 and 1
  assert.equal(result.sources.reduce((t, s) => t + s.matchedWords, 0), result.archiveMatchedPositions.length);
});

test("scorer: the display cap lists fewer sources but changes no position, score, or verified count", () => {
  assert.equal(capped.result.sources.length, 2);
  assert.equal(capped.result.verifiedSourceCount, 4);
  assert.deepEqual(capped.result.archiveMatchedPositions, uncapped.result.archiveMatchedPositions);
  assert.equal(capped.result.score, uncapped.result.score);
  for (const source of capped.result.sources) {
    const twin = uncapped.result.sources.find((s) => s.name === source.name);
    assert.deepEqual(source.attributedRanges, twin.attributedRanges, "a listed source owns the same words whether or not others are listed");
  }
});

test("framing: the public worker result carries verifiedSourceCount and every source's attributedRanges", () => {
  const framed = frameArchiveResult(SUBMISSION, capped.result, {
    scoreBands: [{ label: "Low", minimum: 0, maximum: 100 }],
    corpusVersion: "archive-test",
    risk: { targetThreshold: 0, archiveCutoff: 100, auc: 0, precision: 0, recall: 0, sampleSize: 0 },
  });
  assert.equal(framed.verifiedSourceCount, 4);
  assert.deepEqual(framed.sources.map((s) => s.attributedRanges), capped.result.sources.map((s) => s.attributedRanges));
  assert.ok(framed.sources.every((s) => !("sourceIndex" in s)));
});

test("report: one card per verified source, each with exactly its own words; union, counts and kinds total unchanged", () => {
  const report = mkReport(uncapped.result);
  const perSource = buildReportEvidenceInterpretation(report);
  const legacy = buildReportEvidenceInterpretation(withoutAttribution(report));

  const cards = archiveCards(perSource);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.label).sort(), uncapped.result.sources.map((s) => s.name).sort());
  for (const card of cards) {
    const source = uncapped.result.sources.find((s) => s.name === card.label);
    assert.equal(card.matchedWords, source.matchedWords);
    assert.equal(card.namedSources, undefined, "a per-source card is one of the named sources, not a list of them");
    const cardPositions = new Set(perSource.passages.filter((p) => p.sourceIds.includes(card.id)).flatMap((p) => range(p.wordStart, p.wordEnd)));
    assert.deepEqual([...cardPositions].sort((a, b) => a - b), expand(source.attributedRanges), `${card.label}: its passages are exactly its own words`);
  }
  for (const passage of perSource.passages) assert.equal(passage.sourceIds.length, 1, "no Archive word is credited to two documents");

  assert.equal(perSource.matchedWordCount, legacy.matchedWordCount);
  assert.equal(perSource.matchedWordCount, uncapped.result.archiveMatchedPositions.length);
  const total = (i) => Object.values(i.countsByKind).reduce((a, b) => a + b, 0);
  assert.equal(total(perSource), total(legacy));
  assert.equal(cards.reduce((t, c) => t + c.matchedWords, 0), perSource.matchedWordCount, "cards add up to the union — never more");

  const vm = buildReportV2ViewModel({ ...report, evidenceInterpretation: perSource });
  assert.equal(vm.summary.distinctVerifiedSources, 4);
  assert.equal(vm.summary.distinctVerifiedSourcesIsLowerBound, false);
  assert.equal(vm.summary.matchedWordCount, uncapped.result.archiveMatchedPositions.length);
});

test("report: a display-capped report lists its sources and says how many more verified sources it did not list", () => {
  const report = mkReport(capped.result);
  const interpretation = buildReportEvidenceInterpretation(report);
  const cards = archiveCards(interpretation);
  assert.equal(cards.length, 3, "2 listed sources + 1 card for the unlisted rest");
  const rest = cards.find((c) => /not listed individually/.test(c.label));
  assert.equal(rest.label, "2 more verified Archive sources (not listed individually)");
  const listedWords = capped.result.sources.reduce((t, s) => t + s.matchedWords, 0);
  assert.equal(rest.matchedWords, capped.result.archiveMatchedPositions.length - listedWords);
  assert.equal(cards.reduce((t, c) => t + c.matchedWords, 0), capped.result.archiveMatchedPositions.length);

  const vm = buildReportV2ViewModel({ ...report, evidenceInterpretation: interpretation });
  assert.equal(vm.summary.distinctVerifiedSources, 4, "the overview counts verified sources, not cards");
  assert.equal(verifiedSourceCountText(vm.summary), "4");
});

test("legacy report (no attribution): one aggregate card named for its verified-source count, not for its top source", () => {
  const report = withoutAttribution(mkReport(uncapped.result));
  const interpretation = buildReportEvidenceInterpretation(report);
  const cards = archiveCards(interpretation);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].label, "4 verified Archive sources");
  assert.equal(cards[0].namedSources.length, 4);
  assert.equal(cards[0].matchedWords, uncapped.result.archiveMatchedPositions.length);
  const vm = buildReportV2ViewModel({ ...report, evidenceInterpretation: interpretation });
  assert.equal(vm.summary.distinctVerifiedSources, 4);
  assert.equal(vm.summary.distinctVerifiedSourcesIsLowerBound, false);

  // display-capped legacy report: listed words fall short of the union => at least one more source
  const cappedLegacy = withoutAttribution(mkReport(capped.result));
  const cappedInterpretation = buildReportEvidenceInterpretation(cappedLegacy);
  assert.equal(archiveCards(cappedInterpretation)[0].label, "at least 3 verified Archive sources");
  const cappedVm = buildReportV2ViewModel({ ...cappedLegacy, evidenceInterpretation: cappedInterpretation });
  assert.equal(verifiedSourceCountText(cappedVm.summary), "3+");
});

test("GOLD shape: an interpretation persisted before this fix (top title + 10 named sources) renders as 10 verified sources", () => {
  // The Gold report: one archive:aggregate card titled after the top document, 337 words, namedSources (10).
  const names = range(1, 10).map((i) => `Algerian law article ${i}`);
  const words = [60, 50, 45, 40, 35, 30, 27, 20, 18, 12];
  const union = range(100, 436);
  const report = mkReport(uncapped.result, {
    wordCount: 4668,
    archiveMatchedPositions: union,
    archiveVerifiedSourceCount: undefined,
    sources: names.map((name, i) => ({ name, type: "Publication", percent: Math.floor((words[i] / 4668) * 100), matches: 1, matchedWords: words[i], phrases: [], color: "#d7263d" })),
    text: syn(500, 4668).join(" "),
  });
  assert.equal(words.reduce((a, b) => a + b, 0), union.length);
  const persistedBefore = {
    ...buildReportEvidenceInterpretation(report),
  };
  // what the previous builder stored: the aggregate card carried the top source's title
  persistedBefore.sources = persistedBefore.sources.map((s) => (s.namedSources ? { ...s, label: names[0] } : s));
  const vm = buildReportV2ViewModel({ ...report, evidenceInterpretation: persistedBefore });
  assert.equal(vm.summary.distinctVerifiedSources, 10);
  assert.equal(vm.summary.distinctVerifiedSourcesIsLowerBound, false);
  assert.equal(vm.sources.length, 1);
  assert.equal(vm.sources[0].label, "10 verified Archive sources");
  assert.equal(vm.sources[0].matchedWords, 337);
  assert.equal(vm.summary.matchedWordCount, 337, "the headline union is untouched");
});

test("an aggregate card stored by an older build for a report that has attribution still counts and reads truthfully", () => {
  const report = mkReport(capped.result);
  const storedByOlderBuild = buildReportEvidenceInterpretation(withoutAttribution(report));
  storedByOlderBuild.sources = storedByOlderBuild.sources.map((s) => (s.namedSources ? { ...s, label: capped.result.sources[0].name } : s));
  const vm = buildReportV2ViewModel({ ...report, evidenceInterpretation: storedByOlderBuild });
  assert.equal(vm.sources.length, 1);
  assert.equal(vm.sources[0].label, "4 verified Archive sources");
  assert.equal(vm.summary.distinctVerifiedSources, 4);
});

test("attribution that does not check out against the report falls back to the aggregate card", () => {
  const report = mkReport(uncapped.result);
  const [first, second, ...rest] = report.sources;
  const overlapping = { ...report, sources: [first, { ...second, attributedRanges: [...second.attributedRanges, first.attributedRanges[0]], matchedWords: second.matchedWords + (first.attributedRanges[0][1] - first.attributedRanges[0][0] + 1) }, ...rest] };
  const outside = { ...report, sources: [{ ...first, attributedRanges: [[0, first.matchedWords - 1]] }, second, ...rest] };
  const wrongSize = { ...report, sources: [{ ...first, matchedWords: first.matchedWords + 1 }, second, ...rest] };
  const malformed = { ...report, sources: [{ ...first, attributedRanges: [[5, 2]] }, second, ...rest] };
  for (const [name, tampered] of Object.entries({ overlapping, outside, wrongSize, malformed })) {
    assert.equal(archiveSourceAccounting(tampered).mode, "aggregate", name);
    const cards = archiveCards(buildReportEvidenceInterpretation(tampered));
    assert.equal(cards.length, 1, name);
    assert.equal(cards[0].matchedWords, report.archiveMatchedPositions.length, name);
  }
});

test("an Archive source next to a larger one is not 'also in another verified source' — attribution split it, nothing covers it twice", () => {
  const words = tokens(SUBMISSION).length;
  const report = mkReport(uncapped.result, {
    archiveMatchedPositions: range(10, 113),
    archiveVerifiedSourceCount: 2,
    sources: [
      { name: "Large", type: "Publication", percent: 2, matches: 1, matchedWords: 100, attributedRanges: [[10, 109]], phrases: [], color: "#d7263d" },
      { name: "Small", type: "Publication", percent: 0, matches: 1, matchedWords: 4, attributedRanges: [[110, 113]], phrases: [], color: "#d7263d" },
    ],
    wordCount: words,
  });
  const interpretation = buildReportEvidenceInterpretation(report);
  const small = interpretation.sources.find((s) => s.label === "Small");
  assert.equal(small.interpretation.primaryKind, "DISTINCTIVE_EXTERNAL_MATCH");
  assert.equal(interpretation.countsByKind.LEGITIMATE_ALTERNATE_SOURCE, 0);
});

test("compact persistence keeps per-source Archive cards losslessly", () => {
  const report = mkReport(capped.result);
  const interpretation = buildReportEvidenceInterpretation(report);
  const persisted = compactEvidenceInterpretationForPersistence(interpretation, { compactWrites: true });
  assert.equal(persisted.format, "compact");
  const expanded = expandEvidenceInterpretationFromPersistence(persisted);
  assert.equal(expanded.status, "expanded");
  assert.deepEqual(expanded.value, interpretation);
});
