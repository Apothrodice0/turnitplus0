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

/**
 * Phase 5 finding: real publisher JATS XML (confirmed live against a PLOS
 * Digital Health article's own fullTextXML) can carry invisible Unicode
 * formatting characters — zero-width non-joiner, zero-width joiner, etc. —
 * literally inside a word, typically as a numeric character reference
 * (`&#x200c;`) surviving from the publisher's own typesetting pipeline
 * (soft-hyphenation/ligature control), not from any tag this extractor
 * strips. lib/similarity-core.ts's normalize() treats any character outside
 * \p{L}\p{N}\s as a word boundary — these invisible marks are Unicode
 * category Cf ("Format"), not \p{L}, so one sitting inside "assessment"
 * silently splits it into "assessme" + "nt", corrupting every shingle that
 * crosses the break. Stripped here (removed entirely, not replaced with a
 * space — unlike a real word boundary, these characters carry no separation
 * meaning) so lib/similarity-core.ts's own tokenization — which this file
 * has no authority to change (used by report scoring, archive matching, and
 * every E8S/E8P consumer) — sees the word as the publisher actually wrote
 * it. Explicit, fixed list rather than a broad Unicode-category strip,
 * matching lib/retrieval-safety.ts's own "small, auditable, easy to test
 * exhaustively" convention.
 */
// U+200B ZERO WIDTH SPACE, U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH
// JOINER, U+2060 WORD JOINER, U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM),
// U+00AD SOFT HYPHEN — the confirmed-live case was two consecutive U+200C
// inside "assessment"; the rest are the same class of invisible
// typesetting-control character and equally corrupting if encountered.
const INVISIBLE_FORMAT_CHARACTERS = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g;

function stripInvisibleFormatCharacters(text: string): string {
  return text.replace(INVISIBLE_FORMAT_CHARACTERS, "");
}

function extractSection(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : null;
}

/**
 * Phase 5 finding: the original version of this function extracted <body>
 * only, falling back to <abstract> exclusively when <body> was absent —
 * confirmed live (Europe PMC fullTextXML for a real PLOS Digital Health
 * article) that this silently drops the abstract's own prose whenever a
 * body exists, which is nearly always. A real submission verbatim-copying a
 * paper's ABSTRACT — plausibly the single most commonly copied section of
 * any paper, being its most accessible, self-contained summary — was
 * therefore being compared against text that structurally could never
 * contain a match, independent of any comparator/threshold behavior. Both
 * sections are now extracted and concatenated (abstract first, matching
 * natural reading order) whenever present; a record with only one of the
 * two behaves exactly as before.
 */
function extractSourceSections(xml: string): string | null {
  const abstract = extractSection(xml, "abstract");
  const body = extractSection(xml, "body");
  const parts = [abstract, body].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Converts a JATS fullTextXML document into clean prose text — <abstract>
 * and <body>, concatenated when both are present (see extractSourceSections
 * above), whichever exist when only one is. Returns "" for input with
 * neither — never throws on malformed/unexpected XML, matching this
 * subsystem's "text unavailability is a normal outcome" rule
 * (types.ts/text-retriever.ts).
 */
export function extractTextFromJatsXml(xml: string): string {
  const source = extractSourceSections(xml);
  if (!source) return "";

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
  text = stripInvisibleFormatCharacters(text);

  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
