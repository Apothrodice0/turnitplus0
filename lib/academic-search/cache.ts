import type { AcademicSearchProvider } from "./provider";
import type { AcademicSearchQuery, AcademicSearchResult } from "./types";

/**
 * STEP 5's request-control layer: provider-neutral caching plus a
 * per-report search budget, both applied by wrapping any
 * AcademicSearchProvider — no change to orchestrator.ts or any other
 * pipeline stage is needed, since every stage only ever depends on the
 * AcademicSearchProvider interface (provider.ts), not on a concrete
 * provider's identity.
 *
 * This exists purely because TurnitPlus must stay free (see the phase's own
 * hard requirement): OpenAIRE and Europe PMC are both free today, but "free"
 * still means every redundant network call is pure waste against a shared
 * public rate limit that every TurnitPlus user competes for. Caching and a
 * hard budget are the mechanism that keeps usage low regardless of how many
 * reports run.
 */

type CacheEntry<T> = { value: T; expiresAt: number };

export type AcademicSearchCacheStats = {
  queryHits: number;
  queryMisses: number;
  metadataHits: number;
  metadataMisses: number;
  textHits: number;
  textMisses: number;
};

/**
 * Provider-neutral cache contract. Deliberately three separate namespaces
 * (query results, metadata, text) rather than one generic get/set — each
 * has a different natural key shape and a different reason to exist (STEP
 * 5's own three bullets), and keeping them distinct means a caller can
 * inspect/clear one without touching the others.
 */
export interface AcademicSearchCache {
  getQueryResults(providerId: string, queryText: string): AcademicSearchResult[] | null;
  setQueryResults(providerId: string, queryText: string, results: AcademicSearchResult[]): void;
  getMetadata(providerId: string, externalId: string): Partial<AcademicSearchResult> | null | undefined;
  setMetadata(providerId: string, externalId: string, metadata: Partial<AcademicSearchResult> | null): void;
  getText(providerId: string, externalId: string): string | null | undefined;
  setText(providerId: string, externalId: string, text: string | null): void;
  readonly stats: AcademicSearchCacheStats;
}

export type InMemoryAcademicSearchCacheConfig = {
  /** How long a cached entry stays valid. Generous by design — the target reuse case is "the same or a near-identical submission phrase gets searched again," not sub-second freshness. */
  queryTtlMs: number;
  metadataTtlMs: number;
  textTtlMs: number;
  /** Per-namespace cap so a long-running process can't grow this unboundedly; oldest entry is evicted first (insertion-order eviction, not true LRU — sufficient for this cache's scale). */
  maxEntriesPerNamespace: number;
};

export const DEFAULT_IN_MEMORY_ACADEMIC_SEARCH_CACHE_CONFIG: InMemoryAcademicSearchCacheConfig = {
  queryTtlMs: 30 * 60_000,
  metadataTtlMs: 24 * 60 * 60_000,
  textTtlMs: 24 * 60 * 60_000,
  maxEntriesPerNamespace: 2_000,
};

function normalizeQueryKey(queryText: string): string {
  return queryText.trim().toLowerCase().replace(/\s+/g, " ");
}

class TtlMap<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

/**
 * A single process's in-memory cache — the smallest useful implementation
 * for a free product with no budget for a shared cache backend today. Reset
 * on every cold start, which is a real, disclosed limitation for a
 * serverless deployment (see the final report's infrastructure-impact
 * section), not a silent gap: within a warm instance it still eliminates
 * exact-repeat queries/metadata/text lookups, and the interface is the seam
 * a future Redis/KV-backed implementation would slot into without any
 * caller change.
 */
export function createInMemoryAcademicSearchCache(
  config: Partial<InMemoryAcademicSearchCacheConfig> = {},
): AcademicSearchCache {
  const resolved = { ...DEFAULT_IN_MEMORY_ACADEMIC_SEARCH_CACHE_CONFIG, ...config };
  const queries = new TtlMap<AcademicSearchResult[]>(resolved.queryTtlMs, resolved.maxEntriesPerNamespace);
  const metadata = new TtlMap<Partial<AcademicSearchResult> | null>(resolved.metadataTtlMs, resolved.maxEntriesPerNamespace);
  const text = new TtlMap<string | null>(resolved.textTtlMs, resolved.maxEntriesPerNamespace);
  const stats: AcademicSearchCacheStats = { queryHits: 0, queryMisses: 0, metadataHits: 0, metadataMisses: 0, textHits: 0, textMisses: 0 };

  return {
    stats,

    getQueryResults(providerId, queryText) {
      const hit = queries.get(`${providerId}:${normalizeQueryKey(queryText)}`);
      if (hit) { stats.queryHits += 1; return hit; }
      stats.queryMisses += 1;
      return null;
    },
    setQueryResults(providerId, queryText, results) {
      queries.set(`${providerId}:${normalizeQueryKey(queryText)}`, results);
    },

    getMetadata(providerId, externalId) {
      const hit = metadata.get(`${providerId}:${externalId}`);
      if (hit === undefined) { stats.metadataMisses += 1; return undefined; }
      stats.metadataHits += 1;
      return hit;
    },
    setMetadata(providerId, externalId, value) {
      metadata.set(`${providerId}:${externalId}`, value);
    },

    getText(providerId, externalId) {
      const key = `${providerId}:${externalId}`;
      const hit = text.get(key);
      if (hit === undefined) { stats.textMisses += 1; return undefined; }
      stats.textHits += 1;
      return hit;
    },
    setText(providerId, externalId, value) {
      text.set(`${providerId}:${externalId}`, value);
    },
  };
}

/**
 * Hard cap on total provider calls for one report run, shared across every
 * wrapped provider passed the same budget instance. STEP 5's "enforce a
 * per-report search budget" — belt-and-suspenders alongside
 * phrase-extractor.ts's own 5-20 query cap: that cap bounds queries per
 * document, this bounds total *provider calls* (queries x providers +
 * metadata/text lookups), which is the number that actually determines
 * external request volume.
 */
export type AcademicSearchBudget = {
  tryConsume(kind: "search" | "metadata" | "text"): boolean;
  readonly used: number;
  readonly limit: number;
  readonly exhausted: boolean;
};

export function createAcademicSearchBudget(limit: number): AcademicSearchBudget {
  let used = 0;
  return {
    tryConsume() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    get used() { return used; },
    get limit() { return limit; },
    get exhausted() { return used >= limit; },
  };
}

export const DEFAULT_ACADEMIC_SEARCH_BUDGET_LIMIT = 60;

export type RequestControlOptions = {
  cache?: AcademicSearchCache;
  budget?: AcademicSearchBudget;
};

/**
 * Wraps any AcademicSearchProvider so its search()/getMetadata()/getText()
 * transparently check the cache first, and fall through to the real
 * provider only on a miss (STEP 5's "identical query -> reuse recent
 * result," "identical DOI/PMCID/... id -> reuse metadata," "don't retrieve
 * the same text twice"). When a budget is supplied and exhausted, search()
 * resolves to [] and getText()/getMetadata() resolve to null rather than
 * calling through — a budget stop is a normal, expected outcome (like an
 * empty result set), never a provider error, so it does not appear in
 * providerErrors.
 */
export function withRequestControl(
  provider: AcademicSearchProvider,
  options: RequestControlOptions = {},
): AcademicSearchProvider {
  const { cache, budget } = options;

  const wrapped: AcademicSearchProvider = {
    id: provider.id,

    async search(query: AcademicSearchQuery): Promise<AcademicSearchResult[]> {
      const cached = cache?.getQueryResults(provider.id, query.queryText);
      if (cached) return cached;

      if (budget && !budget.tryConsume("search")) return [];

      const results = await provider.search(query);
      cache?.setQueryResults(provider.id, query.queryText, results);
      return results;
    },
  };

  if (provider.getMetadata) {
    wrapped.getMetadata = async (externalId: string) => {
      const cached = cache?.getMetadata(provider.id, externalId);
      if (cached !== undefined) return cached;

      if (budget && !budget.tryConsume("metadata")) return null;

      const metadata = await provider.getMetadata!(externalId);
      cache?.setMetadata(provider.id, externalId, metadata);
      return metadata;
    };
  }

  if (provider.getText) {
    wrapped.getText = async (externalId: string) => {
      const cached = cache?.getText(provider.id, externalId);
      if (cached !== undefined) return cached;

      if (budget && !budget.tryConsume("text")) return null;

      const text = await provider.getText!(externalId);
      cache?.setText(provider.id, externalId, text);
      return text;
    };
  }

  return wrapped;
}
