/**
 * tools/import-medical-similarity-set.ts
 *
 * READ-ONLY AUDIT — builds nothing, seals nothing, materializes nothing.
 *
 * Scans the medical article / Turnitin-report dataset and writes ONE local JSON
 * audit describing every pair, plus a deterministic, leakage-safe, ADVISORY
 * development / sealed-holdout split proposal.
 *
 * The dataset carries two independent naming conventions, both handled here:
 *   - "numbered-docx": `NN.docx` article  +  `NN-Turnitin.pdf` report
 *                      (ids `docx-01`..`docx-30`; Turnitin UI language: French)
 *   - "med-pdf":       `Med (N).pdf` article  +  `MedNTurnitinReport.pdf` report
 *                      (ids `med-001`..`med-114`; Turnitin UI language: English)
 *
 * Per pair it records:
 *   - article / report filenames, pairing status, stable id, dataset group
 *   - article text extraction status + parser/extraction errors
 *   - detected document language (dominant-window label + English-evidence signals)
 *   - raw + eligible (reference-stripped) word counts
 *   - the Turnitin "Overall Similarity" / "Similarité globale" % from the report
 *   - maximum hashed-5-gram containment against the shipped 230-document archive
 *     index, the closest archive document, and the REAL predicted archive-overlap
 *     % from the shipped v8 scorer (answers "is 0% a coverage gap?" directly)
 *   - duplicate / near-duplicate flags (vs the archive, and within this set)
 *   - a deterministic dev / sealed-holdout / excluded assignment
 *
 * The split:
 *   - duplicate/revision clusters are detected FIRST (union-find over >= 0.5
 *     five-gram containment); each cluster is COLLAPSED to one representative
 *     (best matching English pair, most text) and the rest are excluded as
 *     revision duplicates — so a cluster never straddles the two sets and never
 *     places two copies in either (the sealed evaluator rejects duplicate
 *     revision groups; re-indexing identical text corrupts the index)
 *   - the sealed holdout is stratified on TWO axes — Turnitin score band (Low
 *     0-5 / Moderate 6-15 / High 16-100, mirroring the shipped index bands) and
 *     article length band (33rd/67th percentile of the eligible pool) — then
 *     ranked by sha256 of the article's normalized text (content-addressed, so
 *     order- and filename-independent), and sized to --holdout (default 23)
 *   - every other usable English revision-independent pair is development
 *   - pairs with a hard failure (missing file, unreadable, unparseable score,
 *     non-English article, or >= 0.5 containment with the current archive) are
 *     excluded from BOTH sets and reported with reasons
 *
 * What this tool NEVER does: write corpus/manifest.json, regenerate any
 * public/data/* artifact, touch a database, run training, or seal / copy /
 * "open" any cohort. The proposed holdout is a suggestion in the JSON — no
 * text file is written for it and nothing is removed from anywhere. The tool's
 * only side effect is the audit file named by --out.
 *
 * Reads (never writes): the source directory, public/data/document-index.json.gz,
 * and public/data/risk-calibration.json (for the matching parameters only).
 *
 * Usage:
 *   node --import tsx tools/import-medical-similarity-set.ts \
 *     --input "D:/Corps Turnitin/Medcine" \
 *     [--index public/data/document-index.json.gz] \
 *     [--calibration public/data/risk-calibration.json] \
 *     [--out corpus/audit/medical-similarity-set-audit.json] \
 *     [--holdout 23] [--dev-target 80]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import mammoth from "mammoth";
import {
  DEFAULT_SOURCE_AGGREGATION,
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  detectDominantLanguage,
  gramHash,
  grams,
  informativeGram,
  tokens,
  type SourceAggregationParameters,
} from "../lib/similarity-core";
import {
  ARCHIVE_LEAKAGE_CONTAINMENT,
  FINAL_TEST_MINIMUM_WORDS,
  REPORT_PAIR_MINIMUM_CONTAINMENT,
  REVISION_CONTAINMENT,
  englishLanguageEvidence,
  originalCoverageInReport,
  parseTurnitinReportText,
  sha256ReadyText,
  type TurnitinReportEvidence,
} from "./similarity-final-test-core";
import { extractPdfTextDocument } from "../lib/pdf-text-extraction";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const INPUT_DIR = resolve(argument("--input", "D:/Corps Turnitin/Medcine"));
const INDEX_PATH = resolve(argument("--index", "public/data/document-index.json.gz"));
const CALIBRATION_PATH = resolve(argument("--calibration", "public/data/risk-calibration.json"));
const OUT_PATH = resolve(argument("--out", "corpus/audit/medical-similarity-set-audit.json"));
const HOLDOUT_TARGET = Math.max(0, Math.trunc(Number(argument("--holdout", "23"))) || 0);
const DEV_TARGET = Math.max(0, Math.trunc(Number(argument("--dev-target", "80"))) || 0);

// ---------------------------------------------------------------------------
// opt-in corpus emit — writes the clean, revision-independent pairs as
// index-source + similarity-calibration entries into corpus/manifest.json +
// corpus/similarity/text/. Off by default; `--emit-corpus` previews (dry run),
// `--emit-corpus --commit` actually writes. Never touches the shipped index,
// public/data/*, calibration, the DB, or the 14 excluded / 6 revision-dup
// pairs. Existing manifest entries are preserved byte-for-byte (append only).
// ---------------------------------------------------------------------------
const EMIT_CORPUS = process.argv.includes("--emit-corpus");
const EMIT_COMMIT = process.argv.includes("--commit");
const MANIFEST_PATH = resolve(argument("--manifest", "corpus/manifest.json"));
const TEXT_DIR = resolve(argument("--text-dir", "corpus/similarity/text"));
const EXPECT_CLEAN = Math.max(0, Math.trunc(Number(argument("--expect-clean", "91"))) || 0);
const CORPUS_BATCH = argument("--corpus-batch", "medical-2026-08");
const CORPUS_RETRIEVED_AT = argument("--retrieved-at", new Date().toISOString().slice(0, 10));
const MEDICAL_DISCIPLINE = argument("--discipline", "medicine");
const AUDIT_CROSSCHECK_PATH = resolve(argument("--audit-crosscheck", "corpus/audit/medical-similarity-set-audit.json"));

// Defensive: this audit tool must never write a protected artifact, whatever
// --out is passed.
const forbidden = [
  "public/data/",
  "corpus/manifest.json",
  "corpus/similarity-final-test/",
  "corpus/similarity-medical-holdout/",
];
const outRel = OUT_PATH.replace(/\\/g, "/");
if (forbidden.some((fragment) => outRel.includes(fragment))) {
  throw new Error(`Refusing to write the audit to a protected path (${OUT_PATH}). Pick a different --out.`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const round4 = (value: number) => Number(value.toFixed(4));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const pad = (value: string | number, width: number) => String(Number(value)).padStart(width, "0");

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round4((sorted[mid - 1] + sorted[mid]) / 2);
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return round4(lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function distribution(values: number[]) {
  return {
    count: values.length,
    min: values.length ? round4(Math.min(...values)) : null,
    p25: quantile(values, 0.25),
    median: median(values),
    p75: quantile(values, 0.75),
    p95: quantile(values, 0.95),
    max: values.length ? round4(Math.max(...values)) : null,
    mean: values.length ? round4(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
  };
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Containment of the smaller hashed-5-gram set in the larger — symmetric revision metric. */
function gramSetContainment(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared += 1;
  return shared / small.size;
}

// ---------------------------------------------------------------------------
// the shipped 230-document archive index
// ---------------------------------------------------------------------------

type IndexArticle = {
  id: string;
  title: string;
  sourceType: string;
  originalSimilarity: number | null;
  wordCount: number;
  uniqueShingleCount: number;
};
type SearchIndex = {
  schema: string;
  version: number;
  shingleSize: number;
  corpusVersion: string;
  documentCount: number;
  maximumDocumentFrequency: number;
  scoreBands: Array<{ label: string; minimum: number; maximum: number }>;
  articles: IndexArticle[];
  invertedIndex: Record<string, number[]>;
};

if (!existsSync(INDEX_PATH)) throw new Error(`Missing archive index: ${INDEX_PATH}`);
const index = JSON.parse(gunzipSync(readFileSync(INDEX_PATH)).toString("utf8")) as SearchIndex;
if (index.schema !== "tplus-search-index") throw new Error(`Unexpected index schema: ${index.schema}`);

type MatchParams = { minimumMatchedWords: number; maximumDocumentFrequency: number } & SourceAggregationParameters;

let matchingParameters: MatchParams;
let matchingParametersSource: string;
if (existsSync(CALIBRATION_PATH)) {
  const calibration = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")) as {
    schema?: string;
    version?: number;
    corpusVersion?: string;
    matchingParameters?: MatchParams;
  };
  if (calibration.matchingParameters && calibration.corpusVersion === index.corpusVersion) {
    matchingParameters = calibration.matchingParameters;
    matchingParametersSource = `risk-calibration.json v${calibration.version ?? "?"}`;
  } else {
    matchingParameters = {
      minimumMatchedWords: index.shingleSize,
      maximumDocumentFrequency: index.maximumDocumentFrequency,
      ...DEFAULT_SOURCE_AGGREGATION,
    };
    matchingParametersSource = "engineering defaults (calibration missing or stale for this corpusVersion)";
  }
} else {
  matchingParameters = {
    minimumMatchedWords: index.shingleSize,
    maximumDocumentFrequency: index.maximumDocumentFrequency,
    ...DEFAULT_SOURCE_AGGREGATION,
  };
  matchingParametersSource = "engineering defaults (no risk-calibration.json)";
}

/** Unique hashed 5-grams of a submission, computed exactly as build-index.ts does (tokens() strips the reference section). */
function submissionGramHashes(text: string): Set<string> {
  const words = tokens(text);
  const hashes = new Set<string>();
  for (const gram of new Set(grams(words, index.shingleSize))) hashes.add(gramHash(gram));
  return hashes;
}

/** Max archive containment + closest archive document, using lib/similarity-core's own containment() formula. */
function archiveContainment(gramHashes: Set<string>) {
  const sharedByDoc = new Map<number, number>();
  for (const hash of gramHashes) {
    const posting = index.invertedIndex[hash];
    if (!posting) continue;
    for (const docIndex of posting) sharedByDoc.set(docIndex, (sharedByDoc.get(docIndex) ?? 0) + 1);
  }
  const scored = [...sharedByDoc.entries()].map(([docIndex, shared]) => ({
    docIndex,
    shared,
    containment: containment(shared, gramHashes.size, index.articles[docIndex].uniqueShingleCount),
  }));
  scored.sort((a, b) => b.containment - a.containment || b.shared - a.shared);
  const best = scored[0] ?? null;
  return {
    uniqueFiveGrams: gramHashes.size,
    matchedArchiveDocuments: sharedByDoc.size,
    maxContainment: best ? round4(best.containment) : 0,
    maxSharedFiveGrams: best ? best.shared : 0,
    closestDocument: best
      ? {
        id: index.articles[best.docIndex].id,
        title: index.articles[best.docIndex].title,
        containment: round4(best.containment),
        sharedFiveGrams: best.shared,
        archiveUniqueShingleCount: index.articles[best.docIndex].uniqueShingleCount,
      }
      : null,
    topMatches: scored.slice(0, 5).map((entry) => ({
      id: index.articles[entry.docIndex].id,
      title: index.articles[entry.docIndex].title,
      containment: round4(entry.containment),
      sharedFiveGrams: entry.shared,
    })),
  };
}

/** The real runtime archive-overlap score for this text — the exact algorithm from app/similarity-worker.ts / tools/evaluate-similarity-final-test.ts, run against the shipped index + matching parameters. Answers "is 0% a coverage artifact?" directly. */
function predictedArchiveOverlapPercent(text: string): number {
  const words = tokens(text);
  const documentGrams = grams(words, index.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);

  const sharedBySource = new Map<number, number>();
  uniqueDocumentGrams.forEach((gram) => {
    for (const source of index.invertedIndex[gramHash(gram)] ?? []) {
      sharedBySource.set(source, (sharedBySource.get(source) ?? 0) + 1);
    }
  });

  const excluded = new Set<number>();
  index.articles.forEach((article, sourceIndex) => {
    if (containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, article.uniqueShingleCount) >= 0.75) {
      excluded.add(sourceIndex);
    }
  });

  const positionScores = new Map<number, Map<number, number>>();
  const eligibleCount = index.articles.length - excluded.size;
  documentGrams.forEach((gram, start) => {
    if (!informativeGram(gram)) return;
    const postings = (index.invertedIndex[gramHash(gram)] ?? []).filter((source) => !excluded.has(source));
    if (!postings.length || postings.length > matchingParameters.maximumDocumentFrequency) return;
    const idf = Math.log((eligibleCount + 1) / (postings.length + 1)) + 1;
    postings.forEach((sourceIndex) => {
      for (let position = start; position < start + index.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
  });

  const matchedBySource = new Map<number, Set<number>>();
  positionScores.forEach((scores, position) => {
    const best = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
    if (best === undefined) return;
    const positions = matchedBySource.get(best) ?? new Set<number>();
    positions.add(position);
    matchedBySource.set(best, positions);
  });

  const { spansBySource } = acceptedSimilaritySpans(matchedBySource, matchingParameters.minimumMatchedWords);
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
        index.articles[sourceIndex].uniqueShingleCount,
      ),
    };
  });
  return aggregateSimilaritySources(evidence, words.length, matchingParameters).score;
}

// ---------------------------------------------------------------------------
// PDF / DOCX extraction (read-only; pure-JS pdf.js first, pdftotext fallback)
// ---------------------------------------------------------------------------

type PdfjsModule = { getDocument(source: { data: Uint8Array; verbosity?: number }): { promise: Promise<Parameters<typeof extractPdfTextDocument>[0]> } };
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => null) as PdfjsModule | null;

async function extractPdf(path: string): Promise<{ text: string; extractor: string; error: string | null }> {
  if (pdfjs) {
    try {
      const data = new Uint8Array(readFileSync(path));
      const document = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
      const text = await extractPdfTextDocument(document);
      if (text.trim()) return { text, extractor: "pdfjs-text-layer", error: null };
    } catch {
      /* fall through to pdftotext */
    }
  }
  try {
    const text = execFileSync("pdftotext", ["-layout", path, "-"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 180_000,
    });
    if (text.trim()) return { text, extractor: "pdftotext-layout", error: null };
    return { text: "", extractor: "none", error: "both pdf.js and pdftotext produced empty text (image-only / no text layer?)" };
  } catch (error) {
    return { text: "", extractor: "none", error: `pdf extraction failed: ${message(error)}` };
  }
}

async function extractDocx(path: string): Promise<{ text: string; extractor: string; error: string | null }> {
  try {
    const value = (await mammoth.extractRawText({ buffer: readFileSync(path) })).value;
    if (value.trim()) return { text: value, extractor: "mammoth.extractRawText", error: null };
    return { text: "", extractor: "mammoth.extractRawText", error: "docx produced empty text" };
  } catch (error) {
    return { text: "", extractor: "none", error: `docx unreadable: ${message(error)}` };
  }
}

/**
 * Turnitin similarity reports come in whatever UI language the account uses.
 * This set has BOTH: the numbered-docx reports are French ("Similarité
 * globale", "ID de la copie", …) and the med-pdf reports are English ("Overall
 * Similarity", "Submission ID", …). parseTurnitinReportText
 * (similarity-final-test-core.ts) is English-only and is left untouched; this
 * is a local, additive bilingual wrapper that falls back to French patterns
 * when the English parse finds no score. Same TurnitinReportEvidence shape.
 */
function parseTurnitinReportBilingual(text: string): TurnitinReportEvidence & { reportLanguage: "en" | "fr" | "unknown" } {
  const english = parseTurnitinReportText(text);
  if (english.score !== null) return { ...english, reportLanguage: "en" };

  const frScoreMatch = text.match(/(\d{1,3})\s*%\s*Similarit[ée]\s+globale/i)
    ?? text.match(/Similarit[ée]\s+globale[\s\S]{0,40}?(\d{1,3})\s*%/i);
  const rawScore = frScoreMatch ? Number(frScoreMatch[1]) : null;
  const score = rawScore !== null && Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 100 ? rawScore : null;
  if (score === null) return { ...english, reportLanguage: text.match(/Similarit[ée]\s+globale|ID de la copie/i) ? "fr" : "unknown" };

  const submissionId = text.match(/trn:oid:+\d+:\d+/i)?.[0]
    ?? text.match(/(?:Submission ID|ID de la copie)\s*:?\s*(trn:oid\S+|\d{6,})/i)?.[1]
    ?? null;
  const submissionDate = text.match(/Date de la copie\s+(.+?)\s+Date de t[ée]l[ée]chargement/i)?.[1]?.trim()
    ?? text.match(/Date de la copie\s*\n+\s*([^\n\r]+)/i)?.[1]?.trim()
    ?? null;
  const wordMatch = text.match(/([\d\s ,.]{1,12})\s*mots\b/i);
  const submittedWordCount = wordMatch ? Number(wordMatch[1].replace(/[\s ,.]/g, "")) || null : null;
  const submittedFileName = text.match(/Nom du fichier\s+(\S+\.\w{2,5})/i)?.[1]?.trim() ?? null;

  return {
    score,
    submissionId,
    submissionDate,
    submittedWordCount,
    submittedFileName,
    isSimilarityReport: score !== null && submissionId !== null,
    reportLanguage: "fr",
  };
}

// ---------------------------------------------------------------------------
// pair the source directory (two naming conventions)
// ---------------------------------------------------------------------------

if (!existsSync(INPUT_DIR)) throw new Error(`Missing input directory: ${INPUT_DIR}`);

const entries = readdirSync(INPUT_DIR).filter((name) => !name.startsWith("."));

type DatasetGroup = "numbered-docx" | "med-pdf";
type ArticleFormat = "docx" | "pdf";
type ArticleEntry = { file: string; group: DatasetGroup; format: ArticleFormat; number: number };
type ReportEntry = { file: string; group: DatasetGroup; number: number };

const NUMBERED_PLUS = /^(\d{1,3})[-_ ]*turnitin\s*plus/i;
const NUMBERED_ARTICLE = /^(\d{1,3})\.docx$/i;
const NUMBERED_REPORT = /^(\d{1,3})[-_ ]*turnit\w*\.pdf$/i;
const MED_PLUS = /^med\s*\(?\s*(\d{1,3})\s*\)?\s*turnitin\s*plus/i;
const MED_ARTICLE = /^med\s*\(\s*(\d{1,3})\s*\)\.pdf$/i;
const MED_REPORT = /^med\s*(\d{1,3})\s*turnitin\s*report\.pdf$/i;

const articleFiles = new Map<string, ArticleEntry>();
const reportFiles = new Map<string, ReportEntry>();
const turnitinPlusIgnored: string[] = [];
const unrecognizedFiles: string[] = [];
const otherFilesIgnored: string[] = [];

const claimArticle = (id: string, entry: ArticleEntry) => {
  if (articleFiles.has(id)) unrecognizedFiles.push(`${entry.file} (duplicate article id ${id}; kept ${articleFiles.get(id)!.file})`);
  else articleFiles.set(id, entry);
};
const claimReport = (id: string, entry: ReportEntry) => {
  if (reportFiles.has(id)) unrecognizedFiles.push(`${entry.file} (duplicate report id ${id}; kept ${reportFiles.get(id)!.file})`);
  else reportFiles.set(id, entry);
};

for (const name of entries) {
  const ext = extname(name).toLowerCase();
  let match: RegExpMatchArray | null;
  if ((match = name.match(NUMBERED_PLUS))) { turnitinPlusIgnored.push(name); continue; }
  if ((match = name.match(MED_PLUS))) { turnitinPlusIgnored.push(name); continue; }
  if ((match = name.match(NUMBERED_ARTICLE))) {
    claimArticle(`docx-${pad(match[1], 2)}`, { file: name, group: "numbered-docx", format: "docx", number: Number(match[1]) });
    continue;
  }
  if ((match = name.match(MED_ARTICLE))) {
    claimArticle(`med-${pad(match[1], 3)}`, { file: name, group: "med-pdf", format: "pdf", number: Number(match[1]) });
    continue;
  }
  if ((match = name.match(NUMBERED_REPORT))) {
    claimReport(`docx-${pad(match[1], 2)}`, { file: name, group: "numbered-docx", number: Number(match[1]) });
    continue;
  }
  if ((match = name.match(MED_REPORT))) {
    claimReport(`med-${pad(match[1], 3)}`, { file: name, group: "med-pdf", number: Number(match[1]) });
    continue;
  }
  if (ext === ".pdf" || ext === ".docx") unrecognizedFiles.push(name);
  else otherFilesIgnored.push(name);
}

const allIds = [...new Set([...articleFiles.keys(), ...reportFiles.keys()])].sort();

// ---------------------------------------------------------------------------
// audit every pair
// ---------------------------------------------------------------------------

type Doc = {
  id: string;
  datasetGroup: DatasetGroup;
  number: number;
  articleFile: string | null;
  articleFormat: ArticleFormat | null;
  reportFile: string | null;
  article: {
    extractionStatus: "ok" | "failed" | "missing";
    extractor: string;
    extractionErrors: string[];
    textSha256: string | null;
    rawWordCount: number;
    eligibleWordCount: number;
    dominantLanguage: { language: string; confidence: number } | null;
    englishEvidence: ReturnType<typeof englishLanguageEvidence> | null;
  };
  report: {
    status: "ok" | "missing" | "unreadable" | "not-similarity-report";
    extractor: string;
    reportLanguage: "en" | "fr" | "unknown";
    parseErrors: string[];
    turnitinSimilarityPercent: number | null;
    submissionId: string | null;
    submissionDate: string | null;
    submittedWordCount: number | null;
    submittedFileName: string | null;
    reportCoversArticleFraction: number | null;
  };
  archive: {
    uniqueFiveGrams: number;
    matchedArchiveDocuments: number;
    maxContainment: number;
    maxSharedFiveGrams: number;
    closestDocument: ReturnType<typeof archiveContainment>["closestDocument"];
    topMatches: ReturnType<typeof archiveContainment>["topMatches"];
    predictedArchiveOverlapPercent: number | null;
    nearDuplicateOfArchive: boolean;
  };
  intraSet: {
    nearDuplicate: boolean;
    clusterId: string | null;
    nearDuplicateOf: string[];
    maxIntraContainment: number;
    revisionGroupId: string | null;
    revisionRepresentative: boolean;
    revisionRepresentativeId: string | null;
  };
  excludedReasons: string[];
  holdoutBlockers: string[];
  devRoleEligibility: { indexSource: boolean; similarityCalibration: boolean };
  usable: boolean;
  holdoutEligible: boolean;
  proposedSplit: "dev" | "holdout" | "excluded";
  /** internal — stripped from the emitted JSON. */
  _gramHashes: Set<string>;
  /** internal — retained only for --emit-corpus; stripped from the emitted JSON. */
  _readyText: string;
  _reportSha256: string | null;
  _titleGuess: string | null;
};

const docs: Doc[] = [];

for (const id of allIds) {
  const articleEntry = articleFiles.get(id) ?? null;
  const reportEntry = reportFiles.get(id) ?? null;
  const groupGuess: DatasetGroup = articleEntry?.group ?? reportEntry?.group ?? (id.startsWith("med-") ? "med-pdf" : "numbered-docx");

  const doc: Doc = {
    id,
    datasetGroup: groupGuess,
    number: articleEntry?.number ?? reportEntry?.number ?? Number(id.replace(/\D/g, "")),
    articleFile: articleEntry?.file ?? null,
    articleFormat: articleEntry?.format ?? null,
    reportFile: reportEntry?.file ?? null,
    article: {
      extractionStatus: articleEntry ? "ok" : "missing",
      extractor: "none",
      extractionErrors: [],
      textSha256: null,
      rawWordCount: 0,
      eligibleWordCount: 0,
      dominantLanguage: null,
      englishEvidence: null,
    },
    report: {
      status: reportEntry ? "ok" : "missing",
      extractor: "none",
      reportLanguage: "unknown",
      parseErrors: [],
      turnitinSimilarityPercent: null,
      submissionId: null,
      submissionDate: null,
      submittedWordCount: null,
      submittedFileName: null,
      reportCoversArticleFraction: null,
    },
    archive: {
      uniqueFiveGrams: 0,
      matchedArchiveDocuments: 0,
      maxContainment: 0,
      maxSharedFiveGrams: 0,
      closestDocument: null,
      topMatches: [],
      predictedArchiveOverlapPercent: null,
      nearDuplicateOfArchive: false,
    },
    intraSet: {
      nearDuplicate: false,
      clusterId: null,
      nearDuplicateOf: [],
      maxIntraContainment: 0,
      revisionGroupId: null,
      revisionRepresentative: false,
      revisionRepresentativeId: null,
    },
    excludedReasons: [],
    holdoutBlockers: [],
    devRoleEligibility: { indexSource: false, similarityCalibration: false },
    usable: false,
    holdoutEligible: false,
    proposedSplit: "excluded",
    _gramHashes: new Set<string>(),
    _readyText: "",
    _reportSha256: null,
    _titleGuess: null,
  };

  let articleRawText = "";
  if (articleEntry) {
    const extraction = articleEntry.format === "docx"
      ? await extractDocx(join(INPUT_DIR, articleEntry.file))
      : await extractPdf(join(INPUT_DIR, articleEntry.file));
    doc.article.extractor = extraction.extractor;
    if (extraction.error) {
      doc.article.extractionStatus = "failed";
      doc.article.extractionErrors.push(extraction.error);
    } else {
      articleRawText = extraction.text;
      const ready = sha256ReadyText(articleRawText);
      doc._readyText = ready;
      doc.article.textSha256 = sha256(ready);
      doc.article.rawWordCount = articleRawText.trim() ? articleRawText.trim().split(/\s+/).length : 0;
      const eligibleWords = tokens(articleRawText);
      doc.article.eligibleWordCount = eligibleWords.length;
      const language = detectDominantLanguage(articleRawText);
      doc.article.dominantLanguage = { language: language.language, confidence: round4(language.confidence) };
      doc.article.englishEvidence = englishLanguageEvidence(articleRawText);
      doc._gramHashes = submissionGramHashes(articleRawText);

      const archive = archiveContainment(doc._gramHashes);
      doc.archive.uniqueFiveGrams = archive.uniqueFiveGrams;
      doc.archive.matchedArchiveDocuments = archive.matchedArchiveDocuments;
      doc.archive.maxContainment = archive.maxContainment;
      doc.archive.maxSharedFiveGrams = archive.maxSharedFiveGrams;
      doc.archive.closestDocument = archive.closestDocument;
      doc.archive.topMatches = archive.topMatches;
      doc.archive.nearDuplicateOfArchive = archive.maxContainment >= ARCHIVE_LEAKAGE_CONTAINMENT;
      doc.archive.predictedArchiveOverlapPercent = predictedArchiveOverlapPercent(articleRawText);
    }
  }

  if (reportEntry) {
    const reportPath = join(INPUT_DIR, reportEntry.file);
    doc._reportSha256 = sha256(readFileSync(reportPath));
    const extraction = await extractPdf(reportPath);
    doc.report.extractor = extraction.extractor;
    if (extraction.error) {
      doc.report.status = "unreadable";
      doc.report.parseErrors.push(extraction.error);
    } else {
      const evidence = parseTurnitinReportBilingual(extraction.text);
      doc.report.reportLanguage = evidence.reportLanguage;
      doc.report.turnitinSimilarityPercent = evidence.score;
      doc.report.submissionId = evidence.submissionId;
      doc.report.submissionDate = evidence.submissionDate;
      doc.report.submittedWordCount = evidence.submittedWordCount;
      doc.report.submittedFileName = evidence.submittedFileName;
      if (!evidence.isSimilarityReport) {
        doc.report.status = "not-similarity-report";
        if (evidence.score === null) doc.report.parseErrors.push("no \"Overall Similarity\" / \"Similarité globale\" / \"SIMILARITY INDEX\" percentage found");
        if (evidence.submissionId === null) doc.report.parseErrors.push("no Turnitin submission id found");
      }
      if (articleRawText) {
        doc.report.reportCoversArticleFraction = round4(originalCoverageInReport(articleRawText, extraction.text));
        if (evidence.isSimilarityReport && (doc.report.reportCoversArticleFraction ?? 0) < REPORT_PAIR_MINIMUM_CONTAINMENT) {
          doc.report.parseErrors.push(`report text covers only ${((doc.report.reportCoversArticleFraction ?? 0) * 100).toFixed(1)}% of the article's 5-grams (< ${REPORT_PAIR_MINIMUM_CONTAINMENT * 100}% — report may not match this article)`);
        }
      }
    }
  }

  docs.push(doc);
}

const docById = new Map(docs.map((doc) => [doc.id, doc]));

// ---------------------------------------------------------------------------
// intra-set near-duplicate / revision clusters (5-gram containment >= 0.5)
// Detected BEFORE the split so a cluster is never split across dev / holdout.
// ---------------------------------------------------------------------------

const parent = new Map<string, string>();
const find = (id: string): string => {
  let root = id;
  while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
  return root;
};
for (const doc of docs) parent.set(doc.id, doc.id);

for (let left = 0; left < docs.length; left += 1) {
  for (let right = left + 1; right < docs.length; right += 1) {
    const a = docs[left];
    const b = docs[right];
    if (a._gramHashes.size === 0 || b._gramHashes.size === 0) continue;
    const overlap = gramSetContainment(a._gramHashes, b._gramHashes);
    if (overlap < REVISION_CONTAINMENT) continue;
    a.intraSet.nearDuplicate = true;
    b.intraSet.nearDuplicate = true;
    a.intraSet.nearDuplicateOf.push(b.id);
    b.intraSet.nearDuplicateOf.push(a.id);
    a.intraSet.maxIntraContainment = Math.max(a.intraSet.maxIntraContainment, round4(overlap));
    b.intraSet.maxIntraContainment = Math.max(b.intraSet.maxIntraContainment, round4(overlap));
    parent.set(find(a.id), find(b.id));
  }
}
for (const doc of docs) {
  if (doc.intraSet.nearDuplicate) doc.intraSet.clusterId = `medset-cluster-${find(doc.id)}`;
}

/** The connected near-dup component a doc belongs to (a singleton for docs with no near-dup). */
const componentMembers = new Map<string, string[]>();
for (const doc of docs) {
  const key = doc.intraSet.clusterId ?? `singleton-${doc.id}`;
  componentMembers.set(key, [...(componentMembers.get(key) ?? []), doc.id]);
}

// ---------------------------------------------------------------------------
// collapse each near-dup / revision component to ONE representative
// ---------------------------------------------------------------------------
// A cluster is never split across dev and holdout AND never contributes more
// than one document to either set: the eventual sealed evaluator rejects
// duplicate revision groups, and re-indexing identical text corrupts the
// index's document-frequency / self-exclusion. Non-representatives are
// excluded as "revision-duplicate-of-<rep>" (a benign dedup, reported apart
// from hard failures) and can never reach dev or holdout.

/** The member that best anchors a revision group: a real, matching, English pair with the most text. */
function pickRepresentative(members: Doc[]): Doc {
  const rank = (doc: Doc) => {
    const coverage = doc.report.reportCoversArticleFraction ?? -1;
    const completePair = doc.articleFile && doc.article.extractionStatus === "ok"
      && doc.reportFile && doc.report.turnitinSimilarityPercent !== null ? 1 : 0;
    const english = doc.article.englishEvidence?.classification === "English" ? 1 : 0;
    const reportMatches = coverage >= REPORT_PAIR_MINIMUM_CONTAINMENT ? 1 : 0;
    return { completePair, english, reportMatches, coverage, words: doc.article.eligibleWordCount };
  };
  return [...members].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return rb.completePair - ra.completePair
      || rb.english - ra.english
      || rb.reportMatches - ra.reportMatches
      || rb.coverage - ra.coverage
      || rb.words - ra.words
      || a.id.localeCompare(b.id);
  })[0];
}

for (const [key, ids] of componentMembers) {
  const members = ids.map((id) => docById.get(id)!);
  const groupId = members.length > 1 ? key : `revision-${ids[0]}`;
  const representative = members.length > 1 ? pickRepresentative(members) : members[0];
  for (const member of members) {
    member.intraSet.revisionGroupId = groupId;
    member.intraSet.revisionRepresentative = member.id === representative.id;
    member.intraSet.revisionRepresentativeId = representative.id;
  }
}

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------

for (const doc of docs) {
  const excluded: string[] = [];
  if (doc.intraSet.revisionGroupId && !doc.intraSet.revisionRepresentative) {
    excluded.push(`revision-duplicate-of-${doc.intraSet.revisionRepresentativeId}`);
  }
  if (!doc.articleFile) excluded.push("article-file-missing");
  else if (doc.article.extractionStatus === "failed") excluded.push("article-extraction-failed");
  if (!doc.reportFile) excluded.push("turnitin-report-missing");
  else if (doc.report.status === "unreadable") excluded.push("turnitin-report-unreadable");
  else if (doc.report.status === "not-similarity-report") excluded.push("not-a-complete-turnitin-similarity-report");
  else if (doc.report.turnitinSimilarityPercent === null) excluded.push("turnitin-similarity-percent-unparsed");
  if (doc.articleFile && doc.article.extractionStatus === "ok" && doc.article.englishEvidence?.classification !== "English") {
    excluded.push(`article-language-${(doc.article.englishEvidence?.classification ?? "unknown").toLowerCase()}`);
  }
  if (doc.archive.nearDuplicateOfArchive) {
    excluded.push(`near-duplicate-of-current-archive (containment ${doc.archive.maxContainment}, closest ${doc.archive.closestDocument?.id ?? "n/a"})`);
  }
  doc.excludedReasons = excluded;
  doc.usable = excluded.length === 0;
}

for (const doc of docs) {
  const blockers: string[] = [];
  if (doc.usable) {
    if (doc.article.eligibleWordCount < FINAL_TEST_MINIMUM_WORDS) {
      blockers.push(`fewer-than-${FINAL_TEST_MINIMUM_WORDS}-eligible-words (${doc.article.eligibleWordCount})`);
    }
    if ((doc.report.reportCoversArticleFraction ?? 0) < REPORT_PAIR_MINIMUM_CONTAINMENT) {
      blockers.push(`report-covers-under-${REPORT_PAIR_MINIMUM_CONTAINMENT * 100}%-of-article (${doc.report.reportCoversArticleFraction ?? 0})`);
    }
  }
  doc.holdoutBlockers = blockers;
  doc.devRoleEligibility = {
    // any usable English medical article is valid index-source material
    indexSource: doc.usable,
    // similarity-calibration additionally needs a report we can trust maps to this article
    similarityCalibration: doc.usable && (doc.report.reportCoversArticleFraction ?? 0) >= REPORT_PAIR_MINIMUM_CONTAINMENT,
  };
  // Non-representatives are already excluded, so a usable doc is a stand-alone
  // revision-independent unit; holdout-eligibility is just its own quality.
  doc.holdoutEligible = doc.usable && doc.holdoutBlockers.length === 0;
}

// ---------------------------------------------------------------------------
// deterministic, stratified dev / holdout / excluded split
// ---------------------------------------------------------------------------
// Operates on revision-independent units — every near-dup cluster has already
// been collapsed to one representative, so a cluster can neither straddle the
// two sets nor place two copies in one.

// Turnitin score bands mirror public/data/document-index.meta.json scoreBands:
// Low 0-5, Moderate 6-15, High 16-100.
const scoreBand = (percent: number | null): 0 | 1 | 2 => {
  if (percent === null || percent <= 5) return 0;
  if (percent <= 15) return 1;
  return 2;
};
const BAND_LABELS = ["Low(0-5)", "Moderate(6-15)", "High(16-100)"] as const;

// The holdout is stratified on TWO axes so it mirrors the development pool on
// both dimensions that move a similarity score: the Turnitin score band AND the
// article length (long documents produce more shingles and behave differently
// under the percentage-of-words math). Length cut points are the 33rd/67th
// percentiles of the holdout-eligible pool's eligible word counts — data-driven
// and therefore still fully deterministic.
const holdoutEligibleDocs = docs.filter((doc) => doc.holdoutEligible);
const eligibleWordCounts = holdoutEligibleDocs.map((doc) => doc.article.eligibleWordCount);
const lengthCut1 = quantile(eligibleWordCounts, 1 / 3) ?? 0;
const lengthCut2 = quantile(eligibleWordCounts, 2 / 3) ?? 0;
const lengthBand = (words: number): 0 | 1 | 2 => (words <= lengthCut1 ? 0 : words <= lengthCut2 ? 1 : 2);
const LENGTH_BAND_LABELS = [`short(<=${Math.round(lengthCut1)}w)`, `medium(<=${Math.round(lengthCut2)}w)`, `long(>${Math.round(lengthCut2)}w)`] as const;

type HoldoutCandidate = { doc: Doc; scoreBand: 0 | 1 | 2; lengthBand: 0 | 1 | 2; stratum: number; rank: string };

const holdoutCandidates: HoldoutCandidate[] = holdoutEligibleDocs.map((doc) => {
  const sb = scoreBand(doc.report.turnitinSimilarityPercent);
  const lb = lengthBand(doc.article.eligibleWordCount);
  return {
    doc,
    scoreBand: sb,
    lengthBand: lb,
    stratum: sb * 3 + lb,
    // content-addressed deterministic rank: sha256 of the normalized article
    // text — independent of filename, directory order, and re-runs
    rank: sha256(doc.article.textSha256 ?? doc.id),
  };
});

const STRATA = 9;
const stratumCandidates: HoldoutCandidate[][] = Array.from({ length: STRATA }, () => []);
for (const candidate of holdoutCandidates) stratumCandidates[candidate.stratum].push(candidate);
for (const stratum of stratumCandidates) {
  stratum.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.doc.id.localeCompare(b.doc.id)));
}

const stratumCounts = stratumCandidates.map((candidates) => candidates.length);
const totalHoldoutEligibleDocs = stratumCounts.reduce((sum, count) => sum + count, 0);
const holdoutSize = Math.min(HOLDOUT_TARGET, totalHoldoutEligibleDocs);

// largest-remainder allocation of holdoutSize across the (up to 9) strata,
// proportional to each stratum's available document count
const idealPerStratum = stratumCounts.map((count) => (totalHoldoutEligibleDocs === 0 ? 0 : (holdoutSize * count) / totalHoldoutEligibleDocs));
const allocation = idealPerStratum.map(Math.floor);
let remaining = holdoutSize - allocation.reduce((sum, value) => sum + value, 0);
for (const stratum of Array.from({ length: STRATA }, (_, i) => i)
  .sort((a, b) => (idealPerStratum[b] - allocation[b]) - (idealPerStratum[a] - allocation[a]) || a - b)) {
  if (remaining <= 0) break;
  if (allocation[stratum] < stratumCounts[stratum]) { allocation[stratum] += 1; remaining -= 1; }
}
while (remaining > 0) {
  const stratum = Array.from({ length: STRATA }, (_, i) => i).find((candidate) => allocation[candidate] < stratumCounts[candidate]);
  if (stratum === undefined) break;
  allocation[stratum] += 1;
  remaining -= 1;
}

// take the lowest-hash k candidates per stratum
const holdoutIds = new Set<string>();
const stratumAssigned = new Array(STRATA).fill(0);
for (let stratum = 0; stratum < STRATA; stratum += 1) {
  for (const candidate of stratumCandidates[stratum].slice(0, allocation[stratum])) holdoutIds.add(candidate.doc.id);
  stratumAssigned[stratum] = Math.min(allocation[stratum], stratumCounts[stratum]);
}

// per-score-band roll-up (for reporting / the existing bandAllocation shape)
const bandDocCounts = [0, 1, 2].map((sb) => stratumCandidates.slice(sb * 3, sb * 3 + 3).reduce((sum, list) => sum + list.length, 0));
const bandAssigned = [0, 1, 2].map((sb) => stratumAssigned.slice(sb * 3, sb * 3 + 3).reduce((sum: number, value: number) => sum + value, 0));
const bandHoldoutAllocation = [0, 1, 2].map((sb) => allocation.slice(sb * 3, sb * 3 + 3).reduce((sum, value) => sum + value, 0));

for (const doc of docs) {
  doc.proposedSplit = holdoutIds.has(doc.id) ? "holdout" : doc.usable ? "dev" : "excluded";
}

const devDocs = docs.filter((doc) => doc.proposedSplit === "dev");
const holdoutDocs = docs.filter((doc) => doc.proposedSplit === "holdout");
const excludedDocs = docs.filter((doc) => doc.proposedSplit === "excluded");

// ---------------------------------------------------------------------------
// leakage warnings
// ---------------------------------------------------------------------------

const leakageWarnings: Array<{ severity: "error" | "warning" | "info"; type: string; detail: string }> = [];

// 1. any holdout <-> dev pair whose 5-gram containment reaches the revision guard
for (const held of holdoutDocs) {
  for (const dev of devDocs) {
    if (held._gramHashes.size === 0 || dev._gramHashes.size === 0) continue;
    const overlap = gramSetContainment(held._gramHashes, dev._gramHashes);
    if (overlap >= REVISION_CONTAINMENT) {
      leakageWarnings.push({
        severity: "error",
        type: "holdout-dev-near-duplicate",
        detail: `${held.id} <-> ${dev.id}: 5-gram containment ${round4(overlap)} >= ${REVISION_CONTAINMENT}`,
      });
    }
  }
}

// 2. holdout doc that overlaps the CURRENT archive above the report-pair floor
for (const held of holdoutDocs) {
  if (held.archive.maxContainment >= REPORT_PAIR_MINIMUM_CONTAINMENT) {
    leakageWarnings.push({
      severity: held.archive.maxContainment >= ARCHIVE_LEAKAGE_CONTAINMENT ? "error" : "warning",
      type: "holdout-overlaps-current-archive",
      detail: `${held.id}: archive containment ${held.archive.maxContainment} (closest ${held.archive.closestDocument?.id ?? "n/a"})`,
    });
  }
}

// 3. a near-dup component whose surviving (non-excluded) members did not all
//    land in the same split — after collapse this should be impossible
for (const [key, ids] of componentMembers) {
  if (ids.length < 2) continue;
  const placed = ids.map((id) => docById.get(id)!).filter((doc) => doc.proposedSplit !== "excluded");
  const splits = new Set(placed.map((doc) => doc.proposedSplit));
  if (splits.size > 1) {
    leakageWarnings.push({
      severity: "error",
      type: "near-dup-cluster-straddles-dev-and-holdout",
      detail: `${key}: ${placed.map((doc) => `${doc.id}->${doc.proposedSplit}`).join(", ")}`,
    });
  }
}

// 4. two holdout docs sharing a revision group — the sealed evaluator rejects
//    this; after collapse it should never happen
const holdoutRevisionGroups = new Map<string, string[]>();
for (const held of holdoutDocs) {
  const group = held.intraSet.revisionGroupId ?? held.id;
  holdoutRevisionGroups.set(group, [...(holdoutRevisionGroups.get(group) ?? []), held.id]);
}
for (const [group, ids] of holdoutRevisionGroups) {
  if (ids.length > 1) {
    leakageWarnings.push({
      severity: "error",
      type: "duplicate-revision-group-in-holdout",
      detail: `${group}: ${ids.join(", ")}`,
    });
  }
}

// 5. dev doc that is a near-duplicate of the current archive (should not be re-indexed)
for (const dev of devDocs) {
  if (dev.archive.maxContainment >= ARCHIVE_LEAKAGE_CONTAINMENT) {
    leakageWarnings.push({
      severity: "error",
      type: "dev-near-duplicate-of-current-archive",
      detail: `${dev.id}: archive containment ${dev.archive.maxContainment}`,
    });
  }
}

// ---------------------------------------------------------------------------
// distributions
// ---------------------------------------------------------------------------

const extractedDocs = docs.filter((doc) => doc.articleFile && doc.article.extractionStatus === "ok");
const scoredDocs = docs.filter((doc) => doc.report.turnitinSimilarityPercent !== null);

const scoreBandCounts = (subset: Doc[]) => {
  const counts = [0, 0, 0];
  for (const doc of subset) {
    if (doc.report.turnitinSimilarityPercent === null) continue;
    counts[scoreBand(doc.report.turnitinSimilarityPercent)] += 1;
  }
  return counts;
};
const languageCounts = (subset: Doc[]) => tally(
  subset
    .filter((doc) => doc.article.englishEvidence)
    .map((doc) => doc.article.englishEvidence!.classification),
);
const dominantLanguageCounts = (subset: Doc[]) => tally(
  subset
    .filter((doc) => doc.article.dominantLanguage)
    .map((doc) => doc.article.dominantLanguage!.language),
);

const wordHistogram = (subset: Doc[]) => {
  const edges = [0, 300, 1000, 2500, 5000, 10000, Infinity];
  const labels = ["<300", "300-999", "1000-2499", "2500-4999", "5000-9999", ">=10000"];
  const counts = new Array(labels.length).fill(0);
  for (const doc of subset) {
    if (!doc.articleFile || doc.article.extractionStatus !== "ok") continue;
    const words = doc.article.eligibleWordCount;
    for (let bucket = 0; bucket < labels.length; bucket += 1) {
      if (words >= edges[bucket] && words < edges[bucket + 1]) { counts[bucket] += 1; break; }
    }
  }
  return Object.fromEntries(labels.map((label, bucket) => [label, counts[bucket]]));
};

const devScores = devDocs.map((doc) => doc.report.turnitinSimilarityPercent).filter((value): value is number => value !== null);
const holdoutScores = holdoutDocs.map((doc) => doc.report.turnitinSimilarityPercent).filter((value): value is number => value !== null);
const devWords = devDocs.filter((doc) => doc.article.extractionStatus === "ok").map((doc) => doc.article.eligibleWordCount);
const holdoutWords = holdoutDocs.filter((doc) => doc.article.extractionStatus === "ok").map((doc) => doc.article.eligibleWordCount);

const devScoreDist = distribution(devScores);
const devWordDist = distribution(devWords);
const holdoutMedianScore = median(holdoutScores);
const holdoutMedianWords = median(holdoutWords);

// ---------------------------------------------------------------------------
// assemble + write the single audit file
// ---------------------------------------------------------------------------

const containmentValues = extractedDocs.map((doc) => doc.archive.maxContainment);
const overlapValues = docs.map((doc) => doc.archive.predictedArchiveOverlapPercent).filter((value): value is number => value !== null);
const scoreValues = scoredDocs.map((doc) => doc.report.turnitinSimilarityPercent!) as number[];

const clustersReport = [...componentMembers.entries()]
  .filter(([, ids]) => ids.length > 1)
  .map(([key, ids]) => {
    const members = ids.map((id) => docById.get(id)!);
    const representative = members.find((doc) => doc.intraSet.revisionRepresentative) ?? members[0];
    return {
      clusterId: key,
      size: ids.length,
      memberIds: ids,
      maxPairwiseContainment: round4(Math.max(...members.map((doc) => doc.intraSet.maxIntraContainment))),
      turnitinScores: members.map((doc) => ({ id: doc.id, turnitinSimilarityPercent: doc.report.turnitinSimilarityPercent, reportCoversArticleFraction: doc.report.reportCoversArticleFraction })),
      representativeId: representative.id,
      representativeSplit: representative.proposedSplit,
      collapsedMemberIds: members.filter((doc) => doc.id !== representative.id).map((doc) => doc.id),
      splitAssignments: Object.fromEntries(members.map((doc) => [doc.id, doc.proposedSplit])),
      atomic: members.filter((doc) => doc.proposedSplit !== "excluded").every((doc) => doc.proposedSplit === representative.proposedSplit),
    };
  });

const hardExcludedDocs = excludedDocs.filter((doc) => doc.excludedReasons.some((reason) => !reason.startsWith("revision-duplicate-of-")));
const revisionDuplicateDocs = excludedDocs.filter((doc) => doc.excludedReasons.every((reason) => reason.startsWith("revision-duplicate-of-")));

const holdoutTargetDelta = holdoutDocs.length - HOLDOUT_TARGET;
const devTargetDelta = devDocs.length - DEV_TARGET;
const deviationNotes: string[] = [];
if (holdoutDocs.length !== HOLDOUT_TARGET) {
  deviationNotes.push(
    `Holdout is ${holdoutDocs.length}, target ${HOLDOUT_TARGET} (${holdoutTargetDelta >= 0 ? "+" : ""}${holdoutTargetDelta}). `
    + `Only ${totalHoldoutEligibleDocs} revision-independent pairs are holdout-eligible (usable, English, >= `
    + `${FINAL_TEST_MINIMUM_WORDS} words, report covers >= ${REPORT_PAIR_MINIMUM_CONTAINMENT * 100}% of the article).`,
  );
}
if (devDocs.length !== DEV_TARGET) {
  deviationNotes.push(
    `Development is ${devDocs.length}, target ${DEV_TARGET} (${devTargetDelta >= 0 ? "+" : ""}${devTargetDelta}). `
    + `Of ${docs.filter((doc) => doc.articleFile && doc.reportFile).length} candidate pairs: `
    + `${hardExcludedDocs.length} hard-excluded (${hardExcludedDocs.filter((doc) => doc.excludedReasons.some((reason) => reason.startsWith("article-language-"))).length} non-English, `
    + `${hardExcludedDocs.filter((doc) => doc.excludedReasons.includes("turnitin-report-missing") || doc.excludedReasons.includes("article-file-missing")).length} unpaired), `
    + `${revisionDuplicateDocs.length} collapsed as exact/near revision duplicates, ${holdoutDocs.length} sealed into the holdout, `
    + `leaving ${devDocs.length} for development. Development = every revision-independent usable pair not in the holdout.`,
  );
}

const audit = {
  schema: "turnitplus-medical-similarity-set-audit",
  version: 2,
  generatedBy: "tools/import-medical-similarity-set.ts",
  generatedAt: new Date().toISOString(),
  readOnly: true,
  mutations:
    "NONE. Reads the source directory + public/data/document-index.json.gz + public/data/risk-calibration.json. "
    + "Writes only this audit file. corpus/manifest.json, public/data/*, benchmark-corpus.json, calibration observations, "
    + "and every database are untouched. The proposed holdout is advisory — no text was copied, sealed, or removed.",

  datasetSummary: {
    directory: INPUT_DIR,
    filesScanned: entries.length,
    articleFiles: articleFiles.size,
    reportFiles: reportFiles.size,
    byGroup: {
      "numbered-docx": {
        articles: [...articleFiles.values()].filter((entry) => entry.group === "numbered-docx").length,
        reports: [...reportFiles.values()].filter((entry) => entry.group === "numbered-docx").length,
      },
      "med-pdf": {
        articles: [...articleFiles.values()].filter((entry) => entry.group === "med-pdf").length,
        reports: [...reportFiles.values()].filter((entry) => entry.group === "med-pdf").length,
      },
    },
    turnitinPlusReportsIgnored: turnitinPlusIgnored,
    unrecognizedFiles,
    otherFilesIgnored,
    articleLanguage: {
      englishEvidence: languageCounts(extractedDocs),
      dominantWindow: dominantLanguageCounts(extractedDocs),
    },
    articleEligibleWordCount: {
      ...distribution(extractedDocs.map((doc) => doc.article.eligibleWordCount)),
      histogram: wordHistogram(extractedDocs),
    },
  },

  pairingSummary: {
    docEntries: docs.length,
    candidatePairs: docs.filter((doc) => doc.articleFile && doc.reportFile).length,
    fullPairsBothFilesPresent: docs.filter((doc) => doc.articleFile && doc.reportFile).length,
    articlesWithoutReport: docs.filter((doc) => doc.articleFile && !doc.reportFile).map((doc) => ({ id: doc.id, articleFile: doc.articleFile })),
    reportsWithoutArticle: docs.filter((doc) => !doc.articleFile && doc.reportFile).map((doc) => ({ id: doc.id, reportFile: doc.reportFile })),
    usablePairs: docs.filter((doc) => doc.usable).length,
    usableRevisionIndependentArticles: docs.filter((doc) => doc.usable).length,
    hardExcludedPairs: hardExcludedDocs.length,
    revisionDuplicatePairs: revisionDuplicateDocs.length,
    excludedPairs: excludedDocs.length,
    reportLanguages: {
      en: docs.filter((doc) => doc.report.reportLanguage === "en").length,
      fr: docs.filter((doc) => doc.report.reportLanguage === "fr").length,
      unknown: docs.filter((doc) => doc.reportFile && doc.report.reportLanguage === "unknown").length,
    },
  },

  extractionFailures: {
    articleExtractionFailed: docs
      .filter((doc) => doc.article.extractionStatus === "failed")
      .map((doc) => ({ id: doc.id, articleFile: doc.articleFile, format: doc.articleFormat, errors: doc.article.extractionErrors })),
    reportUnreadable: docs
      .filter((doc) => doc.report.status === "unreadable")
      .map((doc) => ({ id: doc.id, reportFile: doc.reportFile, errors: doc.report.parseErrors })),
    reportNotSimilarity: docs
      .filter((doc) => doc.report.status === "not-similarity-report")
      .map((doc) => ({ id: doc.id, reportFile: doc.reportFile, errors: doc.report.parseErrors })),
    turnitinPercentUnparsed: docs
      .filter((doc) => doc.reportFile && doc.report.status !== "unreadable" && doc.report.turnitinSimilarityPercent === null)
      .map((doc) => ({ id: doc.id, reportFile: doc.reportFile })),
    nonEnglishArticles: docs
      .filter((doc) => doc.article.englishEvidence && doc.article.englishEvidence.classification !== "English")
      .map((doc) => ({
        id: doc.id,
        classification: doc.article.englishEvidence!.classification,
        dominantWindow: doc.article.dominantLanguage,
        englishSignalShare: doc.article.englishEvidence!.englishSignalShare,
      })),
    reportDoesNotMatchArticle: docs
      .filter((doc) => doc.usable && (doc.report.reportCoversArticleFraction ?? 1) < REPORT_PAIR_MINIMUM_CONTAINMENT)
      .map((doc) => ({ id: doc.id, reportCoversArticleFraction: doc.report.reportCoversArticleFraction })),
  },

  turnitinScoreDistribution: {
    ...distribution(scoreValues),
    byBand: Object.fromEntries(BAND_LABELS.map((label, band) => [label, scoreBandCounts(scoredDocs)[band]])),
    dev: { ...distribution(devScores), byBand: Object.fromEntries(BAND_LABELS.map((label, band) => [label, scoreBandCounts(devDocs)[band]])) },
    holdout: { ...distribution(holdoutScores), byBand: Object.fromEntries(BAND_LABELS.map((label, band) => [label, scoreBandCounts(holdoutDocs)[band]])) },
  },

  currentArchiveContainmentDistribution: {
    metric: "max hashed-5-gram containment of the medical article in any of the 230 shipped archive documents",
    ...distribution(containmentValues),
    atOrAbove_0_2: containmentValues.filter((value) => value >= 0.2).length,
    atOrAbove_0_5_leakageGuard: containmentValues.filter((value) => value >= ARCHIVE_LEAKAGE_CONTAINMENT).length,
    predictedArchiveOverlapPercent: {
      note: "the REAL shipped v8 scorer's output for each article against the current archive",
      ...distribution(overlapValues),
      countZero: overlapValues.filter((value) => value === 0).length,
      countAtLeast1: overlapValues.filter((value) => value >= 1).length,
    },
  },

  duplicateRevisionClusters: {
    metric: `union-find over intra-set 5-gram containment >= ${REVISION_CONTAINMENT} (REVISION_CONTAINMENT)`,
    multiMemberClusters: clustersReport.length,
    collapsedRevisionDuplicates: revisionDuplicateDocs.length,
    clusters: clustersReport,
    note: clustersReport.length === 0
      ? "No intra-set near-duplicates or revision pairs — every pair is its own singleton revision group."
      : "Every multi-member cluster is collapsed to ONE representative (best matching English pair, most text). "
        + "Non-representatives are excluded as revision duplicates so a cluster never straddles dev/holdout and never "
        + "places two copies in either set. maxPairwiseContainment 1.0 means the members are the SAME article submitted "
        + "twice under different file numbers.",
  },

  split: {
    method:
      "Deterministic and reproducible. (1) Detect near-dup/revision clusters first (union-find, >= "
      + `${REVISION_CONTAINMENT} five-gram containment); collapse each cluster to one representative (best matching English `
      + "pair, most text) and exclude the rest as revision duplicates. (2) A remaining pair is holdout-eligible iff it is "
      + "usable (article extracted, English by englishLanguageEvidence, a parseable Turnitin similarity report, NOT >= "
      + `${ARCHIVE_LEAKAGE_CONTAINMENT} containment with the current 230-doc archive), has >= ${FINAL_TEST_MINIMUM_WORDS} `
      + `eligible words, and has a report that covers >= ${REPORT_PAIR_MINIMUM_CONTAINMENT * 100}% of the article. `
      + "(3) Holdout-eligible pairs are bucketed by Turnitin score band (Low 0-5 / Moderate 6-15 / High 16-100); within a "
      + "band they are ranked by sha256 of the normalized article text (content-addressed, filename/order independent); the "
      + `holdout takes the lowest-hash k per band, per-band k set by largest-remainder allocation to --holdout=${HOLDOUT_TARGET}. `
      + "(4) Every remaining usable pair is development. (5) Non-usable and revision-duplicate pairs are excluded from both sets.",
    holdoutTarget: HOLDOUT_TARGET,
    devTarget: DEV_TARGET,
    holdoutEligiblePairs: totalHoldoutEligibleDocs,
    developmentSetIsRevisionIndependent: true,
    stratification: {
      axes: ["turnitin-score-band", "article-length-band"],
      scoreBands: "Low 0-5 / Moderate 6-15 / High 16-100 (mirrors the shipped index score bands)",
      lengthBands: `33rd/67th percentile of the holdout-eligible pool's eligible word counts: ${LENGTH_BAND_LABELS.join(" / ")}`,
    },
    bandAllocation: Object.fromEntries(BAND_LABELS.map((label, band) => [label, {
      available: bandDocCounts[band],
      allocated: bandHoldoutAllocation[band],
      assigned: bandAssigned[band],
    }])),
    stratumAllocation: Object.fromEntries(
      Array.from({ length: STRATA }, (_, stratum) => [
        `${BAND_LABELS[Math.floor(stratum / 3)]} x ${LENGTH_BAND_LABELS[stratum % 3]}`,
        { available: stratumCounts[stratum], allocated: allocation[stratum], assigned: stratumAssigned[stratum] },
      ]),
    ),
    developmentCount: devDocs.length,
    sealedHoldoutCount: holdoutDocs.length,
    excludedCount: excludedDocs.length,
    hardExcludedCount: hardExcludedDocs.length,
    revisionDuplicateCount: revisionDuplicateDocs.length,
    developmentSetIds: devDocs.map((doc) => doc.id).sort(),
    sealedHoldoutIds: holdoutDocs.map((doc) => doc.id).sort(),
    hardExcludedIds: hardExcludedDocs.map((doc) => ({ id: doc.id, reasons: doc.excludedReasons })).sort((a, b) => a.id.localeCompare(b.id)),
    revisionDuplicateIds: revisionDuplicateDocs
      .map((doc) => ({ id: doc.id, duplicateOf: doc.intraSet.revisionRepresentativeId, representativeSplit: docById.get(doc.intraSet.revisionRepresentativeId ?? "")?.proposedSplit ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    intendedDevelopmentRoles: ["index-source", "similarity-calibration"],
    deviationFromTarget: deviationNotes,
    representativeness: {
      turnitinScore: {
        devMedian: devScoreDist.median,
        devInterquartile: [devScoreDist.p25, devScoreDist.p75],
        holdoutMedian: holdoutMedianScore,
        holdoutMedianWithinDevInterquartile:
          holdoutMedianScore !== null && devScoreDist.p25 !== null && devScoreDist.p75 !== null
            ? holdoutMedianScore >= devScoreDist.p25 && holdoutMedianScore <= devScoreDist.p75
            : null,
      },
      eligibleWordCount: {
        devMedian: devWordDist.median,
        devInterquartile: [devWordDist.p25, devWordDist.p75],
        holdoutMedian: holdoutMedianWords,
        holdoutMedianWithinDevInterquartile:
          holdoutMedianWords !== null && devWordDist.p25 !== null && devWordDist.p75 !== null
            ? holdoutMedianWords >= devWordDist.p25 && holdoutMedianWords <= devWordDist.p75
            : null,
        devHistogram: wordHistogram(devDocs),
        holdoutHistogram: wordHistogram(holdoutDocs),
        lengthBand: {
          cutPoints: [Math.round(lengthCut1), Math.round(lengthCut2)],
          dev: tally(devDocs.filter((doc) => doc.article.extractionStatus === "ok").map((doc) => LENGTH_BAND_LABELS[lengthBand(doc.article.eligibleWordCount)])),
          holdout: tally(holdoutDocs.filter((doc) => doc.article.extractionStatus === "ok").map((doc) => LENGTH_BAND_LABELS[lengthBand(doc.article.eligibleWordCount)])),
        },
      },
      language: {
        dev: languageCounts(devDocs),
        holdout: languageCounts(holdoutDocs),
        note: "Both sets are English-only by construction — non-English articles are excluded upstream.",
      },
      datasetGroup: {
        dev: tally(devDocs.map((doc) => doc.datasetGroup)),
        holdout: tally(holdoutDocs.map((doc) => doc.datasetGroup)),
      },
    },
    materialized: false,
    note:
      "Advisory only. This tool wrote no text files, sealed nothing, and changed no manifest. To use this split later, the "
      + "development pairs would be added to corpus/manifest.json with roles [\"index-source\", \"similarity-calibration\"] and "
      + "the holdout pairs sealed under an isolated corpus/similarity-medical-holdout/ with its own manifest (mirroring "
      + "corpus/similarity-final-test/), evaluated exactly once via a dedicated evaluator.",
  },

  leakageWarnings,

  archive: {
    indexPath: INDEX_PATH,
    corpusVersion: index.corpusVersion,
    documentCount: index.documentCount,
    shingleSize: index.shingleSize,
    indexMaximumDocumentFrequency: index.maximumDocumentFrequency,
    scoreBands: index.scoreBands,
  },
  matchingParameters: { ...matchingParameters, source: matchingParametersSource },
  thresholds: {
    minimumEligibleWords: FINAL_TEST_MINIMUM_WORDS,
    archiveLeakageContainment: ARCHIVE_LEAKAGE_CONTAINMENT,
    intraSetRevisionContainment: REVISION_CONTAINMENT,
    reportPairMinimumContainment: REPORT_PAIR_MINIMUM_CONTAINMENT,
    holdoutTarget: HOLDOUT_TARGET,
    devTarget: DEV_TARGET,
  },

  documents: docs
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((doc) => {
      const { _gramHashes, _readyText, _reportSha256, _titleGuess, ...rest } = doc;
      void _gramHashes;
      void _readyText;
      void _reportSha256;
      void _titleGuess;
      return rest;
    }),
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(audit, null, 2)}\n`, "utf8");

const relOut = isAbsolute(OUT_PATH) ? OUT_PATH : resolve(OUT_PATH);
console.log(JSON.stringify({
  wrote: relOut,
  filesScanned: entries.length,
  articleFiles: articleFiles.size,
  reportFiles: reportFiles.size,
  candidatePairs: audit.pairingSummary.candidatePairs,
  usablePairs: audit.pairingSummary.usablePairs,
  hardExcludedPairs: hardExcludedDocs.length,
  revisionDuplicatePairs: revisionDuplicateDocs.length,
  articleExtractionFailures: audit.extractionFailures.articleExtractionFailed.length,
  nonEnglishArticles: audit.extractionFailures.nonEnglishArticles.length,
  reportLanguages: audit.pairingSummary.reportLanguages,
  turnitinScore: { min: distribution(scoreValues).min, median: distribution(scoreValues).median, max: distribution(scoreValues).max, byBand: audit.turnitinScoreDistribution.byBand },
  archiveContainmentMax: distribution(containmentValues).max,
  predictedArchiveOverlap: audit.currentArchiveContainmentDistribution.predictedArchiveOverlapPercent,
  multiMemberClusters: clustersReport.length,
  split: {
    development: devDocs.length,
    sealedHoldout: holdoutDocs.length,
    excluded: excludedDocs.length,
    holdoutByBand: audit.turnitinScoreDistribution.holdout.byBand,
  },
  leakageWarnings: { count: leakageWarnings.length, bySeverity: tally(leakageWarnings.map((warning) => warning.severity)) },
  deviationFromTarget: deviationNotes,
}, null, 2));

// ===========================================================================
// --emit-corpus : append the clean, revision-independent medical pairs to the
// local similarity corpus as ["index-source", "similarity-calibration"].
// Off by default; `--emit-corpus` previews (dry run), add `--commit` to write.
// Existing manifest entries are preserved byte-for-byte (append-only). Never
// touches public/data/*, the shipped index, calibration, the DB, or the 14
// excluded / 6 revision-duplicate pairs.
// ===========================================================================

/**
 * Human title for the manifest (display metadata only — the index / scorer
 * never reads it; build-index.ts falls back to the id when it is null).
 *
 * numbered-docx: the student manuscripts put the title on their first line and
 * mammoth preserves it, so we take a lightly-cleaned first line.
 *
 * med-pdf: these are journal-typeset PDFs whose first page interleaves the
 * title with running headers, author lists and affiliations; auto-extraction
 * produced truncated or wrong titles, so we use a neutral, fully-traceable
 * label instead (provenance.articleFile / reportFile / submissionId carry the
 * real identity).
 */
function medicalDisplayTitle(doc: Doc, readyText: string): string {
  if (doc.datasetGroup === "numbered-docx") {
    const first = readyText
      .split(/\r?\n/)
      .map((line) => line.normalize("NFKC").replace(/\s+/g, " ").trim())
      .find(Boolean);
    if (first) {
      const candidate = first
        .replace(/\s*\d{0,3}[.)]?\s*Abstract\b[\s\S]*$/i, "")
        .replace(/[\s.,:;\u2013\u2014-]+$/, "")
        .slice(0, 200);
      const words = candidate.split(/\s+/).filter(Boolean);
      if (
        words.length >= 3
        && words.length <= 30
        && /^["\u00c0-\u00ddA-Z0-9]/.test(candidate)
        && !/\babstract\b/i.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return `Medical journal article (${doc.articleFile ?? doc.id})`;
}
function emitMedicalCorpus(): void {
  const TASK_EXCLUDED = new Set([
    "med-001", "med-040", "med-060", "med-080",                       // French articles
    "med-013", "med-036", "med-061", "med-088",                       // missing article / report
    "med-028", "med-030", "med-031", "med-032", "med-035", "med-037", // exact revision duplicates
  ]);

  const clean = docs.filter((doc) => doc.proposedSplit !== "excluded");

  if (clean.length !== EXPECT_CLEAN) {
    throw new Error(`--emit-corpus: expected ${EXPECT_CLEAN} clean pairs, computed ${clean.length}. Refusing to write.`);
  }
  for (const doc of clean) {
    if (TASK_EXCLUDED.has(doc.id)) throw new Error(`--emit-corpus: excluded id ${doc.id} is in the clean set. Refusing.`);
    if (!doc.intraSet.revisionRepresentative) throw new Error(`--emit-corpus: ${doc.id} is not a revision representative. Refusing.`);
    if (!doc._readyText || !doc.article.textSha256) throw new Error(`--emit-corpus: ${doc.id} has no extracted text. Refusing.`);
    const score = doc.report.turnitinSimilarityPercent;
    if (score === null || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`--emit-corpus: ${doc.id} turnitinScore ${score} is out of range. Refusing.`);
    }
    if (doc.article.englishEvidence?.classification !== "English") throw new Error(`--emit-corpus: ${doc.id} is not English. Refusing.`);
    if (!doc.articleFile || !doc.reportFile) throw new Error(`--emit-corpus: ${doc.id} is unpaired. Refusing.`);
    if (doc.excludedReasons.length || doc.holdoutBlockers.length) throw new Error(`--emit-corpus: ${doc.id} carries flags (${[...doc.excludedReasons, ...doc.holdoutBlockers].join(", ")}). Refusing.`);
  }
  for (const id of TASK_EXCLUDED) {
    const doc = docById.get(id);
    if (doc && doc.proposedSplit !== "excluded") throw new Error(`--emit-corpus: id ${id} must be excluded but is ${doc.proposedSplit}. Refusing.`);
  }

  // reuse the audited representatives — cross-check against the audit on disk
  if (existsSync(AUDIT_CROSSCHECK_PATH)) {
    const prior = JSON.parse(readFileSync(AUDIT_CROSSCHECK_PATH, "utf8")) as {
      documents: Array<{ id: string; proposedSplit: string; article: { textSha256: string | null } }>;
    };
    const priorById = new Map(prior.documents.map((entry) => [entry.id, entry]));
    for (const doc of clean) {
      const p = priorById.get(doc.id);
      if (!p) throw new Error(`--emit-corpus: ${doc.id} is absent from the audit (${AUDIT_CROSSCHECK_PATH}). Refusing.`);
      if (p.proposedSplit === "excluded") throw new Error(`--emit-corpus: the audit marks ${doc.id} excluded. Refusing.`);
      if (p.article.textSha256 !== doc.article.textSha256) throw new Error(`--emit-corpus: ${doc.id} text hash disagrees with the audit. Refusing.`);
    }
    const auditClean = prior.documents.filter((entry) => entry.proposedSplit !== "excluded").map((entry) => entry.id).sort();
    if (JSON.stringify(auditClean) !== JSON.stringify(clean.map((doc) => doc.id).sort())) {
      throw new Error(`--emit-corpus: the clean set disagrees with the audit's clean set. Refusing.`);
    }
  }

  if (!existsSync(MANIFEST_PATH)) throw new Error(`--emit-corpus: ${MANIFEST_PATH} is missing. Restore the corpus first.`);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Array<Record<string, unknown>>;
  if (!Array.isArray(manifest)) throw new Error("--emit-corpus: manifest.json is not a JSON array.");
  const existingIds = new Set(manifest.map((entry) => String(entry.id)));
  if (manifest.some((entry) => String(entry.id).startsWith("medical-"))) {
    throw new Error("--emit-corpus: the manifest already contains medical-* entries. Refusing to double-import.");
  }
  const existingGroups = new Set(manifest.map((entry) => entry.revisionGroupId).filter(Boolean).map(String));

  type Emit = { id: string; textFile: string; readyText: string; entry: Record<string, unknown> };
  const emits: Emit[] = [];
  const seenIds = new Set<string>();
  const seenGroups = new Set<string>();
  for (const doc of clean) {
    const textSha256 = doc.article.textSha256!;
    const id = `medical-${textSha256.slice(0, 16)}`;
    const revisionGroupId = `revision-${textSha256.slice(0, 12)}`;
    if (existingIds.has(id)) throw new Error(`--emit-corpus: id ${id} already exists in the corpus. Refusing.`);
    if (seenIds.has(id)) throw new Error(`--emit-corpus: two clean pairs generate the same id ${id}. Refusing.`);
    if (existingGroups.has(revisionGroupId)) throw new Error(`--emit-corpus: revisionGroupId ${revisionGroupId} clashes with the existing manifest. Refusing.`);
    if (seenGroups.has(revisionGroupId)) throw new Error(`--emit-corpus: two clean pairs generate the same revisionGroupId ${revisionGroupId}. Refusing.`);
    seenIds.add(id);
    seenGroups.add(revisionGroupId);
    const title = medicalDisplayTitle(doc, doc._readyText);
    doc._titleGuess = title;
    const entry: Record<string, unknown> = {
      id,
      roles: ["index-source", "similarity-calibration"],
      textPath: `similarity/text/${id}.txt`,
      title,
      language: "English",
      publishedYear: null,
      turnitinScore: doc.report.turnitinSimilarityPercent,
      writerPopulation: null,
      genre: null,
      discipline: MEDICAL_DISCIPLINE,
      provenance: {
        source: "user-supplied medical Turnitin corps (D:/Corps Turnitin/Medcine)",
        url: null,
        journal: null,
        retrievedAt: CORPUS_RETRIEVED_AT,
        sha256: textSha256,
        batch: CORPUS_BATCH,
        datasetGroup: doc.datasetGroup,
        articleFile: doc.articleFile,
        reportFile: doc.reportFile,
        reportSha256: doc._reportSha256,
        submissionId: doc.report.submissionId,
        submissionDate: doc.report.submissionDate,
        submittedFileName: doc.report.submittedFileName,
        extractionMethod: doc.article.extractor,
        reportExtractionMethod: doc.report.extractor,
        scoreEvidence: doc.report.reportLanguage === "fr"
          ? "Turnitin FR report \u2014 \"Similarit\u00e9 globale\" %"
          : "Turnitin EN report \u2014 \"Overall Similarity\" %",
        auditRef: "corpus/audit/medical-similarity-set-audit.json",
      },
      revisionGroupId,
      calibrationIndependent: true,
    };
    emits.push({ id, textFile: join(TEXT_DIR, `${id}.txt`), readyText: doc._readyText, entry });
  }

  if (!EMIT_COMMIT) {
    console.log(JSON.stringify({
      mode: "emit-corpus DRY RUN — pass --commit to write",
      manifestPath: MANIFEST_PATH,
      textDir: TEXT_DIR,
      existingManifestEntries: manifest.length,
      wouldAppend: emits.length,
      prospectiveManifestEntries: manifest.length + emits.length,
      titles: emits.map((e) => ({ id: e.id, turnitinScore: (e.entry as { turnitinScore: number }).turnitinScore, group: ((e.entry as { provenance: { datasetGroup: string } }).provenance).datasetGroup, title: (e.entry as { title: string }).title })),
      sampleEntry: emits[0]?.entry ?? null,
    }, null, 2));
    return;
  }

  mkdirSync(TEXT_DIR, { recursive: true });
  for (const e of emits) {
    if (existsSync(e.textFile)) throw new Error(`--emit-corpus: ${e.textFile} already exists. Refusing to overwrite.`);
  }
  for (const e of emits) writeFileSync(e.textFile, e.readyText, "utf8");
  const nextManifest = [...manifest, ...emits.map((e) => e.entry)];
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    mode: "emit-corpus COMMITTED",
    manifestPath: MANIFEST_PATH,
    textDir: TEXT_DIR,
    appended: emits.length,
    textFilesWritten: emits.length,
    manifestEntries: nextManifest.length,
    ids: emits.map((e) => e.id).sort(),
  }, null, 2));
}

if (EMIT_CORPUS) emitMedicalCorpus();
