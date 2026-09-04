import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Wrench, Search, ArrowRight } from "lucide-react";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { listRecentReportsForDeveloper } from "@/lib/developer-repo";
import { AdminHeader } from "@/components/admin/admin-header";
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

      <Link href="/admin/developer/lookup" className="admin-card admin-link-card">
        <span className="admin-link-card-icon">
          <Search size={18} />
        </span>
        <span className="admin-link-card-text">
          <strong>Article History / Lookup</strong>
          <span>Search by title, DOI, URL, document hash/fingerprint, author, or document/report id.</span>
        </span>
        <ArrowRight size={16} className="admin-link-card-arrow" />
      </Link>

      <section className="admin-card">
        <h2>Recent reports</h2>
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
                  <td>{report.scoreBand}</td>
                  <td>{report.aiScore ?? "—"}</td>
                  <td>{report.updatedAt}</td>
                  <td>
                    <Link href={`/admin/developer/reports/${encodeURIComponent(report.id)}?deviceKey=${encodeURIComponent(report.deviceKey)}`}>
                      Inspect
                    </Link>
                  </td>
                </tr>
              ))}
              {reports.length === 0 && (
                <tr>
                  <td colSpan={6}>No reports yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-card">
        <DeveloperRoomReset />
        <DeveloperAccountRoomReset />
      </section>
    </main>
  );
}
