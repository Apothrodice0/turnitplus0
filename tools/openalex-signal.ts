import type { OpenAlexCheckResult } from "../lib/openalex-check";
import type { CorpusDocument } from "./calibration-utils";

export type OpenAlexObservation = {
  id: string;
  textSha256: string;
  checkedAt: string;
  queryMethod: "openalex-fulltext-search-exact-v1";
  result: OpenAlexCheckResult;
};

export type OpenAlexObservationFile = {
  schema: "turnitplus-openalex-similarity-observations";
  version: 1;
  provider: "OpenAlex";
  phraseCount: number;
  generatedAt: string;
  observations: OpenAlexObservation[];
};

export function summarizeOpenAlexSignal(
  documents: CorpusDocument[],
  observations: OpenAlexObservation[],
  phraseCount = 20,
) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const rows = documents.map((document) => {
    const observation = byId.get(document.id);
    if (!observation) throw new Error(`Missing OpenAlex observation for ${document.id}.`);
    if (observation.textSha256 !== document.provenance.sha256) {
      throw new Error(`Stale OpenAlex observation for ${document.id}.`);
    }
    if (
      observation.result.status !== "complete"
      || observation.result.errorCount !== 0
      || observation.result.phrasesSampled !== phraseCount
      || observation.result.matches.length !== phraseCount
      || observation.result.matches.some((match) => (
        !Number.isInteger(match.sampleIndex)
        || !Number.isInteger(match.wordStart)
        || !Number.isInteger(match.wordEnd)
      ))
    ) {
      throw new Error(`Incomplete OpenAlex observation for ${document.id}.`);
    }
    return {
      id: document.id,
      phrasesMatched: observation.result.phrasesMatched,
      outcomes: observation.result.outcomes,
      matchedPhrasePositions: observation.result.matches
        .filter((match) => match.outcome === "matched")
        .map((match) => ({
          sampleIndex: match.sampleIndex,
          wordStart: match.wordStart,
          wordEnd: match.wordEnd,
        })),
    };
  });
  const counts = rows.map((row) => row.phrasesMatched).sort((left, right) => left - right);
  const histogram = Object.fromEntries(
    [...new Set(counts)].map((count) => [String(count), counts.filter((value) => value === count).length]),
  );
  const outcomeTotals = rows.reduce((totals, row) => {
    for (const [outcome, count] of Object.entries(row.outcomes)) {
      totals[outcome as keyof typeof totals] += count;
    }
    return totals;
  }, { matched: 0, "no-match": 0, throttled: 0, "timed-out": 0, failed: 0 });
  const matchedPositions = rows.flatMap((row) => row.matchedPhrasePositions);
  const phrasePositionHistogram = Object.fromEntries(
    Array.from({ length: phraseCount }, (_, index) => [
      String(index + 1),
      matchedPositions.filter((position) => position.sampleIndex === index + 1).length,
    ]),
  );
  const positionThirds = matchedPositions.reduce((totals, position) => {
    const third = Math.min(2, Math.floor(((position.sampleIndex - 1) * 3) / phraseCount));
    if (third === 0) totals.early += 1;
    else if (third === 1) totals.middle += 1;
    else totals.late += 1;
    return totals;
  }, { early: 0, middle: 0, late: 0 });
  const documentMatchCounts = [...rows]
    .sort((left, right) => right.phrasesMatched - left.phrasesMatched || left.id.localeCompare(right.id))
    .map((row) => ({ id: row.id, matches: row.phrasesMatched }));
  const totalMatches = documentMatchCounts.reduce((total, row) => total + row.matches, 0);
  const topThreeMatches = documentMatchCounts.slice(0, 3).reduce((total, row) => total + row.matches, 0);
  let cumulativeMatches = 0;
  let documentsForHalfOfMatches = 0;
  if (totalMatches > 0) {
    for (const row of documentMatchCounts) {
      cumulativeMatches += row.matches;
      documentsForHalfOfMatches += 1;
      if (cumulativeMatches >= totalMatches / 2) break;
    }
  }
  return {
    provider: "OpenAlex" as const,
    collectionStatus: "complete" as const,
    queryMethod: "openalex-fulltext-search-exact-v1" as const,
    phraseCountPerDocument: phraseCount,
    sampleSize: rows.length,
    requestCount: rows.length * phraseCount,
    matchDistribution: {
      minimum: counts[0] ?? 0,
      median: counts[Math.floor(counts.length / 2)] ?? 0,
      maximum: counts.at(-1) ?? 0,
      zeroMatchDocuments: counts.filter((value) => value === 0).length,
      nonzeroMatchDocuments: counts.filter((value) => value > 0).length,
      histogram,
    },
    outcomeTotals,
    concentration: {
      totalMatches,
      documentsWithMatches: documentMatchCounts.filter((row) => row.matches > 0).length,
      maximumMatchesInOneDocument: documentMatchCounts[0]?.matches ?? 0,
      topThreeDocuments: documentMatchCounts.slice(0, 3),
      topThreeMatchShare: totalMatches > 0 ? Number((topThreeMatches / totalMatches).toFixed(4)) : null,
      documentsAccountingForHalfOfMatches: totalMatches > 0 ? documentsForHalfOfMatches : null,
    },
    phrasePositionDistribution: {
      sampleIndexHistogram: phrasePositionHistogram,
      thirds: positionThirds,
      definition: "Early = sampled positions 1-7; middle = 8-14; late = 15-20. Per-document word offsets are retained in perDocument.matchedPhrasePositions.",
    },
    decisionUse: "Separate scholarly phrase evidence. It does not alter Archive Similarity unless a later held-out calibration demonstrates an improvement.",
    perDocument: rows,
  };
}

export function pendingOpenAlexSignal() {
  return {
    provider: "OpenAlex" as const,
    collectionStatus: "api-key-required" as const,
    queryMethod: "openalex-fulltext-search-exact-v1" as const,
    phraseCountPerDocument: 20,
    sampleSize: 0,
    requestCount: 1_200,
    matchDistribution: null,
    outcomeTotals: null,
    concentration: null,
    phrasePositionDistribution: null,
    decisionUse: "Not evaluated. Run the resumable offline collector with a free OpenAlex API key; never embed the key in browser code.",
    perDocument: [],
  };
}
