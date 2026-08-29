import type { Client } from "@libsql/client";
import { getOrComputeHistoricalMatchSnapshot, getCurrentCorpusMatchGeneration, isHistoricalMatchSnapshotCurrent, SNAPSHOT_MATCHER_VERSION } from "./report-historical-match";
import { isCorpusSourceMatchingEnabled } from "./corpus-source-matching-flag";
import { CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION } from "./user-submission-corpus";
import { computeUnifiedSimilarity, type UnifiedSimilarityResult } from "./unified-similarity";
import type { ReportHistoricalSubmissionMatch, SimilarityReport } from "./report-types";
import type { ExternalAcademicEvidence } from "./academic-search/types";
import { canonicalSha256 } from "./document-identity";
import { summarizeSubmissionProvenance } from "./submission-provenance";
import { classifyDeviceSelfMatch, productionCountsRelationship } from "./device-self-scoring-rule";
import {
  isDevicePassportSelfScoringEnabled,
  isDevicePassportConservativeSharedGuardEnabled,
} from "./device-passport-server";
import {
  evaluateDeviceSelfSharedGuard,
  guardNotApplied,
  type DeviceSelfSharedGuardResult,
} from "./device-shared-guard";

/**
 * Release-hardening audit finding SIM-02/SIM-03/SIM-04: the ONE server-side
 * source for "what is this report's resolved primary-similarity result" —
 * used by app/api/reports/route.ts (write-time finalization) and
 * app/api/reports/[id]/route.ts (the stale-generation self-heal path). See
 * resolvePersistedSimilarityDisplay below for the READ-side counterpart
 * lib/reports-repo.ts's findRoomOccupant and app/reports/[id]/page.tsx
 * share — that one never calls into this file's own DB-touching functions,
 * only the already-persisted result plus two cheap freshness checks.
 *
 * Reuses lib/report-historical-match.ts's getOrComputeHistoricalMatchSnapshot
 * exactly as-is — the real snapshot cache (report_historical_match_snapshots,
 * keyed by report_device_key+report_id, staleness-checked against version
 * tags AND corpus_match_generation) and its own CORPUS_SOURCE_MATCHING_ENABLED
 * read-time filter — never a second matching implementation, and never a
 * duplicate computation for an already-cached, still-current snapshot.
 *
 * Lives in lib/, not app/ — this file, like lib/report-historical-match.ts,
 * is the sanctioned bridge into lib/user-submission-matching.ts;
 * tests/user-submission-matching-privacy.test.mjs's own structural guarantee
 * ("the matching service is never imported by any file under app/") is
 * unaffected, since no app/ file imports lib/user-submission-matching.ts
 * directly either way.
 */

export type PrimarySimilarityResolution = {
  /** Passed straight through — callers that also need it for their own read-time enrichment (E8P.3, E8S, shadow evaluation) get it from the one call already made here, never a second one. */
  historicalSubmissionMatch: ReportHistoricalSubmissionMatch;
  /** Present whenever the resolution succeeded — absent only if computeUnifiedSimilarity itself threw (it is documented as never doing so; this is a defensive fallback, not an expected path). */
  unifiedSimilarity: UnifiedSimilarityResult | undefined;
  /** unifiedSimilarity.unifiedScore when resolved, otherwise the caller's own supplied archiveScore — the exact same fallback rule lib/report-types.ts's primarySimilarityScore already applies client-side, computed here once, server-side, for both the room card and report detail to share. */
  primaryScore: number;
  /** True when primaryScore reflects the resolved combined result rather than the archive-only fallback. */
  isUnified: boolean;
  /**
   * Release-hardening audit finding SIM-04: isCorpusSourceMatchingEnabled()
   * read once, at the START of this resolution — the flag snapshot a
   * caller must persist alongside unifiedSimilarity so a later reader can
   * detect "this stored result was computed under a different flag state"
   * without re-running anything (see resolvePersistedSimilarityDisplay's
   * own comment for why this is the "live flag rollback" fix: the room
   * card's own read never called getOrComputeHistoricalMatchSnapshot, so it
   * never re-applied applyCorpusSourceMatchingFlag either — this snapshot
   * is what lets a pure SQL read reproduce that same live filtering
   * without a second matching implementation).
   */
  corpusSourceMatchingEnabled: boolean;
  /**
   * Release-hardening audit finding SIM-04: getCurrentCorpusMatchGeneration()
   * read once, at the START of this resolution (before the snapshot lookup
   * — the same "read fresh, before the cache-hit decision" discipline
   * getOrComputeHistoricalMatchSnapshot's own header comment documents for
   * itself). A caller persists this alongside unifiedSimilarity as a
   * monotonic ordering key: when two concurrent resaves finalize the same
   * report, whichever carries the LOWER generation must never overwrite the
   * higher one, regardless of which write actually commits last — see
   * app/api/reports/route.ts's own SAVE_REPORT_SQL generation guard.
   */
  corpusGeneration: number;
  /**
   * Release-hardening audit finding LIFECYCLE-06 (corrected): true only
   * when computeUnifiedSimilarity itself threw for THIS report's own data
   * — a genuine, reproducible overall-computation failure, distinct from a
   * fail-soft individual-source issue. Investigated before adding this:
   * historicalSubmissionMatch reaching a real, persisted terminal
   * "UNAVAILABLE" status (lib/report-historical-match.ts's
   * getOrComputeHistoricalMatchSnapshot, itself never throwing) does NOT
   * set this — lib/unified-similarity.ts's computeUnifiedSimilarity only
   * ever special-cases historicalSubmissionMatch.status === "MATCHED" (see
   * its own sole status check); any other status, "UNAVAILABLE" included,
   * simply contributes zero historical words to an otherwise still-
   * successful computation from whatever archive/academic evidence IS
   * available. So a historical-match failure alone can never set `failed`
   * true here — only computeUnifiedSimilarity's own try/catch below can.
   * Always false on the success path.
   */
  failed: boolean;
  /**
   * Preview-gated same-device SELF rule (flag DEVICE_PASSPORT_SELF_ENABLED —
   * OFF by default): the matchedRepresentationId values that were treated as
   * an EFFECTIVE SELF for this resolution's unified score, WITHOUT rewriting
   * production's persisted relationshipType (the historical-match snapshot
   * keeps its baseline TURNITPLUS_CORPUS_SOURCE / PRIOR_SUBMISSION). Always
   * an empty array when the flag is off, when the report has no verified
   * upload Device Passport, or when no counted historical source is a
   * same-device exact match with zero independent backing. Bounded — bare
   * representation ids only (already present in historicalSubmissionMatch),
   * never a passport id / account id / email / device identifier.
   *
   * When the refined CONSERVATIVE_COMBINED shared-device guard is ENABLED (flag
   * DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED — OFF by default), a
   * representation that classifyDeviceSelfMatch accepted is included here ONLY
   * if it also survives the guard (see deviceSelfSharedGuard below); a blocked
   * candidate is NOT listed, so its matched words stay counted.
   */
  effectiveDeviceSelfRepresentationIds: string[];
  /**
   * The refined CONSERVATIVE_COMBINED (Policy D) shared-device guard decision
   * for this resolution — bounded counts + one short enum, no identity. `null`
   * whenever DEVICE_PASSPORT_SELF_ENABLED is off (the guard is never consulted).
   * When the SELF flag is on, `enabled` reflects
   * DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED and `passed` records
   * whether the SELF downgrade was kept. Consumed only by the ADMIN similarity
   * decision trace — never persisted, never returned to an ordinary user.
   */
  deviceSelfSharedGuard: DeviceSelfSharedGuardResult | null;
};

/**
 * Defensive cap on how many distinct matched representations the same-device
 * SELF rule will fetch provenance evidence for in one resolution — mirrors
 * lib/developer-repo.ts's MAX_TRACE_REPRESENTATIONS. The matcher itself
 * already bounds matches[]; this is a belt-and-braces ceiling so a
 * pathological result can never fan out into an unbounded query loop.
 */
const MAX_DEVICE_SELF_REPRESENTATIONS = 25;

type ReportDeviceProvenanceRow = {
  verified_device_passport_id: string | null;
  document_identity_id: string | null;
};

type ResolvedDeviceSelf = {
  /** The representation ids scoring treats as an EFFECTIVE SELF — already guard-filtered when the guard is on. */
  representationIds: string[];
  /** The refined CONSERVATIVE_COMBINED guard decision, or null when the guard was never consulted (nothing qualified / device-self resolution itself failed). */
  guard: DeviceSelfSharedGuardResult | null;
};

/**
 * Resolves — from the report's OWN immutable verified upload Device Passport
 * plus the deterministic per-backing provenance evidence (never from
 * historical_match_shadow_evaluations, which is written AFTER the response) —
 * the set of matched representation ids that the Preview-gated same-device
 * SELF rule (lib/device-self-scoring-rule.ts) classifies as an EFFECTIVE SELF
 * for scoring. Returns [] whenever the report has no verified passport
 * (condition 3 of the rule) or nothing qualifies. Best-effort: never throws —
 * an evidence-lookup failure means "no downgrade" (a verification / evidence
 * failure must never accidentally trigger SELF), never a scoring failure.
 *
 * When DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED is on, each candidate
 * that passed classifyDeviceSelfMatch is additionally run through the refined
 * CONSERVATIVE_COMBINED (Policy D) shared-device guard
 * (lib/device-shared-guard.ts, facts derived LIVE from durable provenance —
 * never telemetry). If the guard blocks, NO representation is downgraded (the
 * matches stay counted) and the baseline production relationship is untouched.
 * Any guard failure FAILS CLOSED to "keep counted" — never fails open to SELF.
 */
async function resolveEffectiveDeviceSelfRepresentationIds(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    accountId: string | null;
    rawText: string;
    historicalSubmissionMatch: ReportHistoricalSubmissionMatch;
    /**
     * undefined => read the report's persisted verified_device_passport_id +
     * document_identity_id from saved_reports (the GET / self-heal / admin-
     * trace / resave path). string | null => the freshly-verified passport
     * from THIS POST first-save request, whose saved_reports row does not
     * exist yet (document identity is likewise not yet written).
     */
    verifiedDevicePassportIdOverride: string | null | undefined;
  },
): Promise<ResolvedDeviceSelf> {
  const sharedGuardEnabled = isDevicePassportConservativeSharedGuardEnabled();
  try {
    const matches = params.historicalSubmissionMatch.matches ?? [];
    if (matches.length === 0) return { representationIds: [], guard: guardNotApplied(sharedGuardEnabled) };

    let reportPassportId: string | null;
    let reportDocumentIdentityId: string | null;
    if (params.verifiedDevicePassportIdOverride !== undefined) {
      reportPassportId = params.verifiedDevicePassportIdOverride;
      // First-save POST: the row and its document identity are written after
      // this call, and the report's own submission is not yet an admission
      // backing — nothing of its own to exclude.
      reportDocumentIdentityId = null;
    } else {
      const row = await client.execute({
        sql: `SELECT verified_device_passport_id, document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?`,
        args: [params.reportDeviceKey, params.reportId],
      });
      const provenance = row.rows[0] as unknown as ReportDeviceProvenanceRow | undefined;
      reportPassportId = provenance?.verified_device_passport_id ?? null;
      reportDocumentIdentityId = provenance?.document_identity_id ?? null;
    }

    // Condition 3 of the rule: the target report must carry a verified
    // cryptographic Device Passport. No passport -> current scoring, unchanged.
    if (!reportPassportId) return { representationIds: [], guard: guardNotApplied(sharedGuardEnabled) };

    const reportCanonicalSha256 = safeCanonicalSha256(params.rawText);
    const seen = new Set<string>();
    const baselineEffective: string[] = [];
    let processed = 0;
    for (const match of matches) {
      if (seen.has(match.matchedRepresentationId)) continue;
      seen.add(match.matchedRepresentationId);
      if (processed >= MAX_DEVICE_SELF_REPRESENTATIONS) break;
      processed += 1;

      // Cheap pre-filter — only a production-counted, exact canonical match
      // can ever qualify, so skip the provenance query for anything else.
      if (!productionCountsRelationship(match.relationshipType)) continue;
      if (match.matchType !== "EXACT_CANONICAL_MATCH") continue;

      const provenance = await summarizeSubmissionProvenance(client, match.matchedRepresentationId, {
        accountId: params.accountId,
        excludeDocumentIdentityId: reportDocumentIdentityId,
        reportVerifiedDevicePassportId: reportPassportId,
        reportCanonicalSha256,
        reportDocumentIdentityId,
      });
      const classification = classifyDeviceSelfMatch({
        relationshipType: match.relationshipType,
        matchType: match.matchType,
        sameVerifiedDeviceBacking: provenance.sameVerifiedDeviceBacking,
        independentBackingCount: provenance.independentBackingCount,
      });
      if (classification.isEffectiveDeviceSelf) baselineEffective.push(match.matchedRepresentationId);
    }

    // Guard OFF (the production default while DEVICE_PASSPORT_SELF_ENABLED is
    // on): byte-identical to the current Device Passport SELF behaviour.
    if (!sharedGuardEnabled) {
      return { representationIds: baselineEffective, guard: guardNotApplied(false) };
    }
    // Nothing qualified — the guard has nothing to act on.
    if (baselineEffective.length === 0) {
      return { representationIds: [], guard: guardNotApplied(true) };
    }

    // Guard ON: keep the SELF downgrade only if the refined Policy D over
    // durable provenance facts is satisfied; otherwise NONE of the candidates
    // is downgraded (their matches stay counted). Best-effort — a guard failure
    // is FAIL CLOSED (returns passed:false), never fails open to SELF.
    const guard = await evaluateDeviceSelfSharedGuard(client, {
      enabled: true,
      verifiedDevicePassportId: reportPassportId,
      reportAccountId: params.accountId,
      effectiveSelfRepresentationIds: baselineEffective,
    });
    return { representationIds: guard.passed ? baselineEffective : [], guard };
  } catch (err) {
    console.error(
      "resolvePrimarySimilaritySummary: same-device SELF evidence resolution failed (non-fatal — no device-self downgrade applied, current scoring is used):",
      err instanceof Error ? err.message : String(err),
    );
    return { representationIds: [], guard: guardNotApplied(sharedGuardEnabled) };
  }
}

function safeCanonicalSha256(text: string): string {
  try {
    return canonicalSha256(text ?? "");
  } catch {
    return canonicalSha256("");
  }
}

export async function resolvePrimarySimilaritySummary(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    accountId: string | null;
    rawText: string;
    wordCount: number;
    archiveMatchedPositions?: number[] | null;
    externalAcademicEvidence?: ExternalAcademicEvidence[] | null;
    /** The archive-only fallback value — never mutated, never persisted by this function; see this module's own header comment. */
    archiveScore: number;
    /**
     * Preview-gated same-device SELF rule (flag DEVICE_PASSPORT_SELF_ENABLED).
     * `undefined` (every caller except the POST first-save path) => this
     * function reads the report's persisted saved_reports.verified_device_passport_id
     * itself, so the GET / self-heal / admin-trace / resave paths all resolve
     * the same effective relationship. A `string | null` value is the
     * freshly-verified passport from THIS POST /api/reports first-save request,
     * whose saved_reports row does not exist yet — passing it here is what
     * lets the FIRST persisted score already reflect the same-device SELF
     * downgrade, with no second POST or GET. Ignored entirely when the flag is
     * off (not even read).
     */
    verifiedDevicePassportId?: string | null;
    /** Test-only override, mirroring getOrComputeHistoricalMatchSnapshot's own testOnlyPauseBeforeWrite convention — lets a test force the "unified matching genuinely failed" branch without fighting computeUnifiedSimilarity's own deliberately defensive, never-throws-on-malformed-input contract. Always undefined in production. */
    testOnlyComputeUnifiedSimilarity?: typeof computeUnifiedSimilarity;
  },
): Promise<PrimarySimilarityResolution> {
  const corpusSourceMatchingEnabled = isCorpusSourceMatchingEnabled();
  const corpusGeneration = await getCurrentCorpusMatchGeneration(client);
  // Account-level self-match fix: the raw account id is already right here
  // (params.accountId) — no source_ref needs to be constructed at this call
  // site at all (buildReportAdmissionAccountPrefix, lib/corpus-admission-
  // source-ref.ts, is where the account-to-prefix conversion actually
  // happens, inside findCandidateCorpusRepresentations/
  // isRepresentationEligibleForMatching). An anonymous report (accountId
  // null) can never itself be an admission source, since admission jobs
  // only exist for authenticated, consenting accounts, so there is nothing
  // to exclude and this stays undefined. Passed straight through to
  // getOrComputeHistoricalMatchSnapshot -> matchAgainstUserSubmissionCorpus
  // -> findCandidateCorpusRepresentations, so a representation backed ONLY
  // by THIS account's own admission(s) — through this report or any other
  // of the account's own reports — is never offered as a candidate against
  // a report from that same account — see lib/user-submission-corpus.ts's
  // admissionEligibilitySql for the exact predicate. Server-internal only:
  // used solely as a SQL comparison value, never appears in anything this
  // function (or any of its callers) returns.
  const excludeAccountId = params.accountId ?? undefined;
  const historicalSubmissionMatch = await getOrComputeHistoricalMatchSnapshot(client, {
    reportDeviceKey: params.reportDeviceKey,
    reportId: params.reportId,
    accountId: params.accountId,
    rawText: params.rawText,
    excludeAccountId,
    // The SAME single flag read this resolution already took above
    // (corpusSourceMatchingEnabled) — threaded through so the historical
    // computation, its persisted snapshot status, and the
    // corpusSourceMatchingEnabledAtComputation value this function returns
    // are all governed by one value, never three independent env reads that
    // could straddle a mid-request flag flip.
    corpusSourceMatchingEnabled,
  });

  // Preview-gated same-device SELF rule (flag DEVICE_PASSPORT_SELF_ENABLED —
  // OFF by default). Triple-gated so an off flag is a byte-identical no-op
  // with NOT ONE extra query: the flag, a real MATCHED result, and at least
  // one match. Never re-runs the matcher or mutates the historical-match
  // snapshot; only decides which counted representations
  // computeUnifiedSimilarity should treat as an EFFECTIVE SELF for the score.
  let effectiveDeviceSelfRepresentationIds: string[] = [];
  let deviceSelfSharedGuard: DeviceSelfSharedGuardResult | null = null;
  if (
    isDevicePassportSelfScoringEnabled() &&
    historicalSubmissionMatch.status === "MATCHED" &&
    (historicalSubmissionMatch.matches?.length ?? 0) > 0
  ) {
    const resolved = await resolveEffectiveDeviceSelfRepresentationIds(client, {
      reportDeviceKey: params.reportDeviceKey,
      reportId: params.reportId,
      accountId: params.accountId,
      rawText: params.rawText,
      historicalSubmissionMatch,
      verifiedDevicePassportIdOverride: params.verifiedDevicePassportId,
    });
    effectiveDeviceSelfRepresentationIds = resolved.representationIds;
    deviceSelfSharedGuard = resolved.guard;
  }

  // Mirrors the exact try/catch boundary app/api/reports/[id]/route.ts
  // already had around its own inline computeUnifiedSimilarity call —
  // getOrComputeHistoricalMatchSnapshot above is not wrapped here for the
  // same reason it wasn't there either: it never throws by its own
  // documented contract (a computation failure becomes a stored "FAILED"
  // snapshot / UNAVAILABLE status, not an exception).
  try {
    const compute = params.testOnlyComputeUnifiedSimilarity ?? computeUnifiedSimilarity;
    const unifiedSimilarity = compute({
      wordCount: params.wordCount,
      archiveMatchedPositions: params.archiveMatchedPositions,
      externalAcademicEvidence: params.externalAcademicEvidence,
      historicalSubmissionMatch,
      effectiveDeviceSelfRepresentationIds,
    });
    return { historicalSubmissionMatch, unifiedSimilarity, primaryScore: unifiedSimilarity.unifiedScore, isUnified: true, corpusSourceMatchingEnabled, corpusGeneration, failed: false, effectiveDeviceSelfRepresentationIds, deviceSelfSharedGuard };
  } catch (err) {
    console.error("resolvePrimarySimilaritySummary: computeUnifiedSimilarity failed (genuine overall-computation failure — persisted as a terminal 'failed' state by the caller, see this function's own failed field):", err instanceof Error ? err.message : String(err));
    return { historicalSubmissionMatch, unifiedSimilarity: undefined, primaryScore: params.archiveScore, isUnified: false, corpusSourceMatchingEnabled, corpusGeneration, failed: true, effectiveDeviceSelfRepresentationIds, deviceSelfSharedGuard };
  }
}

/**
 * Release-hardening audit finding SIM-04 (acceptance-check hardening): a
 * genuine discriminated union, not a flat object with a status label beside
 * an always-present primaryScore. The earlier shape let a consumer read
 * `.primaryScore` without ever checking `.status` first — harmless by
 * convention as long as every call site remembered the rule, but nothing
 * stopped a future call site from forgetting it and rendering the
 * archive-only fallback as if it were a trustworthy final number. Here,
 * `primaryScore`/`isUnified` simply DO NOT EXIST on the "stale"/"pending"
 * branches — TypeScript itself refuses `display.primaryScore` unless the
 * caller has already narrowed on `display.status === "resolved"`, so the
 * mistake this hardening pass is closing off cannot compile.
 *  - "resolved": primaryScore is trustworthy as-is — either the real
 *    combined result (isUnified true), or a definitive archive-only answer
 *    known correct right now with no further wait (isUnified false:
 *    CORPUS_SOURCE_MATCHING_ENABLED was rolled back OFF since this report's
 *    own persisted result was computed with it on — disabling can only
 *    ever remove a contribution, never add one, so archive-only is
 *    immediately, deterministically right).
 *  - "stale": a real unifiedSimilarity IS persisted, but either
 *    corpus_match_generation has moved on, or the flag was rolled back ON
 *    since this report's own result was computed with it off (the opposite
 *    flag transition from "resolved" above — NOT deterministic: a
 *    newly-eligible corpus source cannot be ruled out without actually
 *    running the matcher again), OR the persisted result predates
 *    unifiedSimilarityGeneration/corpusSourceMatchingEnabledAtComputation
 *    existing at all (a genuinely legacy row — see selfHealUnifiedSimilarity's
 *    own header comment for the Preview regression this specific case
 *    caused: a caller that only re-resolves the "pending" case below and
 *    leaves "stale" as a dead end leaves such a row polling forever). The
 *    caller must show "Updating similarity…" — there is no number here to
 *    render even by accident — UNLESS it can reach the row directly, in
 *    which case (see "pending" below) it is expected to self-heal this too.
 *  - "pending": no unifiedSimilarity has ever been persisted for this
 *    report AND no terminal failure has been recorded either — this
 *    resolver itself never recomputes to find out why (see this function's
 *    own header comment: no DB-touching calls, no matcher). A caller that
 *    can reach the row directly (lib/reports-repo.ts's findRoomOccupant) is
 *    expected to treat this identically to "stale" above — attempt
 *    selfHealUnifiedSimilarity below exactly once, then re-ask this same
 *    resolver for the terminal verdict — before ever surfacing a
 *    still-non-terminal result to the user. See that function's own header
 *    comment for why "pending" alone must never be read as "archive-only is
 *    close enough." The caller must show neutral loading — again, no
 *    number to render.
 *  - "failed" (release-hardening audit finding LIFECYCLE-06, corrected):
 *    the last write-time/self-heal attempt genuinely, reproducibly failed
 *    — resolvePrimarySimilaritySummary's own computeUnifiedSimilarity
 *    threw for this report's own data (see that function's own `failed`
 *    field and its own investigation of what does/doesn't set it — a
 *    fail-soft individual-source issue like an UNAVAILABLE historical
 *    match never reaches this branch). Terminal: the caller must show
 *    "Unavailable," never keep the user waiting on a result that will not
 *    arrive from further passive polling. Distinct from "pending" so a
 *    caller can tell "still might resolve" apart from "this specific
 *    attempt is known to have failed" — never inferred from elapsed
 *    client-side polling time, only from this genuine, persisted signal.
 * A caller that wants an archive-only number to show for "stale"/"pending"/
 * "failed" (there usually isn't one — see OverviewReport/room-page-shell.tsx,
 * which all show neutral/unavailable text instead) must fetch archiveScore
 * itself from wherever it already had it and decide that explicitly; it is
 * deliberately not handed out here.
 */
export type PersistedSimilarityDisplay =
  | { status: "resolved"; primaryScore: number; isUnified: boolean }
  | { status: "stale" }
  | { status: "pending" }
  | { status: "failed" };

/**
 * Release-hardening audit finding SIM-04: the READ-side counterpart to
 * resolvePrimarySimilaritySummary above — never calls
 * getOrComputeHistoricalMatchSnapshot, never runs (or risks running) the
 * expensive matcher. Takes only what a caller can obtain from ALREADY-
 * PERSISTED data (lib/reports-repo.ts's findRoomOccupant via a plain
 * json_extract SQL read; app/reports/[id]/page.tsx via its own already-
 * parsed payload_json) plus isHistoricalMatchSnapshotCurrent's own two
 * cheap, read-only SELECTs — this is "equivalent live filtering" to
 * lib/report-historical-match.ts's own applyCorpusSourceMatchingFlag,
 * reproduced here at the DISPLAY-DECISION level (never reaching for the raw
 * historicalSubmissionMatch.matches array this function never has) so the
 * room card's own bypass of that flag check (the exact gap this finding
 * closes) can never happen again — and so room and detail, which both call
 * this same function, can never disagree.
 */
export async function resolvePersistedSimilarityDisplay(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    archiveScore: number;
    /** From payload.unifiedSimilarity?.unifiedScore (or its json_extract equivalent) — meaningless unless hasUnifiedSimilarity is true. */
    unifiedScore: number | null;
    /** Whether payload.unifiedSimilarity was ever persisted at all for this report. */
    hasUnifiedSimilarity: boolean;
    /** payload.corpusSourceMatchingEnabledAtComputation (or its json_extract equivalent) — the flag snapshot resolvePrimarySimilaritySummary recorded at write time. null/undefined is treated as "never recorded" (a report saved before this fix existed), which is always a mismatch against the live flag, forcing one honest re-resolution rather than silently trusting an unlabeled legacy value. */
    corpusSourceMatchingEnabledAtComputation: boolean | null | undefined;
    /** payload.unifiedSimilarityFailed (or its json_extract equivalent) — see PersistedSimilarityDisplay's own "failed" branch. Checked only when hasUnifiedSimilarity is false: a REAL persisted result always wins over a stale failure marker left behind by an earlier attempt (a later successful resave clears unifiedSimilarityFailed explicitly — see app/api/reports/route.ts's own write). */
    unifiedSimilarityFailed: boolean;
    /**
     * Backward-compatibility fix: whether payload.unifiedSimilarity.matchedPositions
     * was ever persisted for this report — true from
     * `json_extract(payload_json, '$.unifiedSimilarity.matchedPositions') IS NOT NULL`
     * (or the equivalent `!== undefined` check on an already-parsed payload),
     * NOT from `.length > 0`. A real, current 0% match legitimately persists
     * matchedPositions: [] — present but empty — and must stay "resolved",
     * never mistaken for "field never existed." Only reports saved before
     * lib/unified-similarity.ts's computeUnifiedSimilarity started returning
     * matchedPositions/previousUploadPositions (see that type's own comment)
     * have this false while hasUnifiedSimilarity is true — a genuinely
     * resolved score with no position evidence to render highlighting from.
     */
    hasPositionEvidence: boolean;
  },
): Promise<PersistedSimilarityDisplay> {
  if (!params.hasUnifiedSimilarity) {
    return params.unifiedSimilarityFailed ? { status: "failed" } : { status: "pending" };
  }
  const liveFlag = isCorpusSourceMatchingEnabled();
  const computedWithFlag = Boolean(params.corpusSourceMatchingEnabledAtComputation);
  if (computedWithFlag && !liveFlag) {
    // Live flag ROLLBACK (was on, now off): a deterministic, IMMEDIATE
    // answer — disabling corpus-source matching can only ever REMOVE a
    // contribution, never add one, so archive-only is already known
    // correct right now. No wait, no recompute needed to know this.
    return { status: "resolved", primaryScore: params.archiveScore, isUnified: false };
  }
  if (!computedWithFlag && liveFlag) {
    // Live flag ROLL-FORWARD (was off, now on): the opposite direction is
    // NOT deterministic — a corpus source that would now match cannot be
    // ruled out without actually running the matcher again. Treated
    // exactly like generation staleness: show "Updating similarity…"
    // rather than a number until a real recompute (app/api/reports/[id]/
    // route.ts's own self-heal path) resolves and persists the answer.
    return { status: "stale" };
  }
  const current = await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId });
  if (!current) {
    return { status: "stale" };
  }
  // Backward-compatibility fix: current per generation/flag/snapshot is not
  // the same as PRESENTATION-complete. A report self-healed before
  // matchedPositions/previousUploadPositions existed can be fully current
  // by every check above yet still have nothing for the renderer to
  // highlight from — required invariant: "a resolved unified report must
  // not be considered presentation-complete when it lacks the canonical
  // position evidence required to explain its score." Reusing "stale" here
  // (rather than a new status) is deliberate: it is already exactly the
  // "not an authoritative answer right now, self-heal once" signal every
  // caller (lib/reports-repo.ts's findRoomOccupant) already acts on — no
  // second actionable-state concept, no duplicated self-heal wiring.
  if (!params.hasPositionEvidence) {
    return { status: "stale" };
  }
  return { status: "resolved", primaryScore: params.unifiedScore ?? params.archiveScore, isUnified: true };
}

/**
 * Non-converging NO_HISTORICAL_MATCH fix — the "shape" half of
 * presentationResolved (see SelfHealResult's own comment for the other
 * half, the write-landed check). A pure, directly-testable predicate,
 * deliberately kept OUT of lib/report-historical-match.ts's own
 * isSnapshotRowCurrent so the two can be tested independently.
 *
 * Since definitive-no-match caching landed, a complete, current, flag-on
 * NO_HISTORICAL_MATCH IS an ordinary cache hit through
 * isHistoricalMatchSnapshotCurrent, so findRoomOccupant's normal "resolved"
 * path already handles it. This predicate still matters for the request
 * that computes the very first snapshot for a report (no row exists yet, so
 * isHistoricalMatchSnapshotCurrent is briefly false until the write lands)
 * and — the common case in current production — for every no-match computed
 * while CORPUS_SOURCE_MATCHING_ENABLED is off, which is stored under the
 * feature-disabled marker and deliberately never a cache hit.
 *
 * Re-checks version tags, partial, and generation independently rather than
 * trusting the caller — matching the task's own required regression
 * coverage for "version-mismatched" / "partial" / "generation-behind"
 * NO_HISTORICAL_MATCH results. matcherVersion is compared against
 * SNAPSHOT_MATCHER_VERSION (base label + candidate-discovery config digest)
 * — the exact value a fresh snapshot row's matcher_version column holds.
 */
export function isFreshCurrentNoHistoricalMatch(
  match: ReportHistoricalSubmissionMatch,
  generationAtComputation: number,
  liveGenerationAfterWrite: number,
): boolean {
  return (
    match.status === "NO_HISTORICAL_MATCH" &&
    match.matcherVersion === SNAPSHOT_MATCHER_VERSION &&
    match.fingerprintVersion === CORPUS_FINGERPRINT_VERSION &&
    match.canonicalizationVersion === CANONICALIZATION_VERSION &&
    match.partial !== true &&
    generationAtComputation >= liveGenerationAfterWrite
  );
}

export type SelfHealResult =
  | {
    attempted: true; outcome: "resolved"; unifiedSimilarity: UnifiedSimilarityResult; corpusSourceMatchingEnabled: boolean;
    /**
     * Non-converging NO_HISTORICAL_MATCH fix: true only when BOTH —
     * isFreshCurrentNoHistoricalMatch (above) confirms this call's own
     * historical-match recomputation is a genuine, current, non-partial,
     * version-current NO_HISTORICAL_MATCH, checked against a live
     * corpus-generation re-read taken right after that recomputation's own
     * write (catches a generation bump racing the recomputation itself) —
     * AND the unifiedSimilarity write just below actually landed
     * (rowsAffected > 0 — a concurrent write with a higher
     * unifiedSimilarityGeneration could otherwise have silently out-raced
     * this one's own generation-guarded UPDATE).
     *
     * Still meaningful even now that a complete flag-on NO_HISTORICAL_MATCH
     * IS cacheable through isSnapshotRowCurrent: it covers the request that
     * writes the very first snapshot (no row to hit yet) and every no-match
     * computed with corpus-source matching off (stored under the
     * feature-disabled marker, deliberately never a cache hit — section 9).
     * A caller (lib/reports-repo.ts's findRoomOccupant) uses this to treat
     * ITS OWN current response as presentation-resolved without depending on
     * the snapshot already being a cache hit; when the snapshot IS a cache
     * hit, the caller's normal "resolved" path handles it and this override
     * simply never fires.
     */
    presentationResolved: boolean;
  }
  | { attempted: true; outcome: "failed" }
  | { attempted: false };

/**
 * The payload_json keys a similarity finalization / self-heal write OWNS —
 * the ONLY keys it may create, replace, or remove. Everything else in
 * payload_json belongs to a different, independent writer and MUST survive a
 * similarity write byte-for-byte, no matter how the two interleave:
 *   - AI-owned: $.aiAnalysis and its paired raw $.aiScore — written together
 *     by the AI-completion SAVE_REPORT_SQL path (app/api/reports/route.ts,
 *     app/reports/rooms/[room]/room-page-shell.tsx's saveEnrichedAiResult).
 *   - general report fields: title, text, sources, wordCount, … — set once
 *     by the report-generation pipeline, never by a similarity refresh.
 *
 * Fresh-report aiAnalysis-loss fix (Room 5, "The Legal Framework Governing
 * the Election of Constitutional Law Professors…"): the self-heal writes
 * used to rebuild payload_json wholesale from a spread of the row as it was
 * read EARLIER in the request, then write that whole blob back with a raw
 * `UPDATE … SET payload_json = ?`. resolvePrimarySimilaritySummary in
 * between does real matcher work whenever the corpus generation has just
 * moved (exactly the corpus-admission-rollout case), so a concurrent
 * AI-completion SAVE_REPORT_SQL write — which sets $.aiAnalysis/$.aiScore
 * AND moves ai_status to 'ready' + a real ai_score — could commit inside
 * that window. The wholesale write then clobbered that freshly-persisted
 * $.aiAnalysis straight back out (the stale in-memory copy never had it),
 * while the flat ai_* columns, which this path never touches, stayed
 * 'ready' + numeric — producing exactly the Room-5 UI: "0% AI" with "The
 * passage-level breakdown isn't available for this saved copy."
 *
 * persistRefreshedSimilarity below closes that: it applies json_set /
 * json_remove to the row's CURRENT payload_json column value in a single
 * atomic statement, touching ONLY the four similarity-owned keys. Any
 * $.aiAnalysis / $.aiScore (and every other field) a concurrent writer
 * added is read back live by json_set and preserved, regardless of commit
 * order. The generation guard is unchanged — a genuinely newer-generation
 * result a concurrent write already persisted still wins (COALESCE(…, -1)
 * <= this resolution's generation).
 */
const SIMILARITY_GENERATION_GUARD_SQL =
  "COALESCE(json_extract(payload_json, '$.unifiedSimilarityGeneration'), -1) <= ?";

export async function persistRefreshedSimilarity(
  client: Client,
  params: { reportDeviceKey: string; reportId: string },
  resolution: Pick<
    PrimarySimilarityResolution,
    "unifiedSimilarity" | "failed" | "corpusSourceMatchingEnabled" | "corpusGeneration"
  >,
): Promise<{ written: "resolved" | "failed" | "none"; rowsAffected: number }> {
  // json(?) with the literal 'true'/'false' text inserts a real JSON boolean
  // (SQLite has no native boolean), keeping the persisted shape identical to
  // what JSON.stringify(resolution.corpusSourceMatchingEnabled) writes
  // everywhere else. json_valid(payload_json) is a defensive floor: a row
  // whose payload_json somehow is not valid JSON (json_set would return NULL
  // for it) is simply left untouched — same "eligible for another attempt"
  // outcome the callers' own try/catch already produces.
  const flagText = resolution.corpusSourceMatchingEnabled ? "true" : "false";
  if (resolution.unifiedSimilarity) {
    const result = await client.execute({
      sql: `UPDATE saved_reports
            SET payload_json = json_set(
                  payload_json,
                  '$.unifiedSimilarity', json(?),
                  '$.corpusSourceMatchingEnabledAtComputation', json(?),
                  '$.unifiedSimilarityGeneration', ?,
                  '$.unifiedSimilarityFailed', json('false')
                )
            WHERE device_key = ? AND id = ? AND json_valid(payload_json) AND ${SIMILARITY_GENERATION_GUARD_SQL}`,
      args: [
        JSON.stringify(resolution.unifiedSimilarity),
        flagText,
        resolution.corpusGeneration,
        params.reportDeviceKey,
        params.reportId,
        resolution.corpusGeneration,
      ],
    });
    return { written: "resolved", rowsAffected: Number(result.rowsAffected) };
  }
  if (resolution.failed) {
    const result = await client.execute({
      sql: `UPDATE saved_reports
            SET payload_json = json_set(
                  json_remove(payload_json, '$.unifiedSimilarity'),
                  '$.corpusSourceMatchingEnabledAtComputation', json(?),
                  '$.unifiedSimilarityGeneration', ?,
                  '$.unifiedSimilarityFailed', json('true')
                )
            WHERE device_key = ? AND id = ? AND json_valid(payload_json) AND ${SIMILARITY_GENERATION_GUARD_SQL}`,
      args: [
        flagText,
        resolution.corpusGeneration,
        params.reportDeviceKey,
        params.reportId,
        resolution.corpusGeneration,
      ],
    });
    return { written: "failed", rowsAffected: Number(result.rowsAffected) };
  }
  return { written: "none", rowsAffected: 0 };
}

/**
 * Legacy-room bug fix, twice-revised.
 *
 * REJECTED FIRST FIX: reading "no unifiedSimilarity + no failure marker +
 * real text present" as "resolved, archive-only" — !hasUnifiedSimilarity &&
 * !unifiedSimilarityFailed can genuinely mean either a legacy row OR a
 * modern row whose write-time finalization hit the rare transient-infra
 * skip in app/api/reports/route.ts's own outer catch; text presence alone
 * cannot tell those apart, and inferring archiveScore as final for either
 * one can show a false terminal 0% for what is actually a 100% promoted-
 * corpus-source match.
 *
 * PREVIEW REGRESSION (ca89842): the second fix gated this function's own
 * invocation on the RAW hasUnifiedSimilarity/unifiedSimilarityFailed flags
 * — !hasUnifiedSimilarity && !unifiedSimilarityFailed — which only ever
 * covers "no unifiedSimilarity has ever been persisted." A real legacy row
 * observed in Preview had a real, ALREADY-persisted unifiedSimilarity (a
 * genuine, previously-computed 0%) that simply predates
 * unifiedSimilarityGeneration/corpusSourceMatchingEnabledAtComputation
 * existing at all — hasUnifiedSimilarity was true, so this function was
 * never called; resolvePersistedSimilarityDisplay correctly, honestly
 * classified it "stale" (a live-flag roll-forward since computation, per
 * that function's own comment) — but nothing at the room layer ever acted
 * on "stale," so the room polled it forever.
 *
 * ACCEPTED FIX: this function's own body does not change — it already
 * re-resolves from scratch and persists unconditionally, regardless of
 * whether a unifiedSimilarity value previously existed. What changes is the
 * CALLER's own trigger condition (lib/reports-repo.ts's findRoomOccupant):
 * instead of duplicating resolvePersistedSimilarityDisplay's own freshness
 * rules (generation, live-flag comparison, snapshot currency) as a second,
 * parallel gate, the caller asks that SAME canonical resolver for its
 * verdict FIRST, and treats "pending" and "stale" alike as actionable —
 * both mean "the persisted state is not an authoritative answer right
 * now," whether because nothing was ever persisted or because what was
 * persisted no longer reflects current freshness metadata. Renamed from
 * selfHealMissingUnifiedSimilarity to reflect that it is no longer only
 * for the missing case.
 *
 * Called from findRoomOccupant exactly once per non-terminal read: on
 * success, hasUnifiedSimilarity/unifiedSimilarityFailed are updated in the
 * DB (via the SAME generation-guarded write write-time finalization and
 * the detail page's own self-heal already use), so every subsequent
 * findRoomOccupant call for this row (reload, logout/login, a later poll)
 * sees an already-resolved or already-failed row through
 * resolvePersistedSimilarityDisplay's own ordinary cheap path and never
 * re-enters this function again. This is compatibility self-heal, not
 * repeated analysis — it never touches ai_score/ai_status (the AI pipeline
 * is untouched, never rerun, never restarted) and never re-extracts or
 * re-reads the source document beyond the rawText already sitting in
 * payload_json.
 *
 * Deliberately does not special-case missing/empty text as a reason to
 * skip the attempt: resolvePrimarySimilaritySummary's own
 * computeUnifiedSimilarity is unconditional and does not require text (it
 * consumes wordCount/archiveMatchedPositions/externalAcademicEvidence/
 * historicalSubmissionMatch), so a text-less legacy row still converges to
 * an honest, real "resolved" result (a genuine 0%, since there is nothing
 * to match) rather than an indefinitely stuck "pending" — the same
 * "text presence as a discriminator" pattern this fix was told not to use
 * for the fallback value must not be reintroduced here as a gate on
 * whether to even attempt resolution. A genuine infrastructure failure
 * during the attempt itself (DB connectivity, etc. — the same class
 * resolvePrimarySimilaritySummary's own callers already guard against, see
 * tests/report-primary-similarity.test.mjs's "not unconditionally safe"
 * coverage) is caught here and reported as attempted:false, leaving the row
 * exactly as ambiguous as before — eligible for another attempt on the next
 * view, never persisted as a false resolved/failed state.
 */
export async function selfHealUnifiedSimilarity(
  client: Client,
  params: {
    reportDeviceKey: string; reportId: string; accountId: string | null;
    /**
     * Test-only barrier hook, mirroring getOrComputeHistoricalMatchSnapshot's
     * own testOnlyPauseBeforeWrite convention — awaited immediately after
     * the unifiedSimilarity write below has already committed, before the
     * live corpus-generation re-read that decides presentationResolved.
     * Lets a test reproduce a generation bump racing this exact
     * recomputation (started before the bump, wrote before the bump landed,
     * but the live re-read below must still see it) and prove
     * presentationResolved correctly comes back false rather than trusting
     * the now-stale resolution.corpusGeneration. Always undefined in
     * production.
     */
    testOnlyAfterWriteBeforeGenerationRecheck?: () => Promise<void>;
    /**
     * Test-only barrier hook — awaited AFTER resolvePrimarySimilaritySummary
     * has returned but BEFORE the payload_json write below. Lets a test
     * reproduce the fresh-report aiAnalysis-loss race: a concurrent
     * AI-completion SAVE_REPORT_SQL write commits inside exactly this window
     * (self-heal read the row without an aiAnalysis, matched, and is about
     * to write). persistRefreshedSimilarity must then preserve that
     * concurrently-added $.aiAnalysis/$.aiScore. Always undefined in
     * production.
     */
    testOnlyBeforePersist?: () => Promise<void>;
  },
): Promise<SelfHealResult> {
  try {
    const row = await client.execute({
      sql: "SELECT payload_json, archive_score FROM saved_reports WHERE device_key = ? AND id = ?",
      args: [params.reportDeviceKey, params.reportId],
    });
    const raw = row.rows[0] as unknown as { payload_json: string; archive_score: number | bigint } | undefined;
    if (!raw) return { attempted: false };
    const payload = JSON.parse(String(raw.payload_json)) as SimilarityReport;

    const resolution = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: params.reportDeviceKey,
      reportId: params.reportId,
      accountId: params.accountId,
      rawText: payload.text,
      wordCount: payload.wordCount,
      archiveMatchedPositions: payload.archiveMatchedPositions,
      externalAcademicEvidence: payload.externalAcademicEvidence,
      archiveScore: payload.archiveScore ?? payload.score ?? Number(raw.archive_score),
    });

    if (params.testOnlyBeforePersist) await params.testOnlyBeforePersist();

    if (resolution.unifiedSimilarity) {
      // AI-owned ($.aiAnalysis/$.aiScore) and every other payload field are
      // left to json_set to read back live from the current row — a
      // concurrent AI-completion write landing between the read above and
      // this write is preserved, never clobbered. See
      // persistRefreshedSimilarity's own header comment (the Room-5 fix).
      const write = await persistRefreshedSimilarity(
        client,
        { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId },
        resolution,
      );
      const writeLanded = write.rowsAffected > 0;
      // Fresh, live re-read taken AFTER the write above has committed —
      // never resolution.corpusGeneration itself, which is what got
      // STAMPED onto the snapshot row (read before the recomputation ran).
      // Comparing the two is what catches a generation bump racing this
      // exact recomputation — see isFreshCurrentNoHistoricalMatch's own
      // comment. Only paid for when it can possibly matter (write landed);
      // still only ever one extra cheap indexed read, never a second
      // recomputation.
      let presentationResolved = false;
      if (writeLanded) {
        if (params.testOnlyAfterWriteBeforeGenerationRecheck) await params.testOnlyAfterWriteBeforeGenerationRecheck();
        const generationAfterWrite = await getCurrentCorpusMatchGeneration(client);
        presentationResolved = isFreshCurrentNoHistoricalMatch(resolution.historicalSubmissionMatch, resolution.corpusGeneration, generationAfterWrite);
      }
      return {
        attempted: true,
        outcome: "resolved",
        unifiedSimilarity: resolution.unifiedSimilarity,
        corpusSourceMatchingEnabled: resolution.corpusSourceMatchingEnabled,
        presentationResolved,
      };
    }
    if (resolution.failed) {
      // Same targeted write as the success branch: json_remove drops only
      // $.unifiedSimilarity and json_set stamps the three failure-marker
      // keys, on the current row — $.aiAnalysis/$.aiScore and every other
      // field are untouched.
      await persistRefreshedSimilarity(
        client,
        { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId },
        resolution,
      );
      return { attempted: true, outcome: "failed" };
    }
    return { attempted: false };
  } catch (err) {
    console.error("selfHealUnifiedSimilarity failed (non-fatal — row remains eligible for another attempt on the next room read):", err instanceof Error ? err.message : String(err));
    return { attempted: false };
  }
}
