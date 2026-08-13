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

export type SourceContentRetrieverRequest = {
  url: string;
};

export interface SourceContentRetriever {
  id: string;
  retrieve(request: SourceContentRetrieverRequest): Promise<RetrievedSource>;
}
