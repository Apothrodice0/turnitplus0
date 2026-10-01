import { stripReferenceSection } from "./reference-section";

export const COMMON_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "des", "du", "en",
  "et", "for", "from", "in", "is", "la", "le", "les", "of", "on", "or", "the",
  "to", "un", "une", "was", "were", "with", "that", "this", "which",
  "في", "من", "إلى", "الى", "على", "عن", "مع", "هذا", "هذه", "ذلك", "تلك",
  "التي", "الذي", "الذين", "كان", "كانت", "يكون", "و", "أو", "او", "ثم", "أن", "ان",
  "لا", "ما", "هو", "هي", "هم", "كما", "بين", "بعد", "قبل", "كل", "أي", "اي",
]);

/**
 * The scoring-normalization contract: which normalize() a set of matched word
 * positions was computed under. Every position this product persists is an
 * index into tokens() of the report's own text, so a change to what
 * normalize() does to a character changes what an existing index points at.
 *
 *   v1 — NFKD, lowercase, strip \p{M}, every non-letter/digit a boundary.
 *        Frozen as normalizeScoringV1.
 *   v2 — v1, plus the invisible format characters below are deleted with no
 *        boundary, so "pla<U+200B>giarism" is the one word it reads as.
 *        Frozen as normalizeScoringV2.
 *
 * Both are always available. A computation runs under exactly one of them:
 *   - the contract in force for the current server computation
 *     (lib/scoring-normalization-scope.ts runWithScoringNormalization) —
 *     a saved report's own contract, or the one a check request declared;
 *   - otherwise ACTIVE_SCORING_NORMALIZATION_VERSION, the contract this build
 *     computes a NEW check under (a browser has no scope, so it always
 *     computes under the constant of the bundle it loaded).
 *
 * A report with no stamp (SimilarityReport.scoringNormalizationVersion) is
 * v1 — see reportScoringNormalizationVersion.
 */
export type ScoringNormalizationVersion = 1 | 2;

/**
 * The contract a NEW check is computed under by this build. Every reader of
 * persisted positions takes the report's own contract instead, so changing
 * this value changes nothing about a report that already exists.
 *
 * v2 is active: a check started by this build's browser bundle is computed,
 * declared, verified and stamped as v2. A check from a bundle that still
 * computes v1 (or declares nothing) is served as v1, exactly as before.
 *
 * ROLLBACK FLOOR: once this build has been live, v2 reports exist. They are
 * only read, re-resolved and resaved correctly by a build that has this
 * dual-contract support — so this build may be rolled back to the build in
 * which this constant is 1 (the same code with v1 active), and never to
 * anything older.
 */
export const ACTIVE_SCORING_NORMALIZATION_VERSION: ScoringNormalizationVersion = 2;

/**
 * The contract a request DECLARES its positions were (or are to be) computed
 * under — POST /api/reports, /api/academic-evidence and /api/archive/match
 * all read it with this. Absent is v1: a browser bundle older than the
 * declaration never sends one and only ever computed v1. Anything else that
 * is not exactly 1 or 2 is null (the route answers 400) — never a guess.
 */
export function requestedScoringNormalizationVersion(value: unknown): ScoringNormalizationVersion | null {
  if (value === undefined || value === null) return 1;
  return value === 1 || value === 2 ? value : null;
}

/**
 * The 138 code points that are BOTH General_Category=Cf and
 * Default_Ignorable_Code_Point in Unicode 17.0 — soft hyphen, zero-width
 * space/joiners, word joiner, BOM, the bidi marks/embeddings/overrides/
 * isolates, the invisible math operators, the deprecated format characters,
 * the shorthand and musical format controls, and the tag characters. All of
 * them render as nothing, so inside a word they hid it from every matcher.
 *
 * FROZEN: an explicit list, never a \p{Cf} / Unicode-property test — the set
 * must not move when the runtime's Unicode data does (this runs in browsers
 * too), and a visible Cf (U+0600–0605, U+06DD, …) must stay a boundary. A
 * change here is a new ScoringNormalizationVersion.
 */
export const SCORING_IGNORABLE_FORMAT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

const SCORING_IGNORABLE_FORMAT_CLASS = `[${SCORING_IGNORABLE_FORMAT_RANGES
  .map(([first, last]) => (first === last ? `\\u{${first.toString(16)}}` : `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`))
  .join("")}]`;
const SCORING_IGNORABLE_FORMAT = new RegExp(SCORING_IGNORABLE_FORMAT_CLASS, "gu");
const ANY_SCORING_IGNORABLE_FORMAT = new RegExp(SCORING_IGNORABLE_FORMAT_CLASS, "u");

/** Whether `value` holds any SCORING_IGNORABLE_FORMAT_RANGES code point — without one, v1 and v2 normalize it identically. */
export function hasScoringIgnorableFormatCharacter(value: string) {
  return ANY_SCORING_IGNORABLE_FORMAT.test(value);
}

/** `value` with every SCORING_IGNORABLE_FORMAT_RANGES code point removed and nothing put in its place. */
export function stripScoringIgnorableFormatCharacters(value: string) {
  return value.replace(SCORING_IGNORABLE_FORMAT, "");
}

/** Scoring normalization v1, frozen exactly as it was before the contract had a number. */
export function normalizeScoringV1(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Scoring normalization v2, frozen. The deletion runs after the mark strip
 * and before the boundary replacement — U+FEFF is whitespace to `\s`, so it
 * has to go before the whitespace collapse, never after.
 */
export function normalizeScoringV2(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(SCORING_IGNORABLE_FORMAT, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeForScoringVersion(version: ScoringNormalizationVersion) {
  return version === 2 ? normalizeScoringV2 : normalizeScoringV1;
}

/**
 * Where lib/scoring-normalization-scope.ts (server only — it needs
 * node:async_hooks, which this module, shared with browsers and workers, must
 * not import) publishes the store holding the contract of the computation in
 * progress. Read off globalThis so every copy of this module a bundler makes
 * sees the one scope, whichever copy the scope module itself was linked to.
 */
const SCORING_NORMALIZATION_SCOPE_KEY = Symbol.for("turnitplus.scoring-normalization-scope");
type ScoringNormalizationScope = { getStore(): ScoringNormalizationVersion | undefined };
let scoringNormalizationScope: ScoringNormalizationScope | undefined;

/**
 * The contract in force right here: the enclosing runWithScoringNormalization
 * scope's, else ACTIVE_SCORING_NORMALIZATION_VERSION.
 */
export function currentScoringNormalizationVersion(): ScoringNormalizationVersion {
  scoringNormalizationScope ??= (globalThis as { [SCORING_NORMALIZATION_SCOPE_KEY]?: ScoringNormalizationScope })[SCORING_NORMALIZATION_SCOPE_KEY];
  return scoringNormalizationScope?.getStore() ?? ACTIVE_SCORING_NORMALIZATION_VERSION;
}

/**
 * The scoring normalization everything matched, fingerprinted or scored goes
 * through — under the contract in force (currentScoringNormalizationVersion),
 * so one matcher implementation serves both contracts natively.
 */
export function normalize(value: string) {
  return currentScoringNormalizationVersion() === 2 ? normalizeScoringV2(value) : normalizeScoringV1(value);
}

/**
 * The contract a report's persisted positions were computed under. The stamp
 * is written by the server, after it has computed and checked those positions
 * under that contract (app/api/reports/route.ts); a report without one
 * predates the stamp and is v1. Anything but the literal 2 is v1.
 */
export function reportScoringNormalizationVersion(
  report: { scoringNormalizationVersion?: unknown } | null | undefined,
): ScoringNormalizationVersion {
  return report?.scoringNormalizationVersion === 2 ? 2 : 1;
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

/** tokens() under a named contract — the word sequence a report stamped `version` indexes into. */
export function tokensForScoringNormalization(value: string, version: ScoringNormalizationVersion) {
  return normalizeForScoringVersion(version)(comparisonText(value)).split(" ").filter(Boolean);
}

/**
 * Which contract a report's own word count is evidence of, judged from the
 * report's text alone — what lets a server that did not compute a report's
 * archive positions (the browser did, in the same pass that counted the
 * words: lib/archive-similarity-scoring.ts `wordCount: words.length`) still
 * establish the position space they are in before it stamps the report.
 *
 * v2 only ever JOINS consecutive v1 words (it deletes characters v1 turns
 * into a boundary, and nothing else), so the two word sequences are equal
 * exactly when their lengths are:
 *
 *   "either" — the text reads the same under both contracts (no invisible
 *              format character splits a word). Every position is the same
 *              index in both spaces, so neither stamp could mislead a reader.
 *   1 | 2    — the sequences differ and `wordCount` is exactly that
 *              contract's length (and so is not the other's).
 *   null     — the sequences differ and `wordCount` is neither length.
 *
 * A text with none of SCORING_IGNORABLE_FORMAT_RANGES is "either" without
 * being tokenized: no code point outside the set normalizes into one.
 */
export function scoringNormalizationEvidence(value: string, wordCount: unknown): ScoringNormalizationVersion | "either" | null {
  if (!hasScoringIgnorableFormatCharacter(value)) return "either";
  const v1Count = tokensForScoringNormalization(value, 1).length;
  const v2Count = tokensForScoringNormalization(value, 2).length;
  if (v1Count === v2Count) return "either";
  if (wordCount === v1Count) return 1;
  if (wordCount === v2Count) return 2;
  return null;
}

/** `word` is the ORIGINAL text slice [start, end) — never a normalized form. */
export type TokenSpan = { word: string; start: number; end: number };

/**
 * What normalize() turns ONE code point into, before whitespace collapsing:
 * "" when it is deleted outright (a combining mark; under v2 also an
 * invisible format character), text containing " " where it is (or yields) a
 * word boundary. Derived from the contract's own normalizer (`normalizeText`)
 * between two "a" sentinels, so it can never drift from the scoring
 * normalization; null if the sentinels do not survive (never today).
 *
 * Also null for a LONE surrogate (ill-formed UTF-16): once normalize()
 * deletes the combining marks between a lone high and a lone low surrogate,
 * the two code units join into one astral letter that no single code point
 * produces. The mapping cannot be proven from there, so it stops (fail
 * closed) instead of risking a neighbouring word's range.
 */
function normalizedCodePoint(codePoint: string, normalizeText: (value: string) => string): string | null {
  if (/^[\uD800-\uDFFF]$/.test(codePoint)) return null;
  const bracketed = normalizeText(`a${codePoint}a`);
  if (bracketed.length < 2 || bracketed[0] !== "a" || bracketed[bracketed.length - 1] !== "a") return null;
  return bracketed.slice(1, -1);
}

/**
 * normalize() lowercases the WHOLE string, so a capital sigma becomes final
 * "ς" or medial "σ" depending on its neighbours; one code point on its own
 * always becomes "σ". In well-formed text that is the only context-dependent
 * step (NFKD's canonical reordering only moves combining marks, which are
 * deleted; lone surrogates stop the mapping in normalizedCodePoint), so it is
 * the only difference accepted between the two.
 */
function sameScoringToken(derived: string, scored: string) {
  if (derived === scored) return true;
  if (derived.length !== scored.length) return false;
  for (let index = 0; index < derived.length; index += 1) {
    if (derived[index] !== scored[index] && !(derived[index] === "σ" && scored[index] === "ς")) return false;
  }
  return true;
}

/**
 * Unified-similarity highlighting fix: the same word sequence tokens(value)
 * produces, but each entry additionally carries its character [start, end)
 * offset into comparisonText(value) — and therefore into `value` itself
 * too, since stripReferenceSection only ever removes a trailing suffix (see
 * lib/reference-section.ts's own stripReferenceSection: `text.slice(0,
 * start)`), never reorders or edits the prefix any of these offsets fall
 * within.
 *
 * Display-token span alignment: a raw letters-or-digits scan is NOT the same
 * word sequence as tokens() — a combining mark inside a word (NFD accents,
 * Arabic harakat) splits the raw run but is deleted by normalize(), and a
 * compatibility symbol (™ ℃ ½ ⓐ) is a raw boundary but NFKD turns it into
 * letters/digits — so every scored position after such a character used to
 * highlight a neighbouring word. Instead, each ORIGINAL code point is run
 * through normalize() on its own (normalizedCodePoint) and the resulting
 * words are carried with the raw offsets of the code points that produced
 * them:
 *   - a word spans from its first contributing code point to its last,
 *     plus any deleted code points (combining marks) directly after it, so
 *     a mark stays with its base; one before a word's first letter (at the
 *     text start, or after a boundary) belongs to no word;
 *   - a code point that yields several words (½ → "1 2") gives each of them
 *     that same code point's range.
 *
 * FAIL CLOSED: every derived word is checked against the real tokens(value)
 * at the same index (sameScoringToken). At the first word that does not
 * match, mapping stops and the array ends there: callers already treat an
 * index past the end as "no character range" (no highlight), so an
 * unprovable position is never shifted onto a neighbouring word. A lone
 * surrogate (ill-formed UTF-16) also ends the array, at that code unit.
 *
 * Linear in the text length; normalize() runs once per DISTINCT code point.
 *
 * `version` is the scoring-normalization contract the word INDICES being
 * mapped were computed under. Text with nothing persisted against it is the
 * contract in force (the default); a saved report passes its own
 * (reportScoringNormalizationVersion) — a v1 report's positions index the v1
 * word sequence, in which an invisible format character still splits a word,
 * so reading them against the v2 sequence would highlight a later word, and
 * the reverse for a v2 report read against the v1 sequence.
 */
export function tokenSpans(value: string, version: ScoringNormalizationVersion = currentScoringNormalizationVersion()): TokenSpan[] {
  return alignTokenSpans(comparisonText(value), tokensForScoringNormalization(value, version), version);
}

/**
 * tokenSpans()' mapping of `text` onto an already-computed scoring token
 * list (`scored` must be that contract's tokens of the same text for a full
 * result; any other list just ends the array at the first disagreement).
 */
export function alignTokenSpans(
  text: string,
  scored: readonly string[],
  version: ScoringNormalizationVersion = currentScoringNormalizationVersion(),
): TokenSpan[] {
  const normalizeText = normalizeForScoringVersion(version);
  const spans: TokenSpan[] = [];
  const pieces = new Map<string, string | null>();
  let word = "";
  let start = -1;
  let end = -1;
  let offset = 0;
  const closeWord = () => {
    if (start < 0) return true;
    const expected = scored[spans.length];
    if (expected === undefined || !sameScoringToken(word, expected)) return false;
    spans.push({ word: text.slice(start, end), start, end });
    word = "";
    start = -1;
    return true;
  };
  for (const codePoint of text) {
    let piece = pieces.get(codePoint);
    if (piece === undefined) {
      piece = normalizedCodePoint(codePoint, normalizeText);
      pieces.set(codePoint, piece);
    }
    if (piece === null) return spans;
    const next = offset + codePoint.length;
    if (piece === "") {
      if (start >= 0) end = next;
    } else {
      for (const character of piece) {
        if (character === " ") {
          if (!closeWord()) return spans;
        } else {
          if (start < 0) start = offset;
          word += character;
          end = next;
        }
      }
    }
    offset = next;
  }
  closeWord();
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

/**
 * AI reproducibility metadata (report-lifecycle correctness fix): a plain
 * version identifier for the CURRENT detectDominantLanguage/detectLanguage
 * algorithm, bumped only when its classification logic materially changes
 * (windowing, function-word sets, dominance thresholds — not cosmetic
 * refactors). Exists so a persisted AI result can record which detector
 * version decided its eligibility (see app/ai-detector-worker.ts's own
 * analyze(), which threads this into every saved AiAnalysis alongside the
 * detected language itself) — without it, two saved scores for the same
 * document computed under different detector versions are indistinguishable
 * after the fact, which is exactly the gap the "0% historically, 18% now"
 * investigation ran into. 2 = the windowed, word-weighted dominant-language
 * algorithm introduced in commit 668b1f7 ("fix: detect dominant document
 * language"); 1 would retroactively label the whole-document, presence-only
 * heuristic it replaced, had that era persisted this field at all (it
 * didn't — this constant did not exist yet, so no report predating 668b1f7
 * carries a value here, which is itself informative: absent means "before
 * this metadata existed," never "version 1").
 */
export const LANGUAGE_DETECTOR_VERSION = 2;

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
