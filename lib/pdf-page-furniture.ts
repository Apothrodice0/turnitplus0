/**
 * "Investigate two production issues" ISSUE 2: strips a repeated running
 * header/footer (journal name, author byline, page number — the kind of
 * page furniture a print/PDF layout repeats on every page) from raw
 * extracted text before it ever reaches word counts, phrase extraction, or
 * comparison. Measured, real contribution to the confirmed PDF/DOCX
 * word-count gap: 425 of 1,482 words (29%) on a real 19-page article, from
 * a header repeating on 17 of its 19 pages (see this investigation's own
 * report).
 *
 * ROOT CAUSE: lib/pdf-text-extraction.ts's extractPdfTextDocument() joins
 * every text item on a page with a single space and marks PAGE boundaries
 * with "\n\n" — a real page header sits at the very START of its own page
 * chunk with no separator from the body text that follows it (the same
 * structural gap that made lib/reference-section.ts necessary for
 * reference-heading detection). DOCX text (via mammoth) has no equivalent
 * artifact at all — Word stores running headers/footers in separate
 * word/header*.xml / word/footer*.xml parts that mammoth never reads (see
 * lib/docx-text-extraction.ts's own header comment) — so this is a
 * PDF-specific correction, run universally here (any text without this
 * repeated-boundary pattern simply produces no match and is returned
 * unchanged) rather than forked into a second, format-specific pipeline.
 *
 * ALGORITHM: a real header/footer differs page to page only in its page
 * number, so this cannot be exact-substring matching. Instead: mask every
 * digit run to "#", then find the LONGEST leading (or trailing) run of
 * words, masked, shared verbatim by at least MIN_REPEAT_COUNT of the
 * text's own "\n\n"-delimited chunks. Growing the shared prefix/suffix one
 * word at a time (rather than guessing a fixed character window up front)
 * is what lets this correctly stop exactly where the real header ends and
 * page-specific body content begins, even though that boundary sits at a
 * different character offset on every page (the header's own page number
 * has a different digit count). Once the shared template is known, it is
 * rebuilt as a literal regex (digit runs re-opened as \d+) and matched
 * per-chunk, so each page's own real page number is stripped along with
 * the rest of that page's own header/footer instance.
 *
 * FALSE-POSITIVE GUARDS (do not remove legitimate, coincidentally-repeated
 * body text): requires at least MIN_REPEAT_COUNT chunks to share the
 * pattern AND that count to be at least MIN_REPEAT_FRACTION of all chunks,
 * AND the shared span to reach MIN_FURNITURE_WORDS real words — a real
 * running header clears all three by a wide margin (measured: 17/19 pages,
 * 89%, ~10-14 words before the page number); an ordinary document where a
 * few paragraphs coincidentally open the same way falls well short of the
 * fraction threshold, and a short repeated transition phrase falls short
 * of the word-count floor.
 */

const PAGE_BOUNDARY = "\n\n";
const MAX_CANDIDATE_WORDS = 40;
const MIN_REPEAT_COUNT = 3;
const MIN_REPEAT_FRACTION = 0.3;
const MIN_FURNITURE_WORDS = 5;

function maskDigits(word: string): string {
  return word.replace(/\d+/g, "#");
}

/** Splits a chunk into its first N whitespace-delimited words, preserving the exact original substrings (needed to rebuild an exact-length regex template later). */
function leadingWords(chunk: string, maxWords: number): string[] {
  const words: string[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while (words.length < maxWords && (match = pattern.exec(chunk))) {
    words.push(match[0]);
  }
  return words;
}

function trailingWords(chunk: string, maxWords: number): string[] {
  return leadingWords([...chunk].reverse().join(""), maxWords).map((word) => [...word].reverse().join("")).reverse();
}

/**
 * Finds the longest word-count k (up to MAX_CANDIDATE_WORDS) for which a
 * digit-masked k-word span, read from the given side of each chunk, is
 * shared verbatim by a large-enough cohort of chunks — returns that
 * cohort's own literal template words (from one real chunk, not masked)
 * plus which chunk indices belong to it, or null if no k clears every
 * threshold.
 */
function findRepeatedBoundarySpan(
  chunks: string[],
  side: "leading" | "trailing",
): { templateWords: string[]; memberIndices: Set<number> } | null {
  // Both arrays hold up to MAX_CANDIDATE_WORDS words in real left-to-right
  // order, closest to the boundary last. "Growing k" therefore means
  // slice(0, k) for a leading window (extend forward from the start) but
  // slice(length - k) for a trailing window (extend backward from the
  // end) — using slice(0, k) for trailing here would silently take words
  // from the WRONG end (the chunk's own start, not its end) once a chunk
  // has fewer than MAX_CANDIDATE_WORDS words, which is the common case.
  const wordsPerChunk = chunks.map((chunk) => (side === "leading" ? leadingWords(chunk, MAX_CANDIDATE_WORDS) : trailingWords(chunk, MAX_CANDIDATE_WORDS)));
  const windowAtK = (words: string[], k: number) => (side === "leading" ? words.slice(0, k) : words.slice(Math.max(0, words.length - k)));

  let best: { templateWords: string[]; memberIndices: Set<number> } | null = null;
  for (let k = 1; k <= MAX_CANDIDATE_WORDS; k += 1) {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < wordsPerChunk.length; i += 1) {
      const words = wordsPerChunk[i];
      if (words.length < k) continue;
      const key = windowAtK(words, k).map(maskDigits).join(" ");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    }

    let bestGroupIndices: number[] | null = null;
    for (const indices of groups.values()) {
      if (!bestGroupIndices || indices.length > bestGroupIndices.length) bestGroupIndices = indices;
    }
    if (!bestGroupIndices) break; // no chunk even has k words left on this side — nothing longer to find

    const meetsCount = bestGroupIndices.length >= MIN_REPEAT_COUNT;
    const meetsFraction = bestGroupIndices.length / chunks.length >= MIN_REPEAT_FRACTION;
    if (!meetsCount || !meetsFraction) {
      // Once the best group at this length can no longer clear the bar, a
      // longer, stricter span never will either (growing k only shrinks or
      // preserves group sizes) — safe to stop growing.
      break;
    }

    const templateWords = windowAtK(wordsPerChunk[bestGroupIndices[0]], k);
    best = { templateWords, memberIndices: new Set(bestGroupIndices) };
  }

  if (!best) return null;
  const wordCount = best.templateWords.filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (wordCount < MIN_FURNITURE_WORDS) return null;
  return best;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTemplatePattern(templateWords: string[]): RegExp {
  const escaped = templateWords.map((word) => escapeRegExp(word).replace(/\\?\d+/g, "\\d+"));
  return new RegExp(`^\\s*${escaped.join("\\s+")}`);
}

function buildTrailingTemplatePattern(templateWords: string[]): RegExp {
  const escaped = templateWords.map((word) => escapeRegExp(word).replace(/\\?\d+/g, "\\d+"));
  return new RegExp(`${escaped.join("\\s+")}\\s*$`);
}

/**
 * Strips a repeated running header and/or footer from raw extracted text.
 * Never throws; text with fewer than MIN_REPEAT_COUNT "\n\n"-delimited
 * chunks (too little evidence to detect a real repeated pattern) is
 * returned unchanged.
 */
export function stripRepeatedPageFurniture(text: string): string {
  const chunks = text.split(PAGE_BOUNDARY);
  if (chunks.length < MIN_REPEAT_COUNT) return text;

  const header = findRepeatedBoundarySpan(chunks, "leading");
  let working = chunks;
  if (header) {
    const pattern = buildTemplatePattern(header.templateWords);
    working = working.map((chunk, i) => (header.memberIndices.has(i) ? chunk.replace(pattern, "") : chunk));
  }

  const footer = findRepeatedBoundarySpan(working, "trailing");
  if (footer) {
    const pattern = buildTrailingTemplatePattern(footer.templateWords);
    working = working.map((chunk, i) => (footer.memberIndices.has(i) ? chunk.replace(pattern, "") : chunk));
  }

  return working.join(PAGE_BOUNDARY);
}
