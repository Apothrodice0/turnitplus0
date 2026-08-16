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
