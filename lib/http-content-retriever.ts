import { createHash } from "node:crypto";
import { canonicalSha256 } from "./document-identity";
import { extractTextFromHtml, HTML_EXTRACTOR_VERSION } from "./html-text-extraction";
import {
  DEFAULT_RETRIEVAL_SAFETY_CONFIG,
  validateUrlForRetrieval,
  type DnsLookupFn,
  type RetrievalSafetyConfig,
} from "./retrieval-safety";
import type { RetrievalStatus, RetrievedSource, SourceContentRetriever } from "./retrieval-types";

/**
 * Phase E6C: the first real (network-capable) SourceContentRetriever.
 * Retrieves a single publicly-accessible HTML page over HTTP(S) — no
 * authentication, no CAPTCHA/anti-bot handling, no PDF extraction (no safe
 * reusable server-side PDF extractor exists in this project — pdfjs-dist is
 * only ever used client-side/in offline tools/, never in lib/ — see this
 * phase's own task description, section 7, which explicitly permits
 * omitting PDF support on that basis).
 *
 * Redirects are followed MANUALLY, one hop at a time (`fetch(..., {redirect:
 * "manual"})`, empirically confirmed to return the real 3xx status and a
 * readable `location` header on Node's server-side fetch — this is NOT the
 * browser-spec "opaque redirect" behavior), specifically so
 * lib/retrieval-safety.ts's validateUrlForRetrieval can be re-run against
 * every redirect destination before it is ever fetched, not just the
 * initial URL. See this phase's own task description, section 5.
 *
 * Any hop (the initial URL or any redirect target) that fails safety
 * validation is reported as REDIRECT_BLOCKED — the vocabulary
 * (lib/retrieval-types.ts) has no separate "initial URL blocked" status,
 * and from the retriever's own perspective the first hop is not
 * structurally different from any later one.
 */

export type HttpContentRetrieverConfig = {
  timeoutMs: number;
  maxResponseBytes: number;
  maxExtractedTextLength: number;
  /** Matched against the response's Content-Type media type only (parameters like charset are ignored). */
  allowedContentTypes: string[];
  safety: RetrievalSafetyConfig;
  /** Injectable for tests — never defaults to a live call in a test context. */
  fetcher?: typeof fetch;
  lookup?: DnsLookupFn;
};

export const DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG: HttpContentRetrieverConfig = {
  timeoutMs: 10_000,
  maxResponseBytes: 2_000_000,
  maxExtractedTextLength: 200_000,
  allowedContentTypes: ["text/html"],
  safety: DEFAULT_RETRIEVAL_SAFETY_CONFIG,
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function contentTypeMedia(header: string | null): string | null {
  if (!header) return null;
  return header.split(";")[0]?.trim().toLowerCase() || null;
}

function resolveRedirectTarget(location: string, currentUrl: string): string | null {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; tooLarge: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return { bytes: new Uint8Array(0), tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: combined, tooLarge: false };
}

function makeResult(originalUrl: string, status: RetrievalStatus, overrides: Partial<RetrievedSource> = {}): RetrievedSource {
  return {
    originalUrl,
    finalUrl: null,
    httpStatus: null,
    contentType: null,
    retrievedAt: new Date().toISOString(),
    rawSha256: null,
    extractedText: null,
    canonicalSha256: null,
    extractorVersion: null,
    status,
    errorMessage: null,
    ...overrides,
  };
}

export function createHttpContentRetriever(config: Partial<HttpContentRetrieverConfig> = {}): SourceContentRetriever {
  const resolved: HttpContentRetrieverConfig = {
    ...DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG,
    ...config,
    safety: { ...DEFAULT_RETRIEVAL_SAFETY_CONFIG, ...config.safety },
  };
  const fetcher = resolved.fetcher ?? fetch;

  return {
    id: "http-content-retriever",

    async retrieve({ url }) {
      let currentUrl = url;
      let redirectCount = 0;

      while (true) {
        const safety = await validateUrlForRetrieval(currentUrl, resolved.safety, resolved.lookup);
        if (!safety.safe) {
          return makeResult(url, "REDIRECT_BLOCKED", { finalUrl: currentUrl, errorMessage: safety.reason });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), resolved.timeoutMs);
        let response: Response;
        try {
          response = await fetcher(currentUrl, {
            redirect: "manual",
            signal: controller.signal,
            headers: { "User-Agent": "TurnitPlus-Retrieval/1.0 (source correspondence check)" },
          });
        } catch (error) {
          const timedOut = controller.signal.aborted || isAbortError(error);
          return makeResult(url, timedOut ? "TIMEOUT" : "NETWORK_ERROR", {
            finalUrl: currentUrl,
            errorMessage: timedOut
              ? `retrieval timed out after ${resolved.timeoutMs} ms`
              : error instanceof Error ? error.message : String(error),
          });
        } finally {
          clearTimeout(timeout);
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          redirectCount += 1;
          if (!location) {
            return makeResult(url, "HTTP_ERROR", { finalUrl: currentUrl, httpStatus: response.status, errorMessage: `HTTP ${response.status} redirect with no Location header` });
          }
          if (redirectCount > resolved.safety.maxRedirects) {
            return makeResult(url, "REDIRECT_BLOCKED", { finalUrl: currentUrl, errorMessage: `exceeded maximum of ${resolved.safety.maxRedirects} redirects` });
          }
          const target = resolveRedirectTarget(location, currentUrl);
          if (!target) {
            return makeResult(url, "REDIRECT_BLOCKED", { finalUrl: currentUrl, errorMessage: "redirect Location header could not be resolved to a URL" });
          }
          currentUrl = target;
          continue; // re-validate the new target at the top of the loop
        }

        if (!response.ok) {
          return makeResult(url, "HTTP_ERROR", { finalUrl: currentUrl, httpStatus: response.status, errorMessage: `HTTP ${response.status}` });
        }

        const contentType = contentTypeMedia(response.headers.get("content-type"));
        if (!contentType || !resolved.allowedContentTypes.includes(contentType)) {
          return makeResult(url, "UNSUPPORTED_CONTENT_TYPE", {
            finalUrl: currentUrl,
            httpStatus: response.status,
            contentType,
            errorMessage: `content type "${contentType ?? "unknown"}" is not supported`,
          });
        }

        const { bytes, tooLarge } = await readBodyWithLimit(response, resolved.maxResponseBytes);
        if (tooLarge) {
          return makeResult(url, "CONTENT_TOO_LARGE", { finalUrl: currentUrl, httpStatus: response.status, contentType, errorMessage: `response exceeded ${resolved.maxResponseBytes} bytes` });
        }
        if (bytes.length === 0) {
          return makeResult(url, "NO_CONTENT", { finalUrl: currentUrl, httpStatus: response.status, contentType });
        }

        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        if (!decoded.includes("<")) {
          return makeResult(url, "MALFORMED_CONTENT", { finalUrl: currentUrl, httpStatus: response.status, contentType, errorMessage: "response claimed text/html but contained no markup" });
        }

        const extracted = extractTextFromHtml(decoded);
        if (!extracted.trim()) {
          return makeResult(url, "EXTRACTION_FAILED", { finalUrl: currentUrl, httpStatus: response.status, contentType, errorMessage: "no extractable text content found" });
        }

        const bounded = extracted.length > resolved.maxExtractedTextLength ? extracted.slice(0, resolved.maxExtractedTextLength) : extracted;
        return makeResult(url, "SUCCESS", {
          finalUrl: currentUrl,
          httpStatus: response.status,
          contentType,
          rawSha256: createHash("sha256").update(bytes).digest("hex"),
          extractedText: bounded,
          canonicalSha256: canonicalSha256(bounded),
          extractorVersion: HTML_EXTRACTOR_VERSION,
        });
      }
    },
  };
}
