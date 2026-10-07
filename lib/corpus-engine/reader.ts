import {
  CorpusGenerationError,
  DF_HIGH_FILE,
  generationPrefix,
  HighDocumentFrequencyTable,
  loadGenerationManifest,
  segmentPrefix,
  type GenerationManifest,
} from "./generation";
import { DEFAULT_DICTIONARY_CACHE_BYTES, DictionaryBlockCache } from "./dictionary-cache";
import { docIdToDecimal, partitionOfDocId } from "./ids";
import type { RecordReadMetrics } from "./record-pack";
import { CorpusRevocationError, RevocationList, type RevocationAnchor } from "./revocation";
import { CorpusSegmentError, SegmentReader, toSegmentError, type SegmentFailureCode, type SegmentVerifyLevel } from "./segment";
import type { CorpusObjectStore } from "./storage";
import { sha256Hex } from "./bytes";
import { processingIdentityMismatches } from "./versions";

/**
 * Corpus Engine v1 — a reader PINNED to one corpus generation.
 *
 * A reader is opened for an explicit generation id and never looks at
 * anything that generation's manifest does not name. Every result it produces
 * carries the same identity (CorpusReaderIdentity): generation id, logical
 * manifest hash, and the revocation epoch applied — so candidate retrieval,
 * source-text fetch, the verifier adapter and the final result metadata can
 * all be shown to have used the same corpus, and any cache keyed on that
 * identity is correct by construction.
 *
 * Opening fails CLOSED on: an unknown or tampered manifest, a processing
 * identity this build cannot reproduce, and a missing/broken revocation list.
 * A segment that cannot be opened does NOT fail the open: it is recorded, and
 * every query that needed it reports PARTIAL. (Publication validation, by
 * contrast, refuses a generation with any unopenable segment.)
 */

export type CorpusReaderIdentity = {
  generationId: string;
  logicalManifestSha256: string;
  revocationEpoch: string;
};

export type SegmentSlot = {
  partition: number;
  segmentId: string;
  reader: SegmentReader | null;
  failure: { code: SegmentFailureCode; artifact: string; message: string } | null;
  /** Ordinals of revoked documents in this segment (empty for almost every segment). */
  revokedOrdinals: Set<number>;
};

export type DocumentLocation = { partition: number; segmentId: string; slot: SegmentSlot; ordinal: number };

export type TextFetchResult =
  | { state: "OK"; docId: string; text: string; metrics: RecordReadMetrics; location: { partition: number; segmentId: string; ordinal: number }; identity: CorpusReaderIdentity }
  | { state: "REVOKED"; docId: string; identity: CorpusReaderIdentity }
  | { state: "NOT_FOUND"; docId: string; identity: CorpusReaderIdentity }
  | { state: "FAILED"; docId: string; failure: { partition: number; segmentId: string | null; artifact: string; code: string; message: string }; identity: CorpusReaderIdentity };

export class CorpusGenerationReader {
  private constructor(
    readonly store: CorpusObjectStore,
    readonly generationId: string,
    readonly logicalManifestSha256: string,
    readonly manifest: GenerationManifest,
    readonly revocations: RevocationList,
    readonly slots: SegmentSlot[],
    /** null when df-high.bin could not be loaded; `highDfFailure` says why. */
    readonly highDf: HighDocumentFrequencyTable | null,
    readonly highDfFailure: string | null,
    /** The dictionary block cache this reader serves through; null when it runs uncached (dictionaryCacheBytes 0). */
    readonly dictionaryCache: DictionaryBlockCache | null,
  ) {}

  static async open(options: {
    store: CorpusObjectStore;
    generationId: string;
    /** When given, the manifest must hash to exactly this (a request-carried pin). */
    expectedLogicalManifestSha256?: string;
    verify?: SegmentVerifyLevel;
    /** Held outside the list (e.g. from the activation pointer): the list must contain this history. */
    revocationAnchor?: RevocationAnchor | null;
    /** Legacy per-segment decoded-block cache, used only when the reader runs without a dictionary cache. */
    dictionaryBlockCacheBlocks?: number;
    /**
     * A dictionary cache the caller owns and may hand from one generation to
     * the next: opening binds it to THIS generation, which empties it if it
     * served another.
     */
    dictionaryCache?: DictionaryBlockCache;
    /** Without `dictionaryCache`: the byte budget of a cache this reader creates for itself. 0 = no cache. */
    dictionaryCacheBytes?: number;
  }): Promise<CorpusGenerationReader> {
    const { store, generationId } = options;
    const { manifest, logicalManifestSha256 } = await loadGenerationManifest(store, generationId);
    if (options.expectedLogicalManifestSha256 && options.expectedLogicalManifestSha256 !== logicalManifestSha256) {
      throw new CorpusGenerationError("GENERATION_PIN_MISMATCH", `generation ${generationId} does not have the logical manifest hash the request pinned`);
    }
    const mismatches = processingIdentityMismatches(manifest.processing);
    if (mismatches.length > 0) {
      throw new CorpusGenerationError("UNSUPPORTED_PROCESSING_IDENTITY", `generation ${generationId} cannot be served by this build: ${mismatches.join("; ")}`);
    }
    const cacheIdentity = DictionaryBlockCache.identityOf(generationId, logicalManifestSha256);
    let dictionaryCache: DictionaryBlockCache | null = null;
    if (options.dictionaryCache) dictionaryCache = options.dictionaryCache;
    else if ((options.dictionaryCacheBytes ?? DEFAULT_DICTIONARY_CACHE_BYTES) > 0) dictionaryCache = new DictionaryBlockCache(options.dictionaryCacheBytes ?? DEFAULT_DICTIONARY_CACHE_BYTES);
    dictionaryCache?.bind(cacheIdentity);
    const sharedDictionaryCache = dictionaryCache ? { cache: dictionaryCache, identity: cacheIdentity } : null;
    let revocations: RevocationList;
    try {
      revocations = await RevocationList.load(store, options.revocationAnchor ?? null);
    } catch (error) {
      if (error instanceof CorpusRevocationError) throw new CorpusGenerationError(error.code, error.message);
      throw error;
    }

    const slots: SegmentSlot[] = [];
    for (const partition of manifest.partitions) {
      for (const segmentId of partition.segmentIds) {
        const slot: SegmentSlot = { partition: partition.partition, segmentId, reader: null, failure: null, revokedOrdinals: new Set() };
        try {
          slot.reader = await SegmentReader.open(store, segmentPrefix(segmentId), segmentId, manifest.segments[segmentId].manifestSha256, {
            verify: options.verify ?? "size",
            dictionaryBlockCacheBlocks: options.dictionaryBlockCacheBlocks,
            sharedDictionaryCache,
          });
        } catch (error) {
          const failure = error instanceof CorpusSegmentError ? error : toSegmentError(error, "segment");
          slot.failure = { code: failure.code, artifact: failure.artifact, message: failure.message };
        }
        slots.push(slot);
      }
    }
    for (const docId of revocations.docIds()) {
      const partition = partitionOfDocId(docId, manifest.partitionBits);
      for (const slot of slots) {
        if (slot.partition !== partition || !slot.reader) continue;
        const ordinal = slot.reader.ordinalOf(docId);
        if (ordinal >= 0) slot.revokedOrdinals.add(ordinal);
      }
    }

    let highDf: HighDocumentFrequencyTable | null = null;
    let highDfFailure: string | null = null;
    try {
      const recorded = manifest.documentFrequency.files[DF_HIGH_FILE];
      const bytes = await store.readAll(`${generationPrefix(generationId)}/${DF_HIGH_FILE}`);
      if (!recorded || bytes.length !== recorded.bytes || sha256Hex(bytes) !== recorded.sha256) throw new CorpusGenerationError("DF_ARTIFACT_CORRUPT", "df-high.bin does not match its recorded hash");
      highDf = HighDocumentFrequencyTable.parse(bytes);
    } catch (error) {
      highDfFailure = error instanceof Error ? error.message : String(error);
    }

    return new CorpusGenerationReader(store, generationId, logicalManifestSha256, manifest, revocations, slots, highDf, highDfFailure, dictionaryCache);
  }

  identity(): CorpusReaderIdentity {
    return { generationId: this.generationId, logicalManifestSha256: this.logicalManifestSha256, revocationEpoch: this.revocations.epoch };
  }

  get partitionCount() {
    return 1 << this.manifest.partitionBits;
  }

  slotsOfPartition(partition: number): SegmentSlot[] {
    return this.slots.filter((slot) => slot.partition === partition);
  }

  /** Where `docId` lives in this generation; null when no OPEN segment holds it. */
  locate(docId: bigint): DocumentLocation | null {
    const partition = partitionOfDocId(docId, this.manifest.partitionBits);
    for (const slot of this.slots) {
      if (slot.partition !== partition || !slot.reader) continue;
      const ordinal = slot.reader.ordinalOf(docId);
      if (ordinal >= 0) return { partition, segmentId: slot.segmentId, slot, ordinal };
    }
    return null;
  }

  /** True when a segment of `docId`'s partition could not be opened — "not found" there is not trustworthy. */
  private partitionDegraded(docId: bigint): SegmentSlot | null {
    const partition = partitionOfDocId(docId, this.manifest.partitionBits);
    return this.slots.find((slot) => slot.partition === partition && !slot.reader) ?? null;
  }

  /**
   * One candidate's source text: one row read + one span read, decoded and
   * hash-checked. A revoked document is refused BEFORE any pack is touched.
   */
  async fetchText(docId: bigint): Promise<TextFetchResult> {
    const identity = this.identity();
    const decimal = docIdToDecimal(docId);
    if (this.revocations.has(docId)) return { state: "REVOKED", docId: decimal, identity };
    const location = this.locate(docId);
    if (!location) {
      const degraded = this.partitionDegraded(docId);
      if (degraded) {
        return {
          state: "FAILED",
          docId: decimal,
          identity,
          failure: { partition: degraded.partition, segmentId: degraded.segmentId, artifact: degraded.failure?.artifact ?? "segment", code: degraded.failure?.code ?? "UNREADABLE", message: degraded.failure?.message ?? "segment unavailable" },
        };
      }
      return { state: "NOT_FOUND", docId: decimal, identity };
    }
    try {
      const { text, metrics } = await (location.slot.reader as SegmentReader).readText(location.ordinal);
      return { state: "OK", docId: decimal, text, metrics, location: { partition: location.partition, segmentId: location.segmentId, ordinal: location.ordinal }, identity };
    } catch (error) {
      const failure = toSegmentError(error, "text");
      return { state: "FAILED", docId: decimal, identity, failure: { partition: location.partition, segmentId: location.segmentId, artifact: failure.artifact, code: failure.code, message: failure.message } };
    }
  }

  /**
   * A document's metadata + provenance, with the identities that are a
   * property of WHERE it is stored rather than of the record: generation,
   * segment, and the source-text-pack locator. Aliases recorded later, in
   * other segments' addenda, are merged in.
   */
  async fetchMetadata(docId: bigint): Promise<
    | { state: "OK"; metadata: Record<string, unknown>; laterAliases: unknown[]; location: { generationId: string; partition: number; segmentId: string; ordinal: number; textPack: { base: string; recordNumber: number } } }
    | { state: "REVOKED" | "NOT_FOUND" | "FAILED"; message?: string }
  > {
    if (this.revocations.has(docId)) return { state: "REVOKED" };
    const location = this.locate(docId);
    if (!location) return this.partitionDegraded(docId) ? { state: "FAILED", message: "a segment of this document's partition is unavailable" } : { state: "NOT_FOUND" };
    try {
      const { metadata } = await (location.slot.reader as SegmentReader).readMetadata(location.ordinal);
      const decimal = docIdToDecimal(docId);
      const laterAliases: unknown[] = [];
      for (const slot of this.slots) {
        if (slot.partition !== location.partition || !slot.reader || slot.reader.manifest.aliasAddendumCount === 0) continue;
        for (const addendum of await slot.reader.readAliasAddenda()) if (addendum.docId === decimal) laterAliases.push(addendum.alias);
      }
      return {
        state: "OK",
        metadata: metadata as Record<string, unknown>,
        laterAliases,
        location: { generationId: this.generationId, partition: location.partition, segmentId: location.segmentId, ordinal: location.ordinal, textPack: { base: "text", recordNumber: location.ordinal } },
      };
    } catch (error) {
      return { state: "FAILED", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Every (docId) of the generation's OPEN segments, partition by partition — for the exhaustive reference only. */
  *allDocumentIds(): Generator<bigint> {
    for (const slot of this.slots) {
      if (!slot.reader) continue;
      for (let ordinal = 0; ordinal < slot.reader.documentCount; ordinal += 1) {
        if (!slot.revokedOrdinals.has(ordinal)) yield slot.reader.docIds[ordinal];
      }
    }
  }
}
