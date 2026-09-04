import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Wrench, Search, ArrowRight, FlaskConical, Activity } from "lucide-react";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { listRecentReportsForDeveloper } from "@/lib/developer-repo";
import { AdminHeader } from "@/components/admin/admin-header";
import { AdminStatusBadge } from "@/components/admin/status-badge";
import { DeveloperRoomReset } from "@/components/developer/room-reset";
import { DeveloperAccountRoomReset } from "@/components/developer/account-room-reset";

export const dynamic = "force-dynamic";

// Non-admins (including a fully anonymous visitor) get the same plain 404 a
// nonexistent route would — never a 401/403, and never a page-identifying
// title, either (see lib/developer-gate.ts's own comment) — that would
// confirm this page exists.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadDeveloperGate();
  if (!admin) return {};
  return { title: "Developer · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

// Reference-only list of the raw diagnostic JSON endpoints this workspace's
// cards already read (report lookup, shadow measurements) — not new
// behavior, just a documented pointer so a developer with curl/Postman knows
// they exist. Every one of these is independently admin-gated already.
const DIAGNOSTIC_ENDPOINTS = [
  { method: "GET", path: "/api/developer/lookup?q=", note: "Article history search (used by Report lookup)" },
  { method: "GET", path: "/api/developer/reports", note: "Recent reports, raw JSON" },
  { method: "GET", path: "/api/developer/device-provenance-shadow", note: "Raw measurement — see /admin/shadow" },
  { method: "GET", path: "/api/developer/shared-device-risk", note: "Raw measurement — see /admin/shadow" },
  { method: "GET", path: "/api/developer/corpus-duplicate-suppression-shadow", note: "Raw measurement — see /admin/shadow" },
];

export default async function AdminDeveloperPage() {
  const admin = await loadDeveloperGate();
  if (!admin) notFound();

  const client = await getReportsDbClient();
  let reports;
  try {
    reports = await listRecentReportsForDeveloper(client, 100);
  } finally {
    client.close();
  }

  return (
    <main className="developer-page">
      <AdminHeader icon={Wrench} title="Developer" description="Internal diagnostics for the detection pipeline — not visible to ordinary accounts." />

      <section className="admin-card">
        <h2>
          <Search size={17} className="admin-card-title-icon" aria-hidden="true" />
          Report lookup
        </h2>
        <p className="admin-card-description">Search across every account's saved reports, or inspect one of the most recently updated below.</p>

        <Link href="/admin/developer/lookup" className="admin-btn-primary admin-cta-link">
          Open Article History / Lookup
          <ArrowRight size={15} />
        </Link>

        <div className="admin-corpus-result-meta">
          <span>{reports.length} most recently updated reports</span>
        </div>
        {reports.length === 0 ? (
          <p className="admin-corpus-empty">No reports yet.</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="developer-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Account</th>
                  <th>Score band</th>
                  <th>AI score</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={`${report.deviceKey}:${report.id}`}>
                    <td>{report.title}</td>
                    <td>{report.email ? `${report.username} (${report.email})` : "anonymous"}</td>
                    <td><AdminStatusBadge status={report.scoreBand} /></td>
                    <td>{report.aiScore ?? "—"}</td>
                    <td>{report.updatedAt}</td>
                    <td>
                      <Link href={`/admin/developer/reports/${encodeURIComponent(report.id)}?deviceKey=${encodeURIComponent(report.deviceKey)}`} className="admin-action-link">
                        Inspect
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-card">
        <h2>
          <FlaskConical size={17} className="admin-card-title-icon" aria-hidden="true" />
          Test workspace
        </h2>
        <p className="admin-card-description">Reset test data so a room/account is empty again. Every action below is a dry-run preview first — nothing is deleted until you confirm.</p>
        <DeveloperRoomReset />
        <DeveloperAccountRoomReset />
      </section>

      <section className="admin-card">
        <h2>
          <Activity size={17} className="admin-card-title-icon" aria-hidden="true" />
          Developer diagnostics
        </h2>
        <div className="admin-metric-grid">
          <div className="admin-metric-tile">
            <div className="admin-metric-tile-label">Signed in as</div>
            <div className="admin-metric-tile-value admin-metric-tile-value--text">{admin.username}</div>
            <div className="admin-metric-tile-sub">{admin.email}</div>
          </div>
          <div className="admin-metric-tile">
            <div className="admin-metric-tile-label">Environment</div>
            <div className="admin-metric-tile-value admin-metric-tile-value--text">{process.env.VERCEL_ENV ?? "local"}</div>
          </div>
        </div>

        <p className="admin-badge-group-label admin-endpoint-list-label">Raw diagnostic endpoints</p>
        <ul className="admin-endpoint-list">
          {DIAGNOSTIC_ENDPOINTS.map((endpoint) => (
            <li key={endpoint.path}>
              <code>{endpoint.method} {endpoint.path}</code>
              <span>{endpoint.note}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
