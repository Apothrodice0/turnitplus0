import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { publishGeneration, readActivePointer, validateGeneration } from "../../lib/corpus-engine/generation";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { appendRevocation } from "../../lib/corpus-engine/revocation";
import { LocalDirectoryObjectStore } from "../../lib/corpus-engine/storage";
import { verifyCandidatesWithExistingVerifier } from "../../lib/corpus-engine/verifier-adapter";
import type { BenchmarkQuery } from "./benchmark-common";
import { logLine, parseArguments, readJson, requireArgument, writeJson } from "./common";

/**
 * Failure semantics on REAL damage, in a throwaway copy of a corpus root.
 *
 *   checkpoint-failure-semantics.ts --lab-root R --generation G --previous-generation G0 \
 *       --queries queries.json --query exact-pmc --revoke-query duplicate-alias-en --out file.json
 *
 * `--lab-root` MUST be a copy: this script renames and overwrites files in it
 * (and puts each one back before the next case). For one submission whose
 * source document is known it damages the segment that holds that document:
 *
 *   missing segment       the segment directory is gone
 *   corrupt segment       2% of its dictionary is overwritten with zeros (same size)
 *   missing text pack     at open, and again after the reader is already open
 *
 * and, for a second submission whose source exists in both generations:
 *
 *   revocation            one list entry; then the previous generation is
 *                         re-activated (a rollback) and the document must stay gone
 *
 * Each case records what retrieval and verification REPORTED. The requirement
 * is that none of them reports COMPLETE while part of the corpus was not
 * searched or a candidate's text was not read, and that the damaged generation
 * is refused by publication validation.
 */

type Outcome = {
  retrievalState: string;
  retrievalFailures: Array<{ segmentId: string | null; phase: string; artifact: string; code: string }>;
  verificationState: string;
  verificationFailures: Array<{ stage: string; segmentId: string | null; code: string }>;
  candidates: number;
  rankOfSource: number | null;
  verifiedAgainstSource: boolean;
  matchedWords: number;
  score: number;
};

async function run(root: string, generationId: string, query: BenchmarkQuery, sourceDocId: string, hooks: { afterOpen?: () => void; useActivePointer?: boolean } = {}): Promise<Outcome & { generationServed: string }> {
  const store = new LocalDirectoryObjectStore(root);
  try {
    const pointer = hooks.useActivePointer ? readActivePointer(root) : null;
    const reader = await CorpusGenerationReader.open({ store, generationId: pointer?.generationId ?? generationId, revocationAnchor: pointer?.revocationAnchor ?? null });
    hooks.afterOpen?.();
    const retrieval = await retrieveCandidates(reader, query.text, { candidateBudget: 100 });
    const verification = await verifyCandidatesWithExistingVerifier(reader, query.text, retrieval.candidates.map((candidate) => candidate.docId));
    const failures = new Map<string, { stage: string; segmentId: string | null; code: string }>();
    for (const failure of verification.failures) failures.set(`${failure.stage}|${failure.segmentId}|${failure.code}`, { stage: failure.stage, segmentId: failure.segmentId, code: failure.code });
    return {
      generationServed: reader.generationId,
      retrievalState: retrieval.state,
      retrievalFailures: retrieval.failures.map((failure) => ({ segmentId: failure.segmentId, phase: failure.phase, artifact: failure.artifact, code: failure.code })),
      verificationState: verification.state,
      verificationFailures: [...failures.values()],
      candidates: retrieval.candidates.length,
      rankOfSource: retrieval.candidates.find((candidate) => candidate.docIdDecimal === sourceDocId)?.rank ?? null,
      verifiedAgainstSource: verification.verifiedSources.some((source) => source.docId === sourceDocId),
      matchedWords: verification.matchedWordCount,
      score: verification.unifiedScore,
    };
  } finally {
    await store.close();
  }
}

async function validation(root: string, generationId: string) {
  const store = new LocalDirectoryObjectStore(root);
  try {
    const result = await validateGeneration(store, generationId);
    return { ok: result.ok, errors: result.errors.slice(0, 3), errorCount: result.errors.length };
  } finally {
    await store.close();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = requireArgument(args, "lab-root");
  if (!/lab/i.test(path.basename(root))) throw new Error("--lab-root must name a throwaway copy (its folder name must contain \"lab\"); this script damages files");
  const generationId = requireArgument(args, "generation");
  const previousGenerationId = requireArgument(args, "previous-generation");
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const query = queries.find((candidate) => candidate.id === requireArgument(args, "query"));
  const revokeQuery = queries.find((candidate) => candidate.id === requireArgument(args, "revoke-query"));
  if (!query || !revokeQuery) throw new Error("--query / --revoke-query must name submissions of the query file");
  const sourceDocId = query.intendedSources[0].docId;

  const store = new LocalDirectoryObjectStore(root);
  const located = (await CorpusGenerationReader.open({ store, generationId })).locate(docIdFromDecimal(sourceDocId));
  await store.close();
  if (!located) throw new Error("the submission's source document is not in the generation");
  const segmentDirectory = path.join(root, "segments", located.segmentId);
  const report: Record<string, unknown> = { labRoot: root, generationId, query: query.id, sourceDocId, sourceSegment: located.segmentId, sourcePartition: located.partition };
  const say = (label: string, outcome: Outcome) => logLine(`${label.padEnd(34)} retrieval ${outcome.retrievalState.padEnd(8)} verification ${outcome.verificationState.padEnd(8)} source rank ${String(outcome.rankOfSource).padEnd(4)} verified ${String(outcome.verifiedAgainstSource).padEnd(5)} score ${outcome.score}%`);

  const baseline = await run(root, generationId, query, sourceDocId);
  report.baseline = baseline;
  say("baseline", baseline);

  // ── missing segment ──
  renameSync(segmentDirectory, `${segmentDirectory}.hidden`);
  try {
    const outcome = await run(root, generationId, query, sourceDocId);
    report.missingSegment = { ...outcome, publicationValidation: await validation(root, generationId) };
    say("missing segment", outcome);
  } finally {
    renameSync(`${segmentDirectory}.hidden`, segmentDirectory);
  }

  // ── corrupt segment: 2% of the dictionary zeroed in place (the size, which is all a reader checks at open, is unchanged) ──
  const dictionary = path.join(segmentDirectory, "dict.bin");
  const length = Math.floor(statSync(dictionary).size * 0.02);
  const offset = Math.floor(statSync(dictionary).size * 0.49);
  const original = Buffer.allocUnsafe(length);
  let descriptor = openSync(dictionary, "r+");
  readSync(descriptor, original, 0, length, offset);
  writeSync(descriptor, Buffer.alloc(length), 0, length, offset);
  closeSync(descriptor);
  try {
    const outcome = await run(root, generationId, query, sourceDocId);
    report.corruptSegment = { bytesOverwritten: length, atOffset: offset, ...outcome, publicationValidation: await validation(root, generationId) };
    say("corrupt segment (dictionary)", outcome);
  } finally {
    descriptor = openSync(dictionary, "r+");
    writeSync(descriptor, original, 0, length, offset);
    closeSync(descriptor);
  }

  // ── missing text pack ──
  const pack = path.join(segmentDirectory, "text-0000.pack");
  renameSync(pack, `${pack}.hidden`);
  try {
    const outcome = await run(root, generationId, query, sourceDocId);
    report.missingTextPackAtOpen = { ...outcome, publicationValidation: await validation(root, generationId) };
    say("missing text pack (at open)", outcome);
  } finally {
    renameSync(`${pack}.hidden`, pack);
  }
  try {
    const outcome = await run(root, generationId, query, sourceDocId, { afterOpen: () => renameSync(pack, `${pack}.hidden`) });
    report.missingTextPackWhileServing = outcome;
    say("text pack lost while serving", outcome);
  } finally {
    if (existsSync(`${pack}.hidden`)) renameSync(`${pack}.hidden`, pack);
  }

  const restored = await run(root, generationId, query, sourceDocId);
  report.afterRestore = { ...restored, identicalToBaseline: JSON.stringify(restored) === JSON.stringify(baseline), publicationValidation: await validation(root, generationId) };
  say("everything restored", restored);

  // ── revocation, and a rollback ──
  const revokedDocId = revokeQuery.intendedSources[0].docId;
  const revocation: Record<string, unknown> = { query: revokeQuery.id, docId: revokedDocId };
  revocation.before = { [generationId]: await run(root, generationId, revokeQuery, revokedDocId), [previousGenerationId]: await run(root, previousGenerationId, revokeQuery, revokedDocId) };
  await publishGeneration(root, generationId, { note: "failure-semantics lab: current generation active" });
  const entry = appendRevocation(root, { docId: docIdFromDecimal(revokedDocId), reason: "100k checkpoint: revocation and rollback demonstration (lab copy)", revokedBy: "corpus-engine-v1 100k checkpoint" });
  revocation.entry = entry;
  revocation.after = { [generationId]: await run(root, generationId, revokeQuery, revokedDocId), [previousGenerationId]: await run(root, previousGenerationId, revokeQuery, revokedDocId) };
  const rollback = await publishGeneration(root, previousGenerationId, { note: "failure-semantics lab: rollback to the previous generation" });
  revocation.rollback = { published: rollback.published, active: rollback.pointer?.generationId, revocationAnchorSequence: rollback.pointer?.revocationAnchor.sequence };
  revocation.afterRollbackServingActive = await run(root, previousGenerationId, revokeQuery, revokedDocId, { useActivePointer: true });
  const forward = await publishGeneration(root, generationId, { note: "failure-semantics lab: roll forward again" });
  revocation.rollForward = { published: forward.published, active: forward.pointer?.generationId };
  revocation.afterRollForwardServingActive = await run(root, generationId, revokeQuery, revokedDocId, { useActivePointer: true });
  report.revocation = revocation;
  for (const [label, outcome] of [
    [`before, ${generationId.slice(0, 12)}`, (revocation.before as Record<string, Outcome>)[generationId]], [`before, ${previousGenerationId.slice(0, 12)}`, (revocation.before as Record<string, Outcome>)[previousGenerationId]],
    [`revoked, ${generationId.slice(0, 12)}`, (revocation.after as Record<string, Outcome>)[generationId]], [`revoked, ${previousGenerationId.slice(0, 12)}`, (revocation.after as Record<string, Outcome>)[previousGenerationId]],
    ["after rollback (ACTIVE)", revocation.afterRollbackServingActive as Outcome], ["after roll forward (ACTIVE)", revocation.afterRollForwardServingActive as Outcome],
  ] as Array<[string, Outcome]>) say(label, outcome);

  const incomplete = [report.missingSegment, report.corruptSegment, report.missingTextPackAtOpen, report.missingTextPackWhileServing] as Outcome[];
  report.verdict = {
    noDamagedCaseReportedComplete: incomplete.every((outcome) => outcome.retrievalState !== "COMPLETE" || outcome.verificationState !== "COMPLETE"),
    damagedGenerationRefusedByValidation: [report.missingSegment, report.corruptSegment, report.missingTextPackAtOpen].every((outcome) => (outcome as { publicationValidation: { ok: boolean } }).publicationValidation.ok === false),
    revokedDocumentAbsentEverywhere: [(revocation.after as Record<string, Outcome>)[generationId], (revocation.after as Record<string, Outcome>)[previousGenerationId], revocation.afterRollbackServingActive as Outcome, revocation.afterRollForwardServingActive as Outcome]
      .every((outcome) => outcome.rankOfSource === null && !outcome.verifiedAgainstSource),
    restoredIdenticalToBaseline: (report.afterRestore as { identicalToBaseline: boolean }).identicalToBaseline,
  };
  logLine(`verdict ${JSON.stringify(report.verdict)}`);
  writeJson(requireArgument(args, "out"), report);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
