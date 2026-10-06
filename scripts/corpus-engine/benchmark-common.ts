import { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import { LocalDirectoryObjectStore } from "../../lib/corpus-engine/storage";
import { DEFAULT_VERIFIER_PATH, type VerifierPath } from "../../lib/corpus-engine/verifier-adapter";

/**
 * Corpus Engine v1 — shared types of the 10k correctness benchmark.
 *
 * The benchmark asks one question: does putting retrieval in front of the
 * existing verifier change the answer the existing verifier would have given
 * had it been shown every document? "The answer" is the matched-position
 * union and the final similarity score, not only a list of ids.
 */

export type CatalogEntry = {
  docId: string;
  tokenCount: number;
  fingerprintCount: number;
  language: string | null;
  sourceType: string;
  provider: string;
  dataset: string;
  externalId: string;
  title: string | null;
  syntheticLoadOnly: boolean;
  aliasCount: number;
  partition: number;
  segmentId: string;
};

export type IntendedSource = {
  docId: string;
  /** Whitespace-delimited words taken from the source. */
  words: number;
  /** Words under the scoring normalization — the unit the verifier counts in. */
  normalizedWords: number;
  edit: "verbatim" | "every-40th-word-replaced" | "every-12th-word-replaced";
  /** First whitespace word of the passage inside the submission. */
  submissionWordStart: number;
};

export type BenchmarkQuery = {
  id: string;
  category:
    | "exact-document"
    | "near-exact-passage"
    | "heavily-edited-passage"
    | "short-excerpt"
    | "mixed-source"
    | "many-small-sources"
    | "dominant-plus-small"
    | "long-submission"
    | "common-language-negative"
    | "legal-boilerplate"
    | "duplicate-alias"
    | "crowded-by-near-duplicates"
    | "multilingual-mix";
  language: "en" | "fr" | "ar" | "mixed";
  description: string;
  /** What the construction intends: a source the text was copied from, or none. */
  intendedSources: IntendedSource[];
  /** positive = at least one intended source is long enough for the verifier to admit. */
  expectation: "positive" | "negative" | "below-verifier-threshold";
  text: string;
};

export type ReferenceResult = {
  queryId: string;
  submissionWordCount: number;
  documentsVerified: number;
  /** Admitted by the existing verifier (before co-source attribution). */
  admittedDocIds: string[];
  /** Passed STRICT_SPAN but were suppressed by FAMILY_GUARD. */
  suppressedDocIds: string[];
  /** Left with positions after the existing co-source attribution. */
  attributedDocIds: string[];
  matchedPositions: number[];
  matchedWordCount: number;
  unifiedScore: number;
  failures: unknown[];
  verifyCpuMs: number;
};

/**
 * `--verifier-path oracle | prepared-submission`: which implementation of the
 * admission step a benchmark runs. Both must give the same result; running a
 * benchmark once on each is how that is checked on a real corpus.
 */
export function verifierPathArgument(args: Record<string, string>, fallback: VerifierPath = DEFAULT_VERIFIER_PATH): VerifierPath {
  const value = args["verifier-path"];
  if (value === undefined) return fallback;
  if (value !== "oracle" && value !== "prepared-submission") throw new Error(`--verifier-path must be "oracle" or "prepared-submission", not ${JSON.stringify(value)}`);
  return value;
}

export async function openGeneration(root: string, generationId: string, options: { dictionaryBlockCacheBlocks?: number } = {}) {
  const store = new LocalDirectoryObjectStore(root);
  const reader = await CorpusGenerationReader.open({ store, generationId, dictionaryBlockCacheBlocks: options.dictionaryBlockCacheBlocks });
  return { store, reader };
}

/** Positions as inclusive [start, end] runs — compact and exact. */
export function toRanges(positions: readonly number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const position of positions) {
    const last = ranges[ranges.length - 1];
    if (last && position === last[1] + 1) last[1] = position;
    else ranges.push([position, position]);
  }
  return ranges;
}

export function fromRanges(ranges: ReadonlyArray<readonly [number, number]>): number[] {
  const positions: number[] = [];
  for (const [start, end] of ranges) for (let position = start; position <= end; position += 1) positions.push(position);
  return positions;
}
