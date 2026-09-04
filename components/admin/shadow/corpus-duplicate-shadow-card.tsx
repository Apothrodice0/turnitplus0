import Link from "next/link";
import type { CorpusDuplicateSuppressionShadowMeasurement } from "@/lib/corpus-duplicate-suppression-shadow-measurement";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { BadgeGroup } from "@/components/admin/badge-list";
import { AdminCollapsible } from "@/components/admin/collapsible";

/**
 * Corpus-duplicate suppression shadow (Phase B2) — same data as the former
 * app/developer/page.tsx inline section, reorganized into summary metric
 * tiles + collapsible distributions/detail table. Measurement only; no score
 * or relationship is changed by this policy today.
 */
export function CorpusDuplicateShadowCard({ measurement }: { measurement: CorpusDuplicateSuppressionShadowMeasurement }) {
  const m = measurement;
  return (
    <section className="admin-card">
      <h2>Corpus-duplicate suppression shadow (Phase B2)</h2>
      <p>
        <span className="admin-workspace-badge">{m.policyVersion}</span>{" "}
        What the unified similarity score would be if one qualifying TurnitPlus-internal exact-canonical
        whole-document duplicate did not inflate it. Score statistics cover only <code>status IN (OK, BOUNDED)</code>.
      </p>

      <MetricGrid>
        <MetricTile
          label="Evaluations"
          value={m.totals.evaluations}
          sub={`OK ${m.totals.ok} · BOUNDED ${m.totals.bounded} · FAILED ${m.totals.failed} · skipped ${m.totals.skipped}`}
        />
        <MetricTile label="Real-measurement rows" value={m.totals.realMeasurementRows} />
        <MetricTile label="Rows with ≥1 candidate" value={m.totals.candidatePositive} sub={`frequency ${m.candidateFrequency.toFixed(3)}`} />
        <MetricTile
          label="Average score delta"
          value={m.averageScoreDelta === null ? "not measured" : m.averageScoreDelta.toFixed(2)}
          sub={m.averageScoreDeltaWhereCandidate === null ? undefined : `where candidate: ${m.averageScoreDeltaWhereCandidate.toFixed(2)}`}
        />
        <MetricTile label="Authoritative 100 → hypothetical 0" value={m.authoritative100Hypothetical0Count} />
        <MetricTile label="Authoritative 100 → hypothetical 1–99" value={m.authoritative100HypotheticalPartialCount} />
        <MetricTile label="Surviving-word reconciliation" value={`${m.reconciliation.reconciledRows} / ${m.reconciliation.checkedRows}`} />
      </MetricGrid>

      <AdminCollapsible summary="Distributions">
        <BadgeGroup
          label="Skipped breakdown"
          distribution={{ "not-matched": m.totals.skippedNotMatched, "no-authoritative": m.totals.skippedNoAuthoritative }}
        />
        <BadgeGroup label="candidate_count" distribution={{ "0": m.candidateCountDistribution.zero, "1": m.candidateCountDistribution.one, "2+": m.candidateCountDistribution.twoPlus }} />
        <BadgeGroup
          label="score_delta buckets"
          distribution={{
            "0": m.scoreDeltaBuckets.zero,
            "1–9": m.scoreDeltaBuckets.d1to9,
            "10–24": m.scoreDeltaBuckets.d10to24,
            "25–49": m.scoreDeltaBuckets.d25to49,
            "50–99": m.scoreDeltaBuckets.d50to99,
            "100": m.scoreDeltaBuckets.d100,
          }}
        />
        <BadgeGroup label="measurement_category" distribution={m.measurementCategoryDistribution} />
        <BadgeGroup label="origin_confidence" distribution={m.originConfidenceDistribution} />
        <BadgeGroup label="multi_origin_evidence" distribution={m.multiOriginEvidenceDistribution} />
        <BadgeGroup label="checker_accounts_status" distribution={m.checkerAccountsStatusDistribution} />
        <BadgeGroup label="distinct_checker_accounts_bucket (OK/BOUNDED & checker OK)" distribution={m.distinctCheckerAccountsBucketDistribution} />
        <BadgeGroup label="error_code (FAILED rows)" distribution={m.errorCodeDistribution} />
      </AdminCollapsible>

      <AdminCollapsible summary={`Recent candidates (${m.recentCandidates.length})`}>
        <div className="admin-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Status</th>
                <th>Category</th>
                <th>Cand.</th>
                <th>Authoritative</th>
                <th>Hypothetical</th>
                <th>Delta</th>
                <th>Checker</th>
                <th>Computed</th>
              </tr>
            </thead>
            <tbody>
              {m.recentCandidates.map((row) => (
                <tr key={`${row.reportDeviceKey}:${row.reportId}`}>
                  <td>
                    <Link href={`/admin/developer/reports/${encodeURIComponent(row.reportId)}?deviceKey=${encodeURIComponent(row.reportDeviceKey)}`}>
                      {row.reportId}
                    </Link>
                  </td>
                  <td>{row.status}{row.status === "FAILED" && row.errorCode ? ` (${row.errorCode})` : ""}</td>
                  <td>{row.measurementCategory ?? "not measured"}</td>
                  <td>{row.candidateCount === null ? "not measured" : row.candidateCount}</td>
                  <td>{row.authoritativeScore === null ? "not measured" : row.authoritativeScore}</td>
                  <td>{row.hypotheticalScore === null ? "not measured" : row.hypotheticalScore}</td>
                  <td>{row.scoreDelta === null ? "not measured" : row.scoreDelta}</td>
                  <td>{row.checkerAccountsStatus}{row.distinctCheckerAccountsBucket ? ` / ${row.distinctCheckerAccountsBucket}` : ""}</td>
                  <td>{row.computedAt}</td>
                </tr>
              ))}
              {m.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={9}>No corpus-duplicate suppression shadow evaluations yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCollapsible>
    </section>
  );
}
