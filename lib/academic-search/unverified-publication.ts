import type {
  AcademicSearchCandidate,
  AcademicSearchRetrievalDiagnostic,
  ExternalAcademicEvidence,
} from "./types";
import { ACADEMIC_RETRIEVAL_DIAGNOSTICS_VERSION } from "./types";

/**
 * FIX C — "Possible related publication — not verified".
 *
 * A NOTICE, never evidence. When the academic search found a publication, could
 * not retrieve its text (so the comparator never ran), and the stored search
 * record ALONE proves strongly that the publication corresponds to the uploaded
 * manuscript, the report lists it separately with its public bibliographic
 * metadata. It contributes no matched word, no highlight, no source card and no
 * percentage — nothing here is read by scoring (lib/unified-similarity.ts never
 * imports this module).
 *
 * PURE and deterministic: no I/O. Inputs are the server-owned
 * academic_search_run_diagnostics row (candidates_json + retrieval_diagnostics_json
 * + evidence_json, resolved under the same id + submission-binding trust anchor
 * as the scoring evidence) and the server's own manuscript text.
 *
 * Eligibility (all required, per candidate):
 *   A. it is a real candidate of that run, in its top-ranked retrieval set;
 *   B. retrieval diagnostics v1 recorded that its text was NOT retrieved and it
 *      was NOT evaluated (rows recorded before diagnostics v1 never qualify —
 *      "candidate failed" cannot be told apart from "not attempted" there);
 *   C. identity evidence from TWO independent sources in the stored record
 *      agrees with the manuscript (see decidePublicationIdentity);
 *   D. the bibliographic record is complete and self-consistent (DOI, title,
 *      venue, year; the retrieval entry and the candidate agree on DOI/title).
 * Any contradiction rejects. Authors and venue never count as identity evidence.
 */

export const UNVERIFIED_PUBLICATION_NOTICE_VERSION = 1 as const;
export const UNVERIFIED_PUBLICATION_IDENTITY_RULES_VERSION = "unverified-publication-identity-v1";

/** At most this many publications are listed on one report. */
export const MAX_UNVERIFIED_PUBLICATIONS = 3;

/**
 * Gate thresholds — calibrated on already-used fixtures only (2026-10-11: the
 * 20 blind-eval runs, the 158 campaign replays, the website runs and live run
 * #273; see the Fix C validation report). Not a scoring threshold.
 */
export const UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS = {
  /** Shingle size for abstract-reuse measurement. */
  shingleSize: 6,
  /** A title needs at least this many content (non-stopword) tokens to count — generic/short titles never qualify. */
  minTitleContentTokens: 6,
  /** An abstract needs at least this many tokens to be measured at all. */
  minAbstractTokens: 40,
  /** Manuscript front matter = its first N tokens (title page, abstract). */
  frontMatterTokens: 600,
  /** EXACT_TITLE basis: the abstract must also be substantially present. */
  exactTitleMinAbstractCoverage: 0.2,
  exactTitleMinAbstractRun: 12,
  /** ABSTRACT_REUSE basis (a retitled manuscript): abstract reuse + title vocabulary. */
  abstractReuseMinCoverage: 0.3,
  abstractReuseMinRun: 20,
  abstractReuseMinTitleVocabulary: 0.6,
  /** DOI_IN_FRONT_MATTER basis: the candidate's own DOI on the title page + its title there. */
  doiMinTitleRunFraction: 0.8,
  /** Contradiction: an exact title whose abstract is essentially absent. */
  contradictionMaxAbstractCoverage: 0.1,
} as const;

export type UnverifiedPublication = {
  /** Bare, lowercased DOI. The displayed link is always built as https://doi.org/<doi> — never a provider or publisher URL. */
  doi: string;
  title: string;
  venue: string;
  year: number;
};

export type UnverifiedPublicationNotice = {
  version: typeof UNVERIFIED_PUBLICATION_NOTICE_VERSION;
  publications: UnverifiedPublication[];
};

export type PublicationIdentitySignals = {
  titleContentTokens: number;
  titleExactInFrontMatter: boolean;
  /** Longest contiguous run of the title's tokens found in the front matter, as a fraction of the title's tokens. */
  titleRunFractionInFrontMatter: number;
  /** Fraction of the title's content tokens that occur anywhere in the manuscript. */
  titleVocabularyCoverage: number;
  abstractTokens: number;
  /** Fraction of the abstract's distinct 6-gram shingles found verbatim in the manuscript; null when the abstract is too short. */
  abstractCoverage: number | null;
  /** Longest ordered verbatim token run shared by the abstract and the manuscript. */
  abstractLongestRun: number;
  doiInFrontMatter: boolean;
  /** The front matter carries some DOI, none of them the candidate's. */
  foreignDoiInFrontMatter: boolean;
};

export type PublicationIdentityBasis = "EXACT_TITLE" | "ABSTRACT_REUSE" | "DOI_IN_FRONT_MATTER";

export type PublicationIdentityDecision =
  | { strong: true; basis: PublicationIdentityBasis; signals: PublicationIdentitySignals }
  | { strong: false; reason: string; signals: PublicationIdentitySignals | null };

export type UnverifiedPublicationCandidateOutcome = {
  candidateKey: string;
  rank: number;
  eligible: boolean;
  /** Closed reason code (diagnostics/tests only; never shown to a customer). */
  reason: string;
  basis: PublicationIdentityBasis | null;
  signals: PublicationIdentitySignals | null;
};

export type UnverifiedPublicationEvaluation = {
  notice: UnverifiedPublicationNotice | null;
  outcomes: UnverifiedPublicationCandidateOutcome[];
};

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "between", "by", "for", "from", "has", "have", "in", "into", "is", "its",
  "of", "on", "or", "over", "the", "their", "this", "to", "toward", "towards", "under", "upon", "via", "with", "within",
  "among", "amongst", "case", "study", "analysis", "role", "effect", "effects", "impact", "new", "using", "based",
  // French
  "de", "des", "du", "la", "le", "les", "et", "en", "un", "une", "au", "aux", "dans", "par", "pour", "sur",
  // Arabic
  "في", "من", "على", "إلى", "الى", "عن", "مع", "و", "أو", "او", "ال", "دراسة", "حالة", "دور", "أثر", "اثر",
]);

/** NFKD-folded, mark-stripped, lowercased tokens; a hyphen inside a word (also across a line break) is joined. */
export function identityTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const folded = String(text)
    .replace(/<[^>]{0,200}>/g, " ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[’‘'`]/g, "")
    .replace(/(\p{L})[-­‐‑]\s*(\p{Ll})/gu, "$1$2")
    .toLowerCase();
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function contentTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Bare, lowercased DOI, or null when the value is not a DOI. */
export function normalizeDoi(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(bare) ? bare : null;
}

const DOI_IN_TEXT_RE = /\b10\.\d{4,9}\/[^\s"<>]+/gi;

function doisIn(text: string): string[] {
  return (text.match(DOI_IN_TEXT_RE) ?? []).map((d) => d.toLowerCase().replace(/[.,;:)\]]+$/, ""));
}

function collapse(s: string | null | undefined): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// Manuscript index (built once per report, reused for every candidate)
// ---------------------------------------------------------------------------

export type ManuscriptIdentityIndex = {
  tokens: string[];
  tokenSet: Set<string>;
  frontMatter: string[];
  /** 6-gram -> start positions (bounded per gram). */
  shingles: Map<string, number[]>;
  frontMatterDois: string[];
};

const MAX_POSITIONS_PER_SHINGLE = 64;

export function buildManuscriptIdentityIndex(manuscriptText: string): ManuscriptIdentityIndex {
  const n = UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS.shingleSize;
  const tokens = identityTokens(manuscriptText);
  const shingles = new Map<string, number[]>();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const key = tokens.slice(i, i + n).join(" ");
    const list = shingles.get(key);
    if (!list) shingles.set(key, [i]);
    else if (list.length < MAX_POSITIONS_PER_SHINGLE) list.push(i);
  }
  const frontMatter = tokens.slice(0, UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS.frontMatterTokens);
  // Front-matter DOIs are read from the raw text of roughly the same span (DOIs do not survive tokenization).
  const rawFront = sliceRawByTokens(manuscriptText, UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS.frontMatterTokens);
  return { tokens, tokenSet: new Set(tokens), frontMatter, shingles, frontMatterDois: doisIn(rawFront) };
}

function sliceRawByTokens(text: string, maxTokens: number): string {
  const re = /[\p{L}\p{N}]+/gu;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    count += 1;
    if (count >= maxTokens) return text.slice(0, m.index + m[0].length);
  }
  return text;
}

function longestCommonRun(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

function abstractReuse(abstractTokens: readonly string[], index: ManuscriptIdentityIndex): { coverage: number | null; longestRun: number } {
  const n = UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS.shingleSize;
  if (abstractTokens.length < UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS.minAbstractTokens) return { coverage: null, longestRun: 0 };
  const distinct = new Set<string>();
  let hits = 0;
  // run length (in shingles) ending at manuscript start position p, for the previous abstract position
  let prevRuns = new Map<number, number>();
  let bestShingleRun = 0;
  for (let i = 0; i + n <= abstractTokens.length; i += 1) {
    const key = abstractTokens.slice(i, i + n).join(" ");
    const positions = index.shingles.get(key);
    if (!distinct.has(key)) {
      distinct.add(key);
      if (positions) hits += 1;
    }
    const runs = new Map<number, number>();
    for (const p of positions ?? []) {
      const len = (prevRuns.get(p - 1) ?? 0) + 1;
      runs.set(p, len);
      if (len > bestShingleRun) bestShingleRun = len;
    }
    prevRuns = runs;
  }
  return {
    coverage: distinct.size > 0 ? hits / distinct.size : null,
    longestRun: bestShingleRun > 0 ? bestShingleRun + n - 1 : 0,
  };
}

/** Identity signals for one candidate against an indexed manuscript. Pure. */
export function publicationIdentitySignals(
  candidate: Pick<AcademicSearchCandidate, "title" | "abstract" | "doi">,
  index: ManuscriptIdentityIndex,
): PublicationIdentitySignals {
  const titleTokens = identityTokens(candidate.title);
  const titleContent = contentTokens(titleTokens);
  const titleRun = longestCommonRun(titleTokens, index.frontMatter);
  const vocabHits = titleContent.filter((t) => index.tokenSet.has(t)).length;
  const absTokens = identityTokens(candidate.abstract);
  // A provider abstract often starts with the literal word "Abstract".
  const absBody = absTokens[0] === "abstract" ? absTokens.slice(1) : absTokens;
  const reuse = abstractReuse(absBody, index);
  const doi = normalizeDoi(candidate.doi);
  const doiInFrontMatter = doi !== null && index.frontMatterDois.some((d) => d === doi);
  return {
    titleContentTokens: titleContent.length,
    titleExactInFrontMatter: titleTokens.length > 0 && titleRun === titleTokens.length,
    titleRunFractionInFrontMatter: titleTokens.length > 0 ? titleRun / titleTokens.length : 0,
    titleVocabularyCoverage: titleContent.length > 0 ? vocabHits / titleContent.length : 0,
    abstractTokens: absBody.length,
    abstractCoverage: reuse.coverage,
    abstractLongestRun: reuse.longestRun,
    doiInFrontMatter,
    foreignDoiInFrontMatter: index.frontMatterDois.length > 0 && !doiInFrontMatter,
  };
}

/**
 * The identity gate (criterion C). Two independent agreeing signals are always
 * required; a single matching field (a title alone, a DOI alone, an author, a
 * venue) is never enough.
 */
export function decidePublicationIdentity(signals: PublicationIdentitySignals): PublicationIdentityDecision {
  const T = UNVERIFIED_PUBLICATION_IDENTITY_THRESHOLDS;
  if (signals.titleContentTokens < T.minTitleContentTokens) return { strong: false, reason: "TITLE_TOO_GENERIC", signals };
  const cov = signals.abstractCoverage;

  // Contradictions first.
  if (signals.foreignDoiInFrontMatter) return { strong: false, reason: "CONTRADICTION_FOREIGN_DOI", signals };
  if (signals.titleExactInFrontMatter && cov !== null && cov < T.contradictionMaxAbstractCoverage) {
    return { strong: false, reason: "CONTRADICTION_TITLE_WITHOUT_ABSTRACT", signals };
  }

  if (signals.doiInFrontMatter && signals.titleRunFractionInFrontMatter >= T.doiMinTitleRunFraction) {
    return { strong: true, basis: "DOI_IN_FRONT_MATTER", signals };
  }
  if (cov === null) return { strong: false, reason: "INSUFFICIENT_IDENTITY_EVIDENCE", signals };
  if (signals.titleExactInFrontMatter && cov >= T.exactTitleMinAbstractCoverage && signals.abstractLongestRun >= T.exactTitleMinAbstractRun) {
    return { strong: true, basis: "EXACT_TITLE", signals };
  }
  if (
    cov >= T.abstractReuseMinCoverage &&
    signals.abstractLongestRun >= T.abstractReuseMinRun &&
    signals.titleVocabularyCoverage >= T.abstractReuseMinTitleVocabulary
  ) {
    return { strong: true, basis: "ABSTRACT_REUSE", signals };
  }
  return { strong: false, reason: "INSUFFICIENT_IDENTITY_EVIDENCE", signals };
}

// ---------------------------------------------------------------------------
// Record-level gate (criteria A, B, D) + the notice
// ---------------------------------------------------------------------------

/** Not-retrieved categories that may carry a notice. A safety refusal never does. */
const SAFETY_CATEGORIES = new Set(["UNSAFE_URL", "UNSAFE_REDIRECT_TARGET"]);

function plausibleYear(year: unknown): year is number {
  return typeof year === "number" && Number.isInteger(year) && year >= 1900 && year <= 2100;
}

export type UnverifiedPublicationRecordInput = {
  candidates: readonly AcademicSearchCandidate[] | null | undefined;
  retrievalDiagnostics: readonly AcademicSearchRetrievalDiagnostic[] | null | undefined;
  /** The run's server-verified scoring evidence; a publication already verified there is never listed. */
  verifiedEvidence: readonly ExternalAcademicEvidence[] | null | undefined;
};

/**
 * Evaluates every retrieval entry of one stored search run. Returns the notice
 * (null when nothing qualifies) plus a per-candidate outcome for tests and
 * calibration. Never throws on malformed input — anything unexpected is an
 * ineligible outcome.
 */
export function evaluateUnverifiedPublications(
  manuscriptText: string,
  record: UnverifiedPublicationRecordInput,
): UnverifiedPublicationEvaluation {
  const outcomes: UnverifiedPublicationCandidateOutcome[] = [];
  const diagnostics = Array.isArray(record.retrievalDiagnostics) ? record.retrievalDiagnostics : [];
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  if (diagnostics.length === 0 || typeof manuscriptText !== "string" || manuscriptText.trim().length === 0) {
    return { notice: null, outcomes };
  }
  const byKey = new Map<string, AcademicSearchCandidate>();
  for (const c of candidates) if (c && typeof c.candidateKey === "string" && !byKey.has(c.candidateKey)) byKey.set(c.candidateKey, c);
  const verifiedDois = new Set(
    (Array.isArray(record.verifiedEvidence) ? record.verifiedEvidence : [])
      .map((e) => normalizeDoi(e?.doi ?? null))
      .filter((d): d is string => d !== null),
  );

  let index: ManuscriptIdentityIndex | null = null;
  const publications: UnverifiedPublication[] = [];
  const listed = new Set<string>();
  const out = (entry: AcademicSearchRetrievalDiagnostic, reason: string, extra: Partial<UnverifiedPublicationCandidateOutcome> = {}) =>
    outcomes.push({
      candidateKey: String(entry?.candidateKey ?? ""),
      rank: Number.isInteger(entry?.rank) ? entry.rank : -1,
      eligible: false,
      reason,
      basis: null,
      signals: null,
      ...extra,
    });

  for (const entry of diagnostics) {
    if (!entry || typeof entry !== "object") continue;
    // B — only diagnostics v1+ can say "found but not evaluated".
    if (typeof entry.diagnosticsVersion !== "number" || entry.diagnosticsVersion < ACADEMIC_RETRIEVAL_DIAGNOSTICS_VERSION) {
      out(entry, "LEGACY_DIAGNOSTICS");
      continue;
    }
    if (entry.textRetrieved !== false || entry.candidateEvaluated !== false || entry.includedAsEvidence !== false || entry.comparisonSimilarity != null) {
      out(entry, "TEXT_EVALUATED");
      continue;
    }
    if (entry.safetyFailure != null || (entry.errorCategory != null && SAFETY_CATEGORIES.has(entry.errorCategory))) {
      out(entry, "SAFETY_REFUSAL");
      continue;
    }
    // A — a real candidate of this run.
    const cand = byKey.get(entry.candidateKey);
    if (!cand) {
      out(entry, "CANDIDATE_NOT_IN_RECORD");
      continue;
    }
    // D — complete, self-consistent bibliographic record.
    const doi = normalizeDoi(cand.doi);
    const title = collapse(cand.title);
    const venue = collapse(cand.publication);
    if (normalizeDoi(entry.doi) !== doi || collapse(entry.title) !== title) {
      out(entry, "RECORD_INCONSISTENT");
      continue;
    }
    if (!doi || !title || !venue || !plausibleYear(cand.year)) {
      out(entry, "METADATA_INCOMPLETE");
      continue;
    }
    if (verifiedDois.has(doi)) {
      out(entry, "ALREADY_VERIFIED");
      continue;
    }
    // C — identity.
    index ??= buildManuscriptIdentityIndex(manuscriptText);
    const decision = decidePublicationIdentity(publicationIdentitySignals(cand, index));
    if (!decision.strong) {
      out(entry, decision.reason, { signals: decision.signals });
      continue;
    }
    if (listed.has(doi)) {
      out(entry, "DUPLICATE_PUBLICATION", { basis: decision.basis, signals: decision.signals });
      continue;
    }
    if (publications.length >= MAX_UNVERIFIED_PUBLICATIONS) {
      out(entry, "LIST_FULL", { basis: decision.basis, signals: decision.signals });
      continue;
    }
    listed.add(doi);
    publications.push({ doi, title: title.slice(0, 400), venue: venue.slice(0, 200), year: cand.year as number });
    out(entry, "ELIGIBLE", { eligible: true, basis: decision.basis, signals: decision.signals });
  }

  return {
    notice: publications.length > 0 ? { version: UNVERIFIED_PUBLICATION_NOTICE_VERSION, publications } : null,
    outcomes,
  };
}

/**
 * Shape guard for a persisted notice (read side). Anything malformed is
 * treated as "no notice" — a legacy report, or a damaged value, renders exactly
 * as before.
 */
export function sanitizeUnverifiedPublicationNotice(value: unknown): UnverifiedPublicationNotice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { version?: unknown; publications?: unknown };
  if (v.version !== UNVERIFIED_PUBLICATION_NOTICE_VERSION || !Array.isArray(v.publications)) return null;
  const publications: UnverifiedPublication[] = [];
  for (const p of v.publications.slice(0, MAX_UNVERIFIED_PUBLICATIONS)) {
    if (!p || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    const doi = normalizeDoi(typeof r.doi === "string" ? r.doi : null);
    const title = collapse(typeof r.title === "string" ? r.title : null);
    const venue = collapse(typeof r.venue === "string" ? r.venue : null);
    if (!doi || !title || !venue || !plausibleYear(r.year)) return null;
    publications.push({ doi, title, venue, year: r.year });
  }
  return publications.length > 0 ? { version: UNVERIFIED_PUBLICATION_NOTICE_VERSION, publications } : null;
}

/** The only link ever shown for a listed publication. */
export function unverifiedPublicationDoiUrl(doi: string): string {
  return `https://doi.org/${encodeURI(doi)}`;
}
