import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION } from "../document-correspondence";
import { documentShingleHashes } from "../document-family";
import { canonicalSha256 } from "../document-identity";
import { currentScoringNormalizationVersion, tokens, tokensForScoringNormalization, type ScoringNormalizationVersion } from "../similarity-core";
import { canonicalJson, readUint48BE, sha256Hex, writeUint48BE, type Bytes } from "./bytes";
import type { CorpusGenerationReader, DocumentLocation } from "./reader";
import { CorpusStorageError, type CorpusObjectStore } from "./storage";
import {
  CORPUS_FINGERPRINT_HASH,
  CORPUS_NORMALIZATION_CONTRACT_ID,
  FINGERPRINT_PROBE_TEXT,
  NORMALIZATION_PROBE_TEXT,
  normalizationProbeSha256,
} from "./versions";

/**
 * Corpus Engine v1 — the DERIVED SOURCE SIDECAR (derived-source-sidecar-v1).
 *
 * Verifying a candidate needs three things from its source text, and the
 * verifier used to re-derive them from the stored text on every query
 * (~10 ms per average document, 97% of a query at 100k):
 *
 *   wordCount   tokens(source).length
 *   canonical   canonicalSha256(source)                  the exact-document test
 *   shingles    documentShingleHashes(source, 5)         the informative 5-gram hashes
 *
 * The sidecar stores exactly those, per document, so a candidate can be
 * verified without fetching, decompressing or tokenizing its text. It is
 *
 *   OPTIONAL      not part of any segment or generation: a generation is
 *                 complete and servable without it, and a reader with no
 *                 sidecar (or a refused one) verifies from the text, with the
 *                 same result.
 *   REBUILDABLE   from the stored source text alone (buildDerivedSourceSidecar).
 *                 The source text stays the source of truth.
 *   VERSIONED     every input its content depends on is in its IDENTITY, and a
 *                 reader refuses a sidecar whose identity is not the one the
 *                 running code would produce, or whose segment is not the one
 *                 the generation pins.
 *
 * LAYOUT, beside the segments and outside every content hash:
 *
 *   <root>/sidecars/<identitySha256[0..24]>/<segmentId>/
 *       sidecar.json   identity, the segment it was derived from (id + pinned
 *                      segment.json sha256), document count, file hashes
 *       derived.idx    16-byte header + one 64-byte row per segment ordinal:
 *                        docId u64 | offset u48 | length u32 | crc32 u32 |
 *                        sourceTextSha256[32] | reserved[10]
 *       derived.bin    the entries back to back, one per ordinal:
 *                        wordCount u32 | canonicalSha256[32] | shingleCount u32 |
 *                        shingles: shingleCount x (hi u32, lo u32), ascending
 *
 * A shingle hash is gramHash's 16 hex digits read as two uint32 halves, so the
 * ascending numeric order is the ascending order of the hex strings.
 * sourceTextSha256 is the text-pack record hash of the text the entry was
 * derived from; the segment.json the sidecar pins records the text-pack index
 * that holds those hashes.
 */

export const DERIVED_SOURCE_SIDECAR_FORMAT_VERSION = "derived-source-sidecar-v1";
export const DERIVED_INDEX_MAGIC = "TPSX";
export const DERIVED_BIN_MAGIC = "TPSD";
export const DERIVED_HEADER_BYTES = 16;
export const DERIVED_ROW_BYTES = 64;
export const DERIVED_ENTRY_FIXED_BYTES = 4 + 32 + 4;
export const SIDECAR_ROOT = "sidecars";
export const SIDECAR_MANIFEST_FILE = "sidecar.json";
export const SIDECAR_INDEX_FILE = "derived.idx";
export const SIDECAR_BIN_FILE = "derived.bin";

/**
 * Everything a sidecar entry's bytes depend on. Names say what the running
 * code claims; the probes record what it actually did to fixed inputs, so a
 * silent change to normalize(), the reference strip, informativeGram /
 * COMMON_WORDS, gramHash or canonicalizeText changes the identity.
 */
export type DerivedSourceIdentity = {
  artifactFormat: typeof DERIVED_SOURCE_SIDECAR_FORMAT_VERSION;
  normalization: { contract: string; version: number; probeSha256: string };
  /** The reference-section strip runs inside tokens(); its behaviour is covered by the normalization probe (whose text ends in a reference list). */
  referenceStrip: string;
  shingleSize: number;
  gramHash: string;
  informativeGramPolicy: string;
  canonicalization: string;
  thresholdsVersion: string;
  /** sha256 of the derivation of the two engine probe texts — the behavioural probe of everything above. */
  derivationProbeSha256: string;
};

export function derivedSourceEntryOf(text: string, shingleSize: number = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.shingleSize) {
  return { wordCount: tokens(text).length, canonicalSha256: canonicalSha256(text), shingles: documentShingleHashes(text, shingleSize) };
}

const identityCache = new Map<number, DerivedSourceIdentity>();

/** The identity the running code produces under normalization `version` (which must be the ambient one). */
export function derivedSourceIdentity(version: ScoringNormalizationVersion): DerivedSourceIdentity {
  const ambient = currentScoringNormalizationVersion();
  if (ambient !== version) throw new DerivedSourceError("NORMALIZATION_CONTRACT_MISMATCH", `the derivation would run under scoring normalization v${ambient}, not v${version}`);
  const known = identityCache.get(version);
  if (known) return known;
  const probe = [NORMALIZATION_PROBE_TEXT, FINGERPRINT_PROBE_TEXT].map((text) => {
    const entry = derivedSourceEntryOf(text);
    return { wordCount: entry.wordCount, tokensSha256: sha256Hex(tokensForScoringNormalization(text, version).join(" ")), canonicalSha256: entry.canonicalSha256, shingles: [...entry.shingles].sort() };
  });
  const identity: DerivedSourceIdentity = {
    artifactFormat: DERIVED_SOURCE_SIDECAR_FORMAT_VERSION,
    normalization: { contract: CORPUS_NORMALIZATION_CONTRACT_ID, version, probeSha256: normalizationProbeSha256(version) },
    referenceStrip: "lib/reference-section.ts stripReferenceSection, inside lib/similarity-core.ts tokens()",
    shingleSize: DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.shingleSize,
    gramHash: CORPUS_FINGERPRINT_HASH,
    informativeGramPolicy: "lib/similarity-core.ts informativeGram + COMMON_WORDS",
    canonicalization: "lib/document-identity.ts canonicalSha256(canonicalizeText)",
    thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    derivationProbeSha256: sha256Hex(canonicalJson(probe)),
  };
  identityCache.set(version, identity);
  return identity;
}

export function derivedSourceIdentitySha256(identity: DerivedSourceIdentity): string {
  return sha256Hex(canonicalJson(identity));
}

export function sidecarPrefix(identitySha256: string, segmentId: string) {
  return `${SIDECAR_ROOT}/${identitySha256.slice(0, 24)}/${segmentId}`;
}

export type DerivedSourceManifest = {
  sidecarFormat: typeof DERIVED_SOURCE_SIDECAR_FORMAT_VERSION;
  identity: DerivedSourceIdentity;
  identitySha256: string;
  segmentId: string;
  /** The segment.json hash the generation pins for this segment — and with it the text the entries were derived from. */
  segmentManifestSha256: string;
  documentCount: number;
  shingleCount: number;
  files: Record<string, { bytes: number; sha256: string }>;
};

export type DerivedSourceFailureCode = "SIDECAR_MISSING" | "SIDECAR_IDENTITY_MISMATCH" | "SIDECAR_SEGMENT_MISMATCH" | "SIDECAR_CORRUPT" | "NORMALIZATION_CONTRACT_MISMATCH";

export class DerivedSourceError extends Error {
  readonly code: DerivedSourceFailureCode;
  constructor(code: DerivedSourceFailureCode, message: string) {
    super(message);
    this.name = "DerivedSourceError";
    this.code = code;
  }
}

/** What the verifier needs from a source, from the sidecar: no text. */
export type DerivedSource = {
  wordCount: number;
  canonicalSha256: string;
  /** Distinct informative shingle hashes as ascending (hi, lo) uint32 pairs. */
  hi: Uint32Array;
  lo: Uint32Array;
};

function encodeEntry(wordCount: number, canonical: string, shingles: Set<string>): Buffer {
  const sorted = [...shingles].sort();
  const bytes = Buffer.alloc(DERIVED_ENTRY_FIXED_BYTES + sorted.length * 8);
  bytes.writeUInt32BE(wordCount, 0);
  Buffer.from(canonical, "hex").copy(bytes, 4);
  bytes.writeUInt32BE(sorted.length, 36);
  sorted.forEach((hex, index) => {
    bytes.writeUInt32BE(parseInt(hex.slice(0, 8), 16), DERIVED_ENTRY_FIXED_BYTES + index * 8);
    bytes.writeUInt32BE(parseInt(hex.slice(8, 16), 16), DERIVED_ENTRY_FIXED_BYTES + index * 8 + 4);
  });
  return bytes;
}

export function decodeDerivedEntry(bytes: Bytes): DerivedSource {
  if (bytes.length < DERIVED_ENTRY_FIXED_BYTES) throw new DerivedSourceError("SIDECAR_CORRUPT", "derived entry is shorter than its fixed part");
  const count = bytes.readUInt32BE(36);
  if (bytes.length !== DERIVED_ENTRY_FIXED_BYTES + count * 8) throw new DerivedSourceError("SIDECAR_CORRUPT", "derived entry length disagrees with its shingle count");
  const hi = new Uint32Array(count);
  const lo = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = DERIVED_ENTRY_FIXED_BYTES + index * 8;
    hi[index] = bytes.readUInt32BE(offset);
    lo[index] = bytes.readUInt32BE(offset + 4);
    if (index > 0 && (hi[index] < hi[index - 1] || (hi[index] === hi[index - 1] && lo[index] <= lo[index - 1]))) throw new DerivedSourceError("SIDECAR_CORRUPT", "derived shingles are not strictly ascending");
  }
  return { wordCount: bytes.readUInt32BE(0), canonicalSha256: bytes.toString("hex", 4, 36), hi, lo };
}

/** Membership test over a decoded entry's shingles, for a hash given as uint32 halves. */
export function derivedHolds(source: DerivedSource, hi: number, lo: number): boolean {
  let low = 0;
  let high = source.hi.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const middleHi = source.hi[middle];
    if (middleHi === hi) {
      const middleLo = source.lo[middle];
      if (middleLo === lo) return true;
      if (middleLo < lo) low = middle + 1;
      else high = middle - 1;
    } else if (middleHi < hi) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

// ── build ─────────────────────────────────────────────────────────────────

export type SidecarBuildResult = { segmentId: string; documents: number; shingles: number; bytes: number; deriveMs: number; skipped: boolean };

/**
 * Derives the sidecar of one segment of `reader`'s generation from its stored
 * text and writes it under `corpusRoot`. Files are written to a temporary
 * directory and renamed into place, so a reader never sees a half-written
 * sidecar. An existing sidecar with the same identity and segment is kept.
 */
export async function buildSegmentSidecar(corpusRoot: string, reader: CorpusGenerationReader, segmentId: string): Promise<SidecarBuildResult> {
  const version = reader.manifest.processing.normalization.version as ScoringNormalizationVersion;
  const identity = derivedSourceIdentity(version);
  const identitySha256 = derivedSourceIdentitySha256(identity);
  const slot = reader.slots.find((candidate) => candidate.segmentId === segmentId);
  if (!slot?.reader) throw new DerivedSourceError("SIDECAR_SEGMENT_MISMATCH", `segment ${segmentId} is not an open segment of ${reader.generationId}`);
  const segment = slot.reader;
  const prefix = sidecarPrefix(identitySha256, segmentId);
  const finalDirectory = path.join(corpusRoot, ...prefix.split("/"));
  try {
    const existing = JSON.parse((await reader.store.readAll(`${prefix}/${SIDECAR_MANIFEST_FILE}`)).toString("utf8")) as DerivedSourceManifest;
    if (existing.identitySha256 === identitySha256 && existing.segmentManifestSha256 === reader.manifest.segments[segmentId].manifestSha256) {
      return { segmentId, documents: existing.documentCount, shingles: existing.shingleCount, bytes: Object.values(existing.files).reduce((total, file) => total + file.bytes, 0), deriveMs: 0, skipped: true };
    }
  } catch {
    // not built yet
  }
  const temporary = `${finalDirectory}.tmp-${process.pid}`;
  mkdirSync(temporary, { recursive: true });
  const binPath = path.join(temporary, SIDECAR_BIN_FILE);
  const bin = openSync(binPath, "w");
  const header = Buffer.alloc(DERIVED_HEADER_BYTES);
  header.write(DERIVED_BIN_MAGIC, 0, "latin1");
  header.writeUInt16BE(1, 4);
  writeSync(bin, header);
  const binHash = createHash("sha256").update(header);
  const index = Buffer.alloc(DERIVED_HEADER_BYTES + segment.documentCount * DERIVED_ROW_BYTES);
  index.write(DERIVED_INDEX_MAGIC, 0, "latin1");
  index.writeUInt16BE(1, 4);
  index.writeUInt16BE(DERIVED_ROW_BYTES, 6);
  index.writeUInt32BE(segment.documentCount, 8);
  let offset = DERIVED_HEADER_BYTES;
  let shingles = 0;
  let deriveMs = 0;
  for (let ordinal = 0; ordinal < segment.documentCount; ordinal += 1) {
    const { text } = await segment.readText(ordinal);
    const started = performance.now();
    const derived = derivedSourceEntryOf(text, identity.shingleSize);
    deriveMs += performance.now() - started;
    const entry = encodeEntry(derived.wordCount, derived.canonicalSha256, derived.shingles);
    writeSync(bin, entry);
    binHash.update(entry);
    const row = DERIVED_HEADER_BYTES + ordinal * DERIVED_ROW_BYTES;
    index.writeBigUInt64BE(segment.docIds[ordinal], row);
    writeUint48BE(index, row + 8, offset);
    index.writeUInt32BE(entry.length, row + 14);
    index.writeUInt32BE(zlib.crc32(entry) >>> 0, row + 18);
    Buffer.from(sha256Hex(text), "hex").copy(index, row + 22);
    offset += entry.length;
    shingles += derived.shingles.size;
  }
  fsyncSync(bin);
  closeSync(bin);
  writeFileSync(path.join(temporary, SIDECAR_INDEX_FILE), index);
  const manifest: DerivedSourceManifest = {
    sidecarFormat: DERIVED_SOURCE_SIDECAR_FORMAT_VERSION,
    identity,
    identitySha256,
    segmentId,
    segmentManifestSha256: reader.manifest.segments[segmentId].manifestSha256,
    documentCount: segment.documentCount,
    shingleCount: shingles,
    files: {
      [SIDECAR_BIN_FILE]: { bytes: offset, sha256: binHash.digest("hex") },
      [SIDECAR_INDEX_FILE]: { bytes: index.length, sha256: sha256Hex(index) },
    },
  };
  writeFileSync(path.join(temporary, SIDECAR_MANIFEST_FILE), canonicalJson(manifest));
  mkdirSync(path.dirname(finalDirectory), { recursive: true });
  renameSync(temporary, finalDirectory);
  return { segmentId, documents: segment.documentCount, shingles, bytes: offset + index.length, deriveMs, skipped: false };
}

// ── read ──────────────────────────────────────────────────────────────────

type OpenSidecar = { prefix: string; rows: Bytes; segmentDocIds: BigUint64Array };

export type SidecarReadMetrics = { readMs: number; decodeMs: number; bytesRead: number };

/**
 * The sidecars of one pinned generation, opened and checked. A segment whose
 * sidecar is missing or refused is recorded in `refusals` and served from
 * text; nothing here can make a verification differ, only faster.
 */
export class DerivedSourceSidecarSet {
  private constructor(
    private readonly store: CorpusObjectStore,
    readonly identity: DerivedSourceIdentity,
    readonly identitySha256: string,
    private readonly bySegment: Map<string, OpenSidecar>,
    readonly refusals: Array<{ segmentId: string; code: DerivedSourceFailureCode; message: string }>,
  ) {}

  get segmentsServed() {
    return this.bySegment.size;
  }

  static async open(reader: CorpusGenerationReader): Promise<DerivedSourceSidecarSet> {
    const version = reader.manifest.processing.normalization.version as ScoringNormalizationVersion;
    const identity = derivedSourceIdentity(version);
    const identitySha256 = derivedSourceIdentitySha256(identity);
    const bySegment = new Map<string, OpenSidecar>();
    const refusals: DerivedSourceSidecarSet["refusals"] = [];
    for (const slot of reader.slots) {
      if (!slot.reader) continue;
      const prefix = sidecarPrefix(identitySha256, slot.segmentId);
      try {
        let manifestBytes: Bytes;
        try {
          manifestBytes = await reader.store.readAll(`${prefix}/${SIDECAR_MANIFEST_FILE}`);
        } catch (error) {
          if (error instanceof CorpusStorageError && error.code === "NOT_FOUND") throw new DerivedSourceError("SIDECAR_MISSING", `no sidecar for segment ${slot.segmentId}`);
          throw error;
        }
        const manifest = JSON.parse(manifestBytes.toString("utf8")) as DerivedSourceManifest;
        if (manifest.sidecarFormat !== DERIVED_SOURCE_SIDECAR_FORMAT_VERSION) throw new DerivedSourceError("SIDECAR_IDENTITY_MISMATCH", `sidecar format ${manifest.sidecarFormat} is not ${DERIVED_SOURCE_SIDECAR_FORMAT_VERSION}`);
        if (manifest.identitySha256 !== identitySha256 || derivedSourceIdentitySha256(manifest.identity) !== identitySha256) {
          throw new DerivedSourceError("SIDECAR_IDENTITY_MISMATCH", `sidecar of ${slot.segmentId} was derived under another identity`);
        }
        if (manifest.segmentId !== slot.segmentId || manifest.segmentManifestSha256 !== reader.manifest.segments[slot.segmentId].manifestSha256 || manifest.documentCount !== slot.reader.documentCount) {
          throw new DerivedSourceError("SIDECAR_SEGMENT_MISMATCH", `sidecar of ${slot.segmentId} was derived from another segment`);
        }
        const rows = await reader.store.readAll(`${prefix}/${SIDECAR_INDEX_FILE}`);
        const recordedIndex = manifest.files[SIDECAR_INDEX_FILE];
        if (!recordedIndex || rows.length !== recordedIndex.bytes || sha256Hex(rows) !== recordedIndex.sha256) throw new DerivedSourceError("SIDECAR_CORRUPT", `${SIDECAR_INDEX_FILE} of ${slot.segmentId} does not match its recorded hash`);
        if (rows.toString("latin1", 0, 4) !== DERIVED_INDEX_MAGIC || rows.readUInt32BE(8) !== slot.reader.documentCount) throw new DerivedSourceError("SIDECAR_CORRUPT", `${SIDECAR_INDEX_FILE} of ${slot.segmentId} has a bad header`);
        const binSize = await reader.store.size(`${prefix}/${SIDECAR_BIN_FILE}`);
        if (binSize !== manifest.files[SIDECAR_BIN_FILE]?.bytes) throw new DerivedSourceError("SIDECAR_CORRUPT", `${SIDECAR_BIN_FILE} of ${slot.segmentId} has the wrong size`);
        bySegment.set(slot.segmentId, { prefix, rows, segmentDocIds: slot.reader.docIds });
      } catch (error) {
        const failure = error instanceof DerivedSourceError ? error : new DerivedSourceError("SIDECAR_CORRUPT", error instanceof Error ? error.message : String(error));
        refusals.push({ segmentId: slot.segmentId, code: failure.code, message: failure.message });
      }
    }
    return new DerivedSourceSidecarSet(reader.store, identity, identitySha256, bySegment, refusals);
  }

  /** The derived entry of a located document, or null when its segment is not served by a sidecar. Throws on a corrupt entry. */
  async read(location: DocumentLocation, metrics?: SidecarReadMetrics): Promise<DerivedSource | null> {
    const open = this.bySegment.get(location.segmentId);
    if (!open) return null;
    const row = DERIVED_HEADER_BYTES + location.ordinal * DERIVED_ROW_BYTES;
    if (open.rows.readBigUInt64BE(row) !== open.segmentDocIds[location.ordinal]) throw new DerivedSourceError("SIDECAR_CORRUPT", `sidecar row ${location.ordinal} of ${location.segmentId} names another document`);
    const offset = readUint48BE(open.rows, row + 8);
    const length = open.rows.readUInt32BE(row + 14);
    const readStarted = performance.now();
    const bytes = await this.store.readRange(`${open.prefix}/${SIDECAR_BIN_FILE}`, offset, length);
    const decodeStarted = performance.now();
    if ((zlib.crc32(bytes) >>> 0) !== open.rows.readUInt32BE(row + 18)) throw new DerivedSourceError("SIDECAR_CORRUPT", `sidecar entry ${location.ordinal} of ${location.segmentId} fails its checksum`);
    const decoded = decodeDerivedEntry(bytes);
    if (metrics) {
      metrics.readMs += decodeStarted - readStarted;
      metrics.decodeMs += performance.now() - decodeStarted;
      metrics.bytesRead += bytes.length;
    }
    return decoded;
  }
}
