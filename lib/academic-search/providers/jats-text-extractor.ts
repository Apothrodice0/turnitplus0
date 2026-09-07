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
 * Scope: the article's own authored text —
 *   - <abstract> and <trans-abstract> (a translated abstract; still the
 *     authors' own words, just in another language),
 *   - <body> running prose,
 *   - the human-readable parts of floating <table-wrap> / <fig> elements —
 *     their <label>, <caption> (title + prose) and, for tables,
 *     <table-wrap-foot> (footnotes / abbreviation legends) — wherever they
 *     sit (inside <body> or a sibling <floats-group>).
 *
 * Everything else is deliberately excluded and stays excluded: JATS keeps
 * the bibliography, appendices and back matter in a sibling <back> element,
 * and author affiliations / contributions / funding / licence / the
 * "Citation:" line in <front>, so restricting extraction to the elements
 * above already drops the reference list and the front-matter metadata
 * noise without any per-string filtering. Raw <table> cell matrices,
 * formulas, graphics and <xref> citation markers are removed; peer-review
 * <sub-article> / <response> blocks are stripped up front so their own
 * <body>/<abstract> can never be mistaken for the article's (an aggregate
 * document that is *only* a container of sub-articles — e.g. a conference
 * proceedings volume — therefore yields "", which is the honest answer: it
 * has no article text of its own).
 *
 * Verified against real Europe PMC fullTextXML responses: a ~240KB PLOS
 * Digital Health article during Phase 5 (the tag-frequency counts that
 * shaped the strip list: 45 inline-formula, 12 fig, 6 table-wrap, 104 xref,
 * 47 mml:math), plus PLOS Medicine and BMJ articles during the
 * missing-passage audit (the table-wrap / fig / sub-article / trans-abstract
 * handling).
 */

export const JATS_TEXT_EXTRACTOR_VERSION = "jats-text-extractor-v2";

// Peer-review / commentary companions to the main article. They are always
// article-level siblings (never nested in <body>) and carry their own
// <front>/<body>/<abstract>; removed before section extraction so a
// first-match <body>/<abstract> can never pick them up and so their prose is
// never duplicated alongside the article's own.
const SUB_ARTICLE_ELEMENT = /<(sub-article|response)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

// Floating <table-wrap> / <fig>: not stripped wholesale like the elements
// below — their <label> / <caption> / <table-wrap-foot> is human-readable
// prose a student can copy, so it is salvaged (see salvageFloatText). The
// raw <table> cell grid, <graphic> and formulas inside them are discarded.
const FLOAT_PAIRED_ELEMENTS = "table-wrap|fig";
const FLOAT_ELEMENT_PAIR = new RegExp(`<(${FLOAT_PAIRED_ELEMENTS})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, "gi");
// A second, distinct object for use *inside* the salvage callback — a
// global regex cannot be re-entered while String.replace is mid-iteration
// over it.
const NESTED_FLOAT_ELEMENT_PAIR = new RegExp(`<(${FLOAT_PAIRED_ELEMENTS})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, "gi");
const FLOAT_LABEL = /<label(?:\s[^>]*)?>([\s\S]*?)<\/label>/gi;
const FLOAT_CAPTION = /<caption(?:\s[^>]*)?>([\s\S]*?)<\/caption>/gi;
const FLOAT_FOOT = /<table-wrap-foot(?:\s[^>]*)?>([\s\S]*?)<\/table-wrap-foot>/gi;

// Elements whose entire subtree is non-prose with nothing human-readable to
// keep. <table> is here (a bare data grid — its cell matrix is not article
// prose; a table's caption/footnotes live on the enclosing <table-wrap> and
// are salvaged above). <table-wrap> / <fig> are NOT here anymore.
const NON_PROSE_PAIRED_ELEMENTS = "table|disp-formula|inline-formula|graphic|media|supplementary-material|fn-group|mml:math|math|tex-math|label";
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
 * Remove <sub-article> / <response> subtrees. Non-greedy first-close match,
 * looped so nested review companions (a <sub-article> inside a
 * <sub-article>) are fully removed — each pass strips the innermost pair,
 * the next pass the now-closeable outer one. Terminates because every pass
 * that changes anything strictly shortens the string. Any dangling closing
 * tag left by an unbalanced document is swept up by the final tag strip.
 */
function stripSubArticles(xml: string): string {
  let out = xml;
  let previous: string;
  do {
    previous = out;
    out = out.replace(SUB_ARTICLE_ELEMENT, " ");
  } while (out !== previous);
  return out;
}

/** Tags -> spaces, whitespace collapsed. Used only on already-isolated float sub-strings. */
function flattenToText(fragment: string): string {
  return fragment
    .replace(NESTED_FLOAT_ELEMENT_PAIR, " ")
    .replace(NON_PROSE_ELEMENT_PAIR, " ")
    .replace(NON_PROSE_ELEMENT_SELF_CLOSING, " ")
    .replace(XREF_PAIR, " ")
    .replace(XREF_SELF_CLOSING, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A <table-wrap> / <fig> element -> its human-readable text only: the
 * <label> ("Table 5", "Fig 2"), the <caption> (title + prose) and, for
 * tables, the <table-wrap-foot> (footnotes, abbreviation legends). The raw
 * <table> cell grid, <graphic>, formulas and nested floats are dropped —
 * flattening a cell matrix into running text produces noise, not article
 * prose, and no current consumer asks for it. Returns the pieces as
 * newline-separated blocks (each its own paragraph downstream), or a single
 * space when the float carries nothing readable (a bare image, no caption).
 */
function salvageFloatText(floatXml: string): string {
  const blocks: string[] = [];
  for (const re of [FLOAT_LABEL, FLOAT_CAPTION, FLOAT_FOOT]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(floatXml)) !== null) {
      const readable = flattenToText(match[1]);
      if (readable) blocks.push(readable);
    }
    re.lastIndex = 0;
  }
  return blocks.length > 0 ? `\n${blocks.join("\n")}\n` : " ";
}

/**
 * Number of whole words a block must reach before a verbatim repeat of it is
 * dropped. Deliberately well above the downstream matcher's own
 * `minimumPassageLengthWords` (lib/document-correspondence.ts, currently 8):
 * a block this long always survives as its own >=floor matched passage at
 * its FIRST occurrence, so removing a later copy can never take a
 * matcher-reportable passage away from a submission that copied through that
 * later copy — it can only lose a handful of sub-floor "straddle" shingles
 * unique to the second surrounding context, which the matcher discards by
 * design. The margin above 8 also absorbs informativeGram()'s common-word
 * filtering. Below this length a repeat is KEPT: a short recurring line
 * (a heading, a 5-word note) is cheap to keep and removing it could shift
 * what sits adjacent to what in the flattened token stream.
 * See tests/academic-search-jats-text-extractor.test.mjs — "deduplication
 * cannot destroy a match when the same block appears in two contexts".
 */
const MIN_DEDUP_BLOCK_WORDS = 12;

/**
 * Drop repeated blocks (a whole line, >= MIN_DEDUP_BLOCK_WORDS words, seen
 * verbatim before, case-insensitively; first occurrence kept). Publisher XML
 * sometimes carries a float both inline and again in a trailing
 * <floats-group>, and a shared footnote / abbreviation legend can repeat
 * under several tables; one copy is all the matcher needs. Short lines are
 * left untouched — see MIN_DEDUP_BLOCK_WORDS.
 */
function deduplicateBlocks(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.split(/\s+/).filter(Boolean).length >= MIN_DEDUP_BLOCK_WORDS) {
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
 * contain a match, independent of any comparator/threshold behavior.
 *
 * Missing-passage audit follow-on: also collect <trans-abstract> (a
 * translated abstract — still the authors' own words) and a trailing
 * <floats-group> (some publishers park every <table-wrap>/<fig> there
 * instead of inline, which puts their captions structurally out of reach).
 * Sections are concatenated in natural reading order (abstract, translated
 * abstract, body, floats); a record with only some of them behaves exactly
 * as before.
 */
function extractSourceSections(xml: string): string | null {
  const abstract = extractSection(xml, "abstract");
  const transAbstracts = [...xml.matchAll(/<trans-abstract(?:\s[^>]*)?>([\s\S]*?)<\/trans-abstract>/gi)].map((m) => m[1]);
  const body = extractSection(xml, "body");
  const floatsGroup = extractSection(xml, "floats-group");
  const parts = [abstract, ...transAbstracts, body, floatsGroup].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Converts a JATS fullTextXML document into clean prose text — see
 * extractSourceSections for exactly which elements are in scope. Returns ""
 * for input with none of them — never throws on malformed/unexpected XML,
 * matching this subsystem's "text unavailability is a normal outcome" rule
 * (types.ts/text-retriever.ts).
 */
export function extractTextFromJatsXml(xml: string): string {
  const source = extractSourceSections(stripSubArticles(xml));
  if (!source) return "";

  let text = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(FLOAT_ELEMENT_PAIR, (whole) => salvageFloatText(whole))
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

  text = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return deduplicateBlocks(text);
}
