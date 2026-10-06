import { performance } from "node:perf_hooks";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { appendRevocation } from "../../lib/corpus-engine/revocation";
import { verifyCandidatesWithExistingVerifier } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration } from "./benchmark-common";
import { logLine, parseArguments, requireArgument, round, wordsOf, writeJson } from "./common";

/**
 * Cross-generation revocation, demonstrated on the checkpoint corpus.
 *
 *   checkpoint-revocation.ts --root R --generations G1,G2 --doc-id <decimal> --reason "..." --out file.json
 *
 * For every listed generation it shows, BEFORE the revocation, that a
 * submission copying the document retrieves it, fetches its text and verifies
 * against it; then appends ONE entry to the corpus root's revocation list and
 * shows that the same generations — same files, nothing rebuilt — no longer
 * return it, serve its text or score against it. The list lives outside every
 * generation, so this holds for an older generation exactly as for the newest.
 */

async function probe(root: string, generationId: string, docId: bigint, submission: string | null) {
  const opening = performance.now();
  const { store, reader } = await openGeneration(root, generationId);
  const openMs = performance.now() - opening;
  try {
    const text = await reader.fetchText(docId);
    const query = submission ?? (text.state === "OK" ? wordsOf(text.text).slice(20, 420).join(" ") : null);
    if (query === null) return { generationId, openMs: round(openMs, 2), textState: text.state, submission: null as string | null, result: null };
    const retrieval = await retrieveCandidates(reader, query, { candidateBudget: 100 });
    const verification = await verifyCandidatesWithExistingVerifier(reader, query, retrieval.candidates.map((candidate) => candidate.docId));
    const decimal = docId.toString(10);
    return {
      generationId,
      openMs: round(openMs, 2),
      textState: text.state,
      submission: query,
      result: {
        identity: reader.identity(),
        retrievalState: retrieval.state,
        rankOfDocument: retrieval.candidates.find((candidate) => candidate.docIdDecimal === decimal)?.rank ?? null,
        candidates: retrieval.candidates.length,
        verifiedAgainstDocument: verification.verifiedSources.some((source) => source.docId === decimal),
        matchedWords: verification.matchedWordCount,
        score: verification.unifiedScore,
        revokedOrdinalsHeld: reader.slots.reduce((total, slot) => total + slot.revokedOrdinals.size, 0),
        revocationsInList: reader.revocations.size,
      },
    };
  } finally {
    await store.close();
  }
}

type Probe = Awaited<ReturnType<typeof probe>>;

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = requireArgument(args, "root");
  const generations = requireArgument(args, "generations").split(",");
  const docId = docIdFromDecimal(requireArgument(args, "doc-id"));

  const before: Probe[] = [];
  for (const generationId of generations) before.push(await probe(root, generationId, docId, null));
  const submission = before.find((item) => item.submission)?.submission ?? null;
  if (!submission) throw new Error("the document's text could not be read from any listed generation before revocation");

  const entry = appendRevocation(root, { docId, reason: requireArgument(args, "reason"), revokedBy: args.by ?? "corpus-engine-v1 10k checkpoint" });
  logLine(`revoked document ${entry.docId} as sequence ${entry.sequence}`);

  const after: Probe[] = [];
  for (const generationId of generations) after.push(await probe(root, generationId, docId, submission));

  for (let index = 0; index < generations.length; index += 1) {
    logLine(`${generations[index]}: before — rank ${before[index].result?.rankOfDocument}, text ${before[index].textState}, verified ${before[index].result?.verifiedAgainstDocument}, score ${before[index].result?.score}% | after — rank ${after[index].result?.rankOfDocument}, text ${after[index].textState}, verified ${after[index].result?.verifiedAgainstDocument}, score ${after[index].result?.score}%`);
  }
  const strip = (items: Probe[]) => items.map((item) => ({ ...item, submission: undefined }));
  if (args.out) writeJson(args.out, { docId: entry.docId, revocation: entry, submissionWords: wordsOf(submission).length, before: strip(before), after: strip(after) });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
