import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { prepareSubmissionForVerification } from "../../lib/corpus-engine/prepared-verifier";
import { admitCandidates, createVerifierArtifactView, finalizeVerification, type VerifierAdapterFailure } from "../../lib/corpus-engine/verifier-adapter";
import type { SelectiveCorpusArtifact } from "../../lib/selective-corpus/artifact";
import { SELECTIVE_CORPUS_FAMILY_GUARD, SELECTIVE_CORPUS_STOP_DF } from "../../lib/selective-corpus/constants";
import { winnowWordSpanHashes } from "../../lib/selective-corpus/fingerprint";
import { openGeneration, type BenchmarkQuery, type ReferenceResult } from "./benchmark-common";
import { logLine, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * FAMILY_GUARD, measured — nothing here changes it.
 *
 *   measure-family-guard.ts --root R --generations G1[,G2] --queries queries.json --reference reference.json --out guard.json
 *
 * For every submission, the documents the reference found to pass STRICT_SPAN
 * (admitted, or suppressed by the guard) are verified again under each named
 * generation. STRICT_SPAN depends only on the two texts, so for one
 * (submission, document) pair the ONLY thing a different generation can change
 * is the guard's verdict: which fingerprints are stop fingerprints (df >= 13)
 * and how many documents hold a span (>= 3 suppresses it). A difference
 * between two generations over the same pairs is therefore attributable to the
 * guard and to nothing else.
 *
 * Per pair it also records what the guard saw for the dominant span — the
 * numbers verify.ts computes but does not return. That part restates
 * classifySpanFamily for measurement only; verdicts and scores always come
 * from the verifier itself.
 */

type SpanDiagnostics = { fingerprints: number; stopFingerprints: number; stopFraction: number; holders: number | null; verdict: "stop-share" | "holders" | "too-few-fingerprints" | "not-family" };

async function diagnoseSpan(words: readonly string[], start: number, end: number, artifact: SelectiveCorpusArtifact): Promise<SpanDiagnostics> {
  const hashes = winnowWordSpanHashes(words.slice(start, end + 1));
  if (hashes.length === 0) return { fingerprints: 0, stopFingerprints: 0, stopFraction: 0, holders: null, verdict: "too-few-fingerprints" };
  const nonStop = hashes.filter((hash) => !artifact.stopHashes.has(hash));
  const stopFingerprints = hashes.length - nonStop.length;
  const stopFraction = stopFingerprints / hashes.length;
  if (stopFraction >= SELECTIVE_CORPUS_FAMILY_GUARD.stopFractionBoilerplate) return { fingerprints: hashes.length, stopFingerprints, stopFraction, holders: null, verdict: "stop-share" };
  if (nonStop.length < SELECTIVE_CORPUS_FAMILY_GUARD.minSpanFingerprints) return { fingerprints: hashes.length, stopFingerprints, stopFraction, holders: null, verdict: "too-few-fingerprints" };
  const hitsByDocument = new Map<number, number>();
  for (const hash of nonStop) {
    const postings = await artifact.postingsAccessor.getPostings(hash);
    if (postings) for (const ordinal of postings) hitsByDocument.set(ordinal, (hitsByDocument.get(ordinal) ?? 0) + 1);
  }
  const need = SELECTIVE_CORPUS_FAMILY_GUARD.spanContainmentFraction * nonStop.length;
  let holders = 0;
  for (const count of hitsByDocument.values()) if (count >= need) holders += 1;
  return { fingerprints: hashes.length, stopFingerprints, stopFraction, holders, verdict: holders >= SELECTIVE_CORPUS_FAMILY_GUARD.dominantSpanFamilyDocThreshold ? "holders" : "not-family" };
}

type PairRecord = {
  docId: string;
  outcome: string;
  strictSpanPass: boolean;
  familyGuardActivated: boolean;
  totalMatchedWords: number;
  longestSpan: number;
  dominantSpan: SpanDiagnostics | null;
};

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = requireArgument(args, "root");
  const generations = requireArgument(args, "generations").split(",");
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const referenceFile = readJson<{ references: Array<Omit<ReferenceResult, "matchedPositions">> }>(requireArgument(args, "reference"));
  const references = new Map(referenceFile.references.map((reference) => [reference.queryId, reference]));
  const opened = await Promise.all(generations.map((generationId) => openGeneration(root, generationId)));

  const perQuery: Array<Record<string, unknown>> = [];
  const totals = generations.map((generationId, index) => ({
    generationId,
    documentCount: opened[index].reader.manifest.documentCount,
    pairs: 0, admitted: 0, suppressed: 0, guardActivatedButAdmitted: 0,
    matchedWordsOfSuppressedSources: 0, suppressedPositions: 0, suppressedPositionsNotCoveredByAnAdmittedSource: 0,
    holderCounts: [] as number[], stopFractions: [] as number[], verdicts: {} as Record<string, number>,
  }));
  try {
    for (const query of queries) {
      const reference = references.get(query.id);
      if (!reference) throw new Error(`no reference for ${query.id}`);
      const documents = [...new Set([...reference.admittedDocIds, ...reference.suppressedDocIds])].map(docIdFromDecimal).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const prepared = prepareSubmissionForVerification(query.text);
      const record: Record<string, unknown> = { queryId: query.id, category: query.category, strictSpanDocuments: documents.length, generations: {} };
      const scores: number[] = [];
      for (let index = 0; index < generations.length; index += 1) {
        const { reader } = opened[index];
        const failures: VerifierAdapterFailure[] = [];
        const artifact = createVerifierArtifactView(reader, failures);
        const present = documents.filter((docId) => reader.locate(docId) !== null);
        const pass = await admitCandidates(reader, query.text, present, { artifact, failures, preparedSubmission: prepared });
        const final = finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures);
        const covered = new Set(final.matchedPositions);
        const suppressedPositions = new Set<number>();
        const pairs: PairRecord[] = [];
        for (const admission of pass.admissions) {
          const dominant = admission.strictSpanPass && admission.spans.length > 0 ? await diagnoseSpan(prepared.words, admission.spans[0].start, admission.spans[0].end, artifact) : null;
          pairs.push({ docId: admission.docId, outcome: admission.outcome, strictSpanPass: admission.strictSpanPass, familyGuardActivated: admission.familyGuardActivated, totalMatchedWords: admission.totalMatchedWords, longestSpan: admission.longestSpan, dominantSpan: dominant });
          const total = totals[index];
          if (!admission.strictSpanPass) continue;
          total.pairs += 1;
          if (dominant) {
            total.verdicts[dominant.verdict] = (total.verdicts[dominant.verdict] ?? 0) + 1;
            total.stopFractions.push(dominant.stopFraction);
            if (dominant.holders !== null) total.holderCounts.push(dominant.holders);
          }
          if (admission.outcome === "ADMITTED") {
            total.admitted += 1;
            if (admission.familyGuardActivated) total.guardActivatedButAdmitted += 1;
          } else {
            total.suppressed += 1;
            total.matchedWordsOfSuppressedSources += admission.totalMatchedWords;
            for (const span of admission.spans) for (let position = span.start; position <= span.end; position += 1) suppressedPositions.add(position);
          }
        }
        const uncovered = [...suppressedPositions].filter((position) => !covered.has(position)).length;
        totals[index].suppressedPositions += suppressedPositions.size;
        totals[index].suppressedPositionsNotCoveredByAnAdmittedSource += uncovered;
        scores.push(final.unifiedScore);
        (record.generations as Record<string, unknown>)[generations[index]] = {
          documentsPresent: present.length,
          admitted: pairs.filter((pair) => pair.outcome === "ADMITTED").length,
          suppressed: pairs.filter((pair) => pair.strictSpanPass && pair.outcome !== "ADMITTED").length,
          matchedWords: final.matchedWordCount,
          score: final.unifiedScore,
          suppressedPositions: suppressedPositions.size,
          suppressedPositionsNotCovered: uncovered,
          pairs: pairs.filter((pair) => pair.strictSpanPass),
        };
      }
      if (generations.length === 2) {
        const [first, second] = generations.map((generationId) => (record.generations as Record<string, { pairs: PairRecord[]; matchedWords: number; score: number }>)[generationId]);
        const before = new Map(first.pairs.map((pair) => [pair.docId, pair]));
        record.changedPairs = second.pairs.filter((pair) => before.has(pair.docId) && (before.get(pair.docId) as PairRecord).outcome !== pair.outcome)
          .map((pair) => ({ docId: pair.docId, from: (before.get(pair.docId) as PairRecord).outcome, to: pair.outcome, dominantSpanBefore: (before.get(pair.docId) as PairRecord).dominantSpan, dominantSpanAfter: pair.dominantSpan, matchedWords: pair.totalMatchedWords }));
        record.scoreChange = second.score - first.score;
        record.matchedWordChange = second.matchedWords - first.matchedWords;
      }
      perQuery.push(record);
      logLine(`${query.id.padEnd(28)} ${documents.length} STRICT_SPAN document(s) — score ${scores.join(" -> ")}${generations.length === 2 ? `, ${(record.changedPairs as unknown[]).length} verdict(s) changed` : ""}`);
    }

    const histogram = (values: number[], edges: number[]) => {
      const result: Record<string, number> = {};
      for (let index = 0; index < edges.length; index += 1) {
        const low = edges[index];
        const high = edges[index + 1];
        const label = high === undefined ? `${low}+` : high === low + 1 ? String(low) : `${low}-${high - 1}`;
        result[label] = values.filter((value) => value >= low && (high === undefined || value < high)).length;
      }
      return result;
    };
    const summary = totals.map((total) => ({
      generationId: total.generationId,
      documentCount: total.documentCount,
      strictSpanPairs: total.pairs,
      admitted: total.admitted,
      suppressedByGuard: total.suppressed,
      guardActivatedButAdmitted: total.guardActivatedButAdmitted,
      matchedWordsOfSuppressedSources: total.matchedWordsOfSuppressedSources,
      suppressedPositions: total.suppressedPositions,
      suppressedPositionsNotCoveredByAnAdmittedSource: total.suppressedPositionsNotCoveredByAnAdmittedSource,
      dominantSpanVerdicts: total.verdicts,
      holderCountDistribution: histogram(total.holderCounts, [0, 1, 2, 3, 4, 6, 13, 50]),
      holderCountP50: percentile(total.holderCounts, 0.5),
      holderCountP95: percentile(total.holderCounts, 0.95),
      holderCountMax: total.holderCounts.length > 0 ? Math.max(...total.holderCounts) : null,
      dominantSpanStopShareDistribution: histogram(total.stopFractions.map((value) => Math.floor(value * 100)), [0, 1, 10, 25, 50, 75, 100]),
      dominantSpanStopShareP50: round(percentile(total.stopFractions, 0.5), 3),
      dominantSpanStopShareP95: round(percentile(total.stopFractions, 0.95), 3),
    }));
    const comparison = generations.length === 2 ? {
      queries: perQuery.length,
      queriesWithAVerdictChange: perQuery.filter((record) => (record.changedPairs as unknown[]).length > 0).length,
      verdictChanges: perQuery.reduce((total, record) => total + (record.changedPairs as unknown[]).length, 0),
      queriesWithAScoreChange: perQuery.filter((record) => record.scoreChange !== 0).map((record) => ({ queryId: record.queryId, scoreChange: record.scoreChange, matchedWordChange: record.matchedWordChange })),
      matchedWordChange: perQuery.reduce((total, record) => total + (record.matchedWordChange as number), 0),
    } : null;
    writeJson(requireArgument(args, "out"), {
      constants: { stopDocumentFrequency: SELECTIVE_CORPUS_STOP_DF, familyGuard: SELECTIVE_CORPUS_FAMILY_GUARD },
      summary,
      comparison,
      perQuery,
    });
    for (const row of summary) logLine(JSON.stringify(row));
    if (comparison) logLine(JSON.stringify(comparison));
  } finally {
    for (const { store } of opened) await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
