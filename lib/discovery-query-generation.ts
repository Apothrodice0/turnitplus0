import type { DiscoverySignals, DiscoveryQuery } from "./discovery-types";

/**
 * Phase E6A: deterministic, pure query generation from already-extracted
 * discovery signals (lib/discovery-signals.ts). Nothing here sends
 * anything anywhere — see this phase's own task description, section 4:
 * "Do NOT actually send these queries anywhere yet."
 *
 * Distinctive passages are the only signal specific enough to become a
 * query by themselves. Title and author are deliberately never emitted as
 * standalone queries — only combined, and only when both are present — per
 * this phase's own task description, section 3: "Do not make title alone
 * sufficient. Do not make author alone sufficient." A query's `basis` array
 * is therefore never exactly ["TITLE"] or exactly ["AUTHOR"]; see
 * tests/discovery-signals.test.mjs for the structural proof.
 */

export type QueryGenerationConfig = {
  /** Hard cap on the number of queries returned — "avoid generating hundreds/thousands of queries." */
  maxQueries: number;
};

export const DEFAULT_QUERY_GENERATION_CONFIG: QueryGenerationConfig = {
  maxQueries: 6,
};

export function generateDiscoveryQueries(
  signals: DiscoverySignals,
  config: QueryGenerationConfig = DEFAULT_QUERY_GENERATION_CONFIG,
): DiscoveryQuery[] {
  const queries: Omit<DiscoveryQuery, "rank">[] = [];

  for (const passage of signals.distinctivePassages) {
    queries.push({ queryText: passage, basis: ["DISTINCTIVE_PASSAGE"] });
  }

  if (signals.normalizedTitle && signals.normalizedAuthor) {
    queries.push({
      queryText: `${signals.normalizedTitle} ${signals.normalizedAuthor}`,
      basis: ["TITLE", "AUTHOR"],
    });
  }

  return queries.slice(0, Math.max(0, config.maxQueries)).map((query, index) => ({ ...query, rank: index }));
}
