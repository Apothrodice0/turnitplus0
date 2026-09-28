import { tokens } from "./similarity-core";

/**
 * Explicit canonical-token -> raw-token position mapping for the
 * prior-submission channel.
 *
 * lib/report-historical-match.ts runs the prior-submission matcher on
 * canonicalizeText(raw) (lib/canonical-text.ts), so the passages it gets back
 * are indices into tokens(canonicalText). Every unified-similarity position,
 * though — wordCount, archiveMatchedPositions, the union itself — is an index
 * into tokens(rawText). The two token streams are NOT index-compatible:
 * canonicalizeText deletes the invisible formatting marks (U+200B/C/D,
 * U+FEFF), while lib/similarity-core.ts's normalize() turns those same marks
 * into word boundaries. One in-word mark therefore splits ONE canonical token
 * into TWO raw tokens, and reading a canonical index as a raw index credits a
 * raw word that was never verified against the source.
 *
 * Every other canonicalizeText step (NFC, line endings, horizontal-whitespace
 * and blank-line collapsing, trimming) leaves tokens() unchanged, so the
 * canonical token stream is the raw token stream with zero-width-joined
 * fragments merged — up to a possibly different reference-section suffix,
 * since tokens() runs stripReferenceSection on each text separately.
 *
 * This module aligns the two streams by content instead of assuming that
 * shape: a canonical token maps to the run of consecutive raw tokens whose
 * concatenation spells exactly that token. Alignment is a single forward walk
 * that never resynchronises — the first canonical token that cannot be
 * spelled (the streams diverged, e.g. a reference-section cut landed
 * differently) and every token after it stay unmapped, so they can never earn
 * raw credit. Fail closed: an unmapped position contributes nothing.
 */

/** Inclusive tokens(rawText) index range one canonical token was spelled from. */
export type RawTokenRun = { rawStart: number; rawEnd: number };

/**
 * One entry per tokens(canonicalText) index: the raw run it came from, or
 * null when it could not be aligned. Consecutive mapped entries always cover
 * consecutive raw runs (entry i+1 starts at entry i's rawEnd + 1), which is
 * what lets projectCanonicalSpanToRaw emit one contiguous raw range without
 * ever filling a gap.
 */
export function mapCanonicalTokensToRawTokens(rawText: string, canonicalText: string): Array<RawTokenRun | null> {
  const rawTokens = tokens(rawText);
  const canonicalTokens = tokens(canonicalText);
  const mapping: Array<RawTokenRun | null> = new Array(canonicalTokens.length).fill(null);
  let raw = 0;
  for (let index = 0; index < canonicalTokens.length && raw < rawTokens.length; index += 1) {
    const word = canonicalTokens[index];
    let end = raw;
    let spelled = rawTokens[raw];
    while (spelled.length < word.length && end + 1 < rawTokens.length && word.startsWith(spelled)) {
      end += 1;
      spelled += rawTokens[end];
    }
    if (spelled !== word) break;
    mapping[index] = { rawStart: raw, rawEnd: end };
    raw = end + 1;
  }
  return mapping;
}

/**
 * Projects an inclusive canonical token span onto the raw token range spelled
 * by exactly those canonical tokens. Stops at the first unmapped canonical
 * token (keeping only the verified mapped prefix) and returns null when even
 * the first token is unmapped — it never widens a range past what the mapped
 * tokens themselves cover.
 */
export function projectCanonicalSpanToRaw(mapping: ReadonlyArray<RawTokenRun | null>, start: number, end: number): RawTokenRun | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  const first = mapping[start];
  if (!first) return null;
  let last = first;
  for (let index = start + 1; index <= end; index += 1) {
    const next = mapping[index];
    if (!next || next.rawStart !== last.rawEnd + 1) break;
    last = next;
  }
  return { rawStart: first.rawStart, rawEnd: last.rawEnd };
}

/**
 * Re-expresses canonical-space passages in raw token space. submittedWordStart/
 * submittedWordEnd become the raw run and matchedWordCount that run's length
 * (the same end - start + 1 definition lib/document-correspondence.ts uses); a
 * passage with no mapped tokens is dropped. Every other field is passed
 * through unchanged.
 */
export function projectCanonicalPassagesToRaw<P extends { submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>(
  passages: ReadonlyArray<P>,
  mapping: ReadonlyArray<RawTokenRun | null>,
): P[] {
  const projected: P[] = [];
  for (const passage of passages) {
    const run = projectCanonicalSpanToRaw(mapping, passage.submittedWordStart, passage.submittedWordEnd);
    if (!run) continue;
    projected.push({ ...passage, submittedWordStart: run.rawStart, submittedWordEnd: run.rawEnd, matchedWordCount: run.rawEnd - run.rawStart + 1 });
  }
  return projected;
}
