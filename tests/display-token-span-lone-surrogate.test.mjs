import assert from "node:assert/strict";
import test from "node:test";
import { normalize, tokenSpans, tokens } from "../lib/similarity-core.ts";
import { attachEvidenceInterpretation, attachUnifiedSimilarity } from "../lib/document-check-pipeline.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { interpretVerifiedEvidence } from "../lib/evidence-interpretation/interpret.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";

/**
 * DISPLAY TOKEN SPAN ALIGNMENT — ill-formed UTF-16.
 *
 * A lone high surrogate, a combining mark, then a lone low surrogate: normalize()
 * deletes the mark and the two code units JOIN into one astral letter (U+10000
 * here), so tokens() scores a word that no single original code point produces.
 * When that joined letter is identical to the NEXT token, an index-by-index
 * word check alone would accept the neighbour's raw text for it. The mapping
 * must instead stop at the lone surrogate: nothing from there on gets a range,
 * so the neighbouring identical token is never highlighted for it.
 *
 * Scoring is untouched: tokens() still joins the units (asserted below).
 */

const JOINED = "\uD800́\uDC00"; // lone high + combining acute + lone low
const ASTRAL = "𐀀"; // the well-formed U+10000, the same letter the join produces

/** Every span that IS returned is proven: its raw slice normalizes to exactly its own scoring token. */
function provenSpans(text) {
  const spans = tokenSpans(text);
  const scored = tokens(text);
  spans.forEach((span, k) => {
    assert.equal(text.slice(span.start, span.end), span.word);
    assert.equal(normalize(span.word), scored[k], `span ${k} must spell scoring token ${JSON.stringify(scored[k])}`);
  });
  return spans;
}

const overlaps = (range, [start, end]) => range.start < end && range.end > start;

function reportFor(text, positions) {
  return attachEvidenceInterpretation(
    attachUnifiedSimilarity({
      id: "r1", title: "repro", fileName: "repro.txt", createdAt: "2026-09-30T00:00:00.000Z",
      text, wordCount: tokens(text).length, score: 0, archiveScore: 0, archiveMatchedPositions: positions,
      sources: [], externalAcademicEvidence: [],
    }),
  );
}

test("MALFORMED UTF-16 1: a joined lone-surrogate token is never mapped onto its identical neighbour", () => {
  const text = `${JOINED} ${ASTRAL} copied words`;
  assert.deepEqual(tokens(text), ["\u{10000}", "\u{10000}", "copied", "words"], "scoring still joins the lone surrogates");
  assert.equal(text.slice(4, 6), ASTRAL, "the neighbouring identical token's raw text is chars 4-6");
  assert.deepEqual(provenSpans(text), [], "the mapping stops at the first lone surrogate; nothing after it is mapped");
});

test("MALFORMED UTF-16 2: valid spans before the malformed input are kept; nothing at or after it is mapped", () => {
  const text = `intro text ${JOINED} ${ASTRAL} copied words`;
  assert.deepEqual(tokens(text), ["intro", "text", "\u{10000}", "\u{10000}", "copied", "words"]);
  assert.equal(text.slice(15, 17), ASTRAL);
  assert.deepEqual(provenSpans(text), [
    { word: "intro", start: 0, end: 5 },
    { word: "text", start: 6, end: 10 },
  ]);
});

test("MALFORMED UTF-16 3: a joined letter inside a word keeps only the valid prefix", () => {
  const text = `x y ab${JOINED}cd copied words`;
  assert.deepEqual(tokens(text), ["x", "y", "ab\u{10000}cd", "copied", "words"]);
  assert.deepEqual(provenSpans(text), [
    { word: "x", start: 0, end: 1 },
    { word: "y", start: 2, end: 3 },
  ]);
});

test("MALFORMED UTF-16 4: the Report V2 view and the shared highlighter never highlight the neighbouring identical token", () => {
  const cases = [
    // [text, scored positions, the neighbour's raw chars, the proven highlight the view may show (null = none)]
    [`${JOINED} ${ASTRAL} copied words`, [0], [4, 6], null],
    [`${JOINED} ${ASTRAL} copied words`, [0, 1], [4, 6], null],
    [`intro text ${JOINED} ${ASTRAL} copied words`, [2], [15, 17], null],
    [`intro text ${JOINED} ${ASTRAL} copied words`, [1, 2], [15, 17], "text"],
    [`intro text ${JOINED} ${ASTRAL} copied words`, [2, 3], [15, 17], null],
  ];
  for (const [text, positions, neighbour, provenHighlight] of cases) {
    const label = `${JSON.stringify(text)} @ ${positions}`;
    const report = reportFor(text, positions);
    const vm = buildReportV2ViewModel(report);
    assert.equal(vm.passages.length, 1, label);
    const [passage] = vm.passages;
    if (provenHighlight === null) {
      assert.equal(passage.charStart, null, `${label}: an unprovable passage start gets no character range`);
      assert.equal(passage.highlightText, passage.excerpt, `${label}: the view falls back to the scored excerpt`);
    } else {
      // the passage starts on a proven word: only proven words inside the passage may be highlighted
      assert.equal(passage.highlightText, provenHighlight, label);
      assert.ok(!overlaps({ start: passage.charStart, end: passage.charEnd }, neighbour), `${label}: view range must not reach the neighbour`);
    }
    const ranges = findHighlightRanges(report);
    for (const range of ranges) {
      assert.ok(!overlaps(range, neighbour), `${label}: highlighter range ${range.start}-${range.end} must not touch the neighbour`);
    }
    assert.deepEqual(ranges.filter((range) => range.kind === "v2-evidence"), [], `${label}: a passage with an unmapped end is not highlighted`);
  }
});

test("MALFORMED UTF-16 5: the quotation check never reads the neighbour's quoted text for the joined token", () => {
  // the joined token (position 0) sits OUTSIDE the quotes; its identical neighbour sits INSIDE them
  const submissionText = `${JOINED} “${ASTRAL} alpha bravo charlie delta echo foxtrot golf” and more words after it.`;
  assert.deepEqual(tokens(submissionText).slice(0, 3), ["\u{10000}", "\u{10000}", "alpha"]);
  const result = interpretVerifiedEvidence({
    submissionText,
    submissionWordCount: tokens(submissionText).length,
    sources: [{ key: "s", spans: [{ start: 0, end: 0 }], familyGuardActivated: false, dominantSpanBoilerplate: false, submissionCoverageFraction: 0.5 }],
  });
  assert.equal(result.bySource.get("s")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
});

test("WELL-FORMED CONTROL: real astral letters (valid surrogate pairs) are still mapped in full", () => {
  const text = `${ASTRAL} copied ${ASTRAL} words 𝐀𝐁 end`;
  assert.deepEqual(provenSpans(text).map((span) => span.word), [ASTRAL, "copied", ASTRAL, "words", "𝐀𝐁", "end"]);
  assert.equal(tokenSpans(text).length, tokens(text).length);
});

test("FAIL-CLOSED COST: any lone surrogate ends the mapping, even one that joins nothing", () => {
  const text = "alpha beta \uD800 gamma delta";
  assert.deepEqual(tokens(text), ["alpha", "beta", "gamma", "delta"], "scoring treats the lone surrogate as a boundary (unchanged)");
  assert.deepEqual(provenSpans(text).map((span) => span.word), ["alpha", "beta"]);
});
