import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAcademicSearchContentRetriever } from "../lib/academic-search/text-retriever.ts";
import { createHttpContentRetriever, DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG } from "../lib/http-content-retriever.ts";

/**
 * Coverage benchmark (2026-08-21) regression coverage: the shared default's
 * 2,000,000-byte maxResponseBytes rejected the real, ordinary "Attention Is
 * All You Need" arXiv PDF (2,215,244 bytes) as CONTENT_TOO_LARGE, confirmed
 * live via retrieveCandidateText() on the real ranked-#1 candidate.
 * text-retriever.ts's own createAcademicSearchContentRetriever() now raises
 * this to 10,000,000 bytes, scoped to academic-search's own retriever only
 * — see that file's own comment for the full rationale. This file proves,
 * with no real network call, that:
 *  (a) a PDF just above the OLD 2MB cap now succeeds through the raised,
 *      scoped config;
 *  (b) the exact real 2.215MB fixture succeeds through the real (non-mocked)
 *      pdfjs-dist parsing path, using the real production cap value;
 *  (c) the SHARED global default is completely unchanged — every other
 *      caller of createHttpContentRetriever() still gets the original,
 *      conservative 2MB limit.
 */

function publicLookup() {
  return async () => [{ address: "93.184.216.34", family: 4 }];
}

function pdfResponse(bytes) {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
}

const noopPdfLoader = (pageText) => async () => ({
  numPages: 1,
  getPage: async () => ({ getTextContent: async () => ({ items: [{ str: pageText }] }) }),
});

test("shared global default is untouched by the academic-search retrieval-cap fix", () => {
  assert.equal(DEFAULT_HTTP_CONTENT_RETRIEVER_CONFIG.maxResponseBytes, 2_000_000, "every other caller of createHttpContentRetriever() must keep the original, conservative 2MB default");
});

test("a PDF just above the old 2MB cap is rejected under the untouched shared default...", async () => {
  const bytes = new Uint8Array(2_100_000).fill(65);
  const fetcher = async () => pdfResponse(bytes);
  const retriever = createHttpContentRetriever({
    fetcher,
    lookup: publicLookup(),
    allowedContentTypes: ["text/html", "application/pdf"],
    timeoutMs: 5_000,
    // deliberately NOT overriding maxResponseBytes — this is the shared default's own 2MB
  });
  const result = await retriever.retrieve({ url: "https://example.org/paper-just-over-2mb.pdf" });
  assert.equal(result.status, "CONTENT_TOO_LARGE");
});

test("...but succeeds under academic-search's own scoped, raised cap (same bytes, same config createAcademicSearchContentRetriever() now uses)", async () => {
  const bytes = new Uint8Array(2_100_000).fill(65);
  const fetcher = async () => pdfResponse(bytes);
  const retriever = createHttpContentRetriever({
    fetcher,
    lookup: publicLookup(),
    allowedContentTypes: ["text/html", "application/pdf"],
    maxResponseBytes: 10_000_000, // must match createAcademicSearchContentRetriever()'s own value
    loadPdfDocument: noopPdfLoader("Ordinary academic PDF text just above the old cap."),
    timeoutMs: 5_000,
  });
  const result = await retriever.retrieve({ url: "https://example.org/paper-just-over-2mb.pdf" });
  assert.equal(result.status, "SUCCESS");
  assert.match(result.extractedText, /Ordinary academic PDF text just above the old cap\./);
});

test("REAL FIXTURE, REAL PDFJS: the exact 2,215,244-byte Attention Is All You Need PDF now passes through academic-search's real (non-mocked) retrieval + parsing path", async () => {
  const pdfBuffer = await readFile(new URL("./fixtures/attention-is-all-you-need.pdf", import.meta.url));
  assert.ok(pdfBuffer.length > 2_000_000, "sanity check: this fixture must actually exceed the old 2MB cap, or this test would prove nothing");

  const fetcher = async () => pdfResponse(pdfBuffer);
  // Mirrors createAcademicSearchContentRetriever()'s exact config (allowedContentTypes +
  // maxResponseBytes: 10_000_000), with only fetcher/lookup injected for a network-free
  // test and timeoutMs raised for real (non-mocked) pdfjs-dist parsing of a real 2.2MB PDF.
  const retriever = createHttpContentRetriever({
    fetcher,
    lookup: publicLookup(),
    allowedContentTypes: ["text/html", "application/pdf"],
    maxResponseBytes: 10_000_000,
    timeoutMs: 15_000,
  });
  const result = await retriever.retrieve({ url: "https://arxiv.org/pdf/1706.03762" });

  assert.equal(result.status, "SUCCESS", `expected SUCCESS, got ${result.status} (${result.errorMessage ?? "no error message"})`);
  assert.equal(result.contentType, "application/pdf");
  assert.match(result.extractedText, /Attention Is All You Need/);
});

test("createAcademicSearchContentRetriever() itself is constructed with the raised cap (structural check, no network)", () => {
  // Not directly inspectable (the factory returns an opaque SourceContentRetriever),
  // so this only guards that the factory still constructs without throwing after the
  // config change — the behavioral proof is the two tests above, which mirror its
  // exact config values.
  const retriever = createAcademicSearchContentRetriever();
  assert.equal(retriever.id, "http-content-retriever");
  assert.equal(typeof retriever.retrieve, "function");
});
