import type { SourceContentRetriever } from "../retrieval-types";
import { DEFAULT_CANDIDATE_RANKING_WEIGHTS, rankAcademicCandidates, type CandidateRankingWeights } from "./candidate-ranker";
import { compareSubmissionToExternalText } from "./comparator";
import { mapWithConcurrency } from "./concurrency";
import { deduplicateAcademicResults } from "./deduplicator";
import { buildSubmissionTermProfile, computeMetadataRelevanceBonus } from "./metadata-relevance";
import { DEFAULT_PHRASE_EXTRACTION_CONFIG, extractCandidatePhrases, type PhraseExtractionConfig } from "./phrase-extractor";
import { classifyAcademicSearchError, sanitizeAcademicSearchResults, type AcademicSearchProvider } from "./provider";
import { normalizeAcademicResults } from "./result-normalizer";
import { createAcademicSearchContentRetriever, retrieveCandidateText } from "./text-retriever";
import type {
  AcademicSearchProviderError,
  AcademicSearchResult,
  AcademicSearchRetrievalDiagnostic,
  AcademicSearchRunResult,
  AcademicSearchRunStats,
  AcademicSearchStatus,
  ExternalAcademicEvidence,
} from "./types";

/**
 * Ties every stage together (STEP 3's pipeline diagram) and is the one
 * place in this subsystem responsible for STEP 8's central requirement:
 * provider failure must never break a normal TurnitPlus report. Every
 * external call (a provider's search()/getText(), or the HTTP text-retrieval
 * fallback) is individually try/caught; runAcademicSearch itself never
 * throws — a total provider outage still resolves with an empty evidence
 * array and a populated providerErrors list, not a rejected promise.
 *
 * This function is the ONLY place in lib/academic-search/ that knows about
 * every stage at once; every other file in this directory is independently
 * testable in isolation (STEP 4's explicit requirement for the phrase
 * extractor, generalized here to the whole pipeline).
 */

export type AcademicSearchRunConfig = {
  phraseExtraction: PhraseExtractionConfig;
  rankingWeights: CandidateRankingWeights;
  /** How many top-ranked candidates to attempt text retrieval + comparison for — bounds retrieval cost independently of how many candidates were discovered. */
  maxCandidatesToRetrieve: number;
  /** Comparator similarity (0..100) floor below which a candidate is not reported as evidence — still counted in stats/candidates either way. */
  minEvidenceSimilarity: number;
};

export const DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG: AcademicSearchRunConfig = {
  phraseExtraction: DEFAULT_PHRASE_EXTRACTION_CONFIG,
  rankingWeights: DEFAULT_CANDIDATE_RANKING_WEIGHTS,
  maxCandidatesToRetrieve: 5,
  minEvidenceSimilarity: 15,
};

/**
 * Stage 2's worker-pool width. Measured production latency (real DOCX
 * upload, 24 queries x 2 providers = 48 sequential attempts) was ~68s of
 * pure search latency; bounded concurrency in the 4-6 range keeps every
 * existing per-call safeguard (each provider's own AbortController timeout,
 * its own bounded retry, the shared discoveryBudget) exactly as-is while
 * cutting worst-case wall time by roughly this factor. Not higher: staying
 * in single digits keeps simultaneous load against free public APIs
 * (OpenAIRE, Europe PMC) modest, matching this subsystem's existing "stay
 * free, stay polite" discipline (see cache.ts's own header comment).
 */
const STAGE_TWO_CONCURRENCY = 5;

export async function runAcademicSearch(
  submissionText: string,
  providers: AcademicSearchProvider[],
  config: AcademicSearchRunConfig = DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG,
  contentRetriever: SourceContentRetriever = createAcademicSearchContentRetriever(),
): Promise<AcademicSearchRunResult> {
  const totalStart = Date.now();
  const providerErrors: AcademicSearchProviderError[] = [];
  const providersById: Record<string, AcademicSearchProvider> = Object.fromEntries(providers.map((p) => [p.id, p]));

  // Stage 1: PhraseExtractor
  const queries = extractCandidatePhrases(submissionText, config.phraseExtraction);

  // Stage 2: AcademicSearchProvider — every (query, provider) pair is
  // attempted independently; one failing never stops the others. Run with
  // STAGE_TWO_CONCURRENCY in-flight attempts at once (a worker pool pulling
  // from a shared cursor — see concurrency.ts) instead of one at a time:
  // this was the sole cause of ~70s report-generation latency (24 queries x
  // 2 providers = 48 fully sequential round-trips). Each attempt's outcome
  // is written into a slot pre-assigned by its position in the flattened
  // (query, provider) task list, then flattened back in that original
  // order below — so a slow/reordered completion can change *when* a task
  // finishes but never *where* its result lands, and rawResults/
  // providerErrors end up byte-identical to what the old sequential loop
  // produced for the same provider responses. This matters concretely:
  // deduplicator.ts's dedupKey-first-seen grouping and its firstNonNull()
  // metadata picks are order-sensitive (see its own header comment), so
  // preserving exact task order is what keeps Stage 4/5's output unchanged.
  const searchStart = Date.now();
  const searchTasks: { query: (typeof queries)[number]; provider: AcademicSearchProvider }[] = [];
  for (const query of queries) {
    for (const provider of providers) {
      searchTasks.push({ query, provider });
    }
  }

  const resultsByTask: (AcademicSearchResult[] | undefined)[] = new Array(searchTasks.length);
  const errorByTask: (AcademicSearchProviderError | undefined)[] = new Array(searchTasks.length);

  await mapWithConcurrency(searchTasks, STAGE_TWO_CONCURRENCY, async ({ query, provider }, index) => {
    try {
      const results = await provider.search(query);
      // Phase 5: tag with this query's own type here, not inside the
      // provider — a provider only ever sees query text, never which
      // strategy produced it (see types.ts's own comment on
      // AcademicSearchResult.queryType).
      resultsByTask[index] = sanitizeAcademicSearchResults(results).map((result) => ({ ...result, queryType: query.queryType }));
    } catch (error) {
      errorByTask[index] = classifyAcademicSearchError(provider.id, error);
    }
  });

  const rawResults: AcademicSearchResult[] = [];
  for (const results of resultsByTask) {
    if (results) rawResults.push(...results);
  }
  for (const error of errorByTask) {
    if (error) providerErrors.push(error);
  }
  const searchLatencyMs = Date.now() - searchStart;

  // Stage 3: ResultNormalizer
  const normalized = normalizeAcademicResults(rawResults);
  const candidateCountBeforeDedup = normalized.length;

  // Stage 4: Deduplicator
  const deduped = deduplicateAcademicResults(normalized);

  // Stage 5: CandidateRanker
  // Metadata-relevance investigation: computed entirely from data Stage 2's
  // own search() calls already returned (title/abstract — see
  // providers/openaire.ts and providers/europe-pmc.ts's own header
  // comments) and the submission text passed into this function, so this
  // never costs an extra network call and always runs before Stage 6-8's
  // retrieval budget is touched. See metadata-relevance.ts's own header
  // comment for the full account, including why the submission's own
  // administrative boilerplate is stripped first.
  const submissionProfile = buildSubmissionTermProfile(submissionText);
  const metadataRelevanceBonus = computeMetadataRelevanceBonus(deduped, submissionProfile);
  const ranked = rankAcademicCandidates(deduped, config.rankingWeights, metadataRelevanceBonus);

  // Stages 6-8: TextRetriever -> SimilarityComparator -> ExternalAcademicEvidence[]
  const toRetrieve = ranked.slice(0, config.maxCandidatesToRetrieve);
  let textRetrievalLatencyMs = 0;
  let comparisonLatencyMs = 0;
  let candidatesTextRetrieved = 0;
  const evidence: ExternalAcademicEvidence[] = [];
  const retrievalDiagnostics: AcademicSearchRetrievalDiagnostic[] = [];

  for (const candidate of toRetrieve) {
    const retrieval = await retrieveCandidateText(candidate, providersById, contentRetriever);
    textRetrievalLatencyMs += retrieval.latencyMs;
    if (!retrieval.text) {
      retrievalDiagnostics.push({
        candidateKey: candidate.candidateKey,
        rank: candidate.rank,
        doi: candidate.doi,
        url: candidate.url,
        title: candidate.title,
        retrievalSource: retrieval.source,
        retrievalProviderId: retrieval.providerId,
        httpRetrievalStatus: retrieval.httpRetrievalStatus,
        retrievalLatencyMs: retrieval.latencyMs,
        retrievedTextLength: null,
        comparisonSimilarity: null,
        includedAsEvidence: false,
      });
      continue;
    }
    candidatesTextRetrieved += 1;

    const comparisonStart = Date.now();
    const comparison = compareSubmissionToExternalText(submissionText, retrieval.text);
    comparisonLatencyMs += Date.now() - comparisonStart;

    const includedAsEvidence = comparison.similarity >= config.minEvidenceSimilarity;
    retrievalDiagnostics.push({
      candidateKey: candidate.candidateKey,
      rank: candidate.rank,
      doi: candidate.doi,
      url: candidate.url,
      title: candidate.title,
      retrievalSource: retrieval.source,
      retrievalProviderId: retrieval.providerId,
      httpRetrievalStatus: retrieval.httpRetrievalStatus,
      retrievalLatencyMs: retrieval.latencyMs,
      retrievedTextLength: retrieval.text.length,
      comparisonSimilarity: comparison.similarity,
      includedAsEvidence,
    });

    if (!includedAsEvidence) continue;

    const attributedProviderId = retrieval.providerId ?? candidate.contributors[0]?.providerId ?? null;
    const attributedContributor = candidate.contributors.find((c) => c.providerId === attributedProviderId) ?? candidate.contributors[0];

    evidence.push({
      provider: attributedContributor?.providerId ?? "unknown",
      providerId: attributedContributor?.externalId ?? candidate.candidateKey,
      title: candidate.title,
      authors: candidate.authors,
      publication: candidate.publication,
      year: candidate.year,
      doi: candidate.doi,
      url: candidate.url,
      matchedPassages: comparison.matchedPassages,
      similarity: comparison.similarity,
    });
  }

  const searchAttempts = queries.length * providers.length;
  const stats: AcademicSearchRunStats = {
    queryCount: queries.length,
    searchLatencyMs,
    candidateCountBeforeDedup,
    candidateCountAfterDedup: deduped.length,
    deduplicationRate: candidateCountBeforeDedup > 0 ? (candidateCountBeforeDedup - deduped.length) / candidateCountBeforeDedup : 0,
    candidatesTextRetrieved,
    textRetrievalLatencyMs,
    comparisonLatencyMs,
    totalLatencyMs: Date.now() - totalStart,
    providerErrors,
    searchAttempts,
  };

  // "start the two fixes now" TASK 2 — see AcademicSearchStatus's own
  // header comment for the exact rule. A total outage (every attempted
  // (query, provider) call errored) must never look identical to a
  // legitimate zero-evidence result to a downstream caller.
  const status: AcademicSearchStatus =
    evidence.length > 0 ? "COMPLETE_WITH_MATCHES"
    : searchAttempts > 0 && providerErrors.length >= searchAttempts ? "FAILED"
    : "COMPLETE_NO_MATCHES";

  return { evidence, candidates: ranked, stats, status, queries, retrievalDiagnostics };
}
