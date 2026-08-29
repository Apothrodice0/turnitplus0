import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { listRecentReportsForDeveloper } from "@/lib/developer-repo";
import {
  summarizeDeviceProvenanceShadowMeasurement,
  type DeviceProvenanceShadowMeasurement,
} from "@/lib/device-provenance-shadow-measurement";
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
  return { title: "Developer · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function DeveloperOverviewPage() {
  const admin = await loadDeveloperGate();
  if (!admin) notFound();

  const client = await getReportsDbClient();
  let reports;
  let deviceShadow: DeviceProvenanceShadowMeasurement | null = null;
  try {
    reports = await listRecentReportsForDeveloper(client, 100);
    // Compact aggregate view of the device-provenance-shadow-v1 telemetry —
    // measurement only, read-only, never touches similarity scoring. A
    // failure here degrades to a hidden section, never a broken dashboard.
    try {
      deviceShadow = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 25 });
    } catch (err) {
      console.error("developer dashboard: device-provenance shadow summary failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
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

      {deviceShadow && (
        <section className="developer-device-shadow">
          <h2>Device Passport shadow measurement</h2>
          <p>
            <code>{deviceShadow.policyVersion}</code> — proposed same-device SELF rule, telemetry only. No score or
            relationship is changed by this policy today.
          </p>
          <ul className="developer-device-shadow-stats">
            <li>Evaluations: <strong>{deviceShadow.totals.evaluations}</strong> ({deviceShadow.totals.ok} OK / {deviceShadow.totals.failed} failed / {deviceShadow.totals.unparseableEvidence} unparseable)</li>
            <li>MATCHED / NO_HISTORICAL_MATCH: <strong>{deviceShadow.totals.matched}</strong> / {deviceShadow.totals.noHistoricalMatch}</li>
            <li>Would downgrade (≥1 counted match → SELF): <strong>{deviceShadow.wouldDowngradeCount}</strong></li>
            <li>SAME_DEVICE_EXACT_DOCUMENT: <strong>{deviceShadow.sameDeviceExactDocumentCount}</strong></li>
            <li>Shared-device evaluations: <strong>{deviceShadow.sharedDeviceEvaluationCount}</strong></li>
            <li>Blocked by independent backing: <strong>{deviceShadow.blockedByIndependentBackingCount}</strong></li>
            <li>Candidate independent backing &gt; 0: <strong>{deviceShadow.candidateIndependentBackingPositiveCount}</strong></li>
            <li>
              deviceDistinctAccounts — 1: {deviceShadow.deviceDistinctAccountsDistribution.one},
              2: {deviceShadow.deviceDistinctAccountsDistribution.two},
              3+: {deviceShadow.deviceDistinctAccountsDistribution.threePlus},
              unknown: {deviceShadow.deviceDistinctAccountsDistribution.unknown}
            </li>
            <li>
              deviceSubmissionCount — 1: {deviceShadow.deviceSubmissionCountDistribution.one},
              2: {deviceShadow.deviceSubmissionCountDistribution.two},
              3–5: {deviceShadow.deviceSubmissionCountDistribution.threeToFive},
              6+: {deviceShadow.deviceSubmissionCountDistribution.sixPlus},
              unknown: {deviceShadow.deviceSubmissionCountDistribution.unknown}
            </li>
            <li>Production relationships: {distributionText(deviceShadow.productionRelationshipDistribution)}</li>
            <li>Proposed relationships: {distributionText(deviceShadow.proposedRelationshipDistribution)}</li>
            <li>Agreement: {distributionText(deviceShadow.agreementDistribution)}</li>
            <li>
              Exact same-device, not downgraded: <strong>{deviceShadow.exactSameDeviceNotDowngraded.total}</strong>
              {" — "}by candidate reason: {distributionText(deviceShadow.exactSameDeviceNotDowngraded.byCandidateReason)}
            </li>
          </ul>

          <table className="developer-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Production rel.</th>
                <th>Proposed rel.</th>
                <th>Downgrade?</th>
                <th>Reason</th>
                <th>Exact canon.</th>
                <th>Same device</th>
                <th>Indep. backings</th>
                <th>Device accounts</th>
                <th>Device submissions</th>
                <th>Computed</th>
              </tr>
            </thead>
            <tbody>
              {deviceShadow.recentCandidates.map((row) => (
                <tr key={`${row.reportDeviceKey}:${row.reportId}`}>
                  <td>
                    <Link href={`/developer/reports/${encodeURIComponent(row.reportId)}?deviceKey=${encodeURIComponent(row.reportDeviceKey)}`}>
                      {row.reportId}
                    </Link>
                  </td>
                  <td>{row.productionRelationship ?? "—"}</td>
                  <td>{row.proposedRelationship ?? "—"}</td>
                  <td>{row.wouldDowngrade === null ? "?" : row.wouldDowngrade ? "yes" : "no"}</td>
                  <td>{row.reason ?? "—"}</td>
                  <td>{row.exactCanonical === null ? "?" : row.exactCanonical ? "yes" : "no"}</td>
                  <td>{row.sameVerifiedDevice === null ? "?" : row.sameVerifiedDevice ? "yes" : "no"}</td>
                  <td>{row.independentBackingCount ?? "?"}</td>
                  <td>{row.sharedDeviceAccountCount ?? "?"}</td>
                  <td>{row.sharedDeviceSubmissionCount ?? "?"}</td>
                  <td>{row.computedAt}</td>
                </tr>
              ))}
              {deviceShadow.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={11}>No device-provenance shadow evaluations yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      <DeveloperRoomReset />
      <DeveloperAccountRoomReset />
    </main>
  );
}

function distributionText(distribution: Record<string, number>): string {
  const entries = Object.entries(distribution);
  if (entries.length === 0) return "none";
  return entries.map(([key, count]) => `${key}: ${count}`).join(", ");
}
