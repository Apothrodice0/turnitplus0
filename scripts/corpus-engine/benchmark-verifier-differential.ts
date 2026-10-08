import { isDeepStrictEqual } from "node:util";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { admitCandidates, createVerifierArtifactView, finalizeVerification, type CandidateAdmission, type VerifierAdapterFailure } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, type BenchmarkQuery } from "./benchmark-common";
import { logLine, parseArguments, readJson, requireArgument, round, writeJson } from "./common";

/**
 * Prepared-submission verifier vs the unmodified RC verifier ("oracle"), pair
 * by pair, on candidates the engine actually retrieves from a real corpus.
 *
 *   benchmark-verifier-differential.ts --root R --generation G --queries queries.json --out diff.json [--budget 300]
 *
 * For every submission the top `--budget` candidates are verified twice, once
 * on each path, and every field of every admission that is not a timing must
 * be deep-equal; so must the final union and score. This is a bounded sample
 * on purpose — the exhaustive equality proof is the test suite's.
 */

const TIMING_FIELDS = ["textReadMs", "textDecodeMs", "verifyMs"] as const;

function semantic(admission: CandidateAdmission) {
  const copy: Record<string, unknown> = { ...admission };
  for (const field of TIMING_FIELDS) delete copy[field];
  return copy;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const budget = Number(args.budget ?? 300);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const rows: Array<Record<string, unknown>> = [];
  const differences: Array<Record<string, unknown>> = [];
  let pairs = 0;
  let oracleMs = 0;
  let preparedMs = 0;
  try {
    for (const query of queries) {
      const retrieval = await retrieveCandidates(reader, query.text, { candidateBudget: budget });
      const candidates = retrieval.candidates.map((candidate) => candidate.docId);
      const run = async (verifierPath: "oracle" | "prepared-submission") => {
        const failures: VerifierAdapterFailure[] = [];
        const pass = await admitCandidates(reader, query.text, candidates, { artifact: createVerifierArtifactView(reader, failures), failures }, { verifierPath });
        return { pass, final: finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures) };
      };
      const oracle = await run("oracle");
      const prepared = await run("prepared-submission");
      let differing = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        pairs += 1;
        oracleMs += oracle.pass.admissions[index].verifyMs;
        preparedMs += prepared.pass.admissions[index].verifyMs;
        if (!isDeepStrictEqual(semantic(oracle.pass.admissions[index]), semantic(prepared.pass.admissions[index]))) {
          differing += 1;
          differences.push({ queryId: query.id, docId: oracle.pass.admissions[index].docId, oracle: semantic(oracle.pass.admissions[index]), prepared: semantic(prepared.pass.admissions[index]) });
        }
      }
      const finalEqual = isDeepStrictEqual(oracle.final.matchedPositions, prepared.final.matchedPositions) && oracle.final.unifiedScore === prepared.final.unifiedScore
        && isDeepStrictEqual(oracle.final.verifiedSources, prepared.final.verifiedSources) && oracle.pass.submissionWordCount === prepared.pass.submissionWordCount;
      if (!finalEqual) differences.push({ queryId: query.id, final: "union, score or attributed sources differ" });
      rows.push({
        queryId: query.id, candidates: candidates.length, differingAdmissions: differing, finalEqual,
        admitted: oracle.pass.admissions.filter((admission) => admission.outcome === "ADMITTED").length,
        strictSpanPass: oracle.pass.admissions.filter((admission) => admission.strictSpanPass).length,
        guardActivated: oracle.pass.admissions.filter((admission) => admission.familyGuardActivated).length,
        score: oracle.final.unifiedScore,
      });
      logLine(`${query.id.padEnd(28)} ${String(candidates.length).padStart(4)} pairs — ${differing} differing, final equal ${finalEqual} (score ${oracle.final.unifiedScore}%)`);
    }
    writeJson(requireArgument(args, "out"), {
      identity: reader.identity(), budget, queries: queries.length, pairsCompared: pairs,
      semanticDifferences: differences.length, differences,
      pairsThatPassStrictSpan: rows.reduce((total, row) => total + (row.strictSpanPass as number), 0),
      pairsWhereTheGuardActivated: rows.reduce((total, row) => total + (row.guardActivated as number), 0),
      perCandidateMs: { oracle: round(oracleMs / pairs, 3), prepared: round(preparedMs / pairs, 3) },
      perQuery: rows,
    });
    logLine(`${pairs} pairs compared, ${differences.length} semantic differences; per candidate ${round(oracleMs / pairs, 2)} ms oracle vs ${round(preparedMs / pairs, 2)} ms prepared`);
    if (differences.length > 0) process.exitCode = 2;
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
