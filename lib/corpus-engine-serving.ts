import path from "node:path";
import { isCorpusEngineV1Enabled, runCorpusEngineCandidateVerification, type CorpusReaderIdentity, type CorpusVerificationResult } from "./corpus-engine";
import { DEFAULT_DICTIONARY_CACHE_BYTES, DictionaryBlockCache } from "./corpus-engine/dictionary-cache";
import type { RevocationAnchor } from "./corpus-engine/revocation";
import { LocalDirectoryObjectStore, type CorpusObjectStore } from "./corpus-engine/storage";
import { artifactNormalizationCompatibility, type ArtifactNormalizationIdentity } from "./scoring-normalization-artifacts";
import { currentScoringNormalizationVersion } from "./similarity-core";

/**
 * Corpus Engine v1 — the application's SERVER-SIDE serving adapter.
 *
 * Everything a serving process needs to search a Corpus Engine generation
 * comes from server configuration (process.env) and the reviewed record of
 * servable generations below — never from a request, a report or the browser:
 *
 *   CORPUS_ENGINE_V1_ENABLED             the gate (lib/corpus-engine/flag.ts). DEFAULT OFF:
 *                                        unset or anything but "true" => DISABLED before any
 *                                        configuration is read or any file is opened.
 *   CORPUS_ENGINE_STORAGE_ROOT           absolute directory holding the corpus root (ACTIVE.json,
 *                                        generations/, segments/, revocations/, ...). No default:
 *                                        a validation location on a developer machine is not a
 *                                        production contract.
 *   CORPUS_ENGINE_GENERATION_ID          the generation to serve. Must be listed in
 *                                        SERVABLE_CORPUS_ENGINE_GENERATIONS, which also pins its
 *                                        logical manifest hash and revocation anchor; ACTIVE.json is
 *                                        never followed ("latest" is not a thing).
 *   CORPUS_ENGINE_DICTIONARY_CACHE_BYTES the reader's dictionary block cache budget, a decimal
 *                                        integer in [0, CORPUS_ENGINE_MAX_DICTIONARY_CACHE_BYTES]
 *                                        (0 = uncached). Unset => the library default
 *                                        (DEFAULT_DICTIONARY_CACHE_BYTES, 512 MiB). Malformed or out
 *                                        of range => the same library default, reported as
 *                                        "invalid-fallback" — the cache never changes an answer,
 *                                        so a bad value costs speed, never evidence. The 1M launch
 *                                        deployment sets CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES.
 *
 * The cache is held by this module for the life of the process (one cache,
 * bound to the served generation by the reader), so its budget is a property
 * of the deployment, not of a request.
 *
 * Failure semantics (none of them is a completed zero):
 *   DISABLED     flag off — the lane did not run; no Corpus Engine claim either way.
 *   UNAVAILABLE  configuration missing/invalid, the configured generation is not servable, or
 *                the report's scoring-normalization contract cannot read the generation
 *                (NORMALIZATION_INCOMPATIBLE, lib/scoring-normalization-artifacts.ts).
 *   FAILED       the engine could not open/search/verify the pinned generation
 *                (missing generation, pin mismatch, damaged manifest, verifier contract refusal).
 *   PARTIAL      some candidates or segments could not be searched/verified; the evidence
 *                returned is verified but the lane's result is a lower bound.
 *   COMPLETE     retrieval and verification were both complete.
 * Evidence is returned only for PARTIAL/COMPLETE and only as the existing
 * verifier's admitted, co-source-attributed passages.
 */

export const CORPUS_ENGINE_STORAGE_ROOT_ENV = "CORPUS_ENGINE_STORAGE_ROOT";
export const CORPUS_ENGINE_GENERATION_ID_ENV = "CORPUS_ENGINE_GENERATION_ID";
export const CORPUS_ENGINE_DICTIONARY_CACHE_BYTES_ENV = "CORPUS_ENGINE_DICTIONARY_CACHE_BYTES";

/** The dictionary cache budget of the 1M launch deployment (1 GiB; owner decision 2026-10-08). */
export const CORPUS_ENGINE_LAUNCH_DICTIONARY_CACHE_BYTES = 1024 * 1024 * 1024;
/** Upper bound accepted from configuration (4 GiB); anything larger is treated as a misconfiguration. */
export const CORPUS_ENGINE_MAX_DICTIONARY_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

export type ServableCorpusEngineGeneration = {
  generationId: string;
  logicalManifestSha256: string;
  /** The revocation history this generation was published with; a served list must contain it. */
  revocationAnchor: RevocationAnchor | null;
  /** The scoring-normalization identity of the generation (manifest processing.normalization). */
  normalization: ArtifactNormalizationIdentity;
  documents: number;
};

/** The 1M launch generation (Corpus Engine v1 1M checkpoint, accepted 2026-10-08). */
export const CORPUS_ENGINE_LAUNCH_GENERATION: ServableCorpusEngineGeneration = {
  generationId: "gen-661b4f55ffec338591224fca",
  logicalManifestSha256: "661b4f55ffec338591224fca5624d9865199a70450818b25339085ad934d1323",
  revocationAnchor: { sequence: 177, lineSha256: "9b752cbb6541845109c0d68854581b44f638ab0696242812078e4c934434d1d9" },
  normalization: {
    kind: "BUILT_UNDER",
    version: 2,
    proof: "manifest processing.normalization {turnitplus-scoring-normalization, v2, probe eb486c5bc300b5d7…}; every one of its 1,062,380 documents tokenizes identically under the keep-notes comparisonText",
  },
  documents: 1_062_380,
};

/** Generations a serving process may be configured to serve. A new generation needs its own reviewed entry. */
export const SERVABLE_CORPUS_ENGINE_GENERATIONS: readonly ServableCorpusEngineGeneration[] = [CORPUS_ENGINE_LAUNCH_GENERATION];

export type CorpusEngineDictionaryCacheSource = "configured" | "default" | "invalid-fallback";

export type CorpusEngineServingConfig =
  | {
      ok: true;
      storageRoot: string;
      generation: ServableCorpusEngineGeneration;
      dictionaryCacheBytes: number;
      dictionaryCacheSource: CorpusEngineDictionaryCacheSource;
    }
  | {
      ok: false;
      failureCode: "STORAGE_ROOT_UNSET" | "STORAGE_ROOT_NOT_ABSOLUTE" | "GENERATION_UNSET" | "GENERATION_NOT_SERVABLE";
      failureMessage: string;
    };

function setting(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The dictionary cache budget configuration asks for, or the library default when it asks for nothing valid. */
export function resolveCorpusEngineDictionaryCacheBytes(raw: string | null | undefined): { bytes: number; source: CorpusEngineDictionaryCacheSource } {
  if (raw === null || raw === undefined || raw.trim() === "") return { bytes: DEFAULT_DICTIONARY_CACHE_BYTES, source: "default" };
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) return { bytes: DEFAULT_DICTIONARY_CACHE_BYTES, source: "invalid-fallback" };
  const bytes = Number(text);
  if (!Number.isSafeInteger(bytes) || bytes > CORPUS_ENGINE_MAX_DICTIONARY_CACHE_BYTES) return { bytes: DEFAULT_DICTIONARY_CACHE_BYTES, source: "invalid-fallback" };
  return { bytes, source: "configured" };
}

/** Reads the serving configuration. Pure over `env` / `servable` (the defaults are the process's). */
export function resolveCorpusEngineServingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  servable: readonly ServableCorpusEngineGeneration[] = SERVABLE_CORPUS_ENGINE_GENERATIONS,
): CorpusEngineServingConfig {
  const storageRoot = setting(env, CORPUS_ENGINE_STORAGE_ROOT_ENV);
  if (storageRoot === null) return { ok: false, failureCode: "STORAGE_ROOT_UNSET", failureMessage: `${CORPUS_ENGINE_STORAGE_ROOT_ENV} is not set` };
  if (!path.isAbsolute(storageRoot)) return { ok: false, failureCode: "STORAGE_ROOT_NOT_ABSOLUTE", failureMessage: `${CORPUS_ENGINE_STORAGE_ROOT_ENV} must be an absolute directory` };
  const generationId = setting(env, CORPUS_ENGINE_GENERATION_ID_ENV);
  if (generationId === null) return { ok: false, failureCode: "GENERATION_UNSET", failureMessage: `${CORPUS_ENGINE_GENERATION_ID_ENV} is not set` };
  const generation = servable.find((candidate) => candidate.generationId === generationId);
  if (!generation) return { ok: false, failureCode: "GENERATION_NOT_SERVABLE", failureMessage: `generation ${generationId} is not a servable Corpus Engine generation` };
  const cache = resolveCorpusEngineDictionaryCacheBytes(setting(env, CORPUS_ENGINE_DICTIONARY_CACHE_BYTES_ENV));
  return { ok: true, storageRoot, generation, dictionaryCacheBytes: cache.bytes, dictionaryCacheSource: cache.source };
}

// One cache per process, sized by configuration; replaced only if the configured budget changes.
let processDictionaryCache: DictionaryBlockCache | null = null;

/** The process's dictionary cache for `bytes` (null when 0 = uncached). */
export function corpusEngineProcessDictionaryCache(bytes: number): DictionaryBlockCache | null {
  if (bytes === 0) return null;
  if (!processDictionaryCache || processDictionaryCache.maxBytes !== bytes) processDictionaryCache = new DictionaryBlockCache(bytes);
  return processDictionaryCache;
}

/** A passage of the existing verifier's admitted, co-source-attributed evidence, in selectiveCorpusEvidence's shape. */
export type CorpusEngineEvidenceSource = {
  /** `corpus-engine:<generationId>:<docId>` — unique across lanes and generations. */
  sourceId: string;
  docId: string;
  matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
};

export type CorpusEngineLaneDiagnostics = {
  dictionaryCacheBytes: number;
  dictionaryCacheSource: CorpusEngineDictionaryCacheSource;
};

export type CorpusEngineLaneResult =
  | { state: "DISABLED" }
  | { state: "UNAVAILABLE"; failureCode: string; failureMessage: string }
  | { state: "FAILED"; failureCode: string; failureMessage: string; identity: CorpusReaderIdentity | null; diagnostics: CorpusEngineLaneDiagnostics }
  | {
      state: "COMPLETE" | "PARTIAL";
      identity: CorpusReaderIdentity;
      /** Feed to computeUnifiedSimilarity({ selectiveCorpusEvidence }) to union with the other lanes. */
      evidence: CorpusEngineEvidenceSource[];
      verification: CorpusVerificationResult;
      diagnostics: CorpusEngineLaneDiagnostics;
    };

export type RunCorpusEngineLaneOptions = {
  /** Test seam: the storage to read instead of a local directory at the configured root. */
  store?: CorpusObjectStore;
  env?: Readonly<Record<string, string | undefined>>;
  servable?: readonly ServableCorpusEngineGeneration[];
};

/**
 * Runs the Corpus Engine lane over the report's text under the report's
 * scoring-normalization contract (the ambient one: call inside
 * runWithScoringNormalization). Never throws.
 */
export async function runCorpusEngineLane(submissionText: string, options: RunCorpusEngineLaneOptions = {}): Promise<CorpusEngineLaneResult> {
  if (!isCorpusEngineV1Enabled()) return { state: "DISABLED" };
  const config = resolveCorpusEngineServingConfig(options.env ?? process.env, options.servable ?? SERVABLE_CORPUS_ENGINE_GENERATIONS);
  if (!config.ok) return { state: "UNAVAILABLE", failureCode: config.failureCode, failureMessage: config.failureMessage };
  const reportVersion = currentScoringNormalizationVersion();
  const compatibility = artifactNormalizationCompatibility(reportVersion, config.generation.normalization);
  if (!compatibility.compatible) {
    return {
      state: "UNAVAILABLE",
      failureCode: "NORMALIZATION_INCOMPATIBLE",
      failureMessage: `generation ${config.generation.generationId} cannot be read under scoring normalization v${reportVersion}: ${compatibility.reason} (${compatibility.detail})`,
    };
  }
  const diagnostics: CorpusEngineLaneDiagnostics = { dictionaryCacheBytes: config.dictionaryCacheBytes, dictionaryCacheSource: config.dictionaryCacheSource };
  const store = options.store ?? new LocalDirectoryObjectStore(config.storageRoot);
  try {
    const dictionaryCache = corpusEngineProcessDictionaryCache(config.dictionaryCacheBytes);
    const response = await runCorpusEngineCandidateVerification({
      store,
      generationId: config.generation.generationId,
      logicalManifestSha256: config.generation.logicalManifestSha256,
      revocationAnchor: config.generation.revocationAnchor,
      submissionText,
      ...(dictionaryCache ? { dictionaryCache } : { dictionaryCacheBytes: 0 }),
    });
    if (response.state === "DISABLED") return { state: "DISABLED" };
    if (response.state === "FAILED") return { state: "FAILED", failureCode: response.failureCode, failureMessage: response.failureMessage, identity: response.identity, diagnostics };
    const generationId = response.identity.generationId;
    return {
      state: response.state,
      identity: response.identity,
      evidence: response.verification.verifiedSources.map((source) => ({
        sourceId: `corpus-engine:${generationId}:${source.docId}`,
        docId: source.docId,
        matchedPassages: source.matchedPassages,
      })),
      verification: response.verification,
      diagnostics,
    };
  } catch (error) {
    return { state: "FAILED", failureCode: "UNEXPECTED", failureMessage: error instanceof Error ? error.message : String(error), identity: null, diagnostics };
  } finally {
    if (!options.store) await store.close().catch(() => undefined);
  }
}
