import { canonicalizeText } from "../canonical-text";
import { COMMON_WORDS, tokens } from "../similarity-core";
import type { AcademicSearchQuery } from "./types";

/**
 * Stage 1 of the pipeline (STEP 4): turns raw submission text into a small,
 * bounded set of search queries. Pure and deterministic — no I/O, no
 * randomness — and independently testable from every other stage.
 *
 * Unlike lib/discovery-signals.ts's extractDistinctivePassages (fixed-width
 * sliding windows over the whole document, scored only by informative-word
 * count), this extractor is sentence-anchored — the task specifically asks
 * for "sentences with high lexical uniqueness" as a search unit, which reads
 * far more naturally as an academic-search-engine query than an arbitrary
 * 10-word window. Overlong sentences are still chunked into bounded windows
 * (maxWordsPerPhrase) so a single run-on sentence can't produce a query too
 * long for a real search API to handle well.
 */

export type PhraseExtractionConfig = {
  /** Lower bound on how many queries to return, best-effort only — a short or repetitive document may legitimately produce fewer; this is never padded out with weak/generic queries just to hit the floor. */
  minQueries: number;
  maxQueries: number;
  minWordsPerPhrase: number;
  maxWordsPerPhrase: number;
  /** Minimum count of long (>=4 char), non-common words a candidate must contain to be considered at all — same mechanism as lib/discovery-signals.ts's minInformativeWordsPerPassage, applied to a sentence instead of a fixed window. */
  minInformativeWords: number;
  /** A word this long or longer counts as a proxy for domain/academic terminology (e.g. "photosynthesis," "epistemological") — a coarse but cheap signal, not an academic-vocabulary lookup table. */
  longWordThreshold: number;
  /**
   * Phase 5 addition: how many of the top sentence-scored candidates also
   * get a companion KEYWORD query (see extractKeywordQueries below) — a
   * bounded, separate addition to maxQueries, not a replacement for the
   * sentence-based queries above.
   */
  keywordQueryCount: number;
  /** How many whole-document topic-frequency terms are prepended to every keyword query. */
  keywordTopicTermCount: number;
  /** Caps how many of a single candidate sentence's own informative words feed a keyword query (longest-first, after excluding likely verbs/adverbs) — live testing found an uncapped/longer bag reliably diluted relevance rather than improving it. */
  keywordMaxSentenceWords: number;
  /**
   * "Investigate two production issues" ISSUE 1: how many additional
   * queries (0 or 1) are built from ONLY the whole-document topic terms —
   * no per-sentence words mixed in at all, unlike every other keyword
   * query above. Root cause this exists to address, confirmed live against
   * OpenAIRE's real Graph API v3 `search` endpoint (api.openaire.eu): it is
   * NOT a relevance-ranked full-text search — it behaves conjunctively
   * (effectively AND) over METADATA ONLY (title/abstract/authors; see
   * providers/openaire.ts's own header comment — the API has no full-text
   * index at all), so a query built from body-text sentence words, or even
   * the existing per-sentence keyword bags above, routinely includes a
   * word absent from the paper's own title/abstract and silently returns
   * zero results. Confirmed with real numbers against a genuine
   * OpenAIRE-indexed paper: "bayesvalidrox surrogate model documentation
   * repository stuttgart" (an existing per-sentence keyword query) ->
   * numFound 0; the SAME topic terms alone, "bayesvalidrox surrogate
   * model" -> numFound 3, the real record among them. A pure topic-terms
   * query is the shortest, least-noisy signal this pipeline already
   * computes (extractTopicTerms) — reusing it standalone, rather than
   * inventing a second "what is this document about" heuristic, gives a
   * conjunctive-metadata-only search engine the best realistic chance of
   * matching without dragging in body-specific vocabulary the paper's own
   * abstract never uses. Additive only — every existing sentence/keyword
   * query above is unchanged; see this file's own header comment on why a
   * short summary query is a natural complement, not a replacement, for
   * the sentence-anchored strategy those queries already use.
   */
  topicOnlyQueryCount: number;
  /**
   * Accuracy & Coverage Benchmark finding (2026-08-21, Social Sciences/
   * Humanities discovery-loss investigation): how many words from the very
   * start of the (sanitized, canonicalized) document are treated as the
   * document's own "title region" — a submitted document conventionally
   * opens with its own title, so this is a general, position-based proxy
   * for "the paper's own most identifying vocabulary," not a paper-specific
   * heuristic. See extractTitleTerms's own comment.
   *
   * Deliberately generous, not "first line": confirmed live on a real
   * HAL-hosted paper (a large, common French open-access repository, one
   * of many that do this — arXiv/SSRN/institutional repositories follow
   * the same convention) that the actual title can sit ~90-100 words in,
   * behind a repository deposit banner duplicated in two languages plus a
   * license line. A narrow window (originally 20) never reaches the real
   * title at all on a document shaped like this — it only ever picks up
   * fragments of the banner itself (e.g. "multi[-disciplinary]"). Low risk
   * either way: extractTopicTerms still makes a title-region word win a
   * fair tie-break against body-frequency terms before it is ever used, so
   * a wider net costs nothing on a document with no such preamble.
   */
  titleWindowWords: number;
};

export const DEFAULT_PHRASE_EXTRACTION_CONFIG: PhraseExtractionConfig = {
  minQueries: 5,
  maxQueries: 20,
  minWordsPerPhrase: 6,
  maxWordsPerPhrase: 24,
  minInformativeWords: 4,
  longWordThreshold: 9,
  keywordQueryCount: 3,
  keywordTopicTermCount: 3,
  keywordMaxSentenceWords: 6,
  topicOnlyQueryCount: 1,
  titleWindowWords: 150,
};

/**
 * Discovery-loss investigation finding (2026-08-21): a submission whose own
 * source text legitimately contains markup examples or bare URLs (confirmed
 * live on a real Humanities/digital-humanities paper about TEI/XML text
 * encoding) lets raw tag syntax and URL substrings reach phrase-extraction
 * as if they were ordinary prose. Once ordinary punctuation-stripping
 * normalization runs, a tag's own attribute value (e.g. the XML identifier
 * `scripturalNote` inside `type="scripturalNote"`) or a URL's domain label
 * (e.g. `sourceschretiennes` inside `sourceschretiennes.mom.fr`) surfaces as
 * a plausible-looking standalone "word" — high-scoring by every existing
 * signal (long, unique, not a common word) despite carrying zero real
 * search value, since it can never appear in any paper's own title/abstract
 * metadata. Stripped here, structurally (matching real tag/URL syntax, not
 * any particular document's content), before anything else in this file
 * ever sees the text — general-purpose text hygiene, not a per-paper patch.
 *
 * Tag pattern requires the character after "<" (or "</") to be a letter, so
 * a STEM document's own inequality expressions ("x < 5 and y > 3") are never
 * mistaken for markup — confirmed the naive `<[^>]+>` alternative does not
 * have this guard. Bounded to 120 chars with no embedded "<"/">"/newline so
 * one unmatched "<" can't consume an unrelated, arbitrarily long span of
 * real prose.
 */
const MARKUP_TAG_PATTERN = /<\/?[a-zA-Z][^<>\n]{0,120}>/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const BARE_WWW_PATTERN = /\bwww\.[^\s<>"']+/gi;
/**
 * A bare "http"/"https" immediately followed by digits, with no "://" —
 * confirmed live (same Humanities paper): numbered inline hyperlink
 * markers like "[http7]" survive extraction as plain bracketed text
 * (the bracket itself is stripped later by ordinary punctuation
 * normalization, leaving "http7" as a standalone token). Not a real URL
 * (URL_PATTERN already requires "://" precisely so it never fires on
 * ordinary prose), and no genuine English/French/Arabic word takes this
 * shape, so this is safe to strip unconditionally.
 */
const NUMBERED_LINK_MARKER_PATTERN = /\bhttps?\d+\b/gi;

export function sanitizeExtractionArtifacts(rawText: string): string {
  return rawText
    .replace(MARKUP_TAG_PATTERN, " ")
    .replace(URL_PATTERN, " ")
    .replace(BARE_WWW_PATTERN, " ")
    .replace(NUMBERED_LINK_MARKER_PATTERN, " ");
}

/**
 * Discovery-loss investigation finding: a token this long is far more
 * likely to be an extraction artifact (words glued together with no space,
 * a URL fragment or identifier that survived sanitizeExtractionArtifacts,
 * a stray hash/id) than a genuine single word in any of this file's
 * supported languages — even a notably long real academic term
 * ("antidisestablishmentarianism", "electroencephalography") stays well
 * under this bound. A structural backstop for extraction noise
 * sanitizeExtractionArtifacts's own targeted patterns don't happen to
 * catch, never a claim about what a "real word" looks like beyond length.
 */
const MAX_PLAUSIBLE_WORD_LENGTH = 30;

function splitSentences(canonical: string): string[] {
  const sentences: string[] = [];
  for (const paragraph of canonical.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?])\s+(?=\S)/)) {
      const sentence = part.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return sentences;
}

/** Chunks an overlong sentence into non-overlapping windows of at most maxWords words each. A sentence at or under the limit is returned unchanged, as its own single-element array. */
function windowSentence(sentence: string, maxWords: number): string[] {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [sentence];
  const windows: string[] = [];
  for (let start = 0; start < words.length; start += maxWords) {
    windows.push(words.slice(start, start + maxWords).join(" "));
  }
  return windows;
}

type ScoredCandidate = { text: string; position: number; score: number };

function isInformativeWord(word: string): boolean {
  return word.length >= 4 && word.length <= MAX_PLAUSIBLE_WORD_LENGTH && !COMMON_WORDS.has(word);
}

function scoreCandidate(text: string, config: PhraseExtractionConfig): number | null {
  const words = tokens(text);
  if (words.length === 0) return null;
  const informativeWords = words.filter(isInformativeWord);
  if (informativeWords.length < config.minInformativeWords) return null;

  const uniqueRatio = new Set(words).size / words.length;
  const longWordCount = informativeWords.filter((word) => word.length >= config.longWordThreshold).length;
  return informativeWords.length + uniqueRatio * 3 + longWordCount * 1.5;
}

/**
 * Discovery-loss investigation finding (2026-08-21): a submitted document
 * conventionally opens with its own title — a general, position-based
 * signal (never a lookup of any specific paper's actual title) for which
 * words are most likely to be this document's own identifying vocabulary.
 * Pure body-frequency ranking (extractTopicTerms's original, still-primary
 * signal) can miss a paper's own title term entirely on a long document
 * whose body happens to repeat OTHER related vocabulary more often —
 * confirmed live: a real paper's title term never appeared in any of its
 * own generated queries because three other body-frequent words outranked
 * it. `terms` is returned in first-appearance order (informative words only,
 * deduped); extractTopicTerms decides how much weight, if any, to give them.
 *
 * HAL-banner discovery-loss follow-up (2026-08-21): a repository deposit
 * banner (HAL, and the same front-matter convention on arXiv/SSRN/
 * institutional repositories) sits INSIDE this same window, ahead of the
 * paper's real title — confirmed live (soc-openaire, DOI
 * 10.1057/s41253-026-00314-w): "HAL is a multi-disciplinary open access
 * archive..." occupies the first ~105 tokens, before "Infoxicated Feelings?
 * How Affective Polarization and Misinformation..." ever begins. `occurrences`
 * counts each informative word's occurrences WITHIN this same window (not
 * the whole document) — extractTopicTerms uses this alongside the word's
 * whole-document frequency to tell a genuinely reprinted title term (a
 * repository conventionally restates the title itself more than once in its
 * own front matter — a deposit heading, then again in a "To cite this
 * version" line) apart from an incidental banner word that happens to
 * qualify by other measures; see that function's own comment for the full
 * mechanism. Used only as an added, higher-priority tie-break ahead of the
 * existing whole-document-rarity signal, never a replacement for it.
 */
type TitleWindowTerms = { terms: string[]; occurrences: Map<string, number> };

function extractTitleTerms(canonical: string, config: PhraseExtractionConfig): TitleWindowTerms {
  const openingWords = tokens(canonical).slice(0, config.titleWindowWords);
  const occurrences = new Map<string, number>();
  const terms: string[] = [];
  for (const word of openingWords) {
    if (!isInformativeWord(word)) continue;
    const priorCount = occurrences.get(word) ?? 0;
    if (priorCount === 0) terms.push(word);
    occurrences.set(word, priorCount + 1);
  }
  return { terms, occurrences };
}

/**
 * Phase 5: the whole document's own recurring subject terms — informative
 * words appearing 2+ times anywhere in the document, ranked by frequency
 * (ties broken by length, then alphabetically, for determinism). Cheap,
 * corpus-free proxy for "what this document is actually about," reused as
 * the anchor for every keyword query below (see extractKeywordQueries).
 *
 * Discovery-loss investigation addition: reserves exactly one of the
 * `count` slots for the strongest qualifying candidate from `titleWindow.terms`
 * (see extractTitleTerms) that pure frequency ranking would NOT otherwise
 * have included — never more than one, and never at all when every
 * title-region candidate was already going to be included anyway, so a
 * document where frequency ranking already works well (the common case;
 * every domain but the ones the benchmark actually caught) sees zero change.
 *
 * Tie-break direction (2026-08-21 revision): among qualifying candidates,
 * prefer the LOWEST body frequency, not the highest — confirmed live on two
 * independent real papers that the ORIGINAL "prefer highest frequency"
 * direction reliably picks the wrong word. A title word recurring
 * constantly throughout the body (e.g. "affective" in a paper about
 * affective polarization, "text" in a paper about text reuse) is a
 * generic, shared-with-hundreds-of-other-papers core concept — real OpenAIRE
 * numbers confirmed such a term alone returns 1,000+ results with the
 * target nowhere in the top 5. A title word used sparingly (e.g. a paper's
 * own coined term, or its own project name) is precisely the word that
 * narrows a search to a handful of results with the target at rank 0 —
 * standard rare-term-is-more-discriminative intuition, applied here to
 * which of several already-qualifying title candidates gets the one
 * reserved slot. Still requires recurrence (>=2, the SAME floor
 * frequencyRanked itself already applies) so a genuine one-off mention
 * (a co-author's surname on the title page, an incidental word) is never
 * preferred purely for being rare — it must be both title-region AND
 * recurring, only then does rarity between qualifying candidates decide.
 * Still just one slot, same word/query budget; length remains the final,
 * lowest-priority tie-break (this file's own existing "longer -> more
 * likely genuinely distinctive" convention, see longWordThreshold), fully
 * deterministic, never paper-specific.
 *
 * HAL-banner discovery-loss follow-up (2026-08-21): the rarity tie-break
 * above, alone, still picks a repository deposit-banner word over the
 * paper's real title — confirmed live (soc-openaire, DOI
 * 10.1057/s41253-026-00314-w): "disciplinary" (from HAL's own "multi-
 * disciplinary open access archive" banner line) occurs exactly twice
 * document-wide, while "infoxicated" (the paper's own coined title term,
 * reprinted in HAL's front matter) occurs four times — MORE often, not
 * less, precisely because the front matter reprints it. Ascending-rarity
 * alone therefore prefers the rarer banner word every time a genuine,
 * reprinted title term's own repetition pushes its raw count above a
 * banner word's incidental count.
 *
 * A single "is this word ever used outside the window" gate is NOT enough
 * to fix this: confirmed live that "disciplinary" itself has a real,
 * unrelated body mention 7,400+ words later ("moving beyond disciplinary
 * silos to inform both theory and...") — the exact kind of genuine
 * occurrence this fix must NOT discard, per its own scope. Preferring
 * whichever candidate has the highest RAW body frequency is equally wrong
 * the other way: it just re-derives "most frequent word overall," which is
 * exactly the generic, low-precision signal the rarity tie-break above
 * exists to overrule (confirmed live: it picks "affective," the single
 * most generic word in this exact paper's own title).
 *
 * The signal that actually separates them: "infoxicated" is BOTH reprinted
 * *within* the title window itself (2 occurrences among its first 150
 * tokens, from the deposit heading and the "To cite this version" line —
 * see extractTitleTerms) AND still recurs *beyond* the window (2 more
 * occurrences in the actual abstract/body — the SAME >=2 "recurring" floor
 * frequencyRanked and the qualifying-candidate filter below already both
 * use, not a new threshold). "disciplinary" has only ONE occurrence within
 * the window (never reprinted) despite also having one genuine body use
 * elsewhere — a title is, by construction, restated multiple times in a
 * repository's front matter AND is what the body goes on to discuss at
 * length; an incidental word satisfies at most one of those two conditions.
 *
 * The same >=2 body-recurrence floor also turned out to matter for a THIRD
 * confound, confirmed live on the very same paper: an author's own byline
 * ("Mickael Temporão") is conventionally reprinted in front matter for a
 * completely unrelated reason (once near the title, again in the "To cite
 * this version" line) and can satisfy a laxer ">= 1 body use" gate too (a
 * single passing "corresponding author" mention) while still being rarer,
 * document-wide, than the real title term — requiring >=2 body
 * occurrences, not just one, excludes this without any name-detection logic
 * at all.
 *
 * So: among qualifying candidates, first narrow to whichever satisfy BOTH
 * (window-local repetition >= 2 AND body recurrence >= 2) — the signature
 * of a genuinely reprinted, genuinely body-relevant title term — and only
 * among THAT narrower set does the original whole-document-rarity tie-break
 * above decide. If nothing satisfies both (the common case: a plain
 * document with no repeated front-matter title, or a short document where
 * the whole thing IS the window), this step changes nothing and the
 * original, unchanged pool and sort apply exactly as before.
 */
function extractTopicTerms(
  canonical: string,
  count: number,
  titleWindow: TitleWindowTerms = { terms: [], occurrences: new Map() },
): string[] {
  const freq = new Map<string, number>();
  for (const word of tokens(canonical)) {
    if (!isInformativeWord(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  const frequencyRanked = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([word]) => word);

  if (count <= 0 || titleWindow.terms.length === 0) return frequencyRanked.slice(0, count);

  const guaranteedByFrequencyAlone = new Set(frequencyRanked.slice(0, count - 1));
  const qualifying = titleWindow.terms.filter(
    (word) => !guaranteedByFrequencyAlone.has(word) && (freq.get(word) ?? 0) >= 2,
  );
  const reprintedAndBodyRelevant = qualifying.filter((word) => {
    const windowOccurrences = titleWindow.occurrences.get(word) ?? 0;
    const bodyOccurrences = (freq.get(word) ?? 0) - windowOccurrences;
    return windowOccurrences >= 2 && bodyOccurrences >= 2;
  });
  const candidatePool = reprintedAndBodyRelevant.length > 0 ? reprintedAndBodyRelevant : qualifying;
  const bestTitleTerm = [...candidatePool].sort(
    (a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0) || b.length - a.length,
  )[0];
  if (!bestTitleTerm) return frequencyRanked.slice(0, count);

  return [bestTitleTerm, ...frequencyRanked.filter((word) => word !== bestTitleTerm)].slice(0, count);
}

// Verb/adverb/past-participle suffixes — cheap, POS-tagger-free proxy for
// "grammatically cannot be the head noun of a technical term" (see
// extractKeywordQueries's own comment for why this matters). Deliberately a
// small, explicit, auditable list, matching this project's established
// convention (lib/retrieval-safety.ts's own IP-range comment) over a
// broader but opaque heuristic.
const LIKELY_VERB_OR_ADVERB_SUFFIX = /(?:ing|ly|ed)$/;

/**
 * Phase 5 finding: a paraphrased submission's own full sentences can fail to
 * surface their real source at all in a keyword-relevance search (confirmed
 * live against OpenAIRE/Europe PMC — see this phase's own final report),
 * because a rewritten sentence's function words and phrasing dilute the few
 * domain-specific terms a search engine's own ranking actually keys on.
 * Live experimentation on the confirmed failing case (documented in this
 * phase's own final report) found that a short query combining the whole
 * document's own recurring topic terms with ONE candidate sentence's own
 * longest, non-verb/adverb informative words materially improved discovery
 * (Europe PMC: not found -> rank 0) without any hand-picked, document-
 * specific word list — reusing the EXISTING sentence ranking below (no
 * second "which sentence is best" heuristic), just a bounded, generically-
 * applicable re-packaging of words that ranking already surfaced.
 *
 * This is evaluated honestly as a measurable improvement, not a guaranteed
 * fix — an automatic keyword-selection heuristic without real part-of-
 * speech tagging cannot perfectly replicate a hand-picked query every time;
 * see this phase's own final report for the full before/after evidence.
 *
 * Deliberately does not change the sentence-based candidates or their
 * scoring at all — this only adds a bounded number of ADDITIONAL queries,
 * built from candidates already selected by the existing algorithm.
 */
function extractKeywordQueries(
  canonical: string,
  sentenceCandidates: ScoredCandidate[],
  config: PhraseExtractionConfig,
  titleWindow: TitleWindowTerms,
): AcademicSearchQuery[] {
  if (config.keywordQueryCount <= 0) return [];
  const topicTerms = extractTopicTerms(canonical, config.keywordTopicTermCount, titleWindow);

  const queries: AcademicSearchQuery[] = [];
  const seenBags = new Set<string>();
  for (const candidate of sentenceCandidates.slice(0, config.keywordQueryCount)) {
    // tokens(), not a raw whitespace split — candidate.text still carries the
    // sentence's own punctuation (canonicalizeText does not strip it), and a
    // trailing comma glued onto a word (e.g. "verbally,") would otherwise
    // silently defeat the COMMON_WORDS check and reach the query unclean.
    const sentenceWords = tokens(candidate.text)
      .filter(isInformativeWord)
      .filter((word) => !LIKELY_VERB_OR_ADVERB_SUFFIX.test(word))
      .sort((a, b) => b.length - a.length)
      .slice(0, config.keywordMaxSentenceWords);
    const bagWords = [...new Set([...topicTerms, ...sentenceWords])];
    if (bagWords.length < config.minInformativeWords) continue; // too little real signal to bother searching
    const bagText = bagWords.join(" ");
    const key = bagText.toLowerCase();
    if (seenBags.has(key)) continue; // e.g. a short document whose topic terms already cover a whole sentence
    seenBags.add(key);
    queries.push({ queryText: bagText, rank: 0, sourcePassage: candidate.text, queryType: "keyword" });
  }
  return queries;
}

/**
 * "Investigate two production issues" ISSUE 1: see topicOnlyQueryCount's
 * own comment for the full root-cause account. Returns at most one query
 * (topicOnlyQueryCount is 0 or 1) built from nothing but the whole
 * document's own recurring topic terms — reuses the exact same
 * extractTopicTerms this file already computes for extractKeywordQueries,
 * not a second "what is this document about" pass. Tagged queryType
 * "keyword" (not a new type): it is the same kind of short, high-precision
 * signal candidate-ranker.ts's foundByKeywordQuery bonus already exists to
 * reward, and every other caller that switches on queryType only
 * distinguishes "sentence" from "keyword" today — introducing a third
 * value would be a wider, unrelated change for no behavioral benefit.
 */
function extractTopicOnlyQuery(canonical: string, config: PhraseExtractionConfig, titleWindow: TitleWindowTerms): AcademicSearchQuery[] {
  if (config.topicOnlyQueryCount <= 0) return [];
  const topicTerms = extractTopicTerms(canonical, config.keywordTopicTermCount, titleWindow);
  // NOT config.minInformativeWords: that floor is calibrated for a MIXED
  // bag (topic terms + per-sentence words, see extractKeywordQueries)
  // reaching real signal together, and topicTerms alone is capped at
  // keywordTopicTermCount (3 by default) — strictly less than
  // minInformativeWords (4), which would make this branch unreachable by
  // construction for every document, defeating the whole query. Any
  // recurring topic term at all is real signal on its own; only truly
  // empty input has nothing worth querying.
  if (topicTerms.length === 0) return [];
  const queryText = topicTerms.join(" ");
  return [{ queryText, rank: 0, sourcePassage: queryText, queryType: "keyword" }];
}

/**
 * Extracts approximately minQueries-maxQueries distinctive, search-worthy
 * phrases from submission text, prioritizing longer meaningful phrases,
 * uncommon word combinations, and lexically unique/academic-sounding
 * sentences over generic ones. Never searches every sentence — a document
 * with 200 sentences still yields at most config.maxQueries candidates.
 *
 * Returns the existing sentence-based queries first, then up to
 * config.keywordQueryCount companion keyword queries (Phase 5) — a bounded,
 * additive supplement for candidate discovery under heavy paraphrasing, see
 * extractKeywordQueries above — then at most one more topic-only query (see
 * topicOnlyQueryCount's own comment).
 */
export function extractCandidatePhrases(
  rawText: string,
  config: PhraseExtractionConfig = DEFAULT_PHRASE_EXTRACTION_CONFIG,
): AcademicSearchQuery[] {
  const canonical = canonicalizeText(sanitizeExtractionArtifacts(rawText));
  if (!canonical) return [];

  const candidates: ScoredCandidate[] = [];
  const seenText = new Set<string>();
  let position = 0;

  for (const sentence of splitSentences(canonical)) {
    for (const window of windowSentence(sentence, config.maxWordsPerPhrase)) {
      position += 1;
      const wordCount = window.split(/\s+/).filter(Boolean).length;
      if (wordCount < config.minWordsPerPhrase) continue;

      const key = window.toLowerCase();
      if (seenText.has(key)) continue;
      seenText.add(key);

      const score = scoreCandidate(window, config);
      if (score === null) continue;
      candidates.push({ text: window, position, score });
    }
  }

  // Highest-scoring first; original document position as a deterministic
  // tiebreaker so equal scores never depend on array iteration order.
  candidates.sort((a, b) => b.score - a.score || a.position - b.position);

  const sentenceQueries = candidates.slice(0, config.maxQueries).map((candidate, index) => ({
    queryText: candidate.text,
    rank: index,
    sourcePassage: candidate.text,
    queryType: "sentence" as const,
  }));
  const titleWindow = extractTitleTerms(canonical, config);
  const keywordQueries = extractKeywordQueries(canonical, candidates, config, titleWindow);
  const seenKeywordBags = new Set(keywordQueries.map((query) => query.queryText.toLowerCase()));
  const topicOnlyQueries = extractTopicOnlyQuery(canonical, config, titleWindow)
    .filter((query) => !seenKeywordBags.has(query.queryText.toLowerCase())); // e.g. a short document whose only keyword bag already IS the topic terms alone

  return [...sentenceQueries, ...keywordQueries, ...topicOnlyQueries].map((query, index) => ({ ...query, rank: index }));
}
