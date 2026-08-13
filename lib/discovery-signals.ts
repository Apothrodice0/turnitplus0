import { canonicalizeText } from "./canonical-text";
import { tokens, normalize, detectLanguage, COMMON_WORDS } from "./similarity-core";
import type { DiscoverySignals } from "./discovery-types";

/**
 * Phase E6A: deterministic discovery-signal extraction.
 *
 * This is NOT the similarity engine. lib/similarity-core.ts's shingle
 * primitives (tokens/informativeGram) are reused here only to decide which
 * short passages are distinctive enough to be worth searching with — never
 * to compute a similarity/containment score against anything. The output
 * exists to help *find* a possible external counterpart, not to *measure*
 * how similar one is (that remains entirely lib/similarity-core.ts's job,
 * completely untouched by this phase).
 *
 * Every output field is small and bounded, regardless of document length:
 * distinctivePassages is capped at config.maxPassages entries of at most
 * config.passageWindowWords words each — see the "no full-document
 * leakage" test in tests/discovery-signals.test.mjs, which asserts this
 * holds even for a very large input document.
 */

export type DiscoverySignalConfig = {
  /** Words per candidate passage window. */
  passageWindowWords: number;
  /** Word stride between successive candidate windows (smaller than passageWindowWords, so windows overlap and get merged/suppressed below). */
  passageStrideWords: number;
  /** Minimum count of long (>=4 char), non-common words a window must contain to be considered distinctive at all — the direct mechanism behind "do not use a generic/common sentence as a discovery signal." */
  minInformativeWordsPerPassage: number;
  /** Maximum number of distinctive passages returned. */
  maxPassages: number;
  /** A candidate window is rejected if it overlaps (by word position) a higher-ranked already-selected window by more than this fraction — keeps the returned passages from being near-duplicates of each other. */
  maxPassageOverlapRatio: number;
};

export const DEFAULT_DISCOVERY_SIGNAL_CONFIG: DiscoverySignalConfig = {
  passageWindowWords: 10,
  passageStrideWords: 5,
  minInformativeWordsPerPassage: 4,
  maxPassages: 5,
  maxPassageOverlapRatio: 0.5,
};

export type GenerateDiscoverySignalsInput = {
  title?: string | null;
  author?: string | null;
  rawText: string;
  /** Optional pre-computed canonical hash (e.g. from lib/document-identity.ts's canonicalSha256) — passed through as-is, never derived from rawText here, so this module never needs to know the hashing scheme. */
  canonicalHash?: string | null;
};

type CandidateWindow = { start: number; end: number; text: string; score: number };

function overlapRatio(a: CandidateWindow, b: CandidateWindow): number {
  const overlapStart = Math.max(a.start, b.start);
  const overlapEnd = Math.min(a.end, b.end);
  const overlapWords = Math.max(0, overlapEnd - overlapStart);
  return overlapWords / (a.end - a.start);
}

function extractDistinctivePassages(rawText: string, config: DiscoverySignalConfig): string[] {
  const canonical = canonicalizeText(rawText);
  const words = canonical.split(/\s+/).filter(Boolean);

  const candidates: CandidateWindow[] = [];
  for (let start = 0; start + config.passageWindowWords <= words.length; start += config.passageStrideWords) {
    const end = start + config.passageWindowWords;
    const text = words.slice(start, end).join(" ");
    // Score this window's own informativeness by running it through the
    // same normalize/length/common-word filter lib/similarity-core.ts's
    // informativeGram() uses — just applied to the whole window instead of
    // a fixed 5-word gram, since a discovery passage is intentionally
    // longer/more search-friendly than a similarity shingle.
    const informativeCount = tokens(text).filter((word) => word.length >= 4 && !COMMON_WORDS.has(word)).length;
    if (informativeCount >= config.minInformativeWordsPerPassage) {
      candidates.push({ start, end, text, score: informativeCount });
    }
  }

  // Highest-scoring first; position as a deterministic tiebreaker so equal
  // scores never depend on array/object iteration order.
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);

  const selected: CandidateWindow[] = [];
  for (const candidate of candidates) {
    if (selected.length >= config.maxPassages) break;
    if (selected.some((existing) => overlapRatio(candidate, existing) > config.maxPassageOverlapRatio)) continue;
    selected.push(candidate);
  }

  // Final output in reading order, not score order — a stable, predictable
  // presentation independent of the ranking pass above.
  selected.sort((a, b) => a.start - b.start);
  return selected.map((s) => s.text);
}

/**
 * Converts a document into a small set of deterministic discovery signals.
 * Same input always produces the same output (no randomness, no clock
 * reads, no I/O) — see tests/discovery-signals.test.mjs's determinism test.
 */
export function generateDiscoverySignals(
  input: GenerateDiscoverySignalsInput,
  config: DiscoverySignalConfig = DEFAULT_DISCOVERY_SIGNAL_CONFIG,
): DiscoverySignals {
  const trimmedTitle = input.title?.trim() ?? "";
  const trimmedAuthor = input.author?.trim() ?? "";
  const normalizedTitle = trimmedTitle ? normalize(trimmedTitle) : "";
  const normalizedAuthor = trimmedAuthor ? normalize(trimmedAuthor) : "";

  return {
    normalizedTitle: normalizedTitle || null,
    normalizedAuthor: normalizedAuthor || null,
    distinctivePassages: extractDistinctivePassages(input.rawText, config),
    canonicalHash: input.canonicalHash ?? null,
    language: input.rawText.trim() ? detectLanguage(input.rawText) : null,
  };
}
