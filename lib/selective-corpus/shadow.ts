import { performance } from "node:perf_hooks";
import { tokens } from "../similarity-core";
import { isSelectiveCorpusShadowEnabled } from "./flag";
import { getSelectiveCorpusArtifactPath } from "./config";
import {
  loadSelectiveCorpusArtifact,
  SelectiveCorpusArtifactError,
  type SelectiveCorpusArtifact,
} from "./artifact";
import { selectiveCorpusStageA } from "./stage-a";
import { loadSelectiveCorpusCandidateText } from "./source-loader";
import { admitSelectiveCorpusCandidate } from "./verify";
import { disambiguateSelectiveCorpusCoSources } from "./co-source";
import {
  SELECTIVE_CORPUS_SHADOW_EVALUATOR_VERSION,
  SELECTIVE_CORPUS_TIME_BUDGET_MS,
} from "./constants";
import type { SelectiveCorpusShardFailure } from "./shard-reader";
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
};

export function runSelectiveCorpusShadow(
  params: RunSelectiveCorpusShadowParams,
): SelectiveCorpusShadowResult {
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
      const path = params.artifactPathOverride ?? getSelectiveCorpusArtifactPath();
      if (!path) {
        return { state: "ARTIFACT_UNAVAILABLE", failureCode: "MISSING", failureMessage: "no artifact path configured", ...base };
      }
      try {
        artifact = loadSelectiveCorpusArtifact(path);
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

    // Discard any shard-failure ledger a prior evaluation left on the shared,
    // cached reader (e.g. one that exited via TIMEOUT). This evaluation must
    // report only shards that fail while serving THIS submission.
    artifact.postingsAccessor.takeShardFailures();

    // ---- Stage A ----
    const tA0 = performance.now();
    const stageA = selectiveCorpusStageA(params.canonicalSubmissionText, artifact);
    const stageAMs = performance.now() - tA0;

    // ---- Stage B: admit each top-K candidate ----
    const tB0 = performance.now();
    let familyGuardActivations = 0;
    const admittedSpansByKey = new Map<string, ReturnType<typeof admitSelectiveCorpusCandidate>["spans"]>();
    const rankByKey = new Map<string, number>();

    for (const cand of stageA.topK) {
      if (performance.now() - started > SELECTIVE_CORPUS_TIME_BUDGET_MS) {
        const timedOutShardFailures = artifact.postingsAccessor.takeShardFailures();
        return {
          state: "TIMEOUT",
          failureCode: "TIMEOUT",
          failureMessage: "time budget exceeded during Stage B",
          corpusVersion: artifact.corpusVersion,
          corpusDigest: artifact.corpusDigest,
          ...(timedOutShardFailures.length > 0
            ? {
                degradedShardCount: timedOutShardFailures.length,
                degradedShards: timedOutShardFailures.slice(0, 32).map((f) => f.shard),
              }
            : {}),
          ...base,
        };
      }
      const ct = loadSelectiveCorpusCandidateText(artifact, cand.ordinal);
      if (!ct) continue;
      const res = admitSelectiveCorpusCandidate(params.canonicalSubmissionText, submissionWords, ct.text, artifact);
      if (res.familyGuardActivated) familyGuardActivations += 1;
      if (res.admitted) {
        const key = String(cand.ordinal);
        admittedSpansByKey.set(key, res.spans);
        rankByKey.set(key, stageA.rankByOrdinal.get(cand.ordinal) ?? -1);
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

    // Did any packed shard fail to load while serving Stage A / FAMILY_GUARD for
    // this submission? If so the discovery ran over an incomplete index and the
    // counterfactual is a LOWER BOUND — report PARTIAL, not a silent COMPLETED.
    const shardFailures = artifact.postingsAccessor.takeShardFailures();

    const completed: SelectiveCorpusShadowResult = {
      state: "COMPLETED",
      corpusVersion: artifact.corpusVersion,
      corpusDigest: artifact.corpusDigest,
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
