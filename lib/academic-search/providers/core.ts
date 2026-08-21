import {
  AcademicSearchProviderUnavailableError,
  AcademicSearchRateLimitError,
  AcademicSearchTimeoutError,
  type AcademicSearchProvider,
} from "../provider";
import type { AcademicSearchQuery, AcademicSearchResult } from "../types";

/**
 * A real (network-capable) provider backed by CORE's v3 REST API
 * (https://core.ac.uk/services/api) — the provider STEP 5 names as
 * acceptable for the POC. Server-side only.
 *
 * Confidence/verification note, stated honestly rather than overclaimed
 * (unlike lib/discovery-crossref-provider.ts's header comment, which could
 * cite direct, verified access to Crossref's own docs and a live response):
 * this environment could not reach https://api.core.ac.uk/docs/v3 directly
 * (a direct fetch returned HTTP 403), and no CORE_API_KEY was available to
 * exercise a real authenticated request. The request/response shape below
 * was cross-checked against two independent secondary sources that agree
 * with each other — CORE's own public-facing API description and an
 * unrelated open-source community client's TypeScript interface for this
 * same endpoint — but it has NOT been proven against a live response in
 * this environment. Field names most likely to have drifted from a real
 * response: `journals`/`publisher` (used here only as a display fallback,
 * never for dedup identity) and whatever CORE calls its relevance/score
 * signal, if any — providerRelevance is left null here rather than guessed.
 * Before this provider is trusted in production, run
 * tests/academic-search-core-integration.test.mjs with a real
 * CORE_API_KEY (RUN_CORE_INTEGRATION=1) and correct any field-mapping
 * drift it surfaces.
 *
 * Known facts this implementation depends on:
 *  - Base URL: https://api.core.ac.uk/v3
 *  - Search: POST /search/works with a JSON body { q, limit, offset }
 *  - Metadata/full text: GET /works/{id}
 *  - Auth: `Authorization: Bearer <API key>` header. No key is read from
 *    process.env inside this file — matching lib/discovery-crossref-provider
 *    .ts's own convention, the caller is responsible for reading
 *    CORE_API_KEY and passing it in via config.apiKey. Without a key, CORE
 *    still serves limited public-rate-limit traffic per its own docs; this
 *    provider does not special-case that, it simply lets an unauthenticated
 *    request go through and surfaces whatever CORE returns.
 */

export type CoreProviderRetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
};

export type CoreProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  maxResultsPerRequest: number;
  timeoutMs: number;
  retry: CoreProviderRetryConfig;
  /** Injectable for tests — never defaults to a live call in a test context. */
  fetcher?: typeof fetch;
};

export const DEFAULT_CORE_PROVIDER_CONFIG: CoreProviderConfig = {
  maxResultsPerRequest: 5,
  timeoutMs: 8_000,
  retry: { maxAttempts: 2, baseDelayMs: 500 },
};

type CoreAuthor = { name?: string };
type CoreWorkItem = {
  id: number | string;
  doi?: string | null;
  title?: string | null;
  authors?: CoreAuthor[] | null;
  publisher?: string | null;
  yearPublished?: number | null;
  downloadUrl?: string | null;
  sourceFulltextUrls?: string[] | null;
  fullText?: string | null;
};

type CoreSearchResponse = {
  totalHits?: number;
  results?: CoreWorkItem[];
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resultUrl(item: CoreWorkItem): string | null {
  if (item.downloadUrl?.trim()) return item.downloadUrl.trim();
  if (item.sourceFulltextUrls?.[0]?.trim()) return item.sourceFulltextUrls[0].trim();
  if (item.doi?.trim()) return `https://doi.org/${item.doi.trim()}`;
  return null;
}

function mapCoreWorkItem(item: CoreWorkItem, queryText: string): AcademicSearchResult {
  const authors = Array.isArray(item.authors)
    ? item.authors.map((a) => a.name?.trim()).filter((name): name is string => Boolean(name))
    : null;
  return {
    providerId: "core",
    externalId: String(item.id),
    title: item.title?.trim() || null,
    authors: authors && authors.length > 0 ? authors : null,
    publication: item.publisher?.trim() || null,
    year: typeof item.yearPublished === "number" ? item.yearPublished : null,
    doi: item.doi?.trim() || null,
    url: resultUrl(item),
    textAvailable: typeof item.fullText === "string" && item.fullText.trim().length > 0,
    // Out of scope for the metadata-relevance investigation (this provider
    // is not wired into buildProviders() / production use) — left null
    // rather than invented, same convention as providerRelevance above.
    abstract: null,
    querySignalUsed: queryText,
    // CORE v3 does not document a normalized per-result relevance/confidence
    // field in either source consulted (see this file's header comment) —
    // left null rather than invented.
    providerRelevance: null,
  };
}

async function coreRequest<T>(
  path: string,
  init: RequestInit,
  config: CoreProviderConfig,
): Promise<T> {
  const baseUrl = config.baseUrl ?? "https://api.core.ac.uk/v3";
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const fetcher = config.fetcher ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (config.apiKey?.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetcher(url, { ...init, headers, signal: controller.signal });

      if (response.status === 429) {
        throw new AcademicSearchRateLimitError("CORE API rate limit reached (HTTP 429)");
      }
      if (response.status === 401 || response.status === 403) {
        throw new AcademicSearchProviderUnavailableError(`CORE API rejected the request (HTTP ${response.status}) — check CORE_API_KEY`);
      }
      if (response.status >= 500) {
        throw new AcademicSearchProviderUnavailableError(`CORE API returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`CORE API returned HTTP ${response.status}`);
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new Error("CORE API returned malformed JSON");
      }
    } catch (error) {
      if (error instanceof AcademicSearchRateLimitError) throw error;

      const timedOut = controller.signal.aborted || isAbortError(error);
      let classified: unknown = error;
      if (timedOut) {
        classified = new AcademicSearchTimeoutError(`CORE API request timed out after ${config.timeoutMs} ms`);
      } else if (
        !(error instanceof AcademicSearchProviderUnavailableError)
        && !(error instanceof Error && error.message.startsWith("CORE API returned"))
      ) {
        classified = new AcademicSearchProviderUnavailableError(`CORE API network error: ${error instanceof Error ? error.message : String(error)}`);
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
  throw lastError instanceof Error ? lastError : new Error("CORE API request failed");
}

export function createCoreAcademicSearchProvider(config: Partial<CoreProviderConfig> = {}): AcademicSearchProvider {
  const resolved: CoreProviderConfig = { ...DEFAULT_CORE_PROVIDER_CONFIG, ...config, retry: { ...DEFAULT_CORE_PROVIDER_CONFIG.retry, ...config.retry } };

  return {
    id: "core",

    async search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]> {
      const payload = await coreRequest<CoreSearchResponse>(
        "/search/works",
        { method: "POST", body: JSON.stringify({ q: query.queryText, limit: resolved.maxResultsPerRequest, offset: 0 }) },
        resolved,
      );
      const items = Array.isArray(payload.results) ? payload.results : [];
      return items.map((item) => mapCoreWorkItem(item, query.queryText));
    },

    async getMetadata(externalId: string): Promise<Partial<AcademicSearchResult> | null> {
      try {
        const item = await coreRequest<CoreWorkItem>(`/works/${encodeURIComponent(externalId)}`, { method: "GET" }, resolved);
        return mapCoreWorkItem(item, "");
      } catch {
        return null;
      }
    },

    async getText(externalId: string): Promise<string | null> {
      try {
        const item = await coreRequest<CoreWorkItem>(`/works/${encodeURIComponent(externalId)}`, { method: "GET" }, resolved);
        return item.fullText?.trim() || null;
      } catch {
        return null;
      }
    },
  };
}
