import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson, nodeBytes, sha256Hex, type Bytes } from "./bytes";
import type { CorpusDocumentMetadata } from "./builder";
import {
  DF_HIGH_FILE,
  DF_STATS_FILE,
  GENERATION_MANIFEST_FILE,
  generationIdFromManifestBytes,
  loadGenerationManifest,
  segmentIdFromManifestBytes,
  segmentPrefix,
  writeDocumentFrequencyArtifact,
  type GenerationManifest,
} from "./generation";
import { docIdToDecimal } from "./ids";
import { decodeRecordPackRow, decodeRecordSpan, RECORD_PACK_INDEX_HEADER_BYTES, RECORD_PACK_INDEX_ROW_BYTES, recordPackFileName, recordPackIndexFileName, RecordPackWriter, type RecordCodec } from "./record-pack";
import { RevocationList } from "./revocation";
import {
  encodeDocsFile,
  META_PACK_BASE,
  SEGMENT_FILE_ALIASES,
  SEGMENT_FILE_DOCS,
  SEGMENT_FILE_MANIFEST,
  SegmentIndexWriter,
  SegmentReader,
  TEXT_PACK_BASE,
  type DictionaryHit,
  type SegmentFileEntry,
  type SegmentManifest,
} from "./segment";
import { LocalDirectoryObjectStore, type CorpusObjectStore } from "./storage";
import { INDEX_FORMAT_VERSION } from "./versions";

/**
 * Corpus Engine v1 — the manual compaction primitive.
 *
 * Adding documents only ever appends immutable segments, so a partition's
 * segment count grows with the number of builds. Compaction is the inverse
 * operation, and it is deliberately a plain function an operator runs — there
 * is no background scheduler:
 *
 *   compactPartition(generation G, partition p)
 *     -> ONE new immutable segment holding every non-revoked document of p's
 *        segments
 *     -> a new generation G' = G with p's segments replaced by that one
 *
 * G and its segments are not touched; G' is a candidate that still has to pass
 * publication validation like any other generation.
 *
 * It is also where a REVOKED document is physically removed: its postings, its
 * text and its metadata are simply not copied. (Until then the revocation list
 * hides it; afterwards it is gone from every generation built on G'.)
 *
 * DETERMINISTIC by construction: ordinals follow document-id order, postings
 * are re-merged from the source dictionaries, text spans are copied verbatim
 * after their hash is checked, and aliases recorded later in addenda are
 * folded into the document's own metadata record in source-key order. The
 * output depends only on the input segments and the revocation list — so
 * compacting twice gives the same segment id, and compacting a partition that
 * was built in several increments gives byte-for-byte the segment a single
 * build of the same sources would have produced.
 *
 * Bounded memory: the dictionaries are merged as streams (one batch of
 * postings per input segment in memory), and one document's text at a time.
 *
 * The work is two steps, so several partitions can be compacted at once:
 * compactPartitionSegment writes one partition's segment (independent of every
 * other partition), and assembleCompactedGeneration writes ONE generation in
 * which every listed partition is replaced, with one document-frequency pass.
 * compactPartition is both steps for a single partition.
 */

export type CompactionResult = {
  generationId: string;
  logicalManifestSha256: string;
  parentGenerationId: string;
  partition: number;
  compactedSegmentId: string;
  replacedSegmentIds: string[];
  documentsKept: number;
  documentsPhysicallyRemoved: number;
  postingsKept: number;
  manifest: GenerationManifest;
};

/** One partition's compacted segment, before any generation names it. */
export type CompactedPartitionSegment = {
  partition: number;
  compactedSegmentId: string;
  segmentManifestSha256: string;
  replacedSegmentIds: string[];
  documentsKept: number;
  documentsPhysicallyRemoved: number;
  postingsKept: number;
  keyCount: number;
  fileCount: number;
  bytes: number;
  tokenCountBefore: number;
  tokenCountAfter: number;
  aliasesBefore: number;
  aliasesAfter: number;
};

export type MultiPartitionCompactionResult = {
  generationId: string;
  logicalManifestSha256: string;
  parentGenerationId: string;
  partitions: CompactedPartitionSegment[];
  manifest: GenerationManifest;
};

export class CorpusCompactionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorpusCompactionError";
    this.code = code;
  }
}

function hashFile(file: string): SegmentFileEntry {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function aliasKey(alias: Record<string, unknown>): string {
  return `${String(alias.provider)}\u001f${String(alias.dataset)}\u001f${String(alias.externalId)}`;
}

/** A segment's dictionary as a stream of (fingerprint, postings), read in batches of contiguous postings. */
async function* postingsStream(reader: SegmentReader, batchKeys = 4096): AsyncGenerator<{ fingerprint: bigint; ordinals: Uint32Array }> {
  let batch: DictionaryHit[] = [];
  for await (const hit of reader.iterateDictionary()) {
    batch.push(hit);
    if (batch.length >= batchKeys) {
      const lists = await reader.readPostings(batch);
      for (let index = 0; index < batch.length; index += 1) yield { fingerprint: batch[index].fingerprint, ordinals: lists[index] };
      batch = [];
    }
  }
  if (batch.length > 0) {
    const lists = await reader.readPostings(batch);
    for (let index = 0; index < batch.length; index += 1) yield { fingerprint: batch[index].fingerprint, ordinals: lists[index] };
  }
}

/** A record's still-compressed span, after proving it decodes to the bytes its row promises. */
async function readVerifiedSpan(store: CorpusObjectStore, prefix: string, baseName: string, recordNumber: number, expectedDocId: bigint) {
  const rowBytes = await store.readRange(`${prefix}/${recordPackIndexFileName(baseName)}`, RECORD_PACK_INDEX_HEADER_BYTES + recordNumber * RECORD_PACK_INDEX_ROW_BYTES, RECORD_PACK_INDEX_ROW_BYTES);
  const row = decodeRecordPackRow(rowBytes);
  if (row.docId !== expectedDocId) throw new CorpusCompactionError("RECORD_ROW_MISMATCH", `record ${recordNumber} of ${prefix}/${baseName} belongs to another document`);
  const span = await store.readRange(`${prefix}/${recordPackFileName(baseName, row.packNumber)}`, row.offset, row.spanLength);
  const record = decodeRecordSpan(span, row);
  return { row, span, record };
}

export async function compactPartition(config: {
  corpusRoot: string;
  generationId: string;
  partition: number;
  textPackMaxBytes?: number;
}): Promise<CompactionResult> {
  const segment = await compactPartitionSegment(config);
  const generation = await assembleCompactedGeneration({
    corpusRoot: config.corpusRoot,
    generationId: config.generationId,
    compacted: [segment],
    temporaryName: `.tmp-compact-${config.generationId}-p${String(config.partition).padStart(4, "0")}`,
  });
  return {
    generationId: generation.generationId,
    logicalManifestSha256: generation.logicalManifestSha256,
    parentGenerationId: config.generationId,
    partition: config.partition,
    compactedSegmentId: segment.compactedSegmentId,
    replacedSegmentIds: segment.replacedSegmentIds,
    documentsKept: segment.documentsKept,
    documentsPhysicallyRemoved: segment.documentsPhysicallyRemoved,
    postingsKept: segment.postingsKept,
    manifest: generation.manifest,
  };
}

/** Writes partition `partition`'s compacted segment from generation `generationId`; no generation is written. */
export async function compactPartitionSegment(config: {
  corpusRoot: string;
  generationId: string;
  partition: number;
  textPackMaxBytes?: number;
}): Promise<CompactedPartitionSegment> {
  const store = new LocalDirectoryObjectStore(config.corpusRoot);
  const temporaryDirectory = path.join(config.corpusRoot, "segments", `.tmp-compact-${config.generationId}-p${String(config.partition).padStart(4, "0")}`);
  try {
    const { manifest } = await loadGenerationManifest(store, config.generationId);
    const entry = manifest.partitions[config.partition];
    if (!entry) throw new CorpusCompactionError("NO_SUCH_PARTITION", `generation ${config.generationId} has no partition ${config.partition}`);
    if (entry.segmentIds.length === 0) throw new CorpusCompactionError("NOTHING_TO_COMPACT", `partition ${config.partition} has no segments`);
    const revocations = RevocationList.parse(nodeBytes(readFileSync(path.join(config.corpusRoot, "revocations", "revocations.jsonl"))));

    // Compaction must never launder damage into a fresh segment: every input file is fully hashed first.
    const readers: SegmentReader[] = [];
    for (const segmentId of entry.segmentIds) {
      readers.push(await SegmentReader.open(store, segmentPrefix(segmentId), segmentId, manifest.segments[segmentId].manifestSha256, { verify: "sha256", dictionaryBlockCacheBlocks: 0 }));
    }

    // ── the surviving documents, in document-id order, and each input ordinal's new ordinal ──
    const kept: Array<{ docId: bigint; reader: number; ordinal: number; tokenCount: number; fingerprintCount: number }> = [];
    let removed = 0;
    readers.forEach((reader, readerIndex) => {
      for (let ordinal = 0; ordinal < reader.documentCount; ordinal += 1) {
        if (revocations.has(reader.docIds[ordinal])) removed += 1;
        else kept.push({ docId: reader.docIds[ordinal], reader: readerIndex, ordinal, tokenCount: reader.tokenCounts[ordinal], fingerprintCount: reader.fingerprintCounts[ordinal] });
      }
    });
    kept.sort((left, right) => (left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0));
    for (let index = 1; index < kept.length; index += 1) {
      if (kept[index].docId === kept[index - 1].docId) throw new CorpusCompactionError("DUPLICATE_DOCUMENT", `document ${kept[index].docId} is in two segments of partition ${config.partition}`);
    }
    const remap = readers.map((reader) => new Int32Array(reader.documentCount).fill(-1));
    kept.forEach((document, newOrdinal) => {
      remap[document.reader][document.ordinal] = newOrdinal;
    });

    rmSync(temporaryDirectory, { recursive: true, force: true });
    mkdirSync(temporaryDirectory, { recursive: true });

    // ── index: k-way merge of the input dictionaries, ordinals remapped ──
    const blockEntries = readers[0].manifest.blockEntries;
    const indexWriter = new SegmentIndexWriter(temporaryDirectory, blockEntries);
    const postingsPerOrdinal = new Uint32Array(kept.length);
    const streams = readers.map((reader) => postingsStream(reader));
    const heads: Array<{ fingerprint: bigint; ordinals: Uint32Array } | null> = [];
    for (const stream of streams) {
      const next = await stream.next();
      heads.push(next.done ? null : next.value);
    }
    for (;;) {
      let smallest: bigint | null = null;
      for (const head of heads) if (head && (smallest === null || head.fingerprint < smallest)) smallest = head.fingerprint;
      if (smallest === null) break;
      const merged: number[] = [];
      for (let index = 0; index < heads.length; index += 1) {
        const head = heads[index];
        if (!head || head.fingerprint !== smallest) continue;
        for (const ordinal of head.ordinals) {
          const mapped = remap[index][ordinal];
          if (mapped >= 0) merged.push(mapped);
        }
        const next = await streams[index].next();
        heads[index] = next.done ? null : next.value;
      }
      if (merged.length === 0) continue; // a fingerprint held only by removed documents disappears with them
      merged.sort((left, right) => left - right);
      for (const ordinal of merged) postingsPerOrdinal[ordinal] += 1;
      indexWriter.addKey(smallest, merged);
    }
    const indexStats = indexWriter.finish();
    kept.forEach((document, ordinal) => {
      if (postingsPerOrdinal[ordinal] !== document.fingerprintCount) {
        throw new CorpusCompactionError("POSTINGS_COUNT_MISMATCH", `document ${document.docId} has ${postingsPerOrdinal[ordinal]} postings after compaction, expected ${document.fingerprintCount}`);
      }
    });

    // ── aliases recorded later, in any input segment's addenda ──
    const addenda = new Map<string, Array<Record<string, unknown>>>();
    for (const reader of readers) {
      for (const addendum of await reader.readAliasAddenda()) {
        const list = addenda.get(addendum.docId) ?? [];
        list.push(addendum.alias as Record<string, unknown>);
        addenda.set(addendum.docId, list);
      }
    }

    // ── docs, text (spans copied verbatim once verified), metadata (addenda folded in) ──
    writeFileSync(path.join(temporaryDirectory, SEGMENT_FILE_DOCS), encodeDocsFile(kept.map((document) => ({ docId: document.docId, tokenCount: document.tokenCount, fingerprintCount: document.fingerprintCount }))));
    const maxPackBytes = config.textPackMaxBytes ?? 256 * 1024 * 1024;
    const textWriter = new RecordPackWriter(temporaryDirectory, TEXT_PACK_BASE, { maxPackBytes });
    const metaWriter = new RecordPackWriter(temporaryDirectory, META_PACK_BASE, { maxPackBytes });
    let tokenCount = 0;
    let aliasesAfter = 0;
    let aliasesBefore = [...addenda.values()].reduce((total, list) => total + list.length, 0);
    for (const document of kept) {
      const reader = readers[document.reader];
      const text = await readVerifiedSpan(store, reader.prefix, TEXT_PACK_BASE, document.ordinal, document.docId);
      textWriter.appendSpan(document.docId, { span: text.span, uncompressedLength: text.row.uncompressedLength, chunkCount: text.row.chunkCount, sha256: text.row.sha256, codec: text.row.codec as RecordCodec });
      const stored = JSON.parse((await readVerifiedSpan(store, reader.prefix, META_PACK_BASE, document.ordinal, document.docId)).record.toString("utf8")) as CorpusDocumentMetadata;
      aliasesBefore += stored.aliases.length;
      const later = addenda.get(stored.docId) ?? [];
      const aliases = [...stored.aliases, ...later].sort((left, right) => (aliasKey(left) < aliasKey(right) ? -1 : aliasKey(left) > aliasKey(right) ? 1 : 0));
      const metadata: CorpusDocumentMetadata = {
        ...stored,
        aliases,
        duplicateCluster: { ...stored.duplicateCluster, memberCount: aliases.length + 1 },
        syntheticLoadOnly: stored.syntheticLoadOnly && later.every((alias) => alias.syntheticLoadOnly === true),
      };
      metaWriter.append(document.docId, Buffer.from(canonicalJson(metadata), "utf8"));
      tokenCount += document.tokenCount;
      aliasesAfter += aliases.length;
    }
    // aliases of the documents being removed leave the corpus with them
    for (let readerIndex = 0; readerIndex < readers.length; readerIndex += 1) {
      const reader = readers[readerIndex];
      for (let ordinal = 0; ordinal < reader.documentCount; ordinal += 1) {
        if (remap[readerIndex][ordinal] >= 0) continue;
        aliasesBefore += ((await reader.readMetadata(ordinal)).metadata as CorpusDocumentMetadata).aliases.length;
      }
    }
    const textResult = textWriter.finish();
    const metaResult = metaWriter.finish();
    writeFileSync(path.join(temporaryDirectory, SEGMENT_FILE_ALIASES), "");

    const files: Record<string, SegmentFileEntry> = {};
    for (const name of readdirSync(temporaryDirectory).sort()) files[name] = hashFile(path.join(temporaryDirectory, name));
    const segmentManifest: SegmentManifest = {
      segmentFormat: INDEX_FORMAT_VERSION,
      partition: config.partition,
      partitionBits: manifest.partitionBits,
      documentCount: kept.length,
      tokenCount,
      keyCount: indexStats.keyCount,
      postingsCount: indexStats.postingsCount,
      maxPostingsLength: indexStats.maxPostingsLength,
      blockEntries,
      blockCount: indexStats.blockCount,
      docIdMin: kept.length > 0 ? docIdToDecimal(kept[0].docId) : null,
      docIdMax: kept.length > 0 ? docIdToDecimal(kept[kept.length - 1].docId) : null,
      textPackCount: textResult.packFiles.length,
      textUncompressedBytes: textResult.uncompressedBytes,
      metaPackCount: metaResult.packFiles.length,
      aliasAddendumCount: 0,
      dfHistogram: indexStats.dfHistogram,
      topFingerprints: indexStats.topFingerprints,
      files,
    };
    const segmentManifestBytes: Bytes = Buffer.from(canonicalJson(segmentManifest), "utf8");
    writeFileSync(path.join(temporaryDirectory, SEGMENT_FILE_MANIFEST), segmentManifestBytes);
    const compactedSegmentId = segmentIdFromManifestBytes(segmentManifestBytes);
    const finalDirectory = path.join(config.corpusRoot, "segments", compactedSegmentId);
    if (existsSync(finalDirectory)) {
      if (!nodeBytes(readFileSync(path.join(finalDirectory, SEGMENT_FILE_MANIFEST))).equals(segmentManifestBytes)) {
        throw new CorpusCompactionError("SEGMENT_ID_CONFLICT", `segment ${compactedSegmentId} exists with a different manifest`);
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
    } else {
      renameSync(temporaryDirectory, finalDirectory);
    }
    return {
      partition: config.partition,
      compactedSegmentId,
      segmentManifestSha256: sha256Hex(segmentManifestBytes),
      replacedSegmentIds: [...entry.segmentIds],
      documentsKept: kept.length,
      documentsPhysicallyRemoved: removed,
      postingsKept: indexStats.postingsCount,
      keyCount: indexStats.keyCount,
      fileCount: Object.keys(files).length + 1,
      bytes: Object.values(files).reduce((total, file) => total + file.bytes, 0),
      tokenCountBefore: readers.reduce((total, reader) => total + reader.manifest.tokenCount, 0),
      tokenCountAfter: tokenCount,
      aliasesBefore,
      aliasesAfter,
    };
  } finally {
    await store.close();
  }
}

/**
 * Writes ONE generation: `generationId` with every listed partition's segments replaced by its compacted
 * segment. Each compacted segment must exist with the manifest its result names and must replace exactly
 * that partition's segments in `generationId`.
 */
export async function assembleCompactedGeneration(config: {
  corpusRoot: string;
  generationId: string;
  compacted: readonly CompactedPartitionSegment[];
  temporaryName?: string;
}): Promise<MultiPartitionCompactionResult> {
  const store = new LocalDirectoryObjectStore(config.corpusRoot);
  const generationTemporary = path.join(config.corpusRoot, "generations", config.temporaryName ?? `.tmp-compact-${config.generationId}-multi`);
  try {
    const { manifest } = await loadGenerationManifest(store, config.generationId);
    const compacted = [...config.compacted].sort((left, right) => left.partition - right.partition);
    const segments = { ...manifest.segments };
    const replaced = new Map<number, string>();
    for (const item of compacted) {
      if (replaced.has(item.partition)) throw new CorpusCompactionError("DUPLICATE_PARTITION", `partition ${item.partition} is listed twice`);
      const entry = manifest.partitions[item.partition];
      if (!entry || entry.segmentIds.join(",") !== item.replacedSegmentIds.join(",")) {
        throw new CorpusCompactionError("PARTITION_MISMATCH", `the compacted segment of partition ${item.partition} was not made from generation ${config.generationId}`);
      }
      const segmentManifestBytes = nodeBytes(readFileSync(path.join(config.corpusRoot, "segments", item.compactedSegmentId, SEGMENT_FILE_MANIFEST)));
      if (sha256Hex(segmentManifestBytes) !== item.segmentManifestSha256 || segmentIdFromManifestBytes(segmentManifestBytes) !== item.compactedSegmentId) {
        throw new CorpusCompactionError("SEGMENT_MANIFEST_MISMATCH", `segment ${item.compactedSegmentId} does not have the manifest its compaction result names`);
      }
      for (const segmentId of entry.segmentIds) delete segments[segmentId];
      segments[item.compactedSegmentId] = {
        partition: item.partition,
        manifestSha256: item.segmentManifestSha256,
        documentCount: item.documentsKept,
        keyCount: item.keyCount,
        postingsCount: item.postingsKept,
        fileCount: item.fileCount,
        bytes: item.bytes,
      };
      replaced.set(item.partition, item.compactedSegmentId);
    }
    const partitions = manifest.partitions.map((item) => (replaced.has(item.partition) ? { partition: item.partition, segmentIds: [replaced.get(item.partition) as string] } : item));

    rmSync(generationTemporary, { recursive: true, force: true });
    mkdirSync(generationTemporary, { recursive: true });
    const active: SegmentReader[] = [];
    for (const item of partitions) {
      for (const segmentId of item.segmentIds) {
        active.push(await SegmentReader.open(store, segmentPrefix(segmentId), segmentId, segments[segmentId].manifestSha256, { verify: "size", dictionaryBlockCacheBlocks: 0 }));
      }
    }
    const documentFrequency = await writeDocumentFrequencyArtifact(active, generationTemporary, manifest.documentFrequency.recordFloor);
    const dfFile = (name: string): SegmentFileEntry => ({ bytes: statSync(path.join(generationTemporary, name)).size, sha256: sha256Hex(nodeBytes(readFileSync(path.join(generationTemporary, name)))) });
    const documentCount = Object.values(segments).reduce((total, item) => total + item.documentCount, 0);
    const aliasCount = manifest.aliasCount - compacted.reduce((total, item) => total + item.aliasesBefore - item.aliasesAfter, 0);
    const compactedManifest: GenerationManifest = {
      ...manifest,
      parentGenerationId: config.generationId,
      documentCount,
      aliasCount,
      logicalSourceCount: documentCount + aliasCount,
      tokenCount: manifest.tokenCount - compacted.reduce((total, item) => total + item.tokenCountBefore - item.tokenCountAfter, 0),
      distinctFingerprintCount: documentFrequency.distinctFingerprintCount,
      postingsCount: documentFrequency.postingsCount,
      maxPostingsLength: documentFrequency.maxDocumentFrequency,
      partitions,
      segments,
      documentFrequency: {
        recordFloor: manifest.documentFrequency.recordFloor,
        highEntryCount: documentFrequency.highEntryCount,
        files: { [DF_HIGH_FILE]: dfFile(DF_HIGH_FILE), [DF_STATS_FILE]: dfFile(DF_STATS_FILE) },
      },
    };
    const manifestBytes: Bytes = Buffer.from(canonicalJson(compactedManifest), "utf8");
    const generationId = generationIdFromManifestBytes(manifestBytes);
    writeFileSync(path.join(generationTemporary, GENERATION_MANIFEST_FILE), manifestBytes);
    const generationDirectory = path.join(config.corpusRoot, "generations", generationId);
    if (existsSync(generationDirectory)) rmSync(generationTemporary, { recursive: true, force: true });
    else renameSync(generationTemporary, generationDirectory);

    return { generationId, logicalManifestSha256: sha256Hex(manifestBytes), parentGenerationId: config.generationId, partitions: compacted, manifest: compactedManifest };
  } finally {
    await store.close();
  }
}
