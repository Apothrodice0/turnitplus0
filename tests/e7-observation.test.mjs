import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createFixtureDiscoveryProvider } from "../lib/discovery-providers.ts";
import { createDiscoveryProviderRegistry, createContentRetrieverRegistry } from "../lib/source-discovery-registries.ts";
import { findProvenanceSourceById } from "../lib/provenance-registry.ts";
import { extractTextFromHtml, HTML_EXTRACTOR_VERSION } from "../lib/html-text-extraction.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { createE7ExperimentId, runE7ObservationForDocument, classifyE7Outcome, summarizeDocumentE7Outcome } from "../lib/e7-observation.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_e7_observation.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

// --- STRUCTURAL SAFETY (grep-based, matching tests/provenance-scoring-invariance.test.mjs's own convention) ---

function importLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:import|export)\b.*\bfrom\b/.test(line))
    .join("\n");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const E7_FILES = ["lib/e7-observation.ts", "lib/e7-archive-adapter.ts", "lib/e7-pilot-sampling.ts"];

test("none of the E7 files import lib/provenance-verification-workflow.ts, and none call approveVerification/rejectVerification/recordDispute/recordRetraction/reaffirmVerification", () => {
  for (const relativePath of E7_FILES) {
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
  "app/similarity-worker.ts",
  "app/ai-detector-worker.ts",
  "app/web-check-worker.ts",
  "app/page.tsx",
  "lib/report-types.ts",
  "lib/similarity-core.ts",
  "lib/similarity-enrichment.ts",
  "lib/receipt-pdf.ts",
  "app/api/reports/route.ts",
  "app/api/reports/[id]/route.ts",
  "app/reports/[id]/page.tsx",
  "app/reports/[id]/report-detail-shell.tsx",
  "components/report/similarity-report-papers.tsx",
  "components/report/ai-report.tsx",
];

test("no live scoring/report-path or user-upload-path file imports any E7 module — E7 is not wired into any live route", () => {
  const offenders = [];
  for (const relativePath of SCORING_PATH_FILES) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const imports = importLines(fs.readFileSync(fullPath, "utf8"));
    if (/\be7-(observation|archive-adapter|pilot-sampling)/.test(imports)) offenders.push(relativePath);
  }
  assert.deepEqual(offenders, [], `these live-path files import an E7 module, which must not happen: ${offenders.join(", ")}`);
});

test("lib/e7-observation.ts never runs archive text through a real network provider — its own runner (tools/e7-run-pilot.ts) only ever passes text the adapter already resolved locally", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-observation.ts"), "utf8");
  assert.doesNotMatch(importLines(source), /discovery-crossref-provider|http-content-retriever/, "the observation wrapper must go through the registries, not hard-code a real provider/retriever");
});

// --- FUNCTIONAL (fixture-only, no network) ------------------------------------

const SUBMITTED_TEXT = [
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded stopover site in a coastal wetland reserve.",
  "Birds using the stopover site gained significantly more body mass per day than birds recorded at three other established stopover locations nearby.",
  "Habitat quality assessments suggested the reserve's dense insect populations were the primary driver of the elevated refueling rate observed there.",
].join(" ");

function crossrefResultFixture(overrides = {}) {
  return {
    providerResultId: "r1",
    url: "https://journal.example/article",
    externalIdentifier: "10.1234/e7-fixture",
    externalIdentifierType: "DOI",
    title: "A Study of Migratory Songbird Stopover Sites",
    author: "T. Nakamura",
    publisher: "Example Ornithological Society",
    publicationDate: "2023",
    sourceClass: "JOURNAL_PUBLISHER",
    providerConfidence: 0.85,
    querySignalUsed: "q",
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

function successRetriever(id, html) {
  return {
    id,
    async retrieve({ url }) {
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

function timeoutRetriever(id) {
  return {
    id,
    async retrieve() {
      return { originalUrl: "n/a", finalUrl: null, httpStatus: null, contentType: null, retrievedAt: new Date().toISOString(), rawSha256: null, extractedText: null, canonicalSha256: null, extractorVersion: null, status: "TIMEOUT", errorMessage: "simulated timeout" };
    },
  };
}

const FIXTURE_METADATA = {
  id: "fixture-archive-doc-e7",
  title: "Fixture Archive Document",
  sourceType: "Publication",
  originalSimilarity: 12,
  wordCount: 500,
  uniqueShingleCount: 470,
};

test("CASE A: strong-correspondence fixture -> candidate is classified STRONG_CORRESPONDENCE, LIKELY_RELEVANT_CANDIDATE, or VERIFICATION_ELIGIBLE, never silently as anything weaker", async () => {
  const experimentId = createE7ExperimentId();
  const discoveryProviders = createDiscoveryProviderRegistry([
    createFixtureDiscoveryProvider({ id: "crossref-fixture", type: "ACADEMIC_INDEX", results: [crossrefResultFixture()] }),
  ]);
  const retrievers = createContentRetrieverRegistry([successRetriever("fixture-retriever", `<p>${SUBMITTED_TEXT}</p>`)]);

  const observation = await runE7ObservationForDocument(
    client,
    { experimentId, metadata: FIXTURE_METADATA, documentCohort: "bootstrap", submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: "fixture-retriever" },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(observation.experimentId, experimentId);
  assert.equal(observation.documentId, FIXTURE_METADATA.id);
  assert.equal(observation.candidatesDiscovered, 1);
  assert.equal(observation.candidates.length, 1);
  assert.ok(
    ["STRONG_CORRESPONDENCE", "LIKELY_RELEVANT_CANDIDATE", "VERIFICATION_ELIGIBLE"].includes(observation.candidates[0].e7Outcome),
    `unexpected e7Outcome for a strong-correspondence fixture: ${observation.candidates[0].e7Outcome}`,
  );
  assert.equal(observation.documentE7Outcome, observation.candidates[0].e7Outcome);

  // Candidate source remains unverified no matter what E7 observed.
  const source = await findProvenanceSourceById(client, observation.candidates[0].sourceId);
  assert.notEqual(source.provenanceState, "VERIFIED_SOURCE");
});

test("CASE B: no discovery results -> documentE7Outcome is NO_CANDIDATE", async () => {
  const experimentId = createE7ExperimentId();
  const discoveryProviders = createDiscoveryProviderRegistry([
    createFixtureDiscoveryProvider({ id: "crossref-empty", type: "ACADEMIC_INDEX", results: [] }),
  ]);
  const retrievers = createContentRetrieverRegistry([successRetriever("fixture-retriever", "<p>unused</p>")]);

  const observation = await runE7ObservationForDocument(
    client,
    { experimentId, metadata: { ...FIXTURE_METADATA, id: "fixture-archive-doc-e7-nocand" }, documentCohort: "bootstrap", submittedText: SUBMITTED_TEXT, providerIds: ["crossref-empty"], retrieverId: "fixture-retriever" },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(observation.candidatesDiscovered, 0);
  assert.equal(observation.documentE7Outcome, "NO_CANDIDATE");
});

test("CASE C: one candidate's retrieval failure does not stop the experiment — a second candidate for the same document still gets processed and classified", async () => {
  const experimentId = createE7ExperimentId();
  const discoveryProviders = createDiscoveryProviderRegistry([
    createFixtureDiscoveryProvider({
      id: "crossref-mixed",
      type: "ACADEMIC_INDEX",
      results: [
        crossrefResultFixture({ providerResultId: "bad", url: "https://journal.example/unreachable", externalIdentifier: "10.1234/unreachable" }),
        crossrefResultFixture({ providerResultId: "good", url: "https://journal.example/reachable", externalIdentifier: "10.1234/reachable" }),
      ],
    }),
  ]);
  const retrievers = createContentRetrieverRegistry([
    {
      id: "mixed-retriever",
      async retrieve({ url }) {
        if (url === "https://journal.example/unreachable") return timeoutRetriever("mixed-retriever").retrieve();
        return successRetriever("mixed-retriever", `<p>${SUBMITTED_TEXT}</p>`).retrieve({ url });
      },
    },
  ]);

  const observation = await runE7ObservationForDocument(
    client,
    { experimentId, metadata: { ...FIXTURE_METADATA, id: "fixture-archive-doc-e7-mixed" }, documentCohort: "turnitin_import", submittedText: SUBMITTED_TEXT, providerIds: ["crossref-mixed"], retrieverId: "mixed-retriever" },
    { maxCandidatesProcessed: 5, maxRetrievals: 5 },
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(observation.candidatesDiscovered, 2);
  assert.equal(observation.candidates.length, 2, "the failing candidate must not prevent the second candidate from being recorded");
  const outcomes = observation.candidates.map((c) => c.e7Outcome);
  assert.ok(outcomes.includes("INACCESSIBLE_SOURCE"), `expected one INACCESSIBLE_SOURCE outcome, got: ${outcomes.join(", ")}`);
});

// --- REGRESSION: found during the first real 11-document pilot run ----------
// lib/source-discovery-workflow.ts's own candidateResults array puts every
// SKIPPED_BY_LIMIT candidate BEFORE the ones actually processed. A naive
// "first candidate in the array" summary therefore reports SKIPPED_BY_LIMIT
// for a document even when Crossref found more than maxCandidatesProcessed
// results and the ones actually retrieved all got a real, informative
// outcome. 9 of the 11 real pilot documents hit this exact shape.

test("summarizeDocumentE7Outcome ignores array order and never reports SKIPPED_BY_LIMIT while any processed candidate has a real outcome", () => {
  const candidates = [
    { e7Outcome: "SKIPPED_BY_LIMIT" },
    { e7Outcome: "SKIPPED_BY_LIMIT" },
    { e7Outcome: "SKIPPED_BY_LIMIT" },
    { e7Outcome: "INACCESSIBLE_SOURCE" },
    { e7Outcome: "UNRELATED_RETRIEVED_CONTENT" },
  ];
  assert.equal(summarizeDocumentE7Outcome(candidates), "UNRELATED_RETRIEVED_CONTENT", "UNRELATED_RETRIEVED_CONTENT outranks INACCESSIBLE_SOURCE, and both outrank SKIPPED_BY_LIMIT regardless of position");
});

test("summarizeDocumentE7Outcome still surfaces a strong/eligible processed outcome even when it is not the first element", () => {
  const candidates = [
    { e7Outcome: "SKIPPED_BY_LIMIT" },
    { e7Outcome: "INACCESSIBLE_SOURCE" },
    { e7Outcome: "VERIFICATION_ELIGIBLE" },
  ];
  assert.equal(summarizeDocumentE7Outcome(candidates), "VERIFICATION_ELIGIBLE");
});

test("summarizeDocumentE7Outcome falls back to SKIPPED_BY_LIMIT only when literally every candidate was skipped", () => {
  const candidates = [{ e7Outcome: "SKIPPED_BY_LIMIT" }, { e7Outcome: "SKIPPED_BY_LIMIT" }];
  assert.equal(summarizeDocumentE7Outcome(candidates), "SKIPPED_BY_LIMIT");
});

test("summarizeDocumentE7Outcome returns NO_CANDIDATE for an empty candidate list", () => {
  assert.equal(summarizeDocumentE7Outcome([]), "NO_CANDIDATE");
});

test("CASE D (end-to-end regression): more candidates discovered than the processing budget — documentE7Outcome reflects the processed candidates, not the skipped ones", async () => {
  const experimentId = createE7ExperimentId();
  // 7 discovered, budget of 3 processed -> 4 SKIPPED_BY_LIMIT entries occupy
  // the front of candidateResults, exactly the real pilot's shape.
  const results = Array.from({ length: 7 }, (_, i) =>
    crossrefResultFixture({ providerResultId: `r${i}`, url: `https://journal.example/article-${i}`, externalIdentifier: `10.1234/case-d-${i}` }),
  );
  const discoveryProviders = createDiscoveryProviderRegistry([createFixtureDiscoveryProvider({ id: "crossref-budget", type: "ACADEMIC_INDEX", results })]);
  const retrievers = createContentRetrieverRegistry([successRetriever("fixture-retriever", "<p>Completely unrelated retrieved content sharing nothing with the submitted document.</p>")]);

  const observation = await runE7ObservationForDocument(
    client,
    { experimentId, metadata: { ...FIXTURE_METADATA, id: "fixture-archive-doc-e7-budget" }, documentCohort: "bootstrap", submittedText: SUBMITTED_TEXT, providerIds: ["crossref-budget"], retrieverId: "fixture-retriever" },
    { maxCandidatesProcessed: 3, maxRetrievals: 3 },
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(observation.candidatesDiscovered, 7);
  assert.equal(observation.candidatesProcessed, 3);
  assert.equal(observation.candidatesSkipped, 4);
  assert.notEqual(observation.documentE7Outcome, "SKIPPED_BY_LIMIT", "the 4 skipped candidates must not mask the 3 processed candidates' real outcome");
  assert.equal(observation.documentE7Outcome, "UNRELATED_RETRIEVED_CONTENT");
});

test("the observation record never contains the raw submitted document text — only bounded/aggregate correspondence fields", async () => {
  const experimentId = createE7ExperimentId();
  const discoveryProviders = createDiscoveryProviderRegistry([
    createFixtureDiscoveryProvider({ id: "crossref-privacy", type: "ACADEMIC_INDEX", results: [crossrefResultFixture({ providerResultId: "p", externalIdentifier: "10.1234/privacy" })] }),
  ]);
  const retrievers = createContentRetrieverRegistry([successRetriever("fixture-retriever", `<p>${SUBMITTED_TEXT}</p>`)]);

  const observation = await runE7ObservationForDocument(
    client,
    { experimentId, metadata: { ...FIXTURE_METADATA, id: "fixture-archive-doc-e7-privacy" }, documentCohort: "bootstrap", submittedText: SUBMITTED_TEXT, providerIds: ["crossref-privacy"], retrieverId: "fixture-retriever" },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  const serialized = JSON.stringify(observation);
  assert.ok(!serialized.includes(SUBMITTED_TEXT), "the full submitted text must never appear in the observation record");
  assert.ok(!serialized.includes("Ornithologists tracking migratory songbirds"), "no verbatim sentence from the submitted text may leak into the observation record");
});

test("classifyE7Outcome maps every CandidateProcessingStatus to its documented E7 outcome class explicitly (no silent fallthrough)", () => {
  const expected = {
    DISCOVERED: "DISCOVERED_NOT_RETRIEVED",
    RETRIEVED: "WEAK_CORRESPONDENCE",
    CORRESPONDENCE_WEAK: "WEAK_CORRESPONDENCE",
    RETRIEVAL_FAILED: "INACCESSIBLE_SOURCE",
    NO_CORRESPONDENCE: "UNRELATED_RETRIEVED_CONTENT",
    SKIPPED_BY_LIMIT: "SKIPPED_BY_LIMIT",
    DUPLICATE: "DUPLICATE_CANDIDATE",
    PROVIDER_ERROR: "PROCESSING_ERROR",
  };
  for (const [status, expectedOutcome] of Object.entries(expected)) {
    const outcome = classifyE7Outcome({ status, correspondence: null, verificationEligible: false });
    assert.equal(outcome, expectedOutcome, `status ${status} mapped to ${outcome}, expected ${expectedOutcome}`);
  }

  // CORRESPONDENCE_FOUND branches on strongCorrespondence/verificationEligible.
  assert.equal(classifyE7Outcome({ status: "CORRESPONDENCE_FOUND", correspondence: { strongCorrespondence: false }, verificationEligible: false }), "STRONG_CORRESPONDENCE");
  assert.equal(classifyE7Outcome({ status: "CORRESPONDENCE_FOUND", correspondence: { strongCorrespondence: true }, verificationEligible: false }), "LIKELY_RELEVANT_CANDIDATE");
  assert.equal(classifyE7Outcome({ status: "CORRESPONDENCE_FOUND", correspondence: { strongCorrespondence: true }, verificationEligible: true }), "VERIFICATION_ELIGIBLE");
});

test("createE7ExperimentId matches the documented E7-YYYYMMDD-HHMMSS-<hex> format and is unique across calls", () => {
  const id = createE7ExperimentId();
  assert.match(id, /^E7-\d{8}-\d{6}-[0-9a-f]{6}$/);
  const id2 = createE7ExperimentId();
  assert.notEqual(id, id2);
});
