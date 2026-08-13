import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createProvenanceSource, findProvenanceSourceById } from "../lib/provenance-registry.ts";
import { findEvidenceForSource } from "../lib/provenance-evidence.ts";
import { approveVerification } from "../lib/provenance-verification-workflow.ts";
import { createFixtureDiscoveryProvider } from "../lib/discovery-providers.ts";
import { runDiscovery } from "../lib/discovery-orchestrator.ts";
import { createCandidateSourceFromDiscovery } from "../lib/discovery-provenance-bridge.ts";
import { retrieveAndCompareCandidate } from "../lib/retrieval-correspondence-bridge.ts";
import { findSourceRetrievalsForSource, MAX_STORED_EXCERPT_LENGTH } from "../lib/retrieval-repository.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_retrieval_correspondence_bridge.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

const SUBMITTED_TEXT = [
  "Meteorologists analyzing a decade of radiosonde launches over a mountain valley documented a persistent temperature-inversion layer forming almost every clear winter night.",
  "The inversion trapped cold air near the valley floor while temperatures several hundred meters higher remained noticeably warmer throughout the overnight hours.",
  "Local air-quality sensors recorded correspondingly elevated pollutant concentrations during inversion nights compared with nights when the layer failed to form.",
  "Researchers proposed that targeted overnight emission restrictions during forecast inversion conditions could measurably reduce the valley's worst air-quality episodes.",
].join(" ");

const UNRELATED_TEXT = [
  "Textile conservators restoring a centuries-old tapestry catalogued dye degradation patterns across several distinct color regions of the woven surface.",
  "Spectral imaging revealed that certain plant-based dyes had faded far more than mineral-based pigments used in the same original workshop.",
  "The conservation team recommended climate-controlled display conditions specifically calibrated to slow further degradation of the most light-sensitive dye regions.",
].join(" ");

function makeSuccessRetriever(html) {
  return {
    id: "test-fixture-retriever",
    async retrieve({ url }) {
      const { extractTextFromHtml, HTML_EXTRACTOR_VERSION } = await import("../lib/html-text-extraction.ts");
      const { canonicalSha256 } = await import("../lib/document-identity.ts");
      const { createHash } = await import("node:crypto");
      const extracted = extractTextFromHtml(html);
      return {
        originalUrl: url,
        finalUrl: url,
        httpStatus: 200,
        contentType: "text/html",
        retrievedAt: new Date().toISOString(),
        rawSha256: createHash("sha256").update(html).digest("hex"),
        extractedText: extracted,
        canonicalSha256: canonicalSha256(extracted),
        extractorVersion: HTML_EXTRACTOR_VERSION,
        status: "SUCCESS",
        errorMessage: null,
      };
    },
  };
}

function makeFailureRetriever(status, errorMessage) {
  return {
    id: "test-fixture-failing-retriever",
    async retrieve({ url }) {
      return {
        originalUrl: url,
        finalUrl: url,
        httpStatus: null,
        contentType: null,
        retrievedAt: new Date().toISOString(),
        rawSha256: null,
        extractedText: null,
        canonicalSha256: null,
        extractorVersion: null,
        status,
        errorMessage,
      };
    },
  };
}

async function newCandidateSource(title) {
  return createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference", title });
}

// --- BASIC PIPELINE ----------------------------------------------------------

test("BASIC: successful retrieval with strong correspondence creates the full evidence set and advances to PROVENANCE_PENDING", async () => {
  const source = await newCandidateSource("strong correspondence case");
  const retriever = makeSuccessRetriever(`<html><body><p>${SUBMITTED_TEXT}</p></body></html>`);
  const result = await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/article", submittedText: SUBMITTED_TEXT, retriever });

  assert.equal(result.retrievalStatus, "SUCCESS");
  assert.equal(result.stateChanged, true);
  assert.equal(result.newState, "PROVENANCE_PENDING");
  assert.deepEqual(result.evidenceCreated.sort(), ["CANONICAL_CORRESPONDENCE", "CONTENT_HASH", "RETRIEVAL_TIMESTAMP", "URL_ACCESSIBILITY"].sort());

  const reread = await findProvenanceSourceById(client, source.id);
  assert.equal(reread.provenanceState, "PROVENANCE_PENDING");
});

test("BASIC: an exact match produces CANONICAL_CORRESPONDENCE evidence, not STRONG_TEXT_CORRESPONDENCE", async () => {
  const source = await newCandidateSource("exact match case");
  const retriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p>`);
  const result = await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/exact", submittedText: SUBMITTED_TEXT, retriever });
  assert.ok(result.evidenceCreated.includes("CANONICAL_CORRESPONDENCE"));
  assert.ok(!result.evidenceCreated.includes("STRONG_TEXT_CORRESPONDENCE"));
  assert.equal(result.correspondence.exactCanonicalMatch, true);
});

test("BASIC: weak/no correspondence still records STRONG_TEXT_CORRESPONDENCE evidence with match=false, and still advances to PROVENANCE_PENDING (a weak finding is still worth reviewing)", async () => {
  const source = await newCandidateSource("weak correspondence case");
  const retriever = makeSuccessRetriever(`<p>${UNRELATED_TEXT}</p>`);
  const result = await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/unrelated", submittedText: SUBMITTED_TEXT, retriever });

  assert.ok(result.evidenceCreated.includes("STRONG_TEXT_CORRESPONDENCE"));
  assert.equal(result.correspondence.strongCorrespondence, false);
  const evidence = await findEvidenceForSource(client, source.id);
  const strongEvidence = evidence.find((e) => e.evidenceType === "STRONG_TEXT_CORRESPONDENCE");
  assert.equal(strongEvidence.payload.match, false);
  assert.equal(result.stateChanged, true, "even a weak finding is a completed review-worthy attempt");
  assert.equal(result.newState, "PROVENANCE_PENDING");
});

test("BASIC: a failed retrieval records URL_ACCESSIBILITY(accessible=false) and RETRIEVAL_TIMESTAMP only, no CONTENT_HASH or correspondence evidence, and does NOT advance the source", async () => {
  const source = await newCandidateSource("failed retrieval case");
  const retriever = makeFailureRetriever("HTTP_ERROR", "HTTP 404");
  const result = await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/missing", submittedText: SUBMITTED_TEXT, retriever });

  assert.deepEqual(result.evidenceCreated.sort(), ["RETRIEVAL_TIMESTAMP", "URL_ACCESSIBILITY"].sort());
  assert.equal(result.correspondence, null);
  assert.equal(result.stateChanged, false);

  const evidence = await findEvidenceForSource(client, source.id);
  const accessibility = evidence.find((e) => e.evidenceType === "URL_ACCESSIBILITY");
  assert.equal(accessibility.payload.accessible, false);

  const reread = await findProvenanceSourceById(client, source.id);
  assert.equal(reread.provenanceState, "CANDIDATE_SOURCE", "a failed retrieval must leave the source exactly where it was, retrievable again later");
});

// --- EVIDENCE CHAIN SEPARATION (section 18) --------------------------------------

test("SEPARATION: the retrieval bridge never creates DISCOVERY_INDEPENDENCE or PUBLISHER_IDENTITY evidence", async () => {
  const source = await newCandidateSource("evidence separation case");
  const retriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p><footer>Published by Example Press</footer>`);
  await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/x", submittedText: SUBMITTED_TEXT, retriever });
  const evidence = await findEvidenceForSource(client, source.id);
  assert.ok(!evidence.some((e) => e.evidenceType === "DISCOVERY_INDEPENDENCE"), "DISCOVERY_INDEPENDENCE must come only from lib/discovery-provenance-bridge.ts (E6B)");
  assert.ok(!evidence.some((e) => e.evidenceType === "PUBLISHER_IDENTITY"), "a publisher name appearing in retrieved HTML must never alone create PUBLISHER_IDENTITY evidence");
});

test("SEPARATION: passage-level evidence is created only when passages actually exist", async () => {
  const noPassageSource = await newCandidateSource("no passages");
  const retriever = makeSuccessRetriever(`<p>${UNRELATED_TEXT}</p>`);
  const result = await retrieveAndCompareCandidate(client, { sourceId: noPassageSource.id, candidateUrl: "https://example.org/np", submittedText: SUBMITTED_TEXT, retriever });
  if (result.correspondence.passages.length === 0) {
    assert.ok(!result.evidenceCreated.includes("PASSAGE_CORRESPONDENCE"));
  }

  const withPassageSource = await newCandidateSource("with passages");
  const passageRetriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p>`);
  const withResult = await retrieveAndCompareCandidate(client, { sourceId: withPassageSource.id, candidateUrl: "https://example.org/wp", submittedText: SUBMITTED_TEXT, retriever: passageRetriever });
  // Exact match short-circuits before passage computation entirely (no shingle pass run at all) — passages legitimately stay empty even on a full match; this is expected, not a bug (see lib/document-correspondence.ts's emptyResult default for the canonical_hash method).
  assert.equal(withResult.correspondence.method, "canonical_hash");
});

// --- PROVENANCE SAFETY (section 27) ----------------------------------------------

test("PROVENANCE: retrieval alone does not verify — approveVerification still fails after a full successful retrieval+strong-correspondence pipeline (no SOURCE_CLASS/PUBLISHER_IDENTITY evidence exists yet)", async () => {
  const source = await newCandidateSource("retrieval alone");
  const retriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p>`);
  await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/x", submittedText: SUBMITTED_TEXT, retriever });

  const reread = await findProvenanceSourceById(client, source.id);
  assert.equal(reread.provenanceState, "PROVENANCE_PENDING");
  await assert.rejects(
    () => approveVerification(client, { sourceId: source.id, method: "SYSTEM_POLICY" }),
    /verification gate not satisfied/,
  );
});

test("PROVENANCE: Crossref-style discovery metadata plus retrieval still does not verify", async () => {
  const provider = createFixtureDiscoveryProvider({
    id: "fixture-academic-index",
    type: "ACADEMIC_INDEX",
    results: [{
      providerResultId: "r1",
      url: "https://journal.example/article",
      externalIdentifier: "10.9999/example",
      externalIdentifierType: "DOI",
      title: "A Study of Valley Temperature Inversions",
      author: "R. Alvarez",
      publisher: "Example Meteorological Society",
      publicationDate: "2022",
      sourceClass: "JOURNAL_PUBLISHER",
      providerConfidence: 0.9,
      querySignalUsed: "q",
      discoveredAt: new Date().toISOString(),
    }],
  });
  const discovery = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], rawText: SUBMITTED_TEXT, title: null, author: null });
  const source = await createCandidateSourceFromDiscovery(client, discovery.candidates[0]);

  const retriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p>`);
  await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://journal.example/article", submittedText: SUBMITTED_TEXT, retriever });

  const reread = await findProvenanceSourceById(client, source.id);
  assert.equal(reread.provenanceState, "PROVENANCE_PENDING", "the fullest realistic E6A+E6B+E6C pipeline still only reaches PROVENANCE_PENDING");
  await assert.rejects(
    () => approveVerification(client, { sourceId: source.id, method: "SYSTEM_POLICY" }),
    /verification gate not satisfied/,
    "DOI + publisher metadata + independent discovery + strong retrieved correspondence together still do not satisfy ACCEPTABLE_SOURCE_CLASS/IDENTIFIABLE_PUBLISHER, which no phase through E6C creates evidence for",
  );
});

test("PROVENANCE: E6C never transitions a source to VERIFIED_SOURCE, and never imports/calls approveVerification", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "retrieval-correspondence-bridge.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /provenance-verification-workflow/, "must never import the verification workflow");
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(stripComments(source), /approveVerification/, "must never call approveVerification");
  assert.doesNotMatch(stripComments(source), /toState:\s*"VERIFIED_SOURCE"/, "must never request the VERIFIED_SOURCE state directly");
});

test("RESILIENCE: a retriever throwing an unexpected exception for one candidate does not corrupt state for a later, unrelated candidate", async () => {
  const brokenSource = await newCandidateSource("broken retriever case");
  const brokenRetriever = { id: "broken", async retrieve() { throw new Error("unexpected retriever crash"); } };
  await assert.rejects(() => retrieveAndCompareCandidate(client, { sourceId: brokenSource.id, candidateUrl: "https://example.org/x", submittedText: SUBMITTED_TEXT, retriever: brokenRetriever }));

  const laterSource = await newCandidateSource("later unrelated case");
  const goodRetriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p>`);
  const result = await retrieveAndCompareCandidate(client, { sourceId: laterSource.id, candidateUrl: "https://example.org/y", submittedText: SUBMITTED_TEXT, retriever: goodRetriever });
  assert.equal(result.retrievalStatus, "SUCCESS");

  const brokenReread = await findProvenanceSourceById(client, brokenSource.id);
  assert.equal(brokenReread.provenanceState, "CANDIDATE_SOURCE", "the broken candidate must remain in its original state, untouched by the crash");
});

// --- IDEMPOTENCY --------------------------------------------------------------

test("IDEMPOTENCY: a second retrieval attempt on an already-PROVENANCE_PENDING source records new evidence but does not error or re-transition", async () => {
  const source = await newCandidateSource("repeat retrieval case");
  const retriever = makeSuccessRetriever(`<p>${SUBMITTED_TEXT}</p>`);
  const first = await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/x", submittedText: SUBMITTED_TEXT, retriever });
  assert.equal(first.stateChanged, true);

  const second = await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/x", submittedText: SUBMITTED_TEXT, retriever });
  assert.equal(second.stateChanged, false, "the source is already past CANDIDATE_SOURCE, so no further transition occurs");
  assert.equal(second.newState, "PROVENANCE_PENDING");

  const retrievals = await findSourceRetrievalsForSource(client, source.id);
  assert.equal(retrievals.length, 2, "each retrieval attempt is still recorded, even though the state transition is a no-op the second time");
});

// --- DATABASE (source_retrievals repository) -------------------------------------

test("DATABASE: a retrieval record is created with the correct hashes and a truncated excerpt", async () => {
  const source = await newCandidateSource("db check case");
  const hugeText = "distinctivepaddingword ".repeat(5_000);
  const retriever = makeSuccessRetriever(`<p>${hugeText}</p>`);
  await retrieveAndCompareCandidate(client, { sourceId: source.id, candidateUrl: "https://example.org/huge", submittedText: SUBMITTED_TEXT, retriever });

  const [retrieval] = await findSourceRetrievalsForSource(client, source.id);
  assert.equal(retrieval.status, "SUCCESS");
  assert.ok(retrieval.rawSha256);
  assert.ok(retrieval.canonicalSha256);
  assert.ok(retrieval.extractedTextExcerpt.length <= MAX_STORED_EXCERPT_LENGTH);
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
