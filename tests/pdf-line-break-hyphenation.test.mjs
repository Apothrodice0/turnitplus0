import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  extractPdfTextDocument,
  extractPdfTextDocumentWithCompleteness,
  inspectPdfLineBreakRepair,
} from "../lib/pdf-text-extraction.ts";
import { compareWithReference, reference, v1PageText } from "./fixtures/pdf-line-break/conformance.mjs";

/**
 * pdf-text-extraction-v2 — FOCUSED FIXTURES for the line-break hyphenation
 * repair (Rule B3). One test per predicate and per boundary of each numeric
 * threshold.
 *
 * These pin what the frozen rule DOES, not what one might wish it did: a few
 * of them record accepted limitations (a prefix compound the document itself
 * writes closed is joined; "Pati-" / "ent:innen" is left broken; a decomposed
 * accent at the break is refused). Changing any expectation here means the
 * rule changed, which is a new extractor version.
 *
 * Every page built here is also run through the frozen reference
 * (tests/fixtures/pdf-line-break/rule-b3-reference.mjs); production must agree
 * with it site by site and character by character.
 */

// --- a synthetic typeset page -------------------------------------------------
// 10pt text, a 300pt column starting at x=72, 12pt line pitch. One pdf.js item
// per printed line, each closing its line (hasEOL), exactly as pdf.js reports a
// simple justified paragraph.
const EM = 10;
const LEFT = 72;
const WIDTH = 300;
const PITCH = 12;
const TOP = 700;

function item(str, { x = LEFT, y = TOP, em = EM, width, dir = "ltr", eol = true, skew = 0 } = {}) {
  return { str, dir, width: width ?? str.length * em * 0.5, height: em, transform: [em, skew, 0, em, x, y], fontName: "g_d0_f1", hasEOL: eol };
}

/**
 * A column of lines. A plain string is a justified line (stretched to the
 * column width), except the last, which keeps its natural width. An object
 * overrides one line: { str, x, dy (step from the previous line), em, width,
 * short (natural width), dir, skew }.
 */
function column(lines, { x = LEFT, top = TOP, pitch = PITCH, em = EM, width = WIDTH } = {}) {
  let y = top;
  return lines.map((entry, index) => {
    const line = typeof entry === "string" ? { str: entry } : entry;
    if (index > 0) y -= line.dy ?? pitch;
    const justified = index < lines.length - 1 && !line.short;
    return item(line.str, {
      x: line.x ?? x,
      y,
      em: line.em ?? em,
      width: line.width ?? (justified ? width - ((line.x ?? x) - x) : undefined),
      dir: line.dir,
      skew: line.skew,
    });
  });
}

const used = (word) => `The word ${word} was already used above in a plain way and`;
const BREAK = "the committee then asked for one further exam-";
const NEXT = "ple before the session was closed for the day by";
const LAST = "the presiding judge.";

/** Runs production, checks it against the frozen reference, returns the result. */
function repair(pages) {
  const { actual, differences } = compareWithReference(pages, inspectPdfLineBreakRepair);
  assert.deepEqual(differences, [], "production must equal the frozen Rule B3 reference");
  return actual;
}

/** The one candidate site of a page set (a line-final hyphen-like character followed by a letter). */
function onlySite(result) {
  const candidates = result.sites.filter((site) => site.measurements !== null);
  assert.equal(candidates.length, 1, "exactly one candidate site expected");
  return candidates[0];
}

function assertJoined(pages, fragments) {
  const result = repair(pages);
  const site = onlySite(result);
  assert.deepEqual(site.failed, []);
  assert.equal(site.join, true);
  assert.equal(`${site.leftFragment}+${site.rightFragment}`, fragments);
  assert.equal(result.lineBreakJoins, 1);
  return result;
}

function assertRefused(pages, failed) {
  const result = repair(pages);
  const site = onlySite(result);
  assert.deepEqual(site.failed, failed);
  assert.equal(site.join, false);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, pages.map(v1PageText), "a refused break leaves v1's text untouched");
  return result;
}

// =============================================================================
// The repair itself
// =============================================================================

test("genuine soft line hyphenation: 'exam-' / 'ple' is joined when 'example' is written inline, and only the hyphen and the break go", () => {
  const pages = [column([used("example"), BREAK, NEXT, LAST])];
  const result = assertJoined(pages, "exam+ple");
  const v1 = v1PageText(pages[0]);
  assert.equal(v1, `${used("example")} ${BREAK} ${NEXT} ${LAST}`);
  assert.equal(result.pages[0], `${used("example")} the committee then asked for one further example before the session was closed for the day by ${LAST}`);
  assert.equal(result.pages[0], v1.replace("exam- ple", "example"), "the only difference from v1 is the removed '- '");
});

test("the extractor emits the repaired text as its single text, and reports the join count without the words", async () => {
  const pages = [column([used("example"), BREAK, NEXT, LAST])];
  const document = { numPages: 1, async getPage() { return { async getTextContent() { return { items: pages[0] }; } }; } };
  const strict = await extractPdfTextDocument(document);
  assert.equal(strict, `${inspectPdfLineBreakRepair(pages).pages[0]}\n\n`);
  assert.ok(strict.includes("one further example before"));

  const withCompleteness = await extractPdfTextDocumentWithCompleteness(document);
  assert.equal(withCompleteness.text, strict);
  assert.equal(withCompleteness.lineBreakJoins, 1);
  assert.equal(withCompleteness.completeness, "COMPLETE");
  assert.deepEqual(Object.keys(withCompleteness).sort(), [
    "completeness", "diagnostics", "emptyPages", "extractedWordCount", "failedPages", "lineBreakJoins", "parsedPages", "text", "totalPages", "truncatedByMaxPages",
  ]);
  assert.deepEqual(withCompleteness.diagnostics, [], "no fragment of the document reaches the diagnostics");
});

test("a line made of several pdf.js items (a ligature split, a separate hyphen item, a trailing empty EOL item) is still one line", () => {
  const pages = [[
    item(used("configuration"), { y: 700, width: WIDTH }),
    item("the board then reviewed the con", { y: 688, width: 232, eol: false }),
    item("fi", { x: 304.02, y: 688, width: 8, eol: false }),
    item("gura", { x: 312.03, y: 688, width: 40, eol: false }),
    item("-", { x: 352.04, y: 688, width: 5, eol: false }),
    item("", { x: 357.04, y: 688, width: 0 }),
    item("tion of the device before the session was closed by", { y: 676, width: WIDTH }),
    item(LAST, { y: 664 }),
  ]];
  const result = assertJoined(pages, "configura+tion");
  assert.ok(result.pages[0].includes("reviewed the configuration of the device"));
});

// =============================================================================
// Predicates 13 / 14 — the inline evidence
// =============================================================================

test("no inline occurrence of the joined word: the break stays (recall limit, by design)", () => {
  assertRefused([column([used("sample"), BREAK, NEXT, LAST])], ["13-joined-word-inline"]);
});

test("legitimate compound, hyphenated pair written inline: 'well-' / 'known' stays, even when 'wellknown' is also written inline", () => {
  assertRefused(
    [column(["The well-known rule and the wellknown variant were both used above and", "the tribunal recalled that it is a well-", "known rule that bad faith is never presumed by", "courts."])],
    ["14-pair-never-inline"],
  );
});

test("legitimate compound with no inline evidence at all: 'state-' / 'owned' stays", () => {
  assertRefused(
    [column(["The report describes the privatisation of the largest state-", "owned enterprises during the transition towards a", "market economy."])],
    ["13-joined-word-inline"],
  );
});

test("ACCEPTED RESIDUAL: a prefix compound the document itself writes closed ('nonlinear') is joined at 'non-' / 'linear'", () => {
  const result = assertJoined(
    [column([used("nonlinear"), "the model predicts a strongly non-", "linear response of the membrane under a constant", "load."])],
    "non+linear",
  );
  assert.ok(result.pages[0].includes("a strongly nonlinear response"));
});

test("suspended hyphen: 'pre-' / 'and post-operative' stays ('preand' is not a word of the document)", () => {
  assertRefused(
    [column([used("operative"), "the protocol covered every patient during both the pre-", "and post-operative phases of treatment in the surgical", "ward."])],
    ["13-joined-word-inline"],
  );
});

test("evidence is document-wide: an inline occurrence on a LATER page justifies a break on the first page", () => {
  const pages = [column(["The committee met twice in the spring and once more and", BREAK, NEXT, LAST]), column(["On the last page the word example is finally written in", "full."])];
  const result = repair(pages);
  assert.equal(result.lineBreakJoins, 1);
  assert.ok(result.pages[0].includes("one further example before"));
  assert.equal(result.pages[1], v1PageText(pages[1]));
});

test("evidence comes from extracted pages only: beyond maxPages, or on a page that failed to parse, an occurrence does not count", async () => {
  const first = column(["The committee met twice in the spring and once more and", BREAK, NEXT, LAST]);
  const second = column(["On the last page the word example is finally written in", "full."]);
  const document = (failSecond) => ({
    numPages: 2,
    async getPage(n) {
      if (n === 2 && failSecond) throw new Error("page 2 is unreadable");
      return { async getTextContent() { return { items: n === 1 ? first : second }; } };
    },
  });

  const both = await extractPdfTextDocumentWithCompleteness(document(false));
  assert.equal(both.lineBreakJoins, 1);

  const truncated = await extractPdfTextDocumentWithCompleteness(document(false), undefined, 1);
  assert.equal(truncated.lineBreakJoins, 0);
  assert.equal(truncated.text, `${v1PageText(first)}\n\n`);
  assert.equal(truncated.completeness, "PARTIAL");

  const failed = await extractPdfTextDocumentWithCompleteness(document(true));
  assert.equal(failed.lineBreakJoins, 0);
  assert.equal(failed.text, `${v1PageText(first)}\n\n\n\n`);
  assert.equal(failed.completeness, "PARTIAL");
  await assert.rejects(() => extractPdfTextDocument(document(true)), /page 2 is unreadable/, "the strict extractor still throws on a failing page");
});

// =============================================================================
// Non-circular evidence
// =============================================================================

const ONLY_AT_BREAKS = ["The court examined whether the present legis-", "lative amendment affected the judges and the same legis-", "lative amendment was later repealed by the assembly", "of the state."];

test("CIRCULAR EVIDENCE IS FORBIDDEN: a word that exists only at line breaks never vouches for itself, however often it is broken", () => {
  const pages = [column(ONLY_AT_BREAKS)];
  const result = repair(pages);
  const candidates = result.sites.filter((site) => site.measurements !== null);
  assert.equal(candidates.length, 2);
  for (const site of candidates) {
    assert.deepEqual(site.failed, ["13-joined-word-inline"]);
    assert.equal(site.measurements.joinedInline, 0, "the fragments at a line break are not inline evidence");
    assert.equal(site.measurements.pairInline, 0, "nor is 'legis-' + 'lative' counted as an inline hyphenated pair");
  }
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, pages.map(v1PageText));

  // What the forbidden variant would do: let each candidate count the other
  // candidate's joined form. Both sites fail on predicate 13 ALONE, so a
  // circular evidence builder would join both.
  const circularJoins = candidates.filter((site) => site.failed.length === 1 && site.failed[0] === "13-joined-word-inline").length;
  assert.equal(circularJoins, 2);
});

test("one inline occurrence allows the join; an inline hyphenated pair forbids it", () => {
  assertJoined(
    [column(["The word legislative is written here in the plain way and", "the court examined whether the present legis-", "lative amendment affected the judges of the supreme", "court."])],
    "legis+lative",
  );
  assertRefused(
    [column(["The well-established rule is written inline here and the", "wellestablished form too; the tribunal recalled the well-", "established rule that bad faith is never presumed by", "courts."])],
    ["14-pair-never-inline"],
  );
});

test("ITERATIVE REPAIR IS FORBIDDEN: a word broken over three lines is decided once, from the original text only", () => {
  // "inter-" / "nation-" / "al": only the LAST break has evidence in the
  // original text ("national" is inline). Joining it produces "national",
  // which would make the first break ("inter-" + "national" = "international",
  // also inline) joinable — but only for a rule that looks at its own output.
  const lines = [
    "Both national courts and international courts apply the rule that",
    "the tribunal described as a settled principle of general inter-",
    "nation-",
    "al law on the responsibility of states for wrongful acts and",
    "omissions.",
  ];
  const pages = [column([lines[0], lines[1], { str: lines[2], width: WIDTH }, lines[3], lines[4]])];
  const result = repair(pages);
  const candidates = result.sites.filter((site) => site.measurements !== null);
  assert.deepEqual(candidates.map((site) => [`${site.leftFragment}+${site.rightFragment}`, site.join, site.failed]), [
    ["inter+nation", false, ["7-right-token-shape", "13-joined-word-inline"]],
    ["nation+al", true, []],
  ]);
  assert.equal(result.lineBreakJoins, 1);
  assert.ok(result.pages[0].includes("general inter- national law on the responsibility"), "single pass: the first break is left as it was");
  assert.ok(!result.pages[0].includes("international law"));

  // The forbidden variant, made explicit: feed the repaired lines back in.
  const repairedLines = [lines[0], lines[1], "national law on the responsibility of states for wrongful acts and", lines[4]];
  const secondPass = repair([column(repairedLines)]);
  assert.equal(secondPass.lineBreakJoins, 1, "a second pass over the repaired text WOULD join 'inter-' + 'national'");
  assert.equal(result.lineBreakJoins + secondPass.lineBreakJoins, 2, "iterative total (2) differs from the frozen single pass (1)");
});

test("the evidence is immutable: deciding does not change it, and the repair is repeatable on the same items", () => {
  const pages = [column([used("example"), BREAK, NEXT, LAST]), column(ONLY_AT_BREAKS)];
  const snapshot = JSON.stringify(pages);
  const layouts = pages.map((items) => reference.segmentPage(items));
  const before = reference.buildEvidence(layouts);
  const first = inspectPdfLineBreakRepair(pages);
  const second = inspectPdfLineBreakRepair(pages);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(pages), snapshot, "the items are not modified");
  const after = reference.buildEvidence(pages.map((items) => reference.segmentPage(items)));
  assert.deepEqual([...after.words], [...before.words]);
  assert.deepEqual([...after.pairs], [...before.pairs]);
  // the join on page 1 did not create evidence for page 2's sites
  for (const site of first.sites.filter((s) => s.pageIndex === 1 && s.measurements !== null)) assert.equal(site.measurements.joinedInline, 0);
});

// =============================================================================
// Predicate 2 — only U+002D
// =============================================================================

for (const [codePoint, name] of [
  ["00AD", "SOFT HYPHEN"], ["2010", "HYPHEN"], ["2011", "NON-BREAKING HYPHEN"], ["2012", "FIGURE DASH"],
  ["2013", "EN DASH"], ["2014", "EM DASH"], ["2212", "MINUS SIGN"],
]) {
  test(`U+${codePoint} ${name} at a line end is never removed`, () => {
    const hyphen = String.fromCodePoint(Number.parseInt(codePoint, 16));
    const result = assertRefused(
      [column([used("example"), `the committee then asked for one further exam${hyphen}`, NEXT, LAST])],
      ["2-hyphen-is-U+002D", "6-left-token-shape"],
    );
    assert.equal(onlySite(result).hyphen, codePoint);
    assert.ok(result.pages[0].includes(`exam${hyphen} ple`));
  });
}

// =============================================================================
// Predicates 3 / 4 / 5 — the fragments
// =============================================================================

test("upper case at the break is refused: 'CONSTI-' / 'TUTIONAL' and 'non-' / 'European'", () => {
  assertRefused(
    [column([used("constitutional"), "CHAPTER THREE THE PRINCIPLES OF MODERN CONSTI-", "TUTIONAL REVIEW IN COMPARATIVE PERSPECTIVE AND", "PRACTICE"])],
    ["3-lowercase-at-break"],
  );
  assertRefused(
    [column([used("nonEuropean"), "the directive applies without distinction to every non-", "European undertaking established in the internal market for", "services."])],
    ["3-lowercase-at-break"],
  );
});

test("German: 'Kranken-' / 'haus' is joined (lower case on both sides of the break); 'Bundes-' / 'Regierung' is not", () => {
  const result = assertJoined(
    [column(["Das Wort Krankenhaus wurde oben bereits in schlichter Weise verwendet und", "die Patienten wurden nach der Operation im selben Kranken-", "haus weiter betreut und nach zehn Tagen nach Hause", "entlassen."])],
    "Kranken+haus",
  );
  assert.ok(result.pages[0].includes("im selben Krankenhaus weiter betreut"));
  assertRefused(
    [column(["Das Wort BundesRegierung wurde oben bereits in schlichter Weise verwendet und", "der Entwurf wurde im Frühjahr von der Bundes-", "Regierung beschlossen und dem Parlament", "zugeleitet."])],
    ["3-lowercase-at-break"],
  );
});

test("German gender colon: 'Pati-' / 'ent:innen' is left broken by design (predicate 7b), although 'Patient' is written inline", () => {
  const result = assertRefused(
    [column(["Die Patient:innen und jeder einzelne Patient wurden oben bereits genannt und", "die Versorgung aller stationär aufgenommenen Pati-", "ent:innen wurde im selben Zeitraum deutlich", "verbessert."])],
    ["7b-no-url-structure"],
  );
  assert.ok(result.pages[0].includes("Pati- ent:innen wurde"));
  assert.ok(onlySite(result).measurements.joinedInline >= 1, "the evidence is there; only the token structure refuses the join");
});

test("French: 'pré-' / 'vention' (precomposed accent) is joined; an elision on the left token ('l’administra-') is not", () => {
  const result = assertJoined(
    [column(["Le mot prévention a déjà été employé plus haut de façon simple et", "les auteurs soulignent que les programmes nationaux de pré-", "vention restent insuffisants dans les régions rurales du", "pays."])],
    "pré+vention",
  );
  assert.ok(result.pages[0].includes("programmes nationaux de prévention restent"));
  assertRefused(
    [column(["Le mot administration a déjà été employé plus haut de façon simple et", "le tribunal a rappelé que la décision relevait de l’administra-", "tion centrale et non des services déconcentrés de la", "région."])],
    ["6-left-token-shape"],
  );
});

test("accented Latin, DECOMPOSED: a word written with combining marks is never joined — the inline evidence is tokenised on letters only", () => {
  // "généra-" / "lement": the fragments are well formed, but the
  // inline "généralement" is counted as "ge", "ne", "ralement", so the
  // joined word is never found inline. A recall limit of the frozen rule, not
  // a false join: the same text in precomposed form (previous test) is joined.
  const inside = assertRefused(
    [column(["Le mot généralement a déjà été employé plus haut de façon simple et", "les auteurs soulignent que ces mesures restent généra-", "lement insuffisantes dans les régions rurales du", "pays."])],
    ["13-joined-word-inline"],
  );
  assert.equal(onlySite(inside).leftFragment, "généra");
  // "pré-" / "vention": here the character before the hyphen is U+0301
  // itself, which is not a lower-case letter
  assertRefused(
    [column(["Le mot prévention a déjà été employé plus haut de façon simple et", "les auteurs soulignent que les programmes nationaux de pré-", "vention restent insuffisants dans les régions rurales du", "pays."])],
    ["3-lowercase-at-break", "13-joined-word-inline"],
  );
});

test("non-Latin fragments are never joined: Cyrillic and Greek, with the joined word written inline", () => {
  assertRefused(
    [column(["Слово примера уже было использовано выше в простом виде и", "комитет затем попросил ещё одного приме-", "ра до закрытия заседания в этот", "день."])],
    ["4-latin-fragments"],
  );
  assertRefused(
    [column(["Η λέξη παράδειγμα χρησιμοποιήθηκε ήδη παραπάνω και", "η επιτροπή ζήτησε ένα ακόμη παρά-", "δειγμα πριν από το τέλος της", "ημέρας."])],
    ["4-latin-fragments"],
  );
});

test("one-letter fragments are refused on either side: 'x-' / 'ray' and 'exampl-' / 'e'", () => {
  assertRefused(
    [column([used("xray"), "every patient admitted to the unit underwent a chest x-", "ray on admission and again after three days in the", "ward."])],
    ["5-fragment-length>=2"],
  );
  assertRefused(
    [column([used("example"), "the committee then asked for one further exampl-", "e before the session was closed for the day by", LAST])],
    ["5-fragment-length>=2"],
  );
});

// =============================================================================
// Predicates 6 / 7 / 7b — token shape and URL structure
// =============================================================================

test("left token: opening punctuation before the fragment is allowed; a digit, a slash or an inner hyphen is not", () => {
  assertJoined([column([used("example"), "the committee then asked for one further (exam-", NEXT, LAST])], "exam+ple");
  assertJoined([column([used("example"), "the committee then asked for one further “exam-", NEXT, LAST])], "exam+ple");
  assertRefused([column([used("example"), "the committee then asked for one further 2exam-", NEXT, LAST])], ["6-left-token-shape"]);
  assertRefused([column([used("acetylcysteine"), "all patients in the intervention arm received oral N-acetyl-", "cysteine twice daily for a period of fourteen days after", "surgery."])], ["6-left-token-shape"]);
});

test("right token: closing punctuation after the fragment is allowed; a hyphen or a glued digit is not", () => {
  for (const next of ["ple. The session was then closed for the day by", "ple, and the session was closed for the day by", "ple; the session was then closed for the day by", "ple) before the session was closed for the day by", "ple” before the session was closed for the day by"]) {
    assertJoined([column([used("example"), BREAK, next, LAST])], "exam+ple");
  }
  assertRefused(
    [column([used("motherin"), "the applicant had lived for several years with her mother-", "in-law in the family home before the dispute concerning", "it."])],
    ["7-right-token-shape"],
  );
});

test("footnote number glued to the word: 'ple12' fails the token shape, 'ple.12' fails 7b — both stay broken (accepted cost)", () => {
  assertRefused([column([used("example"), BREAK, "ple12 before the session was closed for the day by", LAST])], ["7-right-token-shape"]);
  assertRefused([column([used("example"), BREAK, "ple.12 The session was then closed for the day by", LAST])], ["7b-no-url-structure"]);
});

test("URL: a break inside the path, and a break inside the scheme ('htt-' / 'ps://...'), are never joined", () => {
  assertRefused(
    [column([used("longpath"), "the data set is available at https://example.org/files/long-", "path/archive.zip and is described in the appendix to the", "report."])],
    ["6-left-token-shape", "7-right-token-shape", "7b-no-url-structure"],
  );
  assertRefused(
    [column(["See https and the plain form of the address written above and", "the data set and its documentation can be retrieved from htt-", "ps://example.org/files/archive.zip and are described in the", "appendix."])],
    ["7b-no-url-structure"],
  );
});

test("DOI: a break after a hyphen inside the identifier, and a break before a dotted suffix, are never joined", () => {
  assertRefused(
    [column([used("abcdef"), "the article is registered under the identifier doi:10.1000/abc-", "def.2024.17 and can be retrieved from the publisher at any", "time."])],
    ["6-left-token-shape", "7b-no-url-structure"],
  );
  assertRefused(
    [column([used("journal"), "the article is registered under the suffix of the jour-", "nal.2024.17 and can be retrieved from the publisher at any", "time."])],
    ["7b-no-url-structure"],
  );
});

test("e-mail address: 'john-' / 'smith@example.org' is never joined", () => {
  assertRefused(
    [column([used("johnsmith"), "requests for the data set should be addressed to john-", "smith@example.org and will be answered within thirty", "days."])],
    ["7-right-token-shape", "7b-no-url-structure"],
  );
});

test("slash token: 'input/out-' / 'put' and 'out-' / 'put/input' are never joined", () => {
  assertRefused(
    [column([used("output"), "the table reports for every plant the ratio of input/out-", "put before and after the reform of the tariff in each", "year."])],
    ["6-left-token-shape", "7b-no-url-structure"],
  );
  assertRefused(
    [column([used("output"), "the table reports for every plant the ratio of out-", "put/input before and after the reform of the tariff in", "each year."])],
    ["7-right-token-shape", "7b-no-url-structure"],
  );
});

test("colon token: 'ple:value' is refused by 7b, while a colon that ends the token ('ple: value') is ordinary punctuation", () => {
  assertRefused([column([used("example"), BREAK, "ple:value pairs before the session was closed by", LAST])], ["7b-no-url-structure"]);
  assertJoined([column([used("example"), BREAK, "ple: value pairs before the session was closed by", LAST])], "exam+ple");
});

test("period / domain token: 'ple.org' is refused by 7b, while a full stop that ends the token is ordinary punctuation", () => {
  assertRefused([column([used("example"), BREAK, "ple.org and are described before the session closed", LAST])], ["7b-no-url-structure"]);
  assertJoined([column([used("example"), BREAK, "ple.) The session was then closed for the day by", LAST])], "exam+ple");
});

// =============================================================================
// Predicate 8 — upright, not right-to-left
// =============================================================================

test("right-to-left runs are never joined, on either side of the break", () => {
  assertRefused([column([used("example"), { str: BREAK, dir: "rtl" }, NEXT, LAST])], ["8-upright-not-rtl"]);
  assertRefused([column([used("example"), BREAK, { str: NEXT, dir: "rtl" }, LAST])], ["8-upright-not-rtl"]);
});

test("Arabic lines with a line-final hyphen are never joined", () => {
  const result = repair([column([
    { str: "المحكمة الدستورية قانوندستوري و", dir: "rtl" },
    { str: "المحكمة الدستورية قانون-", dir: "rtl" },
    { str: "دستوري جديد في هذا المجال و", dir: "rtl" },
    { str: "السلام.", dir: "rtl" },
  ])]);
  assert.deepEqual(onlySite(result).failed, ["3-lowercase-at-break", "4-latin-fragments", "8-upright-not-rtl"]);
  assert.equal(result.lineBreakJoins, 0);
});

test("skewed text is refused; text rotated by 90 degrees has no usable geometry and yields no site at all", () => {
  assertRefused([column([used("example"), { str: BREAK, skew: 0.4 }, NEXT, LAST])], ["8-upright-not-rtl"]);
  assertRefused([column([used("example"), BREAK, { str: NEXT, skew: 0.4 }, LAST])], ["8-upright-not-rtl"]);

  const rotated = [used("example"), BREAK, NEXT, LAST].map((str, index) => ({
    str, dir: "ltr", width: 300, height: 10, transform: [0, 10, -10, 0, 72 + index * 12, 100], fontName: "g_d0_f1", hasEOL: true,
  }));
  const result = repair([rotated]);
  assert.equal(result.sites.length, 0);
  assert.equal(result.pages[0], v1PageText(rotated));
});

// =============================================================================
// Predicate 9 — the next line is directly below, at body pitch
// =============================================================================

test("body pitch, lower bound: the next line must be more than 0.5 em below (0.51 em is joined, 0.50 em is not)", () => {
  assertJoined([column([used("example"), BREAK, { str: NEXT, dy: 5.1 }, LAST])], "exam+ple");
  assertRefused([column([used("example"), BREAK, { str: NEXT, dy: 5 }, LAST])], ["9-next-line-below-at-body-pitch"]);
});

test("body pitch, 2.6 em: up to 2.6 em below is always accepted; beyond it only at the page's own line pitch", () => {
  assertJoined([column([used("example"), BREAK, { str: NEXT, dy: 26 }, LAST])], "exam+ple");
  // 2.61 em on a page whose pitch is 1.2 em: a gap, not a line step
  assertRefused([column([used("example"), BREAK, { str: NEXT, dy: 26.1 }, LAST])], ["9-next-line-below-at-body-pitch"]);
});

test("body pitch, wide leading: on a page set at 2.8 em a 2.8 em step is joined; a larger step only within 25% of that pitch (rounded to 2 decimals)", () => {
  const wide = (dy) => [column([used("example"), BREAK, { str: NEXT, dy }, LAST, "A further line keeps the page pitch well defined and", "ends here."], { pitch: 28 })];
  assertJoined(wide(28), "exam+ple");
  assertJoined(wide(35), "exam+ple"); // |35 - 28| / 28 = 0.25
  assertJoined(wide(35.1), "exam+ple"); // 0.2536 rounds to 0.25
  assertRefused(wide(35.2), ["9-next-line-below-at-body-pitch"]); // 0.2571 rounds to 0.26
});

test("body pitch, upper bound: never more than 4 em below, whatever the page pitch (4.00 em is joined, 4.01 em is not)", () => {
  // 12pt lines at a 33pt pitch around a 10pt line that ends with the hyphen
  const tall = (dy) => [column([used("example"), { str: BREAK, em: 10 }, { str: NEXT, dy }, LAST, "A further line keeps the page pitch well defined and", "ends here."], { pitch: 33, em: 12 })];
  assertJoined(tall(40), "exam+ple");
  assertRefused(tall(40.1), ["9-next-line-below-at-body-pitch"]);
});

test("header and footer: a running header above the body and a footer far below it are not continuations", () => {
  // header (emitted first) -> first body line, 60pt below
  assertRefused(
    [[item("Journal of Comparative Constitutional Review and Public Consti-", { y: 760, width: WIDTH }), ...column(["tutional law was already discussed in the plain way above and", "the word constitutional was used there more than", "once."])]],
    ["9-next-line-below-at-body-pitch"],
  );
  // last body line -> footer in a smaller font near the foot of the page
  assertRefused(
    [[...column([used("constitutional"), { str: "the chamber finally turned to the admissibility of the consti-", width: WIDTH }]), item("tutional review quarterly, volume 12, page 7", { y: 60, em: 7 })]],
    ["9-next-line-below-at-body-pitch"],
  );
});

// =============================================================================
// Predicate 10 — same column
// =============================================================================

test("column boundary, right: the next line may start up to 3 em to the right (3.00 em is joined, 3.01 em is not)", () => {
  assertJoined([column([used("example"), BREAK, { str: NEXT, x: LEFT + 30 }, LAST])], "exam+ple");
  assertRefused([column([used("example"), BREAK, { str: NEXT, x: LEFT + 30.1 }, LAST])], ["10-same-column"]);
});

test("column boundary, left: the next line may start up to 6 em to the left (6.00 em is joined, 6.01 em is not)", () => {
  assertJoined([column([used("example"), BREAK, { str: NEXT, x: LEFT - 60 }, LAST])], "exam+ple");
  assertRefused([column([used("example"), BREAK, { str: NEXT, x: LEFT - 60.1 }, LAST])], ["10-same-column"]);
});

test("column boundary: a next line that starts at or beyond the END of the broken line is another column, however close", () => {
  // the broken line is only 25pt wide; the next segment starts exactly where it ends, one line down
  assertRefused(
    [column([used("example"), { str: "exam-", short: true }, { str: NEXT, x: LEFT + 25 }, LAST])],
    ["10-same-column", "12-right-edge-would-not-fit"],
  );
});

test("multi-column: the foot of column 1 is not continued at the head of column 2", () => {
  const left = column([used("international").slice(0, 44), "the first column of this page ends with a", "word that is broken at its foot: inter-"], { width: 230, top: 660 });
  left[2].width = 230;
  const right = column(["national law is discussed at the top of the", "second column of the very same page."], { x: 330, width: 230, top: 700 });
  assertRefused([[...left, ...right]], ["9-next-line-below-at-body-pitch", "10-same-column"]);
});

test("multi-column: two columns emitted side by side on one baseline are one printed line, and its end is not a line end", () => {
  const rows = [
    [used("example").slice(0, 40), "a second column runs beside the first"],
    ["the committee asked for one further exam-", "ple of the second column on this line"],
    ["the first column then simply goes on and", "so does the second column beside it"],
  ];
  const items = rows.flatMap(([a, b], index) => [item(a, { x: 72, y: 700 - index * 12, width: 230 }), item(b, { x: 330, y: 700 - index * 12, width: 230 })]);
  // the second column is on the same baseline (9), the printed line goes on to
  // the right (12), and the 2.8 em between the two columns is a gutter (12b)
  assertRefused([items], ["9-next-line-below-at-body-pitch", "12-right-edge-would-not-fit", "12b-no-column-gutter"]);
});

test("table: a cell that ends with a hyphen is not continued in the next cell of its row", () => {
  const row = (cells, y) => cells.map(([str, x, width]) => item(str, { x, y, width }));
  const items = [
    ...row([["Type of body", 72, 80], ["Example given", 200, 90], ["Reply", 400, 60]], 700),
    ...row([["Type of exam-", 72, 80], ["ple of a reply", 200, 90], ["yes", 400, 60]], 686),
    ...row([["authority", 72, 80], ["none", 200, 90], ["no", 400, 60]], 672),
    item("The word example was already used in the header of the table.", { y: 640 }),
  ];
  // the cells of a row are one printed line: the next cell is on the same
  // baseline (9), the "line" it belongs to goes on to the right (12), and it
  // holds the gutters of the table (12b)
  assertRefused([items], ["9-next-line-below-at-body-pitch", "12-right-edge-would-not-fit", "12b-no-column-gutter"]);
});

test("table: across a row change the cells of one printed row are kept apart by its gutters, with or without inline evidence", () => {
  // The last cell of a row ends "govern-"; the first cell of the next row
  // starts "ment". The cells of a row merge into one printed line, so the next
  // row IS directly below in the same column: predicates 9-12 pass. The row
  // holds two gutters of several em: predicate 12b refuses the break, even
  // when "government" is written inline.
  const row = (cells, y) => cells.map(([str, x, width]) => item(str, { x, y, width }));
  const table = (firstCellOfNextRow) => [
    ...row([["Body", 72, 80], ["Seat", 200, 90], ["Type of body", 400, 100]], 700),
    ...row([["Council", 72, 80], ["Capital", 200, 90], ["local govern-", 400, 100]], 686),
    ...row([[firstCellOfNextRow, 72, 80], ["Capital", 200, 90], ["agency", 400, 100]], 672),
  ];
  assertRefused([table("Senate")], ["3-lowercase-at-break", "12b-no-column-gutter", "13-joined-word-inline"]);
  assertRefused([table("senate")], ["12b-no-column-gutter", "13-joined-word-inline"]);
  const withEvidence = [...table("ment"), item("The word government was used above.", { y: 640 })];
  const site = onlySite(assertRefused([withEvidence], ["12b-no-column-gutter"]));
  assert.equal(site.measurements.joinedInline, 1, "the evidence predicates would have allowed the join");
  assert.equal(site.measurements.widestGapEm, 11);
  assert.equal(site.measurements.sharedGutter, true);
});

// =============================================================================
// Predicate 12b — the hyphenated line holds no column gutter
// =============================================================================

// A printed line made of several text items: each cell is [text, x, width];
// only the last one closes the line, as pdf.js reports a table row or two
// columns set side by side.
const cells = (y, ...parts) => parts.map(([str, x, width], index) => item(str, { x, y, width, eol: index === parts.length - 1 }));

test("wide gutter: a gap of 2 em or more between two items of the hyphenated line refuses the break (1.99 em is joined, 2.00 em is not)", () => {
  // "exam-" still ends at the right edge of the block (x = 372): only 12b can refuse
  const page = (secondCellX) => [[
    item(used("example"), { y: 700, width: WIDTH }),
    ...cells(688, ["the committee then asked", 72, 120], ["for one further exam-", secondCellX, 372 - secondCellX]),
    item(NEXT, { y: 676, width: WIDTH }),
    item(LAST, { y: 664 }),
  ]];
  const joined = onlySite(assertJoined(page(211.9), "exam+ple"));
  assert.equal(joined.measurements.widestGapEm, 1.99);
  assert.equal(joined.measurements.gutterGaps, 1);
  assert.equal(joined.measurements.sharedGutter, false, "the next line is a single run: nothing to share");
  const refused = onlySite(assertRefused(page(212), ["12b-no-column-gutter"]));
  assert.equal(refused.measurements.widestGapEm, 2);
  assert.equal(refused.measurements.sharedGutter, false);
});

test("repeated gutter: a gap of 0.6 em or more that the next line repeats at the same position refuses the break (0.59 em is joined, 0.60 em is not)", () => {
  // both lines are two cells; the second cell of the next line starts at x = 198
  const page = (secondCellX) => [[
    item(used("example"), { y: 700, width: WIDTH }),
    ...cells(688, ["the committee then asked", 72, 120], ["for one further exam-", secondCellX, 372 - secondCellX]),
    ...cells(676, ["ple before the session", 72, 110], ["was closed for the day by", 198, 174]),
    item(LAST, { y: 664 }),
  ]];
  const refused = onlySite(assertRefused(page(198), ["12b-no-column-gutter"]));
  assert.equal(refused.measurements.widestGapEm, 0.6);
  assert.equal(refused.measurements.gutterGaps, 1);
  assert.equal(refused.measurements.sharedGutter, true);
  const joined = onlySite(assertJoined(page(197.9), "exam+ple"));
  assert.equal(joined.measurements.widestGapEm, 0.59);
  assert.equal(joined.measurements.gutterGaps, 0, "a gap under 0.6 em is a word space, not a gutter");
  assert.equal(joined.measurements.sharedGutter, false);
});

test("repeated gutter: 'the same position' is within 0.1 em (0.10 em apart is refused, 0.11 em is joined)", () => {
  const page = (nextLineCellX) => [[
    item(used("example"), { y: 700, width: WIDTH }),
    ...cells(688, ["the committee then asked", 72, 120], ["for one further exam-", 202, 170]),
    ...cells(676, ["ple before the session", 72, 110], ["was closed for the day by", nextLineCellX, 372 - nextLineCellX]),
    item(LAST, { y: 664 }),
  ]];
  assert.equal(onlySite(assertRefused(page(203), ["12b-no-column-gutter"])).measurements.sharedGutter, true);
  assert.equal(onlySite(assertRefused(page(201), ["12b-no-column-gutter"])).measurements.sharedGutter, true);
  const joined = onlySite(assertJoined(page(203.1), "exam+ple"));
  assert.equal(joined.measurements.widestGapEm, 1, "a 1 em gap on the hyphenated line, repeated nowhere");
  assert.equal(joined.measurements.sharedGutter, false);
});

test("repeated gutter: sizes are in em of the hyphenated line — the same 6pt gap is a gutter at 10pt and a word space at 12pt", () => {
  const sized = (entries, em) => entries.map((entry) => ({ ...entry, height: em, transform: [em, 0, 0, em, entry.transform[4], entry.transform[5]] }));
  const page = (em) => [[
    item(used("example"), { y: 700, width: WIDTH, em }),
    ...sized(cells(686, ["the committee then asked", 72, 120], ["for one further exam-", 198, 174]), em),
    ...sized(cells(672, ["ple before the session", 72, 110], ["was closed for the day by", 198, 174]), em),
    item(LAST, { y: 658, em }),
  ]];
  assert.equal(onlySite(assertRefused(page(10), ["12b-no-column-gutter"])).measurements.widestGapEm, 0.6);
  assert.equal(onlySite(assertJoined(page(12), "exam+ple")).measurements.widestGapEm, 0.5);
});

test("repeated gutter: a line with more than five such gaps is word-per-item text, not columns (five shared gaps are refused, six are joined)", () => {
  // every word group is its own item, 1 em apart, at the same positions on both lines
  const spread = (y, words) => {
    const step = (WIDTH + 10) / words.length;
    return words.map((str, index) => item(str, { x: LEFT + index * step, y, width: step - 10, eol: index === words.length - 1 }));
  };
  const page = (a, b) => [[item(used("example"), { y: 700, width: WIDTH }), ...spread(688, a), ...spread(676, b), item(LAST, { y: 664 })]];
  const five = onlySite(assertRefused(
    page(["the", "committee", "then asked", "for one", "further", "exam-"], ["ple", "before", "the session", "was closed", "for the", "day by"]),
    ["12b-no-column-gutter"],
  ));
  assert.equal(five.measurements.gutterGaps, 5);
  assert.equal(five.measurements.widestGapEm, 1);
  assert.equal(five.measurements.sharedGutter, true);
  const six = onlySite(assertJoined(
    page(["the", "committee", "then", "asked", "for one", "further", "exam-"], ["ple", "before", "the", "session", "was closed", "for the", "day by"]),
    "exam+ple",
  ));
  assert.equal(six.measurements.gutterGaps, 6);
  assert.equal(six.measurements.widestGapEm, 1);
  assert.equal(six.measurements.sharedGutter, false, "the same six positions on both lines, and still not a shared gutter");
});

test("wide gutter: the 2 em test has no such exemption — word-per-item text with one 2 em gap is refused", () => {
  // seven items 1 em apart, except that the first three sit 1 em further left: the gap after the third is 2 em
  const step = (WIDTH + 10) / 7;
  const words = ["the", "committee", "then", "asked", "for one", "further", "exam-"];
  const line = words.map((str, index) => item(str, { x: LEFT + index * step + (index < 3 ? -10 : 0), y: 688, width: step - 10, eol: index === words.length - 1 }));
  const page = [[item(used("example"), { x: LEFT - 10, y: 700, width: WIDTH + 10 }), ...line, item(NEXT, { x: LEFT - 10, y: 676, width: WIDTH + 10 }), item(LAST, { x: LEFT - 10, y: 664 })]];
  const site = onlySite(assertRefused(page, ["12b-no-column-gutter"]));
  assert.equal(site.measurements.widestGapEm, 2);
  assert.equal(site.measurements.gutterGaps, 6);
  assert.equal(site.measurements.sharedGutter, false);
});

test("a gutter is found across the segments of one printed line: pdf.js may end a segment at the gap itself", () => {
  // the first cell closes its own segment (hasEOL); the two segments share a baseline and are one printed line
  const page = [[
    item(used("example"), { y: 700, width: WIDTH }),
    item("the committee then asked", { y: 688, width: 120 }),
    item("for one further exam-", { x: 212, y: 688, width: 160 }),
    item(NEXT, { y: 676, width: WIDTH }),
    item(LAST, { y: 664 }),
  ]];
  const site = onlySite(assertRefused(page, ["12b-no-column-gutter"]));
  assert.equal(site.measurements.widestGapEm, 2);
});

test("overlapping or touching items are not a gap: a line split into abutting runs with a separate hyphen item is left alone by 12b", () => {
  const page = [[
    item(used("example"), { y: 700, width: WIDTH }),
    ...cells(688, ["the committee then asked for one", 72, 215], [" further", 285, 60], [" exam", 345, 23], ["-", 368, 4]),
    item(NEXT, { y: 676, width: WIDTH }),
    item(LAST, { y: 664 }),
  ]];
  const site = onlySite(assertJoined(page, "exam+ple"));
  assert.equal(site.measurements.widestGapEm, 0);
  assert.equal(site.measurements.gutterGaps, 0);
});

test("KNOWN LIMIT (frozen, not a protection): a 0.6 to 2 em gutter that the next line does not repeat is not detected", () => {
  // two cells 1.2 em apart; the line below is a single run, so nothing is shared and the break is joined
  const page = [[
    item(used("example"), { y: 700, width: WIDTH }),
    ...cells(688, ["the committee then asked", 72, 120], ["for one further exam-", 204, 168]),
    item(NEXT, { y: 676, width: WIDTH }),
    item(LAST, { y: 664 }),
  ]];
  const site = onlySite(assertJoined(page, "exam+ple"));
  assert.equal(site.measurements.widestGapEm, 1.2);
  assert.equal(site.measurements.gutterGaps, 1);
});

test("KNOWN LIMIT (frozen, not a protection): a gutter that exists only on the NEXT line is not tested", () => {
  const page = [[
    item(used("example"), { y: 700, width: WIDTH }),
    item(BREAK, { y: 688, width: WIDTH }),
    ...cells(676, ["ple before the session", 72, 110], ["was closed for the day by", 252, 120]),
    item(LAST, { y: 664 }),
  ]];
  const site = onlySite(assertJoined(page, "exam+ple"));
  assert.equal(site.measurements.widestGapEm, 0, "the hyphenated line is a single run");
});

// -----------------------------------------------------------------------------
// Tables as pdf.js really reports them: the recorded pdf.js 6.2.108 item
// streams of twenty small PDFs (pdf-lib, standard Helvetica, invented text).
// pdf.js emits a whole printed table row as ONE line — the cells of a row are
// not separated by an end-of-line — so the table boundary the rule meets is a
// ROW CHANGE: the last cell's wrapped line, then the first cell's next line.
// "provides the in-" (which continues "ternal audit report" in its own cell)
// followed by the first cell's "formation of the committee" must not become
// "information".
//
// Every fixture carries `joiningIsWrong` and `outcome`. A wrong join that the
// rule refuses is a protection. T13 is NOT one: it is an accepted residual —
// see its own test below.
// -----------------------------------------------------------------------------
const tables = JSON.parse(readFileSync(new URL("./fixtures/pdf-line-break/table-fixtures.json", import.meta.url), "utf8"));
const tableCase = (id) => {
  const fixture = tables.fixtures.find((candidate) => candidate.id === id);
  assert.ok(fixture, `table fixture ${id}`);
  return { fixture, result: repair(fixture.pages) };
};

test("the table fixture set: 20 recorded streams, each run against its recorded outcome; T13 is the only accepted residual", () => {
  assert.equal(tables.count, 20);
  assert.deepEqual(tables.fixtures.map((fixture) => fixture.id), ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14", "T15", "C1", "C2", "C3", "C4", "C5"]);
  for (const fixture of tables.fixtures) {
    const { result } = tableCase(fixture.id);
    const candidates = result.sites.filter((site) => site.measurements !== null);
    assert.equal(result.lineBreakJoins, fixture.joins, fixture.id);
    assert.deepEqual(result.sites.filter((site) => site.join).map((site) => `${site.leftFragment}+${site.rightFragment}`), fixture.joined, fixture.id);
    assert.equal(candidates.length, fixture.candidateSites, fixture.id);
    assert.deepEqual([...new Set(candidates.flatMap((site) => site.failed))], fixture.failed, fixture.id);
    if (fixture.joins === 0) assert.deepEqual(result.pages, fixture.pages.map(v1PageText), `${fixture.id}: nothing joined, v1's own text`);
  }
  // how the fixtures count: a wrong join still made is a residual, never a protection
  const wrongJoins = tables.fixtures.filter((fixture) => fixture.joiningIsWrong && fixture.joins > 0).map((fixture) => fixture.id);
  assert.deepEqual(wrongJoins, ["T13"]);
  assert.deepEqual(tables.acceptedResidual, ["T13"]);
  assert.deepEqual(tables.fixtures.filter((fixture) => fixture.outcome === "ACCEPTED-RESIDUAL-wrong-join").map((fixture) => fixture.id), ["T13"]);
  const protections = tables.fixtures.filter((fixture) => fixture.joiningIsWrong && fixture.outcome === "refused").map((fixture) => fixture.id);
  assert.deepEqual(protections, ["T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T14"]);
  assert.ok(!protections.includes("T13"), "T13 is not a passing structural protection case");
});

test("real pdf.js table, same row: a hyphen at the end of a cell is not at the end of a line, so it is not even a candidate", () => {
  const { fixture, result } = tableCase("T1");
  assert.equal(result.sites.length, 0);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, fixture.pages.map(v1PageText));
  assert.ok(result.pages[0].includes("Registry provides the in- formation desk"), "the row is one line; the cell hyphen stays");
});

test("real pdf.js table, row change in a table narrower than the text block: refused twice over — the row stops short of the block's right edge, and it holds a gutter", () => {
  for (const [id, failed] of [
    ["T2", ["12-right-edge-would-not-fit", "12b-no-column-gutter", "13-joined-word-inline"]],
    ["T3", ["12-right-edge-would-not-fit", "12b-no-column-gutter"]], // "information" IS written inline here; geometry alone refuses
    ["T4", ["12-right-edge-would-not-fit", "12b-no-column-gutter", "13-joined-word-inline"]],
  ]) {
    const { fixture, result } = tableCase(id);
    assert.deepEqual(onlySite(result).failed, failed, id);
    assert.equal(result.lineBreakJoins, 0, id);
    assert.deepEqual(result.pages, fixture.pages.map(v1PageText), id);
  }
});

test("real pdf.js table, row change in a full-width table, joined word not written anywhere: refused by the gutter and by the evidence", () => {
  const { fixture, result } = tableCase("T6");
  const site = onlySite(result);
  assert.equal(`${site.leftFragment}+${site.rightFragment}`, "in+formation");
  assert.deepEqual(site.failed, ["12b-no-column-gutter", "13-joined-word-inline"]);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, fixture.pages.map(v1PageText));
});

test("real pdf.js table, T5 and T7: a row change in a full-width table is REFUSED although the fragments spell a word the document writes inline", () => {
  // The counterexample that blocked Rule B2: every other predicate passes —
  // the row reaches the right edge of its block and "information" is written
  // elsewhere on the page. The 17.6 em gutter of the row refuses the break.
  for (const id of ["T5", "T7"]) {
    const { fixture, result } = tableCase(id);
    const site = onlySite(result);
    assert.equal(fixture.joiningIsWrong, true, id);
    assert.equal(`${site.leftFragment}+${site.rightFragment}`, "in+formation", id);
    assert.deepEqual(site.failed, ["12b-no-column-gutter"], `${id}: the gutter is the only thing that refuses`);
    assert.equal(site.join, false, id);
    assert.equal(site.measurements.joinedInline, 1, `${id}: "information" is written once, elsewhere on the page`);
    assert.equal(site.measurements.pairInline, 0, id);
    assert.equal(site.measurements.widestGapEm, 17.57, id);
    assert.equal(site.measurements.sharedGutter, true, id);
    assert.equal(result.lineBreakJoins, 0, id);
    assert.deepEqual(result.pages, fixture.pages.map(v1PageText), `${id}: the page is v1's own text`);
    assert.ok(result.pages[0].includes("provides the in- formation of the committee ternal audit report"), id);
    assert.ok(!result.pages[0].includes("the information of the committee"), id);
  }
});

test("real pdf.js tables, tight and unusual gutters: 1.2 em gutters, three and five columns, a centred last column, a narrow wrapped first column — all refused by 12b alone", () => {
  for (const [id, fragments, widestGapEm, sharedGutter] of [
    ["T8", "in+formation", 1.19, true], // 1.2 em gutter, the first cell's second line is short
    ["T9", "in+formation", 1.19, true], // 1.2 em gutter on both lines
    ["T10", "in+formation", 10.39, true], // three columns
    ["T11", "in+formation", 13.28, false], // centred last column: nothing repeats, the gutter is simply wide
    ["T12", "pre+vention", 2.07, true], // narrow first column with a wrapped label
    ["T14", "in+formation", 1.2, true], // five columns, 1.2 em gutters
  ]) {
    const { fixture, result } = tableCase(id);
    const site = onlySite(result);
    assert.equal(fixture.joiningIsWrong, true, id);
    assert.equal(`${site.leftFragment}+${site.rightFragment}`, fragments, id);
    assert.deepEqual(site.failed, ["12b-no-column-gutter"], id);
    assert.ok(site.measurements.joinedInline >= 1, `${id}: the joined word is written inline`);
    assert.equal(site.measurements.widestGapEm, widestGapEm, id);
    assert.equal(site.measurements.sharedGutter, sharedGutter, id);
    assert.equal(result.lineBreakJoins, 0, id);
    assert.deepEqual(result.pages, fixture.pages.map(v1PageText), id);
  }
});

test("ACCEPTED RESIDUAL — T13, NOT a passing structural protection case: a table row with a 0.4 em gutter is still joined across its cells", () => {
  // Rule B3 still joins this synthetic narrow-gutter cross-cell case.
  //   - The gutter is 0.4 em.
  //   - pdf.js getTextContent geometry cannot reliably distinguish it from
  //     ordinary word spacing: pdf.js folds an advance under 0.6 em into the
  //     text of ONE item, as a plain space. The row reaches the rule as a
  //     single run with no gap between items at all (widestGapEm = 0) — the
  //     same shape as a line of prose.
  //   - This is accepted for pdf-text-extraction-v2 (owner decision,
  //     2026-10-02): no operator-list parsing, no table reconstruction.
  //   - It must not be counted as a passing structural protection case. The
  //     join below is WRONG; this test pins it so that it stays visible, and
  //     so that a change in behaviour here — either way — is noticed.
  const { fixture, result } = tableCase("T13");
  assert.equal(fixture.joiningIsWrong, true);
  assert.equal(fixture.outcome, "ACCEPTED-RESIDUAL-wrong-join");
  assert.match(fixture.acceptedResidual, /still joins/);
  assert.match(fixture.acceptedResidual, /0\.4 em/);
  assert.match(fixture.acceptedResidual, /cannot be reliably distinguished from ordinary word spacing/);
  assert.match(fixture.acceptedResidual, /Accepted for pdf-text-extraction-v2/);
  assert.match(fixture.acceptedResidual, /must not be counted as a passing structural protection case/);

  const site = onlySite(result);
  assert.equal(`${site.leftFragment}+${site.rightFragment}`, "in+formation");
  assert.deepEqual(site.failed, [], "no predicate refuses — 12b included");
  assert.equal(site.join, true);
  assert.equal(result.lineBreakJoins, 1);
  assert.equal(site.measurements.widestGapEm, 0, "pdf.js reports the row as one run: there is no gap for 12b to measure");
  assert.equal(site.measurements.gutterGaps, 0);
  assert.equal(site.measurements.sharedGutter, false);
  // the wrong text, as emitted: the last cell of one printed line fused with the first cell of the next
  const v1 = v1PageText(fixture.pages[0]);
  assert.equal(v1.split("in- formation").length, 2, "v1 kept the two cells apart, once");
  assert.equal(result.pages[0], v1.replace("in- formation", "information"), "v2 differs from v1 by exactly this one wrong join");
});

test("real pdf.js, joining is RIGHT and 12b stays out of the way: a wrap inside one cell, a justified paragraph, a loose word-per-item paragraph", () => {
  for (const [id, gutterGaps] of [
    ["T15", 0], // only the last column has text on the two lines: a same-cell wrap
    ["C1", 8], // justified paragraph: eight word gaps of 0.6 em or more, none 2 em wide — more than five, so no shared test
    ["C2", 6], // loose narrow paragraph, one item per word, gaps of 1 em
  ]) {
    const { fixture, result } = tableCase(id);
    const site = onlySite(result);
    assert.equal(fixture.joiningIsWrong, false, id);
    assert.equal(`${site.leftFragment}+${site.rightFragment}`, "in+formation", id);
    assert.deepEqual(site.failed, [], id);
    assert.equal(site.measurements.gutterGaps, gutterGaps, id);
    assert.ok(site.measurements.widestGapEm < 2, id);
    assert.equal(site.measurements.sharedGutter, false, id);
    assert.equal(result.lineBreakJoins, 1, id);
  }
});

test("real pdf.js, list items and a numbered heading: the gap after the label is not what refuses them (predicate 12 does, as before)", () => {
  for (const id of ["C3", "C4", "C5"]) {
    const { fixture, result } = tableCase(id);
    const site = onlySite(result);
    assert.deepEqual(site.failed, ["12-right-edge-would-not-fit"], id);
    assert.equal(site.measurements.sharedGutter, false, id);
    assert.ok(site.measurements.widestGapEm >= 1 && site.measurements.widestGapEm < 2, id);
    assert.equal(result.lineBreakJoins, 0, id);
    assert.deepEqual(result.pages, fixture.pages.map(v1PageText), id);
  }
});

// =============================================================================
// Predicate 1 — same page
// =============================================================================

test("page boundary: a word broken across two pages is never joined, even with the joined word inline", () => {
  const first = column([used("constitutional"), { str: "the applicant had lodged, within the time limit, a constitu-", width: WIDTH }]);
  const second = column(["tional complaint against the judgment of the court of", "appeal of the capital."]);
  const result = repair([first, second]);
  const site = onlySite(result);
  assert.equal(site.kind, "page-boundary");
  assert.deepEqual(site.failed, ["1-same-page", "9-next-line-below-at-body-pitch", "12-right-edge-would-not-fit"]);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, [first, second].map(v1PageText));
  assert.ok(result.pages[0].endsWith("a constitu-"));
  assert.ok(result.pages[1].startsWith("tional complaint"));
});

// =============================================================================
// Predicate 11 — font-size ratio
// =============================================================================

test("font-size ratio: the next line may be 0.70 to 1.45 times the size of the broken line, both bounds included", () => {
  assertJoined([column([used("example"), BREAK, { str: NEXT, em: 7 }, LAST])], "exam+ple");
  assertRefused([column([used("example"), BREAK, { str: NEXT, em: 6.9 }, LAST])], ["11-font-size-ratio"]);
  assertJoined([column([used("example"), BREAK, { str: NEXT, em: 14.5 }, LAST])], "exam+ple");
  assertRefused([column([used("example"), BREAK, { str: NEXT, em: 14.6 }, LAST])], ["11-font-size-ratio"]);
});

test("font-size ratio: sizes are rounded to 0.1 before they are compared (6.96 counts as 7.0, 6.94 as 6.9)", () => {
  assertJoined([column([used("example"), BREAK, { str: NEXT, em: 6.96 }, LAST])], "exam+ple");
  assertRefused([column([used("example"), BREAK, { str: NEXT, em: 6.94 }, LAST])], ["11-font-size-ratio"]);
});

// =============================================================================
// Predicate 12 — the line reaches the right edge of its block
// =============================================================================

test("short line: a hyphen at the end of a line that stops well before the right edge of its block is not a line break", () => {
  assertRefused([column([used("example"), { str: BREAK, short: true }, NEXT, LAST])], ["12-right-edge-would-not-fit"]);
});

test("right edge: the next fragment must not have fitted on the broken line (room under 0.50 em is joined, 0.50 em is not)", () => {
  // block right edge = 372; the next line is 50 characters over 300pt (6pt per
  // character), so "ple" needs 18pt; room = (372 - (x1 - 3.3 + 18)) / 10 em
  const next = "ple before the session was closed for the day by X";
  assert.equal(next.length, 50);
  assertJoined([column([used("example"), { str: BREAK, width: 280.4 }, next, LAST])], "exam+ple"); // room 0.49 em
  assertRefused([column([used("example"), { str: BREAK, width: 280.3 }, next, LAST])], ["12-right-edge-would-not-fit"]); // room 0.50 em
});

test("right edge: a block needs at least one other printed line; a first line indented by more than 3 em has none of its own", () => {
  assertJoined([column([used("example"), { str: BREAK, x: LEFT + 30 }, NEXT, LAST])], "exam+ple");
  assertRefused([column([used("example"), { str: BREAK, x: LEFT + 30.1 }, NEXT, LAST])], ["12-right-edge-would-not-fit"]);
});

// =============================================================================
// Emission
// =============================================================================

test("a document with no join is v1's text, byte for byte — including items without geometry and white-space-only runs", async () => {
  const pages = [
    [{ str: "First" }, { str: "page" }, { type: "marker" }],
    [item("A heading", { y: 760, em: 14 }), item(" ", { x: 200, y: 760, width: 3 }), item("", { x: 203, y: 760, width: 0 }), ...column(["A paragraph without any hyphen at a line end follows the", "heading and ends here."])],
    [],
  ];
  const result = repair(pages);
  assert.equal(result.sites.length, 0);
  assert.deepEqual(result.pages, pages.map(v1PageText));
  assert.equal(result.pages[0], "First page ");
  const document = { numPages: 3, async getPage(n) { return { async getTextContent() { return { items: pages[n - 1] }; } }; } };
  assert.equal(await extractPdfTextDocument(document), `${pages.map(v1PageText).join("\n\n")}\n\n`);
});

test("a join is applied only between adjacent segments: with a geometry-less segment between the two lines the text is left alone", () => {
  const lines = column([used("example"), BREAK, NEXT, LAST]);
  const pages = [[lines[0], lines[1], { str: "[figure]", hasEOL: true }, lines[2], lines[3]]];
  const result = repair(pages);
  const site = onlySite(result);
  assert.equal(site.join, true, "the two lines are consecutive for the rule, which never sees the geometry-less segment");
  assert.equal(result.skippedNonAdjacentJoins, 1);
  assert.equal(result.lineBreakJoins, 0);
  assert.deepEqual(result.pages, pages.map(v1PageText));
});

test("only the joined pair changes on a page: every other separator, including white space the PDF itself carries, is kept", () => {
  const lines = column([used("example"), BREAK, NEXT, "the  presiding   judge."]);
  const pages = [[lines[0], item("", { x: 372, y: 700, width: 0 }), lines[1], item(" ", { x: 372, y: 688, width: 3 }), lines[2], lines[3]]];
  const result = repair(pages);
  assert.equal(result.lineBreakJoins, 1);
  const v1 = v1PageText(pages[0]);
  const removed = /exam-(\s+)ple/u.exec(v1);
  assert.ok(removed, "v1 keeps the hyphen and the break");
  assert.equal(result.pages[0], v1.replace(removed[0], "example"));
  assert.ok(result.pages[0].endsWith("the  presiding   judge."));
});

test("consecutive joins: a line joined to the line above and to the line below is trimmed at both ends, and white space inside either segment goes with the break", () => {
  const MIDDLE = "ple and then asked for one more illustrative exam-";
  const expected = `${used("example")} the committee then asked for one further example and then asked for one more illustrative example before the session was closed for the day by ${LAST}`;

  const plain = repair([column([used("example"), BREAK, MIDDLE, NEXT, LAST])]);
  assert.equal(plain.lineBreakJoins, 2);
  assert.equal(plain.pages[0], expected);

  // The same page with white space where a join has to cut: after the hyphen
  // inside the upper segment, a white-space-only run between the two segments,
  // and at the start of the lower segment. All of it belongs to the break.
  const y = (line) => TOP - line * PITCH;
  const spaced = [[
    item(used("example"), { y: y(0), width: WIDTH }),
    item(BREAK, { y: y(1), width: WIDTH, eol: false }), item("  ", { x: LEFT + WIDTH, y: y(1), width: 5 }),
    item(" ", { x: LEFT, y: y(2), width: 3 }),
    item(" ", { x: LEFT - 3, y: y(2), width: 3, eol: false }), item(MIDDLE, { y: y(2), width: WIDTH }),
    item(NEXT, { y: y(3), width: WIDTH }),
    item(LAST, { y: y(4) }),
  ]];
  // v1: two characters after the hyphen, a run of its own, one before "ple", and the three separators between them
  assert.equal(/exam-( +)ple and then/u.exec(v1PageText(spaced[0]))?.[1].length, 6, "v1 carries the white space of all three places");
  const result = repair(spaced);
  assert.equal(result.lineBreakJoins, 2);
  assert.equal(result.pages[0], expected);
});

test("applying joins does not rescan the page: the string work per character of page text stays flat from 1,000 to 16,000 joins on one page", () => {
  // Counted, not timed: the characters handed to String.prototype.trimEnd and
  // String.prototype.slice while the repair runs. Trimming the page built so
  // far once per join makes that count grow with joins x page length — about
  // one character per join for every character of the page. Trimming each
  // segment on its own keeps it at a few characters per character of the page.
  const repairCountingStringWork = (pages) => {
    const { trimEnd, slice } = String.prototype;
    let characters = 0;
    String.prototype.trimEnd = function () { characters += this.length; return trimEnd.call(this); };
    String.prototype.slice = function (...args) { characters += this.length; return slice.apply(this, args); };
    try {
      const result = inspectPdfLineBreakRepair(pages);
      return { result, characters };
    } finally {
      String.prototype.trimEnd = trimEnd;
      String.prototype.slice = slice;
    }
  };
  const line = (str, index, count) => item(str, { y: 20 + PITCH * (count - index), width: WIDTH });
  const CHAINED = "ple and the committee then asked for one further exam-";
  const UPPER = "the committee then asked for one further exam-";
  const LOWER = "ple before the session was closed for the day by";
  const shapes = {
    // every line ends "exam-" and starts "ple": each joined line is itself joined to the next
    chain: (joins) => ({
      pages: [[line(used("example"), 0, joins + 2), ...Array.from({ length: joins + 1 }, (_, k) => line(CHAINED, k + 1, joins + 2))]],
      text: `${used("example")} ${CHAINED.slice(0, -1).repeat(joins)}${CHAINED}`,
    }),
    // a broken line, then a line that ends on a full word: no join touches the next
    pairs: (joins) => ({
      pages: [[line(used("example"), 0, 2 * joins + 1), ...Array.from({ length: joins }, (_, k) => [line(UPPER, 2 * k + 1, 2 * joins + 1), line(LOWER, 2 * k + 2, 2 * joins + 1)]).flat()]],
      text: `${used("example")}${` ${UPPER.slice(0, -1)}${LOWER}`.repeat(joins)}`,
    }),
  };

  for (const [name, build] of Object.entries(shapes)) {
    const work = new Map();
    for (const joins of [1000, 2000, 4000, 8000, 16000]) {
      const { pages, text } = build(joins);
      const { result, characters } = repairCountingStringWork(pages);
      assert.equal(result.lineBreakJoins, joins, `${name} ${joins}`);
      assert.equal(result.pages[0] === text, true, `${name} ${joins}: the page text is the lines with every break closed`);
      const perPageCharacter = characters / text.length;
      assert.ok(perPageCharacter < 16, `${name} ${joins}: ${perPageCharacter.toFixed(1)} characters of string work per character of page text`);
      work.set(joins, characters);
    }
    const growth = work.get(16000) / work.get(1000);
    assert.ok(growth < 17, `${name}: 16 times the joins cost ${growth.toFixed(1)} times the string work`);
  }

  // and at the smallest size the frozen reference, which trims the whole page per join, emits the same text
  for (const build of Object.values(shapes)) repair(build(1000).pages);
});
