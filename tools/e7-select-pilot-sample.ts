/**
 * Phase E7 — Step 2 CLI: deterministic pilot sample selection.
 *
 * Thin wrapper around lib/e7-pilot-sampling.ts's pure selectPilotSample.
 * Reads public/data/document-index.meta.json (read-only) and writes
 * corpus/e7/pilot-sample.json (gitignored via /corpus/ in .gitignore — this
 * never risks being committed). Never modifies any archive file.
 *
 * Run: node --import tsx tools/e7-select-pilot-sample.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadArchiveIndexMeta } from "../lib/e7-archive-adapter";
import { selectPilotSample } from "../lib/e7-pilot-sampling";

const OUTPUT_PATH = "corpus/e7/pilot-sample.json";
const ALGORITHM_VERSION = "e7-pilot-sample-v1";

function main() {
  const meta = loadArchiveIndexMeta();
  const { cellResults, unfilledCells, sampleDocuments } = selectPilotSample(meta.articles);

  const output = {
    schema: "turnitplus-e7-pilot-sample",
    version: 1,
    algorithmVersion: ALGORITHM_VERSION,
    generatedBy: "tools/e7-select-pilot-sample.ts",
    generatedAt: new Date().toISOString(),
    sourceIndex: {
      path: "public/data/document-index.meta.json",
      corpusVersion: meta.corpusVersion,
      documentCount: meta.documentCount,
    },
    method:
      "Deterministic stratified pick: classify every document into cohort x lengthBucket x " +
      "similarityBucket x titleBucket, then for each of the 16 cells select the member whose " +
      "id sorts lexicographically first. No randomness. See lib/e7-pilot-sampling.ts's file " +
      "header comment for the exact rules.",
    cellCount: cellResults.length,
    unfilledCellCount: unfilledCells.length,
    unfilledCells,
    sampleSize: sampleDocuments.length,
    sampleDocumentIds: sampleDocuments.map((d) => d.id),
    sampleDocuments: sampleDocuments.map((d) => ({
      id: d.id,
      title: d.title,
      sourceType: d.sourceType,
      originalSimilarity: d.originalSimilarity,
      wordCount: d.wordCount,
      uniqueShingleCount: d.uniqueShingleCount,
      cohort: d.cohort,
      lengthBucket: d.lengthBucket,
      similarityBucket: d.similarityBucket,
      titleBucket: d.titleBucket,
    })),
    cellResults: cellResults.map((r) => ({
      ...r.cell,
      relaxedTitleConstraint: r.relaxedTitleConstraint,
      selectedId: r.selected?.id ?? null,
    })),
  };

  mkdirSync("corpus/e7", { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`archive documentCount: ${meta.documentCount} (corpusVersion ${meta.corpusVersion})`);
  console.log(`cells: ${cellResults.length}, unfilled: ${unfilledCells.length}`);
  console.log(`pilot sample size: ${sampleDocuments.length}`);
  for (const doc of sampleDocuments) {
    console.log(
      `  ${doc.id} [${doc.cohort}, ${doc.lengthBucket}, ${doc.similarityBucket}, ${doc.titleBucket}] "${doc.title}"`,
    );
  }
  console.log(`\nwritten to ${OUTPUT_PATH}`);
}

main();
