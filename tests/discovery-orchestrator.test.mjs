import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { runDiscovery } from "../lib/discovery-orchestrator.ts";
import {
  createFixtureDiscoveryProvider,
  DiscoveryTimeoutError,
  DiscoveryRateLimitError,
  DiscoveryProviderUnavailableError,
} from "../lib/discovery-providers.ts";
import { DISCOVERY_ATTEMPT_STATUSES } from "../lib/discovery-types.ts";
import { findDiscoveryAttemptsForRequest, findDiscoveryAttemptsForDocumentIdentity, recordDiscoveryAttempt } from "../lib/discovery-repository.ts";
import { createCandidateSourceFromDiscovery } from "../lib/discovery-provenance-bridge.ts";
import { findProvenanceSourceById, findProvenanceSourcesByState } from "../lib/provenance-registry.ts";
import { findEvidenceForSource } from "../lib/provenance-evidence.ts";
import { approveVerification } from "../lib/provenance-verification-workflow.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_discovery_orchestrator.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

const NO_TEXT_SIGNAL_INPUT = { rawText: "irrelevant filler text the a an is was for this fixture", title: null, author: null };

function okProvider(id, results) {
  return createFixtureDiscoveryProvider({ id, type: "WEB_SEARCH", results });
}

function resultFixture(overrides = {}) {
  return {
    providerResultId: "r1",
    url: "https://example.org/article",
    externalIdentifier: null,
    externalIdentifierType: null,
    title: "An Article",
    author: null,
    publisher: null,
    publicationDate: null,
    sourceClass: null,
    providerConfidence: 0.5,
    querySignalUsed: "q",
    discoveredAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

// --- FAILURE HANDLING --------------------------------------------------------

test("FAILURE: a provider timeout is recorded as TIMEOUT, not as an unhandled rejection", async () => {
  const timingOut = createFixtureDiscoveryProvider({ id: "slow", type: "WEB_SEARCH", results: () => { throw new DiscoveryTimeoutError(); } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [timingOut], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, "TIMEOUT");
  assert.equal(result.candidates.length, 0);
});

test("FAILURE: an unavailable provider is recorded as PROVIDER_UNAVAILABLE", async () => {
  const down = createFixtureDiscoveryProvider({ id: "down", type: "WEB_SEARCH", results: () => { throw new DiscoveryProviderUnavailableError(); } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [down], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.attempts[0].status, "PROVIDER_UNAVAILABLE");
});

test("FAILURE: a rate-limited provider is recorded as RATE_LIMITED", async () => {
  const limited = createFixtureDiscoveryProvider({ id: "limited", type: "WEB_SEARCH", results: () => { throw new DiscoveryRateLimitError(); } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [limited], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.attempts[0].status, "RATE_LIMITED");
});

test("FAILURE: a provider returning zero results is NO_RESULTS, not an error", async () => {
  const empty = okProvider("empty", []);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [empty], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.attempts[0].status, "NO_RESULTS");
  assert.equal(result.attempts[0].errorMessage, null);
});

test("FAILURE: a malformed candidate mixed with valid ones is dropped, not fatal", async () => {
  const mixed = okProvider("mixed", [resultFixture(), { garbage: true }, null]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [mixed], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.attempts[0].status, "OK");
  assert.equal(result.attempts[0].resultCount, 1);
  assert.equal(result.candidates.length, 1);
});

test("FAILURE: one provider failing does not prevent the others from being tried", async () => {
  const good1 = okProvider("good-1", [resultFixture({ providerResultId: "g1", url: "https://a.example/1" })]);
  const broken = createFixtureDiscoveryProvider({ id: "broken", type: "WEB_SEARCH", results: () => { throw new Error("boom"); } });
  const good2 = okProvider("good-2", [resultFixture({ providerResultId: "g2", url: "https://b.example/2" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [good1, broken, good2], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map((a) => a.status), ["OK", "ERROR", "OK"]);
  assert.equal(result.candidates.length, 2);
});

test("FAILURE: provider disagreement (contradictory metadata for the same identifier) does not crash and produces one deterministic candidate", async () => {
  const providerA = okProvider("a", [resultFixture({ externalIdentifier: "10.1/shared", externalIdentifierType: "DOI", title: "Title From A" })]);
  const providerB = okProvider("b", [resultFixture({ externalIdentifier: "10.1/shared", externalIdentifierType: "DOI", title: "Title From B", author: "Someone" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [providerA, providerB], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, "Title From A", "first non-null value in provider order wins, deterministically");
  assert.equal(result.candidates[0].author, "Someone");
});

// --- SECURITY / POISONING ------------------------------------------------------

test("CASE A: a candidate discovered via a user-provided URL is recorded with independence=USER_SUPPLIED and can never directly become VERIFIED_SOURCE", async () => {
  const userProvided = createFixtureDiscoveryProvider({
    id: "user-provided-url",
    type: "USER_SUPPLIED",
    results: [resultFixture({ url: "https://blog.example/my-copy", providerResultId: "user-1" })],
  });
  const result = await runDiscovery({ purpose: "SUBMISSION_CORRESPONDENCE", providers: [userProvided], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].independence, "USER_SUPPLIED");

  const source = await createCandidateSourceFromDiscovery(client, result.candidates[0]);
  assert.equal(source.provenanceState, "CANDIDATE_SOURCE");

  const evidence = await findEvidenceForSource(client, source.id);
  const independenceEvidence = evidence.find((e) => e.evidenceType === "DISCOVERY_INDEPENDENCE");
  assert.equal(independenceEvidence.payload.discoveryType, "USER_SUPPLIED");
  assert.equal(independenceEvidence.payload.independent, false);

  // CANDIDATE_SOURCE has no direct edge to VERIFIED_SOURCE in Phase E1's
  // graph regardless of evidence — this is the structural guarantee that a
  // freshly-discovered candidate (of any independence) can never skip the
  // PROVENANCE_PENDING review step, let alone actual verification.
  await assert.rejects(
    () => approveVerification(client, { sourceId: source.id, method: "SYSTEM_POLICY" }),
    /not an allowed provenance transition/,
  );
});

test("CASE B: two providers returning the same URL produce one normalized candidate", async () => {
  const providerA = okProvider("a", [resultFixture({ url: "https://example.org/paper?utm_source=x", providerResultId: "a1" })]);
  const providerB = okProvider("b", [resultFixture({ url: "https://example.org/paper/", providerResultId: "b1" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [providerA, providerB], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].contributingProviders.length, 2);
});

test("CASE C: the same title at different URLs/documents remains separate candidates", async () => {
  const providerA = okProvider("a", [resultFixture({ url: "https://example.org/one", title: "Shared Title", providerResultId: "a1" })]);
  const providerB = okProvider("b", [resultFixture({ url: "https://another.example/two", title: "Shared Title", providerResultId: "b1" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [providerA, providerB], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.candidates.length, 2);
});

test("CASE D: a suspicious/aggregator-class candidate is still recorded — discovery never pre-filters by source-class eligibility", async () => {
  const aggregator = okProvider("aggregator", [resultFixture({ url: "https://free-papers.example/mirror", sourceClass: "AGGREGATOR", providerResultId: "agg-1" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [aggregator], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceClass, "AGGREGATOR");

  // Discovery records it; the source-class eligibility judgment itself is
  // entirely lib/provenance-verification-policy.ts's (E4) job, not this
  // phase's — creating a CANDIDATE_SOURCE from it must still succeed here.
  const source = await createCandidateSourceFromDiscovery(client, result.candidates[0]);
  assert.equal(source.provenanceState, "CANDIDATE_SOURCE");
});

test("CASE E: no provider returning anything is NO_CANDIDATE, never represented as \"no source exists\"", async () => {
  const empty1 = okProvider("empty-1", []);
  const empty2 = okProvider("empty-2", []);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [empty1, empty2], ...NO_TEXT_SIGNAL_INPUT });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.attempts.every((a) => a.status === "NO_RESULTS"));
  assert.ok(
    !DISCOVERY_ATTEMPT_STATUSES.some((s) => /NO_SOURCE/i.test(s)),
    "the controlled vocabulary must not contain any status implying a source's non-existence was established",
  );
});

// --- SEPARATION ----------------------------------------------------------------

test("SEPARATION: running discovery end to end never creates or changes any provenance_sources row on its own", async () => {
  const before = await findProvenanceSourcesByState(client, "CANDIDATE_SOURCE", 1000);
  const provider = okProvider("sep-provider", [resultFixture({ url: "https://example.org/separation-check" })]);
  await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], client, ...NO_TEXT_SIGNAL_INPUT });
  const after = await findProvenanceSourcesByState(client, "CANDIDATE_SOURCE", 1000);
  assert.equal(after.length, before.length, "runDiscovery alone must never write to provenance_sources — only the separate, explicitly-called bridge does");
});

// Only real import statements are checked, not whole source text — several
// discovery-*.ts files legitimately name other lib/document-family-
// config.ts-style files in doc-comment prose (e.g. "same disclaimer as
// lib/document-family-config.ts's..."), which a plain substring search
// would false-positive on; see tests/provenance-scoring-invariance.test.mjs's
// importLines() for the same, established fix.
function importLines(source) {
  return source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}

test("SEPARATION: no discovery module imports lib/document-family.ts or lib/document-relationship.ts, and neither of those import any discovery module", () => {
  const discoveryFiles = fs.readdirSync(path.join(repo, "lib")).filter((f) => f.startsWith("discovery-"));
  for (const file of discoveryFiles) {
    const imports = importLines(fs.readFileSync(path.join(repo, "lib", file), "utf8"));
    assert.doesNotMatch(imports, /document-family|document-relationship/, `${file} must not import the document-family/relationship modules`);
  }
  for (const file of ["document-family.ts", "document-relationship.ts"]) {
    const imports = importLines(fs.readFileSync(path.join(repo, "lib", file), "utf8"));
    assert.doesNotMatch(imports, /discovery-/, `${file} must not import any discovery module`);
  }
});

// --- NO NETWORK ------------------------------------------------------------------

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("NO NETWORK: no discovery module contains any network primitive", () => {
  const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|http\.request|https\.request|net\.connect|dns\./;
  const discoveryFiles = fs.readdirSync(path.join(repo, "lib")).filter((f) => f.startsWith("discovery-") || f === "source-class.ts");
  assert.ok(discoveryFiles.length >= 9, "the discovery file list itself may be stale");
  for (const file of discoveryFiles) {
    const source = stripComments(fs.readFileSync(path.join(repo, "lib", file), "utf8"));
    assert.doesNotMatch(source, forbidden, `${file} must contain zero network primitives in this phase`);
  }
});

// --- DATABASE (discovery_attempts repository) -----------------------------------

test("DATABASE: runDiscovery persists one discovery_attempts row per provider when a client is supplied", async () => {
  const providerA = okProvider("db-a", [resultFixture({ url: "https://example.org/db-a" })]);
  const providerB = okProvider("db-b", []);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [providerA, providerB], client, ...NO_TEXT_SIGNAL_INPUT });
  const rows = await findDiscoveryAttemptsForRequest(client, result.requestId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.status).sort(), ["NO_RESULTS", "OK"]);
});

test("DATABASE: recordDiscoveryAttempt round-trips queriesUsed/rawResults through JSON without loss", async () => {
  const attempt = await recordDiscoveryAttempt(client, {
    requestId: "manual-req-1",
    purpose: "MANUAL_RESEARCH",
    providerId: "manual-provider",
    providerType: "WEB_SEARCH",
    queriesUsed: ["alpha query", "beta query"],
    status: "OK",
    resultCount: 1,
    rawResults: [resultFixture()],
    requestedAt: "2026-08-13T00:00:00.000Z",
  });
  assert.deepEqual(attempt.queriesUsed, ["alpha query", "beta query"]);
  assert.deepEqual(attempt.rawResults, [resultFixture()]);
});

test("DATABASE: findDiscoveryAttemptsForDocumentIdentity scopes strictly to the given document identity", async () => {
  const docX = await createDocumentIdentity(client, { accountId: null, title: "doc-x.pdf", author: null, rawText: "Entomologists surveying leaf-litter beetle diversity across an elevational gradient recorded a sharp species turnover above eighteen hundred meters." });
  const docY = await createDocumentIdentity(client, { accountId: null, title: "doc-y.pdf", author: null, rawText: "Glaciologists measuring firn compaction rates in an alpine accumulation zone found compaction slowed markedly below negative fifteen degrees." });

  await recordDiscoveryAttempt(client, {
    requestId: "scoped-req-1",
    documentIdentityId: docX.id,
    purpose: "SUBMISSION_CORRESPONDENCE",
    providerId: "p",
    providerType: "WEB_SEARCH",
    queriesUsed: ["q"],
    status: "NO_RESULTS",
    resultCount: 0,
    requestedAt: "2026-08-13T00:00:00.000Z",
  });
  await recordDiscoveryAttempt(client, {
    requestId: "scoped-req-2",
    documentIdentityId: docY.id,
    purpose: "SUBMISSION_CORRESPONDENCE",
    providerId: "p",
    providerType: "WEB_SEARCH",
    queriesUsed: ["q"],
    status: "NO_RESULTS",
    resultCount: 0,
    requestedAt: "2026-08-13T00:00:00.000Z",
  });
  const forX = await findDiscoveryAttemptsForDocumentIdentity(client, docX.id);
  assert.equal(forX.length, 1);
  assert.equal(forX[0].requestId, "scoped-req-1");
});

// --- PROVENANCE BRIDGE (createCandidateSourceFromDiscovery) --------------------

test("BRIDGE: an independently-discovered candidate produces DISCOVERY_INDEPENDENCE evidence with independent=true", async () => {
  const provider = okProvider("independent-provider", [resultFixture({ url: "https://example.org/independent", externalIdentifier: "10.1/independent", externalIdentifierType: "DOI" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...NO_TEXT_SIGNAL_INPUT });
  const source = await createCandidateSourceFromDiscovery(client, result.candidates[0]);
  const evidence = await findEvidenceForSource(client, source.id);
  const independenceEvidence = evidence.find((e) => e.evidenceType === "DISCOVERY_INDEPENDENCE");
  assert.equal(independenceEvidence.payload.discoveryType, "INDEPENDENT_DISCOVERY");
  assert.equal(independenceEvidence.payload.independent, true);
});

test("BRIDGE: createCandidateSourceFromDiscovery always starts at CANDIDATE_SOURCE, regardless of candidate content", async () => {
  const provider = okProvider("bridge-provider", [resultFixture({ url: "https://example.org/bridge" })]);
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...NO_TEXT_SIGNAL_INPUT });
  const source = await createCandidateSourceFromDiscovery(client, result.candidates[0]);
  const reread = await findProvenanceSourceById(client, source.id);
  assert.equal(reread.provenanceState, "CANDIDATE_SOURCE");
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
