import { runCorpusBuild, type BuildFaultPoint } from "../../lib/corpus-engine/builder";
import { adapterFor, type SourceSpec } from "./checkpoint-sources";
import { logLine, parseArguments, readJson, requireArgument, round, writeJson } from "./common";

/**
 * Builds (or resumes) one corpus generation and writes its counts and metrics.
 *
 *   node --import tsx scripts/corpus-engine/build-checkpoint.ts \
 *     --root D:\TurnitPlusTemp\corpus-engine-v1\corpus-10k --build-id base \
 *     --sources D:\...\base.sources.json --partition-bits 2 --out D:\...\base.build.json
 *
 *   --parent <generationId>       incremental build on top of an existing generation
 *   --run-buffer <tuples>         total tuples buffered before a commit (the memory bound)
 *   --fan-in <n>                  maximum runs merged at once
 *   --keep-build-artifacts        keep runs + staging after the generation is built
 *
 * Interruption, for the recovery checkpoint — the process EXITS HARD (no
 * cleanup, nothing flushed), which is what a kill or a power loss looks like:
 *   --crash-after-sources <n>     exit after the n-th source of this run is staged
 *   --crash-at-segment <p>        exit after partition p's index files are written
 *
 * Re-running the same command without the crash flag resumes from the ledger.
 */

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = requireArgument(args, "root");
  const buildId = requireArgument(args, "build-id");
  const specs = readJson<SourceSpec[]>(requireArgument(args, "sources"));
  const crashAfterSources = args["crash-after-sources"] ? Number(args["crash-after-sources"]) : null;
  const crashAtSegment = args["crash-at-segment"] ? Number(args["crash-at-segment"]) : null;
  let stagedThisRun = 0;

  const startedAt = new Date().toISOString();
  const result = await runCorpusBuild(
    {
      corpusRoot: root,
      buildId,
      parentGenerationId: args.parent ?? null,
      partitionBits: args["partition-bits"] ? Number(args["partition-bits"]) : undefined,
      runBufferTuples: args["run-buffer"] ? Number(args["run-buffer"]) : undefined,
      maxMergeFanIn: args["fan-in"] ? Number(args["fan-in"]) : undefined,
      keepBuildArtifacts: args["keep-build-artifacts"] === "true",
      faultInjection: (point: BuildFaultPoint, context) => {
        if (point === "source-staged") {
          stagedThisRun += 1;
          if (crashAfterSources !== null && stagedThisRun === crashAfterSources) {
            process.stdout.write(`SIMULATED CRASH: hard exit after staging source ${stagedThisRun} of this run (${context.commits} commits durable)\n`);
            process.exit(86);
          }
        }
        if (point === "segment-index-written" && crashAtSegment !== null && context.partition === crashAtSegment) {
          process.stdout.write(`SIMULATED CRASH: hard exit while finalizing the segment of partition ${context.partition}\n`);
          process.exit(86);
        }
      },
      onProgress: (event) => logLine(`${event.phase}: ${event.sourcesSeen} sources seen, ${event.newDocuments} new documents, ${event.commits} commits`),
    },
    specs.map(adapterFor),
  );

  const { manifest, ...summary } = result;
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    arguments: args,
    ...summary,
    generation: {
      documentCount: manifest.documentCount,
      logicalSourceCount: manifest.logicalSourceCount,
      aliasCount: manifest.aliasCount,
      tokenCount: manifest.tokenCount,
      distinctFingerprintCount: manifest.distinctFingerprintCount,
      postingsCount: manifest.postingsCount,
      maxPostingsLength: manifest.maxPostingsLength,
      partitionBits: manifest.partitionBits,
      segmentsPerPartition: manifest.partitions.map((partition) => partition.segmentIds.length),
      processing: manifest.processing,
    },
  };
  if (args.out) writeJson(args.out, report);
  logLine(`generation ${result.generationId} — ${manifest.documentCount} documents, ${manifest.aliasCount} aliases, ${manifest.postingsCount} postings, ${manifest.distinctFingerprintCount} distinct fingerprints`);
  logLine(`this run: ${result.metrics.sourcesCommittedThisRun} sources committed, ${result.metrics.sourcesSkippedAlreadyCommitted} skipped as already committed, resumed=${result.resumed}, segments reused from ledger=${result.segmentsReusedFromLedger}`);
  logLine(`time ${round(result.metrics.timingsMs.total / 1000)} s (${round(result.metrics.documentsPerSecond)} sources/s) — peak RSS ${round(result.metrics.peakRssBytes / 2 ** 20)} MiB — peak temp ${round(result.metrics.peakTemporaryBytes / 2 ** 20)} MiB — peak build disk ${round(result.metrics.peakBuildDiskBytes / 2 ** 20)} MiB`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
