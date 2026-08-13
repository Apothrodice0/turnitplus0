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
