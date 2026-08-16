import {
  AcademicSearchProviderUnavailableError,
  AcademicSearchRateLimitError,
  AcademicSearchTimeoutError,
  type AcademicSearchProvider,
} from "../provider";
import type { AcademicSearchQuery, AcademicSearchResult } from "../types";

/**
 * A real (network-capable) provider backed by the OpenAIRE Graph API v3
 * (https://api.openaire.eu/graph/v3/research-products) — Phase 2's Priority
 * 1 free provider. No API key, no registration, and no paid tier exists for
 * this endpoint: it is EU-publicly-funded open infrastructure, which is
 * exactly what the phase's hard "must stay free" requirement calls for.
 *
 * Unlike providers/core.ts (whose request/response shape was never verified
 * against a live call — see that file's own header comment), every field
 * mapped below was checked against real HTTP 200 responses fetched during
 * this phase: plain-text search, the `type=publication` filter, the
 * `accessRightLabel=("Open Access")` OA filter (the exact quoting OpenAIRE
 * requires for a value containing a space — confirmed via the API's own 400
 * error message, which lists every valid parameter name and every valid
 * accessRightLabel value), and the single-record `GET
 * /research-products/{id}` lookup used by getMetadata.
 *
 * Deliberately no getText(): the Graph API's research-products response has
 * no full-text field at any point in its ~40-key shape, only landing-page /
 * repository URLs (`instances[].urls`). Claiming textAvailable from
 * metadata alone is exactly what STEP 2 says not to do, so textAvailable is
 * always false here and getText is omitted entirely — orchestrator.ts's
 * existing HTTP-fallback path (text-retriever.ts fetching candidate.url) is
 * the only way this provider's candidates ever yield text, and only for the
 * ones the URL-selection logic below points at an actual OPEN-access
 * instance.
 *
 * Offset paging tops out at 10,000 results and the docs steer high-volume
 * consumers toward cursor paging instead — irrelevant here: STEP 4 caps
 * this subsystem at a handful of relevance-ranked results per phrase, never
 * a full result set, so this provider only ever requests page 1 and never
 * touches the cursor parameter.
 */

export type OpenAireProviderConfig = {
  baseUrl?: string;
  maxResultsPerRequest: number;
  timeoutMs: number;
  retry: { maxAttempts: number; baseDelayMs: number };
  /** Restrict search() to type=publication (excludes software/dataset/other product types OpenAIRE also indexes) — on by default since a plagiarism-adjacent academic search has little use for a GitHub repo record. */
  publicationsOnly: boolean;
  /** Injectable for tests — never defaults to a live call in a test context. */
  fetcher?: typeof fetch;
};

export const DEFAULT_OPENAIRE_PROVIDER_CONFIG: OpenAireProviderConfig = {
  maxResultsPerRequest: 5,
  timeoutMs: 8_000,
  retry: { maxAttempts: 2, baseDelayMs: 500 },
  publicationsOnly: true,
};

type OpenAireAuthor = { fullName?: string | null };
type OpenAirePid = { scheme?: string | null; value?: string | null };
type OpenAireAccessRight = { code?: string | null; label?: string | null };
type OpenAireInstance = { urls?: string[] | null; accessRight?: OpenAireAccessRight | null };
type OpenAireContainer = { name?: string | null };

type OpenAireResult = {
  id: string;
  type?: string | null;
  mainTitle?: string | null;
  authors?: OpenAireAuthor[] | null;
  publicationDate?: string | null;
  publisher?: string | null;
  container?: OpenAireContainer | null;
  bestAccessRight?: OpenAireAccessRight | null;
  pids?: OpenAirePid[] | null;
  instances?: OpenAireInstance[] | null;
};

type OpenAireSearchResponse = {
  header?: { numFound?: number };
  results?: OpenAireResult[];
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function extractYear(publicationDate: string | null | undefined): number | null {
  const match = publicationDate?.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function extractDoi(pids: OpenAirePid[] | null | undefined): string | null {
  const doi = pids?.find((pid) => pid.scheme?.toLowerCase() === "doi")?.value;
  return doi?.trim() || null;
}

/** Prefers a URL from an OPEN-access instance (more likely to actually be fetchable text, not a paywall) over any other instance, but never claims this URL is guaranteed to yield full text — see this file's header comment. */
function resultUrl(item: OpenAireResult, doi: string | null): string | null {
  const instances = item.instances ?? [];
  const openInstance = instances.find((instance) => instance.accessRight?.label?.toUpperCase() === "OPEN" && instance.urls?.[0]);
  if (openInstance?.urls?.[0]) return openInstance.urls[0];
  const anyInstance = instances.find((instance) => instance.urls?.[0]);
  if (anyInstance?.urls?.[0]) return anyInstance.urls[0];
  if (doi) return `https://doi.org/${doi}`;
  return null;
}

function mapOpenAireResult(item: OpenAireResult, queryText: string): AcademicSearchResult {
  const authors = Array.isArray(item.authors)
    ? item.authors.map((a) => a.fullName?.trim()).filter((name): name is string => Boolean(name))
    : null;
  const doi = extractDoi(item.pids);
  return {
    providerId: "openaire",
    externalId: item.id,
    title: item.mainTitle?.trim() || null,
    authors: authors && authors.length > 0 ? authors : null,
    publication: item.container?.name?.trim() || item.publisher?.trim() || null,
    year: extractYear(item.publicationDate),
    doi,
    url: resultUrl(item, doi),
    // No fullText field exists anywhere in this API's response shape — see header comment.
    textAvailable: false,
    querySignalUsed: queryText,
    // No documented per-result relevance/score field (only header.maxScore for the whole page) — left null rather than invented, matching providers/core.ts's own convention.
    providerRelevance: null,
  };
}

async function openAireRequest<T>(url: string, config: OpenAireProviderConfig): Promise<T> {
  const fetcher = config.fetcher ?? fetch;

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetcher(url, { signal: controller.signal });

      if (response.status === 429) {
        throw new AcademicSearchRateLimitError("OpenAIRE API rate limit reached (HTTP 429)");
      }
      if (response.status >= 500) {
        throw new AcademicSearchProviderUnavailableError(`OpenAIRE API returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`OpenAIRE API returned HTTP ${response.status}`);
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new Error("OpenAIRE API returned malformed JSON");
      }
    } catch (error) {
      if (error instanceof AcademicSearchRateLimitError) throw error;

      const timedOut = controller.signal.aborted || isAbortError(error);
      let classified: unknown = error;
      if (timedOut) {
        classified = new AcademicSearchTimeoutError(`OpenAIRE API request timed out after ${config.timeoutMs} ms`);
      } else if (
        !(error instanceof AcademicSearchProviderUnavailableError)
        && !(error instanceof Error && error.message.startsWith("OpenAIRE API returned"))
      ) {
        classified = new AcademicSearchProviderUnavailableError(`OpenAIRE API network error: ${error instanceof Error ? error.message : String(error)}`);
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
  throw lastError instanceof Error ? lastError : new Error("OpenAIRE API request failed");
}

/**
 * The `search` param has its own light query grammar (parentheses are
 * grouping operators, straight double quotes open an exact-phrase span) —
 * confirmed live: a phrase-extractor sentence fragment containing an
 * unbalanced "(" (ordinary scientific-writing punctuation, e.g.
 * "nitrification genes (amoA and") gets HTTP 400 "Mismatched parentheses in
 * input"; a fragment containing a lone straight quote, e.g. a sentence
 * window that starts or ends mid-quotation ('above." In implementation of
 * this...', found live in a real Phase 3.5 validation document) gets HTTP
 * 400 "Mismatched quotes in input" the same way — both confirmed against
 * the real API, not guessed. A curly right double quotation mark (”, as
 * opposed to the straight ASCII "), and a lone apostrophe/single quote,
 * were both confirmed live NOT to trigger this — only the straight double
 * quote is special to OpenAIRE's parser, so only it is stripped alongside
 * parentheses. Our own queries are always meant as plain relevance search,
 * never OpenAIRE's query DSL, so these characters are stripped rather than
 * escaped/quoted — quoting turns the whole query into an exact-phrase match
 * instead (verified live: numFound dropped from 1500+ to 0 on an ordinary
 * query once quoted), which would gut recall far worse than the rare
 * mismatched-parens/quotes 400 this avoids.
 */
function sanitizeQueryText(queryText: string): string {
  return queryText.replace(/[()"]/g, " ").replace(/\s+/g, " ").trim();
}

function buildSearchUrl(query: AcademicSearchQuery, config: OpenAireProviderConfig): string {
  const baseUrl = config.baseUrl ?? "https://api.openaire.eu/graph/v3/research-products";
  const params = new URLSearchParams({
    search: sanitizeQueryText(query.queryText),
    pageSize: String(config.maxResultsPerRequest),
    sortBy: "relevance DESC",
  });
  if (config.publicationsOnly) params.set("type", "publication");
  return `${baseUrl}?${params.toString()}`;
}

export function createOpenAireAcademicSearchProvider(config: Partial<OpenAireProviderConfig> = {}): AcademicSearchProvider {
  const resolved: OpenAireProviderConfig = { ...DEFAULT_OPENAIRE_PROVIDER_CONFIG, ...config, retry: { ...DEFAULT_OPENAIRE_PROVIDER_CONFIG.retry, ...config.retry } };

  return {
    id: "openaire",

    async search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]> {
      const payload = await openAireRequest<OpenAireSearchResponse>(buildSearchUrl(query, resolved), resolved);
      const items = Array.isArray(payload.results) ? payload.results : [];
      return items.map((item) => mapOpenAireResult(item, query.queryText));
    },

    async getMetadata(externalId: string): Promise<Partial<AcademicSearchResult> | null> {
      const baseUrl = resolved.baseUrl ?? "https://api.openaire.eu/graph/v3/research-products";
      try {
        const item = await openAireRequest<OpenAireResult>(`${baseUrl}/${encodeURIComponent(externalId)}`, resolved);
        return mapOpenAireResult(item, "");
      } catch {
        return null;
      }
    },
  };
}
