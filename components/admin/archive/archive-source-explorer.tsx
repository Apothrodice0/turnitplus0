"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { AdminStatusBadge } from "@/components/admin/status-badge";
import type { ArchiveExplorerListResult, ArchiveExplorerSort, ArchiveExplorerSourceClass, ArchiveExplorerState } from "./archive-types";
import {
  SOURCE_CLASS_LABEL,
  SOURCE_CLASS_OPTIONS,
  SOURCE_CLASS_PLURAL,
  STATE_BADGE_KEY,
  STATE_LABEL,
  STATE_OPTIONS,
  formatCount,
  formatDate,
} from "./archive-format";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

type Filters = { q: string; sourceClass: ArchiveExplorerSourceClass | ""; state: ArchiveExplorerState | ""; sort: ArchiveExplorerSort; page: number };
const DEFAULT_FILTERS: Filters = { q: "", sourceClass: "", state: "", sort: "newest", page: 1 };

function isDefault(filters: Filters): boolean {
  return filters.q === "" && filters.sourceClass === "" && filters.state === "" && filters.sort === "newest" && filters.page === 1;
}

/**
 * Server-side search / filter / paginate over GET /api/admin/archive (itself
 * admin-gated). The browser only ever holds one page (≤ PAGE_SIZE rows) plus
 * the facet counts; it never loads the corpus. First paint uses the page the
 * Server Component already loaded for the default filters.
 */
export function ArchiveSourceExplorer({
  initialList,
  selectedId,
  onSelect,
}: {
  initialList: ArchiveExplorerListResult | null;
  selectedId: string | null;
  onSelect: (sourceId: string) => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [result, setResult] = useState<ArchiveExplorerListResult | null>(initialList);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipInitialFetch = useRef(initialList !== null);

  // Debounced search: typing never fires a request per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setFilters((current) => (current.q === searchInput.trim() ? current : { ...current, q: searchInput.trim(), page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    if (skipInitialFetch.current && isDefault(filters)) {
      skipInitialFetch.current = false;
      return;
    }
    skipInitialFetch.current = false;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.sourceClass) params.set("class", filters.sourceClass);
    if (filters.state) params.set("state", filters.state);
    if (filters.sort !== "newest") params.set("sort", filters.sort);
    params.set("page", String(filters.page));
    params.set("pageSize", String(PAGE_SIZE));
    fetch(`/api/admin/archive?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load sources (${response.status}).`);
        return response.json() as Promise<ArchiveExplorerListResult>;
      })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load sources.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, page: 1, ...patch }));
  const totalPages = result ? Math.max(1, Math.ceil(result.totalCount / result.pageSize)) : 1;
  const classTotal = result ? SOURCE_CLASS_OPTIONS.reduce((sum, c) => sum + result.facets.bySourceClass[c], 0) : 0;

  return (
    <div className="admin-archive-explorer-list">
      <div className="admin-archive-toolbar">
        <label className="admin-archive-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={searchInput}
            maxLength={200}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search titles, source ids, fingerprint prefix"
            aria-label="Search sources"
          />
        </label>
        <div className="admin-archive-toolbar-selects">
          <label>
            <span>State</span>
            <select value={filters.state} onChange={(event) => update({ state: event.target.value as Filters["state"] })} aria-label="Filter by state">
              <option value="">All states</option>
              {STATE_OPTIONS.map((state) => (
                <option key={state} value={state}>
                  {STATE_LABEL[state]}{result ? ` (${formatCount(result.facets.byState[state])})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={filters.sort} onChange={(event) => update({ sort: event.target.value as ArchiveExplorerSort })} aria-label="Sort order">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
        </div>
      </div>

      <div className="admin-archive-chips" role="group" aria-label="Filter by source class">
        <button type="button" className={filters.sourceClass === "" ? "is-selected" : undefined} aria-pressed={filters.sourceClass === ""} onClick={() => update({ sourceClass: "" })}>
          {filters.sourceClass === "" && <Check size={14} aria-hidden="true" />}
          All sources<span>{formatCount(classTotal)}</span>
        </button>
        {SOURCE_CLASS_OPTIONS.map((sourceClass) => (
          <button
            key={sourceClass}
            type="button"
            className={filters.sourceClass === sourceClass ? "is-selected" : undefined}
            aria-pressed={filters.sourceClass === sourceClass}
            onClick={() => update({ sourceClass })}
          >
            {filters.sourceClass === sourceClass && <Check size={14} aria-hidden="true" />}
            {SOURCE_CLASS_PLURAL[sourceClass]}<span>{result ? formatCount(result.facets.bySourceClass[sourceClass]) : "—"}</span>
          </button>
        ))}
      </div>

      {error && <p role="alert" className="admin-form-error">{error}</p>}

      {result && (
        <>
          <div className="admin-corpus-result-meta">
            <span>
              {formatCount(result.totalCount)} source{result.totalCount === 1 ? "" : "s"}
              {loading ? " · updating…" : ""}
            </span>
            <span>{selectedId ? `Page ${result.page} of ${totalPages}` : "Select a row for eligibility, maturity and provenance"}</span>
          </div>

          {result.rows.length === 0 ? (
            <p className="admin-corpus-empty">No sources match these filters.</p>
          ) : (
            <div className={`admin-table-scroll${loading ? " is-refreshing" : ""}`}>
              <table className="developer-table admin-archive-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>State · eligibility</th>
                    <th className="is-numeric">Words</th>
                    <th>Added · matures</th>
                    <th>Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => {
                    const selected = row.sourceId === selectedId;
                    return (
                      <tr key={row.sourceId} className={selected ? "is-selected" : undefined} onClick={() => onSelect(row.sourceId)}>
                        <td className="admin-archive-source-cell">
                          <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(row.sourceId); }} aria-pressed={selected}>
                            <span className="admin-archive-source-name">{row.displayName}</span>
                            <span className="admin-archive-source-id">{SOURCE_CLASS_LABEL[row.sourceClass]} · {row.sourceId}</span>
                          </button>
                        </td>
                        <td>
                          <AdminStatusBadge status={STATE_BADGE_KEY[row.state]} label={STATE_LABEL[row.state]} />
                          <div className="admin-table-subtext">
                            {row.matchEligible ? <span className="admin-archive-eligible-yes"><Check size={12} aria-hidden="true" />Match-eligible</span> : <span className="admin-archive-eligible-no">Not eligible</span>}
                          </div>
                        </td>
                        <td className="is-numeric">{formatCount(row.wordCount)}</td>
                        <td>
                          {formatDate(row.addedAt)}
                          <div className="admin-table-subtext">{row.maturesAt ? `Matures ${formatDate(row.maturesAt)}` : "No maturity window"}</div>
                        </td>
                        <td className="admin-archive-provenance">{row.provenance}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="admin-corpus-pager">
            <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters((f) => ({ ...f, page: Math.max(1, f.page - 1) }))}>
              <ChevronLeft size={14} aria-hidden="true" /> Previous
            </button>
            <span>Page {result.page} of {totalPages}</span>
            <button type="button" disabled={filters.page >= totalPages || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>
              Next <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
      {!result && loading && <p className="admin-corpus-loading">Loading sources…</p>}
    </div>
  );
}
