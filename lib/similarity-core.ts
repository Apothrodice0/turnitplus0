import { stripReferenceSection } from "./reference-section";

export const COMMON_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "des", "du", "en",
  "et", "for", "from", "in", "is", "la", "le", "les", "of", "on", "or", "the",
  "to", "un", "une", "was", "were", "with", "that", "this", "which",
  "في", "من", "إلى", "الى", "على", "عن", "مع", "هذا", "هذه", "ذلك", "تلك",
  "التي", "الذي", "الذين", "كان", "كانت", "يكون", "و", "أو", "او", "ثم", "أن", "ان",
  "لا", "ما", "هو", "هي", "هم", "كما", "بين", "بعد", "قبل", "كل", "أي", "اي",
]);

export function normalize(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * "Investigate two real detection issues" ISSUE 1: delegates to
 * lib/reference-section.ts's shared, format-agnostic detector — see that
 * file's own header comment for why the previous newline-anchored regex
 * here silently never fired for PDF-extracted text.
 */
export function comparisonText(value: string) {
  return stripReferenceSection(value);
}

export function tokens(value: string) {
  return normalize(comparisonText(value)).split(" ").filter(Boolean);
}

export type TokenSpan = { word: string; start: number; end: number };

/**
 * Unified-similarity highlighting fix: the same word sequence tokens(value)
 * produces, but each entry additionally carries its character [start, end)
 * offset into comparisonText(value) — and therefore into `value` itself
 * too, since stripReferenceSection only ever removes a trailing suffix (see
 * lib/reference-section.ts's own stripReferenceSection: `text.slice(0,
 * start)`), never reorders or edits the prefix any of these offsets fall
 * within.
 *
 * Scans the ORIGINAL (comparison) text directly with a maximal-run-of-
 * letters-or-digits regex, rather than re-deriving offsets from
 * normalize()'s destructively-transformed string. This produces the exact
 * same word sequence as tokens() because normalize()'s only
 * boundary-relevant step is `replace(/[^\p{L}\p{N}\s]/gu, " ")` — every
 * non-letter/non-digit/non-whitespace character becomes a boundary, exactly
 * what \p{L}\p{N}+ already treats as a boundary when matched directly
 * against the original text. NFKD decomposition and \p{M} (combining mark)
 * stripping change a letter's internal representation, never whether it
 * counts as a letter, so they never shift a word boundary either. Verified
 * empirically (word sequence equality against tokens()) across this
 * codebase's own realistic fixture texts — see
 * tests/unified-similarity-highlighting.test.mjs.
 */
export function tokenSpans(value: string): TokenSpan[] {
  const text = comparisonText(value);
  const spans: TokenSpan[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match = pattern.exec(text);
  while (match) {
    spans.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return spans;
}

/**
 * Merges a set of word-index positions into contiguous [start, end]
 * (inclusive) ranges — the same "adjacent positions form one span" rule
 * lib/similarity-core.ts's own acceptedSimilaritySpans already applies
 * internally, reused here as a small, independent, presentation-layer
 * geometry helper (no matching/scoring judgment involved — purely turning
 * a position set into spans for rendering).
 */
export function mergeAdjacentPositions(positions: Iterable<number>): Array<[number, number]> {
  const sorted = [...positions].sort((left, right) => left - right);
  const ranges: Array<[number, number]> = [];
  for (const position of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && position <= previous[1] + 1) previous[1] = position;
    else ranges.push([position, position]);
  }
  return ranges;
}

export function grams(words: string[], size: number) {
  const values: string[] = [];
  for (let index = 0; index <= words.length - size; index += 1) {
    values.push(words.slice(index, index + size).join(" "));
  }
  return values;
}

export function informativeGram(gram: string) {
  return gram.split(" ").filter((word) => word.length >= 4 && !COMMON_WORDS.has(word)).length >= 2;
}

export function gramHash(value: string) {
  let first = 0x811c9dc5;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function containment(shared: number, submittedCount: number, sourceCount: number) {
  return shared / Math.max(1, Math.min(submittedCount, sourceCount));
}

export function similarityScore(matched: number, total: number) {
  return Math.min(100, Math.round((matched / Math.max(total, 1)) * 100));
}

export type SimilaritySpan = [start: number, end: number];
export type SourceWeighting = "raw" | "containment";
export type SourceAggregationParameters = {
  minimumSourceContribution: number;
  maximumContributingSources: number | null;
  sourceWeighting: SourceWeighting;
};
export type SimilaritySourceEvidence = {
  sourceIndex: number;
  positions: Set<number>;
  containment: number;
};

export const DEFAULT_SOURCE_AGGREGATION: SourceAggregationParameters = {
  minimumSourceContribution: 0,
  maximumContributingSources: null,
  sourceWeighting: "raw",
};

export function acceptedSimilaritySpans(
  matchedBySource: Map<number, Set<number>>,
  minimumMatchedWords: number,
) {
  if (!Number.isInteger(minimumMatchedWords) || minimumMatchedWords < 1) {
    throw new Error("minimumMatchedWords must be a positive integer.");
  }
  const allMatchedPositions = new Set<number>();
  matchedBySource.forEach((positions) => positions.forEach((position) => allMatchedPositions.add(position)));
  const globalSpans: SimilaritySpan[] = [];
  [...allMatchedPositions].sort((left, right) => left - right).forEach((position) => {
    const previous = globalSpans[globalSpans.length - 1];
    if (previous && position <= previous[1] + 1) previous[1] = position;
    else globalSpans.push([position, position]);
  });
  const acceptedGlobalSpans = globalSpans.filter(
    ([start, end]) => end - start + 1 >= minimumMatchedWords,
  );
  const acceptedPositions = new Set<number>();
  acceptedGlobalSpans.forEach(([start, end]) => {
    for (let position = start; position <= end; position += 1) acceptedPositions.add(position);
  });

  const spansBySource = new Map<number, SimilaritySpan[]>();
  matchedBySource.forEach((positions, sourceIndex) => {
    const sourceSpans: SimilaritySpan[] = [];
    [...positions]
      .filter((position) => acceptedPositions.has(position))
      .sort((left, right) => left - right)
      .forEach((position) => {
        const previous = sourceSpans[sourceSpans.length - 1];
        if (previous && position <= previous[1] + 1) previous[1] = position;
        else sourceSpans.push([position, position]);
      });
    if (sourceSpans.length) spansBySource.set(sourceIndex, sourceSpans);
  });
  return { acceptedPositions, acceptedGlobalSpans, spansBySource };
}

export function aggregateSimilaritySources(
  evidence: SimilaritySourceEvidence[],
  totalWords: number,
  parameters: SourceAggregationParameters = DEFAULT_SOURCE_AGGREGATION,
) {
  if (!Number.isFinite(parameters.minimumSourceContribution) || parameters.minimumSourceContribution < 0) {
    throw new Error("minimumSourceContribution must be a non-negative percentage.");
  }
  if (
    parameters.maximumContributingSources !== null
    && (!Number.isInteger(parameters.maximumContributingSources) || parameters.maximumContributingSources < 1)
  ) {
    throw new Error("maximumContributingSources must be null or a positive integer.");
  }
  if (parameters.sourceWeighting !== "raw" && parameters.sourceWeighting !== "containment") {
    throw new Error("sourceWeighting must be raw or containment.");
  }
  const ranked = evidence.map((source) => {
    const rawContribution = (source.positions.size / Math.max(1, totalWords)) * 100;
    const boundedContainment = Math.max(0, Math.min(1, source.containment));
    return {
      ...source,
      rawContribution,
      weightedWords: source.positions.size * (
        parameters.sourceWeighting === "containment" ? boundedContainment : 1
      ),
    };
  }).filter((source) => source.rawContribution + Number.EPSILON >= parameters.minimumSourceContribution)
    .sort((left, right) =>
      right.rawContribution - left.rawContribution
      || right.containment - left.containment
      || left.sourceIndex - right.sourceIndex,
    );
  const sourceContributions = parameters.maximumContributingSources === null
    ? ranked
    : ranked.slice(0, parameters.maximumContributingSources);
  const acceptedPositions = new Set<number>();
  sourceContributions.forEach((source) => source.positions.forEach((position) => acceptedPositions.add(position)));
  const matchedWordEquivalent = sourceContributions.reduce((total, source) => total + source.weightedWords, 0);
  return {
    score: similarityScore(matchedWordEquivalent, totalWords),
    matchedWordEquivalent,
    acceptedPositions,
    sourceContributions,
  };
}

export function detectLanguage(value: string): "Arabic" | "French" | "English" | "Mixed" {
  const arabic = (value.match(/[\u0600-\u06ff]/g) ?? []).length;
  const latin = (value.match(/[a-zà-ÿ]/gi) ?? []).length;
  if (arabic > latin * 0.25 && latin > arabic * 0.25) return "Mixed";
  if (arabic > latin) return "Arabic";
  const normalized = ` ${normalize(value)} `;
  const frenchSignals = [" le ", " la ", " les ", " des ", " une ", " dans ", " avec ", " pour "]
    .filter((signal) => normalized.includes(signal)).length;
  return frenchSignals >= 3 ? "French" : "English";
}
