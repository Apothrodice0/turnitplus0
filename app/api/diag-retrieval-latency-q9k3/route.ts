import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../lib/reports-db';
import { createHttpContentRetriever } from '../../../lib/http-content-retriever';
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from '../../../lib/academic-search/orchestrator';
import { retrieveCandidateText } from '../../../lib/academic-search/text-retriever';
import { createOpenAireAcademicSearchProvider } from '../../../lib/academic-search/providers/openaire';
import { createEuropePmcAcademicSearchProvider } from '../../../lib/academic-search/providers/europe-pmc';
import { createAcademicSearchBudget, createInMemoryAcademicSearchCache, withRequestControl } from '../../../lib/academic-search/cache';
import { DISCOVERY_BUDGET_LIMIT } from '../../../lib/academic-evidence-integration';
import type { AcademicSearchCandidate } from '../../../lib/academic-search/types';
import type { AcademicSearchProvider } from '../../../lib/academic-search/provider';
import type { SimilarityReport } from '../../../lib/report-types';

/**
 * TEMPORARY diagnostic-only endpoint. Not part of the product. Added to
 * break textRetrievalLatencyMs into a real per-candidate breakdown (URL,
 * redirect hops, HTTP time, download time, extraction+overhead, final
 * status) for one real production report, on the real Vercel production
 * runtime — investigating why the ~5-6s remaining after the Stage 2
 * concurrency fix (see the commit that added lib/academic-search/
 * concurrency.ts) is spent. To be deleted once that investigation is done.
 *
 * Gated on a request header checked against a SHA-256 hash embedded below
 * (never the plaintext secret) rather than an env var — this repo
 * deliberately does not mirror production DB credentials to any local env
 * file (see .env.production.local's own comment), and setting a new
 * production env var here would carry the same "modifies shared prod
 * config" weight this investigation is explicitly trying to avoid before a
 * root cause is established. Requests without the correct header get a
 * plain 404, identical to a route that does not exist.
 *
 * Two modes, selected by request body shape:
 *  - { mode: "lookup" }: lists recent saved_reports (id/title/wordCount/
 *    createdAt only — never document text) so the right test case can be
 *    identified from outside without ever exposing report content.
 *  - { mode: "measure", id, deviceKey, maxCandidatesToRetrieve? }: loads
 *    that one report's stored text and runs the real academic-search
 *    pipeline against it with diagnostic timing wrapped around the two
 *    existing injection points (SourceContentRetriever, AcademicSearchProvider
 *    .getText) — same real providers, same real budgets/cache, same real
 *    retrieveCandidateText() call per candidate, in the same real
 *    sequential order orchestrator.ts's own Stage 6-8 loop uses. No
 *    candidate ranking, provider query, PDF extraction, or retrieval logic
 *    is modified anywhere — only observed via the fetcher/getText seams
 *    already designed to be injectable.
 */

const DIAG_SECRET_HASH = 'de1f46e21582c2b6a4b95c59c8b3dcd44b8d5aaa713ae827790124afe2f6d286';

function isAuthorized(request: Request): boolean {
  const provided = request.headers.get('x-diag-secret');
  if (!provided) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = Buffer.from(DIAG_SECRET_HASH, 'hex');
  return providedHash.length === expectedHash.length && timingSafeEqual(providedHash, expectedHash);
}

// Mirrors lib/academic-evidence-integration.ts's own (non-exported)
// PROVIDER_TIMEOUT_MS / PROVIDER_MAX_RESULTS_PER_QUERY / RETRIEVAL_BUDGET_LIMIT
// exactly, so this diagnostic run reproduces the real production call shape.
// DISCOVERY_BUDGET_LIMIT is imported directly (it IS exported) rather than
// duplicated, per that file's own comment on why it must never drift.
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

  // Times each contributing provider's getText() individually (same
  // providers, same cache/budget wrapping the real pipeline uses) by
  // wrapping getText per attempt here rather than modifying provider.ts —
  // retrieveCandidateText itself is called unmodified below and stops at
  // the first contributor that returns real text, exactly as production
  // does; this only observes each attempt it makes along the way.
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

  // Stage 1-5 only (maxCandidatesToRetrieve: 0 skips retrieval entirely) —
  // real, unmodified runAcademicSearch, so phrase extraction/search/dedup/
  // ranking are exactly what production would have produced.
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
    // Sequential, awaited — deliberately mirrors orchestrator.ts's own
    // Stage 6-8 loop exactly (not concurrent), since whether that seriality
    // itself is the bottleneck is one of this investigation's own questions.
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

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const { mode } = body as Record<string, unknown>;

  const client = await getReportsDbClient();
  try {
    if (mode === 'lookup') {
      const since = typeof (body as Record<string, unknown>).since === 'string' ? (body as Record<string, unknown>).since as string : '2026-08-20';
      const result = await client.execute({
        sql: 'SELECT id, device_key, title, word_count, created_at FROM saved_reports WHERE created_at >= ? ORDER BY created_at DESC LIMIT 40',
        args: [since],
      });
      return NextResponse.json({ rows: result.rows });
    }

    if (mode === 'measure') {
      const { id, deviceKey, maxCandidatesToRetrieve } = body as Record<string, unknown>;
      if (typeof id !== 'string' || typeof deviceKey !== 'string') {
        return new NextResponse(JSON.stringify({ error: 'id and deviceKey are required strings' }), { status: 400 });
      }
      const row = await client.execute({
        sql: 'SELECT payload_json, title, word_count FROM saved_reports WHERE device_key = ? AND id = ?',
        args: [deviceKey, id],
      });
      const record = row.rows[0] as unknown as { payload_json: string; title: string; word_count: number } | undefined;
      if (!record) {
        return new NextResponse(JSON.stringify({ error: 'Report not found' }), { status: 404 });
      }
      const payload = JSON.parse(String(record.payload_json)) as SimilarityReport;
      const n = typeof maxCandidatesToRetrieve === 'number' ? maxCandidatesToRetrieve : DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve;

      const measurement = await runMeasurement(payload.text, n);
      return NextResponse.json({
        report: { title: record.title, wordCount: record.word_count, textLength: payload.text.length },
        runtime: { region: process.env.VERCEL_REGION ?? null, vercelEnv: process.env.VERCEL_ENV ?? null },
        measurement,
      });
    }

    return new NextResponse(JSON.stringify({ error: 'mode must be "lookup" or "measure"' }), { status: 400 });
  } finally {
    client.close();
  }
}
