import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { verifyCandidatesWithExistingVerifier, type VerifierPath } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, verifierPathArgument, type BenchmarkQuery } from "./benchmark-common";
import { logLine, mean, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * Bounded workload / latency profile of retrieval + verification.
 *
 *   benchmark-performance.ts --root R --generation G --queries queries.json --out performance.json [--budget 100]
 *                            [--verifier-path oracle | prepared-submission]
 *
 * The workload is the benchmark's own submissions (300 to ~12,700 words,
 * sources from a few hundred to tens of thousands of words).
 *
 *   cold   one fresh process per submission: open the generation, run it once.
 *          The process and the engine's own caches are cold. The OPERATING
 *          SYSTEM's file cache is not controllable from here and is probably
 *          warm, so "cold" understates a first read from a cold disk or from
 *          object storage.
 *   warm   one process, every submission run once to warm up, then measured.
 *   load   the warm process with a small fixed number of submissions in flight.
 *
 * This is a profile, not a load test.
 *
 * verifierMs is the whole verifier cost of a query: the once-per-query
 * submission preparation (prepareMs; 0 on the oracle path) plus the
 * per-candidate verification summed (candidateVerifyMs).
 */

type Measurement = {
  queryId: string;
  submissionWords: number;
  queryFingerprints: number;
  queryRegions: number;
  candidates: number;
  touchedDocuments: number;
  postingsDecoded: number;
  indexBytesRead: number;
  retrievalState: string;
  verificationState: string;
  fingerprintMs: number;
  lookupMs: number;
  accumulateMs: number;
  mergeMs: number;
  retrievalMs: number;
  textReadMs: number;
  textDecodeMs: number;
  verifierMs: number;
  prepareMs: number;
  candidateVerifyMs: number;
  verificationWallMs: number;
  totalMs: number;
  textCompressedBytesRead: number;
  textDecompressedBytes: number;
  matchedWords: number;
  score: number;
};

async function measure(reader: CorpusGenerationReader, query: BenchmarkQuery, budget: number, verifierPath: VerifierPath): Promise<Measurement> {
  const started = performance.now();
  const retrieval = await retrieveCandidates(reader, query.text, { candidateBudget: budget });
  const retrieved = performance.now();
  const verification = await verifyCandidatesWithExistingVerifier(reader, query.text, retrieval.candidates.map((candidate) => candidate.docId), { verifierPath });
  const finished = performance.now();
  return {
    queryId: query.id,
    submissionWords: retrieval.stats.queryTokenCount,
    queryFingerprints: retrieval.stats.queryFingerprints,
    queryRegions: retrieval.stats.queryRegions,
    candidates: retrieval.candidates.length,
    touchedDocuments: retrieval.stats.touchedDocuments,
    postingsDecoded: retrieval.stats.postingsDecoded,
    indexBytesRead: retrieval.stats.indexBytesRead,
    retrievalState: retrieval.state,
    verificationState: verification.state,
    fingerprintMs: retrieval.stats.timingsMs.fingerprint,
    lookupMs: retrieval.stats.timingsMs.lookup,
    accumulateMs: retrieval.stats.timingsMs.accumulate,
    mergeMs: retrieval.stats.timingsMs.merge,
    retrievalMs: retrieved - started,
    textReadMs: verification.totals.textReadMs,
    textDecodeMs: verification.totals.textDecodeMs,
    verifierMs: verification.totals.prepareMs + verification.totals.verifyMs,
    prepareMs: verification.totals.prepareMs,
    candidateVerifyMs: verification.totals.verifyMs,
    verificationWallMs: finished - retrieved,
    totalMs: finished - started,
    textCompressedBytesRead: verification.totals.textCompressedBytesRead,
    textDecompressedBytes: verification.totals.textDecompressedBytes,
    matchedWords: verification.matchedWordCount,
    score: verification.unifiedScore,
  };
}

const TIMED_FIELDS = ["totalMs", "retrievalMs", "fingerprintMs", "lookupMs", "accumulateMs", "mergeMs", "textReadMs", "textDecodeMs", "verifierMs", "prepareMs", "candidateVerifyMs"] as const;

function summarize(samples: readonly Measurement[]) {
  const result: Record<string, unknown> = { samples: samples.length };
  for (const field of TIMED_FIELDS) {
    const values = samples.map((sample) => sample[field]);
    result[field] = { p50: round(percentile(values, 0.5), 3), p95: round(percentile(values, 0.95), 3), mean: round(mean(values), 3), max: round(Math.max(...values), 3) };
  }
  for (const field of ["touchedDocuments", "candidates", "postingsDecoded", "indexBytesRead", "textCompressedBytesRead", "textDecompressedBytes"] as const) {
    const values = samples.map((sample) => sample[field]);
    result[field] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
  }
  const withCandidates = samples.filter((sample) => sample.candidates > 0);
  result.perCandidate = {
    textCompressedBytesRead: round(mean(withCandidates.map((sample) => sample.textCompressedBytesRead / sample.candidates))),
    textDecompressedBytes: round(mean(withCandidates.map((sample) => sample.textDecompressedBytes / sample.candidates))),
    textReadMs: round(mean(withCandidates.map((sample) => sample.textReadMs / sample.candidates)), 4),
    textDecodeMs: round(mean(withCandidates.map((sample) => sample.textDecodeMs / sample.candidates)), 4),
    verifierMs: round(mean(withCandidates.map((sample) => sample.verifierMs / sample.candidates)), 3),
    candidateVerifyMs: round(mean(withCandidates.map((sample) => sample.candidateVerifyMs / sample.candidates)), 3),
  };
  return result;
}

async function coldChild(args: Record<string, string>) {
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const query = queries.find((candidate) => candidate.id === args["cold-child"]);
  if (!query) throw new Error(`unknown query ${args["cold-child"]}`);
  const opening = performance.now();
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const openMs = performance.now() - opening;
  const measurement = await measure(reader, query, Number(args.budget ?? 100), verifierPathArgument(args));
  await store.close();
  process.send?.({ openMs, measurement, rssBytes: process.memoryUsage.rss() });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args["cold-child"]) return coldChild(args);
  const budget = Number(args.budget ?? 100);
  const verifierPath = verifierPathArgument(args);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));

  // ── cold: one fresh process per submission ──
  const cold: Measurement[] = [];
  const openTimes: number[] = [];
  const coldRss: number[] = [];
  for (const query of queries) {
    const reply = await new Promise<{ openMs: number; measurement: Measurement; rssBytes: number }>((resolve, reject) => {
      const child = fork(process.argv[1], [...process.argv.slice(2), "--cold-child", query.id], { execArgv: process.execArgv });
      let message: { openMs: number; measurement: Measurement; rssBytes: number } | null = null;
      child.on("message", (value) => {
        message = value as { openMs: number; measurement: Measurement; rssBytes: number };
      });
      child.on("exit", (code) => (message ? resolve(message) : reject(new Error(`cold run of ${query.id} exited with code ${code} and no result`))));
      child.on("error", reject);
    });
    cold.push(reply.measurement);
    openTimes.push(reply.openMs);
    coldRss.push(reply.rssBytes);
  }
  logLine(`cold: ${cold.length} fresh processes — total p50 ${round(percentile(cold.map((sample) => sample.totalMs), 0.5))} ms, p95 ${round(percentile(cold.map((sample) => sample.totalMs), 0.95))} ms; generation open p50 ${round(percentile(openTimes, 0.5))} ms`);

  // ── warm: one process ──
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    for (const query of queries) await measure(reader, query, budget, verifierPath);
    const warm: Measurement[] = [];
    for (let repetition = 0; repetition < 3; repetition += 1) for (const query of queries) warm.push(await measure(reader, query, budget, verifierPath));
    logLine(`verifier path: ${verifierPath}`);
    logLine(`warm: ${warm.length} runs — total p50 ${round(percentile(warm.map((sample) => sample.totalMs), 0.5))} ms, p95 ${round(percentile(warm.map((sample) => sample.totalMs), 0.95))} ms`);

    // ── a larger budget, warm, one pass: how the cost moves with K ──
    const warmLarge: Measurement[] = [];
    for (const query of queries) warmLarge.push(await measure(reader, query, 500, verifierPath));

    // ── load: a small fixed number in flight ──
    const concurrency = Number(args.concurrency ?? 4);
    const pending = [...queries, ...queries];
    const loaded: Measurement[] = [];
    const loadStarted = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const query = pending.shift();
        if (!query) return;
        loaded.push(await measure(reader, query, budget, verifierPath));
      }
    }));
    const loadSeconds = (performance.now() - loadStarted) / 1000;

    const documentCount = reader.manifest.documentCount;
    const heaviest = [...warm].sort((left, right) => right.touchedDocuments - left.touchedDocuments)[0];
    writeJson(requireArgument(args, "out"), {
      identity: reader.identity(),
      verifierPath,
      budget,
      documentCount,
      workload: { submissions: queries.length, wordsMin: Math.min(...warm.map((sample) => sample.submissionWords)), wordsMax: Math.max(...warm.map((sample) => sample.submissionWords)), wordsP50: percentile(warm.map((sample) => sample.submissionWords), 0.5) },
      cold: { note: "fresh process per submission; engine caches cold; OS file cache not controlled (probably warm)", generationOpenMs: { p50: round(percentile(openTimes, 0.5), 2), p95: round(percentile(openTimes, 0.95), 2) }, processRssBytes: { p50: percentile(coldRss, 0.5), max: Math.max(...coldRss) }, ...summarize(cold) },
      warm: summarize(warm),
      warmAtBudget500: summarize(warmLarge),
      load: { concurrency, submissions: loaded.length, wallSeconds: round(loadSeconds), submissionsPerSecond: round(loaded.length / loadSeconds), ...summarize(loaded) },
      scaleSignals: {
        heaviestQuery: heaviest.queryId,
        maxTouchedDocuments: heaviest.touchedDocuments,
        maxTouchedShareOfCorpus: round(heaviest.touchedDocuments / documentCount, 4),
        maxCandidatesFetched: Math.max(...warm.map((sample) => sample.candidates)),
        maxCandidatesShareOfCorpus: round(Math.max(...warm.map((sample) => sample.candidates)) / documentCount, 4),
        maxTextDecompressedBytes: Math.max(...warm.map((sample) => sample.textDecompressedBytes)),
      },
      warmProcessRssBytes: process.memoryUsage.rss(),
      perQueryWarm: queries.map((query) => {
        const samples = warm.filter((sample) => sample.queryId === query.id);
        return { ...samples[0], totalMs: round(percentile(samples.map((sample) => sample.totalMs), 0.5), 2), retrievalMs: round(percentile(samples.map((sample) => sample.retrievalMs), 0.5), 2), verifierMs: round(percentile(samples.map((sample) => sample.verifierMs), 0.5), 2), prepareMs: round(percentile(samples.map((sample) => sample.prepareMs), 0.5), 2), candidateVerifyMs: round(percentile(samples.map((sample) => sample.candidateVerifyMs), 0.5), 2) };
      }),
      perQueryCold: cold,
    });
    logLine(`load: ${loaded.length} submissions at concurrency ${concurrency} in ${round(loadSeconds)} s — p50 ${round(percentile(loaded.map((sample) => sample.totalMs), 0.5))} ms, p95 ${round(percentile(loaded.map((sample) => sample.totalMs), 0.95))} ms`);
    logLine(`heaviest query ${heaviest.queryId}: touched ${heaviest.touchedDocuments} of ${documentCount} documents (${round((heaviest.touchedDocuments / documentCount) * 100, 2)}%)`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
