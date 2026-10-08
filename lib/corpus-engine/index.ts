import { DerivedSourceSidecarSet } from "./derived-source";
import { isCorpusEngineV1Enabled } from "./flag";
import { CorpusGenerationError } from "./generation";
import { CorpusGenerationReader, type CorpusReaderIdentity } from "./reader";
import type { RevocationAnchor } from "./revocation";
import { retrieveCandidates, type CandidateRankingPolicy, type RetrievalResult } from "./retrieval";
import type { CorpusObjectStore } from "./storage";
import { verifyCandidatesWithExistingVerifier, type CorpusVerificationResult } from "./verifier-adapter";

/**
 * Corpus Engine v1 — the application-facing surface.
 *
 * The engine is a CANDIDATE-RETRIEVAL layer in front of the existing verifier:
 *
 *   submission -> existing normalization/fingerprints -> corpus-engine retrieval
 *     -> candidate source text -> EXISTING verifier -> EXISTING union -> EXISTING score
 *
 * It decides which source documents are worth verifying. It never decides
 * that a position is verified or what a similarity score is: those are the
 * existing verifier's answers. (By default the engine runs that verifier with
 * the submission prepared once per query — ./prepared-verifier.ts, a
 * restatement held equal to the unmodified functions by an exact-equality
 * gate; see ./verifier-adapter.ts.)
 *
 * Offline tooling (scripts/corpus-engine/*) uses the modules directly. An
 * application caller uses only runCorpusEngineCandidateVerification below,
 * which is gated by CORPUS_ENGINE_V1_ENABLED (default OFF) and requires the
 * caller to PIN a generation: there is no "search the latest" entry point.
 */

export * from "./versions";
export * from "./flag";
export type { CorpusReaderIdentity } from "./reader";
export type { CandidateRankingPolicy, RetrievalResult, RetrievalState } from "./retrieval";
export type { CorpusVerificationResult } from "./verifier-adapter";

export type CorpusEngineRequest = {
  store: CorpusObjectStore;
  /** The generation to search. Required — a request never means "whatever is active". */
  generationId: string;
  /** Optional second pin: the manifest must hash to exactly this. */
  logicalManifestSha256?: string;
  /** The newest revocation history the caller knows of (from the activation pointer); an older or rewritten list is refused. */
  revocationAnchor?: RevocationAnchor | null;
  submissionText: string;
  rankingPolicy?: Partial<CandidateRankingPolicy>;
  /**
   * Verify candidates from the generation's derived-source sidecar where one is
   * present and accepted (same result, no text read). Off unless asked: opening
   * the sidecar index costs a read per segment.
   */
  useDerivedSourceSidecar?: boolean;
  /**
   * Byte budget of the reader's dictionary block cache (default DEFAULT_DICTIONARY_CACHE_BYTES, 512 MiB;
   * 0 = uncached). Measured on the 1M launch generation: 512 MiB holds ~0.67 of a varied workload's
   * blocks, 1 GiB ~0.91 (recommended for a 1M generation). The cache never changes an answer.
   */
  dictionaryCacheBytes?: number;
};

export type CorpusEngineResponse =
  | { state: "DISABLED" }
  | { state: "FAILED"; failureCode: string; failureMessage: string; identity: CorpusReaderIdentity | null }
  | {
      /** COMPLETE only when retrieval AND verification were both complete. */
      state: "COMPLETE" | "PARTIAL";
      identity: CorpusReaderIdentity;
      retrieval: RetrievalResult;
      verification: CorpusVerificationResult;
    };

/**
 * Retrieval -> source text -> existing verifier -> existing union/score, over
 * one pinned generation. Never throws: every failure is a FAILED or PARTIAL
 * response that says what was not searched or not verified.
 */
export async function runCorpusEngineCandidateVerification(request: CorpusEngineRequest): Promise<CorpusEngineResponse> {
  if (!isCorpusEngineV1Enabled()) return { state: "DISABLED" };
  let reader: CorpusGenerationReader;
  try {
    reader = await CorpusGenerationReader.open({
      store: request.store,
      generationId: request.generationId,
      expectedLogicalManifestSha256: request.logicalManifestSha256,
      revocationAnchor: request.revocationAnchor,
      dictionaryCacheBytes: request.dictionaryCacheBytes,
    });
  } catch (error) {
    return {
      state: "FAILED",
      failureCode: error instanceof CorpusGenerationError ? error.code : "UNEXPECTED",
      failureMessage: error instanceof Error ? error.message : String(error),
      identity: null,
    };
  }
  try {
    const retrieval = await retrieveCandidates(reader, request.submissionText, request.rankingPolicy);
    if (retrieval.state === "FAILED") {
      return { state: "FAILED", failureCode: retrieval.failures[0]?.code ?? "RETRIEVAL_FAILED", failureMessage: retrieval.failures[0]?.message ?? "retrieval failed", identity: reader.identity() };
    }
    const sidecars = request.useDerivedSourceSidecar ? await DerivedSourceSidecarSet.open(reader) : null;
    const verification = await verifyCandidatesWithExistingVerifier(reader, request.submissionText, retrieval.candidates.map((candidate) => candidate.docId), { sidecars });
    if (verification.state === "FAILED") {
      return { state: "FAILED", failureCode: verification.failures[0]?.code ?? "VERIFICATION_FAILED", failureMessage: verification.failures[0]?.message ?? "verification failed", identity: reader.identity() };
    }
    return {
      state: retrieval.state === "COMPLETE" && verification.state === "COMPLETE" ? "COMPLETE" : "PARTIAL",
      identity: reader.identity(),
      retrieval,
      verification,
    };
  } catch (error) {
    return { state: "FAILED", failureCode: "UNEXPECTED", failureMessage: error instanceof Error ? error.message : String(error), identity: reader.identity() };
  }
}
