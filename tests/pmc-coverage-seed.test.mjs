import assert from "node:assert/strict";
import test from "node:test";
import { freshDb, makeText, seedCorpus, seedPmcDoc } from "./helpers/pmc-coverage-shadow.mjs";
import { PMC_COMPACT_FINGERPRINT_VERSION, PMC_DF_BAND_POLICY_VERSION } from "../lib/pmc-coverage/constants.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { tokens } from "../lib/similarity-core.ts";

/**
 * Seed determinism + idempotency (lib/pmc-coverage/seed.ts).
 */

async function snapshot(client) {
  const docs = await client.execute("SELECT pmc_id, canonical_sha256, body_words, version, is_retracted FROM pmc_coverage_documents ORDER BY pmc_id");
  const fps = await client.execute("SELECT pmc_id, fingerprint_hash, fingerprint_version FROM pmc_document_fingerprints ORDER BY pmc_id, fingerprint_hash");
  const df = await client.execute("SELECT shingle_hash, df_bucket, policy_version FROM pmc_hash_df_bands ORDER BY shingle_hash");
  return {
    docs: docs.rows.map((r) => ({ ...r })),
    fps: fps.rows.map((r) => ({ ...r })),
    df: df.rows.map((r) => ({ ...r })),
  };
}

const CORPUS = [
  { pmcId: "PMC0001", text: makeText("seed-a", 500) },
  { pmcId: "PMC0002", text: makeText("seed-b", 700) },
  { pmcId: "PMC0003", text: `${makeText("shared-head", 200)} ${makeText("shared-block", 80)} ${makeText("seed-c-tail", 200)}` },
  { pmcId: "PMC0004", text: `${makeText("seed-d-head", 200)} ${makeText("shared-block", 80)} ${makeText("seed-d-tail", 200)}` },
];

test("seed is deterministic: two fresh seeds of the same corpus produce byte-identical rows", async () => {
  const a = await freshDb("seed-det-a");
  const b = await freshDb("seed-det-b");
  try {
    await seedCorpus(a.client, CORPUS);
    await seedCorpus(b.client, CORPUS);
    assert.deepEqual(await snapshot(a.client), await snapshot(b.client));
  } finally { a.cleanup(); b.cleanup(); }
});

test("seed is idempotent: re-running reports UNCHANGED and does not alter any row", async () => {
  const { client, cleanup } = await freshDb("seed-idem");
  try {
    const first = await seedCorpus(client, CORPUS);
    assert.ok(first.documents.every((d) => d.status === "SEEDED"));
    const before = await snapshot(client);

    const second = await seedCorpus(client, CORPUS);
    assert.ok(second.documents.every((d) => d.status === "UNCHANGED"), "a re-run is observably a no-op");
    assert.deepEqual(await snapshot(client), before, "no row changed on re-seed");

    // fingerprint row count is stable (INSERT OR IGNORE)
    const n1 = Number((await client.execute("SELECT COUNT(*) AS n FROM pmc_document_fingerprints")).rows[0].n);
    await seedCorpus(client, CORPUS);
    const n2 = Number((await client.execute("SELECT COUNT(*) AS n FROM pmc_document_fingerprints")).rows[0].n);
    assert.equal(n1, n2);
  } finally { cleanup(); }
});

test("seed is versioned: rows carry the frozen fingerprint / df-band policy versions", async () => {
  const { client, cleanup } = await freshDb("seed-versioned");
  try {
    // A 60-word block shared across 14 docs => its 5-grams reach DF 14 >= 13 and
    // are persisted as DF bands.
    const sharedBlock = makeText("versioned-shared", 60);
    const docs = Array.from({ length: 14 }, (_, i) => ({
      pmcId: `PMC10${String(i).padStart(2, "0")}`,
      text: `${makeText(`v-uniq-${i}`, 250)} ${sharedBlock} ${makeText(`v-tail-${i}`, 150)}`,
    }));
    const result = await seedCorpus(client, docs);
    assert.equal(result.fingerprintVersion, PMC_COMPACT_FINGERPRINT_VERSION);
    const fpv = await client.execute("SELECT DISTINCT fingerprint_version FROM pmc_document_fingerprints");
    assert.deepEqual(fpv.rows.map((r) => r.fingerprint_version), [PMC_COMPACT_FINGERPRINT_VERSION]);

    assert.ok(result.dfBands.persistedRows > 0, "the widely-shared block produced DF-band rows");
    const dfv = await client.execute("SELECT DISTINCT policy_version FROM pmc_hash_df_bands");
    assert.deepEqual(dfv.rows.map((r) => r.policy_version), [PMC_DF_BAND_POLICY_VERSION]);
    const buckets = await client.execute("SELECT DISTINCT df_bucket FROM pmc_hash_df_bands ORDER BY df_bucket");
    for (const r of buckets.rows) assert.ok(Number(r.df_bucket) >= 13, "every persisted bucket is DF >= 13");
  } finally { cleanup(); }
});

test("seed updates a changed document and re-derives its fingerprints", async () => {
  const { client, cleanup } = await freshDb("seed-update");
  try {
    await seedPmcDoc(client, { pmcId: "PMC7", text: makeText("v1-text", 400) });
    const before = await client.execute("SELECT canonical_sha256 FROM pmc_coverage_documents WHERE pmc_id = 'PMC7'");
    const r = await seedPmcDoc(client, { pmcId: "PMC7", text: makeText("v2-different-text", 400) });
    assert.equal(r.status, "UPDATED");
    const after = await client.execute("SELECT canonical_sha256, body_words FROM pmc_coverage_documents WHERE pmc_id = 'PMC7'");
    assert.notEqual(String(after.rows[0].canonical_sha256), String(before.rows[0].canonical_sha256));
    assert.equal(String(after.rows[0].canonical_sha256), canonicalSha256(makeText("v2-different-text", 400)));
    assert.equal(Number(after.rows[0].body_words), tokens(makeText("v2-different-text", 400)).length);
  } finally { cleanup(); }
});

test("seed marks retracted documents as tombstones", async () => {
  const { client, cleanup } = await freshDb("seed-retracted");
  try {
    await seedCorpus(client, [
      { pmcId: "PMC0009", text: makeText("live", 400) },
      { pmcId: "PMC0010", text: makeText("retracted", 400), isRetracted: true },
    ]);
    const rows = await client.execute("SELECT pmc_id, is_retracted FROM pmc_coverage_documents ORDER BY pmc_id");
    assert.equal(Number(rows.rows.find((r) => r.pmc_id === "PMC0010").is_retracted), 1);
    assert.equal(Number(rows.rows.find((r) => r.pmc_id === "PMC0009").is_retracted), 0);
  } finally { cleanup(); }
});
