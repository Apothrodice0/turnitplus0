import type { Client } from "@libsql/client";
import {
  resolvePrimarySimilaritySummary,
  persistSelectiveCorpusAuthoritativeFinalization,
  persistSelectiveCorpusAuthoritativeUnstorable,
  previewSelectiveCorpusAuthoritativeFinalization,
  type SelectiveCorpusAuthoritativeFinalizationWrite,
  type SelectiveCorpusAuthoritativeTerminalStatus,
} from "./report-primary-similarity";
import { resolveVerifiedAcademicEvidence } from "./academic-search-diagnostics-repo";
import { buildFinalizedReportEvidenceInterpretation, priorSubmissionBranchState } from "./report-evidence-interpretation";
import { readPersistedArchiveMatchedPositions, storedRowExceedsServingBound } from "./report-persistence";
import { MAX_REPORT_SAVE_REQUEST_BYTES, persistedPayloadSize } from "./report-transport-limits";
import { buildSizeUnavailableAiAnalysis, isSizeUnavailableAiAnalysis } from "./ai-unavailable-state";
import { logAiSizeUnavailableTelemetry } from "./ai-size-unavailable-telemetry";
import { canonicalSha256 } from "./document-identity";
import { reportScoringNormalizationVersion, type ScoringNormalizationVersion } from "./similarity-core";
import type { SimilarityReport } from "./report-types";
import type { SelectiveCorpusShadowResult } from "./selective-corpus/types";
import type { SelectiveCorpusIncompleteReason } from "./evidence-interpretation/completion";

/**
 * Selective Corpus V4 AUTHORITATIVE PROMOTION — the canonical, single
 * implementation of the "pending -> terminal" lifecycle transition. Both the
 * deferred POST-triggered finalizer (lib/report-shadow-evaluations.ts) and
 * the recovery sweep (app/api/internal/selective-corpus-authoritative-sweep/
 * route.ts) call the SAME finalizeSelectiveCorpusAuthoritativeReport below —
 * there is no second implementation, and neither caller re-runs
 * resolvePrimarySimilaritySummary/computeUnifiedSimilarity itself; both
 * simply hand an already-computed SelectiveCorpusShadowResult to this module.
 *
 * NEVER runs Selective Corpus itself — that stays entirely the callers'
 * responsibility (via runSelectiveCorpusShadowEvaluation with
 * requiredForAuthoritativePendingReport:true). This module only decides WHAT
 * evidence a terminal shadow state is allowed to contribute, and PERSISTS the
 * one final result through the existing canonical scoring path
 * (resolvePrimarySimilaritySummary -> computeUnifiedSimilarity), CAS-guarded
 * so the pending -> {completed|incomplete} transition can only ever happen
 * once, no matter how many duplicate finalization attempts race each other.
 */

export type SelectiveCorpusFinalizationEvidenceSelection = {
  /** null (never []) when the terminal state carries zero evidence at all — mirrors resolvePrimarySimilaritySummary's own selectiveCorpusEvidence contract (absent/empty is byte-identical to "no V4 channel"). */
  evidence:
    | ReadonlyArray<{
        sourceId: string;
        matchedPassages: ReadonlyArray<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
      }>
    | null;
  terminalStatus: SelectiveCorpusAuthoritativeTerminalStatus;
  /** Why terminalStatus is "incomplete" (null for "completed") — persisted with it, surfaced only as a completion diagnostic. */
  incompleteReason: SelectiveCorpusIncompleteReason | null;
};

/**
 * Pure state -> evidence/status policy mapping — no I/O, directly testable.
 *
 *   COMPLETED: real verifiedEvidence (already-verified, already-co-source-
 *     attributed passages) merges in; marker -> "completed".
 *   PARTIAL: shadow.ts's own PARTIAL construction is `{...completed, state:
 *     "PARTIAL", degradedShard*}` — the SAME verification pipeline as
 *     COMPLETED, over an index that had one or more packed shards
 *     unavailable at query time. Its verifiedEvidence is therefore genuine,
 *     already-verified evidence too — a lower bound, never fabricated — so it
 *     merges in exactly like COMPLETED's; marker -> "incomplete" (the search
 *     itself was over an incomplete index, disclosed rather than hidden).
 *   TIMEOUT / ARTIFACT_UNAVAILABLE / FAILED / DISABLED: these states never
 *     carry a verifiedEvidence field at all (confirmed by shadow.ts's own
 *     construction — TIMEOUT/ARTIFACT_UNAVAILABLE/FAILED return bare
 *     failure-code objects with no evidence fields whatsoever), so zero
 *     contribution here is simply what the result object contains, not a
 *     choice this function makes; marker -> "incomplete". (A TIMEOUT only
 *     reaches this mapping once its retries are exhausted — see
 *     finalizeSelectiveCorpusAuthoritativeReport.)
 */
export function selectSelectiveCorpusFinalizationEvidence(
  shadowResult: SelectiveCorpusShadowResult,
): SelectiveCorpusFinalizationEvidenceSelection {
  const toEvidence = (
    verifiedEvidence: SelectiveCorpusShadowResult["verifiedEvidence"],
  ): SelectiveCorpusFinalizationEvidenceSelection["evidence"] => {
    if (!verifiedEvidence || verifiedEvidence.length === 0) return null;
    return verifiedEvidence.map((source) => ({ sourceId: source.sourceLabel, matchedPassages: source.matchedPassages }));
  };

  if (shadowResult.state === "COMPLETED") {
    return { evidence: toEvidence(shadowResult.verifiedEvidence), terminalStatus: "completed", incompleteReason: null };
  }
  if (shadowResult.state === "PARTIAL") {
    return { evidence: toEvidence(shadowResult.verifiedEvidence), terminalStatus: "incomplete", incompleteReason: "PARTIAL_INDEX" };
  }
  // TIMEOUT, ARTIFACT_UNAVAILABLE, FAILED, DISABLED (defensive — the two
  // callers of this module always pass requiredForAuthoritativePendingReport,
  // so a genuine DISABLED should never actually reach here in practice).
  return { evidence: null, terminalStatus: "incomplete", incompleteReason: shadowResult.state };
}

export type FinalizeSelectiveCorpusAuthoritativeReportParams = {
  reportDeviceKey: string;
  reportId: string;
  accountId: string | null;
  /** Already-computed by the caller — this module never runs Stage A/B itself. */
  shadowResult: SelectiveCorpusShadowResult;
  /**
   * The scoring-normalization contract `shadowResult`'s verifiedEvidence word
   * positions were computed under (the scope the caller ran
   * runSelectiveCorpusShadowEvaluation in). They are unioned with the
   * report's own positions, so they are used ONLY when this equals the
   * report's persisted contract; otherwise this attempt writes nothing and
   * the report stays pending for a run under the right contract. Omitted is
   * v1.
   */
  shadowScoringNormalizationVersion?: ScoringNormalizationVersion;
};

export type FinalizeSelectiveCorpusAuthoritativeReportResult =
  | { outcome: "finalized"; status: SelectiveCorpusAuthoritativeTerminalStatus }
  | { outcome: "already-finalized" }
  | { outcome: "not-pending" }
  | { outcome: "row-missing" }
  | { outcome: "gave-up" }
  /**
   * shadowResult was computed under another scoring-normalization contract
   * than the report's own. NOTHING was written; the report stays pending.
   */
  | { outcome: "scoring-normalization-mismatch" }
  /**
   * C2 fail-closed: the ENCODED (compact) whole final report — score plus its
   * explanation — exceeds the report persistence limit, so NO score is written:
   * a customer-visible score is never persisted without the interpretation that
   * explains it. Deliberately NOT retried with less evidence (the zero-V4
   * fallback below is for unexpected exceptions only): shrinking the score to
   * make it fit would be a scoring-semantics decision this module does not make.
   * The overflow is deterministic, so instead of staying "pending" for the
   * recovery sweep to re-run forever, the report is finalized "incomplete"
   * (reason PERSISTENCE_LIMIT) with no score — "Similarity unavailable" — by
   * persistSelectiveCorpusAuthoritativeUnstorable.
   */
  | { outcome: "persistence-limit-exceeded"; status: "incomplete" }
  /**
   * The attempt ended TIMEOUT with retries left: NO final score was written.
   * The report stays "pending" with its timed-out attempt recorded and its
   * claim released, so the recovery sweep runs it again.
   */
  | { outcome: "timeout-retry-scheduled"; timedOutAttempts: number }
  /**
   * Another finalizer advanced this report first (a terminal write, or a newer
   * timed-out attempt record) between this attempt's read and its write — or,
   * for the PERSISTENCE_LIMIT terminal write, any other write changed the row.
   * Nothing written; a clean no-op, like "already-finalized" (a row that is
   * still pending stays eligible for the recovery sweep).
   */
  | { outcome: "stale-attempt" };

/**
 * Bounded TIMEOUT retry. A Selective Corpus TIMEOUT is a transient work-limit
 * result (the same report can complete moments later on a warmer instance), so
 * it does not finalize the report: the report stays "pending" and the recovery
 * sweep runs it again. Only when this many authoritative attempts have ALL
 * timed out does the report finalize "incomplete" with reason TIMEOUT.
 *
 * Same convention as lib/corpus-admission-promotion.ts's MAX_PROMOTION_ATTEMPTS
 * (5): counts completed attempts, including the initial automatic one (here,
 * the first save's deferred run), so up to 4 sweep retries; the counter moves
 * only on a completed timed-out attempt — never on a claim — so a worker that
 * dies mid-attempt costs no attempt (its claim goes stale and is reclaimed); no
 * backoff column, the sweep cadence is the backoff (a released claim is picked
 * up by the next 5-minute run once the report is older than the sweep's 10-minute
 * minimum age). Every other state keeps its existing semantics.
 */
export const MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS = 5;

/**
 * The persisted timed-out attempt count: a non-negative integer, 0 when
 * absent, or null when the stored value is not a valid count (never written by
 * this module — treated as exhausted, so a corrupt counter can never keep a
 * report retrying without bound).
 */
function persistedTimedOutAttempts(payload: SimilarityReport): number | null {
  const value = (payload as { selectiveCorpusAuthoritativeTimedOutAttempts?: unknown }).selectiveCorpusAuthoritativeTimedOutAttempts;
  if (value === undefined || value === null) return 0;
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * Records one more timed-out attempt on a still-pending report and releases its
 * sweep claim, in ONE CAS write: it lands only if the report is still pending
 * AND still carries the count this attempt read, so two racing finalizers can
 * never both record the same attempt, and a report another finalizer already
 * made terminal is never touched. Returns whether it was written.
 */
async function recordSelectiveCorpusTimedOutAttempt(
  client: Client,
  params: FinalizeSelectiveCorpusAuthoritativeReportParams,
  priorAttempts: number,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE saved_reports
          SET payload_json = json_set(
                json_remove(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt'),
                '$.selectiveCorpusAuthoritativeTimedOutAttempts', ?
              )
          WHERE device_key = ? AND id = ? AND json_valid(payload_json)
            AND json_extract(payload_json, '$.selectiveCorpusAuthoritativeStatus') = 'pending'
            AND COALESCE(json_extract(payload_json, '$.selectiveCorpusAuthoritativeTimedOutAttempts'), 0) = ?`,
    args: [priorAttempts + 1, params.reportDeviceKey, params.reportId, priorAttempts],
  });
  return Number(result.rowsAffected) > 0;
}

type ReadReportRowResult = { payload: SimilarityReport; payloadJson: string; archiveScoreColumn: number | bigint };

async function readReportRow(client: Client, reportDeviceKey: string, reportId: string): Promise<ReadReportRowResult | null> {
  const row = await client.execute({
    sql: "SELECT payload_json, archive_score FROM saved_reports WHERE device_key = ? AND id = ?",
    args: [reportDeviceKey, reportId],
  });
  const raw = row.rows[0] as unknown as { payload_json: string; archive_score: number | bigint } | undefined;
  if (!raw) return null;
  const payloadJson = String(raw.payload_json);
  const payload = JSON.parse(payloadJson) as SimilarityReport;
  return { payload, payloadJson, archiveScoreColumn: raw.archive_score };
}

function safeCanonicalSha256Text(text: string): string {
  try {
    return canonicalSha256(text ?? "");
  } catch {
    return canonicalSha256("");
  }
}

/**
 * One resolve-then-persist attempt. Reused for both the primary
 * (evidence-per-state-policy) attempt and the best-effort zero-V4 fallback
 * (see finalizeSelectiveCorpusAuthoritativeReport's own catch block) — never
 * a second scoring implementation, only a different evidenceSelection input.
 * Mirrors exactly the same set of inputs lib/report-primary-similarity.ts's
 * own selfHealUnifiedSimilarity already threads (wordCount,
 * archiveMatchedPositions, server-re-verified externalAcademicEvidence,
 * archiveScore) — deliberately does not widen that scope (e.g. it does not
 * re-resolve userSuppliedReferenceEvidence, exactly like selfHeal does not
 * either — a pre-existing, deliberate design boundary this module does not
 * change).
 */
async function resolveAndPersist(
  client: Client,
  params: FinalizeSelectiveCorpusAuthoritativeReportParams,
  row: ReadReportRowResult,
  evidenceSelection: SelectiveCorpusFinalizationEvidenceSelection,
): Promise<FinalizeSelectiveCorpusAuthoritativeReportResult> {
  const { archiveScoreColumn } = row;
  // `row.payload` is the stored row as parsed, so its archive positions may be in
  // the compact persisted form (lib/position-runs-persistence.ts). Everything
  // below scores and explains from the array they stand for; a row whose compact
  // list cannot be read exactly throws here, before anything is resolved or
  // written. An array (every earlier row) is used as it is, the same object.
  const archiveMatchedPositions = readPersistedArchiveMatchedPositions(row.payload);
  const payload: SimilarityReport =
    archiveMatchedPositions === row.payload.archiveMatchedPositions ? row.payload : { ...row.payload, archiveMatchedPositions };
  // The report's own persisted contract — this finalizer never re-stamps. It
  // resolves under it, and its write is guarded on the row still carrying it.
  const scoringNormalizationVersion = reportScoringNormalizationVersion(payload);

  // Scholarly evidence server trust boundary (drizzle/0052) — same
  // re-verification selfHealUnifiedSimilarity already performs: the
  // persisted payload.externalAcademicEvidence is NEVER trusted directly.
  const verifiedAcademicEvidence =
    typeof payload.text === "string" && payload.text.length > 0
      ? (
          await resolveVerifiedAcademicEvidence(client, {
            diagnosticsId:
              typeof payload.verifiedAcademicSearchDiagnosticsId === "number" && Number.isFinite(payload.verifiedAcademicSearchDiagnosticsId)
                ? payload.verifiedAcademicSearchDiagnosticsId
                : null,
            submissionCanonicalSha256: safeCanonicalSha256Text(payload.text),
            scoringNormalizationVersion,
          })
        ).evidence
      : [];

  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: params.reportDeviceKey,
    reportId: params.reportId,
    accountId: params.accountId,
    rawText: payload.text,
    wordCount: payload.wordCount,
    archiveMatchedPositions: payload.archiveMatchedPositions,
    scoringNormalizationVersion,
    externalAcademicEvidence: verifiedAcademicEvidence,
    selectiveCorpusEvidence: evidenceSelection.evidence,
    archiveScore: payload.archiveScore ?? payload.score ?? Number(archiveScoreColumn),
  });

  if (!resolution.unifiedSimilarity) {
    // A genuine, reproducible computeUnifiedSimilarity failure for this
    // report's own data (documented as never happening in practice) — no
    // safe result to persist from this attempt.
    return { outcome: "gave-up" };
  }

  // The FINAL unifiedSimilarity is now known — derive the customer-visible
  // evidenceInterpretation from IT (through the shared write-time builder), so
  // the score and its explanation can never disagree. A report created in this
  // mode was persisted while "pending" with NO unifiedSimilarity, so the
  // interpretation POST built for it came from archive-only positions and can
  // explain none of the channels that only exist in this final score (imported
  // evidence, Selective Corpus). Built over exactly the inputs that fed the
  // score — the server-verified academic evidence re-resolved above, this
  // resolution's historical match — never the persisted, possibly-stale ones.
  // No user-supplied-reference evidence is passed, mirroring the score
  // resolution above (which deliberately gets none): the explanation never
  // describes evidence the final score does not contain.
  //
  // C2 FAIL CLOSED: the score and its explanation are persisted together or not
  // at all. There is no "land the score, remove the interpretation" outcome.
  //   - BUILD_FAILED: an unexpected exception — thrown, so the existing
  //     exception handling (best-effort zero-V4 fallback, else leave pending for
  //     the recovery sweep) applies exactly as it does for any other failure.
  //   - PERSISTED_SIZE_EXCEEDED: even the compact whole report does not fit the
  //     persistence limit. No score is written; the report is finalized
  //     "incomplete" (PERSISTENCE_LIMIT), similarity unavailable (see the
  //     outcome's own doc comment).
  //
  // SIMILARITY TAKES PRIORITY OVER AI (release decision, 2026-10-05). An AI
  // result can already be stored beside this pending report (its AI save landed
  // first — e.g. while a timed-out Selective Corpus attempt waited for the
  // recovery sweep). Whether the final similarity fits is decided WITHOUT that
  // result, with the AI half as the "AI unavailable for this document" state
  // would leave it — the same decision as when no AI result has arrived yet —
  // so an AI result can never cost a report its similarity: only a similarity
  // that cannot fit on its own ends PERSISTENCE_LIMIT. Whether the AI result
  // then stays is decided below on the exact row this write leaves, by the
  // AI-result route's own rule, so the outcome does not depend on which
  // arrived first.
  const storedAiResult = holdsAiResult(row.payload);
  const prepared = buildFinalizedReportEvidenceInterpretation(
    {
      ...payload,
      ...(storedAiResult ? { aiAnalysis: buildSizeUnavailableAiAnalysis(), aiScore: null } : {}),
      externalAcademicEvidence: verifiedAcademicEvidence,
      unifiedSimilarity: resolution.unifiedSimilarity,
    },
    {
      historicalSubmissionMatch: resolution.historicalSubmissionMatch,
      // The write below never rewrites the row's archive positions, so the size
      // is measured with them exactly as stored, not as expanded above.
      storedArchiveMatchedPositions: (row.payload as { archiveMatchedPositions?: unknown }).archiveMatchedPositions,
    },
  );
  if (!prepared.ok) {
    if (prepared.reason === "PERSISTED_SIZE_EXCEEDED") {
      console.error(
        "selective-corpus authoritative finalization: the final report cannot be persisted WITH its explanation within the persistence limit; finalizing it incomplete (PERSISTENCE_LIMIT) with no score:",
        { reportId: params.reportId, persistedBytes: prepared.persistedBytes, maxBytes: prepared.maxBytes },
      );
      const terminal = await persistSelectiveCorpusAuthoritativeUnstorable(
        client,
        { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId },
        { payloadJson: row.payloadJson },
      );
      // Not written: the row changed since it was read (or, at the ceiling with no
      // explanation to leave out, the terminal fields themselves do not fit).
      // Nothing is lost — a still-pending row is taken again by the sweep.
      return terminal.written ? { outcome: "persistence-limit-exceeded", status: "incomplete" } : { outcome: "stale-attempt" };
    }
    throw new Error("selective-corpus authoritative finalization could not build the final report's evidenceInterpretation");
  }

  const ids = { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId };
  const finalization: SelectiveCorpusAuthoritativeFinalizationWrite = {
    unifiedSimilarity: resolution.unifiedSimilarity,
    corpusSourceMatchingEnabled: resolution.corpusSourceMatchingEnabled,
    corpusGeneration: resolution.corpusGeneration,
    terminalStatus: evidenceSelection.terminalStatus,
    incompleteReason: evidenceSelection.incompleteReason,
    // The previous-submission check THIS final score was resolved with: the
    // pending save had none, so it is recorded with the terminal status.
    priorSubmission: priorSubmissionBranchState(resolution.historicalSubmissionMatch),
    evidenceInterpretation: prepared.evidenceInterpretation,
    // R2 write gate: persist in the exact mode the size check above measured.
    compactWrites: prepared.compactWrites,
    compactPositions: prepared.compactPositions,
    scoringNormalizationVersion,
  };

  if (storedAiResult) return persistBesideStoredAiResult(client, ids, row, finalization);

  const write = await persistSelectiveCorpusAuthoritativeFinalization(client, ids, finalization);
  if (!write.written) {
    // rowsAffected === 0: some other finalizer (a duplicate deferred run, or
    // a racing sweep claim) already won the pending -> terminal transition.
    // A clean no-op, never an error, never retried.
    return { outcome: "already-finalized" };
  }
  return { outcome: "finalized", status: evidenceSelection.terminalStatus };
}

/** A real AI result is stored beside the report (not the size-unavailable state, which is already as small as it gets). */
function holdsAiResult(payload: SimilarityReport): boolean {
  const aiAnalysis = (payload as { aiAnalysis?: unknown }).aiAnalysis;
  return aiAnalysis !== undefined && aiAnalysis !== null && !isSizeUnavailableAiAnalysis(aiAnalysis);
}

/**
 * SIMILARITY TAKES PRIORITY OVER AI — the write for a pending report that already
 * holds an AI result. The final similarity has been decided without it (see
 * resolveAndPersist). The AI half is decided on the EXACT row this finalization
 * would leave (previewSelectiveCorpusAuthoritativeFinalization), by the rule the
 * AI-result route applies when the AI result arrives after the finalization
 * (app/api/reports/[id]/ai-retry/route.ts): it stays when that row fits the
 * persistence ceiling and the compact-positions serving bound; otherwise it is
 * replaced, in the same statement, by the "AI unavailable for this document"
 * state the route writes. Finalizer-first and AI-first therefore end in the same
 * report.
 *
 * The write is a compare-and-swap on the exact stored text that was read and
 * measured: a row that changed meanwhile (a later AI save, another finalizer) is
 * left as it is — "already-finalized" when it is no longer pending, otherwise
 * "stale-attempt" (the recovery sweep takes it again).
 */
async function persistBesideStoredAiResult(
  client: Client,
  ids: { reportDeviceKey: string; reportId: string },
  row: ReadReportRowResult,
  finalization: SelectiveCorpusAuthoritativeFinalizationWrite,
): Promise<FinalizeSelectiveCorpusAuthoritativeReportResult> {
  const fitsBeside = (next: string | null) =>
    next !== null && persistedPayloadSize(next) <= MAX_REPORT_SAVE_REQUEST_BYTES && !storedRowExceedsServingBound(next, MAX_REPORT_SAVE_REQUEST_BYTES);
  const aiSizeUnavailable = !fitsBeside(await previewSelectiveCorpusAuthoritativeFinalization(client, ids, finalization));
  if (aiSizeUnavailable) {
    // The state that replaces it is held to the ceiling, as on the AI-result route. Measured on the row it leaves: if
    // even that does not fit, the similarity cannot be stored at all — the existing PERSISTENCE_LIMIT outcome.
    const settled = await previewSelectiveCorpusAuthoritativeFinalization(client, ids, { ...finalization, aiSizeUnavailable: true });
    if (settled === null || persistedPayloadSize(settled) > MAX_REPORT_SAVE_REQUEST_BYTES) {
      const terminal = await persistSelectiveCorpusAuthoritativeUnstorable(client, ids, { payloadJson: row.payloadJson });
      return terminal.written ? { outcome: "persistence-limit-exceeded", status: "incomplete" } : { outcome: "stale-attempt" };
    }
  }
  const write = await persistSelectiveCorpusAuthoritativeFinalization(client, ids, {
    ...finalization,
    aiSizeUnavailable,
    expectedPayloadJson: row.payloadJson,
  });
  if (!write.written) {
    const now = await readReportRow(client, ids.reportDeviceKey, ids.reportId);
    return now?.payload.selectiveCorpusAuthoritativeStatus === "pending" ? { outcome: "stale-attempt" } : { outcome: "already-finalized" };
  }
  if (aiSizeUnavailable) logAiSizeUnavailableTelemetry();
  return { outcome: "finalized", status: finalization.terminalStatus };
}

/**
 * Finalizes ONE authoritative-pending report using an already-computed
 * terminal SelectiveCorpusShadowResult. Never re-runs Stage A/B. Safe to call
 * more than once for the same report (from a duplicate deferred run, a
 * racing sweep claim, or a genuine retry) — the CAS in
 * persistSelectiveCorpusAuthoritativeFinalization makes every write after the
 * first a harmless no-op.
 *
 * Failure boundary: the primary attempt (real evidence per state policy) is
 * wrapped in a try/catch. On any unexpected exception (a DB hiccup, a bug —
 * NOT the ordinary "gave-up" outcome above, which is a clean return, not a
 * throw), this function attempts exactly ONE best-effort fallback: recompute
 * and persist a real, final result with ZERO Selective Corpus evidence
 * (terminalStatus "incomplete") — the report still leaves "pending" honestly,
 * just without V4's own contribution. If that fallback ALSO fails, this
 * function gives up silently (best-effort, matches this codebase's
 * pervasive "telemetry/finalization failures never propagate" discipline)
 * and the report is deliberately left "pending" — safe, because the recovery
 * sweep (app/api/internal/selective-corpus-authoritative-sweep) is the
 * durable backstop that will retry it later. This function itself never
 * throws.
 *
 * A TIMEOUT result is not terminal until MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS
 * attempts have timed out: before that the attempt is recorded, the claim is
 * released and the report stays "pending" ("timeout-retry-scheduled") for the
 * sweep to run again.
 */
export async function finalizeSelectiveCorpusAuthoritativeReport(
  client: Client,
  params: FinalizeSelectiveCorpusAuthoritativeReportParams,
): Promise<FinalizeSelectiveCorpusAuthoritativeReportResult> {
  try {
    const row = await readReportRow(client, params.reportDeviceKey, params.reportId);
    if (!row) return { outcome: "row-missing" };
    if (row.payload.selectiveCorpusAuthoritativeStatus !== "pending") {
      return { outcome: "not-pending" };
    }
    // Evidence computed under another contract than the report's must never be
    // unioned with the report's positions — and must not be traded for a
    // zero-evidence "incomplete" finalization either. Nothing is written: the
    // report stays pending and the recovery sweep reruns it under its contract.
    if ((params.shadowScoringNormalizationVersion === 2 ? 2 : 1) !== reportScoringNormalizationVersion(row.payload)) {
      return { outcome: "scoring-normalization-mismatch" };
    }
    // Bounded TIMEOUT retry (see MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS):
    // with attempts left, record this one and leave the report pending for the
    // sweep — no score, no completion signal, nothing terminal. The last
    // allowed timeout falls through to the ordinary terminal policy below
    // (incomplete, reason TIMEOUT).
    if (params.shadowResult.state === "TIMEOUT") {
      const priorAttempts = persistedTimedOutAttempts(row.payload);
      if (priorAttempts !== null && priorAttempts + 1 < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS) {
        try {
          return (await recordSelectiveCorpusTimedOutAttempt(client, params, priorAttempts))
            ? { outcome: "timeout-retry-scheduled", timedOutAttempts: priorAttempts + 1 }
            : { outcome: "stale-attempt" };
        } catch (recordErr) {
          // Not a reason to finalize: the report stays pending (claim, if any,
          // goes stale and is reclaimed) and this attempt is simply not counted.
          console.error(
            "finalizeSelectiveCorpusAuthoritativeReport: could not record a timed-out attempt — report remains pending for the recovery sweep:",
            recordErr instanceof Error ? recordErr.message : String(recordErr),
          );
          return { outcome: "gave-up" };
        }
      }
    }
    const evidenceSelection = selectSelectiveCorpusFinalizationEvidence(params.shadowResult);
    const result = await resolveAndPersist(client, params, row, evidenceSelection);
    if (result.outcome !== "gave-up") return result;
    throw new Error("selective-corpus authoritative finalization produced no unifiedSimilarity");
  } catch (err) {
    console.error(
      "finalizeSelectiveCorpusAuthoritativeReport: primary finalization attempt failed (best-effort zero-V4 fallback follows):",
      err instanceof Error ? err.message : String(err),
    );
    try {
      const row = await readReportRow(client, params.reportDeviceKey, params.reportId);
      if (!row) return { outcome: "row-missing" };
      if (row.payload.selectiveCorpusAuthoritativeStatus !== "pending") {
        return { outcome: "not-pending" };
      }
      const fallback = await resolveAndPersist(client, params, row, { evidence: null, terminalStatus: "incomplete", incompleteReason: "FINALIZER_ERROR" });
      return fallback;
    } catch (fallbackErr) {
      console.error(
        "finalizeSelectiveCorpusAuthoritativeReport: best-effort fallback ALSO failed — report remains pending, the recovery sweep will retry it later:",
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      );
      return { outcome: "gave-up" };
    }
  }
}

// ============================================================================
// Recovery sweep — atomic claim (durability backstop)
// ============================================================================

export type ClaimedSelectiveCorpusAuthoritativePendingReport = { reportDeviceKey: string; reportId: string };

export type ClaimStaleSelectiveCorpusAuthoritativePendingReportsParams = {
  openConnection: () => Client | Promise<Client>;
  batchSize?: number;
  /**
   * A pending report younger than this is presumed still genuinely in
   * flight and is never claimed as abandoned. Default 10 minutes — V4's own
   * measured Production Stage A+B totals are ~1.8-4.8s (20-document
   * promotion-gate canary), so this is a deliberately conservative floor
   * against normal serverless cold-start/latency variance, not a tight bound.
   */
  minAgeMs?: number;
  /**
   * A claim older than this is considered abandoned (the worker that made
   * it likely died mid-attempt) and becomes reclaimable by a later sweep run
   * — no permanent lease. Default 10 minutes, mirroring
   * lib/corpus-admission-report-integration.ts's own staleClaimMs
   * convention exactly.
   */
  staleClaimMs?: number;
};

const MAX_CLAIM_BUSY_RETRIES = 10;
function claimBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}
function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

/**
 * Atomically claims up to batchSize stale-pending reports inside ONE real
 * write transaction — directly modeled on
 * lib/corpus-admission-report-integration.ts's runReportAdmissionRetrySweep
 * (the already-shipped, already-proven pattern for exactly this class of
 * problem), adapted to payload_json JSON fields instead of a dedicated jobs
 * table (no migration, no new table). The select-then-claim happens entirely
 * while holding the write transaction's lock, so no other concurrent sweep
 * (in this process or a genuinely separate one) can select the same rows
 * before this transaction commits — the claim UPDATE below is therefore
 * unconditional on the exact ids the SELECT just found, exactly like the
 * reference implementation's own `WHERE id IN (...)`.
 *
 * Uses SQLite's own datetime('now', ...) for every threshold comparison
 * (never a JS-computed ISO string) — the reference implementation's own
 * comment documents a real, previously-fixed bug where an ISO string
 * lexicographically sorts before a same-day CURRENT_TIMESTAMP value
 * regardless of actual time; computing thresholds in the same format, in the
 * same database, sidesteps that whole class of mismatch.
 */
export async function claimStaleSelectiveCorpusAuthoritativePendingReports(
  params: ClaimStaleSelectiveCorpusAuthoritativePendingReportsParams,
): Promise<ClaimedSelectiveCorpusAuthoritativePendingReport[]> {
  const batchSize = params.batchSize ?? 20;
  const minAgeSeconds = Math.max(1, Math.floor((params.minAgeMs ?? 10 * 60 * 1000) / 1000));
  const staleClaimSeconds = Math.max(1, Math.floor((params.staleClaimMs ?? 10 * 60 * 1000) / 1000));
  // report_created_at is NOT a SQLite CURRENT_TIMESTAMP-style column — it is
  // always populated from the client's own `createdAt` field
  // (new Date().toISOString(), "YYYY-MM-DDTHH:MM:SS.sssZ", see
  // app/api/reports/route.ts's SAVE_REPORT_SQL), unlike
  // selectiveCorpusAuthoritativeClaimedAt below, which THIS module sets via
  // SQLite's own datetime('now') (space-separated). Comparing an ISO 'T'
  // string against a datetime('now', ...) threshold hits exactly the
  // lexicographic mismatch lib/corpus-admission-report-integration.ts's own
  // runReportAdmissionRetrySweep comment documents (' ' < 'T' in ASCII, so a
  // same-day ISO timestamp never sorts before a same-day space-separated
  // one) — it would silently make minAgeMs never trigger for any report
  // created earlier the same UTC day. Computed here as a JS ISO threshold
  // instead, so the comparison stays within one consistent format.
  const minAgeThresholdIso = new Date(Date.now() - minAgeSeconds * 1000).toISOString();

  for (let attempt = 1; attempt <= MAX_CLAIM_BUSY_RETRIES; attempt += 1) {
    const client = await params.openConnection();
    try {
      const tx = await client.transaction("write");
      try {
        const candidates = await tx.execute({
          sql: `SELECT device_key, id FROM saved_reports
                WHERE json_extract(payload_json, '$.selectiveCorpusAuthoritativeStatus') = 'pending'
                  AND report_created_at < ?
                  AND (
                    json_extract(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt') IS NULL
                    OR json_extract(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt') < datetime('now', ?)
                  )
                ORDER BY report_created_at ASC LIMIT ?`,
          args: [minAgeThresholdIso, `-${staleClaimSeconds} seconds`, batchSize],
        });
        const rows = candidates.rows as unknown as { device_key: string; id: string | number }[];
        const claimed: ClaimedSelectiveCorpusAuthoritativePendingReport[] = [];
        for (const candidate of rows) {
          const reportDeviceKey = String(candidate.device_key);
          const reportId = String(candidate.id);
          await tx.execute({
            sql: `UPDATE saved_reports
                  SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt', datetime('now'))
                  WHERE device_key = ? AND id = ?`,
            args: [reportDeviceKey, reportId],
          });
          claimed.push({ reportDeviceKey, reportId });
        }
        await tx.commit();
        return claimed;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_CLAIM_BUSY_RETRIES) {
        await claimBackoff(attempt);
        continue;
      }
      throw err;
    } finally {
      client.close();
    }
  }
  return [];
}
