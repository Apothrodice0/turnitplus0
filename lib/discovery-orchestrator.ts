import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { DiscoveryCandidate, DiscoveryPurpose, DiscoveryQuery, DiscoverySignals, TaggedProviderResult } from "./discovery-types";
import { generateDiscoverySignals, DEFAULT_DISCOVERY_SIGNAL_CONFIG, type DiscoverySignalConfig } from "./discovery-signals";
import { generateDiscoveryQueries, DEFAULT_QUERY_GENERATION_CONFIG, type QueryGenerationConfig } from "./discovery-query-generation";
import { deduplicateDiscoveryResults, rankDiscoveryCandidates, DEFAULT_CANDIDATE_RANKING_WEIGHTS, type CandidateRankingWeights } from "./discovery-candidates";
import { sanitizeProviderResults, classifyProviderError, type SourceDiscoveryProvider } from "./discovery-providers";
import { recordDiscoveryAttempt } from "./discovery-repository";

/**
 * Phase E6A: the discovery orchestrator — the one place that ties a
 * document's signals, a bounded query set, a list of providers, and the
 * dedup/rank pipeline together into "here are the candidates we found."
 *
 * This function is NOT called from anywhere in the live application in
 * this phase — not app/api/reports/route.ts, not app/similarity-worker.ts,
 * nowhere. It exists purely as infrastructure a future, separately-
 * approved phase can wire in. See tests/discovery-orchestrator.test.mjs's
 * structural "not imported by any live route" test, and this phase's own
 * task description, section 18.
 *
 * Every provider is called independently; one provider throwing never
 * aborts the others — a single flaky/unavailable provider must not prevent
 * discovery via every other configured provider (this phase's own task
 * description, section 13).
 */

export type RunDiscoveryParams = {
  documentIdentityId?: string | null;
  purpose: DiscoveryPurpose;
  title?: string | null;
  author?: string | null;
  rawText: string;
  canonicalHash?: string | null;
  providers: SourceDiscoveryProvider[];
  signalConfig?: DiscoverySignalConfig;
  queryConfig?: QueryGenerationConfig;
  rankingWeights?: CandidateRankingWeights;
  /** Optional — when supplied, each provider attempt is persisted via lib/discovery-repository.ts. When omitted, runDiscovery is fully in-memory/pure-ish (no DB access at all), which is how every test in this phase that doesn't specifically test persistence uses it. */
  client?: Client | null;
};

export type DiscoveryAttemptSummary = {
  providerId: string;
  providerType: SourceDiscoveryProvider["type"];
  status: "OK" | "NO_RESULTS" | "PROVIDER_UNAVAILABLE" | "TIMEOUT" | "RATE_LIMITED" | "ERROR";
  resultCount: number;
  errorMessage: string | null;
};

export type RunDiscoveryResult = {
  requestId: string;
  signals: DiscoverySignals;
  queries: DiscoveryQuery[];
  candidates: DiscoveryCandidate[];
  attempts: DiscoveryAttemptSummary[];
};

export async function runDiscovery(params: RunDiscoveryParams): Promise<RunDiscoveryResult> {
  const requestId = randomUUID();
  const signals = generateDiscoverySignals(
    { title: params.title, author: params.author, rawText: params.rawText, canonicalHash: params.canonicalHash },
    params.signalConfig ?? DEFAULT_DISCOVERY_SIGNAL_CONFIG,
  );
  const queries = generateDiscoveryQueries(signals, params.queryConfig ?? DEFAULT_QUERY_GENERATION_CONFIG);

  const allResults: TaggedProviderResult[] = [];
  const attempts: DiscoveryAttemptSummary[] = [];

  for (const provider of params.providers) {
    const requestedAt = new Date().toISOString();
    try {
      const raw = await provider.discover({ requestId, queries, signals });
      const sanitized = sanitizeProviderResults(raw);
      const tagged: TaggedProviderResult[] = sanitized.map((r) => ({ ...r, providerId: provider.id, providerType: provider.type }));
      allResults.push(...tagged);
      const status = sanitized.length > 0 ? "OK" : "NO_RESULTS";
      attempts.push({ providerId: provider.id, providerType: provider.type, status, resultCount: sanitized.length, errorMessage: null });
      if (params.client) {
        await recordDiscoveryAttempt(params.client, {
          requestId,
          documentIdentityId: params.documentIdentityId ?? null,
          purpose: params.purpose,
          providerId: provider.id,
          providerType: provider.type,
          queriesUsed: queries.map((q) => q.queryText),
          status,
          resultCount: sanitized.length,
          rawResults: sanitized,
          requestedAt,
          respondedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      const status = classifyProviderError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      attempts.push({ providerId: provider.id, providerType: provider.type, status, resultCount: 0, errorMessage });
      if (params.client) {
        await recordDiscoveryAttempt(params.client, {
          requestId,
          documentIdentityId: params.documentIdentityId ?? null,
          purpose: params.purpose,
          providerId: provider.id,
          providerType: provider.type,
          queriesUsed: queries.map((q) => q.queryText),
          status,
          resultCount: 0,
          errorMessage,
          requestedAt,
          respondedAt: new Date().toISOString(),
        });
      }
      // A provider's failure is isolated to its own attempt record — every
      // remaining provider is still tried.
    }
  }

  const deduplicated = deduplicateDiscoveryResults(allResults);
  const candidates = rankDiscoveryCandidates(deduplicated, signals, params.rankingWeights ?? DEFAULT_CANDIDATE_RANKING_WEIGHTS);

  return { requestId, signals, queries, candidates, attempts };
}
