import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeImportedSimilarityEvidencePackage } from "../scripts/materialize-imported-similarity-evidence.mjs";
import {
  importedSimilarityEvidencePackagePath,
  loadImportedSimilarityEvidencePackage,
  resetImportedSimilarityEvidencePackageCacheForTest,
} from "../lib/imported-similarity-evidence/config.ts";
import { resetImportedSimilarityEvidenceCandidateIndexCacheForTest, resolveImportedSimilarityEvidenceForUnifiedSimilarity } from "../lib/imported-similarity-evidence/index.ts";
import { buildImportedSimilarityEvidencePackageFile, sha256Hex } from "../lib/imported-similarity-evidence/package.ts";
import { IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION, IMPORTED_SIMILARITY_EVIDENCE_MIN_ANCHOR_WINDOW } from "../lib/imported-similarity-evidence/types.ts";
import { IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH } from "../lib/imported-similarity-evidence/materialized-path.ts";
import { tokens } from "../lib/similarity-core.ts";

/**
 * Deterministic tests, NO real network / no live @vercel/blob calls. Every
 * test injects a fake `client` ({get}) — the materializer's only I/O seam —
 * mirroring tests/selective-corpus-vercel-blob.test.mjs's own
 * makeGetResult/streamFromBytes convention. All fixture bytes are tiny
 * synthetic byte strings ("hello world"-class), never real package content.
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

function streamFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeGetResult(bytes) {
  return { statusCode: 200, stream: streamFromBytes(bytes) };
}

function fakeClient(objects) {
  return {
    async get(pathname) {
      const spec = objects[pathname];
      if (!spec) return null;
      if (spec.error) throw spec.error;
      if (spec.bytes === undefined) return null;
      return makeGetResult(spec.bytes);
    },
  };
}

function collectLogs() {
  const lines = [];
  const errorLines = [];
  return {
    log: (msg) => lines.push(msg),
    logError: (msg) => errorLines.push(msg),
    lines,
    errorLines,
  };
}

let workDir;
test.before(() => {
  workDir = mkdtempSync(join(tmpdir(), "imported-evidence-materializer-test-"));
});
test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function freshDest(name) {
  return join(workDir, name, "package.json");
}

const VALID_BLOB_KEY = "imported-similarity-evidence/test-fixture/package.json";
const REAL_BYTES = new TextEncoder().encode("synthetic fixture bytes, not a real package");
const REAL_SHA = sha256Hex_bytes(REAL_BYTES);

function sha256Hex_bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- 1. both absent -> no-op ---------------------------------------------
test("both env vars absent -> not_configured, no-op, nothing written", async () => {
  const dest = freshDest("case1");
  const logs = collectLogs();
  await withEnv(
    { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: undefined, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: undefined },
    async () => {
      const result = await materializeImportedSimilarityEvidencePackage({
        destPath: dest,
        client: fakeClient({}),
        ...logs,
      });
      assert.equal(result.status, "not_configured");
    },
  );
  assert.equal(existsSync(dest), false);
  assert.equal(logs.errorLines.length, 0);
});

// --- 2. blob key only -> configuration error ------------------------------
test("blob key set, SHA unset -> configuration_error, nothing written", async () => {
  const dest = freshDest("case2");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY },
    destPath: dest,
    client: fakeClient({}),
    ...logs,
  });
  assert.equal(result.status, "configuration_error");
  assert.equal(existsSync(dest), false);
  assert.ok(logs.errorLines.some((l) => l.includes("SHA256")));
});

// --- 3. SHA only -> configuration error -----------------------------------
test("SHA set, blob key unset -> configuration_error, nothing written", async () => {
  const dest = freshDest("case3");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA },
    destPath: dest,
    client: fakeClient({}),
    ...logs,
  });
  assert.equal(result.status, "configuration_error");
  assert.equal(existsSync(dest), false);
  assert.ok(logs.errorLines.some((l) => l.includes("BLOB_KEY")));
});

// --- 4. malformed SHA ------------------------------------------------------
test("malformed SHA (not 64 hex chars) -> configuration_error", async () => {
  const dest = freshDest("case4");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: "not-a-real-sha256" },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: REAL_BYTES } }),
    ...logs,
  });
  assert.equal(result.status, "configuration_error");
  assert.equal(result.reason, "malformed_sha256_pin");
  assert.equal(existsSync(dest), false);
});

// --- 5. private Blob not found -> hard failure ----------------------------
test("Blob object not found -> fetch_failed, nothing written", async () => {
  const dest = freshDest("case5");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: "does/not/exist.json", IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA },
    destPath: dest,
    client: fakeClient({}), // no matching key -> get() resolves null
    ...logs,
  });
  assert.equal(result.status, "fetch_failed");
  assert.equal(existsSync(dest), false);
});

test("Blob fetch throws -> fetch_failed, nothing written", async () => {
  const dest = freshDest("case5b");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { error: new Error("simulated network fault") } }),
    ...logs,
  });
  assert.equal(result.status, "fetch_failed");
  assert.equal(existsSync(dest), false);
});

// --- 6. correct bytes + correct SHA -> materialized -----------------------
test("correct bytes + correct SHA -> file materialized, bytes identical", async () => {
  const dest = freshDest("case6");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: REAL_BYTES } }),
    ...logs,
  });
  assert.equal(result.status, "materialized");
  assert.equal(result.byteLength, REAL_BYTES.length);
  assert.equal(result.sha256, REAL_SHA);
  assert.equal(existsSync(dest), true);
  assert.deepEqual(new Uint8Array(readFileSync(dest)), REAL_BYTES);
});

test("SHA pin accepted case-insensitively, normalized to lowercase", async () => {
  const dest = freshDest("case6b");
  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA.toUpperCase() },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: REAL_BYTES } }),
    ...logs,
  });
  assert.equal(result.status, "materialized");
  assert.equal(result.sha256, REAL_SHA);
});

// --- 7. wrong SHA -> hard failure, no usable output -----------------------
test("wrong SHA pin (does not match real bytes) -> hash_mismatch, nothing written", async () => {
  const dest = freshDest("case7");
  const logs = collectLogs();
  const wrongSha = "0".repeat(64);
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: wrongSha },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: REAL_BYTES } }),
    ...logs,
  });
  assert.equal(result.status, "hash_mismatch");
  assert.equal(result.expected, wrongSha);
  assert.equal(result.actual, REAL_SHA);
  assert.equal(existsSync(dest), false);
});

// --- 8. stale pre-existing final file + failed new materialization --------
test("a stale pre-existing output file does NOT survive a failed new materialization", async () => {
  const dest = freshDest("case8");
  mkdirSync(join(workDir, "case8"), { recursive: true });
  const staleBytes = new TextEncoder().encode("stale bytes from a PRIOR successful build");
  writeFileSync(dest, staleBytes);
  assert.equal(existsSync(dest), true);

  const logs = collectLogs();
  const result = await materializeImportedSimilarityEvidencePackage({
    // configured, but this build's fetch will fail
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: "does/not/exist.json", IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA },
    destPath: dest,
    client: fakeClient({}),
    ...logs,
  });
  assert.equal(result.status, "fetch_failed");
  // The critical assertion: the stale file must be GONE, not silently left
  // in place looking valid for this build.
  assert.equal(existsSync(dest), false);
});

test("a stale pre-existing output file is also cleared on a hash mismatch", async () => {
  const dest = freshDest("case8b");
  mkdirSync(join(workDir, "case8b"), { recursive: true });
  writeFileSync(dest, new TextEncoder().encode("stale bytes"));

  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: "0".repeat(64) },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: REAL_BYTES } }),
    ...collectLogs(),
  });
  assert.equal(result.status, "hash_mismatch");
  assert.equal(existsSync(dest), false);
});

// --- 9. nested parent directory creation -----------------------------------
test("nested, not-yet-existing parent directories are created", async () => {
  const dest = join(workDir, "case9", "deeply", "nested", "path", "package.json");
  assert.equal(existsSync(dest), false);
  const result = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: REAL_SHA },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: REAL_BYTES } }),
    ...collectLogs(),
  });
  assert.equal(result.status, "materialized");
  assert.equal(existsSync(dest), true);
});

// --- 10. no package content leaked in logs/errors --------------------------
test("no package content ever appears in logs, including on a hash mismatch", async () => {
  const dest = freshDest("case10");
  const secretLikeBytes = new TextEncoder().encode("THIS-STRING-MUST-NEVER-APPEAR-IN-ANY-LOG-LINE");
  const secretSha = sha256Hex_bytes(secretLikeBytes);
  const logs = collectLogs();

  // Successful path.
  const ok = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: secretSha },
    destPath: dest,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: secretLikeBytes } }),
    ...logs,
  });
  assert.equal(ok.status, "materialized");

  // Mismatch path (fresh dest, wrong pin) -- the case most tempted to log "what we got".
  const dest2 = freshDest("case10b");
  const mismatch = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: VALID_BLOB_KEY, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: "1".repeat(64) },
    destPath: dest2,
    client: fakeClient({ [VALID_BLOB_KEY]: { bytes: secretLikeBytes } }),
    ...logs,
  });
  assert.equal(mismatch.status, "hash_mismatch");

  const allLogText = [...logs.lines, ...logs.errorLines].join("\n");
  assert.ok(!allLogText.includes("THIS-STRING-MUST-NEVER-APPEAR-IN-ANY-LOG-LINE"));
});

// --- Hash-layer distinction (Step 10) ---------------------------------------
test("raw file SHA256 pin is independent of the package's own internal contentSha256", async () => {
  // A tiny, real, VALID package (built with the real production builder --
  // never hand-crafted), so it carries a real, non-trivial internal
  // metadata.contentSha256.
  const evidenceSetId = "set-1";
  const unitRecord = buildSyntheticUnitRecord(evidenceSetId, "the quick brown fox jumps over the lazy dog today");
  const file = buildImportedSimilarityEvidencePackageFile(
    [
      {
        evidenceSetId,
        provenanceType: "TURNITIN_REPORT_IMPORT",
        reportSha256: "a".repeat(64),
        reportedSimilarityPercent: 42,
        normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
        manuscriptIdentitySha256: null,
        createdAt: new Date(0).toISOString(),
        unitCount: 1,
        totalScoreMaskWords: unitRecord.scoreMaskWordCount,
      },
    ],
    [unitRecord],
  );
  const rawFileBytes = new TextEncoder().encode(JSON.stringify(file));
  const rawFileSha256 = sha256Hex_bytes(rawFileBytes);
  const internalContentSha256 = file.metadata.contentSha256;

  // The two hashes are NOT the same value (different inputs: raw file JSON
  // text vs. a canonical stable-key-order serialization of evidenceSets+units
  // only) -- this is the whole point of the distinction.
  assert.notEqual(rawFileSha256, internalContentSha256);

  // The materializer verifies ONLY the raw file hash -- prove it accepts the
  // correct raw-file pin regardless of what the internal contentSha256 is,
  // and REJECTS the internal contentSha256 if someone mistakenly used it as
  // the pin instead.
  const key = "imported-similarity-evidence/hash-layer-fixture/package.json";
  const dest = freshDest("hashlayer-correct");
  const correct = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: key, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: rawFileSha256 },
    destPath: dest,
    client: fakeClient({ [key]: { bytes: rawFileBytes } }),
    ...collectLogs(),
  });
  assert.equal(correct.status, "materialized");

  const dest2 = freshDest("hashlayer-wrong");
  const wrong = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: key, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: internalContentSha256 },
    destPath: dest2,
    client: fakeClient({ [key]: { bytes: rawFileBytes } }),
    ...collectLogs(),
  });
  assert.equal(wrong.status, "hash_mismatch");
  assert.equal(existsSync(dest2), false);
});

// --- helpers for building a tiny, REAL, valid unit record ------------------
function buildSyntheticUnitRecord(evidenceSetId, anchorText) {
  const anchorTokens = tokens(anchorText);
  return {
    evidenceUnitId: "unit-1",
    evidenceSetId,
    provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256: "a".repeat(64),
    reportedSimilarityPercent: 42,
    normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
    sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY",
    sourceMarkerNumbers: [1],
    sourceNames: ["Synthetic Test Source"],
    anchorNormalizedText: anchorText,
    anchorTokenCount: anchorTokens.length,
    anchorTextSha256: sha256Hex(anchorText),
    scoreMaskRelativePositions: anchorTokens.map((_, i) => i),
    scoreMaskWordCount: anchorTokens.length,
    goldSpanIds: [],
    originalManuscriptTokenPositions: anchorTokens.map((_, i) => i),
    originalReportPage: null,
    confidence: "HIGH",
    createdAt: new Date(0).toISOString(),
  };
}

// --- REAL loader integration (Step 9) ---------------------------------------
test("materialized package loads through the REAL, unmodified loader and matches", async () => {
  const anchorText = "synthetic reader-first materializer integration anchor phrase repeated for length " + "padding word ".repeat(20);
  assert.ok(tokens(anchorText).length >= IMPORTED_SIMILARITY_EVIDENCE_MIN_ANCHOR_WINDOW);
  const evidenceSetId = "set-integration";
  const unitRecord = buildSyntheticUnitRecord(evidenceSetId, anchorText);
  const file = buildImportedSimilarityEvidencePackageFile(
    [
      {
        evidenceSetId,
        provenanceType: "TURNITIN_REPORT_IMPORT",
        reportSha256: "b".repeat(64),
        reportedSimilarityPercent: 10,
        normalizationVersion: IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION,
        manuscriptIdentitySha256: null,
        createdAt: new Date(0).toISOString(),
        unitCount: 1,
        totalScoreMaskWords: unitRecord.scoreMaskWordCount,
      },
    ],
    [unitRecord],
  );
  const rawFileBytes = new TextEncoder().encode(JSON.stringify(file));
  const rawFileSha256 = sha256Hex_bytes(rawFileBytes);
  const key = "imported-similarity-evidence/integration-fixture/package.json";
  const dest = freshDest("loader-integration");

  const materializeResult = await materializeImportedSimilarityEvidencePackage({
    env: { IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY: key, IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256: rawFileSha256 },
    destPath: dest,
    client: fakeClient({ [key]: { bytes: rawFileBytes } }),
    ...collectLogs(),
  });
  assert.equal(materializeResult.status, "materialized");

  await withEnv({ IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH: dest }, async () => {
    resetImportedSimilarityEvidencePackageCacheForTest();
    resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
    try {
      assert.equal(importedSimilarityEvidencePackagePath(), dest);

      const state = loadImportedSimilarityEvidencePackage();
      assert.equal(state.status, "loaded");
      assert.equal(state.rejectedUnits.length, 0, "package's own internal integrity validation must run and find nothing wrong");
      assert.equal(state.package.units.length, 1);

      // Candidate lookup works end to end, through the REAL matcher, on a
      // submission that contains the anchor text.
      const submission = "some filler text before. " + anchorText + " and some filler text after.";
      const matches = resolveImportedSimilarityEvidenceForUnifiedSimilarity(submission);
      assert.ok(matches.length >= 1, "expected the real matcher to find the anchor in the submission text");
    } finally {
      resetImportedSimilarityEvidencePackageCacheForTest();
      resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
    }
  });
});

// --- config.ts fallback (tier 2: fixed materialized path) -------------------
test("importedSimilarityEvidencePackagePath() falls back to the fixed materialized path when no explicit override is set", async () => {
  await withEnv({ IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH: undefined }, () => {
    assert.equal(existsSync(IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH), false, "test precondition: nothing already materialized at the real fixed path");
    assert.equal(importedSimilarityEvidencePackagePath(), null, "no explicit override, nothing materialized -> null, today's exact no-package behavior");

    mkdirSync(join(IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH, ".."), { recursive: true });
    writeFileSync(IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH, "{}");
    try {
      assert.equal(importedSimilarityEvidencePackagePath(), IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH);
    } finally {
      rmSync(IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH, { force: true });
    }
    assert.equal(importedSimilarityEvidencePackagePath(), null, "removed again -> back to null");
  });
});

test("an explicit IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH override always wins over the materialized fallback", async () => {
  await withEnv({ IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH: "/some/explicit/override/path.json" }, () => {
    assert.equal(importedSimilarityEvidencePackagePath(), "/some/explicit/override/path.json");
  });
});
