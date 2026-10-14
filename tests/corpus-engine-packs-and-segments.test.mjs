import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, flipByte, inventedText, prng, removeScratch } from './helpers/corpus-engine-fixtures.mjs';
import { CorpusIntegrityError, canonicalJson, sha256Hex } from '../lib/corpus-engine/bytes.ts';
import { mergeRuns, RunBuffer, RUN_RECORD_BYTES } from '../lib/corpus-engine/external-sort.ts';
import { fingerprintToHex, hiLoToUint64 } from '../lib/corpus-engine/ids.ts';
import {
  RECORD_CODEC_RAW,
  RECORD_CODEC_ZSTD,
  RECORD_PACK_HEADER_BYTES,
  RECORD_PACK_INDEX_ROW_BYTES,
  RecordPackWriter,
  decodeRecordSpan,
  encodeRecordSpan,
  readPackedRecord,
} from '../lib/corpus-engine/record-pack.ts';
import {
  CorpusSegmentError,
  SEGMENT_FILE_DICT,
  SEGMENT_FILE_DOCS,
  SEGMENT_FILE_POSTINGS,
  SegmentIndexWriter,
  SegmentReader,
  encodeDocsFile,
} from '../lib/corpus-engine/segment.ts';
import { INDEX_FORMAT_VERSION } from '../lib/corpus-engine/versions.ts';
import { CorpusStorageError, FaultInjectingObjectStore, LocalDirectoryObjectStore } from '../lib/corpus-engine/storage.ts';

/**
 * Corpus Engine v1 — the three storage primitives under the builder:
 * random-access record packs, the external sort, and one index segment.
 */

const scratch = corpusEngineScratch('packs-segments');
test.after(() => removeScratch(scratch));

// ── record packs ────────────────────────────────────────────────────────────

test('record pack: every record is retrieved by its own range read and decoded on its own', async () => {
  const directory = path.join(scratch, 'pack-random-access');
  fs.mkdirSync(directory, { recursive: true });
  const records = Array.from({ length: 40 }, (_, index) => Buffer.from(inventedText(1000 + index, 200 + index * 37), 'utf8'));
  const writer = new RecordPackWriter(directory, 'text', { maxPackBytes: 64 * 1024 * 1024 });
  const rows = records.map((record, index) => writer.append(BigInt(index + 1) * 1000003n, record));
  const result = writer.finish();
  assert.equal(result.recordCount, 40);
  assert.equal(result.packFiles.length, 1);
  assert.equal(result.indexBytes, 16 + 40 * RECORD_PACK_INDEX_ROW_BYTES);

  const store = new LocalDirectoryObjectStore(scratch);
  try {
    // Read in an order unrelated to write order; each read must touch only its own bytes.
    for (const index of [39, 0, 17, 5, 38, 1]) {
      store.resetStats();
      const { record, metrics } = await readPackedRecord(store, 'pack-random-access', 'text', index, BigInt(index + 1) * 1000003n);
      assert.ok(record.equals(records[index]));
      const stats = store.stats();
      assert.equal(stats.rangeReads, 2, 'one row read + one span read');
      assert.equal(stats.wholeReads, 0);
      assert.equal(stats.bytesRead, RECORD_PACK_INDEX_ROW_BYTES + rows[index].spanLength, 'read exactly the row and the span');
      assert.equal(metrics.compressedBytesRead, RECORD_PACK_INDEX_ROW_BYTES + rows[index].spanLength);
      assert.equal(metrics.decompressedBytes, records[index].length);
    }
    // The last record costs the same as the first: nothing is decompressed "from the beginning".
    const first = rows[0].spanLength;
    const last = rows[39].spanLength;
    assert.ok(result.packBytes > 10 * Math.max(first, last));
  } finally {
    await store.close();
  }
});

test('record pack: a large record is cut into bounded, independently compressed chunks', () => {
  const record = Buffer.from(inventedText(77, 9000), 'utf8');
  const encoded = encodeRecordSpan(record, RECORD_CODEC_ZSTD, 9, 4096);
  assert.equal(encoded.chunkCount, Math.ceil(record.length / 4096));
  assert.ok(encoded.span.length < record.length);
  assert.ok(decodeRecordSpan(encoded.span, { ...encoded, spanLength: encoded.span.length }).equals(record));
  // An empty record is a legal, single empty chunk.
  const empty = encodeRecordSpan(Buffer.alloc(0));
  assert.equal(empty.chunkCount, 1);
  assert.equal(decodeRecordSpan(empty.span, { ...empty, spanLength: empty.span.length }).length, 0);
  // The raw codec is the same framing without compression.
  const raw = encodeRecordSpan(record, RECORD_CODEC_RAW, 0, 4096);
  assert.ok(decodeRecordSpan(raw.span, { ...raw, spanLength: raw.span.length }).equals(record));
});

test('record pack: identical input gives identical bytes', () => {
  const record = Buffer.from(inventedText(5, 1500), 'utf8');
  assert.ok(encodeRecordSpan(record).span.equals(encodeRecordSpan(record).span));
});

test('record pack: corruption, truncation and a row/document mix-up are all reported, never returned as text', async () => {
  const directory = path.join(scratch, 'pack-corrupt');
  fs.mkdirSync(directory, { recursive: true });
  const records = [0, 1, 2].map((index) => Buffer.from(inventedText(300 + index, 400), 'utf8'));
  const writer = new RecordPackWriter(directory, 'text', { maxPackBytes: 1 << 26 });
  const rows = records.map((record, index) => writer.append(BigInt(index + 10), record));
  writer.finish();
  const store = new LocalDirectoryObjectStore(scratch);
  try {
    // wrong expected document for the row
    await assert.rejects(readPackedRecord(store, 'pack-corrupt', 'text', 1, 999n), (error) => error instanceof CorpusIntegrityError && error.code === 'RECORD_ROW_MISMATCH');
    // a flipped byte inside record 1's compressed data
    const restore = flipByte(path.join(directory, 'text-0000.pack'), rows[1].offset + 20);
    await assert.rejects(readPackedRecord(store, 'pack-corrupt', 'text', 1, 11n), (error) => error instanceof CorpusIntegrityError);
    // its neighbours are untouched and still read fine
    assert.ok((await readPackedRecord(store, 'pack-corrupt', 'text', 0, 10n)).record.equals(records[0]));
    assert.ok((await readPackedRecord(store, 'pack-corrupt', 'text', 2, 12n)).record.equals(records[2]));
    restore();
    assert.ok((await readPackedRecord(store, 'pack-corrupt', 'text', 1, 11n)).record.equals(records[1]));
    // a truncated pack is a short read
    await store.close();
    fs.truncateSync(path.join(directory, 'text-0000.pack'), rows[2].offset + 5);
    const reopened = new LocalDirectoryObjectStore(scratch);
    await assert.rejects(readPackedRecord(reopened, 'pack-corrupt', 'text', 2, 12n), (error) => error instanceof CorpusStorageError && error.code === 'SHORT_READ');
    await reopened.close();
  } finally {
    await store.close();
  }
});

test('record pack: packs roll at the size bound and rows still locate every record', async () => {
  const directory = path.join(scratch, 'pack-roll');
  fs.mkdirSync(directory, { recursive: true });
  const records = Array.from({ length: 12 }, (_, index) => Buffer.from(inventedText(900 + index, 800), 'utf8'));
  const writer = new RecordPackWriter(directory, 'text', { maxPackBytes: 6000 });
  records.forEach((record, index) => writer.append(BigInt(index + 1), record));
  const result = writer.finish();
  assert.ok(result.packFiles.length > 2);
  for (const name of result.packFiles) assert.ok(fs.statSync(path.join(directory, name)).size > RECORD_PACK_HEADER_BYTES);
  const store = new LocalDirectoryObjectStore(scratch);
  try {
    for (let index = 0; index < records.length; index += 1) {
      assert.ok((await readPackedRecord(store, 'pack-roll', 'text', index, BigInt(index + 1))).record.equals(records[index]));
    }
  } finally {
    await store.close();
  }
});

// ── external sort ───────────────────────────────────────────────────────────

function randomTuples(seed, count) {
  const random = prng(seed);
  const tuples = [];
  for (let index = 0; index < count; index += 1) {
    // few distinct fingerprints and documents, so groups and duplicates occur
    tuples.push([Math.floor(random() * 4) * 0x3fffffff, Math.floor(random() * 50), Math.floor(random() * 3) * 0x7fffffff, Math.floor(random() * 40)]);
  }
  return tuples;
}

const tupleKey = (tuple) => `${fingerprintToHex(hiLoToUint64(tuple[0], tuple[1]))}:${fingerprintToHex(hiLoToUint64(tuple[2], tuple[3]))}`;

test('external sort: runs are sorted and de-duplicated, and the merge equals an in-memory sort for every fan-in', () => {
  const directory = path.join(scratch, 'sort');
  fs.mkdirSync(directory, { recursive: true });
  const tuples = randomTuples(42, 5000);
  const expected = [...new Set(tuples.map(tupleKey))].sort();

  const buffer = new RunBuffer(300);
  const runs = [];
  for (const tuple of tuples) {
    if (!buffer.add(...tuple)) {
      runs.push(buffer.spill(path.join(directory, `r${runs.length}.run`)));
      assert.ok(buffer.add(...tuple));
    }
  }
  const tail = buffer.spill(path.join(directory, `r${runs.length}.run`));
  if (tail) runs.push(tail);
  assert.ok(runs.length >= 16, `expected many runs, got ${runs.length}`);
  for (const run of runs) {
    assert.equal(fs.statSync(run.path).size, run.tuples * RUN_RECORD_BYTES);
    assert.equal(sha256Hex(fs.readFileSync(run.path)), run.sha256);
  }

  for (const maxFanIn of [2, 3, 5, 64]) {
    const merged = [];
    const stats = mergeRuns(runs.map((run) => run.path), { maxFanIn, readBufferBytes: 64, scratchDirectory: directory, scratchPrefix: `m${maxFanIn}` }, (...tuple) => merged.push(tupleKey(tuple)));
    assert.deepEqual(merged, expected, `fan-in ${maxFanIn}`);
    assert.equal(stats.tuplesOut, expected.length);
    assert.ok(stats.maxFanInUsed <= maxFanIn, `fan-in bound ${maxFanIn} exceeded: ${stats.maxFanInUsed}`);
    if (maxFanIn < runs.length) assert.ok(stats.passes > 1 && stats.intermediateRuns > 0, 'a small fan-in must merge in several passes');
    else assert.equal(stats.passes, 1);
    // intermediate runs are gone
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith(`m${maxFanIn}-`)), []);
  }
});

test('external sort: a tuple spilled twice (a retried batch) appears once in the merge', () => {
  const directory = path.join(scratch, 'sort-retry');
  fs.mkdirSync(directory, { recursive: true });
  const tuples = randomTuples(7, 400);
  const first = new RunBuffer(1000);
  const again = new RunBuffer(1000);
  for (const tuple of tuples) {
    first.add(...tuple);
    again.add(...tuple);
  }
  const runs = [first.spill(path.join(directory, 'a.run')), again.spill(path.join(directory, 'b.run'))];
  const merged = [];
  mergeRuns(runs.map((run) => run.path), { maxFanIn: 8, readBufferBytes: 4096, scratchDirectory: directory, scratchPrefix: 'x' }, (...tuple) => merged.push(tupleKey(tuple)));
  assert.deepEqual(merged, [...new Set(tuples.map(tupleKey))].sort());
});

// ── index segment ───────────────────────────────────────────────────────────

/** Builds a segment directory holding only the index + doc table (enough for SegmentReader's index path). */
function writeIndexOnlySegment(name, postingsByKey, documentCount, blockEntries) {
  const directory = path.join(scratch, 'segments', name);
  fs.mkdirSync(directory, { recursive: true });
  const writer = new SegmentIndexWriter(directory, blockEntries);
  for (const key of [...postingsByKey.keys()].sort((left, right) => (left < right ? -1 : 1))) writer.addKey(key, postingsByKey.get(key));
  const stats = writer.finish();
  fs.writeFileSync(path.join(directory, SEGMENT_FILE_DOCS), encodeDocsFile(Array.from({ length: documentCount }, (_, ordinal) => ({ docId: BigInt(ordinal + 1) * 7919n, tokenCount: 100 + ordinal, fingerprintCount: 0 }))));
  const files = {};
  for (const file of fs.readdirSync(directory).sort()) {
    const bytes = fs.readFileSync(path.join(directory, file));
    files[file] = { bytes: bytes.length, sha256: sha256Hex(bytes) };
  }
  const manifest = {
    segmentFormat: INDEX_FORMAT_VERSION, partition: 0, partitionBits: 0, documentCount, tokenCount: 0,
    keyCount: stats.keyCount, postingsCount: stats.postingsCount, maxPostingsLength: stats.maxPostingsLength,
    blockEntries, blockCount: stats.blockCount, docIdMin: null, docIdMax: null, textPackCount: 0, textUncompressedBytes: 0,
    metaPackCount: 0, aliasAddendumCount: 0, dfHistogram: stats.dfHistogram, topFingerprints: stats.topFingerprints, files,
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  fs.writeFileSync(path.join(directory, 'segment.json'), manifestBytes);
  return { directory, stats, manifestSha256: sha256Hex(manifestBytes), prefix: `segments/${name}` };
}

function randomIndex(seed, keyCount, documentCount) {
  const random = prng(seed);
  const postingsByKey = new Map();
  while (postingsByKey.size < keyCount) {
    const key = hiLoToUint64(Math.floor(random() * 0x100000000), Math.floor(random() * 0x100000000));
    const df = random() < 0.9 ? 1 + Math.floor(random() * 3) : 1 + Math.floor(random() * documentCount);
    const ordinals = new Set();
    while (ordinals.size < Math.min(df, documentCount)) ordinals.add(Math.floor(random() * documentCount));
    postingsByKey.set(key, [...ordinals].sort((left, right) => left - right));
  }
  return postingsByKey;
}

test('segment: lookups return exactly the written postings, for present and absent keys, across block boundaries', async () => {
  const documentCount = 500;
  const postingsByKey = randomIndex(11, 3000, documentCount);
  // boundary keys: the smallest and largest possible fingerprints
  postingsByKey.set(0n, [0, 499]);
  postingsByKey.set(2n ** 64n - 1n, [1, 2, 3]);
  const segment = writeIndexOnlySegment('exact', postingsByKey, documentCount, 16);
  assert.equal(segment.stats.keyCount, postingsByKey.size);
  assert.equal(segment.stats.blockCount, Math.ceil(postingsByKey.size / 16));
  assert.equal(segment.stats.postingsCount, [...postingsByKey.values()].reduce((total, list) => total + list.length, 0));

  const store = new LocalDirectoryObjectStore(scratch);
  try {
    const reader = await SegmentReader.open(store, segment.prefix, 'seg-exact', segment.manifestSha256, { verify: 'sha256' });
    const present = [...postingsByKey.keys()];
    const absent = [1n, 12345678901234567890n, 2n ** 64n - 2n].filter((key) => !postingsByKey.has(key));
    const queried = [...present, ...absent].sort((left, right) => (left < right ? -1 : 1));
    const hits = await reader.lookupDictionary(queried);
    const found = hits.filter(Boolean);
    assert.equal(found.length, present.length);
    const lists = await reader.readPostings(found);
    found.forEach((hit, index) => {
      assert.deepEqual([...lists[index]], postingsByKey.get(hit.fingerprint));
      assert.equal(hit.df, postingsByKey.get(hit.fingerprint).length);
    });
    queried.forEach((key, index) => assert.equal(hits[index] !== null, postingsByKey.has(key)));

    // iterateDictionary walks every key once, in order
    const walked = [];
    for await (const hit of reader.iterateDictionary(7)) walked.push(hit.fingerprint);
    assert.deepEqual(walked, [...present].sort((left, right) => (left < right ? -1 : 1)));

    // ordinalOf is exact
    assert.equal(reader.ordinalOf(7919n), 0);
    assert.equal(reader.ordinalOf(7919n * 500n), 499);
    assert.equal(reader.ordinalOf(7920n), -1);
  } finally {
    await store.close();
  }
});

test('segment: a lookup reads only the dictionary blocks and postings it needs — never the whole index', async () => {
  const documentCount = 2000;
  const postingsByKey = randomIndex(23, 20000, documentCount);
  const segment = writeIndexOnlySegment('bounded', postingsByKey, documentCount, 128);
  const store = new LocalDirectoryObjectStore(scratch);
  try {
    const reader = await SegmentReader.open(store, segment.prefix, 'seg-bounded', segment.manifestSha256, { verify: 'size', dictionaryBlockCacheBlocks: 0 });
    const keys = [...postingsByKey.keys()].sort((left, right) => (left < right ? -1 : 1));
    const queried = [keys[10], keys[9000], keys[19990]];
    store.resetStats();
    const hits = await reader.lookupDictionary(queried);
    await reader.readPostings(hits.filter(Boolean));
    const read = store.stats().bytesRead;
    const indexBytes = fs.statSync(path.join(segment.directory, SEGMENT_FILE_DICT)).size + fs.statSync(path.join(segment.directory, SEGMENT_FILE_POSTINGS)).size;
    assert.equal(reader.counters.dictionaryBlocksRead, 3);
    assert.ok(read < indexBytes / 20, `read ${read} of ${indexBytes} index bytes for 3 keys`);
  } finally {
    await store.close();
  }
});

test('segment: every kind of damage is detected at open or at lookup, with a code, and never read as "no match"', async () => {
  const documentCount = 200;
  const postingsByKey = randomIndex(31, 600, documentCount);
  const segment = writeIndexOnlySegment('damage', postingsByKey, documentCount, 32);
  const keys = [...postingsByKey.keys()].sort((left, right) => (left < right ? -1 : 1));
  const base = new LocalDirectoryObjectStore(scratch);
  const store = new FaultInjectingObjectStore(base);
  const open = (verify) => SegmentReader.open(store, segment.prefix, 'seg-damage', segment.manifestSha256, { verify, dictionaryBlockCacheBlocks: 0 });
  const coded = (code) => (error) => error instanceof CorpusSegmentError && error.code === code;
  try {
    // a healthy segment opens at both verification levels
    await open('sha256');
    const healthy = await open('size');

    // wrong pinned manifest hash
    await assert.rejects(SegmentReader.open(store, segment.prefix, 'seg-damage', '0'.repeat(64)), coded('INTEGRITY_MISMATCH'));

    // missing file -> MISSING, even at the cheap level
    store.setFault(`${segment.prefix}/${SEGMENT_FILE_POSTINGS}`, 'missing');
    await assert.rejects(open('size'), coded('MISSING'));
    store.clearFaults();

    // the resident doc table is always hash-checked
    store.setFault(`${segment.prefix}/${SEGMENT_FILE_DOCS}`, 'corrupt');
    await assert.rejects(open('size'), coded('INTEGRITY_MISMATCH'));
    store.clearFaults();

    // a flipped dictionary byte: caught by the full-hash level at open...
    store.setFault(`${segment.prefix}/${SEGMENT_FILE_DICT}`, 'corrupt');
    await assert.rejects(open('sha256'), coded('INTEGRITY_MISMATCH'));
    store.clearFaults();
    // ...and by the per-block checksum at lookup when opened at the cheap level
    store.setFault(`${segment.prefix}/${SEGMENT_FILE_DICT}`, 'corrupt', 32 + 10 + 4);
    await assert.rejects(healthy.lookupDictionary([keys[0]]), coded('INTEGRITY_MISMATCH'));
    store.clearFaults();

    // a postings file that becomes unreadable after open
    const [hit] = await healthy.lookupDictionary([keys[5]]);
    store.setFault(`${segment.prefix}/${SEGMENT_FILE_POSTINGS}`, 'unreadable');
    await assert.rejects(healthy.readPostings([hit]), coded('UNREADABLE'));
    store.clearFaults();

    // truncation on disk -> size mismatch at open
    await store.close();
    fs.truncateSync(path.join(segment.directory, SEGMENT_FILE_POSTINGS), fs.statSync(path.join(segment.directory, SEGMENT_FILE_POSTINGS)).size - 3);
    const fresh = new LocalDirectoryObjectStore(scratch);
    await assert.rejects(SegmentReader.open(fresh, segment.prefix, 'seg-damage', segment.manifestSha256, { verify: 'size' }), coded('CORRUPT'));
    await fresh.close();
  } finally {
    await store.close();
  }
});

test('segment: bytes depend only on content — the same keys written twice give identical files', () => {
  const postingsByKey = randomIndex(5, 800, 300);
  const first = writeIndexOnlySegment('same-a', postingsByKey, 300, 64);
  const second = writeIndexOnlySegment('same-b', postingsByKey, 300, 64);
  assert.equal(first.manifestSha256, second.manifestSha256);
  for (const file of fs.readdirSync(first.directory)) {
    assert.ok(fs.readFileSync(path.join(first.directory, file)).equals(fs.readFileSync(path.join(second.directory, file))), file);
  }
});

test('local object store: open handles stay under the configured bound', async () => {
  const directory = path.join(scratch, 'handles');
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(directory, `f${index}.bin`), Buffer.alloc(64, index));
  const store = new LocalDirectoryObjectStore(scratch, 8);
  try {
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < 30; index += 1) {
        const bytes = await store.readRange(`handles/f${index}.bin`, 8, 16);
        assert.equal(bytes[0], index);
      }
    }
    assert.ok(store.stats().peakOpenHandles <= 9, `peak ${store.stats().peakOpenHandles}`);
    await assert.rejects(store.readRange('handles/missing.bin', 0, 1), (error) => error instanceof CorpusStorageError && error.code === 'NOT_FOUND');
    await assert.rejects(store.readRange('../escape', 0, 1), (error) => error instanceof CorpusStorageError && error.code === 'INVALID_KEY');
    await assert.rejects(store.readRange('handles/f1.bin', 60, 16), (error) => error instanceof CorpusStorageError && error.code === 'SHORT_READ');
  } finally {
    await store.close();
  }
});
