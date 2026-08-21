import fs from "node:fs";
import path from "node:path";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc";
import { runAcademicSearch, DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG } from "../lib/academic-search/orchestrator";
import { retrieveCandidateText, createAcademicSearchContentRetriever } from "../lib/academic-search/text-retriever";
import type { AcademicSearchCandidate, AcademicSearchProviderError, AcademicSearchQuery, AcademicSearchResult } from "../lib/academic-search/types";
import type { AcademicSearchProvider } from "../lib/academic-search/provider";
import { extractTextFromPdfBytes } from "../lib/e7-asjp-client";

/**
 * Standalone, read-only coverage benchmark for the live academic-search
 * subsystem (lib/academic-search/*). Imports and calls the real,
 * unmodified production functions (runAcademicSearch, retrieveCandidateText,
 * the real OpenAIRE/Europe PMC providers) exactly as app/api/academic-evidence
 * does — this file adds zero new library code and edits nothing under
 * lib/academic-search/. Its only job is to drive that unmodified pipeline
 * against a representative set of REAL published papers and record what
 * happens at each stage.
 *
 * Every paper tested here is either (a) a genuinely famous, real paper
 * (verified against a live Crossref lookup at run time, never trusted from
 * memory alone) or (b) discovered live, at run time, via a plain topic
 * query against OpenAIRE's or Europe PMC's own search() — i.e. a real
 * record a live scholarly index actually returned, not invented. This
 * avoids citing a hallucinated DOI/paper as benchmark ground truth.
 *
 * Two independent things are being measured and must not be conflated:
 *  - SOURCING: how each paper and its text were found/obtained (may itself
 *    use provider.search()/getText() once, off to the side).
 *  - THE BENCHMARK ITSELF: what runAcademicSearch() does when that paper's
 *    OWN text is submitted as a document, exactly as a real user submission
 *    would be. Discovery/rank/retrieval/match numbers come only from this
 *    second, independent pipeline run — never from the sourcing step.
 */

const OUTPUT_DIR = path.join(process.cwd(), "tools", "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Node's own undici HTTP client has a known internal assertion crash
 * (AssertionError in Parser.finish / onHttpSocketEnd) triggered by certain
 * real-world connection-close patterns from some servers — confirmed live
 * against OpenAIRE during this benchmark's first full run, well outside any
 * try/catch this script or the app's own provider code could reach (it
 * fires from an internal socket event handler, not inside the fetch()
 * promise chain). This is a Node/undici runtime issue, not a bug in
 * lib/academic-search/ — swallow it here so one flaky connection doesn't
 * lose the rest of an hour-long benchmark run; the affected paper/mode row
 * is simply missing from the output rather than fabricated.
 */
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
// Crossref: independent existence ground-truth, deliberately NOT one of the
// two providers under test. No API key; polite-pool contact email omitted
// (fine for this one-off, low-volume run) per lib/discovery-crossref-provider.ts's
// own documented usage.
// ---------------------------------------------------------------------------

type CrossrefWork = {
  DOI?: string;
  title?: string[];
  type?: string;
  publisher?: string;
  "container-title"?: string[];
  score?: number;
};

async function crossrefLookupByDoi(doi: string): Promise<CrossrefWork | null> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { "User-Agent": "TurnitPlus-CoverageBenchmark/1.0 (one-off internal QA script)" },
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { message?: CrossrefWork };
    return payload.message ?? null;
  } catch {
    return null;
  }
}

/**
 * Crossref's query.bibliographic is fuzzy relevance search, not exact
 * lookup — the top hit for a short/generic title is frequently an unrelated
 * work that merely shares vocabulary (confirmed live: "Attention Is All You
 * Need" and "Why Most Published Research Findings Are False" both returned
 * a plausible-looking but WRONG top hit with a real, different DOI). Only
 * accept the top hit when its own title actually matches what we searched
 * for — otherwise this is worse than useless as ground truth, since a wrong
 * DOI would corrupt every downstream target-matching check.
 */
async function crossrefSearchByTitle(title: string): Promise<CrossrefWork | null> {
  try {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", title);
    url.searchParams.set("rows", "3");
    const res = await fetch(url, { headers: { "User-Agent": "TurnitPlus-CoverageBenchmark/1.0 (one-off internal QA script)" } });
    if (!res.ok) return null;
    const payload = (await res.json()) as { message?: { items?: CrossrefWork[] } };
    const items = payload.message?.items ?? [];
    const verified = items.find((item) => titlesMatch(item.title?.[0] ?? null, title));
    if (!verified) {
      log(`  [crossref] title search for "${title}" found no confidently-matching result (top candidate: "${items[0]?.title?.[0] ?? "(none)"}") — treating as unconfirmed, not guessing.`);
    }
    return verified ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Matching: is this candidate the paper we submitted?
// ---------------------------------------------------------------------------

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
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function candidateMatchesTarget(candidate: AcademicSearchCandidate, target: TestPaper): boolean {
  const targetDoi = normalizeDoi(target.doi);
  const candDoi = normalizeDoi(candidate.doi);
  if (targetDoi && candDoi && targetDoi === candDoi) return true;
  return titlesMatch(candidate.title, target.title);
}

function evidenceMatchesTarget(evidence: { doi: string | null; title: string | null }, target: TestPaper): boolean {
  const targetDoi = normalizeDoi(target.doi);
  const evDoi = normalizeDoi(evidence.doi);
  if (targetDoi && evDoi && targetDoi === evDoi) return true;
  return titlesMatch(evidence.title, target.title);
}

// ---------------------------------------------------------------------------
// Test paper model + sourcing
// ---------------------------------------------------------------------------

type TestPaper = {
  id: string;
  domain: string;
  sourcing: "hand-picked" | "openaire-discovered" | "europe-pmc-discovered";
  title: string;
  doi: string | null;
  crossrefType: string | null;
  crossrefPublisher: string | null;
  abstractText: string | null;
  fullText: string | null;
  fullTextSource: string | null;
};

const openaire = createOpenAireAcademicSearchProvider();
const europePmc = createEuropePmcAcademicSearchProvider();
const providersById: Record<string, AcademicSearchProvider> = { openaire, "europe-pmc": europePmc };
const contentRetriever = createAcademicSearchContentRetriever();

function keywordQuery(text: string): AcademicSearchQuery {
  return { queryText: text, rank: 0, sourcePassage: text, queryType: "keyword" };
}

async function sourceViaProvider(
  provider: AcademicSearchProvider,
  topicQuery: string,
  domain: string,
  id: string,
  sourcing: TestPaper["sourcing"],
): Promise<TestPaper | null> {
  let results: AcademicSearchResult[] = [];
  try {
    results = await provider.search(keywordQuery(topicQuery));
  } catch (err) {
    log(`  [sourcing] ${provider.id} topic query "${topicQuery}" failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
  const hit = results.find((r) => r.title && r.title.trim().length > 15);
  if (!hit) {
    log(`  [sourcing] ${provider.id} topic query "${topicQuery}" returned no usable candidate`);
    return null;
  }

  let fullText: string | null = null;
  let fullTextSource: string | null = null;
  if (provider.getText && hit.textAvailable) {
    try {
      fullText = await provider.getText(hit.externalId);
      if (fullText) fullTextSource = `${provider.id}:getText`;
    } catch {
      /* fall through to HTTP fallback below */
    }
  }
  if (!fullText && hit.url) {
    try {
      const retrieved = await contentRetriever.retrieve({ url: hit.url });
      if (retrieved.status === "SUCCESS" && retrieved.extractedText) {
        fullText = retrieved.extractedText;
        fullTextSource = `http-fallback:${hit.url}`;
      }
    } catch {
      /* leave fullText null */
    }
  }

  const crossref = hit.doi ? await crossrefLookupByDoi(hit.doi) : await crossrefSearchByTitle(hit.title!);
  const confirmedDoi = crossref?.DOI ?? hit.doi ?? null;

  log(`  [sourcing] ${id}: "${hit.title}" doi=${confirmedDoi ?? "(none)"} fullText=${fullText ? `${fullText.length} chars via ${fullTextSource}` : "unavailable"}`);

  return {
    id,
    domain,
    sourcing,
    title: hit.title!.trim(),
    doi: confirmedDoi,
    crossrefType: crossref?.type ?? null,
    crossrefPublisher: crossref?.publisher ?? (crossref?.["container-title"]?.[0] ?? null),
    abstractText: hit.abstract ?? null,
    fullText,
    fullTextSource,
  };
}

async function sourceHandPicked(
  id: string,
  domain: string,
  title: string,
  opts: { localPdfPath?: string; fetchFullTextViaEuropePmc?: boolean; knownDoiHint?: string; europePmcQuery?: string },
): Promise<TestPaper> {
  // A remembered DOI is a hypothesis, never ground truth on its own — verify
  // it by direct GET (authoritative, not fuzzy) and confirm the record's own
  // title actually matches before trusting it. Only fall back to fuzzy
  // bibliographic search (weaker: see crossrefSearchByTitle's own comment)
  // when no hint is given or the hint doesn't check out.
  let crossref: CrossrefWork | null = null;
  if (opts.knownDoiHint) {
    const hinted = await crossrefLookupByDoi(opts.knownDoiHint);
    if (hinted && titlesMatch(hinted.title?.[0] ?? null, title)) {
      crossref = hinted;
    } else {
      // A remembered DOI that doesn't verify is itself a signal this paper
      // is unlikely to be reliably disambiguable by fuzzy bibliographic
      // search either (confirmed live for this exact title — see git log /
      // conversation history) — better to report "not confirmed on
      // Crossref" than accept another guessable wrong match.
      log(`  [sourcing] ${id}: knownDoiHint ${opts.knownDoiHint} did not verify (${hinted ? `resolved to a different title: "${hinted.title?.[0]}"` : "not found on Crossref"}) — reporting unconfirmed rather than risking a fuzzy-search false positive.`);
    }
  } else {
    crossref = await crossrefSearchByTitle(title);
  }
  const confirmedDoi = crossref?.DOI ?? null;
  log(`  [sourcing] ${id} Crossref-confirmed doi=${confirmedDoi ?? "(NOT FOUND ON CROSSREF)"} title="${title}"`);

  let abstractText: string | null = null;
  let fullText: string | null = null;
  let fullTextSource: string | null = null;

  if (opts.localPdfPath) {
    const bytes = new Uint8Array(fs.readFileSync(opts.localPdfPath));
    fullText = await extractTextFromPdfBytes(bytes);
    fullTextSource = `local-fixture:${path.basename(opts.localPdfPath)}`;
    abstractText = fullText.slice(0, 1500); // first ~1500 chars stands in for an abstract-only submission
  }

  if (opts.fetchFullTextViaEuropePmc) {
    try {
      // A confirmed DOI gives an exact, unambiguous query — far more
      // reliable than fuzzy keyword search (see this function's own DOI
      // sourcing above for why fuzzy search misfires on this exact title).
      const query = confirmedDoi ? `DOI:${confirmedDoi}` : (opts.europePmcQuery ?? title);
      const results = await europePmc.search(keywordQuery(query));
      const hit = results.find((r) => titlesMatch(r.title, title));
      if (!hit) {
        log(`  [sourcing] ${id}: Europe PMC search "${query}" found no confidently-matching result (top candidate: "${results[0]?.title ?? "(none)"}")`);
      }
      if (hit) {
        abstractText = hit.abstract ?? abstractText;
        if (hit.textAvailable && europePmc.getText) {
          fullText = await europePmc.getText(hit.externalId);
          fullTextSource = "europe-pmc:getText";
        }
      }
    } catch (err) {
      log(`  [sourcing] ${id} Europe PMC full-text fetch failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  log(`  [sourcing] ${id}: abstract=${abstractText ? `${abstractText.length} chars` : "none"} fullText=${fullText ? `${fullText.length} chars via ${fullTextSource}` : "unavailable"}`);

  return {
    id,
    domain,
    sourcing: "hand-picked",
    title,
    doi: confirmedDoi,
    crossrefType: crossref?.type ?? null,
    crossrefPublisher: crossref?.publisher ?? (crossref?.["container-title"]?.[0] ?? null),
    abstractText,
    fullText,
    fullTextSource,
  };
}

// ---------------------------------------------------------------------------
// The benchmark itself: submit paper.fullText / paper.abstractText through
// the real, unmodified runAcademicSearch() pipeline and record every stage.
// ---------------------------------------------------------------------------

type StageResult = {
  paperId: string;
  domain: string;
  sourcing: TestPaper["sourcing"];
  title: string;
  doi: string | null;
  crossrefType: string | null;
  crossrefPublisher: string | null;
  inputMode: "full" | "abstract";
  inputChars: number | null;
  skippedReason: string | null;
  sourceExistsOnCrossref: boolean;
  queryCount: number | null;
  searchAttempts: number | null;
  providerErrors: AcademicSearchProviderError[] | null;
  openaireDiscovered: boolean;
  europePmcDiscovered: boolean;
  targetRank: number | null;
  candidatePoolSize: number | null;
  withinRetrievalBudget: boolean | null;
  retrievalAttempted: boolean;
  retrievalSucceeded: boolean | null;
  retrievalSource: string | null;
  retrievedTextChars: number | null;
  matchProduced: boolean;
  matchSimilarity: number | null;
  totalLatencyMs: number | null;
  gapDiagnosis: string | null;
};

function diagnoseGap(paper: TestPaper, openaireDiscovered: boolean, europePmcDiscovered: boolean, sourceExists: boolean): string | null {
  if (openaireDiscovered || europePmcDiscovered) return null;
  if (!sourceExists) return "Not found on Crossref either — likely too obscure/new, or not this benchmark's fault (possible title mismatch).";
  const type = paper.crossrefType ?? "";
  if (type === "posted-content" || /arxiv/i.test(paper.crossrefPublisher ?? "")) {
    return "Crossref lists this as a preprint (posted-content/arXiv). Neither OpenAIRE nor Europe PMC's search surfaced it under this subsystem's phrase-based queries. A preprint-aware or general scholarly index (e.g. Crossref, OpenAlex, Semantic Scholar) would be needed.";
  }
  if (type === "journal-article" || type === "proceedings-article") {
    return `Exists on Crossref as a ${type} (publisher: ${paper.crossrefPublisher ?? "unknown"}), but outside OpenAIRE's repository-harvest scope and Europe PMC's biomedical scope. A general publisher-agnostic index (e.g. Crossref, OpenAlex, Semantic Scholar) would close this gap.`;
  }
  return `Exists on Crossref (type: ${type || "unknown"}, publisher: ${paper.crossrefPublisher ?? "unknown"}), not covered by either current provider. A broader general-purpose index would be needed.`;
}

async function benchmarkOne(paper: TestPaper, inputMode: "full" | "abstract"): Promise<StageResult> {
  const base: Omit<StageResult, keyof {}> = {
    paperId: paper.id,
    domain: paper.domain,
    sourcing: paper.sourcing,
    title: paper.title,
    doi: paper.doi,
    crossrefType: paper.crossrefType,
    crossrefPublisher: paper.crossrefPublisher,
    inputMode,
    inputChars: null,
    skippedReason: null,
    sourceExistsOnCrossref: Boolean(paper.doi),
    queryCount: null,
    searchAttempts: null,
    providerErrors: null,
    openaireDiscovered: false,
    europePmcDiscovered: false,
    targetRank: null,
    candidatePoolSize: null,
    withinRetrievalBudget: null,
    retrievalAttempted: false,
    retrievalSucceeded: null,
    retrievalSource: null,
    retrievedTextChars: null,
    matchProduced: false,
    matchSimilarity: null,
    totalLatencyMs: null,
    gapDiagnosis: null,
  };

  const submissionText = inputMode === "full" ? paper.fullText : paper.abstractText;
  if (!submissionText || submissionText.trim().length < 200) {
    return { ...base, skippedReason: inputMode === "full" ? "no full text available for this paper" : "no abstract text available for this paper" };
  }

  log(`  [benchmark] ${paper.id} [${inputMode}] running (${submissionText.length} chars submitted)...`);
  const result = await runAcademicSearch(submissionText, [openaire, europePmc], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, contentRetriever);

  const target = result.candidates.find((c) => candidateMatchesTarget(c, paper)) ?? null;
  const openaireDiscovered = target ? target.contributors.some((c) => c.providerId === "openaire") : false;
  const europePmcDiscovered = target ? target.contributors.some((c) => c.providerId === "europe-pmc") : false;

  let withinRetrievalBudget: boolean | null = null;
  let retrievalAttempted = false;
  let retrievalSucceeded: boolean | null = null;
  let retrievalSource: string | null = null;
  let retrievedTextChars: number | null = null;

  if (target) {
    withinRetrievalBudget = target.rank < DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve;
    retrievalAttempted = true;
    const retrieval = await retrieveCandidateText(target, providersById, contentRetriever);
    retrievalSucceeded = Boolean(retrieval.text);
    retrievalSource = retrieval.source;
    retrievedTextChars = retrieval.text?.length ?? null;
  }

  const matchedEvidence = result.evidence.find((e) => evidenceMatchesTarget(e, paper)) ?? null;

  const gapDiagnosis = diagnoseGap(paper, openaireDiscovered, europePmcDiscovered, base.sourceExistsOnCrossref);

  log(
    `  [benchmark] ${paper.id} [${inputMode}] -> openaire=${openaireDiscovered} europePmc=${europePmcDiscovered} rank=${target?.rank ?? "n/a"} retrieval=${retrievalSucceeded} match=${Boolean(matchedEvidence)} (${result.status}, ${result.stats.totalLatencyMs}ms)`,
  );

  return {
    ...base,
    inputChars: submissionText.length,
    queryCount: result.stats.queryCount,
    searchAttempts: result.stats.searchAttempts,
    providerErrors: result.stats.providerErrors,
    openaireDiscovered,
    europePmcDiscovered,
    targetRank: target?.rank ?? null,
    candidatePoolSize: result.candidates.length,
    withinRetrievalBudget,
    retrievalAttempted,
    retrievalSucceeded,
    retrievalSource,
    retrievedTextChars,
    matchProduced: Boolean(matchedEvidence),
    matchSimilarity: matchedEvidence?.similarity ?? null,
    totalLatencyMs: result.stats.totalLatencyMs,
    gapDiagnosis,
  };
}

// ---------------------------------------------------------------------------
// Paper set
// ---------------------------------------------------------------------------

async function buildPaperSet(): Promise<TestPaper[]> {
  const papers: TestPaper[] = [];

  log("Sourcing paper set...");

  papers.push(
    await sourceHandPicked("cs-attention", "Computer Science / AI / ML", "Attention Is All You Need", {
      localPdfPath: path.join(process.cwd(), "tests", "fixtures", "attention-is-all-you-need.pdf"),
      knownDoiHint: "10.48550/arXiv.1706.03762",
    }),
  );
  papers.push(
    (await sourceViaProvider(openaire, "graph neural network representation learning survey", "Computer Science / AI / ML", "cs-openaire-gnn", "openaire-discovered"))!,
  );

  papers.push(
    await sourceHandPicked("med-ioannidis", "Medicine / Biomedical", "Why Most Published Research Findings Are False", {
      fetchFullTextViaEuropePmc: true,
      knownDoiHint: "10.1371/journal.pmed.0020124",
      europePmcQuery: "Ioannidis Why Most Published Research Findings Are False",
    }),
  );
  papers.push(
    (await sourceViaProvider(europePmc, "CRISPR Cas9 gene editing clinical trial safety", "Medicine / Biomedical", "med-europepmc-crispr", "europe-pmc-discovered"))!,
  );

  papers.push(
    (await sourceViaProvider(openaire, "social media misinformation political polarization survey", "Social Sciences", "soc-openaire-misinfo", "openaire-discovered"))!,
  );
  papers.push(
    (await sourceViaProvider(europePmc, "COVID-19 lockdown mental health anxiety survey", "Social Sciences", "soc-europepmc-covidmh", "europe-pmc-discovered"))!,
  );

  papers.push(
    (await sourceViaProvider(openaire, "consumer brand loyalty social media marketing", "Business / Marketing", "biz-openaire-brand", "openaire-discovered"))!,
  );
  papers.push(
    (await sourceViaProvider(openaire, "corporate social responsibility firm financial performance", "Business / Marketing", "biz-openaire-csr", "openaire-discovered"))!,
  );

  papers.push(
    (await sourceViaProvider(openaire, "solar photovoltaic energy conversion efficiency review", "Engineering", "eng-openaire-solar", "openaire-discovered"))!,
  );
  papers.push(
    (await sourceViaProvider(openaire, "structural health monitoring sensor network bridge", "Engineering", "eng-openaire-shm", "openaire-discovered"))!,
  );

  papers.push(
    (await sourceViaProvider(openaire, "digital humanities text mining literature corpus analysis", "Humanities", "hum-openaire-dh", "openaire-discovered"))!,
  );
  papers.push(
    (await sourceViaProvider(openaire, "cultural heritage digital preservation archive", "Humanities", "hum-openaire-heritage", "openaire-discovered"))!,
  );

  return papers.filter(Boolean);
}

async function main() {
  let papers = await buildPaperSet();
  fs.writeFileSync(path.join(OUTPUT_DIR, `${RUN_ID}-papers.json`), JSON.stringify(papers, null, 2));

  // Resume support: BENCHMARK_ONLY_PAPER_IDS=id1,id2 restricts the benchmark
  // loop (not sourcing, which is cheap) to specific paper ids — used to
  // recover the remainder of a run after the undici crash documented above,
  // without re-running (and re-logging results for) papers already done.
  const onlyIds = process.env.BENCHMARK_ONLY_PAPER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (onlyIds && onlyIds.length > 0) {
    papers = papers.filter((p) => onlyIds.includes(p.id));
    log(`BENCHMARK_ONLY_PAPER_IDS set — restricting benchmark loop to: ${papers.map((p) => p.id).join(", ")}`);
  }

  log(`Sourced ${papers.length} papers. Running benchmark (full + abstract for each)...`);

  const rows: StageResult[] = [];
  for (const paper of papers) {
    rows.push(await benchmarkOne(paper, "full"));
    rows.push(await benchmarkOne(paper, "abstract"));
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `${RUN_ID}-results.json`), JSON.stringify(rows, null, 2));
  log(`Done. Results written to tools/output/${RUN_ID}-results.json`);
}

main().catch((err) => {
  console.error("BENCHMARK FAILED:", err);
  process.exitCode = 1;
});
