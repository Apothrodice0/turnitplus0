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
import { SelectiveCorpusShardReader } from "../lib/selective-corpus/shard-reader.ts";
import { SELECTIVE_CORPUS_EXPECTED_DIGEST } from "../lib/selective-corpus/constants.ts";

const ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
const artifactPresent = (() => {
  try { return statSync(join(ARTIFACT, "corpus-version.json")).isFile(); } catch { return false; }
})();

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("flag defaults OFF and is an immediate no-op (state DISABLED, no artifact read)", () => {
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: undefined, SELECTIVE_CORPUS_ARTIFACT_PATH: "/nonexistent/never/read" }, () => {
    assert.equal(isSelectiveCorpusShadowEnabled(), false);
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: { unifiedScore: 30, matchedPositions: [1, 2, 3] } });
    assert.equal(r.state, "DISABLED");
    assert.equal(r.corpusDigest, undefined);
    assert.equal(r.candidateCount, undefined);
  });
});

test("flag ON but no artifact path => ARTIFACT_UNAVAILABLE, never throws", () => {
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: undefined }, () => {
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: null });
    assert.equal(r.state, "ARTIFACT_UNAVAILABLE");
    assert.equal(r.failureCode, "MISSING");
  });
});

test("flag ON with a corrupt artifact fails closed (ARTIFACT_UNAVAILABLE), never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-corrupt-"));
  writeFileSync(join(dir, "corpus-version.json"), "{ not json");
  clearSelectiveCorpusArtifactCache();
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, () => {
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: null });
    assert.equal(r.state, "ARTIFACT_UNAVAILABLE");
    assert.equal(r.failureCode, "CORRUPT");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("wrong-digest artifact fails closed (WRONG_DIGEST)", () => {
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
  assert.throws(
    () => loadSelectiveCorpusArtifact(dir),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "WRONG_DIGEST",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("flag ON with the frozen artifact: COMPLETED, digest verified, authoritative object untouched", { skip: !artifactPresent }, () => {
  const sub = readFileSync(join(ARTIFACT, "raw", "A-000010.txt"), "utf8");
  const authoritative = { unifiedScore: 8, matchedPositions: [10, 11, 12] };
  const before = JSON.stringify(authoritative);
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: ARTIFACT }, () => {
    clearSelectiveCorpusArtifactCache();
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: sub, authoritative });
    assert.equal(r.state, "COMPLETED");
    assert.equal(r.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
    assert.equal(typeof r.counterfactualUnifiedSimilarity, "number");
    assert.equal(r.authoritativeUnifiedSimilarity, 8);
    assert.ok(Array.isArray(r.topCandidateRanks));
    assert.equal(JSON.stringify(authoritative), before);
  });
});

test("file-backed shard reader is exactly equivalent to the in-memory Map for Stage A", { skip: !artifactPresent }, () => {
  clearSelectiveCorpusArtifactCache();
  const im = loadSelectiveCorpusArtifact(ARTIFACT, { mode: "in-memory" });
  const fb = loadSelectiveCorpusArtifact(ARTIFACT, { mode: "file-backed", hotShards: 8 });
  assert.equal(fb.mode, "file-backed");
  assert.equal("postings" in fb, false); // the full Map is gone
  for (const id of ["A-000003", "A-000050", "Fen-000010"]) {
    let sub;
    try { sub = readFileSync(join(ARTIFACT, "raw", `${id}.txt`), "utf8"); } catch { continue; }
    const a = selectiveCorpusStageA(sub, im);
    const b = selectiveCorpusStageA(sub, fb);
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

test("file-backed reader degrades gracefully on a missing shard (no throw into the report flow)", () => {
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
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, () => {
    // the loader fails closed on the missing shard file at validation time
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: { unifiedScore: 5, matchedPositions: [1] } });
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

test("query-time loss of packed shards after init => state PARTIAL (not a silent COMPLETED)", () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-qtime-missing-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  const authoritative = { unifiedScore: 12, matchedPositions: [1, 2, 3] };
  const before = JSON.stringify(authoritative);
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, () => {
    loadSelectiveCorpusArtifact(dir); // clean initialization — all 256 shards present & valid
    // ...then every shard file vanishes at query time
    for (let s = 0; s < 256; s++) {
      rmSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), { force: true });
    }
    const r = runSelectiveCorpusShadow({ canonicalSubmissionText: SHARD_QUERY_TEXT, authoritative });
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

test("query-time corruption of packed shards after init => state PARTIAL, code CORRUPT", () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-qtime-corrupt-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, () => {
    loadSelectiveCorpusArtifact(dir); // clean initialization
    // truncate every shard below the 4-byte header
    for (let s = 0; s < 256; s++) {
      writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.from([1, 2]));
    }
    const r = runSelectiveCorpusShadow({
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

test("SelectiveCorpusShardReader records + drains a per-evaluation shard-failure ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-reader-ledger-"));
  const packed = join(dir, "packed");
  mkdirSync(packed, { recursive: true });
  for (let s = 0; s < 256; s++) {
    writeFileSync(join(packed, `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  }
  const reader = new SelectiveCorpusShardReader(packed, 8);

  // a present-but-empty shard: undefined, and NO failure recorded
  assert.equal(reader.getPostings("00" + "ff".repeat(7)), undefined);
  assert.equal(reader.takeShardFailures().length, 0);

  // shard 0x2a disappears, then two query hashes land in it
  rmSync(join(packed, "shard-042.bin"), { force: true });
  assert.equal(reader.getPostings("2a" + "00".repeat(7)), undefined);
  assert.equal(reader.getPostings("2a" + "11".repeat(7)), undefined);

  const failures = reader.takeShardFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].shard, 0x2a);
  assert.equal(failures[0].code, "MISSING");
  assert.ok(failures[0].observations >= 2, "the second hit is memoized but still counted");
  assert.equal(typeof failures[0].message, "string");

  // drained: a subsequent drain is empty until the shard is re-observed
  assert.equal(reader.takeShardFailures().length, 0);
  assert.equal(reader.getPostings("2a" + "22".repeat(7)), undefined);
  assert.equal(reader.takeShardFailures().length, 1);
  assert.equal(reader.getStats().shardLoadFailures, 2); // monotonic: re-observed after the drain
  assert.equal(reader.getStats().pendingShardFailures, 0); // just drained

  rmSync(dir, { recursive: true, force: true });
});
