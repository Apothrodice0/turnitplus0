import type { Client } from "@libsql/client";
import { tokens } from "./similarity-core";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256, findPriorSubmissionsForAccount } from "./document-identity";
import {
  findCandidateCorpusRepresentations,
  findRepresentationById,
  summarizeSubmissionOwnership,
  corpusShingleHashes,
  type CandidateCorpusRepresentation,
} from "./user-submission-corpus";
import { USER_SUBMISSION_MATCH_THRESHOLDS } from "./user-submission-matching";
import { computeDocumentCorrespondence } from "./document-correspondence";
import { computeRobustCorrespondence, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG } from "./e8m-robust-correspondence";
import { v2DistinctivenessFromCorrespondence } from "./e8n-pipeline-evaluator";
import { buildCorpusFrequencyIndex } from "./e8l-distinctiveness-v2";
import type { CorpusDocument } from "./e8l-calibration-corpus";
import {
  classifyHistoricalMatch,
  PROPOSED_ACCEPTANCE_THRESHOLDS,
  PROPOSED_ACCEPTANCE_POLICY_VERSION,
  PROPOSED_ROBUST_CORRESPONDENCE_VERSION,
  PROPOSED_DISTINCTIVENESS_MODEL_VERSION,
  type WholeDocumentSignal,
  type PassageLevelSignal,
  type HistoricalMatchClassification,
} from "./e8o-historical-match-policy";
import type { ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * Phase E8P: PRODUCTION SHADOW EVALUATION. For a real report view, this
 * module independently computes what the proposed E8O acceptance policy
 * (lib/e8o-historical-match-policy.ts's classifyHistoricalMatch, never
 * called from anywhere else in production — see tests/e8o-policy-spec.test.mjs
 * test H2's own e8p- exclusion) WOULD have decided, and records only
 * bounded telemetry comparing it to the REAL production result. It never
 * changes what a caller sees: it is always invoked after the real result
 * is already computed and already on its way to the response, via
 * lib/run-after-response.ts's runAfterResponse, exactly like
 * app/api/reports/route.ts's existing corpus-indexing callback. It never
 * writes to report_historical_match_snapshots or any scoring field.
 *
 * Every value persisted to historical_match_shadow_evaluations
 * (drizzle/0021_historical_match_shadow_evaluations.sql) is a bounded
 * count, enum, or timing — never document/passage text, never an account
 * id. See this file's own structural test (tests/e8p-shadow-evaluation.test.mjs)
 * for the enforcement of that at the source level.
 *
 * Reuses, never modifies, every production/experimental primitive it
 * touches: candidate generation and ownership rules from
 * lib/user-submission-corpus.ts and lib/user-submission-matching.ts (the
 * SAME USER_SUBMISSION_MATCH_THRESHOLDS production uses — never a second,
 * drifted copy of those numbers), V0 correspondence from
 * lib/document-correspondence.ts, E8M correspondence from
 * lib/e8m-robust-correspondence.ts, V2 distinctiveness from
 * lib/e8l-distinctiveness-v2.ts (via lib/e8n-pipeline-evaluator.ts's own
 * glue function), and the decision itself from
 * lib/e8o-historical-match-policy.ts.
 *
 * Two known, deliberate simplifications, not oversights:
 *
 *  1. Ownership replication (correctness-critical, not optional):
 *     lib/user-submission-matching.ts's own matcher drops a candidate —
 *     even one whose V0 correspondence would otherwise qualify — when the
 *     only "ownership" of it is the current submission's own just-indexed
 *     self-reference (accountId!==null && !hasSameAccountSubmission &&
 *     otherAccountSubmissionCount===0; see that file's line ~235). This
 *     module reproduces that exact rule per candidate. Skipping it would
 *     manufacture a false "shadow found a match production missed"
 *     disagreement that is really just this known, already-handled edge
 *     case, not real signal about the proposed policy.
 *
 *  2. freqIndex is built ONLY from the bounded candidate batch already
 *     fetched for this one comparison (<= maxCandidates documents, minus
 *     the candidate being scored), never a full-corpus scan.
 *     buildCorpusFrequencyIndex is pure per-document counting with no
 *     cross-document comparison, so this is cheap regardless of how large
 *     the real corpus grows — but it also means "rarity" here is relative
 *     to a handful of documents, not the whole historical corpus. This is
 *     exactly the "corpus-scarce-but-generic text" limitation
 *     lib/e8o-historical-match-policy.ts's own FALSE_POSITIVE_GUARDRAIL_NOTES
 *     already flags as UNRESOLVED — not solved here, only measured:
 *     freq_index_document_count is recorded on every row precisely so a
 *     reviewer can discount low-count partial matches rather than trusting
 *     them blindly.
 *
 * Not replicated: production's defensive exact-canonical-hash candidate
 * addition (lib/user-submission-matching.ts's own fallback for a document
 * too short to produce >= candidateShingleThreshold shingles). That
 * fallback only ever changes the outcome for documents far shorter than
 * PROPOSED_ACCEPTANCE_THRESHOLDS.minimumDocumentWordCountForPartialMatch
 * (100 words), which this module's own short-document guardrail (inherited
 * unchanged from classifyHistoricalMatch) already excludes from the
 * partial-match path — so omitting it here costs no real measurement
 * coverage.
 *
 * Phase E8P.2 fix: a confirmed production race showed a `NO_HISTORICAL_MATCH`
 * + zero-candidate row can go permanently stale — it was cached the moment
 * this report was first viewed, before some OTHER account's matching
 * document had been indexed into the corpus yet, and this module's original
 * "any row exists -> skip" idempotency check then reused that empty result
 * forever, even after the corpus grew to contain a real candidate. This is
 * the same class of problem lib/report-historical-match.ts's own E8E fix
 * already solved for the real production snapshot (see that file's header
 * comment) — but the fix here is deliberately NARROWER: only a
 * `NO_HISTORICAL_MATCH` row whose `candidate_count` is exactly 0 is treated
 * as stale and recomputed (see shouldReuseExistingShadowRow below). A row
 * where a candidate WAS found and evaluated (candidate_count > 0) but still
 * resolved to `NO_HISTORICAL_MATCH` is NOT recomputed just because the
 * corpus grew further — that candidate's own evaluation is not invalidated
 * by some unrelated OTHER representation appearing later. `MATCHED` and
 * `FAILED` rows are unaffected by this fix, matching their existing
 * (already-final) caching semantics exactly as before.
 *
 * No schema change was needed: candidate_count, production_status, and
 * status already existed on this table, and computed_at already had UPDATE
 * semantics available — see the upsertTelemetryRow's ON CONFLICT clause
 * below, the same upsert pattern lib/report-historical-match.ts already
 * uses for report_historical_match_snapshots.
 */

const SHADOW_POLICY_VERSION = PROPOSED_ACCEPTANCE_POLICY_VERSION;

type Agreement = "AGREE" | "DISAGREE_NEW_PARTIAL" | "DISAGREE_NEW_FULL" | "DISAGREE_OTHER";

type TelemetryRow = {
  reportDeviceKey: string;
  reportId: string;
  productionStatus: "NO_HISTORICAL_MATCH" | "MATCHED";
  productionRelationship: string | null;
  proposedStatus: HistoricalMatchClassification["status"];
  proposedRelationship: string | null;
  proposedEvidence: string | null;
  agreement: Agreement;
  candidateCount: number;
  passageLevelEvaluatedCount: number;
  freqIndexDocumentCount: number;
  submittedWordCount: number;
  e8mRuntimeMs: number | null;
  v2RuntimeMs: number | null;
  totalRuntimeMs: number;
  status: "OK" | "FAILED";
  errorMessage: string | null;
};

function truncatedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

type ExistingShadowRow = { production_status: string; candidate_count: number; status: string };

async function existingShadowRow(client: Client, reportDeviceKey: string, reportId: string): Promise<ExistingShadowRow | null> {
  const result = await client.execute({
    sql: `SELECT production_status, candidate_count, status FROM historical_match_shadow_evaluations
          WHERE report_device_key = ? AND report_id = ? AND policy_version = ?`,
    args: [reportDeviceKey, reportId, SHADOW_POLICY_VERSION],
  });
  const row = result.rows[0] as unknown as ExistingShadowRow | undefined;
  return row ?? null;
}

/**
 * The exact, narrow reuse/recompute rule (Phase E8P.2 — see this file's own
 * header comment for the production race that motivated it). Deliberately
 * NOT elapsed-time-based, NOT a periodic recompute, and NOT keyed on
 * anything but the row's own already-recorded, already-bounded fields:
 *   - FAILED stays cached forever, unchanged from before this fix (same
 *     "do not hammer a permanently-failing computation on every view"
 *     reasoning lib/report-historical-match.ts already applies to its own
 *     FAILED snapshots).
 *   - MATCHED stays cached forever — steps 1-2 of classifyHistoricalMatch
 *     are defined to reproduce production's own threshold exactly, so
 *     nothing about a growing corpus can change that outcome.
 *   - NO_HISTORICAL_MATCH with candidate_count > 0 stays cached — a real
 *     candidate was found and genuinely evaluated; a different, unrelated
 *     representation appearing later in the corpus does not invalidate that
 *     evaluation.
 *   - NO_HISTORICAL_MATCH with candidate_count === 0 is the ONLY case
 *     treated as stale: zero candidates were found because none existed in
 *     the corpus AT THAT MOMENT, and that is exactly the condition new
 *     corpus content can change.
 */
function shouldReuseExistingShadowRow(row: ExistingShadowRow): boolean {
  if (row.status === "FAILED") return true;
  if (row.production_status === "MATCHED") return true;
  if (Number(row.candidate_count) > 0) return true;
  return false;
}

async function upsertTelemetryRow(client: Client, row: TelemetryRow): Promise<void> {
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
          (report_device_key, report_id, production_status, production_relationship, proposed_status,
           proposed_relationship, proposed_evidence, agreement, candidate_count, passage_level_evaluated_count,
           freq_index_document_count, submitted_word_count, e8m_runtime_ms, v2_runtime_ms, total_runtime_ms,
           policy_version, correspondence_version, distinctiveness_version, status, error_message, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
          ON CONFLICT(report_device_key, report_id, policy_version) DO UPDATE SET
            production_status = excluded.production_status,
            production_relationship = excluded.production_relationship,
            proposed_status = excluded.proposed_status,
            proposed_relationship = excluded.proposed_relationship,
            proposed_evidence = excluded.proposed_evidence,
            agreement = excluded.agreement,
            candidate_count = excluded.candidate_count,
            passage_level_evaluated_count = excluded.passage_level_evaluated_count,
            freq_index_document_count = excluded.freq_index_document_count,
            submitted_word_count = excluded.submitted_word_count,
            e8m_runtime_ms = excluded.e8m_runtime_ms,
            v2_runtime_ms = excluded.v2_runtime_ms,
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
      row.passageLevelEvaluatedCount,
      row.freqIndexDocumentCount,
      row.submittedWordCount,
      row.e8mRuntimeMs,
      row.v2RuntimeMs,
      row.totalRuntimeMs,
      SHADOW_POLICY_VERSION,
      PROPOSED_ROBUST_CORRESPONDENCE_VERSION,
      PROPOSED_DISTINCTIVENESS_MODEL_VERSION,
      row.status,
      row.errorMessage,
    ],
  });
}

/** Production's own matchType values, renamed exactly as lib/e8o-historical-match-policy.ts's own EvidenceKind comment documents — no new mapping invented here. */
function evidenceForProductionMatchType(matchType: "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH"): string {
  return matchType === "EXACT_CANONICAL_MATCH" ? "EXACT_CANONICAL_MATCH" : "STRONG_WHOLE_DOCUMENT_CORRESPONDENCE";
}

const STATUS_RANK: Record<HistoricalMatchClassification["status"], number> = {
  HISTORICAL_FULL_MATCH: 2,
  HISTORICAL_PARTIAL_MATCH: 1,
  NO_HISTORICAL_MATCH: 0,
};

export async function runHistoricalMatchShadowEvaluation(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    accountId: string | null;
    rawText: string;
    productionResult: ReportHistoricalSubmissionMatch;
  },
): Promise<void> {
  const startedAt = Date.now();

  if (params.productionResult.status === "UNAVAILABLE") return; // nothing to compare against yet

  try {
    const existing = await existingShadowRow(client, params.reportDeviceKey, params.reportId);
    if (existing && shouldReuseExistingShadowRow(existing)) return;

    if (params.productionResult.status === "MATCHED") {
      // Steps 1-2 of classifyHistoricalMatch are DEFINED to reproduce
      // production's own V0 threshold exactly (same USER_SUBMISSION_MATCH_THRESHOLDS
      // either way) — recomputing E8M/V2 here would be pure overhead for an
      // outcome the decision tree itself guarantees. matches[0] is
      // production's own priority-sorted primary match (see
      // lib/user-submission-matching.ts's compareMatches).
      const primary = params.productionResult.matches?.[0];
      await upsertTelemetryRow(client, {
        reportDeviceKey: params.reportDeviceKey,
        reportId: params.reportId,
        productionStatus: "MATCHED",
        productionRelationship: primary?.relationshipType ?? null,
        proposedStatus: "HISTORICAL_FULL_MATCH",
        proposedRelationship: primary?.relationshipType ?? null,
        proposedEvidence: primary ? evidenceForProductionMatchType(primary.matchType) : null,
        agreement: "AGREE",
        candidateCount: params.productionResult.matches?.length ?? 0,
        passageLevelEvaluatedCount: 0,
        freqIndexDocumentCount: 0,
        submittedWordCount: 0,
        e8mRuntimeMs: null,
        v2RuntimeMs: null,
        totalRuntimeMs: Date.now() - startedAt,
        status: "OK",
        errorMessage: null,
      });
      return;
    }

    // productionResult.status === "NO_HISTORICAL_MATCH": the interesting
    // case — production found nothing, so it is worth checking whether the
    // proposed policy would have found a partial-copy opportunity it can't
    // see today.
    const canonicalText = canonicalizeText(params.rawText);
    const submittedWordCount = tokens(canonicalText).length;
    const correspondenceThresholds = USER_SUBMISSION_MATCH_THRESHOLDS.correspondence;

    const queryShingles = corpusShingleHashes(canonicalText, correspondenceThresholds.shingleSize);
    const rawCandidates: CandidateCorpusRepresentation[] = queryShingles.size === 0
      ? []
      : await findCandidateCorpusRepresentations(client, queryShingles, {
          fingerprintVersion: USER_SUBMISSION_MATCH_THRESHOLDS.fingerprintVersion,
          minSharedShingles: USER_SUBMISSION_MATCH_THRESHOLDS.candidateShingleThreshold,
          limit: USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidates,
        });

    // Mirrors lib/report-historical-match.ts's own approach to picking which
    // of the account's own identity rows to exclude from ownership counting.
    let documentIdentityId: string | null = null;
    if (params.accountId) {
      const ownIdentities = await findPriorSubmissionsForAccount(client, params.accountId, canonicalSha256(params.rawText));
      documentIdentityId = ownIdentities.length > 0 ? ownIdentities[ownIdentities.length - 1].id : null;
    }

    // Load representation text + apply production's exact self-reference
    // ownership drop (see this file's header comment) up front, so the
    // candidate batch used to build each freqIndex below is already the
    // same set production would have considered.
    const survivors: { representationId: string; canonicalText: string; relationship: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP" }[] = [];
    for (const candidate of rawCandidates) {
      const representation = await findRepresentationById(client, candidate.representationId);
      if (!representation) continue;
      const ownership = await summarizeSubmissionOwnership(client, candidate.representationId, {
        accountId: params.accountId,
        excludeDocumentIdentityId: documentIdentityId,
      });
      if (params.accountId !== null && !ownership.hasSameAccountSubmission && ownership.otherAccountSubmissionCount === 0) continue;
      const relationship = params.accountId === null ? "UNKNOWN_RELATIONSHIP" : ownership.hasSameAccountSubmission ? "SELF" : "PRIOR_SUBMISSION";
      survivors.push({ representationId: candidate.representationId, canonicalText: representation.canonicalText, relationship });
    }

    let best: HistoricalMatchClassification | null = null;
    let anomaly = false; // a surviving candidate qualified under V0 despite production reporting NO_HISTORICAL_MATCH moments earlier — see DISAGREE_NEW_FULL below
    let passageLevelEvaluatedCount = 0;
    let freqIndexDocumentCount = 0;
    let e8mRuntimeMs = 0;
    let v2RuntimeMs = 0;

    for (const survivor of survivors) {
      const wholeDocument: WholeDocumentSignal = (() => {
        const c = computeDocumentCorrespondence(canonicalText, survivor.canonicalText, correspondenceThresholds);
        return {
          exactCanonicalMatch: c.exactCanonicalMatch,
          meetsProductionThreshold: c.strongCorrespondence,
          containment: c.containment,
          matchedWordCount: c.matchedWordCount,
          longestMatchWords: c.longestMatchWords,
        };
      })();

      if (wholeDocument.exactCanonicalMatch || wholeDocument.meetsProductionThreshold) {
        anomaly = true;
        continue; // do not spend an E8M/V2 pass confirming an already-anomalous candidate
      }

      let passageLevel: PassageLevelSignal | null = null;
      if (submittedWordCount >= PROPOSED_ACCEPTANCE_THRESHOLDS.minimumDocumentWordCountForPartialMatch.value) {
        const otherDocs: CorpusDocument[] = survivors
          .filter((s) => s.representationId !== survivor.representationId)
          .map((s) => ({ id: s.representationId, label: "LIVE_CORPUS", canonicalText: s.canonicalText }));
        freqIndexDocumentCount = otherDocs.length;
        const freqIndex = buildCorpusFrequencyIndex(otherDocs);

        const e8mStart = Date.now();
        const e8m = computeRobustCorrespondence(canonicalText, survivor.canonicalText, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG);
        e8mRuntimeMs += Date.now() - e8mStart;

        const v2Start = Date.now();
        const { distinctiveness } = v2DistinctivenessFromCorrespondence(canonicalText, survivor.canonicalText, e8m, freqIndex);
        v2RuntimeMs += Date.now() - v2Start;

        passageLevel = {
          matchedWordCount: e8m.matchedWordCount,
          longestMatchWords: e8m.longestMatchWords,
          longestSinglePassageWords: e8m.passages.reduce((max, p) => Math.max(max, p.matchedWordCount), 0),
          passageCount: e8m.passageCount,
          passageDensity: e8m.passageDensity,
          distinctivenessV2: distinctiveness,
        };
        passageLevelEvaluatedCount += 1;
      }

      const classification = classifyHistoricalMatch({
        wholeDocument,
        passageLevel,
        relationship: survivor.relationship,
        submittedWordCount,
        thresholds: PROPOSED_ACCEPTANCE_THRESHOLDS,
      });

      if (!best || STATUS_RANK[classification.status] > STATUS_RANK[best.status]) best = classification;
    }

    const proposedStatus = anomaly ? "HISTORICAL_FULL_MATCH" : best?.status ?? "NO_HISTORICAL_MATCH";
    const agreement: Agreement = anomaly
      ? "DISAGREE_NEW_FULL"
      : proposedStatus === "HISTORICAL_PARTIAL_MATCH"
        ? "DISAGREE_NEW_PARTIAL"
        : proposedStatus === "NO_HISTORICAL_MATCH"
          ? "AGREE"
          : "DISAGREE_OTHER";

    await upsertTelemetryRow(client, {
      reportDeviceKey: params.reportDeviceKey,
      reportId: params.reportId,
      productionStatus: "NO_HISTORICAL_MATCH",
      productionRelationship: null,
      proposedStatus,
      proposedRelationship: anomaly ? null : best?.relationship ?? null,
      proposedEvidence: anomaly ? null : best?.evidence ?? null,
      agreement,
      candidateCount: survivors.length,
      passageLevelEvaluatedCount,
      freqIndexDocumentCount,
      submittedWordCount,
      e8mRuntimeMs: passageLevelEvaluatedCount > 0 ? e8mRuntimeMs : null,
      v2RuntimeMs: passageLevelEvaluatedCount > 0 ? v2RuntimeMs : null,
      totalRuntimeMs: Date.now() - startedAt,
      status: "OK",
      errorMessage: null,
    });
  } catch (error) {
    console.error(`historical match shadow evaluation failed (non-fatal) for report=${params.reportId} (${Date.now() - startedAt}ms):`, truncatedErrorMessage(error));
    try {
      await upsertTelemetryRow(client, {
        reportDeviceKey: params.reportDeviceKey,
        reportId: params.reportId,
        productionStatus: params.productionResult.status === "MATCHED" ? "MATCHED" : "NO_HISTORICAL_MATCH",
        productionRelationship: null,
        proposedStatus: "NO_HISTORICAL_MATCH",
        proposedRelationship: null,
        proposedEvidence: null,
        agreement: "DISAGREE_OTHER",
        candidateCount: 0,
        passageLevelEvaluatedCount: 0,
        freqIndexDocumentCount: 0,
        submittedWordCount: 0,
        e8mRuntimeMs: null,
        v2RuntimeMs: null,
        totalRuntimeMs: Date.now() - startedAt,
        status: "FAILED",
        errorMessage: truncatedErrorMessage(error),
      });
    } catch (insertError) {
      console.error(`historical match shadow evaluation: failed to persist FAILED row for report=${params.reportId}:`, truncatedErrorMessage(insertError));
    }
  }
}
