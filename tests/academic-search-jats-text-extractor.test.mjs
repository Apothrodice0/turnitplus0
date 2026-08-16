import assert from "node:assert/strict";
import test from "node:test";
import { extractTextFromJatsXml } from "../lib/academic-search/providers/jats-text-extractor.ts";

test("extracts paragraph text from <body>, joined with newlines between block elements", () => {
  const xml = `<article><body><sec><title>1 Introduction</title><p>First paragraph.</p><p>Second paragraph.</p></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "1 Introduction\nFirst paragraph.\nSecond paragraph.");
});

test("strips tables, figures, and formulas entirely (content included), not just their tags", () => {
  const xml = `<article><body><p>Before.</p><table-wrap><table><tr><td>1.23</td></tr></table></table-wrap><p>After.</p><disp-formula><mml:math><mml:mi>x</mml:mi></mml:math></disp-formula></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "Before.\nAfter.");
  assert.ok(!text.includes("1.23"));
  assert.ok(!text.includes("x"));
});

test("strips <xref> citation markers along with their inner reference number", () => {
  const xml = `<article><body><p>A claim<xref rid="r1" ref-type="bibr">1</xref> follows here.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "A claim follows here.");
});

test("decodes standard XML entities", () => {
  const xml = `<article><body><p>Fish &amp; chips &lt;are&gt; tasty &quot;food&quot;.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, `Fish & chips <are> tasty "food".`);
});

test("decodes numeric character references (decimal and hex)", () => {
  const xml = `<article><body><p>en&#8211;dash and hex&#x2014;dash.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "en–dash and hex—dash.");
});

test("excludes <back> (references/footnotes) entirely — it is a sibling of <body>, never nested inside it", () => {
  const xml = `<article><body><p>Real article prose.</p></body><back><ref-list><ref>Some Citation, 2020.</ref></ref-list></back></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "Real article prose.");
});

test("falls back to <abstract> when there is no <body>", () => {
  const xml = `<article><front><article-meta><abstract><p>Abstract-only record text.</p></abstract></article-meta></front></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.equal(text, "Abstract-only record text.");
});

// --- Phase 5 fix: <abstract> and <body> are both extracted when both are present ---

test("Phase 5: when BOTH <abstract> and <body> are present, both are extracted and concatenated, abstract first — not just <body> as before", () => {
  const xml = `<article>
    <front><article-meta><abstract><p>This is the paper's own abstract summary text.</p></abstract></article-meta></front>
    <body><sec><title>Introduction</title><p>This is the paper's separate introduction prose.</p></sec></body>
  </article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("abstract summary text"), "abstract prose must be present");
  assert.ok(text.includes("introduction prose"), "body prose must still be present too");
  assert.ok(text.indexOf("abstract summary") < text.indexOf("introduction prose"), "abstract must come first, matching natural reading order");
});

test("Phase 5 regression: a submission verbatim-matching ONLY the abstract (not the body) now has real overlapping text to compare against", () => {
  const xml = `<article>
    <front><article-meta><abstract><p>Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages.</p></abstract></article-meta></front>
    <body><sec><p>A completely different, unrelated paragraph about the study's broader background and unrelated context, sharing no wording with the abstract at all here.</p></sec></body>
  </article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("Distinctive biochemical pathway analysis reveals unexpected metabolic divergence"), "the old body-only extractor would have silently dropped this exact-match passage");
});

// --- Phase 5 fix: invisible Unicode formatting characters no longer split words ---

test("Phase 5: a zero-width non-joiner (U+200C) embedded mid-word by the publisher's own numeric character reference is stripped, not treated as a word boundary", () => {
  const xml = `<article><body><p>Pain assessme&#x200c;&#x200c;nt remains challenging.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("assessment"), "the word must be reassembled, not split into 'assessme' + 'nt'");
  assert.ok(!text.includes("assessme "), "no stray space should remain where the invisible characters were");
});

test("Phase 5: other invisible-format characters (ZWSP, ZWJ, word joiner, BOM, soft hyphen) are also stripped", () => {
  const xml = `<article><body><p>al&#x200b;go&#x200d;rithm and trans&#x2060;former and pre&#xfeff;fix and soft&#xad;hyphen.</p></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.includes("algorithm"));
  assert.ok(text.includes("transformer"));
  assert.ok(text.includes("prefix"));
  assert.ok(text.includes("softhyphen"));
});

test("returns an empty string, never throws, for XML with neither body nor abstract", () => {
  const xml = `<article><front><article-meta><title-group><article-title>Just a title</article-title></title-group></article-meta></front></article>`;
  assert.equal(extractTextFromJatsXml(xml), "");
});

test("returns an empty string, never throws, for malformed/empty input", () => {
  assert.equal(extractTextFromJatsXml(""), "");
  assert.equal(extractTextFromJatsXml("not xml at all"), "");
  assert.equal(extractTextFromJatsXml("<body>unclosed"), "");
});

test("is deterministic: identical input always produces identical output", () => {
  const xml = `<article><body><sec><title>T</title><p>Some <italic>emphasized</italic> prose with <xref rid="r1">2</xref> a citation.</p></sec></body></article>`;
  const first = extractTextFromJatsXml(xml);
  const second = extractTextFromJatsXml(xml);
  assert.equal(first, second);
  assert.equal(first, "T\nSome emphasized prose with a citation.");
});

test("real-world sample: a captured Europe PMC fullTextXML fragment extracts to clean, table/formula-free prose", () => {
  const xml = `<article><body><sec sec-type="intro" id="sec001"><title>1 Introduction</title><p>Pain assessme‌‌nt <xref rid="pdig.0001424.ref001" ref-type="bibr">1</xref> in non-verbal patients&#8212;neonates, individuals with cognitive impairment, and sedated patients&#8212;represents one of clinical medicine’s most critical unmet needs.</p></sec></body></article>`;
  const text = extractTextFromJatsXml(xml);
  assert.ok(text.startsWith("1 Introduction\nPain assessme"));
  assert.ok(!text.includes("<xref"));
  assert.ok(!text.includes("ref-type"));
});
