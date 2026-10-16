/**
 * ASJP SIX-WORD OVERLAP — FROZEN INTEGRATION CONTRACT (asjp-sixword-overlap-contract-v1).
 *
 * What the ASJP matching service may return, and a report may persist, about exact six-word (and longer) text overlap
 * that is NOT part of any similarity score. Everything here is informational:
 *   - every match is `scored: false` and carries the fixed label below; no field of this contract is ever passed to
 *     computeUnifiedSimilarity, a lane's credited positions or any percentage;
 *   - every span is a verified exact match: manuscript words [submittedWordStart, submittedWordEnd] equal the holder's
 *     lane tokens [sourceWordStart, sourceWordEnd] word for word, under normalization 2, in the pinned generation;
 *   - character offsets are given only when re-verified on the article's generation text, else null (never guessed);
 *   - no article is ever called the origin: `originEstablished` is always false, whatever the holder count;
 *   - holders are only articles that pass the lane's own source gates (identity, catalog, withdrawal, licence policy,
 *     publication before the reference date); every gated-out holder is COUNTED by reason, never shown as a source;
 *   - retrieval is complete inside the service; only the presentation is bounded (SIXWORD_LIMITS), and every bound
 *     reports exactly what it omitted.
 *
 * Changing any type, constant or rule in this file is a new contract version.
 */
export const ASJP_SIXWORD_CONTRACT_VERSION = "asjp-sixword-overlap-contract-v1";
export const ASJP_SIXWORD_OVERLAP_LABEL = "Exact text overlap — not included in similarity score";

export const SIXWORD_LIMITS = Object.freeze({
  /** matches shown per answer, by tier: every UNIQUE first (longest first), then SHARED, then COMMON */
  maxMatchesShown: 200,
  /** COMMON matches (held by >= 10 articles) shown at most */
  maxCommonShown: 20,
  /** eligible holders listed per match (the rest counted in holdersOmitted) */
  maxHoldersShown: 8,
  /** distinct articles whose character offsets are computed per answer (≈ 8 ms each) */
  maxOffsetArticles: 80,
  /** chained (manuscript gram, article position) pairs before the search stops whole */
  maxPairs: 3_000_000,
  /** wall-clock budget of the whole six-word step, inside the service's 7 s request deadline */
  timeBudgetMs: 4_000,
  /** a persisted record above this size is trimmed (COMMON first, then shortest) and marked truncated */
  maxRecordBytes: 192 * 1024,
});

export type SixwordGateReason =
  | "NO_ASJP_IDENTITY" | "NOT_IN_CATALOG" | "UNVERIFIED_SOURCE_IDENTITY" | "WITHDRAWN" | "LICENCE_NOT_PERMITTING"
  | "PUBLISHED_AFTER_REFERENCE_DATE" | "PUBLICATION_DATE_UNCERTAIN";
export const SIXWORD_GATE_REASONS: readonly SixwordGateReason[] = ["NO_ASJP_IDENTITY", "NOT_IN_CATALOG", "UNVERIFIED_SOURCE_IDENTITY", "WITHDRAWN", "LICENCE_NOT_PERMITTING", "PUBLISHED_AFTER_REFERENCE_DATE", "PUBLICATION_DATE_UNCERTAIN"];

/** One article's catalog facts, listed once per answer in `sources` (holders refer to it by sourceId). */
export type SixwordOverlapSource = { sourceId: string; articleId: string; title: string | null; journal: string | null; publicationDate: string | null; canonicalUrl: string | null };
export type SixwordOverlapHolder = {
  /** `asjp:<articleId>`, a key of the answer's `sources` */
  sourceId: string;
  sourceWordStart: number; sourceWordEnd: number;
  /** re-verified on the generation text, or null (then no source-text highlight may be drawn) */
  sourceCharStart: number | null; sourceCharEnd: number | null;
  /** times the article holds the sequence */
  occurrences: number;
};
export type SixwordOverlapMatch = {
  submittedWordStart: number; submittedWordEnd: number; words: number;
  band: "6-9" | "10-14" | "15-19" | "20-24" | "25-39" | "40-59" | "60+";
  scored: false;
  originEstablished: false;
  /** over the WHOLE pinned index (a description of the wording, not of sources): UNIQUE 1, SHARED 2–9, COMMON >= 10 */
  commonness: "UNIQUE" | "SHARED" | "COMMON";
  holdersInIndex: number;
  eligibleHolders: number;
  holders: SixwordOverlapHolder[];
  holdersOmitted: number;
  ineligibleHolders: Partial<Record<SixwordGateReason, number>>;
  /** manuscript words of this match the scored ASJP lane already credits (those words count once, through the lane) */
  wordsAlreadyCreditedByLane: number;
  labels: { form: string | null; legal: boolean; religious: boolean };
};
export type SixwordOverlapPins = {
  contract: string; evidenceVersion: string; indexFormat: string; indexPostingsSha256: string; tokenStoreSha256: string;
  generationId: string; logicalManifestSha256: string; normalization: 2;
  catalogDigest: string | null; licencePolicy: "permitted-only" | "local-research-all"; referenceDate: string | null;
};
export type SixwordOverlapResponse = {
  contract: typeof ASJP_SIXWORD_CONTRACT_VERSION;
  state: "COMPLETE" | "UNAVAILABLE" | "INCOMPLETE_BUDGET";
  /** UNAVAILABLE / INCOMPLETE_BUDGET: a code only (never a message that could quote input) */
  reason: string | null;
  scored: false;
  label: typeof ASJP_SIXWORD_OVERLAP_LABEL;
  pins: SixwordOverlapPins | null;
  wordCount: number | null;
  summary: {
    matches: number; unique: number; shared: number; common: number; withoutEligibleHolder: number;
    wordsInAnyMatch: number; wordsInEligibleMatch: number; wordsAlreadyCreditedByLane: number; runs: number;
  } | null;
  matches: SixwordOverlapMatch[];
  /** the catalog facts of every article a listed holder refers to (and no other) */
  sources: Record<string, SixwordOverlapSource>;
  truncation: { matchesOmitted: number; commonOmitted: number; matchesWithHoldersOmitted: number; holdersWithoutCharOffsets: number };
  timings: { findMs: number; evidenceMs: number; gatesMs: number; offsetsMs: number; totalMs: number } | null;
};

export function unavailableSixwordOverlap(state: "UNAVAILABLE" | "INCOMPLETE_BUDGET", reason: string, pins: SixwordOverlapPins | null = null, wordCount: number | null = null): SixwordOverlapResponse {
  return { contract: ASJP_SIXWORD_CONTRACT_VERSION, state, reason, scored: false, label: ASJP_SIXWORD_OVERLAP_LABEL, pins, wordCount, summary: null, matches: [], sources: {}, truncation: { matchesOmitted: 0, commonOmitted: 0, matchesWithHoldersOmitted: 0, holdersWithoutCharOffsets: 0 }, timings: null };
}

const int = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
/**
 * Strict shape check of an answer block (the report side accepts nothing else): contract and label exact, scored and
 * originEstablished false everywhere, spans inside the manuscript and consistent, holders within the shown bound,
 * character offsets either both null or a non-empty range. Returns a reason code, or null when valid.
 */
export function sixwordOverlapProblem(r: unknown, wordCount: number): string | null {
  const x = r as SixwordOverlapResponse;
  if (!x || typeof x !== "object") return "NOT_AN_OBJECT";
  if (x.contract !== ASJP_SIXWORD_CONTRACT_VERSION) return "CONTRACT_VERSION";
  if (x.scored !== false || x.label !== ASJP_SIXWORD_OVERLAP_LABEL) return "NOT_INFORMATIONAL";
  if (!["COMPLETE", "UNAVAILABLE", "INCOMPLETE_BUDGET"].includes(x.state)) return "STATE";
  if (!Array.isArray(x.matches) || !x.sources || typeof x.sources !== "object") return "MATCHES";
  if (x.state !== "COMPLETE") return x.matches.length || Object.keys(x.sources).length ? "MATCHES_WITHOUT_COMPLETE" : null;
  const referenced = new Set<string>();
  if (!x.pins || x.pins.normalization !== 2 || x.wordCount !== wordCount) return "PINS_OR_WORD_COUNT";
  if (x.matches.length > SIXWORD_LIMITS.maxMatchesShown) return "TOO_MANY_MATCHES";
  for (const m of x.matches) {
    if (m.scored !== false || m.originEstablished !== false) return "MATCH_NOT_INFORMATIONAL";
    if (!int(m.submittedWordStart) || !int(m.submittedWordEnd) || m.submittedWordEnd >= wordCount || m.submittedWordEnd - m.submittedWordStart + 1 !== m.words || m.words < 6) return "MATCH_SPAN";
    if (!Array.isArray(m.holders) || m.holders.length > SIXWORD_LIMITS.maxHoldersShown || m.holders.length === 0 || m.eligibleHolders !== m.holders.length + m.holdersOmitted || m.eligibleHolders > m.holdersInIndex) return "MATCH_HOLDERS";
    for (const h of m.holders) {
      const source = x.sources[h.sourceId];
      if (!/^asjp:\d+$/.test(h.sourceId) || !source || source.sourceId !== h.sourceId || h.sourceId !== `asjp:${source.articleId}`) return "HOLDER_ID";
      referenced.add(h.sourceId);
      if (!int(h.sourceWordStart) || h.sourceWordEnd - h.sourceWordStart !== m.submittedWordEnd - m.submittedWordStart) return "HOLDER_SPAN";
      const charsNull = h.sourceCharStart === null && h.sourceCharEnd === null;
      if (!charsNull && !(int(h.sourceCharStart) && int(h.sourceCharEnd) && (h.sourceCharEnd as number) > (h.sourceCharStart as number))) return "HOLDER_OFFSETS";
    }
  }
  if (Object.keys(x.sources).length !== referenced.size) return "UNREFERENCED_SOURCE";
  return null;
}
