import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  BlobNotFoundError,
  BlobAccessError,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobRequestAbortedError,
  BlobUnknownError,
} from "@vercel/blob";
import {
  createVercelBlobStorageAdapter,
} from "../lib/selective-corpus/vercel-blob-storage-adapter.ts";
import {
  SelectiveCorpusObjectNotFoundError,
  SelectiveCorpusTransientStorageError,
  createLocalFilesystemStorageAdapter,
} from "../lib/selective-corpus/storage-adapter.ts";
import { SelectiveCorpusShardReader, createSelectiveCorpusFailureCollector } from "../lib/selective-corpus/shard-reader.ts";
import {
  loadSelectiveCorpusArtifact,
  clearSelectiveCorpusArtifactCache,
} from "../lib/selective-corpus/artifact.ts";
import { loadSelectiveCorpusCandidateText, clearSelectiveCorpusSourceCache } from "../lib/selective-corpus/source-loader.ts";
import { selectiveCorpusStageA } from "../lib/selective-corpus/stage-a.ts";
import { runSelectiveCorpusShadow } from "../lib/selective-corpus/shadow.ts";
import { getSelectiveCorpusStorageMode } from "../lib/selective-corpus/config.ts";
import { parseSelectiveCorpusIntegrityManifest } from "../lib/selective-corpus/integrity.ts";
import { SELECTIVE_CORPUS_EXPECTED_DIGEST, SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST } from "../lib/selective-corpus/constants.ts";

/**
 * VERCEL PRIVATE BLOB STORAGE ADAPTER — deterministic tests, NO real network.
 *
 * Every test injects a fake VercelBlobReadClient ({get, head} functions) --
 * the production adapter's only I/O seam. The real @vercel/blob error CLASSES
 * (BlobNotFoundError, BlobServiceRateLimited, ...) are imported and thrown
 * directly by these fakes: constructing/throwing a plain Error subclass
 * performs no I/O, so this both proves the real SDK module imports/compiles
 * correctly (section 14) and drives every error-mapping branch precisely.
 */

// async-safe: the finally block must only run AFTER an async `fn` resolves.
async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function shardKeyFor(shardNumber) {
  return `packed/shard-${String(shardNumber).padStart(3, "0")}.bin`;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildManifestBytes(entries) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      objects: entries.map((e) => ({
        key: e.key,
        sha256: e.sha256Override ?? sha256Hex(e.bytes),
        byteLength: e.byteLengthOverride ?? e.bytes.length,
      })),
    }),
  );
}

function encodeVarint(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

function encodeShardBytes(entries) {
  const sorted = [...entries].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(sorted.length, 0);
  const parts = [header];
  for (const e of sorted) {
    parts.push(Buffer.from(e.hash, "hex"));
    parts.push(encodeVarint(e.ordinals.length));
    let prev = 0;
    for (const ord of e.ordinals) {
      parts.push(encodeVarint(ord - prev));
      prev = ord;
    }
  }
  return Buffer.concat(parts);
}

function streamFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeGetResult(bytes) {
  return {
    statusCode: 200,
    stream: streamFromBytes(bytes),
    headers: new Headers(),
    blob: {
      url: "",
      downloadUrl: "",
      pathname: "",
      contentDisposition: "",
      cacheControl: "",
      uploadedAt: new Date(0),
      etag: "",
      contentType: "application/octet-stream",
      size: bytes.length,
    },
  };
}

function makeHeadResult(bytes) {
  return {
    size: bytes.length,
    uploadedAt: new Date(0),
    pathname: "",
    contentType: "application/octet-stream",
    contentDisposition: "",
    url: "",
    downloadUrl: "",
    cacheControl: "",
    etag: "",
  };
}

/** Minimal deterministic fake VercelBlobReadClient. `objects` keyed by the
 *  FULL pathname (prefix + key) the adapter is expected to construct. */
function createFakeVercelBlobReadClient({ objects = {} } = {}) {
  const getCalls = new Map();
  const headCalls = new Map();
  const getCallOptionsLog = [];
  const transientGetRemaining = new Map();
  function bump(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return {
    async get(pathname, options) {
      bump(getCalls, pathname);
      getCallOptionsLog.push(options);
      const spec = objects[pathname];
      if (!spec) return null;
      if (spec.transientGetFailuresBeforeSuccess) {
        const remaining = transientGetRemaining.get(pathname) ?? spec.transientGetFailuresBeforeSuccess;
        if (remaining > 0) {
          transientGetRemaining.set(pathname, remaining - 1);
          throw new TypeError("fetch failed");
        }
      }
      if (spec.getError) throw spec.getError;
      if (spec.bytes === undefined) return null;
      return makeGetResult(spec.bytes);
    },
    async head(pathname) {
      bump(headCalls, pathname);
      const spec = objects[pathname];
      if (!spec) throw new BlobNotFoundError();
      if (spec.headError) throw spec.headError;
      if (spec.bytes === undefined) throw new BlobNotFoundError();
      return makeHeadResult(spec.bytes);
    },
    getCallCount(pathname) {
      return getCalls.get(pathname) ?? 0;
    },
    headCallCount(pathname) {
      return headCalls.get(pathname) ?? 0;
    },
    totalGetCalls() {
      return [...getCalls.values()].reduce((a, b) => a + b, 0);
    },
    totalHeadCalls() {
      return [...headCalls.values()].reduce((a, b) => a + b, 0);
    },
    getCallOptions(index) {
      return getCallOptionsLog[index];
    },
  };
}

/** Backs a fake client with a REAL local directory (via the local adapter),
 *  with per-artifact-relative-key overrides for missing/corrupt/error
 *  simulation -- everything not overridden reads through to the real bytes. */
function createBackedFakeVercelBlobReadClient(rootDir, prefix, overrides = {}) {
  const backing = createLocalFilesystemStorageAdapter(rootDir);
  const getCalls = new Map();
  const headCalls = new Map();
  function bump(map, k) {
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  function keyFromPathname(pathname) {
    return pathname.slice(prefix.length + 1);
  }
  return {
    async get(pathname) {
      bump(getCalls, pathname);
      const key = keyFromPathname(pathname);
      const ov = overrides[key];
      if (ov) {
        if (ov.getError) throw ov.getError;
        if (ov.missing) return null;
        if (ov.bytesOverride !== undefined) return makeGetResult(ov.bytesOverride);
      }
      try {
        const bytes = await backing.readObject(key);
        return makeGetResult(bytes);
      } catch (err) {
        if (err instanceof SelectiveCorpusObjectNotFoundError) return null;
        throw err;
      }
    },
    async head(pathname) {
      bump(headCalls, pathname);
      const key = keyFromPathname(pathname);
      const ov = overrides[key];
      if (ov) {
        if (ov.headError) throw ov.headError;
        if (ov.missing) throw new BlobNotFoundError();
        if (ov.bytesOverride !== undefined) return makeHeadResult(ov.bytesOverride);
      }
      const exists = await backing.objectExists(key);
      if (!exists) throw new BlobNotFoundError();
      return makeHeadResult(new Uint8Array(0));
    },
    getCallCount(key) {
      return getCalls.get(`${prefix}/${key}`) ?? 0;
    },
    headCallCount(key) {
      return headCalls.get(`${prefix}/${key}`) ?? 0;
    },
  };
}

const PREFIX = "selective-corpus/v1";

// ═══════════════════════════════════════════════════════════════════════
// 12. ADAPTER TESTS (A-I)
// ═══════════════════════════════════════════════════════════════════════

test("adapter A: readObject success -- pathname includes the fixed prefix, access is private, exact bytes returned", async () => {
  const bytes = Buffer.from("hello selective corpus blob bytes", "utf8");
  const pathname = `${PREFIX}/packed/shard-000.bin`;
  const client = createFakeVercelBlobReadClient({ objects: { [pathname]: { bytes } } });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  const result = await adapter.readObject("packed/shard-000.bin");
  assert.deepEqual(Buffer.from(result), bytes, "exact bytes preserved");
  assert.equal(client.getCallCount(pathname), 1);
  assert.deepEqual(client.getCallOptions(0), { access: "private" });
});

test("adapter B: objectExists success", async () => {
  const pathname = `${PREFIX}/packed/shard-005.bin`;
  const client = createFakeVercelBlobReadClient({ objects: { [pathname]: { bytes: Buffer.alloc(4) } } });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  assert.equal(await adapter.objectExists("packed/shard-005.bin"), true);
  assert.equal(client.headCallCount(pathname), 1);
});

test("adapter C: object not found -- readObject throws SelectiveCorpusObjectNotFoundError, objectExists => false", async () => {
  const client = createFakeVercelBlobReadClient({ objects: {} });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  await assert.rejects(() => adapter.readObject("packed/shard-099.bin"), SelectiveCorpusObjectNotFoundError);
  assert.equal(await adapter.objectExists("packed/shard-099.bin"), false);
});

test("adapter D: transient provider/transport failures map to SelectiveCorpusTransientStorageError", async () => {
  const rateLimitedPathname = `${PREFIX}/packed/shard-010.bin`;
  const unavailablePathname = `${PREFIX}/packed/shard-011.bin`;
  const abortedPathname = `${PREFIX}/packed/shard-012.bin`;
  const networkPathname = `${PREFIX}/packed/shard-013.bin`;
  const client = createFakeVercelBlobReadClient({
    objects: {
      [rateLimitedPathname]: { headError: new BlobServiceRateLimited(5) },
      [unavailablePathname]: { headError: new BlobServiceNotAvailable() },
      [abortedPathname]: { headError: new BlobRequestAbortedError() },
      [networkPathname]: { getError: new TypeError("fetch failed") },
    },
  });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  await assert.rejects(() => adapter.objectExists("packed/shard-010.bin"), SelectiveCorpusTransientStorageError);
  await assert.rejects(() => adapter.objectExists("packed/shard-011.bin"), SelectiveCorpusTransientStorageError);
  await assert.rejects(() => adapter.objectExists("packed/shard-012.bin"), SelectiveCorpusTransientStorageError);
  await assert.rejects(() => adapter.readObject("packed/shard-013.bin"), SelectiveCorpusTransientStorageError);
});

test("adapter E: authorization/config failure is never NOT_FOUND and never silently false", async () => {
  const accessPathname = `${PREFIX}/packed/shard-020.bin`;
  const storeGonePathname = `${PREFIX}/packed/shard-021.bin`;
  const suspendedPathname = `${PREFIX}/packed/shard-022.bin`;
  const ambiguousPathname = `${PREFIX}/packed/shard-023.bin`;
  const client = createFakeVercelBlobReadClient({
    objects: {
      [accessPathname]: { headError: new BlobAccessError(), getError: new BlobAccessError() },
      [storeGonePathname]: { headError: new BlobStoreNotFoundError() },
      [suspendedPathname]: { headError: new BlobStoreSuspendedError() },
      [ambiguousPathname]: { headError: new BlobUnknownError() },
    },
  });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  const isNotFoundOrTransient = (e) => e instanceof SelectiveCorpusObjectNotFoundError || e instanceof SelectiveCorpusTransientStorageError;

  await assert.rejects(() => adapter.objectExists("packed/shard-020.bin"), (e) => !isNotFoundOrTransient(e));
  await assert.rejects(() => adapter.readObject("packed/shard-020.bin"), (e) => !isNotFoundOrTransient(e));
  await assert.rejects(() => adapter.objectExists("packed/shard-021.bin"), (e) => !isNotFoundOrTransient(e));
  await assert.rejects(() => adapter.objectExists("packed/shard-022.bin"), (e) => !isNotFoundOrTransient(e));
  // an ambiguous BlobError subtype the SDK might add is ALSO never guessed as not-found/transient
  await assert.rejects(() => adapter.objectExists("packed/shard-023.bin"), (e) => !isNotFoundOrTransient(e));
});

test("adapter F: invalid/traversal/URL-shaped keys are rejected before any SDK call", async () => {
  const client = createFakeVercelBlobReadClient({});
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  const badKeys = [
    "../escape.bin",
    "packed/../../escape.bin",
    "/abs/path.bin",
    "C:\\windows\\x.bin",
    "packed\\shard-000.bin",
    "https://evil.example.com/x",
    "a\0b",
    "",
  ];
  for (const key of badKeys) {
    await assert.rejects(() => adapter.readObject(key), `readObject should reject key ${JSON.stringify(key)}`);
    await assert.rejects(() => adapter.objectExists(key), `objectExists should reject key ${JSON.stringify(key)}`);
  }
  assert.equal(client.totalGetCalls(), 0, "no SDK get() call for any invalid key");
  assert.equal(client.totalHeadCalls(), 0, "no SDK head() call for any invalid key");
});

test("adapter G: prefix normalization is deterministic and cannot be escaped by a key", async () => {
  const bytes = Buffer.from("prefix-normalization-bytes");
  const canonicalPathname = `${PREFIX}/packed/shard-000.bin`;
  const client = createFakeVercelBlobReadClient({ objects: { [canonicalPathname]: { bytes } } });

  // a trailing slash on the configured prefix normalizes to the SAME pathname
  const adapterTrailingSlash = createVercelBlobStorageAdapter({ prefix: `${PREFIX}/`, client });
  const result = await adapterTrailingSlash.readObject("packed/shard-000.bin");
  assert.deepEqual(Buffer.from(result), bytes);
  assert.equal(client.getCallCount(canonicalPathname), 1);

  // a misconfigured prefix fails closed at construction time, before any SDK call
  const badPrefixes = ["../escape", "/abs/prefix", "C:\\abs\\prefix", "", "   ", "https://evil.example.com"];
  for (const prefix of badPrefixes) {
    assert.throws(() => createVercelBlobStorageAdapter({ prefix, client }), `prefix ${JSON.stringify(prefix)} must be rejected`);
  }
});

test("adapter H: concurrent same-shard reads through SelectiveCorpusShardReader still dedupe to one adapter read", async () => {
  const hash = "77" + "00".repeat(7); // shard 0x77 = 119
  const shardBytes = encodeShardBytes([{ hash, ordinals: [5, 6] }]);
  const pathname = `${PREFIX}/${shardKeyFor(119)}`;
  const client = createFakeVercelBlobReadClient({ objects: { [pathname]: { bytes: shardBytes } } });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8);

  const [r1, r2] = await Promise.all([reader.getPostings(hash), reader.getPostings(hash)]);
  assert.deepEqual([...r1], [5, 6]);
  assert.deepEqual([...r2], [5, 6]);
  assert.equal(client.getCallCount(pathname), 1, "one physical adapter read for the concurrent batch");
});

test("adapter I: has no write capability -- only readObject/objectExists are exposed", () => {
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client: createFakeVercelBlobReadClient({}) });
  for (const method of ["put", "upload", "del", "delete", "copy", "rename", "createMultipartUpload", "createMultipartUploader", "putImage"]) {
    assert.equal(adapter[method], undefined, `adapter must not expose ${method}()`);
  }
  assert.deepEqual(Object.keys(adapter).sort(), ["objectExists", "readObject"]);
});

// ═══════════════════════════════════════════════════════════════════════
// 14. STRUCTURAL: real SDK import, never a real request
// ═══════════════════════════════════════════════════════════════════════

test("structural: production adapter imports the real @vercel/blob package; construction with a fake client performs no I/O", async () => {
  const mod = await import("../lib/selective-corpus/vercel-blob-storage-adapter.ts");
  assert.equal(typeof mod.createVercelBlobStorageAdapter, "function");
  const adapter = mod.createVercelBlobStorageAdapter({ prefix: PREFIX, client: createFakeVercelBlobReadClient({}) });
  assert.equal(typeof adapter.readObject, "function");
  assert.equal(typeof adapter.objectExists, "function");
});

// ═══════════════════════════════════════════════════════════════════════
// 13. END-TO-END STORAGE MODE TESTS (fake Blob SDK only)
// ═══════════════════════════════════════════════════════════════════════

const SHARD_QUERY_TEXT = Array.from(
  { length: 640 },
  (_, i) => `term${(i * 2654435761) % 1009}x${(i * 40503) % 251}`,
).join(" ");

function writeMinimalSelectiveCorpusArtifact(dir) {
  mkdirSync(join(dir, "packed"), { recursive: true });
  writeFileSync(
    join(dir, "corpus-version.json"),
    JSON.stringify({
      corpusVersion: "selective-corpus-v1",
      corpusIdentityDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
      fingerprintVersion: "selective-corpus-fp-w15-s5-v1",
      winnowWindow: 15,
      shingleSize: 5,
      stopPolicy: "global DF>=13",
      documentCount: 1,
    }),
  );
  writeFileSync(join(dir, "packed", "docmap.tsv"), "0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.alloc(0));
  for (let s = 0; s < 256; s++) {
    writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  }
}

function buildFullManifestEntriesFromDir(dir) {
  const entries = [];
  for (let s = 0; s < 256; s++) {
    const key = shardKeyFor(s);
    const bytes = readFileSync(join(dir, key));
    entries.push({ key, bytes });
  }
  return entries;
}

test("e2e A+B+C: Blob mode loads corpus-version.json/object-integrity.json/docmap.tsv/stopset.bin/shard-000 with ZERO eager shard-001..255 GET/HEAD calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-blob-coldstart-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  const manifestBytes = buildManifestBytes(buildFullManifestEntriesFromDir(dir));
  const client = createBackedFakeVercelBlobReadClient(dir, PREFIX, {
    "object-integrity.json": { bytesOverride: manifestBytes },
  });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  clearSelectiveCorpusArtifactCache();

  const artifact = await loadSelectiveCorpusArtifact(`vercel-blob-e2e-cold:${PREFIX}`, {
    storageAdapter: adapter,
    integrityMode: "integrity-required",
  });
  assert.ok(artifact.integrity, "A: artifact loaded with a manifest");
  assert.equal(client.getCallCount("corpus-version.json"), 1, "A: corpus-version.json read");
  assert.equal(client.getCallCount("object-integrity.json"), 1, "A: object-integrity.json read");
  assert.equal(client.getCallCount("packed/docmap.tsv"), 1, "A: docmap.tsv read");
  assert.equal(client.getCallCount("packed/stopset.bin"), 1, "A: stopset.bin read");
  assert.equal(client.getCallCount(shardKeyFor(0)), 1, "A: shard-000 smoke read");
  assert.equal(client.headCallCount(shardKeyFor(0)), 0, "shard-000 needs no HEAD -- covered by the manifest inventory check");

  for (let s = 1; s < 256; s++) {
    assert.equal(client.getCallCount(shardKeyFor(s)), 0, `B: shard ${s} zero GET calls during initialization`);
    assert.equal(client.headCallCount(shardKeyFor(s)), 0, `C: shard ${s} zero HEAD calls during initialization`);
  }
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("e2e E: query-time missing shard (Blob mode) => evaluation PARTIAL, zero evidence from that shard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-blob-qtime-missing-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  const manifestBytes = buildManifestBytes(buildFullManifestEntriesFromDir(dir));
  const overrides = { "object-integrity.json": { bytesOverride: manifestBytes } };
  for (let s = 1; s < 256; s++) overrides[shardKeyFor(s)] = { missing: true }; // shard-000 stays readable (smoke read)
  const client = createBackedFakeVercelBlobReadClient(dir, PREFIX, overrides);
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  clearSelectiveCorpusArtifactCache();

  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true" }, async () => {
    const artifact = await loadSelectiveCorpusArtifact(`vercel-blob-e2e-missing:${PREFIX}`, {
      storageAdapter: adapter,
      integrityMode: "integrity-required",
    });
    const authoritative = { unifiedScore: 12, matchedPositions: [1, 2, 3] };
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative, artifactOverride: artifact });
    assert.equal(r.state, "PARTIAL");
    assert.ok((r.degradedShardCount ?? 0) >= 1);
    assert.ok((r.degradedShardCodes?.MISSING ?? 0) >= 1);
    assert.equal(r.authoritativeUnifiedSimilarity, 12, "authoritative score untouched");
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("e2e F: query-time integrity mismatch (Blob mode) => evaluation PARTIAL, zero evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-blob-qtime-mismatch-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  const manifestBytes = buildManifestBytes(buildFullManifestEntriesFromDir(dir)); // manifest reflects the ORIGINAL 4-byte shards
  const overrides = { "object-integrity.json": { bytesOverride: manifestBytes } };
  for (let s = 1; s < 256; s++) overrides[shardKeyFor(s)] = { bytesOverride: Buffer.alloc(8) }; // served bytes now mismatch the manifest
  const client = createBackedFakeVercelBlobReadClient(dir, PREFIX, overrides);
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  clearSelectiveCorpusArtifactCache();

  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true" }, async () => {
    const artifact = await loadSelectiveCorpusArtifact(`vercel-blob-e2e-mismatch:${PREFIX}`, {
      storageAdapter: adapter,
      integrityMode: "integrity-required",
    });
    const authoritative = { unifiedScore: 7, matchedPositions: [] };
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative, artifactOverride: artifact });
    assert.equal(r.state, "PARTIAL");
    assert.ok((r.degradedShardCodes?.INTEGRITY_MISMATCH ?? 0) >= 1);
    assert.equal(r.authoritativeUnifiedSimilarity, 7);
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("e2e G: transient shard failure through the Blob adapter degrades THIS read; the existing cooldown allows a later successful retry", async () => {
  const hash = "23" + "00".repeat(7); // shard 0x23 = 35
  const shardBytes = encodeShardBytes([{ hash, ordinals: [1, 2] }]);
  const pathname = `${PREFIX}/${shardKeyFor(35)}`;
  const client = createFakeVercelBlobReadClient({
    objects: { [pathname]: { bytes: shardBytes, transientGetFailuresBeforeSuccess: 1 } },
  });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  let clockMs = 0;
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { now: () => clockMs, transientRetryCooldownMs: 100 });

  const c1 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings(hash, c1), undefined, "degraded THIS read");
  assert.equal(c1.getFailures()[0].code, "TRANSIENT");
  assert.equal(client.getCallCount(pathname), 1, "no hot loop before cooldown expiry");

  const c2 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings(hash, c2), undefined, "still within cooldown");
  assert.equal(client.getCallCount(pathname), 1);

  clockMs = 200; // past the injected cooldown
  const c3 = createSelectiveCorpusFailureCollector();
  const r3 = await reader.getPostings(hash, c3);
  assert.deepEqual([...r3], [1, 2], "retry after cooldown succeeds");
  assert.equal(c3.getFailures().length, 0);
});

test("e2e H: missing source object through the Blob adapter => candidate skipped, zero evidence", async () => {
  clearSelectiveCorpusSourceCache();
  const client = createFakeVercelBlobReadClient({ objects: {} });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  const doc = { ordinal: 0, sourceId: "s0", family: "A_wikipedia", rawId: "bulk:missing", wordCount: 9, interpretationLabel: "ORDINARY_REFERENCE" };
  const artifact = { artifactPath: "blob-source-missing-test", storage: adapter, docByOrdinal: [doc] };
  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result, null);
  clearSelectiveCorpusSourceCache();
});

test("e2e H2: corrupt (integrity-mismatched) source object through the Blob adapter => candidate skipped, zero evidence", async () => {
  clearSelectiveCorpusSourceCache();
  const text = "some candidate text nobody may trust unless independently verified";
  const bytes = Buffer.from(text, "utf8");
  const key = "raw/docX.txt";
  const pathname = `${PREFIX}/${key}`;
  const integrity = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key, bytes, sha256Override: "9".repeat(64) }]));
  const client = createFakeVercelBlobReadClient({ objects: { [pathname]: { bytes } } });
  const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
  const doc = { ordinal: 0, sourceId: "s0", family: "A_wikipedia", rawId: "bulk:docX", wordCount: 9, interpretationLabel: "ORDINARY_REFERENCE" };
  const artifact = { artifactPath: "blob-source-mismatch-test", storage: adapter, integrity, docByOrdinal: [doc] };
  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result, null);
  clearSelectiveCorpusSourceCache();
});

const REAL_ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
const realArtifactPresent = (() => {
  try {
    return statSync(join(REAL_ARTIFACT, "corpus-version.json")).isFile();
  } catch {
    return false;
  }
})();
let cachedRealManifestEntries = null;
function getFullManifestEntriesForRealArtifact() {
  if (!cachedRealManifestEntries) cachedRealManifestEntries = buildFullManifestEntriesFromDir(REAL_ARTIFACT);
  return cachedRealManifestEntries;
}

test(
  "e2e D+I: Blob-mode artifact produces IDENTICAL shadow results to the local artifact for a real submission -- proves query-time shard/source reads work end-to-end and the authoritative score is untouched",
  { skip: !realArtifactPresent },
  async () => {
    await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true" }, async () => {
      const sub = readFileSync(join(REAL_ARTIFACT, "raw", "A-000010.txt"), "utf8");
      const authoritative = { unifiedScore: 8, matchedPositions: [10, 11, 12] };

      clearSelectiveCorpusArtifactCache();
      // this equivalence test deliberately exercises the OLDER fixture-inclusive
      // dev/regression artifact -- content-agnostic to the production digest.
      const artifactLocal = await loadSelectiveCorpusArtifact(REAL_ARTIFACT, { expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST });

      // Discover exactly which raw/<id>.txt source-text objects THIS
      // submission's candidates will need, so the manifest covers them too --
      // integrity-required mode fails closed (UNKNOWN_ENTRY) for ANY object
      // read without a manifest entry, source text included, not just shards.
      const probeStageA = await selectiveCorpusStageA(sub, artifactLocal);
      const touchedRawIds = probeStageA.topK
        .map((c) => artifactLocal.docByOrdinal[c.ordinal]?.rawId)
        .filter((id) => typeof id === "string" && id.startsWith("bulk:"))
        .map((id) => id.slice(5));
      const manifestEntries = [...getFullManifestEntriesForRealArtifact()];
      for (const id of touchedRawIds) {
        const key = `raw/${id}.txt`;
        let bytes;
        try {
          bytes = readFileSync(join(REAL_ARTIFACT, key));
        } catch {
          continue;
        }
        manifestEntries.push({ key, bytes });
      }
      const manifestBytes = buildManifestBytes(manifestEntries);
      const client = createBackedFakeVercelBlobReadClient(REAL_ARTIFACT, PREFIX, {
        "object-integrity.json": { bytesOverride: manifestBytes },
      });
      const adapter = createVercelBlobStorageAdapter({ prefix: PREFIX, client });
      const artifactBlob = await loadSelectiveCorpusArtifact(`vercel-blob-e2e-di:${PREFIX}`, {
        storageAdapter: adapter,
        integrityMode: "integrity-required",
        expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST,
      });

      const resultLocal = await runSelectiveCorpusShadow({ canonicalSubmissionText: sub, authoritative, artifactOverride: artifactLocal });
      const resultBlob = await runSelectiveCorpusShadow({ canonicalSubmissionText: sub, authoritative, artifactOverride: artifactBlob });

      assert.equal(resultBlob.state, resultLocal.state);
      assert.equal(resultBlob.candidateCount, resultLocal.candidateCount);
      assert.deepEqual(resultBlob.topCandidateRanks, resultLocal.topCandidateRanks);
      assert.equal(resultBlob.verifiedSourceCount, resultLocal.verifiedSourceCount);
      assert.equal(resultBlob.matchedPositionCount, resultLocal.matchedPositionCount);
      assert.equal(resultBlob.counterfactualUnifiedSimilarity, resultLocal.counterfactualUnifiedSimilarity);
      assert.equal(resultBlob.familyGuardActivations, resultLocal.familyGuardActivations);
      assert.equal(resultBlob.coSourceAttributionActivations, resultLocal.coSourceAttributionActivations);
      // I: authoritative score isolation -- untouched, identical, on both paths
      assert.equal(resultLocal.authoritativeUnifiedSimilarity, authoritative.unifiedScore);
      assert.equal(resultBlob.authoritativeUnifiedSimilarity, authoritative.unifiedScore);
    });
  },
);

test("e2e J: unconfigured storage mode (SELECTIVE_CORPUS_STORAGE_MODE unset) continues using the existing local adapter behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-blob-localregress-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv(
    {
      SELECTIVE_CORPUS_SHADOW_ENABLED: "true",
      SELECTIVE_CORPUS_ARTIFACT_PATH: dir,
      SELECTIVE_CORPUS_STORAGE_MODE: undefined,
      SELECTIVE_CORPUS_BLOB_PREFIX: undefined,
    },
    async () => {
      assert.equal(getSelectiveCorpusStorageMode(), "local");
      const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: { unifiedScore: 5, matchedPositions: [] } });
      assert.equal(r.state, "COMPLETED");
    },
  );
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("wiring: vercel-blob mode selected but SELECTIVE_CORPUS_BLOB_PREFIX unset => ARTIFACT_UNAVAILABLE, fails closed, never falls back to local storage", async () => {
  clearSelectiveCorpusArtifactCache();
  await withEnv(
    {
      SELECTIVE_CORPUS_SHADOW_ENABLED: "true",
      SELECTIVE_CORPUS_STORAGE_MODE: "vercel-blob",
      SELECTIVE_CORPUS_BLOB_PREFIX: undefined,
      // a bogus local path proves there is no silent fallback to local mode:
      // if there were, this path (never read) would surface a DIFFERENT
      // failureCode/message than the expected missing-prefix one below.
      SELECTIVE_CORPUS_ARTIFACT_PATH: "/should/never/be/read",
    },
    async () => {
      const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: null });
      assert.equal(r.state, "ARTIFACT_UNAVAILABLE");
      assert.equal(r.failureCode, "MISSING");
      assert.match(r.failureMessage, /SELECTIVE_CORPUS_BLOB_PREFIX/);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 15. SECURITY REVIEW (structural)
// ═══════════════════════════════════════════════════════════════════════

function listFilesRecursive(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const ADAPTER_FILE = join("lib", "selective-corpus", "vercel-blob-storage-adapter.ts");
const REPO_ROOT = process.cwd();

test("security: @vercel/blob is imported ONLY by the one server-side adapter file (never a client component, never an API route)", () => {
  const files = [
    ...listFilesRecursive(join(REPO_ROOT, "app"), [".ts", ".tsx"]),
    ...listFilesRecursive(join(REPO_ROOT, "components"), [".ts", ".tsx"]),
    ...listFilesRecursive(join(REPO_ROOT, "lib"), [".ts", ".tsx"]),
  ];
  const importers = files.filter((f) => readFileSync(f, "utf8").includes("@vercel/blob"));
  const relPaths = importers.map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"));
  assert.deepEqual(relPaths, [ADAPTER_FILE.replace(/\\/g, "/")], "no other file may import @vercel/blob");
});

test("security: createVercelBlobStorageAdapter is called ONLY from the shadow orchestrator, never with a user/manuscript-derived prefix", () => {
  const files = listFilesRecursive(join(REPO_ROOT, "lib"), [".ts"]);
  const callers = files.filter((f) => readFileSync(f, "utf8").includes("createVercelBlobStorageAdapter("));
  const relPaths = callers.map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/")).sort();
  assert.deepEqual(relPaths, [ADAPTER_FILE.replace(/\\/g, "/"), "lib/selective-corpus/shadow.ts"].sort());
  const shadowSrc = readFileSync(join(REPO_ROOT, "lib", "selective-corpus", "shadow.ts"), "utf8");
  assert.match(shadowSrc, /createVercelBlobStorageAdapter\(\{\s*prefix\s*\}\)/, "prefix comes only from getSelectiveCorpusBlobPrefix(), never request/user data");
});

test("security: no app/ route exposes a Blob list/browse/enumeration capability", () => {
  const files = listFilesRecursive(join(REPO_ROOT, "app"), [".ts", ".tsx"]);
  const offenders = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /from ["']@vercel\/blob["']/.test(src) || /\blist\s*\(\s*\{[^}]*prefix/.test(src);
  });
  assert.deepEqual(offenders, []);
});

test("security: the adapter module never generates a signed/presigned/download URL and never calls fetch() directly", () => {
  const src = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  for (const forbidden of ["presignUrl", "issueSignedToken", "getDownloadUrl", "fetch("]) {
    assert.ok(!src.includes(forbidden), `adapter must not use ${forbidden}`);
  }
});

test("security: the adapter module logs nothing and exposes only readObject/objectExists (no write op, no console output)", () => {
  const src = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  assert.ok(!/console\.(log|error|warn|info|debug)/.test(src), "no logging in the adapter");
  for (const forbidden of ["put(", "upload(", "del(", " copy(", "rename(", "createMultipartUpload"]) {
    assert.ok(!src.includes(forbidden), `adapter source must not reference ${forbidden}`);
  }
});
