import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UINT64_MAX,
  CorpusIdError,
  compareUint64,
  deriveDocId,
  docIdFromDecimal,
  docIdFromSqlText,
  docIdToDecimal,
  docIdToSqlText,
  fingerprintFromHex,
  fingerprintHexToHiLo,
  fingerprintToHex,
  hiLoToFingerprintHex,
  hiLoToUint64,
  partitionOfDocId,
  readUint64BE,
  safeNumberFromUint64,
  uint64ToHiLo,
  writeUint64BE,
} from '../lib/corpus-engine/ids.ts';
import {
  ByteReader,
  ByteWriter,
  CorpusIntegrityError,
  canonicalJson,
  decodePostings,
  encodePostings,
  readUint48BE,
  writeUint48BE,
} from '../lib/corpus-engine/bytes.ts';
import { gramHash } from '../lib/similarity-core.ts';

/**
 * Corpus Engine v1 — the 64-bit contract. Document ids and fingerprints are
 * full-width uint64, so the boundary that matters is Number.MAX_SAFE_INTEGER:
 * everything above it must survive every representation exactly, and nothing
 * may quietly become a rounded Number.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BOUNDARY_VALUES = [
  0n,
  1n,
  0xffffffffn,
  0x100000000n,
  MAX_SAFE - 1n,
  MAX_SAFE, // 9007199254740991
  MAX_SAFE + 1n, // 2^53: the first integer a Number cannot tell from its neighbour
  MAX_SAFE + 2n,
  2n ** 63n - 1n, // largest signed 64-bit value (the SQL INTEGER ceiling)
  2n ** 63n,
  UINT64_MAX - 1n,
  UINT64_MAX,
];

test('document ids round-trip exactly through decimal, SQL text, binary and hi/lo at every boundary', () => {
  for (const value of BOUNDARY_VALUES) {
    assert.equal(docIdFromDecimal(docIdToDecimal(value)), value);
    assert.equal(docIdFromSqlText(docIdToSqlText(value)), value);
    const bytes = Buffer.alloc(8);
    writeUint64BE(bytes, 0, value);
    assert.equal(readUint64BE(bytes, 0), value);
    const [hi, lo] = uint64ToHiLo(value);
    assert.equal(hiLoToUint64(hi, lo), value);
    assert.equal(fingerprintFromHex(fingerprintToHex(value)), value);
  }
});

test('a value above Number.MAX_SAFE_INTEGER would be corrupted by a Number, and the id layer never routes through one', () => {
  const above = MAX_SAFE + 2n; // 9007199254740993
  // The hazard itself: the nearest Number is a DIFFERENT integer.
  assert.notEqual(BigInt(Number(above)), above);
  // The id layer keeps it exact.
  assert.equal(docIdToDecimal(above), '9007199254740993');
  assert.equal(docIdFromDecimal('9007199254740993'), above);
  // JSON of the decimal form is lossless; JSON of a Number would not have been.
  assert.equal(docIdFromDecimal(JSON.parse(JSON.stringify({ id: docIdToDecimal(UINT64_MAX) })).id), UINT64_MAX);
  assert.equal(docIdToDecimal(UINT64_MAX), '18446744073709551615');
});

test('a JavaScript number is refused as a document id, even a small safe one', () => {
  assert.throws(() => docIdFromDecimal(42), CorpusIdError);
  assert.throws(() => docIdFromDecimal(Number.MAX_SAFE_INTEGER), CorpusIdError);
  assert.throws(() => docIdFromDecimal(9007199254740993), CorpusIdError);
  assert.throws(() => docIdFromDecimal(undefined), CorpusIdError);
  assert.throws(() => docIdFromDecimal(42n), CorpusIdError);
});

test('non-canonical or out-of-range decimal ids are refused', () => {
  for (const bad of ['', '01', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '0x10', '18446744073709551616', '99999999999999999999', '１２']) {
    assert.throws(() => docIdFromDecimal(bad), CorpusIdError, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(docIdFromDecimal('0'), 0n);
  assert.throws(() => docIdToDecimal(-1n), CorpusIdError);
  assert.throws(() => docIdToDecimal(UINT64_MAX + 1n), CorpusIdError);
  assert.throws(() => docIdToDecimal(5), CorpusIdError);
});

test('safeNumberFromUint64 converts only what fits and throws instead of rounding', () => {
  assert.equal(safeNumberFromUint64(MAX_SAFE, 'value'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => safeNumberFromUint64(MAX_SAFE + 1n, 'value'), CorpusIdError);
  assert.throws(() => safeNumberFromUint64(UINT64_MAX, 'value'), CorpusIdError);
});

test('SQL text form is fixed width and sorts in numeric order; a signed 64-bit column could not hold half the range', () => {
  const sorted = [...BOUNDARY_VALUES].sort(compareUint64);
  const asText = sorted.map(docIdToSqlText);
  assert.deepEqual([...asText].sort(), asText);
  assert.ok(asText.every((text) => text.length === 20));
  // 2^63 is a valid document id and is outside SQLite's signed INTEGER.
  assert.ok(2n ** 63n > 2n ** 63n - 1n && 2n ** 63n <= UINT64_MAX);
  assert.throws(() => docIdFromSqlText('123'), CorpusIdError);
  assert.throws(() => docIdFromSqlText('99999999999999999999'), CorpusIdError);
});

test('binary form is big-endian, so bytewise order equals numeric order', () => {
  const sorted = [...BOUNDARY_VALUES].sort(compareUint64);
  const encoded = sorted.map((value) => {
    const bytes = Buffer.alloc(8);
    writeUint64BE(bytes, 0, value);
    return bytes;
  });
  for (let index = 1; index < encoded.length; index += 1) assert.ok(Buffer.compare(encoded[index - 1], encoded[index]) < 0);
  const one = Buffer.alloc(8);
  writeUint64BE(one, 0, 1n);
  assert.deepEqual([...one], [0, 0, 0, 0, 0, 0, 0, 1]);
});

test('a fingerprint is exactly gramHash output: 16 lowercase hex = one big-endian uint64, full width included', () => {
  const hex = gramHash('the quick brown fox jumps');
  assert.match(hex, /^[0-9a-f]{16}$/);
  assert.equal(fingerprintToHex(fingerprintFromHex(hex)), hex);
  const [hi, lo] = fingerprintHexToHiLo(hex);
  assert.equal(hiLoToFingerprintHex(hi, lo), hex);
  assert.equal(fingerprintFromHex('ffffffffffffffff'), UINT64_MAX);
  assert.equal(fingerprintToHex(UINT64_MAX), 'ffffffffffffffff');
  assert.equal(fingerprintToHex(1n), '0000000000000001');
  assert.deepEqual(fingerprintHexToHiLo('ffffffff00000000'), [0xffffffff, 0]);
  for (const bad of ['FFFFFFFFFFFFFFFF', 'ffff', '0x00000000000001', 'gggggggggggggggg', 12]) {
    assert.throws(() => fingerprintFromHex(bad), CorpusIdError);
  }
});

test('document ids derive deterministically from the normalized-content hash and use the full 64-bit range', () => {
  const hashes = Array.from({ length: 4000 }, (_, index) => index.toString(16).padStart(64, '0'));
  const ids = hashes.map(deriveDocId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(deriveDocId(hashes[7]), ids[7]);
  assert.ok(ids.some((id) => id > MAX_SAFE), 'no derived id exceeded MAX_SAFE_INTEGER');
  assert.ok(ids.some((id) => id >= 2n ** 63n), 'no derived id used the top bit');
  assert.ok(ids.every((id) => id > 0n && id <= UINT64_MAX));
  assert.throws(() => deriveDocId('abc'), CorpusIdError);
  assert.throws(() => deriveDocId('A'.repeat(64)), CorpusIdError);
});

test('the physical partition is the document id prefix: balanced, and splitting one partition moves no other document', () => {
  const ids = Array.from({ length: 8000 }, (_, index) => deriveDocId(index.toString(16).padStart(64, '0')));
  const counts = new Array(4).fill(0);
  for (const id of ids) counts[partitionOfDocId(id, 2)] += 1;
  for (const count of counts) assert.ok(count > 1700 && count < 2300, `unbalanced partitions: ${counts}`);
  // One more bit splits partition p into 2p and 2p+1 and nothing else.
  for (const id of ids) assert.equal(partitionOfDocId(id, 3) >> 1, partitionOfDocId(id, 2));
  assert.equal(partitionOfDocId(UINT64_MAX, 2), 3);
  assert.equal(partitionOfDocId(0n, 2), 0);
  assert.equal(partitionOfDocId(UINT64_MAX, 0), 0);
  assert.throws(() => partitionOfDocId(1n, 13), CorpusIdError);
});

test('varints round-trip the safe range and the full uint64 range, and reject overruns', () => {
  const numbers = [0, 1, 127, 128, 16383, 16384, 0xffffffff, 2 ** 32, 2 ** 48 - 1, Number.MAX_SAFE_INTEGER];
  const writer = new ByteWriter(4);
  for (const value of numbers) writer.writeVarint(value);
  for (const value of BOUNDARY_VALUES) writer.writeVarintBig(value);
  const bytes = writer.toBuffer();
  const reader = new ByteReader(bytes);
  for (const value of numbers) assert.equal(reader.readVarint(), value);
  for (const value of BOUNDARY_VALUES) assert.equal(reader.readVarintBig(), value);
  assert.equal(reader.remaining, 0);

  assert.throws(() => new ByteWriter().writeVarint(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => new ByteWriter().writeVarint(-1), RangeError);
  assert.throws(() => new ByteWriter().writeVarintBig(UINT64_MAX + 1n), RangeError);
  // A uint64 that does not fit a Number is refused by the Number reader, not rounded.
  const big = new ByteWriter();
  big.writeVarintBig(UINT64_MAX);
  assert.throws(() => new ByteReader(big.toBuffer()).readVarint(), CorpusIntegrityError);
  // A truncated varint is an overrun.
  assert.throws(() => new ByteReader(Buffer.from([0x80, 0x80])).readVarint(), CorpusIntegrityError);
  assert.throws(() => new ByteReader(Buffer.from([0xff])).readVarintBig(), CorpusIntegrityError);
});

test('uint48 offsets hold 256 TiB exactly', () => {
  const bytes = Buffer.alloc(6);
  for (const value of [0, 1, 2 ** 32, 2 ** 48 - 1]) {
    writeUint48BE(bytes, 0, value);
    assert.equal(readUint48BE(bytes, 0), value);
  }
  assert.throws(() => writeUint48BE(bytes, 0, 2 ** 48), RangeError);
});

test('postings: sorted ordinals -> delta -> varint, decoded back exactly and compactly', () => {
  const ordinals = [0, 1, 2, 130, 131, 70000, 4000000, 4294967295];
  const writer = new ByteWriter();
  encodePostings(ordinals, writer);
  const bytes = writer.toBuffer();
  assert.deepEqual([...decodePostings(bytes, 0, bytes.length, ordinals.length, 2 ** 32)], ordinals);
  // 2,000 consecutive documents cost one byte each.
  const dense = new ByteWriter();
  encodePostings(Array.from({ length: 2000 }, (_, index) => index + 500), dense);
  assert.equal(dense.length, 2 + 1999);
});

test('postings that are unsorted, repeated or out of range are refused on both sides', () => {
  assert.throws(() => encodePostings([3, 3], new ByteWriter()), RangeError);
  assert.throws(() => encodePostings([5, 4], new ByteWriter()), RangeError);
  assert.throws(() => encodePostings([2 ** 32], new ByteWriter()), RangeError);
  const writer = new ByteWriter();
  encodePostings([1, 5, 9], writer);
  const bytes = writer.toBuffer();
  // ordinal beyond the segment's document count
  assert.throws(() => decodePostings(bytes, 0, bytes.length, 3, 9), CorpusIntegrityError);
  // a list claiming more entries than its bytes hold
  assert.throws(() => decodePostings(bytes, 0, bytes.length, 4, 100), CorpusIntegrityError);
  // a list claiming fewer entries than its bytes hold (trailing bytes)
  assert.throws(() => decodePostings(bytes, 0, bytes.length, 2, 100), CorpusIntegrityError);
  // a zero gap (a repeated document)
  assert.throws(() => decodePostings(Buffer.from([4, 0]), 0, 2, 2, 100), CorpusIntegrityError);
});

test('canonical JSON does not depend on key order and refuses values it cannot represent exactly', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: undefined } }), '{"a":[true,null,"x"],"b":1,"c":{"z":1}}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ id: 5n }), TypeError);
  assert.throws(() => canonicalJson({ value: Number.NaN }), TypeError);
});
