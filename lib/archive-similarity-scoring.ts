import {
  addGramCoverage,
  aggregateSimilaritySources,
  containment,
  gramHash,
  grams,
  informativeGram,
  mergeAdjacentPositions,
  tokens,
  verifiedSourceEvidence,
  type GramCoverage,
  type SourceWeighting,
} from "./similarity-core";

/**
 * 100k-scale architecture, slice 1 (server-side archive parity foundation).
 *
 * This is the built-in archive's matching/scoring algorithm, extracted
 * VERBATIM from app/similarity-worker.ts's own analyze() — same statements,
 * same order, same defaults — so it can run against two different posting
 * sources without risking two independently-drifting reimplementations:
 *
 *   - the browser's static packed index (hashes.bin/offsets.bin/postings.bin,
 *     binary-searched via app/similarity-worker.ts's own indexPostings), and
 *   - a server-side DB-backed posting lookup over corpus_document_shingles
 *     (lib/archive-corpus-matching.ts), which is what lets this algorithm
 *     scale past the point where shipping the whole corpus to a browser tab
 *     becomes impossible.
 *
 * app/similarity-worker.ts now calls this function instead of containing the
 * algorithm inline; its own return shape (risk banding, quotation/reference-
 * list features, detected language) is layered on top of this function's
 * result exactly as before — this file knows nothing about risk calibration
 * or AI-detection framing, only matching.
 *
 * getPostings' contract is load-bearing for parity: it must return an EMPTY
 * result for any shingle hash whose true corpus-wide document frequency
 * exceeds `maximumDocumentFrequency`, exactly like the browser's packed index
 * (whose build step, scripts/build-document-corpus.py's build_index, drops
 * such a hash from the index entirely, so a binary-search lookup can never
 * find it) — never a partial/truncated posting list. See
 * lib/archive-corpus-matching.ts's own getPostings implementation for how the
 * DB-backed side satisfies this without any corpus-size-proportional scan.
 */

export type ArchiveScoringArticle = {
  title: string;
  sourceType: "Publication";
  uniqueShingleCount: number;
};

export type ArchiveScoringMatchingParameters = {
  minimumMatchedWords?: number;
  maximumDocumentFrequency?: number;
  minimumSourceContribution?: number;
  maximumContributingSources?: number | null;
  sourceWeighting?: SourceWeighting;
};

export type ArchivePostings = Uint32Array | number[];

export type ArchiveScoringIndex = {
  shingleSize: number;
  /** The eligible-count basis before self-exclusion — == articles.length. */
  documentCount: number;
  maximumDocumentFrequency: number;
  /** Indexed 0..documentCount-1; a posting's sourceIndex is this array's index. */
  articles: ArchiveScoringArticle[];
  getPostings: (hash: string) => ArchivePostings;
};

export type ArchiveScoringSource = {
  sourceIndex: number;
  name: string;
  type: "Publication";
  color: string;
  matches: number;
  matchedWords: number;
  /** The scored positions attributed to this source (aggregateSimilaritySources'
   *  winner-take-all), as inclusive [start, end] word ranges: matchedWords is
   *  their size. Disjoint across sources; never adds or removes a scored
   *  position. Presentation only — lets a report show one card per source. */
  attributedRanges: Array<[number, number]>;
  phrases: string[];
  percent: number;
};

export type ArchiveScoringResult = {
  wordCount: number;
  databaseSize: number;
  excludedDocuments: number;
  matchedWordCount: number;
  archiveMatchedPositions: number[];
  score: number;
  sources: ArchiveScoringSource[];
  /** How many admitted sources own at least one scored position — the verified
   *  contributing sources, of which `sources` lists at most the display cap. */
  verifiedSourceCount: number;
  maxSourceContainment: number;
  longestMatchedSpan: number;
  highFrequencyShingleCount: number;
};

export function scoreAgainstArchive(
  text: string,
  index: ArchiveScoringIndex,
  matchingParameters: ArchiveScoringMatchingParameters = {},
  /**
   * Fired at the same two points, with the same (percent, label) values,
   * app/similarity-worker.ts's own analyze() posted them at before this
   * extraction — purely a UX progress signal, never consulted for anything
   * scoring-related. Optional/no-op for every non-browser caller (e.g.
   * lib/archive-corpus-matching.ts).
   */
  onProgress?: (percent: number, label: string) => void,
): ArchiveScoringResult {
  return scoreAgainstArchiveDetailed(text, index, matchingParameters, onProgress).result;
}

/**
 * scoreAgainstArchive plus `admittedSourceIndexes`: every source admitted to
 * the score (self-exclusion and minimumSourceContribution applied, never the
 * display cap), in presentation-rank order. `result.sources` is only the
 * displayed top maximumContributingSources of them; the archive matcher uses
 * the full list so verification after scoring is never limited by the display.
 * `contributingSourceIndexes` is the subset that owns at least one scored
 * position (`result.verifiedSourceCount` is its size).
 *
 * `result.archiveMatchedPositions` / `score` are the union of every admitted
 * source's verified positions. Winner-take-all attribution only decides which
 * source a position is listed under, so which source owns a position and how
 * many sources are displayed never change the score.
 */
export function scoreAgainstArchiveDetailed(
  text: string,
  index: ArchiveScoringIndex,
  matchingParameters: ArchiveScoringMatchingParameters = {},
  onProgress?: (percent: number, label: string) => void,
): { result: ArchiveScoringResult; admittedSourceIndexes: number[]; contributingSourceIndexes: number[] } {
  const words = tokens(text);
  const documentGrams = grams(words, index.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  let highFrequencyShingleCount = 0;

  uniqueDocumentGrams.forEach((gram) => {
    const sourceIndexes = index.getPostings(gramHash(gram));
    if (sourceIndexes.length >= Math.max(3, Math.ceil(index.maximumDocumentFrequency * 0.75))) {
      highFrequencyShingleCount += 1;
    }
    sourceIndexes.forEach((sourceIndex) => {
      sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    });
  });

  const excluded = new Set<number>();
  index.articles.forEach((article, sourceIndex) => {
    const shared = sharedBySource.get(sourceIndex) ?? 0;
    if (containment(shared, uniqueDocumentGrams.size, article.uniqueShingleCount) >= 0.75) {
      excluded.add(sourceIndex);
    }
  });

  onProgress?.(68, "Comparing distinctive passages");
  const eligibleCount = index.documentCount - excluded.size;
  const minimumMatchedWords = matchingParameters.minimumMatchedWords ?? index.shingleSize;
  const runtimeMaximumDocumentFrequency = Math.min(
    index.maximumDocumentFrequency,
    matchingParameters.maximumDocumentFrequency ?? index.maximumDocumentFrequency,
  );
  const coverage: GramCoverage = new Map();
  documentGrams.forEach((gram, start) => {
    const sourceIndexes = index.getPostings(gramHash(gram)).filter(
      (sourceIndex) => !excluded.has(sourceIndex),
    );
    if (
      sourceIndexes.length === 0
      || sourceIndexes.length > runtimeMaximumDocumentFrequency
      || !informativeGram(gram)
    ) return;
    addGramCoverage(coverage, start, index.shingleSize, sourceIndexes);
  });

  const evidence = verifiedSourceEvidence(coverage, minimumMatchedWords, eligibleCount, (sourceIndex) => containment(
    sharedBySource.get(sourceIndex) ?? 0,
    uniqueDocumentGrams.size,
    index.articles[sourceIndex].uniqueShingleCount,
  ));
  const aggregation = aggregateSimilaritySources(evidence, words.length, {
    minimumSourceContribution: matchingParameters.minimumSourceContribution ?? 0,
    maximumContributingSources: matchingParameters.maximumContributingSources ?? null,
    sourceWeighting: matchingParameters.sourceWeighting ?? "raw",
  }, minimumMatchedWords);
  const allMatchedPositions = aggregation.acceptedPositions;

  // Displayed sources, each with the positions attributed to it. A tie on
  // percent and matches keeps winner-take-all's historical order (the source
  // owning the earlier position first) and ends in the stable sourceIndex, so
  // the listed order never depends on the order sources were handed in.
  const sources: ArchiveScoringSource[] = aggregation.sourceContributions
    .map(({ sourceIndex, attributedPositions }) => {
      const validSpans = mergeAdjacentPositions(attributedPositions);
      const acceptedSourcePositions = new Set<number>();
      validSpans.forEach(([start, end]) => {
        for (let position = start; position <= end; position += 1) acceptedSourcePositions.add(position);
      });
      const phrases = validSpans.flatMap(([start, end]) => {
        const chunks: string[] = [];
        for (let cursor = start; cursor <= end; cursor += 34) {
          if (end - cursor + 1 < index.shingleSize) break;
          chunks.push(words.slice(cursor, Math.min(end + 1, cursor + 40)).join(" "));
        }
        return chunks;
      });
      return {
        firstPosition: validSpans[0]?.[0] ?? 0,
        source: {
          sourceIndex,
          name: index.articles[sourceIndex].title,
          type: "Publication" as const,
          color: "#d7263d",
          matches: validSpans.length,
          matchedWords: acceptedSourcePositions.size,
          attributedRanges: validSpans,
          phrases,
          percent: Math.floor((acceptedSourcePositions.size / Math.max(words.length, 1)) * 100),
        },
      };
    })
    .filter(({ source }) => source.matches > 0)
    .sort((left, right) =>
      right.source.percent - left.source.percent
      || right.source.matches - left.source.matches
      || left.firstPosition - right.firstPosition
      || left.source.sourceIndex - right.source.sourceIndex)
    .slice(0, 20)
    .map(({ source }) => source);

  onProgress?.(88, "Calculating similarity result");
  const score = aggregation.score;
  const longestMatchedSpan = sources.reduce(
    (maximum, source) => Math.max(maximum, ...source.phrases.map((phrase) => phrase.split(" ").length), 0),
    0,
  );
  const contributingSourceIndexes = aggregation.admittedSources
    .filter((source) => source.attributedPositions.size > 0)
    .map((source) => source.sourceIndex);
  const maxSourceContainment = Math.max(
    0,
    ...[...sharedBySource.entries()]
      .filter(([sourceIndex]) => !excluded.has(sourceIndex))
      .map(([sourceIndex, shared]) => containment(
        shared,
        uniqueDocumentGrams.size,
        index.articles[sourceIndex].uniqueShingleCount,
      )),
  );

  return {
    result: {
      wordCount: words.length,
      databaseSize: eligibleCount,
      excludedDocuments: excluded.size,
      matchedWordCount: allMatchedPositions.size,
      archiveMatchedPositions: [...allMatchedPositions].sort((left, right) => left - right),
      score,
      sources,
      verifiedSourceCount: contributingSourceIndexes.length,
      maxSourceContainment: Math.round(maxSourceContainment * 1000) / 1000,
      longestMatchedSpan,
      highFrequencyShingleCount,
    },
    admittedSourceIndexes: aggregation.admittedSources.map((source) => source.sourceIndex),
    contributingSourceIndexes,
  };
}
