import { normalizeRorId } from "./account-identity";
import { isoCountryByAlpha2 } from "./iso-3166-1-countries";

/**
 * Canonical institution resolution + search, backed by the public ROR v2 API
 * (https://ror.org, data licensed CC0 — no API key or account required).
 *
 * This is the AUTHORITATIVE server-side layer for A2 signup / account-settings:
 * the client sends a ROR id and the server re-resolves it here against the live
 * registry. The client-supplied institution name is NEVER trusted or stored —
 * only the checksum-valid ROR id body (lib/account-identity.ts) is persisted,
 * and the resolved display name is returned to the caller for confirmation only.
 *
 * SERVER-ONLY (makes outbound HTTP). Every function is fail-safe: a network
 * error, timeout, non-200, withdrawn org, or malformed payload yields null / []
 * — never a throw, never a partial write upstream.
 */

const ROR_V2_BASE = "https://api.ror.org/v2/organizations";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 20;

export type RorInstitution = {
  /** canonical 9-char ROR id body (no URL), checksum-valid */
  rorId: string;
  /** ROR display name */
  name: string;
  /** ISO 3166-1 alpha-2 of the org's primary location, or null if ROR has no ISO country for it */
  countryCode: string | null;
  /** English country name for display, or null */
  countryName: string | null;
  /** ROR organization types (education, funder, ...) */
  types: string[];
};

export type RorClientOptions = {
  /** Injected for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra query params merged onto the request URL (tests use this to pin a page). */
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Test seam: route handlers can't take an injected fetch, so tests swap the
 * default here (and restore it after). Passing null restores the real fetch.
 * Never used in production code paths.
 */
let defaultFetch: typeof fetch | null = null;
export function __setRorClientFetchForTest(impl: typeof fetch | null): void {
  defaultFetch = impl;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rorFetch(url: string, opts: RorClientOptions): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race the request against a hard wall-clock deadline so even a fetch impl
  // that ignores the abort signal can never hang a signup request.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) return null;
        return await readBoundedJson(response);
      })(),
      deadline,
    ]);
    return result;
  } catch (err) {
    if (!isAbortError(err)) {
      console.error("ror-client fetch failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RorV2Name = { value?: unknown; types?: unknown };
type RorV2Location = { geonames_details?: { country_code?: unknown; name?: unknown } };
type RorV2Org = {
  id?: unknown;
  status?: unknown;
  names?: unknown;
  locations?: unknown;
  types?: unknown;
};

function displayName(org: RorV2Org): string | null {
  const names = Array.isArray(org.names) ? (org.names as RorV2Name[]) : [];
  const pick = (want: string) =>
    names.find((n) => Array.isArray(n.types) && (n.types as unknown[]).includes(want) && typeof n.value === "string" && n.value.trim().length > 0);
  const chosen = pick("ror_display") ?? pick("label") ?? names.find((n) => typeof n.value === "string" && n.value.trim().length > 0);
  return chosen && typeof chosen.value === "string" ? chosen.value.trim() : null;
}

function primaryCountry(org: RorV2Org): string | null {
  const locations = Array.isArray(org.locations) ? (org.locations as RorV2Location[]) : [];
  for (const loc of locations) {
    const raw = loc?.geonames_details?.country_code;
    if (typeof raw === "string" && raw.trim().length === 2) {
      const cc = raw.trim().toUpperCase();
      if (isoCountryByAlpha2(cc)) return cc;
    }
  }
  return null;
}

function toInstitution(org: RorV2Org): RorInstitution | null {
  if (org.status !== undefined && org.status !== "active") return null; // withdrawn / inactive
  const rorId = normalizeRorId(org.id);
  const name = displayName(org);
  if (!rorId || !name) return null;
  const countryCode = primaryCountry(org);
  return {
    rorId,
    name,
    countryCode,
    countryName: countryCode ? isoCountryByAlpha2(countryCode)?.name ?? null : null,
    types: Array.isArray(org.types) ? (org.types as unknown[]).filter((t): t is string => typeof t === "string") : [],
  };
}

/**
 * AUTHORITATIVE re-resolution of a client-supplied ROR id against the live ROR
 * registry. Returns the canonical institution or null when the id is malformed,
 * unknown (404), withdrawn/inactive, or the registry is unreachable. The caller
 * treats null as "invalid institution".
 */
export async function resolveRorInstitution(rorIdInput: unknown, opts: RorClientOptions = {}): Promise<RorInstitution | null> {
  const body = normalizeRorId(rorIdInput);
  if (!body) return null;
  const payload = await rorFetch(`${ROR_V2_BASE}/${encodeURIComponent(body)}`, opts);
  if (!payload || typeof payload !== "object") return null;
  const resolved = toInstitution(payload as RorV2Org);
  // Guard against a redirect/alias returning a different id than requested.
  return resolved && resolved.rorId === body ? resolved : null;
}

/**
 * Institution name search — used only to populate the client's select. The ids
 * it returns are still re-resolved server-side on submit, so a stale/partial
 * search result can never let junk through.
 */
export async function searchRorInstitutions(query: unknown, opts: RorClientOptions = {}): Promise<RorInstitution[]> {
  if (typeof query !== "string" || query.trim().length < 2) return [];
  const url = `${ROR_V2_BASE}?query=${encodeURIComponent(query.trim().slice(0, 200))}`;
  const payload = await rorFetch(url, opts);
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: RorInstitution[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (out.length >= MAX_SEARCH_RESULTS) break;
    if (!item || typeof item !== "object") continue;
    const inst = toInstitution(item as RorV2Org);
    if (inst && !seen.has(inst.rorId)) {
      seen.add(inst.rorId);
      out.push(inst);
    }
  }
  return out;
}
