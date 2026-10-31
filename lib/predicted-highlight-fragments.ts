import type { PredictedHighlightRange } from "./report-types";

/**
 * What is left of a predicted passage once verified matches have taken part of it. A passage no match touches is drawn
 * exactly as the model returned it and never comes through here. A piece beside a match is drawn only when it still
 * reads as a passage: it starts and ends on whole words, and it keeps the four words the model's own rule asks of a span.
 * Whitespace, a stray "to" or the tail of a word the match cut in two are not drawn. Offsets stay those of the report
 * text, the stored prediction is untouched, and the model's threshold and span rule are not involved.
 */
const MIN_FRAGMENT_WORDS = 4;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const WORD_JOINER = /['’\-‐]/u;
const WHITESPACE = /\s/u;

const inWord = (text: string, index: number) => index >= 0 && index < text.length && (WORD_CHARACTER.test(text[index]) || WORD_JOINER.test(text[index]));

export function usablePredictedFragment(text: string, start: number, end: number): PredictedHighlightRange | null {
  let from = start;
  let to = end;
  if (inWord(text, start - 1)) while (from < to && !WHITESPACE.test(text[from])) from += 1;
  while (from < to && !WORD_CHARACTER.test(text[from])) from += 1;
  if (inWord(text, end)) while (to > from && !WHITESPACE.test(text[to - 1])) to -= 1;
  while (to > from && !WORD_CHARACTER.test(text[to - 1])) to -= 1;
  const words = text.slice(from, to).match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return words >= MIN_FRAGMENT_WORDS ? { start: from, end: to } : null;
}
