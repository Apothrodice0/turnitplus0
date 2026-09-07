import { GEONAMES_CITIES15000_TSV, GEONAMES_CITIES15000_ROW_COUNT } from "./geonames-cities-data";
import { isoCountryByAlpha2 } from "./iso-3166-1-countries";

/**
 * Canonical city resolution + search, backed by the bundled GeoNames cities15000
 * dataset (populated places, population >= 15,000; see
 * lib/geonames-cities-data.ts). This is the AUTHORITATIVE server-side layer for
 * A2 signup / account-settings: the client sends a numeric GeoNames id and the
 * server re-resolves it here — the client-supplied city name is NEVER trusted or
 * stored.
 *
 * SERVER-ONLY. The backing data string is ~1 MB; nothing client-side may import
 * this module (tests/account-identity-signup.test.mjs pins that).
 */

export type GeonamesCity = {
  geonamesId: number;
  /** GeoNames display name. */
  name: string;
  /** ISO 3166-1 alpha-2 (guaranteed officially assigned — non-ISO rows were dropped at build time). */
  countryCode: string;
  /** GeoNames admin1 code (e.g. a US state / a subdivision), or "" — for disambiguation display only. */
  admin1: string;
  population: number;
};

type Parsed = { byId: Map<number, GeonamesCity>; all: GeonamesCity[] };

let parsed: Parsed | null = null;

function parse(): Parsed {
  if (parsed) return parsed;
  const byId = new Map<number, GeonamesCity>();
  const all: GeonamesCity[] = [];
  for (const line of GEONAMES_CITIES15000_TSV.split("\n")) {
    if (!line) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    const tab3 = line.indexOf("\t", tab2 + 1);
    const tab4 = line.indexOf("\t", tab3 + 1);
    if (tab1 < 0 || tab2 < 0 || tab3 < 0 || tab4 < 0) continue;
    const geonamesId = Number(line.slice(0, tab1));
    const name = line.slice(tab1 + 1, tab2);
    const countryCode = line.slice(tab2 + 1, tab3);
    const admin1 = line.slice(tab3 + 1, tab4);
    const population = Number(line.slice(tab4 + 1));
    if (!Number.isInteger(geonamesId) || geonamesId <= 0) continue;
    const city: GeonamesCity = { geonamesId, name, countryCode, admin1, population: Number.isFinite(population) ? population : 0 };
    byId.set(geonamesId, city);
    all.push(city);
  }
  parsed = { byId, all };
  return parsed;
}

/** How many cities the bundled dataset holds (for tests / diagnostics). */
export const GEONAMES_CITY_COUNT = GEONAMES_CITIES15000_ROW_COUNT;

/**
 * AUTHORITATIVE re-resolution of a client-supplied GeoNames city id. Returns the
 * canonical city (with its own country code) or null when the id is not a known
 * populated place in the bundled dataset. The caller must additionally check
 * that `.countryCode` equals the account's residence country.
 */
export function resolveGeonamesCity(id: unknown): GeonamesCity | null {
  const n = typeof id === "string" ? Number(id.trim()) : id;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  return parse().byId.get(n) ?? null;
}

/** Diacritic- and case-insensitive fold for search matching (strips U+0300..U+036F combining marks). */
const COMBINING_MARKS_RE = new RegExp("[\\u0300-\\u036f]", "g");
function fold(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS_RE, "").toLowerCase().trim();
}

export type CitySearchHit = {
  geonamesId: number;
  name: string;
  countryCode: string;
  /** English country name, for display. */
  countryName: string;
  admin1: string;
  population: number;
};

function toHit(c: GeonamesCity): CitySearchHit {
  return {
    geonamesId: c.geonamesId,
    name: c.name,
    countryCode: c.countryCode,
    countryName: isoCountryByAlpha2(c.countryCode)?.name ?? c.countryCode,
    admin1: c.admin1,
    population: c.population,
  };
}

/**
 * Prefix-first, then substring, name search — optionally scoped to one ISO
 * country. Ranked by (prefix match, population). Bounded result set. Used only
 * to POPULATE the client's select; the returned ids are still re-resolved
 * server-side on submit.
 */
export function searchCities(query: unknown, opts: { countryCode?: string | null; limit?: number } = {}): CitySearchHit[] {
  if (typeof query !== "string") return [];
  const q = fold(query);
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);
  const country = typeof opts.countryCode === "string" && opts.countryCode.trim().length === 2
    ? opts.countryCode.trim().toUpperCase()
    : null;

  const prefix: GeonamesCity[] = [];
  const substr: GeonamesCity[] = [];
  for (const c of parse().all) {
    if (country && c.countryCode !== country) continue;
    const folded = fold(c.name);
    if (folded.startsWith(q)) prefix.push(c);
    else if (folded.includes(q)) substr.push(c);
    if (prefix.length >= limit * 4) break; // already-population-sorted; enough
  }
  const rank = (a: GeonamesCity, b: GeonamesCity) => b.population - a.population || a.geonamesId - b.geonamesId;
  prefix.sort(rank);
  substr.sort(rank);
  return [...prefix, ...substr].slice(0, limit).map(toHit);
}
