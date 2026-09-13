import type { SelectiveCorpusShadowResult, SelectiveCorpusShadowState } from "./types";

/**
 * Selective Corpus V1 SHADOW slice — structured production telemetry.
 *
 * PURPOSE: production currently logs Selective Corpus shadow evaluations only
 * for state PARTIAL (a human-oriented console.warn). COMPLETED, TIMEOUT,
 * ARTIFACT_UNAVAILABLE and FAILED are silent, so passive production
 * validation (is V4 shadow completing, how long does it take, is it using
 * the trusted digest, are there integrity/Blob failures) is not auditable
 * from Vercel logs alone. This module builds ONE stable, machine-queryable
 * JSON event per terminal shadow result, covering every state.
 *
 * SCOPE: OBSERVATION ONLY. This module reads an already-computed
 * SelectiveCorpusShadowResult and formats it; it never calls
 * runSelectiveCorpusShadow, never re-derives a value, and never influences
 * scoring, admission, timing, or the authoritative similarity in any way.
 *
 * PRIVACY: the emitted event is an explicit ALLOWLIST of aggregate,
 * non-identifying fields (enums, counts, timings, the corpus digest/version/
 * document count). It deliberately EXCLUDES, even though they exist on
 * SelectiveCorpusShadowResult:
 *   - failureMessage        (free text; SelectiveCorpusArtifactError messages
 *                            can embed a local artifact path or "vercel-blob:
 *                            <prefix>" string — exactly the kind of path the
 *                            privacy rule forbids)
 *   - degradedShards        (raw shard-number array — not needed for
 *                            aggregate health; degradedShardCount +
 *                            degradedShardCodes already answer "how many,
 *                            what kind")
 *   - degradedDetail        (free-text human summary — degradedShardCount/
 *                            degradedShardCodes cover the same signal
 *                            structurally)
 *   - topCandidateRanks, interpretationVersion/Counts/Breakdown,
 *     counterfactualUnifiedSimilarity, authoritativeUnifiedSimilarity,
 *     deltaVsAuthoritative — evidence/outcome-shaped data about a specific
 *     submission's result, not aggregate operational health.
 * There is no reportId, account/user id, email, IP, device-passport value,
 * manuscript/source text or excerpt, source URL/title/id, filename,
 * filesystem path, Blob URL, or credential anywhere in this module or its
 * output — none of those are ever passed in to begin with (see
 * buildSelectiveCorpusShadowTelemetryEvent's parameter type).
 */

export const SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT = "selective_corpus_shadow" as const;

export type SelectiveCorpusShadowTelemetryEvent = {
  event: typeof SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT;
  state: SelectiveCorpusShadowState;
  /** Total wall time of the runSelectiveCorpusShadow(...) call as measured by
   *  its caller — INCLUDES one-time artifact load/bootstrap overhead on a
   *  cold path, unlike runtimeStageAMs/runtimeStageBMs below. Not the
   *  6000ms-budgeted per-submission time; never confuse the two. */
  evaluationWallMs: number;
  evaluatorVersion?: string;
  failureCode?: string;
  corpusVersion?: string;
  corpusDigest?: string;
  documentCount?: number;
  candidateCount?: number;
  stageATruncated?: boolean;
  verifiedSourceCount?: number;
  matchedPositionCount?: number;
  /** Per-submission Stage A discovery time, counted against the 6000ms
   *  budget — present whenever the result already computed it. */
  runtimeStageAMs?: number;
  /** Per-submission Stage B verification time — absent on TIMEOUT (Stage B
   *  had not finished when the budget expired), never guessed. */
  runtimeStageBMs?: number;
  familyGuardActivations?: number;
  coSourceAttributionActivations?: number;
  degradedShardCount?: number;
  degradedShardCodes?: Record<string, number>;
};

/**
 * Pure formatter: given an already-computed shadow result and the wall time
 * its caller measured, returns the allowlisted structured event. Omits every
 * optional field the result did not actually set — never invents a value.
 */
export function buildSelectiveCorpusShadowTelemetryEvent(
  result: SelectiveCorpusShadowResult,
  evaluationWallMs: number,
): SelectiveCorpusShadowTelemetryEvent {
  const event: SelectiveCorpusShadowTelemetryEvent = {
    event: SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT,
    state: result.state,
    evaluationWallMs: +evaluationWallMs.toFixed(2),
  };
  if (result.evaluatorVersion !== undefined) event.evaluatorVersion = result.evaluatorVersion;
  if (result.failureCode !== undefined) event.failureCode = result.failureCode;
  if (result.corpusVersion !== undefined) event.corpusVersion = result.corpusVersion;
  if (result.corpusDigest !== undefined) event.corpusDigest = result.corpusDigest;
  if (result.documentCount !== undefined) event.documentCount = result.documentCount;
  if (result.candidateCount !== undefined) event.candidateCount = result.candidateCount;
  if (result.stageATruncated !== undefined) event.stageATruncated = result.stageATruncated;
  if (result.verifiedSourceCount !== undefined) event.verifiedSourceCount = result.verifiedSourceCount;
  if (result.matchedPositionCount !== undefined) event.matchedPositionCount = result.matchedPositionCount;
  if (result.runtimeStageAMs !== undefined) event.runtimeStageAMs = result.runtimeStageAMs;
  if (result.runtimeStageBMs !== undefined) event.runtimeStageBMs = result.runtimeStageBMs;
  if (result.familyGuardActivations !== undefined) event.familyGuardActivations = result.familyGuardActivations;
  if (result.coSourceAttributionActivations !== undefined) event.coSourceAttributionActivations = result.coSourceAttributionActivations;
  if (result.degradedShardCount !== undefined) event.degradedShardCount = result.degradedShardCount;
  if (result.degradedShardCodes !== undefined) event.degradedShardCodes = result.degradedShardCodes;
  return event;
}

/**
 * Emits exactly one structured log line per call, at a level matching the
 * result's own severity. The "selective_corpus_shadow" event identifier is
 * present regardless of level, so Vercel log aggregation/search works
 * uniformly across COMPLETED/PARTIAL/TIMEOUT/ARTIFACT_UNAVAILABLE/FAILED/
 * DISABLED.
 *
 * BEST-EFFORT, INDEPENDENTLY OF THE EVALUATOR: this function can NEVER throw
 * back into its caller. Formatting (buildSelectiveCorpusShadowTelemetryEvent
 * + JSON.stringify of its plain, non-circular, allowlisted shape) is not
 * expected to fail, and neither is console.log/warn/error under normal
 * Node/Vercel behavior — but the whole body is wrapped in a single try/catch
 * anyway, specifically so a caller's own surrounding try/catch (see
 * shadow-evaluation.ts) can never mistake a telemetry-layer failure for a
 * real evaluator failure and substitute a synthetic FAILED result in place
 * of an already-computed real one. A failure here is silently ignored —
 * deliberately NOT re-logged (that would just risk a second throwing call)
 * and NEVER surfaced as any SelectiveCorpusShadowState.
 */
export function logSelectiveCorpusShadowTelemetry(result: SelectiveCorpusShadowResult, evaluationWallMs: number): void {
  try {
    const line = JSON.stringify(buildSelectiveCorpusShadowTelemetryEvent(result, evaluationWallMs));
    switch (result.state) {
      case "COMPLETED":
      case "DISABLED":
        console.log(line);
        return;
      case "PARTIAL":
      case "TIMEOUT":
        console.warn(line);
        return;
      case "ARTIFACT_UNAVAILABLE":
      case "FAILED":
        console.error(line);
        return;
    }
  } catch {
    // Best-effort only — see the doc comment above. Never rethrow, never log
    // the failure itself, never touch the evaluator's own result.
  }
}
