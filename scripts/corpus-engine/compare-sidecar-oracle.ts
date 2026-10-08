import { isDeepStrictEqual } from "node:util";
import { DerivedSourceSidecarSet, derivedSourceEntryOf, type DerivedSource } from "../../lib/corpus-engine/derived-source";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { comparePreparedSubmissionToCandidate, comparePreparedSubmissionToDerived, prepareSubmissionForVerification } from "../../lib/corpus-engine/prepared-verifier";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { verifyCandidatesWithExistingVerifier } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, readCatalog, type BenchmarkQuery, type CatalogEntry, type ReferenceResult } from "./benchmark-common";
import { logLine, parseArguments, prng, readJson, requireArgument, writeJson } from "./common";

/**
 * The derived-source sidecar against its oracle, the stored text.
 *
 *   compare-sidecar-oracle.ts --root R --generation G --catalog catalog.json --queries queries.json --reference reference.json --out oracle.json
 *
 *   1. ENTRY       for a stratified sample of documents (every dataset and
 *                  language, the shortest and longest, every copied-from
 *                  source and STRICT_SPAN-passing family member of the
 *                  benchmark), the sidecar entry equals what the verifier
 *                  derives from the text: word count, canonical hash, and the
 *                  set of informative shingle hashes.
 *   2. COMPARISON  for every benchmark submission, against its K=250
 *                  candidates, its STRICT_SPAN pairs and a sample of
 *                  documents it does not match, the comparison computed from
 *                  the sidecar is deep-equal to the one computed from the text.
 *   3. END TO END  per submission, retrieval at K=250 then the default
 *                  verification with and without the sidecar: same positions,
 *                  score, sources and family resolutions.
 *
 * Any difference is a failure; there is no tolerance.
 */

const toHexSet = (derived: DerivedSource) => {
  const set = new Set<string>();
  for (let index = 0; index < derived.hi.length; index += 1) set.add(`${derived.hi[index].toString(16).padStart(8, "0")}${derived.lo[index].toString(16).padStart(8, "0")}`);
  return set;
};

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const references = new Map(readJson<{ references: Array<Omit<ReferenceResult, "matchedPositions">> }>(requireArgument(args, "reference")).references.map((reference) => [reference.queryId, reference]));
  const catalog = await readCatalog(requireArgument(args, "catalog"));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const sidecars = await DerivedSourceSidecarSet.open(reader);
  if (sidecars.refusals.length > 0) throw new Error(`sidecar refused: ${JSON.stringify(sidecars.refusals.slice(0, 3))}`);
  const random = prng(20261007);
  const differences: unknown[] = [];
  try {
    // ── 1. entries ──
    const sample = new Map<string, string>();
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of catalog) {
      const key = `${entry.dataset}|${entry.language ?? "?"}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    for (const [key, entries] of groups) {
      entries.sort((left, right) => left.tokenCount - right.tokenCount);
      sample.set(entries[0].docId, `${key} shortest`);
      sample.set(entries[entries.length - 1].docId, `${key} longest`);
      for (let index = 0; index < 40; index += 1) sample.set(entries[Math.floor(random() * entries.length)].docId, key);
    }
    for (const query of queries) {
      for (const source of query.intendedSources) sample.set(source.docId, "copied-from source");
      for (const docId of (references.get(query.id)?.suppressedDocIds ?? []).slice(0, 15)) sample.set(docId, "family member");
    }
    const entryKinds: Record<string, number> = {};
    let entriesCompared = 0;
    for (const [decimal, kind] of sample) {
      const location = reader.locate(docIdFromDecimal(decimal));
      if (!location) continue;
      const fetched = await reader.fetchText(docIdFromDecimal(decimal));
      if (fetched.state !== "OK") throw new Error(`cannot read ${decimal}`);
      const fromText = derivedSourceEntryOf(fetched.text);
      const fromSidecar = await sidecars.read(location);
      if (!fromSidecar) throw new Error(`no sidecar entry for ${decimal}`);
      const sidecarSet = toHexSet(fromSidecar);
      const equal = fromSidecar.wordCount === fromText.wordCount && fromSidecar.canonicalSha256 === fromText.canonicalSha256 && sidecarSet.size === fromText.shingles.size && [...fromText.shingles].every((hash) => sidecarSet.has(hash));
      if (!equal) differences.push({ stage: "entry", docId: decimal, kind });
      entriesCompared += 1;
      const label = kind.replace(/ (shortest|longest)$/, "");
      entryKinds[label] = (entryKinds[label] ?? 0) + 1;
    }
    logLine(`entries: ${entriesCompared} compared, ${differences.length} differences`);

    // ── 2. comparisons, 3. end to end ──
    const all = [...reader.allDocumentIds()];
    let comparisons = 0;
    let matchingComparisons = 0;
    let endToEnd = 0;
    let candidatesFromSidecar = 0;
    for (const query of queries) {
      const prepared = prepareSubmissionForVerification(query.text);
      const retrieval = await retrieveCandidates(reader, query.text, { candidateBudget: 250 });
      const reference = references.get(query.id);
      const documents = new Map<string, bigint>();
      for (const candidate of retrieval.candidates) documents.set(candidate.docIdDecimal, candidate.docId);
      for (const decimal of [...(reference?.admittedDocIds ?? []), ...(reference?.suppressedDocIds ?? []).slice(0, 100)]) documents.set(decimal, docIdFromDecimal(decimal));
      for (let index = 0; index < 20; index += 1) {
        const docId = all[Math.floor(random() * all.length)];
        documents.set(docId.toString(10), docId);
      }
      for (const [decimal, docId] of documents) {
        const location = reader.locate(docId);
        const fetched = await reader.fetchText(docId);
        if (!location || fetched.state !== "OK") throw new Error(`cannot read ${decimal}`);
        const derived = await sidecars.read(location);
        if (!derived) throw new Error(`no sidecar entry for ${decimal}`);
        const fromText = comparePreparedSubmissionToCandidate(prepared, fetched.text);
        const fromSidecar = comparePreparedSubmissionToDerived(prepared, derived, sidecars.identity);
        if (!isDeepStrictEqual(fromText, fromSidecar) || JSON.stringify(fromText) !== JSON.stringify(fromSidecar)) differences.push({ stage: "comparison", queryId: query.id, docId: decimal });
        comparisons += 1;
        if (fromText.matchedPassages.length > 0) matchingComparisons += 1;
      }
      const candidates = retrieval.candidates.map((candidate) => candidate.docId);
      const withText = await verifyCandidatesWithExistingVerifier(reader, query.text, candidates);
      const withSidecar = await verifyCandidatesWithExistingVerifier(reader, query.text, candidates, { sidecars });
      candidatesFromSidecar += withSidecar.totals.candidatesFromSidecar;
      const strip = (result: typeof withText) => ({ state: result.state, matchedPositions: result.matchedPositions, unifiedScore: result.unifiedScore, verifiedSources: result.verifiedSources, familyResolutions: result.familyResolutions, coSourceActivations: result.coSourceActivations, familyGuardActivations: result.familyGuardActivations, candidatesVerified: result.candidatesVerified });
      if (!isDeepStrictEqual(strip(withText), strip(withSidecar))) differences.push({ stage: "end-to-end", queryId: query.id, scoreText: withText.unifiedScore, scoreSidecar: withSidecar.unifiedScore });
      endToEnd += 1;
      logLine(`${query.id.padEnd(28)} ${documents.size} comparisons, end-to-end score ${withText.unifiedScore}/${withSidecar.unifiedScore} (${withSidecar.totals.candidatesFromSidecar}/${candidates.length} from sidecar) — differences so far ${differences.length}`);
    }
    const report = {
      identity: reader.identity(),
      sidecarIdentitySha256: sidecars.identitySha256,
      entries: { compared: entriesCompared, byKind: entryKinds },
      comparisons: { compared: comparisons, withMatchedPassages: matchingComparisons, withoutMatchedPassages: comparisons - matchingComparisons },
      endToEnd: { submissions: endToEnd, candidatesVerifiedFromSidecar: candidatesFromSidecar },
      differences: differences.length,
      differenceDetail: differences.slice(0, 50),
    };
    writeJson(requireArgument(args, "out"), report);
    logLine(`ORACLE: ${entriesCompared} entries, ${comparisons} comparisons (${matchingComparisons} matching), ${endToEnd} end-to-end — ${differences.length} differences`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
