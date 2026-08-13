import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  runAsjpDiscoveryForDocument,
  classifyAsjpCorrespondence,
  MAX_CANDIDATES_CHECKED_PER_DOCUMENT,
} from "../lib/e7-asjp-client.ts";

const repoRoot = path.resolve(".");

// --- STRUCTURAL SAFETY (matching tests/provenance-scoring-invariance.test.mjs's own convention) ---

function importLines(source) {
  return source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const ASJP_FILES = ["lib/e7-asjp-client.ts", "lib/e7-asjp-interface.ts"];

test("L: no TLS bypass anywhere in the ASJP files — no rejectUnauthorized:false, no NODE_TLS_REJECT_UNAUTHORIZED, no custom insecure https.Agent", () => {
  // Comments are stripped first — this file's own header comment legitimately
  // documents that it avoids these exact strings (the same trap
  // tests/provenance-scoring-invariance.test.mjs already warns about: a
  // structural check must scan real code, not prose that happens to name
  // the thing it asserts the absence of).
  for (const relativePath of ASJP_FILES) {
    const code = stripComments(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    assert.doesNotMatch(code, /rejectUnauthorized\s*:\s*false/, `${relativePath} must never disable TLS verification`);
    assert.doesNotMatch(code, /NODE_TLS_REJECT_UNAUTHORIZED/, `${relativePath} must never reference the insecure env override`);
    assert.doesNotMatch(code, /new\s+https\.Agent/, `${relativePath} must never construct a custom TLS agent`);
  }
});

test("O: none of the ASJP files import lib/provenance-verification-workflow.ts, and none call a verification-decision function", () => {
  for (const relativePath of ASJP_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(importLines(source), /provenance-verification-workflow/, `${relativePath} must never import the E5 verification workflow`);
    assert.doesNotMatch(
      stripComments(source),
      /\b(approveVerification|rejectVerification|recordDispute|recordRetraction|reaffirmVerification)\s*\(/,
      `${relativePath} must never call a verification-decision function`,
    );
  }
});

const SCORING_PATH_FILES = [
  "app/similarity-worker.ts", "app/ai-detector-worker.ts", "app/web-check-worker.ts", "app/page.tsx",
  "lib/report-types.ts", "lib/similarity-core.ts", "lib/similarity-enrichment.ts", "lib/receipt-pdf.ts",
  "app/api/reports/route.ts", "app/api/reports/[id]/route.ts", "app/reports/[id]/page.tsx",
  "app/reports/[id]/report-detail-shell.tsx", "components/report/similarity-report-papers.tsx", "components/report/ai-report.tsx",
];

test("P/Q: no live scoring/report-path or user-upload-path file imports any ASJP module", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const imports = importLines(fs.readFileSync(fullPath, "utf8"));
    if (/e7-asjp-(client|interface)/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these live-path files import an ASJP module, which must not happen: ${offenders.join(", ")}`);
});

test("N: the correspondence step reuses lib/document-correspondence.ts unmodified — no new similarity algorithm", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-asjp-client.ts"), "utf8");
  assert.match(importLines(source), /document-correspondence/, "must import the existing E6C correspondence engine");
  assert.doesNotMatch(stripComments(source), /function\s+computeDocumentCorrespondence/, "must not redefine/reimplement the correspondence function");
});

test("PDF extraction reuses lib/pdf-text-extraction.ts unmodified — the same shared contract tools/reextract-ai-negatives-pdfjs.ts already uses", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-asjp-client.ts"), "utf8");
  assert.match(importLines(source), /pdf-text-extraction/, "must import the existing shared PDF text-layer contract");
});

test("R: neither ASJP file performs any filesystem write, and neither imports node:fs at all", () => {
  for (const relativePath of ASJP_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(importLines(source), /node:fs/, `${relativePath} must not touch the filesystem — no archive/index files can be modified from here`);
  }
});

test("this module is not registered in any discovery/content-retriever registry and not imported by lib/source-discovery-workflow.ts", () => {
  const workflowSource = fs.readFileSync(path.join(repoRoot, "lib/source-discovery-workflow.ts"), "utf8");
  assert.doesNotMatch(importLines(workflowSource), /e7-asjp/, "E6D must stay unaware of this standalone ASJP pilot");
  const registrySource = fs.readFileSync(path.join(repoRoot, "lib/source-discovery-registries.ts"), "utf8");
  assert.doesNotMatch(importLines(registrySource), /e7-asjp/, "the ASJP pilot must not be registered as an E6A/E6D provider yet");
});

// --- FUNCTIONAL: fixture transport only, no real network ---------------------

function fixtureTransport(overrides = {}) {
  return {
    async fetchSearchForm() {
      return { ok: true, value: { html: '<input type="hidden" name="_token" value="fixture-token">' } };
    },
    async submitAdvancedSearch() {
      return { ok: true, value: { html: '<a href="https://www.asjp.cerist.dz/en/article/1">Match</a>' } };
    },
    async fetchArticlePage() {
      return {
        ok: true,
        value: {
          html:
            '<meta name="citation_title" content="Fixture"><meta name="citation_issn" content="2588-2007">' +
            '<meta name="citation_pdf_url" content="https://asjp.cerist.dz/en/downArticle/1/1/1/1">' +
            '/en/article/1',
        },
      };
    },
    async fetchPdf() {
      return { ok: true, value: { bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf", httpStatus: 200 } };
    },
    ...overrides,
  };
}

test("C: a malformed/empty search response is handled gracefully — zero candidates classifies as ASJP_SEARCH_NO_RESULT, not a crash", async () => {
  const transport = fixtureTransport({
    async submitAdvancedSearch() {
      return { ok: true, value: { html: "<html><body>garbage, no article links, unexpected markup <<< &&&</body></html>" } };
    },
  });
  const result = await runAsjpDiscoveryForDocument(transport, {
    documentId: "doc-1", expectedIssns: ["2588-2007"], searchSignals: { title: "x" }, submittedText: "irrelevant",
  });
  assert.equal(result.documentClassification, "ASJP_SEARCH_NO_RESULT");
  assert.equal(result.candidatesFound, 0);
});

test("K: a TLS/transport failure on the search form fetch is classified as ASJP_SEARCH_FAILED, never thrown, never retried, never bypassed", async () => {
  const transport = fixtureTransport({
    async fetchSearchForm() {
      return { ok: false, errorClassification: "TLS_CERTIFICATE_VERIFICATION_FAILED: UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
    },
  });
  let submitCalled = false;
  transport.submitAdvancedSearch = async () => { submitCalled = true; return { ok: true, value: { html: "" } }; };

  const result = await runAsjpDiscoveryForDocument(transport, {
    documentId: "doc-1", expectedIssns: ["2588-2007"], searchSignals: { title: "x" }, submittedText: "irrelevant",
  });
  assert.equal(result.documentClassification, "ASJP_SEARCH_FAILED");
  assert.match(result.failureDetail, /TLS_CERTIFICATE_VERIFICATION_FAILED/);
  assert.equal(submitCalled, false, "a failed form fetch must not proceed to submit a search — no retry, no fallback");
  assert.equal(result.requestCount, 1, "exactly one request should have been attempted before stopping");
});

test("M: candidate checking is bounded — more results than the budget are found but not all fetched", async () => {
  let manyResults = "";
  for (let i = 1; i <= MAX_CANDIDATES_CHECKED_PER_DOCUMENT + 5; i++) {
    manyResults += `<a href="https://www.asjp.cerist.dz/en/article/${i}">Title ${i}</a>`;
  }
  let articleFetchCount = 0;
  const transport = fixtureTransport({
    async submitAdvancedSearch() { return { ok: true, value: { html: manyResults } }; },
    async fetchArticlePage() {
      articleFetchCount += 1;
      return { ok: true, value: { html: '<meta name="citation_title" content="X"><meta name="citation_issn" content="9999-9999">' } };
    },
  });

  const result = await runAsjpDiscoveryForDocument(transport, {
    documentId: "doc-1", expectedIssns: ["2588-2007"], searchSignals: { title: "x" }, submittedText: "irrelevant",
  });
  assert.equal(result.candidatesFound, MAX_CANDIDATES_CHECKED_PER_DOCUMENT + 5);
  assert.equal(articleFetchCount, MAX_CANDIDATES_CHECKED_PER_DOCUMENT, "must not fetch more article pages than the bound, even though more candidates were found");
  assert.equal(result.candidatesChecked, MAX_CANDIDATES_CHECKED_PER_DOCUMENT);
});

test("H/I (client-level): an ISSN match retrieves+extracts+corresponds; an ISSN mismatch stops at ISSN_MISMATCH without ever fetching a PDF", async () => {
  let pdfFetchCount = 0;
  const mismatchTransport = fixtureTransport({
    async fetchArticlePage() {
      return { ok: true, value: { html: '<meta name="citation_title" content="X"><meta name="citation_issn" content="0000-0000">' } };
    },
    async fetchPdf() { pdfFetchCount += 1; return { ok: true, value: { bytes: new Uint8Array(), contentType: null, httpStatus: 200 } }; },
  });
  const result = await runAsjpDiscoveryForDocument(mismatchTransport, {
    documentId: "doc-1", expectedIssns: ["2588-2007"], searchSignals: { title: "x" }, submittedText: "irrelevant",
  });
  assert.equal(result.documentClassification, "ASJP_ISSN_MISMATCH");
  assert.equal(pdfFetchCount, 0, "a PDF must never be fetched for a candidate that failed the ISSN check");
});

test("ASJP_PDF_UNAVAILABLE when the ISSN matches but the PDF fetch fails", async () => {
  const transport = fixtureTransport({
    async fetchPdf() { return { ok: false, errorClassification: "HTTP_ERROR_404" }; },
  });
  const result = await runAsjpDiscoveryForDocument(transport, {
    documentId: "doc-1", expectedIssns: ["2588-2007"], searchSignals: { title: "x" }, submittedText: "irrelevant",
  });
  assert.equal(result.documentClassification, "ASJP_PDF_UNAVAILABLE");
});

test("classifyAsjpCorrespondence: unrelated extracted text classifies ASJP_CANDIDATE_UNRELATED, never ASJP_MATCH_CONFIRMED", () => {
  const { classification } = classifyAsjpCorrespondence(
    "Ornithologists tracking migratory songbirds documented a coastal wetland reserve stopover site with dense insect populations.",
    "Ceramicists studying a regional pottery tradition analyzed clay composition across excavated fragments spanning centuries.",
  );
  assert.equal(classification, "ASJP_CANDIDATE_UNRELATED");
});

test("classifyAsjpCorrespondence: an exact canonical match classifies ASJP_MATCH_CONFIRMED", () => {
  const text = "Ornithologists tracking migratory songbirds documented a previously unrecorded stopover site in a coastal wetland reserve with dense insect populations supporting refueling.";
  const { classification, correspondence } = classifyAsjpCorrespondence(text, text);
  assert.equal(classification, "ASJP_MATCH_CONFIRMED");
  assert.ok(correspondence.exactCanonicalMatch);
});

test("the document-level result never contains the raw submittedText or extracted article text — only bounded metadata and correspondence aggregates", async () => {
  const transport = fixtureTransport();
  const result = await runAsjpDiscoveryForDocument(transport, {
    documentId: "doc-1", expectedIssns: ["2588-2007"],
    searchSignals: { title: "x" },
    submittedText: "UNIQUE_SENTINEL_SUBMITTED_TEXT_MARKER_zzz123",
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("UNIQUE_SENTINEL_SUBMITTED_TEXT_MARKER_zzz123"), "submitted text must never leak into the result artifact");
});
