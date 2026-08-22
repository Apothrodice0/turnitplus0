"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ListRow = {
  rowId: string;
  status: "pending" | "failed" | "cancelled" | "accepted" | "review" | "rejected";
  decision: "ACCEPT" | "REVIEW" | "REJECT" | null;
  detectedLanguage: string | null;
  extractedWordCount: number | null;
  qualityScore: number | null;
  accountId: string | null;
  attemptCount: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = { rows: ListRow[]; page: number; pageSize: number; totalCount: number };

const STATUS_OPTIONS = ["", "pending", "failed", "cancelled", "accepted", "review", "rejected"] as const;

/** Client-side list/search/filter/pagination for /admin/corpus — hits GET /api/admin/corpus, itself independently gated by getAdminSessionUser. Renders no data of its own on first paint; every result comes from that authorized fetch. */
export function AdminCorpusSearch() {
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("");
  const [language, setLanguage] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (language.trim()) params.set("language", language.trim());
    if (q.trim()) params.set("q", q.trim());
    params.set("page", String(page));

    fetch(`/api/admin/corpus?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return response.json() as Promise<ListResponse>;
      })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status, language, q, page]);

  const totalPages = result ? Math.max(1, Math.ceil(result.totalCount / result.pageSize)) : 1;

  return (
    <div className="developer-lookup">
      <form
        className="admin-corpus-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
        }}
      >
        <input type="text" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="Search source ref, reason codes, error" aria-label="Search corpus admission" />
        <select value={status} onChange={(event) => { setStatus(event.target.value as (typeof STATUS_OPTIONS)[number]); setPage(1); }} aria-label="Filter by status">
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>{option === "" ? "All statuses" : option}</option>
          ))}
        </select>
        <input type="text" value={language} onChange={(event) => { setLanguage(event.target.value); setPage(1); }} placeholder="Language (e.g. English)" aria-label="Filter by detected language" />
      </form>

      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading…</p>}

      {result && (
        <>
          <p>{result.totalCount} total · page {result.page} of {totalPages}</p>
          <div className="developer-table-scroll">
            <table className="developer-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Language</th>
                  <th>Word count</th>
                  <th>Quality</th>
                  <th>Account</th>
                  <th>Attempts</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.rowId}>
                    <td>{row.status}</td>
                    <td>{row.detectedLanguage ?? "—"}</td>
                    <td>{row.extractedWordCount ?? "—"}</td>
                    <td>{row.qualityScore ?? "—"}</td>
                    <td>{row.accountId ?? "unknown"}</td>
                    <td>{row.attemptCount ?? "—"}</td>
                    <td>{row.createdAt}</td>
                    <td>
                      <Link href={`/admin/corpus/${encodeURIComponent(row.rowId)}`}>Inspect</Link>
                    </td>
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td colSpan={8}>No matching rows.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span> Page {page} of {totalPages} </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
