import { extractTextFromHtml } from "./html-text-extraction";

/**
 * "Investigate two production issues" ISSUE 2: the one shared DOCX
 * text-extraction path — used by both app/page.tsx's real upload flow and
 * every test that needs the same real-world text a DOCX upload actually
 * produces.
 *
 * ROOT CAUSE (confirmed by reading mammoth's own source, not guessed):
 * mammoth.extractRawText() walks only Document.children (the main body) —
 * lib/raw-text.js's convertElementToRawText() recurses through
 * element.children alone, and Document.notes (populated separately from
 * word/footnotes.xml and word/endnotes.xml by docx-reader.js) is never
 * part of that tree. Confirmed live against a real Turnitin-processed
 * DOCX with 39 numbered footnotes: extractRawText()'s own output ends at
 * the bare heading "Citations:" with nothing after it — the entire
 * footnote block (1,046 of the real PDF/DOCX word-count gap's 1,482
 * words, see this investigation's own report) is silently absent, while
 * the same document's PDF rendering prints every footnote as real,
 * visible page content that pdfjs faithfully captures.
 *
 * FIX: mammoth.convertToHtml() DOES resolve Document.notes — document-to-
 * html.js's own writeNotes() appends every footnote/endnote as an <ol>
 * list at the end of the HTML output (confirmed by reading that file).
 * Converting THAT HTML back to plain text, reusing this project's existing
 * lib/html-text-extraction.ts (the same extractor every other HTML source
 * in this codebase already goes through) rather than inventing a second
 * "walk mammoth's document model by hand" implementation, gives exactly
 * the missing footnote/endnote content — in document order, body first
 * then notes — with zero new parsing code of our own.
 *
 * Deliberately does NOT attempt to recover DOCX headers/footers: mammoth's
 * docx-reader.ts only maps "comments", "endnotes", "footnotes",
 * "numbering", and "styles" as document parts related to the main body
 * (confirmed by reading findPartRelatedToMainDocument's own call sites) —
 * word/header*.xml and word/footer*.xml are never read by ANY mammoth API,
 * convertToHtml included. This is exactly the desired outcome anyway: a
 * repeated running header/footer is decorative page furniture, never
 * substantive text (see lib/pdf-page-furniture.ts, which exists to strip
 * the PDF-side equivalent for the same reason) — so DOCX extraction
 * already omits it "for free," with no extra code needed here.
 */

/**
 * Generic over the input shape rather than a fixed `{buffer}|{arrayBuffer}`
 * union: mammoth's Node build only accepts `{buffer: Buffer}` and its
 * browser build only accepts `{arrayBuffer: ArrayBuffer}` (confirmed by
 * each build's own type declarations — see types/assets.d.ts for the
 * browser one) — neither function accepts the OTHER shape, so a caller
 * passing either real `convertToHtml` could never satisfy a parameter
 * typed to require both. Letting TypeScript infer the input type from
 * whichever real `convertToHtml` is actually passed at each call site
 * keeps both real callers (app/page.tsx's browser build, every test's
 * Node build) exactly type-safe without a false union.
 */
export async function extractDocxTextDocument<Input>(
  convertToHtml: (input: Input) => Promise<{ value: string }>,
  input: Input,
): Promise<string> {
  const { value: html } = await convertToHtml(input);
  return extractTextFromHtml(html);
}
