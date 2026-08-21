// Diagnostic (read-only, no production code touched): full per-query trace
// for the two remaining exact-copy discovery failures (Social Sciences,
// Humanities), reflecting every fix applied so far (maxPassages, Stage-1
// title-term/sanitization, PDF ligature). Does not assume those fixes are
// the remaining cause — records the CURRENT queries and CURRENT provider
// responses fresh, with title/abstract overlap for every query, exactly
// matching the rigor of tools/diagnose-engineering-discovery.ts.
import fs from "node:fs";
import path from "node:path";
import { extractCandidatePhrases, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc";
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../lib/academic-search/orchestrator";
import { tokens } from "../lib/similarity-core";
import { sourceViaProviderWithFallback, openaireProvider, titlesMatch, normalizeDoi, type DomainPaper } from "./accuracy-benchmark-lib/sources";

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
const europePmc = createEuropePmcAcademicSearchProvider();

function resultMatches(result: { title: string | null; doi: string | null }, paper: DomainPaper): boolean {
  const paperDoi = normalizeDoi(paper.doi);
  const resDoi = normalizeDoi(result.doi);
  if (paperDoi && resDoi && paperDoi === resDoi) return true;
  return titlesMatch(result.title, paper.title);
}

function informativeTermSet(text: string): Set<string> {
  return new Set(tokens(text).filter((w) => w.length >= 4));
}

function overlap(queryText: string, referenceTerms: Set<string>): { count: number; terms: string[] } {
  const queryTerms = new Set(tokens(queryText).filter((w) => w.length >= 4));
  const shared = [...queryTerms].filter((t) => referenceTerms.has(t));
  return { count: shared.length, terms: shared };
}

async function traceFullDetail(paper: DomainPaper) {
  log(`\n${"=".repeat(90)}`);
  log(`FULL TRACE: ${paper.id} — "${paper.title}"`);
  log(`  doi=${paper.doi} fullTextChars=${paper.fullText.length}`);
  log("=".repeat(90));

  // Own title + abstract, straight from OpenAIRE's own record.
  const titleHits = await openaire.search({ queryText: paper.title, rank: 0, sourcePassage: paper.title, queryType: "keyword" });
  const selfRecord = titleHits.find((r) => resultMatches(r, paper));
  const abstract = selfRecord?.abstract ?? "";
  const titleTerms = informativeTermSet(paper.title);
  const abstractTerms = informativeTermSet(abstract);
  log(`  own OpenAIRE abstract (${abstract.length} chars): ${abstract.slice(0, 400)}`);
  log(`  title terms: ${[...titleTerms].join(", ")}`);
  log(`  abstract terms: ${[...abstractTerms].join(", ")}`);

  const submissionText = paper.fullText.trim();
  const queries = extractCandidatePhrases(submissionText, DEFAULT_PHRASE_EXTRACTION_CONFIG);
  log(`\n  ${queries.length} queries generated`);

  for (const [index, query] of queries.entries()) {
    const titleOverlap = overlap(query.queryText, titleTerms);
    const abstractOverlap = overlap(query.queryText, abstractTerms);
    for (const [providerName, provider] of [["openaire", openaire], ["europe-pmc", europePmc]] as const) {
      try {
        const results = await provider.search(query);
        const hitIndex = results.findIndex((r) => resultMatches(r, paper));
        const numFound = results[0]?.queryTotalResults ?? (results.length === 0 ? 0 : null);
        log(
          `  [${index}][${providerName}] type=${query.queryType} numFound=${numFound} returned=${results.length} ` +
          `targetFound=${hitIndex >= 0}${hitIndex >= 0 ? ` rank=${hitIndex}` : ""} ` +
          `titleOverlap=${titleOverlap.count}[${titleOverlap.terms.join(",")}] abstractOverlap=${abstractOverlap.count}[${abstractOverlap.terms.join(",")}] ` +
          `top="${results[0]?.title ?? "(none)"}" ` +
          `query="${query.queryText}"`,
        );
      } catch (err) {
        log(`  [${index}][${providerName}] ERROR ${err instanceof Error ? err.message : String(err)} query="${query.queryText.slice(0, 80)}"`);
      }
    }
  }

  const pipelineResult = await runAcademicSearch(submissionText, [openaire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG);
  const pipelineTarget = pipelineResult.candidates.find((c) => resultMatches({ title: c.title, doi: c.doi }, paper));
  log(`\n  PIPELINE: status=${pipelineResult.status} candidates=${pipelineResult.candidates.length} targetRank=${pipelineTarget?.rank ?? null}`);

  return { paperId: paper.id, queries, titleTerms: [...titleTerms], abstractTerms: [...abstractTerms] };
}

async function main() {
  log(`Remaining-discovery-failures diagnostic — ${RUN_ID}`);

  const soc = await sourceViaProviderWithFallback(
    openaireProvider,
    ["social media misinformation political polarization survey", "affective polarization misinformation belief"],
    "Social Sciences",
    "soc-openaire",
  );
  const hum = await sourceViaProviderWithFallback(
    openaireProvider,
    ["digital humanities text mining literature corpus", "cultural heritage digital preservation archive", "history text analysis corpus linguistics"],
    "Humanities",
    "hum-openaire",
  );
  if (!soc || !hum) throw new Error(`sourcing failed: soc=${Boolean(soc)} hum=${Boolean(hum)}`);

  await traceFullDetail(soc);
  await traceFullDetail(hum);

  fs.writeFileSync(path.join(OUTPUT_DIR, `${RUN_ID}-remaining-discovery.log`), logLines.join("\n"));
  log(`\nDone. Full log: tools/output/${RUN_ID}-remaining-discovery.log`);
}

main().catch((err) => {
  console.error("DIAGNOSTIC FAILED:", err);
  process.exitCode = 1;
});
