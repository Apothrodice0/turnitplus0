type IndexArticle = {
  id: string;
  title: string;
  sourceType: "Publication";
  originalSimilarity: number | null;
  wordCount: number;
  uniqueShingleCount: number;
};

type SearchIndexMetadata = {
  schema: "tplus-packed-search-index";
  version: 1;
  keyEncoding: "fnv1a32-djb2-hex";
  shingleSize: number;
  documentCount: number;
  totalWords: number;
  corpusVersion: string;
  maximumDocumentFrequency: number;
  scoreBands: Array<{ label: "Low" | "Moderate" | "High"; minimum: number; maximum: number }>;
  articles: IndexArticle[];
  keyCount: number;
  postingCount: number;
  assets: {
    hashes: string;
    offsets: string;
    postings: string;
  };
};

type SearchIndex = SearchIndexMetadata & {
  hashes: Uint32Array;
  offsets: Uint32Array;
  postings: Uint32Array;
};

type WorkerRequest = {
  id: number;
  text: string;
  fileName: string;
};

type RiskCalibration = {
  schema: "turnitplus-risk-calibration";
  version: number;
  corpusVersion: string;
  sampleSize: number;
  targetThreshold: number;
  archiveCutoff: number;
  auc: number;
  precision: number;
  recall: number;
  matchingParameters?: {
    minimumMatchedWords: number;
    maximumDocumentFrequency: number;
    minimumSourceContribution: number;
    maximumContributingSources: number | null;
    sourceWeighting: "raw" | "containment";
  };
};

let indexPromise: Promise<SearchIndex> | null = null;
let riskPromise: Promise<RiskCalibration> | null = null;

function loadIndex() {
  if (!indexPromise) {
    self.postMessage({ type: "progress", progress: 36, label: "Loading comparison data" });
    indexPromise = fetch("/data/document-index.meta.json", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("The document index metadata could not be loaded.");
      const metadata = await response.json() as SearchIndexMetadata;
      if (metadata.schema !== "tplus-packed-search-index" || metadata.version !== 1) {
        throw new Error("The document index uses an unsupported schema.");
      }
      self.postMessage({ type: "progress", progress: 45, label: "Loading reference data" });
      const assetResponses = await Promise.all(
        [metadata.assets.hashes, metadata.assets.offsets, metadata.assets.postings]
          .map((asset) => fetch(`/data/${asset}`)),
      );
      if (assetResponses.some((assetResponse) => !assetResponse.ok)) {
        throw new Error("One or more document index components could not be loaded.");
      }
      const [hashBuffer, offsetBuffer, postingBuffer] = await Promise.all(
        assetResponses.map((assetResponse) => assetResponse.arrayBuffer()),
      );
      const hashes = new Uint32Array(hashBuffer);
      const offsets = new Uint32Array(offsetBuffer);
      const postings = new Uint32Array(postingBuffer);
      if (
        hashes.length !== metadata.keyCount * 2
        || offsets.length !== metadata.keyCount + 1
        || postings.length !== metadata.postingCount
        || offsets[offsets.length - 1] !== postings.length
      ) {
        throw new Error("The packed document index is incomplete.");
      }
      self.postMessage({ type: "progress", progress: 58, label: "Reference data ready" });
      return { ...metadata, hashes, offsets, postings };
    });
  }
  return indexPromise;
}

function indexPostings(search: SearchIndex, hash: string) {
  const first = Number.parseInt(hash.slice(0, 8), 16) >>> 0;
  const second = Number.parseInt(hash.slice(8, 16), 16) >>> 0;
  let low = 0;
  let high = search.keyCount - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const middleFirst = search.hashes[middle * 2];
    const middleSecond = search.hashes[middle * 2 + 1];
    if (middleFirst === first && middleSecond === second) {
      return search.postings.subarray(search.offsets[middle], search.offsets[middle + 1]);
    }
    if (middleFirst < first || (middleFirst === first && middleSecond < second)) low = middle + 1;
    else high = middle - 1;
  }
  return new Uint32Array(0);
}

function loadRiskCalibration() {
  riskPromise ??= fetch("/data/risk-calibration.json").then(async (response) => {
    if (!response.ok) throw new Error("The risk calibration could not be loaded.");
    const value = await response.json() as RiskCalibration;
    if (
      value.schema !== "turnitplus-risk-calibration"
      || !Number.isInteger(value.version)
      || value.version < 1
      || value.version > 8
    ) {
      throw new Error("The risk calibration uses an unsupported schema.");
    }
    return value;
  });
  return riskPromise;
}

async function analyze(text: string) {
  const [search, risk] = await Promise.all([loadIndex(), loadRiskCalibration()]);
  if (risk.corpusVersion !== search.corpusVersion) {
    throw new Error("The risk calibration does not match the current archive.");
  }
  const words = tokens(text);
  const documentGrams = grams(words, search.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  let highFrequencyShingleCount = 0;

  uniqueDocumentGrams.forEach((gram) => {
    const sourceIndexes = indexPostings(search, gramHash(gram));
    if (sourceIndexes.length >= Math.max(3, Math.ceil(search.maximumDocumentFrequency * 0.75))) {
      highFrequencyShingleCount += 1;
    }
    sourceIndexes.forEach((sourceIndex) => {
      sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    });
  });

  const excluded = new Set<number>();
  search.articles.forEach((article, sourceIndex) => {
    const shared = sharedBySource.get(sourceIndex) ?? 0;
    if (containment(shared, uniqueDocumentGrams.size, article.uniqueShingleCount) >= 0.75) {
      excluded.add(sourceIndex);
    }
  });
  self.postMessage({ type: "progress", progress: 68, label: "Comparing distinctive passages" });

  const eligibleCount = search.documentCount - excluded.size;
  const minimumMatchedWords = risk.matchingParameters?.minimumMatchedWords ?? search.shingleSize;
  const runtimeMaximumDocumentFrequency = Math.min(
    search.maximumDocumentFrequency,
    risk.matchingParameters?.maximumDocumentFrequency ?? search.maximumDocumentFrequency,
  );
  const positionScores = new Map<number, Map<number, number>>();
  documentGrams.forEach((gram, start) => {
    const sourceIndexes = indexPostings(search, gramHash(gram)).filter(
      (sourceIndex) => !excluded.has(sourceIndex),
    );
    if (
      sourceIndexes.length === 0
      || sourceIndexes.length > runtimeMaximumDocumentFrequency
      || !informativeGram(gram)
    ) return;
    const idf = Math.log((eligibleCount + 1) / (sourceIndexes.length + 1)) + 1;
    sourceIndexes.forEach((sourceIndex) => {
      for (let position = start; position < start + search.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
  });

  const matchedBySource = new Map<number, Set<number>>();
  positionScores.forEach((scores, position) => {
    const best = [...scores.entries()].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0]?.[0];
    if (best === undefined) return;
    const positions = matchedBySource.get(best) ?? new Set<number>();
    positions.add(position);
    matchedBySource.set(best, positions);
  });

  const { spansBySource } = acceptedSimilaritySpans(
    matchedBySource,
    minimumMatchedWords,
  );
  const evidence = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set<number>();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(
        sharedBySource.get(sourceIndex) ?? 0,
        uniqueDocumentGrams.size,
        search.articles[sourceIndex].uniqueShingleCount,
      ),
    };
  });
  const aggregation = aggregateSimilaritySources(evidence, words.length, {
    minimumSourceContribution: risk.matchingParameters?.minimumSourceContribution ?? 0,
    maximumContributingSources: risk.matchingParameters?.maximumContributingSources ?? null,
    sourceWeighting: risk.matchingParameters?.sourceWeighting ?? "raw",
  });
  const acceptedSourceIndexes = new Set(aggregation.sourceContributions.map((source) => source.sourceIndex));
  const allMatchedPositions = aggregation.acceptedPositions;

  const sources = [...matchedBySource.entries()].filter(([sourceIndex]) => acceptedSourceIndexes.has(sourceIndex))
    .map(([sourceIndex]) => {
    const validSpans = spansBySource.get(sourceIndex) ?? [];
    const acceptedSourcePositions = new Set<number>();
    validSpans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) acceptedSourcePositions.add(position);
    });
    const phrases = validSpans.flatMap(([start, end]) => {
      const chunks: string[] = [];
      for (let cursor = start; cursor <= end; cursor += 34) {
        if (end - cursor + 1 < search.shingleSize) break;
        chunks.push(words.slice(cursor, Math.min(end + 1, cursor + 40)).join(" "));
      }
      return chunks;
    });
    return {
      name: search.articles[sourceIndex].title,
      type: "Publication" as const,
      color: "#d7263d",
      matches: validSpans.length,
      matchedWords: acceptedSourcePositions.size,
      phrases,
      percent: Math.floor((acceptedSourcePositions.size / Math.max(words.length, 1)) * 100),
    };
  }).filter((source) => source.matches > 0)
    .sort((left, right) => right.percent - left.percent || right.matches - left.matches)
    .slice(0, 20);

  const triples = grams(words, 3);
  const frequency = triples.reduce<Record<string, number>>((result, gram) => {
    result[gram] = (result[gram] ?? 0) + 1;
    return result;
  }, {});
  const repeats = Object.entries(frequency)
    .filter(([gram, count]) => count >= 3 && !/^(the|and|for|with|that|this|from|into|have|has|was|were)\b/.test(gram))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  self.postMessage({ type: "progress", progress: 88, label: "Calculating similarity result" });
  const score = aggregation.score;
  const scoreBand = search.scoreBands.find(
    (candidate) => score >= candidate.minimum && score <= candidate.maximum,
  )?.label ?? "High";
  const longestMatchedSpan = sources.reduce(
    (maximum, source) => Math.max(maximum, ...source.phrases.map((phrase) => phrase.split(" ").length), 0),
    0,
  );
  const maxSourceContainment = Math.max(
    0,
    ...[...sharedBySource.entries()]
      .filter(([sourceIndex]) => !excluded.has(sourceIndex))
      .map(([sourceIndex, shared]) => containment(
        shared,
        uniqueDocumentGrams.size,
        search.articles[sourceIndex].uniqueShingleCount,
      )),
  );
  const completeWordCount = normalize(text).split(" ").filter(Boolean).length;
  const referenceListRatio = Math.max(0, (completeWordCount - words.length) / Math.max(1, completeWordCount));
  const quotedWordCount = [...text.matchAll(/["“«]([\s\S]*?)["”»]/g)]
    .reduce((total, match) => total + tokens(match[1]).length, 0);
  const quotationDensity = quotedWordCount / Math.max(1, completeWordCount);
  const riskStatus = score >= risk.archiveCutoff ? "Elevated" : "Lower";
  return {
    wordCount: words.length,
    databaseSize: eligibleCount,
    excludedDocuments: excluded.size,
    matchedWordCount: allMatchedPositions.size,
    archiveMatchedPositions: [...allMatchedPositions].sort((left, right) => left - right),
    score,
    scoreBand,
    riskStatus,
    riskTarget: risk.targetThreshold,
    riskCutoff: risk.archiveCutoff,
    riskCalibration: {
      auc: risk.auc,
      precision: risk.precision,
      recall: risk.recall,
      sampleSize: risk.sampleSize,
    },
    features: {
      maxSourceContainment: Math.round(maxSourceContainment * 1000) / 1000,
      longestMatchedSpan,
      quotationDensity: Math.round(quotationDensity * 1000) / 1000,
      referenceListRatio: Math.round(referenceListRatio * 1000) / 1000,
      highFrequencyShingleCount,
      repeatedThreeGramCount: repeats.length,
      detectedLanguage: detectLanguage(text),
    },
    corpusVersion: search.corpusVersion,
    sources,
    repeats,
  };
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = await analyze(event.data.text);
    self.postMessage({ id: event.data.id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : "Similarity analysis failed.",
    });
  }
});

export {};
import {
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  detectLanguage,
  gramHash,
  grams,
  informativeGram,
  normalize,
  tokens,
} from "@/lib/similarity-core";
