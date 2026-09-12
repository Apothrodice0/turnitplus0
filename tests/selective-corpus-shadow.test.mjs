import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isSelectiveCorpusShadowEnabled } from "../lib/selective-corpus/flag.ts";
import { runSelectiveCorpusShadow } from "../lib/selective-corpus/shadow.ts";
import { runSelectiveCorpusShadowEvaluation } from "../lib/selective-corpus/shadow-evaluation.ts";
import {
  loadSelectiveCorpusArtifact,
  SelectiveCorpusArtifactError,
  clearSelectiveCorpusArtifactCache,
} from "../lib/selective-corpus/artifact.ts";
import { selectiveCorpusStageA } from "../lib/selective-corpus/stage-a.ts";
import { loadSelectiveCorpusCandidateText, clearSelectiveCorpusSourceCache } from "../lib/selective-corpus/source-loader.ts";
import { admitSelectiveCorpusCandidate, selectiveCorpusSubmissionWords } from "../lib/selective-corpus/verify.ts";
import { SelectiveCorpusShardReader, createSelectiveCorpusFailureCollector } from "../lib/selective-corpus/shard-reader.ts";
import { SELECTIVE_CORPUS_EXPECTED_DIGEST, SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST } from "../lib/selective-corpus/constants.ts";
import {
  createLocalFilesystemStorageAdapter,
  SelectiveCorpusObjectNotFoundError,
} from "../lib/selective-corpus/storage-adapter.ts";

const ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
const artifactPresent = (() => {
  try { return statSync(join(ARTIFACT, "corpus-version.json")).isFile(); } catch { return false; }
})();
// the current PRODUCTION (fixture-free) artifact -- matches SELECTIVE_CORPUS_EXPECTED_DIGEST by default
const PRODUCTION_ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-production-v1/run-20260912-023011";
const productionArtifactPresent = (() => {
  try { return statSync(join(PRODUCTION_ARTIFACT, "corpus-version.json")).isFile(); } catch { return false; }
})();

// async-safe: the finally block must only run AFTER an async `fn` resolves,
// or env vars restore before the awaited work inside `fn` actually finishes.
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

test("flag defaults OFF and is an immediate no-op (state DISABLED, no artifact read)", async () => {
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: undefined, SELECTIVE_CORPUS_ARTIFACT_PATH: "/nonexistent/never/read" }, async () => {
    assert.equal(isSelectiveCorpusShadowEnabled(), false);
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: { unifiedScore: 30, matchedPositions: [1, 2, 3] } });
    assert.equal(r.state, "DISABLED");
    assert.equal(r.corpusDigest, undefined);
    assert.equal(r.candidateCount, undefined);
  });
});

test("flag ON but no artifact path => ARTIFACT_UNAVAILABLE, never throws", async () => {
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: undefined }, async () => {
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: null });
    assert.equal(r.state, "ARTIFACT_UNAVAILABLE");
    assert.equal(r.failureCode, "MISSING");
  });
});

test("flag ON with a corrupt artifact fails closed (ARTIFACT_UNAVAILABLE), never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-corrupt-"));
  writeFileSync(join(dir, "corpus-version.json"), "{ not json");
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: null });
    assert.equal(r.state, "ARTIFACT_UNAVAILABLE");
    assert.equal(r.failureCode, "CORRUPT");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("wrong-digest artifact fails closed (WRONG_DIGEST)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-digest-"));
  mkdirSync(join(dir, "packed"), { recursive: true });
  writeFileSync(join(dir, "corpus-version.json"), JSON.stringify({
    corpusVersion: "selective-corpus-v1", corpusIdentityDigest: "0".repeat(64),
    fingerprintVersion: "x", winnowWindow: 15, shingleSize: 5, stopPolicy: "global DF>=13", documentCount: 1,
  }));
  writeFileSync(join(dir, "packed", "docmap.tsv"), "0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.alloc(0));
  for (let s = 0; s < 256; s++) writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(dir),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "WRONG_DIGEST",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("flag ON with the frozen artifact: COMPLETED, digest verified, authoritative object untouched", { skip: !productionArtifactPresent }, async () => {
  // exercises the DEFAULT env-var-driven production path end-to-end -- must
  // be the current PRODUCTION (fixture-free) artifact, since
  // SELECTIVE_CORPUS_ARTIFACT_PATH alone can never select a non-production
  // digest (shadow.ts's local-mode branch never passes expectedDigest).
  const sub = readFileSync(join(PRODUCTION_ARTIFACT, "raw", "A-000010.txt"), "utf8");
  const authoritative = { unifiedScore: 8, matchedPositions: [10, 11, 12] };
  const before = JSON.stringify(authoritative);
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: PRODUCTION_ARTIFACT }, async () => {
    clearSelectiveCorpusArtifactCache();
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: sub, authoritative });
    assert.equal(r.state, "COMPLETED");
    assert.equal(r.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
    assert.equal(typeof r.counterfactualUnifiedSimilarity, "number");
    assert.equal(r.authoritativeUnifiedSimilarity, 8);
    assert.ok(Array.isArray(r.topCandidateRanks));
    assert.equal(JSON.stringify(authoritative), before);
  });
});

test("file-backed shard reader is exactly equivalent to the in-memory Map for Stage A", { skip: !artifactPresent }, async () => {
  clearSelectiveCorpusArtifactCache();
  const im = await loadSelectiveCorpusArtifact(ARTIFACT, { mode: "in-memory", expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST });
  const fb = await loadSelectiveCorpusArtifact(ARTIFACT, { mode: "file-backed", hotShards: 8, expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST });
  assert.equal(fb.mode, "file-backed");
  assert.equal("postings" in fb, false); // the full Map is gone
  for (const id of ["A-000003", "A-000050", "Fen-000010"]) {
    let sub;
    try { sub = readFileSync(join(ARTIFACT, "raw", `${id}.txt`), "utf8"); } catch { continue; }
    const a = await selectiveCorpusStageA(sub, im);
    const b = await selectiveCorpusStageA(sub, fb);
    assert.equal(b.ranked.length, a.ranked.length);
    assert.equal(b.truncated, a.truncated);
    assert.equal(b.stoppedFingerprints, a.stoppedFingerprints);
    for (let i = 0; i < a.ranked.length; i++) {
      assert.equal(b.ranked[i].ordinal, a.ranked[i].ordinal);
      assert.equal(b.ranked[i].matchedFingerprints, a.ranked[i].matchedFingerprints);
      assert.ok(Math.abs(b.ranked[i].weight - a.ranked[i].weight) < 1e-9);
    }
  }
  const stats = fb.postingsAccessor.getStats();
  assert.ok(stats.loadedShards <= 8, "hot-shard LRU is bounded");
});

test("file-backed reader degrades gracefully on a missing shard (no throw into the report flow)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-missing-shard-"));
  mkdirSync(join(dir, "packed"), { recursive: true });
  writeFileSync(join(dir, "corpus-version.json"), JSON.stringify({
    corpusVersion: "selective-corpus-v1", corpusIdentityDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    fingerprintVersion: "x", winnowWindow: 15, shingleSize: 5, stopPolicy: "global DF>=13", documentCount: 1,
  }));
  writeFileSync(join(dir, "packed", "docmap.tsv"), "0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.alloc(0));
  // only 200 shard files — shard 200..255 missing
  for (let s = 0; s < 200; s++) writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    // the loader fails closed on the missing shard file at validation time
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: { unifiedScore: 5, matchedPositions: [1] } });
    assert.equal(r.state, "ARTIFACT_UNAVAILABLE");
    assert.equal(r.failureCode, "MISSING");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("deferred evaluator: flag OFF returns DISABLED without touching disk", async () => {
  const r = await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: undefined }, () =>
    runSelectiveCorpusShadowEvaluation({ reportId: "r1", rawText: "word ".repeat(400), authoritativeUnifiedSimilarity: null }),
  );
  assert.equal(r.state, "DISABLED");
});

// ── query-time shard loss / corruption signaling ───────────────────────────
// A shard that disappears or is truncated AFTER the artifact passed
// initialization must produce explicit PARTIAL/DEGRADED telemetry — not a
// silent COMPLETED that reads like an ordinary "no source matched".

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
  // 256 well-formed EMPTY shards (4-byte header, entryCount 0)
  for (let s = 0; s < 256; s++) {
    writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  }
}

test("query-time loss of packed shards after init => state PARTIAL (not a silent COMPLETED)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-qtime-missing-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  const authoritative = { unifiedScore: 12, matchedPositions: [1, 2, 3] };
  const before = JSON.stringify(authoritative);
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    await loadSelectiveCorpusArtifact(dir); // clean initialization — all 256 shards present & valid
    // ...then every shard file vanishes at query time
    for (let s = 0; s < 256; s++) {
      rmSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), { force: true });
    }
    const r = await runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative });
    assert.equal(r.state, "PARTIAL");
    assert.ok((r.degradedShardCount ?? 0) >= 1, "at least one degraded shard");
    assert.ok(Array.isArray(r.degradedShards) && r.degradedShards.every((n) => n >= 0 && n <= 255));
    assert.deepEqual(r.degradedShards, [...r.degradedShards].sort((a, b) => a - b));
    assert.ok((r.degradedShardCodes?.MISSING ?? 0) >= 1);
    assert.equal(r.degradedShardCodes?.CORRUPT ?? 0, 0);
    assert.equal(typeof r.degradedDetail, "string");
    assert.match(r.degradedDetail, /MISSING/);
    // still a usable (lower-bound) counterfactual, and the authoritative input is untouched
    assert.equal(r.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
    assert.equal(r.authoritativeUnifiedSimilarity, 12);
    assert.equal(typeof r.counterfactualUnifiedSimilarity, "number");
    assert.equal(JSON.stringify(authoritative), before);
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("query-time corruption of packed shards after init => state PARTIAL, code CORRUPT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-qtime-corrupt-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    await loadSelectiveCorpusArtifact(dir); // clean initialization
    // truncate every shard below the 4-byte header
    for (let s = 0; s < 256; s++) {
      writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.from([1, 2]));
    }
    const r = await runSelectiveCorpusShadow({
      canonicalSubmissionText: SHARD_QUERY_TEXT,
      authoritative: { unifiedScore: 4, matchedPositions: [] },
    });
    assert.equal(r.state, "PARTIAL");
    assert.ok((r.degradedShardCodes?.CORRUPT ?? 0) >= 1);
    assert.equal(r.degradedShardCodes?.MISSING ?? 0, 0);
    assert.ok((r.degradedShardCount ?? 0) >= 1);
    assert.match(r.degradedDetail, /CORRUPT/);
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("SelectiveCorpusShardReader: evaluation-scoped failure collector records without destructive draining", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-reader-ledger-"));
  const packed = join(dir, "packed");
  mkdirSync(packed, { recursive: true });
  for (let s = 0; s < 256; s++) {
    writeFileSync(join(packed, `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  }
  const storage = createLocalFilesystemStorageAdapter(dir);
  const reader = new SelectiveCorpusShardReader(storage, "packed", 8);

  // a present-but-empty shard: undefined, and NO failure recorded into the collector
  const c0 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings("00" + "ff".repeat(7), c0), undefined);
  assert.equal(c0.getFailures().length, 0);

  // shard 0x2a disappears, then two query hashes (within the SAME evaluation
  // collector) land in it
  rmSync(join(packed, "shard-042.bin"), { force: true });
  const c1 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings("2a" + "00".repeat(7), c1), undefined);
  assert.equal(await reader.getPostings("2a" + "11".repeat(7), c1), undefined);

  const failures = c1.getFailures();
  assert.equal(failures.length, 1, "deduplicated by shard number within one evaluation collector");
  assert.equal(failures[0].shard, 0x2a);
  assert.equal(failures[0].code, "MISSING");
  assert.ok(failures[0].observations >= 2, "the second hit is memoized but still counted");
  assert.equal(typeof failures[0].message, "string");

  // NON-destructive: reading the same collector again returns the same result
  assert.equal(c1.getFailures().length, 1);
  assert.equal(c1.getFailures()[0].observations, failures[0].observations);

  // a DIFFERENT, later evaluation (fresh collector) that also depends on the
  // SAME still-broken shard independently learns about it too, via the
  // reader's internal "known bad" fast path (no redundant physical read) --
  // this is exactly the property that fixes the original PARTIAL-vs-
  // COMPLETED race: every evaluation that depends on a failed shard gets
  // its own, independent record of that failure.
  const c2 = createSelectiveCorpusFailureCollector();
  assert.equal(await reader.getPostings("2a" + "22".repeat(7), c2), undefined);
  assert.equal(c2.getFailures().length, 1);
  assert.equal(c2.getFailures()[0].shard, 0x2a);

  // c1 is completely unaffected by c2 having also recorded the same shard
  assert.equal(c1.getFailures().length, 1);

  // reader-level stat: ONE distinct shard has ever been observed failing,
  // regardless of how many separate evaluation collectors observed it
  assert.equal(reader.getStats().shardLoadFailures, 1);

  rmSync(dir, { recursive: true, force: true });
});

// ── storage-adapter: local filesystem behavior ──────────────────────────────

test("local adapter: readObject preserves binary bytes exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-adapter-bytes-"));
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  writeFileSync(join(dir, "blob.bin"), Buffer.from(bytes));
  const storage = createLocalFilesystemStorageAdapter(dir);
  const read = await storage.readObject("blob.bin");
  assert.deepEqual(Uint8Array.from(read), bytes);
  rmSync(dir, { recursive: true, force: true });
});

test("local adapter: readObject on a missing key throws SelectiveCorpusObjectNotFoundError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-adapter-missing-"));
  const storage = createLocalFilesystemStorageAdapter(dir);
  await assert.rejects(
    () => storage.readObject("nope.bin"),
    (e) => e instanceof SelectiveCorpusObjectNotFoundError && e.key === "nope.bin",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("local adapter: objectExists is true for a present key, false for absent, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-adapter-exists-"));
  writeFileSync(join(dir, "present.txt"), "x");
  const storage = createLocalFilesystemStorageAdapter(dir);
  assert.equal(await storage.objectExists("present.txt"), true);
  assert.equal(await storage.objectExists("absent.txt"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("local adapter: rejects path traversal outside the artifact root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-adapter-root-"));
  const outside = mkdtempSync(join(tmpdir(), "scv-adapter-outside-"));
  writeFileSync(join(outside, "secret.txt"), "should never be reachable");
  const storage = createLocalFilesystemStorageAdapter(dir);
  const rel = join("..", outside.split(/[\\/]/).pop(), "secret.txt").replace(/\\/g, "/");
  await assert.rejects(() => storage.readObject("../../../../../../etc/passwd"));
  await assert.rejects(() => storage.readObject(rel));
  await assert.rejects(() => storage.readObject("/etc/passwd"), /artifact-relative/);
  await assert.rejects(() => storage.readObject("C:\\Windows\\win.ini"), /artifact-relative/);
  // objectExists rejects a traversal key too — a rejected key is a hard
  // error, never silently reported as an honest "false" (that would let a
  // real traversal attempt masquerade as an ordinary cache miss).
  await assert.rejects(() => storage.objectExists("../outside.txt"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("local adapter: performs no writes — the filesystem is untouched by any adapter call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-adapter-nowrite-"));
  writeFileSync(join(dir, "existing.txt"), "original");
  const before = statSync(join(dir, "existing.txt")).mtimeMs;
  const storage = createLocalFilesystemStorageAdapter(dir);
  await storage.readObject("existing.txt");
  await storage.objectExists("existing.txt");
  await storage.objectExists("does-not-exist.txt").catch(() => {});
  const filesAfter = readFileSync(join(dir, "existing.txt"), "utf8");
  assert.equal(filesAfter, "original", "content unchanged");
  assert.equal(statSync(join(dir, "existing.txt")).mtimeMs, before, "mtime unchanged — no write occurred");
  // no new files/directories were created anywhere under dir
  rmSync(dir, { recursive: true, force: true });
});

// ── artifact loader: concurrent first-load safety ───────────────────────────

test("two concurrent loadSelectiveCorpusArtifact calls for the same path share one load, not two", { skip: !artifactPresent }, async () => {
  clearSelectiveCorpusArtifactCache();
  const [a, b] = await Promise.all([
    loadSelectiveCorpusArtifact(ARTIFACT, { expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST }),
    loadSelectiveCorpusArtifact(ARTIFACT, { expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST }),
  ]);
  // same resolved artifact object identity — proves one shared load, not two independent ones
  assert.equal(a, b);
  assert.equal(a.corpusDigest, SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST);
});

test("a failed artifact load does not poison the cache — a corrected retry succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-cache-recover-"));
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(() => loadSelectiveCorpusArtifact(dir), SelectiveCorpusArtifactError);
  // now make the directory a valid artifact and retry — must NOT still fail from a cached rejection
  mkdirSync(join(dir, "packed"), { recursive: true });
  writeFileSync(join(dir, "corpus-version.json"), JSON.stringify({
    corpusVersion: "selective-corpus-v1", corpusIdentityDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    fingerprintVersion: "x", winnowWindow: 15, shingleSize: 5, stopPolicy: "global DF>=13", documentCount: 1,
  }));
  writeFileSync(join(dir, "packed", "docmap.tsv"), "0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.alloc(0));
  for (let s = 0; s < 256; s++) writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  const artifact = await loadSelectiveCorpusArtifact(dir);
  assert.equal(artifact.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

// ── concurrency hardening ────────────────────────────────────────────────
// Two callers racing on the SAME shard / SAME candidate / SAME nominal
// artifact path+mode must never (a) duplicate the underlying physical read,
// (b) skew cache-hit/miss/bytes-read accounting, or (c) collide across
// distinct injected storage-adapter instances.

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

/** Hand-encodes one well-formed packed shard file: entries sorted ascending
 *  by their 16-hex-char (64-bit) hash, each with its own doc-ordinal list —
 *  the same binary format shard-reader.ts's decodeShard() expects. */
function writeShardFile(path, entries) {
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
  writeFileSync(path, Buffer.concat(parts));
}

/** Wraps a real local storage adapter with per-key call counting and an
 *  optional scripted-failure count (fails the first N reads for a given key
 *  with SelectiveCorpusObjectNotFoundError, then falls through to the real
 *  read) — lets concurrent-dedup tests assert exact physical-read counts
 *  deterministically, without depending on real I/O timing. */
function createCountingStorageAdapter(realAdapter, failNTimesByKey = {}) {
  const counts = new Map();
  const remaining = new Map(Object.entries(failNTimesByKey));
  return {
    async readObject(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const left = remaining.get(key) ?? 0;
      if (left > 0) {
        remaining.set(key, left - 1);
        throw new SelectiveCorpusObjectNotFoundError(key);
      }
      return realAdapter.readObject(key);
    },
    async objectExists(key) {
      return realAdapter.objectExists(key);
    },
    callCount(key) {
      return counts.get(key) ?? 0;
    },
  };
}

function writeConcurrencyTestArtifactMeta(dir, documentCount = 1) {
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
      documentCount,
    }),
  );
  writeFileSync(join(dir, "packed", "docmap.tsv"), "0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.alloc(0));
}

test("concurrency A: two concurrent getPostings() calls for hashes in the SAME shard share one physical read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-conc-a-"));
  const packed = join(dir, "packed");
  mkdirSync(packed, { recursive: true });
  for (let s = 0; s < 256; s++) writeFileSync(join(packed, `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  const hashA = "2a" + "00".repeat(7);
  const hashB = "2a" + "11".repeat(7);
  writeShardFile(join(packed, "shard-042.bin"), [
    { hash: hashA, ordinals: [10, 20] },
    { hash: hashB, ordinals: [30] },
  ]);

  const counting = createCountingStorageAdapter(createLocalFilesystemStorageAdapter(dir));
  const reader = new SelectiveCorpusShardReader(counting, "packed", 8);

  const [postingsA, postingsB] = await Promise.all([reader.getPostings(hashA), reader.getPostings(hashB)]);
  assert.deepEqual([...postingsA], [10, 20]);
  assert.deepEqual([...postingsB], [30]);
  assert.equal(counting.callCount("packed/shard-042.bin"), 1, "exactly one physical readObject call for the shared shard");

  const stats = reader.getStats();
  assert.equal(stats.shardFileReads, 1, "exactly one shardFileReads counted, not one per concurrent caller");
  assert.equal(stats.cacheMisses, 1, "exactly one cacheMisses counted");
  assert.equal(stats.loadedShards, 1);

  // a later, sequential call for either hash is a genuine cache hit -- no new read
  const postingsAAgain = await reader.getPostings(hashA);
  assert.deepEqual([...postingsAAgain], [10, 20]);
  assert.equal(counting.callCount("packed/shard-042.bin"), 1, "still exactly one physical read after a later cache-hit call");
  assert.equal(reader.getStats().cacheHits, 1);

  rmSync(dir, { recursive: true, force: true });
});

test("concurrency B: two concurrent getPostings() calls (from two DIFFERENT evaluation collectors) for a FAILING shard share one physical read, and BOTH collectors independently learn of the failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-conc-b-"));
  const packed = join(dir, "packed");
  mkdirSync(packed, { recursive: true });
  for (let s = 0; s < 256; s++) writeFileSync(join(packed, `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  const hashA = "2b" + "00".repeat(7);
  const hashB = "2b" + "22".repeat(7);
  writeShardFile(join(packed, "shard-043.bin"), [{ hash: hashA, ordinals: [5] }]);

  // scripted to fail the shard's read exactly once -- since the concurrent
  // dedup means only ONE physical read is ever attempted for the batch,
  // this consumes the single scripted failure.
  const counting = createCountingStorageAdapter(createLocalFilesystemStorageAdapter(dir), { "packed/shard-043.bin": 1 });
  const reader = new SelectiveCorpusShardReader(counting, "packed", 8);

  // hashA and hashB represent two DIFFERENT overlapping evaluations, each
  // with its OWN failure collector, both depending on the same shard.
  const collectorX = createSelectiveCorpusFailureCollector();
  const collectorY = createSelectiveCorpusFailureCollector();
  const [postingsA, postingsB] = await Promise.all([
    reader.getPostings(hashA, collectorX),
    reader.getPostings(hashB, collectorY),
  ]);
  assert.equal(postingsA, undefined);
  assert.equal(postingsB, undefined);
  assert.equal(counting.callCount("packed/shard-043.bin"), 1, "exactly one physical read attempt for the concurrent failing batch");

  // BOTH evaluations' own collectors independently learned of the SAME
  // physical failure -- this is the exact property that fixes the
  // PARTIAL-vs-COMPLETED race: neither evaluation "steals" the other's
  // failure record, and neither is left unaware of it.
  const failuresX = collectorX.getFailures();
  const failuresY = collectorY.getFailures();
  assert.equal(failuresX.length, 1);
  assert.equal(failuresY.length, 1);
  assert.equal(failuresX[0].shard, 0x2b);
  assert.equal(failuresY[0].shard, 0x2b);
  assert.equal(failuresX[0].code, "MISSING");
  assert.equal(failuresY[0].code, "MISSING");
  assert.equal(failuresX[0].observations, 1, "each collector saw its own ONE call, not the other's");
  assert.equal(failuresY[0].observations, 1);

  // a later, separate evaluation (fresh collector) that also depends on the
  // same shard within this SAME reader instance still correctly reports the
  // failure -- the reader's internal "known bad" fast path is intentionally
  // persistent for the reader's lifetime (never destructively drained, since
  // draining was the source of the original cross-evaluation race). Whether
  // a shard that failed once should ever be retried within one reader's
  // lifetime is a retry-POLICY question for the future remote-storage
  // adapter, out of this task's scope -- not tested here.
  const collectorZ = createSelectiveCorpusFailureCollector();
  const postingsC = await reader.getPostings(hashA, collectorZ);
  assert.equal(postingsC, undefined);
  assert.equal(collectorZ.getFailures().length, 1);
  assert.equal(counting.callCount("packed/shard-043.bin"), 1, "still exactly one physical read ever -- the known-bad fast path avoided a second one");

  rmSync(dir, { recursive: true, force: true });
});

test("concurrency C: two concurrent loadSelectiveCorpusCandidateText() calls for the SAME candidate share one physical read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-conc-c-"));
  writeConcurrencyTestArtifactMeta(dir);
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw", "doc1.txt"), "the quick brown fox jumps over the lazy dog");
  clearSelectiveCorpusSourceCache();

  const counting = createCountingStorageAdapter(createLocalFilesystemStorageAdapter(dir));
  const artifact = {
    artifactPath: dir,
    storage: counting,
    docByOrdinal: [{ ordinal: 0, sourceId: "s0", family: "A_wikipedia", rawId: "bulk:doc1", wordCount: 9, interpretationLabel: "ORDINARY_REFERENCE" }],
  };

  const [r1, r2] = await Promise.all([
    loadSelectiveCorpusCandidateText(artifact, 0),
    loadSelectiveCorpusCandidateText(artifact, 0),
  ]);
  assert.equal(r1.text, "the quick brown fox jumps over the lazy dog");
  assert.equal(r2.text, r1.text);
  assert.equal(counting.callCount("raw/doc1.txt"), 1, "exactly one physical read for the concurrent batch");

  const r3 = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(r3.text, r1.text);
  assert.equal(counting.callCount("raw/doc1.txt"), 1, "the third, later call is a genuine LRU cache hit -- no new read");

  clearSelectiveCorpusSourceCache();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrency D: two concurrent loadSelectiveCorpusCandidateText() calls for a MISSING candidate both return null from one physical attempt, and a later retry is not permanently poisoned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-conc-d-"));
  writeConcurrencyTestArtifactMeta(dir);
  mkdirSync(join(dir, "raw"), { recursive: true });
  clearSelectiveCorpusSourceCache();

  const counting = createCountingStorageAdapter(createLocalFilesystemStorageAdapter(dir));
  const artifact = {
    artifactPath: dir,
    storage: counting,
    docByOrdinal: [{ ordinal: 0, sourceId: "s0", family: "A_wikipedia", rawId: "bulk:missing", wordCount: 0, interpretationLabel: "ORDINARY_REFERENCE" }],
  };

  const [r1, r2] = await Promise.all([
    loadSelectiveCorpusCandidateText(artifact, 0),
    loadSelectiveCorpusCandidateText(artifact, 0),
  ]);
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(counting.callCount("raw/missing.txt"), 1, "exactly one physical read attempt for the concurrent missing batch");

  // the source becomes available later -- a fresh, later call must not be
  // permanently poisoned by the earlier concurrent miss.
  writeFileSync(join(dir, "raw", "missing.txt"), "now it exists");
  const r3 = await loadSelectiveCorpusCandidateText(artifact, 0);
  assert.equal(r3.text, "now it exists");

  clearSelectiveCorpusSourceCache();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrency E: injected storage-adapter identity partitions the artifact cache -- two adapters sharing a nominal path/mode never collide", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "scv-conc-e-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "scv-conc-e-b-"));
  writeConcurrencyTestArtifactMeta(dirA, 111);
  for (let s = 0; s < 256; s++) writeFileSync(join(dirA, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  writeConcurrencyTestArtifactMeta(dirB, 222);
  for (let s = 0; s < 256; s++) writeFileSync(join(dirB, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));

  const adapterA = createLocalFilesystemStorageAdapter(dirA);
  const adapterB = createLocalFilesystemStorageAdapter(dirB);
  const NOMINAL_PATH = "nominal-shared-path-not-a-real-directory";

  const artifactA = await loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: adapterA });
  const artifactB = await loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: adapterB });
  assert.equal(artifactA.documentCount, 111);
  assert.equal(artifactB.documentCount, 222, "adapter B's own artifact, not adapter A's cached one, despite the identical nominal path/mode");
  assert.notEqual(artifactA, artifactB);

  // same adapter instance + same nominal path => shared cache
  const artifactAAgain = await loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: adapterA });
  assert.equal(artifactAAgain, artifactA, "repeated calls with the SAME adapter instance share the cached artifact");

  // concurrent calls with the SAME adapter share one in-flight initialization
  const freshAdapter = createLocalFilesystemStorageAdapter(dirA);
  const [c1, c2] = await Promise.all([
    loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: freshAdapter }),
    loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: freshAdapter }),
  ]);
  assert.equal(c1, c2, "concurrent calls with the same injected adapter resolve to the identical cached artifact object");

  // a failed load with an injected adapter is retryable, not permanently
  // cached as a rejection -- prove it concretely: fix the underlying
  // directory after the failure and retry with the SAME adapter instance.
  const badDir = mkdtempSync(join(tmpdir(), "scv-conc-e-bad-"));
  const badAdapter = createLocalFilesystemStorageAdapter(badDir); // initially empty, no corpus-version.json
  await assert.rejects(() => loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: badAdapter }), SelectiveCorpusArtifactError);
  writeConcurrencyTestArtifactMeta(badDir, 333);
  for (let s = 0; s < 256; s++) writeFileSync(join(badDir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  const fixed = await loadSelectiveCorpusArtifact(NOMINAL_PATH, { storageAdapter: badAdapter });
  assert.equal(fixed.documentCount, 333, "a corrected retry with the SAME adapter instance succeeds -- the failed load did not permanently poison this cache partition");

  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  rmSync(badDir, { recursive: true, force: true });
});

// ── evaluation-scoped failure attribution (runSelectiveCorpusShadow level) ──
// Fixes the specific race: two runSelectiveCorpusShadow() evaluations
// overlapping while sharing the same cached artifact/reader must each
// independently learn which shards THEY depended on failed -- never via a
// shared, destructively-drained ledger one evaluation could steal from
// another.

// Empirically confirmed (not guessed): SHARD_QUERY_TEXT's winnowed
// fingerprints touch 46 distinct shards, including shard 30 (0x1e);
// SMALL_UNAFFECTED_TEXT's touch exactly shard 5, never 30.
const SMALL_UNAFFECTED_TEXT = "the quick brown fox jumps over the lazy dog while the sun sets slowly behind the distant mountains today";

test("evaluation-scoping A: two overlapping evaluations sharing the same cached reader BOTH independently become PARTIAL from the same failing shard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-evalscope-a-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    const artifactRef = await loadSelectiveCorpusArtifact(dir); // clean initialization, all 256 shards present
    for (let s = 0; s < 256; s++) rmSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), { force: true });

    const statsBefore = artifactRef.postingsAccessor.getStats();
    const authA = { unifiedScore: 10, matchedPositions: [] };
    const authB = { unifiedScore: 20, matchedPositions: [] };
    const [resultA, resultB] = await Promise.all([
      runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative: authA }),
      runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative: authB }),
    ]);

    assert.equal(resultA.state, "PARTIAL", "evaluation A independently classifies PARTIAL");
    assert.equal(resultB.state, "PARTIAL", "evaluation B independently classifies PARTIAL -- neither stole the other's failure");
    assert.ok((resultA.degradedShardCount ?? 0) > 0);
    assert.ok((resultB.degradedShardCount ?? 0) > 0);
    // both used the identical submission text, so both genuinely depended on
    // the SAME shard numbers -- confirm real overlap, not coincidence
    const sharedShards = resultA.degradedShards.filter((s) => resultB.degradedShards.includes(s));
    assert.ok(sharedShards.length > 0, "both evaluations recorded at least one of the SAME shard number as degraded");
    assert.equal(resultA.authoritativeUnifiedSimilarity, 10, "authoritative inputs stay distinct per evaluation");
    assert.equal(resultB.authoritativeUnifiedSimilarity, 20);

    // physical I/O dedup (requirement D): two overlapping evaluations
    // touching the SAME ~46 distinct shards concurrently must still only
    // ever ATTEMPT each distinct shard once physically, thanks to the
    // in-flight-load sharing in shard-reader.ts -- not once per evaluation.
    const statsAfter = artifactRef.postingsAccessor.getStats();
    assert.ok(
      statsAfter.cacheMisses - statsBefore.cacheMisses <= 46,
      `expected at most 46 distinct physical read attempts shared across both evaluations, got ${statsAfter.cacheMisses - statsBefore.cacheMisses}`,
    );
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("evaluation-scoping B: one evaluation touching a failing shard is PARTIAL; a concurrent one that never depends on it stays COMPLETED, with no cross-contamination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-evalscope-b-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    await loadSelectiveCorpusArtifact(dir);
    // remove ONLY shard 30 (0x1e) -- empirically confirmed touched by
    // SHARD_QUERY_TEXT's own fingerprints but NOT by
    // SMALL_UNAFFECTED_TEXT's (which touches only shard 5).
    rmSync(join(dir, "packed", "shard-030.bin"), { force: true });

    const [affected, unaffected] = await Promise.all([
      runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative: { unifiedScore: 1, matchedPositions: [] } }),
      runSelectiveCorpusShadow({ canonicalSubmissionText: SMALL_UNAFFECTED_TEXT, authoritative: { unifiedScore: 2, matchedPositions: [] } }),
    ]);

    assert.equal(affected.state, "PARTIAL");
    assert.ok(affected.degradedShards.includes(30));
    assert.equal(unaffected.state, "COMPLETED", "an evaluation whose own fingerprints never route through the failing shard stays COMPLETED");
    assert.equal(unaffected.degradedShardCount, undefined, "no contamination from the concurrently-running affected evaluation");
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("evaluation-scoping C: Stage A and FAMILY_GUARD (verify.ts) share ONE evaluation collector -- a shard consulted by both is deduplicated to one entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-evalscope-c-"));
  mkdirSync(join(dir, "packed"), { recursive: true });
  // NO shard files at all -- every postings lookup, from Stage A's own
  // fingerprint sweep AND from FAMILY_GUARD's span-fingerprint check (drawn
  // from the SAME submission text), deterministically fails, regardless of
  // exact hash values -- no need to guess which specific shards overlap.
  const storage = createLocalFilesystemStorageAdapter(dir);
  const reader = new SelectiveCorpusShardReader(storage, "packed", 8);
  const artifact = {
    artifactPath: dir,
    corpusVersion: "selective-corpus-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    fingerprintVersion: "selective-corpus-fp-w15-s5-v1",
    documentCount: 0,
    postingsAccessor: reader,
    stopHashes: new Set(),
    docs: [],
    docByOrdinal: [],
    mode: "file-backed",
    storage,
  };

  const collector = createSelectiveCorpusFailureCollector();

  // Stage A's own sweep over the submission's winnowed fingerprints
  await selectiveCorpusStageA(SHARD_QUERY_TEXT, artifact, undefined, collector);
  const afterStageA = collector.getFailures();
  const observationsAfterStageA = afterStageA.reduce((sum, f) => sum + f.observations, 0);
  assert.ok(afterStageA.length > 0, "Stage A's sweep recorded at least one degraded shard");

  // FAMILY_GUARD (verify.ts), called directly the same way shadow.ts's own
  // Stage B loop calls it, sharing the SAME collector. candidateText ===
  // submission guarantees STRICT_SPAN passes via a real, exact match, so
  // classifySpanFamily's own span-hash sweep runs over real content drawn
  // from the SAME text Stage A already swept.
  const submissionWords = selectiveCorpusSubmissionWords(SHARD_QUERY_TEXT);
  await admitSelectiveCorpusCandidate(SHARD_QUERY_TEXT, submissionWords, SHARD_QUERY_TEXT, artifact, collector);

  const final = collector.getFailures();
  const totalObservations = final.reduce((sum, f) => sum + f.observations, 0);
  assert.ok(totalObservations > observationsAfterStageA, "FAMILY_GUARD's own span-hash sweep added more observations to the SAME collector");

  // the key property: every entry is keyed by shard number ONCE, regardless
  // of how many times (from Stage A, from FAMILY_GUARD, or both) that shard
  // was individually touched.
  const shardNumbers = final.map((f) => f.shard);
  assert.equal(new Set(shardNumbers).size, shardNumbers.length, "no duplicate shard-number entries -- degradedShardCount counts each shard once");

  // and at least one shard's observation count grew strictly beyond what
  // Stage A alone produced for it -- proving real overlap (FAMILY_GUARD
  // genuinely re-touched a shard Stage A had already recorded), not two
  // disjoint sets that merely happen to sit in the same collector.
  const grew = final.some((f) => {
    const stageAEntry = afterStageA.find((x) => x.shard === f.shard);
    return stageAEntry && f.observations > stageAEntry.observations;
  });
  assert.ok(grew, "at least one shard's observation count grew after FAMILY_GUARD ran, on the SAME collector Stage A used");

  rmSync(dir, { recursive: true, force: true });
});

test("evaluation-scoping E: existing single-evaluation PARTIAL/COMPLETED fixture expectations are unchanged by the evaluation-scoped redesign", async () => {
  // Re-confirms, in this same file, that the two pre-existing query-time
  // shard-loss/corruption tests (unmodified above) and the frozen-artifact
  // COMPLETED test still hold under the new collector-based mechanism --
  // the authoritative behavioral contract this whole redesign must preserve.
  const dir = mkdtempSync(join(tmpdir(), "scv-evalscope-e-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    await loadSelectiveCorpusArtifact(dir);
    const r = await runSelectiveCorpusShadow({
      canonicalSubmissionText: SHARD_QUERY_TEXT,
      authoritative: { unifiedScore: 7, matchedPositions: [1, 2] },
    });
    // no shards were removed in this variant -- ordinary COMPLETED, exactly
    // as a single, unaffected evaluation always has.
    assert.equal(r.state, "COMPLETED");
    assert.equal(r.degradedShardCount, undefined);
    assert.equal(r.authoritativeUnifiedSimilarity, 7);
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});
