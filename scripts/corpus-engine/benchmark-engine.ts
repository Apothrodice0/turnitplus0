import { DerivedSourceSidecarSet } from "../../lib/corpus-engine/derived-source";
import { computeQueryFingerprints, documentFingerprintHexes, normalizeForCorpus } from "../../lib/corpus-engine/fingerprints";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { prepareSubmissionForVerification } from "../../lib/corpus-engine/prepared-verifier";
import { retrieveCandidates, type CandidateRankingPolicy } from "../../lib/corpus-engine/retrieval";
import { admitCandidates, createVerifierArtifactView, finalizeVerification, type CandidateAdmission, type VerifierAdapterFailure } from "../../lib/corpus-engine/verifier-adapter";
import { selectiveCorpusSubmissionWords } from "../../lib/selective-corpus/verify";
import { fromRanges, openGeneration, verifierPathArgument, type BenchmarkQuery, type ReferenceResult } from "./benchmark-common";
import { logLine, mean, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * Engine retrieval -> existing verifier, compared with the exhaustive reference.
 *
 *   benchmark-engine.ts --root R --generation G --queries queries.json --reference reference.json --out engine.json
 *                       [--verifier-path oracle | prepared-submission] [--sidecars] [--variants a,b]
 *
 * The family admission policy is the engine's default; compare against a
 * reference computed under the same policy (compare-family-policies.ts
 * --out-references). --sidecars verifies from the derived-source sidecar
 * (same results, faster); --variants limits the ranking variants run.
 *
 * For every submission and every candidate budget K it reports whether
 * retrieval changed what the existing verifier concludes:
 *
 *   expected-source recall       were the documents the text was copied from retrieved
 *   contributing-source recall   were the documents the EXHAUSTIVE run admitted retrieved
 *   matched-word coverage        engine union as a share of the exhaustive union
 *   union difference             positions the exhaustive run matched and the engine did not (and the reverse)
 *   score difference             engine unifiedScore minus exhaustive unifiedScore
 *
 * A candidate's verification does not depend on how it was retrieved, so each
 * (submission, document) pair is verified once and reused across variants and
 * budgets.
 *
 * --verifier-path selects the admission implementation (default: the engine's).
 * Apart from the recorded path and the retrieval timings, the output of a run
 * on each path must be identical.
 */

const BUDGETS = [50, 100, 250, 500];
const MAX_BUDGET = 500;

const VARIANTS: Array<{ id: string; description: string; policy: Partial<CandidateRankingPolicy> }> = [
  { id: "region-aware", description: "candidate-ranking-v1 defaults: global list + per-region lists, no suppression", policy: {} },
  { id: "global-only", description: "whole-document rarity-weighted ranking only (region lists off)", policy: { regionAware: false } },
  { id: "region-aware-df256", description: "region-aware; fingerprints with corpus df > 256 do not nominate", policy: { maxDiscoveryDocumentFrequency: 256 } },
  { id: "region-aware-df64", description: "region-aware; fingerprints with corpus df > 64 do not nominate", policy: { maxDiscoveryDocumentFrequency: 64 } },
  { id: "region-aware-df12", description: "region-aware; fingerprints with corpus df > 12 do not nominate (the verifier's stop df - 1)", policy: { maxDiscoveryDocumentFrequency: 12 } },
];

type Comparison = {
  k: number;
  candidates: number;
  intendedRetrieved: number;
  intendedTotal: number;
  /** Intended sources that the exhaustive reference admits — the ones that matter to the score. */
  admissibleIntendedRetrieved: number;
  admissibleIntendedTotal: number;
  contributingRetrieved: number;
  contributingTotal: number;
  engineAdmitted: number;
  matchedWords: number;
  referenceMatchedWords: number;
  coverage: number;
  missingPositions: number;
  extraPositions: number;
  score: number;
  referenceScore: number;
  scoreDifference: number;
  verificationState: string;
};

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const verifierPath = verifierPathArgument(args);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const referenceFile = readJson<{ identity: { generationId: string; logicalManifestSha256: string }; references: Array<Omit<ReferenceResult, "matchedPositions"> & { matchedPositions: Array<[number, number]> }> }>(requireArgument(args, "reference"));
  const references = new Map(referenceFile.references.map((reference) => [reference.queryId, { ...reference, matchedPositions: fromRanges(reference.matchedPositions) }]));
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const sidecars = args.sidecars === "true" ? await DerivedSourceSidecarSet.open(reader) : null;
  if (sidecars && sidecars.refusals.length > 0) throw new Error(`sidecars refused: ${JSON.stringify(sidecars.refusals.slice(0, 3))}`);
  const variants = args.variants ? VARIANTS.filter((variant) => args.variants.split(",").includes(variant.id)) : VARIANTS;
  if (reader.generationId !== referenceFile.identity.generationId || reader.logicalManifestSha256 !== referenceFile.identity.logicalManifestSha256) {
    throw new Error("the reference was computed for a different generation");
  }

  const perQuery: Array<Record<string, unknown>> = [];
  const rows: Array<{ queryId: string; category: string; language: string; expectation: string; variant: string; comparison: Comparison }> = [];
  const retrievalStats: Array<Record<string, unknown>> = [];
  const misses: Array<Record<string, unknown>> = [];

  try {
    for (const query of queries) {
      const reference = references.get(query.id);
      if (!reference) throw new Error(`no exhaustive reference for ${query.id}`);
      const referencePositions = new Set(reference.matchedPositions);
      const contributing = new Set(reference.admittedDocIds);
      const intended = new Set(query.intendedSources.map((source) => source.docId));
      const admissibleIntended = new Set([...intended].filter((docId) => contributing.has(docId)));
      const submissionWords = selectiveCorpusSubmissionWords(query.text);
      const failures: VerifierAdapterFailure[] = [];
      const artifact = createVerifierArtifactView(reader, failures);
      // one preparation per submission, shared by every pass over it
      const preparedSubmission = verifierPath === "prepared-submission" ? prepareSubmissionForVerification(query.text) : undefined;
      const cache = new Map<string, CandidateAdmission>();
      const queryRecord: Record<string, unknown> = {
        id: query.id, category: query.category, language: query.language, expectation: query.expectation, description: query.description,
        submissionWords: submissionWords.length, intendedSources: query.intendedSources,
        reference: { admitted: reference.admittedDocIds.length, suppressed: reference.suppressedDocIds.length, matchedWords: reference.matchedWordCount, score: reference.unifiedScore },
        variants: {},
      };

      for (const variant of variants) {
        const retrieval = await retrieveCandidates(reader, query.text, { ...variant.policy, candidateBudget: MAX_BUDGET });
        const missing = retrieval.candidates.filter((candidate) => !cache.has(candidate.docIdDecimal)).map((candidate) => candidate.docId);
        if (missing.length > 0) {
          const pass = await admitCandidates(reader, query.text, missing, { artifact, failures, submissionWords, preparedSubmission }, { verifierPath, sidecars });
          for (const admission of pass.admissions) cache.set(admission.docId, admission);
        }
        retrievalStats.push({ queryId: query.id, variant: variant.id, state: retrieval.state, candidates: retrieval.candidates.length, ...retrieval.stats });

        const comparisons: Comparison[] = [];
        for (const k of BUDGETS) {
          const top = retrieval.candidates.slice(0, k);
          const topIds = new Set(top.map((candidate) => candidate.docIdDecimal));
          const admissions = top.map((candidate, order) => ({ ...(cache.get(candidate.docIdDecimal) as CandidateAdmission), order }));
          const final = finalizeVerification(reader.identity(), submissionWords.length, admissions, failures, { verifierPath });
          const enginePositions = new Set(final.matchedPositions);
          let shared = 0;
          for (const position of enginePositions) if (referencePositions.has(position)) shared += 1;
          const comparison: Comparison = {
            k,
            candidates: top.length,
            intendedRetrieved: [...intended].filter((docId) => topIds.has(docId)).length,
            intendedTotal: intended.size,
            admissibleIntendedRetrieved: [...admissibleIntended].filter((docId) => topIds.has(docId)).length,
            admissibleIntendedTotal: admissibleIntended.size,
            contributingRetrieved: [...contributing].filter((docId) => topIds.has(docId)).length,
            contributingTotal: contributing.size,
            engineAdmitted: admissions.filter((admission) => admission.outcome === "ADMITTED").length,
            matchedWords: final.matchedWordCount,
            referenceMatchedWords: reference.matchedWordCount,
            coverage: referencePositions.size === 0 ? 1 : shared / referencePositions.size,
            missingPositions: referencePositions.size - shared,
            extraPositions: enginePositions.size - shared,
            score: final.unifiedScore,
            referenceScore: reference.unifiedScore,
            scoreDifference: final.unifiedScore - reference.unifiedScore,
            verificationState: final.state,
          };
          comparisons.push(comparison);
          rows.push({ queryId: query.id, category: query.category, language: query.language, expectation: query.expectation, variant: variant.id, comparison });
        }
        (queryRecord.variants as Record<string, unknown>)[variant.id] = {
          retrievalState: retrieval.state,
          touchedDocuments: retrieval.stats.touchedDocuments,
          candidates: retrieval.candidates.length,
          fingerprintsSuppressed: retrieval.stats.fingerprintsSuppressed,
          comparisons,
          intendedRanks: query.intendedSources.map((source) => ({
            docId: source.docId, words: source.words, normalizedWords: source.normalizedWords, edit: source.edit,
            rank: retrieval.candidates.find((candidate) => candidate.docIdDecimal === source.docId)?.rank ?? null,
            admittedByReference: contributing.has(source.docId),
          })),
        };

        // Every contributing source the default policy did not return within the largest budget is explained.
        if (variant.id === "region-aware") {
          const returned = new Set(retrieval.candidates.map((candidate) => candidate.docIdDecimal));
          const lost = [...contributing].filter((docId) => !returned.has(docId));
          if (lost.length > 0) {
            const deep = await retrieveCandidates(reader, query.text, { candidateBudget: 100_000, regionListDepth: 100_000 });
            const queryFingerprints = new Set(computeQueryFingerprints(query.text, deep.rankingPolicy.regionWords).fingerprints.map((fingerprint) => fingerprint.hex));
            for (const docId of lost) {
              const fetched = await reader.fetchText(docIdFromDecimal(docId));
              const sharedFingerprints = fetched.state === "OK"
                ? documentFingerprintHexes(normalizeForCorpus(fetched.text).tokens).filter((hex) => queryFingerprints.has(hex)).length
                : -1;
              const deepCandidate = deep.candidates.find((candidate) => candidate.docIdDecimal === docId);
              misses.push({
                queryId: query.id, docId, intended: intended.has(docId), sharedFingerprints,
                unboundedRank: deepCandidate?.rank ?? null, globalRank: deepCandidate?.globalRank ?? null, bestRegionRank: deepCandidate?.bestRegionRank ?? null,
                admission: cache.get(docId) ?? null,
              });
            }
          }
        }
      }
      perQuery.push(queryRecord);
      const at = (variant: string, k: number) => rows.find((row) => row.queryId === query.id && row.variant === variant && row.comparison.k === k)?.comparison as Comparison;
      const best = at("region-aware", 500);
      logLine(`${query.id.padEnd(28)} ref ${String(reference.matchedWordCount).padStart(5)}w ${String(reference.unifiedScore).padStart(3)}% | region-aware@50/100/250/500 coverage ${BUDGETS.map((k) => at("region-aware", k).coverage.toFixed(3)).join("/")} score diff ${BUDGETS.map((k) => at("region-aware", k).scoreDifference).join("/")} | contributing ${best.contributingRetrieved}/${best.contributingTotal} ${at("global-only", 50) ? `| global-only@50 cov ${at("global-only", 50).coverage.toFixed(3)}` : ""}`);
    }

    // ── aggregates ──────────────────────────────────────────────────────────
    const summary: Array<Record<string, unknown>> = [];
    for (const variant of variants) {
      for (const k of BUDGETS) {
        const selected = rows.filter((row) => row.variant === variant.id && row.comparison.k === k).map((row) => ({ ...row.comparison, queryId: row.queryId, expectation: row.expectation }));
        const sum = (field: keyof Comparison) => selected.reduce((total, item) => total + (item[field] as number), 0);
        const withIntended = selected.filter((item) => item.intendedTotal > 0);
        const withContributing = selected.filter((item) => item.contributingTotal > 0);
        summary.push({
          variant: variant.id,
          k,
          expectedSourceRecall: round(sum("intendedRetrieved") / Math.max(1, sum("intendedTotal")), 4),
          expectedSourceRecallMacro: round(mean(withIntended.map((item) => item.intendedRetrieved / item.intendedTotal)), 4),
          admissibleExpectedSourceRecall: round(sum("admissibleIntendedRetrieved") / Math.max(1, sum("admissibleIntendedTotal")), 4),
          contributingSourceRecall: round(sum("contributingRetrieved") / Math.max(1, sum("contributingTotal")), 4),
          contributingSourceRecallMacro: round(mean(withContributing.map((item) => item.contributingRetrieved / item.contributingTotal)), 4),
          contributingSourcesMissed: sum("contributingTotal") - sum("contributingRetrieved"),
          matchedWordCoverage: round((sum("referenceMatchedWords") - sum("missingPositions")) / Math.max(1, sum("referenceMatchedWords")), 5),
          minimumQueryCoverage: round(Math.min(...selected.map((item) => item.coverage)), 4),
          queriesWithMissingPositions: selected.filter((item) => item.missingPositions > 0).length,
          missingPositions: sum("missingPositions"),
          extraPositions: sum("extraPositions"),
          queriesWithScoreDifference: selected.filter((item) => item.scoreDifference !== 0).length,
          largestScoreDrop: Math.min(0, ...selected.map((item) => item.scoreDifference)),
          scoreDifferences: selected.filter((item) => item.scoreDifference !== 0).map((item) => `${item.queryId}:${item.scoreDifference}`),
          queries: selected.length,
        });
      }
    }

    const suppression = variants.map((variant) => {
      const stats = retrievalStats.filter((item) => item.variant === variant.id);
      const total = (field: string) => stats.reduce((sum, item) => sum + (item[field] as number), 0);
      return {
        variant: variant.id,
        maxDiscoveryDocumentFrequency: variant.policy.maxDiscoveryDocumentFrequency ?? null,
        queryFingerprints: total("queryFingerprints"),
        fingerprintsFound: total("fingerprintsFound"),
        fingerprintsSuppressed: total("fingerprintsSuppressed"),
        suppressedShareOfFound: round(total("fingerprintsSuppressed") / Math.max(1, total("fingerprintsFound")), 5),
        touchedDocuments: total("touchedDocuments"),
        touchedDocumentsP50: percentile(stats.map((item) => item.touchedDocuments as number), 0.5),
        touchedDocumentsP95: percentile(stats.map((item) => item.touchedDocuments as number), 0.95),
        touchedDocumentsMax: Math.max(...stats.map((item) => item.touchedDocuments as number)),
        postingsDecoded: total("postingsDecoded"),
      };
    });

    const excerptLengths = perQuery.filter((query) => query.category === "short-excerpt").map((query) => {
      const variant = (query.variants as Record<string, { intendedRanks: Array<{ normalizedWords: number; words: number; rank: number | null; admittedByReference: boolean }>; comparisons: Comparison[] }>)["region-aware"];
      return {
        queryId: query.id,
        language: query.language,
        words: variant.intendedRanks[0].words,
        normalizedWords: variant.intendedRanks[0].normalizedWords,
        retrievedAtRank: variant.intendedRanks[0].rank,
        admittedByExhaustiveVerifier: variant.intendedRanks[0].admittedByReference,
        matchedWordsExhaustive: (query.reference as { matchedWords: number }).matchedWords,
        matchedWordsEngineAt50: variant.comparisons[0].matchedWords,
      };
    });

    writeJson(requireArgument(args, "out"), {
      identity: reader.identity(),
      verifierPath,
      budgets: BUDGETS,
      variants,
      counts: {
        queries: queries.length,
        positive: queries.filter((query) => query.expectation === "positive").length,
        negative: queries.filter((query) => query.expectation === "negative").length,
        belowVerifierThreshold: queries.filter((query) => query.expectation === "below-verifier-threshold").length,
        byCategory: Object.fromEntries([...new Set(queries.map((query) => query.category))].map((category) => [category, queries.filter((query) => query.category === category).length])),
        byLanguage: Object.fromEntries([...new Set(queries.map((query) => query.language))].map((language) => [language, queries.filter((query) => query.language === language).length])),
      },
      summary,
      suppression,
      excerptLengths,
      missesAtLargestBudget: misses,
      verifierFailures: [],
      perQuery,
      retrievalStats,
    });

    logLine("");
    logLine("variant               K   exp.recall  admissible  contributing  coverage   min-cov  q.missing  missing-pos  extra  q.score-diff  worst");
    for (const row of summary) {
      logLine(`${String(row.variant).padEnd(20)} ${String(row.k).padStart(3)}   ${String(row.expectedSourceRecall).padEnd(10)}  ${String(row.admissibleExpectedSourceRecall).padEnd(10)}  ${String(row.contributingSourceRecall).padEnd(12)}  ${String(row.matchedWordCoverage).padEnd(9)}  ${String(row.minimumQueryCoverage).padEnd(7)}  ${String(row.queriesWithMissingPositions).padStart(9)}  ${String(row.missingPositions).padStart(11)}  ${String(row.extraPositions).padStart(5)}  ${String(row.queriesWithScoreDifference).padStart(12)}  ${row.largestScoreDrop}`);
    }
    logLine("");
    for (const row of suppression) logLine(`suppression ${String(row.variant).padEnd(20)} suppressed ${row.fingerprintsSuppressed}/${row.fingerprintsFound} found fingerprints (${round(row.suppressedShareOfFound * 100, 3)}%), touched docs p50/p95/max ${row.touchedDocumentsP50}/${row.touchedDocumentsP95}/${row.touchedDocumentsMax}, postings decoded ${row.postingsDecoded}`);
    logLine("");
    for (const row of excerptLengths) logLine(`excerpt ${String(row.queryId).padEnd(18)} ${String(row.normalizedWords).padStart(4)} normalized words — retrieved at rank ${row.retrievedAtRank ?? "NOT RETRIEVED"} — exhaustive verifier admits: ${row.admittedByExhaustiveVerifier}`);
    logLine(`contributing sources not returned within K=${MAX_BUDGET} by the default policy: ${misses.length}`);
    for (const miss of misses) logLine(`  ${miss.queryId} doc ${miss.docId} intended=${miss.intended} sharedFingerprints=${miss.sharedFingerprints} unboundedRank=${miss.unboundedRank}`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
