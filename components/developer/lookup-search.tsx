"use client";

import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { AdminStatusBadge } from "@/components/admin/status-badge";

type DocumentIdentityResult = {
  id: string;
  accountId: string | null;
  accountUsername: string | null;
  accountEmail: string | null;
  title: string | null;
  author: string | null;
  rawSha256: string;
  canonicalSha256: string;
  createdAt: string;
};

type ReportResult = {
  deviceKey: string;
  id: string;
  title: string;
  updatedAt: string;
  scoreBand: string;
  /** Admin Phase 2C finding: GET /api/developer/lookup already returns this field (searchArticleHistory forwards the full DeveloperReportSummary), but the previous client type omitted it and it was never rendered. */
  aiScore: number | null;
  username: string | null;
  email: string | null;
};

/** Client-side search box for /admin/developer/lookup — hits GET /api/developer/lookup, which is itself gated by getAdminSessionUser (see that route's own comment). This component renders no data of its own on first paint; every result comes from that authorized fetch. */
export function DeveloperLookupSearch() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentIdentities, setDocumentIdentities] = useState<DocumentIdentityResult[]>([]);
  const [reports, setReports] = useState<ReportResult[]>([]);
  const [searched, setSearched] = useState(false);

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/developer/lookup?q=${encodeURIComponent(trimmed)}`);
      if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
      const data = (await response.json()) as { documentIdentities: DocumentIdentityResult[]; reports: ReportResult[] };
      setDocumentIdentities(data.documentIdentities);
      setReports(data.reports);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-lookup">
      <form className="admin-lookup-form" onSubmit={runSearch}>
        <div className="admin-lookup-input-wrap">
          <Search size={16} className="admin-lookup-input-icon" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, DOI, URL, hash, author, or document/report id"
            aria-label="Search article history"
          />
        </div>
        <button type="submit" className="admin-btn-primary" disabled={loading || query.trim().length === 0}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p role="alert" className="admin-form-error">{error}</p>}
      {loading && <p className="admin-corpus-loading">Searching…</p>}

      {searched && !loading && (
        <>
          <section className="admin-lookup-results">
            <h3>Document identities ({documentIdentities.length})</h3>
            {documentIdentities.length === 0 ? (
              <p className="admin-corpus-empty">No document identity matched.</p>
            ) : (
              <div className="admin-table-scroll">
                <table className="developer-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Author</th>
                      <th>Account</th>
                      <th>Raw SHA-256</th>
                      <th>Canonical SHA-256</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documentIdentities.map((identity) => (
                      <tr key={identity.id}>
                        <td>{identity.title ?? "—"}</td>
                        <td>{identity.author ?? "—"}</td>
                        <td>{identity.accountEmail ?? "anonymous"}</td>
                        <td><code>{identity.rawSha256.slice(0, 16)}…</code></td>
                        <td><code>{identity.canonicalSha256.slice(0, 16)}…</code></td>
                        <td>{identity.createdAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="admin-lookup-results">
            <h3>Saved reports ({reports.length})</h3>
            {reports.length === 0 ? (
              <p className="admin-corpus-empty">No report matched.</p>
            ) : (
              <div className="admin-table-scroll">
                <table className="developer-table admin-table--report-list">
                  <thead>
                    <tr>
                      <th className="admin-col-title">Title</th>
                      <th className="admin-col-account">Account</th>
                      <th className="admin-col-band">Score band</th>
                      <th className="admin-col-score">AI score</th>
                      <th className="admin-col-updated">Updated</th>
                      <th className="admin-col-action"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((report) => {
                      const account = report.email ?? "anonymous";
                      return (
                        <tr key={`${report.deviceKey}:${report.id}`}>
                          <td className="admin-col-title" title={report.title}>{report.title}</td>
                          <td className="admin-col-account" title={account}>{account}</td>
                          <td className="admin-col-band"><AdminStatusBadge status={report.scoreBand} /></td>
                          <td className="admin-col-score">{report.aiScore ?? "unavailable"}</td>
                          <td className="admin-col-updated">{report.updatedAt}</td>
                          <td className="admin-col-action">
                            <Link href={`/admin/developer/reports/${encodeURIComponent(report.id)}?deviceKey=${encodeURIComponent(report.deviceKey)}`} className="admin-action-link">
                              Inspect
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
