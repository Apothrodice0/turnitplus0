import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as reference from "./rule-b2-reference.mjs";

/**
 * Test support for pdf-text-extraction-v2: compares the production line-break
 * repair (lib/pdf-text-extraction.ts) with the FROZEN Rule B2 reference kept
 * beside this file.
 *
 * rule-b2-reference.mjs and RULE_B2.json are byte-for-byte copies of the
 * contract audit's frozen files (2026-10-01). They are never edited: if
 * production and the reference disagree, production is wrong.
 */
export const RULE_B2_SHA256 = "d8a72df27b11cbcad26dc9c9b8c5b38a3970f7114e15931bdd9d4bf7005eff87";
export const RULE_B2_REFERENCE_SHA256 = "591b5bb58e1ca071632e0f06133c184444078076856fbb3461846c238933d5bb";

/** SHA-256 of a fixture as committed (LF); a Windows checkout may hand it back with CRLF. */
export function committedSha256(fileName) {
  const text = readFileSync(new URL(fileName, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export { reference };

function referenceSite(site) {
  if (site.nextNonLetter) {
    return { page: site.pi, line: site.i, kind: site.kind, hyphen: site.hy, left: site.L, right: null, join: false, failed: site.failed };
  }
  return {
    page: site.pi, line: site.i, kind: site.kind, hyphen: site.hy, left: site.L, right: site.R,
    leftToken: site.tokL, rightToken: site.tokR,
    lowercaseLeft: site.lowL === 1, lowercaseRight: site.lowR === 1, latin: site.latin === 1,
    dyEm: site.dyEm, pitchDeviation: site.pitchDev, dx0Em: site.dx0Em, nextStartsLeftOfLineEnd: site.bLeftOfAEnd === 1,
    emRatio: site.emRatio, rightGapEm: site.rightGapEm, neighbours: site.neigh, fitGapEm: site.fitGapEm,
    rotated: site.rot === 1, dirLeft: site.dirA, dirRight: site.dirB, joinedInline: site.jd, pairInline: site.pd,
    join: site.join, failed: site.failed,
  };
}

function productionSite(site) {
  const m = site.measurements;
  if (m === null) {
    return { page: site.pageIndex, line: site.lineIndex, kind: site.kind, hyphen: site.hyphen, left: site.leftFragment, right: null, join: site.join, failed: site.failed };
  }
  return {
    page: site.pageIndex, line: site.lineIndex, kind: site.kind, hyphen: site.hyphen, left: site.leftFragment, right: site.rightFragment,
    leftToken: site.leftToken, rightToken: site.rightToken,
    lowercaseLeft: m.lowercaseLeft, lowercaseRight: m.lowercaseRight, latin: m.latin,
    dyEm: m.dyEm, pitchDeviation: m.pitchDeviation, dx0Em: m.dx0Em, nextStartsLeftOfLineEnd: m.nextStartsLeftOfLineEnd,
    emRatio: m.emRatio, rightGapEm: m.rightGapEm, neighbours: m.neighbours, fitGapEm: m.fitGapEm,
    rotated: m.rotated, dirLeft: m.dirLeft, dirRight: m.dirRight, joinedInline: m.joinedInline, pairInline: m.pairInline,
    join: site.join, failed: site.failed,
  };
}

/**
 * Runs the reference and the production repair on the same pdf.js item
 * arrays. `differences` lists every disagreement — sites (count, order, every
 * measurement, every failed predicate, the decision) and the emitted text of
 * every page; it is empty when production is exactly Rule B2.
 */
export function compareWithReference(pagesOfItems, inspectPdfLineBreakRepair) {
  const expected = reference.ruleB(pagesOfItems);
  const actual = inspectPdfLineBreakRepair(pagesOfItems);
  const expectedSites = expected.sites.map(referenceSite);
  const actualSites = actual.sites.map(productionSite);
  const differences = [];
  if (expectedSites.length !== actualSites.length) differences.push(`site count: reference ${expectedSites.length}, production ${actualSites.length}`);
  for (let i = 0; i < Math.min(expectedSites.length, actualSites.length); i += 1) {
    const a = JSON.stringify(expectedSites[i]);
    const b = JSON.stringify(actualSites[i]);
    if (a !== b) differences.push(`site ${i}: reference ${a} production ${b}`);
  }
  for (let page = 0; page < pagesOfItems.length; page += 1) {
    if (expected.texts[page] !== actual.pages[page]) differences.push(`page ${page}: emitted text differs`);
  }
  const decided = expected.sites.filter((site) => site.join).length;
  if (decided - expected.skippedNonAdjacent !== actual.lineBreakJoins) differences.push(`applied joins: reference ${decided - expected.skippedNonAdjacent}, production ${actual.lineBreakJoins}`);
  if (expected.skippedNonAdjacent !== actual.skippedNonAdjacentJoins) differences.push(`skipped joins: reference ${expected.skippedNonAdjacent}, production ${actual.skippedNonAdjacentJoins}`);
  return { expected, actual, differences };
}

/** v1's page string for the same items — the reference carries a replica of v1's joinPageTextItems. */
export function v1PageText(items) {
  return reference.segmentPage(items).productText;
}
