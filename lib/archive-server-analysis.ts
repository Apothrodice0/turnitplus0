import type { Client } from "@libsql/client";
import { matchAgainstArchiveCorpus, type MatchAgainstArchiveCorpusResult } from "./archive-corpus-matching";
import { loadArchiveMatchConfig } from "./archive-static-config";
import { frameArchiveResult, type ArchiveAnalysisResult } from "./archive-result-framing";
import {
  createArchiveReadRetryClient,
  summarizeArchiveReadRetry,
  type ArchiveReadRetryHooks,
  type ArchiveReadRetrySummary,
} from "./archive-read-retry";

/**
 * 100k-scale architecture, slice 2E — the server-only analysis service around
 * the ALREADY-PROVEN committed matcher (lib/archive-corpus-matching.ts's
 * matchAgainstArchiveCorpus: compact + FTS phrase fallback + G1s co-source
 * recovery). It:
 *
 *   1. reads the shipped static config (lib/archive-static-config.ts) — the
 *      same document-index.meta.json / risk-calibration.json the browser
 *      worker fetches;
 *   2. wraps the caller-supplied DB Client in ONE request-scoped bounded
 *      transient-read-retry decorator (lib/archive-read-retry.ts) and runs the
 *      matcher against that wrapper — so a lone Turso 502/503/504 or a
 *      connection reset during archive discovery (phrase fan-out especially)
 *      recovers instead of failing the whole analysis. The retry budget is
 *      shared across every read of this one request (doc count, DF-band load,
 *      compact discovery, candidate order/text, FTS phrase probes, co-source
 *      adjacency) and discarded when the request ends. It NEVER retries a
 *      write — only reads flow through the matcher — and once the budget or a
 *      per-read attempt cap is exhausted the matcher still throws (fail-closed
 *      is preserved: app/api/archive/match's POST fails, runViaServer rejects,
 *      no browser fallback);
 *   3. re-frames the result with the EXACT shared rules
 *      (lib/archive-result-framing.ts's frameArchiveResult) the browser worker
 *      uses.
 *
 * Nothing here changes scoreAgainstArchive, the archive cutoff, the phrase
 * budget, the G1s gate, MIN_SHARED/K/OWNER_CAP, the DF policy, self-exclusion,
 * archive_order, or the historical matcher — it only wires the committed
 * pieces together and maps their output into the public worker-result shape.
 * The retry layer changes only WHETHER a transient read is re-issued, never
 * any query, argument, or result.
 *
 * The co-source (G1s) diagnostics matchAgainstArchiveCorpus returns are kept
 * OUT of `result` (the public payload) and exposed only as `diagnostics` for
 * server logs / tests — never serialised to a client. `readRetry` is likewise
 * server/test-only.
 */

export type ServerArchiveAnalysis = {
  /** The public, worker-shaped result — the ONLY thing a route may serialise. */
  result: ArchiveAnalysisResult;
  /** Server/test-only. matchAgainstArchiveCorpus's discovery + co-source
   *  diagnostics (candidate counts, G1s gate state). Never client-facing. */
  diagnostics: MatchAgainstArchiveCorpusResult["archiveDiscovery"];
  /** Server/test-only. Bounded transient-read-retry accounting for this one
   *  request (retries consumed / remaining, total executes). Never
   *  client-facing. `retriesConsumed > 0` means a transient DB read was
   *  recovered. */
  readRetry: ArchiveReadRetrySummary;
};

export type AnalyzeArchiveOnServerOptions = {
  /** Test-only deterministic hooks for the bounded read-retry layer
   *  (record backoff sleeps, fix jitter). Production leaves this unset:
   *  real setTimeout backoff, real Math.random jitter. */
  readRetry?: ArchiveReadRetryHooks;
};

export async function analyzeArchiveOnServer(
  client: Client,
  text: string,
  options: AnalyzeArchiveOnServerOptions = {},
): Promise<ServerArchiveAnalysis> {
  const config = loadArchiveMatchConfig();

  // ONE request-scoped bounded read-retry wrapper, shared across every archive
  // read below, discarded when this call returns. Reads only — the matcher
  // never writes.
  const { client: readClient, state: retryState } = createArchiveReadRetryClient(client, options.readRetry);

  const matched = await matchAgainstArchiveCorpus(readClient, text, {
    maximumDocumentFrequency: config.maximumDocumentFrequency,
    matchingParameters: config.matchingParameters,
  });

  // matched is ArchiveScoringResult & { archiveDiscovery } — frameArchiveResult
  // reads only the ArchiveScoringResult fields; archiveDiscovery is dropped
  // here and never crosses the network.
  const result = frameArchiveResult(text, matched, config.framing);

  return { result, diagnostics: matched.archiveDiscovery, readRetry: summarizeArchiveReadRetry(retryState) };
}
