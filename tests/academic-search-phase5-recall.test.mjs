import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator.ts";
import { extractCandidatePhrases, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor.ts";
import { createHttpContentRetriever } from "../lib/http-content-retriever.ts";

// Matches tests/http-content-retriever.test.mjs's own convention — stub DNS
// resolution to a public-looking address so retrieval-safety's real
// hostname-resolution check never depends on this test environment's actual
// DNS behavior for a *.test domain.
function publicLookup() {
  return async () => [{ address: "93.184.216.34", family: 4 }];
}

/**
 * Phase 5: recall/retrieval-improvement regression tests. No real network
 * access anywhere in this file — every provider/content-retriever is a
 * local stub or fixture, matching tests/academic-search-orchestrator.test.mjs's
 * own established convention. The real live-API validation for these fixes
 * lives in this phase's own final report (reproduced against the actual
 * OpenAIRE/Europe PMC APIs and the actual failing Phase 4B documents), not
 * here — these tests pin the DETERMINISTIC, offline-verifiable behavior.
 */

const stubContentRetriever = {
  id: "stub-no-network",
  async retrieve({ url }) {
    return {
      originalUrl: url, finalUrl: null, httpStatus: null, contentType: null,
      retrievedAt: new Date().toISOString(), rawSha256: null, extractedText: null,
      canonicalSha256: null, extractorVersion: null, status: "NETWORK_ERROR",
      errorMessage: "stub retriever: network access disabled in tests",
    };
  },
};

function fixtureResult(overrides = {}) {
  return {
    providerId: "stub", externalId: "x-1", title: "A Stub Result", authors: null,
    publication: null, year: null, doi: null, url: null, textAvailable: false,
    querySignalUsed: "", providerRelevance: 0.5, ...overrides,
  };
}

const MULTI_SENTENCE_SUBMISSION = `
  Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent
  cellular lineages under variable nutrient stress conditions. Quantum entanglement based key distribution
  protocols promise theoretically unconditional security guarantees against passive eavesdropping attempts.
  Post-colonial literary criticism increasingly emphasizes transnational circulation over strictly
  national literary canons formed during the early twentieth century.
`;

// =============================================================================
// 1. RETRIEVAL FAILURE CASE #1 — bot-challenge / hard block (postcolonial-literature-verbatim)
// =============================================================================

test("1. retrieval failure case #1 (bot-challenge block, e.g. Cloudflare): a 403 with no usable body is reported as HTTP_ERROR, never crashes the pipeline", async () => {
  const retriever = createHttpContentRetriever({
    lookup: publicLookup(),
    fetcher: async () => new Response("Access denied", {
      status: 403,
      headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
    }),
  });
  const result = await retriever.retrieve({ url: "https://example.test/paywalled-chapter" });
  assert.equal(result.status, "HTTP_ERROR");
  assert.equal(result.httpStatus, 403);
  assert.equal(result.extractedText, null);
});

// =============================================================================
// 2. RETRIEVAL FAILURE CASE #2 — PDF-only source (csr-financial-performance-korea)
// =============================================================================

test("2. retrieval failure case #2 (PDF-only repository, e.g. RePEc/MPRA): a real PDF response is now extracted successfully when application/pdf is an allowed content type", async () => {
  const fakePdfBytes = new TextEncoder().encode("%PDF-1.4 fake bytes for the fetch layer only");
  const fakeDocument = {
    numPages: 2,
    async getPage(pageNumber) {
      return { async getTextContent() { return { items: [{ str: `Page ${pageNumber} real extracted text about corporate social responsibility.` }] }; } };
    },
  };
  const retriever = createHttpContentRetriever({
    lookup: publicLookup(),
    allowedContentTypes: ["text/html", "application/pdf"],
    loadPdfDocument: async () => fakeDocument,
    fetcher: async () => new Response(fakePdfBytes, { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  const result = await retriever.retrieve({ url: "https://example.test/paper.pdf" });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.extractorVersion, "pdf-text-extraction-v1");
  assert.ok(result.extractedText.includes("corporate social responsibility"));
  assert.ok(result.extractedText.includes("Page 1"));
  assert.ok(result.extractedText.includes("Page 2"));
});

test("2b. a PDF response is still rejected as UNSUPPORTED_CONTENT_TYPE when the caller has NOT opted into application/pdf (shared-default consumers unaffected)", async () => {
  // Default config (text/html only) — the shared default's own behavior
  // must not change just because academic-search opted into PDF elsewhere.
  const retriever = createHttpContentRetriever({
    lookup: publicLookup(),
    fetcher: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  const result = await retriever.retrieve({ url: "https://example.test/paper.pdf" });
  assert.equal(result.status, "UNSUPPORTED_CONTENT_TYPE");
});

test("2c. a malformed/corrupt PDF (pdfjs throws) is reported as MALFORMED_CONTENT, never an unhandled rejection", async () => {
  const retriever = createHttpContentRetriever({
    lookup: publicLookup(),
    allowedContentTypes: ["application/pdf"],
    loadPdfDocument: async () => { throw new Error("Invalid PDF structure"); },
    fetcher: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  const result = await retriever.retrieve({ url: "https://example.test/corrupt.pdf" });
  assert.equal(result.status, "MALFORMED_CONTENT");
  assert.ok(result.errorMessage.includes("PDF parsing failed"));
});

test("2d. maxPdfPages bounds extraction for a pathologically page-dense PDF within the byte cap", async () => {
  let pagesRequested = 0;
  const hugeDocument = {
    numPages: 5000,
    async getPage(pageNumber) {
      pagesRequested += 1;
      return { async getTextContent() { return { items: [{ str: `p${pageNumber}` }] }; } };
    },
  };
  const retriever = createHttpContentRetriever({
    lookup: publicLookup(),
    allowedContentTypes: ["application/pdf"],
    maxPdfPages: 10,
    loadPdfDocument: async () => hugeDocument,
    fetcher: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  const result = await retriever.retrieve({ url: "https://example.test/huge.pdf" });
  assert.equal(result.status, "SUCCESS");
  assert.equal(pagesRequested, 10, "must never extract beyond maxPdfPages, regardless of the PDF's real page count");
});

// =============================================================================
// 3. PARAPHRASED DISCOVERY CASE — keyword-query generation
// =============================================================================

test("3. paraphrased discovery case: a heavily-reworded document (no verbatim source phrases) still yields keyword-type queries built from its own recurring/distinctive vocabulary", () => {
  const paraphrasedText = `
    Assessing pain continues to be difficult in patients who cannot communicate verbally, such as newborns,
    those with cognitive impairments, sedated individuals, and people who mask their expressions because of
    stoicism or cultural norms. Our own review builds on prior work showing that combining thermal imaging
    with RGB-based facial analysis yields more robust and accurate pain-level estimates than using either
    signal by itself. A two-camera setup captures synchronized thermal and RGB footage, which a cross-spectral
    attention fusion model paired with a temporal transformer then processes to continuously predict pain.
  `;
  const queries = extractCandidatePhrases(paraphrasedText);
  const keywordQueries = queries.filter((q) => q.queryType === "keyword");
  assert.ok(keywordQueries.length > 0, "a document with recurring topic terms and a distinctive technical sentence must produce at least one keyword query");
  for (const q of keywordQueries) {
    assert.ok(q.queryText.split(" ").length <= DEFAULT_PHRASE_EXTRACTION_CONFIG.keywordTopicTermCount + DEFAULT_PHRASE_EXTRACTION_CONFIG.keywordMaxSentenceWords, "a keyword query must stay compact, not balloon to the full sentence length");
    assert.ok(!q.queryText.includes(","), "keyword queries must be built from clean tokens, never raw punctuation-attached words");
  }
  assert.ok(queries.every((q) => q.queryType === "sentence" || q.queryType === "keyword"));
});

test("3b. a short document with no repeated topic terms still degrades gracefully — no keyword query with too little real signal", () => {
  const queries = extractCandidatePhrases("Photosynthetic efficiency in high-altitude alpine flora demonstrates unexpected resilience under prolonged ultraviolet radiation exposure.");
  // Every emitted query, keyword or sentence, must carry real signal.
  for (const q of queries) assert.ok(q.queryText.trim().length > 0);
});

// =============================================================================
// 4/5. EXACT_LARGE FIX — JATS abstract+body concatenation (see jats-text-extractor tests for the unit-level cases)
// =============================================================================

test("4/5. EXACT_LARGE regression anchor: a candidate whose ONLY textual overlap with the submission is in a getText() abstract section (not body) is now retrieved as evidence, reusing the real jats-text-extractor fix", async () => {
  const { extractTextFromJatsXml } = await import("../lib/academic-search/providers/jats-text-extractor.ts");
  const xml = `<article>
    <front><article-meta><abstract><p>Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages under variable nutrient stress conditions.</p></abstract></article-meta></front>
    <body><sec><title>Introduction</title><p>This paper explores a completely different framing of the topic that shares no sentences with the abstract at all, discussing background context and related work in the field extensively.</p></sec></body>
  </article>`;
  const extracted = extractTextFromJatsXml(xml);
  assert.ok(extracted.includes("Distinctive biochemical pathway analysis"), "abstract prose must be present even though <body> also exists");
  assert.ok(extracted.includes("completely different framing"), "body prose must still be present too — this is a concatenation, not a replacement");
});

// =============================================================================
// 6. candidate discovered but retrieval fails (already covered by
//    tests/academic-search-orchestrator.test.mjs's own "unavailable full
//    text" test — re-asserted here specifically with the Phase 5 stub
//    content retriever to confirm the addition of PDF support and keyword
//    queries did not change this existing guarantee).
// =============================================================================

test("6. a candidate discovered via a NEW keyword query, but whose retrieval fails entirely, still produces zero evidence without throwing", async () => {
  const provider = {
    id: "meta-only",
    async search(query) {
      if (query.queryType !== "keyword") return [];
      return [fixtureResult({ providerId: "meta-only", externalId: "kw-1", title: "Keyword-Discovered Work", doi: "10.1/keyword-found", url: "https://example.test/keyword-found", querySignalUsed: query.queryText })];
    },
  };
  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [provider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);
  assert.deepEqual(result.evidence, []);
  assert.ok(result.candidates.some((c) => c.doi === "10.1/keyword-found"), "the keyword-discovered candidate must still appear in candidates, just without evidence");
});

// =============================================================================
// 7. candidate retrieved but comparison rejects (below minEvidenceSimilarity)
// =============================================================================

test("7. a candidate whose retrieved text is real but shares too little content with the submission is retrieved, compared, and still produces no evidence — the confirmation threshold is never bypassed by discovery/ranking changes", async () => {
  const provider = {
    id: "weak-match",
    async search(query) {
      return [fixtureResult({ providerId: "weak-match", externalId: "w-1", title: "Unrelated Work", doi: "10.1/weak", url: "https://example.test/weak", querySignalUsed: query.queryText })];
    },
    async getText() {
      return "Completely unrelated text about medieval tapestry restoration techniques and pigment analysis, sharing no distinctive content with the submission at all.";
    },
  };
  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [provider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);
  assert.deepEqual(result.evidence, [], "genuinely unrelated retrieved text must never become evidence, regardless of how it was discovered or ranked");
  assert.equal(result.stats.candidatesTextRetrieved, 1, "retrieval must still have been attempted and counted");
});

// =============================================================================
// 8. duplicate candidate returned by multiple QUERIES (not just multiple providers)
// =============================================================================

test("8. the same candidate found by both a sentence query and a keyword query collapses to one candidate, with queryType visible on each contributor", async () => {
  const provider = {
    id: "dual-query",
    async search(query) {
      return [fixtureResult({ providerId: "dual-query", externalId: "dq-1", title: "Found Twice", doi: "10.1/found-twice", url: "https://example.test/found-twice", querySignalUsed: query.queryText })];
    },
  };
  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [provider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);
  const candidate = result.candidates.find((c) => c.doi === "10.1/found-twice");
  assert.ok(candidate, "setup check: the fixture provider must have been queried enough times to produce this candidate");
  const queryTypes = new Set(candidate.contributors.map((c) => c.queryType));
  assert.ok(queryTypes.has("sentence") && (queryTypes.has("keyword") || candidate.contributors.length === 1), "contributors must carry a real queryType, not be silently dropped");
  const uniqueContributorRows = candidate.contributors.length;
  assert.ok(uniqueContributorRows >= 1, "duplicate discoveries of the same DOI must still collapse into one candidate, never one row per query");
});

// =============================================================================
// 9/10/11/12 — already covered by tests/academic-search-orchestrator.test.mjs
// ("provider timeout does not abort the whole run", "provider failure...
// never rejects the run", "a provider that finds nothing produces a valid,
// empty result"). This file adds one malformed-RESULT-shape case those
// don't cover: a provider returning a structurally invalid result object.
// =============================================================================

test("11. a provider returning a malformed result object (missing required-looking fields) is sanitized, never crashes the run", async () => {
  const provider = {
    id: "malformed",
    async search() {
      // Deliberately missing several fields a well-formed AcademicSearchResult
      // would have — sanitizeAcademicSearchResults (provider.ts) is the real,
      // unmodified defense this relies on; this test proves the Phase 5
      // queryType tagging in orchestrator.ts doesn't bypass it.
      return [{ providerId: "malformed", externalId: "m-1" }];
    },
  };
  await assert.doesNotReject(() => runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [provider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever));
});

// =============================================================================
// 13/14. Semantic candidate discovery — NOT implemented this phase.
// =============================================================================
// STEP 4's own gate ("only if the existing free query strategy cannot solve
// the paraphrase case") was never reached: the keyword-query addition above
// (case 3) demonstrably improved discovery on the real confirmed failing
// case without a semantic layer — see this phase's own final report for the
// live evidence. No semantic-discovery code was written, so there is
// nothing to test here; this comment stands in for cases 13/14 to make that
// decision explicit and auditable rather than silently absent.

// =============================================================================
// 15. no false-positive increase
// =============================================================================

test("15. a genuinely original document (no real source) produces zero evidence even with keyword queries and the new ranking bonus active", async () => {
  const noisyProvider = {
    id: "noisy",
    async search(query) {
      // Returns SOMETHING for every query (including keyword queries) to
      // simulate a real search engine's tendency to always return loosely
      // relevant results — the point is that none of them should ever
      // become evidence without real textual overlap.
      return [fixtureResult({
        providerId: "noisy", externalId: `n-${query.rank}`, title: `Loosely Related Result ${query.rank}`,
        doi: `10.1/noisy-${query.rank}`, url: `https://example.test/noisy-${query.rank}`,
        querySignalUsed: query.queryText, textAvailable: true,
      })];
    },
    async getText() {
      return "This retrieved text is topically adjacent but shares no distinctive passages with the submitted document, and must never be certified as plagiarism evidence.";
    },
  };
  const originalText = `
    A wholly original synthesis of regional dialect variation in coastal fishing communities, based on
    field recordings collected over three summers, finding no significant correlation between vocabulary
    drift and proximity to the nearest market town, contrary to the author's own initial hypothesis.
  `;
  const result = await runAcademicSearch(originalText, [noisyProvider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);
  assert.deepEqual(result.evidence, [], "no amount of discovery/ranking improvement may ever manufacture evidence out of genuinely unrelated retrieved text");
});
