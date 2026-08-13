/**
 * Deterministic, content-preserving text canonicalization for document
 * identity hashing (see lib/document-identity.ts). This is intentionally NOT
 * the same transform as similarity-core.ts's normalize()/tokens(): that
 * transform is lossy on purpose (case, punctuation, diacritics all stripped)
 * because it feeds shingling for similarity matching. Canonicalization here
 * exists only to make two byte-different extractions of the *same* document
 * agree on one hash — it must never fold two different documents together,
 * so case, punctuation, word order, and word content are left untouched.
 *
 * Normalizes only:
 *  - line endings (CRLF/CR -> LF)
 *  - invisible/zero-width formatting marks (BOM, zero-width space/joiners)
 *  - Unicode representation (NFC), so visually/semantically identical
 *    characters encoded differently hash the same
 *  - runs of horizontal whitespace (spaces/tabs/non-breaking spaces),
 *    collapsed to a single space, including leading/trailing space per line
 *  - runs of 3+ blank lines, collapsed to a single blank line
 *  - leading/trailing whitespace of the document as a whole
 */

// Zero-width space, zero-width non-joiner, zero-width joiner, BOM / zero-width no-break space.
// Built from a code-point array (not a regex literal containing the raw characters) so the
// source file never has to embed genuinely invisible bytes.
const INVISIBLE_FORMATTING_MARKS = new RegExp(
  [0x200b, 0x200c, 0x200d, 0xfeff].map((codePoint) => String.fromCharCode(codePoint)).join("|"),
  "g",
);
const HORIZONTAL_WHITESPACE_RUN = /[^\S\n]+/g;
const MULTIPLE_BLANK_LINES = /\n{3,}/g;
const LINE_ENDINGS = /\r\n|\r/g;

export function canonicalizeText(value: string): string {
  const withoutInvisibles = value
    .normalize("NFC")
    .replace(LINE_ENDINGS, "\n")
    .replace(INVISIBLE_FORMATTING_MARKS, "");

  const withCollapsedLines = withoutInvisibles
    .split("\n")
    .map((line) => line.replace(HORIZONTAL_WHITESPACE_RUN, " ").trim())
    .join("\n");

  return withCollapsedLines.replace(MULTIPLE_BLANK_LINES, "\n\n").trim();
}
