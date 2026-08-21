import type { AcademicSearchCandidate, NormalizedAcademicResult } from "./types";

/**
 * Stage 4 of the pipeline: groups normalized results into candidates using
 * only a stable identifier (DOI, then canonical URL, then a
 * provider-specific fallback) — never title or author alone, so two
 * different papers that happen to share a title are never silently merged.
 * This is the mechanism STEP 7's "multiple providers returning the same
 * DOI" test exercises: two results from different providerIds normalizing
 * to the same dedupKey collapse into one candidate with both contributors
 * recorded.
 */
export function deduplicateAcademicResults(results: NormalizedAcademicResult[]): AcademicSearchCandidate[] {
  const groups = new Map<string, NormalizedAcademicResult[]>();
  const order: string[] = [];
  for (const result of results) {
    if (!groups.has(result.dedupKey)) {
      groups.set(result.dedupKey, []);
      order.push(result.dedupKey);
    }
    groups.get(result.dedupKey)!.push(result);
  }

  return order.map((key) => {
    const contributors = groups.get(key)!;
    const firstNonNull = <T>(values: (T | null)[]): T | null => values.find((v) => v !== null && v !== undefined) ?? null;

    const candidate: AcademicSearchCandidate = {
      candidateKey: key,
      doi: firstNonNull(contributors.map((c) => c.doi)),
      url: firstNonNull(contributors.map((c) => c.url)),
      title: firstNonNull(contributors.map((c) => c.title)),
      authors: firstNonNull(contributors.map((c) => c.authors)),
      publication: firstNonNull(contributors.map((c) => c.publication)),
      year: firstNonNull(contributors.map((c) => c.year)),
      textAvailable: contributors.some((c) => c.textAvailable),
      abstract: firstNonNull(contributors.map((c) => c.abstract)),
      contributors,
      rank: 0, // assigned by candidate-ranker.ts
    };
    return candidate;
  });
}
