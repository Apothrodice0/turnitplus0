import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import { CorpusIntegrityError, nodeBytes, readUint48BE, sha256Hex, writeUint48BE, type Bytes } from "./bytes";
import type { CorpusObjectStore } from "./storage";

/**
 * Corpus Engine v1 — record-pack-v1: immutable, random-access record packs.
 *
 * A pack is a 16-byte header followed by record SPANS. A span is one record's
 * bytes cut into chunks of at most `chunkBytes`, each chunk compressed ON ITS
 * OWN:
 *
 *   span  = chunk, chunk, ...
 *   chunk = [uncompressedLength u32][compressedLength u32][compressed bytes]
 *
 * So one record is retrieved by ONE byte-range read of exactly its span and
 * decoded without touching any other record: the work to fetch a candidate's
 * source text is bounded by that document's own size, never by the pack's or
 * the corpus's. Nothing is ever decompressed "from the beginning".
 *
 * The companion index is fixed-width (64 bytes per record), so the row for
 * record N is itself one range read at 16 + 64 * N:
 *
 *   docId u64 | packNumber u16 | chunkCount u16 | offset u48 | spanLength u32 |
 *   uncompressedLength u32 | codec u8 | reserved[5] | sha256[32]
 *
 * sha256 is over the record's UNCOMPRESSED bytes and is checked on every read.
 * Source text and document metadata both use this format.
 */

export const RECORD_PACK_MAGIC = "TPRP";
export const RECORD_PACK_INDEX_MAGIC = "TPRX";
export const RECORD_PACK_FORMAT_NUMBER = 1;
export const RECORD_PACK_HEADER_BYTES = 16;
export const RECORD_PACK_INDEX_HEADER_BYTES = 16;
export const RECORD_PACK_INDEX_ROW_BYTES = 64;

export const RECORD_CODEC_RAW = 0;
export const RECORD_CODEC_ZSTD = 1;
export type RecordCodec = typeof RECORD_CODEC_RAW | typeof RECORD_CODEC_ZSTD;

/** zstd level 9: measured 2.69x on real sources at ~47 us/document decode, byte-deterministic. */
export const DEFAULT_RECORD_CODEC: RecordCodec = RECORD_CODEC_ZSTD;
export const DEFAULT_RECORD_CODEC_LEVEL = 9;
export const DEFAULT_RECORD_CHUNK_BYTES = 1 << 20;
/** No single record may exceed this — the hard bound on one fetch. */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;

const CHUNK_HEADER_BYTES = 8;

/**
 * zstd entered node:zlib in Node 22.15. The type package here predates it, and
 * package.json admits Node 22.13, so the functions are looked up at run time
 * and their absence is a clear UNSUPPORTED_CODEC error, never a crash.
 */
type ZstdApi = {
  zstdCompressSync(input: Uint8Array, options?: { params?: Record<number, number> }): Uint8Array;
  zstdDecompressSync(input: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
  constants: Record<string, number>;
};
function zstd(): ZstdApi {
  const api = zlib as unknown as Partial<ZstdApi>;
  if (typeof api.zstdCompressSync !== "function" || typeof api.zstdDecompressSync !== "function") {
    throw new CorpusIntegrityError("UNSUPPORTED_CODEC", `this Node runtime (${process.version}) has no zstd in node:zlib; record-pack codec 1 needs Node >= 22.15`);
  }
  return api as ZstdApi;
}

export type RecordSpan = {
  span: Bytes;
  uncompressedLength: number;
  chunkCount: number;
  sha256: string;
  codec: RecordCodec;
};

function compressChunk(chunk: Bytes, codec: RecordCodec, level: number): Bytes {
  if (codec === RECORD_CODEC_RAW) return chunk;
  if (codec === RECORD_CODEC_ZSTD) {
    const api = zstd();
    return nodeBytes(api.zstdCompressSync(chunk, { params: { [api.constants.ZSTD_c_compressionLevel]: level } }));
  }
  throw new CorpusIntegrityError("UNSUPPORTED_CODEC", `unsupported record codec ${codec}`);
}

function decompressChunk(chunk: Bytes, codec: number, expectedLength: number): Bytes {
  if (codec === RECORD_CODEC_RAW) return chunk;
  // maxOutputLength bounds the decode to the length the chunk header promised (zlib rejects 0, so an
  // empty chunk asks for 1; the caller still checks the exact length).
  if (codec === RECORD_CODEC_ZSTD) return nodeBytes(zstd().zstdDecompressSync(chunk, { maxOutputLength: Math.max(1, expectedLength) }));
  throw new CorpusIntegrityError("UNSUPPORTED_CODEC", `unsupported record codec ${codec}`);
}

export function encodeRecordSpan(
  record: Bytes,
  codec: RecordCodec = DEFAULT_RECORD_CODEC,
  level: number = DEFAULT_RECORD_CODEC_LEVEL,
  chunkBytes: number = DEFAULT_RECORD_CHUNK_BYTES,
): RecordSpan {
  if (record.length > MAX_RECORD_BYTES) {
    throw new CorpusIntegrityError("RECORD_TOO_LARGE", `record of ${record.length} bytes exceeds the ${MAX_RECORD_BYTES}-byte bound`);
  }
  const parts: Bytes[] = [];
  let chunkCount = 0;
  for (let start = 0; start < record.length || chunkCount === 0; start += chunkBytes) {
    const chunk = record.subarray(start, Math.min(record.length, start + chunkBytes));
    const packed = compressChunk(chunk, codec, level);
    const header = Buffer.allocUnsafe(CHUNK_HEADER_BYTES);
    header.writeUInt32BE(chunk.length, 0);
    header.writeUInt32BE(packed.length, 4);
    parts.push(header, packed);
    chunkCount += 1;
    if (record.length === 0) break;
  }
  if (chunkCount > 0xffff) throw new CorpusIntegrityError("RECORD_TOO_LARGE", `record needs ${chunkCount} chunks; the row holds a u16`);
  return { span: Buffer.concat(parts), uncompressedLength: record.length, chunkCount, sha256: sha256Hex(record), codec };
}

export type RecordPackRow = {
  docId: bigint;
  packNumber: number;
  chunkCount: number;
  offset: number;
  spanLength: number;
  uncompressedLength: number;
  codec: number;
  sha256: string;
};

export function encodeRecordPackRow(row: RecordPackRow): Bytes {
  const bytes = Buffer.alloc(RECORD_PACK_INDEX_ROW_BYTES);
  bytes.writeBigUInt64BE(row.docId, 0);
  bytes.writeUInt16BE(row.packNumber, 8);
  bytes.writeUInt16BE(row.chunkCount, 10);
  writeUint48BE(bytes, 12, row.offset);
  bytes.writeUInt32BE(row.spanLength, 18);
  bytes.writeUInt32BE(row.uncompressedLength, 22);
  bytes.writeUInt8(row.codec, 26);
  Buffer.from(row.sha256, "hex").copy(bytes, 32);
  return bytes;
}

export function decodeRecordPackRow(bytes: Bytes, offset = 0): RecordPackRow {
  if (bytes.length < offset + RECORD_PACK_INDEX_ROW_BYTES) throw new CorpusIntegrityError("SHORT_READ", "record-pack index row is truncated");
  return {
    docId: bytes.readBigUInt64BE(offset),
    packNumber: bytes.readUInt16BE(offset + 8),
    chunkCount: bytes.readUInt16BE(offset + 10),
    offset: readUint48BE(bytes, offset + 12),
    spanLength: bytes.readUInt32BE(offset + 18),
    uncompressedLength: bytes.readUInt32BE(offset + 22),
    codec: bytes.readUInt8(offset + 26),
    sha256: bytes.subarray(offset + 32, offset + 64).toString("hex"),
  };
}

export function decodeRecordSpan(span: Bytes, row: Pick<RecordPackRow, "chunkCount" | "uncompressedLength" | "codec" | "sha256" | "spanLength">): Bytes {
  if (span.length !== row.spanLength) throw new CorpusIntegrityError("SHORT_READ", `record span is ${span.length} bytes, its row says ${row.spanLength}`);
  const parts: Bytes[] = [];
  let position = 0;
  let total = 0;
  for (let index = 0; index < row.chunkCount; index += 1) {
    if (position + CHUNK_HEADER_BYTES > span.length) throw new CorpusIntegrityError("RECORD_CORRUPT", "record chunk header runs past its span");
    const uncompressedLength = span.readUInt32BE(position);
    const compressedLength = span.readUInt32BE(position + 4);
    position += CHUNK_HEADER_BYTES;
    if (position + compressedLength > span.length || total + uncompressedLength > row.uncompressedLength) {
      throw new CorpusIntegrityError("RECORD_CORRUPT", "record chunk lengths disagree with its span");
    }
    let chunk: Bytes;
    try {
      chunk = decompressChunk(span.subarray(position, position + compressedLength), row.codec, uncompressedLength);
    } catch (error) {
      if (error instanceof CorpusIntegrityError) throw error;
      throw new CorpusIntegrityError("RECORD_CORRUPT", `record chunk failed to decompress: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (chunk.length !== uncompressedLength) throw new CorpusIntegrityError("RECORD_CORRUPT", "record chunk decompressed to the wrong length");
    parts.push(chunk);
    total += uncompressedLength;
    position += compressedLength;
  }
  if (position !== span.length || total !== row.uncompressedLength) throw new CorpusIntegrityError("RECORD_CORRUPT", "record span was not consumed exactly");
  const record = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  if (sha256Hex(record) !== row.sha256) throw new CorpusIntegrityError("RECORD_HASH_MISMATCH", "record bytes do not match their integrity hash");
  return record;
}

function packHeader(codec: number, level: number, chunkBytes: number): Bytes {
  const header = Buffer.alloc(RECORD_PACK_HEADER_BYTES);
  header.write(RECORD_PACK_MAGIC, 0, "latin1");
  header.writeUInt16BE(RECORD_PACK_FORMAT_NUMBER, 4);
  header.writeUInt8(codec, 6);
  header.writeUInt8(level, 7);
  header.writeUInt32BE(chunkBytes, 8);
  return header;
}

export function recordPackFileName(baseName: string, packNumber: number) {
  return `${baseName}-${String(packNumber).padStart(4, "0")}.pack`;
}

export function recordPackIndexFileName(baseName: string) {
  return `${baseName}.pidx`;
}

export type RecordPackWriterResult = {
  packFiles: string[];
  indexFile: string;
  recordCount: number;
  packBytes: number;
  indexBytes: number;
  uncompressedBytes: number;
};

/**
 * Writes `<base>-NNNN.pack` files (rolled at `maxPackBytes`) plus `<base>.pidx`.
 * Records are appended in the caller's order; row N of the index is record N.
 * Synchronous on purpose: the builder is a batch job and a simple write path
 * is easier to make crash-safe than an interleaved one.
 */
export class RecordPackWriter {
  private readonly packFiles: string[] = [];
  private packDescriptor = -1;
  private packNumber = -1;
  private packOffset = 0;
  private readonly indexDescriptor: number;
  private recordCount = 0;
  private packBytes = 0;
  private uncompressedBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly baseName: string,
    private readonly options: { maxPackBytes: number; codec?: RecordCodec; level?: number; chunkBytes?: number },
  ) {
    this.indexDescriptor = openSync(path.join(directory, recordPackIndexFileName(baseName)), "w");
    const header = Buffer.alloc(RECORD_PACK_INDEX_HEADER_BYTES);
    header.write(RECORD_PACK_INDEX_MAGIC, 0, "latin1");
    header.writeUInt16BE(RECORD_PACK_FORMAT_NUMBER, 4);
    header.writeUInt16BE(RECORD_PACK_INDEX_ROW_BYTES, 6);
    writeSync(this.indexDescriptor, header);
  }

  private rollPack() {
    if (this.packDescriptor >= 0) {
      fsyncSync(this.packDescriptor);
      closeSync(this.packDescriptor);
    }
    this.packNumber += 1;
    if (this.packNumber > 0xffff) throw new CorpusIntegrityError("TOO_MANY_PACKS", "a segment may hold at most 65,536 packs per kind");
    const name = recordPackFileName(this.baseName, this.packNumber);
    this.packFiles.push(name);
    this.packDescriptor = openSync(path.join(this.directory, name), "w");
    const header = packHeader(this.options.codec ?? DEFAULT_RECORD_CODEC, this.options.level ?? DEFAULT_RECORD_CODEC_LEVEL, this.options.chunkBytes ?? DEFAULT_RECORD_CHUNK_BYTES);
    writeSync(this.packDescriptor, header);
    this.packOffset = header.length;
    this.packBytes += header.length;
  }

  /** Appends an already-encoded span (the builder stages spans once and copies them here). */
  appendSpan(docId: bigint, encoded: RecordSpan): RecordPackRow {
    if (this.packDescriptor < 0 || (this.packOffset > RECORD_PACK_HEADER_BYTES && this.packOffset + encoded.span.length > this.options.maxPackBytes)) {
      this.rollPack();
    }
    const row: RecordPackRow = {
      docId,
      packNumber: this.packNumber,
      chunkCount: encoded.chunkCount,
      offset: this.packOffset,
      spanLength: encoded.span.length,
      uncompressedLength: encoded.uncompressedLength,
      codec: encoded.codec,
      sha256: encoded.sha256,
    };
    writeSync(this.packDescriptor, encoded.span);
    writeSync(this.indexDescriptor, encodeRecordPackRow(row));
    this.packOffset += encoded.span.length;
    this.packBytes += encoded.span.length;
    this.uncompressedBytes += encoded.uncompressedLength;
    this.recordCount += 1;
    return row;
  }

  append(docId: bigint, record: Bytes): RecordPackRow {
    return this.appendSpan(docId, encodeRecordSpan(record, this.options.codec, this.options.level, this.options.chunkBytes));
  }

  finish(): RecordPackWriterResult {
    if (this.packDescriptor < 0) this.rollPack();
    fsyncSync(this.packDescriptor);
    closeSync(this.packDescriptor);
    fsyncSync(this.indexDescriptor);
    closeSync(this.indexDescriptor);
    return {
      packFiles: [...this.packFiles],
      indexFile: recordPackIndexFileName(this.baseName),
      recordCount: this.recordCount,
      packBytes: this.packBytes,
      indexBytes: RECORD_PACK_INDEX_HEADER_BYTES + this.recordCount * RECORD_PACK_INDEX_ROW_BYTES,
      uncompressedBytes: this.uncompressedBytes,
    };
  }
}

export type RecordReadMetrics = {
  /** Bytes fetched from storage for this record: its index row + its span. */
  compressedBytesRead: number;
  decompressedBytes: number;
  rangeReads: number;
  readMs: number;
  decodeMs: number;
};

/**
 * Reads record `recordNumber` of the pack set `<prefix>/<base>*`: one range
 * read for the 64-byte row, one for the span. `expectedDocId` must match the
 * row — a row/ordinal mix-up is reported, never returned as someone else's text.
 */
export async function readPackedRecord(
  store: CorpusObjectStore,
  prefix: string,
  baseName: string,
  recordNumber: number,
  expectedDocId: bigint,
): Promise<{ record: Bytes; row: RecordPackRow; metrics: RecordReadMetrics }> {
  const readStarted = performance.now();
  const rowBytes = await store.readRange(
    `${prefix}/${recordPackIndexFileName(baseName)}`,
    RECORD_PACK_INDEX_HEADER_BYTES + recordNumber * RECORD_PACK_INDEX_ROW_BYTES,
    RECORD_PACK_INDEX_ROW_BYTES,
  );
  const row = decodeRecordPackRow(rowBytes);
  if (row.docId !== expectedDocId) {
    throw new CorpusIntegrityError("RECORD_ROW_MISMATCH", `record ${recordNumber} of ${baseName} belongs to document ${row.docId}, expected ${expectedDocId}`);
  }
  if (row.uncompressedLength > MAX_RECORD_BYTES) throw new CorpusIntegrityError("RECORD_TOO_LARGE", "record row exceeds the record size bound");
  const span = await store.readRange(`${prefix}/${recordPackFileName(baseName, row.packNumber)}`, row.offset, row.spanLength);
  const readMs = performance.now() - readStarted;
  const decodeStarted = performance.now();
  const record = decodeRecordSpan(span, row);
  return {
    record,
    row,
    metrics: {
      compressedBytesRead: RECORD_PACK_INDEX_ROW_BYTES + row.spanLength,
      decompressedBytes: record.length,
      rangeReads: 2,
      readMs,
      decodeMs: performance.now() - decodeStarted,
    },
  };
}

/** Structural check of a pack index file against its expected record count (publication validation). */
export function checkRecordPackIndex(indexBytes: Bytes, expectedRecords: number): string | null {
  if (indexBytes.length < RECORD_PACK_INDEX_HEADER_BYTES) return "record-pack index is shorter than its header";
  if (indexBytes.toString("latin1", 0, 4) !== RECORD_PACK_INDEX_MAGIC) return "record-pack index has the wrong magic";
  if (indexBytes.readUInt16BE(4) !== RECORD_PACK_FORMAT_NUMBER) return `record-pack index format ${indexBytes.readUInt16BE(4)} is not supported`;
  const expectedLength = RECORD_PACK_INDEX_HEADER_BYTES + expectedRecords * RECORD_PACK_INDEX_ROW_BYTES;
  if (indexBytes.length !== expectedLength) return `record-pack index is ${indexBytes.length} bytes, expected ${expectedLength} for ${expectedRecords} records`;
  return null;
}
