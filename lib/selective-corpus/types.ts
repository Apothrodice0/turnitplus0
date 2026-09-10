import type { SelectiveCorpusArtifactErrorCode } from "./artifact";
import type {
  SelectiveCorpusInterpretationKind,
  SelectiveCorpusInterpretationConfidence,
} from "./interpretation";

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
   * Evidence Interpretation Layer V1 — EXPLANATION ONLY. Classifies the
   * already-verified spans; changes NO matched position and NO similarity
   * number (matchedPositionCount / counterfactualUnifiedSimilarity above are
   * computed before it runs). Present only on state COMPLETED / PARTIAL.
   *
   * `interpretationBreakdown` uses NON-SENSITIVE per-source labels (S1..Sn) and
   * word indices into the user's own submission — no source id, path, hash,
   * fingerprint, corpus digest or provenance internal ever appears here.
   *
   * POSSIBLE_SAME_WORK is emitted ONLY on a trusted work/version relationship
   * signal, never from overlap percentage. The shadow supplies no such signal,
   * so `interpretationCounts.POSSIBLE_SAME_WORK` is currently always 0.
   */
  interpretationVersion?: string;
  interpretationCounts?: Record<SelectiveCorpusInterpretationKind, number>;
  interpretationBreakdown?: Array<{
    sourceLabel: string;
    spans: Array<{
      wordRange: [start: number, end: number];
      kind: SelectiveCorpusInterpretationKind;
      confidence: SelectiveCorpusInterpretationConfidence;
      reasons: string[];
    }>;
  }>;

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
