import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildSelectiveCorpusPackageIntegrityManifest,
  writeSelectiveCorpusProductionPackage,
  SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS,
} from "../tools/package-selective-corpus-production.ts";
import { parseSelectiveCorpusIntegrityManifest, verifySelectiveCorpusObjectIntegrity } from "../lib/selective-corpus/integrity.ts";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Builds a small, fully synthetic corpus ARTIFACT directory (not a package)
 *  with a caller-chosen shard count and source count -- deliberately NOT
 *  256/9176, so any test asserting on these numbers proves the packaging
 *  code is genuinely generic rather than coincidentally correct for V4. */
function makeSyntheticArtifact(dir, { shardCount, sourceCount }) {
  mkdirSync(join(dir, "packed"), { recursive: true });
  mkdirSync(join(dir, "raw"), { recursive: true });

  writeFileSync(join(dir, "corpus-version.json"), JSON.stringify({ corpusVersion: "selective-corpus-v1", documentCount: sourceCount }, null, 2));
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

  const docmapRows = [];
  for (let i = 0; i < sourceCount; i++) {
    const sourceId = `scb-${String(i + 1).padStart(6, "0")}`;
    const rawId = `bulk:TEST-${i}`;
    docmapRows.push(`${i}\t${sourceId}\tA_wikipedia\t${rawId}\t300\tORDINARY_REFERENCE`);
    writeFileSync(join(dir, "raw", `TEST-${i}.txt`), `synthetic source text for document ${i} `.repeat(20));
  }
  writeFileSync(join(dir, "packed", "docmap.tsv"), docmapRows.join("\n"));

  for (let s = 0; s < shardCount; s++) {
    writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.from([s, s + 1, s + 2]));
  }

  return dir;
}

test("package manifest contains exactly sourceCount + shardCount + 3 entries, generic for any counts (not hardcoded to 9176/256)", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  const SHARD_COUNT = 4; // deliberately small and NOT 256
  const SOURCE_COUNT = 7; // deliberately small and NOT 9176
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: SHARD_COUNT, sourceCount: SOURCE_COUNT });
    const result = writeSelectiveCorpusProductionPackage(artifactDir, packageDir);

    assert.equal(result.shardEntryCount, SHARD_COUNT, "shard entry count must match what is actually on disk, not a hardcoded constant");
    assert.equal(result.sourceEntryCount, SOURCE_COUNT, "source entry count must match the actual docmap row count, not a hardcoded constant");
    assert.equal(result.controlEntryCount, 3, "exactly 3 control/meta entries");
    assert.equal(result.totalEntryCount, SOURCE_COUNT + SHARD_COUNT + 3, "generic count math: total = sourceCount + shardCount + 3");
    assert.equal(SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS.length, 3);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("all 3 control/meta keys are present with correct key/SHA256/byteLength", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: 3, sourceCount: 5 });
    writeSelectiveCorpusProductionPackage(artifactDir, packageDir);

    const manifest = JSON.parse(readFileSync(join(packageDir, "object-integrity.json"), "utf8"));
    const byKey = new Map(manifest.objects.map((o) => [o.key, o]));

    for (const key of SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS) {
      const entry = byKey.get(key);
      assert.ok(entry, `${key} must be present in object-integrity.json`);
      const actualBuf = readFileSync(join(packageDir, ...key.split("/")));
      assert.equal(entry.byteLength, actualBuf.length, `${key} byteLength must match the actual file`);
      assert.equal(entry.sha256, sha256Hex(actualBuf), `${key} sha256 must match the actual file`);
    }
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("object-integrity.json does not list itself", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: 2, sourceCount: 2 });
    writeSelectiveCorpusProductionPackage(artifactDir, packageDir);
    const manifest = JSON.parse(readFileSync(join(packageDir, "object-integrity.json"), "utf8"));
    assert.ok(!manifest.objects.some((o) => o.key === "object-integrity.json"), "the manifest must never list itself");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("audit-only files (build-report.json, cleaning-report.json) are never treated as runtime package objects even when present alongside the artifact", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: 2, sourceCount: 2 });
    writeFileSync(join(artifactDir, "build-report.json"), JSON.stringify({ note: "audit only" }));
    writeFileSync(join(artifactDir, "cleaning-report.json"), JSON.stringify({ note: "audit only" }));
    const result = writeSelectiveCorpusProductionPackage(artifactDir, packageDir);

    assert.equal(result.totalEntryCount, 2 + 2 + 3, "audit files must not inflate the protected-object count");
    const manifest = JSON.parse(readFileSync(join(packageDir, "object-integrity.json"), "utf8"));
    assert.ok(!manifest.objects.some((o) => o.key.includes("build-report.json")));
    assert.ok(!manifest.objects.some((o) => o.key.includes("cleaning-report.json")));
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("writeSelectiveCorpusProductionPackage refuses to overwrite an existing package directory", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: 1, sourceCount: 1 });
    writeSelectiveCorpusProductionPackage(artifactDir, packageDir);
    assert.throws(() => writeSelectiveCorpusProductionPackage(artifactDir, packageDir), /refusing to write over/);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("the generated manifest round-trips through the REAL parser/verifier (parseSelectiveCorpusIntegrityManifest / verifySelectiveCorpusObjectIntegrity), including for the 3 control objects", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: 2, sourceCount: 3 });
    writeSelectiveCorpusProductionPackage(artifactDir, packageDir);

    const manifestBytes = readFileSync(join(packageDir, "object-integrity.json"));
    const parsed = parseSelectiveCorpusIntegrityManifest(manifestBytes);

    for (const key of SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS) {
      const bytes = readFileSync(join(packageDir, ...key.split("/")));
      assert.doesNotThrow(() => verifySelectiveCorpusObjectIntegrity(key, bytes, parsed), `${key} must verify successfully against the real verifier`);
    }
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("buildSelectiveCorpusPackageIntegrityManifest is a pure read (never mutates the package directory)", () => {
  const artifactDir = mkdtempSync(join("D:/tmp", "scb-pkg-artifact-"));
  const packageDir = join(mkdtempSync(join("D:/tmp", "scb-pkg-root-")), "package");
  try {
    makeSyntheticArtifact(artifactDir, { shardCount: 2, sourceCount: 2 });
    writeSelectiveCorpusProductionPackage(artifactDir, packageDir);
    const before = readFileSync(join(packageDir, "packed", "docmap.tsv"), "utf8");
    buildSelectiveCorpusPackageIntegrityManifest(packageDir); // called again, discarding result
    const after = readFileSync(join(packageDir, "packed", "docmap.tsv"), "utf8");
    assert.equal(before, after);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});
