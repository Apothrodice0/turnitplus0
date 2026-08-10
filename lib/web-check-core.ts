import {
  COMMON_WORDS,
  comparisonText,
  grams,
  informativeGram,
  normalize,
  tokens,
} from "./similarity-core";

export type SelectedWebPhrase = {
  text: string;
  normalized: string;
  rarity: number;
  wordStart: number;
  wordEnd: number;
};

export type WebCheckSource = {
  title: string;
  url: string;
  pageId: number;
};

export type WebPhraseOutcome = "matched" | "no-match" | "throttled" | "timed-out" | "failed";

export type WebPhraseMatch = {
  phrase: string;
  normalizedPhrase: string;
  wordStart?: number;
  wordEnd?: number;
  matched: boolean;
  outcome?: WebPhraseOutcome;
  sources: WebCheckSource[];
  excludedSelfSources?: WebCheckSource[];
  error?: string;
};

export type WebCheckResult = {
  status: "complete" | "partial" | "error" | "insufficient";
  provider: "Wikipedia";
  phrasesSampled: number;
  phrasesMatched: number;
  matches: WebPhraseMatch[];
  checkedAt: string;
  errorCount: number;
  referenceSectionRemoved?: boolean;
  selfMatchesExcluded?: number;
  phrasesWithSelfMatchesExcluded?: number;
  outcomes?: Record<WebPhraseOutcome, number>;
};

type RawWord = {
  normalized: string;
  start: number;
  end: number;
};

function rawWords(value: string): RawWord[] {
  const body = comparisonText(value);
  const matches = body.matchAll(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu);
  const result: RawWord[] = [];
  for (const match of matches) {
    const start = match.index ?? 0;
    const normalizedParts = normalize(match[0]).split(" ").filter(Boolean);
    for (const normalizedPart of normalizedParts) {
      result.push({ normalized: normalizedPart, start, end: start + match[0].length });
    }
  }
  return result;
}

function rarityScore(phrase: string) {
  return phrase.split(" ").reduce((score, word) => {
    if (COMMON_WORDS.has(word)) return score;
    if (word.length >= 10) return score + 3;
    if (word.length >= 7) return score + 2;
    if (word.length >= 4) return score + 1;
    return score;
  }, 0);
}

export function selectPhrases(
  cleanText: string,
  rawText = cleanText,
  count = 20,
  phraseSize = 9,
): SelectedWebPhrase[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Phrase count must be a positive integer.");
  if (!Number.isInteger(phraseSize) || phraseSize < 5) throw new Error("Phrase size must be at least five words.");

  const words = tokens(cleanText);
  if (words.length < phraseSize) return [];
  const originalBody = comparisonText(rawText);
  const originals = rawWords(rawText);
  const rawAligned = originals.length === words.length
    && originals.every((word, index) => word.normalized === words[index]);
  const candidates = grams(words, phraseSize)
    .map((normalizedPhrase, wordStart) => ({
      normalizedPhrase,
      wordStart,
      rarity: rarityScore(normalizedPhrase),
    }))
    .filter((candidate) => informativeGram(candidate.normalizedPhrase) && candidate.rarity >= 8);

  if (candidates.length === 0) return [];
  const maxStart = Math.max(1, words.length - phraseSize);
  const bySegment = Array.from({ length: count }, () => [] as typeof candidates);
  for (const candidate of candidates) {
    const segment = Math.min(count - 1, Math.floor((candidate.wordStart / (maxStart + 1)) * count));
    bySegment[segment].push(candidate);
  }
  for (const segment of bySegment) {
    segment.sort((a, b) => b.rarity - a.rarity || a.wordStart - b.wordStart);
  }

  const chosen: SelectedWebPhrase[] = [];
  const used = new Set<string>();
  const overlaps = (start: number) => chosen.some((phrase) => Math.abs(phrase.wordStart - start) < phraseSize);
  const add = (candidate: (typeof candidates)[number]) => {
    if (overlaps(candidate.wordStart) || used.has(candidate.normalizedPhrase)) return false;
    const firstRaw = originals[candidate.wordStart];
    const lastRaw = originals[candidate.wordStart + phraseSize - 1];
    const text = rawAligned && firstRaw && lastRaw
      ? originalBody.slice(firstRaw.start, lastRaw.end).replace(/\s+/g, " ").trim()
      : candidate.normalizedPhrase;
    chosen.push({
      text,
      normalized: candidate.normalizedPhrase,
      rarity: candidate.rarity,
      wordStart: candidate.wordStart,
      wordEnd: candidate.wordStart + phraseSize,
    });
    used.add(candidate.normalizedPhrase);
    return true;
  };

  for (const segment of bySegment) {
    const candidate = segment.find((item) => !overlaps(item.wordStart) && !used.has(item.normalizedPhrase));
    if (candidate) add(candidate);
  }

  if (chosen.length < count) {
    const remaining = [...candidates].sort((a, b) => b.rarity - a.rarity || a.wordStart - b.wordStart);
    for (const candidate of remaining) {
      add(candidate);
      if (chosen.length >= count) break;
    }
  }

  return chosen.sort((a, b) => a.wordStart - b.wordStart).slice(0, count);
}

export function summarizeWebCheck(result: WebCheckResult) {
  if (result.status === "insufficient") return "Not enough text to sample distinctive phrases.";
  if (result.status === "error") return "Wikipedia could not be reached for this check.";
  return `${result.phrasesMatched} of ${result.phrasesSampled} sampled phrases found on Wikipedia`;
}
