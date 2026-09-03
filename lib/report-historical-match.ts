import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { canonicalizeText } from "./canonical-text";
import { matchAgainstUserSubmissionCorpus, isCorpusSourceMatchingEnabled, USER_SUBMISSION_MATCHER_VERSION, USER_SUBMISSION_MATCH_THRESHOLDS } from "./user-submission-matching";
import {
  CORPUS_FINGERPRINT_VERSION,
  CANONICALIZATION_VERSION,
  CORPUS_ACTIVATION_DELAY_DAYS,
  corpusMaturityCutoff,
  sqliteUtcTimestamp,
  parseSqliteUtc,
} from "./user-submission-corpus";
import { canonicalSha256, findPriorSubmissionsForAccount } from "./document-identity";
import { getCurrentCorpusMatchGeneration, bumpCorpusMatchGeneration } from "./corpus-match-generation";
import type { ReportHistoricalSubmissionMatch, HistoricalSubmissionMatchEntry } from "./report-types";

// Re-exported unchanged so every existing importer
// (lib/corpus-admission-promotion.ts, lib/corpus-admission-admin-actions.ts,
// lib/report-primary-similarity.ts, and this feature's tests) keeps importing
// them from here — the definitions moved to lib/corpus-match-generation.ts
// only so lib/user-submission-corpus.ts can bump the counter without an
// import cycle back through this bridge module. See that file's header.
export { getCurrentCorpusMatchGeneration, bumpCorpusMatchGeneration };

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
 * upserted on recompute. A stored snapshot is reused as-is when its version
 * tags (matcher — see SNAPSHOT_MATCHER_VERSION below, which now folds in the
 * full candidate-discovery config — plus fingerprint/canonicalization) all
 * equal the CURRENT_VERSIONS below AND its corpus_generation is still
 * current AND it is not a partial result; if any differ (or no snapshot
 * exists yet), a fresh computation runs and overwrites it via INSERT ... ON
 * CONFLICT DO UPDATE — atomic, so two simultaneous requests computing the
 * same stale snapshot race harmlessly to the same eventually-consistent row
 * (this phase's own task description, section 15) rather than needing a lock
 * table. A computation failure is itself persisted as status "FAILED" (never
 * thrown past this function) so a permanently-failing document does not get
 * recomputed on every single report view.
 *
 * Definitive-no-match caching (supersedes the original "Phase E8E fix",
 * which unconditionally excluded every NO_HISTORICAL_MATCH row from reuse):
 * a COMPLETE, CURRENT no-match is now reused exactly like a MATCHED one.
 * That original blanket exclusion predated the corpus_match_generation
 * counter (drizzle/0036); its stated reason — "version tags never change
 * when only the corpus's *contents* change" — is precisely what the
 * generation counter now covers. Every event that can turn a no-match into
 * a match bumps the generation in the SAME transaction that adds the
 * content: a promotion reaching 'indexed'
 * (lib/corpus-admission-promotion.ts), a reactivation
 * (lib/corpus-admission-admin-actions.ts), and a user submission indexed
 * into the corpus (lib/user-submission-corpus.ts's
 * indexDocumentSubmissionIntoCorpus — the deferred after() path the
 * original E8E comment worried about, which additionally no longer has any
 * production call site at all: app/api/reports/route.ts stopped calling it
 * directly). So a stamped corpus_generation older than the current global
 * value is the reliable, race-proof "this no-match might be out of date"
 * signal — checked here exactly like the version tags.
 *
 * TWO results that LOOK like a no-match but must NEVER be cached as a
 * durable one, both already distinguished in storage:
 *   - a PARTIAL result (is_partial column, drizzle/0035): the matcher's
 *     candidate DB query timed out / errored, or its soft time budget was
 *     exceeded mid-loop, so only some candidates were evaluated. Always
 *     recomputed on next view.
 *   - a FEATURE-DISABLED result: computed while
 *     CORPUS_SOURCE_MATCHING_ENABLED was off, so promoted-corpus-source
 *     candidates were deliberately not classified. Stored under the
 *     distinct status "NO_HISTORICAL_MATCH_FEATURE_DISABLED" (rowToResult
 *     still maps it to the ordinary external NO_HISTORICAL_MATCH shape — the
 *     distinction is a storage-layer reuse marker only) and never reused, so
 *     turning the flag on cannot leave a real corpus-source match
 *     permanently suppressed (this phase's own task description, section 9).
 *     Net effect: no-match caching is inert until the flag is on — exactly
 *     the rollout it exists to serve — and current production behaviour is
 *     unchanged.
 *
 *     CACHEABILITY DESCRIBES THE CONDITIONS THE RESULT WAS COMPUTED UNDER,
 *     NOT THE ENVIRONMENT VALUE AT THE LATER WRITE INSTANT. The flag is
 *     therefore captured ONCE per computation
 *     (corpusSourceMatchingEnabledAtComputation, read at the very top of
 *     getOrComputeHistoricalMatchSnapshot, or threaded in by
 *     resolvePrimarySimilaritySummary from its own single request-scoped
 *     read) and that one value governs BOTH the matcher's classification
 *     (passed into matchAgainstUserSubmissionCorpus) AND the status choice
 *     above. Without this, an OFF->ON flip landing between the matcher run
 *     and the write would let a suppressed-corpus-source no-match be
 *     persisted as the reusable "NO_HISTORICAL_MATCH". Read-time filtering
 *     (applyCorpusSourceMatchingFlag) still uses the LIVE flag — that is the
 *     separate, intentional rollback behaviour that hides corpus-source
 *     entries from a stored MATCHED row while the flag is currently off.
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
 * budget was exceeded, or its candidate DB query timed out / errored — see
 * that file's TIMEOUT HONESTY comment) is never cached as final, always
 * recomputed on next view (is_partial column, drizzle/0035) — an incomplete
 * computation must never be mistaken for a settled one, whichever status it
 * happened to carry.
 */

/**
 * A stable digest of every value in USER_SUBMISSION_MATCH_THRESHOLDS —
 * folded into the snapshot's own matcher_version tag below. USER_SUBMISSION_MATCHER_VERSION
 * ("user-submission-match-v1") is a hand-maintained label that, by its own
 * history, does NOT reliably move when the matcher's config does: the maxDF
 * candidate-discovery hardening (maxCandidateShingleDocumentFrequency,
 * minDiscriminativeShingles) shipped without touching it. That was harmless
 * while NO_HISTORICAL_MATCH was never cached; now that a complete no-match
 * IS reused, a no-match computed under one candidate-discovery config must
 * stop being reused the moment that config changes in a way that could
 * surface a candidate it could not before. Digesting the whole thresholds
 * object (candidate-DF ceiling, discriminative-shingle floor, shingle
 * threshold, candidate LIMIT, per-candidate size cap, correspondence
 * thresholds, time budgets — all of it) makes "the matcher config changed"
 * an automatic snapshot invalidation with no column and no migration, and
 * with nothing to remember to bump. A config deploy is rare; an extra
 * one-time lazy recompute per report on such a deploy is wasted work, never
 * wrong behaviour.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
// Phase A — 7-day corpus maturity. CORPUS_ACTIVATION_DELAY_DAYS is folded into
// this digest alongside the matcher thresholds so deploying Phase A (or ever
// changing the window) invalidates every snapshot computed under the previous
// activation-less policy — the same automatic, no-column, no-migration
// invalidation a thresholds change already gets. An activation-less snapshot
// could otherwise keep an immature source's contribution cached indefinitely.
const MATCH_CONFIG_DIGEST = createHash("sha256")
  .update(stableStringify({ thresholds: USER_SUBMISSION_MATCH_THRESHOLDS, corpusActivationDelayDays: CORPUS_ACTIVATION_DELAY_DAYS }))
  .digest("hex")
  .slice(0, 12);

/**
 * The matcher identity a snapshot is validated against: the hand-maintained
 * matcher version PLUS the config digest above. Exported so
 * lib/report-primary-similarity.ts's isFreshCurrentNoHistoricalMatch checks
 * against the exact same value a stored row's matcher_version column holds.
 */
export const SNAPSHOT_MATCHER_VERSION = `${USER_SUBMISSION_MATCHER_VERSION}+cfg.${MATCH_CONFIG_DIGEST}`;

/**
 * Written to a snapshot row's status column (instead of "NO_HISTORICAL_MATCH")
 * when the no-match was computed while CORPUS_SOURCE_MATCHING_ENABLED was
 * off — a deliberately incomplete evaluation (promoted-corpus-source
 * candidates were not classified). rowToResult maps it back to the ordinary
 * external NO_HISTORICAL_MATCH shape; isSnapshotRowCurrent never treats it
 * as a cache hit, so turning the flag on always forces a real recompute.
 */
export const NO_HISTORICAL_MATCH_FEATURE_DISABLED_STATUS = "NO_HISTORICAL_MATCH_FEATURE_DISABLED";

const CURRENT_VERSIONS = {
  matcherVersion: SNAPSHOT_MATCHER_VERSION,
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
 * does. See this file's own header comment for why every one of these
 * conditions exists.
 *
 * A MATCHED, a definitive NO_HISTORICAL_MATCH, and a FAILED row are all
 * reusable on equal terms: current version tags (SNAPSHOT_MATCHER_VERSION,
 * which now folds in the whole candidate-discovery config), not a partial
 * result, and a corpus_generation still at or ahead of the current global
 * value. The ONLY no-match-shaped row that is never a cache hit is the
 * feature-disabled one (NO_HISTORICAL_MATCH_FEATURE_DISABLED_STATUS): it was
 * computed with corpus-source matching switched off, so it is not a complete
 * evaluation and must not survive the flag being switched on (this phase's
 * own task description, section 9).
 */
function isSnapshotRowCurrent(row: SnapshotRow | undefined, currentGeneration: number): boolean {
  return Boolean(
    row &&
    isCurrentVersion(row) &&
    row.status !== NO_HISTORICAL_MATCH_FEATURE_DISABLED_STATUS &&
    Number(row.is_partial) !== 1 &&
    Number(row.corpus_generation) >= currentGeneration,
  );
}

/**
 * Phase A — 7-day corpus maturity. Time-based snapshot invalidation.
 *
 * The corpus_match_generation counter is bumped only by a DATABASE WRITE that
 * adds matchable content (a promotion reaching 'indexed', a reactivation, a
 * user submission indexed). NO write happens when a backing simply reaches
 * CORPUS_ACTIVATION_DELAY_DAYS old — so isSnapshotRowCurrent above would keep
 * reusing a cached snapshot forever even though a source that was invisible
 * (or an already-visible source whose lineage age changed — Phase C) has now
 * matured. This closes that gap: a cached snapshot is ALSO stale when ANY
 * corpus backing crossed maturity strictly after it was computed and on/before
 * the current logical `asOf`.
 *
 * A backing matures at `T0 + CORPUS_ACTIVATION_DELAY_DAYS`, so it "matured in
 * (snapshot.computed_at, asOf]" iff its immutable `T0` is in
 * `(computed_at - CORPUS_ACTIVATION_DELAY_DAYS, asOf - CORPUS_ACTIVATION_DELAY_DAYS]`
 * — a bounded range on `created_at`, indexed by drizzle/0043.
 *
 * Deliberately corpus-wide: it does NOT scope to "a backing that could match
 * THIS report" (a search over what is already stored can never find what is
 * missing — the same argument drizzle/0036's own comment makes for the global
 * generation counter). A backing maturing anywhere stales every cached
 * snapshot whose window it falls in; each such report then does ONE lazy
 * recompute on its next score read and converges. Conservative
 * over-invalidation, accepted — correctness first.
 *
 * `maturityCutoff` (== asOf - CORPUS_ACTIVATION_DELAY_DAYS) is the SAME string
 * threaded through eligibility for this resolution, so the two can never
 * disagree on a boundary. The lower bound is derived in JS from the snapshot's
 * own `computed_at` (format-tolerant UTC parse) so both bounds are plain
 * 'YYYY-MM-DD HH:MM:SS' strings and the range stays index-friendly.
 */
async function corpusBackingMaturedInWindow(
  exec: Pick<Client, "execute">,
  params: { snapshotComputedAt: string; maturityCutoff: string },
): Promise<boolean> {
  const lowerExclusive = sqliteUtcTimestamp(
    new Date(parseSqliteUtc(params.snapshotComputedAt).getTime() - CORPUS_ACTIVATION_DELAY_DAYS * 86_400_000),
  );
  // A snapshot computed at/after `asOf` (a fresh write) has an empty window —
  // nothing can have matured "since" it. Skip the query.
  if (lowerExclusive >= params.maturityCutoff) return false;
  const result = await exec.execute({
    // Both EXISTS drive from the selective created_at range (indexed by
    // drizzle/0043 — EXPLAIN QUERY PLAN: covering-index range SEARCH on
    // idx_corpus_submission_references_created_at / idx_corpus_admission_decisions_created_at),
    // then the admission side confirms an 'indexed' promotion for that
    // decision via ux_corpus_admission_promotions_decision_id.
    sql: `SELECT (
            EXISTS (
              SELECT 1 FROM corpus_submission_references sr
              WHERE sr.created_at > ? AND sr.created_at <= ?
            )
            OR EXISTS (
              SELECT 1 FROM corpus_admission_decisions d
              WHERE d.created_at > ? AND d.created_at <= ?
                AND EXISTS (
                  SELECT 1 FROM corpus_admission_promotions p
                  WHERE p.decision_id = d.id AND p.status = 'indexed'
                )
            )
          ) AS matured`,
    args: [lowerExclusive, params.maturityCutoff, lowerExclusive, params.maturityCutoff],
  });
  const row = result.rows[0] as unknown as { matured: number | bigint } | undefined;
  return row !== undefined && Number(row.matured) === 1;
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
     * (including currentGeneration and corpusSourceMatchingEnabledAtComputation
     * below) has already happened. Lets a test pause a fresh computation in
     * the gap between this function's reads and its write, then let the
     * write proceed, to prove the persisted row reflects the state the
     * computation actually ran under — not whatever changed during the gap.
     * Two scenarios use it: (1) a deactivation committing — targeted delete
     * AND generation bump — mid-gap, proving the NEXT call rejects the
     * now-stale result the generation bump stamped it against; (2) the
     * corpus-source-matching flag flipping mid-gap, proving the persisted
     * status comes from the captured value, never a write-time re-read.
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
    /**
     * The corpus-source-matching-enabled state THIS computation should run
     * under — captured ONCE by the caller and threaded straight through, so
     * one value governs BOTH whether promoted-corpus-source candidates
     * participate/classify inside matchAgainstUserSubmissionCorpus AND
     * whether a complete no-match is persisted as the reusable
     * "NO_HISTORICAL_MATCH" or the never-reused
     * "NO_HISTORICAL_MATCH_FEATURE_DISABLED". lib/report-primary-similarity.ts's
     * resolvePrimarySimilaritySummary passes its own single request-scoped
     * isCorpusSourceMatchingEnabled() read here. Omitted only by direct test
     * callers, which then get a single fallback read taken below — still
     * ONE read per computation, never re-read at snapshot-write time.
     * Cacheability describes the conditions the result was computed under,
     * not the environment value at the later write instant.
     */
    corpusSourceMatchingEnabled?: boolean;
    /**
     * Phase A — 7-day corpus maturity. The ONE logical instant this whole
     * resolution reasons "as of". `maturityCutoff` (asOf - CORPUS_ACTIVATION_DELAY_DAYS)
     * is derived from it exactly once here and threaded into BOTH the matcher
     * (eligibility) AND the maturity-crossing check that decides cache reuse,
     * so no two queries in this call can disagree on a boundary. Defaults to
     * `new Date()` (server time). Tests inject/freeze it.
     */
    asOf?: Date;
  },
): Promise<ReportHistoricalSubmissionMatch> {
  // Read fresh, before the cache-hit decision — see this file's own header
  // comment (corpus-source matching addendum, point 1): this is compared
  // against a stored row's own corpus_generation exactly like the
  // matcher/fingerprint/canonicalization version tags already are.
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);

  // Phase A: the single maturity clock for this resolution — derived ONCE,
  // used for eligibility AND the maturity-crossing cache check below.
  const asOf = params.asOf ?? new Date();
  const maturityCutoff = corpusMaturityCutoff(asOf);

  // Captured ONCE here, before any matcher work or snapshot write — the
  // single source of truth for this computation's corpus-source-matching
  // semantics. Never re-read from the environment at write time (that was
  // the OFF->ON race: matcher suppresses the corpus source while the flag is
  // off, the flag flips on before persistence, and an independent write-time
  // read stores a reusable "NO_HISTORICAL_MATCH" for what was really an
  // incomplete evaluation).
  const corpusSourceMatchingEnabledAtComputation = params.corpusSourceMatchingEnabled ?? isCorpusSourceMatchingEnabled();

  const existing = await client.execute({
    sql: `SELECT status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation
          FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?`,
    args: [params.reportDeviceKey, params.reportId],
  });
  const existingRow = existing.rows[0] as unknown as SnapshotRow | undefined;
  // See this file's own header comment (definitive-no-match caching): a
  // complete, current MATCHED / NO_HISTORICAL_MATCH / FAILED row is reused
  // as-is. A partial result and a feature-disabled no-match never are —
  // either could be completed by more time or by the corpus-source flag
  // turning on. corpus_generation catches what version tags alone cannot:
  // eligibility newly ADDED, which a targeted, per-representation search
  // could never discover for a report that doesn't reference the new
  // content yet.
  //
  // Phase A: corpus_generation ALSO cannot catch a backing simply reaching
  // CORPUS_ACTIVATION_DELAY_DAYS old — no DB write happens then. So an
  // otherwise-current row is reused only when NO corpus backing crossed
  // maturity in (row.computed_at, asOf] — see corpusBackingMaturedInWindow.
  if (
    isSnapshotRowCurrent(existingRow, currentGeneration) &&
    !(await corpusBackingMaturedInWindow(client, {
      snapshotComputedAt: (existingRow as SnapshotRow).computed_at,
      maturityCutoff,
    }))
  ) {
    return applyCorpusSourceMatchingFlag(rowToResult(existingRow as SnapshotRow));
  }

  const startedAt = Date.now();
  let status: "MATCHED" | "NO_HISTORICAL_MATCH" | typeof NO_HISTORICAL_MATCH_FEATURE_DISABLED_STATUS | "FAILED";
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
    // corpusSourceMatchingEnabledAtComputation (captured once, above) governs
    // classification here — never a fresh env read inside the matcher — so
    // it and the status choice below can never disagree across a flag flip.
    const matchResult = await matchAgainstUserSubmissionCorpus(client, {
      accountId: params.accountId,
      documentIdentityId,
      canonicalText,
      excludeAccountId: params.excludeAccountId,
      corpusSourceMatchingEnabled: corpusSourceMatchingEnabledAtComputation,
      // Phase A: the SAME cutoff the maturity-crossing cache check above uses.
      maturityCutoff,
    });
    isPartial = matchResult.partial === true;
    if (matchResult.status === "MATCHED") {
      status = "MATCHED";
      const serialized = serializeMatchesForStorage(matchResult.matches);
      resultJson = JSON.stringify(serialized);
      candidateCount = serialized.length;
    } else if (isPartial || corpusSourceMatchingEnabledAtComputation) {
      // A complete no-match evaluated with corpus-source matching ON — the
      // reusable kind. Chosen from the SAME captured value the matcher just
      // ran under, never a re-read of the live environment. (A partial
      // no-match also lands here but is_partial keeps it out of the cache
      // regardless of status.)
      status = "NO_HISTORICAL_MATCH";
    } else {
      // Computed with corpus-source matching off: promoted-corpus-source
      // candidates were never classified, so this is not a complete
      // evaluation. Stored under a distinct status so isSnapshotRowCurrent
      // never reuses it and the flag turning on forces a real recompute
      // (section 9). Externally still an ordinary NO_HISTORICAL_MATCH.
      status = NO_HISTORICAL_MATCH_FEATURE_DISABLED_STATUS;
    }
  } catch (error) {
    status = "FAILED";
    errorMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const processingDurationMs = Date.now() - startedAt;
  // Phase A: stamp the snapshot with the LOGICAL instant this computation
  // reasoned "as of" (== asOf), NOT wall-clock now. In production the two are
  // the same (asOf defaults to `new Date()`), so this is byte-identical there.
  // It matters for the maturity-crossing check: corpusBackingMaturedInWindow
  // treats this value as "the moment the matcher already accounted for
  // maturity through", so a fresh recompute's own window is empty and the row
  // reads as current immediately after it is written.
  const computedAt = asOf.toISOString();

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
  params: {
    reportDeviceKey: string;
    reportId: string;
    /**
     * Phase A — the logical instant this check reasons "as of". Must be the
     * SAME instant the caller (lib/report-primary-similarity.ts's
     * resolvePersistedSimilarityDisplay) uses for its whole resolution.
     * Defaults to server time; tests inject/freeze it.
     */
    asOf?: Date;
  },
): Promise<boolean> {
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);
  const existing = await client.execute({
    sql: `SELECT status, matcher_version, fingerprint_version, canonicalization_version, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation
          FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?`,
    args: [params.reportDeviceKey, params.reportId],
  });
  const existingRow = existing.rows[0] as unknown as SnapshotRow | undefined;
  if (!isSnapshotRowCurrent(existingRow, currentGeneration)) return false;
  // Phase A: an otherwise-current row is stale the moment a corpus backing
  // crosses maturity after it was computed — the SAME check
  // getOrComputeHistoricalMatchSnapshot's own cache-hit branch applies, so a
  // "would this be a cache hit right now" answer stays truthful.
  const maturityCutoff = corpusMaturityCutoff(params.asOf ?? new Date());
  return !(await corpusBackingMaturedInWindow(client, {
    snapshotComputedAt: (existingRow as SnapshotRow).computed_at,
    maturityCutoff,
  }));
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
