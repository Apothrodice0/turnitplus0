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
import { SELECTIVE_CORPUS_EXPECTED_DIGEST } from "../lib/selective-corpus/constants.ts";

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

function writeFullLocalArtifact(dir, { withManifest = false, excludeShards = [] } = {}) {
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
  const entries = [];
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
  const entries = [];
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
      const artifactLocal = await loadSelectiveCorpusArtifact(ARTIFACT);

      // Discover exactly which shard/raw objects THIS submission will touch,
      // so the manifest only needs to cover what will actually be read --
      // not the whole multi-thousand-document corpus.
      const probeStageA = await selectiveCorpusStageA(sub, artifactLocal);
      const touchedRawIds = probeStageA.topK
        .map((c) => artifactLocal.docByOrdinal[c.ordinal]?.rawId)
        .filter((id) => typeof id === "string" && id.startsWith("bulk:"))
        .map((id) => id.slice(5));

      const integrityEntries = [];
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
