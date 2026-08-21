// Diagnostic (read-only, no production code touched): reproduces the
// Engineering discovery-failure cases from the accuracy benchmark and traces
// each one through phrase-extraction -> REAL OpenAIRE provider calls,
// recording actual numFound/results per query, never inferring from query
// text alone. Compares against the successful Engineering cases too.
import fs from "node:fs";
import path from "node:path";
import { extractCandidatePhrases, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire";
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../lib/academic-search/orchestrator";
import { tokens } from "../lib/similarity-core";
import { composeCase, wordCount, type CopyCondition } from "./accuracy-benchmark-lib/compose";
import { sourceViaProviderWithFallback, openaireProvider, titlesMatch, normalizeDoi, type DomainPaper } from "./accuracy-benchmark-lib/sources";
import type { AcademicSearchQuery, AcademicSearchResult } from "../lib/academic-search/types";

const EXPECTED_DOI = "10.3389/fenrg.2022.977925";
const EXPECTED_TITLE = "A review on configuration optimization of hybrid energy system based on renewable energy";

const OUTPUT_DIR = path.join(process.cwd(), "tools", "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const logLines: string[] = [];
function log(...args: unknown[]) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  logLines.push(line);
}

const openaire = createOpenAireAcademicSearchProvider();

function resultMatches(result: { title: string | null; doi: string | null }, paper: DomainPaper): boolean {
  const paperDoi = normalizeDoi(paper.doi);
  const resDoi = normalizeDoi(result.doi);
  if (paperDoi && resDoi && paperDoi === resDoi) return true;
  return titlesMatch(result.title, paper.title);
}

function informativeTermSet(text: string): Set<string> {
  return new Set(tokens(text).filter((w) => w.length >= 4));
}

function overlapCount(queryText: string, referenceTerms: Set<string>): { count: number; terms: string[] } {
  const queryTerms = new Set(tokens(queryText).filter((w) => w.length >= 4));
  const shared = [...queryTerms].filter((t) => referenceTerms.has(t));
  return { count: shared.length, terms: shared };
}

const SIZE_WORDS = { short: 800, medium: 3000, long: 8000 } as const;

type CaseSpec = { caseId: string; condition: CopyCondition; targetTotalWords: number };
const CASES: CaseSpec[] = [
  // Failing (discovery) cases
  { caseId: "eng-openaire-fifty-docx-medium", condition: "fifty", targetTotalWords: SIZE_WORDS.medium },
  { caseId: "eng-openaire-twentyfive-docx-medium", condition: "twentyfive", targetTotalWords: SIZE_WORDS.medium },
  { caseId: "eng-openaire-ten-docx-medium", condition: "ten", targetTotalWords: SIZE_WORDS.medium },
  { caseId: "eng-openaire-twentyfive-docx-long", condition: "twentyfive", targetTotalWords: SIZE_WORDS.long },
  { caseId: "eng-openaire-twentyfive-pdf-medium", condition: "twentyfive", targetTotalWords: SIZE_WORDS.medium },
  // Successful comparison cases
  { caseId: "eng-openaire-exact-docx-natural", condition: "exact", targetTotalWords: SIZE_WORDS.medium /* ignored for exact */ },
  { caseId: "eng-openaire-fewSentences-docx-medium", condition: "fewSentences", targetTotalWords: SIZE_WORDS.medium },
  { caseId: "eng-openaire-twentyfive-docx-short", condition: "twentyfive", targetTotalWords: SIZE_WORDS.short },
];

type QueryDiagnostic = {
  index: number;
  queryType: string;
  queryText: string;
  numFound: number | null;
  returned: number;
  targetFound: boolean;
  targetRankInResponse: number | null;
  titleOverlapCount: number;
  titleOverlapTerms: string[];
  abstractOverlapCount: number;
  abstractOverlapTerms: string[];
  error: string | null;
};

async function diagnoseCase(spec: CaseSpec, paper: DomainPaper, titleTerms: Set<string>, abstractTerms: Set<string>) {
  const composed = composeCase({
    sourceText: paper.fullText,
    domain: paper.domain,
    condition: spec.condition,
    targetTotalWords: spec.targetTotalWords,
    fillerSeed: 0,
  });
  const submissionText = composed.text;
  const submissionWordCount = wordCount(submissionText);

  const queries = extractCandidatePhrases(submissionText, DEFAULT_PHRASE_EXTRACTION_CONFIG);

  const queryDiagnostics: QueryDiagnostic[] = [];
  for (const [index, query] of queries.entries()) {
    const titleOverlap = overlapCount(query.queryText, titleTerms);
    const abstractOverlap = overlapCount(query.queryText, abstractTerms);
    try {
      const results = await openaire.search(query);
      const hitIndex = results.findIndex((r) => resultMatches(r, paper));
      queryDiagnostics.push({
        index,
        queryType: query.queryType,
        queryText: query.queryText,
        numFound: results[0]?.queryTotalResults ?? (results.length === 0 ? 0 : null),
        returned: results.length,
        targetFound: hitIndex >= 0,
        targetRankInResponse: hitIndex >= 0 ? hitIndex : null,
        titleOverlapCount: titleOverlap.count,
        titleOverlapTerms: titleOverlap.terms,
        abstractOverlapCount: abstractOverlap.count,
        abstractOverlapTerms: abstractOverlap.terms,
        error: null,
      });
    } catch (err) {
      queryDiagnostics.push({
        index,
        queryType: query.queryType,
        queryText: query.queryText,
        numFound: null,
        returned: -1,
        targetFound: false,
        targetRankInResponse: null,
        titleOverlapCount: titleOverlap.count,
        titleOverlapTerms: titleOverlap.terms,
        abstractOverlapCount: abstractOverlap.count,
        abstractOverlapTerms: abstractOverlap.terms,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Authoritative full-pipeline result (both providers, real orchestrator) —
  // confirms whether a raw per-query hit (if any) actually survives
  // normalization/dedup/ranking into the final candidate pool.
  const europePmcModule = await import("../lib/academic-search/providers/europe-pmc");
  const europePmc = europePmcModule.createEuropePmcAcademicSearchProvider();
  const pipelineResult = await runAcademicSearch(submissionText, [openaire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG);
  const pipelineTarget = pipelineResult.candidates.find((c) => resultMatches({ title: c.title, doi: c.doi }, paper));

  const anyRawHit = queryDiagnostics.some((q) => q.targetFound);
  let firstLossStage: string;
  if (submissionWordCount < 50) firstLossStage = "extraction (degenerate submission)";
  else if (!anyRawHit) firstLossStage = "provider search (no generated query's raw OpenAIRE response ever contains the target, on any provider queried)";
  else if (!pipelineTarget) firstLossStage = "normalization/deduplication (a raw hit existed but the target never became a final candidate)";
  else if (pipelineTarget.rank >= DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve) firstLossStage = "ranking (candidate exists but ranked outside retrieval budget)";
  else firstLossStage = "none — target reached the candidate pool within retrieval budget";

  return {
    caseId: spec.caseId,
    condition: spec.condition,
    submissionWordCount,
    composedTotalWords: composed.totalWordCount,
    copiedWordCount: composed.copiedWordCount,
    generatedQueryCount: queries.length,
    queryDiagnostics,
    pipelineStatus: pipelineResult.status,
    pipelineCandidateCount: pipelineResult.candidates.length,
    pipelineTargetRank: pipelineTarget?.rank ?? null,
    firstLossStage,
  };
}

async function main() {
  log(`Engineering discovery diagnostic — ${RUN_ID}`);
  log("Sourcing the Engineering ground-truth paper (same fallback queries as the benchmark)...");

  const paper = await sourceViaProviderWithFallback(
    openaireProvider,
    [
      "renewable energy system performance review",
      "structural health monitoring sensor network",
      "wireless sensor network infrastructure reliability",
    ],
    "Engineering",
    "eng-openaire",
  );
  if (!paper) throw new Error("Failed to source the Engineering paper.");

  const normalizedTarget = normalizeDoi(paper.doi);
  const normalizedExpected = normalizeDoi(EXPECTED_DOI);
  if (normalizedTarget !== normalizedExpected || !titlesMatch(paper.title, EXPECTED_TITLE)) {
    log(`WARNING: sourced paper does not match the expected target! sourced doi=${paper.doi} title="${paper.title}" — expected doi=${EXPECTED_DOI} title="${EXPECTED_TITLE}"`);
  } else {
    log(`Confirmed target paper: "${paper.title}" doi=${paper.doi} fullTextChars=${paper.fullText.length}`);
  }

  // Fetch the target's own title + abstract as OpenAIRE itself reports them (Stage 0-style lookup).
  const titleSearchResults: AcademicSearchResult[] = await openaire.search({
    queryText: paper.title,
    rank: 0,
    sourcePassage: paper.title,
    queryType: "keyword",
  });
  const selfRecord = titleSearchResults.find((r) => resultMatches(r, paper));
  const targetAbstract = selfRecord?.abstract ?? "";
  log(`Target's own OpenAIRE record: title="${selfRecord?.title ?? "(not found via title search)"}" abstractChars=${targetAbstract.length}`);
  log(`Target abstract (first 500 chars): ${targetAbstract.slice(0, 500)}`);

  const titleTerms = informativeTermSet(paper.title);
  const abstractTerms = informativeTermSet(targetAbstract);
  log(`Target title terms (informative, >=4 chars): ${[...titleTerms].join(", ")}`);
  log(`Target abstract terms (informative, >=4 chars): ${[...abstractTerms].join(", ")}`);

  const results = [];
  for (const spec of CASES) {
    log(`\n--- Diagnosing ${spec.caseId} ---`);
    const result = await diagnoseCase(spec, paper, titleTerms, abstractTerms);
    results.push(result);
    log(`  submissionWordCount=${result.submissionWordCount} copiedWordCount=${result.copiedWordCount} generatedQueryCount=${result.generatedQueryCount}`);
    log(`  pipelineStatus=${result.pipelineStatus} candidates=${result.pipelineCandidateCount} targetRank=${result.pipelineTargetRank}`);
    log(`  FIRST LOSS STAGE: ${result.firstLossStage}`);
    for (const q of result.queryDiagnostics) {
      log(`  [${q.index}] type=${q.queryType} numFound=${q.numFound} returned=${q.returned} targetFound=${q.targetFound}${q.targetFound ? ` rank=${q.targetRankInResponse}` : ""} titleOverlap=${q.titleOverlapCount}[${q.titleOverlapTerms.join(",")}] abstractOverlap=${q.abstractOverlapCount}[${q.abstractOverlapTerms.join(",")}] error=${q.error ?? "none"} query="${q.queryText.slice(0, 90)}"`);
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `${RUN_ID}-engineering-discovery.json`), JSON.stringify({ paper: { ...paper, fullText: `${paper.fullText.length} chars omitted` }, targetAbstract, results }, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${RUN_ID}-engineering-discovery.log`), logLines.join("\n"));
  log(`\nDone. Full data: tools/output/${RUN_ID}-engineering-discovery.json`);
}

main().catch((err) => {
  console.error("DIAGNOSTIC FAILED:", err);
  process.exitCode = 1;
});
