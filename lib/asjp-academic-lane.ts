import { DerivedSourceSidecarSet } from "./corpus-engine/derived-source";
import { CorpusGenerationError } from "./corpus-engine/generation";
import { docIdFromDecimal } from "./corpus-engine/ids";
import { CorpusGenerationReader } from "./corpus-engine/reader";
import { retrieveCandidates } from "./corpus-engine/retrieval";
import type { CorpusObjectStore } from "./corpus-engine/storage";
import { admitCandidates, finalizeVerification } from "./corpus-engine/verifier-adapter";
import { runWithScoringNormalization } from "./scoring-normalization-scope";
import { SELECTIVE_CORPUS_STRICT_SPAN } from "./selective-corpus/constants";
import { tokensForScoringNormalization, tokenSpans } from "./similarity-core";

/**
 * ASJP academic-publication lane — published Algerian journal articles (asjp.cerist.dz) as their own evidence lane.
 *
 * It is separate from every existing lane: it reads only a pinned ASJP generation of the Corpus Engine, it never
 * reads or writes Archive records, imported Turnitin evidence units, Selective Corpus or prior uploads, and nothing in
 * the report path calls it yet. Its output enters a score only through computeUnifiedSimilarity's
 * asjpPublicationEvidence channel, where a position another lane already credited is counted once.
 *
 * A source is credited only when ALL of these hold:
 *   1. the article's TEXT is in the pinned generation (a retrieved, extracted, English-verified PDF body);
 *   2. the catalog confirms the source identity (the generation record's provider / ASJP id / canonical URL) and a
 *      licence that permits this use — an article the catalog does not know, or holds for licensing, earns nothing;
 *   3. the existing verifier admits it under the frozen STRICT_SPAN / FAMILY_GUARD rules, unchanged (a title, an
 *      abstract-sized or a generic-phrase overlap does not pass them);
 *   4. each credited manuscript position is found again, verbatim, in that article's indexed text by this module's own
 *      token comparison. A position the verifier credited but this check cannot place in the source is dropped;
 *   5. context: a passage counts only inside a cluster of the source's passages (each at most ASJP_CONTEXT_GAP_WORDS
 *      from the next) that holds a verbatim run of at least ASJP_CONTEXT_ANCHOR_WORDS. An admitted article does not
 *      lend credit to an isolated short phrase elsewhere in the manuscript (an institution name, a stock formula).
 *
 * PUBLISHED WORK COUNTS (owner decision 2026-10-13). An article that is the manuscript's own published version, or
 * shares its authors, is credited like any other verified source: similarity is not automatically plagiarism. It is
 * ATTRIBUTED separately (relationship SAME_WORK_PUBLISHED_VERSION, shown as previously published work) while its words
 * stay in the union. Same-work identity never removes a candidate or a match; sameWorkPolicy "exclude" exists only
 * to reproduce a benchmark that excluded it. The Archive lane's six-word rule and self-exclusion are not touched here.
 *
 * TIME-AWARE COMPARISON. With referenceDate set (the date of a historical report being reproduced), an article
 * published after that date is not credited (PUBLISHED_AFTER_REFERENCE_DATE), and one whose publication date cannot
 * be placed before it is not credited either but flagged (PUBLICATION_DATE_UNCERTAIN). Both stay in the result with
 * their passages. Without referenceDate (a new submission today) every indexed article was published already.
 */

export const ASJP_ACADEMIC_LANE_VERSION = "asjp-academic-lane-v4";
export const ASJP_PROVIDER = "cerist-asjp";

/** Same-work thresholds: the Archive lane's self threshold (0.75), and a lower one when the titles agree. */
export const ASJP_SAME_WORK_CONTAINMENT = 0.75;
/** With a matching title, a published article holding this share of the manuscript is a version of it (a revised or
 *  retitled version still shares most title words; measured: 0.49-0.69 on three such manuscripts). */
export const ASJP_SAME_WORK_TITLE_CONTAINMENT = 0.3;
/** Share of the article title's words that must stand in the manuscript's title or opening. */
export const ASJP_SAME_WORK_TITLE_WORD_SHARE = 0.6;
/** A verbatim run shorter than this cannot place a credited position in the source. */
export const ASJP_MINIMUM_VERBATIM_RUN = 6;
/** The run a cluster of passages needs to count: the frozen STRICT_SPAN longest-span requirement. */
export const ASJP_CONTEXT_ANCHOR_WORDS = SELECTIVE_CORPUS_STRICT_SPAN.minLongestContiguousSpan;
/** Passages of one source at most this many manuscript words apart form one cluster. */
export const ASJP_CONTEXT_GAP_WORDS = 50;
/**
 * v2 CORRECTIONS (all three on by default; each can be switched off to measure it alone):
 *   selfOverlapLabels   a matching title with containment >= ASJP_SAME_WORK_TITLE_MIN_CONTAINMENT also marks the
 *                       article as the manuscript's published version; an author surname of the article in the
 *                       manuscript's byline (first ASJP_BYLINE_WORDS words) marks it SAME_AUTHORS_OTHER_WORK. Labels
 *                       only: a credited article stays credited with the same words.
 *   genericFilter       CORPUS-GROUNDED: a credited cluster whose longest verbatim run is shorter than
 *                       ASJP_GENERIC_MAX_RUN words is not credited when that exact run stands in at least
 *                       ASJP_GENERIC_MIN_OTHER_ARTICLES OTHER indexed articles (journal templates, citation formulae,
 *                       software output legends, much-quoted titles). Measured on the index at query time.
 *   verbatimCompletion  for an admitted, verbatim-supported article, every maximal verbatim run of at least
 *                       ASJP_CONTEXT_ANCHOR_WORDS words between the manuscript and the article's indexed text that the
 *                       verifier did not return (numeric tables it does not anchor on) is added.
 */
export type AsjpMatchingCorrections = { selfOverlapLabels?: boolean; genericFilter?: boolean; verbatimCompletion?: boolean; verbatimRescue?: boolean; rescueMinVerifiedWords?: number; rescueFastPath?: boolean; runMerge?: boolean; structuralFilter?: boolean; annotations?: boolean };
/**
 * v3 rescue pre-filter: only a candidate in which the verifier itself verified at least two minimum verbatim runs
 * (2 x 6 words) is re-read; the rescue still needs >= 60 exact verbatim words with a 25-word run. A pre-filter of 30
 * was answer-identical on the 563 manuscripts but lost a 90-word copied passage the verifier had verified only 19
 * words of (B054 splice), so the bar is set by the run size, not by the cases seen.
 */
export const ASJP_RESCUE_MIN_VERIFIED_WORDS = 2 * 6;
/**
 * v3 CORRECTIONS (on by default):
 *   verbatimRescue    a candidate the verifier verified spans in but did not admit is admitted when the lane's own exact
 *                     verbatim runs against its text meet the SAME frozen STRICT_SPAN thresholds (>= 60 words in all, a
 *                     run >= 25). The verifier fragments some verbatim passages at grams that are common in the corpus.
 *   runMerge          inside a maximal verbatim run of >= ASJP_CONTEXT_ANCHOR_WORDS words that already touches a
 *                     supported passage, the words the verifier skipped (any number) are filled in, and pieces that
 *                     continue each other in BOTH texts are joined: a 31-word run returned as 19 + 11 anchors.
 *   structuralFilter  a credited cluster shorter than ASJP_GENERIC_MAX_RUN words whose text is STRUCTURALLY boilerplate
 *                     or bibliographic is not credited, with its evidence recorded: a short unit repeated (template
 *                     placeholder), a citation (numbers + bibliographic vocabulary), a name or title (title-case
 *                     words), an abbreviation legend (acronyms). Features of the text's form only, never phrase lists.
 *   annotations       no change to the score: a cluster with the form of a legal provision is annotated
 *                     LEGAL_PRIMARY_TEXT (quoted or not), and a cluster other indexed articles also hold is annotated
 *                     SHARED_TEXT with their number, so neither is presented as the article's unique origin.
 */
export type AsjpStructuralCategory = "PLACEHOLDER_REPETITION" | "BIBLIOGRAPHIC_CITATION" | "NAME_OR_TITLE" | "ABBREVIATION_LEGEND";
/**
 * v4 labels of credited clusters (no score change):
 *   LEGAL_PRIMARY_TEXT    the form of a legal provision: a legal instrument named around it + quoted or statutory text
 *   RELIGIOUS_TEXT        the form of a scripture quotation: a scripture named around it + quoted or short
 *   SHARED_QUOTATION      quoted text other indexed articles also hold (not legal / religious)
 *   SHARED_ACADEMIC_TEXT  unquoted text other indexed articles also hold: common academic wording, origin not known
 *   STRUCTURAL_FORM       a citation / title / acronym-legend form (no longer removed: v4 removes repetition only)
 * namedSource is the instrument or scripture as the manuscript names it (or null); originEstablished is always false:
 * the lane knows where the words stand in the index, never which text they first came from.
 */
export type AsjpAnnotationKind = "LEGAL_PRIMARY_TEXT" | "RELIGIOUS_TEXT" | "SHARED_QUOTATION" | "SHARED_ACADEMIC_TEXT" | "STRUCTURAL_FORM";
export type AsjpAnnotation = { submittedWordStart: number; submittedWordEnd: number; words: number; kind: AsjpAnnotationKind; quoted?: boolean; markers?: string[]; otherArticles?: number; namedSource?: string | null; originEstablished?: false; category?: AsjpStructuralCategory; evidence?: Record<string, number | string> };
export const ASJP_SAME_WORK_TITLE_MIN_CONTAINMENT = 0.05;
export const ASJP_BYLINE_WORDS = 120;
export const ASJP_GENERIC_MAX_RUN = 60;
export const ASJP_GENERIC_MIN_OTHER_ARTICLES = 3;
/** Candidates whose text is read when measuring how many articles hold a run. */
export const ASJP_GENERIC_CANDIDATES_CHECKED = 60;
/**
 * The scoring normalization the ASJP generations are built with. Positions this lane returns index the manuscript's
 * tokens under THIS version; a caller may union them with other lanes only for a report scored under the same one.
 */
export const ASJP_LANE_SCORING_NORMALIZATION = 2 as const;

export function isAsjpAcademicLaneEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ASJP_ACADEMIC_LANE_ENABLED === "true";
}

/** What the catalog knows about one indexed article version. */
export type AsjpCatalogEntry = {
  articleId: string;
  canonicalUrl: string;
  title: string | null;
  authors: string[] | null;
  journal: string | null;
  issn: string | null;
  publicationDate: string | null;
  doi: string | null;
  license: string | null;
  licenseBasis: string | null;
  /** PERMITTED (CC BY / CC BY-SA / CC0 stated by the PDF or the journal's DOAJ record), RESTRICTED (-NC, -ND, all
   *  rights reserved), CONFLICTING (two different statements) or UNKNOWN (no licence record). Absent = UNKNOWN. */
  licenceStatus?: AsjpLicenceStatus;
  /** True only for PERMITTED. */
  reusePermitted: boolean;
  /** True when the article was withdrawn from the index after it was built (takedown, licence change). */
  withdrawn: boolean;
};
export type AsjpCatalogLookup = (articleId: string) => AsjpCatalogEntry | null | undefined;
export type AsjpLicenceStatus = "PERMITTED" | "RESTRICTED" | "CONFLICTING" | "UNKNOWN";
/**
 * "permitted-only" (the default): only a PERMITTED article can be credited.
 * "local-research-all": every indexed article can be credited, whatever its licence status, for the isolated local
 * research corpus. Not for Production or customer-facing reports without a separate release decision.
 */
export type AsjpLicencePolicy = "permitted-only" | "local-research-all";
const licenceStatusOf = (entry: AsjpCatalogEntry): AsjpLicenceStatus => entry.licenceStatus ?? (entry.reusePermitted ? "PERMITTED" : "UNKNOWN");

export type AsjpMatchedPassage = {
  submittedWordStart: number;
  /** Inclusive, the convention every other lane's passages use. */
  submittedWordEnd: number;
  matchedWordCount: number;
  /** Where the same words stand in the article's indexed text (token indices, inclusive; character offsets, end-exclusive). */
  sourceWordStart: number;
  sourceWordEnd: number;
  sourceCharStart: number;
  sourceCharEnd: number;
};

export type AsjpRelationship = "INDEPENDENT_PUBLICATION" | "SAME_WORK_PUBLISHED_VERSION" | "SAME_AUTHORS_OTHER_WORK";
export type AsjpNotCreditedReason =
  | "UNVERIFIED_SOURCE_IDENTITY"
  | "NOT_IN_CATALOG"
  | "LICENCE_NOT_PERMITTING"
  | "WITHDRAWN"
  | "NOT_ADMITTED_BY_VERIFIER"
  | "NO_VERBATIM_SOURCE_SUPPORT"
  | "ONLY_ISOLATED_SHORT_PASSAGES"
  | "GENERIC_COMMON_TEXT"
  | "STRUCTURAL_BOILERPLATE"
  | "SAME_WORK_EXCLUDED_BY_POLICY"
  | "PUBLISHED_AFTER_REFERENCE_DATE"
  | "PUBLICATION_DATE_UNCERTAIN"
  | "SOURCE_TEXT_UNAVAILABLE";

export type AsjpLaneSource = {
  /** `asjp:<article id>` — the id the union deduplicates on. */
  sourceId: string;
  docId: string;
  publication: AsjpCatalogEntry | null;
  relationship: AsjpRelationship | null;
  credited: boolean;
  notCreditedReason: AsjpNotCreditedReason | null;
  /** The verifier's own reason when it did not admit the source. */
  verifierReason: string | null;
  matchedPassages: AsjpMatchedPassage[];
  matchedWordCount: number;
  longestSpan: number;
  /** Matched words over the manuscript's words. */
  containmentOfSubmission: number;
  /** Verifier-credited positions this module could not place verbatim in the source (dropped). */
  unsupportedWords: number;
  /** Verbatim-supported words dropped because their passage stood outside any anchored cluster (gate 5). */
  isolatedWords: number;
  /** v2: words of clusters not credited as generic text, and words added by verbatim completion. */
  genericWords: number;
  completionWords: number;
  /** v2: the generic clusters set aside, with the number of other indexed articles holding their longest run. */
  genericClusters: Array<{ submittedWordStart: number; submittedWordEnd: number; words: number; otherArticles: number }>;
  /** v3: admitted by the lane's verbatim runs after the verifier did not admit it. */
  admittedBy: "VERIFIER" | "VERBATIM_RESCUE" | null;
  /** v3: clusters set aside as structural boilerplate / bibliographic text, with the evidence. */
  structuralClusters: Array<{ submittedWordStart: number; submittedWordEnd: number; words: number; category: AsjpStructuralCategory; evidence: Record<string, number | string> }>;
  structuralWords: number;
  /** v3: annotations of credited clusters (no score change). */
  annotations: AsjpAnnotation[];
  /** v2: article author surnames found in the manuscript's byline. */
  authorMatches: string[];
  /** Why the article is classed as the manuscript's own published version; null for an independent publication. */
  sameWorkBasis: "CONTAINMENT" | "TITLE_AND_CONTAINMENT" | "TITLE" | null;
  /** Against request.referenceDate: BEFORE, AFTER, UNCERTAIN; null when no reference date was given. */
  publicationTiming: "BEFORE" | "AFTER" | "UNCERTAIN" | null;
};

export type AsjpLaneResult =
  | { version: typeof ASJP_ACADEMIC_LANE_VERSION; state: "DISABLED" }
  | { version: typeof ASJP_ACADEMIC_LANE_VERSION; state: "FAILED"; failureCode: string; failureMessage: string }
  | {
      version: typeof ASJP_ACADEMIC_LANE_VERSION;
      /** COMPLETE only when retrieval and verification both covered the whole generation. */
      state: "COMPLETE" | "PARTIAL";
      generationId: string;
      logicalManifestSha256: string;
      submissionWordCount: number;
      candidates: number;
      sources: AsjpLaneSource[];
      /** Union of the credited sources' positions, ascending. */
      creditedPositions: number[];
      /** v3: credited positions inside clusters annotated LEGAL_PRIMARY_TEXT (they stay in creditedPositions). */
      legalAnnotatedPositions: number[];
      timings: { openMs: number; retrievalMs: number; verificationMs: number; supportMs: number; totalMs: number };
    };

export type AsjpLaneRequest = {
  store: CorpusObjectStore;
  /** The ASJP generation to search. Required: a request never means "the latest". */
  generationId: string;
  logicalManifestSha256?: string;
  submissionText: string;
  /** The manuscript's title when the caller has it; otherwise the manuscript's opening is used for the same-title test. */
  submissionTitle?: string | null;
  catalog: AsjpCatalogLookup;
  licencePolicy?: AsjpLicencePolicy;
  /** "credit" (default): previously published work counts. "exclude": reproduce a benchmark that excluded it. */
  sameWorkPolicy?: "exclude" | "credit";
  /** v2 corrections; each defaults to on. */
  corrections?: AsjpMatchingCorrections;
  /** ISO date (YYYY-MM-DD) of the historical report being reproduced; absent for a new submission. */
  referenceDate?: string | null;
  /** Skip the feature flag (offline evaluation only). */
  ignoreFlag?: boolean;
  /**
   * A session opened once with openAsjpLaneSession and reused across requests: the generation reader (and its
   * dictionary cache) stays open, and verification reads candidates from the derived-source sidecar where one is
   * accepted. Same answers as a request without one; generationId must match the session's.
   */
  session?: AsjpLaneSession;
  dictionaryCacheBytes?: number;
};

/** Start positions of every `size`-gram of `words`, keyed by the gram. */
function gramStarts(words: readonly string[], size: number): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let start = 0; start + size <= words.length; start += 1) {
    const key = words.slice(start, start + size).join(" ");
    const starts = index.get(key);
    if (starts) starts.push(start);
    else index.set(key, [start]);
  }
  return index;
}

/**
 * The parts of submission[start..end] that stand verbatim in the source, as maximal runs of at least
 * ASJP_MINIMUM_VERBATIM_RUN words, each with where it stands in the source. Greedy from the left; the longest
 * source occurrence wins, the earliest on a tie.
 */
export function verbatimRunsInSource(
  submission: readonly string[],
  start: number,
  end: number,
  source: readonly string[],
  sourceGrams: Map<string, number[]>,
): Array<{ submittedWordStart: number; submittedWordEnd: number; sourceWordStart: number; sourceWordEnd: number }> {
  const runs: Array<{ submittedWordStart: number; submittedWordEnd: number; sourceWordStart: number; sourceWordEnd: number }> = [];
  const size = ASJP_MINIMUM_VERBATIM_RUN;
  let position = start;
  while (position + size <= end + 1) {
    const starts = sourceGrams.get(submission.slice(position, position + size).join(" "));
    if (!starts) { position += 1; continue; }
    let bestLength = 0;
    let bestSource = -1;
    for (const sourceStart of starts) {
      let length = size;
      while (position + length <= end && sourceStart + length < source.length && submission[position + length] === source[sourceStart + length]) length += 1;
      if (length > bestLength) { bestLength = length; bestSource = sourceStart; }
    }
    runs.push({ submittedWordStart: position, submittedWordEnd: position + bestLength - 1, sourceWordStart: bestSource, sourceWordEnd: bestSource + bestLength - 1 });
    position += bestLength;
  }
  return runs;
}

/**
 * The ASJP identity a generation record carries: its canonical source, or an alias (the same text supplied again),
 * whose provider is ASJP and whose external id is an ASJP article number. Null when the record names no ASJP article.
 */
function asjpIdentityOf(record: Record<string, unknown>, laterAliases: readonly unknown[]): { externalId: string; canonicalUrl: string | null } | null {
  const named = [record.canonicalSource, ...(Array.isArray(record.aliases) ? record.aliases : []), ...laterAliases];
  for (const candidate of named) {
    if (!candidate || typeof candidate !== "object") continue;
    const source = candidate as Record<string, unknown>;
    if (source.provider !== ASJP_PROVIDER || typeof source.externalId !== "string" || !/^\d+$/.test(source.externalId)) continue;
    return { externalId: source.externalId, canonicalUrl: typeof source.canonicalUrl === "string" ? source.canonicalUrl : null };
  }
  return null;
}

/**
 * Where a publication date stands against a reference date. Dates are compared as far as the publication date goes:
 * a full date by day; a year-and-month or a year alone is BEFORE / AFTER only when the whole period is, else UNCERTAIN.
 * A missing or unreadable date is UNCERTAIN: availability is never assumed.
 */
export function publicationTimingOf(publicationDate: string | null | undefined, referenceDate: string): "BEFORE" | "AFTER" | "UNCERTAIN" {
  const reference = String(referenceDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const published = String(publicationDate ?? "").trim().match(/^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/);
  if (!reference || !published) return "UNCERTAIN";
  const pad = (value: string) => value.padStart(2, "0");
  const ref = `${reference[1]}-${reference[2]}-${reference[3]}`;
  const earliest = `${published[1]}-${pad(published[2] ?? "01")}-${pad(published[3] ?? "01")}`;
  const latest = `${published[1]}-${pad(published[2] ?? "12")}-${pad(published[3] ?? "31")}`;
  if (latest <= ref) return "BEFORE";
  if (earliest > ref) return "AFTER";
  return "UNCERTAIN";
}

/** v3 card fields, present only when the source carries annotations (v1/v2 card shapes are unchanged otherwise). */
function annotationWordsOf(source: AsjpLaneSource): { legalWords?: number; religiousWords?: number; sharedWords?: number; structuralFormWords?: number } {
  if (!source.annotations?.length) return {};
  const sum = (kinds: string[]) => source.annotations.filter((a) => kinds.includes(a.kind)).reduce((t, a) => t + a.words, 0);
  return { legalWords: sum(["LEGAL_PRIMARY_TEXT"]), religiousWords: sum(["RELIGIOUS_TEXT"]), sharedWords: sum(["SHARED_QUOTATION", "SHARED_ACADEMIC_TEXT"]) + source.annotations.filter((a) => (a.kind === "LEGAL_PRIMARY_TEXT" || a.kind === "RELIGIOUS_TEXT") && (a.otherArticles ?? 0) > 0).reduce((t, a) => t + a.words, 0), structuralFormWords: sum(["STRUCTURAL_FORM"]) };
}

/** Share of a source's credited words in clusters labelled with one of `kinds` (all primary-source / shared kinds by default). */
function sharedShare(source: AsjpLaneSource, kinds: string[] = ["LEGAL_PRIMARY_TEXT", "RELIGIOUS_TEXT", "SHARED_QUOTATION", "SHARED_ACADEMIC_TEXT"]): number {
  if (!source.matchedWordCount) return 0;
  const covered = new Set<number>();
  for (const a of source.annotations) if (kinds.includes(a.kind)) for (let q = a.submittedWordStart; q <= a.submittedWordEnd; q += 1) covered.add(q);
  let words = 0;
  for (const p of source.matchedPassages) for (let q = p.submittedWordStart; q <= p.submittedWordEnd; q += 1) if (covered.has(q)) words += 1;
  return words / source.matchedWordCount;
}

const BIBLIOGRAPHIC_WORDS = new Set(["no", "nos", "vol", "vols", "pp", "p", "ed", "eds", "edition", "journal", "review", "gazette", "official", "issue", "press", "publishing", "publishers", "publisher", "university", "isbn", "issn", "doi", "http", "https", "www", "retrieved", "available", "accessed", "volume", "number", "proceedings", "bulletin"]);
const STOP_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with", "which", "may", "be", "is", "are", "its", "their", "that", "this", "s"]);
const LEGAL_WORDS = new Set(["article", "articles", "law", "laws", "decree", "ordinance", "shall", "hereby", "paragraph", "provisions", "convention", "covenant", "charter", "statute", "constitution", "constitutional", "code", "declaration", "protocol", "treaty", "parties", "amendment", "promulgated", "promulgation", "pursuant", "court", "jurisdiction"]);

/**
 * The structural form of a short credited cluster, or null. Each test is a property of the text's FORM, with the
 * measured features returned as evidence:
 *   PLACEHOLDER_REPETITION  a unit of 5–30 words repeated so that >= 80% of the cluster repeats it (template filler)
 *   BIBLIOGRAPHIC_CITATION  >= 2 numbers AND >= 2 bibliographic words, together >= 20% of the words (a reference)
 *   NAME_OR_TITLE           <= 40 words, >= 6 content words, >= 85% of them Title-Case in the manuscript (a title or name)
 *   ABBREVIATION_LEGEND     >= 4 all-caps acronyms making >= 15% of the words (an output / abbreviation legend)
 */
export function structuralForm(tokens: readonly string[], original: string): { category: AsjpStructuralCategory; evidence: Record<string, number | string> } | null {
  const n = tokens.length;
  if (n === 0) return null;
  const repeated = repetitionForm(tokens);
  if (repeated) return repeated;
  const numbers = tokens.filter((t) => /^\d+$/.test(t)).length;
  const biblio = tokens.filter((t) => BIBLIOGRAPHIC_WORDS.has(t)).length;
  if (numbers >= 2 && biblio >= 2 && (numbers + biblio) / n >= 0.2) return { category: "BIBLIOGRAPHIC_CITATION", evidence: { numbers, bibliographicWords: biblio, share: +((numbers + biblio) / n).toFixed(3) } };
  const words = original.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
  const content = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()) && w.length >= 3);
  const titleCase = content.filter((w) => /^\p{Lu}/u.test(w)).length;
  if (n <= 40 && content.length >= 6 && titleCase / content.length >= 0.85) return { category: "NAME_OR_TITLE", evidence: { contentWords: content.length, titleCaseShare: +(titleCase / content.length).toFixed(3) } };
  const acronyms = words.filter((w) => w.length >= 2 && w === w.toUpperCase() && /\p{Lu}/u.test(w)).length;
  if (acronyms >= 4 && acronyms / Math.max(1, words.length) >= 0.15) return { category: "ABBREVIATION_LEGEND", evidence: { acronyms, acronymShare: +(acronyms / words.length).toFixed(3) } };
  return null;
}

/**
 * Template filler repeated within itself ("enter your abstract here … enter your abstract here …"): >= 80% of the
 * text's words lie in 4-word groups that recur >= 3 times inside the same text, each group holding >= 3 alphabetic
 * words (so numeric results tables never qualify). Robust to extraction artefacts ("th e", "a bstract") that shift a
 * repeat by a word. A property of form only; any length: genuine prose does not repeat itself like this.
 */
export function repetitionForm(tokens: readonly string[]): { category: AsjpStructuralCategory; evidence: Record<string, number | string> } | null {
  const n = tokens.length;
  const G = 4;
  if (n < 3 * G) return null;
  const counts = new Map<string, number>();
  const alphabetic = (t: string) => /\p{L}/u.test(t) && t.length >= 2;
  const keyAt = (i: number) => (tokens.slice(i, i + G).filter(alphabetic).length >= 3 ? tokens.slice(i, i + G).join(" ") : null);
  for (let i = 0; i + G <= n; i += 1) { const k = keyAt(i); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
  const covered = new Uint8Array(n);
  for (let i = 0; i + G <= n; i += 1) { const k = keyAt(i); if (k && counts.get(k)! >= 3) covered.fill(1, i, i + G); }
  const share = covered.reduce((t, c) => t + c, 0) / n;
  return share >= 0.8 ? { category: "PLACEHOLDER_REPETITION", evidence: { gramWords: G, minRecurrences: 3, repeatedShare: +share.toFixed(3) } } : null;
}

/** v3 legal annotation: clusters of at most this many credited words (a quotation, not a reused section) */
export const ASJP_LEGAL_MAX_CLUSTER_WORDS = 150;
/** v3 legal annotation: manuscript words before a cluster searched for the instrument it quotes */
export const ASJP_LEGAL_CONTEXT_WORDS = 40;
/** v3 legal annotation: an UNQUOTED cluster counts as reproduced statutory text only up to this many credited words */
export const ASJP_LEGAL_UNQUOTED_MAX_WORDS = 80;
/** A legal instrument referred to: "Article 11", "Art. 30(1)", or an instrument noun (constitution, covenant, …). */
const INSTRUMENT_REFERENCE = /\b(?:art(?:icle)?s?\.?\s*\(?\d+|constitution|covenant|declaration|statute|convention|charter|treaty|protocol|code|decree|ordinance|law\s+(?:no|n°|number)\.?\s*\d+|act\s+(?:no|of))(?![\p{L}])/iu;
/** v4: a scripture referred to (category vocabulary, not phrases of any manuscript). */
const SCRIPTURE_REFERENCE = /\b(?:qur['’\s]?an|koran|surah?|sura|ayah|hadith|sunnah|bible|biblical|gospel|psalms?|torah|scripture)(?![\p{L}])/iu;
/** v4: words after a cluster searched for the source it quotes ("… (Qur'an 5:32)") */
export const ASJP_PRIMARY_SOURCE_AFTER_WORDS = 15;

/**
 * v4: the form of a scripture quotation (label only): a scripture is named in the cluster or around it, and the
 * cluster is quoted or at most ASJP_LEGAL_UNQUOTED_MAX_WORDS credited words. Checked before the legal form.
 */
export function religiousForm(words: number, before: string, after: string, context: string): { markers: string[]; quoted: boolean } | null {
  const scripture = context.match(SCRIPTURE_REFERENCE);
  if (!scripture) return null;
  const quoted = QUOTATION_MARK.test(before) || QUOTATION_MARK.test(after);
  if (!quoted && words > ASJP_LEGAL_UNQUOTED_MAX_WORDS) return null;
  return { markers: [scripture[0].toLowerCase().replace(/\s+/g, " ")], quoted };
}

/**
 * The form of a quoted or verbatim legal provision (annotation only; nothing is removed from the score):
 *   an instrument is referred to in the cluster or the ASJP_LEGAL_CONTEXT_WORDS words before it (`context`), AND
 *   either a quotation mark opens / closes at the cluster's edge (`before` / `after`: the characters between the edge
 *   words and their neighbours) or the cluster reads as statutory text (>= 2 distinct legal words, >= 6% of its words).
 * Calibrated on the Phase-2 audit (ICCPR, UDHR, Rome Statute quotations annotated; a constitution passage paraphrased
 * without quotation marks or a named instrument is not, and stays recorded only as text other articles share).
 */
export function legalForm(tokens: readonly string[], before: string, after: string, context: string): { markers: string[]; quoted: boolean } | null {
  const instrument = context.match(INSTRUMENT_REFERENCE);
  if (!instrument) return null;
  const quoted = QUOTATION_MARK.test(before) || QUOTATION_MARK.test(after);
  const legal = tokens.filter((t) => LEGAL_WORDS.has(t));
  const markers = [...new Set(legal)];
  const statutory = markers.length >= 2 && legal.length / Math.max(1, tokens.length) >= 0.06;
  if (!quoted && !statutory) return null;
  return { markers: [instrument[0].toLowerCase().replace(/\s+/g, " "), ...markers.filter((m) => m !== instrument[0].toLowerCase())], quoted };
}
const QUOTATION_MARK = /["“”«»]/;

/** v3: joins, in place, passages that continue each other in both the manuscript and the source (one verbatim run). */
export function mergeContiguousRuns(passages: AsjpMatchedPassage[]): void {
  passages.sort((left, right) => left.submittedWordStart - right.submittedWordStart);
  const merged: AsjpMatchedPassage[] = [];
  for (const passage of passages) {
    const last = merged[merged.length - 1];
    if (last && passage.submittedWordStart === last.submittedWordEnd + 1 && passage.sourceWordStart === last.sourceWordEnd + 1) {
      last.submittedWordEnd = passage.submittedWordEnd; last.sourceWordEnd = passage.sourceWordEnd; last.sourceCharEnd = passage.sourceCharEnd;
      last.matchedWordCount = last.submittedWordEnd - last.submittedWordStart + 1;
    } else merged.push({ ...passage });
  }
  passages.splice(0, passages.length, ...merged);
}

/** Passages of one source (manuscript order) at most ASJP_CONTEXT_GAP_WORDS apart, as clusters. */
export function clusterPassages<P extends { submittedWordStart: number; submittedWordEnd: number }>(passages: readonly P[]): P[][] {
  const ordered = [...passages].sort((left, right) => left.submittedWordStart - right.submittedWordStart);
  const clusters: P[][] = [];
  for (const passage of ordered) {
    const last = clusters[clusters.length - 1];
    if (last && passage.submittedWordStart - last[last.length - 1].submittedWordEnd - 1 <= ASJP_CONTEXT_GAP_WORDS) last.push(passage);
    else clusters.push([passage]);
  }
  return clusters;
}

/**
 * v3.1 rescue fast path (exact). For a candidate the verifier did not admit, the full search (maximalVerbatimRuns over
 * the whole manuscript) is needed only if the verbatim runs could still reach STRICT_SPAN. A necessary condition:
 *   every maximal verbatim run of >= ASJP_MINIMUM_VERBATIM_RUN words is a chain of 6-word groups the source holds, so
 *   (a) the manuscript words covered by groups the source holds >= the words the kept (disjoint) runs can total, and
 *   (b) the longest chain of consecutive held groups + 5 >= the longest run.
 * Groups are compared as hashes of per-request integer word ids; a collision can only make a group look held, i.e.
 * loosen the bound, never reject a candidate the full search would admit. When the bound passes, nothing changes.
 */
export type RescueSubmissionIndex = { ids: Map<string, number>; keys: Float64Array; keySet: Set<number> };
const GROUP = ASJP_MINIMUM_VERBATIM_RUN;
function groupKey(ids: ArrayLike<number>, at: number): number {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let k = 0; k < GROUP; k += 1) { a = Math.imul(a ^ ids[at + k], 0x01000193); b = Math.imul(b ^ ids[at + k], 0x5bd1e995); b ^= b >>> 15; }
  return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
}
export function rescueSubmissionIndex(submission: readonly string[]): RescueSubmissionIndex {
  const ids = new Map<string, number>();
  const seq = new Int32Array(submission.length);
  for (let i = 0; i < submission.length; i += 1) { let id = ids.get(submission[i]); if (id === undefined) { id = ids.size; ids.set(submission[i], id); } seq[i] = id; }
  const keys = new Float64Array(Math.max(0, submission.length - GROUP + 1));
  const keySet = new Set<number>();
  for (let i = 0; i + GROUP <= submission.length; i += 1) { keys[i] = groupKey(seq, i); keySet.add(keys[i]); }
  return { ids, keys, keySet };
}
export function rescueCanAdmit(index: RescueSubmissionIndex, source: readonly string[]): boolean {
  const seq = new Int32Array(source.length);
  for (let i = 0; i < source.length; i += 1) seq[i] = index.ids.get(source[i]) ?? -1;
  const held = new Set<number>();
  let unknownAt = -1; // last source position holding a word the manuscript never uses
  for (let i = 0; i < source.length; i += 1) {
    if (seq[i] < 0) unknownAt = i;
    if (i + 1 < GROUP || unknownAt > i - GROUP) continue;
    const key = groupKey(seq, i - GROUP + 1);
    if (index.keySet.has(key)) held.add(key);
  }
  if (held.size === 0) return false;
  let covered = 0, coveredTo = -1, chain = 0, longestChain = 0;
  for (let i = 0; i < index.keys.length; i += 1) {
    if (!held.has(index.keys[i])) { chain = 0; continue; }
    chain += 1; longestChain = Math.max(longestChain, chain);
    const end = i + GROUP - 1;
    covered += end - Math.max(coveredTo, i - 1);
    coveredTo = end;
  }
  return covered >= SELECTIVE_CORPUS_STRICT_SPAN.minMatchedWords && longestChain + GROUP - 1 >= SELECTIVE_CORPUS_STRICT_SPAN.minLongestContiguousSpan;
}

/** Every maximal verbatim run of at least minWords words between the whole manuscript and the source. */
export function maximalVerbatimRuns(submission: readonly string[], source: readonly string[], sourceGrams: Map<string, number[]>, minWords: number) {
  const runs: Array<{ submittedWordStart: number; submittedWordEnd: number; sourceWordStart: number; sourceWordEnd: number }> = [];
  const size = ASJP_MINIMUM_VERBATIM_RUN;
  for (let at = 0; at + size <= submission.length; at += 1) {
    const starts = sourceGrams.get(submission.slice(at, at + size).join(" "));
    if (!starts) continue;
    for (const sourceStart of starts) {
      if (at > 0 && sourceStart > 0 && submission[at - 1] === source[sourceStart - 1]) continue; // not the start of the run
      let length = size;
      while (at + length < submission.length && sourceStart + length < source.length && submission[at + length] === source[sourceStart + length]) length += 1;
      if (length >= minWords) runs.push({ submittedWordStart: at, submittedWordEnd: at + length - 1, sourceWordStart: sourceStart, sourceWordEnd: sourceStart + length - 1 });
    }
  }
  // one source occurrence per manuscript run (the first); runs sharing manuscript words keep the longest
  runs.sort((left, right) => (right.submittedWordEnd - right.submittedWordStart) - (left.submittedWordEnd - left.submittedWordStart) || left.submittedWordStart - right.submittedWordStart);
  const taken = new Set<number>();
  const kept: typeof runs = [];
  for (const run of runs) {
    let free = true;
    for (let q = run.submittedWordStart; q <= run.submittedWordEnd; q += 1) if (taken.has(q)) { free = false; break; }
    if (!free) continue;
    for (let q = run.submittedWordStart; q <= run.submittedWordEnd; q += 1) taken.add(q);
    kept.push(run);
  }
  return kept.sort((left, right) => left.submittedWordStart - right.submittedWordStart);
}

/**
 * How many indexed articles OTHER than `ownDocId` hold `run` verbatim: the index's own candidates for the run's
 * text, read in rank order (up to ASJP_GENERIC_CANDIDATES_CHECKED), stopping once ASJP_GENERIC_MIN_OTHER_ARTICLES
 * holders are found.
 */
async function otherArticlesHolding(reader: CorpusGenerationReader, run: readonly string[], ownDocId: string, cache: Map<string, number>): Promise<number> {
  const key = run.join(" ");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const retrieval = await retrieveCandidates(reader, key);
  let holders = 0;
  let checked = 0;
  for (const candidate of retrieval.candidates) {
    if (String(candidate.docId) === ownDocId) continue;
    if (checked >= ASJP_GENERIC_CANDIDATES_CHECKED || holders >= ASJP_GENERIC_MIN_OTHER_ARTICLES) break;
    checked += 1;
    const fetched = await reader.fetchText(docIdFromDecimal(String(candidate.docId)));
    if (fetched.state !== "OK") continue;
    if (` ${tokensForScoringNormalization(fetched.text, ASJP_LANE_SCORING_NORMALIZATION).join(" ")} `.includes(` ${key} `)) holders += 1;
  }
  cache.set(key, holders);
  return holders;
}

/** The article's author surnames (words of four letters or more) that stand in `byline`. */
function authorSurnamesIn(authors: string[] | null, byline: readonly string[]): string[] {
  const words = new Set(byline);
  const found = new Set<string>();
  for (const author of authors ?? []) {
    for (const word of tokensForScoringNormalization(String(author).split(",")[0] ?? "", ASJP_LANE_SCORING_NORMALIZATION)) {
      if (word.length >= 4 && words.has(word)) found.add(word);
    }
  }
  return [...found];
}

/**
 * Gate 5: the passages that stand in an anchored cluster. Passages (one source, manuscript order) at most
 * ASJP_CONTEXT_GAP_WORDS apart form a cluster; a cluster counts only if one of its passages is at least
 * ASJP_CONTEXT_ANCHOR_WORDS long.
 */
export function anchoredPassages<P extends { submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>(passages: readonly P[]): P[] {
  const ordered = [...passages].sort((left, right) => left.submittedWordStart - right.submittedWordStart);
  const kept: P[] = [];
  let cluster: P[] = [];
  const close = () => { if (cluster.some((passage) => passage.matchedWordCount >= ASJP_CONTEXT_ANCHOR_WORDS)) kept.push(...cluster); cluster = []; };
  for (const passage of ordered) {
    const last = cluster[cluster.length - 1];
    if (last && passage.submittedWordStart - last.submittedWordEnd - 1 > ASJP_CONTEXT_GAP_WORDS) close();
    cluster.push(passage);
  }
  close();
  return kept;
}

/**
 * True when the article title and the manuscript's title agree: the same words in a row, or (titles of four words or
 * more) at least ASJP_SAME_WORK_TITLE_WORD_SHARE of the shorter title's distinct words found in the other. When the
 * manuscript's title is not known its opening stands in for it, and the share is taken of the article title.
 */
function titlesAgree(sourceTitle: readonly string[], manuscript: readonly string[], manuscriptIsOpening: boolean): boolean {
  if (sourceTitle.length < 3) return false;
  if (titleStandsIn(sourceTitle, manuscript)) return true;
  const source = new Set(sourceTitle);
  const other = new Set(manuscript);
  const base = manuscriptIsOpening || source.size <= other.size ? source : other;
  const against = base === source ? other : source;
  if (base.size < 4) return false;
  let found = 0;
  for (const word of base) if (against.has(word)) found += 1;
  return found / base.size >= ASJP_SAME_WORK_TITLE_WORD_SHARE;
}

/** True when the title's words (at least three) stand as one run in `words`. */
function titleStandsIn(titleWords: readonly string[], words: readonly string[]): boolean {
  if (titleWords.length < 3 || titleWords.length > words.length) return false;
  for (let start = 0; start + titleWords.length <= words.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < titleWords.length; offset += 1) if (words[start + offset] !== titleWords[offset]) { same = false; break; }
    if (same) return true;
  }
  return false;
}

/**
 * Retrieval -> existing verifier -> identity / licence / verbatim-support gates, over one pinned ASJP generation.
 * Never throws: a failure is a FAILED result that says why.
 */
export async function runAsjpAcademicLane(request: AsjpLaneRequest): Promise<AsjpLaneResult> {
  if (!request.ignoreFlag && !isAsjpAcademicLaneEnabled()) return { version: ASJP_ACADEMIC_LANE_VERSION, state: "DISABLED" };
  return runWithScoringNormalization(ASJP_LANE_SCORING_NORMALIZATION, () => runLane(request));
}

export type AsjpLaneSession = { reader: CorpusGenerationReader; sidecars: DerivedSourceSidecarSet | null };

/**
 * Opens a generation once for many requests. useDerivedSourceSidecar: verify candidates from the generation's
 * derived-source sidecar (no stored text read) where one is present and its identity matches the running code;
 * a segment without an accepted sidecar is verified from its text exactly as before.
 */
export async function openAsjpLaneSession(options: { store: CorpusObjectStore; generationId: string; logicalManifestSha256?: string; dictionaryCacheBytes?: number; useDerivedSourceSidecar?: boolean }): Promise<AsjpLaneSession> {
  const reader = await CorpusGenerationReader.open({ store: options.store, generationId: options.generationId, expectedLogicalManifestSha256: options.logicalManifestSha256, dictionaryCacheBytes: options.dictionaryCacheBytes });
  const sidecars = options.useDerivedSourceSidecar ? await DerivedSourceSidecarSet.open(reader) : null;
  return { reader, sidecars };
}

async function runLane(request: AsjpLaneRequest): Promise<AsjpLaneResult> {
  const version = ASJP_ACADEMIC_LANE_VERSION;
  const started = performance.now();
  let reader: CorpusGenerationReader;
  try {
    if (request.session) {
      if (request.session.reader.identity().generationId !== request.generationId) throw new CorpusGenerationError("SESSION_GENERATION_MISMATCH", `session is open on ${request.session.reader.identity().generationId}, request names ${request.generationId}`);
      reader = request.session.reader;
    } else reader = await CorpusGenerationReader.open({
      store: request.store,
      generationId: request.generationId,
      expectedLogicalManifestSha256: request.logicalManifestSha256,
      dictionaryCacheBytes: request.dictionaryCacheBytes,
    });
  } catch (error) {
    return { version, state: "FAILED", failureCode: error instanceof CorpusGenerationError ? error.code : "UNEXPECTED", failureMessage: error instanceof Error ? error.message : String(error) };
  }
  try {
    const opened = performance.now();
    const retrieval = await retrieveCandidates(reader, request.submissionText);
    if (retrieval.state === "FAILED") {
      return { version, state: "FAILED", failureCode: retrieval.failures[0]?.code ?? "RETRIEVAL_FAILED", failureMessage: retrieval.failures[0]?.message ?? "retrieval failed" };
    }
    const retrieved = performance.now();
    const pass = await admitCandidates(reader, request.submissionText, retrieval.candidates.map((candidate) => candidate.docId), undefined, { sidecars: request.session?.sidecars ?? null });
    const verification = finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures, { verifierPath: pass.verifierPath, prepareMs: pass.prepareMs, familyPolicy: pass.familyPolicy });
    if (verification.state === "FAILED") {
      return { version, state: "FAILED", failureCode: verification.failures[0]?.code ?? "VERIFICATION_FAILED", failureMessage: verification.failures[0]?.message ?? "verification failed" };
    }
    const verified = performance.now();

    const submission = tokensForScoringNormalization(request.submissionText, ASJP_LANE_SCORING_NORMALIZATION);
    const submissionWordCount = submission.length;
    let submissionIndexMemo: RescueSubmissionIndex | null = null;
    const submissionIndex = () => (submissionIndexMemo ??= rescueSubmissionIndex(submission));
    const titleWords = request.submissionTitle ? tokensForScoringNormalization(request.submissionTitle, ASJP_LANE_SCORING_NORMALIZATION) : null;
    const submissionSpans = tokenSpans(request.submissionText, ASJP_LANE_SCORING_NORMALIZATION);
    const originalOf = (start: number, end: number) => request.submissionText.slice(submissionSpans[start]?.start ?? 0, submissionSpans[end]?.end ?? 0);
    // the characters between word `left` and word `right` (left -1: from the text's start; right = word count: to its end)
    const gapText = (left: number, right: number) => request.submissionText.slice(left >= 0 ? submissionSpans[left].end : 0, right < submissionSpans.length ? submissionSpans[right].start : request.submissionText.length);
    const opening = submission.slice(0, 300);
    const admittedByDoc = new Map(verification.verifiedSources.map((source) => [String(source.docId), source]));
    const sameWorkPolicy = request.sameWorkPolicy ?? "credit";
    const corrections = request.corrections ?? {};
    const genericCache = new Map<string, number>();
    const sources: AsjpLaneSource[] = [];
    const credited = new Set<number>();

    for (const admission of pass.admissions) {
      if (admission.spans.length === 0) continue; // nothing verified in this candidate: not a finding
      const docId = String(admission.docId);
      const admitted = admittedByDoc.get(docId) ?? null;
      const base: AsjpLaneSource = {
        sourceId: `asjp-doc:${docId}`, docId, publication: null, relationship: null, credited: false, notCreditedReason: null,
        verifierReason: admitted ? null : admission.reason, matchedPassages: [], matchedWordCount: admission.totalMatchedWords, longestSpan: admission.longestSpan,
        containmentOfSubmission: submissionWordCount ? admission.totalMatchedWords / submissionWordCount : 0, unsupportedWords: 0, isolatedWords: 0, genericWords: 0, completionWords: 0, genericClusters: [], admittedBy: null, structuralClusters: [], structuralWords: 0, annotations: [], authorMatches: [], sameWorkBasis: null, publicationTiming: null,
      };

      // identity: the generation's own record must name an ASJP article, and the catalog must know that article
      const metadata = await reader.fetchMetadata(docIdFromDecimal(docId));
      const identity = metadata.state === "OK" ? asjpIdentityOf(metadata.metadata, metadata.laterAliases) : null;
      if (!identity) { sources.push({ ...base, notCreditedReason: "UNVERIFIED_SOURCE_IDENTITY" }); continue; }
      const externalId = identity.externalId;
      base.sourceId = `asjp:${externalId}`;
      const entry = request.catalog(externalId) ?? null;
      if (!entry) { sources.push({ ...base, notCreditedReason: "NOT_IN_CATALOG" }); continue; }
      base.publication = entry;
      const recordUrl = identity.canonicalUrl;
      if (entry.articleId !== externalId || !recordUrl || recordUrl !== entry.canonicalUrl) { sources.push({ ...base, notCreditedReason: "UNVERIFIED_SOURCE_IDENTITY" }); continue; }
      if (entry.withdrawn) { sources.push({ ...base, notCreditedReason: "WITHDRAWN" }); continue; }
      if ((request.licencePolicy ?? "permitted-only") === "permitted-only" && licenceStatusOf(entry) !== "PERMITTED") { sources.push({ ...base, notCreditedReason: "LICENCE_NOT_PERMITTING" }); continue; }
      if (!admitted && (corrections.verbatimRescue === false || admission.totalMatchedWords < (corrections.rescueMinVerifiedWords ?? ASJP_RESCUE_MIN_VERIFIED_WORDS))) { sources.push({ ...base, notCreditedReason: "NOT_ADMITTED_BY_VERIFIER" }); continue; }

      // verbatim support: every credited position must be found again in the article's indexed text
      const fetched = await reader.fetchText(docIdFromDecimal(docId));
      if (fetched.state !== "OK") { sources.push({ ...base, notCreditedReason: admitted ? "SOURCE_TEXT_UNAVAILABLE" : "NOT_ADMITTED_BY_VERIFIER" }); continue; }
      const source = tokensForScoringNormalization(fetched.text, ASJP_LANE_SCORING_NORMALIZATION);
      // v3.1 (exact): a rescue candidate is first tested against a necessary condition on integer word ids; only one
      // that can still meet STRICT_SPAN reaches the full search below, which is unchanged. Character spans are built
      // only when a passage needs source offsets.
      if (!admitted && corrections.rescueFastPath !== false && !rescueCanAdmit(submissionIndex(), source)) { sources.push({ ...base, notCreditedReason: "NOT_ADMITTED_BY_VERIFIER" }); continue; }
      let sourceSpansMemo: ReturnType<typeof tokenSpans> | null = null;
      const sourceSpans = () => (sourceSpansMemo ??= tokenSpans(fetched.text, ASJP_LANE_SCORING_NORMALIZATION));
      const sourceGrams = gramStarts(source, ASJP_MINIMUM_VERBATIM_RUN);
      const supportedPassages: AsjpMatchedPassage[] = [];
      let verifierWords = 0;
      let rescuePassages: AsjpMatchedPassage[] | null = null;
      if (!admitted) {
        // v3 verbatim rescue: the same frozen STRICT_SPAN thresholds, applied to exact verbatim runs
        const runs = maximalVerbatimRuns(submission, source, sourceGrams, ASJP_MINIMUM_VERBATIM_RUN);
        const total = runs.reduce((sum, run) => sum + run.submittedWordEnd - run.submittedWordStart + 1, 0);
        const longest = runs.reduce((max, run) => Math.max(max, run.submittedWordEnd - run.submittedWordStart + 1), 0);
        if (total < SELECTIVE_CORPUS_STRICT_SPAN.minMatchedWords || longest < SELECTIVE_CORPUS_STRICT_SPAN.minLongestContiguousSpan) { sources.push({ ...base, notCreditedReason: "NOT_ADMITTED_BY_VERIFIER" }); continue; }
        rescuePassages = runs.map((run) => ({ ...run, matchedWordCount: run.submittedWordEnd - run.submittedWordStart + 1, sourceCharStart: sourceSpans()[run.sourceWordStart]?.start ?? -1, sourceCharEnd: sourceSpans()[run.sourceWordEnd]?.end ?? -1 }));
      }
      if (rescuePassages) supportedPassages.push(...rescuePassages);
      for (const passage of admitted?.matchedPassages ?? []) {
        verifierWords += passage.submittedWordEnd - passage.submittedWordStart + 1;
        for (const run of verbatimRunsInSource(submission, passage.submittedWordStart, passage.submittedWordEnd, source, sourceGrams)) {
          supportedPassages.push({
            ...run,
            matchedWordCount: run.submittedWordEnd - run.submittedWordStart + 1,
            sourceCharStart: sourceSpans()[run.sourceWordStart]?.start ?? -1,
            sourceCharEnd: sourceSpans()[run.sourceWordEnd]?.end ?? -1,
          });
        }
      }
      // v2 verbatim completion: long verbatim runs the verifier did not return (numeric tables), for this admitted article
      let completionWords = 0;
      let mergeFillWords = 0;
      // the maximal verbatim runs of >= ASJP_CONTEXT_ANCHOR_WORDS, computed once for completion and run merge
      let longRunsMemo: ReturnType<typeof maximalVerbatimRuns> | null = null;
      const longRuns = () => (longRunsMemo ??= maximalVerbatimRuns(submission, source, sourceGrams, ASJP_CONTEXT_ANCHOR_WORDS));
      if (corrections.verbatimCompletion !== false && supportedPassages.length > 0) {
        const covered = new Set<number>();
        for (const passage of supportedPassages) for (let q = passage.submittedWordStart; q <= passage.submittedWordEnd; q += 1) covered.add(q);
        for (const run of longRuns()) {
          // the uncovered parts of the run, each at least ASJP_MINIMUM_VERBATIM_RUN long, mapped to the source
          let at = run.submittedWordStart;
          while (at <= run.submittedWordEnd) {
            while (at <= run.submittedWordEnd && covered.has(at)) at += 1;
            let end = at;
            while (end + 1 <= run.submittedWordEnd && !covered.has(end + 1)) end += 1;
            if (at <= run.submittedWordEnd && end - at + 1 >= ASJP_MINIMUM_VERBATIM_RUN) {
              const sourceStart = run.sourceWordStart + (at - run.submittedWordStart);
              const sourceEnd = sourceStart + (end - at);
              supportedPassages.push({ submittedWordStart: at, submittedWordEnd: end, sourceWordStart: sourceStart, sourceWordEnd: sourceEnd, matchedWordCount: end - at + 1, sourceCharStart: sourceSpans()[sourceStart]?.start ?? -1, sourceCharEnd: sourceSpans()[sourceEnd]?.end ?? -1 });
              for (let q = at; q <= end; q += 1) covered.add(q);
              completionWords += end - at + 1;
            }
            at = end + 1;
          }
        }
        supportedPassages.sort((left, right) => left.submittedWordStart - right.submittedWordStart);
      }
      if (corrections.runMerge !== false && supportedPassages.length > 0) {
        const covered = new Set<number>();
        for (const passage of supportedPassages) for (let q = passage.submittedWordStart; q <= passage.submittedWordEnd; q += 1) covered.add(q);
        for (const run of longRuns()) {
          let touches = false;
          for (let q = run.submittedWordStart; q <= run.submittedWordEnd && !touches; q += 1) touches = covered.has(q);
          if (!touches) continue;
          let at = run.submittedWordStart;
          while (at <= run.submittedWordEnd) {
            while (at <= run.submittedWordEnd && covered.has(at)) at += 1;
            let end = at;
            while (end + 1 <= run.submittedWordEnd && !covered.has(end + 1)) end += 1;
            if (at <= run.submittedWordEnd) {
              const sourceStart = run.sourceWordStart + (at - run.submittedWordStart);
              const sourceEnd = sourceStart + (end - at);
              supportedPassages.push({ submittedWordStart: at, submittedWordEnd: end, sourceWordStart: sourceStart, sourceWordEnd: sourceEnd, matchedWordCount: end - at + 1, sourceCharStart: sourceSpans()[sourceStart]?.start ?? -1, sourceCharEnd: sourceSpans()[sourceEnd]?.end ?? -1 });
              for (let q = at; q <= end; q += 1) covered.add(q);
              completionWords += end - at + 1;
              mergeFillWords += end - at + 1;
            }
            at = end + 1;
          }
        }
        mergeContiguousRuns(supportedPassages);
      }
      let passages = anchoredPassages(supportedPassages);
      const verbatimWords = supportedPassages.reduce((total, passage) => total + passage.matchedWordCount, 0);
      const anchoredWords = passages.reduce((total, passage) => total + passage.matchedWordCount, 0);
      // v2 generic filter: corpus-grounded, per cluster
      let genericWords = 0;
      const genericClusters: AsjpLaneSource["genericClusters"] = [];
      // v3: the legal form of a cluster (an instrument referred to + quoted or statutory text), or null
      // v4: the primary-source form of a cluster — religious (scripture named) or legal (instrument named) — or null
      const legalOf = (cluster: AsjpMatchedPassage[]): { kind: "LEGAL_PRIMARY_TEXT" | "RELIGIOUS_TEXT"; markers: string[]; quoted: boolean } | null => {
        if (corrections.annotations === false) return null;
        const start = cluster[0].submittedWordStart, end = cluster[cluster.length - 1].submittedWordEnd;
        const words = cluster.reduce((total, passage) => total + passage.matchedWordCount, 0);
        if (words > ASJP_LEGAL_MAX_CLUSTER_WORDS) return null;
        const tokens = cluster.flatMap((passage) => submission.slice(passage.submittedWordStart, passage.submittedWordEnd + 1));
        // a citation describes a source; it is not the quoted text of that source
        if (words < ASJP_GENERIC_MAX_RUN && structuralForm(tokens, cluster.map((passage) => originalOf(passage.submittedWordStart, passage.submittedWordEnd)).join(" "))?.category === "BIBLIOGRAPHIC_CITATION") return null;
        const before = gapText(start - 1, start), after = gapText(end, end + 1);
        const context = originalOf(Math.max(0, start - ASJP_LEGAL_CONTEXT_WORDS), Math.max(0, start - 1)) + " " + originalOf(start, end) + " " + originalOf(Math.min(submission.length - 1, end + 1), Math.min(submission.length - 1, end + ASJP_PRIMARY_SOURCE_AFTER_WORDS));
        const religious = religiousForm(words, before, after, context);
        if (religious) return { kind: "RELIGIOUS_TEXT", ...religious };
        const legal = legalForm(tokens, before, after, context);
        // without quotation marks, only a short cluster is taken as reproduced statutory text (a long one is analysis)
        return legal && (legal.quoted || words <= ASJP_LEGAL_UNQUOTED_MAX_WORDS) ? { kind: "LEGAL_PRIMARY_TEXT", ...legal } : null;
      };
      if (corrections.genericFilter !== false) {
        const kept: AsjpMatchedPassage[] = [];
        for (const cluster of clusterPassages(passages)) {
          const longest = cluster.reduce((best, passage) => (passage.matchedWordCount > best.matchedWordCount ? passage : best), cluster[0]);
          if (longest.matchedWordCount >= ASJP_GENERIC_MAX_RUN) { kept.push(...cluster); continue; }
          // v3: a quoted / statutory legal provision is shared primary-source text, never removed for being common;
          // it stays credited and is annotated (legal + the number of other articles holding it)
          if (legalOf(cluster)) { kept.push(...cluster); continue; }
          const others = await otherArticlesHolding(reader, submission.slice(longest.submittedWordStart, longest.submittedWordEnd + 1), docId, genericCache);
          if (others >= ASJP_GENERIC_MIN_OTHER_ARTICLES) {
            const words = cluster.reduce((total, passage) => total + passage.matchedWordCount, 0);
            genericWords += words;
            genericClusters.push({ submittedWordStart: cluster[0].submittedWordStart, submittedWordEnd: cluster[cluster.length - 1].submittedWordEnd, words, otherArticles: others });
          } else kept.push(...cluster);
        }
        passages = kept;
      }
      // v3 structural filter: confirmed boilerplate / bibliographic form. Measured on the CREDITED words of a cluster
      // (never the manuscript's own text between its passages); a repeated placeholder unit at any size, the other
      // forms only for clusters of fewer than ASJP_GENERIC_MAX_RUN credited words
      let structuralWords = 0;
      const structuralClusters: AsjpLaneSource["structuralClusters"] = [];
      const structuralForms: AsjpAnnotation[] = [];
      if (corrections.structuralFilter !== false) {
        const kept: AsjpMatchedPassage[] = [];
        for (const cluster of clusterPassages(passages)) {
          const words = cluster.reduce((total, passage) => total + passage.matchedWordCount, 0);
          const start = cluster[0].submittedWordStart, end = cluster[cluster.length - 1].submittedWordEnd;
          const tokens = cluster.flatMap((passage) => submission.slice(passage.submittedWordStart, passage.submittedWordEnd + 1));
          const form = repetitionForm(submission.slice(start, end + 1))
            ?? (words < ASJP_GENERIC_MAX_RUN ? structuralForm(tokens, cluster.map((passage) => originalOf(passage.submittedWordStart, passage.submittedWordEnd)).join(" ")) : null);
          if (form && form.category === "PLACEHOLDER_REPETITION") { structuralWords += words; structuralClusters.push({ submittedWordStart: start, submittedWordEnd: end, words, category: form.category, evidence: form.evidence }); }
          else { kept.push(...cluster); if (form) structuralForms.push({ submittedWordStart: start, submittedWordEnd: end, words, kind: "STRUCTURAL_FORM", category: form.category, evidence: form.evidence }); }
        }
        passages = kept;
      }
      // v3 annotations (no score change)
      const annotations: AsjpAnnotation[] = [...structuralForms];
      if (corrections.annotations !== false) {
        for (const cluster of clusterPassages(passages)) {
          const start = cluster[0].submittedWordStart, end = cluster[cluster.length - 1].submittedWordEnd;
          const words = cluster.reduce((total, passage) => total + passage.matchedWordCount, 0);
          const primary = legalOf(cluster);
          const longest = cluster.reduce((best, passage) => (passage.matchedWordCount > best.matchedWordCount ? passage : best), cluster[0]);
          const others = longest.matchedWordCount < ASJP_GENERIC_MAX_RUN || primary
            ? await otherArticlesHolding(reader, submission.slice(longest.submittedWordStart, longest.submittedWordEnd + 1), docId, genericCache)
            : 0;
          if (primary) annotations.push({ submittedWordStart: start, submittedWordEnd: end, words, kind: primary.kind, quoted: primary.quoted, markers: primary.markers, otherArticles: others, namedSource: primary.markers[0] ?? null, originEstablished: false });
          else if (others > 0) {
            const quoted = QUOTATION_MARK.test(gapText(start - 1, start)) || QUOTATION_MARK.test(gapText(end, end + 1));
            annotations.push({ submittedWordStart: start, submittedWordEnd: end, words, kind: quoted ? "SHARED_QUOTATION" : "SHARED_ACADEMIC_TEXT", quoted, otherArticles: others, namedSource: null, originEstablished: false });
          }
        }
      }
      const supportedWords = passages.reduce((total, passage) => total + passage.matchedWordCount, 0);
      const supported: AsjpLaneSource = {
        ...base,
        matchedPassages: passages,
        matchedWordCount: supportedWords,
        longestSpan: passages.reduce((longest, passage) => Math.max(longest, passage.matchedWordCount), 0),
        containmentOfSubmission: submissionWordCount ? supportedWords / submissionWordCount : 0,
        unsupportedWords: Math.max(0, verifierWords - (verbatimWords - completionWords)),
        isolatedWords: verbatimWords - anchoredWords,
        genericWords, completionWords, genericClusters,
        admittedBy: admitted ? "VERIFIER" : "VERBATIM_RESCUE", structuralClusters, structuralWords, annotations,
      };
      if (supportedPassages.length === 0) { sources.push({ ...supported, notCreditedReason: "NO_VERBATIM_SOURCE_SUPPORT" }); continue; }
      if (passages.length === 0) { sources.push({ ...supported, notCreditedReason: structuralWords > 0 ? "STRUCTURAL_BOILERPLATE" : genericWords > 0 ? "GENERIC_COMMON_TEXT" : "ONLY_ISOLATED_SHORT_PASSAGES" }); continue; }

      // same work: the article is this manuscript's published version
      const sourceTitleWords = entry.title ? tokensForScoringNormalization(entry.title, ASJP_LANE_SCORING_NORMALIZATION) : [];
      const sameTitle = titlesAgree(sourceTitleWords, titleWords && titleWords.length >= 3 ? titleWords : opening, !(titleWords && titleWords.length >= 3));
      const labels = corrections.selfOverlapLabels !== false;
      supported.sameWorkBasis = supported.containmentOfSubmission >= ASJP_SAME_WORK_CONTAINMENT ? "CONTAINMENT"
        : sameTitle && supported.containmentOfSubmission >= ASJP_SAME_WORK_TITLE_CONTAINMENT ? "TITLE_AND_CONTAINMENT"
        // below the 30% title rule: against the manuscript's own title (when known) the titles must agree; against its
        // opening the article title must stand there as one run (shared subject words alone are not enough)
        : labels && supported.containmentOfSubmission >= ASJP_SAME_WORK_TITLE_MIN_CONTAINMENT && (titleWords && titleWords.length >= 3 ? sameTitle : titleStandsIn(sourceTitleWords, opening)) ? "TITLE" : null;
      const sameWork = supported.sameWorkBasis !== null;
      supported.authorMatches = labels ? authorSurnamesIn(entry.authors, submission.slice(0, ASJP_BYLINE_WORDS)) : [];
      supported.relationship = sameWork ? "SAME_WORK_PUBLISHED_VERSION" : supported.authorMatches.length > 0 ? "SAME_AUTHORS_OTHER_WORK" : "INDEPENDENT_PUBLICATION";
      if (request.referenceDate) {
        supported.publicationTiming = publicationTimingOf(entry.publicationDate, request.referenceDate);
        if (supported.publicationTiming === "AFTER") { sources.push({ ...supported, notCreditedReason: "PUBLISHED_AFTER_REFERENCE_DATE" }); continue; }
        if (supported.publicationTiming === "UNCERTAIN") { sources.push({ ...supported, notCreditedReason: "PUBLICATION_DATE_UNCERTAIN" }); continue; }
      }
      if (sameWork && sameWorkPolicy === "exclude") { sources.push({ ...supported, notCreditedReason: "SAME_WORK_EXCLUDED_BY_POLICY" }); continue; }
      supported.credited = true;
      for (const passage of passages) for (let position = passage.submittedWordStart; position <= passage.submittedWordEnd; position += 1) credited.add(position);
      sources.push(supported);
    }
    const supportedAt = performance.now();
    sources.sort((left, right) => Number(right.credited) - Number(left.credited) || right.matchedWordCount - left.matchedWordCount || (left.sourceId < right.sourceId ? -1 : 1));
    return {
      version,
      state: retrieval.state === "COMPLETE" && verification.state === "COMPLETE" ? "COMPLETE" : "PARTIAL",
      generationId: reader.identity().generationId,
      logicalManifestSha256: reader.identity().logicalManifestSha256,
      submissionWordCount,
      candidates: retrieval.candidates.length,
      sources,
      creditedPositions: [...credited].sort((left, right) => left - right),
      legalAnnotatedPositions: [...new Set(sources.filter((source) => source.credited).flatMap((source) => source.annotations.filter((a) => a.kind === "LEGAL_PRIMARY_TEXT").flatMap((a) => Array.from({ length: a.submittedWordEnd - a.submittedWordStart + 1 }, (_, i) => a.submittedWordStart + i))))].filter((q) => credited.has(q)).sort((left, right) => left - right),
      timings: {
        openMs: Math.round(opened - started), retrievalMs: Math.round(retrieved - opened), verificationMs: Math.round(verified - retrieved),
        supportMs: Math.round(supportedAt - verified), totalMs: Math.round(supportedAt - started),
      },
    };
  } catch (error) {
    return { version, state: "FAILED", failureCode: "UNEXPECTED", failureMessage: error instanceof Error ? error.message : String(error) };
  }
}

/** The lane's credited sources in the shape computeUnifiedSimilarity's asjpPublicationEvidence channel takes. */
export function asjpPublicationEvidenceOf(result: AsjpLaneResult): Array<{ sourceId: string; matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> }> {
  if (result.state !== "COMPLETE" && result.state !== "PARTIAL") return [];
  return result.sources.filter((source) => source.credited).map((source) => ({
    sourceId: source.sourceId,
    matchedPassages: source.matchedPassages.map(({ submittedWordStart, submittedWordEnd, matchedWordCount }) => ({ submittedWordStart, submittedWordEnd, matchedWordCount })),
  }));
}

export type AsjpSourceCard = {
  kind: "asjp_publication";
  sourceId: string;
  /** The publication title, exactly as the catalog holds it. */
  title: string;
  journal: string | null;
  publicationDate: string | null;
  doi: string | null;
  /** The canonical ASJP article URL. */
  url: string;
  authors: string[] | null;
  license: string | null;
  licenceStatus: AsjpLicenceStatus;
  matchedWordCount: number;
  relationship: AsjpRelationship;
  /** False only for an article shown but not scored (a benchmark reproduction that excludes it). */
  scored: boolean;
  /** How the match is presented: the manuscript's own previously published work, or another publication. */
  /** v4: QUOTES_PRIMARY_SOURCE = >= 90 % of its credited words are legal / religious quotations; the article quotes the
   *  text, it is not named as the text's origin. SHARED_TEXT_ORIGIN_NOT_ESTABLISHED = >= 90 % also held by other articles. */
  attribution: "PREVIOUSLY_PUBLISHED_WORK" | "SELF_OVERLAP_SAME_AUTHORS" | "QUOTES_PRIMARY_SOURCE" | "SHARED_TEXT_ORIGIN_NOT_ESTABLISHED" | "PUBLISHED_SOURCE";
  /** v3: words in legal-provision clusters and in clusters other indexed articles also hold. */
  legalWords?: number;
  religiousWords?: number;
  sharedWords?: number;
  structuralFormWords?: number;
};

/**
 * One card per verified ASJP source: credited sources (previously published work labelled as such), and same-work
 * articles a benchmark reproduction did not score. A source whose identity, licence, text support or publication
 * timing failed gets no card.
 */
export function asjpSourceCards(result: AsjpLaneResult): AsjpSourceCard[] {
  if (result.state !== "COMPLETE" && result.state !== "PARTIAL") return [];
  const cards: AsjpSourceCard[] = [];
  for (const source of result.sources) {
    const shown = source.credited || source.notCreditedReason === "SAME_WORK_EXCLUDED_BY_POLICY";
    if (!shown || !source.publication || !source.relationship || !source.publication.title) continue;
    cards.push({
      kind: "asjp_publication",
      sourceId: source.sourceId,
      title: source.publication.title,
      journal: source.publication.journal,
      publicationDate: source.publication.publicationDate,
      doi: source.publication.doi,
      url: source.publication.canonicalUrl,
      authors: source.publication.authors,
      license: source.publication.license,
      licenceStatus: licenceStatusOf(source.publication),
      ...annotationWordsOf(source),
      matchedWordCount: source.matchedWordCount,
      relationship: source.relationship,
      scored: source.credited,
      attribution: source.relationship === "SAME_WORK_PUBLISHED_VERSION" ? "PREVIOUSLY_PUBLISHED_WORK" : source.relationship === "SAME_AUTHORS_OTHER_WORK" ? "SELF_OVERLAP_SAME_AUTHORS"
        : sharedShare(source, ["LEGAL_PRIMARY_TEXT", "RELIGIOUS_TEXT"]) >= 0.9 ? "QUOTES_PRIMARY_SOURCE"
        : sharedShare(source) >= 0.9 ? "SHARED_TEXT_ORIGIN_NOT_ESTABLISHED" : "PUBLISHED_SOURCE",
    });
  }
  return cards;
}
