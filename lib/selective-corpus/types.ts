import type { SelectiveCorpusArtifactErrorCode } from "./artifact";

/**
 * Selective Corpus V1 SHADOW slice — the internal shadow result.
 *
 * MEASUREMENT ONLY. Nothing here is exposed to ordinary users, written to the
 * reports DB, or fed into the authoritative unifiedScore. Internal IDs, paths,
 * hashes and fingerprint data are deliberately absent from the shape returned
 * to any caller outside this module (the local diagnostics writer may include
 * a bounded per-candidate breakdown; a route/telemetry caller gets only the
 * aggregate fields below).
 */

export type SelectiveCorpusShadowState =
  | "DISABLED" // flag off — immediate no-op, zero I/O
  | "ARTIFACT_UNAVAILABLE" // no path configured, or the artifact failed validation
  | "COMPLETED"
  | "PARTIAL" // completed, but >= 1 packed shard was unavailable at query time — counterfactual is a LOWER BOUND
  | "TIMEOUT"
  | "FAILED";

export type SelectiveCorpusShadowResult = {
  state: SelectiveCorpusShadowState;
  evaluatorVersion: string;

  /** Present unless state is DISABLED / ARTIFACT_UNAVAILABLE. */
  corpusVersion?: string;
  corpusDigest?: string;

  /** Stage A discovery — fingerprint hits, which NEVER score. */
  candidateCount?: number;
  /** Stage-A ranks (0-based) of the admitted sources, ascending. */
  topCandidateRanks?: number[];
  stageATruncated?: boolean;

  /** Stage B — the unmodified matcher + STRICT_SPAN + FAMILY_GUARD + co-source. */
  verifiedSourceCount?: number;
  matchedPositionCount?: number;

  /** Counterfactual: unified similarity if the selective-corpus verified
   *  positions were also unioned into the authoritative matched set. */
  counterfactualUnifiedSimilarity?: number;
  authoritativeUnifiedSimilarity?: number | null;
  deltaVsAuthoritative?: number;

  runtimeStageAMs?: number;
  runtimeStageBMs?: number;

  familyGuardActivations?: number;
  coSourceAttributionActivations?: number;

  /**
   * Set when state is PARTIAL (and, when already observed, on a TIMEOUT):
   * packed shards that could not be loaded at query time, so Stage A discovery
   * ran over an incomplete index. The counterfactual similarity is then a
   * LOWER BOUND — a source the missing shard would have surfaced is absent.
   */
  degradedShardCount?: number;
  /** Affected shard numbers (0-255), ascending, capped at 32. */
  degradedShards?: number[];
  /** Failure-code histogram, e.g. { MISSING: 2, CORRUPT: 1 }. */
  degradedShardCodes?: Record<string, number>;
  /** One-line, path-free human summary of the degradation. */
  degradedDetail?: string;

  /** Set when state is ARTIFACT_UNAVAILABLE / FAILED / TIMEOUT. */
  failureCode?: SelectiveCorpusArtifactErrorCode | "TIMEOUT" | "UNEXPECTED";
  failureMessage?: string;
};
