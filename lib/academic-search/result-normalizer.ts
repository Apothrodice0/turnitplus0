import type { AcademicSearchResult, NormalizedAcademicResult } from "./types";

/**
 * Stage 3 of the pipeline: pure normalization of whatever a provider handed
 * back, for comparison/dedup purposes only — the original provider-supplied
 * values are always preserved unchanged alongside the computed dedupKey
 * (same "normalize for comparison, never destructively" rule
 * lib/discovery-normalization.ts follows for the existing discovery
 * pipeline; this is an independent implementation, not a reuse of it, so
 * this subsystem has no import-time dependency on the discovery-* family).
 */

function normalizeDoi(rawDoi: string | null | undefined): string | null {
  if (!rawDoi || !rawDoi.trim()) return null;
  return rawDoi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
}

/** Canonicalizes a URL for comparison: lowercases the host, drops the fragment, and removes a single trailing slash on a non-root path. Returns null for anything that isn't a parseable http(s) URL — malformed input is expected, not an error. */
export function normalizeUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || !rawUrl.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function buildDedupKey(result: AcademicSearchResult, normalizedDoi: string | null, normalizedUrl: string | null): string {
  if (normalizedDoi) return `doi:${normalizedDoi}`;
  if (normalizedUrl) return `url:${normalizedUrl}`;
  return `provider:${result.providerId}:${result.externalId}`;
}

/** Normalizes a single raw provider result. Never throws — a malformed field is simply treated as absent. */
export function normalizeAcademicResult(result: AcademicSearchResult): NormalizedAcademicResult {
  const doi = normalizeDoi(result.doi);
  const url = normalizeUrl(result.url);
  return {
    ...result,
    doi,
    url,
    title: result.title?.trim() || null,
    authors: result.authors && result.authors.length > 0 ? result.authors.map((a) => a.trim()).filter(Boolean) : null,
    publication: result.publication?.trim() || null,
    dedupKey: buildDedupKey(result, doi, url),
  };
}

export function normalizeAcademicResults(results: AcademicSearchResult[]): NormalizedAcademicResult[] {
  return results.map(normalizeAcademicResult);
}
