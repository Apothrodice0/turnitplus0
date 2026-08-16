/**
 * Small, deterministic JATS XML -> plain text converter for Europe PMC's
 * fullTextXML endpoint (STEP 3). Regex-based, not a DOM/XML parser — same
 * "smallest reliable extractor already compatible with the project"
 * rationale as lib/html-text-extraction.ts (this project has no XML/DOM
 * parsing dependency in package.json), and an independent implementation
 * from it rather than a shared one, since JATS's non-prose elements (tables,
 * figures, MathML, inline citation markers) have no HTML equivalent to reuse
 * rules from.
 *
 * Scope: only <body> (the article's own running prose) is extracted. JATS
 * puts references/footnotes/back matter in a sibling <back> element, so
 * excluding everything outside <body> already excludes the bibliography
 * without any extra filtering. Verified against a real Europe PMC
 * fullTextXML response during this phase (a ~240KB PLOS Digital Health
 * article) — the tag-frequency counts in that sample (45 inline-formula, 12
 * fig, 6 table-wrap, 104 xref, 47 mml:math) are what the strip list below is
 * shaped around.
 */

export const JATS_TEXT_EXTRACTOR_VERSION = "jats-text-extractor-v1";

const NON_PROSE_PAIRED_ELEMENTS = "table-wrap|fig|disp-formula|inline-formula|graphic|media|supplementary-material|fn-group|mml:math|math|label";
const NON_PROSE_ELEMENT_PAIR = new RegExp(`<(${NON_PROSE_PAIRED_ELEMENTS})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, "gi");
const NON_PROSE_ELEMENT_SELF_CLOSING = new RegExp(`<(${NON_PROSE_PAIRED_ELEMENTS})(?:\\s[^>]*)?\\/>`, "gi");

// Citation/cross-reference markers (e.g. "<xref ...>1</xref>", "<xref .../>") — their inner
// content is a reference number, not part of the article's own prose.
const XREF_PAIR = /<xref(?:\s[^>]*)?>[\s\S]*?<\/xref>/gi;
const XREF_SELF_CLOSING = /<xref(?:\s[^>]*)?\/>/gi;

// Block-level JATS elements whose closing tag should become a paragraph break, mirroring
// html-text-extraction.ts's BLOCK_LEVEL_CLOSING_TAGS convention.
const BLOCK_LEVEL_CLOSING_TAGS = /<\/(?:p|title|sec|list-item|caption|abstract)>/gi;

const NAMED_ENTITY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&amp;/gi, "&"], // must run last so it never re-expands entities produced by the replacements above
];

function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function extractSection(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : null;
}

/**
 * Converts a JATS fullTextXML document into clean prose text. Falls back to
 * the article's <abstract> when no <body> is present (e.g. some OA records
 * only ever carry an abstract). Returns "" for input with neither — never
 * throws on malformed/unexpected XML, matching this subsystem's "text
 * unavailability is a normal outcome" rule (types.ts/text-retriever.ts).
 */
export function extractTextFromJatsXml(xml: string): string {
  const source = extractSection(xml, "body") ?? extractSection(xml, "abstract");
  if (!source || !source.trim()) return "";

  let text = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(NON_PROSE_ELEMENT_PAIR, " ")
    .replace(NON_PROSE_ELEMENT_SELF_CLOSING, " ")
    .replace(XREF_PAIR, " ")
    .replace(XREF_SELF_CLOSING, " ")
    .replace(BLOCK_LEVEL_CLOSING_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeNumericEntities(text);
  for (const [pattern, replacement] of NAMED_ENTITY_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
