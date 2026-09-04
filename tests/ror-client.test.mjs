import assert from "node:assert/strict";
import test from "node:test";
import { resolveRorInstitution, searchRorInstitutions, __setRorClientFetchForTest } from "../lib/ror-client.ts";

/**
 * The ROR v2 canonical-institution client. Every path is fail-safe: a network
 * error, non-200, withdrawn org, redirect to a different id, or malformed
 * payload yields null / [] — never a throw. All requests use an injected fetch
 * (no real network in tests).
 */

const HARVARD = {
  id: "https://ror.org/03vek6s52",
  status: "active",
  names: [
    { lang: "en", types: ["ror_display", "label"], value: "Harvard University" },
    { lang: "es", types: ["label"], value: "Universidad de Harvard" },
  ],
  locations: [{ geonames_details: { country_code: "US", name: "Cambridge" } }],
  types: ["education", "funder"],
};

test.after(() => __setRorClientFetchForTest(null));

test("resolveRorInstitution: resolves an active org to canonical id + display name + ISO country", async () => {
  __setRorClientFetchForTest(async (url) => {
    assert.match(String(url), /\/v2\/organizations\/03vek6s52$/);
    return new Response(JSON.stringify(HARVARD), { status: 200 });
  });
  const r = await resolveRorInstitution("https://ror.org/03vek6s52");
  assert.deepEqual(r, {
    rorId: "03vek6s52",
    name: "Harvard University",
    countryCode: "US",
    countryName: "United States of America",
    types: ["education", "funder"],
  });
  // accepts a bare id too
  assert.equal((await resolveRorInstitution("03vek6s52")).rorId, "03vek6s52");
});

test("resolveRorInstitution: null for malformed id, bad checksum, 404, 5xx, withdrawn, id-mismatch, and network error", async () => {
  __setRorClientFetchForTest(async () => new Response(JSON.stringify(HARVARD), { status: 200 }));
  assert.equal(await resolveRorInstitution("not-a-ror"), null, "malformed");
  assert.equal(await resolveRorInstitution("03vek6s51"), null, "bad checksum never even fetched");

  __setRorClientFetchForTest(async () => new Response("{}", { status: 404 }));
  assert.equal(await resolveRorInstitution("02mhbdp94"), null, "404");

  __setRorClientFetchForTest(async () => new Response("{}", { status: 503 }));
  assert.equal(await resolveRorInstitution("02mhbdp94"), null, "5xx");

  __setRorClientFetchForTest(async () => new Response(JSON.stringify({ ...HARVARD, id: "https://ror.org/02mhbdp94", status: "withdrawn" }), { status: 200 }));
  assert.equal(await resolveRorInstitution("02mhbdp94"), null, "withdrawn org");

  __setRorClientFetchForTest(async () => new Response(JSON.stringify(HARVARD), { status: 200 })); // requested 02mhbdp94, got 03vek6s52
  assert.equal(await resolveRorInstitution("02mhbdp94"), null, "id mismatch (redirect/alias)");

  __setRorClientFetchForTest(async () => { throw new Error("ECONNRESET"); });
  assert.equal(await resolveRorInstitution("02mhbdp94"), null, "network error");
});

test("resolveRorInstitution: a hung request is bounded by the timeout", async () => {
  __setRorClientFetchForTest((url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const t0 = Date.now();
  const r = await resolveRorInstitution("03vek6s52", { timeoutMs: 150 });
  assert.equal(r, null);
  assert.ok(Date.now() - t0 < 2000, "returned promptly after the timeout, did not hang");
});

test("searchRorInstitutions: maps items to canonical hits, dedupes, bounds, [] on failure", async () => {
  __setRorClientFetchForTest(async (url) => {
    assert.match(String(url), /\/v2\/organizations\?query=/);
    return new Response(JSON.stringify({ number_of_results: 2, items: [HARVARD, HARVARD, { id: "https://ror.org/02mhbdp94", status: "active", names: [{ types: ["ror_display"], value: "MIT" }], locations: [{ geonames_details: { country_code: "US" } }], types: [] }] }), { status: 200 });
  });
  const hits = await searchRorInstitutions("Harvard");
  assert.equal(hits.length, 2, "deduped by rorId");
  assert.equal(hits[0].name, "Harvard University");

  assert.deepEqual(await searchRorInstitutions("x"), [], "query too short -> no fetch");
  __setRorClientFetchForTest(async () => new Response("nope", { status: 500 }));
  assert.deepEqual(await searchRorInstitutions("anything"), []);
});
