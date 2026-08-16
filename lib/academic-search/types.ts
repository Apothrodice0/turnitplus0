/**
 * Live academic search — Phase 1 (provider-agnostic POC). Data shapes only;
 * the provider interface itself lives in provider.ts.
 *
 * This subsystem answers a different question than lib/discovery-*.ts (the
 * existing E6 candidate-discovery pipeline, also unwired from any live
 * route today): discovery-* is about assembling provenance evidence for a
 * document's own record; this subsystem is about live-querying an external
 * academic search index for candidate articles that might overlap a
 * submission's text, fetching whatever text is available for the strongest
 * candidates, and locally comparing it. It deliberately does not reuse
 * lib/discovery-types.ts's RawProviderResult/DiscoveryCandidate shapes or
 * lib/discovery-providers.ts's SourceDiscoveryProvider interface — those are
 * shaped around "discover() returns everything in one batch," this is
 * shaped around "search() to find candidates, then getText() only for the
 * few worth fetching," which is a materially different provider contract.
 *
 * What IS reused from the existing codebase (read-only imports, nothing in
 * lib/academic-search/ modifies any file outside this directory):
 *  - lib/document-correspondence.ts's computeDocumentCorrespondence for the
 *    local comparison stage (comparator.ts) — already the project's
 *    purpose-built "submission text vs. external text" engine.
 *  - lib/http-content-retriever.ts + lib/retrieval-safety.ts for fetching a
 *    candidate's landing page when a provider does not hand back full text
 *    directly (text-retriever.ts) — already SSRF-hardened, timeout-bounded,
 *    size-capped.
 *  - lib/similarity-core.ts's tokens/normalize for phrase scoring
 *    (phrase-extractor.ts).
 *
 * Nothing in this directory touches score, archiveScore, aiScore,
 * verifiedSimilarity, historical-match state, or any E8S file — see the
 * final report for the exact (currently unmodified) integration point.
 */

/** A single query string handed to a provider, plus why it was chosen — carried through so evidence can cite which passage of the submission produced a given candidate. */
export type AcademicSearchQuery = {
  queryText: string;
  /** 0-indexed rank assigned by the phrase extractor (0 = most distinctive). */
  rank: number;
  /** The submission passage this query was derived from, verbatim (for citing in evidence). Equal to queryText for whole-passage queries. */
  sourcePassage: string;
};

/**
 * Normalized shape every provider's search() results are mapped into.
 * Deliberately sparse — a provider is not required to populate every field
 * (see textAvailable: most providers can be queried for metadata far more
 * cheaply than they can supply full text, so callers must treat every field
 * beyond providerId/externalId as possibly absent, never assume it will
 * arrive).
 */
export type AcademicSearchResult = {
  /** Which provider produced this result — e.g. "core", "mock". Never a display name. */
  providerId: string;
  /** The provider's own opaque id for this work, passed back into getMetadata()/getText() unchanged. Never assumed to be comparable across providers. */
  externalId: string;
  title: string | null;
  authors: string[] | null;
  publication: string | null;
  year: number | null;
  /** Bare DOI (no "https://doi.org/" prefix, lowercased) if the provider supplied one — the one cross-provider identifier this subsystem trusts for deduplication. */
  doi: string | null;
  url: string | null;
  /** True only when the provider claims it can hand back usable full (or near-full) text for this result without further user action — a claim TextRetriever still verifies, never taken on faith for ranking alone. */
  textAvailable: boolean;
  /** The query that produced this raw result — before normalization/dedup, so the orchestrator can report which of the 5-20 queries were productive. */
  querySignalUsed: string;
  /** Provider's own relevance/confidence signal for this result, if any, normalized to 0..1 within a single query's result set. Never a probability of plagiarism — purely "how well did this match the search query." */
  providerRelevance: number | null;
};

export type AcademicSearchProviderError = {
  providerId: string;
  kind: "TIMEOUT" | "RATE_LIMITED" | "UNAVAILABLE" | "ERROR";
  message: string;
};

/** A provider result after normalization but before dedup — provider-tagged so multiple providers returning the same work can still be told apart until they're merged. */
export type NormalizedAcademicResult = AcademicSearchResult & {
  /** Canonicalized DOI/URL used purely for dedup identity — see deduplicator.ts. Never displayed. */
  dedupKey: string;
};

export type AcademicSearchCandidate = {
  candidateKey: string;
  doi: string | null;
  url: string | null;
  title: string | null;
  authors: string[] | null;
  publication: string | null;
  year: number | null;
  textAvailable: boolean;
  /** Every normalized result that collapsed into this candidate — always >= 1; length > 1 is the "multiple providers/queries returned the same work" case. */
  contributors: NormalizedAcademicResult[];
  /** Assigned by candidate-ranker.ts; 0 = highest priority. */
  rank: number;
};

/** A single passage of the submission found to correspond to the external text — shaped for eventual display, independent of lib/document-correspondence.ts's own CorrespondencePassage so this subsystem's public contract doesn't change if that engine's internals do. */
export type MatchedPassage = {
  submittedText: string;
  submittedWordStart: number;
  submittedWordEnd: number;
  matchedWordCount: number;
};

/**
 * The terminal output of the pipeline. Intentionally has no relationship to
 * SimilarityReport's score/archiveScore/aiScore/verifiedSimilarity fields —
 * see this file's own header comment and the final report's "next step for
 * production integration" section for how a future phase would surface
 * this on SimilarityReport without touching any of them.
 */
export type ExternalAcademicEvidence = {
  provider: string;
  providerId: string;
  title: string | null;
  authors: string[] | null;
  /** Phase 3 addition — carried straight through from the winning candidate's own publication/year (already computed by candidate-ranker.ts's input, never re-derived here). Added for report UI display (STEP 6: "title, authors, publication, year... where available"); orchestrator.ts's dedup/ranking/retrieval logic is otherwise unchanged. */
  publication: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  matchedPassages: MatchedPassage[];
  /** 0..100, derived from lib/document-correspondence.ts's containment — "how much of the submission's distinctive content appears in this external source," never a plagiarism probability. */
  similarity: number;
};

export type AcademicSearchRunStats = {
  queryCount: number;
  searchLatencyMs: number;
  candidateCountBeforeDedup: number;
  candidateCountAfterDedup: number;
  /** (beforeDedup - afterDedup) / beforeDedup, 0 when there was nothing to dedupe. */
  deduplicationRate: number;
  candidatesTextRetrieved: number;
  textRetrievalLatencyMs: number;
  comparisonLatencyMs: number;
  totalLatencyMs: number;
  providerErrors: AcademicSearchProviderError[];
};

export type AcademicSearchRunResult = {
  evidence: ExternalAcademicEvidence[];
  candidates: AcademicSearchCandidate[];
  stats: AcademicSearchRunStats;
};
