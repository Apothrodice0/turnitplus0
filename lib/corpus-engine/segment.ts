import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ByteReader, ByteWriter, CorpusIntegrityError, decodePostings, encodePostings, readUint48BE, sha256Hex, writeUint48BE, type Bytes } from "./bytes";
import { compactDictionaryBlock, findInCompactBlock, keyHalves, type DictionaryBlockCache } from "./dictionary-cache";
import { fingerprintToHex } from "./ids";
import { readPackedRecord, type RecordReadMetrics } from "./record-pack";
import { CorpusStorageError, type CorpusObjectStore } from "./storage";
import { INDEX_FORMAT_VERSION } from "./versions";

/**
 * Corpus Engine v1 — index-segment-v1: one immutable inverted-index segment.
 *
 *   fingerprint (uint64)  ->  sorted segment-local document ordinals (uint32)
 *
 * A segment is a small, FIXED set of files regardless of how many fingerprints
 * it holds. Logical buckets are dictionary BLOCKS inside one file, never one
 * file per bucket:
 *
 *   dict.bin      blocks of `blockEntries` keys, ascending. Per block:
 *                 [entryCount u16][payloadLength u32][crc32 u32][payload]
 *                 (crc32 covers the entry count and the payload)
 *                 payload = firstKey u64, then per entry
 *                   (key delta varint, entries after the first) (df varint) (postingsLength varint)
 *   dict.idx      one 24-byte row per block, resident in the reader:
 *                 firstKey u64 | blockOffset u48 | blockLength u32 | postingsOffset u48
 *   postings.bin  the postings lists back to back (postings-delta-varint-v1)
 *   docs.bin      one 16-byte row per ordinal: docId u64 | tokenCount u32 | fingerprintCount u32
 *
 * Ordinals are assigned in ascending document-id order, so a segment's bytes
 * depend only on WHICH documents and fingerprints it holds, never on the order
 * they were ingested in.
 *
 * A lookup is: binary-search the resident block index, range-read the few
 * blocks that can hold the query keys, range-read the postings those entries
 * point at. Nothing scans the dictionary and nothing scans the documents.
 */

export const DICT_MAGIC = "TPDI";
export const DICT_INDEX_MAGIC = "TPDX";
export const POSTINGS_MAGIC = "TPPO";
export const DOCS_MAGIC = "TPDO";
export const SEGMENT_FORMAT_NUMBER = 1;
export const DICT_HEADER_BYTES = 32;
export const DICT_INDEX_HEADER_BYTES = 16;
export const DICT_INDEX_ROW_BYTES = 24;
export const POSTINGS_HEADER_BYTES = 16;
export const DOCS_HEADER_BYTES = 16;
export const DOCS_ROW_BYTES = 16;
export const DICT_BLOCK_HEADER_BYTES = 10;
export const DEFAULT_DICTIONARY_BLOCK_ENTRIES = 128;

export const SEGMENT_FILE_DICT = "dict.bin";
export const SEGMENT_FILE_DICT_INDEX = "dict.idx";
export const SEGMENT_FILE_POSTINGS = "postings.bin";
export const SEGMENT_FILE_DOCS = "docs.bin";
export const SEGMENT_FILE_ALIASES = "aliases.jsonl";
export const SEGMENT_FILE_MANIFEST = "segment.json";
export const TEXT_PACK_BASE = "text";
export const META_PACK_BASE = "meta";

/** Exact counts for df 1..DF_EXACT_BUCKETS, then one bucket per power of two. */
export const DF_EXACT_BUCKETS = 64;
export const TOP_FINGERPRINTS_KEPT = 50;

export type DocumentFrequencyHistogram = {
  /** exact[i] = number of fingerprints with df === i + 1, for df 1..64. */
  exact: number[];
  /** log2[k] = number of fingerprints with 2^k <= df < 2^(k+1), for df > 64. */
  log2: Record<string, number>;
};

export function emptyDfHistogram(): DocumentFrequencyHistogram {
  return { exact: new Array<number>(DF_EXACT_BUCKETS).fill(0), log2: {} };
}

export function addToDfHistogram(histogram: DocumentFrequencyHistogram, df: number) {
  if (df <= DF_EXACT_BUCKETS) histogram.exact[df - 1] += 1;
  else {
    const bucket = String(Math.floor(Math.log2(df)));
    histogram.log2[bucket] = (histogram.log2[bucket] ?? 0) + 1;
  }
}

/** Keeps the `limit` highest-df fingerprints seen (ties: lower fingerprint first). */
export class TopFingerprints {
  private entries: Array<{ fingerprint: bigint; df: number }> = [];
  private floor = 0;
  constructor(private readonly limit = TOP_FINGERPRINTS_KEPT) {}

  offer(fingerprint: bigint, df: number) {
    if (this.entries.length >= this.limit && df <= this.floor) return;
    this.entries.push({ fingerprint, df });
    if (this.entries.length > this.limit * 4) this.trim();
  }

  private trim() {
    this.entries.sort((left, right) => right.df - left.df || (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0));
    this.entries.length = Math.min(this.entries.length, this.limit);
    this.floor = this.entries.length >= this.limit ? this.entries[this.entries.length - 1].df : 0;
  }

  result(): Array<{ fingerprint: string; df: number }> {
    this.trim();
    return this.entries.map((entry) => ({ fingerprint: fingerprintToHex(entry.fingerprint), df: entry.df }));
  }
}

export type SegmentIndexStats = {
  keyCount: number;
  postingsCount: number;
  maxPostingsLength: number;
  blockCount: number;
  dictionaryBytes: number;
  dictionaryIndexBytes: number;
  postingsBytes: number;
  dfHistogram: DocumentFrequencyHistogram;
  topFingerprints: Array<{ fingerprint: string; df: number }>;
};

/** Streams an ascending (fingerprint, ordinals) sequence into dict.bin / dict.idx / postings.bin. */
export class SegmentIndexWriter {
  private readonly dictDescriptor: number;
  private readonly indexDescriptor: number;
  private readonly postingsDescriptor: number;
  private readonly block = new ByteWriter(4096);
  private readonly postingsBuffer = new ByteWriter(1 << 16);
  private readonly scratch = new ByteWriter(256);
  private blockEntryCount = 0;
  private blockFirstKey = BigInt(0);
  private blockPostingsOffset = 0;
  private previousKey = BigInt(-1);
  private dictOffset = DICT_HEADER_BYTES;
  private postingsOffset = POSTINGS_HEADER_BYTES;
  private keyCount = 0;
  private postingsCount = 0;
  private maxPostingsLength = 0;
  private blockCount = 0;
  private readonly histogram = emptyDfHistogram();
  private readonly top = new TopFingerprints();

  constructor(directory: string, private readonly blockEntries: number = DEFAULT_DICTIONARY_BLOCK_ENTRIES) {
    if (!Number.isInteger(blockEntries) || blockEntries < 1 || blockEntries > 0xffff) throw new RangeError("blockEntries must be in [1, 65535]");
    this.dictDescriptor = openSync(path.join(directory, SEGMENT_FILE_DICT), "w");
    this.indexDescriptor = openSync(path.join(directory, SEGMENT_FILE_DICT_INDEX), "w");
    this.postingsDescriptor = openSync(path.join(directory, SEGMENT_FILE_POSTINGS), "w");
    writeSync(this.dictDescriptor, Buffer.alloc(DICT_HEADER_BYTES));
    writeSync(this.indexDescriptor, Buffer.alloc(DICT_INDEX_HEADER_BYTES));
    const postingsHeader = Buffer.alloc(POSTINGS_HEADER_BYTES);
    postingsHeader.write(POSTINGS_MAGIC, 0, "latin1");
    postingsHeader.writeUInt16BE(SEGMENT_FORMAT_NUMBER, 4);
    writeSync(this.postingsDescriptor, postingsHeader);
  }

  /** `ordinals` must be strictly increasing; `fingerprint` strictly greater than the previous call's. */
  addKey(fingerprint: bigint, ordinals: ArrayLike<number>) {
    if (fingerprint <= this.previousKey) throw new RangeError("segment keys must be added in strictly increasing order");
    if (ordinals.length === 0) throw new RangeError("a segment key needs at least one posting");
    this.scratch.reset();
    encodePostings(ordinals, this.scratch);
    const postingsLength = this.scratch.length;

    if (this.blockEntryCount === 0) {
      this.blockFirstKey = fingerprint;
      this.blockPostingsOffset = this.postingsOffset;
      this.block.writeUint64BE(fingerprint);
    } else {
      this.block.writeVarintBig(fingerprint - this.previousKey);
    }
    this.block.writeVarint(ordinals.length);
    this.block.writeVarint(postingsLength);
    this.blockEntryCount += 1;
    this.previousKey = fingerprint;

    this.postingsBuffer.writeBytes(this.scratch.toBuffer());
    this.postingsOffset += postingsLength;
    if (this.postingsBuffer.length >= 1 << 20) this.flushPostings();

    this.keyCount += 1;
    this.postingsCount += ordinals.length;
    if (ordinals.length > this.maxPostingsLength) this.maxPostingsLength = ordinals.length;
    addToDfHistogram(this.histogram, ordinals.length);
    this.top.offer(fingerprint, ordinals.length);
    if (this.blockEntryCount >= this.blockEntries) this.flushBlock();
  }

  private flushPostings() {
    if (this.postingsBuffer.length === 0) return;
    writeSync(this.postingsDescriptor, this.postingsBuffer.toBuffer());
    this.postingsBuffer.reset();
  }

  private flushBlock() {
    if (this.blockEntryCount === 0) return;
    const payload = this.block.toBuffer();
    const header = Buffer.alloc(DICT_BLOCK_HEADER_BYTES);
    header.writeUInt16BE(this.blockEntryCount, 0);
    header.writeUInt32BE(payload.length, 2);
    header.writeUInt32BE(zlib.crc32(payload, zlib.crc32(header.subarray(0, 2))) >>> 0, 6);
    writeSync(this.dictDescriptor, header);
    writeSync(this.dictDescriptor, payload);
    const blockLength = header.length + payload.length;

    const row = Buffer.alloc(DICT_INDEX_ROW_BYTES);
    row.writeBigUInt64BE(this.blockFirstKey, 0);
    writeUint48BE(row, 8, this.dictOffset);
    row.writeUInt32BE(blockLength, 14);
    writeUint48BE(row, 18, this.blockPostingsOffset);
    writeSync(this.indexDescriptor, row);

    this.dictOffset += blockLength;
    this.blockCount += 1;
    this.blockEntryCount = 0;
    this.block.reset();
  }

  finish(): SegmentIndexStats {
    this.flushBlock();
    this.flushPostings();

    const dictHeader = Buffer.alloc(DICT_HEADER_BYTES);
    dictHeader.write(DICT_MAGIC, 0, "latin1");
    dictHeader.writeUInt16BE(SEGMENT_FORMAT_NUMBER, 4);
    dictHeader.writeUInt16BE(this.blockEntries, 6);
    dictHeader.writeBigUInt64BE(BigInt(this.keyCount), 8);
    dictHeader.writeUInt32BE(this.blockCount, 16);
    dictHeader.writeBigUInt64BE(BigInt(this.postingsCount), 20);
    writeSync(this.dictDescriptor, dictHeader, 0, dictHeader.length, 0);

    const indexHeader = Buffer.alloc(DICT_INDEX_HEADER_BYTES);
    indexHeader.write(DICT_INDEX_MAGIC, 0, "latin1");
    indexHeader.writeUInt16BE(SEGMENT_FORMAT_NUMBER, 4);
    indexHeader.writeUInt16BE(DICT_INDEX_ROW_BYTES, 6);
    indexHeader.writeUInt32BE(this.blockCount, 8);
    writeSync(this.indexDescriptor, indexHeader, 0, indexHeader.length, 0);

    for (const descriptor of [this.dictDescriptor, this.indexDescriptor, this.postingsDescriptor]) {
      fsyncSync(descriptor);
      closeSync(descriptor);
    }
    return {
      keyCount: this.keyCount,
      postingsCount: this.postingsCount,
      maxPostingsLength: this.maxPostingsLength,
      blockCount: this.blockCount,
      dictionaryBytes: this.dictOffset,
      dictionaryIndexBytes: DICT_INDEX_HEADER_BYTES + this.blockCount * DICT_INDEX_ROW_BYTES,
      postingsBytes: this.postingsOffset,
      dfHistogram: this.histogram,
      topFingerprints: this.top.result(),
    };
  }
}

export type SegmentDocumentRow = { docId: bigint; tokenCount: number; fingerprintCount: number };

export function encodeDocsFile(rows: readonly SegmentDocumentRow[]): Bytes {
  const bytes = Buffer.alloc(DOCS_HEADER_BYTES + rows.length * DOCS_ROW_BYTES);
  bytes.write(DOCS_MAGIC, 0, "latin1");
  bytes.writeUInt16BE(SEGMENT_FORMAT_NUMBER, 4);
  bytes.writeUInt16BE(DOCS_ROW_BYTES, 6);
  bytes.writeUInt32BE(rows.length, 8);
  let previous = BigInt(-1);
  rows.forEach((row, ordinal) => {
    if (row.docId <= previous) throw new RangeError("segment documents must be in strictly increasing document-id order");
    previous = row.docId;
    const offset = DOCS_HEADER_BYTES + ordinal * DOCS_ROW_BYTES;
    bytes.writeBigUInt64BE(row.docId, offset);
    bytes.writeUInt32BE(row.tokenCount, offset + 8);
    bytes.writeUInt32BE(row.fingerprintCount, offset + 12);
  });
  return bytes;
}

export type SegmentFileEntry = { bytes: number; sha256: string };

/** segment.json — everything a reader needs to open and check a segment. */
export type SegmentManifest = {
  segmentFormat: string;
  partition: number;
  partitionBits: number;
  documentCount: number;
  tokenCount: number;
  keyCount: number;
  postingsCount: number;
  maxPostingsLength: number;
  blockEntries: number;
  blockCount: number;
  /** Decimal strings; null for a segment that only carries alias addenda. */
  docIdMin: string | null;
  docIdMax: string | null;
  textPackCount: number;
  textUncompressedBytes: number;
  metaPackCount: number;
  aliasAddendumCount: number;
  dfHistogram: DocumentFrequencyHistogram;
  topFingerprints: Array<{ fingerprint: string; df: number }>;
  /** Every file of the segment except segment.json itself. */
  files: Record<string, SegmentFileEntry>;
};

export type SegmentFailureCode = "MISSING" | "UNREADABLE" | "CORRUPT" | "INTEGRITY_MISMATCH" | "UNSUPPORTED";

export class CorpusSegmentError extends Error {
  readonly code: SegmentFailureCode;
  readonly artifact: string;
  constructor(code: SegmentFailureCode, artifact: string, message: string) {
    super(message);
    this.name = "CorpusSegmentError";
    this.code = code;
    this.artifact = artifact;
  }
}

/** Turns any read/decode error on `artifact` into a coded segment failure. */
export function toSegmentError(error: unknown, artifact: string): CorpusSegmentError {
  if (error instanceof CorpusSegmentError) return error;
  if (error instanceof CorpusStorageError) {
    const code: SegmentFailureCode = error.code === "NOT_FOUND" ? "MISSING" : error.code === "SHORT_READ" ? "CORRUPT" : "UNREADABLE";
    return new CorpusSegmentError(code, artifact, error.message);
  }
  if (error instanceof CorpusIntegrityError) {
    return new CorpusSegmentError(error.code === "RECORD_HASH_MISMATCH" ? "INTEGRITY_MISMATCH" : "CORRUPT", artifact, `${error.code}: ${error.message}`);
  }
  return new CorpusSegmentError("UNREADABLE", artifact, error instanceof Error ? error.message : String(error));
}

export type DictionaryHit = { fingerprint: bigint; df: number; postingsOffset: number; postingsLength: number };

export type SegmentReadCounters = {
  dictionaryBlocksRead: number;
  dictionaryBlockCacheHits: number;
  dictionaryBytesRead: number;
  postingsBytesRead: number;
  postingsListsDecoded: number;
  postingsDecoded: number;
  rangeReads: number;
};

export type SegmentVerifyLevel = "size" | "sha256";

type DecodedBlock = { keys: bigint[]; dfs: Uint32Array; offsets: Float64Array; lengths: Uint32Array };

/** A generation-bound cache shared by every segment of one reader (see ./dictionary-cache.ts). */
export type SharedDictionaryCache = { cache: DictionaryBlockCache; identity: string };

const RANGE_COALESCE_GAP_BYTES = 4096;
const RANGE_COALESCE_MAX_BYTES = 4 * 1024 * 1024;

export class SegmentReader {
  readonly counters: SegmentReadCounters = {
    dictionaryBlocksRead: 0,
    dictionaryBlockCacheHits: 0,
    dictionaryBytesRead: 0,
    postingsBytesRead: 0,
    postingsListsDecoded: 0,
    postingsDecoded: 0,
    rangeReads: 0,
  };
  private readonly blockCache = new Map<number, DecodedBlock>();
  private sharedCache: SharedDictionaryCache | null = null;

  private constructor(
    private readonly store: CorpusObjectStore,
    readonly prefix: string,
    readonly segmentId: string,
    readonly manifest: SegmentManifest,
    readonly docIds: BigUint64Array,
    readonly tokenCounts: Uint32Array,
    readonly fingerprintCounts: Uint32Array,
    private readonly blockFirstKeys: BigUint64Array,
    private readonly blockOffsets: Float64Array,
    private readonly blockLengths: Uint32Array,
    private readonly blockPostingsOffsets: Float64Array,
    private readonly blockCacheLimit: number,
  ) {}

  get documentCount() {
    return this.manifest.documentCount;
  }

  /**
   * Opens a segment named by a generation manifest. `expectedManifestSha256`
   * pins segment.json itself; every other file is then checked against the
   * table inside it — by size ("size"), or by size and full hash ("sha256").
   * dict.idx and docs.bin are read whole and always hash-checked, because the
   * reader keeps them resident and answers from them.
   */
  static async open(
    store: CorpusObjectStore,
    prefix: string,
    segmentId: string,
    expectedManifestSha256: string,
    options: { verify?: SegmentVerifyLevel; dictionaryBlockCacheBlocks?: number; sharedDictionaryCache?: SharedDictionaryCache | null } = {},
  ): Promise<SegmentReader> {
    const verify = options.verify ?? "size";
    let manifest: SegmentManifest;
    try {
      const manifestBytes = await store.readAll(`${prefix}/${SEGMENT_FILE_MANIFEST}`);
      if (sha256Hex(manifestBytes) !== expectedManifestSha256) {
        throw new CorpusSegmentError("INTEGRITY_MISMATCH", SEGMENT_FILE_MANIFEST, `segment ${segmentId}: segment.json does not match the hash its generation recorded`);
      }
      manifest = JSON.parse(manifestBytes.toString("utf8")) as SegmentManifest;
    } catch (error) {
      throw toSegmentError(error, SEGMENT_FILE_MANIFEST);
    }
    if (manifest.segmentFormat !== INDEX_FORMAT_VERSION) {
      throw new CorpusSegmentError("UNSUPPORTED", SEGMENT_FILE_MANIFEST, `segment ${segmentId}: index format ${manifest.segmentFormat} is not supported`);
    }

    const resident = new Map<string, Bytes>();
    for (const [name, entry] of Object.entries(manifest.files)) {
      const wholeRead = verify === "sha256" || name === SEGMENT_FILE_DICT_INDEX || name === SEGMENT_FILE_DOCS;
      try {
        if (wholeRead) {
          const bytes = await store.readAll(`${prefix}/${name}`);
          if (bytes.length !== entry.bytes) throw new CorpusSegmentError("CORRUPT", name, `segment ${segmentId}: ${name} is ${bytes.length} bytes, manifest says ${entry.bytes}`);
          if (sha256Hex(bytes) !== entry.sha256) throw new CorpusSegmentError("INTEGRITY_MISMATCH", name, `segment ${segmentId}: ${name} does not match its recorded hash`);
          if (name === SEGMENT_FILE_DICT_INDEX || name === SEGMENT_FILE_DOCS) resident.set(name, bytes);
        } else {
          const size = await store.size(`${prefix}/${name}`);
          if (size !== entry.bytes) throw new CorpusSegmentError("CORRUPT", name, `segment ${segmentId}: ${name} is ${size} bytes, manifest says ${entry.bytes}`);
        }
      } catch (error) {
        throw toSegmentError(error, name);
      }
    }

    const docsBytes = resident.get(SEGMENT_FILE_DOCS);
    const indexBytes = resident.get(SEGMENT_FILE_DICT_INDEX);
    if (!docsBytes || !indexBytes) throw new CorpusSegmentError("CORRUPT", SEGMENT_FILE_MANIFEST, `segment ${segmentId}: manifest lists no ${SEGMENT_FILE_DOCS} / ${SEGMENT_FILE_DICT_INDEX}`);

    if (docsBytes.toString("latin1", 0, 4) !== DOCS_MAGIC || docsBytes.readUInt16BE(4) !== SEGMENT_FORMAT_NUMBER) {
      throw new CorpusSegmentError("UNSUPPORTED", SEGMENT_FILE_DOCS, `segment ${segmentId}: docs.bin header is not format ${SEGMENT_FORMAT_NUMBER}`);
    }
    const documentCount = docsBytes.readUInt32BE(8);
    if (documentCount !== manifest.documentCount || docsBytes.length !== DOCS_HEADER_BYTES + documentCount * DOCS_ROW_BYTES) {
      throw new CorpusSegmentError("CORRUPT", SEGMENT_FILE_DOCS, `segment ${segmentId}: docs.bin disagrees with the manifest's document count`);
    }
    const docIds = new BigUint64Array(documentCount);
    const tokenCounts = new Uint32Array(documentCount);
    const fingerprintCounts = new Uint32Array(documentCount);
    for (let ordinal = 0; ordinal < documentCount; ordinal += 1) {
      const offset = DOCS_HEADER_BYTES + ordinal * DOCS_ROW_BYTES;
      docIds[ordinal] = docsBytes.readBigUInt64BE(offset);
      tokenCounts[ordinal] = docsBytes.readUInt32BE(offset + 8);
      fingerprintCounts[ordinal] = docsBytes.readUInt32BE(offset + 12);
      if (ordinal > 0 && docIds[ordinal] <= docIds[ordinal - 1]) {
        throw new CorpusSegmentError("CORRUPT", SEGMENT_FILE_DOCS, `segment ${segmentId}: docs.bin is not in increasing document-id order`);
      }
    }

    if (indexBytes.toString("latin1", 0, 4) !== DICT_INDEX_MAGIC || indexBytes.readUInt16BE(4) !== SEGMENT_FORMAT_NUMBER) {
      throw new CorpusSegmentError("UNSUPPORTED", SEGMENT_FILE_DICT_INDEX, `segment ${segmentId}: dict.idx header is not format ${SEGMENT_FORMAT_NUMBER}`);
    }
    const blockCount = indexBytes.readUInt32BE(8);
    if (blockCount !== manifest.blockCount || indexBytes.length !== DICT_INDEX_HEADER_BYTES + blockCount * DICT_INDEX_ROW_BYTES) {
      throw new CorpusSegmentError("CORRUPT", SEGMENT_FILE_DICT_INDEX, `segment ${segmentId}: dict.idx disagrees with the manifest's block count`);
    }
    const blockFirstKeys = new BigUint64Array(blockCount);
    const blockOffsets = new Float64Array(blockCount);
    const blockLengths = new Uint32Array(blockCount);
    const blockPostingsOffsets = new Float64Array(blockCount);
    for (let block = 0; block < blockCount; block += 1) {
      const offset = DICT_INDEX_HEADER_BYTES + block * DICT_INDEX_ROW_BYTES;
      blockFirstKeys[block] = indexBytes.readBigUInt64BE(offset);
      blockOffsets[block] = readUint48BE(indexBytes, offset + 8);
      blockLengths[block] = indexBytes.readUInt32BE(offset + 14);
      blockPostingsOffsets[block] = readUint48BE(indexBytes, offset + 18);
    }

    const reader = new SegmentReader(
      store, prefix, segmentId, manifest, docIds, tokenCounts, fingerprintCounts,
      blockFirstKeys, blockOffsets, blockLengths, blockPostingsOffsets,
      options.dictionaryBlockCacheBlocks ?? 2048,
    );
    reader.sharedCache = options.sharedDictionaryCache ?? null;
    return reader;
  }

  /** The ordinal of `docId` in this segment, or -1. */
  ordinalOf(docId: bigint): number {
    let low = 0;
    let high = this.docIds.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.docIds[middle];
      if (value === docId) return middle;
      if (value < docId) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  /** The block that could hold `key`: the last one whose first key is <= key; -1 if none. */
  private blockFor(key: bigint): number {
    let low = 0;
    let high = this.blockFirstKeys.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (this.blockFirstKeys[middle] <= key) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found;
  }

  private decodeBlock(block: number, bytes: Bytes, start: number): DecodedBlock {
    const blockLength = this.blockLengths[block];
    const entryCount = bytes.readUInt16BE(start);
    const payloadLength = bytes.readUInt32BE(start + 2);
    const crc = bytes.readUInt32BE(start + 6);
    if (payloadLength + DICT_BLOCK_HEADER_BYTES !== blockLength) {
      throw new CorpusSegmentError("CORRUPT", SEGMENT_FILE_DICT, `segment ${this.segmentId}: dictionary block ${block} has an impossible length`);
    }
    const payloadStart = start + DICT_BLOCK_HEADER_BYTES;
    const payload = bytes.subarray(payloadStart, payloadStart + payloadLength);
    if ((zlib.crc32(payload, zlib.crc32(bytes.subarray(start, start + 2))) >>> 0) !== crc) {
      throw new CorpusSegmentError("INTEGRITY_MISMATCH", SEGMENT_FILE_DICT, `segment ${this.segmentId}: dictionary block ${block} fails its checksum`);
    }
    const reader = new ByteReader(bytes, payloadStart, payloadStart + payloadLength);
    const keys = new Array<bigint>(entryCount);
    const dfs = new Uint32Array(entryCount);
    const offsets = new Float64Array(entryCount);
    const lengths = new Uint32Array(entryCount);
    let key = BigInt(0);
    let postingsOffset = this.blockPostingsOffsets[block];
    for (let entry = 0; entry < entryCount; entry += 1) {
      key = entry === 0 ? reader.readUint64BE() : key + reader.readVarintBig();
      keys[entry] = key;
      dfs[entry] = reader.readVarint();
      lengths[entry] = reader.readVarint();
      offsets[entry] = postingsOffset;
      postingsOffset += lengths[entry];
    }
    if (reader.remaining !== 0 || (entryCount > 0 && keys[0] !== this.blockFirstKeys[block])) {
      throw new CorpusSegmentError("CORRUPT", SEGMENT_FILE_DICT, `segment ${this.segmentId}: dictionary block ${block} does not decode cleanly`);
    }
    return { keys, dfs, offsets, lengths };
  }

  private remember(block: number, decoded: DecodedBlock) {
    if (this.blockCacheLimit <= 0) return;
    this.blockCache.set(block, decoded);
    if (this.blockCache.size > this.blockCacheLimit) this.blockCache.delete(this.blockCache.keys().next().value as number);
  }

  private async loadBlocks(blocks: number[]): Promise<Map<number, DecodedBlock>> {
    const loaded = new Map<number, DecodedBlock>();
    const missing: number[] = [];
    for (const block of blocks) {
      const cached = this.blockCache.get(block);
      if (cached) {
        this.blockCache.delete(block);
        this.blockCache.set(block, cached);
        loaded.set(block, cached);
        this.counters.dictionaryBlockCacheHits += 1;
      } else missing.push(block);
    }
    // Coalesce neighbouring blocks into one range read.
    let index = 0;
    while (index < missing.length) {
      const first = missing[index];
      const rangeStart = this.blockOffsets[first];
      let rangeEnd = rangeStart + this.blockLengths[first];
      let last = index;
      while (
        last + 1 < missing.length
        && this.blockOffsets[missing[last + 1]] - rangeEnd <= RANGE_COALESCE_GAP_BYTES
        && this.blockOffsets[missing[last + 1]] + this.blockLengths[missing[last + 1]] - rangeStart <= RANGE_COALESCE_MAX_BYTES
      ) {
        last += 1;
        rangeEnd = this.blockOffsets[missing[last]] + this.blockLengths[missing[last]];
      }
      let bytes: Bytes;
      try {
        bytes = await this.store.readRange(`${this.prefix}/${SEGMENT_FILE_DICT}`, rangeStart, rangeEnd - rangeStart);
      } catch (error) {
        throw toSegmentError(error, SEGMENT_FILE_DICT);
      }
      this.counters.rangeReads += 1;
      this.counters.dictionaryBytesRead += bytes.length;
      for (let cursor = index; cursor <= last; cursor += 1) {
        const block = missing[cursor];
        let decoded: DecodedBlock;
        try {
          decoded = this.decodeBlock(block, bytes, this.blockOffsets[block] - rangeStart);
        } catch (error) {
          throw toSegmentError(error, SEGMENT_FILE_DICT);
        }
        this.counters.dictionaryBlocksRead += 1;
        this.remember(block, decoded);
        loaded.set(block, decoded);
      }
      index = last + 1;
    }
    return loaded;
  }

  /**
   * With a shared cache: the compact form of the `blocks` (ascending,
   * distinct), from the cache or from one coalesced range read per run of
   * neighbours. A block read from storage is verified and decoded exactly as
   * on the uncached path (decodeBlock) before it is cached or used.
   */
  private async loadCompactBlocks(blocks: number[], shared: SharedDictionaryCache): Promise<Map<number, Uint32Array | DecodedBlock>> {
    const loaded = new Map<number, Uint32Array | DecodedBlock>();
    const missing: number[] = [];
    for (const block of blocks) {
      const cached = shared.cache.get(shared.identity, this.segmentId, block);
      if (cached) {
        loaded.set(block, cached);
        this.counters.dictionaryBlockCacheHits += 1;
      } else missing.push(block);
    }
    let index = 0;
    while (index < missing.length) {
      const first = missing[index];
      const rangeStart = this.blockOffsets[first];
      let rangeEnd = rangeStart + this.blockLengths[first];
      let last = index;
      while (
        last + 1 < missing.length
        && this.blockOffsets[missing[last + 1]] - rangeEnd <= RANGE_COALESCE_GAP_BYTES
        && this.blockOffsets[missing[last + 1]] + this.blockLengths[missing[last + 1]] - rangeStart <= RANGE_COALESCE_MAX_BYTES
      ) {
        last += 1;
        rangeEnd = this.blockOffsets[missing[last]] + this.blockLengths[missing[last]];
      }
      let bytes: Bytes;
      try {
        bytes = await this.store.readRange(`${this.prefix}/${SEGMENT_FILE_DICT}`, rangeStart, rangeEnd - rangeStart);
      } catch (error) {
        throw toSegmentError(error, SEGMENT_FILE_DICT);
      }
      this.counters.rangeReads += 1;
      this.counters.dictionaryBytesRead += bytes.length;
      for (let cursor = index; cursor <= last; cursor += 1) {
        const block = missing[cursor];
        let decoded: DecodedBlock;
        try {
          decoded = this.decodeBlock(block, bytes, this.blockOffsets[block] - rangeStart);
        } catch (error) {
          throw toSegmentError(error, SEGMENT_FILE_DICT);
        }
        this.counters.dictionaryBlocksRead += 1;
        const compact = compactDictionaryBlock(decoded.keys, decoded.dfs, decoded.offsets, decoded.lengths, this.blockPostingsOffsets[block]);
        if (compact) {
          shared.cache.set(shared.identity, this.segmentId, block, compact);
          loaded.set(block, compact);
        } else loaded.set(block, decoded);
      }
      index = last + 1;
    }
    return loaded;
  }

  /** The shared-cache lookup: same answer as the uncached one, keys compared as uint32 halves by binary search. */
  private async lookupWithSharedCache(sortedKeys: readonly bigint[], shared: SharedDictionaryCache): Promise<Array<DictionaryHit | null>> {
    const result = new Array<DictionaryHit | null>(sortedKeys.length).fill(null);
    const blockOfKey = new Int32Array(sortedKeys.length);
    const needed: number[] = [];
    for (let index = 0; index < sortedKeys.length; index += 1) {
      const block = this.blockFor(sortedKeys[index]);
      blockOfKey[index] = block;
      if (block >= 0 && needed[needed.length - 1] !== block) needed.push(block);
    }
    const blocks = await this.loadCompactBlocks(needed, shared);
    const { hi, lo } = keyHalves(sortedKeys);
    for (let index = 0; index < sortedKeys.length; index += 1) {
      const block = blockOfKey[index];
      if (block < 0) continue;
      const loaded = blocks.get(block) as Uint32Array | DecodedBlock;
      if (loaded instanceof Uint32Array) {
        const entry = findInCompactBlock(loaded, hi[index], lo[index]);
        if (entry < 0) continue;
        const n = loaded.length / 5;
        result[index] = { fingerprint: sortedKeys[index], df: loaded[2 * n + entry], postingsOffset: this.blockPostingsOffsets[block] + loaded[3 * n + entry], postingsLength: loaded[4 * n + entry] };
      } else {
        const entry = loaded.keys.indexOf(sortedKeys[index]);
        if (entry >= 0) result[index] = { fingerprint: sortedKeys[index], df: loaded.dfs[entry], postingsOffset: loaded.offsets[entry], postingsLength: loaded.lengths[entry] };
      }
    }
    return result;
  }

  /** `sortedKeys` ascending and distinct. Result is aligned to it; null = the segment does not hold that fingerprint. */
  async lookupDictionary(sortedKeys: readonly bigint[]): Promise<Array<DictionaryHit | null>> {
    if (this.sharedCache && this.blockFirstKeys.length > 0 && sortedKeys.length > 0) return this.lookupWithSharedCache(sortedKeys, this.sharedCache);
    const result = new Array<DictionaryHit | null>(sortedKeys.length).fill(null);
    if (this.blockFirstKeys.length === 0 || sortedKeys.length === 0) return result;
    const blockOfKey = new Int32Array(sortedKeys.length);
    const needed: number[] = [];
    for (let index = 0; index < sortedKeys.length; index += 1) {
      const block = this.blockFor(sortedKeys[index]);
      blockOfKey[index] = block;
      if (block >= 0 && needed[needed.length - 1] !== block) needed.push(block);
    }
    const blocks = await this.loadBlocks(needed);
    let cursorBlock = -1;
    let cursor = 0;
    for (let index = 0; index < sortedKeys.length; index += 1) {
      const block = blockOfKey[index];
      if (block < 0) continue;
      const decoded = blocks.get(block);
      if (!decoded) continue;
      if (block !== cursorBlock) {
        cursorBlock = block;
        cursor = 0;
      }
      const key = sortedKeys[index];
      while (cursor < decoded.keys.length && decoded.keys[cursor] < key) cursor += 1;
      if (cursor < decoded.keys.length && decoded.keys[cursor] === key) {
        result[index] = { fingerprint: key, df: decoded.dfs[cursor], postingsOffset: decoded.offsets[cursor], postingsLength: decoded.lengths[cursor] };
      }
    }
    return result;
  }

  /** Postings for `hits`, aligned to the input order. Lists are validated as they are decoded. */
  async readPostings(hits: readonly DictionaryHit[]): Promise<Uint32Array[]> {
    const order = hits.map((_, index) => index).sort((left, right) => hits[left].postingsOffset - hits[right].postingsOffset);
    const result = new Array<Uint32Array>(hits.length);
    let index = 0;
    while (index < order.length) {
      const first = hits[order[index]];
      const rangeStart = first.postingsOffset;
      let rangeEnd = rangeStart + first.postingsLength;
      let last = index;
      while (last + 1 < order.length) {
        const next = hits[order[last + 1]];
        if (next.postingsOffset - rangeEnd > RANGE_COALESCE_GAP_BYTES || next.postingsOffset + next.postingsLength - rangeStart > RANGE_COALESCE_MAX_BYTES) break;
        last += 1;
        rangeEnd = Math.max(rangeEnd, next.postingsOffset + next.postingsLength);
      }
      let bytes: Bytes;
      try {
        bytes = await this.store.readRange(`${this.prefix}/${SEGMENT_FILE_POSTINGS}`, rangeStart, rangeEnd - rangeStart);
      } catch (error) {
        throw toSegmentError(error, SEGMENT_FILE_POSTINGS);
      }
      this.counters.rangeReads += 1;
      this.counters.postingsBytesRead += bytes.length;
      for (let cursor = index; cursor <= last; cursor += 1) {
        const hit = hits[order[cursor]];
        try {
          result[order[cursor]] = decodePostings(bytes, hit.postingsOffset - rangeStart, hit.postingsLength, hit.df, this.manifest.documentCount);
        } catch (error) {
          throw toSegmentError(error, SEGMENT_FILE_POSTINGS);
        }
        this.counters.postingsListsDecoded += 1;
        this.counters.postingsDecoded += hit.df;
      }
      index = last + 1;
    }
    return result;
  }

  /** Every dictionary entry in key order, read block by block — for the DF artifact and for validation only. */
  async *iterateDictionary(blocksPerRead = 256): AsyncGenerator<DictionaryHit> {
    for (let start = 0; start < this.blockFirstKeys.length; start += blocksPerRead) {
      const end = Math.min(this.blockFirstKeys.length, start + blocksPerRead) - 1;
      const rangeStart = this.blockOffsets[start];
      const rangeEnd = this.blockOffsets[end] + this.blockLengths[end];
      let bytes: Bytes;
      try {
        bytes = await this.store.readRange(`${this.prefix}/${SEGMENT_FILE_DICT}`, rangeStart, rangeEnd - rangeStart);
      } catch (error) {
        throw toSegmentError(error, SEGMENT_FILE_DICT);
      }
      for (let block = start; block <= end; block += 1) {
        let decoded: DecodedBlock;
        try {
          decoded = this.decodeBlock(block, bytes, this.blockOffsets[block] - rangeStart);
        } catch (error) {
          throw toSegmentError(error, SEGMENT_FILE_DICT);
        }
        for (let entry = 0; entry < decoded.keys.length; entry += 1) {
          yield { fingerprint: decoded.keys[entry], df: decoded.dfs[entry], postingsOffset: decoded.offsets[entry], postingsLength: decoded.lengths[entry] };
        }
      }
    }
  }

  async readText(ordinal: number): Promise<{ text: string; metrics: RecordReadMetrics }> {
    try {
      const { record, metrics } = await readPackedRecord(this.store, this.prefix, TEXT_PACK_BASE, ordinal, this.docIds[ordinal]);
      return { text: record.toString("utf8"), metrics };
    } catch (error) {
      throw toSegmentError(error, TEXT_PACK_BASE);
    }
  }

  async readMetadata(ordinal: number): Promise<{ metadata: unknown; metrics: RecordReadMetrics }> {
    try {
      const { record, metrics } = await readPackedRecord(this.store, this.prefix, META_PACK_BASE, ordinal, this.docIds[ordinal]);
      return { metadata: JSON.parse(record.toString("utf8")), metrics };
    } catch (error) {
      throw toSegmentError(error, META_PACK_BASE);
    }
  }

  async readAliasAddenda(): Promise<Array<{ docId: string; alias: unknown }>> {
    if (this.manifest.aliasAddendumCount === 0) return [];
    try {
      const bytes = await this.store.readAll(`${this.prefix}/${SEGMENT_FILE_ALIASES}`);
      return bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { docId: string; alias: unknown });
    } catch (error) {
      throw toSegmentError(error, SEGMENT_FILE_ALIASES);
    }
  }
}
