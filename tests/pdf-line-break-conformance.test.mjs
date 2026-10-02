import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectPdfLineBreakRepair, PDF_LINE_BREAK_PREDICATES } from "../lib/pdf-text-extraction.ts";
import {
  committedSha256,
  compareWithReference,
  reference,
  RULE_B3_REFERENCE_SHA256,
  RULE_B3_SHA256,
  v1PageText,
} from "./fixtures/pdf-line-break/conformance.mjs";

/**
 * pdf-text-extraction-v2 CONFORMANCE: lib/pdf-text-extraction.ts must be
 * exactly the frozen Rule B3. The rule description and its reference
 * implementation are committed under tests/fixtures/pdf-line-break/ and pinned
 * here by hash, so neither side of the comparison can drift quietly:
 * changing the rule means a new extractor version and a new frozen reference,
 * never an edit to these files.
 */

const rule = JSON.parse(readFileSync(new URL("./fixtures/pdf-line-break/RULE_B3.json", import.meta.url), "utf8"));

test("the frozen Rule B3 description and reference implementation are the audited files, unedited", () => {
  assert.equal(RULE_B3_SHA256, "e5c03787be91d3180ddd551d3cfa6e41c1bf393510865dda767f6f5ca4bc7ccc");
  assert.equal(RULE_B3_REFERENCE_SHA256, "83cbdc7ca216075edbab0675a35b294be701feccb7203b62cc891f77c04d7eeb");
  assert.equal(committedSha256("RULE_B3.json"), RULE_B3_SHA256);
  assert.equal(committedSha256("rule-b3-reference.mjs"), RULE_B3_REFERENCE_SHA256);
  assert.equal(rule.name, "Rule B3");
});

test("Rule B3 is Rule B2 plus predicate 12b: its constants are the production constants, and its known limits are on record", () => {
  assert.deepEqual(rule.columnGutter.constants, { WIDE_GUTTER_EM: 2, REPEATED_GUTTER_EM: 0.6, GUTTER_ALIGN_EM: 0.1, REPEATED_GUTTER_MAX: 5 });
  const source = readFileSync(new URL("../lib/pdf-text-extraction.ts", import.meta.url), "utf8");
  for (const [name, value] of Object.entries(rule.columnGutter.constants)) {
    assert.ok(source.includes(`const ${name} = ${value};`), `lib/pdf-text-extraction.ts must declare ${name} = ${value}`);
  }
  // The rule does NOT promise "no cross-cell join": the frozen description
  // lists what predicate 12b cannot see, first of all a gutter under 0.6 em.
  assert.equal(rule.columnGutter.knownLimits.length, 4);
  assert.match(rule.columnGutter.knownLimits[0], /narrower than 0\.6 em .* not distinguishable from a word space/);
});

test("the production predicate list is the ordered predicate list of RULE_B3.json", () => {
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
// into several items, items without geometry, rows of cells at tab stops,
// lines with gaps between their items, word-per-item lines) — production and
// the reference must agree on every site and every character.
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
// Predicate 12b: gaps between the items of a printed line, in em, on both
// sides of its two width thresholds; and the offset of a cell from its tab
// stop, in pt, on both sides of the 0.1 em alignment tolerance at 10pt.
const GAPS = [0.4, 0.59, 0.6, 0.61, 1, 1.2, 1.99, 2, 2.01, 5];
const TAB_OFFSETS = [0, 0, 0, 0, 1, 1.1, 4];
const LINE_STYLES = ["text", "text", "text", "cells", "cells", "spaced", "words"];

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
      // how this column's lines are cut into items: "text" abutting runs,
      // "cells" items at the column's tab stops (a table), "spaced" a gap
      // before every item, "words" one item per word
      const columnStyle = pick(LINE_STYLES);
      const tabStops = [columnX + 90, columnX + 170];
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
        const style = chance(0.75) ? columnStyle : "text";
        const pieces = [];
        if (style === "text") {
          const cuts = chance(0.4) ? 1 + Math.floor(random() * 2) : 0;
          let rest = text;
          for (let c = 0; c < cuts && rest.length > 4; c += 1) {
            const at = 2 + Math.floor(random() * (rest.length - 3));
            pieces.push(rest.slice(0, at));
            rest = rest.slice(at);
          }
          pieces.push(rest);
        } else if (style === "words") {
          pieces.push(...words);
        } else {
          // two or three cells, cut between words
          const cellCount = Math.min(words.length, 2 + Math.floor(random() * 2));
          const perCell = Math.ceil(words.length / cellCount);
          for (let c = 0; c < words.length; c += perCell) pieces.push(words.slice(c, c + perCell).join(" "));
        }
        let cursor = x;
        const perChar = width / Math.max(1, text.length);
        const lineGap = pick(GAPS) * em;
        pieces.forEach((piece, index) => {
          let pieceWidth = piece.length * perChar;
          if (index > 0 && style === "cells") cursor = tabStops[Math.min(index, tabStops.length) - 1] + pick(TAB_OFFSETS);
          if (index > 0 && style === "spaced") cursor += pick(GAPS) * em;
          if (index > 0 && style === "words") cursor += lineGap;
          // the last cell of a row usually runs to the right edge of its column
          if (style !== "text" && index === pieces.length - 1 && chance(0.75) && columnX + columnWidth - cursor > 1) pieceWidth = columnX + columnWidth - cursor;
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
  // predicate 12b, by the branch that decided
  const gutter = { onlyFailure: 0, wideNotShared: 0, sharedNotWide: 0, overFiveGaps: 0, joinedDespiteGaps: 0 };
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
      const m = site.measurements;
      if (m !== null && site.kind === "same-page") {
        const refused = site.failed.includes("12b-no-column-gutter");
        assert.equal(refused, m.widestGapEm >= 2 || m.sharedGutter, `seed ${seed}: 12b is exactly "a wide gutter or a shared one"`);
        if (m.sharedGutter) assert.ok(m.gutterGaps >= 1 && m.gutterGaps <= 5, `seed ${seed}: a shared gutter needs one to five gaps`);
        if (refused && site.failed.length === 1) gutter.onlyFailure += 1;
        if (m.widestGapEm >= 2 && !m.sharedGutter) gutter.wideNotShared += 1;
        if (m.widestGapEm < 2 && m.sharedGutter) gutter.sharedNotWide += 1;
        if (m.gutterGaps > 5) gutter.overFiveGaps += 1;
        if (site.join && m.widestGapEm > 0) gutter.joinedDespiteGaps += 1;
      } else if (m !== null) {
        assert.deepEqual([m.widestGapEm, m.gutterGaps, m.sharedGutter], [null, null, false], `seed ${seed}: 12b is not measured across a page boundary`);
        assert.ok(!site.failed.includes("12b-no-column-gutter"), `seed ${seed}`);
      }
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
  // ... and both branches of 12b decided, alone, with the others staying out of the way
  for (const [branch, count] of Object.entries(gutter)) assert.ok(count > 10, `predicate 12b, ${branch}=${count}`);
});

test("the reference's own v1 replica is what a no-join page emits (zero-join text is v1 text)", () => {
  const pages = randomDocument(7).map((items) => items.map((item) => ({ ...item, str: item.str.replace(/[\-­‐-—−]/gu, "") })));
  const result = inspectPdfLineBreakRepair(pages);
  assert.equal(result.sites.length, 0);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, pages.map(v1PageText));
  assert.deepEqual(result.pages, reference.applyJoins(pages.map((items) => reference.segmentPage(items)), []).texts);
});
