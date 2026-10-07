import { fork } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assembleCompactedGeneration, compactPartition, compactPartitionSegment, type CompactedPartitionSegment } from "../../lib/corpus-engine/compaction";
import { loadGenerationManifest, publishGeneration, readActivePointer, segmentPrefix, validateGeneration } from "../../lib/corpus-engine/generation";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { appendRevocation } from "../../lib/corpus-engine/revocation";
import { LocalDirectoryObjectStore } from "../../lib/corpus-engine/storage";
import { logLine, parseArguments, requireArgument, writeJson } from "./common";

/**
 * Corpus root administration for the checkpoint: validate, publish, describe,
 * revoke. Every command names the corpus root and (where relevant) an explicit
 * generation id — none of them acts on "the latest".
 *
 *   admin.ts validate --root R --generation G [--out file]
 *   admin.ts publish  --root R --generation G [--out file]
 *   admin.ts active   --root R
 *   admin.ts describe --root R --generation G [--out file]     storage breakdown + file counts
 *   admin.ts revoke   --root R --doc-id <decimal> --reason "..." [--content-sha256 H]
 *   admin.ts compact  --root R --generation G --partition P       one partition -> one segment, new candidate generation
 *   admin.ts compact-all --root R --generation G --work DIR [--workers 4] [--partitions 0,1]
 *                                                              every multi-segment partition, in parallel -> ONE candidate generation
 */

function classify(file: string): string {
  if (file === "dict.bin") return "fingerprintDictionaryBytes";
  if (file === "dict.idx") return "fingerprintDictionaryBlockIndexBytes";
  if (file === "postings.bin") return "postingsBytes";
  if (file === "docs.bin") return "documentTableBytes";
  if (file === "text.pidx") return "textPackIndexBytes";
  if (/^text-\d+\.pack$/.test(file)) return "textPackBytes";
  if (file === "meta.pidx" || /^meta-\d+\.pack$/.test(file)) return "metadataBytes";
  if (file === "aliases.jsonl") return "aliasAddendaBytes";
  if (file === "segment.json") return "segmentManifestBytes";
  return "otherBytes";
}

async function describe(root: string, generationId: string) {
  const store = new LocalDirectoryObjectStore(root);
  try {
    const { manifest, logicalManifestSha256 } = await loadGenerationManifest(store, generationId);
    const bytes: Record<string, number> = {};
    let segmentFiles = 0;
    for (const segmentId of Object.keys(manifest.segments)) {
      const directory = path.join(root, ...segmentPrefix(segmentId).split("/"));
      for (const file of readdirSync(directory)) {
        const kind = classify(file);
        bytes[kind] = (bytes[kind] ?? 0) + statSync(path.join(directory, file)).size;
        segmentFiles += 1;
      }
    }
    const generationDirectory = path.join(root, "generations", generationId);
    let generationFiles = 0;
    for (const file of readdirSync(generationDirectory)) {
      const size = statSync(path.join(generationDirectory, file)).size;
      if (file === "manifest.json") bytes.generationManifestBytes = size;
      else if (file.startsWith("df-")) bytes.documentFrequencyArtifactBytes = (bytes.documentFrequencyArtifactBytes ?? 0) + size;
      else bytes.buildEventBytes = (bytes.buildEventBytes ?? 0) + size;
      generationFiles += 1;
    }
    const immutable = Object.entries(bytes).filter(([kind]) => kind !== "buildEventBytes").reduce((total, [, size]) => total + size, 0);
    return {
      generationId,
      logicalManifestSha256,
      parentGenerationId: manifest.parentGenerationId,
      documentCount: manifest.documentCount,
      aliasCount: manifest.aliasCount,
      logicalSourceCount: manifest.logicalSourceCount,
      tokenCount: manifest.tokenCount,
      distinctFingerprintCount: manifest.distinctFingerprintCount,
      postingsCount: manifest.postingsCount,
      maxPostingsLength: manifest.maxPostingsLength,
      partitionBits: manifest.partitionBits,
      physicalPartitions: manifest.partitions.length,
      activeSegments: Object.keys(manifest.segments).length,
      segmentsPerPartition: manifest.partitions.map((partition) => partition.segmentIds.length),
      files: { segmentFiles, generationFiles, total: segmentFiles + generationFiles },
      bytes: { ...bytes, totalImmutableBytes: immutable },
      perDocument: {
        postingsBytes: (bytes.postingsBytes ?? 0) / manifest.documentCount,
        dictionaryBytes: ((bytes.fingerprintDictionaryBytes ?? 0) + (bytes.fingerprintDictionaryBlockIndexBytes ?? 0)) / manifest.documentCount,
        textPackBytes: (bytes.textPackBytes ?? 0) / manifest.documentCount,
        totalImmutableBytes: immutable / manifest.documentCount,
      },
      perPosting: {
        postingsBytes: (bytes.postingsBytes ?? 0) / manifest.postingsCount,
        dictionaryBytesPerKey: (bytes.fingerprintDictionaryBytes ?? 0) / manifest.distinctFingerprintCount,
      },
      processing: manifest.processing,
    };
  } finally {
    await store.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArguments(rest);
  const root = requireArgument(args, "root");
  let output: unknown;
  if (command === "validate") {
    const store = new LocalDirectoryObjectStore(root);
    const started = Date.now();
    try {
      const validation = await validateGeneration(store, requireArgument(args, "generation"));
      output = { ...validation, validationMs: Date.now() - started };
      logLine(`validate ${validation.generationId}: ${validation.ok ? "OK" : "FAILED"} — ${validation.checks.filesHashed} files / ${validation.checks.bytesHashed} bytes hashed, ${validation.checks.postingsChecked} postings checked${validation.ok ? "" : ` — ${validation.errors.length} error(s): ${validation.errors.slice(0, 5).join(" | ")}`}`);
    } finally {
      await store.close();
    }
  } else if (command === "publish") {
    const result = await publishGeneration(root, requireArgument(args, "generation"), { note: args.note });
    output = result;
    logLine(result.published
      ? `PUBLISHED ${result.pointer?.generationId} (previous ${result.pointer?.previousGenerationId ?? "none"})`
      : `PUBLICATION REFUSED for ${requireArgument(args, "generation")} — active stays ${result.pointer?.generationId ?? "none"} — ${result.validation.errors.slice(0, 5).join(" | ")}`);
  } else if (command === "active") {
    output = readActivePointer(root);
    logLine(`active: ${JSON.stringify(output)}`);
  } else if (command === "describe") {
    output = await describe(root, requireArgument(args, "generation"));
    logLine(JSON.stringify(output, null, 2));
  } else if (command === "revoke") {
    output = appendRevocation(root, {
      docId: docIdFromDecimal(requireArgument(args, "doc-id")),
      normalizedContentSha256: args["content-sha256"] ?? null,
      reason: requireArgument(args, "reason"),
      revokedBy: args.by ?? null,
    });
    logLine(`revoked: ${JSON.stringify(output)}`);
  } else if (command === "compact") {
    const started = Date.now();
    const { manifest: _manifest, ...result } = await compactPartition({ corpusRoot: root, generationId: requireArgument(args, "generation"), partition: Number(requireArgument(args, "partition")) });
    void _manifest;
    const directoryBytes = (segmentId: string) => {
      const directory = path.join(root, ...segmentPrefix(segmentId).split("/"));
      return readdirSync(directory).reduce((total, file) => total + statSync(path.join(directory, file)).size, 0);
    };
    const outputBytes = directoryBytes(result.compactedSegmentId);
    output = {
      ...result,
      compactionMs: Date.now() - started,
      inputBytes: result.replacedSegmentIds.reduce((total, segmentId) => total + directoryBytes(segmentId), 0),
      outputBytes,
      // The new segment is written into a temporary directory and renamed; nothing else is staged.
      temporaryDiskBytes: outputBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
    logLine(`compacted partition ${result.partition}: ${result.replacedSegmentIds.length} segment(s) -> ${result.compactedSegmentId}; ${result.documentsKept} documents kept, ${result.documentsPhysicallyRemoved} physically removed; candidate generation ${result.generationId}`);
  } else if (command === "compact-segment") {
    // worker of compact-all: one partition's segment, result written for the parent
    const started = Date.now();
    const result = await compactPartitionSegment({ corpusRoot: root, generationId: requireArgument(args, "generation"), partition: Number(requireArgument(args, "partition")) });
    output = { ...result, compactionMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
    logLine(`partition ${result.partition}: ${result.replacedSegmentIds.length} segment(s) -> ${result.compactedSegmentId}, ${result.documentsKept} documents, ${Math.round((Date.now() - started) / 1000)} s`);
  } else if (command === "compact-all") {
    // every partition with more than one segment (or --partitions), --workers at a time, then ONE candidate generation
    const generationId = requireArgument(args, "generation");
    const workDirectory = requireArgument(args, "work");
    const workers = Number(args.workers ?? 4);
    const store = new LocalDirectoryObjectStore(root);
    const { manifest } = await loadGenerationManifest(store, generationId);
    await store.close();
    const partitions = args.partitions
      ? args.partitions.split(",").map(Number)
      : manifest.partitions.filter((entry) => entry.segmentIds.length > 1).map((entry) => entry.partition);
    const started = Date.now();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(workers, partitions.length) }, async () => {
      while (next < partitions.length) {
        const partition = partitions[next];
        next += 1;
        const out = path.join(workDirectory, `compact-p${String(partition).padStart(2, "0")}.json`);
        await new Promise<void>((resolve, reject) => {
          const child = fork(process.argv[1], ["compact-segment", "--root", root, "--generation", generationId, "--partition", String(partition), "--out", out], { execArgv: process.execArgv });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`compaction of partition ${partition} exited with code ${code}`))));
          child.on("error", reject);
        });
      }
    }));
    const segmentsMs = Date.now() - started;
    const results = partitions.map((partition) => JSON.parse(readFileSync(path.join(workDirectory, `compact-p${String(partition).padStart(2, "0")}.json`), "utf8")) as CompactedPartitionSegment & { compactionMs: number; peakRssBytes: number });
    const assembled = await assembleCompactedGeneration({ corpusRoot: root, generationId, compacted: results });
    const directoryBytes = (segmentId: string) => {
      const directory = path.join(root, ...segmentPrefix(segmentId).split("/"));
      return readdirSync(directory).reduce((total, file) => total + statSync(path.join(directory, file)).size, 0);
    };
    output = {
      parentGenerationId: generationId,
      generationId: assembled.generationId,
      logicalManifestSha256: assembled.logicalManifestSha256,
      workers,
      partitions: results.map((result) => ({
        ...result,
        inputBytes: result.replacedSegmentIds.reduce((total, segmentId) => total + directoryBytes(segmentId), 0),
        outputBytes: directoryBytes(result.compactedSegmentId),
      })),
      segmentsWallMs: segmentsMs,
      totalWallMs: Date.now() - started,
    };
    logLine(`compacted ${partitions.length} partition(s) with ${workers} workers in ${Math.round(segmentsMs / 1000)} s (+ ${Math.round((Date.now() - started - segmentsMs) / 1000)} s generation); candidate generation ${assembled.generationId}`);
  } else {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected validate | publish | active | describe | revoke | compact | compact-all`);
  }
  if (args.out) writeJson(args.out, output);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
