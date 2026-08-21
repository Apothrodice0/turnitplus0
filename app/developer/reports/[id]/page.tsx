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
  let previousReports: Array<{
    deviceKey: string;
    id: string;
    submissionId: string;
    title: string;
    reportCreatedAt: string;
    username: string | null;
    email: string | null;
  }> = [];
  try {
    const admin = await getAdminSessionUserByToken(token, client);
    if (!admin) notFound();
    deepDive = await getReportDeepDiveForDeveloper(client, deviceKey, id);

    // Developer/admin view: answer the practical question directly — has
    // this document been submitted before? Use canonical document identity,
    // not account ownership, so the answer includes previous submissions by
    // other accounts as well as repeats by the current account. This is a
    // read-only admin surface; it does not alter the customer-facing score.
    if (deepDive.documentIdentity?.canonicalSha256) {
      const result = await client.execute({
        sql: `SELECT sr.device_key, sr.id, sr.submission_id, sr.title, sr.report_created_at,
                     u.username, u.email
              FROM document_identities di
              JOIN saved_reports sr ON sr.document_identity_id = di.id
              LEFT JOIN users u ON u.id = sr.user_id
              WHERE di.canonical_sha256 = ? AND NOT (sr.device_key = ? AND sr.id = ?)
              ORDER BY sr.report_created_at DESC LIMIT 100`,
        args: [deepDive.documentIdentity.canonicalSha256, deviceKey, id],
      });
      previousReports = result.rows.map((row) => ({
        deviceKey: String(row.device_key),
        id: String(row.id),
        submissionId: String(row.submission_id),
        title: String(row.title),
        reportCreatedAt: String(row.report_created_at),
        username: row.username === null ? null : String(row.username),
        email: row.email === null ? null : String(row.email),
      }));
    }
  } finally {
    client.close();
  }

  if (!deepDive.report) notFound();
  const { report, documentIdentity, familyMembers, family, academicSearchRuns } = deepDive;

  return (
    <main className="developer-page">
      <header className="developer-header">
        <h1>{report.payload.title}</h1>
        <p>{report.email ? `${report.username} (${report.email})` : "anonymous"} · report {report.id} · device {report.deviceKey}</p>
      </header>

      <section>
        <h2>Previous submission?</h2>
        {previousReports.length > 0 ? (
          <>
            <p><strong>YES.</strong> This document has {previousReports.length} previous saved submission{previousReports.length === 1 ? "" : "s"} in TurnitPlus.</p>
            <table className="developer-table">
              <thead><tr><th>Date</th><th>Account</th><th>Title</th><th>Submission ID</th><th>Report ID</th></tr></thead>
              <tbody>
                {previousReports.map((previous) => (
                  <tr key={`${previous.deviceKey}:${previous.id}`}>
                    <td>{previous.reportCreatedAt}</td>
                    <td>{previous.email ? `${previous.username} (${previous.email})` : "anonymous"}</td>
                    <td>{previous.title}</td>
                    <td>{previous.submissionId}</td>
                    <td><a href={`/developer/reports/${encodeURIComponent(previous.id)}?deviceKey=${encodeURIComponent(previous.deviceKey)}`}>{previous.id}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p><strong>NO.</strong> No previous saved report with the same canonical document identity was found.</p>
        )}
      </section>

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
            <thead><tr><th>Relationship</th><th>Identity id</th><th>Account</th><th>Match type</th><th>Evidence score</th></tr></thead>
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
            <summary>Run #{run.id} — {run.status} · {run.totalLatencyMs}ms total · {run.createdAt}</summary>
            <h3>Stats</h3><pre>{JSON.stringify(run.stats, null, 2)}</pre>
            <h3>Generated queries ({run.queries?.length ?? 0})</h3><pre>{JSON.stringify(run.queries, null, 2)}</pre>
            <h3>Ranked candidates ({run.candidates?.length ?? 0})</h3><pre>{JSON.stringify(run.candidates, null, 2)}</pre>
            <h3>Retrieval / comparison outcome per candidate</h3><pre>{JSON.stringify(run.retrievalDiagnostics, null, 2)}</pre>
          </details>
        ))}
      </section>

      <section><h2>Matched sources (evidence used in the final report)</h2><pre>{JSON.stringify(report.payload.externalAcademicEvidence ?? [], null, 2)}</pre></section>
      <section><h2>Full report payload</h2><details><summary>Raw payload_json</summary><pre>{JSON.stringify(report.payload, null, 2)}</pre></details></section>
    </main>
  );
}
