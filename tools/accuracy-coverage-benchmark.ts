// TurnitPlus — Accuracy & Coverage Benchmark.
//
// Builds controlled test submissions with KNOWN ground truth (exact copies,
// 50/25/10% partial copies, a few copied sentences, fully original
// controls) across 6 domains, in PDF and DOCX, at short/medium/long
// lengths — and runs every one of them through the real, unmodified
// production pipeline (lib/academic-search's runAcademicSearch,
// lib/unified-similarity's computeUnifiedSimilarity, and the real archive
// lane via scripts/validation/real-archive-analyze.mjs) exactly as a real
// user's report would. This is a BASELINE run: nothing here tunes the
// pipeline, and nothing under lib/ is modified.
//
// See tools/accuracy-benchmark-lib/synthetic-archive.ts's own header
// comment for why a small in-memory synthetic archive index is ALSO built
// (the real production archive corpus's raw text is not available on this
// machine — only a privacy-preserving shingle-hash index is).
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator";
import { createAcademicSearchContentRetriever, retrieveCandidateText } from "../lib/academic-search/text-retriever";
import type { AcademicSearchCandidate, AcademicSearchProviderError, ExternalAcademicEvidence } from "../lib/academic-search/types";
import type { AcademicSearchProvider } from "../lib/academic-search/provider";
import { computeUnifiedSimilarity } from "../lib/unified-similarity";
import { realArchiveAnalyze } from "../scripts/validation/real-archive-analyze.mjs";
import { buildSyntheticArchiveIndex, analyzeSyntheticArchive, type SyntheticArchiveIndex } from "./accuracy-benchmark-lib/synthetic-archive";
import { composeCase, wordCount, type CopyCondition } from "./accuracy-benchmark-lib/compose";
import { writePdf, extractPdf, writeDocx, extractDocx } from "./accuracy-benchmark-lib/render";
import { sourceAllDomainPapers, titlesMatch, normalizeDoi, openaireProvider, europePmcProvider, type DomainPaper } from "./accuracy-benchmark-lib/sources";

const OUTPUT_DIR = path.join(process.cwd(), "tools", "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

// Same undici crash precedent documented in tools/benchmark-academic-coverage.ts —
// swallow rather than lose the rest of an hour-long run.
process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException — continuing] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`[unhandledRejection — continuing] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});

function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(OUTPUT_DIR, `${RUN_ID}.log`), line + "\n");
}

// ---------------------------------------------------------------------------
// Case matrix
// ---------------------------------------------------------------------------

type SizeBucket = "short" | "medium" | "long" | "natural";
type Format = "pdf" | "docx";

const SIZE_WORDS: Record<Exclude<SizeBucket, "natural">, number> = { short: 800, medium: 3000, long: 8000 };
const CORE_CONDITIONS: CopyCondition[] = ["exact", "fifty", "twentyfive", "ten", "fewSentences", "original"];

type CaseSpec = {
  caseId: string;
  paperId: string;
  condition: CopyCondition;
  format: Format;
  sizeBucket: SizeBucket;
  targetTotalWords: number;
  fillerSeed: number;
};

function buildCaseMatrix(papers: DomainPaper[]): CaseSpec[] {
  const specs: CaseSpec[] = [];
  let seed = 0;

  for (const paper of papers) {
    for (const condition of CORE_CONDITIONS) {
      const sizeBucket: SizeBucket = condition === "exact" ? "natural" : "medium";
      specs.push({
        caseId: `${paper.id}-${condition}-docx-${sizeBucket}`,
        paperId: paper.id,
        condition,
        format: "docx",
        sizeBucket,
        targetTotalWords: SIZE_WORDS.medium,
        fillerSeed: seed++,
      });
    }
  }

  // Size sub-study: 25%-condition at short/long, DOCX, all domains.
  for (const paper of papers) {
    for (const bucket of ["short", "long"] as const) {
      specs.push({
        caseId: `${paper.id}-twentyfive-docx-${bucket}`,
        paperId: paper.id,
        condition: "twentyfive",
        format: "docx",
        sizeBucket: bucket,
        targetTotalWords: SIZE_WORDS[bucket],
        fillerSeed: seed++,
      });
    }
  }

  // Format sub-study: exact + 25%-medium, also as PDF, all domains.
  for (const paper of papers) {
    for (const condition of ["exact", "twentyfive"] as const) {
      const sizeBucket: SizeBucket = condition === "exact" ? "natural" : "medium";
      specs.push({
        caseId: `${paper.id}-${condition}-pdf-${sizeBucket}`,
        paperId: paper.id,
        condition,
        format: "pdf",
        sizeBucket,
        targetTotalWords: SIZE_WORDS.medium,
        fillerSeed: seed++,
      });
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Matching helpers (submission's target paper vs. a live-search candidate/evidence)
// ---------------------------------------------------------------------------

function candidateMatchesPaper(candidate: AcademicSearchCandidate, paper: DomainPaper): boolean {
  const paperDoi = normalizeDoi(paper.doi);
  const candDoi = normalizeDoi(candidate.doi);
  if (paperDoi && candDoi && paperDoi === candDoi) return true;
  return titlesMatch(candidate.title, paper.title);
}

function evidenceMatchesPaper(evidence: ExternalAcademicEvidence, paper: DomainPaper): boolean {
  const paperDoi = normalizeDoi(paper.doi);
  const evDoi = normalizeDoi(evidence.doi);
  if (paperDoi && evDoi && paperDoi === evDoi) return true;
  return titlesMatch(evidence.title, paper.title);
}

const PAYWALL_URL_SIGNATURES = [
  "sciencedirect.com", "onlinelibrary.wiley.com", "link.springer.com", "tandfonline.com",
  "ieeexplore.ieee.org", "dl.acm.org", "jstor.org", "springer.com",
];

function looksLikeExternalAccessLimitation(target: AcademicSearchCandidate | null): boolean {
  if (!target?.url) return false;
  return PAYWALL_URL_SIGNATURES.some((signature) => target.url!.includes(signature));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Classification =
  | "correct"
  | "false_positive"
  | "discovery"
  | "ranking"
  | "retrieval"
  | "external_access_limitation"
  | "comparison"
  | "scoring_display";

const SCORING_GAP_TOLERANCE_POINTS = 20;
const FALSE_POSITIVE_SCORE_THRESHOLD = 5;

function classifyCase(params: {
  condition: CopyCondition;
  target: AcademicSearchCandidate | null;
  matchedEvidence: ExternalAcademicEvidence | null;
  retrievalAttempted: boolean;
  retrievalSucceeded: boolean | null;
  withinRetrievalBudget: boolean | null;
  expectedProportionPercent: number;
  unifiedScore: number;
  crossMatchCount: number;
}): { classification: Classification; note: string } {
  const { condition, target, matchedEvidence, retrievalAttempted, retrievalSucceeded, withinRetrievalBudget, expectedProportionPercent, unifiedScore, crossMatchCount } = params;

  if (condition === "original") {
    if (crossMatchCount > 0 || unifiedScore > FALSE_POSITIVE_SCORE_THRESHOLD) {
      return { classification: "false_positive", note: `original control produced unified score ${unifiedScore} with ${crossMatchCount} cross-domain evidence match(es)` };
    }
    return { classification: "correct", note: `original control correctly scored ${unifiedScore}` };
  }

  if (!target) {
    return { classification: "discovery", note: "target paper not present in the candidate pool at all" };
  }
  if (withinRetrievalBudget === false) {
    return { classification: "ranking", note: `target found (rank ${target.rank}) but outside the retrieval budget` };
  }
  if (!retrievalAttempted || retrievalSucceeded === false) {
    return {
      classification: looksLikeExternalAccessLimitation(target) ? "external_access_limitation" : "retrieval",
      note: "candidate found and ranked in-budget, but text retrieval failed",
    };
  }
  if (!matchedEvidence) {
    return { classification: "comparison", note: `text retrieved, but comparison similarity fell below the evidence threshold (expected ~${expectedProportionPercent}% copied)` };
  }
  if (Math.abs(unifiedScore - expectedProportionPercent) > SCORING_GAP_TOLERANCE_POINTS) {
    return { classification: "scoring_display", note: `comparison matched (per-source similarity ${matchedEvidence.similarity}) but unified score ${unifiedScore} diverges from expected ~${expectedProportionPercent}%` };
  }
  return { classification: "correct", note: `unified score ${unifiedScore} vs. expected ~${expectedProportionPercent}%` };
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

type ResultRow = {
  caseId: string;
  paperId: string;
  domain: string;
  paperTitle: string;
  paperDoi: string | null;
  condition: CopyCondition;
  format: Format;
  sizeBucket: SizeBucket;
  expectedTotalWords: number;
  composedTotalWords: number;
  copiedWordCount: number;
  copiedProportionPercent: number;
  trueCopiedWordStart: number;
  trueCopiedWordEnd: number;
  extractedWordCount: number;
  extractionWordCountDeltaPercent: number;
  queryCount: number;
  searchAttempts: number;
  providerErrors: AcademicSearchProviderError[];
  candidatePoolSize: number;
  targetRank: number | null;
  withinRetrievalBudget: boolean | null;
  retrievalAttempted: boolean;
  retrievalSucceeded: boolean | null;
  retrievalSource: string | null;
  retrievedTextChars: number | null;
  provider: string | null;
  comparisonSimilarity: number | null;
  matchedPassageCount: number | null;
  matchedWordCountAcademic: number | null;
  archiveScoreProd: number;
  archiveMatchedWordCountProd: number;
  archiveScoreSynthetic: number;
  archiveMatchedWordCountSynthetic: number;
  unifiedScore: number;
  unifiedLiveAcademicOnlyWords: number;
  unifiedArchiveOnlyWords: number;
  crossMatchCount: number;
  archiveLatencyMsProd: number;
  archiveLatencyMsSynthetic: number;
  academicLatencyMs: number;
  totalLatencyMs: number;
  classification: Classification;
  classificationNote: string;
};

async function runCase(
  spec: CaseSpec,
  paper: DomainPaper,
  allPapers: DomainPaper[],
  syntheticIndex: SyntheticArchiveIndex,
  providers: AcademicSearchProvider[],
  providersById: Record<string, AcademicSearchProvider>,
  contentRetriever: ReturnType<typeof createAcademicSearchContentRetriever>,
): Promise<ResultRow> {
  const composed = composeCase({
    sourceText: paper.fullText,
    domain: paper.domain,
    condition: spec.condition,
    targetTotalWords: spec.targetTotalWords,
    fillerSeed: spec.fillerSeed,
    sourceTitle: paper.title,
  });

  const fileBytes = spec.format === "pdf" ? await writePdf(composed.text) : await writeDocx(composed.text);
  const extractedText = spec.format === "pdf" ? await extractPdf(fileBytes) : await extractDocx(fileBytes);
  const extractedWordCount = wordCount(extractedText);

  const tArchiveProdStart = Date.now();
  const prodArchive = realArchiveAnalyze(extractedText);
  const archiveLatencyMsProd = Date.now() - tArchiveProdStart;

  const tArchiveSynthStart = Date.now();
  const synthArchive = analyzeSyntheticArchive(extractedText, syntheticIndex);
  const archiveLatencyMsSynthetic = Date.now() - tArchiveSynthStart;

  const tAcademicStart = Date.now();
  const academicResult = await runAcademicSearch(extractedText, providers, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, contentRetriever);
  const academicLatencyMs = Date.now() - tAcademicStart;

  const target = academicResult.candidates.find((c) => candidateMatchesPaper(c, paper)) ?? null;
  let withinRetrievalBudget: boolean | null = null;
  let retrievalAttempted = false;
  let retrievalSucceeded: boolean | null = null;
  let retrievalSource: string | null = null;
  let retrievedTextChars: number | null = null;

  if (target) {
    withinRetrievalBudget = target.rank < DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve;
    if (withinRetrievalBudget) {
      retrievalAttempted = true;
      const retrieval = await retrieveCandidateText(target, providersById, contentRetriever);
      retrievalSucceeded = Boolean(retrieval.text);
      retrievalSource = retrieval.source;
      retrievedTextChars = retrieval.text?.length ?? null;
    }
  }

  const matchedEvidence = academicResult.evidence.find((e) => evidenceMatchesPaper(e, paper)) ?? null;
  const crossMatches = academicResult.evidence.filter(
    (e) => !evidenceMatchesPaper(e, paper) && allPapers.some((p) => p.id !== paper.id && evidenceMatchesPaper(e, p)),
  );

  const unified = computeUnifiedSimilarity({
    wordCount: extractedWordCount,
    archiveMatchedPositions: prodArchive.archiveMatchedPositions,
    externalAcademicEvidence: academicResult.evidence,
  });

  const expectedProportionPercent = Math.round(composed.copiedProportion * 100);
  const { classification, note } = classifyCase({
    condition: spec.condition,
    target,
    matchedEvidence,
    retrievalAttempted,
    retrievalSucceeded,
    withinRetrievalBudget,
    expectedProportionPercent,
    unifiedScore: unified.unifiedScore,
    crossMatchCount: crossMatches.length,
  });

  const totalLatencyMs = archiveLatencyMsProd + archiveLatencyMsSynthetic + academicLatencyMs;

  log(
    `  [case] ${spec.caseId} -> expected~${expectedProportionPercent}% target=${target ? `rank ${target.rank}` : "not found"} retrieval=${retrievalSucceeded} evidence=${Boolean(matchedEvidence)} unified=${unified.unifiedScore} archiveProd=${prodArchive.score} archiveSynth=${synthArchive.score} => ${classification} (${totalLatencyMs}ms)`,
  );

  return {
    caseId: spec.caseId,
    paperId: paper.id,
    domain: paper.domain,
    paperTitle: paper.title,
    paperDoi: paper.doi,
    condition: spec.condition,
    format: spec.format,
    sizeBucket: spec.sizeBucket,
    expectedTotalWords: spec.targetTotalWords,
    composedTotalWords: composed.totalWordCount,
    copiedWordCount: composed.copiedWordCount,
    copiedProportionPercent: expectedProportionPercent,
    trueCopiedWordStart: composed.trueCopiedWordStart,
    trueCopiedWordEnd: composed.trueCopiedWordEnd,
    extractedWordCount,
    extractionWordCountDeltaPercent: composed.totalWordCount > 0
      ? Math.round(((extractedWordCount - composed.totalWordCount) / composed.totalWordCount) * 1000) / 10
      : 0,
    queryCount: academicResult.stats.queryCount,
    searchAttempts: academicResult.stats.searchAttempts,
    providerErrors: academicResult.stats.providerErrors,
    candidatePoolSize: academicResult.candidates.length,
    targetRank: target?.rank ?? null,
    withinRetrievalBudget,
    retrievalAttempted,
    retrievalSucceeded,
    retrievalSource,
    retrievedTextChars,
    provider: target?.contributors.map((c) => c.providerId).join("+") ?? null,
    comparisonSimilarity: matchedEvidence?.similarity ?? null,
    matchedPassageCount: matchedEvidence?.matchedPassages.length ?? null,
    matchedWordCountAcademic: matchedEvidence
      ? matchedEvidence.matchedPassages.reduce((total, p) => total + p.matchedWordCount, 0)
      : null,
    archiveScoreProd: prodArchive.score,
    archiveMatchedWordCountProd: prodArchive.matchedWordCount,
    archiveScoreSynthetic: synthArchive.score,
    archiveMatchedWordCountSynthetic: synthArchive.matchedWordCount,
    unifiedScore: unified.unifiedScore,
    unifiedLiveAcademicOnlyWords: unified.liveAcademicOnlyWords,
    unifiedArchiveOnlyWords: unified.archiveOnlyWords,
    crossMatchCount: crossMatches.length,
    archiveLatencyMsProd,
    archiveLatencyMsSynthetic,
    academicLatencyMs,
    totalLatencyMs,
    classification,
    classificationNote: note,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Sourcing 6 domain ground-truth papers...");
  const papers = await sourceAllDomainPapers(log);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${RUN_ID}-accuracy-papers.json`),
    JSON.stringify(papers.map((p) => ({ ...p, fullText: `${p.fullText.length} chars (omitted from this file)` })), null, 2),
  );
  for (const paper of papers) {
    log(`  sourced ${paper.id} (${paper.domain}): "${paper.title}" doi=${paper.doi ?? "(none)"} fullText=${paper.fullText.length} chars`);
  }

  log("Building in-memory synthetic archive index from the 6 domain papers (no files written to public/data/)...");
  const syntheticIndex = buildSyntheticArchiveIndex(papers.map((p) => ({ id: p.id, title: p.title, text: p.fullText })));

  let specs = buildCaseMatrix(papers);
  const onlyIds = process.env.ACCURACY_BENCHMARK_ONLY_CASE_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (onlyIds && onlyIds.length > 0) {
    specs = specs.filter((s) => onlyIds.includes(s.caseId));
    log(`ACCURACY_BENCHMARK_ONLY_CASE_IDS set — restricting run to: ${specs.map((s) => s.caseId).join(", ")}`);
  }
  log(`Built ${specs.length} test cases. Running full pipeline for each...`);

  const providers = [openaireProvider, europePmcProvider];
  const providersById: Record<string, AcademicSearchProvider> = Object.fromEntries(providers.map((p) => [p.id, p]));
  const contentRetriever = createAcademicSearchContentRetriever();
  const papersById = new Map(papers.map((p) => [p.id, p]));

  const rows: ResultRow[] = [];
  const resultsPath = path.join(OUTPUT_DIR, `${RUN_ID}-accuracy-results.json`);
  for (const [index, spec] of specs.entries()) {
    const paper = papersById.get(spec.paperId)!;
    log(`[${index + 1}/${specs.length}] running ${spec.caseId}...`);
    try {
      const row = await runCase(spec, paper, papers, syntheticIndex, providers, providersById, contentRetriever);
      rows.push(row);
    } catch (err) {
      log(`  [ERROR] ${spec.caseId} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2));
  }

  log(`Done. ${rows.length}/${specs.length} cases completed. Results: tools/output/${RUN_ID}-accuracy-results.json`);
  writeSummary(rows, papers);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function rate(rows: ResultRow[], predicate: (r: ResultRow) => boolean): string {
  if (rows.length === 0) return "n/a (0 cases)";
  const matched = rows.filter(predicate).length;
  return `${matched}/${rows.length} (${Math.round((matched / rows.length) * 100)}%)`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function writeSummary(rows: ResultRow[], papers: DomainPaper[]) {
  const lines: string[] = [];
  lines.push(`# Accuracy & Coverage Benchmark — ${RUN_ID}`);
  lines.push("");
  lines.push(`${rows.length} cases completed.`);
  lines.push("");
  lines.push("## Ground-truth papers");
  for (const p of papers) lines.push(`- **${p.domain}**: "${p.title}" (doi: ${p.doi ?? "none"}, ${p.fullText.length} chars)`);
  lines.push("");

  const byCondition = (condition: CopyCondition) => rows.filter((r) => r.condition === condition);
  lines.push("## Detection by copy condition (core matrix, medium/DOCX + natural exact)");
  for (const condition of CORE_CONDITIONS) {
    const subset = byCondition(condition).filter((r) => r.format === "docx" && (condition !== "twentyfive" || r.sizeBucket === "medium"));
    lines.push(`- **${condition}**: correct = ${rate(subset, (r) => r.classification === "correct")}; classifications: ${summarizeClassifications(subset)}`);
  }
  lines.push("");

  lines.push("## False positives (original controls, all formats/sizes)");
  const originals = rows.filter((r) => r.condition === "original");
  lines.push(`- false_positive rate: ${rate(originals, (r) => r.classification === "false_positive")}`);
  lines.push("");

  lines.push("## Domain breakdown");
  for (const p of papers) {
    const subset = rows.filter((r) => r.paperId === p.id && r.condition !== "original");
    lines.push(`- **${p.domain}**: correct = ${rate(subset, (r) => r.classification === "correct")}`);
  }
  lines.push("");

  lines.push("## Format comparison (exact + twentyfive-medium, PDF vs DOCX, paired)");
  for (const condition of ["exact", "twentyfive"] as const) {
    const pdf = rows.filter((r) => r.condition === condition && r.format === "pdf" && (condition !== "twentyfive" || r.sizeBucket === "medium"));
    const docx = rows.filter((r) => r.condition === condition && r.format === "docx" && (condition !== "twentyfive" || r.sizeBucket === "medium"));
    lines.push(`- **${condition}**: PDF correct = ${rate(pdf, (r) => r.classification === "correct")}, DOCX correct = ${rate(docx, (r) => r.classification === "correct")}`);
    lines.push(`  - PDF extraction word-count delta: median ${median(pdf.map((r) => r.extractionWordCountDeltaPercent))}%; DOCX: median ${median(docx.map((r) => r.extractionWordCountDeltaPercent))}%`);
  }
  lines.push("");

  lines.push("## Size comparison (twentyfive condition, DOCX, short/medium/long)");
  for (const bucket of ["short", "medium", "long"] as const) {
    const subset = rows.filter((r) => r.condition === "twentyfive" && r.format === "docx" && r.sizeBucket === bucket);
    lines.push(`- **${bucket}**: correct = ${rate(subset, (r) => r.classification === "correct")}; median total latency ${median(subset.map((r) => r.totalLatencyMs))}ms`);
  }
  lines.push("");

  lines.push("## Processing time");
  lines.push(`- median total latency: ${median(rows.map((r) => r.totalLatencyMs))}ms`);
  lines.push(`- median academic-search latency: ${median(rows.map((r) => r.academicLatencyMs))}ms`);
  lines.push(`- median archive (production) latency: ${median(rows.map((r) => r.archiveLatencyMsProd))}ms`);
  lines.push("");

  lines.push("## Synthetic archive lane (algorithm-only, controlled test corpus — NOT production coverage)");
  for (const condition of CORE_CONDITIONS) {
    const subset = byCondition(condition).filter((r) => r.format === "docx" && (condition !== "twentyfive" || r.sizeBucket === "medium"));
    const expected = subset[0] ? subset[0].copiedProportionPercent : 0;
    lines.push(`- **${condition}** (expected ~${expected}%): median synthetic archive score = ${median(subset.map((r) => r.archiveScoreSynthetic))}`);
  }
  lines.push("");

  lines.push("## Overall failure-mode breakdown (all cases)");
  lines.push(summarizeClassifications(rows));
  lines.push("");

  const summaryPath = path.join(OUTPUT_DIR, `${RUN_ID}-accuracy-summary.md`);
  fs.writeFileSync(summaryPath, lines.join("\n"));
  log(`Summary written to tools/output/${RUN_ID}-accuracy-summary.md`);
}

function summarizeClassifications(rows: ResultRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  return [...counts.entries()].map(([classification, count]) => `${classification}=${count}`).join(", ") || "(no cases)";
}

main().catch((err) => {
  console.error("ACCURACY BENCHMARK FAILED:", err);
  process.exitCode = 1;
});
