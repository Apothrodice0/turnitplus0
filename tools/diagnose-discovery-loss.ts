// Diagnostic (read-only, no production code touched): traces exactly where
// the Social Sciences and Humanities exact-copy submissions lose their own
// ground-truth source paper during discovery, stage by stage, and compares
// against a successful exact-copy case (Engineering — the LONGEST of the 6
// domain papers, which nonetheless succeeds, ruling out raw length alone as
// the explanation).
import fs from "node:fs";
import path from "node:path";
import { extractCandidatePhrases, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc";
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../lib/academic-search/orchestrator";
import { sourceViaProviderWithFallback, sourceHandPickedViaEuropePmc, titlesMatch, normalizeDoi, type DomainPaper } from "./accuracy-benchmark-lib/sources";

const OUTPUT_DIR = path.join(process.cwd(), "tools", "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const logLines: string[] = [];
function log(...args: unknown[]) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 0))).join(" ");
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

async function traceOne(paper: DomainPaper) {
  log(`\n${"=".repeat(90)}`);
  log(`TRACE: ${paper.id} — "${paper.title}"`);
  log(`  domain=${paper.domain} doi=${paper.doi ?? "(none)"} fullTextChars=${paper.fullText.length}`);
  log("=".repeat(90));

  const submissionText = paper.fullText.trim();

  // ---- Stage 0: does a "cheating" query (the paper's own title, or its own
  // DOI) find it at all, on each provider, independent of our own phrase
  // extraction? Establishes whether the paper is indexed/reachable at all
  // before asking whether OUR queries are good enough to reach it.
  log("\n--- STAGE 0: is the paper reachable via its own title/DOI at all? ---");
  for (const [providerName, provider] of [["openaire", openaire], ["europe-pmc", europePmc]] as const) {
    try {
      const byTitle = await provider.search({ queryText: paper.title, rank: 0, sourcePassage: paper.title, queryType: "keyword" });
      const titleHit = byTitle.find((r) => resultMatches(r, paper));
      log(`  [${providerName}] search(own title) -> ${byTitle.length} results, target found: ${Boolean(titleHit)}${titleHit ? ` (title in response: "${titleHit.title}")` : ""}`);
      if (!titleHit && byTitle.length > 0) log(`      top result instead: "${byTitle[0].title}" (doi: ${byTitle[0].doi ?? "none"})`);
    } catch (err) {
      log(`  [${providerName}] search(own title) FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (paper.doi) {
      try {
        const byDoi = await provider.search({ queryText: `DOI:${paper.doi}`, rank: 0, sourcePassage: paper.doi, queryType: "keyword" });
        const doiHit = byDoi.find((r) => resultMatches(r, paper));
        log(`  [${providerName}] search(DOI:${paper.doi}) -> ${byDoi.length} results, target found: ${Boolean(doiHit)}`);
      } catch (err) {
        log(`  [${providerName}] search(DOI:...) FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---- Stage 1: phrase extraction — what queries does OUR pipeline
  // actually generate from this exact submission?
  log("\n--- STAGE 1: phrase extraction (what queries get generated) ---");
  const queries = extractCandidatePhrases(submissionText, DEFAULT_PHRASE_EXTRACTION_CONFIG);
  log(`  ${queries.length} queries generated (sentence=${queries.filter((q) => q.queryType === "sentence").length}, keyword=${queries.filter((q) => q.queryType === "keyword").length})`);
  const keywordAndTopicQueries = queries.filter((q) => q.queryType === "keyword");
  for (const q of keywordAndTopicQueries) log(`    [keyword] "${q.queryText}"`);
  log(`  first 3 sentence queries (highest-scored):`);
  for (const q of queries.filter((q) => q.queryType === "sentence").slice(0, 3)) log(`    [sentence] "${q.queryText.slice(0, 140)}${q.queryText.length > 140 ? "..." : ""}"`);

  // ---- Stage 2: run EVERY generated query against both providers directly,
  // check the FULL raw result set (not just top-1) for the target.
  log("\n--- STAGE 2: does ANY of our own generated queries surface the target, on either provider? ---");
  let anyHit = false;
  const perQueryFindings: { query: string; type: string; provider: string; numFound: number | null; returned: number; hit: boolean; hitRank: number | null }[] = [];
  for (const query of queries) {
    for (const [providerName, provider] of [["openaire", openaire], ["europe-pmc", europePmc]] as const) {
      try {
        const results = await provider.search(query);
        const hitIndex = results.findIndex((r) => resultMatches(r, paper));
        const hit = hitIndex >= 0;
        if (hit) anyHit = true;
        perQueryFindings.push({
          query: query.queryText,
          type: query.queryType,
          provider: providerName,
          numFound: results[0]?.queryTotalResults ?? null,
          returned: results.length,
          hit,
          hitRank: hit ? hitIndex : null,
        });
      } catch (err) {
        perQueryFindings.push({ query: query.queryText, type: query.queryType, provider: providerName, numFound: null, returned: -1, hit: false, hitRank: null });
      }
    }
  }
  const hits = perQueryFindings.filter((f) => f.hit);
  log(`  total (query x provider) attempts: ${perQueryFindings.length}; target surfaced in: ${hits.length}`);
  for (const h of hits) log(`    HIT: [${h.provider}, ${h.type}] rank-within-response=${h.hitRank} numFound=${h.numFound} query="${h.query.slice(0, 100)}"`);
  if (hits.length === 0) {
    log(`  NO query (of our own ${queries.length}, across both providers) ever surfaced the target paper in its raw response.`);
    // Show numFound distribution to see whether queries were "too broad" (huge numFound, target buried past top-5) vs "too narrow" (numFound 0, zero overlap with metadata).
    const openaireFindings = perQueryFindings.filter((f) => f.provider === "openaire" && f.returned >= 0);
    const zeroFound = openaireFindings.filter((f) => f.numFound === 0).length;
    const nonZero = openaireFindings.filter((f) => (f.numFound ?? 0) > 0);
    log(`  openaire: ${zeroFound}/${openaireFindings.length} queries returned numFound=0 (zero metadata overlap).`);
    if (nonZero.length > 0) {
      const avgFound = Math.round(nonZero.reduce((s, f) => s + (f.numFound ?? 0), 0) / nonZero.length);
      log(`  openaire: ${nonZero.length} queries returned nonzero numFound, average numFound=${avgFound} (paper not in top-${DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG ? 5 : 5} of those).`);
    }
  }

  // ---- Stage 3: run the REAL, full pipeline end to end, confirm the same
  // outcome, and capture stats (provider errors, query/search-attempt counts).
  log("\n--- STAGE 3: full runAcademicSearch() pipeline (production, unmodified) ---");
  const result = await runAcademicSearch(submissionText, [openaire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG);
  const targetCandidate = result.candidates.find((c) => resultMatches({ title: c.title, doi: c.doi }, paper));
  log(`  status=${result.status} candidates=${result.candidates.length} queryCount=${result.stats.queryCount} searchAttempts=${result.stats.searchAttempts} providerErrors=${JSON.stringify(result.stats.providerErrors)}`);
  log(`  target present in final candidate pool: ${Boolean(targetCandidate)}${targetCandidate ? ` at rank ${targetCandidate.rank}` : ""}`);

  return { paper, queries, perQueryFindings, anyHit, result };
}

async function main() {
  log(`Discovery-loss diagnostic — ${RUN_ID}`);
  log("Sourcing the 4 papers needed for this trace (2 failing + 2 comparison cases)...\n");

  const soc = await sourceViaProviderWithFallback(
    openaire,
    ["social media misinformation political polarization survey", "affective polarization misinformation belief"],
    "Social Sciences",
    "soc-openaire",
  );
  const hum = await sourceViaProviderWithFallback(
    openaire,
    ["digital humanities text mining literature corpus", "cultural heritage digital preservation archive", "history text analysis corpus linguistics"],
    "Humanities",
    "hum-openaire",
  );
  const eng = await sourceViaProviderWithFallback(
    openaire,
    ["renewable energy system performance review", "structural health monitoring sensor network", "wireless sensor network infrastructure reliability"],
    "Engineering",
    "eng-openaire",
  );
  const med = await sourceHandPickedViaEuropePmc(
    "med-ioannidis",
    "Medicine / Biomedical",
    "Why Most Published Research Findings Are False",
    "10.1371/journal.pmed.0020124",
    "Ioannidis Why Most Published Research Findings Are False",
  );

  if (!soc || !hum || !eng || !med) {
    throw new Error(`Sourcing failed: soc=${Boolean(soc)} hum=${Boolean(hum)} eng=${Boolean(eng)} med=${Boolean(med)}`);
  }

  const traces = [];
  for (const paper of [soc, hum, eng, med]) {
    traces.push(await traceOne(paper));
  }

  log(`\n${"=".repeat(90)}`);
  log("SUMMARY");
  log("=".repeat(90));
  for (const t of traces) {
    log(`${t.paper.id.padEnd(16)} domain=${t.paper.domain.padEnd(28)} chars=${String(t.paper.fullText.length).padEnd(7)} ownQueryEverHit=${t.anyHit} finalCandidateFound=${Boolean(t.result.candidates.find((c) => resultMatches({ title: c.title, doi: c.doi }, t.paper)))}`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `${RUN_ID}-discovery-loss-diagnostic.log`), logLines.join("\n"));
  log(`\nFull log: tools/output/${RUN_ID}-discovery-loss-diagnostic.log`);
}

main().catch((err) => {
  console.error("DIAGNOSTIC FAILED:", err);
  process.exitCode = 1;
});
