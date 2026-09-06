import type { Client } from "@libsql/client";
import { matchAgainstArchiveCorpus, type MatchAgainstArchiveCorpusResult } from "./archive-corpus-matching";
import { loadArchiveMatchConfig } from "./archive-static-config";
import { frameArchiveResult, type ArchiveAnalysisResult } from "./archive-result-framing";

/**
 * 100k-scale architecture, slice 2E — the server-only analysis service around
 * the ALREADY-PROVEN committed matcher (lib/archive-corpus-matching.ts's
 * matchAgainstArchiveCorpus: compact + FTS phrase fallback + G1s co-source
 * recovery). It:
 *
 *   1. reads the shipped static config (lib/archive-static-config.ts) — the
 *      same document-index.meta.json / risk-calibration.json the browser
 *      worker fetches;
 *   2. runs the matcher against the caller-supplied DB Client (established
 *      server DB plumbing — app/api/archive/match/route.ts passes
 *      getReportsDbClient());
 *   3. re-frames the result with the EXACT shared rules
 *      (lib/archive-result-framing.ts's frameArchiveResult) the browser worker
 *      uses.
 *
 * Nothing here changes scoreAgainstArchive, the archive cutoff, the phrase
 * budget, the G1s gate, MIN_SHARED/K/OWNER_CAP, the DF policy, self-exclusion,
 * archive_order, or the historical matcher — it only wires the committed
 * pieces together and maps their output into the public worker-result shape.
 *
 * The co-source (G1s) diagnostics matchAgainstArchiveCorpus returns are kept
 * OUT of `result` (the public payload) and exposed only as `diagnostics` for
 * server logs / tests — never serialised to a client.
 */

export type ServerArchiveAnalysis = {
  /** The public, worker-shaped result — the ONLY thing a route may serialise. */
  result: ArchiveAnalysisResult;
  /** Server/test-only. matchAgainstArchiveCorpus's discovery + co-source
   *  diagnostics (candidate counts, G1s gate state). Never client-facing. */
  diagnostics: MatchAgainstArchiveCorpusResult["archiveDiscovery"];
};

export async function analyzeArchiveOnServer(
  client: Client,
  text: string,
): Promise<ServerArchiveAnalysis> {
  const config = loadArchiveMatchConfig();

  const matched = await matchAgainstArchiveCorpus(client, text, {
    maximumDocumentFrequency: config.maximumDocumentFrequency,
    matchingParameters: config.matchingParameters,
  });

  // matched is ArchiveScoringResult & { archiveDiscovery } — frameArchiveResult
  // reads only the ArchiveScoringResult fields; archiveDiscovery is dropped
  // here and never crosses the network.
  const result = frameArchiveResult(text, matched, config.framing);

  return { result, diagnostics: matched.archiveDiscovery };
}
