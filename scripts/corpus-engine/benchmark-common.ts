import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import { LocalDirectoryObjectStore } from "../../lib/corpus-engine/storage";
import { FAMILY_ADMISSION_POLICIES, type FamilyAdmissionPolicyId } from "../../lib/corpus-engine/family-admission";
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

/**
 * A catalog file is either `{ catalog: [...] }` JSON or, for a corpus too large to hold as one JSON string
 * (1M entries), JSON lines with one entry per line (`.jsonl`).
 */
export async function readCatalog(file: string): Promise<CatalogEntry[]> {
  if (!file.endsWith(".jsonl")) return (JSON.parse(readFileSync(file, "utf8")) as { catalog: CatalogEntry[] }).catalog;
  const entries: CatalogEntry[] = [];
  for await (const line of createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) {
    if (line.length > 0) entries.push(JSON.parse(line) as CatalogEntry);
  }
  return entries;
}

export async function writeCatalogJsonLines(file: string, entries: readonly CatalogEntry[]) {
  const stream = createWriteStream(file, { encoding: "utf8" });
  for (const entry of entries) if (!stream.write(`${JSON.stringify(entry)}
`)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
  await new Promise<void>((resolve) => stream.end(() => resolve()));
}

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
    | "multilingual-mix"
    | "natural-near-duplicate"
    | "recurring-public-notice";
  language: "en" | "fr" | "ar" | "mixed";
  description: string;
  /** What the construction intends: a source the text was copied from, or none. */
  intendedSources: IntendedSource[];
  /** Known sources of a reused submission that the generation no longer holds (e.g. revoked); not expected. */
  excludedIntendedSources?: IntendedSource[];
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

/**
 * `--family-policy <id>`: run a benchmark or reference under a named family admission policy instead of the
 * engine's default (undefined). A reference meant to be re-verified under several policies is built under
 * `strict-span-only-measurement`, so every STRICT_SPAN pair is recorded whatever a policy would make of it.
 */
export function familyPolicyArgument(args: Record<string, string>): FamilyAdmissionPolicyId | undefined {
  const value = args["family-policy"];
  if (value === undefined) return undefined;
  if (!FAMILY_ADMISSION_POLICIES.includes(value as FamilyAdmissionPolicyId)) throw new Error(`unknown family policy ${JSON.stringify(value)}`);
  return value as FamilyAdmissionPolicyId;
}

export async function openGeneration(root: string, generationId: string, options: { dictionaryBlockCacheBlocks?: number; dictionaryCacheBytes?: number } = {}) {
  const store = new LocalDirectoryObjectStore(root);
  const reader = await CorpusGenerationReader.open({ store, generationId, dictionaryBlockCacheBlocks: options.dictionaryBlockCacheBlocks, dictionaryCacheBytes: options.dictionaryCacheBytes });
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
