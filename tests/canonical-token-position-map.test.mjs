import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { runWithScoringNormalization } from "../lib/scoring-normalization-scope.ts";
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

/**
 * The canonical->raw mapping exists because of scoring normalization v1, where a zero-width mark inside a word splits a
 * raw word that canonicalizeText keeps whole. Every report saved so far is a v1 report and is resolved under v1 whatever
 * a build computes NEW checks under, so these tests name that contract instead of relying on the build's default. The
 * v2 counterparts — where the same marks split nothing — are at the end of the file.
 */
const testV1 = (name, body) => test(name, () => runWithScoringNormalization(1, body));
const testV2 = (name, body) => test(name, () => runWithScoringNormalization(2, body));

testV1("unchanged plain text maps every canonical token to the raw token at the same index", () => {
  const raw = "Glaciologists recovered a continuous core from the icefield.";
  assert.deepEqual(mapThroughCanonicalization(raw), identity(tokens(raw).length));
});

testV1("a zero-width mark inside a word maps the merged canonical token to both raw fragments and shifts nothing after it", () => {
  for (const mark of [ZWSP, ZWNJ, ZWJ, BOM]) {
    const raw = `alpha be${mark}ta gamma delta`;
    assert.deepEqual(tokens(raw), ["alpha", "be", "ta", "gamma", "delta"]);
    assert.deepEqual(tokens(canonicalizeText(raw)), ["alpha", "beta", "gamma", "delta"]);
    assert.deepEqual(mapThroughCanonicalization(raw), [[0, 0], [1, 2], [3, 3], [4, 4]], `mark U+${mark.charCodeAt(0).toString(16)}`);
  }
});

testV1("repeated zero-width marks inside one word map to one contiguous raw run", () => {
  const raw = `a${ZWSP}l${ZWSP}${ZWSP}p${ZWJ}ha beta ga${BOM}${ZWNJ}mma`;
  assert.deepEqual(tokens(raw), ["a", "l", "p", "ha", "beta", "ga", "mma"]);
  assert.deepEqual(mapThroughCanonicalization(raw), [[0, 3], [4, 4], [5, 6]]);
});

testV1("zero-width marks between words (next to whitespace) leave raw position identity untouched", () => {
  const raw = `alpha ${ZWSP} beta${ZWSP} ${ZWJ}gamma ${BOM}delta`;
  assert.deepEqual(tokens(raw), tokens(canonicalizeText(raw)));
  assert.deepEqual(mapThroughCanonicalization(raw), identity(4));
});

testV1("a zero-width mark as the only separator maps the joined canonical token to both raw words it was spelled from", () => {
  const raw = `alpha${ZWSP}beta gamma`;
  assert.deepEqual(tokens(canonicalizeText(raw)), ["alphabeta", "gamma"]);
  assert.deepEqual(mapThroughCanonicalization(raw), [[0, 1], [2, 2]]);
});

testV1("punctuation already normalized today keeps raw position identity", () => {
  const raw = "Alpha, beta; gamma — delta! (epsilon) “quoted” it's well-known... [1] 3.14";
  assert.deepEqual(mapThroughCanonicalization(raw), identity(tokens(raw).length));
});

testV1("normal whitespace and newlines (CRLF, tabs, blank-line runs, leading/trailing space) keep raw position identity", () => {
  const raw = "  alpha   beta\r\n\r\n\r\n\r\ngamma\t\tdelta \n\n epsilon  \r zeta  ";
  assert.deepEqual(mapThroughCanonicalization(raw), identity(6));
});

testV1("NBSP keeps raw position identity", () => {
  const raw = `alpha${NBSP}beta${NBSP}${NBSP}gamma delta`;
  assert.deepEqual(mapThroughCanonicalization(raw), identity(4));
});

testV1("soft hyphen and word joiner are NOT stripped by canonicalization: both spaces split on them identically, so identity holds (normalization policy unchanged)", () => {
  for (const mark of [SOFT_HYPHEN, WORD_JOINER]) {
    const raw = `alpha be${mark}ta gamma`;
    assert.deepEqual(tokens(raw), ["alpha", "be", "ta", "gamma"]);
    assert.deepEqual(tokens(canonicalizeText(raw)), ["alpha", "be", "ta", "gamma"]);
    assert.deepEqual(mapThroughCanonicalization(raw), identity(4));
  }
});

testV1("projection covers exactly the raw fragments of the projected canonical tokens — nothing before, after, or in between", () => {
  const raw = `one tw${ZWSP}o thr${ZWSP}${ZWSP}e${ZWJ}e four five`;
  assert.deepEqual(tokens(raw), ["one", "tw", "o", "thr", "e", "e", "four", "five"]);
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 1, 2), { rawStart: 1, rawEnd: 5 });
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 3, 4), { rawStart: 6, rawEnd: 7 });
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 0, 0), { rawStart: 0, rawEnd: 0 });
});

testV1("projection rejects malformed spans", () => {
  const mapping = mapCanonicalTokensToRawTokens("alpha beta", "alpha beta");
  assert.equal(projectCanonicalSpanToRaw(mapping, -1, 0), null);
  assert.equal(projectCanonicalSpanToRaw(mapping, 1, 0), null);
  assert.equal(projectCanonicalSpanToRaw(mapping, 0.5, 1), null);
  assert.equal(projectCanonicalSpanToRaw(mapping, 5, 6), null);
});

testV1("FAIL CLOSED: once the streams diverge, no later canonical token is ever mapped (no resynchronisation), and projection keeps only the verified prefix", () => {
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

testV1("REAL reference-section divergence, raw cut earlier: canonical tokens past the raw stream stay unmapped", () => {
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

testV1("REAL reference-section divergence, canonical cut earlier: raw tokens past the canonical stream are never covered", () => {
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

testV1("passage projection rewrites only positions (matchedWordCount = raw run length), passes other fields through, drops unmapped passages", () => {
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

testV1("plain-text passages are byte-identical after projection", () => {
  const raw = "alpha beta gamma delta epsilon zeta";
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  const passages = [
    { submittedText: "beta gamma delta", submittedWordStart: 1, submittedWordEnd: 3, matchedWordCount: 3 },
    { submittedText: "zeta", submittedWordStart: 5, submittedWordEnd: 5, matchedWordCount: 1 },
  ];
  assert.deepEqual(projectCanonicalPassagesToRaw(passages, mapping), passages);
});

testV1("PROPERTY: across deterministic random zero-width insertions, every mapped run spells its canonical token and runs tile the raw stream", () => {
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

// --- scoring normalization v2 ------------------------------------------------
// v2 deletes the invisible format characters in the tokenizer itself, on both sides. The raw and the canonical word
// sequences then agree over them, and the mapping is the identity: there is no raw fragment to map a merged word onto.

testV2("v2: a zero-width mark inside a word, repeated marks, and a mark as the only separator all map by identity", () => {
  for (const mark of [ZWSP, ZWNJ, ZWJ, BOM]) {
    const raw = `alpha be${mark}ta gamma delta`;
    assert.deepEqual(tokens(raw), ["alpha", "beta", "gamma", "delta"]);
    assert.deepEqual(tokens(canonicalizeText(raw)), ["alpha", "beta", "gamma", "delta"]);
    assert.deepEqual(mapThroughCanonicalization(raw), identity(4), `mark U+${mark.charCodeAt(0).toString(16)}`);
  }
  const repeated = `a${ZWSP}l${ZWSP}${ZWSP}p${ZWJ}ha beta ga${BOM}${ZWNJ}mma`;
  assert.deepEqual(tokens(repeated), ["alpha", "beta", "gamma"]);
  assert.deepEqual(mapThroughCanonicalization(repeated), identity(3));
  const joined = `alpha${ZWSP}beta gamma`;
  assert.deepEqual(tokens(joined), ["alphabeta", "gamma"]);
  assert.deepEqual(mapThroughCanonicalization(joined), identity(2));
});

testV2("v2: soft hyphen and word joiner are kept by canonicalizeText and deleted by the tokenizer on both sides — identity", () => {
  for (const mark of [SOFT_HYPHEN, WORD_JOINER]) {
    const raw = `alpha be${mark}ta gamma`;
    assert.ok(canonicalizeText(raw).includes(mark), "the canonical identity text still carries the mark");
    assert.deepEqual(tokens(raw), ["alpha", "beta", "gamma"]);
    assert.deepEqual(tokens(canonicalizeText(raw)), ["alpha", "beta", "gamma"]);
    assert.deepEqual(mapThroughCanonicalization(raw), identity(3));
  }
});

testV2("v2: a passage projected through the mapping keeps its positions — they already are raw positions", () => {
  const raw = `alpha be${ZWSP}ta gamma delta epsilon`;
  const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
  const passages = [
    { submittedText: "beta gamma", submittedWordStart: 1, submittedWordEnd: 2, externalWordStart: null, matchedWordCount: 2 },
    { submittedText: "epsilon", submittedWordStart: 4, submittedWordEnd: 4, externalWordStart: null, matchedWordCount: 1 },
  ];
  assert.deepEqual(projectCanonicalPassagesToRaw(passages, mapping), passages);
  assert.deepEqual(projectCanonicalSpanToRaw(mapping, 1, 2), { rawStart: 1, rawEnd: 2 });
});

testV2("v2 PROPERTY: across deterministic random invisible-character insertions, raw and canonical tokens are one sequence and every run is one position", () => {
  const words = "glaciologists drilling through taku icefield recovered continuous core whose volcanic ash layers aligned precisely documented eruptions mount katmai allowing researchers calibrate annual accumulation".split(" ");
  const marks = [ZWSP, ZWNJ, ZWJ, BOM, SOFT_HYPHEN, WORD_JOINER];
  const separators = [" ", "  ", "\n", `${NBSP}`, ", ", ". ", ` ${ZWSP} `, "\r\n"];
  let seed = 20261001;
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
    assert.deepEqual(tokens(canonicalizeText(raw)), rawTokens, `trial ${trial}: ${JSON.stringify(raw)}`);
    assert.deepEqual(mapThroughCanonicalization(raw), identity(rawTokens.length), `trial ${trial}`);
  }
});

test("one raw text, two contracts: each mapping spells its own canonical tokens out of its own raw tokens", () => {
  const raw = `one tw${ZWSP}o thr${ZWSP}${ZWSP}e${ZWJ}e fo${SOFT_HYPHEN}ur five`;
  const under = (version) => runWithScoringNormalization(version, () => {
    const rawTokens = tokens(raw);
    const canonicalTokens = tokens(canonicalizeText(raw));
    const mapping = mapCanonicalTokensToRawTokens(raw, canonicalizeText(raw));
    mapping.forEach((run, index) => assert.equal(rawTokens.slice(run.rawStart, run.rawEnd + 1).join(""), canonicalTokens[index], `v${version} canonical token ${index}`));
    return { rawTokens, canonicalTokens, runs: mapping.map((run) => [run.rawStart, run.rawEnd]) };
  });
  // v1: the zero-width marks split raw words canonicalization keeps whole; the soft hyphen splits both sides alike.
  assert.deepEqual(under(1), {
    rawTokens: ["one", "tw", "o", "thr", "e", "e", "fo", "ur", "five"],
    canonicalTokens: ["one", "two", "three", "fo", "ur", "five"],
    runs: [[0, 0], [1, 2], [3, 5], [6, 6], [7, 7], [8, 8]],
  });
  // v2: nothing is split on either side.
  assert.deepEqual(under(2), {
    rawTokens: ["one", "two", "three", "four", "five"],
    canonicalTokens: ["one", "two", "three", "four", "five"],
    runs: identity(5),
  });
});
