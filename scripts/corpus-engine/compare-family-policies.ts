import path from "node:path";
import {
  FAMILY_ADMISSION_POLICIES,
  FAMILY_ADMISSION_POLICY_AWARE_V2,
  FAMILY_ADMISSION_POLICY_GUARD_V1,
  FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY,
  genericFamilyDocuments,
  type FamilyAdmissionPolicyId,
} from "../../lib/corpus-engine/family-admission";
import { docIdFromDecimal } from "../../lib/corpus-engine/ids";
import { prepareSubmissionForVerification } from "../../lib/corpus-engine/prepared-verifier";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import { admitCandidates, finalizeVerification, type CandidateAdmission, type VerifierAdapterFailure } from "../../lib/corpus-engine/verifier-adapter";
import { openGeneration, toRanges, type BenchmarkQuery, type ReferenceResult } from "./benchmark-common";
import { logLine, parseArguments, percentile, readJson, requireArgument, writeJson } from "./common";

/**
 * The family admission policies, side by side on one generation.
 *
 *   compare-family-policies.ts --root R --generation G --queries queries.json [--reference reference.json]
 *                              --out comparison.json [--out-references DIR] [--policies a,b,c]
 *
 * STRICT_SPAN depends only on the two texts, so the set of (submission,
 * document) pairs that pass it is the same under every policy; a policy only
 * decides what happens to those pairs. Each submission's pairs are therefore
 * verified under each policy and nothing else is: the pairs come from an
 * all-touched reference (its admitted and suppressed documents), or, for a
 * submission the reference does not have, from every document sharing a
 * fingerprint with it.
 *
 * Per submission and policy it reports the matched positions and score the
 * existing union gives, which copied-from sources are attributed, how many
 * other sources are, and the verified positions of STRICT_SPAN-passing
 * documents that end up covered by no attributed source.
 *
 * With --out-references it also writes, per policy, a file in the shape of the
 * exhaustive reference, so benchmark-engine.ts can check a candidate budget
 * against the policy it will be served with.
 */

type IntendedStatus = "source" | "representative" | "collapsed-into-family" | "suppressed-generic" | "suppressed-by-guard" | "below-strict-span" | "not-a-candidate";

type PolicyRow = {
  admitted: number;
  representatives: number;
  collapsed: number;
  suppressed: number;
  attributedNotIntended: number;
  intended: Record<IntendedStatus, number>;
  matchedWords: number;
  score: number;
  uncoveredPositions: number;
  /** Corpus holders of the dominant span of every family member, attributed or not. */
  familyHolders: number[];
  matchedPositions: number[];
  /** Every attributed source: how it was attributed, the words credited to it, and the corpus holders of its dominant span (v2). */
  attributedSources: Array<{ docId: string; intended: boolean; via: "source" | "representative"; attributedPositions: number; dominantSpanHolders: number | null }>;
};

function policyArgument(args: Record<string, string>): FamilyAdmissionPolicyId[] {
  if (!args.policies) return [FAMILY_ADMISSION_POLICY_GUARD_V1, FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY, FAMILY_ADMISSION_POLICY_AWARE_V2];
  return args.policies.split(",").map((value) => {
    if (!FAMILY_ADMISSION_POLICIES.includes(value as FamilyAdmissionPolicyId)) throw new Error(`unknown family policy ${JSON.stringify(value)}`);
    return value as FamilyAdmissionPolicyId;
  });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const policies = policyArgument(args);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const references = new Map<string, Omit<ReferenceResult, "matchedPositions">>();
  if (args.reference) for (const reference of readJson<{ references: Array<Omit<ReferenceResult, "matchedPositions">> }>(args.reference).references) references.set(reference.queryId, reference);
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"), { dictionaryBlockCacheBlocks: Number(args["dictionary-cache-blocks"] ?? 2048) });
  const perQuery: Array<Record<string, unknown>> = [];
  const perPolicyReferences = new Map<FamilyAdmissionPolicyId, unknown[]>(policies.map((policy) => [policy, []]));
  try {
    for (const query of queries) {
      const reference = references.get(query.id);
      let documents: bigint[];
      let pairSource: string;
      if (reference) {
        documents = [...new Set([...reference.admittedDocIds, ...reference.suppressedDocIds])].map(docIdFromDecimal);
        pairSource = "reference STRICT_SPAN pairs";
      } else {
        // No reference: verify every document sharing a fingerprint once, and keep the ones that pass STRICT_SPAN.
        const retrieval = await retrieveCandidates(reader, query.text, { regionAware: false, candidateBudget: 100_000_000 });
        if (retrieval.state !== "COMPLETE") throw new Error(`retrieval for ${query.id} was ${retrieval.state}`);
        const touched = await admitCandidates(reader, query.text, retrieval.candidates.map((candidate) => candidate.docId), undefined, { familyPolicy: FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY });
        documents = touched.admissions.filter((admission) => admission.strictSpanPass).map((admission) => docIdFromDecimal(admission.docId));
        pairSource = `STRICT_SPAN pairs among the ${retrieval.candidates.length} documents sharing a fingerprint`;
      }
      documents.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const intended = new Set(query.intendedSources.map((source) => source.docId));
      const prepared = prepareSubmissionForVerification(query.text);
      const rows: Record<string, PolicyRow> = {};
      for (const policy of policies) {
        const failures: VerifierAdapterFailure[] = [];
        const pass = await admitCandidates(reader, query.text, documents, { failures, preparedSubmission: prepared }, { familyPolicy: policy });
        const final = finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures, { familyPolicy: policy });
        if (final.state !== "COMPLETE") throw new Error(`verification of ${query.id} under ${policy} was ${final.state}: ${JSON.stringify(final.failures.slice(0, 2))}`);
        const byDocId = new Map<string, CandidateAdmission>(pass.admissions.map((admission) => [admission.docId, admission]));
        const resolution = new Map(final.familyResolutions.map((entry) => [entry.docId, entry.role]));
        const attributed = new Set<string>([...pass.admissions.filter((admission) => admission.outcome === "ADMITTED").map((admission) => admission.docId), ...final.familyResolutions.filter((entry) => entry.role === "REPRESENTATIVE").map((entry) => entry.docId)]);
        const statusOf = (docId: string): IntendedStatus => {
          const admission = byDocId.get(docId);
          if (!admission) return "not-a-candidate";
          if (admission.outcome === "ADMITTED") return "source";
          if (admission.outcome === "FAMILY_MEMBER") return resolution.get(docId) === "REPRESENTATIVE" ? "representative" : "collapsed-into-family";
          if (!admission.strictSpanPass) return "below-strict-span";
          return admission.familyRole === "GENERIC" ? "suppressed-generic" : "suppressed-by-guard";
        };
        const intendedCounts: Record<IntendedStatus, number> = { source: 0, representative: 0, "collapsed-into-family": 0, "suppressed-generic": 0, "suppressed-by-guard": 0, "below-strict-span": 0, "not-a-candidate": 0 };
        for (const docId of intended) intendedCounts[statusOf(docId)] += 1;
        const union = new Set(final.matchedPositions);
        const strictPositions = new Set<number>();
        for (const admission of pass.admissions) {
          if (!admission.strictSpanPass) continue;
          for (const span of admission.spans) for (let position = span.start; position <= span.end; position += 1) strictPositions.add(position);
        }
        let uncovered = 0;
        for (const position of strictPositions) if (!union.has(position)) uncovered += 1;
        rows[policy] = {
          admitted: pass.admissions.filter((admission) => admission.outcome === "ADMITTED").length,
          representatives: final.familyResolutions.filter((entry) => entry.role === "REPRESENTATIVE").length,
          collapsed: final.familyResolutions.filter((entry) => entry.role === "COLLAPSED").length,
          suppressed: pass.admissions.filter((admission) => admission.strictSpanPass && admission.outcome === "NOT_ADMITTED").length,
          attributedNotIntended: [...attributed].filter((docId) => !intended.has(docId)).length,
          intended: intendedCounts,
          matchedWords: final.matchedWordCount,
          score: final.unifiedScore,
          uncoveredPositions: uncovered,
          familyHolders: pass.admissions.filter((admission) => admission.outcome === "FAMILY_MEMBER").map((admission) => admission.dominantSpanHolders ?? 0),
          matchedPositions: final.matchedPositions,
          attributedSources: final.verifiedSources.map((source) => ({ docId: source.docId, intended: intended.has(source.docId), via: source.familyRepresentative ? "representative" as const : "source" as const, attributedPositions: source.attributedPositions, dominantSpanHolders: source.dominantSpanHolders })),
        };
        (perPolicyReferences.get(policy) as unknown[]).push({
          queryId: query.id,
          submissionWordCount: pass.submissionWordCount,
          documentsVerified: pass.admissions.length,
          admittedDocIds: [...attributed],
          suppressedDocIds: pass.admissions.filter((admission) => admission.strictSpanPass && !attributed.has(admission.docId)).map((admission) => admission.docId),
          attributedDocIds: final.verifiedSources.map((source) => source.docId),
          matchedPositions: toRanges(final.matchedPositions),
          matchedWordCount: final.matchedWordCount,
          unifiedScore: final.unifiedScore,
          failures: final.failures,
          verifyCpuMs: 0,
        });
      }
      const strictSpanPairs = rows[policies[0]].admitted + rows[policies[0]].representatives + rows[policies[0]].collapsed + rows[policies[0]].suppressed;
      perQuery.push({
        queryId: query.id, category: query.category, language: query.language, expectation: query.expectation, submissionWords: prepared.words.length,
        pairSource, documentsVerified: documents.length, strictSpanPairs, intendedSources: intended.size,
        policies: Object.fromEntries(Object.entries(rows).map(([policy, row]) => [policy, { ...row, matchedPositions: undefined, familyHolders: undefined, familyHoldersMax: row.familyHolders.length > 0 ? Math.max(...row.familyHolders) : null }])),
        positionDifferences: Object.fromEntries(policies.slice(1).map((policy) => {
          const base = new Set(rows[policies[0]].matchedPositions);
          const other = new Set(rows[policy].matchedPositions);
          let gained = 0;
          let lost = 0;
          for (const position of other) if (!base.has(position)) gained += 1;
          for (const position of base) if (!other.has(position)) lost += 1;
          return [`${policies[0]} -> ${policy}`, { gained, lost, scoreChange: rows[policy].score - rows[policies[0]].score }];
        })),
        rows,
      });
      logLine(`${query.id.padEnd(28)} ${String(strictSpanPairs).padStart(5)} pairs | ${policies.map((policy) => `${rows[policy].score}% ${rows[policy].admitted + rows[policy].representatives}src unc${rows[policy].uncoveredPositions}`).join(" | ")}`);
    }

    const summary = policies.map((policy) => {
      const rows = perQuery.map((record) => (record.rows as Record<string, PolicyRow>)[policy]);
      const total = (pick: (row: PolicyRow) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
      const holders = rows.flatMap((row) => row.familyHolders);
      const intendedTotal = perQuery.reduce((sum, record) => sum + (record.intendedSources as number), 0);
      return {
        policy,
        strictSpanPairs: total((row) => row.admitted + row.representatives + row.collapsed + row.suppressed),
        attributedSources: total((row) => row.admitted + row.representatives),
        admittedInTheirOwnRight: total((row) => row.admitted),
        familyRepresentatives: total((row) => row.representatives),
        collapsedIntoAFamily: total((row) => row.collapsed),
        suppressed: total((row) => row.suppressed),
        attributedSourcesNotCopiedFrom: total((row) => row.attributedNotIntended),
        copiedFromSources: {
          total: intendedTotal,
          attributed: total((row) => row.intended.source + row.intended.representative),
          evidenceKeptThroughAFamilyRepresentative: total((row) => row.intended["collapsed-into-family"]),
          suppressed: total((row) => row.intended["suppressed-by-guard"] + row.intended["suppressed-generic"]),
          suppressedAsGeneric: total((row) => row.intended["suppressed-generic"]),
          belowStrictSpanOrNotACandidate: total((row) => row.intended["below-strict-span"] + row.intended["not-a-candidate"]),
        },
        matchedWords: total((row) => row.matchedWords),
        uncoveredPositions: total((row) => row.uncoveredPositions),
        queriesScoringAboveZero: rows.filter((row) => row.score > 0).length,
        negativeQueriesScoringAboveZero: perQuery.filter((record) => record.expectation === "negative" && (record.rows as Record<string, PolicyRow>)[policy].score > 0).map((record) => `${record.queryId}:${(record.rows as Record<string, PolicyRow>)[policy].score}`),
        familyMembers: holders.length,
        familyHoldersP50: percentile(holders, 0.5),
        familyHoldersP95: percentile(holders, 0.95),
        familyHoldersMax: holders.length > 0 ? Math.max(...holders) : null,
      };
    });
    for (const record of perQuery) delete record.rows;
    const documentCount = reader.manifest.documentCount;
    writeJson(requireArgument(args, "out"), {
      identity: reader.identity(),
      documentCount,
      genericFamilyDocuments: genericFamilyDocuments(documentCount),
      policies,
      summary,
      scoreChanges: Object.fromEntries(policies.slice(1).map((policy) => {
        const key = `${policies[0]} -> ${policy}`;
        return [key, perQuery.filter((record) => (record.positionDifferences as Record<string, { scoreChange: number }>)[key].scoreChange !== 0).map((record) => ({ queryId: record.queryId, expectation: record.expectation, ...(record.positionDifferences as Record<string, object>)[key] }))];
      })),
      perQuery,
    });
    if (args["out-references"]) {
      for (const policy of policies) {
        writeJson(path.join(args["out-references"], `reference.${policy}.json`), {
          identity: reader.identity(),
          referenceKind: "strict-span-pairs-of-the-all-touched-reference",
          familyPolicy: policy,
          documentsInGeneration: documentCount,
          references: perPolicyReferences.get(policy),
        });
      }
    }
    for (const row of summary) logLine(JSON.stringify(row));
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
