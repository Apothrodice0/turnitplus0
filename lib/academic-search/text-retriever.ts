import { createHttpContentRetriever } from "../http-content-retriever";
import {
  createRetrievalTrace,
  retrievalTraceHost,
  type RetrievalStatus,
  type RetrievalTrace,
  type RetrievedSource,
  type SourceContentRetriever,
} from "../retrieval-types";
import type { AcademicSearchProvider } from "./provider";
import type { AcademicProviderTextAttempt, AcademicRetrievalDetail, AcademicRetrievalErrorCategory, AcademicSearchCandidate } from "./types";

/**
 * Phase 5: academic-search's own retriever, distinct from
 * createHttpContentRetriever()'s bare default — enables "application/pdf"
 * alongside the shared default's "text/html". A deliberately scoped,
 * per-caller opt-in rather than widening DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG
 * itself, since that default is also used by lib/source-discovery-registries.ts
 * and lib/retrieval-correspondence-bridge.ts, whose own PDF-handling
 * decision this phase does not make for them. A real, confirmed cause of
 * retrieval failure: many open-access repositories (arXiv, RePEc/MPRA,
 * numerous institutional repositories) serve their canonical full text as
 * PDF only, with no HTML alternative — see this phase's own final report.
 *
 * Coverage benchmark (2026-08-21): the shared default's 2,000,000-byte
 * maxResponseBytes rejected the real, ordinary "Attention Is All You Need"
 * arXiv PDF (2,215,244 bytes — nothing unusual for a paper with figures) as
 * CONTENT_TOO_LARGE, confirmed live via retrieveCandidateText() on the real
 * ranked-#1 candidate — see tests/http-content-retriever.test.mjs's own
 * "REAL PDFJS" test, which already had to work around this exact 2.2MB
 * fixture exceeding the 2MB default. Raised here, scoped to this retriever
 * only — the shared DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG (and every other
 * caller of createHttpContentRetriever()) is untouched. 10,000,000 bytes is
 * a bounded, not-unlimited step: comfortably above ordinary academic PDFs
 * (this fixture's 2.2MB is typical; even a longer, heavily-figured paper
 * rarely exceeds a few MB) while remaining well inside the range this
 * codebase's own test suite already asserts as "conservative" for the
 * shared default's own upper bound (see http-content-retriever.test.mjs's
 * "DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG bounds are conservative" test,
 * <= 10_000_000). maxPdfPages (unchanged, still 60) independently bounds a
 * pathologically page-dense PDF regardless of this byte cap.
 */
export function createAcademicSearchContentRetriever(): SourceContentRetriever {
  return createHttpContentRetriever({ allowedContentTypes: ["text/html", "application/pdf"], maxResponseBytes: 10_000_000 });
}

/**
 * Stage 6 of the pipeline: obtains whatever text is available for a ranked
 * candidate. Tries the cheapest path first — asking the contributing
 * provider(s) directly via getText(), which for a provider like CORE can
 * mean an already-extracted fullText field with no extra network hop — and
 * only falls back to fetching the candidate's own URL when no provider
 * could supply text. The HTTP fallback reuses lib/http-content-retriever.ts
 * as-is (SSRF-safe, timeout-bounded, size-capped) rather than reimplementing
 * retrieval; see this directory's types.ts header comment.
 *
 * Never throws: a provider's getText() failing, or the HTTP fallback
 * returning any non-SUCCESS lib/retrieval-types.ts status, both resolve to
 * `text: null` / `source: "unavailable"` rather than propagating — text
 * unavailability is a normal, expected outcome (STEP 7's "unavailable full
 * text" case), not a pipeline failure.
 */

export type TextRetrievalResult = {
  text: string | null;
  source: "provider" | "http-fallback" | "unavailable";
  /** Which provider actually supplied the text, when source is "provider". */
  providerId: string | null;
  latencyMs: number;
  /** Only set when source is "http-fallback" or the fallback was attempted and failed. */
  httpRetrievalStatus?: RetrievalStatus;
  /** Retrieval diagnostics v1 — observability only, never read by comparison or scoring (see AcademicRetrievalDetail). */
  detail: AcademicRetrievalDetail;
};

const MAX_RECORDED_PROVIDER_TEXT_ATTEMPTS = 8;
const MAX_RECORDED_HOPS = 12;

/** Closed-vocabulary reason a non-SUCCESS HTTP fallback produced no text. */
function httpErrorCategory(retrieved: RetrievedSource, trace: RetrievalTrace): AcademicRetrievalErrorCategory {
  const code = retrieved.httpStatus;
  switch (retrieved.status) {
    case "HTTP_ERROR":
      if (code !== null && code >= 300 && code <= 399) return "HTTP_3XX_NO_LOCATION";
      if (code === 401) return "HTTP_401_UNAUTHORIZED";
      if (code === 403) return "HTTP_403_FORBIDDEN";
      if (code === 404) return "HTTP_404_NOT_FOUND";
      if (code === 429) return "HTTP_429_RATE_LIMITED";
      if (code !== null && code >= 500 && code <= 599) return "HTTP_5XX_SERVER_ERROR";
      if (code !== null && code >= 400 && code <= 499) return "HTTP_4XX_OTHER";
      return "HTTP_OTHER";
    case "TIMEOUT":
      return "TIMEOUT";
    case "NETWORK_ERROR":
      return "NETWORK_ERROR";
    case "REDIRECT_BLOCKED": {
      if (trace.redirectFailure === "LIMIT_EXCEEDED") return "REDIRECT_LIMIT_EXCEEDED";
      if (trace.redirectFailure === "UNRESOLVABLE_LOCATION") return "REDIRECT_LOCATION_INVALID";
      if (trace.failureStage === "SAFETY_CHECK") {
        const failedHop = trace.hops[trace.hops.length - 1];
        return failedHop && failedHop.kind !== "initial" ? "UNSAFE_REDIRECT_TARGET" : "UNSAFE_URL";
      }
      return "REDIRECT_BLOCKED";
    }
    case "UNSUPPORTED_CONTENT_TYPE":
    case "CONTENT_TOO_LARGE":
    case "NO_CONTENT":
    case "MALFORMED_CONTENT":
    case "EXTRACTION_FAILED":
      return retrieved.status;
    case "SUCCESS":
      return "NO_CONTENT"; // SUCCESS without text — the shared retriever never returns this; defensive only
  }
}

function emptyDetail(providerTextAttempts: AcademicProviderTextAttempt[], providerTextAttemptCount: number): AcademicRetrievalDetail {
  return {
    providerTextAttempts,
    providerTextAttemptCount,
    httpFallbackAttempted: false,
    attemptedHost: null,
    finalHost: null,
    httpStatusCode: null,
    errorCategory: null,
    failureStage: null,
    redirectCount: 0,
    citationPdfFollowed: false,
    hops: [],
    networkErrorCode: null,
    safetyFailure: null,
  };
}

function httpFallbackDetail(
  candidateUrl: string,
  retrieved: RetrievedSource,
  trace: RetrievalTrace,
  succeeded: boolean,
  providerTextAttempts: AcademicProviderTextAttempt[],
  providerTextAttemptCount: number,
): AcademicRetrievalDetail {
  // A retriever that ignores the trace (e.g. a test double) leaves hops empty; RetrievedSource still gives the
  // final URL and status, so the detail stays meaningful either way.
  const hops = trace.hops.slice(0, MAX_RECORDED_HOPS).map((hop) => ({ ...hop }));
  return {
    providerTextAttempts,
    providerTextAttemptCount,
    httpFallbackAttempted: true,
    attemptedHost: retrievalTraceHost(candidateUrl),
    finalHost: retrievalTraceHost(retrieved.finalUrl) ?? hops[hops.length - 1]?.host ?? null,
    httpStatusCode: retrieved.httpStatus,
    errorCategory: succeeded ? null : httpErrorCategory(retrieved, trace),
    failureStage: succeeded ? null : trace.failureStage,
    redirectCount: trace.hops.filter((hop) => hop.kind === "redirect").length,
    citationPdfFollowed: trace.hops.some((hop) => hop.kind === "citation_pdf"),
    hops,
    networkErrorCode: trace.networkErrorCode,
    safetyFailure: trace.safetyFailure,
  };
}

export async function retrieveCandidateText(
  candidate: AcademicSearchCandidate,
  providers: Record<string, AcademicSearchProvider>,
  contentRetriever: SourceContentRetriever = createAcademicSearchContentRetriever(),
): Promise<TextRetrievalResult> {
  const start = Date.now();
  // Diagnostics only: recording an attempt never changes which providers are asked, in what order, or what is returned.
  const providerTextAttempts: AcademicProviderTextAttempt[] = [];
  let providerTextAttemptCount = 0;
  const recordAttempt = (providerId: string, outcome: AcademicProviderTextAttempt["outcome"]) => {
    providerTextAttemptCount += 1;
    if (providerTextAttempts.length < MAX_RECORDED_PROVIDER_TEXT_ATTEMPTS) providerTextAttempts.push({ providerId, outcome });
  };

  for (const contributor of candidate.contributors) {
    const provider = providers[contributor.providerId];
    if (!provider?.getText) continue;
    let outcome: AcademicProviderTextAttempt["outcome"] = "NO_TEXT";
    try {
      const text = await provider.getText(contributor.externalId);
      if (text && text.trim()) {
        recordAttempt(contributor.providerId, "TEXT");
        return { text, source: "provider", providerId: contributor.providerId, latencyMs: Date.now() - start, detail: emptyDetail(providerTextAttempts, providerTextAttemptCount) };
      }
    } catch {
      // Not fatal: fall through to the next contributing provider, or the HTTP fallback below.
      outcome = "ERROR";
    }
    recordAttempt(contributor.providerId, outcome);
  }

  if (candidate.url) {
    const trace = createRetrievalTrace();
    const retrieved = await contentRetriever.retrieve({ url: candidate.url, trace });
    if (retrieved.status === "SUCCESS" && retrieved.extractedText) {
      return {
        text: retrieved.extractedText,
        source: "http-fallback",
        providerId: null,
        latencyMs: Date.now() - start,
        httpRetrievalStatus: retrieved.status,
        detail: httpFallbackDetail(candidate.url, retrieved, trace, true, providerTextAttempts, providerTextAttemptCount),
      };
    }
    return {
      text: null,
      source: "unavailable",
      providerId: null,
      latencyMs: Date.now() - start,
      httpRetrievalStatus: retrieved.status,
      detail: httpFallbackDetail(candidate.url, retrieved, trace, false, providerTextAttempts, providerTextAttemptCount),
    };
  }

  return {
    text: null,
    source: "unavailable",
    providerId: null,
    latencyMs: Date.now() - start,
    detail: { ...emptyDetail(providerTextAttempts, providerTextAttemptCount), errorCategory: "NO_TEXT_SOURCE" },
  };
}
