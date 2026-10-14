import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex, type Bytes } from "./bytes";
import { compareUint64, fingerprintToHex, partitionOfDocId } from "./ids";
import { checkRecordPackIndex, recordPackIndexFileName } from "./record-pack";
import { initializeRevocationList, RevocationList, type RevocationAnchor } from "./revocation";
import {
  addToDfHistogram,
  emptyDfHistogram,
  META_PACK_BASE,
  SegmentReader,
  TEXT_PACK_BASE,
  TopFingerprints,
  type DictionaryHit,
  type DocumentFrequencyHistogram,
  type SegmentManifest,
} from "./segment";
import { CorpusStorageError, LocalDirectoryObjectStore, type CorpusObjectStore } from "./storage";
import { processingIdentityMismatches, type CorpusProcessingIdentity } from "./versions";

/**
 * Corpus Engine v1 — immutable corpus generations.
 *
 * A generation is a MANIFEST: the exact list of immutable segments that make
 * up the corpus at one point, with the processing identity they were built
 * under. Segments are shared between generations; adding documents writes new
 * segments and a new manifest that references the old segments unchanged.
 *
 *   <root>/segments/<segmentId>/...            immutable, content-addressed
 *   <root>/generations/<generationId>/
 *       manifest.json      the LOGICAL manifest, as canonical JSON
 *       build-event.json   who/when/how long — never part of any hash
 *       df-high.bin        fingerprints with corpus df >= recordFloor
 *       df-stats.json      document-frequency distribution
 *   <root>/ACTIVE.json                         the served generation pointer
 *   <root>/activation-log.jsonl
 *   <root>/revocations/revocations.jsonl       generation-independent
 *
 * IDENTITY: generationId = "gen-" + sha256(manifest.json bytes)[0..24]. The
 * logical manifest holds only content (no timestamps, no build id, no host),
 * so the same documents built the same way always produce the same generation
 * id, and a manifest whose bytes do not hash to its own directory name is
 * rejected. Timestamps and durations live in build-event.json.
 *
 * A query never searches "whatever is in the folder": it names a generation
 * id, and the reader opens only the objects that generation's manifest lists.
 */

export const GENERATION_MANIFEST_KIND = "turnitplus-corpus-generation";
export const ACTIVE_POINTER_KEY = "ACTIVE.json";
export const ACTIVATION_LOG_KEY = "activation-log.jsonl";
export const DF_HIGH_FILE = "df-high.bin";
export const DF_STATS_FILE = "df-stats.json";
export const GENERATION_MANIFEST_FILE = "manifest.json";
export const BUILD_EVENT_FILE = "build-event.json";

export const DF_HIGH_MAGIC = "TPDF";
export const DF_HIGH_HEADER_BYTES = 16;
export const DF_HIGH_ROW_BYTES = 12;
/** Thresholds the df-stats report tabulates ("how many fingerprints / postings sit above df T"). */
export const DF_REPORT_THRESHOLDS = [2, 3, 4, 6, 8, 13, 16, 32, 64, 128, 256, 512, 1024, 4096];

export type GenerationSegmentEntry = {
  partition: number;
  /** sha256 of the segment's segment.json bytes — pins the whole segment. */
  manifestSha256: string;
  documentCount: number;
  keyCount: number;
  postingsCount: number;
  fileCount: number;
  bytes: number;
};

export type GenerationManifest = {
  manifestKind: typeof GENERATION_MANIFEST_KIND;
  processing: CorpusProcessingIdentity;
  partitionBits: number;
  /** null for a root generation. */
  parentGenerationId: string | null;
  /** Unique logical documents (after exact deduplication). */
  documentCount: number;
  /** Every supplied source that resolved to a document: documentCount + aliasCount. */
  logicalSourceCount: number;
  aliasCount: number;
  tokenCount: number;
  /** Distinct fingerprint keys across the whole generation. */
  distinctFingerprintCount: number;
  postingsCount: number;
  maxPostingsLength: number;
  /** Every partition, in order, with its active segments oldest first. */
  partitions: Array<{ partition: number; segmentIds: string[] }>;
  segments: Record<string, GenerationSegmentEntry>;
  documentFrequency: {
    recordFloor: number;
    highEntryCount: number;
    files: Record<string, { bytes: number; sha256: string }>;
  };
};

export function segmentPrefix(segmentId: string) {
  return `segments/${segmentId}`;
}

export function generationPrefix(generationId: string) {
  return `generations/${generationId}`;
}

export function segmentIdFromManifestBytes(manifestBytes: Bytes | string): string {
  return `seg-${sha256Hex(manifestBytes).slice(0, 24)}`;
}

export function generationIdFromManifestBytes(manifestBytes: Bytes | string): string {
  return `gen-${sha256Hex(manifestBytes).slice(0, 24)}`;
}

export class CorpusGenerationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorpusGenerationError";
    this.code = code;
  }
}

/** Creates the fixed skeleton of a corpus root (idempotent). */
export function initializeCorpusRoot(corpusRoot: string) {
  for (const directory of ["segments", "generations", "builds", "revocations"]) mkdirSync(path.join(corpusRoot, directory), { recursive: true });
  initializeRevocationList(corpusRoot);
}

/** Loads a generation manifest and proves it is the one its id names. */
export async function loadGenerationManifest(store: CorpusObjectStore, generationId: string): Promise<{ manifest: GenerationManifest; logicalManifestSha256: string }> {
  if (!/^gen-[0-9a-f]{24}$/.test(generationId)) throw new CorpusGenerationError("INVALID_GENERATION_ID", `not a generation id: ${JSON.stringify(generationId)}`);
  let bytes: Bytes;
  try {
    bytes = await store.readAll(`${generationPrefix(generationId)}/${GENERATION_MANIFEST_FILE}`);
  } catch (error) {
    const missing = error instanceof CorpusStorageError && error.code === "NOT_FOUND";
    throw new CorpusGenerationError(missing ? "GENERATION_NOT_FOUND" : "GENERATION_UNREADABLE", `generation ${generationId}: manifest ${missing ? "not found" : "unreadable"}`);
  }
  if (generationIdFromManifestBytes(bytes) !== generationId) {
    throw new CorpusGenerationError("GENERATION_MANIFEST_MISMATCH", `generation ${generationId}: manifest bytes do not hash to its id`);
  }
  let manifest: GenerationManifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as GenerationManifest;
  } catch {
    throw new CorpusGenerationError("GENERATION_MANIFEST_MISMATCH", `generation ${generationId}: manifest is not JSON`);
  }
  if (manifest.manifestKind !== GENERATION_MANIFEST_KIND) throw new CorpusGenerationError("GENERATION_MANIFEST_MISMATCH", `generation ${generationId}: not a corpus generation manifest`);
  return { manifest, logicalManifestSha256: sha256Hex(bytes) };
}

// ── document-frequency artifact ───────────────────────────────────────────

export type DocumentFrequencyStats = {
  distinctFingerprintCount: number;
  postingsCount: number;
  maxDocumentFrequency: number;
  recordFloor: number;
  highEntryCount: number;
  histogram: DocumentFrequencyHistogram;
  topFingerprints: Array<{ fingerprint: string; df: number }>;
  /** For each threshold T: fingerprints with df >= T and the postings they hold. */
  atOrAbove: Array<{ df: number; fingerprints: number; postings: number }>;
};

/**
 * Merges the dictionaries of `segments` (each already ascending) into the
 * generation-wide document frequency of every fingerprint, streaming: one
 * pending entry per segment is held, nothing else. Emits every (fingerprint,
 * df) to `visit` in ascending fingerprint order.
 */
export async function mergeDocumentFrequencies(
  segments: readonly SegmentReader[],
  visit: (fingerprint: bigint, df: number) => void,
): Promise<void> {
  const iterators = segments.map((segment) => segment.iterateDictionary());
  const heads: Array<DictionaryHit | null> = [];
  for (const iterator of iterators) {
    const next = await iterator.next();
    heads.push(next.done ? null : next.value);
  }
  for (;;) {
    let smallest: bigint | null = null;
    for (const head of heads) {
      if (head && (smallest === null || head.fingerprint < smallest)) smallest = head.fingerprint;
    }
    if (smallest === null) return;
    let df = 0;
    for (let index = 0; index < heads.length; index += 1) {
      const head = heads[index];
      if (head && head.fingerprint === smallest) {
        df += head.df;
        const next = await iterators[index].next();
        heads[index] = next.done ? null : next.value;
      }
    }
    visit(smallest, df);
  }
}

/** Writes df-high.bin + df-stats.json for the given active segments into `directory`. */
export async function writeDocumentFrequencyArtifact(
  segments: readonly SegmentReader[],
  directory: string,
  recordFloor: number,
): Promise<DocumentFrequencyStats> {
  if (!Number.isInteger(recordFloor) || recordFloor < 2) throw new RangeError("df recordFloor must be an integer >= 2");
  const histogram = emptyDfHistogram();
  const top = new TopFingerprints();
  const atOrAbove = DF_REPORT_THRESHOLDS.map((df) => ({ df, fingerprints: 0, postings: 0 }));
  const descriptor = openSync(path.join(directory, DF_HIGH_FILE), "w");
  writeSync(descriptor, Buffer.alloc(DF_HIGH_HEADER_BYTES));
  const chunk = Buffer.allocUnsafe(DF_HIGH_ROW_BYTES * 4096);
  let filled = 0;
  let distinct = 0;
  let postings = 0;
  let maximum = 0;
  let high = 0;
  await mergeDocumentFrequencies(segments, (fingerprint, df) => {
    distinct += 1;
    postings += df;
    if (df > maximum) maximum = df;
    addToDfHistogram(histogram, df);
    top.offer(fingerprint, df);
    for (const bucket of atOrAbove) {
      if (df >= bucket.df) {
        bucket.fingerprints += 1;
        bucket.postings += df;
      }
    }
    if (df >= recordFloor) {
      chunk.writeBigUInt64BE(fingerprint, filled);
      chunk.writeUInt32BE(df, filled + 8);
      filled += DF_HIGH_ROW_BYTES;
      high += 1;
      if (filled === chunk.length) {
        writeSync(descriptor, chunk, 0, filled);
        filled = 0;
      }
    }
  });
  if (filled > 0) writeSync(descriptor, chunk, 0, filled);
  fsyncSync(descriptor);
  closeSync(descriptor);

  const header = Buffer.alloc(DF_HIGH_HEADER_BYTES);
  header.write(DF_HIGH_MAGIC, 0, "latin1");
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(DF_HIGH_ROW_BYTES, 6);
  header.writeUInt32BE(high, 8);
  header.writeUInt32BE(recordFloor, 12);
  const patch = openSync(path.join(directory, DF_HIGH_FILE), "r+");
  writeSync(patch, header, 0, header.length, 0);
  fsyncSync(patch);
  closeSync(patch);

  const stats: DocumentFrequencyStats = {
    distinctFingerprintCount: distinct,
    postingsCount: postings,
    maxDocumentFrequency: maximum,
    recordFloor,
    highEntryCount: high,
    histogram,
    topFingerprints: top.result(),
    atOrAbove,
  };
  writeFileSync(path.join(directory, DF_STATS_FILE), canonicalJson(stats));
  return stats;
}

/** The resident high-df table: answers "what is this fingerprint's corpus df" for df >= recordFloor, else 0. */
export class HighDocumentFrequencyTable {
  private constructor(private readonly keys: BigUint64Array, private readonly dfs: Uint32Array, readonly recordFloor: number) {}

  get size() {
    return this.keys.length;
  }

  static parse(bytes: Bytes): HighDocumentFrequencyTable {
    if (bytes.length < DF_HIGH_HEADER_BYTES || bytes.toString("latin1", 0, 4) !== DF_HIGH_MAGIC || bytes.readUInt16BE(4) !== 1) {
      throw new CorpusGenerationError("DF_ARTIFACT_CORRUPT", "df-high.bin has an unsupported header");
    }
    const count = bytes.readUInt32BE(8);
    const recordFloor = bytes.readUInt32BE(12);
    if (bytes.length !== DF_HIGH_HEADER_BYTES + count * DF_HIGH_ROW_BYTES) throw new CorpusGenerationError("DF_ARTIFACT_CORRUPT", "df-high.bin length disagrees with its row count");
    const keys = new BigUint64Array(count);
    const dfs = new Uint32Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = DF_HIGH_HEADER_BYTES + index * DF_HIGH_ROW_BYTES;
      keys[index] = bytes.readBigUInt64BE(offset);
      dfs[index] = bytes.readUInt32BE(offset + 8);
      if (index > 0 && keys[index] <= keys[index - 1]) throw new CorpusGenerationError("DF_ARTIFACT_CORRUPT", "df-high.bin is not in increasing fingerprint order");
    }
    return new HighDocumentFrequencyTable(keys, dfs, recordFloor);
  }

  /** Corpus df of `fingerprint` when it is >= recordFloor; 0 means "below the floor" (possibly absent). */
  get(fingerprint: bigint): number {
    let low = 0;
    let high = this.keys.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.keys[middle];
      if (value === fingerprint) return this.dfs[middle];
      if (value < fingerprint) low = middle + 1;
      else high = middle - 1;
    }
    return 0;
  }
}

// ── publication validation ────────────────────────────────────────────────

export type GenerationValidation = {
  generationId: string;
  ok: boolean;
  errors: string[];
  checks: {
    segmentsChecked: number;
    filesHashed: number;
    bytesHashed: number;
    documentsChecked: number;
    dictionaryKeysChecked: number;
    postingsChecked: number;
  };
};

/**
 * Decides whether a generation may be served. Nothing is taken on trust:
 *
 *   - the manifest hashes to the generation id and names a supported
 *     processing identity (probes recomputed under the running code);
 *   - every referenced segment exists, its segment.json matches the pinned
 *     hash, and EVERY file of it matches its recorded size and sha256;
 *   - every document sits in the partition its id belongs to, no document is
 *     in two segments, and the document / key / postings counts add up;
 *   - each dictionary is strictly increasing and its df values sum to the
 *     segment's postings count; the text and metadata indexes have one row
 *     per document;
 *   - the df artifact matches its recorded hashes and agrees with the
 *     dictionaries it was merged from;
 *   - the revocation list is present and intact.
 *
 * Returns every problem found rather than stopping at the first.
 */
export async function validateGeneration(store: CorpusObjectStore, generationId: string): Promise<GenerationValidation> {
  const errors: string[] = [];
  const checks = { segmentsChecked: 0, filesHashed: 0, bytesHashed: 0, documentsChecked: 0, dictionaryKeysChecked: 0, postingsChecked: 0 };
  const fail = (message: string) => {
    errors.push(message);
  };

  let manifest: GenerationManifest;
  try {
    manifest = (await loadGenerationManifest(store, generationId)).manifest;
  } catch (error) {
    return { generationId, ok: false, errors: [error instanceof Error ? error.message : String(error)], checks };
  }

  for (const problem of processingIdentityMismatches(manifest.processing)) fail(`unsupported processing identity — ${problem}`);

  try {
    await RevocationList.load(store);
  } catch (error) {
    fail(`revocation list — ${error instanceof Error ? error.message : String(error)}`);
  }

  const expectedPartitions = 1 << manifest.partitionBits;
  if (manifest.partitions.length !== expectedPartitions || manifest.partitions.some((entry, index) => entry.partition !== index)) {
    fail(`manifest must list partitions 0..${expectedPartitions - 1} in order`);
  }
  const listed = new Set<string>();
  for (const partition of manifest.partitions) {
    for (const segmentId of partition.segmentIds) {
      if (listed.has(segmentId)) fail(`segment ${segmentId} is listed twice`);
      listed.add(segmentId);
      if (manifest.segments[segmentId]?.partition !== partition.partition) fail(`segment ${segmentId} is listed under partition ${partition.partition} but recorded for another`);
    }
  }
  for (const segmentId of Object.keys(manifest.segments)) if (!listed.has(segmentId)) fail(`segment ${segmentId} is recorded but not listed in any partition`);

  const opened: SegmentReader[] = [];
  const seenDocuments = new Map<bigint, string>();
  let documentTotal = 0;
  let postingsTotal = 0;
  let tokenTotal = 0;
  let aliasTotal = 0;

  for (const partition of manifest.partitions) {
    for (const segmentId of partition.segmentIds) {
      const entry = manifest.segments[segmentId];
      if (!entry) continue;
      checks.segmentsChecked += 1;
      let segment: SegmentReader;
      try {
        // "sha256" reads and hashes every file of the segment against segment.json.
        segment = await SegmentReader.open(store, segmentPrefix(segmentId), segmentId, entry.manifestSha256, { verify: "sha256", dictionaryBlockCacheBlocks: 0 });
      } catch (error) {
        fail(`segment ${segmentId} — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      opened.push(segment);
      const segmentManifest: SegmentManifest = segment.manifest;
      const files = Object.values(segmentManifest.files);
      checks.filesHashed += files.length;
      checks.bytesHashed += files.reduce((total, file) => total + file.bytes, 0);

      if (segmentManifest.partition !== partition.partition || segmentManifest.partitionBits !== manifest.partitionBits) {
        fail(`segment ${segmentId} was built for partition ${segmentManifest.partition}/${segmentManifest.partitionBits} bits`);
      }
      if (entry.documentCount !== segmentManifest.documentCount || entry.keyCount !== segmentManifest.keyCount || entry.postingsCount !== segmentManifest.postingsCount) {
        fail(`segment ${segmentId}: generation manifest counts disagree with segment.json`);
      }
      if (entry.fileCount !== files.length + 1 || entry.bytes !== files.reduce((total, file) => total + file.bytes, 0)) {
        fail(`segment ${segmentId}: generation manifest file count / bytes disagree with segment.json`);
      }

      let segmentTokens = 0;
      for (let ordinal = 0; ordinal < segment.documentCount; ordinal += 1) {
        const docId = segment.docIds[ordinal];
        if (partitionOfDocId(docId, manifest.partitionBits) !== partition.partition) fail(`segment ${segmentId}: document ${docId} does not belong to partition ${partition.partition}`);
        const other = seenDocuments.get(docId);
        if (other) fail(`document ${docId} is in both ${other} and ${segmentId}`);
        else seenDocuments.set(docId, segmentId);
        segmentTokens += segment.tokenCounts[ordinal];
      }
      checks.documentsChecked += segment.documentCount;
      if (segmentTokens !== segmentManifest.tokenCount) fail(`segment ${segmentId}: token count ${segmentTokens} != manifest ${segmentManifest.tokenCount}`);

      let keys = 0;
      let postings = 0;
      let previous: bigint | null = null;
      let maxDf = 0;
      try {
        for await (const hit of segment.iterateDictionary()) {
          if (previous !== null && compareUint64(hit.fingerprint, previous) <= 0) {
            fail(`segment ${segmentId}: dictionary is not strictly increasing at ${fingerprintToHex(hit.fingerprint)}`);
            break;
          }
          if (hit.df < 1 || hit.df > segment.documentCount) {
            fail(`segment ${segmentId}: fingerprint ${fingerprintToHex(hit.fingerprint)} has impossible df ${hit.df}`);
            break;
          }
          previous = hit.fingerprint;
          keys += 1;
          postings += hit.df;
          if (hit.df > maxDf) maxDf = hit.df;
        }
      } catch (error) {
        fail(`segment ${segmentId} dictionary — ${error instanceof Error ? error.message : String(error)}`);
      }
      checks.dictionaryKeysChecked += keys;
      checks.postingsChecked += postings;
      if (keys !== segmentManifest.keyCount) fail(`segment ${segmentId}: ${keys} dictionary keys != manifest ${segmentManifest.keyCount}`);
      if (postings !== segmentManifest.postingsCount) fail(`segment ${segmentId}: df sum ${postings} != manifest postings ${segmentManifest.postingsCount}`);
      if (maxDf !== segmentManifest.maxPostingsLength) fail(`segment ${segmentId}: max df ${maxDf} != manifest ${segmentManifest.maxPostingsLength}`);

      for (const base of [TEXT_PACK_BASE, META_PACK_BASE]) {
        try {
          const problem = checkRecordPackIndex(await store.readAll(`${segmentPrefix(segmentId)}/${recordPackIndexFileName(base)}`), segment.documentCount);
          if (problem) fail(`segment ${segmentId} ${base}: ${problem}`);
        } catch (error) {
          fail(`segment ${segmentId} ${base} index — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // One real record per pack kind: proves the rows point at decodable, hash-matching bytes.
      if (segment.documentCount > 0) {
        for (const ordinal of new Set([0, segment.documentCount - 1])) {
          try {
            await segment.readText(ordinal);
            await segment.readMetadata(ordinal);
          } catch (error) {
            fail(`segment ${segmentId} record ${ordinal} — ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      documentTotal += segment.documentCount;
      postingsTotal += segmentManifest.postingsCount;
      tokenTotal += segmentManifest.tokenCount;
      aliasTotal += segmentManifest.aliasAddendumCount;
    }
  }

  if (errors.length === 0) {
    if (documentTotal !== manifest.documentCount) fail(`documents ${documentTotal} != manifest ${manifest.documentCount}`);
    if (postingsTotal !== manifest.postingsCount) fail(`postings ${postingsTotal} != manifest ${manifest.postingsCount}`);
    if (tokenTotal !== manifest.tokenCount) fail(`tokens ${tokenTotal} != manifest ${manifest.tokenCount}`);
    if (manifest.logicalSourceCount !== manifest.documentCount + manifest.aliasCount) fail("logicalSourceCount != documentCount + aliasCount");
    if (aliasTotal > manifest.aliasCount) fail(`alias addenda ${aliasTotal} exceed the manifest's alias count ${manifest.aliasCount}`);
  }

  // The df artifact: recorded hashes, then agreement with the dictionaries.
  const dfPrefix = generationPrefix(generationId);
  let table: HighDocumentFrequencyTable | null = null;
  for (const [name, recorded] of Object.entries(manifest.documentFrequency.files)) {
    try {
      const bytes = await store.readAll(`${dfPrefix}/${name}`);
      checks.filesHashed += 1;
      checks.bytesHashed += bytes.length;
      if (bytes.length !== recorded.bytes || sha256Hex(bytes) !== recorded.sha256) fail(`${name} does not match its recorded size/hash`);
      else if (name === DF_HIGH_FILE) table = HighDocumentFrequencyTable.parse(bytes);
    } catch (error) {
      fail(`${name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!manifest.documentFrequency.files[DF_HIGH_FILE] || !manifest.documentFrequency.files[DF_STATS_FILE]) fail("manifest does not record both document-frequency files");
  if (table && errors.length === 0) {
    if (table.recordFloor !== manifest.documentFrequency.recordFloor || table.size !== manifest.documentFrequency.highEntryCount) fail("df-high.bin header disagrees with the manifest");
    let distinct = 0;
    let high = 0;
    let maximum = 0;
    let mismatched = 0;
    await mergeDocumentFrequencies(opened, (fingerprint, df) => {
      distinct += 1;
      if (df > maximum) maximum = df;
      const recorded = table ? table.get(fingerprint) : 0;
      if (df >= manifest.documentFrequency.recordFloor) {
        high += 1;
        if (recorded !== df) mismatched += 1;
      } else if (recorded !== 0) mismatched += 1;
    });
    if (distinct !== manifest.distinctFingerprintCount) fail(`distinct fingerprints ${distinct} != manifest ${manifest.distinctFingerprintCount}`);
    if (high !== manifest.documentFrequency.highEntryCount) fail(`high-df entries ${high} != manifest ${manifest.documentFrequency.highEntryCount}`);
    if (maximum !== manifest.maxPostingsLength) fail(`max df ${maximum} != manifest ${manifest.maxPostingsLength}`);
    if (mismatched > 0) fail(`${mismatched} fingerprints disagree between df-high.bin and the dictionaries`);
  }

  return { generationId, ok: errors.length === 0, errors, checks };
}

// ── activation ────────────────────────────────────────────────────────────

export type ActivePointer = {
  generationId: string;
  logicalManifestSha256: string;
  activatedAt: string;
  previousGenerationId: string | null;
  /** The revocation list as it stood at activation. A reader given this anchor refuses a shorter or rewritten list. */
  revocationAnchor: RevocationAnchor;
};

export function readActivePointer(corpusRoot: string): ActivePointer | null {
  const file = path.join(corpusRoot, ACTIVE_POINTER_KEY);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as ActivePointer;
}

/**
 * Makes `generationId` the served generation — but only after validateGeneration
 * passes. On any validation error nothing is written: ACTIVE.json and the
 * previous generation are untouched and the error list is returned.
 *
 * Activation is the atomic replacement of one small file (write temp, fsync,
 * rename), so a reader sees either the old pointer or the new one, and a
 * rollback is just publishing an older, still-valid generation.
 */
export async function publishGeneration(
  corpusRoot: string,
  generationId: string,
  options: { activatedAt?: string; note?: string } = {},
): Promise<{ published: boolean; validation: GenerationValidation; pointer: ActivePointer | null }> {
  const store = new LocalDirectoryObjectStore(corpusRoot);
  try {
    const validation = await validateGeneration(store, generationId);
    const previous = readActivePointer(corpusRoot);
    const activatedAt = options.activatedAt ?? new Date().toISOString();
    if (!validation.ok) {
      appendFileSync(path.join(corpusRoot, ACTIVATION_LOG_KEY), `${canonicalJson({ event: "PUBLICATION_REFUSED", generationId, at: activatedAt, errors: validation.errors.slice(0, 20), activeGenerationId: previous?.generationId ?? null })}\n`);
      return { published: false, validation, pointer: previous };
    }
    const { logicalManifestSha256 } = await loadGenerationManifest(store, generationId);
    const revocations = await RevocationList.load(store);
    const pointer: ActivePointer = {
      generationId,
      logicalManifestSha256,
      activatedAt,
      previousGenerationId: previous?.generationId ?? null,
      revocationAnchor: revocations.anchor(),
    };
    const temporary = path.join(corpusRoot, `${ACTIVE_POINTER_KEY}.tmp`);
    const descriptor = openSync(temporary, "w");
    writeSync(descriptor, canonicalJson(pointer));
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, path.join(corpusRoot, ACTIVE_POINTER_KEY));
    appendFileSync(path.join(corpusRoot, ACTIVATION_LOG_KEY), `${canonicalJson({ event: "PUBLISHED", ...pointer, note: options.note ?? null })}\n`);
    return { published: true, validation, pointer };
  } finally {
    await store.close();
  }
}
