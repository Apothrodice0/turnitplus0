import type { Client } from "@libsql/client";
import { tokens } from "./similarity-core";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256 } from "./document-identity";
import { isDevicePassportEnabled } from "./device-passport-server";
import { summarizeSubmissionProvenance } from "./submission-provenance";
import { classifyDeviceSelfMatch } from "./device-self-scoring-rule";
import type { ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * Device Passport — Phase 4: PRIOR-SUBMISSION SHADOW.
 *
 * For a real report view, this module independently computes what a proposed
 * Device-Passport-aware relationship rule WOULD have decided for EVERY
 * historical match production found (not just matches[0]) — because
 * lib/unified-similarity.ts's computeUnifiedSimilarity considers the whole
 * match collection, deduplicated by matchedRepresentationId — and records
 * ONLY bounded AGGREGATE telemetry comparing it to the REAL production
 * result. It is measurement, never a decision:
 *
 *   - It NEVER changes what a caller sees. It runs AFTER the real
 *     historical-match snapshot is already computed and already on its way to
 *     the response, via lib/run-after-response.ts's runAfterResponse — exactly
 *     the same deferred pattern app/api/reports/[id]/route.ts already uses for
 *     lib/e8p-shadow-evaluation.ts's runHistoricalMatchShadowEvaluation.
 *   - It NEVER writes report_historical_match_snapshots, saved_reports, any
 *     scoring field, or any device-passport table. Its only write target is
 *     historical_match_shadow_evaluations (drizzle/0021), reusing that
 *     existing table under a DISTINCT policy_version
 *     (DEVICE_PROVENANCE_SHADOW_POLICY_VERSION) so its rows coexist with
 *     lib/e8p-shadow-evaluation.ts's own e8o-policy-v1 rows for the same
 *     report — the table's unique index is (report_device_key, report_id,
 *     policy_version). NO migration.
 *   - It NEVER calls the production matcher, computeUnifiedSimilarity,
 *     summarizeSubmissionOwnership's callers, or resolvePrimarySimilaritySummary.
 *     It consumes production's already-computed ReportHistoricalSubmissionMatch
 *     as an input and reads it, never re-derives it.
 *   - Feature-flagged OFF: gated on isDevicePassportEnabled(). While that flag
 *     is off (the production default), saved_reports.verified_device_passport_id
 *     is never populated anyway, and this function returns before issuing a
 *     single query — production behaviour is byte-identical to today.
 *
 * DEVICE IDENTITY SOURCE (Phase 4 section 4): the report's IMMUTABLE upload
 * provenance — saved_reports.verified_device_passport_id, written once at
 * POST /api/reports and never on a resave. The browser/device currently
 * VIEWING the report is never consulted.
 *
 * GENERATION HANDLING (Phase 4 section 12): this shadow recomputes on every
 * report view (its queries are all cheap indexed lookups and it runs
 * off-response), so it is inherently current with respect to a passport's
 * per-passport device_passports.provenance_generation — that value is
 * RECORDED in proposed_evidence (reportPassportGeneration) for later
 * bucketing, but is not needed as a staleness gate here. This module
 * deliberately does NOT stamp report_historical_match_snapshots.device_provenance_generation
 * (drizzle/0040): doing so would require threading the passport id through the
 * production resolvePrimarySimilaritySummary -> getOrComputeHistoricalMatchSnapshot
 * path AND surfacing verified_device_passport_id in the report read route,
 * which tests/device-passport-privacy.test.mjs structurally forbids for that
 * route — and would expand the production write surface past "shadow only".
 * That plumbing is left for the score-changing phase.
 *
 * PRIVACY: every value persisted here is a bounded count, enum, or boolean.
 * No passport id, account id, email, IP, name, source_ref, document text, or
 * matched-passage text is ever stored — see this module's own structural
 * test (tests/device-provenance-shadow.test.mjs).
 */

export const DEVICE_PROVENANCE_SHADOW_POLICY_VERSION = "device-provenance-shadow-v1";

/** This shadow reads production's own matchType instead of recomputing correspondence, and runs no distinctiveness model — the two NOT NULL version columns record that explicitly. */
const CORRESPONDENCE_VERSION_TAG = "n/a-production-matchtype-passthrough";
const DISTINCTIVENESS_VERSION_TAG = "n/a";

type Agreement = "AGREE" | "DISAGREE_DEVICE_SELF";

type ProductionRelationship = "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP" | "TURNITPLUS_CORPUS_SOURCE";

// productionCountsRelationship + the per-match same-device SELF test both live
// in lib/device-self-scoring-rule.ts now — imported above and shared VERBATIM
// with the production unified-similarity scoring path so this shadow's
// `wouldDowngrade` and the scored decision can never diverge.

function truncatedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

type ReportProvenanceRow = {
  verified_device_passport_id: string | null;
  document_identity_id: string | null;
  user_id: string | null;
};

async function loadReportUploadProvenance(
  client: Client,
  reportDeviceKey: string,
  reportId: string,
): Promise<ReportProvenanceRow | null> {
  const result = await client.execute({
    sql: `SELECT verified_device_passport_id, document_identity_id, user_id
          FROM saved_reports WHERE device_key = ? AND id = ?`,
    args: [reportDeviceKey, reportId],
  });
  return (result.rows[0] as unknown as ReportProvenanceRow | undefined) ?? null;
}

/** The report passport's own PER-PASSPORT provenance_generation (drizzle/0038), or 0 if the passport row is missing. */
async function loadPassportProvenanceGeneration(client: Client, passportId: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT provenance_generation FROM device_passports WHERE id = ?`,
    args: [passportId],
  });
  const row = result.rows[0] as unknown as { provenance_generation: number | bigint } | undefined;
  return row ? Number(row.provenance_generation) : 0;
}

export type DevicePassportSharedness = {
  /** Distinct non-null account ids that have ever uploaded a report under this verified passport. */
  deviceDistinctAccounts: number;
  /** Total reports ever uploaded under this verified passport (lifetime — no rolling window drives anything here). */
  deviceSubmissionCount: number;
  /** Reports uploaded under this passport with no account (anonymous). */
  deviceAnonUploads: number;
};

/**
 * Lifetime-only, stable sharedness facts for one verified passport, from the
 * indexed saved_reports.verified_device_passport_id provenance
 * (idx_saved_reports_verified_device_passport). Phase 4 section 6: rolling
 * 7d/30d/90d windows are deliberately NOT computed — they must never drive a
 * classification and are not cheap enough here to be worth recording only for
 * observation.
 */
export async function summarizeDevicePassportSharedness(client: Client, passportId: string): Promise<DevicePassportSharedness> {
  const result = await client.execute({
    sql: `SELECT
            COUNT(*) AS submission_count,
            COUNT(DISTINCT user_id) AS distinct_accounts,
            SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS anon_uploads
          FROM saved_reports
          WHERE verified_device_passport_id = ?`,
    args: [passportId],
  });
  const row = result.rows[0] as unknown as { submission_count: number | bigint; distinct_accounts: number | bigint; anon_uploads: number | bigint | null };
  return {
    deviceSubmissionCount: Number(row.submission_count),
    deviceDistinctAccounts: Number(row.distinct_accounts),
    deviceAnonUploads: Number(row.anon_uploads ?? 0),
  };
}

/**
 * Why a match is / is not a device-SELF candidate — for the STRONGEST
 * candidate only, so a reviewer can see the closest case without a raw
 * per-representation array.
 */
type CandidateReason =
  /** A production-counted, EXACT_CANONICAL_MATCH match with a same-device backing and ZERO independent backing — the per-match device rule fired. */
  | "SAME_DEVICE_EXACT_DOCUMENT"
  /** Counted + exact + same-device backing, but ≥1 independent backing (another account's submission, or a different verified device) blocked the SELF proposal. */
  | "INDEPENDENT_BACKING_BLOCKED"
  /** Exact + same-device backing, but the relationship (SELF / UNKNOWN_RELATIONSHIP) is one production already does not count toward the score. */
  | "SAME_DEVICE_EXACT_NOT_COUNTED"
  /** A same-device backing exists but this was only a STRONG_TEXT_MATCH, not an exact canonical match. */
  | "SAME_DEVICE_NOT_EXACT"
  /** A production-counted match with no same-device backing at all. */
  | "COUNTED_NO_SAME_DEVICE"
  | "OTHER";

type ProposedEvidence = {
  reason: "SAME_DEVICE_EXACT_DOCUMENT" | "NO_DEVICE_DOWNGRADE" | "NO_MATCH_TO_EVALUATE";
  hasReportPassport: true;
  reportPassportGeneration: number;

  // --- production summary (bounded) ---
  productionMatchCount: number;
  productionCountedMatchCount: number;
  productionPrimaryRelationship: ProductionRelationship | null;

  // --- MULTI-MATCH device aggregates (bounded counts, Phase 4 §2) ---
  /** Distinct matchedRepresentationId values evaluated (deduplicated exactly as computeUnifiedSimilarity dedups). */
  matchesEvaluated: number;
  /** Production-counted matches whose per-match device rule fired (same-device EXACT, zero independent backing). */
  deviceSelfCandidateCount: number;
  /** Matches that were EXACT_CANONICAL_MATCH AND had a same-device backing, regardless of relationship / independent backing. */
  exactSameDeviceMatchCount: number;
  /** Counted + exact + same-device matches that would have been a SELF candidate BUT FOR ≥1 independent backing. */
  independentBlockedCandidateCount: number;
  /** true iff deviceSelfCandidateCount > 0 — i.e. AT LEAST ONE production-counted historical match would become SELF (NOT "every match becomes SELF"). */
  wouldDowngrade: boolean;
  /** "SELF" iff wouldDowngrade — the coarse existing telemetry signal, meaning "≥1 counted historical match would be SELF", never "the whole historical result is SELF". null otherwise. */
  proposedRelationship: "SELF" | null;

  // --- STRONGEST candidate bounded summary (Phase 4 §2 — NO representation / passport / account id) ---
  candidateReason: CandidateReason | null;
  candidateMatchType: "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH" | null;
  candidateRelationship: ProductionRelationship | null;
  candidateExactCanonicalMatch: boolean;
  candidateProductionCountsThisSource: boolean;
  candidateSameVerifiedDeviceBacking: boolean;
  candidateSameDeviceBackingCount: number;
  candidateIndependentBackingCount: number;
  candidateBackingsWithoutDeviceProvenance: number;
  candidateSubmissionReferenceBackingCount: number;
  candidateAdmittedPromotionBackingCount: number;
  candidateAdmittedBackingsDifferentDevice: number;
  candidateAdmittedBackingsNoDeviceProvenance: number;
  candidateHasSameAccountSubmission: boolean;
  candidateOtherAccountSubmissionCount: number;
  candidateIdentitySameAccount: boolean;
  candidatePriorSameAccountIdentityCount: number;

  // --- device sharedness (bounded, lifetime only) ---
  deviceDistinctAccounts: number;
  deviceSubmissionCount: number;
  deviceAnonUploads: number;
  deviceSharedAcrossAccounts: boolean;
};

type PerMatchEvaluation = {
  relationship: ProductionRelationship;
  matchType: "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";
  exactCanonicalMatch: boolean;
  productionCountsThisSource: boolean;
  wouldDowngrade: boolean;
  provenance: Awaited<ReturnType<typeof summarizeSubmissionProvenance>>;
};

function candidateRank(m: PerMatchEvaluation): number {
  if (m.wouldDowngrade) return 5;
  if (m.productionCountsThisSource && m.exactCanonicalMatch && m.provenance.sameVerifiedDeviceBacking) return 4; // independent-blocked
  if (m.exactCanonicalMatch && m.provenance.sameVerifiedDeviceBacking) return 3; // relationship not counted
  if (m.provenance.sameVerifiedDeviceBacking) return 2; // same-device but not exact
  if (m.productionCountsThisSource) return 1;
  return 0;
}

function candidateReasonFor(m: PerMatchEvaluation): CandidateReason {
  if (m.wouldDowngrade) return "SAME_DEVICE_EXACT_DOCUMENT";
  if (m.productionCountsThisSource && m.exactCanonicalMatch && m.provenance.sameVerifiedDeviceBacking) return "INDEPENDENT_BACKING_BLOCKED";
  if (m.exactCanonicalMatch && m.provenance.sameVerifiedDeviceBacking) return "SAME_DEVICE_EXACT_NOT_COUNTED";
  if (m.provenance.sameVerifiedDeviceBacking) return "SAME_DEVICE_NOT_EXACT";
  if (m.productionCountsThisSource) return "COUNTED_NO_SAME_DEVICE";
  return "OTHER";
}

const EMPTY_CANDIDATE_FIELDS = {
  candidateReason: null,
  candidateMatchType: null,
  candidateRelationship: null,
  candidateExactCanonicalMatch: false,
  candidateProductionCountsThisSource: false,
  candidateSameVerifiedDeviceBacking: false,
  candidateSameDeviceBackingCount: 0,
  candidateIndependentBackingCount: 0,
  candidateBackingsWithoutDeviceProvenance: 0,
  candidateSubmissionReferenceBackingCount: 0,
  candidateAdmittedPromotionBackingCount: 0,
  candidateAdmittedBackingsDifferentDevice: 0,
  candidateAdmittedBackingsNoDeviceProvenance: 0,
  candidateHasSameAccountSubmission: false,
  candidateOtherAccountSubmissionCount: 0,
  candidateIdentitySameAccount: false,
  candidatePriorSameAccountIdentityCount: 0,
} as const;

type TelemetryRow = {
  reportDeviceKey: string;
  reportId: string;
  productionStatus: "MATCHED" | "NO_HISTORICAL_MATCH";
  productionRelationship: string | null;
  proposedStatus: "MATCHED" | "NO_HISTORICAL_MATCH";
  proposedRelationship: string | null;
  proposedEvidence: string;
  agreement: Agreement;
  candidateCount: number;
  submittedWordCount: number;
  totalRuntimeMs: number;
  status: "OK" | "FAILED";
  errorMessage: string | null;
};

async function existingRowStatus(client: Client, reportDeviceKey: string, reportId: string): Promise<string | null> {
  const result = await client.execute({
    sql: `SELECT status FROM historical_match_shadow_evaluations
          WHERE report_device_key = ? AND report_id = ? AND policy_version = ?`,
    args: [reportDeviceKey, reportId, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION],
  });
  const row = result.rows[0] as unknown as { status: string } | undefined;
  return row ? String(row.status) : null;
}

async function upsertTelemetryRow(client: Client, row: TelemetryRow): Promise<void> {
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
          (report_device_key, report_id, production_status, production_relationship, proposed_status,
           proposed_relationship, proposed_evidence, agreement, candidate_count, passage_level_evaluated_count,
           freq_index_document_count, submitted_word_count, e8m_runtime_ms, v2_runtime_ms, total_runtime_ms,
           policy_version, correspondence_version, distinctiveness_version, status, error_message, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,0,?,NULL,NULL,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
          ON CONFLICT(report_device_key, report_id, policy_version) DO UPDATE SET
            production_status = excluded.production_status,
            production_relationship = excluded.production_relationship,
            proposed_status = excluded.proposed_status,
            proposed_relationship = excluded.proposed_relationship,
            proposed_evidence = excluded.proposed_evidence,
            agreement = excluded.agreement,
            candidate_count = excluded.candidate_count,
            submitted_word_count = excluded.submitted_word_count,
            total_runtime_ms = excluded.total_runtime_ms,
            correspondence_version = excluded.correspondence_version,
            distinctiveness_version = excluded.distinctiveness_version,
            status = excluded.status,
            error_message = excluded.error_message,
            computed_at = excluded.computed_at`,
    args: [
      row.reportDeviceKey,
      row.reportId,
      row.productionStatus,
      row.productionRelationship,
      row.proposedStatus,
      row.proposedRelationship,
      row.proposedEvidence,
      row.agreement,
      row.candidateCount,
      row.submittedWordCount,
      row.totalRuntimeMs,
      DEVICE_PROVENANCE_SHADOW_POLICY_VERSION,
      CORRESPONDENCE_VERSION_TAG,
      DISTINCTIVENESS_VERSION_TAG,
      row.status,
      row.errorMessage,
    ],
  });
}

export type RunDeviceProvenanceShadowEvaluationParams = {
  reportDeviceKey: string;
  reportId: string;
  /** The viewing account (for a valid report read this equals the report owner). */
  accountId: string | null;
  rawText: string;
  /** production's already-computed historical-match result — read, never re-derived. */
  productionResult: ReportHistoricalSubmissionMatch;
};

/**
 * SHADOW ONLY. Best-effort, bounded, non-blocking, idempotent-upserted, and
 * NEVER throws — a telemetry failure must never fail report loading or
 * saving. Returns without any query when the Device Passport feature flag is
 * off, when production could not produce a comparable result, or when the
 * report has no verified upload passport (Phase 4 section 4: with no report
 * passport, device evidence is absent and current behaviour is unchanged).
 */
export async function runDeviceProvenanceShadowEvaluation(
  client: Client,
  params: RunDeviceProvenanceShadowEvaluationParams,
): Promise<void> {
  if (!isDevicePassportEnabled()) return;
  if (params.productionResult.status === "UNAVAILABLE") return;

  const startedAt = Date.now();
  try {
    const reportRow = await loadReportUploadProvenance(client, params.reportDeviceKey, params.reportId);
    const reportPassportId = reportRow?.verified_device_passport_id ?? null;
    if (!reportPassportId) return; // no verified upload passport -> nothing device-related to observe

    // A FAILED row for this report+policy is left cached (don't hammer a
    // permanently-failing computation) — mirrors lib/e8p-shadow-evaluation.ts.
    if ((await existingRowStatus(client, params.reportDeviceKey, params.reportId)) === "FAILED") return;

    const reportPassportGeneration = await loadPassportProvenanceGeneration(client, reportPassportId);
    const sharedness = await summarizeDevicePassportSharedness(client, reportPassportId);
    const submittedWordCount = tokens(canonicalizeText(params.rawText)).length;

    const productionStatus: "MATCHED" | "NO_HISTORICAL_MATCH" =
      params.productionResult.status === "MATCHED" ? "MATCHED" : "NO_HISTORICAL_MATCH";
    const rawMatches = params.productionResult.matches ?? [];

    // Dedup by matchedRepresentationId, keeping the first (production is
    // priority-sorted — matches[0] is the headline) exactly as
    // computeUnifiedSimilarity's own seenPriorRepresentation set does, so
    // "how many candidates" here means the same thing it does for the score.
    const seen = new Set<string>();
    const distinctMatches = rawMatches.filter((m) => {
      if (seen.has(m.matchedRepresentationId)) return false;
      seen.add(m.matchedRepresentationId);
      return true;
    });
    const primaryRelationship: ProductionRelationship | null =
      rawMatches[0] ? (rawMatches[0].relationshipType as ProductionRelationship) : null;

    const baseEvidence = {
      hasReportPassport: true as const,
      reportPassportGeneration,
      productionMatchCount: rawMatches.length,
      productionPrimaryRelationship: primaryRelationship,
      deviceDistinctAccounts: sharedness.deviceDistinctAccounts,
      deviceSubmissionCount: sharedness.deviceSubmissionCount,
      deviceAnonUploads: sharedness.deviceAnonUploads,
      deviceSharedAcrossAccounts: sharedness.deviceDistinctAccounts > 1,
    };

    if (productionStatus !== "MATCHED" || distinctMatches.length === 0) {
      // Production found nothing to compare against — no matched
      // representation to evaluate a device backing for. Record the device
      // sharedness observation only.
      const evidence: ProposedEvidence = {
        ...baseEvidence,
        ...EMPTY_CANDIDATE_FIELDS,
        reason: "NO_MATCH_TO_EVALUATE",
        productionCountedMatchCount: 0,
        matchesEvaluated: 0,
        deviceSelfCandidateCount: 0,
        exactSameDeviceMatchCount: 0,
        independentBlockedCandidateCount: 0,
        wouldDowngrade: false,
        proposedRelationship: null,
      };
      await upsertTelemetryRow(client, {
        reportDeviceKey: params.reportDeviceKey,
        reportId: params.reportId,
        productionStatus,
        productionRelationship: primaryRelationship,
        proposedStatus: productionStatus,
        proposedRelationship: null,
        proposedEvidence: JSON.stringify(evidence),
        agreement: "AGREE",
        candidateCount: rawMatches.length,
        submittedWordCount,
        totalRuntimeMs: Date.now() - startedAt,
        status: "OK",
        errorMessage: null,
      });
      return;
    }

    // Phase 4 §1: evaluate EVERY distinct matched representation. Never
    // modify a match object; never return SELF to production.
    const reportCanonicalSha256 = canonicalSha256(params.rawText);
    const perMatch: PerMatchEvaluation[] = [];
    for (const match of distinctMatches) {
      const provenance = await summarizeSubmissionProvenance(client, match.matchedRepresentationId, {
        accountId: params.accountId,
        excludeDocumentIdentityId: reportRow?.document_identity_id ?? null,
        reportVerifiedDevicePassportId: reportPassportId,
        reportCanonicalSha256,
        reportDocumentIdentityId: reportRow?.document_identity_id ?? null,
      });
      const relationship = match.relationshipType as ProductionRelationship;
      // The PROPOSED per-match Device-Passport rule, OBSERVATION only (Phase 4
      // §1) — the exact same shared classifier lib/report-primary-similarity.ts
      // uses for the score-changing path. Deliberately conservative: any
      // independent backing (Phase 4 §10 / INDEPENDENT_BACKING_DEFINITION)
      // blocks this match's SELF proposal.
      const classification = classifyDeviceSelfMatch({
        relationshipType: relationship,
        matchType: match.matchType,
        sameVerifiedDeviceBacking: provenance.sameVerifiedDeviceBacking,
        independentBackingCount: provenance.independentBackingCount,
      });
      const exactCanonicalMatch = classification.exactCanonicalMatch;
      const productionCountsThisSource = classification.productionCountsRelationship;
      const wouldDowngrade = classification.isEffectiveDeviceSelf;
      perMatch.push({ relationship, matchType: match.matchType, exactCanonicalMatch, productionCountsThisSource, wouldDowngrade, provenance });
    }

    const deviceSelfCandidateCount = perMatch.filter((m) => m.wouldDowngrade).length;
    const exactSameDeviceMatchCount = perMatch.filter((m) => m.exactCanonicalMatch && m.provenance.sameVerifiedDeviceBacking).length;
    const independentBlockedCandidateCount = perMatch.filter(
      (m) => m.productionCountsThisSource && m.exactCanonicalMatch && m.provenance.sameVerifiedDeviceBacking && m.provenance.independentBackingCount > 0,
    ).length;
    const productionCountedMatchCount = perMatch.filter((m) => m.productionCountsThisSource).length;

    // Phase 4 §3: wouldDowngrade == true if >= 1 individual production-counted
    // match would become SELF. proposedRelationship = "SELF" is kept only as
    // the coarse existing telemetry signal and means exactly that — NOT that
    // every historical match becomes SELF.
    const wouldDowngrade = deviceSelfCandidateCount > 0;
    const proposedRelationship: "SELF" | null = wouldDowngrade ? "SELF" : null;
    const agreement: Agreement = wouldDowngrade ? "DISAGREE_DEVICE_SELF" : "AGREE";

    // Strongest candidate: highest rank, ties broken by production priority
    // order (perMatch preserves distinctMatches order, which is matches[]
    // order). A bounded summary only — never a per-representation array.
    let strongest = perMatch[0];
    for (const m of perMatch) if (candidateRank(m) > candidateRank(strongest)) strongest = m;

    const evidence: ProposedEvidence = {
      ...baseEvidence,
      reason: wouldDowngrade ? "SAME_DEVICE_EXACT_DOCUMENT" : "NO_DEVICE_DOWNGRADE",
      productionCountedMatchCount,
      matchesEvaluated: perMatch.length,
      deviceSelfCandidateCount,
      exactSameDeviceMatchCount,
      independentBlockedCandidateCount,
      wouldDowngrade,
      proposedRelationship,
      candidateReason: candidateReasonFor(strongest),
      candidateMatchType: strongest.matchType,
      candidateRelationship: strongest.relationship,
      candidateExactCanonicalMatch: strongest.exactCanonicalMatch,
      candidateProductionCountsThisSource: strongest.productionCountsThisSource,
      candidateSameVerifiedDeviceBacking: strongest.provenance.sameVerifiedDeviceBacking,
      candidateSameDeviceBackingCount: strongest.provenance.sameDeviceBackingCount,
      candidateIndependentBackingCount: strongest.provenance.independentBackingCount,
      candidateBackingsWithoutDeviceProvenance: strongest.provenance.backingsWithoutDeviceProvenance,
      candidateSubmissionReferenceBackingCount: strongest.provenance.submissionReferenceBackingCount,
      candidateAdmittedPromotionBackingCount: strongest.provenance.admittedPromotionBackingCount,
      candidateAdmittedBackingsDifferentDevice: strongest.provenance.admittedBackingsDifferentDevice,
      candidateAdmittedBackingsNoDeviceProvenance: strongest.provenance.admittedBackingsNoDeviceProvenance,
      candidateHasSameAccountSubmission: strongest.provenance.hasSameAccountSubmission,
      candidateOtherAccountSubmissionCount: strongest.provenance.otherAccountSubmissionCount,
      candidateIdentitySameAccount: strongest.provenance.identitySameAccount,
      candidatePriorSameAccountIdentityCount: strongest.provenance.priorSameAccountIdentityCount,
    };

    await upsertTelemetryRow(client, {
      reportDeviceKey: params.reportDeviceKey,
      reportId: params.reportId,
      productionStatus,
      productionRelationship: primaryRelationship,
      proposedStatus: productionStatus,
      proposedRelationship,
      proposedEvidence: JSON.stringify(evidence),
      agreement,
      candidateCount: rawMatches.length,
      submittedWordCount,
      totalRuntimeMs: Date.now() - startedAt,
      status: "OK",
      errorMessage: null,
    });
  } catch (error) {
    console.error(
      `device-provenance shadow evaluation failed (non-fatal) for report=${params.reportId} (${Date.now() - startedAt}ms):`,
      truncatedErrorMessage(error),
    );
    try {
      await upsertTelemetryRow(client, {
        reportDeviceKey: params.reportDeviceKey,
        reportId: params.reportId,
        productionStatus: params.productionResult.status === "MATCHED" ? "MATCHED" : "NO_HISTORICAL_MATCH",
        productionRelationship: null,
        proposedStatus: params.productionResult.status === "MATCHED" ? "MATCHED" : "NO_HISTORICAL_MATCH",
        proposedRelationship: null,
        proposedEvidence: JSON.stringify({ error: true }),
        agreement: "AGREE",
        candidateCount: 0,
        submittedWordCount: 0,
        totalRuntimeMs: Date.now() - startedAt,
        status: "FAILED",
        errorMessage: truncatedErrorMessage(error),
      });
    } catch (insertError) {
      console.error(
        `device-provenance shadow evaluation: failed to persist FAILED row for report=${params.reportId}:`,
        truncatedErrorMessage(insertError),
      );
    }
  }
}
