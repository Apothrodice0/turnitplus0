import { createHash } from "node:crypto";

/**
 * Corpus Engine v1 — byte-level primitives shared by every binary artifact.
 *
 * Fixed-width integers are BIG-ENDIAN everywhere (one rule, and an 8-byte
 * big-endian key sorts bytewise in numeric order). Variable-width integers are
 * unsigned LEB128: 7 payload bits per byte, low group first, high bit = "more".
 */

/**
 * A Node Buffer, typed locally.
 *
 * This project's global `Buffer` TYPE carries no Node methods (the Workers
 * type package declares the global as `any` and the Node interface does not
 * merge), so `buffer.readUInt32BE(...)` does not type-check anywhere in the
 * repo — the reason lib/selective-corpus decodes with raw Uint8Array
 * arithmetic. Rather than touch shared compiler config, the corpus engine
 * names exactly the Buffer methods it uses. Every value typed Bytes IS a real
 * Buffer at run time: it comes from Buffer.alloc/from/concat or from
 * nodeBytes() below.
 */
export interface Bytes extends Uint8Array {
  readUInt8(offset?: number): number;
  readUInt16BE(offset?: number): number;
  readUInt32BE(offset?: number): number;
  readUIntBE(offset: number, byteLength: number): number;
  readBigUInt64BE(offset?: number): bigint;
  writeUInt8(value: number, offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  writeUIntBE(value: number, offset: number, byteLength: number): number;
  writeBigUInt64BE(value: bigint, offset?: number): number;
  write(text: string, offset?: number, encoding?: string): number;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  equals(other: Uint8Array): boolean;
  indexOf(value: number, byteOffset?: number): number;
  toString(encoding?: string, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Bytes;
}

/** A Buffer view of bytes returned by fs / crypto / zlib (no copy when it already is one). */
export function nodeBytes(value: Uint8Array): Bytes {
  return (Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)) as Bytes;
}

export class CorpusIntegrityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorpusIntegrityError";
    this.code = code;
  }
}

const SEVEN = BigInt(7);
const LOW_SEVEN = BigInt(0x7f);
const ZERO = BigInt(0);
const UINT64_LIMIT = BigInt(1) << BigInt(64);

/** Growable append-only byte buffer. */
export class ByteWriter {
  private buffer: Bytes;
  length = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = Buffer.allocUnsafe(Math.max(16, initialCapacity));
  }

  private reserve(extra: number) {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = Buffer.allocUnsafe(capacity);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  /** Unsigned LEB128 of a non-negative safe integer. */
  writeVarint(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`varint value must be a non-negative safe integer, got ${value}`);
    this.reserve(8);
    let rest = value;
    while (rest >= 0x80) {
      this.buffer[this.length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.buffer[this.length++] = rest;
  }

  /** Unsigned LEB128 of a uint64 (up to 10 bytes). */
  writeVarintBig(value: bigint) {
    if (value < ZERO || value >= UINT64_LIMIT) throw new RangeError(`varint value must be a uint64, got ${value}`);
    this.reserve(10);
    let rest = value;
    while (rest >= BigInt(0x80)) {
      this.buffer[this.length++] = Number(rest & LOW_SEVEN) | 0x80;
      rest >>= SEVEN;
    }
    this.buffer[this.length++] = Number(rest);
  }

  writeUint64BE(value: bigint) {
    this.reserve(8);
    this.buffer.writeBigUInt64BE(value, this.length);
    this.length += 8;
  }

  writeBytes(bytes: Uint8Array) {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  reset() {
    this.length = 0;
  }

  /** A copy of the written bytes. */
  toBuffer(): Bytes {
    return Buffer.from(this.buffer.subarray(0, this.length));
  }
}

/** Sequential reader over a byte range; every read is bounds-checked. */
export class ByteReader {
  position: number;
  private readonly end: number;

  constructor(private readonly bytes: Bytes, start = 0, end = bytes.length) {
    this.position = start;
    this.end = end;
  }

  get remaining() {
    return this.end - this.position;
  }

  readVarint(): number {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < 8; count += 1) {
      if (this.position >= this.end) throw new CorpusIntegrityError("VARINT_OVERRUN", "varint runs past the end of its range");
      const byte = this.bytes[this.position++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) throw new CorpusIntegrityError("VARINT_RANGE", "varint exceeds the safe integer range");
        return value;
      }
      scale *= 0x80;
    }
    throw new CorpusIntegrityError("VARINT_RANGE", "varint is longer than a safe integer allows");
  }

  readVarintBig(): bigint {
    let value = ZERO;
    let shift = ZERO;
    for (let count = 0; count < 10; count += 1) {
      if (this.position >= this.end) throw new CorpusIntegrityError("VARINT_OVERRUN", "varint runs past the end of its range");
      const byte = this.bytes[this.position++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (value >= UINT64_LIMIT) throw new CorpusIntegrityError("VARINT_RANGE", "varint exceeds uint64");
        return value;
      }
      shift += SEVEN;
    }
    throw new CorpusIntegrityError("VARINT_RANGE", "varint is longer than a uint64 allows");
  }

  readUint64BE(): bigint {
    if (this.position + 8 > this.end) throw new CorpusIntegrityError("SHORT_READ", "uint64 runs past the end of its range");
    const value = this.bytes.readBigUInt64BE(this.position);
    this.position += 8;
    return value;
  }
}

/** A 48-bit unsigned offset/length: big enough for 256 TiB files, and a safe Number. */
export function writeUint48BE(target: Bytes, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffffffff) throw new RangeError(`uint48 out of range: ${value}`);
  target.writeUIntBE(value, offset, 6);
}

export function readUint48BE(source: Bytes, offset: number): number {
  return source.readUIntBE(offset, 6);
}

/**
 * postings-delta-varint-v1: strictly increasing uint32 ordinals, the first
 * stored as is and each following one as its gap from the previous (>= 1).
 */
export function encodePostings(ordinals: ArrayLike<number>, writer: ByteWriter): void {
  let previous = -1;
  for (let index = 0; index < ordinals.length; index += 1) {
    const ordinal = ordinals[index];
    if (!Number.isInteger(ordinal) || ordinal <= previous || ordinal > 0xffffffff) {
      throw new RangeError(`postings must be strictly increasing uint32 ordinals; got ${ordinal} after ${previous}`);
    }
    writer.writeVarint(previous < 0 ? ordinal : ordinal - previous);
    previous = ordinal;
  }
}

/**
 * Decodes exactly `count` ordinals from bytes[start, start + length) and
 * checks everything the format promises: strictly increasing, below
 * `documentCount`, and the byte range consumed exactly. A list that fails any
 * of these is corrupt and is never returned partially.
 */
export function decodePostings(bytes: Bytes, start: number, length: number, count: number, documentCount: number): Uint32Array {
  const reader = new ByteReader(bytes, start, start + length);
  const ordinals = new Uint32Array(count);
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    const value = reader.readVarint();
    const ordinal = previous < 0 ? value : previous + value;
    if (previous >= 0 && value === 0) throw new CorpusIntegrityError("POSTINGS_NOT_INCREASING", "postings gap of zero");
    if (ordinal >= documentCount) throw new CorpusIntegrityError("POSTINGS_ORDINAL_RANGE", `postings ordinal ${ordinal} is outside the segment's ${documentCount} documents`);
    ordinals[index] = ordinal;
    previous = ordinal;
  }
  if (reader.remaining !== 0) throw new CorpusIntegrityError("POSTINGS_LENGTH", `postings list left ${reader.remaining} undecoded bytes`);
  return ordinals;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof bytes === "string") hash.update(bytes, "utf8");
  else hash.update(bytes);
  return hash.digest("hex");
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, undefined
 * dropped. The byte string every content hash of a JSON document is taken
 * over, so the hash never depends on property insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonical JSON cannot hold a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") throw new TypeError("canonical JSON cannot hold a bigint; encode it as a decimal string");
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}
