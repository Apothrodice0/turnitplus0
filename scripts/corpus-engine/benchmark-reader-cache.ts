import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { openGeneration, type BenchmarkQuery } from "./benchmark-common";
import { logLine, mean, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * The reader's dictionary cache, measured.
 *
 *   benchmark-reader-cache.ts --root R --generation G --queries queries.json --out cache.json [--configs a,b,...] [--passes 5]
 *
 * Every configuration runs in its own fresh process (so RSS is its own):
 *
 *   legacy-default   no dictionary cache; the original per-segment decoded-block LRU (2,048 blocks per segment)
 *   legacy-resident  no dictionary cache; that LRU unbounded — every block a query needs stays decoded (the 100k "resident" reference)
 *   cache-<N>mb      the generation-bound raw-block cache with an N MiB budget
 *
 * Per configuration the 42 submissions are run `passes` times: pass 1 is cold
 * (fresh process, empty engine caches; the OS file cache is not controlled),
 * pass 2 is the first warm pass, passes 3+ are steady warm. Two lookups are
 * timed per submission, each excluding fingerprinting:
 *
 *   candidate lookup   every document sharing a fingerprint, whole-document
 *                      ranking (the metric of the 100k reference-engine study)
 *   K=250 retrieval    the served policy: region-aware, K = 250
 *
 * Correctness: each configuration's candidate lists (ids, ranks, weights,
 * hit counts) are hashed per submission and compared with legacy-default's.
 */

type Sample = { queryId: string; pass: number; candidateLookupMs: number; k250LookupMs: number; signature: string };
type ChildReply = { config: string; openMs: number; samples: Sample[]; rssBytes: number; peakRssBytes: number; heapUsedBytes: number; cache: unknown };

function readerOptions(config: string) {
  if (config === "legacy-default") return { dictionaryCacheBytes: 0 };
  if (config === "legacy-resident") return { dictionaryCacheBytes: 0, dictionaryBlockCacheBlocks: 1 << 30 };
  const match = /^cache-(\d+)mb$/.exec(config);
  if (!match) throw new Error(`unknown configuration ${config}`);
  return { dictionaryCacheBytes: Number(match[1]) * 1024 * 1024 };
}

async function child(args: Record<string, string>) {
  const config = args.child;
  const passes = Number(args.passes ?? 5);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const opening = performance.now();
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"), readerOptions(config));
  const openMs = performance.now() - opening;
  const samples: Sample[] = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    for (const query of queries) {
      const all = await retrieveCandidates(reader, query.text, { candidateBudget: 100_000_000, regionAware: false });
      const served = await retrieveCandidates(reader, query.text, { candidateBudget: 250 });
      const hash = createHash("sha256");
      for (const candidate of [...all.candidates, ...served.candidates]) hash.update(`${candidate.docIdDecimal}:${candidate.rank}:${candidate.globalWeight}:${candidate.fingerprintHits}:${candidate.regionsSupported}:${candidate.nominatedBy};`);
      samples.push({
        queryId: query.id,
        pass,
        candidateLookupMs: all.stats.timingsMs.total - all.stats.timingsMs.fingerprint,
        k250LookupMs: served.stats.timingsMs.total - served.stats.timingsMs.fingerprint,
        signature: hash.digest("hex"),
      });
    }
  }
  if (global.gc) global.gc();
  const memory = process.memoryUsage();
  process.send?.({ config, openMs, samples, rssBytes: memory.rss, peakRssBytes: process.resourceUsage().maxRSS * 1024, heapUsedBytes: memory.heapUsed, cache: reader.dictionaryCache?.stats() ?? null } satisfies ChildReply);
  await store.close();
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.child) return child(args);
  const configs = (args.configs ?? "legacy-default,legacy-resident,cache-64mb,cache-128mb,cache-256mb,cache-512mb").split(",");
  const replies: ChildReply[] = [];
  for (const config of configs) {
    const reply = await new Promise<ChildReply>((resolve, reject) => {
      const forked = fork(process.argv[1], [...process.argv.slice(2), "--child", config], { execArgv: [...process.execArgv, "--expose-gc"] });
      let message: ChildReply | null = null;
      forked.on("message", (value) => {
        message = value as ChildReply;
      });
      forked.on("exit", (code) => (message ? resolve(message) : reject(new Error(`${config} exited with code ${code}`))));
      forked.on("error", reject);
    });
    replies.push(reply);
    const steady = reply.samples.filter((sample) => sample.pass >= 3);
    logLine(`${config.padEnd(16)} steady candidate lookup p50 ${round(percentile(steady.map((sample) => sample.candidateLookupMs), 0.5))} p95 ${round(percentile(steady.map((sample) => sample.candidateLookupMs), 0.95))} ms | K=250 p50 ${round(percentile(steady.map((sample) => sample.k250LookupMs), 0.5))} p95 ${round(percentile(steady.map((sample) => sample.k250LookupMs), 0.95))} ms | RSS ${round(reply.rssBytes / 2 ** 20)} MiB`);
  }
  const baseline = replies.find((reply) => reply.config === "legacy-default") ?? replies[0];
  const baselineSignature = new Map(baseline.samples.map((sample) => [`${sample.queryId}#${sample.pass}`, sample.signature]));
  const stats = (values: number[]) => ({ p50: round(percentile(values, 0.5), 2), p95: round(percentile(values, 0.95), 2), mean: round(mean(values), 2), max: round(Math.max(...values), 2) });
  const results = replies.map((reply) => {
    const phase = (from: number, to: number) => reply.samples.filter((sample) => sample.pass >= from && sample.pass <= to);
    const cache = reply.cache as { hits: number; misses: number } | null;
    return {
      config: reply.config,
      openMs: round(reply.openMs, 1),
      candidateLookupMs: { cold: stats(phase(1, 1).map((sample) => sample.candidateLookupMs)), firstWarm: stats(phase(2, 2).map((sample) => sample.candidateLookupMs)), steadyWarm: stats(phase(3, 99).map((sample) => sample.candidateLookupMs)) },
      k250LookupMs: { cold: stats(phase(1, 1).map((sample) => sample.k250LookupMs)), firstWarm: stats(phase(2, 2).map((sample) => sample.k250LookupMs)), steadyWarm: stats(phase(3, 99).map((sample) => sample.k250LookupMs)) },
      rssBytes: reply.rssBytes,
      peakRssBytes: reply.peakRssBytes,
      heapUsedBytes: reply.heapUsedBytes,
      cache: reply.cache,
      cacheHitRatio: cache && cache.hits + cache.misses > 0 ? round(cache.hits / (cache.hits + cache.misses), 4) : null,
      candidateListDifferencesVsLegacyDefault: reply.samples.filter((sample) => baselineSignature.get(`${sample.queryId}#${sample.pass}`) !== sample.signature).length,
      samples: reply.samples.length,
    };
  });
  writeJson(requireArgument(args, "out"), { generation: requireArgument(args, "generation"), queries: baseline.samples.length / Math.max(...baseline.samples.map((sample) => sample.pass)), results });
  for (const result of results) logLine(JSON.stringify({ ...result, cache: undefined }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
