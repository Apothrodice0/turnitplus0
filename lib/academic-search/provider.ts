import type { AcademicSearchProviderError, AcademicSearchQuery, AcademicSearchResult } from "./types";

/**
 * The provider abstraction itself — see types.ts's header comment for why
 * this is a distinct shape from lib/discovery-providers.ts's
 * SourceDiscoveryProvider rather than a reuse of it.
 *
 * A provider implementation:
 *  - search(query) is the only stage the orchestrator calls once per
 *    extracted phrase (bounded to ~5-20 calls per submission by
 *    phrase-extractor.ts). Must resolve, never throw for expected failure
 *    modes — see the *Error classes below, which a provider should throw
 *    instead so orchestrator.ts can classify and continue with the next
 *    query rather than aborting the whole run (STEP 8: "provider failure
 *    does NOT break normal TurnitPlus reports").
 *  - getMetadata(id) is optional — a provider that has nothing beyond what
 *    search() already returned can omit it entirely.
 *  - getText(id) is optional — a provider with no full-text access at all
 *    (e.g. an index that only ever returns metadata) can omit it; the
 *    orchestrator falls back to fetching result.url via TextRetriever
 *    instead, and if neither is possible the candidate is simply reported
 *    with textAvailable: false.
 */
export interface AcademicSearchProvider {
  id: string;
  search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]>;
  getMetadata?(externalId: string): Promise<Partial<AcademicSearchResult> | null>;
  getText?(externalId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Error classes — mirrors lib/discovery-providers.ts's DiscoveryTimeoutError
// family (name-based classification, not message-sniffing), independently
// defined here so this subsystem never imports discovery-providers.ts.
// ---------------------------------------------------------------------------

export class AcademicSearchTimeoutError extends Error {
  constructor(message = "academic search provider timed out") {
    super(message);
    this.name = "AcademicSearchTimeoutError";
  }
}

export class AcademicSearchRateLimitError extends Error {
  constructor(message = "academic search provider rate limit exceeded") {
    super(message);
    this.name = "AcademicSearchRateLimitError";
  }
}

export class AcademicSearchProviderUnavailableError extends Error {
  constructor(message = "academic search provider unavailable") {
    super(message);
    this.name = "AcademicSearchProviderUnavailableError";
  }
}

export function classifyAcademicSearchError(providerId: string, error: unknown): AcademicSearchProviderError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const kind: AcademicSearchProviderError["kind"] =
    name === "AcademicSearchTimeoutError" ? "TIMEOUT"
    : name === "AcademicSearchRateLimitError" ? "RATE_LIMITED"
    : name === "AcademicSearchProviderUnavailableError" ? "UNAVAILABLE"
    : "ERROR";
  return { providerId, kind, message };
}

/**
 * A minimal, defensive check on what a provider's search() returned. Mirrors
 * lib/discovery-providers.ts's isUsableProviderResult: a "malformed result"
 * here means the entry carries no identifying information at all (no
 * externalId, no url, no title) — dropped rather than raised as an error,
 * since a bad/empty individual result is a normal, expected outcome to
 * handle gracefully.
 */
export function isUsableAcademicSearchResult(result: unknown): result is AcademicSearchResult {
  if (!result || typeof result !== "object") return false;
  const candidate = result as Partial<AcademicSearchResult>;
  if (typeof candidate.providerId !== "string" || !candidate.providerId) return false;
  if (typeof candidate.externalId !== "string" || !candidate.externalId) return false;
  const hasUrl = typeof candidate.url === "string" && candidate.url.trim().length > 0;
  const hasTitle = typeof candidate.title === "string" && candidate.title.trim().length > 0;
  const hasDoi = typeof candidate.doi === "string" && candidate.doi.trim().length > 0;
  return hasUrl || hasTitle || hasDoi;
}

/** Filters a raw, possibly-malformed provider response down to usable results — never throws on bad input. */
export function sanitizeAcademicSearchResults(results: unknown[]): AcademicSearchResult[] {
  if (!Array.isArray(results)) return [];
  return results.filter(isUsableAcademicSearchResult);
}
