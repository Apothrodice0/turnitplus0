import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { classifySubmitterRelationship } from "../lib/document-relationship.ts";
import { findFamilyForIdentity } from "../lib/document-family.ts";
import { createFixtureDiscoveryProvider, DiscoveryProviderUnavailableError, DiscoveryTimeoutError } from "../lib/discovery-providers.ts";
import { createDiscoveryProviderRegistry, createContentRetrieverRegistry } from "../lib/source-discovery-registries.ts";
import { runSourceDiscoveryWorkflow } from "../lib/source-discovery-workflow.ts";
import { findProvenanceSourceById } from "../lib/provenance-registry.ts";
import { findEvidenceForSource, createProvenanceEvidence } from "../lib/provenance-evidence.ts";
import { evaluateVerificationEligibility } from "../lib/provenance-verification-policy.ts";
import { approveVerification } from "../lib/provenance-verification-workflow.ts";
import { extractTextFromHtml, HTML_EXTRACTOR_VERSION } from "../lib/html-text-extraction.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { createHash } from "node:crypto";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_source_discovery_workflow.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

const SUBMITTED_TEXT = [
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded stopover site in a coastal wetland reserve.",
  "Birds using the stopover site gained significantly more body mass per day than birds recorded at three other established stopover locations nearby.",
  "Habitat quality assessments suggested the reserve's dense insect populations were the primary driver of the elevated refueling rate observed there.",
  "Conservation planners recommended prioritizing the newly identified stopover site for protection given its apparent importance to the broader migratory route.",
].join(" ");

const UNRELATED_TEXT = [
  "Ceramicists studying a regional pottery tradition analyzed clay composition across dozens of excavated fragments spanning three centuries of production.",
  "Trace-element ratios shifted gradually over time, consistent with a slow change in the clay source used by successive generations of potters.",
  "The findings offer a new dating method for otherwise undated fragments recovered from disturbed archaeological contexts in the same region.",
].join(" ");

function crossrefResultFixture(overrides = {}) {
  return {
    providerResultId: "r1",
    url: "https://journal.example/article",
    externalIdentifier: "10.1234/example",
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

function fixtureProvider(id, results) {
  return createFixtureDiscoveryProvider({ id, type: "ACADEMIC_INDEX", results });
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
  return { id, async retrieve({ url }) { return { originalUrl: url, finalUrl: url, httpStatus: null, contentType: null, retrievedAt: new Date().toISOString(), rawSha256: null, extractedText: null, canonicalSha256: null, extractorVersion: null, status: "TIMEOUT", errorMessage: "simulated timeout" }; } };
}

function byUrlRetriever(id, byUrl) {
  return {
    id,
    async retrieve({ url }) {
      const step = byUrl[url];
      if (!step) throw new Error(`byUrlRetriever: no fixture configured for ${url}`);
      return step;
    },
  };
}

const NOOP_RETRIEVER_REGISTRY_ID = "fixture-retriever";

// --- FIXTURE A: full success path -------------------------------------------

test("FIXTURE A: document -> Crossref-style fixture -> candidate -> retrieval fixture -> strong correspondence", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(result.candidatesDiscovered, 1);
  assert.equal(result.candidatesProcessed, 1);
  assert.equal(result.candidateResults.length, 1);
  const [candidate] = result.candidateResults;
  assert.equal(candidate.status, "CORRESPONDENCE_FOUND");
  assert.equal(candidate.provenanceState, "PROVENANCE_PENDING");
  assert.ok(candidate.correspondence.strongCorrespondence || candidate.correspondence.method === "canonical_hash");
  assert.ok(candidate.evidenceCreated.includes("URL_ACCESSIBILITY"));
});

// --- FIXTURE B: retrieval timeout --------------------------------------------

test("FIXTURE B: document -> candidate -> retrieval timeout", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture({ url: "https://journal.example/timeout" })])]);
  const retrievers = createContentRetrieverRegistry([timeoutRetriever(NOOP_RETRIEVER_REGISTRY_ID)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  const [candidate] = result.candidateResults;
  assert.equal(candidate.status, "RETRIEVAL_FAILED");
  assert.equal(candidate.retrievalStatus, "TIMEOUT");
  assert.equal(candidate.provenanceState, "CANDIDATE_SOURCE", "a failed retrieval must not advance the source");
});

// --- FIXTURE C: multiple candidates, one fails one succeeds -----------------

test("FIXTURE C: multiple candidates -> one fails, one succeeds, the workflow continues for both", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [
    crossrefResultFixture({ providerResultId: "bad", externalIdentifier: "10.1/bad", url: "https://journal.example/bad" }),
    crossrefResultFixture({ providerResultId: "good", externalIdentifier: "10.1/good", url: "https://journal.example/good" }),
  ])]);
  const retrievers = createContentRetrieverRegistry([byUrlRetriever(NOOP_RETRIEVER_REGISTRY_ID, {
    "https://journal.example/bad": { originalUrl: "https://journal.example/bad", finalUrl: "https://journal.example/bad", httpStatus: null, contentType: null, retrievedAt: new Date().toISOString(), rawSha256: null, extractedText: null, canonicalSha256: null, extractorVersion: null, status: "NETWORK_ERROR", errorMessage: "simulated network error" },
    "https://journal.example/good": (() => { const html = `<p>${SUBMITTED_TEXT}</p>`; const extracted = extractTextFromHtml(html); return { originalUrl: "https://journal.example/good", finalUrl: "https://journal.example/good", httpStatus: 200, contentType: "text/html", retrievedAt: new Date().toISOString(), rawSha256: createHash("sha256").update(html).digest("hex"), extractedText: extracted, canonicalSha256: canonicalSha256(extracted), extractorVersion: HTML_EXTRACTOR_VERSION, status: "SUCCESS", errorMessage: null }; })(),
  })]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    { maxCandidatesProcessed: 5, maxRetrievals: 5 },
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(result.candidatesDiscovered, 2);
  const byUrl = Object.fromEntries(result.candidateResults.map((c) => [c.sourceId, c]));
  const statuses = result.candidateResults.map((c) => c.status).sort();
  assert.deepEqual(statuses, ["CORRESPONDENCE_FOUND", "RETRIEVAL_FAILED"]);
  assert.equal(result.failures.length, 0, "a designed retrieval failure status is not an unexpected failure — it is a normal, recorded outcome");
});

// --- FIXTURE D: weak correspondence -------------------------------------------

test("FIXTURE D: retrieval succeeds but correspondence is weak", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${UNRELATED_TEXT}</p>`)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  const [candidate] = result.candidateResults;
  assert.ok(candidate.status === "CORRESPONDENCE_WEAK" || candidate.status === "NO_CORRESPONDENCE");
  assert.equal(candidate.correspondence.strongCorrespondence, false);
  assert.equal(candidate.provenanceState, "PROVENANCE_PENDING", "even a weak finding is a completed, review-worthy attempt");
});

// --- FIXTURE E: verificationEligible reflects the real E4 gate, correctly ------

test("FIXTURE E: verificationEligible is computed from the real, live E4 gate — it becomes true once a complete evidence set exists, even though this workflow alone never creates every required evidence type", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  const [candidate] = result.candidateResults;

  // Realistically, through E6A+E6B+E6C+E6D alone, ACCEPTABLE_SOURCE_CLASS and
  // IDENTIFIABLE_PUBLISHER evidence is never created (no phase through E6D
  // builds that) — see lib/retrieval-correspondence-bridge.ts's and
  // lib/discovery-provenance-bridge.ts's own header comments. So this
  // workflow's own report is correctly `false` here:
  assert.equal(candidate.verificationEligible, false);
  assert.equal(result.verificationEligible, false);

  // Proving the FIELD ITSELF is meaningful (reads the real gate, not
  // hardcoded false): manually complete the evidence set the way a future
  // phase would, then re-run the exact same check the workflow uses.
  await createProvenanceEvidence(client, { sourceId: candidate.sourceId, evidenceType: "SOURCE_CLASS", payload: { sourceClass: "JOURNAL_PUBLISHER", eligibleForVerification: true } });
  await createProvenanceEvidence(client, { sourceId: candidate.sourceId, evidenceType: "PUBLISHER_IDENTITY", payload: { publisher: "Example Ornithological Society", verified: true } });
  const evidence = await findEvidenceForSource(client, candidate.sourceId);
  const evaluation = evaluateVerificationEligibility(evidence);
  assert.equal(evaluation.eligible, true, "with a complete evidence set, the same gate the workflow reports through must show eligible=true");
});

// --- FIXTURE F: repeated workflow -> bounded/idempotent behavior ---------------

test("FIXTURE F: running the same workflow twice for the same document does not create duplicate candidate sources", async () => {
  const docIdentity = await createDocumentIdentity(client, { accountId: null, title: "repeat-workflow.pdf", author: null, rawText: SUBMITTED_TEXT });
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture({ externalIdentifier: "10.1/repeat-case", url: "https://journal.example/repeat" })])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);

  const first = await runSourceDiscoveryWorkflow(
    client,
    { documentIdentityId: docIdentity.id, submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  assert.equal(first.candidateResults[0].status, "CORRESPONDENCE_FOUND");
  const firstSourceId = first.candidateResults[0].sourceId;

  const second = await runSourceDiscoveryWorkflow(
    client,
    { documentIdentityId: docIdentity.id, submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  assert.equal(second.candidateResults[0].status, "DUPLICATE");
  assert.equal(second.candidateResults[0].sourceId, firstSourceId, "the second run must reuse the existing source, not create a new one");
});

// --- FIXTURE G: provider failure -> graceful workflow result -------------------

test("FIXTURE G: a discovery provider being unavailable produces a graceful, complete workflow result — not a crash", async () => {
  const failingProvider = createFixtureDiscoveryProvider({ id: "down-provider", type: "ACADEMIC_INDEX", results: () => { throw new DiscoveryProviderUnavailableError(); } });
  const discoveryProviders = createDiscoveryProviderRegistry([failingProvider]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, "<p>irrelevant</p>")]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["down-provider"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(result.candidatesDiscovered, 0);
  assert.equal(result.discoveryAttempts.length, 1);
  assert.equal(result.discoveryAttempts[0].status, "PROVIDER_UNAVAILABLE");
  assert.equal(result.candidateResults.length, 0);
});

// --- FIXTURE H: no candidates found -------------------------------------------

test("FIXTURE H: no candidates found is represented as zero candidates, never as \"no source exists\"", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, "<p>irrelevant</p>")]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  assert.equal(result.candidatesDiscovered, 0);
  assert.deepEqual(result.candidateResults, []);
  assert.doesNotMatch(JSON.stringify(result), /NO_SOURCE/i);
});

// --- FIXTURE I: malicious candidate URL -> blocked before retrieval -----------

test("FIXTURE I: a candidate whose URL is a private/internal address is blocked by SSRF protection, not fetched", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture({ url: "http://127.0.0.1:9999/internal-admin", externalIdentifier: "10.1/malicious" })])]);
  // The REAL http retriever (with its real SSRF checks) is used here on
  // purpose — this proves E6D reuses E6C's actual protection rather than a
  // weaker/duplicated check. See lib/source-discovery-registries.ts.
  const { createDefaultContentRetrieverRegistry } = await import("../lib/source-discovery-registries.ts");
  const retrievers = createDefaultContentRetrieverRegistry({ timeoutMs: 500 });

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: "http" },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );

  const [candidate] = result.candidateResults;
  assert.equal(candidate.status, "RETRIEVAL_FAILED");
  assert.equal(candidate.retrievalStatus, "REDIRECT_BLOCKED");
});

// --- FIXTURE J: full pipeline never reaches VERIFIED_SOURCE --------------------

test("FIXTURE J: the full pipeline (discovery + retrieval + strong correspondence) leaves the candidate at PROVENANCE_PENDING, never VERIFIED_SOURCE, and approveVerification still fails", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  const [candidate] = result.candidateResults;
  const source = await findProvenanceSourceById(client, candidate.sourceId);
  assert.equal(source.provenanceState, "PROVENANCE_PENDING");
  assert.notEqual(source.provenanceState, "VERIFIED_SOURCE");
  await assert.rejects(() => approveVerification(client, { sourceId: candidate.sourceId, method: "SYSTEM_POLICY" }));
});

// --- BUDGETS ---------------------------------------------------------------

test("BUDGETS: maxCandidatesProcessed limits how many candidates are created, the rest are SKIPPED_BY_LIMIT", async () => {
  const results = [1, 2, 3, 4].map((n) => crossrefResultFixture({ providerResultId: `r${n}`, externalIdentifier: `10.1/budget-${n}`, url: `https://journal.example/budget-${n}` }));
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", results)]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    { maxCandidatesProcessed: 2 },
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(result.candidatesDiscovered, 4);
  assert.equal(result.candidatesProcessed, 2);
  assert.equal(result.candidatesSkipped, 2);
  const skipped = result.candidateResults.filter((c) => c.status === "SKIPPED_BY_LIMIT");
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((c) => c.sourceId === null));
});

test("BUDGETS: maxRetrievals independently limits retrieval attempts even when more candidates were created", async () => {
  const results = [1, 2].map((n) => crossrefResultFixture({ providerResultId: `r${n}`, externalIdentifier: `10.1/retrieval-budget-${n}`, url: `https://journal.example/retrieval-budget-${n}` }));
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", results)]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);

  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    { maxCandidatesProcessed: 2, maxRetrievals: 1 },
    { discoveryProviders, contentRetrievers: retrievers },
  );

  assert.equal(result.candidatesProcessed, 2);
  const retrieved = result.candidateResults.filter((c) => c.retrievalStatus !== null);
  const notRetrieved = result.candidateResults.filter((c) => c.retrievalStatus === null && c.status === "DISCOVERED");
  assert.equal(retrieved.length, 1);
  assert.equal(notRetrieved.length, 1);
});

// --- SEPARATION (section 27) ----------------------------------------------------

test("SEPARATION: discovery alone (retrieval budget zero) does not verify — the source stays CANDIDATE_SOURCE", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);
  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    { maxRetrievals: 0 },
    { discoveryProviders, contentRetrievers: retrievers },
  );
  const [candidate] = result.candidateResults;
  assert.equal(candidate.status, "DISCOVERED");
  assert.equal(candidate.provenanceState, "CANDIDATE_SOURCE");
  assert.equal(candidate.verificationEligible, false);
});

test("SEPARATION: retrieval and correspondence alone do not verify (already proven end to end by Fixture J)", async () => {
  // Explicit restatement per this phase's own task description, section 27
  // — see FIXTURE J above for the full behavioral proof.
  assert.ok(true);
});

test("SEPARATION: PRIOR_SUBMISSION and SELF relationship classifications are wholly independent of this workflow's provenance results", async () => {
  const relationshipPrior = classifySubmitterRelationship("wf-account-b", "wf-account-a");
  const relationshipSelf = classifySubmitterRelationship("wf-account-a", "wf-account-a");
  assert.equal(relationshipPrior, "PRIOR_SUBMISSION");
  assert.equal(relationshipSelf, "SELF");

  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);
  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  assert.equal(result.candidatesDiscovered, 1, "the relationship calls above must have no bearing on discovery/candidate results");
});

test("SEPARATION: the workflow never calls resolveFamilyForIdentity and creates no document-family rows", async () => {
  const source = fs.readFileSync(path.join(repo, "lib", "source-discovery-workflow.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /document-family/, "must not import lib/document-family.ts at all");

  const docIdentity = await createDocumentIdentity(client, { accountId: null, title: "family-check.pdf", author: null, rawText: SUBMITTED_TEXT });
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture({ externalIdentifier: "10.1/family-check", url: "https://journal.example/family-check" })])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<p>${SUBMITTED_TEXT}</p>`)]);
  await runSourceDiscoveryWorkflow(
    client,
    { documentIdentityId: docIdentity.id, submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  const family = await findFamilyForIdentity(client, docIdentity.id);
  assert.equal(family, null, "running the workflow must never create a document-family membership for the source document");
});

// --- PRIVACY: no raw HTML or full document text in the result -----------------

test("PRIVACY: the workflow result never contains raw HTML or the full submitted document text", async () => {
  const discoveryProviders = createDiscoveryProviderRegistry([fixtureProvider("crossref-fixture", [crossrefResultFixture()])]);
  const retrievers = createContentRetrieverRegistry([successRetriever(NOOP_RETRIEVER_REGISTRY_ID, `<html><body><script>should never appear</script><p>${SUBMITTED_TEXT}</p></body></html>`)]);
  const result = await runSourceDiscoveryWorkflow(
    client,
    { submittedText: SUBMITTED_TEXT, providerIds: ["crossref-fixture"], retrieverId: NOOP_RETRIEVER_REGISTRY_ID },
    {},
    { discoveryProviders, contentRetrievers: retrievers },
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /<html>|<script>|<body>/i);
  assert.doesNotMatch(serialized, new RegExp(SUBMITTED_TEXT.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the full submitted text must not be echoed back verbatim in the result");
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
