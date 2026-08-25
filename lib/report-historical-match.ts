import type { Client } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";
import { matchAgainstUserSubmissionCorpus, isCorpusSourceMatchingEnabled, USER_SUBMISSION_MATCHER_VERSION } from "./user-submission-matching";
import { CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION } from "./user-submission-corpus";
import { canonicalSha256, findPriorSubmissionsForAccount } from "./document-identity";
import type { ReportHistoricalSubmissionMatch, HistoricalSubmissionMatchEntry } from "./report-types";

/**
 * Phase E8C bridge layer: turns a saved report's raw text + viewing account
 * into the ReportHistoricalSubmissionMatch snapshot attached to it as
 * SimilarityReport.historicalSubmissionMatch — the same role
 * lib/report-classification.ts plays for Phase D's matchClassification, but
 * backed by Phase E8A/E8B's corpus/matcher instead of Phase B's family
 * system. This is the only module that knows about both "reports" and
 * "the user submission corpus" — lib/user-submission-matching.ts stays
 * unaware of the report shape, exactly as lib/document-family.ts does for
 * Phase D.
 *
 * Deliberately never touches SimilarityReport.score/archiveScore, never
 * imports lib/provenance-verification-workflow.ts, never imports any E7
 * module (the 230-document historical evaluation corpus stays a separate
 * dataset), and never calls ASJP/Crossref discovery — see
 * tests/report-historical-match.test.mjs's structural checks.
 *
 * Snapshot/staleness model (this phase's own task description, section 14):
 * report_historical_match_snapshots holds exactly one row per report,
 * upserted on recompute. A stored snapshot is reused as-is when its three
 * version tags (matcher/fingerprint/canonicalization) all equal the
 * CURRENT_VERSIONS below; if any differ (or no snapshot exists yet), a
 * fresh computation runs and overwrites it via INSERT ... ON CONFLICT DO
 * UPDATE — atomic, so two simultaneous requests computing the same stale
 * snapshot race harmlessly to the same eventually-consistent row (this
 * phase's own task description, section 15) rather than needing a lock
 * table. A computation failure is itself persisted as status "FAILED" (never
 * thrown past this function) so a permanently-failing document does not get
 * recomputed on every single report view.
 *
 * Phase E8E fix: a cached "NO_HISTORICAL_MATCH" row is the one exception —
 * it is never reused, even with current version tags. Phase E8D activated
 * save-time indexing via a genuinely deferred after() callback in
 * production, so a report can legitimately be viewed for the first time
 * before another account's earlier upload has finished indexing; the very
 * first view would then compute and permanently cache NO_HISTORICAL_MATCH,
 * silently hiding a real PRIOR_SUBMISSION/SELF match that only exists a
 * moment later — version tags never change to invalidate it, since nothing
 * about the matcher/fingerprint/canonicalization changed, only the corpus's
 * contents did.
 *
 * corpus-source matching addendum (this file's own review required this
 * THREE times now — each round below records what the previous one got
 * wrong, on purpose, rather than silently rewriting history): "MATCHED
 * cannot go stale, new content cannot make an existing match disappear"
 * stopped being true once TURNITPLUS_CORPUS_SOURCE entries existed. TWO
 * different staleness causes, TWO different mechanisms working TOGETHER
 * (not three separate ones as an earlier version of this comment claimed —
 * see point 1's own correction):
 *
 *   1. EVERY eligibility change — added (a promotion newly reaches
 *      'indexed', a deactivated fingerprint reactivated) or removed (an
 *      admin deactivates a fingerprint) — bumps the GLOBAL corpus-match
 *      generation (bumpCorpusMatchGeneration below, corpus_match_generation
 *      table, drizzle/0036). This is the actual correctness mechanism,
 *      uniformly, for all three events. An EARLIER version of this comment
 *      claimed targeted, per-representation deletion (below) was "sound and
 *      sufficient" for the deactivation direction on its own — that was
 *      wrong, caught by this file's third review: a concurrent
 *      getOrComputeHistoricalMatchSnapshot call can read this
 *      representation while still eligible, then not write its own
 *      snapshot until AFTER a deactivation's targeted DELETE has already
 *      committed — the DELETE runs against a row that does not exist yet,
 *      finds nothing, and the concurrent write lands moments later already
 *      stale, with nothing left to ever invalidate it (see the barrier
 *      test in tests/report-historical-match-invalidation.test.mjs, which
 *      reproduces exactly this ordering). The generation bump closes this
 *      regardless of write timing: that concurrent computation captured
 *      the OLD generation value before it ever started (currentGeneration
 *      below is read once, at the top of getOrComputeHistoricalMatchSnapshot,
 *      BEFORE any candidate search), so its stale write is stamped with a
 *      generation the bump has already moved past — correctly rejected as
 *      stale the very next time anyone views that report, no matter
 *      exactly when its write landed relative to the deactivating
 *      transaction's commit. Compared the same way the matcher/
 *      fingerprint/canonicalization version tags already are.
 *
 *   2. Deactivation ADDITIONALLY runs targeted, per-representation deletion
 *      (invalidateHistoricalMatchSnapshotsForRepresentation below) — kept
 *      as an OPTIMIZATION, not the correctness mechanism: for the common,
 *      non-racing case (a report's cached snapshot already exists and
 *      already references the now-deactivated representation), this
 *      removes it in the SAME commit, so that report stops showing a stale
 *      match immediately rather than waiting for its own next view to
 *      notice the generation bump. Promotion and reactivation have no
 *      equivalent optimization available (see lib/corpus-admission-
 *      admin-actions.ts's own reactivateAcceptedRepresentation comment for
 *      why: adding eligibility can only ever affect a report that does NOT
 *      reference the representation yet, which a targeted search can never
 *      find in the first place) — generation bump alone, for those two.
 *
 *   3. The CORPUS_SOURCE_MATCHING_ENABLED flag changing — NEVER invalidation
 *      (an env var flip is not a database event this process can hook), a
 *      read-time FILTER instead (applyCorpusSourceMatchingFlag below):
 *      getOrComputeHistoricalMatchSnapshot always strips
 *      TURNITPLUS_CORPUS_SOURCE entries from whatever it is about to
 *      return — freshly computed OR loaded from cache — whenever the flag
 *      reads false at that moment, RECOMPUTING status (not just filtering
 *      the array) so a corpus-only match cleanly becomes NO_HISTORICAL_MATCH
 *      rather than an empty-but-"MATCHED" result a caller could
 *      misinterpret. This is what makes "clearing the flag immediately
 *      hides cached corpus matches" true without touching a single row —
 *      the same "no code change, no matcher change, no database change"
 *      rollback story lib/e8p-visibility.ts's own E8P_VISIBILITY_ALLOWLIST
 *      already proves for this exact codebase.
 *
 * A "partial" result (lib/user-submission-matching.ts's own soft time
 * budget was exceeded — see that file's TIMEOUT HONESTY comment) is treated
 * like NO_HISTORICAL_MATCH for staleness purposes: never cached as final,
 * always recomputed on next view (is_partial column, drizzle/0035) — an
 * incomplete computation must never be mistaken for a settled one.
 */

const CURRENT_VERSIONS = {
  matcherVersion: USER_SUBMISSION_MATCHER_VERSION,
  fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
  canonicalizationVersion: CANONICALIZATION_VERSION,
};

type SnapshotRow = {
  status: string;
  matcher_version: string | null;
  fingerprint_version: string | null;
  canonicalization_version: string | null;
  result_json: string | null;
  candidate_count: number | null;
  processing_duration_ms: number | null;
  error_message: string | null;
  computed_at: string;
  is_partial: number | bigint;
  corpus_generation: number | bigint;
};

/**
 * Reads the current global corpus-match generation (drizzle/0036) — always
 * fresh, never cached in memory, same discipline as
 * isCorpusSourceMatchingEnabled()'s own live process.env read. The seed row
 * (id=1, generation=0) is inserted by the migration itself; this never
 * needs to create it.
 */
export async function getCurrentCorpusMatchGeneration(execOrTx: Pick<Client, "execute">): Promise<number> {
  const result = await execOrTx.execute("SELECT generation FROM corpus_match_generation WHERE id = 1");
  const row = result.rows[0] as unknown as { generation: number | bigint } | undefined;
  return row ? Number(row.generation) : 0;
}

/**
 * Bumps the global generation by 1 — called whenever corpus eligibility is
 * ADDED (a promotion newly 'indexed', a fingerprint reactivated), never for
 * eligibility removed (see this file's own header comment for why
 * deactivation uses targeted invalidation instead). Safe to call more than
 * once for what is conceptually "one" eligibility-adding event (e.g. several
 * decisions promoted in the same sweep tick each bump it separately) — an
 * extra bump only means an extra harmless recompute somewhere, never a
 * missed one.
 */
export async function bumpCorpusMatchGeneration(execOrTx: Pick<Client, "execute">): Promise<void> {
  await execOrTx.execute("UPDATE corpus_match_generation SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1");
}

function isCurrentVersion(row: SnapshotRow): boolean {
  return (
    row.matcher_version === CURRENT_VERSIONS.matcherVersion &&
    row.fingerprint_version === CURRENT_VERSIONS.fingerprintVersion &&
    row.canonicalization_version === CURRENT_VERSIONS.canonicalizationVersion
  );
}

/**
 * Release-hardening audit finding SIM-03: the exact "is this existing row
 * still cache-worthy" condition getOrComputeHistoricalMatchSnapshot already
 * used inline — factored out so a caller that only needs to know "would a
 * call right now be a cache hit or a real recompute" (lib/report-primary-
 * similarity.ts's write-time finalization, and any future stale-generation
 * check) can ask without duplicating this exact rule, and can never drift
 * out of sync with what getOrComputeHistoricalMatchSnapshot itself actually
 * does. See this file's own header comment (Phase E8E fix, corpus-source
 * matching addendum point 1) for why every one of these conditions exists.
 */
function isSnapshotRowCurrent(row: SnapshotRow | undefined, currentGeneration: number): boolean {
  return Boolean(
    row &&
    isCurrentVersion(row) &&
    row.status !== "NO_HISTORICAL_MATCH" &&
    Number(row.is_partial) !== 1 &&
    Number(row.corpus_generation) >= currentGeneration,
  );
}

function rowToResult(row: SnapshotRow): ReportHistoricalSubmissionMatch {
  const base = {
    computedAt: row.computed_at,
    matcherVersion: row.matcher_version ?? CURRENT_VERSIONS.matcherVersion,
    fingerprintVersion: row.fingerprint_version ?? CURRENT_VERSIONS.fingerprintVersion,
    canonicalizationVersion: row.canonicalization_version ?? CURRENT_VERSIONS.canonicalizationVersion,
    ...(Number(row.is_partial) === 1 ? { partial: true as const } : {}),
  };
  if (row.status === "MATCHED") {
    return { ...base, status: "MATCHED", matches: row.result_json ? (JSON.parse(row.result_json) as HistoricalSubmissionMatchEntry[]) : [] };
  }
  if (row.status === "FAILED") {
    return { ...base, status: "UNAVAILABLE" };
  }
  return { ...base, status: "NO_HISTORICAL_MATCH" };
}

/** Only the fields this file ever persists — see report-types.ts's own comment on why externalWordStart and per-entry version tags are dropped. */
function serializeMatchesForStorage(matches: Array<{
  relationshipType: string;
  matchedRepresentationId: string;
  matchType: string;
  containment: number;
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
  passages: Array<{ submittedText: string; submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
  historicalSubmissionCount: number;
}>): HistoricalSubmissionMatchEntry[] {
  return matches.map((m) => ({
    relationshipType: m.relationshipType as HistoricalSubmissionMatchEntry["relationshipType"],
    matchedRepresentationId: m.matchedRepresentationId,
    matchType: m.matchType as HistoricalSubmissionMatchEntry["matchType"],
    containment: m.containment,
    matchedWordCount: m.matchedWordCount,
    passageCount: m.passageCount,
    longestMatchWords: m.longestMatchWords,
    passages: m.passages.map((p) => ({
      submittedText: p.submittedText,
      submittedWordStart: p.submittedWordStart,
      submittedWordEnd: p.submittedWordEnd,
      matchedWordCount: p.matchedWordCount,
    })),
    historicalSubmissionCount: m.historicalSubmissionCount,
  }));
}

/**
 * Returns the current historical-match snapshot for one saved report,
 * computing and persisting it first if missing or stale. Never throws — a
 * computation failure is caught, persisted as status "FAILED", and returned
 * as { status: "UNAVAILABLE" } so a caller can render the report normally
 * either way (this phase's own task description, section 13). accountId may
 * be null (anonymous report) — passed straight through to
 * matchAgainstUserSubmissionCorpus, which already reports
 * UNKNOWN_RELATIONSHIP rather than guessing SELF in that case (Phase E8B);
 * this function does not special-case anonymity beyond that.
 */
/**
 * Applied at every exit point of getOrComputeHistoricalMatchSnapshot,
 * whether the result just came from cache or was freshly computed — see
 * this file's own header comment (corpus-source matching addendum, point
 * 3). Never trust a flag state baked into stored/cached data; always
 * re-check isCorpusSourceMatchingEnabled() fresh, right here, at the read
 * boundary. If stripping empties an otherwise-MATCHED result, the status
 * drops to NO_HISTORICAL_MATCH too — a caller checking status === "MATCHED"
 * must be able to trust matches is non-empty.
 */
function applyCorpusSourceMatchingFlag(result: ReportHistoricalSubmissionMatch): ReportHistoricalSubmissionMatch {
  if (isCorpusSourceMatchingEnabled() || result.status !== "MATCHED" || !result.matches) return result;
  const filtered = result.matches.filter((m) => m.relationshipType !== "TURNITPLUS_CORPUS_SOURCE");
  if (filtered.length === result.matches.length) return result;
  if (filtered.length === 0) {
    return {
      status: "NO_HISTORICAL_MATCH",
      computedAt: result.computedAt,
      matcherVersion: result.matcherVersion,
      fingerprintVersion: result.fingerprintVersion,
      canonicalizationVersion: result.canonicalizationVersion,
      ...(result.partial ? { partial: true as const } : {}),
    };
  }
  return { ...result, matches: filtered };
}

export async function getOrComputeHistoricalMatchSnapshot(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    accountId: string | null;
    rawText: string;
    /**
     * Test-only barrier hook (mirrors lib/corpus-admission-promotion.ts's
     * own simulateFailureAfterShingles / tests/ingest.unit.test.mjs's
     * simulateFailureAfterChunkIndex convention) — awaited immediately
     * before this function's own snapshot write, after every read
     * (including currentGeneration below) has already happened. Lets a
     * test pause a fresh computation at exactly the point described in
     * this file's own header comment (corpus-source matching addendum,
     * point 1): reproduce a deactivation committing — targeted delete AND
     * generation bump — DURING the gap between this function's reads and
     * its write, then let the write proceed, and prove the NEXT call
     * rejects the now-stale result the generation bump stamped it against.
     * Always undefined in production.
     */
    testOnlyPauseBeforeWrite?: () => Promise<void>;
    /**
     * Account-level own-submission exclusion fix: the account id of the
     * report currently being evaluated, passed straight through to
     * matchAgainstUserSubmissionCorpus — see that function's own comment.
     * Optional; omitted by every caller that doesn't have one (an anonymous
     * report can never itself be an admission's source_ref, since admission
     * jobs are only ever created for authenticated, consenting accounts —
     * see lib/corpus-admission-report-integration.ts's createPendingReportAdmissionJob).
     */
    excludeAccountId?: string;
  },
): Promise<ReportHistoricalSubmissionMatch> {
  // Read fresh, before the cache-hit decision — see this file's own header
  // comment (corpus-source matching addendum, point 1): this is compared
  // against a stored row's own corpus_generation exactly like the
  // matcher/fingerprint/canonicalization version tags already are.
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);

  const existing = await client.execute({
    sql: `SELECT status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation
          FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?`,
    args: [params.reportDeviceKey, params.reportId],
  });
  const existingRow = existing.rows[0] as unknown as SnapshotRow | undefined;
  // See this file's own header comment (Phase E8E fix, and the corpus-source
  // matching addendum below it): NO_HISTORICAL_MATCH and a partial result
  // are never treated as final, even with current version tags, because
  // either can be invalidated/completed by new corpus content or more time
  // — something version tags alone cannot detect. corpus_generation catches
  // the case those alone cannot: eligibility newly ADDED, which a targeted,
  // per-representation search could never discover for a report that
  // doesn't reference the new content yet.
  if (isSnapshotRowCurrent(existingRow, currentGeneration)) {
    return applyCorpusSourceMatchingFlag(rowToResult(existingRow as SnapshotRow));
  }

  const startedAt = Date.now();
  let status: "MATCHED" | "NO_HISTORICAL_MATCH" | "FAILED";
  let resultJson: string | null = null;
  let candidateCount: number | null = null;
  let errorMessage: string | null = null;
  let isPartial = false;

  try {
    const canonicalText = canonicalizeText(params.rawText);
    // Phase E8D: now that save-time indexing is live, this exact report's
    // own submission is typically already present in the corpus under
    // params.accountId by the time this ever runs — matchAgainstUserSubmissionCorpus's
    // own documentIdentityId parameter exists precisely for this ("relevant
    // only if the caller already indexed this exact submission into the
    // corpus before calling this function" — see that file's own comment).
    // Before E8D this was genuinely unreachable (nothing indexed the
    // current submission before its own report was ever viewed), so
    // omitting it was harmless; leaving it omitted now would make every
    // signed-in viewer's own representation membership look like a SELF
    // match against itself, even for another account's prior content. The
    // exact document_identities row is not stored on saved_reports (no
    // schema change here), so this picks the account's own most recent
    // identity row for this canonical hash — sufficient because excluding
    // any one of an account's own rows from ownership counting still
    // leaves a genuine repeat's earlier row counted, and leaves nothing
    // counted when this is that account's only submission of the content.
    const ownIdentities = params.accountId ? await findPriorSubmissionsForAccount(client, params.accountId, canonicalSha256(params.rawText)) : [];
    const documentIdentityId = ownIdentities.length > 0 ? ownIdentities[ownIdentities.length - 1].id : null;
    const matchResult = await matchAgainstUserSubmissionCorpus(client, { accountId: params.accountId, documentIdentityId, canonicalText, excludeAccountId: params.excludeAccountId });
    isPartial = matchResult.partial === true;
    if (matchResult.status === "MATCHED") {
      status = "MATCHED";
      const serialized = serializeMatchesForStorage(matchResult.matches);
      resultJson = JSON.stringify(serialized);
      candidateCount = serialized.length;
    } else {
      status = "NO_HISTORICAL_MATCH";
    }
  } catch (error) {
    status = "FAILED";
    errorMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const processingDurationMs = Date.now() - startedAt;
  const computedAt = new Date().toISOString();

  // Test-only barrier — see params.testOnlyPauseBeforeWrite's own comment.
  // Every read this function does (currentGeneration, the candidate
  // search inside matchAgainstUserSubmissionCorpus, everything above) has
  // already happened by this point; only the write below is still
  // pending.
  if (params.testOnlyPauseBeforeWrite) await params.testOnlyPauseBeforeWrite();

  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(report_device_key, report_id) DO UPDATE SET
            status = excluded.status,
            matcher_version = excluded.matcher_version,
            fingerprint_version = excluded.fingerprint_version,
            canonicalization_version = excluded.canonicalization_version,
            result_json = excluded.result_json,
            candidate_count = excluded.candidate_count,
            processing_duration_ms = excluded.processing_duration_ms,
            error_message = excluded.error_message,
            computed_at = excluded.computed_at,
            is_partial = excluded.is_partial,
            corpus_generation = excluded.corpus_generation`,
    args: [
      params.reportDeviceKey,
      params.reportId,
      status,
      CURRENT_VERSIONS.matcherVersion,
      CURRENT_VERSIONS.fingerprintVersion,
      CURRENT_VERSIONS.canonicalizationVersion,
      resultJson,
      candidateCount,
      processingDurationMs,
      errorMessage,
      computedAt,
      isPartial ? 1 : 0,
      // The value read at the TOP of this function, before the search ran —
      // never a fresher read taken here. Stamping a newer value than what
      // the search actually reflected would silently under-invalidate: a
      // generation bump that lands between the search and this write must
      // still make this row stale on the next read, so it gets a real
      // recompute rather than being trusted to already reflect content it
      // never actually saw.
      currentGeneration,
    ],
  });

  return applyCorpusSourceMatchingFlag(rowToResult({
    status,
    matcher_version: CURRENT_VERSIONS.matcherVersion,
    fingerprint_version: CURRENT_VERSIONS.fingerprintVersion,
    canonicalization_version: CURRENT_VERSIONS.canonicalizationVersion,
    result_json: resultJson,
    candidate_count: candidateCount,
    is_partial: isPartial ? 1 : 0,
    corpus_generation: currentGeneration,
    processing_duration_ms: processingDurationMs,
    error_message: errorMessage,
    computed_at: computedAt,
  }));
}

/**
 * Release-hardening audit finding SIM-03: a pure freshness check — no
 * candidate search, no write, not even rowToResult's own JSON.parse of
 * result_json (this SELECT never reads that column at all). Lets a caller
 * that already has a persisted SimilarityReport.unifiedSimilarity in hand
 * (lib/report-primary-similarity.ts's write-time finalization, and
 * app/reports/[id]/page.tsx's own read-time staleness signal) ask "is that
 * value still trustworthy right now" without paying for — or risking —
 * getOrComputeHistoricalMatchSnapshot's own recompute path. Exactly the
 * same two cheap, indexed reads (corpus_match_generation, then this table)
 * that function's own cache-hit path already does; true here if and only if
 * a call to that function right now would also be a cache hit.
 */
export async function isHistoricalMatchSnapshotCurrent(
  client: Client,
  params: { reportDeviceKey: string; reportId: string },
): Promise<boolean> {
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);
  const existing = await client.execute({
    sql: `SELECT status, matcher_version, fingerprint_version, canonicalization_version, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation
          FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?`,
    args: [params.reportDeviceKey, params.reportId],
  });
  const existingRow = existing.rows[0] as unknown as SnapshotRow | undefined;
  return isSnapshotRowCurrent(existingRow, currentGeneration);
}

/** Deletes a report's historical-match snapshot, if any — see db/schema.ts's own comment on why this is an explicit application-level cascade rather than a DB-level FOREIGN KEY ... ON DELETE CASCADE. Called from app/api/reports/[id]/route.ts's DELETE handler, in the same request that deletes the report itself. */
export async function deleteHistoricalMatchSnapshot(client: Client, params: { reportDeviceKey: string; reportId: string }): Promise<void> {
  await client.execute({
    sql: "DELETE FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [params.reportDeviceKey, params.reportId],
  });
}

/**
 * DELETEs every cached snapshot whose stored matches array references the
 * given representation — see this file's own header comment (corpus-source
 * matching addendum, point 2) for why this is an OPTIMIZATION layered on
 * top of the generation bump (point 1), never the sole correctness
 * mechanism on its own: a concurrent computation that read this
 * representation before it was deactivated but writes its own snapshot
 * after this DELETE commits will not be caught by this DELETE (the row
 * does not exist yet when this runs) — only the generation bump reliably
 * catches that ordering, which is why deactivateAcceptedRepresentation
 * calls both, never just this. Called ONLY from
 * lib/corpus-admission-admin-actions.ts's own deactivateAcceptedRepresentation
 * transaction — promotion and reactivateAcceptedRepresentation use
 * bumpCorpusMatchGeneration alone (see that function's own comment for why
 * a targeted delete has nothing useful to find in the eligibility-ADDED
 * direction) — passing its own transaction object so this commits
 * atomically with the deactivation that made it necessary, not lazily on a
 * later view.
 *
 * Deleting (not patching the JSON in place) is deliberate: a report's
 * snapshot is a single opaque blob today, and "one representation among
 * several in this snapshot went stale" is simplest to handle the same way
 * a total cache miss already is — recomputed in full on next view, reusing
 * the existing lazy-recompute path rather than adding a second one that
 * edits stored JSON.
 *
 * Takes only a representation_id (an opaque id, not a decision_id or
 * source_ref) and issues one DELETE — it never reads a row, so it cannot
 * leak anything about which reports were affected back to its caller.
 * Accepts anything with an execute() method (a plain Client or an open
 * Transaction) rather than requiring the full Client interface — the same
 * reason lib/corpus-admission-gate.ts's own SqlExecutor type exists.
 *
 * Known scaling note: this scans every row via json_each on the stored
 * result_json — fine at today's volume (one admin deactivate action, never
 * a per-request hot path), but a reverse index
 * (report_historical_match_snapshots.representation_id, one row per match
 * entry) would be the next step if this table grows large enough to make a
 * full scan noticeable on every deactivate.
 */
export async function invalidateHistoricalMatchSnapshotsForRepresentation(
  execOrTx: Pick<Client, "execute">,
  representationId: string,
): Promise<void> {
  await execOrTx.execute({
    sql: `DELETE FROM report_historical_match_snapshots
          WHERE result_json IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(result_json)
              WHERE json_extract(value, '$.matchedRepresentationId') = ?
            )`,
    args: [representationId],
  });
}
