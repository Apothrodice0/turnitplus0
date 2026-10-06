import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { admitCandidates, createVerifierArtifactView, finalizeVerification, type CandidateAdmission, type VerifierAdapterFailure } from "../../lib/corpus-engine/verifier-adapter";
import { selectiveCorpusSubmissionWords } from "../../lib/selective-corpus/verify";
import { openGeneration, toRanges, verifierPathArgument, type BenchmarkQuery, type ReferenceResult } from "./benchmark-common";
import { logLine, parseArguments, readJson, requireArgument, round, writeJson } from "./common";

/**
 * The EXHAUSTIVE reference: the existing verifier run against EVERY document
 * of the generation, for every benchmark submission.
 *
 *   benchmark-exhaustive.ts --root R --generation G --queries queries.json --out-dir DIR [--workers 10]
 *                           [--verifier-path oracle | prepared-submission]
 *
 * No retrieval is involved. Each worker process takes every N-th document and
 * runs the unmodified admission (admitSelectiveCorpusCandidate, via the same
 * adapter the engine path uses) for every submission; the parent then applies
 * the existing co-source attribution and the existing union/score once per
 * submission. This is only possible because 10k documents is small — it is the
 * yardstick, not a way to serve queries.
 *
 * Nothing is skipped on a shortcut such as "shares no fingerprint": a document
 * is verified whether or not any index says it could match.
 *
 * The reference is the yardstick, so it runs the unmodified admission (verifier
 * path "oracle") unless --verifier-path says otherwise; reference.json records
 * which path produced it.
 */

type WorkerOutput = {
  worker: number;
  documents: number;
  results: Record<string, { admissions: CandidateAdmission[]; failures: VerifierAdapterFailure[]; verified: number; cpuMs: number }>;
};

async function runWorker(args: Record<string, string>) {
  const worker = Number(requireArgument(args, "worker"));
  const workers = Number(requireArgument(args, "workers"));
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    const mine = [...reader.allDocumentIds()].filter((_, index) => index % workers === worker);
    const output: WorkerOutput = { worker, documents: mine.length, results: {} };
    for (const query of queries) {
      const failures: VerifierAdapterFailure[] = [];
      const artifact = createVerifierArtifactView(reader, failures);
      const started = process.cpuUsage();
      const pass = await admitCandidates(reader, query.text, mine, { artifact, failures, submissionWords: selectiveCorpusSubmissionWords(query.text) }, { verifierPath: verifierPathArgument(args, "oracle") });
      const cpu = process.cpuUsage(started);
      output.results[query.id] = {
        // Only documents that reached STRICT_SPAN carry spans worth keeping; the rest are "no match".
        admissions: pass.admissions.filter((admission) => admission.strictSpanPass || admission.outcome !== "NOT_ADMITTED"),
        failures: pass.failures,
        verified: pass.admissions.filter((admission) => admission.outcome === "ADMITTED" || admission.outcome === "NOT_ADMITTED").length,
        cpuMs: (cpu.user + cpu.system) / 1000,
      };
    }
    writeJson(path.join(requireArgument(args, "out-dir"), `exhaustive-worker-${worker}.json`), output);
  } finally {
    await store.close();
  }
}

async function runParent(args: Record<string, string>) {
  const outDirectory = requireArgument(args, "out-dir");
  const workers = Number(args.workers ?? 10);
  const verifierPath = verifierPathArgument(args, "oracle");
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const started = Date.now();
  logLine(`exhaustive reference: ${queries.length} submissions x every document, ${workers} worker processes`);

  await Promise.all(Array.from({ length: workers }, (_, worker) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], [...process.argv.slice(2), "--worker", String(worker), "--workers", String(workers)], { execArgv: process.execArgv });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exhaustive worker ${worker} exited with code ${code}`))));
    child.on("error", reject);
  })));

  const outputs = Array.from({ length: workers }, (_, worker) => {
    const file = path.join(outDirectory, `exhaustive-worker-${worker}.json`);
    if (!existsSync(file)) throw new Error(`missing worker output ${file}`);
    return readJson<WorkerOutput>(file);
  });
  const documents = outputs.reduce((total, output) => total + output.documents, 0);

  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    const references: ReferenceResult[] = [];
    for (const query of queries) {
      const admissions = outputs.flatMap((output) => output.results[query.id].admissions)
        .sort((left, right) => (docIdFromDecimal(left.docId) < docIdFromDecimal(right.docId) ? -1 : 1))
        .map((admission, order) => ({ ...admission, order }));
      const failures = outputs.flatMap((output) => output.results[query.id].failures);
      const verified = outputs.reduce((total, output) => total + output.results[query.id].verified, 0);
      const submissionWordCount = selectiveCorpusSubmissionWords(query.text).length;
      const final = finalizeVerification(reader.identity(), submissionWordCount, admissions, failures, { verifierPath });
      references.push({
        queryId: query.id,
        submissionWordCount,
        documentsVerified: verified,
        admittedDocIds: admissions.filter((admission) => admission.outcome === "ADMITTED").map((admission) => admission.docId),
        suppressedDocIds: admissions.filter((admission) => admission.outcome === "NOT_ADMITTED" && admission.strictSpanPass).map((admission) => admission.docId),
        attributedDocIds: final.verifiedSources.map((source) => source.docId),
        matchedPositions: final.matchedPositions,
        matchedWordCount: final.matchedWordCount,
        unifiedScore: final.unifiedScore,
        failures: final.failures,
        verifyCpuMs: outputs.reduce((total, output) => total + output.results[query.id].cpuMs, 0),
      });
      logLine(`${query.id.padEnd(28)} verified ${verified} docs — admitted ${String(references[references.length - 1].admittedDocIds.length).padStart(3)}, suppressed ${String(references[references.length - 1].suppressedDocIds.length).padStart(3)}, matched ${String(final.matchedWordCount).padStart(5)}/${submissionWordCount} words, score ${final.unifiedScore}%`);
    }
    if (references.some((reference) => reference.documentsVerified !== documents)) throw new Error("a submission was not verified against every document");
    writeJson(path.join(outDirectory, "reference.json"), {
      identity: reader.identity(),
      verifierPath,
      documentsInGeneration: documents,
      workers,
      wallSeconds: round((Date.now() - started) / 1000),
      cpuSeconds: round(references.reduce((total, reference) => total + reference.verifyCpuMs, 0) / 1000),
      references: references.map((reference) => ({ ...reference, matchedPositions: toRanges(reference.matchedPositions) })),
    });
    logLine(`exhaustive reference done: ${documents} documents x ${queries.length} submissions in ${round((Date.now() - started) / 1000)} s wall`);
  } finally {
    await store.close();
  }
}

const args = parseArguments(process.argv.slice(2));
(args.worker !== undefined ? runWorker(args) : runParent(args)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
