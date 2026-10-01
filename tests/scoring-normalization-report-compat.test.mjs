import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  normalizeScoringV1,
  normalizeScoringV2,
  reportScoringNormalizationVersion,
  tokenSpans,
  tokensForScoringNormalization,
} from "../lib/similarity-core.ts";
import { runWithScoringNormalization } from "../lib/scoring-normalization-scope.ts";
import { attachEvidenceInterpretation, attachUnifiedSimilarity } from "../lib/document-check-pipeline.ts";
import { withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { buildReportV2ViewModel, paginateManuscriptText } from "../lib/report-v2-view.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";

/**
 * RELEASE GATE — one raw manuscript, two persisted contracts, read by one build.
 *
 * A report's word positions index the word sequence of the scoring
 * normalization they were computed under. The same raw text must render
 * correctly from v1 positions (no stamp: an invisible format character still
 * splits a word) and from v2 positions (stamp 2: it does not) — whichever
 * contract the build reading it computes NEW checks under. Every reader takes
 * the report's own contract; nothing here depends on the build's active one,
 * so this file holds for a build that defaults to either.
 */

const cp = (n) => String.fromCodePoint(n);
const ZWSP = cp(0x200b);
const SHY = cp(0x00ad);
const WJ = cp(0x2060);
const RLM = cp(0x200f);
const MARKS = [ZWSP, SHY, WJ, RLM];

/** Puts one invisible format character inside each of the first `count` words of length >= 5. */
function markInsideWords(text, count) {
  let used = 0;
  return text.split(" ").map((word) => {
    if (used >= count || word.replace(/[^\p{L}]/gu, "").length < 5) return word;
    const mark = MARKS[used % MARKS.length];
    used += 1;
    return `${word.slice(0, 2)}${mark}${word.slice(2)}`;
  }).join(" ");
}

const INTRO = markInsideWords(
  "Beekeepers monitoring orchard pollination throughout springtime noticed hives positioned beside hedgerows produced noticeably heavier honey yields compared against colonies standing beside plowed fields during several consecutive seasons, although weather records remained incomplete throughout the surveyed district and several keepers disputed the published figures afterwards.",
  30,
);
const PASSAGE_WORDS = "glaciologists drilling through the icefield recovered a continuous core whose volcanic ash layers aligned precisely with documented eruptions allowing researchers to calibrate annual accumulation rates across four centuries";
// The copied passage also carries marks, and is a declared, attributed quotation.
const PASSAGE = markInsideWords(PASSAGE_WORDS, 5);
const OUTRO = "Ferry operators subsequently rescheduled timetables because tidal currents intensified unexpectedly during autumn storms along the northern channel.";
const MANUSCRIPT = `${INTRO} According to Smith (2019), “${PASSAGE}” ${OUTRO}`;

/** The copied passage's word range in the given contract's word sequence, computed from the parts — never from the code under test. */
function passageRange(version) {
  const tok = (text) => tokensForScoringNormalization(text, version);
  const start = tok(`${INTRO} According to Smith (2019), `).length;
  const count = tok(PASSAGE).length;
  assert.equal(tok(MANUSCRIPT).length, start + count + tok(OUTRO).length, "fixture sanity: parts tokenize independently");
  return { start, end: start + count - 1, count };
}
const range = (r) => Array.from({ length: r.count }, (_, index) => r.start + index);
const PASSAGE_CHAR_START = MANUSCRIPT.indexOf(PASSAGE);
const PASSAGE_CHAR_END = PASSAGE_CHAR_START + PASSAGE.length;

function baseReport(version) {
  const r = passageRange(version);
  return {
    version: 11, id: 1, submissionId: "s1", title: "compat.txt", author: "a", assignment: "", created: "2026-10-01T00:00:00.000Z",
    text: MANUSCRIPT,
    wordCount: tokensForScoringNormalization(MANUSCRIPT, version).length,
    score: 0, archiveScore: 0, scoreBand: "Low", matchedWordCount: r.count,
    archiveMatchedPositions: range(r),
    sources: [], repeats: [], externalAcademicEvidence: [],
    ...(version === 2 ? { scoringNormalizationVersion: 2 } : {}),
  };
}
const finished = (report) => attachEvidenceInterpretation(attachUnifiedSimilarity(report));

test("FIXTURE: the two contracts really index different word sequences for this manuscript", () => {
  const v1 = passageRange(1);
  const v2 = passageRange(2);
  assert.equal(v1.start, v2.start + 30, "30 in-word marks before the passage: its v1 start is 30 words later");
  assert.equal(v1.count, v2.count + 5, "5 in-word marks inside it: five more v1 words");
  assert.deepEqual(tokensForScoringNormalization(PASSAGE, 2), PASSAGE_WORDS.split(" "), "v2 reads the passage as the words it shows");
  assert.equal(normalizeScoringV1(PASSAGE).split(" ").length, PASSAGE_WORDS.split(" ").length + 5);
  assert.equal(normalizeScoringV2(PASSAGE), PASSAGE_WORDS);
});

// Each report is rendered three ways: with no scope (a browser, or SSR — the build's own active contract is the
// ambient one), and inside a server scope of EACH contract. The report's own stamp must win every time.
const AMBIENT = [
  ["no scope", (render) => render()],
  ["inside a v1 scope", (render) => runWithScoringNormalization(1, render)],
  ["inside a v2 scope", (render) => runWithScoringNormalization(2, render)],
];

for (const version of [1, 2]) {
  const label = version === 1 ? "LEGACY v1 report (no stamp)" : "v2 report (stamp 2)";

  for (const [ambientLabel, within] of AMBIENT) {
    test(`${label}, rendered ${ambientLabel}: the persisted word positions highlight exactly the copied raw characters — no neighbour shift`, () => within(() => {
      const report = finished(baseReport(version));
      assert.equal(reportScoringNormalizationVersion(report), version);
      assert.equal("scoringNormalizationVersion" in report, version === 2);

      // Report V2 view model.
      const vm = buildReportV2ViewModel(report);
      assert.equal(vm.passages.length, 1);
      const [passage] = vm.passages;
      assert.equal(passage.charStart, PASSAGE_CHAR_START);
      assert.equal(passage.charEnd, PASSAGE_CHAR_END);
      assert.equal(MANUSCRIPT.slice(passage.charStart, passage.charEnd), PASSAGE, "the highlighted raw text is the copied passage, invisible characters included");
      assert.equal(passage.highlightText, PASSAGE);

      // The shared highlighter.
      const ranges = findHighlightRanges(report).filter((r) => r.kind === "v2-evidence");
      assert.deepEqual(ranges.map((r) => [r.start, r.end]), [[PASSAGE_CHAR_START, PASSAGE_CHAR_END]]);

      // Every span of this contract spells its own scoring token, and the spans tile the token list.
      const spans = tokenSpans(MANUSCRIPT, version);
      const scored = tokensForScoringNormalization(MANUSCRIPT, version);
      assert.equal(spans.length, scored.length);
      const norm = version === 1 ? normalizeScoringV1 : normalizeScoringV2;
      spans.forEach((span, index) => assert.equal(norm(span.word), scored[index]));
      const r = passageRange(version);
      assert.equal(spans[r.start].start, PASSAGE_CHAR_START);
      assert.equal(spans[r.end].end, PASSAGE_CHAR_END);
    }));

    test(`${label}, rendered ${ambientLabel}: the excerpt and the quotation label are read through the report's own contract`, () => within(() => {
      const report = finished(baseReport(version));
      const [passage] = report.evidenceInterpretation.passages;
      const r = passageRange(version);
      assert.equal(passage.wordStart, r.start);
      assert.equal(passage.wordEnd, r.end);
      assert.equal(passage.interpretation.kind, "ATTRIBUTED_QUOTATION", "curly quotes + \"According to Smith (2019)\"");
      const expectedExcerpt = tokensForScoringNormalization(MANUSCRIPT, version).slice(r.start, Math.min(r.end + 1, r.start + 40));
      assert.equal(passage.excerpt.replace(/ …$/, ""), expectedExcerpt.join(" "));
      assert.equal(report.evidenceInterpretation.matchedWordCount, r.count);
    }));

    test(`${label}, rendered ${ambientLabel}: pagination reconstructs the text, cuts only at this contract's word starts, and never splits the highlight`, () => within(() => {
      const report = finished(baseReport(version));
      const vm = buildReportV2ViewModel(report);
      const occupied = vm.passages.map((p) => ({ start: p.charStart, end: p.charEnd }));
      const starts = new Set(tokenSpans(MANUSCRIPT, version).map((span) => span.start));
      for (const wordsPerPage of [7, 20, 45]) {
        const pages = paginateManuscriptText(MANUSCRIPT, occupied, wordsPerPage, version);
        assert.ok(pages.length > 1);
        assert.equal(pages.map((p) => MANUSCRIPT.slice(p.start, p.end)).join(""), MANUSCRIPT);
        for (const page of pages.slice(1)) {
          assert.ok(starts.has(page.start) || page.start === PASSAGE_CHAR_END || page.start === MANUSCRIPT.length, `page boundary ${page.start} is a word start`);
          assert.ok(!(page.start > PASSAGE_CHAR_START && page.start < PASSAGE_CHAR_END), "the highlight is never split across pages");
        }
      }
      // A page is counted in the report's own words: one page boundary differs between the two contracts.
      const own = paginateManuscriptText(MANUSCRIPT, [], 10, version).map((p) => p.start);
      const other = paginateManuscriptText(MANUSCRIPT, [], 10, version === 1 ? 2 : 1).map((p) => p.start);
      assert.notDeepEqual(own, other);
    }));
  }

  test(`${label}: every rendering is the same whichever contract is ambient`, () => {
    const render = () => {
      const report = finished(baseReport(version));
      return JSON.stringify({
        interpretation: report.evidenceInterpretation,
        unified: report.unifiedSimilarity,
        view: buildReportV2ViewModel(report).passages,
        highlights: findHighlightRanges(report),
      });
    };
    const outputs = AMBIENT.map(([, within]) => within(render));
    assert.equal(outputs[1], outputs[0]);
    assert.equal(outputs[2], outputs[0]);
  });
}

test("the stamp is what makes the difference: v1 positions read as v2 (or v2 as v1) land on other words and lose the quotation", () => {
  // v1 positions wrongly stamped v2: the passage is read 30+ words late — into the novel outro.
  const promoted = finished({ ...baseReport(1), scoringNormalizationVersion: 2 });
  const promotedVm = buildReportV2ViewModel(promoted);
  const promotedText = promotedVm.passages.map((p) => (p.charStart === null ? null : MANUSCRIPT.slice(p.charStart, p.charEnd)));
  assert.notDeepEqual(promotedText, [PASSAGE]);
  assert.notEqual(promoted.evidenceInterpretation.passages[0].interpretation.kind, "ATTRIBUTED_QUOTATION");

  // v2 positions with the stamp lost: read 30 words early — into the novel intro.
  const { scoringNormalizationVersion: _dropped, ...demotedBase } = baseReport(2);
  const demoted = finished(demotedBase);
  const demotedVm = buildReportV2ViewModel(demoted);
  assert.notDeepEqual(demotedVm.passages.map((p) => (p.charStart === null ? null : MANUSCRIPT.slice(p.charStart, p.charEnd))), [PASSAGE]);
  assert.notEqual(demoted.evidenceInterpretation.passages[0].interpretation.kind, "ATTRIBUTED_QUOTATION");
});

test("a report with no invisible format character is identical under both contracts — the stamp changes nothing for it", () => {
  const plain = MANUSCRIPT.replace(new RegExp(`[${MARKS.join("")}]`, "gu"), "");
  assert.deepEqual(tokensForScoringNormalization(plain, 1), tokensForScoringNormalization(plain, 2));
  assert.deepEqual(tokenSpans(plain, 1), tokenSpans(plain, 2));
  const start = tokensForScoringNormalization(plain.slice(0, plain.indexOf("“")), 1).length;
  const count = PASSAGE_WORDS.split(" ").length;
  const base = {
    version: 11, id: 2, submissionId: "s2", title: "plain.txt", author: "a", assignment: "", created: "2026-10-01T00:00:00.000Z",
    text: plain, wordCount: tokensForScoringNormalization(plain, 1).length, score: 0, archiveScore: 0, scoreBand: "Low", matchedWordCount: count,
    archiveMatchedPositions: Array.from({ length: count }, (_, index) => start + index), sources: [], repeats: [], externalAcademicEvidence: [],
  };
  const unstamped = finished(base);
  const stamped = finished({ ...base, scoringNormalizationVersion: 2 });
  assert.deepEqual(unstamped.evidenceInterpretation, stamped.evidenceInterpretation);
  assert.deepEqual(unstamped.unifiedSimilarity, stamped.unifiedSimilarity);
  assert.deepEqual(buildReportV2ViewModel(unstamped).passages, buildReportV2ViewModel(stamped).passages);
  assert.deepEqual(findHighlightRanges(unstamped), findHighlightRanges(stamped));
  assert.deepEqual(paginateManuscriptText(plain, [], 12, 1), paginateManuscriptText(plain, [], 12, 2));
});

test("withEvidenceInterpretation rebuilds a report's interpretation in the report's own contract — whatever contract is ambient", () => {
  for (const version of [1, 2]) {
    const report = attachUnifiedSimilarity(baseReport(version));
    const r = passageRange(version);
    for (const [ambientLabel, within] of AMBIENT) {
      const rebuilt = within(() => withEvidenceInterpretation(report, { selectiveCorpusBranch: null }));
      assert.deepEqual(
        rebuilt.evidenceInterpretation.passages.map((p) => [p.wordStart, p.wordEnd, p.interpretation.kind]),
        [[r.start, r.end, "ATTRIBUTED_QUOTATION"]],
        `v${version} report, ${ambientLabel}`,
      );
      assert.equal("scoringNormalizationVersion" in rebuilt, version === 2, "an interpretation rebuild never stamps or unstamps");
    }
  }
});

test("who may write the stamp: the check that computed the positions (on its own, unsaved report object) and the save route (the persisted one) — nothing else", () => {
  const root = path.resolve(".");
  const writers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        // Comments say the field's name; only code can set it.
        const source = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        // an object-literal entry / assignment / JSON path that SETS the report field to a value (reads go through
        // reportScoringNormalizationVersion; passing a `scoringNormalizationVersion` argument to a function is not a write)
        if (/scoringNormalizationVersion:\s*2\b/.test(source) || /scoringNormalizationVersion:\s*\w+\s*===\s*2\s*\?\s*2\s*:\s*undefined/.test(source) || /\.scoringNormalizationVersion\s*=[^=]/.test(source) || /json_set\([^)]*scoringNormalizationVersion/.test(source)) {
          writers.push(path.relative(root, full).replace(/\\/g, "/"));
        }
      }
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(path.join(root, dir));
  assert.deepEqual(writers.sort(), ["app/api/reports/route.ts", "lib/document-check-pipeline.ts"]);

  // The save route writes it from the contract it decided and checked — never from the payload, never from the build's constant.
  const route = fs.readFileSync(path.join(root, "app", "api", "reports", "route.ts"), "utf8");
  assert.match(route, /scoringNormalizationVersion: reportScoringVersion === 2 \? 2 : undefined/);
  assert.match(route, /const reportScoringVersion: ScoringNormalizationVersion = persistedScoringNormalizationVersion \?\? declaredScoringNormalizationVersion;/);
  assert.doesNotMatch(route, /ACTIVE_SCORING_NORMALIZATION_VERSION/);
  assert.doesNotMatch(route, /reportScoringNormalizationVersion\(/, "the route never reads the stamp off the resubmitted payload");
  // The other payload writers replace named keys only — never the stamp — and guard on it instead.
  for (const file of ["lib/report-primary-similarity.ts", "lib/selective-corpus-authoritative.ts", "app/api/reports/[id]/ai-retry/route.ts"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /'\$\.scoringNormalizationVersion',/, `${file} never sets the stamp`);
  }
  const resolver = fs.readFileSync(path.join(root, "lib", "report-primary-similarity.ts"), "utf8");
  assert.equal((resolver.match(/\$\{SIMILARITY_SCORING_NORMALIZATION_GUARD_SQL\}/g) ?? []).length, 3, "all three similarity write-backs carry the contract guard");
  // Both read-side display resolutions hand the report's own stamp to the snapshot-currency check.
  assert.match(fs.readFileSync(path.join(root, "lib", "reports-repo.ts"), "utf8"), /scoringNormalizationVersion: occupant\.scoring_normalization_version,/);
  assert.match(fs.readFileSync(path.join(root, "app", "reports", "[id]", "page.tsx"), "utf8"), /scoringNormalizationVersion: payload\.scoringNormalizationVersion,/);
  // Every typed caller of the resolver must name the report's contract: the parameter is required.
  assert.match(resolver, /\n    scoringNormalizationVersion: ScoringNormalizationVersion;\r?\n  \},\r?\n\): Promise<PrimarySimilarityResolution> \{/);
});
