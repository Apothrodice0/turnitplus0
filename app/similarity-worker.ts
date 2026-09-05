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

  // 100k-scale architecture, slice 1: the actual matching/scoring algorithm
  // now lives in lib/archive-similarity-scoring.ts, shared with the
  // server-side DB-backed adapter (lib/archive-corpus-matching.ts) — this is
  // only the browser-specific data source (binary-search over the packed
  // static index) and the risk/quotation/reference-list framing this worker
  // has always layered on top. Behavior is unchanged: same statements, same
  // order, same two progress posts, wired through onProgress below.
  const result = scoreAgainstArchive(
    text,
    {
      shingleSize: search.shingleSize,
      documentCount: search.documentCount,
      maximumDocumentFrequency: search.maximumDocumentFrequency,
      articles: search.articles,
      getPostings: (hash) => indexPostings(search, hash),
    },
    {
      minimumMatchedWords: risk.matchingParameters?.minimumMatchedWords,
      maximumDocumentFrequency: risk.matchingParameters?.maximumDocumentFrequency,
      minimumSourceContribution: risk.matchingParameters?.minimumSourceContribution,
      maximumContributingSources: risk.matchingParameters?.maximumContributingSources,
      sourceWeighting: risk.matchingParameters?.sourceWeighting,
    },
    (progress, label) => self.postMessage({ type: "progress", progress, label }),
  );

  const words = tokens(text);
  const triples = grams(words, 3);
  const frequency = triples.reduce<Record<string, number>>((total, gram) => {
    total[gram] = (total[gram] ?? 0) + 1;
    return total;
  }, {});
  const repeats = Object.entries(frequency)
    .filter(([gram, count]) => count >= 3 && !/^(the|and|for|with|that|this|from|into|have|has|was|were)\b/.test(gram))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  const scoreBand = search.scoreBands.find(
    (candidate) => result.score >= candidate.minimum && result.score <= candidate.maximum,
  )?.label ?? "High";
  const completeWordCount = normalize(text).split(" ").filter(Boolean).length;
  const referenceListRatio = Math.max(0, (completeWordCount - result.wordCount) / Math.max(1, completeWordCount));
  const quotedWordCount = [...text.matchAll(/["“«]([\s\S]*?)["”»]/g)]
    .reduce((total, match) => total + tokens(match[1]).length, 0);
  const quotationDensity = quotedWordCount / Math.max(1, completeWordCount);
  const riskStatus = result.score >= risk.archiveCutoff ? "Elevated" : "Lower";
  return {
    wordCount: result.wordCount,
    databaseSize: result.databaseSize,
    excludedDocuments: result.excludedDocuments,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    score: result.score,
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
      maxSourceContainment: result.maxSourceContainment,
      longestMatchedSpan: result.longestMatchedSpan,
      quotationDensity: Math.round(quotationDensity * 1000) / 1000,
      referenceListRatio: Math.round(referenceListRatio * 1000) / 1000,
      highFrequencyShingleCount: result.highFrequencyShingleCount,
      repeatedThreeGramCount: repeats.length,
      detectedLanguage: detectLanguage(text),
    },
    corpusVersion: search.corpusVersion,
    // sourceIndex exists on ArchiveScoringSource for the DB-backed adapter's
    // own use (mapping back to representation/article identity) — the
    // browser worker's own output shape never included it, so it is
    // stripped back out here for byte-identical parity with every existing
    // consumer of this worker's postMessage result.
    sources: result.sources.map(({ sourceIndex: _sourceIndex, ...source }) => source),
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
  detectLanguage,
  grams,
  normalize,
  tokens,
} from "@/lib/similarity-core";
import { scoreAgainstArchive } from "@/lib/archive-similarity-scoring";
