import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createProvenanceSource } from "../lib/provenance-registry.ts";
import {
  createProvenanceEvidence,
  findEvidenceForSource,
  findEvidenceByType,
} from "../lib/provenance-evidence.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_provenance_evidence.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

async function newSource(title) {
  return createProvenanceSource(client, {
    provenanceState: "CANDIDATE_SOURCE",
    sourceType: "external_reference",
    title,
  });
}

// --- Creation / structure ----------------------------------------------------

test("createProvenanceEvidence creates a row with the given payload, round-tripping through JSON", async () => {
  const source = await newSource("evidence structure test source");
  const evidence = await createProvenanceEvidence(client, {
    sourceId: source.id,
    evidenceType: "URL_ACCESSIBILITY",
    payload: { url: "https://example.org/article", httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true },
    observedAt: "2026-08-01T00:00:00.000Z",
  });
  assert.ok(evidence.id);
  assert.equal(evidence.sourceId, source.id);
  assert.equal(evidence.evidenceType, "URL_ACCESSIBILITY");
  assert.deepEqual(evidence.payload, { url: "https://example.org/article", httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true });
  assert.equal(evidence.observedAt, "2026-08-01T00:00:00.000Z");
  assert.ok(evidence.createdAt);
});

test("createProvenanceEvidence defaults observedAt to now when omitted", async () => {
  const source = await newSource("default observedAt source");
  const before = new Date();
  const evidence = await createProvenanceEvidence(client, {
    sourceId: source.id,
    evidenceType: "METADATA",
    payload: { note: "no explicit observedAt supplied" },
  });
  const observed = new Date(evidence.observedAt);
  assert.ok(!Number.isNaN(observed.getTime()), "observedAt must default to a valid parseable timestamp");
  assert.ok(observed.getTime() >= before.getTime() - 5000, "defaulted observedAt should be close to now");
});

test("source_id foreign key: evidence cannot be created for a nonexistent provenance source", async () => {
  await assert.rejects(() =>
    createProvenanceEvidence(client, {
      sourceId: "does-not-exist",
      evidenceType: "OTHER",
      payload: {},
    }),
  );
});

test("findEvidenceForSource only returns rows for that source (not other sources' evidence)", async () => {
  const sourceA = await newSource("isolation source A");
  const sourceB = await newSource("isolation source B");
  await createProvenanceEvidence(client, { sourceId: sourceA.id, evidenceType: "OTHER", payload: { marker: "A" }, observedAt: "2026-08-01T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: sourceB.id, evidenceType: "OTHER", payload: { marker: "B" }, observedAt: "2026-08-01T00:00:00.000Z" });

  const forA = await findEvidenceForSource(client, sourceA.id);
  const forB = await findEvidenceForSource(client, sourceB.id);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].payload.marker, "A");
  assert.equal(forB.length, 1);
  assert.equal(forB[0].payload.marker, "B");
});

test("findEvidenceForSource returns records in chronological order by observedAt, regardless of insertion order", async () => {
  const source = await newSource("ordering test source");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "OTHER", payload: { seq: 3 }, observedAt: "2026-08-03T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "OTHER", payload: { seq: 1 }, observedAt: "2026-08-01T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "OTHER", payload: { seq: 2 }, observedAt: "2026-08-02T00:00:00.000Z" });

  const evidence = await findEvidenceForSource(client, source.id);
  assert.deepEqual(evidence.map((e) => e.payload.seq), [1, 2, 3]);
});

test("multiple evidence records of different types accumulate for the same source", async () => {
  const source = await newSource("multi-type source");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "EXTERNAL_IDENTIFIER", payload: { identifierType: "DOI", identifierValue: "10.1/abc" }, observedAt: "2026-08-01T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "PUBLISHER_IDENTITY", payload: { publisher: "Example Press" }, observedAt: "2026-08-01T00:01:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "CONTENT_HASH", payload: { candidateHash: "a", externalHash: "a", algorithm: "sha256", match: true }, observedAt: "2026-08-01T00:02:00.000Z" });

  const evidence = await findEvidenceForSource(client, source.id);
  assert.equal(evidence.length, 3);
  assert.deepEqual(evidence.map((e) => e.evidenceType), ["EXTERNAL_IDENTIFIER", "PUBLISHER_IDENTITY", "CONTENT_HASH"]);
});

test("duplicate evidence records (identical type and payload) are both stored, not deduplicated", async () => {
  const source = await newSource("duplicate evidence source");
  const payload = { candidateHash: "same", externalHash: "same", algorithm: "sha256", match: true };
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "CONTENT_HASH", payload, observedAt: "2026-08-01T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "CONTENT_HASH", payload, observedAt: "2026-08-01T00:05:00.000Z" });

  const evidence = await findEvidenceForSource(client, source.id);
  assert.equal(evidence.length, 2, "two separately-observed identical facts must both be persisted as distinct rows");
  assert.notEqual(evidence[0].id, evidence[1].id);
});

test("findEvidenceByType filters to only the requested type", async () => {
  const source = await newSource("filter by type source");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "URL_ACCESSIBILITY", payload: { url: "https://example.org", httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true }, observedAt: "2026-08-01T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "URL_ACCESSIBILITY", payload: { url: "https://example.org", httpStatus: 404, retrievedAt: "2026-09-01T00:00:00.000Z", accessible: false }, observedAt: "2026-09-01T00:00:00.000Z" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "PUBLISHER_IDENTITY", payload: { publisher: "Example Press" }, observedAt: "2026-08-01T00:00:00.000Z" });

  const accessibility = await findEvidenceByType(client, source.id, "URL_ACCESSIBILITY");
  assert.equal(accessibility.length, 2);
  assert.ok(accessibility.every((e) => e.evidenceType === "URL_ACCESSIBILITY"));

  const publisher = await findEvidenceByType(client, source.id, "PUBLISHER_IDENTITY");
  assert.equal(publisher.length, 1);
});

// --- Immutability --------------------------------------------------------------

test("immutability: a later contradicting fact is appended as a new row; the earlier row is left exactly as it was", async () => {
  const source = await newSource("immutability source");
  const first = await createProvenanceEvidence(client, {
    sourceId: source.id,
    evidenceType: "URL_ACCESSIBILITY",
    payload: { url: "https://example.org/paper", httpStatus: 200, retrievedAt: "2026-08-13T00:00:00.000Z", accessible: true },
    observedAt: "2026-08-13T00:00:00.000Z",
  });
  await createProvenanceEvidence(client, {
    sourceId: source.id,
    evidenceType: "URL_ACCESSIBILITY",
    payload: { url: "https://example.org/paper", httpStatus: 404, retrievedAt: "2026-09-01T00:00:00.000Z", accessible: false },
    observedAt: "2026-09-01T00:00:00.000Z",
  });

  const evidence = await findEvidenceForSource(client, source.id);
  assert.equal(evidence.length, 2, "both the original positive and the later negative fact must remain");
  const reread = await findEvidenceByType(client, source.id, "URL_ACCESSIBILITY");
  const original = reread.find((e) => e.id === first.id);
  assert.deepEqual(original.payload, { url: "https://example.org/paper", httpStatus: 200, retrievedAt: "2026-08-13T00:00:00.000Z", accessible: true }, "the original row must be byte-for-byte unchanged");
});

test("structural: lib/provenance-evidence.ts exposes no update or delete operation for evidence rows", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "provenance-evidence.ts"), "utf8");
  assert.doesNotMatch(source, /UPDATE\s+provenance_evidence/i, "provenance_evidence must never be updated in place — a changed fact is always a new row");
  assert.doesNotMatch(source, /DELETE\s+FROM\s+provenance_evidence/i, "provenance_evidence rows must never be deleted by the repository layer (only ON DELETE CASCADE from the parent source may remove them)");
  assert.doesNotMatch(source, /export\s+(async\s+)?function\s+update/i);
  assert.doesNotMatch(source, /export\s+(async\s+)?function\s+delete/i);
});

test("cascade: deleting a provenance_sources row removes its evidence (ON DELETE CASCADE), consistent with provenance_events", async () => {
  const source = await newSource("cascade source");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "OTHER", payload: {}, observedAt: "2026-08-01T00:00:00.000Z" });
  await client.execute({ sql: "DELETE FROM provenance_sources WHERE id = ?", args: [source.id] });
  const remaining = await findEvidenceForSource(client, source.id);
  assert.equal(remaining.length, 0);
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
