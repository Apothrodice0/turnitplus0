import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AsjpCatalogEntry, AsjpLicenceStatus } from "./asjp-academic-lane";

/**
 * Read access to an ASJP catalog database (schema 3) for the ASJP lane's `catalog` lookup, safe under many
 * concurrent processes.
 *
 * Several processes opening the same WAL-mode database at once race to initialise its shared-memory index; without a
 * busy timeout the loser fails at once with "database is locked" (SQLITE_BUSY). Two modes:
 *   immutable  a frozen catalog snapshot (the release catalog): opened with SQLite's `immutable=1`, so no process takes
 *              any lock or touches the -wal / -shm files. Refused when the database has a non-empty -wal (committed
 *              rows not yet in the main file, which an immutable open would not see).
 *   shared     a catalog another process may still write: read-only with a busy timeout, and every open / query
 *              retried with exponential backoff while SQLite reports BUSY / LOCKED, up to a bounded number of attempts;
 *              the error is raised after that, never swallowed.
 */
export type AsjpCatalogOpenMode = "immutable" | "shared";
export const ASJP_CATALOG_BUSY_TIMEOUT_MS = 5_000;
export const ASJP_CATALOG_ATTEMPTS = 6;
export const ASJP_CATALOG_BACKOFF_MS = 50;

export type AsjpCatalogStore = {
  readonly mode: AsjpCatalogOpenMode;
  /** The lane's `catalog` lookup. */
  readonly entry: (articleId: string) => AsjpCatalogEntry | null;
  /** BUSY / LOCKED retries taken so far (open + queries). */
  readonly busyRetries: () => number;
  readonly close: () => void;
};

const ENTRY_SQL = `SELECT a.article_id, a.canonical_url, a.title, a.authors_json, j.name journal, j.eissn, a.publication_date, a.doi,
  v.licence, v.licence_version, v.licence_basis, v.licence_status, v.reuse_permitted, v.withdrawn
  FROM article_versions v JOIN articles a USING(article_id) JOIN journals j USING(journal_id)
  WHERE v.article_id = ? AND v.indexed = 1`;

/** A catalog row (ENTRY_SQL / ALL_ENTRIES_SQL columns) as the lane's entry. */
export function catalogRowToEntry(row: Record<string, unknown>): AsjpCatalogEntry {
  return {
    articleId: String(row.article_id),
    canonicalUrl: String(row.canonical_url),
    title: (row.title as string | null) ?? null,
    authors: row.authors_json ? (JSON.parse(String(row.authors_json)) as string[]) : null,
    journal: (row.journal as string | null) ?? null,
    issn: (row.eissn as string | null) ?? null,
    publicationDate: (row.publication_date as string | null) ?? null,
    doi: (row.doi as string | null) ?? null,
    license: row.licence == null ? null : `${row.licence}${row.licence_version ? ` ${row.licence_version}` : ""}`,
    licenseBasis: (row.licence_basis as string | null) ?? null,
    licenceStatus: (row.licence_status as AsjpLicenceStatus | null) ?? undefined,
    reusePermitted: row.reuse_permitted === 1,
    withdrawn: row.withdrawn === 1,
  };
}

/** Every indexed article's row (for an in-memory snapshot). */
export const ALL_ENTRIES_SQL = ENTRY_SQL.replace("WHERE v.article_id = ? AND v.indexed = 1", "WHERE v.indexed = 1");

/** True for SQLITE_BUSY (5) / SQLITE_LOCKED (6) and their extended codes. */
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  if (typeof code === "number") return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /database (table )?is locked|database is busy/i.test(String((error as Error | null)?.message ?? ""));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openAsjpCatalog(
  path: string,
  options: { mode?: AsjpCatalogOpenMode; busyTimeoutMs?: number; attempts?: number; backoffMs?: number } = {},
): AsjpCatalogStore {
  const mode = options.mode ?? "shared";
  const attempts = Math.max(1, options.attempts ?? ASJP_CATALOG_ATTEMPTS);
  const backoffMs = options.backoffMs ?? ASJP_CATALOG_BACKOFF_MS;
  let retries = 0;
  const withRetry = <T>(work: () => T): T => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return work();
      } catch (error) {
        if (!isSqliteBusy(error) || attempt >= attempts) throw error;
        retries += 1;
        sleepSync(backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * backoffMs));
      }
    }
  };
  if (!existsSync(path)) throw new Error(`ASJP catalog not found: ${path}`);
  if (mode === "immutable" && existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) {
    throw new Error(`ASJP catalog ${path} has a non-empty -wal: checkpoint it before an immutable open, or open it "shared"`);
  }
  let statement: StatementSync;
  const db = withRetry(() => {
    const opened = mode === "immutable"
      ? new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true })
      : new DatabaseSync(path, { readOnly: true, timeout: options.busyTimeoutMs ?? ASJP_CATALOG_BUSY_TIMEOUT_MS });
    try {
      statement = opened.prepare(ENTRY_SQL);
      statement.get(-1); // the first read initialises the WAL index; a race shows here
      return opened;
    } catch (error) {
      opened.close();
      throw error;
    }
  });
  const entry = (articleId: string): AsjpCatalogEntry | null => {
    const row = withRetry(() => statement.get(Number(articleId))) as Record<string, unknown> | undefined;
    if (!row) return null;
    return catalogRowToEntry(row);
  };
  return { mode, entry, busyRetries: () => retries, close: () => db.close() };
}
