// Accuracy & Coverage Benchmark — ground-truth source paper sourcing.
//
// Deliberately duplicated (not imported) from tools/benchmark-academic-
// coverage.ts's own sourceHandPicked/sourceViaProvider/Crossref-verification
// logic — this codebase's own stated convention for small, independent
// per-consumer helpers (see lib/unified-similarity.ts's academicIdentityKey
// comment) rather than reaching into an already-run, separately-referenced
// benchmark script. Every paper here is either a real, well-known paper
// (Crossref-verified DOI, never trusted from memory alone) or discovered
// live via a plain topic query against OpenAIRE's/Europe PMC's own search().
import fs from "node:fs";
import path from "node:path";
import { createEuropePmcAcademicSearchProvider } from "../../lib/academic-search/providers/europe-pmc";
import { createOpenAireAcademicSearchProvider } from "../../lib/academic-search/providers/openaire";
import { createAcademicSearchContentRetriever } from "../../lib/academic-search/text-retriever";
import type { AcademicSearchQuery, AcademicSearchResult } from "../../lib/academic-search/types";
import type { AcademicSearchProvider } from "../../lib/academic-search/provider";
import { extractTextFromPdfBytes } from "../../lib/e7-asjp-client";

export type DomainPaper = {
  id: string;
  domain: string;
  title: string;
  doi: string | null;
  fullText: string;
};

type CrossrefWork = { DOI?: string; title?: string[] };

async function crossrefLookupByDoi(doi: string): Promise<CrossrefWork | null> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { "User-Agent": "TurnitPlus-AccuracyBenchmark/1.0 (internal QA script)" },
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { message?: CrossrefWork };
    return payload.message ?? null;
  } catch {
    return null;
  }
}

function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function titlesMatch(a: string | null, b: string | null): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb || na.length < 8 || nb.length < 8) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

export function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

const openaire = createOpenAireAcademicSearchProvider();
const europePmc = createEuropePmcAcademicSearchProvider();
const contentRetriever = createAcademicSearchContentRetriever();

function keywordQuery(text: string): AcademicSearchQuery {
  return { queryText: text, rank: 0, sourcePassage: text, queryType: "keyword" };
}

/** Sourcing (unlike the main benchmark pipeline) makes only a handful of network calls total, so a bounded retry on the provider's own transient timeout/rate-limit errors is worth the small extra latency — avoids one flaky 8s timeout aborting an entire domain's sourcing. */
async function withRetry<T>(attempt: () => Promise<T>, attempts = 3, delayMs = 1500): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function sourceFromLocalPdf(id: string, domain: string, title: string, pdfPath: string, knownDoiHint?: string): Promise<DomainPaper> {
  const bytes = new Uint8Array(fs.readFileSync(pdfPath));
  const fullText = await extractTextFromPdfBytes(bytes);
  let doi: string | null = null;
  if (knownDoiHint) {
    const hinted = await crossrefLookupByDoi(knownDoiHint);
    if (hinted && titlesMatch(hinted.title?.[0] ?? null, title)) doi = hinted.DOI ?? knownDoiHint;
  }
  return { id, domain, title, doi, fullText };
}

/** Hand-picked paper with a known DOI, full text fetched via Europe PMC (proven query from the prior coverage benchmark). */
export async function sourceHandPickedViaEuropePmc(
  id: string,
  domain: string,
  title: string,
  knownDoi: string,
  europePmcQuery: string,
): Promise<DomainPaper | null> {
  const hinted = await crossrefLookupByDoi(knownDoi);
  if (!hinted || !titlesMatch(hinted.title?.[0] ?? null, title)) {
    return null;
  }
  const confirmedDoi = hinted.DOI ?? knownDoi;
  // A confirmed DOI gives an exact, unambiguous query — far more reliable
  // than free-text keyword search, whose top results can drift over time
  // (confirmed live: the plain-title query stopped surfacing this exact
  // paper at all). Same DOI-first precedence
  // tools/benchmark-academic-coverage.ts's own sourceHandPicked uses.
  const results = await withRetry(() => europePmc.search(keywordQuery(`DOI:${confirmedDoi}`)));
  const hit = results.find((r) => titlesMatch(r.title, title)) ?? (await withRetry(() => europePmc.search(keywordQuery(europePmcQuery)))).find((r) => titlesMatch(r.title, title));
  if (!hit || !hit.textAvailable || !europePmc.getText) return null;
  const fullText = await withRetry(() => europePmc.getText!(hit.externalId));
  if (!fullText || fullText.trim().length < 500) return null;
  return { id, domain, title, doi: confirmedDoi, fullText };
}

/**
 * Discovers a paper live via a topic query and fetches its full text (via
 * the provider's own getText(), falling back to an HTTP fetch of its URL —
 * same fallback chain tools/benchmark-academic-coverage.ts's own
 * sourceViaProvider uses). Tries each query in `topicQueries` in order until
 * one yields usable full text, so a domain with no single reliable query
 * (Engineering/Humanities did not, in the prior coverage benchmark run) can
 * still be sourced without a human picking the exact right phrase in advance.
 */
export async function sourceViaProviderWithFallback(
  provider: AcademicSearchProvider,
  topicQueries: string[],
  domain: string,
  id: string,
): Promise<DomainPaper | null> {
  for (const topicQuery of topicQueries) {
    let results: AcademicSearchResult[] = [];
    try {
      results = await withRetry(() => provider.search(keywordQuery(topicQuery)));
    } catch {
      continue;
    }
    const candidates = results.filter((r) => r.title && r.title.trim().length > 15);
    for (const hit of candidates) {
      let fullText: string | null = null;
      if (provider.getText && hit.textAvailable) {
        try {
          fullText = await withRetry(() => provider.getText!(hit.externalId));
        } catch {
          /* fall through */
        }
      }
      if (!fullText && hit.url) {
        try {
          const retrieved = await contentRetriever.retrieve({ url: hit.url });
          if (retrieved.status === "SUCCESS" && retrieved.extractedText) fullText = retrieved.extractedText;
        } catch {
          /* leave null */
        }
      }
      if (fullText && fullText.trim().length >= 2000) {
        const crossref = hit.doi ? await crossrefLookupByDoi(hit.doi) : null;
        return { id, domain, title: hit.title!.trim(), doi: crossref?.DOI ?? hit.doi ?? null, fullText };
      }
    }
  }
  return null;
}

export const openaireProvider = openaire;
export const europePmcProvider = europePmc;

export async function sourceAllDomainPapers(log: (...args: unknown[]) => void): Promise<DomainPaper[]> {
  const papers: DomainPaper[] = [];

  log("Sourcing CS/AI/ML: Attention Is All You Need (local fixture)...");
  papers.push(
    await sourceFromLocalPdf(
      "cs-attention",
      "Computer Science / AI / ML",
      "Attention Is All You Need",
      path.join(process.cwd(), "tests", "fixtures", "attention-is-all-you-need.pdf"),
      "10.48550/arXiv.1706.03762",
    ),
  );

  log("Sourcing Medicine: Why Most Published Research Findings Are False (Europe PMC)...");
  const medicine = await sourceHandPickedViaEuropePmc(
    "med-ioannidis",
    "Medicine / Biomedical",
    "Why Most Published Research Findings Are False",
    "10.1371/journal.pmed.0020124",
    "Ioannidis Why Most Published Research Findings Are False",
  );
  if (!medicine) throw new Error("Failed to source the Medicine domain paper (Ioannidis) — expected this to be reliable per the prior coverage benchmark run.");
  papers.push(medicine);

  log("Sourcing Social Sciences via OpenAIRE...");
  const social = await sourceViaProviderWithFallback(
    openaire,
    ["social media misinformation political polarization survey", "affective polarization misinformation belief"],
    "Social Sciences",
    "soc-openaire",
  );
  if (!social) throw new Error("Failed to source a Social Sciences domain paper via OpenAIRE.");
  papers.push(social);

  log("Sourcing Business/Marketing via OpenAIRE...");
  const business = await sourceViaProviderWithFallback(
    openaire,
    ["corporate social responsibility firm financial performance", "consumer brand loyalty social media marketing"],
    "Business / Marketing",
    "biz-openaire",
  );
  if (!business) throw new Error("Failed to source a Business/Marketing domain paper via OpenAIRE.");
  papers.push(business);

  log("Sourcing Engineering via OpenAIRE (needs fresh sourcing — no full text in prior runs)...");
  const engineering = await sourceViaProviderWithFallback(
    openaire,
    [
      "renewable energy system performance review",
      "structural health monitoring sensor network",
      "wireless sensor network infrastructure reliability",
    ],
    "Engineering",
    "eng-openaire",
  );
  if (!engineering) throw new Error("Failed to source an Engineering domain paper via OpenAIRE after all fallback queries.");
  papers.push(engineering);

  log("Sourcing Humanities via OpenAIRE (needs fresh sourcing — no full text in prior runs)...");
  const humanities = await sourceViaProviderWithFallback(
    openaire,
    [
      "digital humanities text mining literature corpus",
      "cultural heritage digital preservation archive",
      "history text analysis corpus linguistics",
    ],
    "Humanities",
    "hum-openaire",
  );
  if (!humanities) throw new Error("Failed to source a Humanities domain paper via OpenAIRE after all fallback queries.");
  papers.push(humanities);

  return papers;
}
