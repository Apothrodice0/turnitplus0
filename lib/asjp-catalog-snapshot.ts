import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { AsjpCatalogEntry } from "./asjp-academic-lane";
import { ALL_ENTRIES_SQL, isSqliteBusy, mergeCatalogRows } from "./asjp-catalog-store";

/**
 * The serving catalog: an in-memory snapshot of every indexed article's entry. A lookup never touches SQLite, so it
 * can never block the event loop or meet a lock. (The synchronous store with its bounded retry sleep remains for
 * batch scripts only.)
 *   load      reads the catalog once: `immutable` for a frozen snapshot, else read-only with SQLite's busy timeout 0
 *             (no blocking wait) and ASYNC exponential-backoff retries while it is BUSY / LOCKED
 *   refresh   loads a new snapshot the same way and swaps it in atomically; on failure the current snapshot stays
 *             and the error is reported (a takedown written to the catalog becomes effective at the next refresh)
 */
export type AsjpCatalogSnapshot = { readonly entries: ReadonlyMap<string, AsjpCatalogEntry>; readonly loadedAt: string; readonly busyRetries: number; readonly loadMs: number };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function loadAsjpCatalogSnapshot(path: string, options: { immutable?: boolean; attempts?: number; backoffMs?: number } = {}): Promise<AsjpCatalogSnapshot> {
  if (!existsSync(path)) throw new Error(`ASJP catalog not found: ${path}`);
  if (options.immutable && existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) throw new Error(`ASJP catalog ${path} has a non-empty -wal: not a frozen snapshot`);
  const attempts = Math.max(1, options.attempts ?? 8), backoff = options.backoffMs ?? 25;
  const t0 = performance.now();
  for (let attempt = 1; ; attempt += 1) {
    let db: DatabaseSync | null = null;
    try {
      db = options.immutable ? new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true }) : new DatabaseSync(path, { readOnly: true, timeout: 0 });
      const rows = db.prepare(ALL_ENTRIES_SQL).all();
      const byArticle = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) { const k = String(row.article_id); const l = byArticle.get(k); if (l) l.push(row); else byArticle.set(k, [row]); }
      const entries = new Map<string, AsjpCatalogEntry>();
      for (const [k, list] of byArticle) entries.set(k, mergeCatalogRows(list)!);
      return { entries, loadedAt: new Date().toISOString(), busyRetries: attempt - 1, loadMs: Math.round(performance.now() - t0) };
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= attempts) throw error;
      await sleep(backoff * 2 ** (attempt - 1) + Math.floor(Math.random() * backoff));
    } finally {
      db?.close();
    }
  }
}

/** The catalog a serving process holds: lookups from memory, refreshed asynchronously. */
export class AsjpCatalogSource {
  private snapshot: AsjpCatalogSnapshot;
  private refreshing: Promise<boolean> | null = null;
  lastRefreshError: string | null = null;
  private constructor(private readonly path: string, private readonly immutable: boolean, first: AsjpCatalogSnapshot) { this.snapshot = first; }
  static async open(path: string, options: { immutable?: boolean } = {}): Promise<AsjpCatalogSource> {
    return new AsjpCatalogSource(path, !!options.immutable, await loadAsjpCatalogSnapshot(path, options));
  }
  /** The lane's `catalog` lookup (synchronous, from memory). */
  readonly entry = (articleId: string): AsjpCatalogEntry | null => this.snapshot.entries.get(articleId) ?? null;
  get current(): AsjpCatalogSnapshot { return this.snapshot; }
  /** Loads a new snapshot and swaps it in; concurrent calls share one load. True when swapped. */
  refresh(): Promise<boolean> {
    this.refreshing ??= loadAsjpCatalogSnapshot(this.path, { immutable: this.immutable })
      .then((next) => { this.snapshot = next; this.lastRefreshError = null; return true; })
      .catch((error) => { this.lastRefreshError = String(error?.message ?? error); return false; })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
