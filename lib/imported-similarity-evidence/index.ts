import { loadImportedSimilarityEvidencePackage } from "./config";
import {
  buildImportedSimilarityEvidenceCandidateIndex,
  matchImportedSimilarityEvidence,
  type ImportedSimilarityEvidenceCandidateIndex,
  type ImportedSimilarityEvidenceMatchedSource,
} from "./matcher";

export * from "./types";
export * from "./package";
export * from "./matcher";
export * from "./config";

let indexCache: { contentSha256: string; index: ImportedSimilarityEvidenceCandidateIndex } | null = null;

/**
 * The single entry point lib/report-primary-similarity.ts calls to resolve
 * this channel's contribution for computeUnifiedSimilarity — in the SAME
 * `{sourceId, matchedPassages}[]` shape userSuppliedReferenceEvidence and
 * selectiveCorpusEvidence already use, so it slots in as one more sibling
 * channel with no new aggregation logic (see lib/unified-similarity.ts).
 *
 * Fails closed at every stage: no package configured, an invalid/corrupt
 * package, or an empty/too-short submission all return `[]` — byte-identical
 * to this channel not existing at all. Never throws.
 */
export function resolveImportedSimilarityEvidenceForUnifiedSimilarity(
  rawText: string,
): ImportedSimilarityEvidenceMatchedSource[] {
  const state = loadImportedSimilarityEvidencePackage();
  if (state.status !== "loaded") return [];
  if (!indexCache || indexCache.contentSha256 !== state.package.metadata.contentSha256) {
    indexCache = {
      contentSha256: state.package.metadata.contentSha256,
      index: buildImportedSimilarityEvidenceCandidateIndex(state.package),
    };
  }
  try {
    return matchImportedSimilarityEvidence(rawText ?? "", indexCache.index);
  } catch (err) {
    console.error(
      "resolveImportedSimilarityEvidenceForUnifiedSimilarity: matching failed (non-fatal — imported evidence contributes nothing for this resolution):",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export function resetImportedSimilarityEvidenceCandidateIndexCacheForTest(): void {
  indexCache = null;
}
