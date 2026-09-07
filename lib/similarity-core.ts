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

/**
 * The single source of truth for "what language is this document" —
 * canonicalized here so lib/corpus-quality-signals.ts (corpus admission)
 * and app/similarity-worker.ts (report/AI eligibility) can never derive
 * label + confidence via two independently-drifting formulas again. See
 * detectDominantLanguage's own header comment for the full design; this is
 * deliberately a closed 5-value set (no open-ended "Other" bucket) —
 * everything this product currently NEEDS to distinguish (English-only
 * eligibility for corpus admission and the AI detector, plus enough
 * granularity to explain a REVIEW/UNCERTAIN outcome to an admin) fits in
 * Arabic/French/English/Spanish/Mixed; adding a language means widening
 * this union deliberately, at the one place it's declared, and re-checking
 * every consumer of it — a Spanish passage silently had no home in the old
 * union at all, which is exactly how it got misread as French.
 */
export type DetectedLanguage = "Arabic" | "French" | "English" | "Spanish" | "Mixed";

export type LanguageDetectionResult = {
  language: DetectedLanguage;
  /** [0,1]. The dominant language's own share of the DOCUMENT'S classified evidence (word-weighted across windows) — not a per-window score, not a stopword tally. See detectDominantLanguage's own comment for exactly what this does and doesn't mean. */
  confidence: number;
};

// ENGINEERING_DEFAULT constants — not calibrated against a labeled corpus,
// same disclaimer as every other unpicked threshold in this codebase.
// LANGUAGE_WINDOW_WORDS is sized so a short embedded passage (a translated
// abstract, typically 100-300 words) occupies only one or two windows out
// of the many a real multi-page academic body produces, while staying
// large enough that genuine prose reliably clears
// MIN_WINDOW_FUNCTION_WORD_MATCHES within a single window — the bug this
// module exists to fix: a whole-document presence check let a handful of
// French/Spanish-ambiguous stopwords in a short abstract flip an entire
// multi-thousand-word English document's classification.
const LANGUAGE_WINDOW_WORDS = 200;
/** Mirrors the OLD detector's own "frenchSignals >= 3" convention, now applied per-window and symmetrically to all three Latin languages, and requiring an actual comparative win rather than bare presence. */
const MIN_WINDOW_FUNCTION_WORD_MATCHES = 3;
/** The dominant language's own share of total classified weight must reach this before the document is called confidently one language rather than Mixed. */
const MIN_DOMINANCE_SHARE = 0.55;
/** The gap between the dominant and runner-up shares must also reach this — protects against a narrow plurality (e.g. three closely-split languages) being reported as confidently dominant. */
const MIN_DOMINANCE_MARGIN = 0.2;

/**
 * Deliberately curated, hand-checked function-word sets — the fix for the
 * exact ambiguity that caused this bug: French "le"/"la"/"les"/"un"/"de"/
 * "que"/"entre" and Spanish "un"/"de"/"que"/"entre" are genuine shared
 * vocabulary, so NONE of those appear in either set below — a word only
 * ever appears in ONE of these three sets, chosen because it is not a
 * common function word in either of the other two. This is what makes
 * per-window comparison (rather than a single-list presence check) able to
 * actually distinguish French from Spanish: a genuine French window scores
 * on "dans"/"avec"/"pour"/"du"/"au"/"une" (none of which are Spanish);
 * a genuine Spanish window scores on "el"/"los"/"las"/"una"/"esta"/"del"/
 * "al" (none of which are French) — "una" vs French "une" and "el"/"los"/
 * "las" vs French "le"/"les"/"la" are the load-bearing minimal pairs.
 * Matched by exact token equality against normalize()'d text (which
 * lowercases and strips accents via NFKD — hence "etre" not "être", "esta"
 * not "está" below), never substring presence.
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  "the", "and", "of", "in", "is", "was", "were", "that", "this", "which",
  "with", "for", "as", "are", "from", "have", "has", "been", "not", "but",
  "their", "these", "those", "such", "between", "into", "than", "however",
  "also", "would", "could", "should", "about", "there", "when", "while",
  "because", "we", "they", "you", "an", "its", "if", "then", "each",
  "other", "more", "most", "only", "over", "after", "before", "through",
  "during", "on", "by", "at", "or", "all",
]);
const FRENCH_FUNCTION_WORDS = new Set([
  "des", "une", "dans", "avec", "pour", "du", "au", "aux", "etre", "etait",
  "etaient", "cette", "ces", "leur", "ou", "qui", "sur", "sont", "nous",
  "vous", "donc", "ainsi", "alors", "chaque", "tous", "toutes",
]);
const SPANISH_FUNCTION_WORDS = new Set([
  "el", "los", "las", "es", "son", "con", "para", "por", "una", "esta",
  "estos", "estas", "mas", "pero", "como", "su", "sus", "del", "al", "muy",
  "tambien", "anos", "hacia", "desde",
]);

type LatinLanguage = "English" | "French" | "Spanish";

/**
 * One window's own Latin-script language, decided by comparative exact
 * function-word evidence — never substring presence. Requires both a
 * minimum absolute match count (protects against a near-empty/junk window
 * producing a spurious win on 1 stray token) AND an outright winner (a
 * genuine tie between two languages' counts is reported as no signal
 * rather than an arbitrary pick).
 */
function classifyLatinWindow(windowText: string): LatinLanguage | null {
  const words = normalize(windowText).split(" ").filter(Boolean);
  let english = 0;
  let french = 0;
  let spanish = 0;
  for (const word of words) {
    if (ENGLISH_FUNCTION_WORDS.has(word)) english += 1;
    if (FRENCH_FUNCTION_WORDS.has(word)) french += 1;
    if (SPANISH_FUNCTION_WORDS.has(word)) spanish += 1;
  }
  const counts: Array<[LatinLanguage, number]> = [["English", english], ["French", french], ["Spanish", spanish]];
  const best = Math.max(english, french, spanish);
  if (best < MIN_WINDOW_FUNCTION_WORD_MATCHES) return null;
  const winners = counts.filter(([, count]) => count === best);
  return winners.length === 1 ? winners[0][0] : null;
}

type WindowLabel = "Arabic" | "MixedScript" | LatinLanguage | "Unclassified";

/**
 * Script tier first (unchanged ratios from the original single-shot
 * detector, just reapplied per window — "keep Arabic/script handling"):
 * Arabic-vs-Latin CHARACTER ratio decides Arabic / MixedScript / "proceed
 * to the Latin-language tier" exactly as before. A window with neither
 * script present (pure whitespace/digits/symbols — e.g. a table row) is
 * "Unclassified" and carries no weight in the aggregate below.
 */
function classifyWindow(windowText: string): WindowLabel {
  const arabic = (windowText.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (windowText.match(/[a-zà-ÿ]/gi) ?? []).length;
  if (arabic === 0 && latin === 0) return "Unclassified";
  if (arabic > latin * 0.25 && latin > arabic * 0.25) return "MixedScript";
  if (arabic > latin) return "Arabic";
  return classifyLatinWindow(windowText) ?? "Unclassified";
}

/**
 * Dominant-language detection over multiple fixed-size windows — the
 * replacement for the old whole-document, presence-only design. Splits the
 * raw text into LANGUAGE_WINDOW_WORDS-word windows, classifies each
 * independently (classifyWindow above), then aggregates windows WEIGHTED
 * BY THEIR OWN WORD COUNT — never a flat one-window-one-vote count, which
 * is exactly what would let a short trailing/partial window count the same
 * as a full one. This is what makes a short embedded passage (a translated
 * abstract) unable to dominate a long body: it contributes at most one or
 * two windows' worth of weight out of however many the rest of the
 * document produces, however emphatically that one window itself
 * classifies.
 *
 * A window that produces no Latin-language winner (classifyLatinWindow
 * returning null — too few matches, or a genuine tie) is "Unclassified"
 * and contributes ZERO weight — critically, this means a Latin-script
 * window is NEVER defaulted to English merely for lacking French/Spanish
 * evidence; it must clear its OWN English evidence bar via the exact same
 * comparative check French and Spanish do. Unclassified windows are
 * excluded from the confidence denominator entirely (a document that's
 * mostly tables/references with a little real prose reports confidence
 * over the prose it could actually read, not artificially diluted by the
 * parts it structurally can't classify).
 *
 * Document-level result: the label with the largest total weight, PROVIDED
 * it clears both MIN_DOMINANCE_SHARE (a real majority of the classified
 * evidence) and MIN_DOMINANCE_MARGIN (a real gap over the runner-up) —
 * otherwise "Mixed", regardless of which raw label happened to have more
 * weight. A dominant "MixedScript" (individual windows themselves showing
 * substantial Arabic+Latin mixing) resolves straight to "Mixed" without
 * the share/margin gate — genuine intra-window script mixing is Mixed by
 * construction, not a borderline call. Confidence is always the dominant
 * label's own share of total classified weight — including for a "Mixed"
 * result, where it simply reports how close the aggregate came to being
 * decisive rather than implying any confidence in a single label.
 *
 * Zero evidence anywhere (no window ever classifies as anything — an
 * all-numeric/symbolic document, or a genuinely unhandled Latin-script
 * language) falls back to { language: "English", confidence: 0 } — the
 * SAME "no real signal, report zero confidence" contract the old
 * languageConfidenceFor already used for its own totalScript === 0 case,
 * preserved here as the one remaining "default to English" path, and only
 * because there is no other label a zero-evidence result could honestly
 * report; confidence 0 combined with the corpus-admission confidence floor
 * (lib/corpus-hard-gates.ts) still correctly routes this to UNCERTAIN.
 */
export function detectDominantLanguage(value: string): LanguageDetectionResult {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { language: "English", confidence: 0 };

  const weights: Record<Exclude<WindowLabel, "Unclassified">, number> = {
    Arabic: 0, MixedScript: 0, English: 0, French: 0, Spanish: 0,
  };
  for (let start = 0; start < words.length; start += LANGUAGE_WINDOW_WORDS) {
    const windowWords = words.slice(start, start + LANGUAGE_WINDOW_WORDS);
    const label = classifyWindow(windowWords.join(" "));
    if (label === "Unclassified") continue;
    weights[label] += windowWords.length;
  }

  const totalWeight = weights.Arabic + weights.MixedScript + weights.English + weights.French + weights.Spanish;
  if (totalWeight === 0) return { language: "English", confidence: 0 };

  const ranked = (Object.entries(weights) as Array<[Exclude<WindowLabel, "Unclassified">, number]>)
    .sort((left, right) => right[1] - left[1]);
  const [dominantLabel, dominantWeight] = ranked[0];
  const runnerUpWeight = ranked[1][1];
  const dominantShare = dominantWeight / totalWeight;
  const margin = (dominantWeight - runnerUpWeight) / totalWeight;

  if (dominantLabel === "MixedScript") {
    return { language: "Mixed", confidence: dominantShare };
  }
  if (dominantShare < MIN_DOMINANCE_SHARE || margin < MIN_DOMINANCE_MARGIN) {
    return { language: "Mixed", confidence: dominantShare };
  }
  return { language: dominantLabel, confidence: dominantShare };
}

/** Bare-label convenience wrapper for the many existing callers that only ever needed the label — see detectDominantLanguage for the full algorithm and for confidence. */
export function detectLanguage(value: string): DetectedLanguage {
  return detectDominantLanguage(value).language;
}
