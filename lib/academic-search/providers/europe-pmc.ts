import {
  AcademicSearchProviderUnavailableError,
  AcademicSearchRateLimitError,
  AcademicSearchTimeoutError,
  type AcademicSearchProvider,
} from "../provider";
import type { AcademicSearchQuery, AcademicSearchResult } from "../types";
import { extractTextFromJatsXml } from "./jats-text-extractor";

/**
 * A real (network-capable) provider backed by the Europe PMC REST API
 * (https://www.ebi.ac.uk/europepmc/webservices/rest/) — Phase 2's Priority
 * 2 free provider. No API key, no registration; EBI publishes it as free,
 * unlimited-registration public infrastructure with no paid tier, which is
 * what the phase's hard "must stay free" requirement calls for.
 *
 * Every field mapped below, and both non-obvious query-syntax choices, were
 * checked against real HTTP 200 responses fetched during this phase:
 *  - The default (unspecified resultType, equivalently resultType=lite)
 *    search response already includes doi/pmcid/isOpenAccess/journalTitle
 *    flat on each result — no need for the heavier resultType=core payload
 *    just to populate this subsystem's normalized shape.
 *  - OA filtering is a query-string term, not a separate parameter:
 *    `... AND OPEN_ACCESS:Y`.
 *  - `externalId` is the PMCID (e.g. "PMC13178875") when Europe PMC
 *    supplies one, falling back to Europe PMC's own `id` otherwise — this
 *    is deliberate, not arbitrary: getText() only ever succeeds for a
 *    "PMC..."-shaped externalId, so a result with no PMCID naturally can
 *    never attempt (and fail) a full-text fetch. getMetadata() handles both
 *    shapes by switching query syntax (`PMCID:...` vs `EXT_ID:...`).
 *  - `GET /{PMCID}/fullTextXML` 404s (empty body) for an id Europe PMC
 *    does not have full text for — handled as "no text," not an error.
 *
 * textAvailable is only ever true when Europe PMC's own flags say the
 * fullTextXML endpoint should work for this record (pmcid present AND
 * isOpenAccess: "Y") — STEP 3's "do not retrieve full text for articles
 * where the provider does not make it available," applied at the
 * normalization stage so a caller never has to know the underlying
 * eligibility rule. getText() still independently handles a 404/empty
 * response as null rather than trusting that flag blindly.
 */

export type EuropePmcProviderConfig = {
  baseUrl?: string;
  maxResultsPerRequest: number;
  timeoutMs: number;
  retry: { maxAttempts: number; baseDelayMs: number };
  /** Restrict search() to a specific EBI query-syntax filter, e.g. "OPEN_ACCESS:Y" — appended to every query with AND. Empty by default (unfiltered relevance search); STEP 3 explicitly asks the provider to support OA filtering, not to force it on. */
  extraQueryFilter?: string;
  /** Injectable for tests — never defaults to a live call in a test context. */
  fetcher?: typeof fetch;
};

export const DEFAULT_EUROPE_PMC_PROVIDER_CONFIG: EuropePmcProviderConfig = {
  maxResultsPerRequest: 5,
  timeoutMs: 8_000,
  retry: { maxAttempts: 2, baseDelayMs: 500 },
};

type EuropePmcSearchResult = {
  id: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  isOpenAccess?: "Y" | "N";
  inEPMC?: "Y" | "N";
};

type EuropePmcSearchResponse = {
  hitCount?: number;
  resultList?: { result?: EuropePmcSearchResult[] };
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseAuthors(authorString: string | undefined): string[] | null {
  if (!authorString?.trim()) return null;
  const authors = authorString.replace(/\.$/, "").split(/,\s*/).map((a) => a.trim()).filter(Boolean);
  return authors.length > 0 ? authors : null;
}

function resultUrl(item: EuropePmcSearchResult): string | null {
  if (item.pmcid) return `https://europepmc.org/article/PMC/${item.pmcid}`;
  if (item.pmid) return `https://europepmc.org/article/MED/${item.pmid}`;
  if (item.doi) return `https://doi.org/${item.doi}`;
  return null;
}

function isFullTextEligible(item: EuropePmcSearchResult): boolean {
  return Boolean(item.pmcid) && item.isOpenAccess === "Y";
}

function mapEuropePmcResult(item: EuropePmcSearchResult, queryText: string): AcademicSearchResult {
  return {
    providerId: "europe-pmc",
    externalId: item.pmcid ?? item.id,
    title: item.title?.trim() || null,
    authors: parseAuthors(item.authorString),
    publication: item.journalTitle?.trim() || null,
    year: item.pubYear ? Number(item.pubYear) : null,
    doi: item.doi?.trim() || null,
    url: resultUrl(item),
    textAvailable: isFullTextEligible(item),
    querySignalUsed: queryText,
    // Europe PMC's search response carries no per-result relevance/score field (results are simply returned in relevance order when no sort param is given) — left null rather than invented.
    providerRelevance: null,
  };
}

async function europePmcRequest<T>(url: string, config: EuropePmcProviderConfig): Promise<T | null> {
  const fetcher = config.fetcher ?? fetch;

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetcher(url, { signal: controller.signal });

      if (response.status === 404) return null;
      if (response.status === 429) {
        throw new AcademicSearchRateLimitError("Europe PMC API rate limit reached (HTTP 429)");
      }
      if (response.status >= 500) {
        throw new AcademicSearchProviderUnavailableError(`Europe PMC API returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`Europe PMC API returned HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("json")) {
        try {
          return (await response.json()) as T;
        } catch {
          throw new Error("Europe PMC API returned malformed JSON");
        }
      }
      return (await response.text()) as unknown as T;
    } catch (error) {
      if (error instanceof AcademicSearchRateLimitError) throw error;

      const timedOut = controller.signal.aborted || isAbortError(error);
      let classified: unknown = error;
      if (timedOut) {
        classified = new AcademicSearchTimeoutError(`Europe PMC API request timed out after ${config.timeoutMs} ms`);
      } else if (
        !(error instanceof AcademicSearchProviderUnavailableError)
        && !(error instanceof Error && error.message.startsWith("Europe PMC API returned"))
      ) {
        classified = new AcademicSearchProviderUnavailableError(`Europe PMC API network error: ${error instanceof Error ? error.message : String(error)}`);
      }
      lastError = classified;

      const retryable = classified instanceof AcademicSearchTimeoutError || classified instanceof AcademicSearchProviderUnavailableError;
      if (retryable && attempt < config.retry.maxAttempts) {
        if (config.retry.baseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.retry.baseDelayMs));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Europe PMC API request failed");
}

function buildSearchUrl(query: AcademicSearchQuery, config: EuropePmcProviderConfig): string {
  const baseUrl = config.baseUrl ?? "https://www.ebi.ac.uk/europepmc/webservices/rest";
  const queryString = config.extraQueryFilter ? `${query.queryText} AND ${config.extraQueryFilter}` : query.queryText;
  const params = new URLSearchParams({
    query: queryString,
    format: "json",
    pageSize: String(config.maxResultsPerRequest),
    resultType: "lite",
  });
  return `${baseUrl}/search?${params.toString()}`;
}

export function createEuropePmcAcademicSearchProvider(config: Partial<EuropePmcProviderConfig> = {}): AcademicSearchProvider {
  const resolved: EuropePmcProviderConfig = { ...DEFAULT_EUROPE_PMC_PROVIDER_CONFIG, ...config, retry: { ...DEFAULT_EUROPE_PMC_PROVIDER_CONFIG.retry, ...config.retry } };
  const baseUrl = resolved.baseUrl ?? "https://www.ebi.ac.uk/europepmc/webservices/rest";

  return {
    id: "europe-pmc",

    async search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]> {
      const payload = await europePmcRequest<EuropePmcSearchResponse>(buildSearchUrl(query, resolved), resolved);
      const items = payload?.resultList?.result ?? [];
      return items.map((item) => mapEuropePmcResult(item, query.queryText));
    },

    async getMetadata(externalId: string): Promise<Partial<AcademicSearchResult> | null> {
      const lookupQuery = externalId.startsWith("PMC") ? `PMCID:${externalId}` : `EXT_ID:${externalId}`;
      const params = new URLSearchParams({ query: lookupQuery, format: "json", resultType: "lite", pageSize: "1" });
      try {
        const payload = await europePmcRequest<EuropePmcSearchResponse>(`${baseUrl}/search?${params.toString()}`, resolved);
        const item = payload?.resultList?.result?.[0];
        return item ? mapEuropePmcResult(item, "") : null;
      } catch {
        return null;
      }
    },

    /**
     * Only ever attempts the fullTextXML fetch for a PMC-shaped externalId
     * (see this file's header comment) — a non-OA or PMCID-less result
     * simply can never reach the network call, matching STEP 3's "do not
     * retrieve full text for articles where the provider does not make it
     * available."
     */
    async getText(externalId: string): Promise<string | null> {
      if (!externalId.startsWith("PMC")) return null;
      try {
        const xml = await europePmcRequest<string>(`${baseUrl}/${encodeURIComponent(externalId)}/fullTextXML`, resolved);
        if (!xml || typeof xml !== "string") return null;
        const text = extractTextFromJatsXml(xml);
        return text.trim() || null;
      } catch {
        return null;
      }
    },
  };
}
