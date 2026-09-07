import type { Client } from "@libsql/client";

/**
 * The global corpus-match generation counter (drizzle/0036,
 * corpus_match_generation, single row id=1) — a monotonically increasing
 * "the set of corpus content eligible for historical matching has changed"
 * epoch. Every event that ADDS matchable content bumps it:
 *   - a corpus-admission promotion reaching 'indexed'
 *     (lib/corpus-admission-promotion.ts's indexPromotionAtomically)
 *   - a deactivated fingerprint reactivated, and a deactivation
 *     (lib/corpus-admission-admin-actions.ts)
 *   - a user submission indexed into the reusable corpus
 *     (lib/user-submission-corpus.ts's indexDocumentSubmissionIntoCorpus)
 * A cached report_historical_match_snapshots row is only reused while its
 * own stored corpus_generation is still >= the current global value — the
 * exact same staleness discipline the matcher/fingerprint/canonicalization
 * version columns already use (see lib/report-historical-match.ts's
 * isSnapshotRowCurrent).
 *
 * Split out of lib/report-historical-match.ts into its own tiny module so
 * lib/user-submission-corpus.ts can bump the counter without importing the
 * report bridge layer (which itself imports user-submission-corpus — a
 * cycle). lib/report-historical-match.ts re-exports both functions, so every
 * existing importer is unaffected.
 */

/**
 * Reads the current global corpus-match generation — always fresh, never
 * cached in memory, same discipline as isCorpusSourceMatchingEnabled()'s own
 * live process.env read. The seed row (id=1, generation=0) is inserted by
 * the migration itself; this never needs to create it.
 */
export async function getCurrentCorpusMatchGeneration(execOrTx: Pick<Client, "execute">): Promise<number> {
  const result = await execOrTx.execute("SELECT generation FROM corpus_match_generation WHERE id = 1");
  const row = result.rows[0] as unknown as { generation: number | bigint } | undefined;
  return row ? Number(row.generation) : 0;
}

/**
 * Bumps the global generation by 1 — called whenever corpus eligibility is
 * ADDED (a promotion newly 'indexed', a fingerprint reactivated, a user
 * submission indexed) and, defensively, on removal (a deactivation, which
 * also runs targeted per-representation invalidation). Safe to call more
 * than once for what is conceptually "one" eligibility-changing event — an
 * extra bump only means an extra harmless recompute somewhere, never a
 * missed one.
 */
export async function bumpCorpusMatchGeneration(execOrTx: Pick<Client, "execute">): Promise<void> {
  await execOrTx.execute("UPDATE corpus_match_generation SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1");
}
