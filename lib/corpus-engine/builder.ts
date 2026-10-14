import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalJson, nodeBytes, sha256Hex, type Bytes } from "./bytes";
import { mergeRuns, RunBuffer, type MergeStats } from "./external-sort";
import { documentFingerprintHexes, normalizeForCorpus } from "./fingerprints";
import {
  BUILD_EVENT_FILE,
  CorpusGenerationError,
  DF_HIGH_FILE,
  DF_STATS_FILE,
  GENERATION_MANIFEST_FILE,
  GENERATION_MANIFEST_KIND,
  generationIdFromManifestBytes,
  initializeCorpusRoot,
  loadGenerationManifest,
  segmentIdFromManifestBytes,
  segmentPrefix,
  writeDocumentFrequencyArtifact,
  type DocumentFrequencyStats,
  type GenerationManifest,
  type GenerationSegmentEntry,
} from "./generation";
import { deriveDocId, docIdToDecimal, fingerprintHexToHiLo, hiLoToUint64, partitionOfDocId, uint64ToHiLo } from "./ids";
import {
  BuildLedger,
  newBuildStartRecord,
  type LedgerRecord,
  type LedgerRunRecord,
  type LedgerSegmentRecord,
  type LedgerSourceRecord,
  type LedgerStagedText,
} from "./ledger";
import { DEFAULT_RECORD_CODEC, encodeRecordSpan, RecordPackWriter, type RecordCodec } from "./record-pack";
import { RevocationList } from "./revocation";
import {
  DEFAULT_DICTIONARY_BLOCK_ENTRIES,
  encodeDocsFile,
  META_PACK_BASE,
  SEGMENT_FILE_ALIASES,
  SEGMENT_FILE_DOCS,
  SEGMENT_FILE_MANIFEST,
  SegmentIndexWriter,
  SegmentReader,
  TEXT_PACK_BASE,
  type SegmentFileEntry,
  type SegmentManifest,
} from "./segment";
import { sourceKeyOf, type SourceAdapter, type SourceDocument } from "./source-adapter";
import { LocalDirectoryObjectStore } from "./storage";
import {
  CORPUS_FINGERPRINT_CONTRACT_ID,
  CORPUS_FINGERPRINT_SHINGLE_SIZE,
  CORPUS_NORMALIZATION_VERSION,
  currentProcessingIdentity,
  INDEX_FORMAT_VERSION,
} from "./versions";

/**
 * Corpus Engine v1 — the restartable, bounded-memory corpus builder.
 *
 *   sources (adapters)
 *     -> normalize (frozen contract) -> exact dedup (normalized-content hash)
 *     -> fingerprint -> tuples into a fixed-size run buffer
 *     -> text compressed once and appended to a staging file
 *     -> COMMIT: runs spilled, staging fsync'd, ledger batch appended (atomic)
 *   per physical partition
 *     -> k-way merge of that partition's runs -> one immutable index segment
 *     -> staged text copied into the segment's text packs in ordinal order
 *     -> metadata + provenance packed, alias addenda written
 *     -> segment.json (sizes + sha256 of every file) -> content-addressed rename
 *   generation
 *     -> parent's segments (untouched) + new segments
 *     -> generation-wide document-frequency artifact
 *     -> content-addressed manifest
 *
 * WHAT IS BOUNDED: the run buffer (config), the merge fan-in and its read
 * buffers (config), one postings list, one document's text. WHAT IS NOT YET:
 * the per-source ledger index and the per-document table are held in memory
 * (about 150-250 bytes per source). That is fine at 1M and must move to disk
 * before 5M — it is reported, not hidden.
 *
 * DETERMINISM: ordinals follow document-id order, the stored text of a
 * document is its lexicographically smallest source's, aliases are sorted by
 * source key, and no timestamp enters an immutable artifact. So the bytes of
 * every segment and of the generation manifest are a function of the SET of
 * sources supplied, not of the order they arrived in or of where a crash
 * interrupted the build.
 *
 * INCREMENTAL: with a parent generation, only new documents are indexed, into
 * new segments. No existing segment is opened for writing, rewritten or
 * copied.
 */

export type BuildFaultPoint =
  | "source-staged"
  | "before-commit"
  | "runs-spilled"
  | "after-commit"
  | "segment-index-written"
  | "after-segment-commit"
  | "before-generation-rename";

export type CorpusBuildConfig = {
  corpusRoot: string;
  /** Names the build's working directory and ledger. Reusing it RESUMES that build. */
  buildId: string;
  parentGenerationId: string | null;
  /** Required for a root generation; inherited from (and must equal) the parent's otherwise. */
  partitionBits?: number;
  /** Total tuples buffered across all partitions before a commit is forced. */
  runBufferTuples?: number;
  maxMergeFanIn?: number;
  mergeReadBufferBytes?: number;
  textPackMaxBytes?: number;
  dictionaryBlockEntries?: number;
  /** Fingerprints with corpus df >= this are recorded in df-high.bin. Must stay <= the verifier's stop df (13). */
  dfRecordFloor?: number;
  recordCodec?: RecordCodec;
  /** Keep runs + staging after the generation is built (default false: they are deleted). */
  keepBuildArtifacts?: boolean;
  /** Test/checkpoint hook, called at named points; throwing or exiting there simulates a crash. */
  faultInjection?: (point: BuildFaultPoint, context: { commits: number; sourcesCommitted: number; partition?: number }) => void;
  onProgress?: (event: { phase: string; sourcesSeen: number; newDocuments: number; commits: number }) => void;
};

export type CorpusBuildMetrics = {
  sourcesSeen: number;
  sourcesSkippedAlreadyCommitted: number;
  sourcesCommittedThisRun: number;
  commits: number;
  commitsThisRun: number;
  runFiles: number;
  runBytes: number;
  runTuples: number;
  stagingBytes: number;
  mergeIntermediateBytes: number;
  mergePasses: number;
  mergeMaxFanIn: number;
  /** runs + staging + merge intermediates at their largest. */
  peakTemporaryBytes: number;
  /** peak of (temporary bytes + immutable bytes this build had written so far). */
  peakBuildDiskBytes: number;
  newImmutableBytes: number;
  peakRssBytes: number;
  runBufferBytes: number;
  /** The build ledger as it stood when ingestion ended: its file, and what the builder keeps resident from it. */
  ledger: { fileBytes: number; sourceEntries: number; documentTableEntries: number; heapUsedAfterIngestBytes: number; rssAfterIngestBytes: number };
  timingsMs: {
    read: number;
    normalize: number;
    fingerprint: number;
    compress: number;
    spill: number;
    mergeAndIndex: number;
    pack: number;
    documentFrequency: number;
    total: number;
  };
  documentsPerSecond: number;
};

export type CorpusBuildCounts = {
  /** Sources that resolved to a document in THIS build's ledger (new + aliases). */
  sourcesAccepted: number;
  newDocuments: number;
  aliasesInBuild: number;
  aliasesOfExisting: number;
  rejectedEmpty: number;
  rejectedRevoked: number;
  realSources: number;
  syntheticLoadOnlySources: number;
  /** New documents with at least one real source / with only synthetic sources. */
  newRealDocuments: number;
  newSyntheticOnlyDocuments: number;
  tokens: number;
  retainedFingerprints: number;
};

export type CorpusBuildResult = {
  buildId: string;
  generationId: string;
  logicalManifestSha256: string;
  parentGenerationId: string | null;
  newSegmentIds: string[];
  inheritedSegmentIds: string[];
  /** Segments this run found already committed in the ledger and did not rebuild. */
  segmentsReusedFromLedger: number;
  resumed: boolean;
  discardedLedgerTailBytes: number;
  counts: CorpusBuildCounts;
  metrics: CorpusBuildMetrics;
  documentFrequency: DocumentFrequencyStats;
  manifest: GenerationManifest;
};

export class CorpusBuildError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorpusBuildError";
    this.code = code;
  }
}

type BuildDocument = {
  docId: bigint;
  docIdDecimal: string;
  hi: number;
  lo: number;
  normalizedContentSha256: string;
  tokenCount: number;
  fingerprintCount: number;
  partition: number;
  canonicalSourceKey: string;
  staged: LedgerStagedText;
  sourceKeys: string[];
  hasRealSource: boolean;
};

function directoryBytes(directory: string): number {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : statSync(full).size;
  }
  return total;
}

function hashFile(file: string): SegmentFileEntry {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1 << 20);
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, bytes);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function aliasRecordOf(document: SourceDocument, rawContentSha256: string): Record<string, unknown> {
  return {
    provider: document.provider,
    dataset: document.dataset,
    datasetVersion: document.datasetVersion,
    externalId: document.externalId,
    canonicalUrl: document.canonicalUrl,
    title: document.title,
    authors: document.authors,
    publishedDate: document.publishedDate,
    sourceType: document.sourceType,
    language: document.language,
    rights: document.rights,
    provenance: document.provenance,
    extractionVersion: document.extractionVersion,
    rawContentSha256,
    syntheticLoadOnly: document.syntheticLoadOnly,
  };
}

/** The stored metadata + provenance record of one logical document. */
export type CorpusDocumentMetadata = {
  docId: string;
  normalizedContentSha256: string;
  normalizationVersion: number;
  fingerprintContract: string;
  tokenCount: number;
  fingerprintCount: number;
  /** sha256 of the stored source text (the text-pack record). */
  textSha256: string;
  /** The source whose text is stored. */
  canonicalSource: Record<string, unknown>;
  /** Every other source with identical normalized content, sorted by source key. */
  aliases: Array<Record<string, unknown>>;
  duplicateCluster: { kind: "exact-normalized"; id: string; memberCount: number; nearDuplicateClusterId: null };
  syntheticLoadOnly: boolean;
};

export async function runCorpusBuild(config: CorpusBuildConfig, adapters: readonly SourceAdapter[]): Promise<CorpusBuildResult> {
  const started = performance.now();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(config.buildId)) throw new CorpusBuildError("INVALID_BUILD_ID", "buildId must be 1-80 characters of [A-Za-z0-9._-]");
  const runBufferTuples = config.runBufferTuples ?? 1_000_000;
  const maxMergeFanIn = config.maxMergeFanIn ?? 32;
  const mergeReadBufferBytes = config.mergeReadBufferBytes ?? 256 * 1024;
  const textPackMaxBytes = config.textPackMaxBytes ?? 256 * 1024 * 1024;
  const blockEntries = config.dictionaryBlockEntries ?? DEFAULT_DICTIONARY_BLOCK_ENTRIES;
  const dfRecordFloor = config.dfRecordFloor ?? 8;
  const recordCodec = config.recordCodec ?? DEFAULT_RECORD_CODEC;
  const fault = config.faultInjection ?? (() => undefined);

  initializeCorpusRoot(config.corpusRoot);
  const store = new LocalDirectoryObjectStore(config.corpusRoot);
  const buildDirectory = path.join(config.corpusRoot, "builds", config.buildId);
  const runsDirectory = path.join(buildDirectory, "runs");
  const stagingDirectory = path.join(buildDirectory, "staging");
  const scratchDirectory = path.join(buildDirectory, "scratch");
  for (const directory of [runsDirectory, stagingDirectory, scratchDirectory]) mkdirSync(directory, { recursive: true });
  const stagingFile = path.join(stagingDirectory, "text.spans");

  const identity = currentProcessingIdentity();
  const ledger = BuildLedger.open(path.join(buildDirectory, "ledger.jsonl"));
  const resumed = ledger.start !== null;
  let stagingDescriptor = -1;
  const parentReaders: SegmentReader[][] = [];

  try {
    // ── parent generation (read-only) ───────────────────────────────────
    let parentManifest: GenerationManifest | null = null;
    if (config.parentGenerationId) {
      parentManifest = (await loadGenerationManifest(store, config.parentGenerationId)).manifest;
    }
    const partitionBits = parentManifest?.partitionBits ?? config.partitionBits;
    if (partitionBits === undefined) throw new CorpusBuildError("PARTITION_BITS_REQUIRED", "a root generation needs partitionBits");
    if (config.partitionBits !== undefined && config.partitionBits !== partitionBits) {
      throw new CorpusBuildError("PARTITION_BITS_MISMATCH", `the parent generation uses ${partitionBits} partition bits; they cannot change in an incremental build`);
    }
    const partitionCount = 1 << partitionBits;

    if (ledger.start === null) {
      ledger.append([newBuildStartRecord({
        buildId: config.buildId,
        parentGenerationId: config.parentGenerationId,
        partitionBits,
        normalizationProbeSha256: identity.normalization.probeSha256,
        fingerprintProbeSha256: identity.fingerprint.probeSha256,
      })]);
    } else {
      const start = ledger.start;
      if (
        start.buildId !== config.buildId || start.parentGenerationId !== config.parentGenerationId || start.partitionBits !== partitionBits
        || start.normalizationProbeSha256 !== identity.normalization.probeSha256 || start.fingerprintProbeSha256 !== identity.fingerprint.probeSha256
      ) {
        throw new CorpusBuildError("BUILD_CONFIG_MISMATCH", `build ${config.buildId} was started with a different parent, partitioning or processing identity; it cannot be resumed with this one`);
      }
    }

    for (let partition = 0; partition < partitionCount; partition += 1) parentReaders.push([]);
    if (parentManifest) {
      for (const entry of parentManifest.partitions) {
        for (const segmentId of entry.segmentIds) {
          parentReaders[entry.partition].push(
            await SegmentReader.open(store, segmentPrefix(segmentId), segmentId, parentManifest.segments[segmentId].manifestSha256, { verify: "size", dictionaryBlockCacheBlocks: 0 }),
          );
        }
      }
    }
    const locateInParent = (docId: bigint, partition: number): { reader: SegmentReader; ordinal: number } | null => {
      for (const reader of parentReaders[partition]) {
        const ordinal = reader.ordinalOf(docId);
        if (ordinal >= 0) return { reader, ordinal };
      }
      return null;
    };

    const revocations = RevocationList.parse(nodeBytes(readFileSync(path.join(config.corpusRoot, "revocations", "revocations.jsonl"))));

    // ── rebuild in-memory state from the ledger ─────────────────────────
    const documents = new Map<bigint, BuildDocument>();
    const addenda: Array<{ docId: bigint; partition: number; sourceKey: string }> = [];
    const counts: CorpusBuildCounts = {
      sourcesAccepted: 0, newDocuments: 0, aliasesInBuild: 0, aliasesOfExisting: 0, rejectedEmpty: 0, rejectedRevoked: 0,
      realSources: 0, syntheticLoadOnlySources: 0, newRealDocuments: 0, newSyntheticOnlyDocuments: 0, tokens: 0, retainedFingerprints: 0,
    };

    const applySource = (record: LedgerSourceRecord) => {
      if (record.synthetic) counts.syntheticLoadOnlySources += 1;
      else counts.realSources += 1;
      if (record.state === "REJECTED_EMPTY") {
        counts.rejectedEmpty += 1;
        return;
      }
      if (record.state === "REJECTED_REVOKED") {
        counts.rejectedRevoked += 1;
        return;
      }
      counts.sourcesAccepted += 1;
      const docId = BigInt(record.docId as string);
      if (record.state === "ALIAS_OF_EXISTING") {
        counts.aliasesOfExisting += 1;
        addenda.push({ docId, partition: record.partition as number, sourceKey: record.sourceKey });
        return;
      }
      if (record.state === "NEW") {
        const [hi, lo] = uint64ToHiLo(docId);
        documents.set(docId, {
          docId,
          docIdDecimal: record.docId as string,
          hi,
          lo,
          normalizedContentSha256: record.normalizedContentSha256 as string,
          tokenCount: record.tokenCount as number,
          fingerprintCount: record.fingerprintCount as number,
          partition: record.partition as number,
          canonicalSourceKey: record.sourceKey,
          staged: record.staged as LedgerStagedText,
          sourceKeys: [record.sourceKey],
          hasRealSource: !record.synthetic,
        });
        counts.newDocuments += 1;
        counts.tokens += record.tokenCount as number;
        counts.retainedFingerprints += record.fingerprintCount as number;
        return;
      }
      const existing = documents.get(docId);
      if (!existing) throw new CorpusBuildError("LEDGER_INCONSISTENT", `ledger alias ${record.sourceKey} names a document the ledger never created`);
      counts.aliasesInBuild += 1;
      existing.sourceKeys.push(record.sourceKey);
      if (!record.synthetic) existing.hasRealSource = true;
      if (record.staged) {
        existing.canonicalSourceKey = record.sourceKey;
        existing.staged = record.staged;
      }
    };
    for (const record of ledger.committedSourceRecords) applySource(record);
    ledger.committedSourceRecords.length = 0;

    const metrics: CorpusBuildMetrics = {
      sourcesSeen: 0, sourcesSkippedAlreadyCommitted: 0, sourcesCommittedThisRun: 0,
      commits: ledger.commitCount, commitsThisRun: 0, runFiles: 0, runBytes: 0, runTuples: 0,
      stagingBytes: ledger.stagingBytes, mergeIntermediateBytes: 0, mergePasses: 0, mergeMaxFanIn: 0,
      peakTemporaryBytes: 0, peakBuildDiskBytes: 0, newImmutableBytes: 0, peakRssBytes: 0,
      runBufferBytes: runBufferTuples * 16,
      ledger: { fileBytes: 0, sourceEntries: 0, documentTableEntries: 0, heapUsedAfterIngestBytes: 0, rssAfterIngestBytes: 0 },
      timingsMs: { read: 0, normalize: 0, fingerprint: 0, compress: 0, spill: 0, mergeAndIndex: 0, pack: 0, documentFrequency: 0, total: 0 },
      documentsPerSecond: 0,
    };
    let immutableBytesWritten = 0;
    const sampleDisk = (extraTemporaryBytes = 0) => {
      const temporary = directoryBytes(buildDirectory) + extraTemporaryBytes;
      metrics.peakTemporaryBytes = Math.max(metrics.peakTemporaryBytes, temporary);
      metrics.peakBuildDiskBytes = Math.max(metrics.peakBuildDiskBytes, temporary + immutableBytesWritten);
      metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage.rss());
    };

    // ── a build whose generation already exists is simply reported ──────
    let segmentsReusedFromLedger = ledger.segments.size;
    if (ledger.generation === null) {
      // Crash repair: staging back to its committed length, unreferenced runs removed.
      if (existsSync(stagingFile)) {
        if (statSync(stagingFile).size < ledger.stagingBytes) throw new CorpusBuildError("STAGING_TRUNCATED", "the staging file is shorter than the ledger's committed length");
        truncateSync(stagingFile, ledger.stagingBytes);
      } else if (ledger.stagingBytes > 0) {
        throw new CorpusBuildError("STAGING_MISSING", "the ledger references staged text but the staging file is gone");
      }
      const referencedRuns = new Set(ledger.runs.map((run) => run.file));
      for (const name of readdirSync(runsDirectory)) if (!referencedRuns.has(name)) unlinkSync(path.join(runsDirectory, name));
      for (const run of ledger.runs) {
        const file = path.join(runsDirectory, run.file);
        if (!existsSync(file) || statSync(file).size !== run.bytes) throw new CorpusBuildError("RUN_MISSING", `committed run ${run.file} is missing or the wrong size`);
      }
      rmSync(scratchDirectory, { recursive: true, force: true });
      mkdirSync(scratchDirectory, { recursive: true });

      stagingDescriptor = openSync(stagingFile, "a+");
      let stagingLength = ledger.stagingBytes;

      // ── INGEST ───────────────────────────────────────────────────────
      const perPartitionCapacity = Math.max(1, Math.ceil(runBufferTuples / partitionCount));
      const runBuffers = Array.from({ length: partitionCount }, () => new RunBuffer(perPartitionCapacity));
      let pendingRecords: LedgerSourceRecord[] = [];
      const pendingKeys = new Set<string>();

      const commit = () => {
        if (pendingRecords.length === 0 && runBuffers.every((buffer) => buffer.count === 0)) return;
        fault("before-commit", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size });
        const spillStarted = performance.now();
        fsyncSync(stagingDescriptor);
        const sequence = ledger.commitCount + 1;
        const runs: LedgerRunRecord[] = [];
        for (let partition = 0; partition < partitionCount; partition += 1) {
          const name = `c${String(sequence).padStart(6, "0")}-p${String(partition).padStart(4, "0")}.run`;
          const run = runBuffers[partition].spill(path.join(runsDirectory, name));
          if (run) runs.push({ partition, file: name, tuples: run.tuples, bytes: run.bytes, sha256: run.sha256 });
        }
        metrics.timingsMs.spill += performance.now() - spillStarted;
        fault("runs-spilled", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size });
        const batch: LedgerRecord[] = [...pendingRecords, { type: "commit", sequence, sourcesCommitted: pendingRecords.length, stagingBytes: stagingLength, runs }];
        ledger.append(batch);
        metrics.sourcesCommittedThisRun += pendingRecords.length;
        metrics.commitsThisRun += 1;
        metrics.commits = ledger.commitCount;
        metrics.stagingBytes = stagingLength;
        pendingRecords = [];
        pendingKeys.clear();
        sampleDisk();
        fault("after-commit", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size });
        config.onProgress?.({ phase: "ingest", sourcesSeen: metrics.sourcesSeen, newDocuments: counts.newDocuments, commits: ledger.commitCount });
      };

      const stage = (text: string): LedgerStagedText => {
        const compressStarted = performance.now();
        const encoded = encodeRecordSpan(Buffer.from(text, "utf8"), recordCodec);
        metrics.timingsMs.compress += performance.now() - compressStarted;
        writeSync(stagingDescriptor, encoded.span);
        const staged: LedgerStagedText = {
          offset: stagingLength,
          spanLength: encoded.span.length,
          uncompressedLength: encoded.uncompressedLength,
          chunkCount: encoded.chunkCount,
          sha256: encoded.sha256,
          codec: encoded.codec,
        };
        stagingLength += encoded.span.length;
        return staged;
      };

      for (const adapter of adapters) {
        const iterator = adapter.documents()[Symbol.asyncIterator]();
        for (;;) {
          const readStarted = performance.now();
          const next = await iterator.next();
          metrics.timingsMs.read += performance.now() - readStarted;
          if (next.done) break;
          const source = next.value;
          metrics.sourcesSeen += 1;
          const sourceKey = sourceKeyOf(source);
          if (ledger.sources.has(sourceKey)) {
            metrics.sourcesSkippedAlreadyCommitted += 1;
            continue;
          }
          if (pendingKeys.has(sourceKey)) throw new CorpusBuildError("DUPLICATE_SOURCE_KEY", `two sources share the identity ${JSON.stringify(sourceKey)}`);

          const rawContentSha256 = sha256Hex(source.rawContent);
          const alias = aliasRecordOf(source, rawContentSha256);
          const normalizeStarted = performance.now();
          const normalized = normalizeForCorpus(source.text, CORPUS_NORMALIZATION_VERSION);
          metrics.timingsMs.normalize += performance.now() - normalizeStarted;

          let record: LedgerSourceRecord;
          if (normalized.tokenCount < CORPUS_FINGERPRINT_SHINGLE_SIZE) {
            // Fewer words than one shingle: nothing to fingerprint, so nothing could ever retrieve it.
            record = { type: "source", sourceKey, state: "REJECTED_EMPTY", synthetic: source.syntheticLoadOnly, rawContentSha256, tokenCount: normalized.tokenCount, alias };
          } else {
            const docId = deriveDocId(normalized.normalizedContentSha256);
            const docIdDecimal = docIdToDecimal(docId);
            const partition = partitionOfDocId(docId, partitionBits);
            const base = {
              type: "source" as const,
              sourceKey,
              synthetic: source.syntheticLoadOnly,
              rawContentSha256,
              docId: docIdDecimal,
              normalizedContentSha256: normalized.normalizedContentSha256,
              tokenCount: normalized.tokenCount,
              partition,
              alias,
            };
            const inBuild = documents.get(docId);
            if (revocations.has(docId) || revocations.hasContent(normalized.normalizedContentSha256)) {
              record = { ...base, state: "REJECTED_REVOKED" };
            } else if (inBuild) {
              if (inBuild.normalizedContentSha256 !== normalized.normalizedContentSha256) {
                throw new CorpusBuildError("DOC_ID_COLLISION", `document id ${docIdDecimal} derived for two different normalized contents`);
              }
              // The stored text is the smallest source key's, so it does not depend on arrival order.
              const becomesCanonical = sourceKey < inBuild.canonicalSourceKey;
              record = { ...base, state: "ALIAS_IN_BUILD", fingerprintCount: inBuild.fingerprintCount, ...(becomesCanonical ? { staged: stage(source.text) } : {}) };
            } else {
              const inParent = locateInParent(docId, partition);
              if (inParent) {
                const stored = (await inParent.reader.readMetadata(inParent.ordinal)).metadata as CorpusDocumentMetadata;
                if (stored.normalizedContentSha256 !== normalized.normalizedContentSha256) {
                  throw new CorpusBuildError("DOC_ID_COLLISION", `document id ${docIdDecimal} already belongs to different content in the parent generation`);
                }
                record = { ...base, state: "ALIAS_OF_EXISTING", fingerprintCount: stored.fingerprintCount };
              } else {
                const fingerprintStarted = performance.now();
                const fingerprints = documentFingerprintHexes(normalized.tokens);
                metrics.timingsMs.fingerprint += performance.now() - fingerprintStarted;
                if (fingerprints.length > perPartitionCapacity) {
                  throw new CorpusBuildError("RUN_BUFFER_TOO_SMALL", `one document has ${fingerprints.length} fingerprints; raise runBufferTuples above ${fingerprints.length * partitionCount}`);
                }
                if (runBuffers[partition].count + fingerprints.length > perPartitionCapacity) commit();
                const [docHi, docLo] = uint64ToHiLo(docId);
                for (const hex of fingerprints) {
                  const [fingerprintHi, fingerprintLo] = fingerprintHexToHiLo(hex);
                  runBuffers[partition].add(fingerprintHi, fingerprintLo, docHi, docLo);
                }
                record = { ...base, state: "NEW", fingerprintCount: fingerprints.length, staged: stage(source.text) };
              }
            }
          }
          applySource(record);
          pendingRecords.push(record);
          pendingKeys.add(sourceKey);
          fault("source-staged", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size });
        }
      }
      commit();
      // Measurement only: with --expose-gc the heap figure is live data, not garbage awaiting collection.
      (globalThis as { gc?: () => void }).gc?.();
      const memoryAfterIngest = process.memoryUsage();
      metrics.ledger = {
        fileBytes: ledger.byteLength,
        sourceEntries: ledger.sources.size,
        documentTableEntries: documents.size,
        heapUsedAfterIngestBytes: memoryAfterIngest.heapUsed,
        rssAfterIngestBytes: memoryAfterIngest.rss,
      };
      for (const run of ledger.runs) {
        metrics.runFiles += 1;
        metrics.runBytes += run.bytes;
        metrics.runTuples += run.tuples;
      }
      sampleDisk();

      // ── FINALIZE: one immutable segment per partition that gained anything ──
      // A partition whose segment the ledger already holds (a resumed build) is not rebuilt.
      for (let partition = 0; partition < partitionCount; partition += 1) {
        if (ledger.segments.has(partition)) continue;
        const partitionDocuments = [...documents.values()].filter((document) => document.partition === partition)
          .sort((left, right) => (left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0));
        const partitionAddenda = addenda.filter((item) => item.partition === partition)
          .sort((left, right) => (left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0));
        if (partitionDocuments.length === 0 && partitionAddenda.length === 0) continue;

        const temporaryDirectory = path.join(config.corpusRoot, "segments", `.tmp-${config.buildId}-p${String(partition).padStart(4, "0")}`);
        rmSync(temporaryDirectory, { recursive: true, force: true });
        mkdirSync(temporaryDirectory, { recursive: true });

        // index: merge this partition's runs into dict / postings
        const mergeStarted = performance.now();
        const documentHi = new Uint32Array(partitionDocuments.length);
        const documentLo = new Uint32Array(partitionDocuments.length);
        partitionDocuments.forEach((document, ordinal) => {
          documentHi[ordinal] = document.hi;
          documentLo[ordinal] = document.lo;
        });
        const ordinalOf = (hi: number, lo: number): number => {
          let low = 0;
          let high = documentHi.length - 1;
          while (low <= high) {
            const middle = (low + high) >>> 1;
            if (documentHi[middle] === hi && documentLo[middle] === lo) return middle;
            if (documentHi[middle] < hi || (documentHi[middle] === hi && documentLo[middle] < lo)) low = middle + 1;
            else high = middle - 1;
          }
          return -1;
        };
        const indexWriter = new SegmentIndexWriter(temporaryDirectory, blockEntries);
        const postingsPerOrdinal = new Uint32Array(partitionDocuments.length);
        let groupHi = -1;
        let groupLo = -1;
        let group: number[] = [];
        const flushGroup = () => {
          if (group.length > 0) indexWriter.addKey(hiLoToUint64(groupHi, groupLo), group);
          group = [];
        };
        const partitionRuns = ledger.runs.filter((run) => run.partition === partition).map((run) => path.join(runsDirectory, run.file));
        let mergeStats: MergeStats | null = null;
        if (partitionRuns.length > 0) {
          mergeStats = mergeRuns(
            partitionRuns,
            { maxFanIn: maxMergeFanIn, readBufferBytes: mergeReadBufferBytes, scratchDirectory, scratchPrefix: `p${partition}` },
            (fingerprintHi, fingerprintLo, docHi, docLo) => {
              const ordinal = ordinalOf(docHi, docLo);
              if (ordinal < 0) throw new CorpusBuildError("RUN_INCONSISTENT", "a run holds a posting for a document the ledger does not list in this partition");
              if (fingerprintHi !== groupHi || fingerprintLo !== groupLo) {
                flushGroup();
                groupHi = fingerprintHi;
                groupLo = fingerprintLo;
              }
              group.push(ordinal);
              postingsPerOrdinal[ordinal] += 1;
            },
          );
          flushGroup();
          metrics.mergeIntermediateBytes += mergeStats.intermediateBytes;
          metrics.mergePasses = Math.max(metrics.mergePasses, mergeStats.passes);
          metrics.mergeMaxFanIn = Math.max(metrics.mergeMaxFanIn, mergeStats.maxFanInUsed);
          sampleDisk(mergeStats.peakIntermediateBytes);
        }
        const indexStats = indexWriter.finish();
        // Every document must have exactly the postings its fingerprinting produced: none lost, none doubled.
        partitionDocuments.forEach((document, ordinal) => {
          if (postingsPerOrdinal[ordinal] !== document.fingerprintCount) {
            throw new CorpusBuildError("POSTINGS_COUNT_MISMATCH", `document ${document.docIdDecimal} has ${postingsPerOrdinal[ordinal]} postings, expected ${document.fingerprintCount}`);
          }
        });
        metrics.timingsMs.mergeAndIndex += performance.now() - mergeStarted;
        fault("segment-index-written", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size, partition });

        // docs, text packs (staged spans copied in ordinal order), metadata packs, alias addenda
        const packStarted = performance.now();
        writeFileSync(path.join(temporaryDirectory, SEGMENT_FILE_DOCS), encodeDocsFile(partitionDocuments.map((document) => ({
          docId: document.docId,
          tokenCount: document.tokenCount,
          fingerprintCount: document.fingerprintCount,
        }))));
        const textWriter = new RecordPackWriter(temporaryDirectory, TEXT_PACK_BASE, { maxPackBytes: textPackMaxBytes, codec: recordCodec });
        const metaWriter = new RecordPackWriter(temporaryDirectory, META_PACK_BASE, { maxPackBytes: textPackMaxBytes, codec: recordCodec });
        let segmentTokens = 0;
        for (const document of partitionDocuments) {
          const span = Buffer.allocUnsafe(document.staged.spanLength);
          const read = readSync(stagingDescriptor, span, 0, span.length, document.staged.offset);
          if (read !== span.length) throw new CorpusBuildError("STAGING_SHORT_READ", `staged text of document ${document.docIdDecimal} is incomplete`);
          textWriter.appendSpan(document.docId, {
            span,
            uncompressedLength: document.staged.uncompressedLength,
            chunkCount: document.staged.chunkCount,
            sha256: document.staged.sha256,
            codec: document.staged.codec as RecordCodec,
          });
          const aliasRecords = [...document.sourceKeys].sort().map((key) => {
            const entry = ledger.sources.get(key);
            if (!entry) throw new CorpusBuildError("LEDGER_INCONSISTENT", `no ledger entry for source ${JSON.stringify(key)}`);
            return { key, alias: ledger.readSourceRecord(entry).alias };
          });
          const canonical = aliasRecords.find((item) => item.key === document.canonicalSourceKey);
          if (!canonical) throw new CorpusBuildError("LEDGER_INCONSISTENT", `document ${document.docIdDecimal} has no canonical source`);
          const metadata: CorpusDocumentMetadata = {
            docId: document.docIdDecimal,
            normalizedContentSha256: document.normalizedContentSha256,
            normalizationVersion: CORPUS_NORMALIZATION_VERSION,
            fingerprintContract: CORPUS_FINGERPRINT_CONTRACT_ID,
            tokenCount: document.tokenCount,
            fingerprintCount: document.fingerprintCount,
            textSha256: document.staged.sha256,
            canonicalSource: canonical.alias,
            aliases: aliasRecords.filter((item) => item.key !== document.canonicalSourceKey).map((item) => item.alias),
            duplicateCluster: { kind: "exact-normalized", id: document.docIdDecimal, memberCount: aliasRecords.length, nearDuplicateClusterId: null },
            syntheticLoadOnly: !document.hasRealSource,
          };
          metaWriter.append(document.docId, Buffer.from(canonicalJson(metadata), "utf8"));
          segmentTokens += document.tokenCount;
        }
        const textResult = textWriter.finish();
        const metaResult = metaWriter.finish();
        const addendaLines = partitionAddenda.map((item) => {
          const entry = ledger.sources.get(item.sourceKey);
          if (!entry) throw new CorpusBuildError("LEDGER_INCONSISTENT", `no ledger entry for source ${JSON.stringify(item.sourceKey)}`);
          return `${canonicalJson({ docId: docIdToDecimal(item.docId), alias: ledger.readSourceRecord(entry).alias })}\n`;
        });
        writeFileSync(path.join(temporaryDirectory, SEGMENT_FILE_ALIASES), addendaLines.join(""));

        const files: Record<string, SegmentFileEntry> = {};
        for (const name of readdirSync(temporaryDirectory).sort()) files[name] = hashFile(path.join(temporaryDirectory, name));
        const segmentManifest: SegmentManifest = {
          segmentFormat: INDEX_FORMAT_VERSION,
          partition,
          partitionBits,
          documentCount: partitionDocuments.length,
          tokenCount: segmentTokens,
          keyCount: indexStats.keyCount,
          postingsCount: indexStats.postingsCount,
          maxPostingsLength: indexStats.maxPostingsLength,
          blockEntries,
          blockCount: indexStats.blockCount,
          docIdMin: partitionDocuments.length > 0 ? partitionDocuments[0].docIdDecimal : null,
          docIdMax: partitionDocuments.length > 0 ? partitionDocuments[partitionDocuments.length - 1].docIdDecimal : null,
          textPackCount: textResult.packFiles.length,
          textUncompressedBytes: textResult.uncompressedBytes,
          metaPackCount: metaResult.packFiles.length,
          aliasAddendumCount: partitionAddenda.length,
          dfHistogram: indexStats.dfHistogram,
          topFingerprints: indexStats.topFingerprints,
          files,
        };
        const manifestBytes: Bytes = Buffer.from(canonicalJson(segmentManifest), "utf8");
        writeFileSync(path.join(temporaryDirectory, SEGMENT_FILE_MANIFEST), manifestBytes);
        for (const name of [SEGMENT_FILE_DOCS, SEGMENT_FILE_ALIASES, SEGMENT_FILE_MANIFEST]) {
          const descriptor = openSync(path.join(temporaryDirectory, name), "r+");
          fsyncSync(descriptor);
          closeSync(descriptor);
        }
        const segmentId = segmentIdFromManifestBytes(manifestBytes);
        const finalDirectory = path.join(config.corpusRoot, "segments", segmentId);
        if (existsSync(finalDirectory)) {
          // Same content was already published by an earlier build: keep it, never rewrite it.
          if (!nodeBytes(readFileSync(path.join(finalDirectory, SEGMENT_FILE_MANIFEST))).equals(manifestBytes)) {
            throw new CorpusBuildError("SEGMENT_ID_CONFLICT", `segment ${segmentId} exists with a different manifest`);
          }
          rmSync(temporaryDirectory, { recursive: true, force: true });
        } else {
          renameSync(temporaryDirectory, finalDirectory);
        }
        const segmentBytes = Object.values(files).reduce((total, file) => total + file.bytes, 0);
        immutableBytesWritten += segmentBytes + manifestBytes.length;
        metrics.timingsMs.pack += performance.now() - packStarted;
        const segmentRecord: LedgerSegmentRecord = {
          type: "segment-committed",
          partition,
          segmentId,
          manifestSha256: sha256Hex(manifestBytes),
          documentCount: partitionDocuments.length,
          keyCount: indexStats.keyCount,
          postingsCount: indexStats.postingsCount,
          fileCount: Object.keys(files).length + 1,
          bytes: segmentBytes,
          aliasAddendumCount: partitionAddenda.length,
        };
        ledger.append([segmentRecord]);
        sampleDisk();
        fault("after-segment-commit", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size, partition });
        config.onProgress?.({ phase: `segment-p${partition}`, sourcesSeen: metrics.sourcesSeen, newDocuments: counts.newDocuments, commits: ledger.commitCount });
      }
      closeSync(stagingDescriptor);
      stagingDescriptor = -1;

      // ── GENERATION ───────────────────────────────────────────────────
      const segments: Record<string, GenerationSegmentEntry> = { ...(parentManifest?.segments ?? {}) };
      const partitions = Array.from({ length: partitionCount }, (_, partition) => ({
        partition,
        segmentIds: [...(parentManifest?.partitions[partition]?.segmentIds ?? [])],
      }));
      for (const record of [...ledger.segments.values()].sort((left, right) => left.partition - right.partition)) {
        segments[record.segmentId] = {
          partition: record.partition,
          manifestSha256: record.manifestSha256,
          documentCount: record.documentCount,
          keyCount: record.keyCount,
          postingsCount: record.postingsCount,
          fileCount: record.fileCount,
          bytes: record.bytes,
        };
        if (!partitions[record.partition].segmentIds.includes(record.segmentId)) partitions[record.partition].segmentIds.push(record.segmentId);
      }

      const dfStarted = performance.now();
      const generationTemporary = path.join(config.corpusRoot, "generations", `.tmp-${config.buildId}`);
      rmSync(generationTemporary, { recursive: true, force: true });
      mkdirSync(generationTemporary, { recursive: true });
      const activeReaders: SegmentReader[] = [];
      for (const entry of partitions) {
        for (const segmentId of entry.segmentIds) {
          activeReaders.push(await SegmentReader.open(store, segmentPrefix(segmentId), segmentId, segments[segmentId].manifestSha256, { verify: "size", dictionaryBlockCacheBlocks: 0 }));
        }
      }
      const documentFrequency = await writeDocumentFrequencyArtifact(activeReaders, generationTemporary, dfRecordFloor);
      metrics.timingsMs.documentFrequency += performance.now() - dfStarted;

      const newAliases = counts.aliasesInBuild + counts.aliasesOfExisting;
      const manifest: GenerationManifest = {
        manifestKind: GENERATION_MANIFEST_KIND,
        processing: identity,
        partitionBits,
        parentGenerationId: config.parentGenerationId,
        documentCount: Object.values(segments).reduce((total, entry) => total + entry.documentCount, 0),
        logicalSourceCount: 0,
        aliasCount: (parentManifest?.aliasCount ?? 0) + newAliases,
        tokenCount: (parentManifest?.tokenCount ?? 0) + counts.tokens,
        distinctFingerprintCount: documentFrequency.distinctFingerprintCount,
        postingsCount: documentFrequency.postingsCount,
        maxPostingsLength: documentFrequency.maxDocumentFrequency,
        partitions,
        segments,
        documentFrequency: {
          recordFloor: dfRecordFloor,
          highEntryCount: documentFrequency.highEntryCount,
          files: {
            [DF_HIGH_FILE]: hashFile(path.join(generationTemporary, DF_HIGH_FILE)),
            [DF_STATS_FILE]: hashFile(path.join(generationTemporary, DF_STATS_FILE)),
          },
        },
      };
      manifest.logicalSourceCount = manifest.documentCount + manifest.aliasCount;
      const manifestBytes: Bytes = Buffer.from(canonicalJson(manifest), "utf8");
      const generationId = generationIdFromManifestBytes(manifestBytes);
      writeFileSync(path.join(generationTemporary, GENERATION_MANIFEST_FILE), manifestBytes);
      fault("before-generation-rename", { commits: ledger.commitCount, sourcesCommitted: ledger.sources.size });
      const generationDirectory = path.join(config.corpusRoot, "generations", generationId);
      if (existsSync(generationDirectory)) {
        if (!nodeBytes(readFileSync(path.join(generationDirectory, GENERATION_MANIFEST_FILE))).equals(manifestBytes)) {
          throw new CorpusGenerationError("GENERATION_ID_CONFLICT", `generation ${generationId} exists with a different manifest`);
        }
        rmSync(generationTemporary, { recursive: true, force: true });
      } else {
        renameSync(generationTemporary, generationDirectory);
        immutableBytesWritten += directoryBytes(generationDirectory);
      }
      ledger.append([{ type: "generation-built", generationId, logicalManifestSha256: sha256Hex(manifestBytes) }]);
      sampleDisk();
      metrics.newImmutableBytes = immutableBytesWritten;
    }

    // ── result (also reached when the generation had already been built) ──
    const generationRecord = ledger.generation;
    if (!generationRecord) throw new CorpusBuildError("BUILD_INCOMPLETE", "the build ended without a generation");
    const { manifest, logicalManifestSha256 } = await loadGenerationManifest(store, generationRecord.generationId);
    counts.newRealDocuments = [...documents.values()].filter((document) => document.hasRealSource).length;
    counts.newSyntheticOnlyDocuments = documents.size - counts.newRealDocuments;
    const newSegmentIds = [...ledger.segments.values()].sort((left, right) => left.partition - right.partition).map((record) => record.segmentId);
    const inheritedSegmentIds = Object.keys(manifest.segments).filter((segmentId) => !newSegmentIds.includes(segmentId)).sort();
    const documentFrequency = JSON.parse(readFileSync(path.join(config.corpusRoot, "generations", generationRecord.generationId, DF_STATS_FILE), "utf8")) as DocumentFrequencyStats;

    metrics.timingsMs.total = performance.now() - started;
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.resourceUsage().maxRSS * 1024);
    metrics.documentsPerSecond = metrics.timingsMs.total > 0 ? (metrics.sourcesCommittedThisRun / metrics.timingsMs.total) * 1000 : 0;

    const result: CorpusBuildResult = {
      buildId: config.buildId,
      generationId: generationRecord.generationId,
      logicalManifestSha256,
      parentGenerationId: config.parentGenerationId,
      newSegmentIds,
      inheritedSegmentIds,
      segmentsReusedFromLedger,
      resumed,
      discardedLedgerTailBytes: ledger.discardedTailBytes,
      counts,
      metrics,
      documentFrequency,
      manifest,
    };

    // Build-event metadata: who/when/how long. Never part of any content hash.
    const eventFile = path.join(config.corpusRoot, "generations", generationRecord.generationId, BUILD_EVENT_FILE);
    const event = {
      buildId: config.buildId,
      finishedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      resumed,
      counts,
      metrics,
      adapters: adapters.map((adapter) => adapter.adapterId),
    };
    writeFileSync(existsSync(eventFile) ? path.join(path.dirname(eventFile), `build-event.${config.buildId}.json`) : eventFile, JSON.stringify(event, null, 2));

    if (!config.keepBuildArtifacts) {
      rmSync(runsDirectory, { recursive: true, force: true });
      rmSync(stagingDirectory, { recursive: true, force: true });
      rmSync(scratchDirectory, { recursive: true, force: true });
    }
    return result;
  } finally {
    if (stagingDescriptor >= 0) closeSync(stagingDescriptor);
    ledger.close();
    await store.close();
  }
}
