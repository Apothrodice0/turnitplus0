import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectPdfLineBreakRepair, PDF_LINE_BREAK_PREDICATES } from "../lib/pdf-text-extraction.ts";
import {
  committedSha256,
  compareWithReference,
  reference,
  RULE_B2_REFERENCE_SHA256,
  RULE_B2_SHA256,
  v1PageText,
} from "./fixtures/pdf-line-break/conformance.mjs";

/**
 * pdf-text-extraction-v2 CONFORMANCE: lib/pdf-text-extraction.ts must be
 * exactly the frozen Rule B2. The rule description and its reference
 * implementation are committed under tests/fixtures/pdf-line-break/ and pinned
 * here by hash, so neither side of the comparison can drift quietly:
 * changing the rule means a new extractor version and a new frozen reference,
 * never an edit to these files.
 */

test("the frozen Rule B2 description and reference implementation are the audited files, unedited", () => {
  assert.equal(committedSha256("RULE_B2.json"), RULE_B2_SHA256);
  assert.equal(committedSha256("rule-b2-reference.mjs"), RULE_B2_REFERENCE_SHA256);
});

test("the production predicate list is the ordered predicate list of RULE_B2.json", () => {
  const rule = JSON.parse(readFileSync(new URL("./fixtures/pdf-line-break/RULE_B2.json", import.meta.url), "utf8"));
  assert.equal(rule.candidateExtractorVersion, "pdf-text-extraction-v2");
  assert.deepEqual(
    PDF_LINE_BREAK_PREDICATES.map((name) => name.split("-")[0]),
    rule.predicatesAllRequired.map((predicate) => String(predicate.id)),
  );
  // every production label after its id starts with the frozen predicate name
  for (const [index, predicate] of rule.predicatesAllRequired.entries()) {
    const label = PDF_LINE_BREAK_PREDICATES[index];
    const name = label.slice(label.indexOf("-") + 1);
    assert.ok(name.startsWith(predicate.name), `${label} must name the frozen predicate "${predicate.name}"`);
  }
});

// ---------------------------------------------------------------------------
// The 36 synthetic structural fixtures of the contract audit, as the recorded
// pdf.js 6.2.108 item streams of the fixture PDFs.
//
// The count is 36. Earlier audit notes alternate between "36" and "37": two
// superseded first drafts were left beside the fixture PDFs — N20 (became the
// positive P5) and N29 (became X29b) — and one of them was picked up by one
// runner. They were never fixtures, are not recorded here, and stay in the
// audit folder as history only.
// ---------------------------------------------------------------------------
const structural = JSON.parse(readFileSync(new URL("./fixtures/pdf-line-break/structural-fixtures.json", import.meta.url), "utf8"));

test("structural set: exactly the 36 fixtures (28 negatives N*, 7 positives P*, 1 documented limitation X29b)", () => {
  assert.equal(structural.count, 36);
  assert.equal(structural.fixtures.length, 36);
  const ids = structural.fixtures.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, 36);
  assert.equal(ids.filter((id) => id.startsWith("N")).length, 28);
  assert.equal(ids.filter((id) => id.startsWith("P")).length, 7);
  assert.deepEqual(ids.filter((id) => id.startsWith("X")), ["X29b"]);
  assert.ok(!ids.includes("N20") && !ids.includes("N29"), "the superseded drafts N20 / N29 are not fixtures");
  assert.equal(structural.fixtures.reduce((sum, fixture) => sum + fixture.joins, 0), 7);
});

for (const fixture of structural.fixtures) {
  test(`structural ${fixture.id}: ${fixture.purpose}`, () => {
    const { actual, differences } = compareWithReference(fixture.pages, inspectPdfLineBreakRepair);
    assert.deepEqual(differences, [], "production must equal the frozen reference");

    assert.equal(actual.lineBreakJoins, fixture.joins);
    assert.deepEqual(actual.sites.filter((site) => site.join).map((site) => `${site.leftFragment}+${site.rightFragment}`), fixture.joined);
    const candidates = actual.sites.filter((site) => site.measurements !== null);
    assert.equal(candidates.length, fixture.candidateSites);
    assert.deepEqual([...new Set(candidates.flatMap((site) => site.failed))], fixture.failed);

    if (fixture.joins === 0) {
      assert.deepEqual(actual.pages, fixture.pages.map(v1PageText), "nothing joined: every page is v1's own string");
    }
  });
}

// ---------------------------------------------------------------------------
// Seeded differential. Random pages built from the shapes the rule separates
// (soft breaks, compounds, URLs, other scripts, look-alike hyphens, columns,
// font-size and pitch changes, rotated and right-to-left runs, lines split
// into several items, items without geometry) — production and the reference
// must agree on every site and every character.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER = [
  "the", "of", "and", "court", "law", "rule", "data", "site", "was", "used", "above", "example", "information", "amendment",
  "national", "international", "legislative", "constitutional", "wellknown", "well-known", "output", "prévention",
  "Krankenhaus", "примера", "patient", "https", "abcdef", "johnsmith", "einund", "state-owned",
  "(see", "below)", "2024", "x", "nonlinear", "المحكمة",
];
const BREAKS = [
  ["exam", "ple"], ["infor", "mation"], ["amend", "ment"], ["nation", "al"], ["inter", "national"], ["legis", "lative"],
  ["consti", "tutional"], ["well", "known"], ["state", "owned"], ["out", "put"], ["pré", "vention"], ["Kranken", "haus"],
  ["приме", "ра"], ["x", "ray"], ["CONSTI", "TUTIONAL"], ["non", "European"], ["non", "linear"],
  ["Pati", "ent:innen"], ["exam", "ple.org"], ["htt", "ps://example.org/a"], ["abc", "def.2024"], ["john", "smith@example.org"],
  ["in", "put/output"], ["exam", "ple:"], ["exam", "ple."], ["exam", "ple,"], ["exam", "ple12"], ["12", "bis"], ["Ein", "und"],
  ["https://example.org/long", "path"], ["l’informa", "tion"], ["(exam", "ple)"], ["nation", "al-level"], ["pre", "and"],
  ["pré", "vention"], ["قانون", "دستوري"],
];
const HYPHENS = ["-", "-", "-", "-", "-", "-", "-", "­", "‐", "‑", "‒", "–", "—", "−"];

function randomDocument(seed) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const chance = (p) => random() < p;
  const pages = [];
  const pageCount = 1 + Math.floor(random() * 3);
  for (let p = 0; p < pageCount; p += 1) {
    const items = [];
    const columns = chance(0.3) ? [40, 320] : [40];
    const columnWidth = columns.length === 2 ? 230 : 300;
    let pendingRight = null;
    for (const columnX of columns) {
      let y = 700;
      const lineCount = 4 + Math.floor(random() * 18);
      for (let line = 0; line < lineCount; line += 1) {
        const em = pick([10, 10, 10, 10, 10, 10, 7, 6.9, 14.5, 14.6, 12, 6.96]);
        const words = [];
        if (pendingRight !== null) words.push(pendingRight);
        pendingRight = null;
        for (let w = 1 + Math.floor(random() * 6); w > 0; w -= 1) words.push(pick(FILLER));
        if (chance(0.45)) {
          const [left, right] = pick(BREAKS);
          words.push(left + pick(HYPHENS));
          pendingRight = right;
        }
        const text = words.join(" ");
        const x = columnX + pick([0, 0, 0, 0, 0, 0, 18, 30, 30.1, -60, -60.1, 45]);
        const natural = text.length * em * 0.5;
        const width = chance(0.75) ? columnWidth - (x - columnX) : Math.min(natural, columnWidth * 0.6);
        const dir = chance(0.05) ? "rtl" : "ltr";
        const matrix = chance(0.04) ? [em, 0.4, 0, em, x, y] : chance(0.03) ? [0, em, -em, 0, x, y] : [em, 0, 0, em, x, y];

        // one printed line = 1..3 items; a cut either falls on a space (a real
        // gap follows) or inside a word (the next item is geometrically adjacent)
        const cuts = chance(0.4) ? 1 + Math.floor(random() * 2) : 0;
        const pieces = [];
        let rest = text;
        for (let c = 0; c < cuts && rest.length > 4; c += 1) {
          const at = 2 + Math.floor(random() * (rest.length - 3));
          pieces.push(rest.slice(0, at));
          rest = rest.slice(at);
        }
        pieces.push(rest);
        let cursor = x;
        const perChar = width / Math.max(1, text.length);
        pieces.forEach((piece, index) => {
          const pieceWidth = piece.length * perChar;
          const withoutGeometry = chance(0.02);
          const entry = withoutGeometry
            ? { str: piece }
            : { str: piece, dir, width: pieceWidth, height: em, transform: [matrix[0], matrix[1], matrix[2], matrix[3], cursor, y] };
          entry.hasEOL = index === pieces.length - 1 ? !chance(0.05) : chance(0.03);
          items.push(entry);
          cursor += pieceWidth;
        });
        if (chance(0.1)) items.push({ str: "", dir: "ltr", width: 0, height: 0, transform: [em, 0, 0, em, cursor, y], hasEOL: true });
        if (chance(0.03)) items.push({ str: " ", dir: "ltr", width: 2.5, height: em, transform: [em, 0, 0, em, cursor, y], hasEOL: true });
        if (chance(0.03)) items.push({ str: "[figure]", hasEOL: true });
        y -= pick([12, 12, 12, 12, 12, 12, 14, 26, 26.1, 28, 35, 35.2, 5, 5.1, 0, 60, 40, 40.1]);
      }
    }
    pages.push(items);
  }
  return pages;
}

test("seeded differential: 400 random documents, production equals the frozen reference on every site and every character", () => {
  const failedSeen = new Map();
  let sites = 0;
  let joins = 0;
  let skipped = 0;
  let pageBoundarySites = 0;
  let nonLetterSites = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const pages = randomDocument(seed);
    const { expected, actual, differences } = compareWithReference(pages, inspectPdfLineBreakRepair);
    assert.deepEqual(differences, [], `seed ${seed}`);
    assert.deepEqual(inspectPdfLineBreakRepair(pages), actual, `seed ${seed}: the repair is deterministic and leaves its input untouched`);

    const joinedPages = new Set(actual.sites.filter((site) => site.join).map((site) => site.pageIndex));
    for (const [index, items] of pages.entries()) {
      if (!joinedPages.has(index)) assert.equal(actual.pages[index], v1PageText(items), `seed ${seed} page ${index}: no join decided, so v1's string`);
    }
    for (const site of actual.sites) {
      sites += 1;
      if (site.kind === "page-boundary") {
        pageBoundarySites += 1;
        assert.equal(site.join, false, `seed ${seed}: a page-boundary pair is never joined`);
      }
      if (site.measurements === null) nonLetterSites += 1;
      for (const name of site.failed) failedSeen.set(name, (failedSeen.get(name) ?? 0) + 1);
    }
    joins += actual.lineBreakJoins;
    skipped += expected.skippedNonAdjacent;
  }
  // the generator really exercised the rule: every predicate refused something, and joins happened
  for (const name of PDF_LINE_BREAK_PREDICATES) assert.ok((failedSeen.get(name) ?? 0) > 0, `no generated site failed ${name}`);
  assert.ok(sites > 3000, `sites=${sites}`);
  assert.ok(joins > 100, `joins=${joins}`);
  assert.ok(skipped > 0, `skipped non-adjacent joins=${skipped}`);
  assert.ok(pageBoundarySites > 20, `page-boundary sites=${pageBoundarySites}`);
  assert.ok(nonLetterSites > 0, `sites followed by a non-letter line=${nonLetterSites}`);
});

test("the reference's own v1 replica is what a no-join page emits (zero-join text is v1 text)", () => {
  const pages = randomDocument(7).map((items) => items.map((item) => ({ ...item, str: item.str.replace(/[\-­‐-—−]/gu, "") })));
  const result = inspectPdfLineBreakRepair(pages);
  assert.equal(result.sites.length, 0);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, pages.map(v1PageText));
  assert.deepEqual(result.pages, reference.applyJoins(pages.map((items) => reference.segmentPage(items)), []).texts);
});
