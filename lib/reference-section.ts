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

const HEADING_PATTERN = /\b(references|bibliography|works\s+cited)\b/gi;

/** How far past a candidate heading to look for corroborating reference-list-shaped content. Generous enough to skip a short "References" subtitle/byline before the first entry, small enough that unrelated later text can't accidentally corroborate an early false match. */
const LOOKAHEAD_WINDOW = 700;

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
