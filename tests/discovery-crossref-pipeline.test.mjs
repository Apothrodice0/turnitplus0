import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createCrossrefDiscoveryProvider } from "../lib/discovery-crossref-provider.ts";
import { runDiscovery } from "../lib/discovery-orchestrator.ts";
import { createCandidateSourceFromDiscovery } from "../lib/discovery-provenance-bridge.ts";
import { findProvenanceSourceById } from "../lib/provenance-registry.ts";
import { findEvidenceForSource } from "../lib/provenance-evidence.ts";
import { approveVerification } from "../lib/provenance-verification-workflow.ts";

// This file exercises the full E6A pipeline end to end (signals -> queries
// -> Crossref provider -> normalization -> dedup/rank -> provenance bridge)
// using ONLY the fixture fetcher below — no network access, matching every
// other "pure/local" test in this phase (this phase's own task description,
// section 18A). The one real-network test lives separately in
// tests/discovery-crossref-integration.test.mjs, opt-in only.

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_discovery_crossref_pipeline.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

function crossrefResponse(items) {
  return { status: "ok", "message-type": "work-list", message: { "total-results": items.length, items } };
}

function crossrefItem(overrides = {}) {
  return {
    DOI: "10.5555/pipeline.test",
    URL: "https://doi.org/10.5555/pipeline.test",
    title: ["A Study of Deep-Sea Hydrothermal Vent Chemosynthesis"],
    author: [{ given: "Priya", family: "Nandan" }],
    publisher: "Example Oceanographic Society",
    type: "journal-article",
    score: 90,
    "published-print": { "date-parts": [[2021, 4]] },
    ...overrides,
  };
}

function createMockFetch(steps) {
  const calls = [];
  let index = 0;
  const fetcher = async (url) => {
    calls.push(String(url));
    const step = steps[index];
    index += 1;
    if (!step) throw new Error("mock fetch called more times than configured");
    return new Response(JSON.stringify(step.body ?? crossrefResponse([])), { status: step.status ?? 200, headers: { "content-type": "application/json" } });
  };
  fetcher.calls = calls;
  return fetcher;
}

const DISCOVERY_INPUT = {
  rawText: "Deep-sea researchers surveying a hydrothermal vent field documented dense tube-worm colonies clustered directly above active fluid seepage points. Chemosynthetic bacteria within the worms' trophosome tissue oxidized dissolved sulfide compounds independently of sunlight-driven photosynthesis. The colonies persisted across multiple survey years despite measurable shifts in vent fluid temperature.",
  title: "A Study of Deep-Sea Hydrothermal Vent Chemosynthesis",
  author: "Priya Nandan",
};

// --- CASE A/B/H: Crossref candidate -> CANDIDATE_SOURCE only, never VERIFIED_SOURCE, even with DOI+publisher+title ---

test("CASE A/B/H: a Crossref candidate (DOI + publisher + title) becomes CANDIDATE_SOURCE only, and can never directly reach VERIFIED_SOURCE", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([crossrefItem()]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 1, timeoutMs: 500, retry: { maxAttempts: 1, baseDelayMs: 0 } });

  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...DISCOVERY_INPUT });
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.externalIdentifier, "10.5555/pipeline.test");
  assert.equal(candidate.publisher, "Example Oceanographic Society");
  assert.ok(candidate.title);

  const source = await createCandidateSourceFromDiscovery(client, candidate);
  assert.equal(source.provenanceState, "CANDIDATE_SOURCE", "must be CANDIDATE_SOURCE regardless of how rich the Crossref metadata is");

  const reread = await findProvenanceSourceById(client, source.id);
  assert.equal(reread.provenanceState, "CANDIDATE_SOURCE");

  // Even with DOI + publisher + title all present, a fresh CANDIDATE_SOURCE
  // has no valid direct edge to VERIFIED_SOURCE in Phase E1's graph, and no
  // evidence gate has been satisfied — approveVerification must refuse it.
  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "SYSTEM_POLICY" }));
});

// --- CASE C: no results -> NO_RESULTS, never "no source exists" ------------

test("CASE C: Crossref returning zero results produces NO_RESULTS, not any status implying a source's non-existence", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 1, timeoutMs: 500, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...DISCOVERY_INPUT });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.attempts[0].status, "NO_RESULTS");
});

// --- CASE D: 429 -> RATE_LIMITED --------------------------------------------

test("CASE D: a Crossref 429 response is recorded as RATE_LIMITED", async () => {
  const fetcher = createMockFetch([{ status: 429 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 1, timeoutMs: 500, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...DISCOVERY_INPUT });
  assert.equal(result.attempts[0].status, "RATE_LIMITED");
  assert.equal(result.candidates.length, 0);
});

// --- CASE E: unavailable -> PROVIDER_UNAVAILABLE ----------------------------

test("CASE E: Crossref being unavailable (5xx) is recorded as PROVIDER_UNAVAILABLE, never as proof no source exists", async () => {
  const fetcher = createMockFetch([{ status: 503 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 1, timeoutMs: 500, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...DISCOVERY_INPUT });
  assert.equal(result.attempts[0].status, "PROVIDER_UNAVAILABLE");
});

// --- CASE G: same title, different DOI -> separate candidates ------------------

test("CASE G: two Crossref results sharing a title but carrying different DOIs remain separate candidates", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([
    crossrefItem({ DOI: "10.1/first", title: ["A Shared Title Across Two Different Papers"] }),
    crossrefItem({ DOI: "10.1/second", title: ["A Shared Title Across Two Different Papers"] }),
  ]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 1, timeoutMs: 500, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...DISCOVERY_INPUT });
  assert.equal(result.candidates.length, 2, "differing DOIs must never be merged just because the titles match");
});

// --- Evidence produced by the bridge accurately reflects Crossref as an independent academic-index discovery ---

test("EVIDENCE: a Crossref-sourced candidate produces DISCOVERY_INDEPENDENCE evidence identifying Crossref as an independent academic-index provider", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([crossrefItem({ DOI: "10.5555/evidence.check" })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 1, timeoutMs: 500, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  const result = await runDiscovery({ purpose: "MANUAL_RESEARCH", providers: [provider], ...DISCOVERY_INPUT });
  const source = await createCandidateSourceFromDiscovery(client, result.candidates[0]);
  const evidence = await findEvidenceForSource(client, source.id);

  assert.equal(evidence.length, 1, "discovery alone must create exactly one evidence record — no CONTENT_HASH, no CANONICAL_CORRESPONDENCE, no PUBLISHER_IDENTITY, since none of those were actually established");
  const [independence] = evidence;
  assert.equal(independence.evidenceType, "DISCOVERY_INDEPENDENCE");
  assert.equal(independence.payload.discoveryType, "INDEPENDENT_DISCOVERY");
  assert.equal(independence.payload.independent, true);
  assert.match(independence.payload.basis, /ACADEMIC_INDEX/);
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
