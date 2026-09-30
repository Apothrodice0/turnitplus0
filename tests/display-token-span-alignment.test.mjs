import assert from "node:assert/strict";
import test from "node:test";
import {
  alignTokenSpans,
  comparisonText,
  mergeAdjacentPositions,
  normalize,
  tokenSpans,
  tokens,
} from "../lib/similarity-core.ts";
import { computeDocumentCorrespondence } from "../lib/document-correspondence.ts";
import { attachEvidenceInterpretation, attachUnifiedSimilarity } from "../lib/document-check-pipeline.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { interpretVerifiedEvidence } from "../lib/evidence-interpretation/interpret.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";

/**
 * DISPLAY TOKEN SPAN ALIGNMENT — scored word positions are indices into
 * tokens(text) (NFKD → lowercase → strip combining marks → split), so the
 * character range the report highlights for position k must be the raw text
 * that produced tokens(text)[k]. A raw [\p{L}\p{N}]+ scan disagreed with
 * tokens() whenever a combining mark sat inside a word or a compatibility
 * symbol (™ ℃ ½ ⓐ) decomposed to letters/digits, and every later position
 * was highlighted on a neighbouring word while the score stayed right.
 *
 * Every case below is also run through an INDEPENDENT oracle
 * (assertSpansProveTokens) that never looks at tokenSpans() internals.
 */

const shown = (text, k) => {
  const span = tokenSpans(text)[k];
  return span ? text.slice(span.start, span.end) : undefined;
};

const fold = (word) => (word ?? "").replace(/ς/g, "σ");

/**
 * Oracle: insert a unique letters-only marker word into the ORIGINAL text at
 * every span edge (overlapping spans — one code point yielding several words,
 * like ½ — share one marker pair), then normalize(). The marker-free words
 * must still be exactly tokens(text), and each marker pair must enclose
 * exactly its own scoring tokens: a shifted, widened or split highlight all
 * fail. Spans may contain no boundary-producing code point in their interior.
 */
function assertSpansProveTokens(text, spans = tokenSpans(text)) {
  const base = comparisonText(text);
  const scored = tokens(text);
  const clusters = [];
  spans.forEach((span, k) => {
    const last = clusters[clusters.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.k1 = k;
    } else clusters.push({ start: span.start, end: span.end, k0: k, k1: k });
  });
  const letters = (i) => [...i.toString(16)].map((c) => "abcdefghijklmnop"["0123456789abcdef".indexOf(c)]).join("");
  const edges = new Map();
  const edge = (offset) => edges.get(offset) ?? edges.set(offset, { ends: [], starts: [] }).get(offset);
  clusters.forEach((cluster, i) => {
    edge(cluster.end).ends.push(` zqxe${letters(i)}q `);
    edge(cluster.start).starts.push(` zqxs${letters(i)}q `);
  });
  let marked = "";
  let previous = 0;
  for (const offset of [...edges.keys()].sort((a, b) => a - b)) {
    marked += base.slice(previous, offset) + edges.get(offset).ends.join("") + edges.get(offset).starts.join("");
    previous = offset;
  }
  marked += base.slice(previous);
  let index = 0;
  const opened = new Map();
  for (const word of normalize(marked).split(" ").filter(Boolean)) {
    const marker = /^zqx([se])([a-p]+)q$/.exec(word);
    if (!marker) {
      assert.equal(fold(word), fold(scored[index]), `marker-free word ${index} must still be scoring token "${scored[index]}" in ${JSON.stringify(text)}`);
      index += 1;
    } else if (marker[1] === "s") opened.set(marker[2], index);
    else {
      const cluster = clusters[parseInt([...marker[2]].map((c) => "0123456789abcdef"["abcdefghijklmnop".indexOf(c)]).join(""), 16)];
      assert.deepEqual([opened.get(marker[2]), index], [cluster.k0, cluster.k1 + 1], `span(s) ${cluster.k0}..${cluster.k1} must enclose exactly their own scoring tokens in ${JSON.stringify(text)}`);
    }
  }
  assert.equal(index, scored.length);
  for (const span of spans) {
    const codePoints = [...base.slice(span.start, span.end)];
    for (const inner of codePoints.slice(1, -1)) {
      assert.ok(!normalize(`a${inner}a`).includes(" "), `span ${JSON.stringify(span.word)} must not contain a boundary code point`);
    }
  }
}

test("1. combining marks: scored 'copied' highlights exactly the raw word 'copied', not a split fragment", () => {
  const text = "résumé copied words";
  assert.deepEqual(tokens(text), ["resume", "copied", "words"]);
  assert.equal(shown(text, 1), "copied");
  assert.equal(shown(text, 0), "résumé", "the marks stay inside their own raw word");
  assert.equal(shown(text, 2), "words");
  assert.equal(tokenSpans(text).length, tokens(text).length);
  assertSpansProveTokens(text);
});

test("2. several combining marks on one base character stay with that word", () => {
  const text = "ṩourcȩ́̈ copied words";
  assert.deepEqual(tokens(text), ["source", "copied", "words"]);
  assert.equal(shown(text, 0), "ṩourcȩ́̈");
  assert.equal(shown(text, 1), "copied");
  assertSpansProveTokens(text);
});

test("3. precomposed and decomposed accents highlight the same words", () => {
  const composed = "café résumé déjà copied words";
  const decomposed = composed.normalize("NFD");
  assert.notEqual(composed, decomposed);
  assert.deepEqual(tokens(composed), tokens(decomposed));
  for (const text of [composed, decomposed]) {
    assert.equal(shown(text, 3), "copied");
    assert.equal(shown(text, 1).normalize("NFC"), "résumé");
    assertSpansProveTokens(text);
  }
});

test("4. compatibility symbols (™ ℃ № ½ ⓐ) map to the raw symbol and later words stay aligned", () => {
  const cases = [
    ["Brand™ copied words", ["brandtm", "copied", "words"], { 0: "Brand™", 1: "copied" }],
    ["Brand ™ copied words", ["brand", "tm", "copied", "words"], { 1: "™", 2: "copied" }],
    ["heated to 25 ℃ copied words", ["heated", "to", "25", "c", "copied", "words"], { 3: "℃", 4: "copied" }],
    ["Order № 7 copied words", ["order", "no", "7", "copied", "words"], { 1: "№", 3: "copied" }],
    ["add ½ copied cup", ["add", "1", "2", "copied", "cup"], { 1: "½", 2: "½", 3: "copied" }],
    ["the ⓒⓞⓤⓡⓣ copied words", ["the", "court", "copied", "words"], { 1: "ⓒⓞⓤⓡⓣ", 2: "copied" }],
  ];
  for (const [text, expectedTokens, expectedShown] of cases) {
    assert.deepEqual(tokens(text), expectedTokens, text);
    for (const [k, raw] of Object.entries(expectedShown)) assert.equal(shown(text, Number(k)), raw, `${text} @${k}`);
    assertSpansProveTokens(text);
  }
});

test("5. ligatures NFKD already folds (ﬁ ﬂ ﬃ) highlight the raw ligature spelling", () => {
  const text = "ﬁnal ﬂow eﬃcient copied";
  assert.deepEqual(tokens(text), ["final", "flow", "efficient", "copied"]);
  assert.deepEqual([0, 1, 2, 3].map((k) => shown(text, k)), ["ﬁnal", "ﬂow", "eﬃcient", "copied"]);
  assertSpansProveTokens(text);
});

test("6. full-width Latin maps to the raw full-width words", () => {
  const text = "ＣＯＰＩＥＤ ｗｏｒｄｓ ｈｅｒｅ then plain";
  assert.deepEqual(tokens(text), ["copied", "words", "here", "then", "plain"]);
  assert.equal(shown(text, 0), "ＣＯＰＩＥＤ");
  assert.equal(shown(text, 3), "then");
  assertSpansProveTokens(text);
});

test("7. Greek sigma: final ς from whole-string lowercasing is matched to the raw word; the rule is one-directional", () => {
  const text = "ΟΔΥΣΣΕΥΣ copied words ΑΣ. ΑΣ'Β σοφός ΛΟΓΟΣ end";
  const scored = tokens(text);
  assert.deepEqual(scored, ["οδυσσευς", "copied", "words", "ας", "ασ", "β", "σοφος", "λογος", "end"]);
  assert.equal(tokenSpans(text).length, scored.length, "no sigma position may fail closed");
  assert.equal(shown(text, 0), "ΟΔΥΣΣΕΥΣ");
  assert.equal(shown(text, 1), "copied");
  assert.equal(shown(text, 3), "ΑΣ");
  assert.equal(shown(text, 7), "ΛΟΓΟΣ");
  assert.equal(shown(text, 8), "end");
  assertSpansProveTokens(text);
  // only derived σ vs scored ς is tolerated; nothing else is
  assert.deepEqual(alignTokenSpans("ς copied", ["σ", "copied"]), []);
});

test("8. Arabic presentation forms and harakat map to the raw Arabic words", () => {
  const forms = "ﻻ ﺍﻟﻤﺤﻜﻤﺔ copied words";
  assert.deepEqual(tokens(forms), ["لا", "المحكمة", "copied", "words"]);
  assert.equal(shown(forms, 1), "ﺍﻟﻤﺤﻜﻤﺔ");
  assert.equal(shown(forms, 2), "copied");
  assertSpansProveTokens(forms);
  const harakat = "نَظَرَتِ المَحْكَمَةُ الدُّسْتُورِيَّةُ copied words";
  assert.deepEqual(tokens(harakat), ["نظرت", "المحكمة", "الدستورية", "copied", "words"]);
  assert.equal(shown(harakat, 2), "الدُّسْتُورِيَّةُ");
  assert.equal(shown(harakat, 3), "copied");
  assertSpansProveTokens(harakat);
});

test("9-10. empty and punctuation-only text have no scoring tokens and no spans", () => {
  for (const text of ["", "... — !!! ,,, «» () ؟ ،", "́́ ّ", "   \n\t "]) {
    assert.deepEqual(tokens(text), []);
    assert.deepEqual(tokenSpans(text), []);
  }
});

test("11. repeated identical words map by index, never by searching for the word", () => {
  const text = "résumé copy copy copy end";
  const first = text.indexOf("copy");
  const second = text.indexOf("copy", first + 1);
  const third = text.indexOf("copy", second + 1);
  assert.deepEqual(tokenSpans(text).slice(1, 4).map((span) => span.start), [first, second, third]);
  assertSpansProveTokens(text);
});

test("12. surrogate pairs / astral code points around matched words", () => {
  const text = "😀copied 𝐀𝐁 words😀 𝒸𝑜𝓅𝒾𝑒𝒹 end 😀";
  assert.deepEqual(tokens(text), ["copied", "ab", "words", "copied", "end"]);
  assert.deepEqual([0, 1, 2, 3, 4].map((k) => shown(text, k)), ["copied", "𝐀𝐁", "words", "𝒸𝑜𝓅𝒾𝑒𝒹", "end"]);
  assertSpansProveTokens(text);
});

test("13. combining marks at the beginning/end of the text: a leading orphan mark belongs to no word, a trailing one to its word", () => {
  const text = "́resume copied resumé";
  assert.deepEqual(tokens(text), ["resume", "copied", "resume"]);
  assert.deepEqual(tokenSpans(text)[0], { word: "resume", start: 1, end: 7 });
  assert.deepEqual(tokenSpans(text)[2], { word: "resumé", start: 15, end: text.length });
  assertSpansProveTokens(text);
});

test("14. several matched ranges in one paragraph each highlight their own raw words", () => {
  const text = "Le résumé détaillé ™ the constitutional court examined whether ﬁnal ℃ the legislative amendment affected the independence.";
  const scored = tokens(text);
  const first = scored.indexOf("constitutional");
  const second = scored.indexOf("legislative");
  const positions = [first, first + 1, first + 2, second, second + 1, second + 2];
  const spans = tokenSpans(text);
  const highlighted = mergeAdjacentPositions(positions).map(([a, b]) => text.slice(spans[a].start, spans[b].end));
  assert.deepEqual(highlighted, ["constitutional court examined", "legislative amendment affected"]);
  assertSpansProveTokens(text);
});

test("FAIL CLOSED: when the derived words disagree with the scoring tokens, the span array ends there — no later position is shifted onto a neighbour", () => {
  const text = "alpha beta gamma delta";
  assert.deepEqual(alignTokenSpans(text, ["alpha", "beta", "EXTRA", "gamma", "delta"]).map((span) => span.word), ["alpha", "beta"]);
  assert.deepEqual(alignTokenSpans(text, ["alpha", "gamma", "delta"]).map((span) => span.word), ["alpha"]);
  assert.deepEqual(alignTokenSpans(text, ["alpha", "beta"]).map((span) => span.word), ["alpha", "beta"]);
  assert.deepEqual(alignTokenSpans(text, tokens(text)), tokenSpans(text));
});

test("FUZZ: 400 deterministic mixed-script strings — every scoring token gets a span and the independent oracle agrees", () => {
  const pool = [
    "copied", "words", "Court", "the", " ", " ", " ", "\n", ", ", ". ", "é", "́", "ّ", "ً", "͏", "️",
    "™", "℃", "№", "½", "ⓐ", "ﬁ", "ﬃ", "Ｗ", "ΟΔΥΣΣΕΥΣ", "Σ", "ς", "'", "ﻻ", "ﺍﻟ", "نَظَرَتِ", "😀", "𝐀", "İ", "ẞ", "​", "­",
  ];
  let seed = 20260930;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let n = 0; n < 400; n += 1) {
    let text = "";
    const length = 3 + Math.floor(next() * 30);
    for (let i = 0; i < length; i += 1) text += pool[Math.floor(next() * pool.length)];
    assert.equal(tokenSpans(text).length, tokens(text).length, `every token must be mapped for ${JSON.stringify(text)}`);
    assertSpansProveTokens(text);
  }
});

// ---------------------------------------------------------------------------
// End to end: the real report pipeline and both renderers.
// ---------------------------------------------------------------------------
const COPIED = "the constitutional court examined whether the legislative amendment affected the independence of the judiciary";
const SOURCE = `Unrelated opening words appear first. ${COPIED}. Unrelated closing words appear last.`;

function reportFor(prefix) {
  const text = `${prefix} ${COPIED}`;
  const correspondence = computeDocumentCorrespondence(text, SOURCE);
  const positions = [];
  for (const passage of correspondence.allMatchedPassages) {
    for (let word = passage.submittedWordStart; word <= passage.submittedWordEnd; word += 1) positions.push(word);
  }
  let report = {
    id: "r1", title: "repro", fileName: "repro.txt", createdAt: "2026-09-30T00:00:00.000Z",
    text, wordCount: tokens(text).length, score: 0, archiveScore: 0, archiveMatchedPositions: positions,
    sources: [], externalAcademicEvidence: [],
  };
  report = attachEvidenceInterpretation(attachUnifiedSimilarity(report));
  return { text, positions, report };
}

for (const [label, prefix] of [
  ["NFD accents", "Novel preface written by the student about naïve café résumé matters".normalize("NFD")],
  ["Arabic harakat", "مُقَدِّمَةٌ جَدِيدَةٌ كَتَبَهَا الطَّالِبُ"],
  ["circled letters", "Novel preface ⓐⓑⓒ written by the student"],
  ["degree Celsius + fraction", "Heated to 25 ℃ with ½ cup added by the student"],
  ["trade mark", "Brand™ products reviewed by the student"],
]) {
  test(`END TO END (${label}): the verified copied passage is highlighted exactly, in the Report V2 view and the shared highlighter`, () => {
    const { text, positions, report } = reportFor(prefix);
    assert.equal(positions.length, tokens(COPIED).length);
    assert.equal(Math.min(...positions), tokens(prefix).length, "scoring positions start at the first copied word");
    const vm = buildReportV2ViewModel(report);
    assert.equal(vm.passages.length, 1);
    const [passage] = vm.passages;
    assert.equal(passage.highlightText, COPIED);
    assert.equal(passage.charStart, text.indexOf(COPIED));
    assert.equal(passage.charEnd, text.length);
    const ranges = findHighlightRanges(report).filter((range) => range.kind === "v2-evidence");
    assert.deepEqual(ranges.map((range) => text.slice(range.start, range.end)), [COPIED]);
  });
}

test("INTERPRETATION: quotation detection reads the raw quoted words, not text shifted by marks earlier in the document", () => {
  const quoted = "alpha bravo charlie delta echo foxtrot golf hotel";
  const submissionText = `نَظَرَتِ المَحْكَمَةُ الدُّسْتُورِيَّةُ فِي “${quoted}” and more words after it.`;
  const start = tokens(submissionText).indexOf("alpha");
  assert.equal(start, 4);
  const result = interpretVerifiedEvidence({
    submissionText,
    submissionWordCount: tokens(submissionText).length,
    sources: [{ key: "s", spans: [{ start, end: start + 7 }], familyGuardActivated: false, dominantSpanBoilerplate: false, submissionCoverageFraction: 0.5 }],
  });
  assert.equal(result.bySource.get("s")[0].kind, "DECLARED_QUOTATION");
});

test("INTERPRETATION FAIL CLOSED: a span with no proven char range is never read as quoted (no clamp onto the last word)", () => {
  const submissionText = "“alpha bravo charlie delta echo foxtrot golf hotel india”";
  const result = interpretVerifiedEvidence({
    submissionText,
    submissionWordCount: 9,
    sources: [{ key: "s", spans: [{ start: 5, end: 12 }], familyGuardActivated: false, dominantSpanBoilerplate: false, submissionCoverageFraction: 0.5 }],
  });
  assert.equal(result.bySource.get("s")[0].kind, "DISTINCTIVE_EXTERNAL_MATCH");
});
