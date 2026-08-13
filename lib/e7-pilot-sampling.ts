/**
 * Phase E7 (calibration/observation pilot against the 230-document archive,
 * not part of the E1-E6D provenance/discovery module family): pure,
 * deterministic pilot-sample selection.
 *
 * No I/O in this file — it only classifies and selects among an already-
 * loaded array of archive metadata records (id/title/sourceType/
 * originalSimilarity/wordCount/uniqueShingleCount, the same six fields the
 * browser search index already ships in public/data/document-index.meta.json).
 * Reading that file and writing the resulting artifact is tools/e7-select-
 * pilot-sample.ts's job, not this module's.
 *
 * Method: classify every document into cohort x lengthBucket x
 * similarityBucket x titleBucket, then for each of the 16 cross-product
 * cells select the member whose id sorts lexicographically first. There is
 * no randomness anywhere in this file — the same input array always
 * produces the same sample.
 */

export type ArchiveDocumentMetadata = {
  id: string;
  title: string;
  sourceType: string;
  originalSimilarity: number | null;
  wordCount: number;
  uniqueShingleCount: number;
};

export type Cohort = "turnitin_import" | "bootstrap";
export type LengthBucket = "short" | "mid" | "long";
export type SimilarityBucket = "low" | "mid" | "high" | "unscored";
export type TitleBucket = "generic" | "distinctive";

export type ClassifiedArchiveDocument = ArchiveDocumentMetadata & {
  cohort: Cohort;
  lengthBucket: LengthBucket;
  similarityBucket: SimilarityBucket;
  titleBucket: TitleBucket;
};

export function classifyCohort(id: string): Cohort {
  return id.startsWith("turnitin-") ? "turnitin_import" : "bootstrap";
}

const GENERIC_TITLE_MARKER = /\b(vol\.?|no\.?|n[°o]|issue|part|chapter|volume|edition)\b/i;

/**
 * Word-shape heuristic, not a scoring model: a title is "generic" if it
 * matches a common front-matter marker (Vol./No./Issue/Chapter/etc.) or has
 * fewer than 3 "distinctive" words (alphabetic, length >= 5).
 */
export function classifyTitle(title: string): TitleBucket {
  if (GENERIC_TITLE_MARKER.test(title)) return "generic";
  const distinctiveWordCount = (title.match(/[a-zA-Z][a-zA-Z'-]{4,}/g) ?? []).length;
  return distinctiveWordCount >= 3 ? "distinctive" : "generic";
}

export function computeTertileCutoffs(sortedAscendingValues: number[]): [number, number] {
  if (sortedAscendingValues.length === 0) return [0, 0];
  const lowIndex = Math.floor(sortedAscendingValues.length / 3);
  const highIndex = Math.floor((2 * sortedAscendingValues.length) / 3);
  return [sortedAscendingValues[lowIndex], sortedAscendingValues[Math.min(highIndex, sortedAscendingValues.length - 1)]];
}

export function classifyArchive(articles: ArchiveDocumentMetadata[]): ClassifiedArchiveDocument[] {
  const sortedWordCounts = [...articles.map((a) => a.wordCount)].sort((a, b) => a - b);
  const [lengthLowCut, lengthHighCut] = computeTertileCutoffs(sortedWordCounts);

  const scoredSimilarities = articles
    .map((a) => a.originalSimilarity)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const [simLowCut, simHighCut] = computeTertileCutoffs(scoredSimilarities);

  return articles.map((article) => {
    let lengthBucket: LengthBucket = "mid";
    if (article.wordCount <= lengthLowCut) lengthBucket = "short";
    else if (article.wordCount >= lengthHighCut) lengthBucket = "long";

    let similarityBucket: SimilarityBucket = "unscored";
    if (article.originalSimilarity !== null) {
      similarityBucket = "mid";
      if (article.originalSimilarity <= simLowCut) similarityBucket = "low";
      else if (article.originalSimilarity >= simHighCut) similarityBucket = "high";
    }

    return {
      ...article,
      cohort: classifyCohort(article.id),
      lengthBucket,
      similarityBucket,
      titleBucket: classifyTitle(article.title),
    };
  });
}

const COHORTS: Cohort[] = ["turnitin_import", "bootstrap"];
const LENGTH_CELLS: Array<Exclude<LengthBucket, "mid">> = ["short", "long"];
const SIMILARITY_CELLS: Array<Extract<SimilarityBucket, "low" | "high">> = ["low", "high"];
const TITLE_CELLS: TitleBucket[] = ["generic", "distinctive"];

export type SampleCell = { cohort: Cohort; lengthBucket: string; similarityBucket: string; titleBucket: string };
export type CellResult = {
  cell: SampleCell;
  relaxedTitleConstraint: boolean;
  selected: ClassifiedArchiveDocument | null;
};

function pickFirstBySortedId(candidates: ClassifiedArchiveDocument[]): ClassifiedArchiveDocument | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

export function selectPilotSampleCells(classified: ClassifiedArchiveDocument[]): CellResult[] {
  const results: CellResult[] = [];
  for (const cohort of COHORTS) {
    for (const lengthBucket of LENGTH_CELLS) {
      for (const similarityBucket of SIMILARITY_CELLS) {
        for (const titleBucket of TITLE_CELLS) {
          const exact = classified.filter(
            (a) =>
              a.cohort === cohort &&
              a.lengthBucket === lengthBucket &&
              a.similarityBucket === similarityBucket &&
              a.titleBucket === titleBucket,
          );
          let selected = pickFirstBySortedId(exact);
          let relaxedTitleConstraint = false;
          if (!selected) {
            const relaxed = classified.filter(
              (a) => a.cohort === cohort && a.lengthBucket === lengthBucket && a.similarityBucket === similarityBucket,
            );
            selected = pickFirstBySortedId(relaxed);
            relaxedTitleConstraint = selected !== null;
          }
          results.push({ cell: { cohort, lengthBucket, similarityBucket, titleBucket }, relaxedTitleConstraint, selected });
        }
      }
    }
  }
  return results;
}

export type PilotSampleSelection = {
  cellResults: CellResult[];
  unfilledCells: SampleCell[];
  sampleDocuments: ClassifiedArchiveDocument[];
};

/** The full, deterministic selection: classify -> select per cell -> dedupe -> sort by id. */
export function selectPilotSample(articles: ArchiveDocumentMetadata[]): PilotSampleSelection {
  const classified = classifyArchive(articles);
  const cellResults = selectPilotSampleCells(classified);

  const seenIds = new Set<string>();
  const sampleDocuments: ClassifiedArchiveDocument[] = [];
  for (const result of cellResults) {
    if (result.selected && !seenIds.has(result.selected.id)) {
      seenIds.add(result.selected.id);
      sampleDocuments.push(result.selected);
    }
  }
  sampleDocuments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const unfilledCells = cellResults.filter((r) => r.selected === null).map((r) => r.cell);

  return { cellResults, unfilledCells, sampleDocuments };
}
