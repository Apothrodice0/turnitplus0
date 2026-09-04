"use client";

import { useState } from "react";
import Link from "next/link";

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
    <div className="developer-lookup">
      <form onSubmit={runSearch}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, DOI, URL, hash, author, or document/report id"
          aria-label="Search article history"
        />
        <button type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {searched && (
        <>
          <section>
            <h2>Document identities ({documentIdentities.length})</h2>
            {documentIdentities.length === 0 ? (
              <p>No document identity matched.</p>
            ) : (
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
            )}
          </section>

          <section>
            <h2>Saved reports ({reports.length})</h2>
            {reports.length === 0 ? (
              <p>No report matched.</p>
            ) : (
              <table className="developer-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Account</th>
                    <th>Score band</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr key={`${report.deviceKey}:${report.id}`}>
                      <td>{report.title}</td>
                      <td>{report.email ?? "anonymous"}</td>
                      <td>{report.scoreBand}</td>
                      <td>{report.updatedAt}</td>
                      <td>
                        <Link href={`/admin/developer/reports/${encodeURIComponent(report.id)}?deviceKey=${encodeURIComponent(report.deviceKey)}`}>
                          Inspect
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
