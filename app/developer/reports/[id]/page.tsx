import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SESSION_COOKIE_NAME, getAdminSessionUserByToken } from "@/lib/auth-session";
import { getReportsDbClient } from "@/lib/reports-db";
import { getReportDeepDiveForDeveloper } from "@/lib/developer-repo";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Report inspection · Developer · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function DeveloperReportInspectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ deviceKey?: string }>;
}) {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) notFound();

  const { id } = await params;
  const { deviceKey } = await searchParams;
  if (!deviceKey) notFound();

  const client = await getReportsDbClient();
  let deepDive;
  try {
    const admin = await getAdminSessionUserByToken(token, client);
    if (!admin) notFound();
    deepDive = await getReportDeepDiveForDeveloper(client, deviceKey, id);
  } finally {
    client.close();
  }

  if (!deepDive.report) notFound();
  const { report, documentIdentity, familyMembers, academicSearchRuns } = deepDive;

  return (
    <main className="developer-page">
      <header className="developer-header">
        <h1>{report.payload.title}</h1>
        <p>
          {report.email ? `${report.username} (${report.email})` : "anonymous"} · report {report.id} · device {report.deviceKey}
        </p>
      </header>

      <section>
        <h2>Final classification</h2>
        <ul>
          <li>Score band: {report.payload.scoreBand}</li>
          <li>Archive/similarity score: {report.payload.archiveScore ?? report.payload.score}</li>
          <li>AI score: {report.payload.aiScore ?? "unavailable"}</li>
          <li>Academic evidence status: {report.payload.academicEvidenceStatus ?? "n/a"}</li>
          <li>Matched word count: {report.payload.matchedWordCount}</li>
          <li>Report created: {report.reportCreatedAt} · saved: {report.savedAt} · last updated: {report.updatedAt}</li>
        </ul>
      </section>

      <section>
        <h2>Document identity</h2>
        {documentIdentity ? (
          <ul>
            <li>Identity id: {documentIdentity.id}</li>
            <li>Account: {documentIdentity.accountEmail ? `${documentIdentity.accountUsername} (${documentIdentity.accountEmail})` : "anonymous"}</li>
            <li>Title: {documentIdentity.title ?? "—"}</li>
            <li>Author: {documentIdentity.author ?? "—"}</li>
            <li>Raw SHA-256: <code>{documentIdentity.rawSha256}</code></li>
            <li>Canonical SHA-256: <code>{documentIdentity.canonicalSha256}</code></li>
            <li>Created: {documentIdentity.createdAt}</li>
          </ul>
        ) : (
          <p>No document identity captured for this report (predates capture, or capture failed).</p>
        )}
      </section>

      <section>
        <h2>Seen before? (document family)</h2>
        {familyMembers.length > 0 ? (
          <table className="developer-table">
            <thead>
              <tr>
                <th>Relationship</th>
                <th>Identity id</th>
                <th>Account</th>
                <th>Match type</th>
                <th>Evidence score</th>
              </tr>
            </thead>
            <tbody>
              {familyMembers.map((member) => (
                <tr key={member.id}>
                  <td>{member.relationship}</td>
                  <td>{member.documentIdentityId}</td>
                  <td>{member.accountId ?? "anonymous"}</td>
                  <td>{member.matchType}</td>
                  <td>{member.evidenceScore ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No other submission has ever matched this document's family.</p>
        )}
      </section>

      <section>
        <h2>Academic-search runs</h2>
        {academicSearchRuns.length === 0 && <p>No academic-search diagnostics captured for this report.</p>}
        {academicSearchRuns.map((run) => (
          <details key={run.id} open>
            <summary>
              Run #{run.id} — {run.status} · {run.totalLatencyMs}ms total · {run.createdAt}
            </summary>
            <h3>Stats</h3>
            <pre>{JSON.stringify(run.stats, null, 2)}</pre>
            <h3>Generated queries ({run.queries?.length ?? 0})</h3>
            <pre>{JSON.stringify(run.queries, null, 2)}</pre>
            <h3>Ranked candidates ({run.candidates?.length ?? 0})</h3>
            <pre>{JSON.stringify(run.candidates, null, 2)}</pre>
            <h3>Retrieval / comparison outcome per candidate</h3>
            <pre>{JSON.stringify(run.retrievalDiagnostics, null, 2)}</pre>
          </details>
        ))}
      </section>

      <section>
        <h2>Matched sources (evidence used in the final report)</h2>
        <pre>{JSON.stringify(report.payload.externalAcademicEvidence ?? [], null, 2)}</pre>
      </section>

      <section>
        <h2>Full report payload</h2>
        <details>
          <summary>Raw payload_json</summary>
          <pre>{JSON.stringify(report.payload, null, 2)}</pre>
        </details>
      </section>
    </main>
  );
}
