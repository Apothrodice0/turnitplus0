import fs from "node:fs";
import path from "node:path";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc";
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../lib/academic-search/orchestrator";
import { retrieveCandidateText, createAcademicSearchContentRetriever } from "../lib/academic-search/text-retriever";
import type { AcademicSearchCandidate, AcademicSearchQuery, AcademicSearchResult } from "../lib/academic-search/types";
import type { AcademicSearchProvider } from "../lib/academic-search/provider";

/**
 * Read-only OpenAlex coverage experiment. Does NOT touch lib/academic-search/
 * — the "OpenAlex provider" below lives entirely in this file, is never
 * exported from lib/, and is only ever passed as an extra array entry into
 * the real, unmodified runAcademicSearch(). That function was always
 * designed to accept an arbitrary provider list (providers: AcademicSearchProvider[]),
 * so adding a controlled 3rd entry for a comparison run requires zero
 * production code changes and zero new files under lib/academic-search/.
 * candidate-ranker.ts, metadata-relevance.ts, phrase-extractor.ts are
 * untouched and reused exactly as production uses them.
 *
 * For every paper/mode already sourced by the 2026-08-21 coverage benchmark
 * (tools/output/merged-papers.json — same text, no re-sourcing, no new
 * hallucination risk), this runs BOTH:
 *   - BASELINE: runAcademicSearch(text, [openaire, europePmc])  — current production
 *   - +OPENALEX: runAcademicSearch(text, [openaire, europePmc, openalex])
 * and diffs the resulting candidate pools to answer: what does OpenAlex add,
 * is it real, does it have usable text, does it change anything for the
 * target paper specifically.
 */

const OUTPUT_DIR = path.join(process.cwd(), "tools", "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(OUTPUT_DIR, `openalex-experiment-${RUN_ID}.log`), line + "\n");
}

process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException — continuing] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`[unhandledRejection — continuing] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});

// ---------------------------------------------------------------------------
// OpenAlex, wired to the same AcademicSearchProvider interface OpenAIRE and
// Europe PMC implement — reuses this codebase's own established OpenAlex
// conventions from lib/openalex-check.ts (base URL, mailto polite-pool
// param, timeout/abort handling, rate-limit classification) but adapted
// from that file's exact-phrase fulltext.search use case to a plain
// relevance search (the works endpoint's `search` param), since
// phrase-extractor.ts produces sentence/keyword queries meant for relevance
// matching, not phrases meant for verbatim fulltext verification.
// ---------------------------------------------------------------------------

type OpenAlexWork = {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  type?: string | null;
  authorships?: Array<{ author?: { display_name?: string | null } | null }>;
  primary_location?: { landing_page_url?: string | null; pdf_url?: string | null; source?: { display_name?: string | null } | null } | null;
  best_oa_location?: { is_oa?: boolean; url?: string | null; pdf_url?: string | null; license?: string | null } | null;
  open_access?: { is_oa?: boolean; oa_status?: string | null; oa_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  relevance_score?: number | null;
};

type OpenAlexResponse = { results?: OpenAlexWork[]; meta?: { count?: number } };

/** OpenAlex returns abstracts as a word -> [positions] inverted index (to avoid TDM/copyright issues with plain text) — this is the standard, documented reconstruction. */
function reconstructAbstract(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const maxPos = Object.values(index).reduce((max, positions) => Math.max(max, ...positions), -1);
  if (maxPos < 0) return null;
  const words: string[] = new Array(maxPos + 1).fill("");
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeOpenAlexDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

/** Prefers an actual PDF URL over a landing page — mirrors providers/openaire.ts's own resultUrl() preference for a fetchable target over a DOI-resolver hop. */
function bestOpenAlexUrl(work: OpenAlexWork, doi: string | null): string | null {
  if (work.best_oa_location?.pdf_url) return work.best_oa_location.pdf_url;
  if (work.best_oa_location?.url) return work.best_oa_location.url;
  if (work.primary_location?.pdf_url) return work.primary_location.pdf_url;
  if (work.primary_location?.landing_page_url) return work.primary_location.landing_page_url;
  if (doi) return `https://doi.org/${doi}`;
  return null;
}

function mapOpenAlexWork(work: OpenAlexWork, queryText: string, queryTotalResults: number | null): AcademicSearchResult {
  const doi = normalizeOpenAlexDoi(work.doi);
  const authors = Array.isArray(work.authorships)
    ? work.authorships.map((a) => a.author?.display_name?.trim()).filter((n): n is string => Boolean(n))
    : null;
  const isOa = Boolean(work.best_oa_location?.is_oa ?? work.open_access?.is_oa);
  return {
    providerId: "openalex",
    externalId: work.id ?? doi ?? queryText,
    title: (work.title ?? work.display_name)?.trim() || null,
    authors: authors && authors.length > 0 ? authors : null,
    publication: work.primary_location?.source?.display_name?.trim() || null,
    year: Number.isInteger(work.publication_year) ? work.publication_year! : null,
    doi,
    url: bestOpenAlexUrl(work, doi),
    // Claiming textAvailable only when OpenAlex itself reports a real OA
    // location with a direct PDF url — same discipline as providers/europe-pmc.ts's
    // isFullTextEligible(): a claim TextRetriever still independently verifies.
    textAvailable: isOa && Boolean(work.best_oa_location?.pdf_url),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    querySignalUsed: queryText,
    providerRelevance: null, // relevance_score is unbounded/query-relative, not documented as 0..1 — left null per this subsystem's own convention (see providers/openaire.ts)
    queryTotalResults,
  };
}

export type ExperimentalOpenAlexConfig = {
  maxResultsPerRequest: number;
  timeoutMs: number;
  mailto?: string;
  fetcher?: typeof fetch;
};

function createExperimentalOpenAlexProvider(config: Partial<ExperimentalOpenAlexConfig> = {}): AcademicSearchProvider {
  const resolved: ExperimentalOpenAlexConfig = { maxResultsPerRequest: 5, timeoutMs: 8_000, mailto: "openalex-experiment@turnitplus.app", ...config };
  const fetcher = resolved.fetcher ?? fetch;

  return {
    id: "openalex",
    async search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]> {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query.queryText);
      url.searchParams.set("per-page", String(resolved.maxResultsPerRequest));
      if (resolved.mailto) url.searchParams.set("mailto", resolved.mailto);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), resolved.timeoutMs);
      try {
        const response = await fetcher(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`OpenAlex returned HTTP ${response.status}`);
        const payload = (await response.json()) as OpenAlexResponse;
        const items = Array.isArray(payload.results) ? payload.results : [];
        const queryTotalResults = typeof payload.meta?.count === "number" ? payload.meta.count : null;
        return items.map((item) => mapOpenAlexWork(item, query.queryText, queryTotalResults));
      } finally {
        clearTimeout(timeout);
      }
    },
    // Deliberately no getText(): OpenAlex's works response has no full-text
    // field, mirroring providers/openaire.ts's own documented reasoning —
    // the orchestrator's HTTP-fallback (text-retriever.ts fetching
    // candidate.url) is the only way this provider's candidates ever yield
    // text.
  };
}

// ---------------------------------------------------------------------------
// Comparison harness
// ---------------------------------------------------------------------------

type TestPaper = {
  id: string;
  domain: string;
  title: string;
  doi: string | null;
  abstractText: string | null;
  fullText: string | null;
};

function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}
function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function titlesMatch(a: string | null, b: string | null): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb || na.length < 8 || nb.length < 8) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}
function candidateMatchesTarget(candidate: AcademicSearchCandidate, target: TestPaper): boolean {
  const targetDoi = normalizeDoi(target.doi);
  const candDoi = normalizeDoi(candidate.doi);
  if (targetDoi && candDoi && targetDoi === candDoi) return true;
  return titlesMatch(candidate.title, target.title);
}
function candidateDedupeKey(c: AcademicSearchCandidate): string {
  const doi = normalizeDoi(c.doi);
  if (doi) return `doi:${doi}`;
  if (c.url) return `url:${c.url}`;
  return `title:${normalizeTitle(c.title)}`;
}
function evidenceMatchesTarget(evidence: { doi: string | null; title: string | null }, target: TestPaper): boolean {
  const targetDoi = normalizeDoi(target.doi);
  const evDoi = normalizeDoi(evidence.doi);
  if (targetDoi && evDoi && targetDoi === evDoi) return true;
  return titlesMatch(evidence.title, target.title);
}

type RunResult = {
  paperId: string;
  domain: string;
  inputMode: "full" | "abstract";
  title: string;
  doi: string | null;

  baseline: {
    candidatePoolSize: number;
    targetFound: boolean;
    targetRank: number | null;
    targetOpenaireFound: boolean;
    targetEuropePmcFound: boolean;
    matchProduced: boolean;
    totalLatencyMs: number;
  };
  withOpenAlex: {
    candidatePoolSize: number;
    targetFound: boolean;
    targetRank: number | null;
    targetOpenAlexFound: boolean;
    targetOpenAlexHasBetterAbstract: boolean;
    targetOpenAlexDoiMatches: boolean | null;
    targetOpenAlexOaUrl: string | null;
    matchProduced: boolean;
    totalLatencyMs: number;
  };

  incrementalCandidates: Array<{
    title: string | null;
    doi: string | null;
    rank: number;
    openAlexOnly: boolean;
    hasOaUrl: boolean;
    textRetrieved: boolean | null;
    retrievedChars: number | null;
    looksRelevant: "yes" | "no" | "uncertain";
  }>;
};

async function runOne(paper: TestPaper, inputMode: "full" | "abstract", providersById: Record<string, AcademicSearchProvider>, contentRetriever: ReturnType<typeof createAcademicSearchContentRetriever>): Promise<RunResult | null> {
  const text = inputMode === "full" ? paper.fullText : paper.abstractText;
  if (!text || text.trim().length < 200) return null;

  log(`  [${paper.id}] [${inputMode}] running baseline (2-provider)...`);
  const openaire = providersById.openaire;
  const europePmc = providersById["europe-pmc"];
  const openalex = providersById.openalex;

  const baselineRun = await runAcademicSearch(text, [openaire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, contentRetriever);
  const baselineTarget = baselineRun.candidates.find((c) => candidateMatchesTarget(c, paper)) ?? null;

  log(`  [${paper.id}] [${inputMode}] running +OpenAlex (3-provider)...`);
  const augmentedRun = await runAcademicSearch(text, [openaire, europePmc, openalex], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, contentRetriever);
  const augmentedTarget = augmentedRun.candidates.find((c) => candidateMatchesTarget(c, paper)) ?? null;

  // Incremental: candidates present in the augmented pool but not in the baseline pool (by dedupe key).
  const baselineKeys = new Set(baselineRun.candidates.map(candidateDedupeKey));
  const incrementalRaw = augmentedRun.candidates.filter((c) => !baselineKeys.has(candidateDedupeKey(c)));

  const incrementalCandidates: RunResult["incrementalCandidates"] = [];
  for (const c of incrementalRaw.slice(0, 10)) {
    // Only attempt retrieval for candidates plausibly worth checking (top of the pool) to bound cost.
    let textRetrieved: boolean | null = null;
    let retrievedChars: number | null = null;
    if (c.rank < DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve) {
      const retrieval = await retrieveCandidateText(c, providersById, contentRetriever);
      textRetrieved = Boolean(retrieval.text);
      retrievedChars = retrieval.text?.length ?? null;
    }
    const openAlexOnly = c.contributors.every((ct) => ct.providerId === "openalex");
    incrementalCandidates.push({
      title: c.title,
      doi: c.doi,
      rank: c.rank,
      openAlexOnly,
      hasOaUrl: Boolean(c.url),
      textRetrieved,
      retrievedChars,
      looksRelevant: "uncertain", // filled in qualitatively in the report, not auto-classified here
    });
  }

  let targetOpenAlexHasBetterAbstract = false;
  let targetOpenAlexDoiMatches: boolean | null = null;
  let targetOpenAlexOaUrl: string | null = null;
  let targetOpenAlexFound = false;
  if (augmentedTarget) {
    const openAlexContributor = augmentedTarget.contributors.find((c) => c.providerId === "openalex");
    targetOpenAlexFound = Boolean(openAlexContributor);
    if (openAlexContributor) {
      const baselineHadAbstract = Boolean(baselineTarget?.abstract);
      targetOpenAlexHasBetterAbstract = Boolean(openAlexContributor.abstract) && !baselineHadAbstract;
      targetOpenAlexDoiMatches = paper.doi ? normalizeDoi(openAlexContributor.doi) === normalizeDoi(paper.doi) : null;
      targetOpenAlexOaUrl = openAlexContributor.textAvailable ? openAlexContributor.url : null;
    }
  }

  const result: RunResult = {
    paperId: paper.id,
    domain: paper.domain,
    inputMode,
    title: paper.title,
    doi: paper.doi,
    baseline: {
      candidatePoolSize: baselineRun.candidates.length,
      targetFound: Boolean(baselineTarget),
      targetRank: baselineTarget?.rank ?? null,
      targetOpenaireFound: baselineTarget ? baselineTarget.contributors.some((c) => c.providerId === "openaire") : false,
      targetEuropePmcFound: baselineTarget ? baselineTarget.contributors.some((c) => c.providerId === "europe-pmc") : false,
      matchProduced: baselineRun.evidence.some((e) => evidenceMatchesTarget(e, paper)),
      totalLatencyMs: baselineRun.stats.totalLatencyMs,
    },
    withOpenAlex: {
      candidatePoolSize: augmentedRun.candidates.length,
      targetFound: Boolean(augmentedTarget),
      targetRank: augmentedTarget?.rank ?? null,
      targetOpenAlexFound,
      targetOpenAlexHasBetterAbstract,
      targetOpenAlexDoiMatches,
      targetOpenAlexOaUrl,
      matchProduced: augmentedRun.evidence.some((e) => evidenceMatchesTarget(e, paper)),
      totalLatencyMs: augmentedRun.stats.totalLatencyMs,
    },
    incrementalCandidates,
  };

  log(
    `  [${paper.id}] [${inputMode}] baseline rank=${result.baseline.targetRank} match=${result.baseline.matchProduced} | +openalex rank=${result.withOpenAlex.targetRank} match=${result.withOpenAlex.matchProduced} | incremental=${incrementalCandidates.length} latency ${result.baseline.totalLatencyMs}ms -> ${result.withOpenAlex.totalLatencyMs}ms`,
  );

  return result;
}

async function main() {
  const papersRaw = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, "merged-papers.json"), "utf8"));
  const papers: TestPaper[] = papersRaw.map((p: any) => ({ id: p.id, domain: p.domain, title: p.title, doi: p.doi, abstractText: p.abstractText, fullText: p.fullText }));

  const onlyIds = process.env.EXPERIMENT_ONLY_PAPER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  const targetPapers = onlyIds && onlyIds.length > 0 ? papers.filter((p) => onlyIds.includes(p.id)) : papers;

  log(`Running OpenAlex coverage experiment on ${targetPapers.length} papers (both modes where text exists)...`);

  const openaire = createOpenAireAcademicSearchProvider();
  const europePmc = createEuropePmcAcademicSearchProvider();
  const openalex = createExperimentalOpenAlexProvider();
  const providersById: Record<string, AcademicSearchProvider> = { openaire, "europe-pmc": europePmc, openalex };
  const contentRetriever = createAcademicSearchContentRetriever();

  const results: RunResult[] = [];
  for (const paper of targetPapers) {
    for (const mode of ["full", "abstract"] as const) {
      const r = await runOne(paper, mode, providersById, contentRetriever);
      if (r) results.push(r);
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `openalex-experiment-${RUN_ID}-results.json`), JSON.stringify(results, null, 2));
  log(`Done. ${results.length} runs. Results written to tools/output/openalex-experiment-${RUN_ID}-results.json`);
}

main().catch((err) => {
  console.error("EXPERIMENT FAILED:", err);
  process.exitCode = 1;
});
