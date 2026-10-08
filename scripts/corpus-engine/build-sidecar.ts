import { fork } from "node:child_process";
import path from "node:path";
import { buildSegmentSidecar, derivedSourceIdentity, derivedSourceIdentitySha256, DerivedSourceSidecarSet, type SidecarBuildResult } from "../../lib/corpus-engine/derived-source";
import type { ScoringNormalizationVersion } from "../../lib/similarity-core";
import { openGeneration } from "./benchmark-common";
import { logLine, parseArguments, readJson, requireArgument, round, writeJson } from "./common";

/**
 * Builds the derived-source sidecar (derived-source-sidecar-v1) of every
 * segment of a generation, from the stored text.
 *
 *   build-sidecar.ts --root R --generation G --out build.json [--workers 6]
 *
 * Segments are shared out between worker processes; each segment is written to
 * a temporary directory and renamed into place, and one that already has a
 * sidecar of the same identity is skipped, so the build can be re-run after an
 * interruption. Nothing in the generation or its segments is touched.
 */

async function worker(args: Record<string, string>) {
  const index = Number(args.worker);
  const workers = Number(args.workers);
  const root = requireArgument(args, "root");
  const { store, reader } = await openGeneration(root, requireArgument(args, "generation"));
  const results: SidecarBuildResult[] = [];
  try {
    const segmentIds = reader.slots.map((slot) => slot.segmentId);
    for (let cursor = index; cursor < segmentIds.length; cursor += workers) {
      const started = performance.now();
      const result = await buildSegmentSidecar(root, reader, segmentIds[cursor]);
      results.push(result);
      logLine(`worker ${index}: ${result.segmentId} ${result.documents} documents, ${round(result.bytes / 2 ** 20)} MiB${result.skipped ? " (already built)" : ""} in ${round((performance.now() - started) / 1000)} s`);
    }
  } finally {
    await store.close();
  }
  writeJson(path.join(requireArgument(args, "work"), `sidecar-worker-${index}.json`), results);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.worker !== undefined) return worker(args);
  const workers = Number(args.workers ?? 6);
  const work = path.join(path.dirname(requireArgument(args, "out")), "sidecar-build-work");
  const started = performance.now();
  await Promise.all(Array.from({ length: workers }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], [...process.argv.slice(2), "--worker", String(index), "--workers", String(workers), "--work", work], { execArgv: process.execArgv });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${index} exited with code ${code}`))));
    child.on("error", reject);
  })));
  const wallMs = performance.now() - started;
  const results = Array.from({ length: workers }, (_, index) => readJson<SidecarBuildResult[]>(path.join(work, `sidecar-worker-${index}.json`))).flat();
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    const identity = derivedSourceIdentity(reader.manifest.processing.normalization.version as ScoringNormalizationVersion);
    const opened = await DerivedSourceSidecarSet.open(reader);
    const documents = results.reduce((total, result) => total + result.documents, 0);
    const bytes = results.reduce((total, result) => total + result.bytes, 0);
    const shingles = results.reduce((total, result) => total + result.shingles, 0);
    const deriveMs = results.reduce((total, result) => total + result.deriveMs, 0);
    const report = {
      identity: reader.identity(),
      sidecarIdentity: identity,
      sidecarIdentitySha256: derivedSourceIdentitySha256(identity),
      segments: results.length,
      segmentsServedAfterOpen: opened.segmentsServed,
      refusalsAfterOpen: opened.refusals,
      documents,
      bytes,
      bytesPerDocument: round(bytes / documents),
      shinglesPerDocument: round(shingles / documents),
      projectedBytesFor1MDocuments: Math.round((bytes / documents) * 1_000_000),
      deriveCpuSeconds: round(deriveMs / 1000),
      wallSeconds: round(wallMs / 1000),
      workers,
      perSegment: results,
    };
    writeJson(requireArgument(args, "out"), report);
    logLine(`${documents} documents in ${results.length} segments: ${round(bytes / 2 ** 30, 3)} GiB (${report.bytesPerDocument} B/document), derive ${report.deriveCpuSeconds} CPU-s, ${report.wallSeconds} s wall; ${opened.segmentsServed} segments served on open, ${opened.refusals.length} refused`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
