import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { SESSION_COOKIE_NAME, getAdminSessionUserByToken } from "@/lib/auth-session";
import { getReportsDbClient } from "@/lib/reports-db";
import { listRecentReportsForDeveloper } from "@/lib/developer-repo";

export const dynamic = "force-dynamic";

// Non-admins (including a fully anonymous visitor) get the same plain 404 a
// nonexistent route would — never a 401/403 that would confirm this page
// exists. See lib/auth-session.ts's getAdminSessionUserByToken.
export async function generateMetadata(): Promise<Metadata> {
  return { title: "Developer · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function DeveloperOverviewPage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) notFound();

  const client = await getReportsDbClient();
  let reports;
  try {
    const admin = await getAdminSessionUserByToken(token, client);
    if (!admin) notFound();
    reports = await listRecentReportsForDeveloper(client, 100);
  } finally {
    client.close();
  }

  return (
    <main className="developer-page">
      <header className="developer-header">
        <h1>Developer dashboard</h1>
        <p>Internal diagnostics for the detection pipeline — not visible to ordinary accounts.</p>
        <Link href="/developer/lookup">Article History / Lookup →</Link>
      </header>

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
                <Link href={`/developer/reports/${encodeURIComponent(report.id)}?deviceKey=${encodeURIComponent(report.deviceKey)}`}>
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
    </main>
  );
}
