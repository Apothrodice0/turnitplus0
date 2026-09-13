import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadSelectiveCorpusArtifact,
  SelectiveCorpusArtifactError,
  clearSelectiveCorpusArtifactCache,
} from "../lib/selective-corpus/artifact.ts";
import { runSelectiveCorpusShadow } from "../lib/selective-corpus/shadow.ts";
import { selectiveCorpusStageA } from "../lib/selective-corpus/stage-a.ts";
import { loadSelectiveCorpusCandidateText, clearSelectiveCorpusSourceCache } from "../lib/selective-corpus/source-loader.ts";
import { SelectiveCorpusShardReader, createSelectiveCorpusFailureCollector } from "../lib/selective-corpus/shard-reader.ts";
import { createLocalFilesystemStorageAdapter } from "../lib/selective-corpus/storage-adapter.ts";
import {
  parseSelectiveCorpusIntegrityManifest,
  verifySelectiveCorpusObjectIntegrity,
  SelectiveCorpusIntegrityManifestError,
  SelectiveCorpusIntegrityMismatchError,
} from "../lib/selective-corpus/integrity.ts";
import { createSimulatedRemoteStorageAdapter } from "../lib/selective-corpus/testing/simulated-remote-storage-adapter.ts";
import { winnowSubmissionFingerprints } from "../lib/selective-corpus/fingerprint.ts";
import {
  SELECTIVE_CORPUS_EXPECTED_DIGEST,
  SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST,
  SELECTIVE_CORPUS_STAGE_A_SHARD_FETCH_CONCURRENCY,
  SELECTIVE_CORPUS_STAGE_A_TOP_K,
  SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS,
  SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES,
  SELECTIVE_CORPUS_TIME_BUDGET_MS,
  SELECTIVE_CORPUS_HOT_SHARD_LRU,
} from "../lib/selective-corpus/constants.ts";

/**
 * SELECTIVE CORPUS SIMULATED REMOTE STORAGE + INTEGRITY VERIFICATION.
 *
 * NO real network, NO vendor SDK, NO real credentials anywhere in this file.
 * lib/selective-corpus/testing/simulated-remote-storage-adapter.ts is an
 * in-memory / local-fixture-backed simulation of remote-like async storage
 * semantics (latency, one-shot transient failure, persistent failure,
 * per-key call counting) implementing the SAME SelectiveCorpusStorageAdapter
 * interface as the local-filesystem adapter — never a second, divergent
 * storage concept.
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

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Test/fixture-only manifest builder — computes real sha256/byteLength via
 *  Node's own crypto (no Python, no external tool), with optional overrides
 *  to deliberately construct a wrong-digest / wrong-byteLength manifest. */
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

/** Hand-encodes one well-formed packed shard file (same binary format
 *  shard-reader.ts's decodeShard() expects): [4B entryCount LE] then per
 *  entry [8B hash BE][varint postingCount][delta-varint doc ordinals asc]. */
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

function shardKeyFor(shardNumber) {
  return `packed/shard-${String(shardNumber).padStart(3, "0")}.bin`;
}

/** Test-only call-counting wrapper around a real SelectiveCorpusStorageAdapter
 *  -- delegates every call to `inner` unchanged, but records exact per-key
 *  readObject()/objectExists() invocation counts so cold-start request-count
 *  assertions (e.g. "zero calls for shard-001..255 in integrity-required
 *  mode") do not have to guess at internals. */
function createCountingAdapter(inner) {
  const readObjectCalls = new Map();
  const objectExistsCalls = new Map();
  return {
    async readObject(key) {
      readObjectCalls.set(key, (readObjectCalls.get(key) ?? 0) + 1);
      return inner.readObject(key);
    },
    async objectExists(key) {
      objectExistsCalls.set(key, (objectExistsCalls.get(key) ?? 0) + 1);
      return inner.objectExists(key);
    },
    readObjectCallCount(key) {
      return readObjectCalls.get(key) ?? 0;
    },
    objectExistsCallCount(key) {
      return objectExistsCalls.get(key) ?? 0;
    },
    totalReadObjectCalls() {
      return [...readObjectCalls.values()].reduce((a, b) => a + b, 0);
    },
    totalObjectExistsCalls() {
      return [...objectExistsCalls.values()].reduce((a, b) => a + b, 0);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 9. SHARD TESTS
// ═══════════════════════════════════════════════════════════════════════

test("shard A: valid shard bytes + correct integrity manifest => normal postings result", async () => {
  const hash = "5a" + "00".repeat(7); // shard 0x5a = 90
  const shardBytes = encodeShardBytes([{ hash, ordinals: [7, 9] }]);
  const key = shardKeyFor(90);
  const integrity = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key, bytes: shardBytes }]));
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes: shardBytes } } });
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { integrity });

  const postings = await reader.getPostings(hash);
  assert.deepEqual([...postings], [7, 9]);
  assert.equal(reader.getStats().shardLoadFailures, 0);
});

test("shard B: valid shard bytes + wrong sha256 in manifest => INTEGRITY_MISMATCH, PARTIAL-style degradation, zero evidence", async () => {
  const hash = "5b" + "00".repeat(7); // shard 91
  const shardBytes = encodeShardBytes([{ hash, ordinals: [3] }]);
  const key = shardKeyFor(91);
  const integrity = parseSelectiveCorpusIntegrityManifest(
    buildManifestBytes([{ key, bytes: shardBytes, sha256Override: "0".repeat(64) }]),
  );
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes: shardBytes } } });
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { integrity });

  const collector = createSelectiveCorpusFailureCollector();
  const postings = await reader.getPostings(hash, collector);
  assert.equal(postings, undefined, "zero evidence from a shard that failed integrity verification");
  const failures = collector.getFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].shard, 91);
  assert.equal(failures[0].code, "INTEGRITY_MISMATCH");
});

test("shard C: valid shard bytes + wrong byteLength in manifest => INTEGRITY_MISMATCH, zero evidence", async () => {
  const hash = "5c" + "00".repeat(7); // shard 92
  const shardBytes = encodeShardBytes([{ hash, ordinals: [4, 5] }]);
  const key = shardKeyFor(92);
  const integrity = parseSelectiveCorpusIntegrityManifest(
    buildManifestBytes([{ key, bytes: shardBytes, byteLengthOverride: shardBytes.length + 5 }]),
  );
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes: shardBytes } } });
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { integrity });

  const collector = createSelectiveCorpusFailureCollector();
  const postings = await reader.getPostings(hash, collector);
  assert.equal(postings, undefined);
  assert.equal(collector.getFailures()[0].code, "INTEGRITY_MISMATCH");
});

test("shard D: structurally-corrupt bytes that integrity-match their OWN manifest entry still fail closed as CORRUPT at decode time", async () => {
  const garbage = Buffer.from([9, 9]); // too short for even the 4-byte header
  const key = shardKeyFor(93);
  const integrity = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key, bytes: garbage }]));
  // sanity: integrity verification ALONE does not throw for these bytes --
  // the manifest was built from these exact (garbage) bytes.
  assert.doesNotThrow(() => verifySelectiveCorpusObjectIntegrity(key, garbage, integrity));

  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes: garbage } } });
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { integrity });
  const collector = createSelectiveCorpusFailureCollector();
  const postings = await reader.getPostings("5d" + "00".repeat(7), collector); // shard 93
  assert.equal(postings, undefined);
  assert.equal(collector.getFailures()[0].code, "CORRUPT", "integrity passing does not bypass structural decode validation");
});

test("shard E: transient failure => degrades THIS call, concurrent callers share one failing read, no hot-loop before cooldown, retry succeeds after cooldown", async () => {
  const hash = "5e" + "00".repeat(7); // shard 94
  const shardBytes = encodeShardBytes([{ hash, ordinals: [42] }]);
  const key = shardKeyFor(94);
  const adapter = createSimulatedRemoteStorageAdapter({
    objects: { [key]: { bytes: shardBytes, transientFailuresBeforeSuccess: 1 } },
  });
  let clockMs = 0;
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { now: () => clockMs, transientRetryCooldownMs: 100 });

  // concurrent callers during the SAME failed attempt share one physical read
  const c1 = createSelectiveCorpusFailureCollector();
  const c2 = createSelectiveCorpusFailureCollector();
  const [r1, r2] = await Promise.all([reader.getPostings(hash, c1), reader.getPostings(hash, c2)]);
  assert.equal(r1, undefined);
  assert.equal(r2, undefined);
  assert.equal(adapter.callCount(key), 1, "one physical attempt for the concurrent failing batch");
  assert.equal(c1.getFailures()[0].code, "TRANSIENT");
  assert.equal(c2.getFailures()[0].code, "TRANSIENT");

  // before cooldown expiry: no hot loop back to storage
  const c3 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings(hash, c3), undefined);
  assert.equal(adapter.callCount(key), 1, "still exactly one physical attempt -- no hot loop before cooldown expiry");
  assert.equal(c3.getFailures()[0].code, "TRANSIENT");

  // after cooldown expiry: retry occurs, and the (now one-shot-recovered) backend succeeds
  clockMs = 1000;
  const c4 = createSelectiveCorpusFailureCollector();
  const r4 = await reader.getPostings(hash, c4);
  assert.deepEqual([...r4], [42]);
  assert.equal(c4.getFailures().length, 0, "no failure recorded for a call that succeeded after the cooldown");
  assert.equal(adapter.callCount(key), 2, "exactly one retry attempt after cooldown expiry");
});

test("shard F: persistent NOT_FOUND fails closed and is remembered without repeated physical reads", async () => {
  const adapter = createSimulatedRemoteStorageAdapter({ objects: {} }); // never registered => always NotFound
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8);
  const hash = "5f" + "00".repeat(7); // shard 95
  const key = shardKeyFor(95);

  const c1 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings(hash, c1), undefined);
  assert.equal(c1.getFailures()[0].code, "MISSING");
  assert.equal(adapter.callCount(key), 1);

  // repeated evaluations keep failing closed WITHOUT a new physical read --
  // persistent failures are remembered for the reader's lifetime, unlike TRANSIENT.
  const c2 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings(hash, c2), undefined);
  assert.equal(c2.getFailures()[0].code, "MISSING");
  assert.equal(adapter.callCount(key), 1, "no repeated physical read for a remembered persistent failure");
});

test("shard G: two concurrent evaluations sharing one transient failing shard both independently learn of the degradation; one physical attempt; deterministic retry", async () => {
  const hash = "60" + "00".repeat(7); // shard 96
  const shardBytes = encodeShardBytes([{ hash, ordinals: [11, 22] }]);
  const key = shardKeyFor(96);
  const adapter = createSimulatedRemoteStorageAdapter({
    objects: { [key]: { bytes: shardBytes, transientFailuresBeforeSuccess: 1, delayMs: 5 } },
  });
  let clockMs = 0;
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 8, { now: () => clockMs, transientRetryCooldownMs: 50 });

  const evalX = createSelectiveCorpusFailureCollector();
  const evalY = createSelectiveCorpusFailureCollector();
  const [rx, ry] = await Promise.all([reader.getPostings(hash, evalX), reader.getPostings(hash, evalY)]);
  assert.equal(rx, undefined);
  assert.equal(ry, undefined);
  assert.equal(adapter.callCount(key), 1, "one physical attempt shared by both concurrently-overlapping evaluations");
  assert.equal(evalX.getFailures()[0].code, "TRANSIENT");
  assert.equal(evalY.getFailures()[0].code, "TRANSIENT");
  assert.equal(evalX.getFailures()[0].observations, 1, "each evaluation's collector saw only its own call");
  assert.equal(evalY.getFailures()[0].observations, 1);

  clockMs = 100; // past cooldown
  const evalZ = createSelectiveCorpusFailureCollector();
  const rz = await reader.getPostings(hash, evalZ);
  assert.deepEqual([...rz], [11, 22]);
  assert.equal(evalZ.getFailures().length, 0);

  // the two earlier evaluations' own records are unaffected by the later, successful retry
  assert.equal(evalX.getFailures().length, 1);
  assert.equal(evalY.getFailures().length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 10. SOURCE-TEXT TESTS
// ═══════════════════════════════════════════════════════════════════════

function minimalDoc(rawId) {
  return { ordinal: 0, sourceId: "s0", family: "A_wikipedia", rawId, wordCount: 9, interpretationLabel: "ORDINARY_REFERENCE" };
}

test("source A: valid source text + correct integrity hash => verification proceeds, text loads normally", async () => {
  clearSelectiveCorpusSourceCache();
  const text = "the quick brown fox jumps over the lazy dog";
  const bytes = Buffer.from(text, "utf8");
  const key = "raw/docA.txt";
  const integrity = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key, bytes }]));
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes } } });
  const artifact = { artifactPath: "source-test-A", storage: adapter, integrity, docByOrdinal: [minimalDoc("bulk:docA")] };

  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result.text, text);
  clearSelectiveCorpusSourceCache();
});

test("source B: wrong source sha256 => source rejected, candidate skipped, zero evidence", async () => {
  clearSelectiveCorpusSourceCache();
  const text = "an example candidate text that must never be trusted unverified";
  const bytes = Buffer.from(text, "utf8");
  const key = "raw/docB.txt";
  const integrity = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key, bytes, sha256Override: "1".repeat(64) }]));
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes } } });
  const artifact = { artifactPath: "source-test-B", storage: adapter, integrity, docByOrdinal: [minimalDoc("bulk:docB")] };

  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result, null, "candidate skipped -- never manufacture similarity from an unverified source");
  clearSelectiveCorpusSourceCache();
});

test("source C: wrong byteLength => rejected, candidate skipped", async () => {
  clearSelectiveCorpusSourceCache();
  const text = "another candidate text body for the byte length mismatch case";
  const bytes = Buffer.from(text, "utf8");
  const key = "raw/docC.txt";
  const integrity = parseSelectiveCorpusIntegrityManifest(
    buildManifestBytes([{ key, bytes, byteLengthOverride: bytes.length + 1 }]),
  );
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes } } });
  const artifact = { artifactPath: "source-test-C", storage: adapter, integrity, docByOrdinal: [minimalDoc("bulk:docC")] };

  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result, null);
  clearSelectiveCorpusSourceCache();
});

test("source D: transient source read failure cannot be verified THIS call; no permanent poison; succeeds once the backend heals", async () => {
  clearSelectiveCorpusSourceCache();
  const text = "a candidate source body for the transient source read test";
  const bytes = Buffer.from(text, "utf8");
  const key = "raw/docD.txt";
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes, transientFailuresBeforeSuccess: 1 } } });
  const artifact = { artifactPath: "source-test-D", storage: adapter, docByOrdinal: [minimalDoc("bulk:docD")] };

  const first = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(first, null, "this evaluation cannot verify the candidate from a transiently-failing source");
  const second = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(second.text, text, "a later call succeeds once the simulated backend heals -- no permanent poison");
  clearSelectiveCorpusSourceCache();
});

test("source E: missing source object => existing null/skip semantics preserved", async () => {
  clearSelectiveCorpusSourceCache();
  const adapter = createSimulatedRemoteStorageAdapter({ objects: {} });
  const artifact = { artifactPath: "source-test-E", storage: adapter, docByOrdinal: [minimalDoc("bulk:missing")] };

  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result, null);
  clearSelectiveCorpusSourceCache();
});

test("source F: concurrent same-source remote-like reads still dedupe to one physical attempt", async () => {
  clearSelectiveCorpusSourceCache();
  const text = "concurrent dedup candidate source text body";
  const bytes = Buffer.from(text, "utf8");
  const key = "raw/docF.txt";
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { [key]: { bytes, delayMs: 10 } } });
  const artifact = { artifactPath: "source-test-F", storage: adapter, docByOrdinal: [minimalDoc("bulk:docF")] };

  const [r1, r2] = await Promise.all([loadSelectiveCorpusCandidateText(artifact, 0), loadSelectiveCorpusCandidateText(artifact, 0)]);
  assert.equal(r1.text, text);
  assert.equal(r2.text, text);
  assert.equal(adapter.callCount(key), 1, "exactly one physical read for the concurrent batch");
  clearSelectiveCorpusSourceCache();
});

// ═══════════════════════════════════════════════════════════════════════
// 11. ARTIFACT / INTEGRITY MANIFEST TESTS
// ═══════════════════════════════════════════════════════════════════════

test("integrity manifest: malformed JSON is rejected", () => {
  assert.throws(
    () => parseSelectiveCorpusIntegrityManifest(Buffer.from("{ not json")),
    (e) => e instanceof SelectiveCorpusIntegrityManifestError && e.code === "MALFORMED_JSON",
  );
});

test("integrity manifest: wrong top-level shape is rejected", () => {
  assert.throws(
    () => parseSelectiveCorpusIntegrityManifest(Buffer.from(JSON.stringify({ notObjects: [] }))),
    (e) => e instanceof SelectiveCorpusIntegrityManifestError && e.code === "MALFORMED_SHAPE",
  );
});

test("integrity manifest: duplicate object key is rejected", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      objects: [
        { key: "packed/shard-000.bin", sha256: "a".repeat(64), byteLength: 4 },
        { key: "packed/shard-000.bin", sha256: "b".repeat(64), byteLength: 4 },
      ],
    }),
  );
  assert.throws(
    () => parseSelectiveCorpusIntegrityManifest(bytes),
    (e) => e instanceof SelectiveCorpusIntegrityManifestError && e.code === "DUPLICATE_KEY",
  );
});

test("integrity manifest: malformed digest is rejected", () => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, objects: [{ key: "packed/shard-000.bin", sha256: "not-hex", byteLength: 4 }] }));
  assert.throws(
    () => parseSelectiveCorpusIntegrityManifest(bytes),
    (e) => e instanceof SelectiveCorpusIntegrityManifestError && e.code === "BAD_DIGEST",
  );
});

test("integrity manifest: negative/malformed byteLength is rejected", () => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, objects: [{ key: "packed/shard-000.bin", sha256: "a".repeat(64), byteLength: -1 }] }));
  assert.throws(
    () => parseSelectiveCorpusIntegrityManifest(bytes),
    (e) => e instanceof SelectiveCorpusIntegrityManifestError && e.code === "BAD_BYTE_LENGTH",
  );
});

test("integrity manifest: non-artifact-relative key is rejected", () => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, objects: [{ key: "../escape.bin", sha256: "a".repeat(64), byteLength: 4 }] }));
  assert.throws(
    () => parseSelectiveCorpusIntegrityManifest(bytes),
    (e) => e instanceof SelectiveCorpusIntegrityManifestError && e.code === "BAD_KEY",
  );
});

test("integrity manifest: an object with no manifest entry fails closed as UNKNOWN_ENTRY at verification time", () => {
  const manifest = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key: "packed/shard-000.bin", bytes: Buffer.alloc(4) }]));
  assert.throws(
    () => verifySelectiveCorpusObjectIntegrity("packed/shard-099.bin", Buffer.alloc(4), manifest),
    (e) => e instanceof SelectiveCorpusIntegrityMismatchError && e.reason === "UNKNOWN_ENTRY",
  );
});

function writeFullLocalArtifact(dir, { withManifest = false, excludeShards = [], excludeControlEntries = [] } = {}) {
  mkdirSync(join(dir, "packed"), { recursive: true });
  const corpusVersionBytes = Buffer.from(
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
  writeFileSync(join(dir, "corpus-version.json"), corpusVersionBytes);
  const docmapBytes = Buffer.from("0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "docmap.tsv"), docmapBytes);
  const stopsetBytes = Buffer.alloc(0);
  writeFileSync(join(dir, "packed", "stopset.bin"), stopsetBytes);
  // The 3 control/meta objects MUST be integrity-protected too (see
  // lib/selective-corpus/artifact.ts's trust-order fix) -- included here by
  // default so every existing test fixture reflects the real, established
  // package contract; `excludeControlEntries` lets a test deliberately omit
  // one to prove the loader fails closed on a missing manifest entry.
  const controlEntries = [
    { key: "corpus-version.json", bytes: corpusVersionBytes },
    { key: "packed/docmap.tsv", bytes: docmapBytes },
    { key: "packed/stopset.bin", bytes: stopsetBytes },
  ].filter((e) => !excludeControlEntries.includes(e.key));
  const entries = [...controlEntries];
  for (let s = 0; s < 256; s++) {
    const bytes = Buffer.alloc(4);
    const key = shardKeyFor(s);
    writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), bytes);
    if (!excludeShards.includes(s)) entries.push({ key, bytes });
  }
  if (withManifest) {
    writeFileSync(join(dir, "object-integrity.json"), buildManifestBytes(entries));
  }
}

test("integrity-required mode: missing object-integrity.json => artifact unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-missing-manifest-"));
  writeFullLocalArtifact(dir, { withManifest: false });
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "INTEGRITY_MANIFEST_INVALID",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("integrity-required mode: malformed object-integrity.json => artifact unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-malformed-manifest-"));
  writeFullLocalArtifact(dir, { withManifest: false });
  writeFileSync(join(dir, "object-integrity.json"), "{ not json");
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "INTEGRITY_MANIFEST_INVALID",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("local-compatible mode (default) does NOT require a manifest -- existing behavior preserved, artifact.integrity is undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-localcompat-"));
  writeFullLocalArtifact(dir, { withManifest: false });
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir); // no integrityMode given at all
  assert.equal(artifact.integrity, undefined);
  rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 13. REMOTE COLD-START REQUEST HARDENING (integrity manifest as structural
//     inventory instead of eager per-shard objectExists()).
// ═══════════════════════════════════════════════════════════════════════

// Required test A + F: full manifest inventory => initialization succeeds
// with ZERO eager storage calls for shard-001..255, and exactly one real
// smoke read (no objectExists) for shard-000.
test("integrity-required mode: manifest covers all 256 shards => init succeeds, zero readObject/objectExists calls for shard-001..255, one smoke read for shard-000", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-full-manifest-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  const counting = createCountingAdapter(createLocalFilesystemStorageAdapter(dir));
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir, { storageAdapter: counting, integrityMode: "integrity-required" });
  assert.ok(artifact.integrity);

  for (let s = 1; s < 256; s++) {
    const key = shardKeyFor(s);
    assert.equal(counting.readObjectCallCount(key), 0, `shard ${s}: zero readObject calls during initialization`);
    assert.equal(counting.objectExistsCallCount(key), 0, `shard ${s}: zero objectExists calls during initialization`);
  }
  assert.equal(counting.readObjectCallCount(shardKeyFor(0)), 1, "shard-000: exactly one real smoke read");
  assert.equal(counting.objectExistsCallCount(shardKeyFor(0)), 0, "shard-000: no objectExists call -- covered by the manifest inventory check");
  rmSync(dir, { recursive: true, force: true });
});

// Required test B: one required shard manifest entry missing => fail closed
// at initialization, and storage is never queried about that shard's
// existence merely to discover the manifest is missing it.
test("integrity-required mode: one required shard manifest entry missing => initialization fails closed without querying storage for that shard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-missing-shard-entry-"));
  writeFullLocalArtifact(dir, { withManifest: true, excludeShards: [30] });
  const counting = createCountingAdapter(createLocalFilesystemStorageAdapter(dir));
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { storageAdapter: counting, integrityMode: "integrity-required" }),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "INTEGRITY_MANIFEST_INVALID",
  );
  assert.equal(counting.readObjectCallCount(shardKeyFor(30)), 0, "storage is never read merely to discover whether the missing-manifest shard exists");
  assert.equal(counting.objectExistsCallCount(shardKeyFor(30)), 0, "storage existence is never queried for the missing-manifest shard either");
  rmSync(dir, { recursive: true, force: true });
});

// Required test C: shard-000's manifest entry is present but the physical
// object is gone => fail closed (the one shard that IS eagerly, physically
// read at initialization).
test("integrity-required mode: shard-000 manifest entry present but physical object missing => initialization fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-shard0-missing-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  rmSync(join(dir, "packed", "shard-000.bin"));
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "MISSING",
  );
  rmSync(dir, { recursive: true, force: true });
});

// Required test D: a non-zero shard's manifest entry exists but the physical
// object is gone => initialization still SUCCEEDS (the manifest entry alone
// satisfies the structural inventory), and the failure surfaces only lazily,
// at query time, as zero evidence for the evaluation that touches it.
test("integrity-required mode: non-zero shard manifest entry present but physical object missing => init succeeds, query-time MISSING, zero evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-shard30-missing-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  rmSync(join(dir, "packed", "shard-030.bin"));
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" });
  assert.ok(artifact.integrity, "initialization succeeds -- the manifest entry alone satisfies the structural inventory check");

  const collector = createSelectiveCorpusFailureCollector();
  const postings = await artifact.postingsAccessor.getPostings("1e" + "00".repeat(7), collector); // shard 0x1e = 30
  assert.equal(postings, undefined, "zero evidence from a shard whose backing object is missing");
  assert.equal(collector.getFailures()[0].code, "MISSING");
  rmSync(dir, { recursive: true, force: true });
});

// Required test E: a non-zero shard's manifest entry exists, and the object
// physically exists, but its bytes do not match the manifest's digest =>
// zero evidence, INTEGRITY_MISMATCH -- distinct from test D (object present,
// content wrong, rather than object absent).
test("integrity-required mode: non-zero shard integrity mismatch at query time => zero evidence, INTEGRITY_MISMATCH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-shard31-mismatch-"));
  writeFullLocalArtifact(dir, { withManifest: false });
  const entries = [
    { key: "corpus-version.json", bytes: readFileSync(join(dir, "corpus-version.json")) },
    { key: "packed/docmap.tsv", bytes: readFileSync(join(dir, "packed", "docmap.tsv")) },
    { key: "packed/stopset.bin", bytes: readFileSync(join(dir, "packed", "stopset.bin")) },
  ];
  for (let s = 0; s < 256; s++) {
    const bytes = readFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`));
    entries.push(s === 31 ? { key: shardKeyFor(s), bytes, sha256Override: "f".repeat(64) } : { key: shardKeyFor(s), bytes });
  }
  writeFileSync(join(dir, "object-integrity.json"), buildManifestBytes(entries));
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" });

  const collector = createSelectiveCorpusFailureCollector();
  const postings = await artifact.postingsAccessor.getPostings("1f" + "00".repeat(7), collector); // shard 0x1f = 31
  assert.equal(postings, undefined);
  assert.equal(collector.getFailures()[0].code, "INTEGRITY_MISMATCH");
  rmSync(dir, { recursive: true, force: true });
});

// Required test G: local-compatible mode is untouched -- still eagerly
// validates every one of the 256 shard files via objectExists(), and a
// missing local shard still fails initialization exactly as before.
test("local-compatible mode: still eagerly validates all 256 shard files exist, and a missing one fails initialization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-localcompat-eager-"));
  writeFullLocalArtifact(dir, { withManifest: false });
  const counting = createCountingAdapter(createLocalFilesystemStorageAdapter(dir));
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir, { storageAdapter: counting }); // no integrityMode => local-compatible
  assert.equal(artifact.integrity, undefined);
  for (let s = 0; s < 256; s++) {
    assert.equal(counting.objectExistsCallCount(shardKeyFor(s)), 1, `shard ${s}: existing eager objectExists check preserved`);
  }

  rmSync(join(dir, "packed", "shard-045.bin"));
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "MISSING",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("integrity-required mode: missing required source entry encountered at verification time => candidate skipped", async () => {
  clearSelectiveCorpusSourceCache();
  const otherKey = "raw/onlyOther.txt";
  const otherBytes = Buffer.from("some other, unrelated verified text", "utf8");
  const integrity = parseSelectiveCorpusIntegrityManifest(buildManifestBytes([{ key: otherKey, bytes: otherBytes }]));
  const targetBytes = Buffer.from("the actual candidate text nobody has an integrity entry for", "utf8");
  const adapter = createSimulatedRemoteStorageAdapter({ objects: { "raw/target.txt": { bytes: targetBytes } } });
  const artifact = {
    artifactPath: "source-test-manifest-missing-entry",
    storage: adapter,
    integrity,
    docByOrdinal: [minimalDoc("bulk:target")],
  };
  const result = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(result, null, "fail-closed: candidate text has no integrity entry, so it cannot be verified");
  clearSelectiveCorpusSourceCache();
});

test("integrity-required mode: same adapter/path concurrent artifact init remains deduped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-conc-dedup-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  const adapter = createLocalFilesystemStorageAdapter(dir);
  clearSelectiveCorpusArtifactCache();
  const [a, b] = await Promise.all([
    loadSelectiveCorpusArtifact("nominal-path-integrity-x", { storageAdapter: adapter, integrityMode: "integrity-required" }),
    loadSelectiveCorpusArtifact("nominal-path-integrity-x", { storageAdapter: adapter, integrityMode: "integrity-required" }),
  ]);
  assert.equal(a, b, "concurrent same-adapter/path/integrityMode loads share one initialization");
  rmSync(dir, { recursive: true, force: true });
});

test("integrity-required mode: different adapters sharing a nominal path do not collide", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "scv-remote-conc-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "scv-remote-conc-b-"));
  writeFullLocalArtifact(dirA, { withManifest: true });
  writeFullLocalArtifact(dirB, { withManifest: true });
  const adapterA = createLocalFilesystemStorageAdapter(dirA);
  const adapterB = createLocalFilesystemStorageAdapter(dirB);
  clearSelectiveCorpusArtifactCache();
  const [a, b] = await Promise.all([
    loadSelectiveCorpusArtifact("nominal-path-integrity-y", { storageAdapter: adapterA, integrityMode: "integrity-required" }),
    loadSelectiveCorpusArtifact("nominal-path-integrity-y", { storageAdapter: adapterB, integrityMode: "integrity-required" }),
  ]);
  assert.notEqual(a, b);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 11B. CONTROL-OBJECT (corpus-version.json / packed/docmap.tsv /
//      packed/stopset.bin) BOOTSTRAP-TIME INTEGRITY ENFORCEMENT
//
// Proves the loader trust-order fix in lib/selective-corpus/artifact.ts:
// in integrity-required mode, these 3 bootstrap objects are read and
// VERIFIED against object-integrity.json BEFORE their bytes are parsed or
// trusted -- not merely listed in the manifest. Each corruption below is
// deliberately kept syntactically/structurally valid (valid JSON, valid TSV
// row shape, a readable binary blob) so a failure can only be attributable
// to integrity verification, never to a downstream parse error.
// ═══════════════════════════════════════════════════════════════════════

const CONTROL_KEYS = ["corpus-version.json", "packed/docmap.tsv", "packed/stopset.bin"];

test("control objects: valid package with all 3 control entries => integrity-required bootstrap succeeds normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-control-valid-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" });
  assert.ok(artifact.integrity, "manifest was loaded and attached");
  assert.equal(artifact.corpusVersion, "selective-corpus-v1");
  assert.equal(artifact.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
  rmSync(dir, { recursive: true, force: true });
});

for (const missingKey of CONTROL_KEYS) {
  test(`control objects: manifest entry for ${missingKey} absent (physical file still exists) => bootstrap fails closed`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "scv-remote-control-missing-entry-"));
    writeFullLocalArtifact(dir, { withManifest: true, excludeControlEntries: [missingKey] });
    // sanity: the physical file is genuinely still present on disk
    assert.ok(statSync(join(dir, ...missingKey.split("/"))).isFile(), "physical file must still exist -- only the manifest entry is missing");
    clearSelectiveCorpusArtifactCache();
    await assert.rejects(
      () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
      (e) => {
        assert.ok(e instanceof SelectiveCorpusArtifactError, "must be the established typed artifact error");
        assert.equal(e.code, "CORRUPT");
        assert.match(e.message, /failed integrity verification/);
        assert.match(e.message, new RegExp(missingKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
    rmSync(dir, { recursive: true, force: true });
  });
}

test("control objects: corpus-version.json bytes corrupted (still valid JSON, unrelated field changed) => fails on integrity, not on JSON/version/digest checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-control-corrupt-version-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  const original = JSON.parse(readFileSync(join(dir, "corpus-version.json"), "utf8"));
  // change a field the loader never validates (documentCount) -- stays valid
  // JSON, and corpusVersion/digest/winnow/shingle/stopPolicy are untouched,
  // so if this is caught it can ONLY be the integrity check catching it.
  const corrupted = { ...original, documentCount: (original.documentCount ?? 0) + 999 };
  writeFileSync(join(dir, "corpus-version.json"), JSON.stringify(corrupted));
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, "corpus-version.json"), "utf8")), "corruption must remain valid JSON");

  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
    (e) => {
      assert.ok(e instanceof SelectiveCorpusArtifactError);
      assert.equal(e.code, "CORRUPT");
      assert.match(e.message, /corpus-version\.json failed integrity verification/, "must be attributed to integrity, not to WRONG_VERSION/WRONG_DIGEST/JSON parse");
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("control objects: packed/docmap.tsv bytes corrupted (still valid TSV row shape) => fails on integrity, not on TSV parsing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-control-corrupt-docmap-"));
  writeFullLocalArtifact(dir, { withManifest: true });
  const original = readFileSync(join(dir, "packed", "docmap.tsv"), "utf8");
  const fields = original.split("\t");
  fields[4] = String(Number(fields[4]) + 1); // wordCount, off by one -- structurally still a valid TSV row
  const corrupted = fields.join("\t");
  writeFileSync(join(dir, "packed", "docmap.tsv"), corrupted);
  assert.equal(corrupted.split("\t").length, original.split("\t").length, "corruption must preserve valid TSV row structure");

  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
    (e) => {
      assert.ok(e instanceof SelectiveCorpusArtifactError);
      assert.equal(e.code, "CORRUPT");
      assert.match(e.message, /packed\/docmap\.tsv failed integrity verification/, "must be attributed to integrity, not to a TSV parse/empty-docmap error");
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("control objects: packed/stopset.bin bytes corrupted (still a readable binary blob) => fails on integrity, not on decode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-control-corrupt-stopset-"));
  // stopset.bin is empty (0 hashes) in writeFullLocalArtifact's fixture, so
  // give it real content here to have bytes worth flipping.
  writeFullLocalArtifact(dir, { withManifest: false });
  const realStopBytes = Buffer.concat([Buffer.alloc(8, 0x11), Buffer.alloc(8, 0x22)]); // 2 fake hashes
  writeFileSync(join(dir, "packed", "stopset.bin"), realStopBytes);
  const entries = [
    { key: "corpus-version.json", bytes: readFileSync(join(dir, "corpus-version.json")) },
    { key: "packed/docmap.tsv", bytes: readFileSync(join(dir, "packed", "docmap.tsv")) },
    { key: "packed/stopset.bin", bytes: realStopBytes }, // manifest reflects the ORIGINAL bytes
  ];
  for (let s = 0; s < 256; s++) {
    entries.push({ key: shardKeyFor(s), bytes: readFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`)) });
  }
  writeFileSync(join(dir, "object-integrity.json"), buildManifestBytes(entries));

  const corrupted = Buffer.from(realStopBytes);
  corrupted[3] = corrupted[3] ^ 0xff; // flip a byte -- still exactly 16 bytes, still cleanly decodes as 2 hashes
  writeFileSync(join(dir, "packed", "stopset.bin"), corrupted);
  assert.equal(corrupted.length, realStopBytes.length, "corruption must preserve the readable binary structure (same length, decodes fine)");

  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir, { integrityMode: "integrity-required" }),
    (e) => {
      assert.ok(e instanceof SelectiveCorpusArtifactError);
      assert.equal(e.code, "CORRUPT");
      assert.match(e.message, /packed\/stopset\.bin failed integrity verification/, "must be attributed to integrity, not to a decode error");
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("control objects: local-compatible mode (no integrityMode given) ignores control-object corruption entirely -- existing non-integrity workflows are unaffected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-remote-control-localcompat-corrupt-"));
  writeFullLocalArtifact(dir, { withManifest: false }); // no manifest at all -- pure local-compatible fixture
  const original = JSON.parse(readFileSync(join(dir, "corpus-version.json"), "utf8"));
  writeFileSync(join(dir, "corpus-version.json"), JSON.stringify({ ...original, documentCount: 12345 }));
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(dir); // default local-compatible mode
  assert.equal(artifact.integrity, undefined, "local-compatible mode never attaches an integrity manifest");
  rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 12. LOCAL vs SIMULATED-REMOTE/INTEGRITY-REQUIRED EQUIVALENCE
// ═══════════════════════════════════════════════════════════════════════

const ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
const artifactPresent = (() => {
  try {
    return statSync(join(ARTIFACT, "corpus-version.json")).isFile();
  } catch {
    return false;
  }
})();

test(
  "equivalence: local filesystem adapter vs simulated-remote/integrity-required adapter over the SAME fixture corpus produce identical shadow results",
  { skip: !artifactPresent },
  async () => {
    await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true" }, async () => {
      const sub = readFileSync(join(ARTIFACT, "raw", "A-000010.txt"), "utf8");
      const authoritative = { unifiedScore: 8, matchedPositions: [10, 11, 12] };

      clearSelectiveCorpusArtifactCache();
      // this equivalence test deliberately exercises the OLDER fixture-inclusive
      // dev/regression artifact -- content-agnostic to the production digest.
      const artifactLocal = await loadSelectiveCorpusArtifact(ARTIFACT, { expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST });

      // Discover exactly which shard/raw objects THIS submission will touch,
      // so the manifest only needs to cover what will actually be read --
      // not the whole multi-thousand-document corpus.
      const probeStageA = await selectiveCorpusStageA(sub, artifactLocal);
      const touchedRawIds = probeStageA.topK
        .map((c) => artifactLocal.docByOrdinal[c.ordinal]?.rawId)
        .filter((id) => typeof id === "string" && id.startsWith("bulk:"))
        .map((id) => id.slice(5));

      const integrityEntries = [
        { key: "corpus-version.json", bytes: readFileSync(join(ARTIFACT, "corpus-version.json")) },
        { key: "packed/docmap.tsv", bytes: readFileSync(join(ARTIFACT, "packed", "docmap.tsv")) },
        { key: "packed/stopset.bin", bytes: readFileSync(join(ARTIFACT, "packed", "stopset.bin")) },
      ];
      for (let s = 0; s < 256; s++) {
        const key = shardKeyFor(s);
        const bytes = readFileSync(join(ARTIFACT, key));
        integrityEntries.push({ key, bytes });
      }
      for (const id of touchedRawIds) {
        const key = `raw/${id}.txt`;
        let bytes;
        try {
          bytes = readFileSync(join(ARTIFACT, key));
        } catch {
          continue;
        }
        integrityEntries.push({ key, bytes });
      }
      const manifestBytes = buildManifestBytes(integrityEntries);

      const remoteAdapter = createSimulatedRemoteStorageAdapter({
        objects: { "object-integrity.json": { bytes: manifestBytes } },
        backing: createLocalFilesystemStorageAdapter(ARTIFACT),
      });
      const artifactRemote = await loadSelectiveCorpusArtifact(ARTIFACT, {
        storageAdapter: remoteAdapter,
        integrityMode: "integrity-required",
        expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST,
      });
      assert.ok(artifactRemote.integrity);

      const resultLocal = await runSelectiveCorpusShadow({
        canonicalSubmissionText: sub,
        authoritative,
        artifactOverride: artifactLocal,
      });
      const resultRemote = await runSelectiveCorpusShadow({
        canonicalSubmissionText: sub,
        authoritative,
        artifactOverride: artifactRemote,
      });

      assert.equal(resultRemote.state, resultLocal.state);
      assert.equal(resultRemote.candidateCount, resultLocal.candidateCount);
      assert.deepEqual(resultRemote.topCandidateRanks, resultLocal.topCandidateRanks);
      assert.equal(resultRemote.stageATruncated, resultLocal.stageATruncated);
      assert.equal(resultRemote.verifiedSourceCount, resultLocal.verifiedSourceCount);
      assert.equal(resultRemote.matchedPositionCount, resultLocal.matchedPositionCount);
      assert.equal(resultRemote.counterfactualUnifiedSimilarity, resultLocal.counterfactualUnifiedSimilarity);
      assert.equal(resultRemote.deltaVsAuthoritative, resultLocal.deltaVsAuthoritative);
      assert.equal(resultRemote.familyGuardActivations, resultLocal.familyGuardActivations);
      assert.equal(resultRemote.coSourceAttributionActivations, resultLocal.coSourceAttributionActivations);
      assert.equal(resultRemote.interpretationVersion, resultLocal.interpretationVersion);
      assert.deepEqual(resultRemote.interpretationCounts, resultLocal.interpretationCounts);
      assert.deepEqual(resultRemote.interpretationBreakdown, resultLocal.interpretationBreakdown);
      // authoritative score isolation: untouched, identical, on both paths
      assert.equal(resultLocal.authoritativeUnifiedSimilarity, authoritative.unifiedScore);
      assert.equal(resultRemote.authoritativeUnifiedSimilarity, authoritative.unifiedScore);
      // storage-specific telemetry (timing, cache hit/miss counts) is
      // deliberately NOT compared -- it is expected to differ.
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════
// 14. STAGE A BOUNDED-CONCURRENCY SHARD PREFETCH (remote-I/O optimization)
// ═══════════════════════════════════════════════════════════════════════
//
// Root cause under test: a submission's winnowed fingerprints can span
// dozens of distinct packed shards; the ORIGINAL implementation issued one
// sequential network round trip per newly-encountered shard -- measured
// timing out even a 526-word/35-shard submission over a real remote store.
// selectiveCorpusStageA now runs a bounded-concurrency PREFETCH pass before
// its (byte-for-byte unchanged) sequential aggregation pass -- see
// lib/selective-corpus/stage-a.ts. Every test below uses ONLY the existing
// SelectiveCorpusStorageAdapter / SimulatedRemoteObjectSpec test seam; no
// production code is touched by these fixtures, and
// SELECTIVE_CORPUS_TIME_BUDGET_MS is asserted, never modified.

function seededRandomWords(n, seed) {
  let a = seed >>> 0;
  function rnd() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const words = [];
  for (let i = 0; i < n; i++) words.push(`w${Math.floor(rnd() * 1e9).toString(36)}`);
  return words.join(" ");
}

// Empirically confirmed against the real production fingerprint pipeline
// (winnowSubmissionFingerprints, offline, before writing this fixture): 5,000
// seeded-random tokens (seed 12345) winnow to ~628 fingerprints touching ~82
// distinct shards -- approximating the real P90/LONG natural-manuscript
// fanout (85 shards) that motivated this optimization. Verified below by an
// explicit range assertion rather than a hardcoded exact count, so a future
// unrelated change to winnow/gramHash constants cannot silently invalidate
// the fixture without failing loudly.
const HIGH_FANOUT_TEXT = seededRandomWords(5000, 12345);

function distinctNonStoppedShards(text) {
  const { fingerprints } = winnowSubmissionFingerprints(text);
  return [...new Set(fingerprints.map((h) => h.slice(0, 2)))].sort();
}

/** A minimal artifact object exposing ONLY what selectiveCorpusStageA reads
 *  (stopHashes + postingsAccessor) -- same pattern as the
 *  "evaluation-scoping C" fixture in selective-corpus-shadow.test.mjs. */
function minimalStageAArtifact(postingsAccessor, stopHashes = new Set()) {
  return { stopHashes, postingsAccessor };
}

/** Test-only: wraps a storage adapter to track peak concurrent readObject()
 *  calls and exact per-key physical call counts, without altering behavior. */
function createConcurrencyTrackingAdapter(inner) {
  let inFlight = 0;
  let peak = 0;
  const perKeyCalls = new Map();
  return {
    async readObject(key) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      perKeyCalls.set(key, (perKeyCalls.get(key) ?? 0) + 1);
      try {
        return await inner.readObject(key);
      } finally {
        inFlight -= 1;
      }
    },
    async objectExists(key) {
      return inner.objectExists(key);
    },
    peakConcurrency: () => peak,
    callCount: (key) => perKeyCalls.get(key) ?? 0,
    totalCalls: () => [...perKeyCalls.values()].reduce((a, b) => a + b, 0),
  };
}

test("stage A determinism: reordered simulated network completion produces byte-identical Stage A output", async () => {
  const text = seededRandomWords(1200, 999);
  const shards = distinctNonStoppedShards(text);
  assert.ok(shards.length >= 20, `expected a meaningful multi-shard fanout, got ${shards.length}`);

  // Give 3 of the touched shards real postings so `ranked` is non-empty --
  // otherwise this would only prove a (still valid, but less interesting)
  // "always empty" equivalence.
  const { fingerprints } = winnowSubmissionFingerprints(text);
  const sortedFp = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chosenShards = [shards[0], shards[Math.floor(shards.length / 2)], shards[shards.length - 1]];
  const shardBytesByNumber = new Map();
  for (const shardHex of chosenShards) {
    const hash = sortedFp.find((h) => h.slice(0, 2) === shardHex);
    const shardNum = Number.parseInt(shardHex, 16);
    shardBytesByNumber.set(shardNum, encodeShardBytes([{ hash, ordinals: [shardNum, shardNum + 1000] }]));
  }

  function buildObjects(delayForShard) {
    const objects = {};
    for (let s = 0; s < 256; s++) {
      objects[shardKeyFor(s)] = { bytes: shardBytesByNumber.get(s) ?? Buffer.alloc(4), delayMs: delayForShard(s) };
    }
    return objects;
  }

  async function runOnce(delayForShard) {
    const adapter = createSimulatedRemoteStorageAdapter({ objects: buildObjects(delayForShard) });
    const reader = new SelectiveCorpusShardReader(adapter, "packed", 256);
    return selectiveCorpusStageA(text, minimalStageAArtifact(reader));
  }

  const zero = await runOnce(() => 0);
  const ascending = await runOnce((s) => s % 11); // 0..10ms, correlated with shard number
  const descending = await runOnce((s) => (255 - s) % 11); // inverted -- opposite completion order

  function normalize(r) {
    return {
      ranked: r.ranked,
      topK: r.topK,
      queryFingerprintsUsed: r.queryFingerprintsUsed,
      stoppedFingerprints: r.stoppedFingerprints,
      postingRowsTallied: r.postingRowsTallied,
      truncated: r.truncated,
    };
  }
  assert.ok(zero.ranked.length >= 3, "sanity: the 3 seeded shards produced real candidates");
  assert.deepEqual(normalize(ascending), normalize(zero), "ascending-delay completion order must match the zero-delay baseline");
  assert.deepEqual(normalize(descending), normalize(zero), "descending (reversed) completion order must match the zero-delay baseline");
});

test("stage A concurrency: bounded prefetch achieves real parallelism, never exceeds the configured limit, and never double-fetches a shard", async () => {
  const shards = distinctNonStoppedShards(HIGH_FANOUT_TEXT);
  assert.ok(
    shards.length >= 70 && shards.length <= 95,
    `expected a high-fanout case approximating the real 77-85-shard natural-manuscript observation, got ${shards.length}`,
  );

  const objects = {};
  for (let s = 0; s < 256; s++) objects[shardKeyFor(s)] = { bytes: Buffer.alloc(4), delayMs: 5 };
  const tracking = createConcurrencyTrackingAdapter(createSimulatedRemoteStorageAdapter({ objects }));
  const reader = new SelectiveCorpusShardReader(tracking, "packed", 256);
  const artifact = minimalStageAArtifact(reader);

  const CONCURRENCY_LIMIT = SELECTIVE_CORPUS_STAGE_A_SHARD_FETCH_CONCURRENCY;
  await selectiveCorpusStageA(HIGH_FANOUT_TEXT, artifact, { shardFetchConcurrency: CONCURRENCY_LIMIT });

  assert.ok(tracking.peakConcurrency() > 1, `expected real parallelism, peak was ${tracking.peakConcurrency()}`);
  assert.ok(
    tracking.peakConcurrency() <= CONCURRENCY_LIMIT,
    `peak concurrency ${tracking.peakConcurrency()} must never exceed the configured limit ${CONCURRENCY_LIMIT}`,
  );

  for (const shardHex of shards) {
    const key = shardKeyFor(Number.parseInt(shardHex, 16));
    assert.equal(tracking.callCount(key), 1, `shard ${shardHex}: exactly one physical fetch despite prefetch + aggregation both calling getPostings`);
  }
  assert.equal(tracking.totalCalls(), shards.length, "no reads beyond the distinct shards actually needed");

  // Cache-hit re-run: a second Stage A call over the SAME text/reader must
  // add ZERO physical reads -- every needed shard is already warm.
  const totalBefore = tracking.totalCalls();
  await selectiveCorpusStageA(HIGH_FANOUT_TEXT, artifact, { shardFetchConcurrency: CONCURRENCY_LIMIT });
  assert.equal(tracking.totalCalls(), totalBefore, "cache hits must not create unnecessary remote requests");
});

test("stage A concurrency: a smaller configured limit is honored", async () => {
  const objects = {};
  for (let s = 0; s < 256; s++) objects[shardKeyFor(s)] = { bytes: Buffer.alloc(4), delayMs: 5 };
  const tracking = createConcurrencyTrackingAdapter(createSimulatedRemoteStorageAdapter({ objects }));
  const reader = new SelectiveCorpusShardReader(tracking, "packed", 256);
  const artifact = minimalStageAArtifact(reader);

  await selectiveCorpusStageA(HIGH_FANOUT_TEXT, artifact, { shardFetchConcurrency: 3 });
  assert.ok(tracking.peakConcurrency() > 1, "still genuinely parallel");
  assert.ok(tracking.peakConcurrency() <= 3, `peak concurrency ${tracking.peakConcurrency()} must respect the smaller configured limit of 3`);
});

test("stage A resilience: a one-shot transient failure during prefetch does not poison cache/in-flight state; retry after cooldown succeeds", async () => {
  const text = seededRandomWords(300, 555);
  const shards = distinctNonStoppedShards(text);
  assert.ok(shards.length >= 5);
  const failingShardNum = Number.parseInt(shards[0], 16);
  const failingKey = shardKeyFor(failingShardNum);

  const objects = {};
  for (let s = 0; s < 256; s++) objects[shardKeyFor(s)] = { bytes: Buffer.alloc(4) };
  objects[failingKey] = { bytes: Buffer.alloc(4), transientFailuresBeforeSuccess: 1 };

  const adapter = createSimulatedRemoteStorageAdapter({ objects });
  let clockMs = 0;
  const reader = new SelectiveCorpusShardReader(adapter, "packed", 256, { now: () => clockMs, transientRetryCooldownMs: 100 });
  const artifact = minimalStageAArtifact(reader);

  const collector1 = createSelectiveCorpusFailureCollector();
  const r1 = await selectiveCorpusStageA(text, artifact, undefined, collector1);
  assert.equal(r1.truncated, false);
  const failures1 = collector1.getFailures();
  assert.equal(failures1.length, 1, "exactly one degraded shard recorded (the transient one)");
  assert.equal(failures1[0].shard, failingShardNum);
  assert.equal(failures1[0].code, "TRANSIENT");
  assert.equal(adapter.callCount(failingKey), 1, "prefetch pass + aggregation pass together still made only ONE physical attempt");

  // Still within cooldown -- no hot loop back to storage.
  const collector2 = createSelectiveCorpusFailureCollector();
  await selectiveCorpusStageA(text, artifact, undefined, collector2);
  assert.equal(adapter.callCount(failingKey), 1, "still exactly one physical attempt before cooldown expiry");
  assert.equal(collector2.getFailures()[0]?.code, "TRANSIENT");

  // Past cooldown -- the (now one-shot-recovered) backend succeeds on retry.
  clockMs = 1000;
  const collector3 = createSelectiveCorpusFailureCollector();
  await selectiveCorpusStageA(text, artifact, undefined, collector3);
  assert.equal(collector3.getFailures().length, 0, "no failure recorded once the backend has healed");
  assert.equal(adapter.callCount(failingKey), 2, "exactly one retry attempt after cooldown expiry");
});

test("latency regression: bounded concurrency completes comfortably inside the 6s budget where naive per-shard-sequential timing would not", async () => {
  const shards = distinctNonStoppedShards(HIGH_FANOUT_TEXT);
  const PER_SHARD_DELAY_MS = 80;

  // Arithmetic fact tied to the SAME real simulated per-shard delay measured
  // below (not a fabricated number): naive sequential round trips for this
  // shard fanout would exceed SELECTIVE_CORPUS_TIME_BUDGET_MS.
  const naiveSequentialEstimateMs = shards.length * PER_SHARD_DELAY_MS;
  assert.ok(
    naiveSequentialEstimateMs > SELECTIVE_CORPUS_TIME_BUDGET_MS,
    `test setup sanity: ${shards.length} shards * ${PER_SHARD_DELAY_MS}ms = ${naiveSequentialEstimateMs}ms must exceed the ${SELECTIVE_CORPUS_TIME_BUDGET_MS}ms budget to be a meaningful regression case`,
  );

  const objects = {};
  for (let s = 0; s < 256; s++) objects[shardKeyFor(s)] = { bytes: Buffer.alloc(4), delayMs: PER_SHARD_DELAY_MS };
  const reader = new SelectiveCorpusShardReader(createSimulatedRemoteStorageAdapter({ objects }), "packed", 256);
  const artifact = minimalStageAArtifact(reader);

  const t0 = Date.now();
  await selectiveCorpusStageA(HIGH_FANOUT_TEXT, artifact);
  const elapsedMs = Date.now() - t0;

  assert.ok(
    elapsedMs < SELECTIVE_CORPUS_TIME_BUDGET_MS / 2,
    `optimized bounded-concurrency Stage A took ${elapsedMs.toFixed(0)}ms, expected comfortably under half the ${SELECTIVE_CORPUS_TIME_BUDGET_MS}ms budget (naive sequential would have needed ~${naiveSequentialEstimateMs}ms)`,
  );
});

test("full shadow evaluation determinism: reordered simulated network completion produces identical admission/similarity results", async () => {
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true" }, async () => {
    const submissionText = seededRandomWords(600, 4242);
    const { fingerprints } = winnowSubmissionFingerprints(submissionText);
    const sortedFp = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const chosenHash = sortedFp[Math.floor(sortedFp.length / 2)];
    const chosenShardNum = Number.parseInt(chosenHash.slice(0, 2), 16);
    const rawBytes = Buffer.from(submissionText, "utf8"); // candidateText === submission => guaranteed STRICT_SPAN admission

    async function runOnce(delayForShard) {
      clearSelectiveCorpusSourceCache();
      const objects = {};
      for (let s = 0; s < 256; s++) {
        const bytes = s === chosenShardNum ? encodeShardBytes([{ hash: chosenHash, ordinals: [0] }]) : Buffer.alloc(4);
        objects[shardKeyFor(s)] = { bytes, delayMs: delayForShard(s) };
      }
      objects["raw/doc0.txt"] = { bytes: rawBytes, delayMs: delayForShard(chosenShardNum) };
      const adapter = createSimulatedRemoteStorageAdapter({ objects });
      const artifact = {
        artifactPath: "det-test",
        corpusVersion: "selective-corpus-v1",
        corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
        fingerprintVersion: "selective-corpus-fp-w15-s5-v1",
        documentCount: 1,
        postingsAccessor: new SelectiveCorpusShardReader(adapter, "packed", 256),
        stopHashes: new Set(),
        docs: [minimalDoc("bulk:doc0")],
        docByOrdinal: [minimalDoc("bulk:doc0")],
        mode: "file-backed",
        storage: adapter,
      };
      const authoritative = { unifiedScore: 3, matchedPositions: [0, 1] };
      return runSelectiveCorpusShadow({ canonicalSubmissionText: submissionText, authoritative, artifactOverride: artifact });
    }

    const zero = await runOnce(() => 0);
    const ascending = await runOnce((s) => s % 9);
    const descending = await runOnce((s) => (255 - s) % 9);

    function pick(r) {
      return {
        state: r.state,
        candidateCount: r.candidateCount,
        topCandidateRanks: r.topCandidateRanks,
        stageATruncated: r.stageATruncated,
        verifiedSourceCount: r.verifiedSourceCount,
        matchedPositionCount: r.matchedPositionCount,
        counterfactualUnifiedSimilarity: r.counterfactualUnifiedSimilarity,
        deltaVsAuthoritative: r.deltaVsAuthoritative,
        familyGuardActivations: r.familyGuardActivations,
        coSourceAttributionActivations: r.coSourceAttributionActivations,
        interpretationVersion: r.interpretationVersion,
        interpretationCounts: r.interpretationCounts,
        interpretationBreakdown: r.interpretationBreakdown,
      };
    }
    assert.equal(zero.state, "COMPLETED");
    assert.ok(zero.verifiedSourceCount >= 1, "sanity: the seeded candidate was genuinely admitted");
    assert.deepEqual(pick(ascending), pick(zero), "ascending completion order must match the zero-delay baseline");
    assert.deepEqual(pick(descending), pick(zero), "descending (reversed) completion order must match the zero-delay baseline");
    clearSelectiveCorpusSourceCache();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 15. WINDOWED PREFETCH (high-fanout-vs-LRU-capacity audit)
// ═══════════════════════════════════════════════════════════════════════
//
// AUDIT FINDING: the original (unwindowed) prefetch pass -- warm every
// distinct shard a query needs, THEN aggregate -- is only correct while
// total distinct-shard fanout fits inside the postings accessor's own cache
// capacity (getStats().maxShards). Reproduced empirically (see the fix's own
// commit): once fanout exceeds capacity, the prefetch pass's own later
// shards evict its own earlier shards before the aggregation pass reaches
// them, causing EVERY shard (not just the excess) to be physically fetched
// twice. selectiveCorpusStageA now derives a window size from the accessor's
// OWN configured capacity and prefetches/aggregates one window at a time --
// see stage-a.ts. Every test below proves that fix directly.
//
// ACHIEVABLE FANOUT CEILING (measured, not assumed): a single submission's
// real winnowSubmissionFingerprints() output cannot organically exceed ~108
// distinct shards under the frozen winnow(w=15)/shingle(5)/4096-fingerprint-
// cap parameters -- winnow's minimum-hash-in-window selection structurally
// biases toward LOW hash-prefix (shard) values (the min of 15 i.i.d. samples
// over a byte-valued prefix has an expected value far below 128), and
// exceeding the 4096 raw-fingerprint cap triggers a "keep the numerically
// lowest" trim that collapses shard diversity further. This is a property of
// the winnow ALGORITHM, not of gramHash itself: gramHash's own first byte
// was independently confirmed (a 400,000-sample probe) to reach all 256
// values given sufficiently varied 5-grams. 200-256 distinct shards is
// therefore NOT deterministically constructible via genuine single-submission
// text, and no attempt is made to fabricate it. Instead, "below/at/above/
// near-maximum LRU capacity" is exercised the same way several PRE-EXISTING
// tests in this file already legitimately do -- by constructing the
// SelectiveCorpusShardReader with an explicit, smaller `maxShards` -- which
// exercises IDENTICAL production code (maxShards is a real, documented,
// env-overridable configuration knob: SELECTIVE_CORPUS_HOT_SHARD_LRU) against
// the real achievable fanout ceiling.

// Empirically confirmed (see the audit above): 30,000 seeded-random tokens
// (seed 12345) winnow to 3,762 raw fingerprints (under the 4096 cap, so NOT
// trimmed) touching exactly 108 distinct shards -- the measured real ceiling
// for a single submission under the frozen production parameters.
const NEAR_MAX_FANOUT_TEXT = seededRandomWords(30000, 12345);

test("windowed-prefetch audit: the real single-submission fanout ceiling is far below 256, and is NOT a gramHash defect", () => {
  const shards = distinctNonStoppedShards(NEAR_MAX_FANOUT_TEXT);
  const { rawCount, trimmed } = winnowSubmissionFingerprints(NEAR_MAX_FANOUT_TEXT);
  assert.equal(trimmed, false, "must stay under the 4096-fingerprint cap -- trimming would collapse shard diversity, not increase it");
  assert.ok(shards.length >= 95 && shards.length <= 120, `measured real ceiling: expected ~108 distinct shards, got ${shards.length}`);
  console.log(`[windowed-prefetch audit] near-max achievable single-submission fanout: ${shards.length} distinct shards from ${rawCount} raw fingerprints`);
});

/** A deliberately NAIVE, single-pass, non-prefetching reference
 *  implementation of Stage A's aggregation -- the literal pre-optimization
 *  algorithm, reproduced here ONLY as an independent oracle for the
 *  equivalence tests below. A single forward-only pass never revisits an
 *  earlier shard, so it can never suffer the eviction-during-prefetch bug by
 *  construction -- exactly why it is trustworthy as ground truth regardless
 *  of how small `artifact.postingsAccessor`'s own cache capacity is. */
async function referenceSequentialStageA(submissionText, artifact) {
  const topK = SELECTIVE_CORPUS_STAGE_A_TOP_K;
  const maxPostingRows = SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS;
  const maxCandidates = SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES;
  const { fingerprints } = winnowSubmissionFingerprints(submissionText);
  let postingRowsTallied = 0;
  let stoppedFingerprints = 0;
  let truncated = false;
  const weightByDoc = new Map();
  const matchedByDoc = new Map();
  const orderedFingerprints = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const h of orderedFingerprints) {
    if (artifact.stopHashes.has(h)) {
      stoppedFingerprints += 1;
      continue;
    }
    const arr = await artifact.postingsAccessor.getPostings(h);
    if (!arr) continue;
    postingRowsTallied += arr.length;
    if (postingRowsTallied > maxPostingRows) {
      truncated = true;
      break;
    }
    const w = 1 / Math.log2(2 + arr.length);
    for (const ord of arr) {
      if (!matchedByDoc.has(ord) && matchedByDoc.size >= maxCandidates) {
        truncated = true;
        continue;
      }
      matchedByDoc.set(ord, (matchedByDoc.get(ord) ?? 0) + 1);
      weightByDoc.set(ord, (weightByDoc.get(ord) ?? 0) + w);
    }
  }
  const ranked = [...matchedByDoc.keys()]
    .map((ordinal) => ({ ordinal, matchedFingerprints: matchedByDoc.get(ordinal) ?? 0, weight: weightByDoc.get(ordinal) ?? 0 }))
    .sort((a, b) => b.weight - a.weight || b.matchedFingerprints - a.matchedFingerprints || a.ordinal - b.ordinal);
  return { ranked, topK: ranked.slice(0, topK), queryFingerprintsUsed: fingerprints.length, stoppedFingerprints, postingRowsTallied, truncated };
}

/** Builds a fresh, real (non-empty) packed-shard byte set for `text`'s own
 *  touched shards -- a handful of them carry real postings so `ranked` is
 *  non-trivial -- plus valid-empty bytes for every other shard, served
 *  through a tracked simulated adapter with a small uniform delay so real
 *  parallelism is observable. Returns a fresh {trackedAdapter, artifact}
 *  pair each call -- no state is ever shared across calls. */
function buildHighFanoutFixture(text, maxShards, { withRealCandidates = true, delayMs = 2 } = {}) {
  const shards = distinctNonStoppedShards(text);
  const { fingerprints } = winnowSubmissionFingerprints(text);
  const sortedFp = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shardBytesByNumber = new Map();
  if (withRealCandidates) {
    const sampled = [shards[0], shards[Math.floor(shards.length / 3)], shards[Math.floor((2 * shards.length) / 3)], shards[shards.length - 1]];
    for (const shardHex of sampled) {
      const hash = sortedFp.find((h) => h.slice(0, 2) === shardHex);
      const shardNum = Number.parseInt(shardHex, 16);
      shardBytesByNumber.set(shardNum, encodeShardBytes([{ hash, ordinals: [shardNum, shardNum + 1000] }]));
    }
  }
  const objects = {};
  for (let s = 0; s < 256; s++) {
    objects[shardKeyFor(s)] = { bytes: shardBytesByNumber.get(s) ?? Buffer.alloc(4), delayMs };
  }
  const tracking = createConcurrencyTrackingAdapter(createSimulatedRemoteStorageAdapter({ objects }));
  const reader = new SelectiveCorpusShardReader(tracking, "packed", maxShards);
  const artifact = minimalStageAArtifact(reader);
  return { tracking, artifact, shards };
}

async function assertNoDuplicatePhysicalFetches(tracking, shards, label) {
  for (const shardHex of shards) {
    const key = shardKeyFor(Number.parseInt(shardHex, 16));
    assert.equal(tracking.callCount(key), 1, `${label}: shard ${shardHex} must be fetched exactly once, got ${tracking.callCount(key)}`);
  }
  assert.equal(tracking.totalCalls(), shards.length, `${label}: total physical reads must equal distinct shards needed`);
}

const HIGH_FANOUT_SHARD_COUNT = distinctNonStoppedShards(HIGH_FANOUT_TEXT).length; // ~82
const NEAR_MAX_FANOUT_SHARD_COUNT = distinctNonStoppedShards(NEAR_MAX_FANOUT_TEXT).length; // ~108

test("high-fanout A: fanout below LRU capacity (production default maxShards) -- one physical read per shard, real parallelism", async () => {
  const { tracking, artifact, shards } = buildHighFanoutFixture(HIGH_FANOUT_TEXT, SELECTIVE_CORPUS_HOT_SHARD_LRU);
  assert.ok(shards.length < SELECTIVE_CORPUS_HOT_SHARD_LRU, `sanity: ${shards.length} shards must be below the production default LRU capacity ${SELECTIVE_CORPUS_HOT_SHARD_LRU}`);
  const result = await selectiveCorpusStageA(HIGH_FANOUT_TEXT, artifact);
  await assertNoDuplicatePhysicalFetches(tracking, shards, "A (below capacity)");
  assert.ok(tracking.peakConcurrency() > 1);
  assert.ok(tracking.peakConcurrency() <= SELECTIVE_CORPUS_STAGE_A_SHARD_FETCH_CONCURRENCY);
  assert.ok(result.ranked.length >= 4, "sanity: seeded real candidates were found");
});

test("high-fanout B: fanout AT LRU capacity (maxShards == distinct shards needed, exactly one window) -- one physical read per shard", async () => {
  const maxShards = NEAR_MAX_FANOUT_SHARD_COUNT; // exactly matches the fanout -- a single window
  const { tracking, artifact, shards } = buildHighFanoutFixture(NEAR_MAX_FANOUT_TEXT, maxShards);
  assert.equal(shards.length, maxShards);
  await selectiveCorpusStageA(NEAR_MAX_FANOUT_TEXT, artifact);
  await assertNoDuplicatePhysicalFetches(tracking, shards, "B (at capacity)");
});

test("high-fanout C: fanout ABOVE LRU capacity (~2x) -- windowed prefetch still yields exactly one physical read per shard", async () => {
  const maxShards = Math.floor(NEAR_MAX_FANOUT_SHARD_COUNT / 2); // ~54 -- fanout is ~2x capacity, several windows
  const { tracking, artifact, shards } = buildHighFanoutFixture(NEAR_MAX_FANOUT_TEXT, maxShards);
  assert.ok(shards.length > maxShards * 1.5, `sanity: fanout ${shards.length} must clearly exceed capacity ${maxShards}`);
  const result = await selectiveCorpusStageA(NEAR_MAX_FANOUT_TEXT, artifact);
  await assertNoDuplicatePhysicalFetches(tracking, shards, "C (above capacity)");
  assert.ok(tracking.peakConcurrency() > 1);
  assert.ok(tracking.peakConcurrency() <= SELECTIVE_CORPUS_STAGE_A_SHARD_FETCH_CONCURRENCY);
  assert.ok(result.ranked.length >= 4);
});

test("high-fanout D: near-maximum real fanout (~108 shards) against a small LRU (many window transitions) -- one physical read per shard, identical result to the trusted sequential reference", async () => {
  const maxShards = 15; // ~108/15 ≈ 8 window transitions -- maximizes windowing stress within the real achievable ceiling
  const { tracking, artifact, shards } = buildHighFanoutFixture(NEAR_MAX_FANOUT_TEXT, maxShards);
  assert.ok(shards.length > maxShards * 5, `sanity: fanout ${shards.length} must be many multiples of capacity ${maxShards}`);

  const optimized = await selectiveCorpusStageA(NEAR_MAX_FANOUT_TEXT, artifact);
  await assertNoDuplicatePhysicalFetches(tracking, shards, "D (near-max, many windows)");

  // Independent oracle: a SEPARATE reader/adapter pair over the SAME shard
  // bytes, run through the naive single-pass reference (see its own doc
  // comment for why it is trustworthy regardless of cache size).
  const { artifact: referenceArtifact } = buildHighFanoutFixture(NEAR_MAX_FANOUT_TEXT, maxShards, { delayMs: 0 });
  const reference = await referenceSequentialStageA(NEAR_MAX_FANOUT_TEXT, referenceArtifact);

  assert.deepEqual(optimized.ranked, reference.ranked, "ranked candidates must be identical to the trusted sequential reference");
  assert.deepEqual(optimized.topK, reference.topK);
  assert.equal(optimized.queryFingerprintsUsed, reference.queryFingerprintsUsed);
  assert.equal(optimized.stoppedFingerprints, reference.stoppedFingerprints);
  assert.equal(optimized.postingRowsTallied, reference.postingRowsTallied);
  assert.equal(optimized.truncated, reference.truncated);
});

test("high-fanout: three network completion schedules (ascending/descending/shuffled delay) over near-max fanout produce byte-identical logical output", async () => {
  const maxShards = 20;
  const shards = distinctNonStoppedShards(NEAR_MAX_FANOUT_TEXT);
  const { fingerprints } = winnowSubmissionFingerprints(NEAR_MAX_FANOUT_TEXT);
  const sortedFp = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sampled = [shards[0], shards[Math.floor(shards.length / 2)], shards[shards.length - 1]];
  const shardBytesByNumber = new Map();
  for (const shardHex of sampled) {
    const hash = sortedFp.find((h) => h.slice(0, 2) === shardHex);
    const shardNum = Number.parseInt(shardHex, 16);
    shardBytesByNumber.set(shardNum, encodeShardBytes([{ hash, ordinals: [shardNum, shardNum + 1000] }]));
  }
  function buildObjects(delayForShard) {
    const objects = {};
    for (let s = 0; s < 256; s++) objects[shardKeyFor(s)] = { bytes: shardBytesByNumber.get(s) ?? Buffer.alloc(4), delayMs: delayForShard(s) };
    return objects;
  }
  async function runOnce(delayForShard) {
    const adapter = createSimulatedRemoteStorageAdapter({ objects: buildObjects(delayForShard) });
    const reader = new SelectiveCorpusShardReader(adapter, "packed", maxShards);
    return selectiveCorpusStageA(NEAR_MAX_FANOUT_TEXT, minimalStageAArtifact(reader));
  }
  function normalize(r) {
    return { ranked: r.ranked, topK: r.topK, queryFingerprintsUsed: r.queryFingerprintsUsed, stoppedFingerprints: r.stoppedFingerprints, postingRowsTallied: r.postingRowsTallied, truncated: r.truncated };
  }
  // deterministic pseudo-shuffle -- a fixed, reproducible permutation, not Math.random()
  function shuffledDelay(s) {
    return (s * 73 + 11) % 17;
  }
  const zero = await runOnce(() => 0);
  const ascending = await runOnce((s) => s % 13);
  const descending = await runOnce((s) => (255 - s) % 13);
  const shuffled = await runOnce(shuffledDelay);

  assert.ok(zero.ranked.length >= 3, "sanity: seeded real candidates were found");
  assert.deepEqual(normalize(ascending), normalize(zero));
  assert.deepEqual(normalize(descending), normalize(zero));
  assert.deepEqual(normalize(shuffled), normalize(zero));
});

test("high-fanout failure semantics: transient + permanent-missing + integrity-mismatch shards above LRU capacity behave exactly as without windowing -- no hot loop, no cache poisoning, no cascading duplicate fetches of healthy shards", async () => {
  const maxShards = 20; // well below the ~108-shard fanout
  const shards = distinctNonStoppedShards(NEAR_MAX_FANOUT_TEXT);
  const { fingerprints } = winnowSubmissionFingerprints(NEAR_MAX_FANOUT_TEXT);
  const sortedFp = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const transientShardHex = shards[5];
  const missingShardHex = shards[15];
  const integrityShardHex = shards[25];
  const transientShardNum = Number.parseInt(transientShardHex, 16);
  const missingShardNum = Number.parseInt(missingShardHex, 16);
  const integrityShardNum = Number.parseInt(integrityShardHex, 16);

  const integrityHash = sortedFp.find((h) => h.slice(0, 2) === integrityShardHex);
  const integrityBytes = encodeShardBytes([{ hash: integrityHash, ordinals: [999] }]);

  // Real bytes for every shard (empty-but-valid, except the integrity shard's
  // own well-formed non-empty bytes). A full 256-entry manifest is REQUIRED --
  // SelectiveCorpusShardReader's `integrity` option applies uniformly to every
  // shard read, and a shard with no manifest entry at all fails closed as
  // INTEGRITY_MISMATCH ("UNKNOWN_ENTRY") -- so a partial manifest would make
  // every OTHER (healthy) shard fail too. Every entry gets its real,
  // matching digest EXCEPT the one deliberately wrong override for the
  // integrity-test shard.
  const bytesByShard = new Map();
  for (let s = 0; s < 256; s++) bytesByShard.set(s, Buffer.alloc(4));
  bytesByShard.set(integrityShardNum, integrityBytes);
  const manifestEntries = [...bytesByShard.entries()].map(([s, bytes]) =>
    s === integrityShardNum
      ? { key: shardKeyFor(s), bytes, sha256Override: "0".repeat(64) }
      : { key: shardKeyFor(s), bytes },
  );
  const manifest = parseSelectiveCorpusIntegrityManifest(buildManifestBytes(manifestEntries));

  const objects = {};
  for (let s = 0; s < 256; s++) objects[shardKeyFor(s)] = { bytes: bytesByShard.get(s), delayMs: 1 };
  objects[shardKeyFor(transientShardNum)] = { bytes: bytesByShard.get(transientShardNum), transientFailuresBeforeSuccess: 1, delayMs: 1 };
  // no `bytes` at all -- forces SelectiveCorpusObjectNotFoundError per the
  // simulated adapter's own contract, independent of the manifest (a missing
  // OBJECT is caught before integrity verification is ever reached).
  objects[shardKeyFor(missingShardNum)] = { delayMs: 1 };

  let clockMs = 0;
  const adapter = createSimulatedRemoteStorageAdapter({ objects });
  const reader = new SelectiveCorpusShardReader(adapter, "packed", maxShards, {
    now: () => clockMs,
    transientRetryCooldownMs: 100,
    integrity: manifest,
  });
  const artifact = minimalStageAArtifact(reader);
  const collector = createSelectiveCorpusFailureCollector();

  const result = await selectiveCorpusStageA(NEAR_MAX_FANOUT_TEXT, artifact, undefined, collector);

  const failures = collector.getFailures();
  const byShard = new Map(failures.map((f) => [f.shard, f]));
  assert.equal(byShard.get(transientShardNum)?.code, "TRANSIENT");
  assert.equal(byShard.get(missingShardNum)?.code, "MISSING");
  assert.equal(byShard.get(integrityShardNum)?.code, "INTEGRITY_MISMATCH");

  // exactly one physical attempt per failing shard within this one evaluation
  // (prefetch pass's attempt + aggregation pass's attempt must dedupe via the
  // reader's own known-bad fast path, exactly as the healthy-shard case does).
  assert.equal(adapter.callCount(shardKeyFor(transientShardNum)), 1, "one physical attempt for the transient shard (no hot loop)");
  assert.equal(adapter.callCount(shardKeyFor(missingShardNum)), 1, "one physical attempt for the missing shard");
  assert.equal(adapter.callCount(shardKeyFor(integrityShardNum)), 1, "one physical attempt for the integrity-mismatched shard");

  // every OTHER (healthy) shard is still fetched exactly once -- the 3
  // failures do not cascade into duplicate fetches elsewhere.
  const healthyShards = shards.filter((s) => ![transientShardHex, missingShardHex, integrityShardHex].includes(s));
  await assertNoDuplicatePhysicalFetches({ callCount: (k) => adapter.callCount(k), totalCalls: () => healthyShards.reduce((sum, s) => sum + adapter.callCount(shardKeyFor(Number.parseInt(s, 16))), 0) }, healthyShards, "healthy shards amid failures");

  // no evidence manufactured from any of the 3 failing shards
  assert.equal(result.ranked.find((r) => r.ordinal === 999), undefined, "integrity-mismatched shard's postings never contributed a candidate");

  // retry after cooldown succeeds for the transient shard -- cache/in-flight
  // state was not poisoned by the windowed prefetch.
  clockMs = 1000;
  const collector2 = createSelectiveCorpusFailureCollector();
  await selectiveCorpusStageA(NEAR_MAX_FANOUT_TEXT, artifact, undefined, collector2);
  assert.equal(collector2.getFailures().find((f) => f.shard === transientShardNum), undefined, "transient shard healed after cooldown");
  assert.equal(adapter.callCount(shardKeyFor(transientShardNum)), 2, "exactly one retry attempt after cooldown, still no hot loop");
});
