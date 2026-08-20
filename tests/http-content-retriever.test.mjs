import assert from "node:assert/strict";
import test from "node:test";
import { createHttpContentRetriever, DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG } from "../lib/http-content-retriever.ts";
import { DEFAULT_RETRIEVAL_SAFETY_CONFIG } from "../lib/retrieval-safety.ts";

function publicLookup(map = {}) {
  return async (hostname) => map[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
}

function htmlResponse(body, { status = 200, contentType = "text/html" } = {}) {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function createMockFetch(steps) {
  const calls = [];
  let index = 0;
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error("mock fetch called more times than configured");
    if (step.type === "network-error") throw new TypeError("fetch failed");
    if (step.type === "abort") {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (step.type === "oversized") {
      const chunkSize = step.chunkSize ?? 1_000_000;
      const chunks = step.chunks ?? 5;
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < chunks; i += 1) controller.enqueue(new Uint8Array(chunkSize).fill(65));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
    }
    return step.response;
  };
  fetcher.calls = calls;
  return fetcher;
}

const FAST_CONFIG = { timeoutMs: 100, safety: { ...DEFAULT_RETRIEVAL_SAFETY_CONFIG, maxRedirects: 5 } };

// --- SUCCESS / basic parsing ----------------------------------------------------

test("SUCCESS: retrieves and extracts a simple HTML page, computing both hashes", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("<html><body><p>Distinctive retrieval content sample.</p></body></html>") }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/article" });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.contentType, "text/html");
  assert.equal(result.finalUrl, "https://example.org/article");
  assert.match(result.extractedText, /Distinctive retrieval content sample\./);
  assert.ok(result.rawSha256);
  assert.ok(result.canonicalSha256);
  assert.ok(result.extractorVersion);
});

// --- CASE H/I: redirects ---------------------------------------------------------

test("CASE H: a redirect to a private/internal address is blocked before the second request is ever made", async () => {
  const fetcher = createMockFetch([{ response: redirectResponse("http://internal.example.org/secret") }]);
  const lookup = publicLookup({ "public.example.org": [{ address: "93.184.216.34", family: 4 }], "internal.example.org": [{ address: "10.0.0.5", family: 4 }] });
  const retriever = createHttpContentRetriever({ fetcher, lookup, ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://public.example.org/redirect-start" });

  assert.equal(result.status, "REDIRECT_BLOCKED");
  assert.equal(fetcher.calls.length, 1, "the blocked redirect target must never actually be fetched");
});

test("CASE I: excessive redirects are blocked once the configured maximum is exceeded", async () => {
  const fetcher = createMockFetch([
    { response: redirectResponse("https://example.org/hop-1") },
    { response: redirectResponse("https://example.org/hop-2") },
    { response: redirectResponse("https://example.org/hop-3") },
  ]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), timeoutMs: 100, safety: { ...DEFAULT_RETRIEVAL_SAFETY_CONFIG, maxRedirects: 2 } });
  const result = await retriever.retrieve({ url: "https://example.org/start" });

  assert.equal(result.status, "REDIRECT_BLOCKED");
  assert.equal(fetcher.calls.length, 3, "exactly maxRedirects+1 requests should be attempted before stopping");
});

test("a redirect to a safe public URL is followed, and finalUrl reflects the destination", async () => {
  const fetcher = createMockFetch([
    { response: redirectResponse("https://example.org/final") },
    { response: htmlResponse("<p>Final destination content.</p>") },
  ]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/start" });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.finalUrl, "https://example.org/final");
  assert.equal(fetcher.calls.length, 2);
});

test("a relative redirect Location is resolved against the current URL", async () => {
  const fetcher = createMockFetch([
    { response: redirectResponse("/moved") },
    { response: htmlResponse("<p>Moved content.</p>") },
  ]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/start" });
  assert.equal(result.finalUrl, "https://example.org/moved");
});

// --- CASE J: oversized response --------------------------------------------------

test("CASE J: a response exceeding the configured byte limit is aborted and reported as CONTENT_TOO_LARGE", async () => {
  const fetcher = createMockFetch([{ type: "oversized", chunkSize: 500_000, chunks: 5 }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), maxResponseBytes: 1_000_000, ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/huge" });
  assert.equal(result.status, "CONTENT_TOO_LARGE");
  assert.equal(result.extractedText, null, "no partial content should be exposed once the limit is exceeded");
});

// --- CASE K: unsupported content type --------------------------------------------

test("CASE K: an unsupported content type is reported as UNSUPPORTED_CONTENT_TYPE, not as a source-does-not-exist failure", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("%PDF-1.4 binary data here", { contentType: "application/pdf" }) }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/paper.pdf" });
  assert.equal(result.status, "UNSUPPORTED_CONTENT_TYPE");
});

test("content type matching ignores charset/parameters", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("<p>Text</p>", { contentType: "text/html; charset=utf-8" }) }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/x" });
  assert.equal(result.status, "SUCCESS");
});

// --- CASE L/M: timeout and network error -----------------------------------------

test("CASE L: a request that never resolves within the timeout is reported as TIMEOUT", async () => {
  const fetcher = createMockFetch([{ type: "abort" }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), timeoutMs: 20, safety: DEFAULT_RETRIEVAL_SAFETY_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/slow" });
  assert.equal(result.status, "TIMEOUT");
});

test("CASE M: a network-level failure is reported as NETWORK_ERROR", async () => {
  const fetcher = createMockFetch([{ type: "network-error" }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/unreachable" });
  assert.equal(result.status, "NETWORK_ERROR");
});

// --- CASE N: malformed content -----------------------------------------------------

test("CASE N: a text/html response with no markup at all is reported as MALFORMED_CONTENT", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("just plain bytes, no tags whatsoever") }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/weird" });
  assert.equal(result.status, "MALFORMED_CONTENT");
});

test("CASE N (variant): HTML that extracts to nothing meaningful is reported as EXTRACTION_FAILED", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("<script>var x = 1;</script><style>.a{}</style>") }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/empty-shell" });
  assert.equal(result.status, "EXTRACTION_FAILED");
});

test("an empty response body is reported as NO_CONTENT", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("") }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/blank" });
  assert.equal(result.status, "NO_CONTENT");
});

test("a non-2xx, non-3xx HTTP status is reported as HTTP_ERROR, not as a source-does-not-exist failure", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("Not Found", { status: 404 }) }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/missing" });
  assert.equal(result.status, "HTTP_ERROR");
  assert.equal(result.httpStatus, 404);
});

// --- CASE O: privacy — nothing beyond the URL and standard headers is sent -----

test("CASE O: the retrieval request contains only the candidate URL and standard headers — nothing document- or user-specific", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("<p>content</p>") }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  await retriever.retrieve({ url: "https://example.org/article" });

  const [call] = fetcher.calls;
  assert.equal(call.url, "https://example.org/article");
  const headerKeys = Object.keys(call.init.headers);
  assert.deepEqual(headerKeys, ["User-Agent"], "only a descriptive User-Agent header is sent — no cookies, tokens, or account information");
  assert.doesNotMatch(JSON.stringify(call.init), /account|email|session|cookie|token/i);
});

// --- "Investigate two production issues" ISSUE 1: citation_pdf_url following ---

function pdfResponse(bytes) {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
}

test("citation_pdf_url: a landing page's own citation_pdf_url is followed once when the caller has opted into application/pdf, and the PDF's own extracted text is returned", async () => {
  const landingHtml = '<html><head><meta name="citation_pdf_url" content="https://example.org/paper/pdf"></head><body><p>Abstract only, nowhere near the real article.</p></body></html>';
  const fetcher = createMockFetch([
    { response: htmlResponse(landingHtml) },
    { response: pdfResponse(new TextEncoder().encode("%PDF-1.4 fake bytes")) },
  ]);
  const loadPdfDocument = async () => ({
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "The full article text lives here." }] }) }),
  });
  const retriever = createHttpContentRetriever({
    fetcher, lookup: publicLookup(), loadPdfDocument,
    allowedContentTypes: ["text/html", "application/pdf"],
    ...FAST_CONFIG,
  });
  const result = await retriever.retrieve({ url: "https://example.org/paper" });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.finalUrl, "https://example.org/paper/pdf");
  assert.equal(result.contentType, "application/pdf");
  assert.match(result.extractedText, /The full article text lives here\./);
  assert.equal(fetcher.calls.length, 2, "exactly one extra hop: the landing page, then the PDF it points at");
});

test("citation_pdf_url: a caller that has NOT opted into application/pdf never follows it — landing-page HTML is returned as-is", async () => {
  const landingHtml = '<html><head><meta name="citation_pdf_url" content="https://example.org/paper/pdf"></head><body><p>Abstract text.</p></body></html>';
  const fetcher = createMockFetch([{ response: htmlResponse(landingHtml) }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/paper" });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.contentType, "text/html");
  assert.match(result.extractedText, /Abstract text\./);
  assert.equal(fetcher.calls.length, 1, "no citation_pdf_url hop for a caller that never enabled application/pdf");
});

test("citation_pdf_url: a page with no citation_pdf_url meta tag is unaffected — no extra request is ever made", async () => {
  const fetcher = createMockFetch([{ response: htmlResponse("<p>Ordinary page, no citation metadata.</p>") }]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), allowedContentTypes: ["text/html", "application/pdf"], ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/plain" });

  assert.equal(result.status, "SUCCESS");
  assert.match(result.extractedText, /Ordinary page/);
  assert.equal(fetcher.calls.length, 1);
});

test("citation_pdf_url: is only ever followed once, even if the linked PDF URL somehow also resolves to HTML with its own citation_pdf_url", async () => {
  const firstLanding = '<meta name="citation_pdf_url" content="https://example.org/hop-2">';
  const secondLanding = '<meta name="citation_pdf_url" content="https://example.org/hop-3"><p>Second landing page body text.</p>';
  const fetcher = createMockFetch([
    { response: htmlResponse(firstLanding) },
    { response: htmlResponse(secondLanding) },
  ]);
  const retriever = createHttpContentRetriever({ fetcher, lookup: publicLookup(), allowedContentTypes: ["text/html", "application/pdf"], ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://example.org/hop-1" });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.finalUrl, "https://example.org/hop-2", "the second page's own citation_pdf_url must not be followed — the mechanism is capped at one hop");
  assert.match(result.extractedText, /Second landing page body text\./);
  assert.equal(fetcher.calls.length, 2);
});

test("citation_pdf_url: an SSRF-unsafe target is blocked exactly like an HTTP redirect to the same address would be", async () => {
  const landingHtml = '<meta name="citation_pdf_url" content="http://internal.example.org/secret.pdf">';
  const fetcher = createMockFetch([{ response: htmlResponse(landingHtml) }]);
  const lookup = publicLookup({ "public.example.org": [{ address: "93.184.216.34", family: 4 }], "internal.example.org": [{ address: "10.0.0.5", family: 4 }] });
  const retriever = createHttpContentRetriever({ fetcher, lookup, allowedContentTypes: ["text/html", "application/pdf"], ...FAST_CONFIG });
  const result = await retriever.retrieve({ url: "https://public.example.org/paper" });

  assert.equal(result.status, "REDIRECT_BLOCKED", "the citation_pdf_url hop is re-validated by the same safety check as any other target URL");
  assert.equal(fetcher.calls.length, 1, "the blocked internal target must never actually be fetched");
});

test("DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG bounds are conservative", () => {
  assert.ok(DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG.maxResponseBytes <= 10_000_000);
  assert.ok(DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG.timeoutMs <= 30_000);
  assert.deepEqual(DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG.allowedContentTypes, ["text/html"]);
});
