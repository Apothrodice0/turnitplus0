import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tokensForScoringNormalization } from "../lib/similarity-core.ts";

/**
 * EXTERNAL SIMILARITY BENCHMARK — submission 1036041427 (Turnitin copy
 * trn:oid:::1:3667807767). tests/fixtures/external-benchmarks/ holds
 * MEASUREMENT DATA ONLY: the Turnitin report's highlighted words (category,
 * source badge, page rectangle) aligned onto TurnitPlus token positions, plus
 * the 101 positions TurnitPlus verified. It explains a gap (Turnitin 6% vs
 * TurnitPlus 1%); it is never a scoring input — only verified source text may
 * change a TurnitPlus score. The last test pins that no production path can
 * read it.
 *
 * Turnitin's colours are citation categories (red = no citation, yellow =
 * missing citation, orange = missing quotation marks); TurnitPlus's are
 * verification states (red = verified, scored; yellow = possible match, not
 * scored). The fixture keeps them apart and so do these tests.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_REL = "tests/fixtures/external-benchmarks/turnitin-1036041427.json";
const fixture = JSON.parse(fs.readFileSync(path.join(repo, FIXTURE_REL), "utf8"));
const CATEGORIES = ["NO_CITATION", "MISSING_CITATION", "MISSING_QUOTES", "QUOTED"];

function countBy(words, unit) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const w of words) counts[w.category] += unit === "tokens" ? w.tokens.length : 1;
  return counts;
}

test("fixture identifies both reports and declares itself measurement-only", () => {
  assert.equal(fixture.schema, "turnitplus.external-similarity-benchmark.v1");
  assert.equal(fixture.benchmarkId, "turnitin-1036041427");
  assert.match(fixture.purpose, /TEST \/ MEASUREMENT DATA ONLY/);
  assert.match(fixture.purpose, /Production code must never read this file/);
  assert.match(fixture.purpose, /nothing here is ever a scoring input/);

  assert.equal(fixture.turnitin.copyId, "trn:oid:::1:3667807767");
  assert.equal(fixture.turnitin.overallSimilarityPercent, 6);
  assert.equal(fixture.turnitin.reportPdf.sha256, "ccbdaeff05ef779446be736fb699ca1b778a18cfee164bbb7f26a4e6c65ca7fe");
  assert.equal(fixture.turnitin.sources.length, 22);
  assert.deepEqual(fixture.turnitin.sources.map((s) => s.number), Array.from({ length: 22 }, (_, i) => i + 1));

  assert.equal(fixture.turnitplus.submissionId, "1036041427");
  assert.deepEqual(
    { ...fixture.turnitplus.observed },
    { similarityPercent: 1, matchedWords: 101, analyzedWords: 10513, verifiedSources: 1, namedSources: 2, matchedPassages: 14, searchStatus: "Needs attention (completion state PARTIAL)" },
  );
  assert.equal(fixture.turnitplus.reportPdf.sha256, "cea238e0c597097125c8d41b24446aba3707a2f33dff2baa9e38de97362137bd");

  // the two palettes are documented as different, never as one mapping
  assert.match(fixture.colorSemantics.note, /NOT equivalent/);
  assert.match(fixture.colorSemantics.turnitin.yellow, /^MISSING_CITATION/);
  assert.match(fixture.colorSemantics.turnitplus.yellow, /NOT counted in the similarity score/);
  // personal data is not stored
  const raw = JSON.stringify(fixture);
  assert.doesNotMatch(raw, /Guettas|Faculté|\.docx/);
});

test("highlight counts re-extracted from the PDF: 584 words (488 red / 65 yellow / 31 orange), 609 tokens", () => {
  assert.equal(fixture.words.length, 584);
  assert.deepEqual(countBy(fixture.words, "words"), { NO_CITATION: 488, MISSING_CITATION: 65, MISSING_QUOTES: 31, QUOTED: 0 });
  assert.deepEqual(countBy(fixture.words, "tokens"), { NO_CITATION: 510, MISSING_CITATION: 66, MISSING_QUOTES: 33, QUOTED: 0 });
  assert.deepEqual(fixture.summary.highlightedWordsByCategory, countBy(fixture.words, "words"));
  assert.equal(fixture.summary.highlightedTokens, 609);
  // the task's stated figures differ by one red word (the supplied JSON was not available to compare)
  assert.equal(fixture.summary.statedInTask.highlightedWords, 583);
});

test("every highlighted word overlaps a recorded highlight rectangle of its own category", () => {
  for (const w of fixture.words) {
    assert.ok(CATEGORIES.includes(w.category), `category ${w.category}`);
    assert.ok(w.page >= 5 && w.page <= 31, `page ${w.page}`);
    const [x0, y0, x1, y1] = w.rect;
    assert.ok(x0 < x1 && y0 < y1 && x0 >= 0 && x1 <= 596 && y1 <= 842, `rect ${w.rect}`);
    assert.ok(w.glyphsHighlighted >= 1 && w.glyphsHighlighted <= w.glyphs);
    // overlap, not containment: a partly highlighted word ("14/2006") is only partly covered
    const covered = fixture.highlightRectangles.some(
      (r) => r.page === w.page && r.category === w.category && x0 < r.rect[2] && x1 > r.rect[0] && r.rect[1] === y0 && r.rect[3] === y1,
    );
    assert.ok(covered, `word ${w.word} on page ${w.page} has no ${w.category} rectangle`);
  }
});

test("badge attribution agrees with Turnitin's own match-group counts", () => {
  assert.ok(fixture.words.every((w) => Number.isInteger(w.source) && w.source >= 1 && w.source <= 22));
  const sourcesWith = (category) => new Set(fixture.words.filter((w) => w.category === category).map((w) => w.source)).size;
  // 2 "Guillemets manquants" groups and 4 "Citation manquante" groups on the report's overview page
  assert.equal(sourcesWith("MISSING_QUOTES"), fixture.turnitin.matchGroups.MISSING_QUOTES.groups);
  assert.equal(sourcesWith("MISSING_CITATION"), fixture.turnitin.matchGroups.MISSING_CITATION.groups);
  assert.equal(fixture.turnitin.matchGroups.QUOTED.groups, 0);
});

test("stored tokens are TurnitPlus tokens under both scoring-normalization contracts (Phase B compatible)", () => {
  for (const w of fixture.words) {
    const stored = w.tokens.map((t) => t.token);
    assert.ok(stored.length >= 1, `word ${w.word} has no tokens`);
    assert.deepEqual(tokensForScoringNormalization(stored.join(" "), 1), stored);
    assert.deepEqual(tokensForScoringNormalization(stored.join(" "), 2), stored);
  }
});

test("alignment regression: recall of the external highlights by TurnitPlus verified positions", () => {
  const verified = fixture.turnitplus.verifiedTokenPositions;
  assert.equal(verified.length, 101);
  assert.deepEqual([...verified], [...new Set(verified)].sort((a, b) => a - b));
  const verifiedSet = new Set(verified);

  const aligned = fixture.words.flatMap((w) => w.tokens.map((t) => ({ position: t.turnitplusPosition, category: w.category })));
  assert.ok(aligned.every((t) => Number.isInteger(t.position) && t.position >= 0 && t.position < 10513), "every highlighted token aligns");
  assert.equal(new Set(aligned.map((t) => t.position)).size, aligned.length, "no two highlighted tokens share a TurnitPlus position");

  const hit = (category) => aligned.filter((t) => (!category || t.category === category) && verifiedSet.has(t.position)).length;
  assert.equal(hit(), 53);
  assert.equal(hit("NO_CITATION"), 48);
  assert.equal(hit("MISSING_CITATION"), 0);
  assert.equal(hit("MISSING_QUOTES"), 5);
  const benchmarkPositions = new Set(aligned.map((t) => t.position));
  assert.equal(verified.filter((p) => !benchmarkPositions.has(p)).length, 48, "TurnitPlus-only verified tokens");
});

test("the external benchmark cannot reach a production or scoring path", () => {
  const offenders = [];
  const needles = ["external-benchmarks", "turnitin-1036041427", "1036041427", "3667807767"];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (needles.some((n) => text.includes(n))) offenders.push(path.relative(repo, full));
      }
    }
  }
  // everything that is built, deployed or used to build scoring data
  for (const dir of ["app", "lib", "components", "db", "drizzle", "tools", "scripts", "public", "types"]) walk(path.join(repo, dir));
  for (const file of ["next.config.ts", "middleware.ts", "instrumentation.ts", "package.json", "tsconfig.json"]) {
    const full = path.join(repo, file);
    if (fs.existsSync(full) && needles.some((n) => fs.readFileSync(full, "utf8").includes(n))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  // and nothing traces test fixtures into a serverless bundle
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "next.config.ts"), "utf8"), /tests\/fixtures/);
});
