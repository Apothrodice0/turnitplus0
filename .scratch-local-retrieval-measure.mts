/**
 * Local counterpart to app/api/diag-retrieval-latency-q9k3/route.ts — same
 * measurement logic, run directly via tsx against the real lib/ code (no
 * HTTP hop, no deploy) so the "local built server" side of the
 * local-vs-Vercel comparison uses an identical instrumentation approach.
 * Not part of the app; never committed (deleted after use).
 *
 * Usage: node --import tsx .scratch-local-retrieval-measure.mts <path-to-json-with-text-field>
 * (the JSON file should be { "text": "<the real submission text>" })
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHttpContentRetriever } from './lib/http-content-retriever';
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from './lib/academic-search/orchestrator';
import { retrieveCandidateText } from './lib/academic-search/text-retriever';
import { createOpenAireAcademicSearchProvider } from './lib/academic-search/providers/openaire';
import { createEuropePmcAcademicSearchProvider } from './lib/academic-search/providers/europe-pmc';
import { createAcademicSearchBudget, createInMemoryAcademicSearchCache, withRequestControl } from './lib/academic-search/cache';
import { DISCOVERY_BUDGET_LIMIT } from './lib/academic-evidence-integration';
import type { AcademicSearchCandidate } from './lib/academic-search/types';
import type { AcademicSearchProvider } from './lib/academic-search/provider';

const PROVIDER_TIMEOUT_MS = 9_000;
const PROVIDER_MAX_RESULTS_PER_QUERY = 5;
const RETRIEVAL_BUDGET_LIMIT = 15;

type HopLogEntry = {
  url: string;
  status?: number;
  contentType?: string | null;
  location?: string | null;
  httpMs: number;
  downloadMs?: number;
  byteLength?: number | 'unreadable' | null;
  error?: string;
};

type CandidateDiagnostics = {
  rank: number;
  candidateKey: string;
  title: string | null;
  doi: string | null;
  url: string | null;
  contributorProviderIds: string[];
  providerTextAttempts: { providerId: string; ms: number; gotText: boolean }[];
  hops: HopLogEntry[];
  redirectHopCount: number;
  totalHttpMs: number;
  totalDownloadMs: number;
  extractionAndOverheadMs: number;
  finalSource: 'provider' | 'http-fallback' | 'unavailable';
  finalHttpRetrievalStatus: string | null;
  totalCandidateMs: number;
};

function makeDiagnosticFetcher(getActiveLog: () => CandidateDiagnostics | null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const log = getActiveLog();
    const start = Date.now();
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      const httpMs = Date.now() - start;
      log?.hops.push({ url: String(input), httpMs, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const httpMs = Date.now() - start;
    const entry: HopLogEntry = {
      url: String(input),
      status: response.status,
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      httpMs,
    };
    log?.hops.push(entry);
    const downloadStart = Date.now();
    try {
      const bytes = await response.clone().arrayBuffer();
      entry.byteLength = bytes.byteLength;
    } catch {
      entry.byteLength = 'unreadable';
    }
    entry.downloadMs = Date.now() - downloadStart;
    return response;
  }) as typeof fetch;
}

async function measureCandidate(
  candidate: AcademicSearchCandidate,
  rank: number,
  providersById: Record<string, AcademicSearchProvider>,
  diagnosticContentRetriever: ReturnType<typeof createHttpContentRetriever>,
  setActiveLog: (log: CandidateDiagnostics | null) => void,
): Promise<CandidateDiagnostics> {
  const providerTextAttempts: CandidateDiagnostics['providerTextAttempts'] = [];
  const log: CandidateDiagnostics = {
    rank,
    candidateKey: candidate.candidateKey,
    title: candidate.title,
    doi: candidate.doi,
    url: candidate.url,
    contributorProviderIds: candidate.contributors.map((c: AcademicSearchCandidate['contributors'][number]) => c.providerId),
    providerTextAttempts,
    hops: [],
    redirectHopCount: 0,
    totalHttpMs: 0,
    totalDownloadMs: 0,
    extractionAndOverheadMs: 0,
    finalSource: 'unavailable',
    finalHttpRetrievalStatus: null,
    totalCandidateMs: 0,
  };

  const timedProvidersById: Record<string, AcademicSearchProvider> = {};
  for (const [id, provider] of Object.entries(providersById)) {
    if (!provider.getText) {
      timedProvidersById[id] = provider;
      continue;
    }
    timedProvidersById[id] = {
      ...provider,
      getText: async (externalId: string) => {
        const start = Date.now();
        const text = await provider.getText!(externalId);
        providerTextAttempts.push({ providerId: id, ms: Date.now() - start, gotText: Boolean(text && text.trim()) });
        return text;
      },
    };
  }

  setActiveLog(log);
  const result = await retrieveCandidateText(candidate, timedProvidersById, diagnosticContentRetriever);
  setActiveLog(null);

  log.finalSource = result.source;
  log.finalHttpRetrievalStatus = result.httpRetrievalStatus ?? null;
  log.totalCandidateMs = result.latencyMs;
  log.redirectHopCount = log.hops.filter((h) => h.status !== undefined && h.status >= 300 && h.status < 400).length;
  log.totalHttpMs = log.hops.reduce((sum, h) => sum + h.httpMs, 0);
  log.totalDownloadMs = log.hops.reduce((sum, h) => sum + (h.downloadMs ?? 0), 0);
  const providerMs = providerTextAttempts.reduce((sum, a) => sum + a.ms, 0);
  log.extractionAndOverheadMs = Math.max(0, log.totalCandidateMs - providerMs - log.totalHttpMs - log.totalDownloadMs);

  return log;
}

async function runMeasurement(rawText: string, maxCandidatesToRetrieve: number) {
  const cache = createInMemoryAcademicSearchCache();
  const discoveryBudget = createAcademicSearchBudget(DISCOVERY_BUDGET_LIMIT);
  const retrievalBudget = createAcademicSearchBudget(RETRIEVAL_BUDGET_LIMIT);
  const providers: AcademicSearchProvider[] = [
    withRequestControl(createOpenAireAcademicSearchProvider({ maxResultsPerRequest: PROVIDER_MAX_RESULTS_PER_QUERY, timeoutMs: PROVIDER_TIMEOUT_MS }), { cache, discoveryBudget, retrievalBudget }),
    withRequestControl(createEuropePmcAcademicSearchProvider({ maxResultsPerRequest: PROVIDER_MAX_RESULTS_PER_QUERY, timeoutMs: PROVIDER_TIMEOUT_MS }), { cache, discoveryBudget, retrievalBudget }),
  ];
  const providersById = Object.fromEntries(providers.map((p) => [p.id, p]));

  const stage15 = await runAcademicSearch(rawText, providers, { ...DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, maxCandidatesToRetrieve: 0 });

  let activeLog: CandidateDiagnostics | null = null;
  const diagnosticContentRetriever = createHttpContentRetriever({
    allowedContentTypes: ['text/html', 'application/pdf'],
    fetcher: makeDiagnosticFetcher(() => activeLog),
  });

  const toRetrieve = stage15.candidates.slice(0, maxCandidatesToRetrieve);
  const candidateDiagnostics: CandidateDiagnostics[] = [];
  const retrievalStart = Date.now();
  for (let i = 0; i < toRetrieve.length; i++) {
    const diag = await measureCandidate(toRetrieve[i], i, providersById, diagnosticContentRetriever, (log) => { activeLog = log; });
    candidateDiagnostics.push(diag);
  }
  const totalRetrievalMs = Date.now() - retrievalStart;

  return {
    stage1to5: {
      queryCount: stage15.stats.queryCount,
      searchLatencyMs: stage15.stats.searchLatencyMs,
      candidateCountBeforeDedup: stage15.stats.candidateCountBeforeDedup,
      candidateCountAfterDedup: stage15.stats.candidateCountAfterDedup,
      providerErrors: stage15.stats.providerErrors,
    },
    candidatesConsidered: stage15.candidates.length,
    candidatesRetrieved: toRetrieve.length,
    totalRetrievalMs,
    sumOfPerCandidateMs: candidateDiagnostics.reduce((sum, c) => sum + c.totalCandidateMs, 0),
    candidates: candidateDiagnostics,
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node --import tsx .scratch-local-retrieval-measure.mts <path-to-json-with-text-field>');
    process.exit(1);
  }
  const { text, maxCandidatesToRetrieve } = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const n = typeof maxCandidatesToRetrieve === 'number' ? maxCandidatesToRetrieve : DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve;
  console.log(`Running local measurement (maxCandidatesToRetrieve=${n})...`);
  const measurement = await runMeasurement(text, n);
  const outPath = inputPath.replace(/\.json$/, '.local-result.json');
  writeFileSync(outPath, JSON.stringify(measurement, null, 2));
  console.log(`Done. Total retrieval: ${measurement.totalRetrievalMs}ms across ${measurement.candidatesRetrieved} candidates.`);
  console.log(`Result written to ${outPath}`);
}

main().catch((error) => {
  console.error('MEASUREMENT FAILED:', error);
  process.exitCode = 1;
});
