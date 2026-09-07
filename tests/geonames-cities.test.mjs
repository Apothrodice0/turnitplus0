import assert from "node:assert/strict";
import test from "node:test";
import { resolveGeonamesCity, searchCities, GEONAMES_CITY_COUNT } from "../lib/geonames-cities.ts";
import { GEONAMES_CITIES15000_ROW_COUNT } from "../lib/geonames-cities-data.ts";
import { isoCountryByAlpha2 } from "../lib/iso-3166-1-countries.ts";

/**
 * The bundled GeoNames cities15000 canonical-city layer. Deterministic, offline,
 * no network. This is the authoritative server-side re-resolver for A2 signup.
 */

test("dataset is well-formed: sane row count, every searched row carries a real ISO alpha-2 country", () => {
  assert.ok(GEONAMES_CITY_COUNT > 20_000 && GEONAMES_CITY_COUNT < 60_000, `count ${GEONAMES_CITY_COUNT}`);
  assert.equal(GEONAMES_CITY_COUNT, GEONAMES_CITIES15000_ROW_COUNT);

  // Every hit across a broad set of substrings resolves and has a real ISO country.
  const seen = new Set();
  let checked = 0;
  for (const q of ["a", "e", "i", "o", "u", "an", "in", "san", "new", "port", "ville", "burg", "grad"]) {
    for (const hit of searchCities(q, { limit: 50 })) {
      assert.ok(isoCountryByAlpha2(hit.countryCode), `${hit.countryCode} must be a real ISO alpha-2`);
      const re = resolveGeonamesCity(hit.geonamesId);
      assert.ok(re && re.geonamesId === hit.geonamesId, "the search hit re-resolves by id");
      assert.equal(re.countryCode, hit.countryCode);
      seen.add(hit.geonamesId);
      checked += 1;
    }
  }
  assert.ok(checked >= 200 && seen.size >= 100, `checked ${checked}, distinct ${seen.size}`);
});

test("resolveGeonamesCity: known ids, string ids, rejects unknown / malformed", () => {
  const nyc = resolveGeonamesCity(5128581);
  assert.equal(nyc.name, "New York City");
  assert.equal(nyc.countryCode, "US");
  assert.equal(resolveGeonamesCity("2643743").name, "London");
  assert.equal(resolveGeonamesCity(999999999), null);
  assert.equal(resolveGeonamesCity(-1), null);
  assert.equal(resolveGeonamesCity(0), null);
  assert.equal(resolveGeonamesCity(1.5), null);
  assert.equal(resolveGeonamesCity("abc"), null);
  assert.equal(resolveGeonamesCity("'; DROP TABLE users; --"), null);
  assert.equal(resolveGeonamesCity(null), null);
});

test("searchCities: prefix-first, population-ranked, country-scoped, bounded", () => {
  const london = searchCities("london", { limit: 5 });
  assert.equal(london[0].name, "London");
  assert.equal(london[0].countryCode, "GB"); // GB London outranks CA London by population

  const parisFr = searchCities("paris", { countryCode: "FR", limit: 10 });
  assert.ok(parisFr.length > 0 && parisFr.every((c) => c.countryCode === "FR"));

  assert.ok(searchCities("q", {}).length === 0, "single char -> no results");
  assert.ok(searchCities("zzzzzznotacity", {}).length === 0);
  assert.ok(searchCities("a", { limit: 999 }).length <= 50, "result set is hard-capped");

  // diacritic-insensitive
  assert.ok(searchCities("zurich", {}).some((c) => c.name.toLowerCase().includes("rich")));
});
