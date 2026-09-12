import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Selective Corpus PRODUCTION PACKAGING — builds a local, upload-ready package
 * directory (a full copy of a built corpus artifact plus a generated
 * object-integrity.json sidecar) from an artifact produced by
 * tools/build-selective-corpus-production.ts.
 *
 * ESTABLISHED PACKAGE CONTRACT (confirmed against two independently-built,
 * real historical packages found under
 * D:\TurnitPlusTemp\selective-corpus-blob-package\ -- both record
 * "metadataObjectCount": 3 with these exact three keys): the integrity
 * manifest protects THREE kinds of object --
 *   1. every packed shard ("packed/shard-XXX.bin"),
 *   2. every kept source object ("raw/<docId>.txt", one per docmap row),
 *   3. exactly three control/meta objects (SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS).
 * A prior packaging script omitted category 3 entirely -- the 3 control
 * files were copied into the package directory (so they physically existed)
 * but never hashed into object-integrity.json, so lib/selective-corpus/
 * artifact.ts's bootstrap reads of them (corpus-version.json, docmap.tsv,
 * stopset.bin) were never provably tamper-evident the way shard/source reads
 * already are. This module fixes that generically -- it discovers the shard
 * count and source population from whatever is actually on disk, so it is
 * not specific to any one corpus build (V4 or otherwise).
 *
 * object-integrity.json itself is NEVER listed inside its own manifest, and
 * build-audit files (build-report.json, cleaning-report.json) are NEVER
 * treated as runtime package objects -- they are local audit artifacts, the
 * same way the historical packages' own UPLOAD-RECEIPT.json is explicitly
 * documented as "NOT a Blob object... must be excluded by filename from any
 * future bulk upload".
 */

/** The exact 3 control/meta object keys the established package contract
 *  requires alongside shards and source objects. Exported so tests can
 *  assert on this list directly rather than hardcoding it a second time. */
export const SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS = ["corpus-version.json", "packed/docmap.tsv", "packed/stopset.bin"] as const;

export type SelectiveCorpusPackageManifestEntry = { key: string; sha256: string; byteLength: number };
export type SelectiveCorpusPackageManifest = { objects: SelectiveCorpusPackageManifestEntry[] };

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readEntry(packageDir: string, key: string): SelectiveCorpusPackageManifestEntry {
  const buf = readFileSync(join(packageDir, ...key.split("/")));
  return { key, sha256: sha256Hex(buf), byteLength: buf.length };
}

/**
 * Pure(ish) computation over an already-materialized package directory: no
 * network, no mutation of the directory, deterministic given identical
 * bytes on disk. Discovers shards and source objects from what is actually
 * present (packed/shard-*.bin files, packed/docmap.tsv rows) rather than
 * assuming any fixed count, so the SAME function is correct for a 4-shard
 * synthetic test fixture and a real 256-shard corpus alike.
 */
export function buildSelectiveCorpusPackageIntegrityManifest(packageDir: string): SelectiveCorpusPackageManifest {
  const objects: SelectiveCorpusPackageManifestEntry[] = [];

  // 1. shards -- discovered by listing packed/, not a hardcoded count.
  const packedDir = join(packageDir, "packed");
  const shardFileNames = readdirSync(packedDir)
    .filter((name) => /^shard-\d{3}\.bin$/.test(name))
    .sort();
  for (const name of shardFileNames) {
    objects.push(readEntry(packageDir, `packed/${name}`));
  }

  // 2. source objects -- driven by the ACTUAL docmap.tsv rows, never
  // guessed/globbed, so a stray or orphaned raw/ file can never silently
  // gain an integrity entry it should not have.
  const docmapLines = readFileSync(join(packedDir, "docmap.tsv"), "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of docmapLines) {
    const [, , , rawId] = line.split("\t");
    const bareId = rawId.replace(/^bulk:/, "");
    objects.push(readEntry(packageDir, `raw/${bareId}.txt`));
  }

  // 3. control/meta objects -- the fix. Exactly the 3 established keys,
  // never object-integrity.json itself, never audit-only files.
  for (const key of SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS) {
    objects.push(readEntry(packageDir, key));
  }

  return { objects };
}

export type SelectiveCorpusPackageBuildResult = {
  manifest: SelectiveCorpusPackageManifest;
  shardEntryCount: number;
  sourceEntryCount: number;
  controlEntryCount: number;
  totalEntryCount: number;
  totalBytes: number;
  manifestSha256: string;
  manifestByteLength: number;
};

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else copyFileSync(s, d);
  }
}

/**
 * Copies sourceArtifactDir -> packageDir (a brand new directory; never
 * overwrites an existing one) and writes a complete, correct
 * object-integrity.json into it. Never uploads anything -- purely local
 * filesystem output. Never touches sourceArtifactDir except to read it.
 */
export function writeSelectiveCorpusProductionPackage(sourceArtifactDir: string, packageDir: string): SelectiveCorpusPackageBuildResult {
  if (existsSync(packageDir)) {
    throw new Error(`refusing to write over an existing package directory: ${packageDir}`);
  }
  copyDirRecursive(sourceArtifactDir, packageDir);

  const manifest = buildSelectiveCorpusPackageIntegrityManifest(packageDir);
  const shardEntryCount = manifest.objects.filter((o) => /^packed\/shard-\d{3}\.bin$/.test(o.key)).length;
  const sourceEntryCount = manifest.objects.filter((o) => o.key.startsWith("raw/")).length;
  const controlEntryCount = manifest.objects.filter((o) => (SELECTIVE_CORPUS_PACKAGE_CONTROL_OBJECT_KEYS as readonly string[]).includes(o.key)).length;
  const totalBytes = manifest.objects.reduce((s, o) => s + o.byteLength, 0);

  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(join(packageDir, "object-integrity.json"), manifestJson);
  const manifestBuf = Buffer.from(manifestJson, "utf8");

  return {
    manifest,
    shardEntryCount,
    sourceEntryCount,
    controlEntryCount,
    totalEntryCount: manifest.objects.length,
    totalBytes,
    manifestSha256: sha256Hex(manifestBuf),
    manifestByteLength: manifestBuf.length,
  };
}

async function main(): Promise<void> {
  const sourceArtifactDir = process.argv[2];
  const packageDir = process.argv[3];
  if (!sourceArtifactDir || !packageDir) {
    console.error("usage: package-selective-corpus-production.ts <sourceArtifactDir> <packageDir>");
    process.exitCode = 1;
    return;
  }
  console.log(`[package] source: ${sourceArtifactDir}`);
  console.log(`[package] package: ${packageDir}`);
  const result = writeSelectiveCorpusProductionPackage(sourceArtifactDir, packageDir);
  console.log(
    JSON.stringify(
      {
        shardEntryCount: result.shardEntryCount,
        sourceEntryCount: result.sourceEntryCount,
        controlEntryCount: result.controlEntryCount,
        totalEntryCount: result.totalEntryCount,
        totalBytes: result.totalBytes,
        manifestSha256: result.manifestSha256,
        manifestByteLength: result.manifestByteLength,
      },
      null,
      2,
    ),
  );
}

const isMainModule = (() => {
  try {
    return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    console.error("[package] FAILED:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
