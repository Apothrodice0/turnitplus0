/**
 * "Investigate two real detection issues" ISSUE 1: the one shared, format-
 * agnostic implementation of "where does this document's reference list
 * start" — used by lib/similarity-core.ts's comparisonText() (archive
 * matching / wordCount) and lib/ai-core.ts's eligibleAiText()/buildAiChunks()
 * (AI-writing analysis), which previously each carried their own slightly
 * different newline-anchored regex.
 *
 * ROOT CAUSE (confirmed empirically against a real downloaded PDF and a
 * real-content DOCX of the same article, arXiv:1706.03762): both prior
 * regexes required the heading to be isolated on its own line
 * (`\n...references...\n`). lib/pdf-text-extraction.ts's
 * extractPdfTextDocument() joins every text item on a page with a single
 * space and only inserts `\n\n` between PAGES (never within one), so a
 * "References" heading almost never lands on a clean newline boundary in
 * PDF-extracted text — the reference list silently stayed in scope for
 * every downstream consumer. mammoth's DOCX extraction preserves real
 * paragraph breaks, so the exact same regex reliably matched there. This
 * was a genuine parity bug, not something PDF/DOCX handling ever did
 * differently on purpose.
 *
 * FIX: rather than loosening the newline requirement (which would also
 * start matching ordinary prose — "as the references above indicate" must
 * never be treated as a section boundary), this looks for the heading
 * keyword AND requires the text immediately following it to look like the
 * actual start of a reference list — a numbered/bracketed marker, or a
 * cluster of publication years together with citation-shaped vocabulary.
 * That signal is present whether or not the source format preserved line
 * breaks, so PDF and DOCX now get the same answer from the same evidence.
 * In-text citations mid-body ("[13]", "(Smith, 2020)") never trigger this on
 * their own — they are isolated, not immediately followed by a run of
 * further citation-shaped content, which is exactly what distinguishes a
 * real reference list from an inline citation or a stray prose mention.
 */

/**
 * MULTILINGUAL HEADING SUPPORT: the heading terms this detector recognizes.
 * Deliberately narrow — one heading vocabulary per supported language, not a
 * synonym dictionary. Multi-word headings use `\s+` between their words
 * (matching the existing "works\s+cited" convention) so the WHOLE phrase is
 * consumed as one match, letting looksLikeReferenceListStart's immediate-
 * marker checks apply right after the full heading, exactly as they already
 * do for "works cited".
 *
 *   English (unchanged): references | bibliography | works cited
 *   French:  références | bibliographie | références bibliographiques
 *            ("references", unaccented, is already covered by the English
 *            term above and doubles as valid French usage)
 *   Arabic:  المراجع (references/sources) | قائمة المراجع (list of
 *            references) | المصادر والمراجع (the sources and references)
 */
const HEADING_TERMS = [
  "references",
  "bibliography",
  "works\\s+cited",
  "références\\s+bibliographiques",
  "références",
  "bibliographie",
  "المراجع",
  "قائمة\\s+المراجع",
  "المصادر\\s+والمراجع",
].join("|");

/**
 * UNICODE-SAFE BOUNDARIES: JavaScript's \b is defined purely in terms of \w
 * ([A-Za-z0-9_]), which does not include Arabic letters OR Latin letters
 * with diacritics (é, à, ç, …) even with the /u flag — \w itself never
 * changes meaning under /u. Two concrete failures this caused when naively
 * tried: (1) \bالمراجع\b never matches at all when surrounded by whitespace,
 * because neither an Arabic letter nor a space is ever \w, so there is no
 * \w/non-\w transition for \b to fire on; (2) \bréférences\b matches in
 * spurious, unstable places inside ordinary French words — "é" is itself
 * "non-word" under \w's ASCII-only definition, so e.g. "préférences"
 * ("preferences", an unrelated word) contains internal \w/non-\w
 * transitions around each "é" that could let a naive \b-based pattern fire
 * where it should not.
 *
 * The fix used here — negative lookbehind/lookahead requiring the character
 * immediately outside the match to NOT be a Unicode letter or number
 * (\p{L}\p{N}) — reuses the exact \p{L}/\p{N} convention lib/similarity-
 * core.ts's own normalize()/tokenSpans() already rely on elsewhere in this
 * codebase, rather than introducing a second boundary mechanism. It
 * correctly rejects "références" inside "préférences" (the preceding "p" is
 * \p{L}) and correctly matches "المراجع" surrounded by plain whitespace
 * (space is neither \p{L} nor \p{N}).
 */
const HEADING_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${HEADING_TERMS})(?![\\p{L}\\p{N}])`, "giu");

/** How far past a candidate heading to look for corroborating reference-list-shaped content. Generous enough to skip a short "References" subtitle/byline before the first entry, small enough that unrelated later text can't accidentally corroborate an early false match. */
const LOOKAHEAD_WINDOW = 700;

/**
 * TERMINAL-POSITION GUARD: a genuine reference/bibliography section is
 * structurally the document's last major section. Book-scale text can
 * contain an incidental heading-word occurrence (e.g. a prose mention of
 * "references" followed by an unrelated footnote pair that happens to carry
 * two adjacent years) far from the true end, which the year-clustering
 * corroboration signal alone cannot distinguish from a real reference list.
 * Audited against a 273-page book where such an incidental match at 22.4%
 * through discarded 77.6% of substantive content, versus every confirmed
 * genuine terminal reference section observed sitting at 55% or later.
 * Candidates before this fraction of the document are rejected outright,
 * without ever being corroborated — cheaper and simpler than adding
 * position as a fourth corroboration signal, and strictly more conservative
 * than the prior behavior (it only rejects candidates the old heuristic
 * would have accepted, never the reverse). Character-offset fraction, matching
 * this function's existing character-index representation throughout.
 */
const TERMINAL_FRACTION_THRESHOLD = 0.5;

/** How far past a candidate heading to look for a citation-pointer phrase. Deliberately much smaller than LOOKAHEAD_WINDOW: this check stays cheap and cannot accidentally match a pointer phrase appearing later inside a genuine citation entry's own text. */
const POINTER_LOOKAHEAD_WINDOW = 30;

/**
 * CITATION-POINTER REJECTION: three closed, evidence-backed lexical forms
 * ("see", "of the", "will be found") found to immediately follow a
 * heading-term match in real false-positive cases — an in-prose sentence
 * that happens to contain the word "references" but is pointing the reader
 * elsewhere ("references see S. M. Author...", "references of the Madrid
 * Peace Conference...", "references will be found in my article...") rather
 * than opening an actual reference list. Evaluated only against the text
 * immediately following an already-matched heading term, exactly like
 * looksLikeReferenceListStart's own checks. English-only by construction —
 * no French/Arabic equivalents were found in the audited evidence.
 */
const CITATION_POINTER_PATTERNS = [/^see\b/i, /^of\s+the\b/i, /^will\s+be\s+found\b/i];

function isCitationPointer(lookahead: string): boolean {
  const trimmed = lookahead.trimStart();
  return CITATION_POINTER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function looksLikeReferenceListStart(lookahead: string): boolean {
  const trimmed = lookahead.trimStart();
  // Strong signal alone: the very next thing is a numbered/bracketed list
  // marker — "[1]", "1.", "(1)" — exactly how this project's own real test
  // fixture (arXiv:1706.03762) and the vast majority of numbered-citation
  // papers open their reference list.
  if (/^[[(]?\d{1,3}[\])]?[.\s]/.test(trimmed)) return true;

  // "Investigate two production issues" ISSUE 2: a second strong signal —
  // a single-letter CATEGORY marker ("A. Books", "B) Theses", "C: Journal
  // Articles"), the same structural role as a numbered marker (the very
  // next thing after the heading is a list marker, not prose) but grouping
  // the bibliography by source type instead of numbering every entry.
  // Confirmed live: a real reference section (categorized A-E, non-
  // parenthetical "Author, Title, Publisher; Year." citation style) was
  // found to slip past both the numbered-marker check above and the
  // weaker year-based checks below, leaving ~1,650 words of bibliography +
  // footnote text in scope for word counts/similarity/AI analysis in a
  // real production report. Same bounded risk profile as the existing
  // numbered-marker check: only evaluated against the text immediately
  // following an already-matched "references/bibliography/works cited"
  // heading, never scanned for on its own.
  if (/^[A-Z][.):]\s/.test(trimmed)) return true;

  // Weaker signals, required together: author-year reference lists don't
  // open with a number, but a real reference list is unmistakably dense
  // with publication years and citation vocabulary within a few entries —
  // ordinary prose essentially never produces both close together.
  const yearMatches = lookahead.match(/\b(19|20)\d{2}[a-z]?\b/g) ?? [];
  if (yearMatches.length < 2) return false;
  const hasCitationVocabulary = /\b(arxiv preprint|corr,?\s*abs|proceedings of|doi:|et al\.|vol\.|pp\.)\b/i.test(lookahead);
  const hasParentheticalYear = /\(\d{4}[a-z]?\)/.test(lookahead);
  // "Investigate two production issues" ISSUE 2: a third weak signal — a
  // year immediately delimited by a semicolon or comma on one side and a
  // period/comma on the other ("...Dar Al-Houda, Algeria; 2014."), the
  // real citation style found alongside the lettered-category headings
  // above. A common bibliographic convention outside strict APA-style
  // parenthetical years, distinct from an ordinary in-prose year mention
  // (which is rarely delimited this tightly on both sides).
  const hasDelimitedYear = /[;,]\s*(19|20)\d{2}[a-z]?\s*[.,]/.test(lookahead);
  return hasCitationVocabulary || hasParentheticalYear || hasDelimitedYear;
}

/**
 * Returns the character index where a genuine reference/bibliography
 * section begins, or -1 if none is found — the same contract as
 * String.prototype.search(), so existing `text.search(REGEX)` call sites
 * swap in this function directly. Scans candidate heading occurrences from
 * the END of the document backward (a real reference section is
 * structurally the document's last major section), returning the first
 * one whose immediately-following text looks like an actual reference
 * list rather than an incidental mention of the word.
 */
export function findReferenceSectionStart(text: string): number {
  const candidates = [...text.matchAll(HEADING_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate.start / text.length < TERMINAL_FRACTION_THRESHOLD) continue;
    if (isCitationPointer(text.slice(candidate.end, candidate.end + POINTER_LOOKAHEAD_WINDOW))) continue;
    const lookahead = text.slice(candidate.end, candidate.end + LOOKAHEAD_WINDOW);
    if (looksLikeReferenceListStart(lookahead)) {
      // Report the start of the heading word itself, not the text after it —
      // matches the existing callers' expectation (they slice up to, and
      // exclude, the heading).
      return candidate.start;
    }
  }
  return -1;
}

/** The document's body text only — everything before a detected reference section, or the whole text unchanged when none is found. */
export function stripReferenceSection(text: string): string {
  const start = findReferenceSectionStart(text);
  return start >= 0 ? text.slice(0, start) : text;
}

/**
 * GOLD GAP — footnotes/endnotes placed after the bibliography by extraction.
 *
 * lib/docx-text-extraction.ts converts a DOCX through mammoth.convertToHtml,
 * whose writeNotes() appends every footnote and endnote AFTER the body, as
 * `<li id="footnote-N"><p>…</p><p>… <a href="#footnote-ref-N">↑</a></p></li>`,
 * and marks each reference in the body as `<sup><a …>[N]</a></sup>`.
 * lib/html-text-extraction.ts turns that into plain text in which:
 *   - the body carries the anchors "[1]", "[2]", …;
 *   - every note ends with the back-link "↑";
 *   - consecutive notes are separated by a blank line (`</p></li>`), while the
 *     paragraphs inside one note, and the last body paragraph before the first
 *     note, are separated by a single line break.
 * So a paper whose body ends with "Bibliography:" has all its notes AFTER the
 * bibliography, and findReferenceSectionStart's cut discarded every one of
 * them (confirmed on the Gold case: 32 footnotes, ~880 words).
 *
 * This reads that extraction structure — never prose — and returns where the
 * trailing note block begins, or -1:
 *   - the text must end with a note back-link;
 *   - walking back over blank-line-separated blocks, every block of the run
 *     must end with a back-link (a block that does not ends the run, so the
 *     notes before it stay wherever they are today);
 *   - the earliest block of the run can also hold the body/bibliography lines
 *     just before the first note (one line break apart), so only its LAST
 *     line is taken as the first note's start (a multi-paragraph first note
 *     keeps only its last paragraph — conservative);
 *   - the text before the block must carry the first note's anchor "[1]".
 * Repeated running headers are never part of this block: DOCX extraction never
 * reads header/footer parts, and PDF page furniture is stripped earlier
 * (lib/pdf-page-furniture.ts).
 */
const NOTE_BACKLINK = "↑";
const BLANK_LINE = /\n[^\S\n]*\n/g;

export function findAppendedNotesStart(text: string): number {
  const end = text.trimEnd().length;
  if (end === 0 || text[end - 1] !== NOTE_BACKLINK) return -1;
  // [start, end) of every blank-line-separated block, in document order.
  const blocks: Array<{ start: number; end: number }> = [];
  let blockStart = 0;
  for (const separator of text.slice(0, end).matchAll(BLANK_LINE)) {
    blocks.push({ start: blockStart, end: separator.index });
    blockStart = separator.index + separator[0].length;
  }
  blocks.push({ start: blockStart, end });
  let earliest = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (!text.slice(blocks[index].start, blocks[index].end).trimEnd().endsWith(NOTE_BACKLINK)) break;
    earliest = index;
  }
  if (earliest < 0) return -1;
  const first = blocks[earliest];
  const lastLineBreak = text.lastIndexOf("\n", text.slice(first.start, first.end).trimEnd().length + first.start - 1);
  const notesStart = lastLineBreak >= first.start ? lastLineBreak + 1 : first.start;
  return text.slice(0, notesStart).includes("[1]") ? notesStart : -1;
}

/**
 * The similarity-analysis view of `text`: BODY and legitimate FOOTNOTE/ENDNOTE
 * text stay, the BIBLIOGRAPHY/REFERENCES list does not.
 *
 * The bibliography is found exactly as before (findReferenceSectionStart, on
 * the whole text). When a trailing note block (findAppendedNotesStart) starts
 * AFTER it, the bibliography between the two is replaced by the same number of
 * spaces instead of the notes being cut with it. Otherwise this is
 * stripReferenceSection(text), unchanged.
 *
 * Same-length blanking keeps every character offset an offset into `text`
 * (tokenSpans' contract), and the word sequence is the previous one with the
 * note words appended: every word index computed before this change still
 * names the same word.
 */
export function stripReferenceSectionKeepingNotes(text: string): string {
  const referenceStart = findReferenceSectionStart(text);
  if (referenceStart < 0) return text;
  const notesStart = findAppendedNotesStart(text);
  if (notesStart <= referenceStart) return text.slice(0, referenceStart);
  return text.slice(0, referenceStart) + " ".repeat(notesStart - referenceStart) + text.slice(notesStart);
}
