import { createHash } from "node:crypto";
import { nodeBytes, type Bytes } from "./bytes";

/**
 * Corpus Engine v1 — the 64-bit contract for document ids and fingerprints.
 *
 * Both are full-width unsigned 64-bit values, so neither may ever travel
 * through a JavaScript Number (exact only to 2^53 - 1). One representation per
 * place, chosen on purpose:
 *
 *   place            document id                 fingerprint
 *   ---------------  --------------------------  --------------------------------
 *   binary files     8 bytes, big-endian         8 bytes, big-endian
 *   Node runtime     bigint                      bigint, or a (hi, lo) uint32 pair
 *                                                in hot loops, or 16 lowercase hex
 *                                                where existing code expects it
 *   JSON / API       canonical decimal string    16 lowercase hex characters
 *   SQL (if used)    TEXT, 20 digits zero-padded TEXT(16) hex, or BLOB(8) big-endian
 *
 * SQL note: SQLite/libSQL INTEGER is SIGNED 64-bit, so half of all ids would
 * overflow it and a REAL column would round them. The zero-padded decimal and
 * the hex/BLOB forms sort in numeric order as text/bytes.
 *
 * Postings never hold a document id: they hold segment-local uint32 ordinals,
 * which ARE safe Numbers. The segment's doc table maps ordinal -> document id.
 *
 * tsconfig targets ES2017, so there are no BigInt literals in this directory;
 * constants are built with BigInt().
 */

export type DocId = bigint;

const ZERO = BigInt(0);
const SIXTY_FOUR = BigInt(64);
const THIRTY_TWO = BigInt(32);
const UINT32_MASK = BigInt(0xffffffff);
export const UINT64_MAX = (BigInt(1) << SIXTY_FOUR) - BigInt(1);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class CorpusIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusIdError";
  }
}

export function isUint64(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= ZERO && value <= UINT64_MAX;
}

export function assertUint64(value: unknown, label: string): bigint {
  if (!isUint64(value)) {
    throw new CorpusIdError(`${label} must be a bigint in [0, 2^64 - 1]; got ${typeof value === "bigint" ? value.toString() : typeof value}`);
  }
  return value;
}

/** Canonical decimal: no sign, no leading zeros, no exponent. The JSON/API form of a document id. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

export function docIdToDecimal(id: DocId): string {
  return assertUint64(id, "document id").toString(10);
}

/**
 * Parses the JSON/API form. A JavaScript number is REFUSED even when it is a
 * safe integer: a caller that hands over a number has already been through a
 * lossy channel for every id above 2^53 - 1, and accepting the small ones
 * would hide that until the first large one.
 */
export function docIdFromDecimal(value: unknown): DocId {
  if (typeof value !== "string") {
    throw new CorpusIdError(`document id must be a decimal string, got ${typeof value}`);
  }
  if (!CANONICAL_DECIMAL.test(value)) throw new CorpusIdError(`document id is not canonical decimal: ${JSON.stringify(value)}`);
  const id = BigInt(value);
  if (id > UINT64_MAX) throw new CorpusIdError(`document id exceeds 2^64 - 1: ${value}`);
  return id;
}

/** 20 digits, zero padded: sorts in numeric order as TEXT. */
export function docIdToSqlText(id: DocId): string {
  return docIdToDecimal(id).padStart(20, "0");
}

export function docIdFromSqlText(value: unknown): DocId {
  if (typeof value !== "string" || !/^[0-9]{20}$/.test(value)) {
    throw new CorpusIdError(`document id SQL text must be exactly 20 digits, got ${JSON.stringify(value)}`);
  }
  const id = BigInt(value);
  if (id > UINT64_MAX) throw new CorpusIdError(`document id exceeds 2^64 - 1: ${value}`);
  return id;
}

export function writeUint64BE(target: Bytes, offset: number, value: bigint): void {
  target.writeBigUInt64BE(assertUint64(value, "uint64"), offset);
}

export function readUint64BE(source: Bytes, offset: number): bigint {
  return source.readBigUInt64BE(offset);
}

export function uint64ToHiLo(value: bigint): [hi: number, lo: number] {
  assertUint64(value, "uint64");
  return [Number(value >> THIRTY_TWO), Number(value & UINT32_MASK)];
}

export function hiLoToUint64(hi: number, lo: number): bigint {
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || lo < 0 || hi > 0xffffffff || lo > 0xffffffff) {
    throw new CorpusIdError(`hi/lo must each be a uint32, got ${hi}/${lo}`);
  }
  return (BigInt(hi) << THIRTY_TWO) | BigInt(lo);
}

/** A uint64 as a Number — only when it provably fits. Throws rather than rounding. */
export function safeNumberFromUint64(value: bigint, label: string): number {
  assertUint64(value, label);
  if (value > MAX_SAFE) throw new CorpusIdError(`${label} ${value.toString()} exceeds Number.MAX_SAFE_INTEGER and cannot be a Number`);
  return Number(value);
}

const FINGERPRINT_HEX = /^[0-9a-f]{16}$/;

/** lib/similarity-core.ts gramHash() output is exactly this: 16 lowercase hex = one big-endian uint64. */
export function isFingerprintHex(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_HEX.test(value);
}

export function fingerprintFromHex(hex: string): bigint {
  if (!isFingerprintHex(hex)) throw new CorpusIdError(`fingerprint must be 16 lowercase hex characters, got ${JSON.stringify(hex)}`);
  return BigInt(`0x${hex}`);
}

export function fingerprintToHex(value: bigint): string {
  return assertUint64(value, "fingerprint").toString(16).padStart(16, "0");
}

export function fingerprintHexToHiLo(hex: string): [hi: number, lo: number] {
  if (!isFingerprintHex(hex)) throw new CorpusIdError(`fingerprint must be 16 lowercase hex characters, got ${JSON.stringify(hex)}`);
  return [Number.parseInt(hex.slice(0, 8), 16), Number.parseInt(hex.slice(8), 16)];
}

export function hiLoToFingerprintHex(hi: number, lo: number): string {
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

const DOC_ID_DOMAIN = "turnitplus:corpus-doc-id:v1\n";

/**
 * corpus-doc-id-v1: the first 8 bytes (big-endian) of
 * sha256("turnitplus:corpus-doc-id:v1\n" + normalizedContentSha256).
 *
 * The id is a function of the NORMALIZED CONTENT alone, so it is stable across
 * rebuilds, generations, machines and ingestion order, needs no allocator, and
 * two providers supplying the same normalized content get the same id (which
 * is what exact deduplication keys on). 0 is reserved as "no document".
 *
 * Collisions between different contents are possible in principle (birthday
 * bound: about 7e-7 at 5,000,000 documents) and are never resolved silently —
 * the builder compares the full normalized hash and fails the build with
 * DOC_ID_COLLISION.
 */
export function deriveDocId(normalizedContentSha256: string): DocId {
  if (!/^[0-9a-f]{64}$/.test(normalizedContentSha256)) {
    throw new CorpusIdError(`normalized content hash must be 64 lowercase hex characters`);
  }
  const digest = nodeBytes(createHash("sha256").update(DOC_ID_DOMAIN + normalizedContentSha256, "utf8").digest());
  const id = digest.readBigUInt64BE(0);
  if (id === ZERO) throw new CorpusIdError("derived document id 0 is reserved (DOC_ID_COLLISION with the null id)");
  return id;
}

export const MAX_PARTITION_BITS = 12;

/**
 * partition-docid-prefix-v1: a document's physical partition is the top
 * `partitionBits` bits of its id. Ids are uniform hashes, so partitions are
 * balanced; and because it is a PREFIX, one partition can later be split in
 * two (one more bit) without moving any document of any other partition.
 */
export function partitionOfDocId(id: DocId, partitionBits: number): number {
  if (!Number.isInteger(partitionBits) || partitionBits < 0 || partitionBits > MAX_PARTITION_BITS) {
    throw new CorpusIdError(`partitionBits must be an integer in [0, ${MAX_PARTITION_BITS}], got ${partitionBits}`);
  }
  assertUint64(id, "document id");
  if (partitionBits === 0) return 0;
  return Number(id >> BigInt(64 - partitionBits));
}

export function compareUint64(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
