import type { DiscoveryProviderRequest, SourceDiscoveryProvider } from "./discovery-providers";
import { DiscoveryTimeoutError, DiscoveryRateLimitError, DiscoveryProviderUnavailableError } from "./discovery-providers";
import type { RawProviderResult } from "./discovery-types";
import type { SourceClass } from "./source-class";

/**
 * Phase E6B: the first real (network-capable) discovery provider, backed by
 * the Crossref REST API's /works endpoint. Server-side only — nothing here
 * is imported by app/page.tsx or any client component (see
 * tests/discovery-crossref-provider.test.mjs's structural check).
 *
 * Confirmed against official Crossref documentation before writing this
 * file (github.com/CrossRef/rest-api-doc, crossref.org/documentation), not
 * guessed — see this phase's final report for the exact findings. Key
 * facts this implementation depends on:
 *  - Endpoint: https://api.crossref.org/works
 *  - `query.bibliographic` is the recommended field query "for citation
 *    lookup" — exactly this provider's use case — and, unlike `query.title`,
 *    is NOT deprecated.
 *  - No API key is required for public or "polite pool" access. Only the
 *    paid Metadata Plus tier needs one, which this provider does not use —
 *    see this file's own header comment on CrossrefProviderConfig for why
 *    no key/secret is ever read or required here.
 *  - The polite pool (better, more consistent rate limits) is entered by
 *    supplying a `mailto` query parameter or a User-Agent containing
 *    `mailto:` — this provider uses the `mailto` query parameter, since it
 *    requires no fabricated project URL.
 *  - Rate limits are advertised via the `x-rate-limit-limit`/
 *    `x-rate-limit-interval` response headers; exceeding them returns HTTP
 *    429. Crossref's own guidance is to back off and avoid tight retry
 *    loops — this provider never automatically retries a 429 (see
 *    DEFAULT_CROSSREF_PROVIDER_CONFIG's retry comment).
 *  - `message.items[]` fields actually used here (verified against a real
 *    response, not assumed): DOI, title (an ARRAY of strings), author
 *    (an array of {given, family, ...}), publisher, container-title (an
 *    array), type, URL, score, and one of published-print/published-online
 *    /issued/published (each `{ "date-parts": [[y, m, d]] }`).
 *
 * A Crossref result is discovery evidence, never verification. This
 * provider's discover() only ever returns RawProviderResult[] — it never
 * imports, and structurally cannot call, lib/provenance-verification-
 * workflow.ts's approveVerification or lib/provenance-registry.ts's
 * transitionProvenanceState. See CASE I in
 * tests/discovery-crossref-provider.test.mjs.
 */

export type CrossrefRetryConfig = {
  /** Total attempts for a single query (1 = no retry). Never applied to a 429 — see this file's header comment. */
  maxAttempts: number;
  /** Fixed delay between attempts — deliberately not exponential backoff, per this phase's own "start conservatively, no complex retry system" instruction. */
  baseDelayMs: number;
};

export type CrossrefProviderConfig = {
  /**
   * Optional contact email for Crossref's polite pool. Read from the
   * environment by whatever *calls* this module (matching
   * lib/openalex-check.ts's existing OPENALEX_MAILTO convention) — this
   * file itself never reads process.env, so it stays trivially testable
   * and has no implicit environment coupling. No API key field exists here
   * at all: Crossref's public/polite pool requires none, and inventing one
   * would be exactly the unfounded credential this phase was told not to
   * add.
   */
  contactEmail?: string;
  /** Hard cap on the number of actual Crossref HTTP requests made per discover() call — bounded independently of how many queries E6A generated. */
  maxRequestsPerRun: number;
  /** Crossref's `rows` parameter — how many candidate works to request per query. */
  maxResultsPerRequest: number;
  timeoutMs: number;
  retry: CrossrefRetryConfig;
  /** Injectable for tests — never defaults to a live call in a test context; see tests/discovery-crossref-provider.test.mjs. */
  fetcher?: typeof fetch;
  /** Overridable only for tests; production code should never need to change this. */
  baseUrl?: string;
};

export const DEFAULT_CROSSREF_PROVIDER_CONFIG: CrossrefProviderConfig = {
  maxRequestsPerRun: 3,
  maxResultsPerRequest: 5,
  timeoutMs: 8_000,
  retry: { maxAttempts: 2, baseDelayMs: 500 },
};

type CrossrefDateParts = { "date-parts"?: Array<Array<number>> };

type CrossrefAuthor = { given?: string; family?: string };

type CrossrefWorkItem = {
  DOI?: string;
  URL?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  publisher?: string;
  "container-title"?: string[];
  type?: string;
  score?: number;
  "published-print"?: CrossrefDateParts;
  "published-online"?: CrossrefDateParts;
  issued?: CrossrefDateParts;
  published?: CrossrefDateParts;
};

type CrossrefWorksResponse = {
  status?: string;
  "message-type"?: string;
  message?: {
    items?: CrossrefWorkItem[];
  };
};

/**
 * Only `journal-article`-family Crossref types are mapped to
 * JOURNAL_PUBLISHER — the one case this provider can be confident about.
 * Everything else Crossref returns (book chapters, preprints/posted-content,
 * dissertations, reports, datasets, peer reviews, standards, and any type
 * not listed here) maps to UNKNOWN, per this phase's own instruction:
 * "If the current model cannot safely distinguish it, use the safest
 * existing category and document the limitation." This is a deliberate,
 * conservative choice, not a parsing gap — Crossref's `type` taxonomy is
 * much richer than lib/source-class.ts's vocabulary, and guessing a more
 * specific mapping for, say, "posted-content" (which could be a preprint
 * hosted anywhere) would be exactly the invented-confidence this whole
 * provenance system exists to avoid.
 */
const JOURNAL_TYPES = new Set(["journal-article", "journal-issue", "journal-volume", "proceedings-article"]);

function mapCrossrefTypeToSourceClass(type: string | undefined): SourceClass {
  if (type && JOURNAL_TYPES.has(type)) return "JOURNAL_PUBLISHER";
  return "UNKNOWN";
}

function formatAuthors(authors: CrossrefAuthor[] | undefined): string | null {
  if (!Array.isArray(authors) || authors.length === 0) return null;
  const names = authors
    .map((a) => [a.given, a.family].filter(Boolean).join(" ").trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;
  const shown = names.slice(0, 5);
  const suffix = names.length > 5 ? " et al." : "";
  return shown.join("; ") + suffix;
}

function formatDateParts(parts: CrossrefDateParts | undefined): string | null {
  const dateParts = parts?.["date-parts"]?.[0];
  if (!Array.isArray(dateParts) || dateParts.length === 0 || typeof dateParts[0] !== "number") return null;
  // The year is never padded (always 4 digits already); month/day are
  // zero-padded to 2 digits, matching ISO-8601 date-prefix formatting.
  const [year, ...rest] = dateParts;
  return [String(year), ...rest.map((n) => String(n).padStart(2, "0"))].join("-");
}

function firstPublicationDate(item: CrossrefWorkItem): string | null {
  return (
    formatDateParts(item["published-print"])
    ?? formatDateParts(item["published-online"])
    ?? formatDateParts(item.issued)
    ?? formatDateParts(item.published)
  );
}

function resultUrl(item: CrossrefWorkItem): string | null {
  if (item.URL && item.URL.trim()) return item.URL.trim();
  if (item.DOI && item.DOI.trim()) return `https://doi.org/${item.DOI.trim()}`;
  return null;
}

/**
 * Crossref's `score` is an unbounded, query-relative Lucene-style ranking
 * value — NOT a 0..1 confidence, and never "provenance confidence" (this
 * phase's own instruction). Normalized here to 0..1 by dividing by the
 * highest score seen in the same response, so it is at least internally
 * comparable within one query's results before lib/discovery-candidates.ts
 * clamps and weighs it alongside every other provider's signal.
 */
function normalizedConfidence(item: CrossrefWorkItem, maxScoreInResponse: number): number | null {
  if (typeof item.score !== "number" || !Number.isFinite(item.score) || maxScoreInResponse <= 0) return null;
  return Math.max(0, Math.min(1, item.score / maxScoreInResponse));
}

function mapCrossrefItem(item: CrossrefWorkItem, querySignalUsed: string, maxScoreInResponse: number, discoveredAt: string): RawProviderResult {
  return {
    providerResultId: item.DOI ?? null,
    url: resultUrl(item),
    externalIdentifier: item.DOI ?? null,
    externalIdentifierType: item.DOI ? "DOI" : null,
    title: Array.isArray(item.title) && item.title.length > 0 ? item.title[0] : null,
    author: formatAuthors(item.author),
    publisher: item.publisher ?? (Array.isArray(item["container-title"]) ? item["container-title"][0] ?? null : null),
    publicationDate: firstPublicationDate(item),
    sourceClass: mapCrossrefTypeToSourceClass(item.type),
    providerConfidence: normalizedConfidence(item, maxScoreInResponse),
    querySignalUsed,
    discoveredAt,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchCrossrefWorks(
  queryText: string,
  config: CrossrefProviderConfig,
): Promise<RawProviderResult[]> {
  const fetcher = config.fetcher ?? fetch;
  const baseUrl = config.baseUrl ?? "https://api.crossref.org/works";
  const url = new URL(baseUrl);
  url.searchParams.set("query.bibliographic", queryText);
  url.searchParams.set("rows", String(config.maxResultsPerRequest));
  if (config.contactEmail?.trim()) url.searchParams.set("mailto", config.contactEmail.trim());

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        headers: { "User-Agent": "TurnitPlus-Discovery/1.0 (source discovery provider)" },
      });

      if (response.status === 429) {
        // Never retried automatically — Crossref's own guidance is to back
        // off, not to hammer a rate-limited endpoint (this phase's own
        // instruction, section 15).
        throw new DiscoveryRateLimitError("Crossref rate limit reached (HTTP 429)");
      }
      if (response.status >= 500) {
        throw new DiscoveryProviderUnavailableError(`Crossref returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        // 400/401/403/404 and any other non-2xx, non-429, non-5xx status —
        // a request-shape or resource problem, not "the provider is down."
        // Never retried: an identical request will fail identically.
        throw new Error(`Crossref returned HTTP ${response.status}`);
      }

      let payload: CrossrefWorksResponse;
      try {
        payload = (await response.json()) as CrossrefWorksResponse;
      } catch {
        throw new Error("Crossref returned malformed JSON");
      }
      const items = payload.message?.items;
      if (!Array.isArray(items)) {
        throw new Error("Crossref returned an unexpected response shape (message.items missing)");
      }

      const discoveredAt = new Date().toISOString();
      const maxScore = items.reduce((max, item) => (typeof item.score === "number" && item.score > max ? item.score : max), 0);
      return items.map((item) => mapCrossrefItem(item, queryText, maxScore, discoveredAt));
    } catch (error) {
      if (error instanceof DiscoveryRateLimitError) throw error; // never retried, propagate immediately

      const timedOut = controller.signal.aborted || isAbortError(error);
      let classified: unknown = error;
      if (timedOut) {
        classified = new DiscoveryTimeoutError(`Crossref request timed out after ${config.timeoutMs} ms`);
      } else if (
        !(error instanceof DiscoveryProviderUnavailableError)
        && !(error instanceof Error && error.message.startsWith("Crossref returned"))
      ) {
        // fetch() itself rejected before any HTTP response existed at all
        // (DNS failure, connection refused, TLS error) — a genuine
        // network-level failure, treated the same as "provider unavailable."
        classified = new DiscoveryProviderUnavailableError(`Crossref network error: ${error instanceof Error ? error.message : String(error)}`);
      }
      lastError = classified;

      // Only timeout/unavailable are worth retrying — a 4xx or a malformed
      // response will fail the exact same way again.
      const retryable = classified instanceof DiscoveryTimeoutError || classified instanceof DiscoveryProviderUnavailableError;
      if (retryable && attempt < config.retry.maxAttempts) {
        if (config.retry.baseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.retry.baseDelayMs));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
  // Unreachable (the loop always returns or throws), but keeps TS satisfied.
  throw lastError instanceof Error ? lastError : new Error("Crossref request failed");
}

/**
 * Builds the real Crossref-backed SourceDiscoveryProvider. Consumes only
 * the already-bounded queries E6A generated (lib/discovery-query-generation.ts)
 * — never raw document text, never account/user identity (neither is even
 * part of DiscoveryProviderRequest's shape). Queries are already ranked by
 * lib/discovery-query-generation.ts (distinctive passages first); this
 * provider takes the top `config.maxRequestsPerRun` of them as-is, never
 * re-ranking or expanding the set.
 *
 * One query hitting a rate limit or timing out stops the whole discover()
 * call immediately (no further Crossref requests this run) — a
 * single bad/malformed response from one query does not abort the others.
 * If every attempted query fails, the failure (rate limit, timeout, or the
 * first other error encountered) propagates to the caller so
 * lib/discovery-orchestrator.ts records an honest failed attempt rather
 * than a misleading empty success.
 */
export function createCrossrefDiscoveryProvider(config: Partial<CrossrefProviderConfig> = {}): SourceDiscoveryProvider {
  const resolvedConfig: CrossrefProviderConfig = { ...DEFAULT_CROSSREF_PROVIDER_CONFIG, ...config, retry: { ...DEFAULT_CROSSREF_PROVIDER_CONFIG.retry, ...config.retry } };

  return {
    id: "crossref",
    type: "ACADEMIC_INDEX",
    async discover(request: DiscoveryProviderRequest): Promise<RawProviderResult[]> {
      const queries = request.queries.slice(0, resolvedConfig.maxRequestsPerRun);
      const collected: RawProviderResult[] = [];
      let firstNonHaltingError: unknown = null;
      let attemptedAny = false;

      for (const query of queries) {
        attemptedAny = true;
        try {
          const results = await fetchCrossrefWorks(query.queryText, resolvedConfig);
          collected.push(...results);
        } catch (error) {
          if (error instanceof DiscoveryRateLimitError || error instanceof DiscoveryTimeoutError) {
            if (collected.length > 0) return collected;
            throw error;
          }
          if (!firstNonHaltingError) firstNonHaltingError = error;
        }
      }

      if (collected.length === 0 && attemptedAny && firstNonHaltingError) throw firstNonHaltingError;
      return collected;
    },
  };
}
