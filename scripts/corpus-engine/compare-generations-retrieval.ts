import { isDeepStrictEqual } from "node:util";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { verifyCandidatesWithExistingVerifier } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, type BenchmarkQuery } from "./benchmark-common";
import { logLine, mean, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * Two generations that hold the SAME documents in a different physical layout
 * (before and after compaction) must answer every query identically.
 *
 *   compare-generations-retrieval.ts --root R --before G1 --after G2 --queries queries.json --out file.json [--budget 500] [--verify-budget 100]
 *
 * Compared per submission: the fused candidate list (document ids in order,
 * weights, hit counts, region support, which list nominated each) and the
 * touched-document and postings counts; then, on the top `--verify-budget`
 * candidates, the verified union and score. Segment ids and ordinals are
 * expected to differ and are not compared. Lookup time is recorded for both,
 * warm, as a by-product: it is the cost of having more segments to ask.
 */

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = requireArgument(args, "root");
  const budget = Number(args.budget ?? 500);
  const verifyBudget = Number(args["verify-budget"] ?? 100);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const before = await openGeneration(root, requireArgument(args, "before"));
  const after = await openGeneration(root, requireArgument(args, "after"));
  const rows: Array<Record<string, unknown>> = [];
  const lookup = { before: [] as number[], after: [] as number[] };
  const ranges = { before: [] as number[], after: [] as number[] };
  try {
    for (const side of [before, after]) for (const query of queries) await retrieveCandidates(side.reader, query.text, { candidateBudget: budget }); // warm both
    for (const query of queries) {
      const first = await retrieveCandidates(before.reader, query.text, { candidateBudget: budget });
      const second = await retrieveCandidates(after.reader, query.text, { candidateBudget: budget });
      lookup.before.push(first.stats.timingsMs.lookup);
      lookup.after.push(second.stats.timingsMs.lookup);
      ranges.before.push(first.stats.indexRangeReads);
      ranges.after.push(second.stats.indexRangeReads);
      const shape = (result: typeof first) => result.candidates.map((candidate) => ({
        rank: candidate.rank, docId: candidate.docIdDecimal, tokenCount: candidate.tokenCount, globalWeight: candidate.globalWeight, fingerprintHits: candidate.fingerprintHits,
        regionsSupported: candidate.regionsSupported, globalRank: candidate.globalRank, bestRegionRank: candidate.bestRegionRank, bestRegion: candidate.bestRegion, nominatedBy: candidate.nominatedBy,
      }));
      const candidatesEqual = isDeepStrictEqual(shape(first), shape(second));
      const statsEqual = first.state === second.state && first.stats.touchedDocuments === second.stats.touchedDocuments && first.stats.postingsDecoded === second.stats.postingsDecoded && first.stats.fingerprintsFound === second.stats.fingerprintsFound;
      const top = (result: typeof first) => result.candidates.slice(0, verifyBudget).map((candidate) => candidate.docId);
      const verifiedBefore = await verifyCandidatesWithExistingVerifier(before.reader, query.text, top(first));
      const verifiedAfter = await verifyCandidatesWithExistingVerifier(after.reader, query.text, top(second));
      const verificationEqual = verifiedBefore.state === verifiedAfter.state && verifiedBefore.unifiedScore === verifiedAfter.unifiedScore
        && isDeepStrictEqual(verifiedBefore.matchedPositions, verifiedAfter.matchedPositions) && isDeepStrictEqual(verifiedBefore.verifiedSources, verifiedAfter.verifiedSources);
      rows.push({ queryId: query.id, candidates: first.candidates.length, candidatesEqual, statsEqual, verificationEqual, score: verifiedBefore.unifiedScore });
      if (!candidatesEqual || !statsEqual || !verificationEqual) logLine(`DIFFERENT: ${query.id} candidates ${candidatesEqual} stats ${statsEqual} verification ${verificationEqual}`);
    }
    const summarize = (values: number[]) => ({ p50: round(percentile(values, 0.5), 3), p95: round(percentile(values, 0.95), 3), mean: round(mean(values), 3) });
    const report = {
      before: { ...before.reader.identity(), activeSegments: before.reader.slots.length, warmLookupMs: summarize(lookup.before), indexRangeReadsPerQuery: summarize(ranges.before) },
      after: { ...after.reader.identity(), activeSegments: after.reader.slots.length, warmLookupMs: summarize(lookup.after), indexRangeReadsPerQuery: summarize(ranges.after) },
      budget, verifyBudget, queries: rows.length,
      queriesWithDifferentCandidates: rows.filter((row) => !row.candidatesEqual || !row.statsEqual).length,
      queriesWithDifferentVerification: rows.filter((row) => !row.verificationEqual).length,
      perQuery: rows,
    };
    writeJson(requireArgument(args, "out"), report);
    logLine(`${rows.length} submissions: ${report.queriesWithDifferentCandidates} with different candidates, ${report.queriesWithDifferentVerification} with different verification`);
    logLine(`warm lookup: ${report.before.activeSegments} segments p50 ${report.before.warmLookupMs.p50} ms / p95 ${report.before.warmLookupMs.p95} ms (${report.before.indexRangeReadsPerQuery.mean} range reads) -> ${report.after.activeSegments} segments p50 ${report.after.warmLookupMs.p50} ms / p95 ${report.after.warmLookupMs.p95} ms (${report.after.indexRangeReadsPerQuery.mean} range reads)`);
    if (report.queriesWithDifferentCandidates + report.queriesWithDifferentVerification > 0) process.exitCode = 2;
  } finally {
    await before.store.close();
    await after.store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
