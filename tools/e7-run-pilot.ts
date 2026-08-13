/**
 * Phase E7 — Steps 4-9 CLI: run the controlled pilot in observation mode.
 *
 * For each document in the deterministic pilot sample (lib/e7-pilot-
 * sampling.ts):
 *   1. Resolve full text via lib/e7-archive-adapter.ts's
 *      resolveArchiveDocumentText. If TEXT_UNAVAILABLE (the case for every
 *      document in this checkout — see the E7 pilot report), the document
 *      is recorded as blocked and the pipeline moves on; no discovery,
 *      retrieval, correspondence, or database write happens for it, and no
 *      text is substituted.
 *   2. If text IS available, run it through lib/e7-observation.ts's
 *      runE7ObservationForDocument (E6D observation mode) against an
 *      isolated, run-scoped SQLite database created fresh under corpus/e7/
 *      — never the shared dev/prod database. The isolated DB file is only
 *      created lazily, on the first document that actually has text.
 *
 * This script never calls approveVerification or any function from
 * lib/provenance-verification-workflow.ts (not imported here at all — see
 * tests/e7-observation.test.mjs's structural check), never modifies
 * public/data/document-index*, and never writes to the archive/corpus
 * source files it reads.
 *
 * Run: node --import tsx tools/e7-run-pilot.ts
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest";
import { loadArchiveIndexMeta, resolveArchiveDocumentText } from "../lib/e7-archive-adapter";
import { selectPilotSample } from "../lib/e7-pilot-sampling";
import { createE7ExperimentId, runE7ObservationForDocument, type E7DocumentObservation } from "../lib/e7-observation";

const EXPERIMENT_DIR = "corpus/e7";

type BlockedObservation = {
  experimentId: string;
  documentId: string;
  documentTitle: string;
  documentCohort: string;
  status: "TEXT_UNAVAILABLE";
  reason: string;
};

async function main() {
  const startedAt = Date.now();
  const experimentId = createE7ExperimentId();
  const meta = loadArchiveIndexMeta();
  const { sampleDocuments } = selectPilotSample(meta.articles);

  mkdirSync(EXPERIMENT_DIR, { recursive: true });

  let dbClient: Awaited<ReturnType<typeof createClient>> | null = null;
  let dbFile: string | null = null;

  const observations: Array<E7DocumentObservation | BlockedObservation> = [];
  let textAvailableCount = 0;
  let textUnavailableCount = 0;

  for (const doc of sampleDocuments) {
    const resolved = resolveArchiveDocumentText(doc);
    if (resolved.status === "TEXT_UNAVAILABLE") {
      textUnavailableCount += 1;
      observations.push({
        experimentId,
        documentId: doc.id,
        documentTitle: doc.title,
        documentCohort: doc.cohort,
        status: "TEXT_UNAVAILABLE",
        reason: resolved.reason,
      });
      console.log(`[${doc.id}] TEXT_UNAVAILABLE: ${resolved.reason}`);
      continue;
    }

    textAvailableCount += 1;
    if (!dbClient) {
      dbFile = path.join(EXPERIMENT_DIR, `${experimentId}.db`);
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${dbFile}${suffix}`;
        if (existsSync(candidate)) unlinkSync(candidate);
      }
      dbClient = createClient({ url: `file:${dbFile}` });
      await dbClient.execute("PRAGMA foreign_keys = ON");
      await applyMigrationsLibsql(dbClient, path.join(process.cwd(), "drizzle"));
      console.log(`isolated experiment database created at ${dbFile}`);
    }

    const observation = await runE7ObservationForDocument(dbClient, {
      experimentId,
      metadata: doc,
      documentCohort: doc.cohort,
      submittedText: resolved.submittedText,
    });
    observations.push(observation);
    console.log(`[${doc.id}] ${observation.documentE7Outcome} (${observation.candidatesDiscovered} candidate(s))`);
  }

  if (dbClient) dbClient.close();

  const elapsedMs = Date.now() - startedAt;
  const output = {
    schema: "turnitplus-e7-pilot-run",
    version: 1,
    experimentId,
    generatedBy: "tools/e7-run-pilot.ts",
    generatedAt: new Date().toISOString(),
    elapsedMs,
    sourceIndex: {
      path: "public/data/document-index.meta.json",
      corpusVersion: meta.corpusVersion,
      documentCount: meta.documentCount,
    },
    sampleDocumentCount: sampleDocuments.length,
    textAvailableCount,
    textUnavailableCount,
    isolatedDatabaseFile: dbFile,
    note:
      textAvailableCount === 0
        ? "No document in the pilot sample had locally resolvable full text " +
          "(no corpus/manifest.json in this environment). No discovery, " +
          "retrieval, correspondence, or database write was performed for " +
          "any document — see the E7 pilot report's STOP CONDITION section."
        : undefined,
    observations,
  };

  const outputPath = path.join(EXPERIMENT_DIR, `pilot-run-${experimentId}.json`);
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`\nexperiment: ${experimentId}`);
  console.log(`sample size: ${sampleDocuments.length}, text available: ${textAvailableCount}, text unavailable: ${textUnavailableCount}`);
  console.log(`elapsed: ${elapsedMs}ms`);
  console.log(`written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
