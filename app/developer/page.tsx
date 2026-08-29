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
import {
  summarizeSharedDeviceRiskMeasurement,
  type SharedDeviceRiskMeasurement,
} from "@/lib/device-sharedness-measurement";
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
  let sharedDeviceRisk: SharedDeviceRiskMeasurement | null = null;
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
    // Shared-device false-SELF risk for the current downgrade candidates —
    // also SELECT-only, also never touches scoring. Same degrade-to-hidden
    // discipline.
    try {
      sharedDeviceRisk = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 25 });
    } catch (err) {
      console.error("developer dashboard: shared-device risk summary failed (non-fatal):", err instanceof Error ? err.message : String(err));
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

      {sharedDeviceRisk && (
        <section className="developer-device-shadow developer-shared-device-risk">
          <h2>Shared-device false-SELF risk</h2>
          <p>
            Same browser / profile ≠ automatically same human. For every current same-device SELF downgrade candidate
            (<code>{sharedDeviceRisk.policyVersion}</code>, <strong>{sharedDeviceRisk.totals.wouldDowngradeCandidates}</strong> found),
            how shared its verified upload Passport looks — measurement and hypothetical-policy evidence only. No score or
            relationship is changed by any label or policy here.
          </p>
          <ul className="developer-device-shadow-stats">
            <li>
              Evaluated: <strong>{sharedDeviceRisk.totals.candidatesEvaluated}</strong>
              {sharedDeviceRisk.totals.candidatesCapped > 0 ? ` (${sharedDeviceRisk.totals.candidatesCapped} capped)` : ""}
              {" — "}distinct candidate devices: {sharedDeviceRisk.distinctCandidateDevices}
            </li>
            <li>
              On 1-account devices: <strong>{sharedDeviceRisk.deviceAccountCountBuckets.one}</strong>,
              2-account: <strong>{sharedDeviceRisk.deviceAccountCountBuckets.two}</strong>,
              3+ account: <strong>{sharedDeviceRisk.deviceAccountCountBuckets.threePlus}</strong>,
              unknown: {sharedDeviceRisk.deviceAccountCountBuckets.unknown}
            </li>
            <li>On devices with anonymous uploads: <strong>{sharedDeviceRisk.candidatesOnDevicesWithAnonUploads}</strong></li>
            <li>
              Account pair shares exactly 1 Passport: <strong>{sharedDeviceRisk.pairSharesExactlyOnePassport}</strong>,
              2+ Passports: <strong>{sharedDeviceRisk.pairSharesTwoOrMorePassports}</strong>,
              unknown: {sharedDeviceRisk.pairSharedPassportUnknown}
            </li>
            <li>
              Devices with exactly 1 unordered account pair: <strong>{sharedDeviceRisk.devicesWithExactlyOnePair}</strong>,
              multiple pairs: <strong>{sharedDeviceRisk.devicesWithMultiplePairs}</strong>,
              no resolvable pair: {sharedDeviceRisk.devicesWithNoResolvablePair}
            </li>
            <li>
              Data gaps — missing report row: {sharedDeviceRisk.totals.candidatesMissingReportRow},
              missing passport: {sharedDeviceRisk.totals.candidatesMissingPassport},
              missing snapshot: {sharedDeviceRisk.totals.candidatesMissingSnapshot},
              representation drift: {sharedDeviceRisk.totals.candidatesRepresentationDrift},
              source account unresolved: {sharedDeviceRisk.totals.candidatesSourceAccountUnresolved},
              anonymous target: {sharedDeviceRisk.totals.candidatesTargetAnonymous}
            </li>
            <li>Risk category: {distributionText(sharedDeviceRisk.riskCategoryDistribution)}</li>
          </ul>

          <table className="developer-table">
            <thead>
              <tr>
                <th>Hypothetical policy</th>
                <th>Kept as SELF</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>CURRENT_PREVIEW (A)</td><td>{sharedDeviceRisk.policyImpact.CURRENT_PREVIEW.kept}</td><td>{sharedDeviceRisk.policyImpact.CURRENT_PREVIEW.blocked}</td></tr>
              <tr><td>TWO_ACCOUNT_MAX (B)</td><td>{sharedDeviceRisk.policyImpact.TWO_ACCOUNT_MAX.kept}</td><td>{sharedDeviceRisk.policyImpact.TWO_ACCOUNT_MAX.blocked}</td></tr>
              <tr><td>MULTI_PASSPORT_PAIR (C)</td><td>{sharedDeviceRisk.policyImpact.MULTI_PASSPORT_PAIR.kept}</td><td>{sharedDeviceRisk.policyImpact.MULTI_PASSPORT_PAIR.blocked}</td></tr>
              <tr><td>CONSERVATIVE_COMBINED (D)</td><td>{sharedDeviceRisk.policyImpact.CONSERVATIVE_COMBINED.kept}</td><td>{sharedDeviceRisk.policyImpact.CONSERVATIVE_COMBINED.blocked}</td></tr>
            </tbody>
          </table>

          <table className="developer-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Prod. rel.</th>
                <th>Proposed SELF</th>
                <th>Exact canon.</th>
                <th>Same device</th>
                <th>Indep. backing</th>
                <th>Device accounts</th>
                <th>Device submissions</th>
                <th>Device anon</th>
                <th>Unordered pairs on device</th>
                <th>Pair shared Passports</th>
                <th>Pair other Passports</th>
                <th>A</th>
                <th>B</th>
                <th>C</th>
                <th>D</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {sharedDeviceRisk.recentCandidates.map((row) => (
                <tr key={row.reportId}>
                  <td>{row.reportId}</td>
                  <td>{row.productionRelationship ?? "—"}</td>
                  <td>{row.proposedRelationship ?? "—"}</td>
                  <td>{row.exactCanonical === null ? "?" : row.exactCanonical ? "yes" : "no"}</td>
                  <td>{row.sameVerifiedDevice === null ? "?" : row.sameVerifiedDevice ? "yes" : "no"}</td>
                  <td>{row.independentBackingCount ?? "?"}</td>
                  <td>{row.deviceDistinctAccounts ?? "?"}</td>
                  <td>{row.deviceSubmissionCount ?? "?"}</td>
                  <td>{row.deviceAnonUploads ?? "?"}</td>
                  <td>{row.unorderedDeviceAccountPairCount ?? "?"}</td>
                  <td>{row.pairSharedPassportCount ?? "?"}</td>
                  <td>{row.pairOtherVerifiedPassportCount ?? "?"}</td>
                  <td>{row.policyA ? "keep" : "block"}</td>
                  <td>{row.policyB ? "keep" : "block"}</td>
                  <td>{row.policyC ? "keep" : "block"}</td>
                  <td>{row.policyD ? "keep" : "block"}</td>
                  <td title={row.riskRationale}>{row.riskCategory}</td>
                </tr>
              ))}
              {sharedDeviceRisk.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={17}>No current same-device SELF downgrade candidates.</td>
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
