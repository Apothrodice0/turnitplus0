/**
 * Phase E6C: the smallest reliable server-side HTML-to-text extractor.
 * Deliberately regex-based rather than a full DOM/HTML parser — this
 * project has no HTML-parsing dependency today (jsdom/cheerio/etc. are not
 * in package.json), and adding one is more than "the smallest reliable
 * server-side extraction approach already compatible with the project"
 * calls for. Never invents text: every character in the output either came
 * from the input HTML's text content or is whitespace inserted to keep
 * words from different elements from running together.
 *
 * Bump HTML_EXTRACTOR_VERSION whenever the extraction rules change
 * materially — lib/retrieval-repository.ts stores it on every retrieval
 * record specifically so a later reader can tell whether two extractions
 * of the same page are comparable.
 */

export const HTML_EXTRACTOR_VERSION = "html-text-extraction-v1";

const BLOCK_LEVEL_CLOSING_TAGS = /<\/(?:p|div|li|h[1-6]|tr|table|section|article|blockquote)>/gi;

const ENTITY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&amp;/gi, "&"], // must run last so it never re-expands entities produced by the replacements above
];

export function extractTextFromHtml(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(?:nav|header|footer|aside)[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_LEVEL_CLOSING_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");

  for (const [pattern, replacement] of ENTITY_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return text
    .replace(/[^\S\n]+/g, " ") // collapse runs of horizontal whitespace, but keep newlines as paragraph breaks
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * "Investigate two production issues" ISSUE 1: extracts the
 * `citation_pdf_url` meta tag, if present — the de facto Highwire
 * Press/Google Scholar convention (`<meta name="citation_pdf_url"
 * content="...">`) used by most scholarly repositories and journal
 * platforms (arXiv, institutional repositories, and — confirmed live —
 * episciences.org) to point an HTML landing page at the actual full-text
 * PDF. Real, confirmed root cause this exists to address: an academic
 * search candidate's own URL is frequently a landing page whose own body
 * text is just an abstract plus navigation chrome (confirmed live: ~289
 * words total, only ~55 of them the real abstract) — nowhere near the
 * genuine article. Regex-based like extractTextFromHtml above, for the
 * same reason (no HTML-parsing dependency in this project); attribute
 * order is not assumed (`name` before `content` is the overwhelmingly
 * common real-world order, confirmed live, but the second alternative
 * handles the reverse order defensively). Returns null when absent or
 * malformed — never guessed from the page's other content.
 */
export function extractCitationPdfUrl(html: string): string | null {
  const nameFirst = html.match(/<meta[^>]*\bname\s*=\s*["']citation_pdf_url["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/i);
  const contentFirst = nameFirst ? null : html.match(/<meta[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']citation_pdf_url["'][^>]*>/i);
  const url = (nameFirst ?? contentFirst)?.[1]?.trim();
  return url || null;
}
