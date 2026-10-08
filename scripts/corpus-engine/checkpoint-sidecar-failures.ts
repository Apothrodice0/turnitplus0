import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nodeBytes } from "../../lib/corpus-engine/bytes";
import { DerivedSourceSidecarSet } from "../../lib/corpus-engine/derived-source";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { admitCandidates, finalizeVerification } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, type BenchmarkQuery } from "./benchmark-common";
import { logLine, parseArguments, readJson, requireArgument, writeJson } from "./common";

/**
 * Derived-source sidecar failures on a REAL generation, in a throwaway lab root.
 *
 *   checkpoint-sidecar-failures.ts --lab-root R --generation G --queries queries.json --query ID --out file.json
 *
 * `--lab-root` MUST be a lab (prepare-failure-lab.cjs): sidecar files there may be hard links to the real
 * root, so every file this script changes is first DETACHED (copied, the link removed, the copy renamed
 * into place) and every change is undone before the next case. For the sidecar of the segment that holds
 * the query's first known source:
 *
 *   missing sidecar               the segment's sidecar directory is gone
 *   wrong sidecar format          sidecar.json names another format
 *   wrong normalization contract  the recorded identity's normalization differs
 *   wrong source content          the pinned segment.json sha256 differs (the text it was derived from)
 *   wrong semantic identity       the recorded identity's shingle size differs
 *   damaged entry                 the source's derived.bin entry fails its checksum
 *
 * Each case must be refused (or the entry rejected) and the candidate verified from the stored text, with
 * a result identical to the undamaged sidecar's: same positions, score and attributed sources.
 */

function detach(file: string) {
  copyFileSync(file, `${file}.detached`);
  unlinkSync(file);
  renameSync(`${file}.detached`, file);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const lab = requireArgument(args, "lab-root");
  const generationId = requireArgument(args, "generation");
  const query = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries")).queries.find((candidate) => candidate.id === requireArgument(args, "query"));
  if (!query || query.intendedSources.length === 0) throw new Error("the query must exist and name a known source");
  const sourceDocId = query.intendedSources[0].docId;

  const run = async () => {
    const { store, reader } = await openGeneration(lab, generationId);
    try {
      const sidecars = await DerivedSourceSidecarSet.open(reader);
      const retrieval = await retrieveCandidates(reader, query.text, { candidateBudget: 250 });
      const pass = await admitCandidates(reader, query.text, retrieval.candidates.map((candidate) => candidate.docId), undefined, { sidecars });
      const result = finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures, { verifierPath: pass.verifierPath, prepareMs: pass.prepareMs, familyPolicy: pass.familyPolicy });
      const source = pass.admissions.find((admission) => admission.docId === sourceDocId);
      return {
        refusals: sidecars.refusals.map((refusal) => ({ segmentId: refusal.segmentId, code: refusal.code })),
        segmentsServed: sidecars.segmentsServed,
        retrievalState: retrieval.state,
        verificationState: result.state,
        score: result.unifiedScore,
        matchedWords: result.matchedWordCount,
        positions: JSON.stringify(result.matchedPositions),
        sources: result.verifiedSources.map((item) => item.docId).sort().join(","),
        sourceVerifiedFrom: source?.sourceFrom ?? null,
        sourceOutcome: source?.outcome ?? null,
        candidatesFromSidecar: result.totals.candidatesFromSidecar,
        candidates: retrieval.candidates.length,
        location: reader.locate(docIdFromDecimal(sourceDocId)),
      };
    } finally {
      await store.close();
    }
  };

  const baseline = await run();
  if (!baseline.location) throw new Error(`source ${sourceDocId} is not in ${generationId}`);
  const sidecarsRoot = path.join(lab, "sidecars");
  const identityDirectory = readdirSync(sidecarsRoot).find((name) => existsSync(path.join(sidecarsRoot, name, baseline.location!.segmentId)));
  if (!identityDirectory) throw new Error("no sidecar for the source's segment in the lab");
  const directory = path.join(sidecarsRoot, identityDirectory, baseline.location.segmentId);
  const manifestFile = path.join(directory, "sidecar.json");
  logLine(`baseline: ${baseline.segmentsServed} segments served, source verified from ${baseline.sourceVerifiedFrom}, score ${baseline.score}%`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editManifest = async (name: string, edit: (manifest: Record<string, any>) => void) => {
    detach(manifestFile);
    const original = readFileSync(manifestFile);
    const manifest = JSON.parse(nodeBytes(original).toString("utf8"));
    edit(manifest);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    try {
      return { name, ...(await run()) };
    } finally {
      writeFileSync(manifestFile, original);
    }
  };

  const cases: Array<Record<string, unknown>> = [];
  // missing sidecar
  renameSync(directory, `${directory}.hidden`);
  try {
    cases.push({ name: "missing sidecar", ...(await run()) });
  } finally {
    renameSync(`${directory}.hidden`, directory);
  }
  cases.push(await editManifest("wrong sidecar format", (manifest) => { manifest.sidecarFormat = "derived-source-sidecar-v0"; }));
  cases.push(await editManifest("wrong normalization contract", (manifest) => { manifest.identity.normalization = { ...manifest.identity.normalization, version: Number(manifest.identity.normalization?.version ?? 0) + 1 }; }));
  cases.push(await editManifest("wrong source content", (manifest) => { manifest.segmentManifestSha256 = "0".repeat(64); }));
  cases.push(await editManifest("wrong semantic identity", (manifest) => { manifest.identity.shingleSize = Number(manifest.identity.shingleSize ?? 5) + 1; }));
  // damaged entry: flip the bytes of the source's own entry in derived.bin
  {
    const bin = path.join(directory, "derived.bin");
    const index = nodeBytes(readFileSync(path.join(directory, "derived.idx")));
    const row = 16 + baseline.location.ordinal * 64;
    const offset = index.readUIntBE(row + 8, 6);
    detach(bin);
    const original = readFileSync(bin);
    const damaged = Buffer.from(original);
    for (let cursor = offset + 40; cursor < offset + 56 && cursor < damaged.length; cursor += 1) damaged[cursor] ^= 0xff;
    writeFileSync(bin, damaged);
    try {
      cases.push({ name: "damaged entry", ...(await run()) });
    } finally {
      writeFileSync(bin, original);
    }
  }
  const after = await run();

  const sameAsBaseline = (item: Record<string, unknown>) => ["score", "matchedWords", "positions", "sources", "verificationState", "retrievalState"].every((key) => item[key] === (baseline as Record<string, unknown>)[key]);
  const report = {
    generationId,
    queryId: query.id,
    sourceDocId,
    sourceSegment: baseline.location.segmentId,
    baseline: { ...baseline, positions: undefined },
    cases: cases.map((item) => ({
      ...item,
      positions: undefined,
      location: undefined,
      refusedOrRejected: item.name === "damaged entry" ? item.sourceVerifiedFrom === "text" : (item.refusals as Array<{ segmentId: string }>).some((refusal) => refusal.segmentId === baseline.location!.segmentId),
      resultIdenticalToBaseline: sameAsBaseline(item),
    })),
    restoredIdenticalToBaseline: sameAsBaseline(after) && after.refusals.length === baseline.refusals.length && after.sourceVerifiedFrom === baseline.sourceVerifiedFrom,
  };
  (report.cases as Array<Record<string, unknown>>).forEach((item) => logLine(`${String(item.name).padEnd(30)} refusals ${JSON.stringify(item.refusals)} source from ${item.sourceVerifiedFrom} — refused ${item.refusedOrRejected}, identical ${item.resultIdenticalToBaseline}`));
  writeJson(requireArgument(args, "out"), report);
  logLine(`restored identical: ${report.restoredIdenticalToBaseline}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
