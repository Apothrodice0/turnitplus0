import { normalize } from "./similarity-core";

/**
 * Phase E6A: deterministic normalization of provider-supplied candidate
 * data. Every function here is pure and safe on malformed input — never
 * throws, never guesses at a "fixed" destination for something that isn't
 * parseable. Per this phase's own task description, section 8: normalize
 * for *comparison*, never destructively — the original provider-supplied
 * value must always be preserved unchanged alongside whatever this module
 * computes (see lib/discovery-types.ts's RawProviderResult.url vs
 * DiscoveryCandidate.canonicalUrl/originalUrls).
 */

/** A conservative, explicit allowlist only — never a guess at what "looks like" tracking. Extend deliberately, do not infer. */
const KNOWN_TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
]);

/**
 * Returns a canonicalized URL for comparison/deduplication, or null if the
 * input is missing or not parseable as a URL — malformed input is a normal,
 * expected case (Phase E6A section 13), not an error. Never returns a URL
 * pointing anywhere the original didn't: only the hash fragment (which by
 * definition cannot change which resource is fetched) and known tracking
 * parameters are stripped, host casing is lowercased, and a single trailing
 * slash on a non-root path is removed — all reversible, meaning-preserving
 * normalizations, never a guess at "the real" URL.
 */
export function normalizeUrlForDiscovery(rawUrl: string | null | undefined): string | null {
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
  for (const param of [...parsed.searchParams.keys()]) {
    if (KNOWN_TRACKING_PARAMS.has(param.toLowerCase())) parsed.searchParams.delete(param);
  }
  // URLSearchParams re-serializes deterministically but re-orders nothing on
  // its own; sort remaining params for a stable comparison key regardless of
  // the order a provider happened to supply them in.
  const sortedParams = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  parsed.search = "";
  for (const [key, value] of sortedParams) parsed.searchParams.append(key, value);

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

/**
 * Normalizes a stable external identifier for comparison. DOIs are the one
 * concrete case this phase has a real rule for (case-insensitive, and
 * sometimes supplied as a full doi.org URL rather than a bare identifier —
 * both forms must dedupe to the same key); every other identifier type is
 * only trimmed, never reinterpreted, since guessing a normalization rule
 * for an identifier scheme this phase doesn't actually understand would
 * risk silently merging two different sources.
 */
export function normalizeExternalIdentifier(type: string | null | undefined, rawValue: string | null | undefined): string | null {
  if (!rawValue || !rawValue.trim()) return null;
  const trimmed = rawValue.trim();
  const looksLikeDoi = /^10\.\d{4,9}\//.test(trimmed) || /^https?:\/\/(dx\.)?doi\.org\//i.test(trimmed);
  if (type?.toUpperCase() === "DOI" || looksLikeDoi) {
    return trimmed.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
  }
  return trimmed;
}

/** Normalizes title text for candidate-ranking comparison only (lib/discovery-candidates.ts) — reuses lib/similarity-core.ts's existing normalize(), the same primitive lib/discovery-signals.ts uses, so "the same title" is judged consistently everywhere in this phase. */
export function normalizeTitleForComparison(title: string | null | undefined): string | null {
  if (!title || !title.trim()) return null;
  const normalized = normalize(title);
  return normalized || null;
}
