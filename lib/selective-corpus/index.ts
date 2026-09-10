/**
 * Selective Corpus V1 SHADOW slice — public surface.
 *
 * The mechanism validated across the mixed-fulltext-index /
 * minority-evidence-admission / strict-span-family-final / co-source-attribution
 * / selective-corpus-v1 / selective-corpus-bulk-v1 benchmarks, integrated
 * behind the DEFAULT-OFF SELECTIVE_CORPUS_SHADOW_ENABLED flag.
 *
 * Fingerprint/index hits are candidate discovery ONLY — they never contribute
 * to any similarity score. The authoritative unifiedScore is byte-for-byte
 * identical whether this slice is on or off.
 */
export { isSelectiveCorpusShadowEnabled } from "./flag";
export { runSelectiveCorpusShadow } from "./shadow";
export { runSelectiveCorpusShadowEvaluation } from "./shadow-evaluation";
export {
  loadSelectiveCorpusArtifact,
  SelectiveCorpusArtifactError,
  clearSelectiveCorpusArtifactCache,
  type SelectiveCorpusArtifact,
  type LoadSelectiveCorpusArtifactOptions,
} from "./artifact";
export {
  SelectiveCorpusShardReader,
  type SelectiveCorpusShardReaderStats,
  type SelectiveCorpusPostingsAccessor,
  type SelectiveCorpusShardFailure,
  type SelectiveCorpusShardFailureCode,
} from "./shard-reader";
export type { SelectiveCorpusShadowResult, SelectiveCorpusShadowState } from "./types";
export {
  SELECTIVE_CORPUS_EXPECTED_DIGEST,
  SELECTIVE_CORPUS_VERSION,
  SELECTIVE_CORPUS_SHADOW_EVALUATOR_VERSION,
} from "./constants";
