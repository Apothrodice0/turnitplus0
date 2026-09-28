import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import {
  mapCanonicalTokensToRawTokens,
  projectCanonicalSpanToRaw,
  projectCanonicalPassagesToRaw,
} from "../lib/canonical-token-position-map.ts";

const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const WORD_JOINER = String.fromCharCode(0x2060);

/** Maps raw text through the real canonicalization, returning the mapping as plain [rawStart, rawEnd] pairs. */
function mapThroughCanonicalization(raw) {
  return mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw)).map((run) => (run ? [run.rawStart, run.rawEnd] : null));
}

function identity(count) {
  return Array.from({ length: count }, (_, index) => [index, index]);
}

test("unchanged plain text maps every canonical token to the raw token at the same index", () => {
  const raw = "Glaciologists recovered a continuous core from the icefield.";
  assert.deepEqual(mapThroughCanonicalization(raw), identity(tokens(raw).length));
});

test("a zero-width mark inside a word maps the merged canonical token to both raw fragments and shifts nothing after it", () => {
  for (const mark of [ZWSP, ZWNJ, ZWJ, BOM]) {
    const raw = `alpha be${mark}ta gamma delta`;
    assert.deepEqual(tokens(raw), ["alpha", "be", "ta", "gamma", "delta"]);
    assert.deepEqual(tokens(canonicalizeText(raw)), ["alpha", "beta", "gamma", "delta"]);
    assert.deepEqual(mapThroughCanonicalization(raw), [[0, 0], [1, 2], [3, 3], [4, 4]], `mark U+${mark.charCodeAt(0).toString(16)}`);
  }
});

test("repeated zero-width marks inside one word map to one contiguous raw run", () => {
  const raw = `a${ZWSP}l${ZWSP}${ZWSP}p${ZWJ}ha beta ga${BOM}${ZWNJ}mma`;
  assert.deepEqual(tokens(raw), ["a", "l", "p", "ha", "beta", "ga", "mma"]);
  assert.deepEqual(mapThroughCanonicalization(raw), [[0, 3], [4, 4], [5, 6]]);
});

test("zero-width marks between words (next to whitespace) leave raw position identity untouched", () => {
  const raw = `alpha ${ZWSP} beta${ZWSP} ${ZWJ}gamma ${BOM}delta`;
  assert.deepEqual(tokens(raw), tokens(canonicalizeText(raw)));
  assert.deepEqual(mapThroughCanonicalization(raw), identity(4));
});

test("a zero-width mark as the only separator maps the joined canonical token to both raw words it was spelled from", () => {
  const raw = `alpha${ZWSP}beta gamma`;
  assert.deepEqual(tokens(canonicalizeText(raw)), ["alphabeta", "gamma"]);
  assert.deepEqual(mapThroughCanonicalization(raw), [[0, 1], [2, 2]]);
});

test("punctuation already normalized today keeps raw position identity", () => {
  const raw = "Alpha, beta; gamma — delta! (epsilon) “quoted” it's well-known... [1] 3.14";
  assert.deepEqual(mapThroughCanonicalization(raw), identity(tokens(raw).length));
});

test("normal whitespace and newlines (CRLF, tabs, blank-line runs, leading/trailing space) keep raw position identity", () => {
  const raw = "  alpha   beta\r\n\r\n\r\n\r\ngamma\t\tdelta \n\n epsilon  \r zeta  ";
  assert.deepEqual(mapThroughCanonicalization(raw), identity(6));
});

test("NBSP keeps raw position identity", () => {
  const raw = `alpha${NBSP}beta${NBSP}${NBSP}gamma delta`;
  assert.deepEqual(mapThroughCanonicalization(raw), identity(4));
});

test("soft hyphen and word joiner are NOT stripped by canonicalization: both spaces split on them identically, so identity holds (normalization policy unchanged)", () => {
  for (const mark of [SOFT_HYPHEN, WORD_JOINER]) {
    const raw = `alpha be${mark}ta gamma`;
    assert.deepEqual(tokens(raw), ["alpha", "be", "ta", "gamma"]);
    assert.deepEqual(tokens(canonicalizeText(raw)), ["alpha", "be", "ta", "gamma"]);
    assert.deepEqual(mapThroughCanonicalization(raw), identity(4));
  }
});

test("projection covers exactly the raw fragments of the projected canonical tokens — nothing before, after, or in between", () => {
  const raw = `one tw${ZWSP}o thr${ZWSP}${ZWSP}e${ZWJ}e four five`;
  assert.deepEqual(tokens(raw), ["one", "tw", "o", "thr", "e", "e", "four", "five"]);
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 1, 2), { rawStart: 1, rawEnd: 5 });
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 3, 4), { rawStart: 6, rawEnd: 7 });
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 0, 0), { rawStart: 0, rawEnd: 0 });
});

test("projection rejects malformed spans", () => {
  const mapping = mapCanonicalTokensToRawTokens("alpha beta", "alpha beta");
  assert.equal(projectCanonicalSpanToRaw(mapping, -1, 0), null);
  assert.equal(projectCanonicalSpanToRaw(mapping, 1, 0), null);
  assert.equal(projectCanonicalSpanToRaw(mapping, 0.5, 1), null);
  assert.equal(projectCanonicalSpanToRaw(mapping, 5, 6), null);
});

test("FAIL CLOSED: once the streams diverge, no later canonical token is ever mapped (no resynchronisation), and projection keeps only the verified prefix", () => {
  const mapping = mapCanonicalTokensToRawTokens("alpha beta gamma delta", "alpha bravo gamma delta");
  assert.deepEqual(mapping, [{ rawStart: 0, rawEnd: 0 }, null, null, null]);
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 0, 3), { rawStart: 0, rawEnd: 0 });
  assert.equal(projectCanonicalSpanToRaw(mapping, 2, 3), null, "gamma/delta happen to match but come after the divergence");
  // Raw stream exhausted before the canonical stream.
  assert.deepEqual(mapCanonicalTokensToRawTokens("alpha beta", "alpha beta gamma"), [{ rawStart: 0, rawEnd: 0 }, { rawStart: 1, rawEnd: 1 }, null]);
  // A canonical token that would need raw tokens past the end is unmapped.
  assert.deepEqual(mapCanonicalTokensToRawTokens("alpha be", "alpha beta"), [{ rawStart: 0, rawEnd: 0 }, null]);
  assert.deepEqual(mapCanonicalTokensToRawTokens("", "alpha"), [null]);
  assert.deepEqual(mapCanonicalTokensToRawTokens("alpha", ""), []);
});

test("REAL reference-section divergence, raw cut earlier: canonical tokens past the raw stream stay unmapped", () => {
  // The heading sits past 50% of the raw text only because of whitespace
  // padding that canonicalizeText collapses, so only raw strips the list.
  const raw = `Alpha beta gamma delta epsilon.${" ".repeat(200)}References [1] Smith J. Title of work. 2019.`;
  const rawTokens = tokens(raw);
  const canonicalTokens = tokens(canonicalizeText(raw));
  assert.equal(rawTokens.length, 5, "fixture sanity: raw strips the reference list");
  assert.ok(canonicalTokens.length > rawTokens.length, "fixture sanity: canonical keeps it");
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  assert.deepEqual(mapping.slice(0, 5), identity(5).map(([s, e]) => ({ rawStart: s, rawEnd: e })));
  assert.ok(mapping.slice(5).every((run) => run === null));
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 3, 8), { rawStart: 3, rawEnd: 4 });
  assert.equal(projectCanonicalSpanToRaw(mapping, 5, 8), null);
});

test("REAL reference-section divergence, canonical cut earlier: raw tokens past the canonical stream are never covered", () => {
  // A zero-width mark inside the heading hides it from the raw detector only.
  const body = "Hydrologists measuring spring discharge across limestone aquifers observed seasonal lag patterns consistent with deep conduit storage beneath the plateau region studied here.";
  const raw = `${body} Refer${ZWSP}ences [1] Smith J. Karst. 2019.`;
  const rawTokens = tokens(raw);
  const canonicalTokens = tokens(canonicalizeText(raw));
  assert.equal(canonicalTokens.length, tokens(body).length, "fixture sanity: canonical strips the reference list");
  assert.ok(rawTokens.length > canonicalTokens.length, "fixture sanity: raw keeps it");
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  assert.deepEqual(mapping, identity(canonicalTokens.length).map(([s, e]) => ({ rawStart: s, rawEnd: e })));
  const covered = Math.max(...mapping.map((run) => run.rawEnd));
  assert.equal(covered, canonicalTokens.length - 1);
});

test("passage projection rewrites only positions (matchedWordCount = raw run length), passes other fields through, drops unmapped passages", () => {
  const raw = `alpha be${ZWSP}ta gamma delta epsilon`;
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  const passages = [
    { submittedText: "beta gamma", submittedWordStart: 1, submittedWordEnd: 2, externalWordStart: null, matchedWordCount: 2 },
    { submittedText: "epsilon", submittedWordStart: 4, submittedWordEnd: 4, externalWordStart: null, matchedWordCount: 1 },
    { submittedText: "out of range", submittedWordStart: 9, submittedWordEnd: 11, externalWordStart: null, matchedWordCount: 3 },
  ];
  assert.deepEqual(projectCanonicalPassagesToRaw(passages, mapping), [
    { submittedText: "beta gamma", submittedWordStart: 1, submittedWordEnd: 3, externalWordStart: null, matchedWordCount: 3 },
    { submittedText: "epsilon", submittedWordStart: 5, submittedWordEnd: 5, externalWordStart: null, matchedWordCount: 1 },
  ]);
});

test("plain-text passages are byte-identical after projection", () => {
  const raw = "alpha beta gamma delta epsilon zeta";
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  const passages = [
    { submittedText: "beta gamma delta", submittedWordStart: 1, submittedWordEnd: 3, matchedWordCount: 3 },
    { submittedText: "zeta", submittedWordStart: 5, submittedWordEnd: 5, matchedWordCount: 1 },
  ];
  assert.deepEqual(projectCanonicalPassagesToRaw(passages, mapping), passages);
});

test("PROPERTY: across deterministic random zero-width insertions, every mapped run spells its canonical token and runs tile the raw stream", () => {
  const words = "glaciologists drilling through taku icefield recovered continuous core whose volcanic ash layers aligned precisely documented eruptions mount katmai allowing researchers calibrate annual accumulation".split(" ");
  const marks = [ZWSP, ZWNJ, ZWJ, BOM];
  const separators = [" ", "  ", "\n", `${NBSP}`, ", ", ". ", ` ${ZWSP} `, "\r\n"];
  let seed = 20260928;
  const next = (bound) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % bound;
  };
  for (let trial = 0; trial < 300; trial += 1) {
    const parts = [];
    const length = 1 + next(30);
    for (let index = 0; index < length; index += 1) {
      let word = words[next(words.length)];
      const insertions = next(4);
      for (let k = 0; k < insertions && word.length > 1; k += 1) {
        const at = 1 + next(word.length - 1);
        word = word.slice(0, at) + marks[next(marks.length)].repeat(1 + next(3)) + word.slice(at);
      }
      parts.push(word, separators[next(separators.length)]);
    }
    const raw = parts.join("");
    const rawTokens = tokens(raw);
    const canonicalTokens = tokens(canonicalizeText(raw));
    const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
    let expectedStart = 0;
    mapping.forEach((run, index) => {
      assert.ok(run, `trial ${trial}: canonical token ${index} unmapped in ${JSON.stringify(raw)}`);
      assert.equal(run.rawStart, expectedStart, `trial ${trial}: runs must be consecutive`);
      assert.equal(rawTokens.slice(run.rawStart, run.rawEnd + 1).join(""), canonicalTokens[index]);
      expectedStart = run.rawEnd + 1;
    });
    assert.equal(expectedStart, rawTokens.length, `trial ${trial}: runs must cover every raw token`);
  }
});
