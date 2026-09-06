import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { resetRateForTest } from "../lib/rate-limit.js";

/**
 * Slice 2E, Phase 3 + security + Phase 10 compatibility — POST/GET
 * /api/archive/match. Synthetic archive, real shipped static config
 * (public/data/*.json); CI-safe.
 */

const repo = path.resolve(".");
const dbFile = path.join(repo, "test_archive_server_route.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repo, "drizzle"));

const uniq = (ns, i) => `zq${ns}x${i.toString(36)}w`;
const distinctive = (ns, n) => Array.from({ length: n }, (_, i) => uniq(ns, i)).join(" ");
const SHARED_RUN = distinctive(7000, 140);

const DOCS = [
  { id: "rt-a", title: "Route Source A", body: `${distinctive(1, 260)} ${SHARED_RUN} ${distinctive(2, 260)}` },
  { id: "rt-b", title: "Route Peer B", body: `${distinctive(3, 420)} ${SHARED_RUN} ${distinctive(4, 420)}` },
  { id: "rt-c", title: "Route Unrelated C", body: distinctive(5, 700) },
];
for (const [order, d] of DOCS.entries()) {
  const r = await seedArchiveDocument(
    client,
    { archiveArticleId: d.id, title: d.title, originalSimilarity: null, text: d.body, archiveOrder: order },
    { corpusVersion: "route-test-v1", firstSeenAt: "2020-01-01 00:00:00" },
  );
  assert.equal(r.status, "SEEDED");
}
await rebuildArchiveScalableIndex(client);
client.close();

const route = await import("../app/api/archive/match/route.ts");

test.after(() => {
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});

function req(method, body, ip = "route-test-ip") {
  return new Request("http://localhost/api/archive/match", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function get(ip = "route-test-get") { await resetRateForTest(ip); return route.GET(req("GET", undefined, ip)); }
async function post(body, ip = "route-test-post") { await resetRateForTest(ip); return route.POST(req("POST", body, ip)); }

const PARTIAL_TEXT = `Framing one. ${distinctive(3, 420)} ${SHARED_RUN} An unrelated tail sentence here.`;

test("Phase 4: GET reports the flag — default OFF when the env var is absent", async () => {
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { archiveServerSide: false });
});

test("Phase 4: GET reports OFF for any value that is not exactly \"true\"", async () => {
  for (const v of ["1", "TRUE", "yes", "", "false"]) {
    process.env.ARCHIVE_SERVER_SIDE_ENABLED = v;
    assert.equal((await (await get()).json()).archiveServerSide, false, `value ${JSON.stringify(v)}`);
  }
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});

test("Phase 4: GET reports ON only for the exact string \"true\"", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  assert.equal((await (await get()).json()).archiveServerSide, true);
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});

test("Phase 3: POST is 404 (inert) while the flag is off", async () => {
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  const res = await post({ text: PARTIAL_TEXT });
  assert.equal(res.status, 404);
});

test("Phase 3: POST validates the body — bad JSON, missing text, oversize text", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  const badJson = await route.POST(new Request("http://localhost/api/archive/match", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "v1" }, body: "{not json",
  }));
  await resetRateForTest("v1");
  assert.equal(badJson.status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: "   " })).status, 400);
  assert.equal((await post({ text: "x".repeat(1_000_001) })).status, 413);
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});

test("Phase 3 + 7: POST returns the frozen worker-result shape for a partial match", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  const res = await post({ text: PARTIAL_TEXT });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.result && typeof body.result === "object");
  const r = body.result;
  for (const k of ["wordCount", "databaseSize", "excludedDocuments", "matchedWordCount", "archiveMatchedPositions",
    "score", "scoreBand", "riskStatus", "riskTarget", "riskCutoff", "riskCalibration", "features", "corpusVersion",
    "sources", "repeats"]) {
    assert.ok(k in r, `missing field ${k}`);
  }
  assert.ok(["Low", "Moderate", "High"].includes(r.scoreBand));
  assert.ok(["Elevated", "Lower"].includes(r.riskStatus));
  assert.ok(Array.isArray(r.sources) && r.sources.length >= 1, "the shared 140-word run should produce a source");
  assert.ok(r.score > 0, "a real partial copy scores > 0");
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});

test("Phase 7: POST no-match text scores 0 with no sources", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  const res = await post({ text: `${distinctive(99001, 400)} nothing here overlaps the archive at all` });
  const r = (await res.json()).result;
  assert.equal(r.score, 0);
  assert.deepEqual(r.sources, []);
  assert.deepEqual(r.archiveMatchedPositions, []);
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});

test("SECURITY: the response body exposes NO internal identifiers or diagnostics", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  const res = await post({ text: PARTIAL_TEXT });
  const raw = await res.text();
  for (const forbidden of [
    "representation_id", "representationId", "co_representation_id", "coRepresentationId",
    "policy_version", "policyVersion", "archive-cosource-v1", "archiveDiscovery", "cosource",
    "sourceIndex", "fingerprint_hash", "fingerprintHash", "shingle_hash", "archive_order",
    "selfExcluded", "anchorCount", "neighborCount", "rt-a", "rt-b", "device", "passport",
  ]) {
    assert.equal(raw.includes(forbidden), false, `response leaked "${forbidden}"`);
  }
  // Public source handles (titles) ARE part of the product contract and may appear.
  const r = JSON.parse(raw).result;
  assert.ok(r.sources.every((s) => typeof s.name === "string" && !("sourceIndex" in s)));
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});

test("Phase 10: the framed result carries everything the report persistence path needs", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  const r = (await (await post({ text: PARTIAL_TEXT })).json()).result;
  // app/api/reports/route.ts persists: archive_score (= report.archiveScore = result.score),
  // score_band (= result.scoreBand), word_count, and the whole payload_json blob
  // (archiveMatchedPositions / sources / features / repeats / riskCalibration ...).
  assert.equal(typeof r.score, "number");
  assert.ok(Number.isFinite(r.score));
  assert.equal(typeof r.scoreBand, "string");
  assert.ok(Array.isArray(r.archiveMatchedPositions));
  assert.ok(Array.isArray(r.sources));
  assert.equal(typeof r.features.detectedLanguage, "string");
  assert.equal(typeof r.riskCalibration.auc, "number");
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
});
