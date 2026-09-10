import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SELECTIVE_CORPUS_EXPECTED_DIGEST,
  SELECTIVE_CORPUS_STOP_DF,
  SELECTIVE_CORPUS_VERSION,
} from "./constants";
import {
  SelectiveCorpusShardReader,
  InMemoryPostingsAccessor,
  type SelectiveCorpusPostingsAccessor,
} from "./shard-reader";

/**
 * Selective Corpus V1 SHADOW slice — packed artifact loader + version/digest
 * validation. FAIL CLOSED: any structural problem throws SelectiveCorpusArtifactError
 * with a code; the orchestrator (lib/selective-corpus/shadow.ts) catches it and
 * returns state "ARTIFACT_UNAVAILABLE" so the application continues normally.
 *
 * Loads: docmap.tsv into a row array and stopset.bin into a Set<hash> (both
 * small, always resident) and validates that all 256 shard files exist and
 * shard-000 decodes. It does NOT deserialise the packed postings — Stage A
 * reads them through a bounded file-backed hot-shard LRU
 * (lib/selective-corpus/shard-reader.ts), so at most SELECTIVE_CORPUS_HOT_SHARD_LRU
 * shards' worth of postings are ever in RAM. The previous implementation
 * expanded the ~26 MB of packed bytes into a ~1 GB Map (per-entry Map / string /
 * typed-array overhead over ~2.4 M entries); the file-backed reader removes
 * that. "in-memory" mode (the full Map) exists only for the equivalence test.
 *
 * Does NOT load any source text — that is lib/selective-corpus/source-loader.ts,
 * one file per candidate, LRU-bounded.
 */

export type SelectiveCorpusArtifactErrorCode =
  | "MISSING"
  | "CORRUPT"
  | "WRONG_VERSION"
  | "WRONG_DIGEST";

export class SelectiveCorpusArtifactError extends Error {
  readonly code: SelectiveCorpusArtifactErrorCode;
  constructor(code: SelectiveCorpusArtifactErrorCode, message: string) {
    super(message);
    this.name = "SelectiveCorpusArtifactError";
    this.code = code;
  }
}

export type SelectiveCorpusDoc = {
  ordinal: number;
  sourceId: string;
  family: string;
  rawId: string;
  wordCount: number;
  interpretationLabel: string;
};

export type SelectiveCorpusArtifact = {
  artifactPath: string;
  corpusVersion: string;
  corpusDigest: string;
  fingerprintVersion: string;
  documentCount: number;
  /** hash(hex16) -> doc ordinals (asc). File-backed by default (a bounded
   *  hot-shard LRU — the packed index is NEVER fully deserialised); an
   *  in-memory Map only in "in-memory" mode, used solely by the equivalence
   *  test. Stop hashes are absent (excluded at build). */
  postingsAccessor: SelectiveCorpusPostingsAccessor;
  /** DF >= SELECTIVE_CORPUS_STOP_DF hashes — removed from Stage A queries. */
  stopHashes: Set<string>;
  docs: SelectiveCorpusDoc[];
  docByOrdinal: SelectiveCorpusDoc[];
  mode: "file-backed" | "in-memory";
};

export type LoadSelectiveCorpusArtifactOptions = {
  /** "file-backed" (default, production) uses the bounded shard LRU.
   *  "in-memory" builds the full Map — equivalence test only. */
  mode?: "file-backed" | "in-memory";
  /** file-backed only: hot-shard LRU size override (also SELECTIVE_CORPUS_HOT_SHARD_LRU). */
  hotShards?: number;
};

// Byte-level helpers — deliberately operate on Uint8Array so the code does not
// depend on any particular @types/node Buffer-method surface.
function readVarint(buf: Uint8Array, st: { i: number }): number {
  let sh = 0;
  let r = 0;
  let b: number;
  do {
    b = buf[st.i++];
    r |= (b & 0x7f) << sh;
    sh += 7;
  } while (b & 0x80);
  return r >>> 0;
}
function readUint32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function hex8(buf: Uint8Array, off: number): string {
  return (
    HEX[buf[off]] + HEX[buf[off + 1]] + HEX[buf[off + 2]] + HEX[buf[off + 3]] +
    HEX[buf[off + 4]] + HEX[buf[off + 5]] + HEX[buf[off + 6]] + HEX[buf[off + 7]]
  );
}

// module-level cache keyed by "<absolute artifact path>|<mode>". A failed load
// never poisons the cache (we only set it on success).
const cache = new Map<string, SelectiveCorpusArtifact>();

export function clearSelectiveCorpusArtifactCache(): void {
  cache.clear();
}

export function loadSelectiveCorpusArtifact(
  artifactPath: string,
  options: LoadSelectiveCorpusArtifactOptions = {},
): SelectiveCorpusArtifact {
  const mode = options.mode ?? "file-backed";
  const cacheKey = `${artifactPath}|${mode}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!existsSync(artifactPath) || !statSync(artifactPath).isDirectory()) {
    throw new SelectiveCorpusArtifactError("MISSING", `artifact path not a directory: ${artifactPath}`);
  }
  const versionFile = join(artifactPath, "corpus-version.json");
  if (!existsSync(versionFile)) {
    throw new SelectiveCorpusArtifactError("MISSING", "corpus-version.json not found");
  }

  let version: {
    corpusVersion?: string;
    corpusIdentityDigest?: string;
    fingerprintVersion?: string;
    winnowWindow?: number;
    shingleSize?: number;
    stopPolicy?: string;
    documentCount?: number;
  };
  try {
    version = JSON.parse(readFileSync(versionFile, "utf8"));
  } catch {
    throw new SelectiveCorpusArtifactError("CORRUPT", "corpus-version.json is not valid JSON");
  }

  if (version.corpusVersion !== SELECTIVE_CORPUS_VERSION) {
    throw new SelectiveCorpusArtifactError(
      "WRONG_VERSION",
      `expected corpusVersion ${SELECTIVE_CORPUS_VERSION}, got ${String(version.corpusVersion)}`,
    );
  }
  if (version.winnowWindow !== 15 || version.shingleSize !== 5 || version.stopPolicy !== `global DF>=${SELECTIVE_CORPUS_STOP_DF}`) {
    throw new SelectiveCorpusArtifactError(
      "WRONG_VERSION",
      `artifact fingerprint parameters do not match this build (w=${String(version.winnowWindow)} s=${String(version.shingleSize)} stop=${String(version.stopPolicy)})`,
    );
  }
  if (version.corpusIdentityDigest !== SELECTIVE_CORPUS_EXPECTED_DIGEST) {
    throw new SelectiveCorpusArtifactError(
      "WRONG_DIGEST",
      `artifact digest mismatch — expected ${SELECTIVE_CORPUS_EXPECTED_DIGEST}, got ${String(version.corpusIdentityDigest)}`,
    );
  }

  // docmap
  const packDir = join(artifactPath, "packed");
  const docmapFile = join(packDir, "docmap.tsv");
  const stopFile = join(packDir, "stopset.bin");
  if (!existsSync(docmapFile) || !existsSync(stopFile)) {
    throw new SelectiveCorpusArtifactError("MISSING", "packed/docmap.tsv or packed/stopset.bin not found");
  }
  const docs: SelectiveCorpusDoc[] = [];
  try {
    for (const line of readFileSync(docmapFile, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      const [ord, sourceId, family, rawId, wc, label] = line.split("\t");
      docs.push({
        ordinal: Number(ord),
        sourceId,
        family,
        rawId,
        wordCount: Number(wc),
        interpretationLabel: label ?? "ORDINARY_REFERENCE",
      });
    }
  } catch {
    throw new SelectiveCorpusArtifactError("CORRUPT", "packed/docmap.tsv unreadable");
  }
  if (docs.length === 0) throw new SelectiveCorpusArtifactError("CORRUPT", "packed/docmap.tsv is empty");
  const docByOrdinal: SelectiveCorpusDoc[] = [];
  for (const d of docs) docByOrdinal[d.ordinal] = d;

  // stopset
  const stopHashes = new Set<string>();
  try {
    const stopBuf = new Uint8Array(readFileSync(stopFile));
    for (let i = 0; i + 8 <= stopBuf.length; i += 8) stopHashes.add(hex8(stopBuf, i));
  } catch {
    throw new SelectiveCorpusArtifactError("CORRUPT", "packed/stopset.bin unreadable");
  }

  // packed shards — structural validation only: every shard file must exist and
  // shard-000 must decode. We do NOT decode all 256 (that is the ~1 GB /
  // ~4 s cost this runtime removes).
  for (let s = 0; s < 256; s++) {
    const shardFile = join(packDir, `shard-${String(s).padStart(3, "0")}.bin`);
    if (!existsSync(shardFile)) {
      throw new SelectiveCorpusArtifactError("MISSING", `packed/shard-${String(s).padStart(3, "0")}.bin not found`);
    }
  }
  let smoke: Uint8Array;
  try {
    smoke = new Uint8Array(readFileSync(join(packDir, "shard-000.bin")));
  } catch {
    throw new SelectiveCorpusArtifactError("CORRUPT", "packed/shard-000.bin unreadable");
  }
  if (smoke.length >= 4) {
    const n0 = readUint32LE(smoke, 0);
    // a sane shard has a nonneg entry count and, if nonempty, enough bytes for one entry header
    if (n0 > 0 && smoke.length < 4 + 8 + 1) {
      throw new SelectiveCorpusArtifactError("CORRUPT", "packed/shard-000.bin is truncated");
    }
    // decode one entry to confirm the format
    if (n0 > 0) {
      const st = { i: 4 + 8 };
      readVarint(smoke, st); // postingCount — throws range issues would surface here
      void hex8(smoke, 4);
    }
  }

  let postingsAccessor: SelectiveCorpusPostingsAccessor;
  if (mode === "in-memory") {
    const map = new Map<string, Uint32Array>();
    try {
      for (let s = 0; s < 256; s++) {
        const buf = new Uint8Array(readFileSync(join(packDir, `shard-${String(s).padStart(3, "0")}.bin`)));
        if (buf.length < 4) continue;
        const n = readUint32LE(buf, 0);
        const st = { i: 4 };
        for (let e = 0; e < n; e++) {
          const h = hex8(buf, st.i);
          st.i += 8;
          const pc = readVarint(buf, st);
          const arr = new Uint32Array(pc);
          let prev = 0;
          for (let k = 0; k < pc; k++) {
            prev += readVarint(buf, st);
            arr[k] = prev;
          }
          map.set(h, arr);
        }
      }
    } catch (err) {
      throw new SelectiveCorpusArtifactError("CORRUPT", `in-memory shard decode failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (map.size === 0) throw new SelectiveCorpusArtifactError("CORRUPT", "packed shards decoded to zero postings");
    postingsAccessor = new InMemoryPostingsAccessor(map);
  } else {
    postingsAccessor = new SelectiveCorpusShardReader(packDir, options.hotShards);
  }

  const artifact: SelectiveCorpusArtifact = {
    artifactPath,
    corpusVersion: version.corpusVersion,
    corpusDigest: version.corpusIdentityDigest ?? "",
    fingerprintVersion: version.fingerprintVersion ?? "",
    documentCount: version.documentCount ?? docs.length,
    postingsAccessor,
    mode,
    stopHashes,
    docs,
    docByOrdinal,
  };
  cache.set(cacheKey, artifact);
  return artifact;
}
