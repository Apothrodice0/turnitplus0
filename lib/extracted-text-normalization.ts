/**
 * "Investigate two real detection issues" ISSUE 1: the shared post-
 * extraction cleanup step every uploaded document's text passes through in
 * app/page.tsx's generateReport(), before archive analysis, AI analysis,
 * academic search, or word/character counts ever see it. Previously an
 * inline `.replace()` chain in generateReport() itself.
 *
 * Pulled out into its own module for two reasons: it is now unit-testable
 * directly against the real PDF/DOCX fixtures (tests/pdf-docx-extraction-
 * parity.test.mjs), and a second, more severe bug was found living in it
 * while investigating the reference-list parity issue — see
 * HTML_TAG_PATTERN's own comment below.
 */

/**
 * The original inline regex here was `/<[^>]*>/g` — intended to strip real
 * HTML markup for a `.html` upload (extractFileText() returns raw file
 * source for txt/md/html/csv, tags included), but applied unconditionally
 * to every upload. `[^>]*` is unbounded: given a single stray `<` with no
 * real closing tag nearby, it greedily consumes everything up to the NEXT
 * `>` anywhere later in the document. Confirmed against a real PDF (arXiv
 * 1706.03762, "Attention Is All You Need") extracted via lib/pdf-text-
 * extraction.ts: a single `<` from a math inequality ("... n < ...")
 * matched almost 20,000 characters forward to the next `>`, silently
 * deleting the Introduction, the Model Architecture section, and the
 * "References" heading itself — which is also why the ISSUE 1 investigation
 * initially found comparisonText()/eligibleAiText() failing even after
 * lib/reference-section.ts's fix: the heading had already been erased
 * before either function ever ran.
 *
 * This pattern instead requires the content between `<`/`</` and `>` to
 * actually look like a tag: starting with a letter (never a space, digit,
 * or math symbol — the exact thing that let "n <" start a false match),
 * then a short alphanumeric tag name, then at most ~150 characters of
 * attribute-shaped content. A real `.html` upload's tags still match this
 * easily; a stray inequality/angle-bracket in prose or an equation no
 * longer can, because nothing about it looks like `<tagname ...>`.
 */
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]{0,150})?\/?>/g;

/** Every uploaded document's text passes through this exact chain before any downstream analysis sees it — see this file's own header comment. */
export function normalizeExtractedText(raw: string): string {
  return raw
    .replace(HTML_TAG_PATTERN, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
