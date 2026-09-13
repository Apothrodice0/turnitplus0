import { performance } from "node:perf_hooks";
import { tokens } from "../similarity-core";
import { isSelectiveCorpusShadowEnabled } from "./flag";
import { getSelectiveCorpusArtifactPath, getSelectiveCorpusStorageMode, getSelectiveCorpusBlobPrefix } from "./config";
import {
  loadSelectiveCorpusArtifact,
  SelectiveCorpusArtifactError,
  type SelectiveCorpusArtifact,
} from "./artifact";
import { createVercelBlobStorageAdapter } from "./vercel-blob-storage-adapter";
import { selectiveCorpusStageA, runWithBoundedConcurrency } from "./stage-a";
import { loadSelectiveCorpusCandidateText, type SelectiveCorpusCandidateText } from "./source-loader";
import { admitSelectiveCorpusCandidate } from "./verify";
import { disambiguateSelectiveCorpusCoSources } from "./co-source";
import { interpretSelectiveCorpusEvidence } from "./interpretation";
import {
  SELECTIVE_CORPUS_SHADOW_EVALUATOR_VERSION,
  SELECTIVE_CORPUS_TIME_BUDGET_MS,
  SELECTIVE_CORPUS_STAGE_B_SOURCE_FETCH_CONCURRENCY,
} from "./constants";
import { createSelectiveCorpusFailureCollector, type SelectiveCorpusShardFailure } from "./shard-reader";
import type { SelectiveCorpusShadowResult } from "./types";

/**
 * Selective Corpus V1 SHADOW slice — the orchestrator.
 *
 * submission canonical text
 *   -> production-compatible winnowed fingerprints
 *   -> packed Selective Corpus Stage A (fingerprint hits NEVER score)
 *   -> bounded top-K
 *   -> load the actual candidate source text (one file per candidate, LRU)
 *   -> the UNMODIFIED lib/academic-search/comparator.ts matcher
 *   -> STRICT_SPAN -> FAMILY_GUARD -> co-source attribution
 *   -> a SHADOW result only
 *
 * NO authoritative report score may change. This function reads
 * authoritativeUnifiedSimilarity but only to compute a counterfactual delta;
 * it never mutates it, never returns a new score into the pipeline.
 *
 * NEVER THROWS. Any error -> a result object with state FAILED / TIMEOUT /
 * ARTIFACT_UNAVAILABLE. A run that finished but over an index that lost one or
 * more packed shards AT QUERY TIME (a shard deleted/corrupted after the
 * artifact passed initialization) returns state PARTIAL with degradedShard*
 * fields — never a silent COMPLETED that looks like an ordinary "no match".
 */

export type RunSelectiveCorpusShadowParams = {
  /** The report's own canonical submission text — reused as-is, never re-fetched. */
  canonicalSubmissionText: string;
  /** Production's already-computed authoritative result (unifiedScore +
   *  matchedPositions). null when computeUnifiedSimilarity itself threw. */
  authoritative: { unifiedScore: number; matchedPositions: readonly number[] } | null;
  /** Test/regression seam: override the configured artifact path. */
  artifactPathOverride?: string;
  /** Test/regression seam: an already-loaded artifact (skips the loader). */
  artifactOverride?: SelectiveCorpusArtifact;
  /** Test/regression seam, mirroring selectiveCorpusStageA's own
   *  opts.shardFetchConcurrency: overrides SELECTIVE_CORPUS_STAGE_B_SOURCE_FETCH_CONCURRENCY
   *  for this one call — the module-level constant is frozen at import time
   *  (read from process.env once, like its Stage-A counterpart), so a
   *  per-call override is the only way tests can exercise a different bound
   *  (e.g. proving concurrency=1 and the real default produce identical
   *  evidence) without a process restart. */
  stageBSourceFetchConcurrencyOverride?: number;
};

export async function runSelectiveCorpusShadow(
  params: RunSelectiveCorpusShadowParams,
): Promise<SelectiveCorpusShadowResult> {
  const base = { evaluatorVersion: SELECTIVE_CORPUS_SHADOW_EVALUATOR_VERSION } as const;

  if (!isSelectiveCorpusShadowEnabled()) {
    return { state: "DISABLED", ...base };
  }

  try {
    // ---- artifact (loaded once, cached — NOT counted against the per-submission time budget) ----
    let artifact: SelectiveCorpusArtifact;
    if (params.artifactOverride) {
      artifact = params.artifactOverride;
    } else {
      try {
        if (getSelectiveCorpusStorageMode() === "vercel-blob") {
          // VERCEL-BLOB MODE: manifest is mandatory (integrity-required),
          // shards/source objects stay lazy (see artifact.ts's cold-start
          // hardening) — and a missing/invalid prefix fails closed here,
          // never silently falling back to SELECTIVE_CORPUS_ARTIFACT_PATH.
          const prefix = getSelectiveCorpusBlobPrefix();
          if (!prefix) {
            throw new SelectiveCorpusArtifactError("MISSING", "vercel-blob storage mode requires SELECTIVE_CORPUS_BLOB_PREFIX");
          }
          const storageAdapter = createVercelBlobStorageAdapter({ prefix });
          artifact = await loadSelectiveCorpusArtifact(`vercel-blob:${prefix}`, {
            storageAdapter,
            integrityMode: "integrity-required",
          });
        } else {
          // LOCAL MODE (default, unchanged): SELECTIVE_CORPUS_ARTIFACT_PATH,
          // local-compatible artifact loading, exactly as before this task.
          const path = params.artifactPathOverride ?? getSelectiveCorpusArtifactPath();
          if (!path) {
            throw new SelectiveCorpusArtifactError("MISSING", "no artifact path configured");
          }
          artifact = await loadSelectiveCorpusArtifact(path);
        }
      } catch (err) {
        if (err instanceof SelectiveCorpusArtifactError) {
          return { state: "ARTIFACT_UNAVAILABLE", failureCode: err.code, failureMessage: err.message, ...base };
        }
        return { state: "ARTIFACT_UNAVAILABLE", failureCode: "UNEXPECTED", failureMessage: err instanceof Error ? err.message : String(err), ...base };
      }
    }

    // per-submission time budget starts here (after the one-time artifact load)
    const started = performance.now();
    const submissionWords = tokens(params.canonicalSubmissionText);
    const submissionWordCount = submissionWords.length;
    if (submissionWordCount < 10) {
      return {
        state: "COMPLETED",
        corpusVersion: artifact.corpusVersion,
        corpusDigest: artifact.corpusDigest,
        documentCount: artifact.documentCount,
        candidateCount: 0,
        topCandidateRanks: [],
        verifiedSourceCount: 0,
        matchedPositionCount: 0,
        counterfactualUnifiedSimilarity: params.authoritative?.unifiedScore ?? 0,
        authoritativeUnifiedSimilarity: params.authoritative?.unifiedScore ?? null,
        deltaVsAuthoritative: 0,
        runtimeStageAMs: 0,
        runtimeStageBMs: 0,
        familyGuardActivations: 0,
        coSourceAttributionActivations: 0,
        ...base,
      };
    }

    // Evaluation-scoped shard-failure attribution: this collector is
    // exclusive to THIS runSelectiveCorpusShadow() call, threaded through
    // Stage A and FAMILY_GUARD below. It is never a shared/reader-level
    // ledger, so a concurrently-running evaluation sharing the same cached
    // artifact/reader can never drain a failure this evaluation also
    // depended on -- and this evaluation can never see a failure it did not
    // itself encounter.
    const failureCollector = createSelectiveCorpusFailureCollector();

    // ---- Stage A ----
    const tA0 = performance.now();
    const stageA = await selectiveCorpusStageA(params.canonicalSubmissionText, artifact, undefined, failureCollector);
    const stageAMs = performance.now() - tA0;

    // ---- Stage B: prefetch candidate source text (bounded concurrency),
    // then admit each top-K candidate in ORIGINAL Stage-A rank order ----
    const tB0 = performance.now();

    // Shared by every TIMEOUT return point below (before the prefetch
    // window, after it resolves, and during ordered verification) so the
    // three checkpoints can never drift into different result shapes.
    // Surfaces the SAME zero-evidence shape the original single mid-loop
    // check always did — a TIMEOUT here can therefore never admit MORE
    // evidence than the old sequential implementation would have, because
    // the old implementation never surfaced partial Stage-B evidence on a
    // timeout either (a mid-loop timeout returned before the `completed`
    // object — carrying any admitted spans — was ever constructed).
    const timeoutResult = (failureMessage: string): SelectiveCorpusShadowResult => {
      const timedOutShardFailures = failureCollector.getFailures();
      return {
        state: "TIMEOUT",
        failureCode: "TIMEOUT",
        failureMessage,
        corpusVersion: artifact.corpusVersion,
        corpusDigest: artifact.corpusDigest,
        documentCount: artifact.documentCount,
        // Stage A itself always finishes before any Stage-B check can fire
        // (it runs unconditionally before Stage B), so its own duration is a
        // real, already-computed value here — Stage B's own runtime is not,
        // since it timed out before finishing; omitted rather than guessed.
        runtimeStageAMs: +stageAMs.toFixed(2),
        ...(timedOutShardFailures.length > 0
          ? {
              degradedShardCount: timedOutShardFailures.length,
              degradedShards: timedOutShardFailures.slice(0, 32).map((f) => f.shard),
            }
          : {}),
        ...base,
      };
    };

    // Checkpoint 1: before starting ANY prefetch — never begin prefetching
    // (even a trivial/empty window) once the budget is already exhausted by
    // Stage A alone. Same logical position the original implementation's
    // very first per-candidate check occupied.
    if (performance.now() - started > SELECTIVE_CORPUS_TIME_BUDGET_MS) {
      return timeoutResult("time budget exceeded before Stage B began");
    }

    // Bounded-concurrency prefetch of every stageA.topK candidate's source
    // text. topK is capped at SELECTIVE_CORPUS_STAGE_A_TOP_K (20), comfortably
    // <= SELECTIVE_CORPUS_SOURCE_TEXT_LRU (64) — a SINGLE prefetch window for
    // this evaluation's own candidates cannot self-evict, so (unlike Stage
    // A's shard prefetch, whose fanout can exceed its own LRU) no windowing
    // loop is needed here. Reuses the SAME bounded-concurrency primitive
    // Stage A's shard prefetch already uses and has already proven safe and
    // deterministic — never a second, divergent concurrency helper.
    // loadSelectiveCorpusCandidateText never throws (see source-loader.ts),
    // so this prefetch can never reject; every candidate's outcome — a real
    // text, or null for missing/transient/corrupt/unreadable, exactly as
    // before — lands in this map. Fully awaited before any decision below is
    // made, so no fetch promise is ever left running past a return.
    const prefetchedTextByOrdinal = new Map<number, SelectiveCorpusCandidateText | null>();
    const stageBConcurrency = params.stageBSourceFetchConcurrencyOverride ?? SELECTIVE_CORPUS_STAGE_B_SOURCE_FETCH_CONCURRENCY;
    await runWithBoundedConcurrency(stageA.topK, stageBConcurrency, async (cand) => {
      const ct = await loadSelectiveCorpusCandidateText(artifact, cand.ordinal);
      prefetchedTextByOrdinal.set(cand.ordinal, ct);
    });

    // Checkpoint 2: after the prefetch window fully resolves, before ordered
    // verification begins — stops wasted verification work if the prefetch
    // itself consumed the remaining budget.
    if (performance.now() - started > SELECTIVE_CORPUS_TIME_BUDGET_MS) {
      return timeoutResult("time budget exceeded during Stage B source prefetch");
    }

    let familyGuardActivations = 0;
    const admittedSpansByKey = new Map<string, Awaited<ReturnType<typeof admitSelectiveCorpusCandidate>>["spans"]>();
    const rankByKey = new Map<string, number>();
    /** FAMILY_GUARD's own per-source verdict, kept for the Evidence Interpretation
     *  Layer (explanation only — never re-derived, never changes a position). */
    const guardByKey = new Map<string, { familyGuardActivated: boolean; dominantSpanBoilerplate: boolean }>();

    // Ordered verification, in the EXACT original stageA.topK (rank) order —
    // fetch completion order during the prefetch above has zero effect on
    // this order or on the result, since every candidate's text is already
    // resolved in prefetchedTextByOrdinal before this loop starts. Checkpoint
    // 3: the per-candidate boundary check is retained here, unchanged in
    // position and behavior from the original implementation, so a slow
    // verification pass (not I/O — the text is already loaded) still cannot
    // run unbounded past the budget.
    for (const cand of stageA.topK) {
      if (performance.now() - started > SELECTIVE_CORPUS_TIME_BUDGET_MS) {
        return timeoutResult("time budget exceeded during Stage B verification");
      }
      const ct = prefetchedTextByOrdinal.get(cand.ordinal) ?? null;
      if (!ct) continue;
      const res = await admitSelectiveCorpusCandidate(params.canonicalSubmissionText, submissionWords, ct.text, artifact, failureCollector);
      if (res.familyGuardActivated) familyGuardActivations += 1;
      if (res.admitted) {
        const key = String(cand.ordinal);
        admittedSpansByKey.set(key, res.spans);
        rankByKey.set(key, stageA.rankByOrdinal.get(cand.ordinal) ?? -1);
        guardByKey.set(key, {
          familyGuardActivated: res.familyGuardActivated,
          dominantSpanBoilerplate: res.dominantSpanBoilerplate,
        });
      }
    }

    // ---- co-source attribution ----
    const co = disambiguateSelectiveCorpusCoSources(admittedSpansByKey);
    const stageBMs = performance.now() - tB0;

    const admittedKeys = [...co.attributed.entries()].filter(([, s]) => s.size > 0).map(([k]) => k);
    const verifiedPositions = new Set<number>();
    for (const k of admittedKeys) for (const p of co.attributed.get(k)!) verifiedPositions.add(p);

    // ---- counterfactual unified similarity ----
    const authScore = params.authoritative?.unifiedScore ?? null;
    const authPositions = new Set<number>(params.authoritative?.matchedPositions ?? []);
    const merged = new Set<number>(authPositions);
    for (const p of verifiedPositions) merged.add(p);
    const counterfactual = submissionWordCount > 0
      ? Math.min(100, Math.round((merged.size / submissionWordCount) * 100))
      : 0;
    const delta = authScore === null ? 0 : counterfactual - authScore;

    // ---- Evidence Interpretation Layer V1 (EXPLANATION ONLY) ----
    // Runs AFTER the counterfactual is computed, over the already-verified spans.
    // It re-runs nothing and touches no position: matchedPositionCount,
    // verifiedSourceCount, counterfactualUnifiedSimilarity and deltaVsAuthoritative
    // above are final and independent of anything below.
    const interpretation = interpretSelectiveCorpusEvidence({
      submissionText: params.canonicalSubmissionText,
      submissionWordCount,
      sources: [...admittedSpansByKey.entries()].map(([key, spans]) => {
        const pos = new Set<number>();
        for (const s of spans) for (let i = s.start; i <= s.end; i += 1) pos.add(i);
        const guard = guardByKey.get(key);
        return {
          key,
          spans,
          familyGuardActivated: guard?.familyGuardActivated ?? false,
          dominantSpanBoilerplate: guard?.dominantSpanBoilerplate ?? false,
          submissionCoverageFraction: submissionWordCount > 0 ? pos.size / submissionWordCount : 0,
          // The shadow has no trusted work/version relationship signal, so
          // POSSIBLE_SAME_WORK is never emitted here (overlap % alone must not
          // produce it). Left null deliberately.
          sameWorkRelationship: null,
        };
      }),
    });
    // stable, NON-SENSITIVE per-source labels (S1..Sn in admitted-rank order) —
    // never the ordinal, never a source id, never a path or hash.
    const orderedKeys = [...admittedSpansByKey.keys()];
    const interpretationBreakdown = orderedKeys.map((key, i) => ({
      sourceLabel: `S${i + 1}`,
      spans: (interpretation.bySource.get(key) ?? []).map((si) => ({
        wordRange: si.wordRange,
        kind: si.kind,
        confidence: si.confidence,
        reasons: si.reasons,
      })),
    }));

    // Did any packed shard fail to load while serving Stage A / FAMILY_GUARD for
    // THIS evaluation? If so the discovery ran over an incomplete index and the
    // counterfactual is a LOWER BOUND — report PARTIAL, not a silent COMPLETED.
    // Read from this evaluation's own collector only — never a shared/reader-
    // level ledger another concurrently-running evaluation could have drained.
    const shardFailures = failureCollector.getFailures();

    const completed: SelectiveCorpusShadowResult = {
      state: "COMPLETED",
      corpusVersion: artifact.corpusVersion,
      corpusDigest: artifact.corpusDigest,
      documentCount: artifact.documentCount,
      candidateCount: stageA.ranked.length,
      topCandidateRanks: admittedKeys.map((k) => rankByKey.get(k) ?? -1).sort((a, b) => a - b),
      stageATruncated: stageA.truncated,
      verifiedSourceCount: admittedKeys.length,
      matchedPositionCount: verifiedPositions.size,
      counterfactualUnifiedSimilarity: counterfactual,
      authoritativeUnifiedSimilarity: authScore,
      deltaVsAuthoritative: delta,
      runtimeStageAMs: +stageAMs.toFixed(2),
      runtimeStageBMs: +stageBMs.toFixed(2),
      familyGuardActivations,
      coSourceAttributionActivations: co.activations,
      interpretationVersion: interpretation.version,
      interpretationCounts: interpretation.counts,
      interpretationBreakdown,
      ...base,
    };

    if (shardFailures.length === 0) return completed;

    const degradedShardCodes: Record<string, number> = {};
    for (const f of shardFailures) degradedShardCodes[f.code] = (degradedShardCodes[f.code] ?? 0) + 1;
    return {
      ...completed,
      state: "PARTIAL",
      degradedShardCount: shardFailures.length,
      degradedShards: shardFailures.slice(0, 32).map((f) => f.shard),
      degradedShardCodes,
      degradedDetail: summarizeSelectiveCorpusShardFailures(shardFailures),
    };
  } catch (err) {
    return {
      state: "FAILED",
      failureCode: "UNEXPECTED",
      failureMessage: err instanceof Error ? err.message : String(err),
      ...base,
    };
  }
}

function summarizeSelectiveCorpusShardFailures(
  failures: readonly SelectiveCorpusShardFailure[],
): string {
  const byCode = new Map<string, number>();
  for (const f of failures) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  const codes = [...byCode.entries()].map(([c, n]) => `${c}:${n}`).join(", ");
  const shown = failures.slice(0, 8).map((f) => f.shard);
  const list = shown.join(",") + (failures.length > shown.length ? ",..." : "");
  return (
    `${failures.length} packed shard(s) unavailable at query time (${codes}); ` +
    `Stage A discovery ran over an incomplete index, so the counterfactual is a lower bound. ` +
    `affected shards: [${list}]`
  );
}
