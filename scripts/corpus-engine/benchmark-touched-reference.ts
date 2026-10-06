import { fork } from "node:child_process";
import path from "node:path";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { admitCandidates, createVerifierArtifactView, finalizeVerification, type VerifierAdapterFailure } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, toRanges, verifierPathArgument, type BenchmarkQuery, type ReferenceResult } from "./benchmark-common";
import { logLine, parseArguments, readJson, requireArgument, round, writeJson } from "./common";

/**
 * The ALL-TOUCHED reference: for every submission, the verifier is run against
 * every document that shares at least one fingerprint with it — however many
 * that is, with no candidate budget and no ranking.
 *
 *   benchmark-touched-reference.ts --root R --generation G --queries queries.json --out-dir DIR [--workers 8]
 *
 * It is what a retrieval layer with an unlimited budget would hand to the
 * verifier, so comparing a budgeted retrieval against it isolates exactly the
 * loss the budget and the ranking cause. It is NOT the exhaustive reference: a
 * document that shares no fingerprint with the submission is never verified
 * here. Whether such a document can still be admitted is what the (much more
 * expensive) exhaustive sample answers; this reference exists because that
 * sample cannot be run for forty submissions against 100k documents.
 *
 * The output has the shape of the exhaustive reference.json, so
 * benchmark-engine.ts reads either; `referenceKind` says which it is.
 */

type WorkerOutput = { worker: number; references: Array<ReferenceResult & { touchedDocuments: number; wallMs: number }> };

async function runWorker(args: Record<string, string>) {
  const worker = Number(requireArgument(args, "worker"));
  const workers = Number(requireArgument(args, "workers"));
  const verifierPath = verifierPathArgument(args);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const output: WorkerOutput = { worker, references: [] };
  try {
    for (let index = worker; index < queries.length; index += workers) {
      const query = queries[index];
      const started = Date.now();
      const cpuStarted = process.cpuUsage();
      const retrieval = await retrieveCandidates(reader, query.text, { regionAware: false, candidateBudget: 100_000_000 });
      if (retrieval.state !== "COMPLETE") throw new Error(`retrieval for ${query.id} was ${retrieval.state}`);
      const touched = retrieval.candidates.map((candidate) => candidate.docId).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const failures: VerifierAdapterFailure[] = [];
      const artifact = createVerifierArtifactView(reader, failures);
      const pass = await admitCandidates(reader, query.text, touched, { artifact, failures }, { verifierPath });
      const final = finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures, { verifierPath });
      const cpu = process.cpuUsage(cpuStarted);
      output.references.push({
        queryId: query.id,
        submissionWordCount: pass.submissionWordCount,
        documentsVerified: pass.admissions.filter((admission) => admission.outcome === "ADMITTED" || admission.outcome === "NOT_ADMITTED").length,
        admittedDocIds: pass.admissions.filter((admission) => admission.outcome === "ADMITTED").map((admission) => admission.docId),
        suppressedDocIds: pass.admissions.filter((admission) => admission.outcome === "NOT_ADMITTED" && admission.strictSpanPass).map((admission) => admission.docId),
        attributedDocIds: final.verifiedSources.map((source) => source.docId),
        matchedPositions: final.matchedPositions,
        matchedWordCount: final.matchedWordCount,
        unifiedScore: final.unifiedScore,
        failures: final.failures,
        verifyCpuMs: (cpu.user + cpu.system) / 1000,
        touchedDocuments: touched.length,
        wallMs: Date.now() - started,
      });
    }
    writeJson(path.join(requireArgument(args, "out-dir"), `touched-worker-${worker}.json`), output);
  } finally {
    await store.close();
  }
}

async function runParent(args: Record<string, string>) {
  const outDirectory = requireArgument(args, "out-dir");
  const workers = Number(args.workers ?? 8);
  const verifierPath = verifierPathArgument(args);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const started = Date.now();
  logLine(`all-touched reference: ${queries.length} submissions, ${workers} worker processes`);
  await Promise.all(Array.from({ length: workers }, (_, worker) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], [...process.argv.slice(2), "--worker", String(worker), "--workers", String(workers)], { execArgv: process.execArgv });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${worker} exited with code ${code}`))));
    child.on("error", reject);
  })));
  const byId = new Map(Array.from({ length: workers }, (_, worker) => readJson<WorkerOutput>(path.join(outDirectory, `touched-worker-${worker}.json`)).references).flat().map((reference) => [reference.queryId, reference]));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    const references = queries.map((query) => {
      const reference = byId.get(query.id);
      if (!reference) throw new Error(`no worker produced a reference for ${query.id}`);
      const intended = new Set(query.intendedSources.map((source) => source.docId));
      const admitted = new Set(reference.admittedDocIds);
      logLine(`${query.id.padEnd(28)} touched ${String(reference.touchedDocuments).padStart(6)} docs — admitted ${String(reference.admittedDocIds.length).padStart(3)} (intended ${[...intended].filter((docId) => admitted.has(docId)).length}/${intended.size}), suppressed ${String(reference.suppressedDocIds.length).padStart(3)}, matched ${String(reference.matchedWordCount).padStart(5)}/${reference.submissionWordCount} words, score ${reference.unifiedScore}% — ${round(reference.wallMs / 1000, 1)} s`);
      return { ...reference, matchedPositions: toRanges(reference.matchedPositions) };
    });
    writeJson(path.join(outDirectory, "reference.json"), {
      identity: reader.identity(),
      referenceKind: "all-touched-documents",
      verifierPath,
      documentsInGeneration: reader.manifest.documentCount,
      workers,
      wallSeconds: round((Date.now() - started) / 1000),
      cpuSeconds: round(references.reduce((total, reference) => total + reference.verifyCpuMs, 0) / 1000),
      references,
    });
    logLine(`all-touched reference done: ${references.reduce((total, reference) => total + reference.documentsVerified, 0)} verifications in ${round((Date.now() - started) / 1000)} s wall`);
  } finally {
    await store.close();
  }
}

const args = parseArguments(process.argv.slice(2));
(args.worker !== undefined ? runWorker(args) : runParent(args)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
