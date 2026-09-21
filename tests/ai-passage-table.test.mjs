import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as core from "../lib/ai-core.ts";
import * as codec from "../lib/ai-passage-table.ts";
import * as flag from "../lib/ai-compact-passages-flag.ts";
import { aiSignalDisplay } from "../lib/report-types.ts";
import { AiReport } from "../components/report/ai-report.tsx";
import * as helpers from "./helpers/real-ai-windows.mjs";

/**
 * ai-compact-v1 (lib/ai-passage-table.ts) — the lossless compact form of an AI result's per-window passage list.
 *
 * Everything that matters is proved against the REAL ModernBERT tokenizer (already cached in node_modules, loaded strictly
 * offline — nothing is downloaded) and the REAL buildAiTokenChunks: full result -> compact -> JSON stringify/parse ->
 * expand -> deep equality on ALL 13 passage fields (including `text`). Only the per-window model outputs are simulated.
 * Text is synthetic, or read at run time from the developer's local gitignored corpus (skipped when absent) — none is
 * embedded here. The route-level / end-to-end behaviour lives in tests/ai-compact-passages-integration.test.mjs.
 */

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const realTokenizer = await helpers.loadRealModernBertTokenizer();
const skipReal = realTokenizer ? false : "the real ModernBERT tokenizer is not cached in node_modules on this machine";
const stand = helpers.pseudoBpeTokenizer();
const corpusFiles = helpers.localEnglishCorpusFiles();
const FLAG = flag.AI_COMPACT_PASSAGES_WRITE_FLAG;
const savedFlag = process.env[FLAG];
delete process.env[FLAG];
test.after(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

const clone = (value) => JSON.parse(JSON.stringify(value));
// The words a window's `wordCount` counts (lib/ai-core.ts WORD_PATTERN), for fixtures that edit a passage's text.
const wordCountOf = (text) => [...text.matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].length;

/** analysis -> compact -> JSON stringify/parse -> expand, with every invariant checked. */
function roundtrip(text, tokenizer = realTokenizer, options) {
  const analysis = helpers.buildRealisticAiAnalysis(text, tokenizer, options);
  const before = JSON.stringify(analysis);
  const outcome = codec.compactAiAnalysis(analysis, text);
  assert.equal(JSON.stringify(analysis), before, "the encoder never mutates its input");
  if (!outcome.ok) return { analysis, outcome };
  const wire = JSON.parse(JSON.stringify(outcome.analysis));
  return { analysis, outcome, wire, expanded: codec.expandCompactAiPassages(wire, text), validation: codec.validateCompactAiAnalysis(wire, { text }) };
}

function assertExact(result, label) {
  assert.equal(result.outcome.ok, true, `${label}: compactable (${result.outcome.reason ?? ""})`);
  assert.equal(result.validation.ok, true, `${label}: the server validator accepts the encoder's own output (${result.validation.reason ?? ""})`);
  assert.equal(result.expanded.ok, true, `${label}: expands`);
  assert.deepEqual(result.expanded.passages, result.analysis.passages, `${label}: every passage field, including text, is reproduced exactly`);
  assert.equal(isDeepStrictEqual(result.expanded.passages, result.analysis.passages), true);
  const { compactPassages, passages, ...restWire } = result.wire;
  const { passages: originalPassages, ...restOriginal } = result.analysis;
  assert.deepEqual(passages, [], `${label}: passages is [] in the compact form`);
  assert.ok(compactPassages && originalPassages.length > 0);
  assert.deepEqual(restWire, restOriginal, `${label}: every top-level scalar is byte-for-byte unchanged`);
}

const body = helpers.synthProse(60_000, { seed: 7, messiness: 0 });
const inject = (text, every, snippet) => text.split(" ").flatMap((word, i) => (i % every === 0 ? [word, snippet] : [word])).join(" ");

// ----------------------------------------------------------------------------------------------------------------
// 1. Contract, format constants and the writer gate
// ----------------------------------------------------------------------------------------------------------------

test("CONTRACT: the format's pinned windowing/scoring contract equals lib/ai-core.ts — a scoring-contract change cannot pass unnoticed", () => {
  assert.deepEqual(codec.AI_COMPACT_V1_CONTRACT, { windowTokens: core.AI_CONTENT_TOKENS, strideTokens: core.AI_TOKEN_STRIDE, scoringVersion: core.AI_SCORING_VERSION });
  assert.equal(codec.AI_COMPACT_PASSAGES_FORMAT, "turnitplus.ai-passages");
  assert.equal(codec.AI_COMPACT_PASSAGES_FORMAT_VERSION, 1);
  assert.equal(codec.AI_COMPACT_PASSAGES_TEXT_RULE, 1);
});

test("WRITER GATE: default OFF, only the exact string \"true\" enables, an explicit option wins, it is documented and client-visible, and nothing but the two client save helpers consult it", async () => {
  for (const off of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "]) {
    if (off === undefined) delete process.env[FLAG];
    else process.env[FLAG] = off;
    assert.equal(flag.isAiCompactPassagesWriteEnabled(), false, `${JSON.stringify(off)} => OFF`);
  }
  process.env[FLAG] = "true";
  assert.equal(flag.isAiCompactPassagesWriteEnabled(), true);
  assert.equal(flag.resolveAiCompactPassagesWrites({ compactWrites: false }), false, "an explicit option beats the environment");
  delete process.env[FLAG];
  assert.equal(flag.resolveAiCompactPassagesWrites({ compactWrites: true }), true);
  assert.equal(flag.resolveAiCompactPassagesWrites(), false);
  assert.equal(FLAG, "NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED", "NEXT_PUBLIC_: the compaction runs in the browser, so the gate must be inlined into the client bundle");
  assert.equal(process.env[FLAG], undefined, "this suite leaves the flag unset (default state)");

  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  assert.match(read("../lib/ai-compact-passages-flag.ts"), /process\.env\.NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED === "true"/, "a literal property access (a computed key would not be inlined by Next.js)");
  assert.match(read("../.env.example"), /^NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED=$/m, "documented in .env.example with an empty (OFF) value");
  // Reader-first: neither the reader nor the validator may depend on the writer flag (the two server routes are checked in
  // tests/ai-compact-passages-integration.test.mjs, which — unlike this pure unit suite — drives them and owns their DB setup).
  for (const rel of ["../lib/ai-passage-table.ts", "../components/report/ai-report.tsx"]) {
    const source = read(rel);
    if (rel === "../lib/ai-passage-table.ts") {
      assert.equal((source.match(/isAiCompactPassagesWriteEnabled\(\)/g) ?? []).length, 1, "the codec consults the gate in exactly one place (prepareAiAnalysisForTransport)");
    } else {
      assert.doesNotMatch(source, /AI_COMPACT_PASSAGES_WRITE|isAiCompactPassagesWriteEnabled|resolveAiCompactPassagesWrites/, `${rel} never consults the writer gate`);
    }
  }
});

// ----------------------------------------------------------------------------------------------------------------
// 2. The frozen text basis
// ----------------------------------------------------------------------------------------------------------------

test("TEXT BASIS: cleanup_v1 is exactly the tokenizer's own clean-up step (real ModernBERT decode with and without it)", { skip: skipReal }, () => {
  const samples = [
    "Fig . 3 , and it 's a test ! Really ? do n't we 've they 're I 'm ' quoted ' x",
    helpers.synthProse(20_000, { seed: 11, messiness: 0.5 }),
    ". , ! ? ' n't 's 'm 've 're",
    "plain text with nothing to clean up at all",
  ];
  for (const sample of samples) {
    const ids = realTokenizer.encode(sample, { add_special_tokens: false });
    const withCleanup = realTokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: true });
    const without = realTokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
    assert.equal(codec.cleanupTokenizationV1(without), withCleanup, "frozen cleanup_v1(decode without) === decode with clean_up_tokenization_spaces");
  }
});

test("TEXT BASIS: toWellFormed + NFC + cleanup_v1, spelled out — lone surrogates become U+FFFD, valid pairs and BMP text are untouched, the basis is deterministic", () => {
  const cases = ["a\uD800b", "\uDC00x", "x😀y", "\uD83D", "\uDE00\uD83D", "ab\uD800𐀀cd", "Café naïve", "no surrogates here . ,"];
  for (const text of cases) {
    assert.equal(codec.aiPassageDisplayBasis(text), codec.cleanupTokenizationV1(text.toWellFormed().normalize("NFC")), JSON.stringify(text));
    assert.equal(codec.aiPassageDisplayBasis(text), codec.aiPassageDisplayBasis(text));
  }
  assert.equal(codec.aiPassageDisplayBasis("a\uD800b"), "a�b");
  assert.equal(codec.aiPassageDisplayBasis("Café"), "Café", "NFC recomposes decomposed accents (the tokenizer's own normalizer)");
  assert.equal(codec.aiPassageDisplayBasis("x . y ,"), "x. y,");
});

test("FNV-1a-32: matches the published test vectors and is order/length sensitive", () => {
  assert.equal(codec.fnv1a32(""), 0x811c9dc5);
  assert.equal(codec.fnv1a32("a"), 0xe40c292c);
  assert.equal(codec.fnv1a32("foobar"), 0xbf9cf968);
  assert.notEqual(codec.fnv1a32("ab"), codec.fnv1a32("ba"));
});

// ----------------------------------------------------------------------------------------------------------------
// 3. Exact round-trip — the real tokenizer + the real chunk builder
// ----------------------------------------------------------------------------------------------------------------

test("ROUNDTRIP (real corpus sample): full result -> compact -> JSON -> expand deep-equals the original, with essentially no literals, at ~0.08x the manuscript", { skip: skipReal || (corpusFiles.length === 0 ? "the local English corpus is not present on this machine" : false) }, () => {
  const sample = corpusFiles.filter((_, i) => i % 6 === 0);
  let windows = 0;
  let literal = 0;
  let edge = 0;
  let compactChars = 0;
  let legacyChars = 0;
  let textChars = 0;
  for (const file of sample) {
    const text = fs.readFileSync(file, "utf8");
    const result = roundtrip(text);
    if (!result.analysis.passages.length) continue; // too short for an AI analysis
    assertExact(result, file);
    windows += result.analysis.passages.length;
    literal += result.outcome.stats.literal;
    edge += result.outcome.stats.edge;
    compactChars += JSON.stringify(result.wire).length;
    legacyChars += JSON.stringify(result.analysis).length;
    textChars += text.length;
  }
  assert.ok(windows > 500, `a meaningful sample (${windows} windows)`);
  assert.ok(literal / windows < 0.005, `literal escapes are rare on real prose (${literal}/${windows})`);
  assert.ok(edge > 0, "and the U+FFFD edge-fragment path is exercised by real text");
  assert.ok(compactChars / textChars < 0.11, `compact result is ~0.08x the manuscript (${(compactChars / textChars).toFixed(4)})`);
  assert.ok(legacyChars / textChars > 2.0, `while the legacy result is ~2.4x it (${(legacyChars / textChars).toFixed(3)})`);
  console.log("[ai-compact] real corpus sample:", JSON.stringify({ docs: sample.length, windows, literal, edge, compactRatio: +(compactChars / textChars).toFixed(4), legacyRatio: +(legacyChars / textChars).toFixed(3) }));
});

test("ROUNDTRIP (real tokenizer, synthetic prose with PDF-style clean-up artefacts): exact at several sizes, seeds and clean-up densities", { skip: skipReal }, () => {
  for (const [chars, seed, messiness] of [[30_000, 1, 0], [100_000, 2, 0.02], [60_000, 3, 0.3], [45_000, 4, 0.9]]) {
    const text = helpers.synthProse(chars, { seed, messiness });
    const result = roundtrip(text);
    assertExact(result, `synth ${chars}/${seed}/${messiness}`);
    assert.ok(result.analysis.passages.length > 30, `a meaningful number of windows (${result.analysis.passages.length})`);
  }
});

test("ROUNDTRIP (real tokenizer, adversarial manuscripts): Unicode, NFD, emoji/CJK, CR/LF, clean-up, page boundaries, lone surrogates, U+FFFD, math glyphs, whitespace runs, periodic text — exact, or an honest legacy fallback", { skip: skipReal }, () => {
  const adversarial = {
    nfd: body.normalize("NFD") + " " + "Café naïve résumé façade coöperate ".repeat(400),
    emojiCjkArabic: inject(body, 40, "😀 漢字 مرحبا 🚀"),
    specialTokensMild: inject(body, 3000, "[MASK]"),
    sourceReplacementChars: inject(body, 25, "��") + " �",
    cleanupHeavy: inject(body, 8, " , word . x ? y ! do n't it 's I 'm we 've they 're"),
    crlfInvisibles: inject(body, 30, "a\r\nb\rc​d­e f g h"),
    pageBoundaries: body.replace(/\. /g, (match, offset) => (offset % 3000 < 2 ? ".\n\n12\n\nJournal of Testing Vol 3 (2021)\n\n" : match)),
    urlsDigitsSymbols: inject(body, 15, "https://example.org/a/b?c=d&e=f#g 1234567890123456 ~~~~ ---- ==== ©® ½ ± ≥ √ ∑"),
    loneSurrogates: inject(body, 50, "x\uD800y\uDC00z"),
    asciiControls: inject(body, 45, "a\u0000b\u0007c\u001Bd"),
    mathAndPrivateUse: inject(body, 12, "∑∫√  ෣ ૫ ૬ ૭ \u{1D7D8}\u{1D7D9}"),
    whitespaceRuns: inject(body, 5, "   \t  "),
    periodic: "the cat sat on the mat and the dog ran. ".repeat(6000),
  };
  const summary = {};
  for (const [label, text] of Object.entries(adversarial)) {
    const result = roundtrip(text);
    if (result.outcome.ok) {
      assertExact(result, label);
      summary[label] = { windows: result.analysis.passages.length, plain: result.outcome.stats.plain, edge: result.outcome.stats.edge, literal: result.outcome.stats.literal };
    } else {
      // Not compactable is not a failure of exactness: the caller keeps the legacy form, which is exact by definition.
      assert.ok(["LITERAL_BUDGET", "LITERAL_TOO_LARGE"].includes(result.outcome.reason), `${label}: only the literal budget may refuse (${result.outcome.reason})`);
      summary[label] = { fallback: result.outcome.reason };
    }
  }
  assert.ok(summary.nfd.plain > 0 && summary.emojiCjkArabic.edge >= 0);
  assert.ok(summary.loneSurrogates && !summary.loneSurrogates.fallback, "lone surrogates are handled by the frozen toWellFormed step, not by literals");
  assert.ok(summary.mathAndPrivateUse.edge > 0, "windows whose boundary splits a multi-byte glyph use the edge markers");
  assert.ok(summary.whitespaceRuns.literal === 0, "runs of spaces (whose trimmed leading whitespace makes consecutive windows start on the same character) need no literal");
  assert.ok(summary.specialTokensMild.literal > 0, "literal special-token strings are dropped by the tokenizer's decode, so those windows carry a bounded literal");
  console.log("[ai-compact] adversarial:", JSON.stringify(summary));
});

test("ROUNDTRIP (regression): consecutive windows may begin on the SAME character — the anchored last window one token after the previous one, over runs of spaces", { skip: skipReal }, () => {
  // 240-token windows at a 120 stride; make total tokens = 120k + 241 so the anchored final window starts one token after
  // window k (start 120k). When token 120k is whitespace, `.trim()` removes it and both windows begin at the same character.
  let checked = 0;
  for (let pad = 1; pad <= 6; pad += 1) {
    const text = helpers.synthProse(20_000, { seed: 100 + pad, messiness: 0 }).replace(/ /g, () => " ".repeat(1 + ((pad * 7) % 3)));
    const result = roundtrip(text);
    assertExact(result, `spaces x${pad}`);
    assert.equal(result.outcome.stats.literal, 0, `no literal fallback (pad ${pad})`);
    const starts = result.wire.compactPassages.rows.map((row) => row[2]);
    for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] >= starts[i - 1], "char starts are non-decreasing");
    checked += 1;
  }
  assert.equal(checked, 6);
});

test("ROUNDTRIP (large-scale shape): the pseudo-BPE stand-in at 550k characters is exact, ~0.08x, and linear-time even for periodic text", () => {
  const text = helpers.synthProse(550_000, { seed: 5, messiness: 0.02 });
  const started = Date.now();
  const result = roundtrip(text, stand);
  assertExact(result, "550k");
  const ratio = JSON.stringify(result.wire).length / text.length;
  assert.ok(ratio < 0.11, `compact ratio ${ratio.toFixed(4)}`);
  assert.ok(JSON.stringify(result.analysis).length / text.length > 2.0, "legacy is ~2.4x with the REAL window structure");
  const periodic = "the cat sat on the mat and the dog ran. ".repeat(12_000);
  assertExact(roundtrip(periodic, stand), "periodic 480k");
  assert.ok(Date.now() - started < 60_000, "bounded search keeps encode + verify linear (generous cap; timings are recorded in the artifacts)");
});

// ----------------------------------------------------------------------------------------------------------------
// 4. The encoder refuses what it cannot represent exactly (legacy stays the fallback) and never mutates
// ----------------------------------------------------------------------------------------------------------------

test("ENCODER: anything that is not a complete, current-contract, exactly-shaped result stays legacy — with the reason — and the input is never mutated", () => {
  const text = helpers.synthProse(30_000, { seed: 21 });
  const good = helpers.buildRealisticAiAnalysis(text, stand);
  assert.equal(codec.compactAiAnalysis(good, text).ok, true);
  const refuse = (label, mutate, reason, useText = text) => {
    const analysis = clone(good);
    mutate(analysis);
    const before = JSON.stringify(analysis);
    const outcome = codec.compactAiAnalysis(analysis, useText);
    assert.equal(outcome.ok, false, label);
    assert.equal(outcome.reason, reason, label);
    assert.equal(JSON.stringify(analysis), before, `${label}: input untouched`);
  };
  refuse("unsupported", (a) => { a.status = "unsupported"; a.passages = []; }, "NOT_COMPLETE");
  refuse("error", (a) => { a.status = "error"; }, "NOT_COMPLETE");
  refuse("already compact", (a) => { a.compactPassages = {}; }, "ALREADY_COMPACT");
  refuse("no passages", (a) => { a.passages = []; }, "NO_PASSAGES");
  refuse("passages not an array", (a) => { a.passages = "x"; }, "NO_PASSAGES");
  refuse("older scoring version", (a) => { a.scoringVersion = 9; }, "SCORING_VERSION");
  refuse("no scoring version", (a) => { delete a.scoringVersion; }, "SCORING_VERSION");
  refuse("unknown top-level key", (a) => { a.somethingNew = 1; }, "UNKNOWN_TOP_LEVEL_KEY");
  refuse("extra passage field", (a) => { a.passages[3].extra = true; }, "PASSAGE_SHAPE");
  refuse("missing passage field", (a) => { delete a.passages[3].tokenCount; }, "PASSAGE_SHAPE");
  refuse("wordStart is not start", (a) => { a.passages[2].wordStart += 1; }, "PASSAGE_SHAPE");
  refuse("tokenEnd is not end", (a) => { a.passages[2].tokenEnd += 1; }, "PASSAGE_SHAPE");
  refuse("tokenCount is not end-start", (a) => { a.passages[2].tokenCount = 239; }, "PASSAGE_SHAPE");
  refuse("wasTruncated true", (a) => { a.passages[2].wasTruncated = true; }, "PASSAGE_SHAPE");
  refuse("wordCount is not the text's word count", (a) => { a.passages[2].wordCount += 1; }, "PASSAGE_SHAPE");
  refuse("non-finite logOdds", (a) => { a.passages[2].logOdds = Number.NaN; }, "PASSAGE_SHAPE");
  refuse("flagged not boolean", (a) => { a.passages[2].flagged = 1; }, "PASSAGE_SHAPE");
  refuse("window is not 240 tokens", (a) => { a.passages[2].end -= 1; a.passages[2].wordEnd -= 1; a.passages[2].tokenEnd -= 1; a.passages[2].tokenCount -= 1; }, "WINDOW_LAYOUT");
  refuse("empty manuscript", () => {}, "TEXT_MISSING", "");
  refuse("non-string manuscript", () => {}, "TEXT_MISSING", null); // (not `undefined`: that would trigger the default parameter)
  // A passage whose text is nowhere in the manuscript is a literal — never a guess.
  const literalAnalysis = clone(good);
  literalAnalysis.passages[4].text = `not in the manuscript ${literalAnalysis.passages[4].text.slice(0, 40)}`;
  literalAnalysis.passages[4].wordCount = wordCountOf(literalAnalysis.passages[4].text);
  const withLiteral = codec.compactAiAnalysis(literalAnalysis, text);
  assert.equal(withLiteral.ok, true);
  assert.equal(withLiteral.stats.literal, 1);
  const wire = clone(withLiteral.analysis);
  assert.equal(wire.compactPassages.literals["4"], literalAnalysis.passages[4].text);
  assert.deepEqual(codec.expandCompactAiPassages(wire, text).passages, literalAnalysis.passages, "a literal round-trips exactly too");
  // ... and too many of them exceed the budget: the whole result stays legacy rather than approximating.
  const allLiteral = clone(good);
  for (const passage of allLiteral.passages) { passage.text = `zz ${passage.text}`; passage.wordCount = wordCountOf(passage.text); }
  assert.deepEqual(codec.compactAiAnalysis(allLiteral, text), { ok: false, reason: "LITERAL_BUDGET" });
});

test("ENCODER never throws, whatever it is given", () => {
  const junk = [undefined, null, 0, 1, "x", [], {}, { status: "complete" }, { status: "complete", scoringVersion: 10, passages: [null] }, { status: "complete", scoringVersion: 10, passages: [{}] }, { status: "complete", scoringVersion: 10, passages: [[1, 2]] }, Object.create(null)];
  for (const value of junk) {
    for (const text of [undefined, null, "", "abc", 5, {}]) {
      assert.doesNotThrow(() => codec.compactAiAnalysis(value, text));
      assert.equal(codec.compactAiAnalysis(value, text).ok, false);
    }
  }
});

// ----------------------------------------------------------------------------------------------------------------
// 5. Server validator — the accept path and the security negatives
// ----------------------------------------------------------------------------------------------------------------

const negText = helpers.synthProse(30_000, { seed: 31 });
const negBase = (() => {
  const analysis = helpers.buildRealisticAiAnalysis(negText, stand);
  const outcome = codec.compactAiAnalysis(analysis, negText);
  assert.equal(outcome.ok, true);
  return clone(outcome.analysis);
})();
const mutated = (fn) => { const wire = clone(negBase); fn(wire, wire.compactPassages, wire.compactPassages.rows); return wire; };

test("VALIDATOR accepts the encoder's output — structurally without a manuscript, and exactly with it", () => {
  assert.deepEqual(codec.validateCompactAiAnalysis(negBase), { ok: true });
  assert.deepEqual(codec.validateCompactAiAnalysis(negBase, { text: negText }), { ok: true });
  assert.ok(negBase.compactPassages.rows.length > 40);
});

test("SECURITY NEGATIVES: every malformed, oversized, unsupported, mismatched or hostile table is rejected with a specific reason (no giant allocations are ever made)", () => {
  const T = negText;
  const cases = [
    ["unsupported format version", (w, t) => { t.formatVersion = 2; }, ["FORMAT_VERSION"]],
    ["unknown format", (w, t) => { t.format = "someone.else"; }, ["FORMAT"]],
    ["unknown text rule", (w, t) => { t.textRule = 2; }, ["TEXT_RULE"]],
    ["bad text hash", (w, t) => { t.textHash = (t.textHash ^ 1) >>> 0; }, ["TEXT_HASH"]],
    ["text hash out of range", (w, t) => { t.textHash = 2 ** 33; }, ["TEXT_HASH"]],
    ["wrong text length", (w, t) => { t.textLength += 1; }, ["TEXT_LENGTH", "BASIS_LENGTH"]],
    ["zero text length", (w, t) => { t.textLength = 0; }, ["TEXT_LENGTH"]],
    ["wrong window size", (w, t) => { t.windowTokens = 128; }, ["WINDOW_TOKENS"]],
    ["absurd basis length", (w, t) => { t.basisLength = t.textLength * 10; }, ["BASIS_LENGTH"]],
    ["char range past the basis", (w, t, rows) => { rows[3][3] = t.basisLength + 5; }, ["CHAR_RANGE"]],
    ["huge char range", (w, t, rows) => { rows[3][3] = 10 ** 15; }, ["CHAR_RANGE"]],
    ["negative char start on a non-literal row", (w, t, rows) => { rows[3][2] = -5; }, ["CHAR_RANGE"]],
    ["char end before char start", (w, t, rows) => { rows[3][3] = rows[3][2] - 1; }, ["CHAR_RANGE"]],
    ["one range longer than the per-row cap", (w, t, rows) => { rows[3][3] = rows[3][2] + 17_000; }, ["CHAR_RANGE"]],
    ["char starts going backwards", (w, t, rows) => { const s = rows[6][2]; rows[6][2] = rows[7][2]; rows[7][2] = s; if (rows[6][2] === rows[7][2]) rows[6][2] += 1; }, ["CHAR_RANGE"]],
    ["ranges that together exceed the aggregate budget", (w, t, rows) => { for (let i = 1; i <= 6; i += 1) { rows[i][2] = 1000 + i; rows[i][3] = rows[i][2] + 16_000; } }, ["RANGE_BUDGET", "CHAR_RANGE"]],
    ["non-increasing token starts", (w, t, rows) => { rows[5][0] = rows[4][0]; rows[5][1] = rows[4][1]; }, ["TOKEN_LAYOUT"]],
    ["token starts off the 240/120 layout", (w, t, rows) => { rows[4][0] += 1; rows[4][1] += 1; }, ["TOKEN_LAYOUT"]],
    ["window that is not 240 tokens", (w, t, rows) => { rows[2][1] += 1; }, ["TOKEN_RANGE"]],
    ["negative token start", (w, t, rows) => { rows[0][0] = -1; rows[0][1] = 239; }, ["TOKEN_RANGE", "TOKEN_LAYOUT"]],
    ["more rows than the token count allows", (w) => { w.analyzedTokenCount = 500; }, ["ROWS"]],
    ["token count not the last window's end", (w) => { w.analyzedTokenCount += 1; }, ["TOKEN_LAYOUT", "COUNT_MISMATCH"]],
    ["token count below one window", (w) => { w.analyzedTokenCount = 100; }, ["TOKEN_RANGE"]],
    ["null (non-finite) logOdds", (w, t, rows) => { rows[1][4] = null; }, ["MODEL_VALUE"]],
    ["non-finite probability", (w, t, rows) => { rows[1][5] = Number.POSITIVE_INFINITY; }, ["MODEL_VALUE"]],
    ["probability above 1", (w, t, rows) => { rows[1][5] = 1.5; }, ["MODEL_VALUE"]],
    ["logOdds out of range", (w, t, rows) => { rows[1][4] = 1000; }, ["MODEL_VALUE"]],
    ["flagged is not 0/1", (w, t, rows) => { rows[1][6] = 2; }, ["MODEL_VALUE"]],
    ["flagged is a boolean", (w, t, rows) => { rows[1][6] = true; }, ["MODEL_VALUE"]],
    ["tuple too short", (w, t, rows) => { rows[1] = rows[1].slice(0, 5); }, ["ROW_SHAPE"]],
    ["tuple of 8", (w, t, rows) => { rows[1] = [...rows[1].slice(0, 7), 1]; }, ["ROW_SHAPE"]],
    ["tuple of 10", (w, t, rows) => { rows[1] = [...rows[1].slice(0, 7), 0, 0, 0]; }, ["ROW_SHAPE"]],
    ["tuple is an object", (w, t, rows) => { rows[1] = { start: 1 }; }, ["ROW_SHAPE"]],
    ["tuple is null", (w, t, rows) => { rows[1] = null; }, ["ROW_SHAPE"]],
    ["numeric string in a tuple", (w, t, rows) => { rows[1][0] = "120"; }, ["ROW_SHAPE"]],
    ["fractional token index", (w, t, rows) => { rows[1][0] = 120.5; }, ["ROW_SHAPE"]],
    ["edge markers too large", (w, t, rows) => { rows[2] = [...rows[2].slice(0, 7), 5, 5]; }, ["EDGE_MARKER"]],
    ["negative edge marker", (w, t, rows) => { rows[2] = [...rows[2].slice(0, 7), -1, 0]; }, ["EDGE_MARKER"]],
    ["empty slice without fragments", (w, t, rows) => { rows[2][3] = rows[2][2]; }, ["CHAR_RANGE"]],
    ["a literal with no literal row", (w, t) => { t.literals = { 2: "x" }; }, ["LITERAL"]],
    ["literal key not a decimal index", (w, t, rows) => { rows[2][2] = -1; rows[2][3] = -1; t.literals = { "02": "x" }; }, ["LITERAL"]],
    ["literal key that is not a number", (w, t, rows) => { rows[2][2] = -1; rows[2][3] = -1; t.literals = { abc: "x" }; }, ["LITERAL"]],
    ["literal index out of range", (w, t) => { t.literals = { 9999: "x" }; }, ["LITERAL"]],
    ["literal row with no literal", (w, t, rows) => { rows[2][2] = -1; rows[2][3] = -1; }, ["LITERAL"]],
    ["literal that is not a string", (w, t, rows) => { rows[2][2] = -1; rows[2][3] = -1; t.literals = { 2: 5 }; }, ["LITERAL"]],
    ["empty literal", (w, t, rows) => { rows[2][2] = -1; rows[2][3] = -1; t.literals = { 2: "" }; }, ["LITERAL"]],
    ["one oversized literal", (w, t, rows) => { rows[2][2] = -1; rows[2][3] = -1; t.literals = { 2: "x".repeat(17_000) }; }, ["LITERAL"]],
    ["literal table over the budget", (w, t, rows) => { for (const i of [2, 3, 4]) { rows[i][2] = -1; rows[i][3] = -1; } t.literals = { 2: "x".repeat(6000), 3: "x".repeat(6000), 4: "x".repeat(6000) }; }, ["LITERAL_BUDGET"]],
    ["literals is not an object", (w, t) => { t.literals = ["x"]; }, ["LITERAL"]],
    ["literal row with edge markers", (w, t, rows) => { rows[2] = [rows[2][0], rows[2][1], -1, -1, rows[2][4], rows[2][5], rows[2][6], 1, 0]; t.literals = { 2: "x" }; }, ["EDGE_MARKER"]],
    ["unknown table key", (w, t) => { t.extra = 1; }, ["UNKNOWN_KEY"]],
    ["unknown top-level key", (w) => { w.smuggled = "payload"; }, ["UNKNOWN_KEY"]],
    ["inherited-name key", (w) => { w.constructor = "x"; }, ["UNKNOWN_KEY"]],
    ["both forms: passages is not empty", (w) => { w.passages = [{ start: 0 }]; }, ["BOTH_FORMS"]],
    ["passages is missing", (w) => { delete w.passages; }, ["SCALAR"]],
    ["status is not complete", (w) => { w.status = "error"; }, ["STATUS"]],
    ["older scoring version", (w) => { w.scoringVersion = 9; }, ["SCORING_VERSION"]],
    ["non-numeric scalar", (w) => { w.medianLogOdds = "high"; }, ["SCALAR"]],
    ["non-finite scalar", (w) => { w.threshold = Number.NaN; }, ["SCALAR"]],
    ["oversized string scalar", (w) => { w.model = "x".repeat(300); }, ["SCALAR"]],
    ["undefined scalar", (w) => { w.coveragePercent = undefined; }, ["SCALAR"]],
    ["flagged count that contradicts the rows", (w) => { w.flaggedPassageCount += 1; }, ["COUNT_MISMATCH"]],
    ["compactPassages is null", (w) => { w.compactPassages = null; }, ["NOT_OBJECT"]],
    ["compactPassages is an array", (w) => { w.compactPassages = []; }, ["NOT_OBJECT"]],
    ["no rows", (w, t) => { t.rows = []; }, ["ROWS"]],
    ["rows is not an array", (w, t) => { t.rows = "x"; }, ["ROWS"]],
  ];
  for (const [label, mutate, reasons] of cases) {
    const wire = mutated(mutate);
    const verdict = codec.validateCompactAiAnalysis(wire, { text: T });
    assert.equal(verdict.ok, false, `${label}: must be rejected`);
    assert.ok(reasons.includes(verdict.reason), `${label}: rejected for ${verdict.reason}, expected one of ${reasons.join("/")}`);
  }
  // A `__proto__` key arrives as an OWN property when parsed from JSON — it must be rejected, never merged.
  const parsed = JSON.parse(JSON.stringify(negBase).replace(/^\{/, '{"__proto__":{"polluted":true},'));
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), true);
  assert.deepEqual(codec.validateCompactAiAnalysis(parsed, { text: T }), { ok: false, reason: "UNKNOWN_KEY" });
  assert.equal({}.polluted, undefined, "nothing was polluted");
  // The manuscript-dependent checks really depend on the manuscript.
  assert.deepEqual(codec.validateCompactAiAnalysis(negBase, { text: `${negText} ` }), { ok: false, reason: "TEXT_LENGTH" });
  assert.deepEqual(codec.validateCompactAiAnalysis(negBase, { text: `${negText.slice(0, -1)}#` }), { ok: false, reason: "TEXT_HASH" }, "same length, different text");
  // Not compact / not an object.
  for (const value of [undefined, null, 5, "x", [], {}, { status: "complete" }]) assert.equal(codec.validateCompactAiAnalysis(value).ok, false);
  assert.equal(codec.isCompactAiAnalysis({ compactPassages: {} }), true);
  assert.equal(codec.isCompactAiAnalysis({ passages: [] }), false);
  assert.equal(codec.isCompactAiAnalysis(null), false);
});

test("VALIDATOR is cheap for hostile input: a row of huge numbers, a 2,000-row table and a deeply repeated literal map are rejected without allocating anything proportional to a claimed size", () => {
  const started = process.hrtime.bigint();
  const huge = mutated((w, t, rows) => { rows[2][2] = 10 ** 15; rows[2][3] = 10 ** 15 + 5; t.basisLength = 2 ** 40; });
  assert.equal(codec.validateCompactAiAnalysis(huge, { text: negText }).ok, false);
  const many = mutated((w, t) => { t.rows = Array.from({ length: 2000 }, (_, i) => [i * 120, i * 120 + 240, 0, 10, 0, 0.5, 0]); });
  assert.deepEqual(codec.validateCompactAiAnalysis(many, { text: negText }), { ok: false, reason: "ROWS" });
  const literals = mutated((w, t) => { t.literals = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i + 100), "x"])); });
  assert.equal(codec.validateCompactAiAnalysis(literals, { text: negText }).ok, false);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2000, "all rejections are near-instant");
});

// ----------------------------------------------------------------------------------------------------------------
// 6. Reader — legacy, compact, and fail-soft
// ----------------------------------------------------------------------------------------------------------------

test("READER: a legacy result is returned untouched (same array), a compact one is expanded exactly, an absent one is empty — and reading never rewrites anything", () => {
  const legacy = helpers.buildRealisticAiAnalysis(negText, stand);
  const resolvedLegacy = codec.resolveAiPassages(legacy, negText);
  assert.equal(resolvedLegacy.status, "ok");
  assert.equal(resolvedLegacy.source, "legacy");
  assert.equal(resolvedLegacy.passages, legacy.passages, "the very same array — legacy rows are never rewritten or copied");
  const resolvedCompact = codec.resolveAiPassages(negBase, negText);
  assert.equal(resolvedCompact.status, "ok");
  assert.equal(resolvedCompact.source, "compact");
  assert.deepEqual(resolvedCompact.passages, legacy.passages);
  assert.equal(negBase.compactPassages !== undefined && negBase.passages.length === 0, true, "the compact analysis object itself was not modified by reading it");
  assert.deepEqual(codec.resolveAiPassages(undefined, "x"), { status: "ok", passages: [], source: "legacy" });
  assert.deepEqual(codec.resolveAiPassages({ status: "unsupported", passages: [] }, "x"), { status: "ok", passages: [], source: "legacy" });
  assert.deepEqual(codec.resolveAiPassages({ status: "complete" }, "x"), { status: "ok", passages: [], source: "legacy" });
});

test("READER fails SOFT: an unreadable table is `unavailable` (never \"zero windows\", never a throw, never another string's text)", () => {
  const unavailable = (label, analysis, text, reason) => {
    const resolved = codec.resolveAiPassages(analysis, text);
    assert.equal(resolved.status, "unavailable", label);
    if (reason) assert.equal(resolved.reason, reason, label);
  };
  unavailable("wrong manuscript (different text, same length)", negBase, `${negText.slice(0, -1)}#`, "TEXT_HASH");
  unavailable("manuscript missing", negBase, undefined, "TEXT_MISSING");
  unavailable("manuscript empty", negBase, "", "TEXT_LENGTH");
  unavailable("manuscript longer", negBase, `${negText}.`, "TEXT_LENGTH");
  unavailable("unsupported future version", mutated((w, t) => { t.formatVersion = 2; }), negText, "FORMAT_VERSION");
  unavailable("unsupported text rule", mutated((w, t) => { t.textRule = 2; }), negText, "TEXT_RULE");
  unavailable("row past the basis", mutated((w, t, rows) => { rows[3][3] = t.basisLength + 1; }), negText, "CHAR_RANGE");
  unavailable("both forms present", mutated((w) => { w.passages = clone(helpers.buildRealisticAiAnalysis(negText, stand).passages.slice(0, 1)); }), negText, "BOTH_FORMS");
  unavailable("basis drift (engine normalises differently)", mutated((w, t) => { t.basisLength += 1; }), negText, "BASIS_LENGTH");
  unavailable("literal for a non-literal row", mutated((w, t) => { t.literals = { 3: "x" }; }), negText, "LITERAL");
  unavailable("hash of some other text", mutated((w, t) => { t.textHash = codec.fnv1a32("other"); }), negText, "TEXT_HASH");
  // Junk never throws.
  for (const analysis of [null, 0, "x", [], { compactPassages: null }, { compactPassages: [] }, { compactPassages: { rows: "x" } }, { compactPassages: { format: codec.AI_COMPACT_PASSAGES_FORMAT } }, Object.create(null)]) {
    for (const text of [undefined, null, "", "abc", {}, 5]) {
      assert.doesNotThrow(() => codec.expandCompactAiPassages(analysis, text));
      assert.doesNotThrow(() => codec.resolveAiPassages(analysis, text));
      assert.doesNotThrow(() => codec.validateCompactAiAnalysis(analysis, { text: typeof text === "string" ? text : undefined }));
    }
  }
});

test("READER can read compact/1 whatever the writer flag says (reader-first)", () => {
  for (const value of [undefined, "true", "false"]) {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    assert.equal(codec.resolveAiPassages(negBase, negText).status, "ok");
    assert.equal(codec.validateCompactAiAnalysis(negBase, { text: negText }).ok, true);
  }
  delete process.env[FLAG];
});

// ----------------------------------------------------------------------------------------------------------------
// 7. Client transport helpers
// ----------------------------------------------------------------------------------------------------------------

test("TRANSPORT: with the gate OFF (the default) nothing changes — the very same object — and with it ON a compactable result leaves compact; anything else stays as it was", () => {
  const text = helpers.synthProse(30_000, { seed: 41 });
  const analysis = helpers.buildRealisticAiAnalysis(text, stand);
  const report = { id: 1, text, aiScore: 7, aiAnalysis: analysis, other: { keep: true } };
  delete process.env[FLAG];
  assert.equal(codec.prepareAiAnalysisForTransport(analysis, text), analysis, "OFF: same reference");
  assert.equal(codec.prepareReportForTransport(report), report, "OFF: same reference");
  assert.equal(codec.prepareAiAnalysisForTransport(analysis, text, { compactWrites: false }), analysis);

  const on = codec.prepareAiAnalysisForTransport(analysis, text, { compactWrites: true });
  assert.notEqual(on, analysis);
  assert.ok(on.compactPassages && on.passages.length === 0);
  process.env[FLAG] = "true";
  try {
    assert.deepEqual(codec.prepareAiAnalysisForTransport(analysis, text), on, "ON via the environment flag");
    const prepared = codec.prepareReportForTransport(report);
    assert.notEqual(prepared, report);
    assert.equal(prepared.other, report.other, "every other field is carried through by reference");
    assert.deepEqual({ ...prepared, aiAnalysis: undefined }, { ...report, aiAnalysis: undefined });
    assert.equal(report.aiAnalysis, analysis, "the caller's report is never mutated (its local copy keeps the full shape)");
    assert.equal(analysis.passages.length > 0 && analysis.compactPassages === undefined, true);

    // Not applicable / not compactable -> the same reference, silently.
    const first = { id: 1, text, title: "first save, no aiAnalysis yet" };
    assert.equal(codec.prepareReportForTransport(first), first, "the first save is untouched");
    assert.equal(codec.prepareReportForTransport({ ...first, aiAnalysis: null }).aiAnalysis, null);
    const errorAnalysis = { status: "error", score: null, model: "m", engine: null, threshold: 0.7, eligibleWordCount: 0, analyzedWordCount: 0, passages: [], error: "boom" };
    assert.equal(codec.prepareAiAnalysisForTransport(errorAnalysis, text), errorAnalysis);
    const unsupported = { ...errorAnalysis, status: "unsupported" };
    assert.equal(codec.prepareAiAnalysisForTransport(unsupported, text), unsupported);
    assert.equal(codec.prepareAiAnalysisForTransport(analysis, undefined), analysis, "no manuscript -> legacy");
    assert.equal(codec.prepareAiAnalysisForTransport(analysis, helpers.synthProse(30_000, { seed: 999 })), analysis, "a manuscript the windows are not from -> legacy (every window would be a literal, over budget), never a wrong table");
    // (Appending text leaves every window valid — the table is then simply tied to the appended manuscript by its hash.)
    const appended = codec.prepareAiAnalysisForTransport(analysis, `${text} changed`);
    assert.equal(codec.validateCompactAiAnalysis(appended, { text: `${text} changed` }).ok, true);
    assert.equal(codec.validateCompactAiAnalysis(appended, { text }).ok, false, "... and is refused against the original manuscript");
    const already = codec.prepareAiAnalysisForTransport(analysis, text);
    assert.equal(codec.prepareAiAnalysisForTransport(already, text), already, "already compact -> untouched");
    for (const value of [undefined, null, 5, "s", [], () => 1]) {
      assert.equal(codec.prepareReportForTransport(value), value);
      assert.doesNotThrow(() => codec.prepareAiAnalysisForTransport(value, text));
    }
  } finally {
    delete process.env[FLAG];
  }
});

// ----------------------------------------------------------------------------------------------------------------
// 8. Customer-visible parity — the real AiReport, legacy vs compact
// ----------------------------------------------------------------------------------------------------------------

const parityText = helpers.synthProse(40_000, { seed: 51, messiness: 0.03 });
const parityLegacy = helpers.buildRealisticAiAnalysis(parityText, realTokenizer ?? stand, { flaggedRate: 0.06 });
const parityCompact = codec.compactAiAnalysis(parityLegacy, parityText);
const renderAi = (aiAnalysis, text = parityText, extra = {}) => {
  const report = { submissionId: "sub-parity", text, aiScore: aiAnalysis.score ?? null, aiAnalysis };
  return renderToStaticMarkup(React.createElement(AiReport, { report, printMode: true, ...extra }));
};

test("CUSTOMER PARITY: the real AiReport renders BYTE-IDENTICAL markup for a legacy result and its compact form — headline, tiles, counts, order, flags, passage text and window metadata", () => {
  assert.equal(parityCompact.ok, true);
  const wire = clone(parityCompact.analysis);
  const legacyMarkup = renderAi(clone(parityLegacy));
  const compactMarkup = renderAi(wire);
  assert.equal(compactMarkup, legacyMarkup, "identical customer-visible output");
  assert.ok(parityLegacy.passages.length > 40 && parityLegacy.flaggedPassageCount > 0, "a meaningful fixture: many windows, some flagged");
  assert.match(legacyMarkup, /AI writing score/);
  assert.match(legacyMarkup, /ai-passage-list/, "non-vacuous: the passage list really is rendered");
  assert.equal((legacyMarkup.match(/<article class="(?:ai-detected|human-detected)"/g) ?? []).length, parityLegacy.passages.length, "one block per window, in order");
  assert.ok((legacyMarkup.match(/ai-detected/g) ?? []).length >= parityLegacy.flaggedPassageCount);
  assert.ok(legacyMarkup.includes(`<strong>${parityLegacy.passages.length.toLocaleString()}</strong><span>passage windows</span>`), "the window-count tile");
  const escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  assert.ok(legacyMarkup.includes(escapeHtml(parityLegacy.passages[3].text)), "the whole passage text is rendered");
  assert.ok(compactMarkup.includes(escapeHtml(parityLegacy.passages[3].text)), "and identically from the compact form");
  // The same headline the flat-column path derives.
  const legacyReport = { submissionId: "sub-parity", text: parityText, aiScore: parityLegacy.score, aiAnalysis: clone(parityLegacy) };
  const compactReport = { ...legacyReport, aiAnalysis: wire };
  assert.deepEqual(aiSignalDisplay(compactReport), aiSignalDisplay(legacyReport), "status / score / tone / median behaviour is identical");
});

test("CUSTOMER PARITY: an unreadable compact table shows the EXISTING 'breakdown isn't available' state — headline intact, never the false '0 passages exceeded' message", () => {
  const wire = clone(parityCompact.analysis);
  const legacyMarkup = renderAi(clone(parityLegacy));
  const wrongManuscript = renderAi(wire, `${parityText.slice(0, -1)}#`);
  assert.match(wrongManuscript, /passage-level breakdown isn(?:&#x27;|')t available/);
  assert.doesNotMatch(wrongManuscript, /passages exceeded the human/);
  assert.doesNotMatch(wrongManuscript, /ai-passage-list|ai-passage-review/);
  assert.match(wrongManuscript, /AI writing score/, "the headline is unaffected");
  const headline = (html) => html.match(/<section class="ai-report-heading">[\s\S]*?<\/section>/)?.[0];
  assert.equal(headline(wrongManuscript), headline(legacyMarkup), "the heading (score + detail) is identical");
  assert.match(wrongManuscript, /<strong>—<\/strong><span>passage windows<\/span>/, "the window count is unknown, not zero");
  const badVersion = clone(wire);
  badVersion.compactPassages.formatVersion = 99;
  assert.match(renderAi(badVersion), /passage-level breakdown isn(?:&#x27;|')t available/);
  // ... while a genuinely EMPTY legacy list still says so (unchanged behaviour).
  const empty = renderAi({ ...clone(parityLegacy), passages: [], flaggedPassageCount: 0 });
  assert.match(empty, /passages exceeded the human/);
  assert.doesNotMatch(empty, /breakdown isn(?:&#x27;|')t available/);
});

test("LEGACY / MIXED SHAPES: the reader treats every combination of legacy and compact AI with a legacy or compact similarity payload the same (they are independent fields)", () => {
  const legacyAi = clone(parityLegacy);
  const compactAi = clone(parityCompact.analysis);
  const legacySimilarity = { unifiedSimilarity: { unifiedScore: 12 }, evidenceInterpretation: { format: "legacy" } };
  const compactSimilarity = { unifiedSimilarity: { unifiedScore: 12, contributionsEncoding: "compact" }, evidenceInterpretation: { format: "compact", formatVersion: 1 } };
  const baseline = renderAi(legacyAi);
  for (const [aiLabel, ai] of [["legacy AI", legacyAi], ["compact AI", compactAi]]) {
    for (const [simLabel, sim] of [["legacy similarity", legacySimilarity], ["compact similarity", compactSimilarity]]) {
      const report = { submissionId: "sub-parity", text: parityText, aiScore: ai.score, aiAnalysis: ai, ...sim };
      assert.equal(renderToStaticMarkup(React.createElement(AiReport, { report, printMode: true })), baseline, `${aiLabel} + ${simLabel}`);
    }
  }
});
