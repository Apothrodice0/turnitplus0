import { existsSync, statSync } from "node:fs";
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
import {
  createLocalFilesystemStorageAdapter,
  SelectiveCorpusObjectNotFoundError,
  type SelectiveCorpusStorageAdapter,
} from "./storage-adapter";
import {
  parseSelectiveCorpusIntegrityManifest,
  verifySelectiveCorpusObjectIntegrity,
  SelectiveCorpusIntegrityManifestError,
  type SelectiveCorpusIntegrityManifest,
} from "./integrity";

/**
 * Selective Corpus V1 SHADOW slice — packed artifact loader + version/digest
 * validation. FAIL CLOSED: any structural problem throws SelectiveCorpusArtifactError
 * with a code; the orchestrator (lib/selective-corpus/shadow.ts) catches it and
 * returns state "ARTIFACT_UNAVAILABLE" so the application continues normally.
 *
 * Loads: docmap.tsv into a row array and stopset.bin into a Set<hash> (both
 * small, always resident) and validates the 256 packed shards' structural
 * inventory: in LOCAL COMPATIBILITY MODE (default) every shard file's
 * existence is checked via objectExists(), exactly as before this comment was
 * updated. In INTEGRITY-REQUIRED MODE the integrity manifest itself IS the
 * inventory — every shard key must have a manifest entry, but no
 * objectExists()/readObject() round trip is made for shard-001..255 at
 * initialization, avoiding an unnecessary remote-request burst; their actual
 * presence is discovered lazily, per-shard, at query time. Either mode always
 * physically reads+decodes shard-000 as a smoke test. It does NOT deserialise
 * the packed postings — Stage A
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
  | "WRONG_DIGEST"
  | "INTEGRITY_MANIFEST_INVALID";

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
  /** The SAME storage adapter this artifact was loaded through — reused by
   *  source-loader.ts for `bulk:`-kind candidate text so every read for this
   *  artifact goes through one consistent adapter instance (local-fs today;
   *  an injected/remote adapter in a future task). */
  storage: SelectiveCorpusStorageAdapter;
  /** Present only when this artifact was loaded with
   *  `integrityMode: "integrity-required"`. When set, shard-reader.ts and
   *  source-loader.ts verify every packed-shard / candidate-source-text
   *  object's bytes against it before decoding/using/caching them. Absent
   *  (LOCAL COMPATIBILITY MODE, the default) preserves existing behavior
   *  exactly — no manifest is required, and nothing is verified. */
  integrity?: SelectiveCorpusIntegrityManifest;
};

export type LoadSelectiveCorpusArtifactOptions = {
  /** "file-backed" (default, production) uses the bounded shard LRU.
   *  "in-memory" builds the full Map — equivalence test only. */
  mode?: "file-backed" | "in-memory";
  /** file-backed only: hot-shard LRU size override (also SELECTIVE_CORPUS_HOT_SHARD_LRU). */
  hotShards?: number;
  /** Test/future-storage seam: use this adapter instead of constructing a
   *  local-filesystem adapter rooted at `artifactPath`. When given, the
   *  local-only "is artifactPath a real directory" pre-check is skipped —
   *  validating that is the injected adapter's own responsibility. */
  storageAdapter?: SelectiveCorpusStorageAdapter;
  /**
   * "local-compatible" (default): existing behavior — no integrity manifest
   * is required or read, exactly as before this option existed.
   * "integrity-required": proves the future remote/object-store contract —
   * the artifact fails to load (code "INTEGRITY_MANIFEST_INVALID") unless
   * "object-integrity.json" is present and well-formed. Every subsequent
   * packed-shard / candidate-source-text read is then verified against it
   * (see integrity.ts) before its bytes are decoded, cached, or scored from.
   * The CURRENT local frozen artifact is never required to carry this
   * sidecar unless a caller explicitly opts into this mode.
   */
  integrityMode?: "local-compatible" | "integrity-required";
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

// module-level cache keyed by "<absolute artifact path>|<mode>", caching the
// in-flight PROMISE (not just the resolved value) so two callers that
// request the same artifact concurrently, before either has resolved, share
// ONE load rather than each independently re-validating 256 shards. A failed
// load never poisons the cache — the entry is removed on rejection so the
// next call gets a fresh attempt, generalising the old "only set on success"
// behavior to promise form. This Map is used ONLY for the DEFAULT (no
// injected storage adapter) case.
const cache = new Map<string, Promise<SelectiveCorpusArtifact>>();

/**
 * Concurrency/identity hardening: a SEPARATE cache, partitioned per injected
 * storage-adapter INSTANCE, for the `options.storageAdapter` case (tests
 * today; a future remote-storage adapter). Two distinct adapter objects
 * pointed at the same nominal artifactPath/mode must never collide — a
 * single shared `cache` keyed only by "path|mode" cannot tell them apart,
 * since the key carries no adapter identity at all. WeakMap keys by REFERENCE
 * IDENTITY (never a constructor name or a stringified adapter, which could
 * collide or be spoofed), and its entries are automatically eligible for GC
 * once nothing else holds a reference to that adapter — no unbounded
 * registry to manage, and no explicit cleanup needed as adapters are
 * discarded. The DEFAULT path never touches this map: constructing a fresh
 * local adapter on every uncached call (as it always has) would give each
 * call a distinct identity here, defeating path/mode-based caching for the
 * common case, so the default case keeps using the plain `cache` above,
 * unchanged.
 */
const adapterScopedCaches = new WeakMap<SelectiveCorpusStorageAdapter, Map<string, Promise<SelectiveCorpusArtifact>>>();

export function clearSelectiveCorpusArtifactCache(): void {
  cache.clear();
  // adapterScopedCaches is deliberately NOT (and cannot be) cleared here — a
  // WeakMap offers no enumeration/clear API by design, which is exactly what
  // makes it safe from an unbounded-registry standpoint. Every caller that
  // injects an adapter owns that adapter's own lifetime; discarding the
  // adapter reference (e.g. a test ending) is how its cache partition goes
  // away.
}

function resolveArtifactCacheMap(
  options: LoadSelectiveCorpusArtifactOptions,
): Map<string, Promise<SelectiveCorpusArtifact>> {
  if (!options.storageAdapter) return cache;
  let scoped = adapterScopedCaches.get(options.storageAdapter);
  if (!scoped) {
    scoped = new Map<string, Promise<SelectiveCorpusArtifact>>();
    adapterScopedCaches.set(options.storageAdapter, scoped);
  }
  return scoped;
}

export function loadSelectiveCorpusArtifact(
  artifactPath: string,
  options: LoadSelectiveCorpusArtifactOptions = {},
): Promise<SelectiveCorpusArtifact> {
  const mode = options.mode ?? "file-backed";
  const integrityMode = options.integrityMode ?? "local-compatible";
  const cacheKey = `${artifactPath}|${mode}|${integrityMode}`;
  const targetCache = resolveArtifactCacheMap(options);
  const cached = targetCache.get(cacheKey);
  if (cached) return cached;

  // targetCache.set happens synchronously, before this async function's
  // first await runs — any concurrent caller arriving in the same tick
  // (using the SAME adapter instance, or the default path) sees the cache
  // hit above instead of starting a second load.
  const promise = loadSelectiveCorpusArtifactUncached(artifactPath, options).catch((err: unknown) => {
    targetCache.delete(cacheKey);
    throw err;
  });
  targetCache.set(cacheKey, promise);
  return promise;
}

async function loadSelectiveCorpusArtifactUncached(
  artifactPath: string,
  options: LoadSelectiveCorpusArtifactOptions,
): Promise<SelectiveCorpusArtifact> {
  const mode = options.mode ?? "file-backed";
  const integrityMode = options.integrityMode ?? "local-compatible";

  let storage: SelectiveCorpusStorageAdapter;
  if (options.storageAdapter) {
    storage = options.storageAdapter;
  } else {
    // Local-filesystem-only bootstrap check: confirms artifactPath itself is
    // a real directory before treating it as a local adapter root. This is
    // the one remaining sync fs call in this module — justified because it
    // fires at most once per (uncached) artifact load, never in the per-shard
    // hot path, and "is this local path a directory" has no analogue for an
    // injected (future remote) adapter, which is why it is skipped when one
    // is supplied.
    if (!existsSync(artifactPath) || !statSync(artifactPath).isDirectory()) {
      throw new SelectiveCorpusArtifactError("MISSING", `artifact path not a directory: ${artifactPath}`);
    }
    storage = createLocalFilesystemStorageAdapter(artifactPath);
  }

  let versionBytes: Uint8Array;
  try {
    versionBytes = await storage.readObject("corpus-version.json");
  } catch (err) {
    if (err instanceof SelectiveCorpusObjectNotFoundError) {
      throw new SelectiveCorpusArtifactError("MISSING", "corpus-version.json not found");
    }
    throw err;
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
    version = JSON.parse(Buffer.from(versionBytes).toString("utf8"));
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

  // REMOTE/INTEGRITY MODE only: the sidecar manifest is itself an ordinary
  // artifact-relative object, read through the SAME storage adapter as
  // everything else — never a separate side-channel. LOCAL COMPATIBILITY
  // MODE (the default) skips this entirely: the current local frozen
  // artifact is never required to carry this file unless a caller
  // explicitly opts in.
  let integrity: SelectiveCorpusIntegrityManifest | undefined;
  if (integrityMode === "integrity-required") {
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = await storage.readObject("object-integrity.json");
    } catch (err) {
      if (err instanceof SelectiveCorpusObjectNotFoundError) {
        throw new SelectiveCorpusArtifactError(
          "INTEGRITY_MANIFEST_INVALID",
          "integrity-required mode requires object-integrity.json, none found",
        );
      }
      throw err;
    }
    try {
      integrity = parseSelectiveCorpusIntegrityManifest(manifestBytes);
    } catch (err) {
      if (err instanceof SelectiveCorpusIntegrityManifestError) {
        throw new SelectiveCorpusArtifactError("INTEGRITY_MANIFEST_INVALID", `object-integrity.json invalid (${err.code}): ${err.message}`);
      }
      throw err;
    }
  }

  // docmap
  const packPrefix = "packed";
  const docmapKey = `${packPrefix}/docmap.tsv`;
  const stopKey = `${packPrefix}/stopset.bin`;
  const [docmapExists, stopExists] = [await storage.objectExists(docmapKey), await storage.objectExists(stopKey)];
  if (!docmapExists || !stopExists) {
    throw new SelectiveCorpusArtifactError("MISSING", "packed/docmap.tsv or packed/stopset.bin not found");
  }
  const docs: SelectiveCorpusDoc[] = [];
  try {
    const docmapBytes = await storage.readObject(docmapKey);
    for (const line of Buffer.from(docmapBytes).toString("utf8").split(/\r?\n/)) {
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
    const stopBuf = await storage.readObject(stopKey);
    for (let i = 0; i + 8 <= stopBuf.length; i += 8) stopHashes.add(hex8(stopBuf, i));
  } catch {
    throw new SelectiveCorpusArtifactError("CORRUPT", "packed/stopset.bin unreadable");
  }

  // packed shards — structural validation, forked by integrityMode.
  //
  // LOCAL COMPATIBILITY MODE (default, unchanged from before this task): every
  // one of the 256 shard files is existence-checked via objectExists() before
  // shard-000 is read/decoded. Sequential, not parallel — deterministic
  // first-failure reporting, matching the original loop's order exactly.
  //
  // INTEGRITY-REQUIRED MODE: objectExists() against all 256 shards would be an
  // unnecessary remote-request burst before Stage A ever runs. The sidecar
  // manifest (already read/parsed above) IS the structural inventory instead —
  // we require it to carry an entry for every shard key, but never ask storage
  // whether the backing object for shard-001..255 actually exists. A manifest
  // entry existing does not guarantee the object still does; that is
  // discovered lazily, per-shard, the first time Stage A/FAMILY_GUARD queries
  // it (see shard-reader.ts), where a missing/corrupt non-zero shard degrades
  // only the affected evaluation to PARTIAL with zero evidence rather than
  // failing initialization for the whole corpus.
  if (integrityMode === "integrity-required") {
    // Guaranteed defined here: the block above either assigned `integrity` or
    // already threw INTEGRITY_MANIFEST_INVALID.
    const manifest = integrity!;
    for (let s = 0; s < 256; s++) {
      const shardKey = `${packPrefix}/shard-${String(s).padStart(3, "0")}.bin`;
      if (!manifest.get(shardKey)) {
        throw new SelectiveCorpusArtifactError(
          "INTEGRITY_MANIFEST_INVALID",
          `object-integrity.json is missing a required entry for ${shardKey}`,
        );
      }
    }
  } else {
    for (let s = 0; s < 256; s++) {
      const shardKey = `${packPrefix}/shard-${String(s).padStart(3, "0")}.bin`;
      if (!(await storage.objectExists(shardKey))) {
        throw new SelectiveCorpusArtifactError("MISSING", `packed/shard-${String(s).padStart(3, "0")}.bin not found`);
      }
    }
  }

  // shard-000 smoke validation — ALWAYS one real physical read+decode, in
  // BOTH modes, proving the adapter is operational and the artifact format is
  // usable. Integrity-required mode additionally verifies these exact bytes
  // against the manifest — the only packed-shard byte-integrity check done
  // eagerly at initialization; shard-001..255 are verified lazily, per read.
  let smoke: Uint8Array;
  try {
    smoke = await storage.readObject(`${packPrefix}/shard-000.bin`);
  } catch (err) {
    if (err instanceof SelectiveCorpusObjectNotFoundError) {
      throw new SelectiveCorpusArtifactError("MISSING", "packed/shard-000.bin not found");
    }
    throw new SelectiveCorpusArtifactError("CORRUPT", "packed/shard-000.bin unreadable");
  }
  if (integrity) {
    try {
      verifySelectiveCorpusObjectIntegrity(`${packPrefix}/shard-000.bin`, smoke, integrity);
    } catch (err) {
      throw new SelectiveCorpusArtifactError(
        "CORRUPT",
        `packed/shard-000.bin failed integrity verification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      // Sequential, not parallel — this mode exists solely for the
      // equivalence test (never the production path), so there is no reason
      // to risk changing its behavior by parallelizing.
      for (let s = 0; s < 256; s++) {
        const buf = await storage.readObject(`${packPrefix}/shard-${String(s).padStart(3, "0")}.bin`);
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
    postingsAccessor = new SelectiveCorpusShardReader(storage, packPrefix, options.hotShards, { integrity });
  }

  return {
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
    storage,
    integrity,
  };
}
