import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  ACTIVE_SCORING_NORMALIZATION_VERSION,
  SCORING_IGNORABLE_FORMAT_RANGES,
  currentScoringNormalizationVersion,
  grams,
  gramHash,
  hasScoringIgnorableFormatCharacter,
  normalize,
  normalizeScoringV1,
  normalizeScoringV2,
  reportScoringNormalizationVersion,
  requestedScoringNormalizationVersion,
  scoringNormalizationEvidence,
  stripScoringIgnorableFormatCharacters,
  tokenSpans,
  tokens,
  tokensForScoringNormalization,
} from "../lib/similarity-core.ts";
import { runWithScoringNormalization } from "../lib/scoring-normalization-scope.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { computeDocumentCorrespondence } from "../lib/document-correspondence.ts";
import { extractCandidatePhrases, sanitizeExtractionArtifacts } from "../lib/academic-search/phrase-extractor.ts";
import {
  SNAPSHOT_MATCHER_VERSION,
  snapshotMatcherVersion,
  snapshotScoringNormalizationVersion,
} from "../lib/report-historical-match.ts";
import { academicEvidenceSubmissionBinding } from "../lib/academic-search-diagnostics-repo.ts";

/**
 * The two scoring-normalization contracts, each stated on its own.
 *
 *   v1 — the normalization every report so far was computed under.
 *   v2 — v1, plus the 138 invisible format characters (General_Category=Cf AND
 *        Default_Ignorable_Code_Point, Unicode 17.0) are deleted with no
 *        boundary.
 *
 * Nothing here depends on which of the two a build computes a NEW check under
 * (ACTIVE_SCORING_NORMALIZATION_VERSION): every assertion names its contract,
 * so this file holds for a build that defaults to either.
 *
 * Every code point is built with String.fromCodePoint so this file never has
 * to embed an invisible byte.
 */

const cp = (n) => String.fromCodePoint(n);
const hex = (n) => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;
const under = (version, compute) => runWithScoringNormalization(version, compute);
const tokens1 = (text) => tokensForScoringNormalization(text, 1);
const tokens2 = (text) => tokensForScoringNormalization(text, 2);

// The contract, written out a second time, independently of lib/similarity-core.ts.
const FROZEN = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];
const MEMBERS = FROZEN.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => first + index));
const MEMBER_SET = new Set(MEMBERS);

// Independent statements of both contracts.
const independentV1 = (value) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const independentV2 = (value) => {
  const kept = [...value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")].filter((ch) => !MEMBER_SET.has(ch.codePointAt(0))).join("");
  return kept.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
};

// ── the frozen set ───────────────────────────────────────────────────────
test("the frozen set is exactly the 138 documented code points", () => {
  assert.equal(MEMBERS.length, 138);
  assert.deepEqual(SCORING_IGNORABLE_FORMAT_RANGES.map(([first, last]) => [first, last]), FROZEN);
  const exported = SCORING_IGNORABLE_FORMAT_RANGES.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => first + index));
  assert.equal(exported.length, 138);
  assert.equal(new Set(exported).size, 138, "no code point is listed twice");
});

test("v2 differs from v1 for the 138 members and for nothing else in Unicode — and no other code point normalizes INTO a member", () => {
  // If v2 consulted \p{Cf} / Default_Ignorable, a newer runtime would start
  // deleting whatever it newly classifies. Here the deleted set is measured
  // over ALL of Unicode and must be exactly the 138, whatever the runtime's
  // Unicode version is.
  const deleted = [];
  const changedOutsideSet = [];
  const becomesMember = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = cp(code);
    const probe = `a${ch}b`;
    const v2 = normalizeScoringV2(probe);
    const v1 = normalizeScoringV1(probe);
    if (v1 !== v2) {
      if (MEMBER_SET.has(code) && v1 === "a b" && v2 === "ab") deleted.push(code);
      else changedOutsideSet.push(hex(code));
    }
    // What scoringNormalizationEvidence's fast path relies on: a text holding
    // no member has none after NFKD + lowercasing either, so v2 has nothing to
    // delete in it and the two contracts read it identically.
    if (!MEMBER_SET.has(code) && hasScoringIgnorableFormatCharacter(ch.normalize("NFKD").toLowerCase())) becomesMember.push(hex(code));
  }
  assert.deepEqual(changedOutsideSet, [], "v2 differs from v1 for a code point outside the frozen set");
  assert.equal(deleted.length, 138);
  assert.deepEqual(deleted, MEMBERS);
  assert.deepEqual(becomesMember, [], "a non-member decomposes or lowercases into a member");
});

test("on the pinned runtime (Unicode 17.0) the frozen list is exactly Cf AND Default_Ignorable_Code_Point", { skip: process.versions.unicode !== "17.0" && `runtime Unicode ${process.versions.unicode}: the frozen list is deliberately not re-derived` }, () => {
  const derived = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = cp(code);
    if (/\p{Cf}/u.test(ch) && /\p{Default_Ignorable_Code_Point}/u.test(ch)) derived.push(code);
  }
  assert.deepEqual(derived, MEMBERS);
});

// ── v2 ────────────────────────────────────────────────────────────────────
test("v2: every one of the 138 members is deleted with no boundary — inside a word, alone, and between spaces; v1 keeps it a boundary", () => {
  for (const code of MEMBERS) {
    const ch = cp(code);
    assert.equal(normalizeScoringV2(`pla${ch}giarism`), "plagiarism", hex(code));
    assert.deepEqual(tokens2(`copied pla${ch}giarism words`), ["copied", "plagiarism", "words"], hex(code));
    assert.equal(normalizeScoringV2(ch), "", hex(code));
    assert.equal(normalizeScoringV2(`${ch}${ch}${ch}`), "", hex(code));
    assert.equal(normalizeScoringV2(`one ${ch} two`), "one two", hex(code));
    assert.equal(normalizeScoringV2(`${ch}one two${ch}`), "one two", hex(code));
    assert.equal(normalizeScoringV2(`one${ch} ${ch}two`), "one two", `${hex(code)} next to a real space stays a boundary`);
    assert.equal(normalizeScoringV2(`pla${ch}${ch}giarism`), "plagiarism", `${hex(code)} doubled`);
    assert.equal(stripScoringIgnorableFormatCharacters(`pla${ch}giarism`), "plagiarism", hex(code));
    assert.equal(hasScoringIgnorableFormatCharacter(`pla${ch}giarism`), true, hex(code));
    // v1 is frozen: the same character is still a boundary there.
    assert.equal(normalizeScoringV1(`pla${ch}giarism`), "pla giarism", hex(code));
    assert.deepEqual(tokens1(`pla${ch}giarism`), ["pla", "giarism"], hex(code));
    assert.deepEqual(tokens2(`pla${ch}giarism`), ["plagiarism"], hex(code));
  }
});

test("v2: the named cases — soft hyphen, zero-width space/joiners, word joiner, BOM, a bidi control, a tag character", () => {
  const named = { SHY: 0x00ad, ZWSP: 0x200b, ZWNJ: 0x200c, ZWJ: 0x200d, WJ: 0x2060, BOM: 0xfeff, LRM: 0x200e, RLM: 0x200f, RLO: 0x202e, LRI: 0x2066, TAG_A: 0xe0061 };
  for (const [name, code] of Object.entries(named)) {
    assert.ok(MEMBER_SET.has(code), name);
    assert.equal(normalizeScoringV2(`pla${cp(code)}giarism`), "plagiarism", name);
  }
});

test("v2 fingerprints: an obfuscated passage hashes to exactly the clean passage's 5-grams; under v1 it does not", () => {
  const clean = "the constitutional court examined whether the legislative amendment affected judicial independence";
  for (const code of [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x200e, 0x202a, 0x2062, 0xe0020]) {
    const obfuscated = clean.split(" ").map((word) => (word.length > 3 ? `${word.slice(0, 2)}${cp(code)}${word.slice(2)}` : word)).join(" ");
    assert.notEqual(obfuscated, clean);
    assert.deepEqual(tokens2(obfuscated), tokens2(clean), hex(code));
    assert.deepEqual(grams(tokens2(obfuscated), 5).map(gramHash), grams(tokens2(clean), 5).map(gramHash), hex(code));
    assert.notDeepEqual(tokens1(obfuscated), tokens1(clean), hex(code));
    // tokens() itself, inside each contract's scope, is that contract's sequence.
    assert.deepEqual(under(2, () => tokens(obfuscated)), tokens2(clean), hex(code));
    assert.deepEqual(under(1, () => tokens(obfuscated)), tokens1(obfuscated), hex(code));
  }
});

test("matching under v2: a submission with an invisible character in every word is verified against the clean source — the same matcher under v1 is not", () => {
  const passage = "The constitutional court examined whether the legislative amendment affected the independence of the judiciary and the effective separation of powers while its reasoning emphasised that meaningful oversight requires sufficient financial autonomy transparent appointment procedures and a reliable mechanism for reviewing official conduct without political influence";
  const source = `Hemlark provost dunsaire ketterby morvane scullion trebbet. ${passage}. Quenwick harrowdel jostram illiven parbeck sollitude.`;
  const copyWords = tokens2(passage).length;
  for (const code of [0x200b, 0x00ad, 0x2060, 0x200f]) {
    const obfuscated = passage.split(" ").map((word) => (word.length > 3 ? `${word.slice(0, 2)}${cp(code)}${word.slice(2)}` : word)).join(" ");
    const submission = `Zorvex qualtin marrowby pestrel onglaze vintrice holbrook. ${obfuscated}. Glimvar trosket abellin quorrin vashmere dultrop.`;
    const v2 = under(2, () => computeDocumentCorrespondence(submission, source));
    assert.equal(v2.matchedWordCount, copyWords, hex(code));
    const start = tokens2("Zorvex qualtin marrowby pestrel onglaze vintrice holbrook.").length;
    for (const passageResult of v2.allMatchedPassages) {
      assert.ok(passageResult.submittedWordStart >= start && passageResult.submittedWordEnd < start + copyWords, `${hex(code)}: credit stays inside the copied range`);
    }
    const v1 = under(1, () => computeDocumentCorrespondence(submission, source));
    assert.ok(v1.matchedWordCount < copyWords, `${hex(code)}: v1 still loses the obfuscated words`);
  }
});

// ── explicitly excluded: v2 === v1 ───────────────────────────────────────
test("excluded characters behave under v2 exactly as under v1", () => {
  const TATWEEL = cp(0x0640);
  const cases = {
    "tatweel inside an Arabic word": `العـ${TATWEEL}ربية`,
    "tatweel standalone run": `تاريخ الإرسال ${TATWEEL}${TATWEEL}${TATWEEL} تاريخ القبول`,
    "thin space inside a word": `pla${cp(0x2009)}giarism`,
    "hair space inside a word": `pla${cp(0x200a)}giarism`,
    "narrow no-break space": `pla${cp(0x202f)}giarism`,
    "no-break space": `two${cp(0x00a0)}words`,
    "Cyrillic homoglyph": `pl${cp(0x0430)}giarism`,
    "Greek homoglyph": `c${cp(0x03bf)}urt`,
    "small capital": `pl${cp(0x1d00)}giarism`,
    "Farsi yeh": `السیاسات`,
    "Farsi kaf": `کتاب`,
    "Arabic-Indic digits": `عام ${cp(0x0662)}${cp(0x0660)}${cp(0x0661)}${cp(0x0669)}`,
    "alef maqsura / taa marbuta": `على مدرسة`,
    "oe ligature": `cœur œuvre`,
    "ae ligature": `encyclopædie`,
    "Hangul filler U+3164": `pla${cp(0x3164)}giarism`,
    "Hangul choseong filler U+115F": `pla${cp(0x115f)}giarism`,
    "Hangul jungseong filler U+1160": `pla${cp(0x1160)}giarism`,
    "halfwidth Hangul filler U+FFA0": `pla${cp(0xffa0)}giarism`,
    "braille blank": `pla${cp(0x2800)}giarism`,
    "visible Cf: Arabic number sign": `رقم${cp(0x0600)}١٢`,
    "visible Cf: end of ayah": `آية${cp(0x06dd)}١`,
    "visible Cf: Syriac abbreviation mark": `a${cp(0x070f)}b`,
    "visible Cf: interlinear annotation anchor": `a${cp(0xfff9)}b`,
    "unassigned default-ignorable U+2065": `a${cp(0x2065)}b`,
    "object replacement U+FFFC": `a${cp(0xfffc)}b`,
    "hyphen-minus": "well-known",
    "line-wrap hyphen": "consti-\ntutional",
    "extracted line-wrap hyphen": "consti- tutional",
    "non-breaking hyphen": `well${cp(0x2011)}known`,
    "en dash": `pre${cp(0x2013)}post`,
    "combining grapheme joiner": `pla${cp(0x034f)}giarism`,
    "variation selector 16": `pla${cp(0xfe0f)}giarism`,
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.equal(normalizeScoringV2(value), normalizeScoringV1(value), name);
    assert.deepEqual(tokens2(value), tokens1(value), name);
    assert.equal(scoringNormalizationEvidence(value, 0), "either", name);
  }
  // …and the behaviours themselves, so "unchanged" cannot hide a shared mistake.
  assert.ok(normalizeScoringV2(cases["tatweel inside an Arabic word"]).includes(TATWEEL), "tatweel is still a letter");
  assert.notDeepEqual(tokens2("العربية"), tokens2(`العـربية`));
  assert.deepEqual(tokens2(cases["thin space inside a word"]), ["pla", "giarism"]);
  assert.deepEqual(tokens2(cases["hair space inside a word"]), ["pla", "giarism"]);
  assert.notDeepEqual(tokens2(cases["Cyrillic homoglyph"]), tokens2("plagiarism"));
  assert.notDeepEqual(tokens2(cases["Greek homoglyph"]), tokens2("court"));
  assert.notDeepEqual(tokens2(cases["small capital"]), tokens2("plagiarism"));
  assert.notDeepEqual(tokens2("السیاسات"), tokens2("السياسات"), "Farsi yeh is not folded to Arabic yeh");
  assert.notDeepEqual(tokens2("کتاب"), tokens2("كتاب"), "Farsi kaf is not folded to Arabic kaf");
  assert.notDeepEqual(tokens2("cœur"), tokens2("coeur"));
  assert.notDeepEqual(tokens2("encyclopædie"), tokens2("encyclopaedie"));
  assert.equal(tokens2(cases["Hangul filler U+3164"]).length, 1, "a Hangul filler is a letter: one token, not the clean word");
  assert.notDeepEqual(tokens2(cases["Hangul filler U+3164"]), ["plagiarism"]);
  assert.deepEqual(tokens2(cases["braille blank"]), ["pla", "giarism"]);
  assert.deepEqual(tokens2(cases["visible Cf: Syriac abbreviation mark"]), ["a", "b"]);
  assert.deepEqual(tokens2(cases["visible Cf: interlinear annotation anchor"]), ["a", "b"]);
  assert.deepEqual(tokens2(cases["unassigned default-ignorable U+2065"]), ["a", "b"]);
  assert.deepEqual(tokens2("well-known"), ["well", "known"]);
  assert.deepEqual(tokens2(cases["line-wrap hyphen"]), ["consti", "tutional"]);
  assert.deepEqual(tokens2(cases["extracted line-wrap hyphen"]), ["consti", "tutional"]);
  // A soft hyphen at a line end is NOT a dehyphenation rule: the line break still separates.
  assert.deepEqual(tokens2(`consti${cp(0x00ad)}\ntutional`), ["consti", "tutional"]);
});

// ── multilingual controls ────────────────────────────────────────────────
test("multilingual text with no member is token-identical under v1 and v2", () => {
  const texts = [
    "The constitutional court examined whether the legislative amendment affected the independence of the judiciary.",
    "La cour constitutionnelle a examiné si la réforme législative portait atteinte à l'indépendance de la justice.",
    "نظرت المحكمة الدستورية في مدى تأثير التعديل التشريعي على استقلال السلطة القضائية ومبدأ الفصل بين السلطات.",
    "نَظَرَتِ الْمَحْكَمَةُ الدُّسْتُورِيَّةُ فِي التَّعْدِيلِ",
    "دانشگاه تهران کتابهای علمی",
    "विश्वविद्यालय की स्थापना और कानून",
    "ΑΣ ΟΔΟΣ ΚΟΣΜΟΣ τέλος",
    "Größe Straße naïve façade Ångström",
    "ｆｕｌｌｗｉｄｔｈ ﬁnancial conﬂict oﬃcial ™ ½ №",
  ];
  for (const text of texts) {
    assert.equal(hasScoringIgnorableFormatCharacter(text), false, text);
    assert.equal(normalizeScoringV2(text), normalizeScoringV1(text), text);
    assert.equal(normalizeScoringV1(text), independentV1(text), text);
    assert.deepEqual(tokenSpans(text, 1), tokenSpans(text, 2), text);
  }
});

test("Latin accents: NFC, NFD, NFKC and NFKD spellings of one string are the same tokens under both contracts, and fold to the unaccented form", () => {
  const text = "Criminalité à l'égard des déçus naïfs — résumé";
  for (const tokenize of [tokens1, tokens2]) {
    const forms = ["NFC", "NFD", "NFKC", "NFKD"].map((form) => tokenize(text.normalize(form)));
    for (const form of forms) assert.deepEqual(form, forms[0]);
    assert.deepEqual(forms[0], ["criminalite", "a", "l", "egard", "des", "decus", "naifs", "resume"]);
  }
});

test("Arabic under v2: harakat, presentation forms, lam-alef and hamza forms still fold as before; a member inside a word is deleted", () => {
  assert.deepEqual(tokens2("نَظَرَتِ الْمَحْكَمَةُ"), tokens2("نظرت المحكمة"));
  assert.deepEqual(tokens2(`${cp(0xfee3)}${cp(0xfea4)}${cp(0xfee4)}${cp(0xfeaa)}`), tokens2("محمد"), "presentation forms");
  assert.deepEqual(tokens2(`ا${cp(0xfefb)}م`), tokens2("الام"), "lam-alef ligature");
  assert.deepEqual(tokens2("أحمد إلى آخر"), tokens2("احمد الى اخر"), "hamza forms");
  assert.deepEqual(tokens2(`المح${cp(0x200b)}كمة الدستو${cp(0x200f)}رية`), tokens2("المحكمة الدستورية"));
  // RLM / ALM where they really occur — next to punctuation or a space — change nothing.
  assert.deepEqual(tokens2(`(عربي)${cp(0x200f)} text ${cp(0x061c)}123`), tokens2("(عربي) text 123"));
  assert.deepEqual(tokens1(`(عربي)${cp(0x200f)} text ${cp(0x061c)}123`), tokens1("(عربي) text 123"));
});

test("Persian ZWNJ and Indic ZWJ/ZWNJ sit inside one word: deleted under v2, a boundary under v1", () => {
  const persian = `می${cp(0x200c)}خواهم`;
  assert.deepEqual(tokens2(persian), ["میخواهم"]);
  assert.deepEqual(tokens1(persian), ["می", "خواهم"]);
  // Devanagari conjunct with an explicit ZWJ / ZWNJ after the virama (the virama is \p{M}, already stripped).
  assert.deepEqual(tokens2(`क्${cp(0x200d)}ष`), tokens2("क्ष"));
  assert.deepEqual(tokens2(`क्${cp(0x200c)}ष`), tokens2("क्ष"));
  assert.deepEqual(tokens1(`क्${cp(0x200d)}ष`), ["क", "ष"]);
});

test("ligatures and compatibility forms are unchanged; under v2 a member next to one is still deleted", () => {
  for (const tokenize of [tokens1, tokens2]) {
    assert.deepEqual(tokenize("ﬁnancial conﬂict oﬃcial"), ["financial", "conflict", "official"]);
    assert.deepEqual(tokenize("ｆｕｌｌ ①"), ["full", "1"]);
  }
  assert.deepEqual(tokens2(`ﬁ${cp(0x200b)}nancial`), ["financial"]);
});

test("Greek final sigma under v2: the member is ignored by case mapping exactly as it is by the tokenizer", () => {
  assert.deepEqual(tokens2(`ΑΣ${cp(0x200b)}Β`), tokens2("ΑΣΒ"));
  assert.deepEqual(tokens2(`ΟΔΟΣ${cp(0x200b)}`), tokens2("ΟΔΟΣ"));
  assert.deepEqual(tokens2(`ΟΔΟΣ${cp(0x200b)} ΑΒ`), tokens2("ΟΔΟΣ ΑΒ"));
});

// ── both contracts are frozen ─────────────────────────────────────────────
test("normalizeScoringV1 and normalizeScoringV2 are each their independent statement, byte for byte — and v2 only ever JOINS v1 words", () => {
  let seed = 0x1234abcd;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const alphabet = [..."abc XYZ éñ ß.,-'\"\n\t", cp(0x0301), cp(0x00ad), cp(0x200b), cp(0x200d), cp(0x2060), cp(0xfeff), cp(0x200f), cp(0x202e), cp(0xe0041), cp(0x0640), cp(0x0627), cp(0x064e), cp(0xfb01), cp(0x2122), cp(0x00bd), cp(0x03a3), cp(0x1d400), cp(0x2009), cp(0x3164)];
  let differing = 0;
  for (let round = 0; round < 4000; round += 1) {
    let text = "";
    const length = 1 + (next() % 40);
    for (let index = 0; index < length; index += 1) text += alphabet[next() % alphabet.length];
    assert.equal(normalizeScoringV1(text), independentV1(text));
    assert.equal(normalizeScoringV2(text), independentV2(text));
    // v2 is v1 with the members removed before the boundary step — never anything else.
    const withoutMembers = stripScoringIgnorableFormatCharacters(text);
    if (withoutMembers === text) assert.equal(normalizeScoringV2(text), normalizeScoringV1(text));
    assert.equal(normalizeScoringV2(text), normalizeScoringV2(withoutMembers));
    // Merge-only: concatenating consecutive v1 words spells each v2 word, in order, with nothing left over. This is why
    // "the word sequences are equal" and "the word counts are equal" are the same statement (scoringNormalizationEvidence).
    const v1 = tokens1(text);
    const v2 = tokens2(text);
    let cursor = 0;
    for (const word of v2) {
      let built = "";
      while (built.length < word.length && cursor < v1.length) { built += v1[cursor]; cursor += 1; }
      assert.equal(built, word, JSON.stringify(text));
    }
    assert.equal(cursor, v1.length, JSON.stringify(text));
    assert.equal(v1.length === v2.length, v1.join("\u0001") === v2.join("\u0001"), JSON.stringify(text));
    if (v1.length !== v2.length) differing += 1;
  }
  assert.ok(differing > 500, "the fuzz really exercises texts the two contracts read differently");
});

// ── which contract a computation runs under ───────────────────────────────
test("normalize() runs under the enclosing scope's contract; outside any scope, under the build's active one", async () => {
  const text = `pla${cp(0x200b)}giarism so${cp(0x00ad)}ft`;
  assert.ok(ACTIVE_SCORING_NORMALIZATION_VERSION === 1 || ACTIVE_SCORING_NORMALIZATION_VERSION === 2);
  assert.equal(currentScoringNormalizationVersion(), ACTIVE_SCORING_NORMALIZATION_VERSION, "no scope: the active contract");
  assert.equal(normalize(text), ACTIVE_SCORING_NORMALIZATION_VERSION === 2 ? "plagiarism soft" : "pla giarism so ft");
  assert.deepEqual(tokens(text), tokensForScoringNormalization(text, ACTIVE_SCORING_NORMALIZATION_VERSION));

  assert.equal(under(1, () => currentScoringNormalizationVersion()), 1);
  assert.equal(under(2, () => currentScoringNormalizationVersion()), 2);
  assert.equal(under(1, () => normalize(text)), "pla giarism so ft");
  assert.equal(under(2, () => normalize(text)), "plagiarism soft");
  assert.deepEqual(under(1, () => tokenSpans(text)), tokenSpans(text, 1), "tokenSpans' default is the scope's contract");
  assert.deepEqual(under(2, () => tokenSpans(text)), tokenSpans(text, 2));
  // Nested: the innermost wins, and the outer one is back afterwards.
  under(1, () => {
    assert.equal(under(2, () => normalize(text)), "plagiarism soft");
    assert.equal(normalize(text), "pla giarism so ft");
  });
  assert.equal(currentScoringNormalizationVersion(), ACTIVE_SCORING_NORMALIZATION_VERSION, "a scope leaves nothing behind");

  // The scope follows the computation across awaits, and two computations in
  // flight at once — one per contract — never see each other's.
  const seen = { 1: [], 2: [] };
  const computation = (version) => under(version, async () => {
    for (let step = 0; step < 25; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, step % 3));
      seen[version].push(normalize(text));
    }
    return currentScoringNormalizationVersion();
  });
  assert.deepEqual(await Promise.all([computation(1), computation(2), computation(1), computation(2)]), [1, 2, 1, 2]);
  assert.deepEqual([...new Set(seen[1])], ["pla giarism so ft"]);
  assert.deepEqual([...new Set(seen[2])], ["plagiarism soft"]);
  // A callback scheduled from inside a scope that runs later still has it; one scheduled outside never gains it.
  const later = await under(2, () => new Promise((resolve) => setTimeout(() => resolve(currentScoringNormalizationVersion()), 1)));
  assert.equal(later, 2);
  const outside = await new Promise((resolve) => setTimeout(() => resolve(currentScoringNormalizationVersion()), 1));
  assert.equal(outside, ACTIVE_SCORING_NORMALIZATION_VERSION);
});

test("the scope module is server-only: no client component, worker or shared rendering module can reach it", () => {
  const root = path.resolve(".");
  const read = (file) => fs.readFileSync(file, "utf8");
  const resolveImport = (from, spec) => {
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  // Value imports only — what survives into a bundle: `import type`, `export type … from` and an import whose every
  // specifier is `type` are erased at build time. Also dynamic import() and `new URL("./x-worker.ts", import.meta.url)`.
  const valueImports = (file) => {
    const sourceFile = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const specs = [];
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
        const erased = clause !== undefined && (clause.isTypeOnly || (!clause.name && named !== null && named.length > 0 && named.every((element) => element.isTypeOnly)));
        if (!erased) specs.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.isTypeOnly) specs.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specs.push(node.arguments[0].text);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) {
        specs.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specs;
  };
  const scopeModule = path.join(root, "lib", "scoring-normalization-scope.ts");

  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = read(full);
        if (/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(source) || /-worker\.ts$/.test(entry.name)) entries.push(full);
      }
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(path.join(root, dir));
  assert.ok(entries.length > 10, "client entry points were found");

  const reaches = new Map();
  const reachesScope = (file, trail = []) => {
    if (file === scopeModule) return [...trail, file];
    if (reaches.has(file)) return reaches.get(file);
    reaches.set(file, null);
    for (const spec of valueImports(file)) {
      const target = resolveImport(file, spec);
      if (!target) continue;
      const found = reachesScope(target, [...trail, file]);
      if (found) { reaches.set(file, found); return found; }
    }
    return null;
  };
  for (const entry of entries) {
    const found = reachesScope(entry);
    assert.equal(found, null, `client code reaches the server-only scope module: ${(found ?? []).map((f) => path.relative(root, f)).join(" -> ")}`);
  }
  // The shared core itself imports nothing from Node and not the scope module.
  const coreImports = valueImports(path.join(root, "lib", "similarity-core.ts"));
  assert.deepEqual(coreImports.filter((spec) => spec.startsWith("node:") || /scoring-normalization-scope/.test(spec)), []);
  // …while the server modules that scope a computation do reach it (the walk is not vacuous).
  for (const serverFile of ["lib/report-primary-similarity.ts", "lib/report-historical-match.ts", "app/api/reports/route.ts", "app/api/academic-evidence/route.ts", "app/api/archive/match/route.ts"]) {
    reaches.clear();
    assert.ok(reachesScope(path.join(root, serverFile)), serverFile);
  }
});

// ── request declarations and report stamps ────────────────────────────────
test("requestedScoringNormalizationVersion: absent is v1; only exactly 1 or 2 is a declaration; anything else is refused", () => {
  assert.equal(requestedScoringNormalizationVersion(undefined), 1);
  assert.equal(requestedScoringNormalizationVersion(null), 1);
  assert.equal(requestedScoringNormalizationVersion(1), 1);
  assert.equal(requestedScoringNormalizationVersion(2), 2);
  for (const value of [0, 3, 2.5, "1", "2", true, false, {}, [], [2], NaN]) {
    assert.equal(requestedScoringNormalizationVersion(value), null, JSON.stringify(value));
  }
});

test("reportScoringNormalizationVersion: only the literal 2 is v2; no stamp is v1", () => {
  assert.equal(reportScoringNormalizationVersion({ scoringNormalizationVersion: 2 }), 2);
  for (const value of [undefined, null, 1, 3, "2", true, {}, 2.5]) {
    assert.equal(reportScoringNormalizationVersion({ scoringNormalizationVersion: value }), 1, String(value));
  }
  assert.equal(reportScoringNormalizationVersion({}), 1);
  assert.equal(reportScoringNormalizationVersion(null), 1);
  assert.equal(reportScoringNormalizationVersion(undefined), 1);
});

test("scoringNormalizationEvidence: the word count names the contract exactly when the two contracts read the text differently", () => {
  const plain = "The constitutional court examined whether the legislative amendment affected judicial independence.";
  assert.equal(scoringNormalizationEvidence(plain, tokens1(plain).length), "either");
  assert.equal(scoringNormalizationEvidence(plain, 0), "either", "nothing to tell apart: no count is evidence against either");
  assert.equal(scoringNormalizationEvidence("", 0), "either");

  // A member that splits no word (next to a space / punctuation): the sequences are equal.
  const harmless = `(عربي)${cp(0x200f)} text ${cp(0x061c)}123 and a${cp(0xfeff)} b`;
  assert.deepEqual(tokens1(harmless), tokens2(harmless));
  assert.equal(scoringNormalizationEvidence(harmless, tokens1(harmless).length), "either");
  assert.equal(scoringNormalizationEvidence(harmless, 999), "either");

  // A member inside a word: v1 counts one word more per split.
  const sensitive = `copied pla${cp(0x200b)}giarism wo${cp(0x00ad)}rds from the so${cp(0x2060)}urce`;
  assert.equal(tokens1(sensitive).length, tokens2(sensitive).length + 3);
  assert.equal(scoringNormalizationEvidence(sensitive, tokens1(sensitive).length), 1);
  assert.equal(scoringNormalizationEvidence(sensitive, tokens2(sensitive).length), 2);
  for (const other of [0, tokens2(sensitive).length - 1, tokens1(sensitive).length + 1, tokens2(sensitive).length + 1, "6", null, undefined, NaN]) {
    assert.equal(scoringNormalizationEvidence(sensitive, other), null, String(other));
  }
  // The count is taken on the same text positions are: the reference section is stripped under both.
  const withReferences = `${sensitive}\n\nReferences\n\nSmith, J. (2019). A ti${cp(0x200b)}tle. Journal of Things, 4(2), 10-20.\nJones, K. (2020). Another title. Press.`;
  assert.equal(scoringNormalizationEvidence(withReferences, tokens2(withReferences).length), 2);
  assert.equal(scoringNormalizationEvidence(withReferences, tokens1(withReferences).length), 1);
  // …and the answer never depends on the scope it is asked in.
  assert.equal(under(2, () => scoringNormalizationEvidence(sensitive, tokens1(sensitive).length)), 1);
  assert.equal(under(1, () => scoringNormalizationEvidence(sensitive, tokens2(sensitive).length)), 2);
});

// ── canonicalizeText() is a different contract and is NOT changed ─────────
test("canonicalizeText and the canonical identity hash are unchanged, under either contract", () => {
  // Pinned outputs: canonicalizeText still deletes ONLY U+200B/C/D and U+FEFF.
  const text = `﻿Title  line\r\n\r\n\r\n\r\npla${cp(0x200b)}gia${cp(0x200c)}ri${cp(0x200d)}sm  so${cp(0x00ad)}ft wo${cp(0x2060)}rd bi${cp(0x200f)}di ta${cp(0xe0041)}g\tend `;
  const expected = `Title line\n\nplagiarism so${cp(0x00ad)}ft wo${cp(0x2060)}rd bi${cp(0x200f)}di ta${cp(0xe0041)}g end`;
  assert.equal(canonicalizeText(text), expected);
  for (const version of [1, 2]) assert.equal(under(version, () => canonicalizeText(text)), expected);
  // Identity hashes computed at ca85e1a (before the contract had a number), pinned.
  for (const hash of [canonicalSha256, (value) => under(1, () => canonicalSha256(value)), (value) => under(2, () => canonicalSha256(value))]) {
    assert.equal(hash("The quick brown fox.\r\nSecond  line."), "883be4c4a8c54bcfa25cae175e4ba2ede410bfbbd3da54c76e77a925a2c35f0e");
    assert.equal(
      hash(`pla${cp(0x200b)}giarism so${cp(0x00ad)}ft wo${cp(0x2060)}rd bi${cp(0x200f)}di`),
      "14fab9618686f046727a3d8e83b78db2d2c23214f0d3fe4b19a84779ee5e45f4",
    );
  }
  for (const code of MEMBERS) {
    const kept = ![0x200b, 0x200c, 0x200d, 0xfeff].includes(code);
    assert.equal(canonicalizeText(`pla${cp(code)}giarism`).includes(cp(code)), kept, hex(code));
  }
  // The module itself takes nothing from the scoring normalization.
  const source = fs.readFileSync(path.join(path.resolve("."), "lib", "canonical-text.ts"), "utf8");
  assert.match(source, /\[0x200b, 0x200c, 0x200d, 0xfeff\]/);
  assert.doesNotMatch(source, /^import\b/m);
  assert.doesNotMatch(source, /SCORING_IGNORABLE/);
});

// ── scholarly discovery query hygiene (discovery only) ────────────────────
test("scholarly discovery under v2: queries are built from text with the members removed and equal the clean text's queries; under v1 discovery is exactly what it was", () => {
  const clean = [
    "The constitutional court examined whether the legislative amendment affected the independence of the judiciary and the effective separation of powers.",
    "Its reasoning emphasised that meaningful oversight requires sufficient financial autonomy, transparent appointment procedures, and a reliable mechanism for reviewing official conduct.",
    "The judges further observed that the office of the prosecutor had repeatedly failed to publish its annual reports, which undermined public confidence in criminal proceedings.",
    "Affluent districts reshuffled their budgets while poorer municipalities struggled with difficult staffing conflicts and baffling administrative requirements.",
  ].join(" ");
  for (const code of [0x00ad, 0x2060, 0x200f, 0x200b, 0x202a, 0xe0020]) {
    const obfuscated = clean.split(" ").map((word) => (word.length > 4 ? `${word.slice(0, 2)}${cp(code)}${word.slice(2)}` : word)).join(" ");
    // v2
    assert.equal(under(2, () => sanitizeExtractionArtifacts(obfuscated)), under(2, () => sanitizeExtractionArtifacts(clean)), hex(code));
    const queries = under(2, () => extractCandidatePhrases(obfuscated));
    assert.ok(queries.length > 0);
    assert.deepEqual(queries, under(2, () => extractCandidatePhrases(clean)), hex(code));
    for (const query of queries) {
      for (const ch of query.queryText) assert.ok(!MEMBER_SET.has(ch.codePointAt(0)), `${hex(code)} leaked into a v2 query`);
    }
    // v1: the text reaches the extractor with its members, as it always did (this fixture has no markup or
    // URL, so the sanitizer has nothing else to remove and returns it untouched).
    assert.equal(under(1, () => sanitizeExtractionArtifacts(obfuscated)), obfuscated, hex(code));
    // (U+200B is one of the four characters canonicalizeText has always removed before extraction, so it never
    // reached a query; every other member did.)
    if (code !== 0x200b) {
      assert.notDeepEqual(under(1, () => extractCandidatePhrases(obfuscated)), under(1, () => extractCandidatePhrases(clean)), hex(code));
    }
  }
  // Text without a member is discovered identically under both.
  assert.deepEqual(under(1, () => extractCandidatePhrases(clean)), under(2, () => extractCandidatePhrases(clean)));
});

test("query cleanup never contributes score: a query is text only, and only the discovery module uses the sanitizer", () => {
  const queries = under(2, () => extractCandidatePhrases("The constitutional court examined whether the legislative amendment affected the independence of the judiciary and the effective separation of powers in several comparable jurisdictions."));
  for (const query of queries) {
    assert.deepEqual(Object.keys(query).sort(), ["queryText", "queryType", "rank", "sourcePassage"]);
  }
  // Verification is computeDocumentCorrespondence on the untouched submission
  // text: cleaning (or not cleaning) the query text cannot add a matched word.
  const submission = `Glimvar trosket abellin quorrin vashmere dultrop kenniver slop${cp(0x00ad)}worth yarrowen brimsel tovich nardle prewick olvenstam zorvex qualtin marrowby.`;
  const unrelated = "Hemlark provost dunsaire ketterby morvane scullion trebbet vandrell oskium palliter rodgewin quenwick harrowdel jostram illiven parbeck sollitude.";
  for (const version of [1, 2]) {
    assert.equal(under(version, () => computeDocumentCorrespondence(submission, unrelated)).matchedWordCount, 0);
    assert.equal(under(version, () => computeDocumentCorrespondence(sanitizeExtractionArtifacts(submission), unrelated)).matchedWordCount, 0);
  }

  const libRoot = path.join(path.resolve("."), "lib");
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && /sanitizeExtractionArtifacts/.test(fs.readFileSync(full, "utf8"))) users.push(path.relative(libRoot, full).replace(/\\/g, "/"));
    }
  };
  walk(libRoot);
  assert.deepEqual(users, ["academic-search/phrase-extractor.ts"]);
});

// ── what records a computation's contract ─────────────────────────────────
test("the prior-submission snapshot tag: a v1 report's is the tag every existing row already holds; a v2 report's carries norm.v2", () => {
  // Pinned: the v1 tag is byte-for-byte the pre-contract tag, so no existing snapshot row is invalidated.
  assert.match(SNAPSHOT_MATCHER_VERSION, /^user-submission-match-v1\+pos\.raw-token-v1\+cfg\.[0-9a-f]{12}$/);
  assert.equal(snapshotMatcherVersion(1), SNAPSHOT_MATCHER_VERSION);
  assert.match(snapshotMatcherVersion(2), /^user-submission-match-v1\+pos\.raw-token-v1\+norm\.v2\+cfg\.[0-9a-f]{12}$/);
  assert.equal(snapshotMatcherVersion(2).replace("+norm.v2", ""), SNAPSHOT_MATCHER_VERSION, "same matcher, position space and config — only the contract differs");
  assert.equal(snapshotScoringNormalizationVersion(snapshotMatcherVersion(1)), 1);
  assert.equal(snapshotScoringNormalizationVersion(snapshotMatcherVersion(2)), 2);
  // Tags older than either segment, and a missing tag, are v1.
  for (const legacy of ["user-submission-match-v1", "user-submission-match-v1+cfg.0123456789ab", "", null, undefined]) {
    assert.equal(snapshotScoringNormalizationVersion(legacy), 1, String(legacy));
  }
  assert.equal(snapshotScoringNormalizationVersion("user-submission-match-v1+pos.raw-token-v1+norm.v2+cfg.0123456789ab"), 2);
  assert.equal(snapshotScoringNormalizationVersion("user-submission-match-v1+pos.raw-token-v1+norm.v20+cfg.0123456789ab"), 1, "only the exact segment");
});

test("the scholarly-evidence binding: v1 is the canonical hash itself; v2 is a different 64-hex value derived from it", () => {
  const hash = canonicalSha256("The quick brown fox.\r\nSecond  line.");
  assert.equal(academicEvidenceSubmissionBinding(hash, 1), hash, "a v1 row stores exactly what every existing row stores");
  const v2 = academicEvidenceSubmissionBinding(hash, 2);
  assert.match(v2, /^[0-9a-f]{64}$/);
  assert.notEqual(v2, hash);
  assert.equal(academicEvidenceSubmissionBinding(hash, 2), v2, "deterministic");
  assert.notEqual(academicEvidenceSubmissionBinding(canonicalSha256("another document"), 2), v2);
});
