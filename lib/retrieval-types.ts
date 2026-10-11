/**
 * Phase E6C: retrieval vocabulary and shapes — separate from
 * lib/discovery-types.ts (E6A) and lib/discovery-providers.ts's
 * SourceDiscoveryProvider on purpose. Discovery answers "does a candidate
 * exist"; retrieval answers "what does that candidate actually contain."
 * Combining the two interfaces would blur exactly the distinction this
 * phase exists to preserve — see this phase's own task description,
 * section 2.
 */

export const RETRIEVAL_STATUSES = [
  "SUCCESS",
  "TIMEOUT",
  "NETWORK_ERROR",
  "HTTP_ERROR",
  "REDIRECT_BLOCKED",
  "CONTENT_TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "MALFORMED_CONTENT",
  "EXTRACTION_FAILED",
  "NO_CONTENT",
] as const;

export type RetrievalStatus = (typeof RETRIEVAL_STATUSES)[number];

const RETRIEVAL_STATUS_SET: ReadonlySet<string> = new Set(RETRIEVAL_STATUSES);

export function isRetrievalStatus(value: unknown): value is RetrievalStatus {
  return typeof value === "string" && RETRIEVAL_STATUS_SET.has(value);
}

/**
 * What a retrieval attempt produced. Only `SUCCESS` carries a non-null
 * extractedText/canonicalSha256 — every other status means "we did not
 * obtain usable content," which is a fact about the attempt, never treated
 * as "the source does not exist" (this phase's own task description,
 * section 11).
 */
export type RetrievedSource = {
  originalUrl: string;
  /** The URL actually fetched, after following any (validated) redirects. Null if retrieval never got a request off. */
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  retrievedAt: string;
  /** SHA-256 of the raw response bytes actually received (post byte-limit enforcement), before any extraction. */
  rawSha256: string | null;
  /** Extracted, human-readable text — kept in memory for the correspondence engine to consume; see lib/retrieval-repository.ts for what (if anything) is actually persisted. */
  extractedText: string | null;
  /** SHA-256 of canonicalizeText(extractedText) — comparable against a submission's own canonical hash (lib/document-identity.ts). */
  canonicalSha256: string | null;
  extractorVersion: string | null;
  status: RetrievalStatus;
  errorMessage: string | null;
};

/**
 * Retrieval trace (academic-search retrieval diagnostics, 2026-10-11): an optional, caller-owned sink for ONE retrieve()
 * call. A retriever that supports it fills it in as it goes and never reads it back, so passing one cannot change which
 * URL is fetched, how often, or what is returned. It holds hosts, HTTP status codes and closed-vocabulary categories
 * only — never a path, query string, header, cookie, body, resolved IP address or free-text error message.
 */
export type RetrievalTraceHop = {
  /** "initial" = the requested URL; "redirect" = an HTTP 3xx Location target; "citation_pdf" = a landing page's citation_pdf_url. */
  kind: "initial" | "redirect" | "citation_pdf";
  /** The URL's host (hostname[:port]); null if it could not be parsed. */
  host: string | null;
  /** The status this hop answered with; null when no response arrived (safety refusal, timeout, network error). */
  httpStatus: number | null;
};

/** Where a failed retrieve() stopped. */
export type RetrievalFailureStage = "SAFETY_CHECK" | "REQUEST" | "REDIRECT" | "RESPONSE_STATUS" | "CONTENT_TYPE" | "BODY" | "PARSE" | "EXTRACTION";

/** lib/retrieval-safety.ts refusals as a closed vocabulary (its free-text reason can carry hostnames and resolved IPs). */
export type RetrievalSafetyFailure = "MALFORMED_URL" | "DISALLOWED_PROTOCOL" | "EMBEDDED_CREDENTIALS" | "NO_HOSTNAME" | "DENIED_HOSTNAME" | "BLOCKED_ADDRESS" | "DNS_FAILED" | "DNS_NO_ADDRESSES" | "OTHER";

export type RetrievalRedirectFailure = "NO_LOCATION" | "LIMIT_EXCEEDED" | "UNRESOLVABLE_LOCATION";

export type RetrievalTrace = {
  hops: RetrievalTraceHop[];
  failureStage: RetrievalFailureStage | null;
  safetyFailure: RetrievalSafetyFailure | null;
  redirectFailure: RetrievalRedirectFailure | null;
  /** A system error code (ECONNRESET, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, ...) — only ever a bare upper-case token. */
  networkErrorCode: string | null;
};

export function createRetrievalTrace(): RetrievalTrace {
  return { hops: [], failureStage: null, safetyFailure: null, redirectFailure: null, networkErrorCode: null };
}

/** hostname[:port] of a URL — never its path, query string or embedded credentials. */
export function retrievalTraceHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export type SourceContentRetrieverRequest = {
  url: string;
  /** Optional observability sink — see RetrievalTrace. Retrievers that do not support it simply ignore it. */
  trace?: RetrievalTrace;
};

export interface SourceContentRetriever {
  id: string;
  retrieve(request: SourceContentRetrieverRequest): Promise<RetrievedSource>;
}
