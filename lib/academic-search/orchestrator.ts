import type { SourceContentRetriever } from "../retrieval-types";
import { DEFAULT_CANDIDATE_RANKING_WEIGHTS, rankAcademicCandidates, type CandidateRankingWeights } from "./candidate-ranker";
import { compareSubmissionToExternalText } from "./comparator";
import { deduplicateAcademicResults } from "./deduplicator";
import { DEFAULT_PHRASE_EXTRACTION_CONFIG, extractCandidatePhrases, type PhraseExtractionConfig } from "./phrase-extractor";
import { classifyAcademicSearchError, sanitizeAcademicSearchResults, type AcademicSearchProvider } from "./provider";
import { normalizeAcademicResults } from "./result-normalizer";
import { createAcademicSearchContentRetriever, retrieveCandidateText } from "./text-retriever";
import type {
  AcademicSearchProviderError,
  AcademicSearchResult,
  AcademicSearchRunResult,
  AcademicSearchRunStats,
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
  // attempted independently; one failing never stops the others.
  const searchStart = Date.now();
  const rawResults: AcademicSearchResult[] = [];
  for (const query of queries) {
    for (const provider of providers) {
      try {
        const results = await provider.search(query);
        // Phase 5: tag with this query's own type here, not inside the
        // provider — a provider only ever sees query text, never which
        // strategy produced it (see types.ts's own comment on
        // AcademicSearchResult.queryType).
        rawResults.push(...sanitizeAcademicSearchResults(results).map((result) => ({ ...result, queryType: query.queryType })));
      } catch (error) {
        providerErrors.push(classifyAcademicSearchError(provider.id, error));
      }
    }
  }
  const searchLatencyMs = Date.now() - searchStart;

  // Stage 3: ResultNormalizer
  const normalized = normalizeAcademicResults(rawResults);
  const candidateCountBeforeDedup = normalized.length;

  // Stage 4: Deduplicator
  const deduped = deduplicateAcademicResults(normalized);

  // Stage 5: CandidateRanker
  const ranked = rankAcademicCandidates(deduped, config.rankingWeights);

  // Stages 6-8: TextRetriever -> SimilarityComparator -> ExternalAcademicEvidence[]
  const toRetrieve = ranked.slice(0, config.maxCandidatesToRetrieve);
  let textRetrievalLatencyMs = 0;
  let comparisonLatencyMs = 0;
  let candidatesTextRetrieved = 0;
  const evidence: ExternalAcademicEvidence[] = [];

  for (const candidate of toRetrieve) {
    const retrieval = await retrieveCandidateText(candidate, providersById, contentRetriever);
    textRetrievalLatencyMs += retrieval.latencyMs;
    if (!retrieval.text) continue;
    candidatesTextRetrieved += 1;

    const comparisonStart = Date.now();
    const comparison = compareSubmissionToExternalText(submissionText, retrieval.text);
    comparisonLatencyMs += Date.now() - comparisonStart;

    if (comparison.similarity < config.minEvidenceSimilarity) continue;

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
  };

  return { evidence, candidates: ranked, stats };
}
