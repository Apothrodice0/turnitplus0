import Link from "next/link";
import type { CorpusDuplicateSuppressionShadowMeasurement } from "@/lib/corpus-duplicate-suppression-shadow-measurement";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { BadgeGroup } from "@/components/admin/badge-list";
import { AdminCollapsible } from "@/components/admin/collapsible";
import { AdminStatusBadge, YesNoBadge } from "@/components/admin/status-badge";

/**
 * Corpus-duplicate suppression shadow (Phase B2) — summary metric tiles +
 * collapsible distributions/detail tables. Measurement only; no score or
 * relationship is changed by this policy today.
 *
 * Admin Phase 2B finding: the measurement layer already computes
 * averageAuthoritativeScore/averageHypotheticalScore is a NEW trivial
 * aggregation added alongside the existing averageScoreDelta (same query,
 * same REAL_MEASUREMENT_FILTER scope — see that lib's own comment). Separately,
 * ~20 fields on every recentCandidates row (word-survival reconciliation,
 * backing counts, same-Passport/cross-account category flags, corpus
 * snapshot generation, truncation, runtime) were already fetched into the
 * page but had NO UI at all — surfaced below in a dedicated collapsible
 * rather than widening the main table past what the task's own column spec
 * asks for.
 */
export function CorpusDuplicateShadowCard({ measurement }: { measurement: CorpusDuplicateSuppressionShadowMeasurement }) {
  const m = measurement;
  return (
    <section className="admin-card">
      <h2>Corpus-duplicate suppression shadow</h2>
      <p className="admin-card-description">
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
        <MetricTile label="Candidates" value={m.totals.candidatePositive} sub={`of ${m.totals.realMeasurementRows} real-measurement rows`} />
        <MetricTile label="Candidate frequency" value={m.candidateFrequency.toFixed(3)} />
        <MetricTile label="Avg. authoritative score" value={m.averageAuthoritativeScore === null ? "not measured" : m.averageAuthoritativeScore.toFixed(1)} />
        <MetricTile label="Avg. hypothetical score" value={m.averageHypotheticalScore === null ? "not measured" : m.averageHypotheticalScore.toFixed(1)} />
        <MetricTile
          label="Average score delta"
          value={m.averageScoreDelta === null ? "not measured" : m.averageScoreDelta.toFixed(2)}
          sub={m.averageScoreDeltaWhereCandidate === null ? undefined : `where candidate: ${m.averageScoreDeltaWhereCandidate.toFixed(2)}`}
        />
        <MetricTile label="Authoritative 100 → hypothetical 0" value={m.authoritative100Hypothetical0Count} />
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
                  <td>
                    <AdminStatusBadge status={row.status} />
                    {row.status === "FAILED" && row.errorCode ? <div className="admin-table-subtext">{row.errorCode}</div> : null}
                  </td>
                  <td>{row.measurementCategory ? <AdminStatusBadge status={row.measurementCategory} /> : "not measured"}</td>
                  <td>{row.candidateCount === null ? "not measured" : row.candidateCount}</td>
                  <td>{row.authoritativeScore === null ? "not measured" : row.authoritativeScore}</td>
                  <td>{row.hypotheticalScore === null ? "not measured" : row.hypotheticalScore}</td>
                  <td>{row.scoreDelta === null ? "not measured" : row.scoreDelta}</td>
                  <td>
                    <AdminStatusBadge status={row.checkerAccountsStatus} />
                    {row.distinctCheckerAccountsBucket ? <div className="admin-table-subtext">{row.distinctCheckerAccountsBucket} accounts</div> : null}
                  </td>
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

      <AdminCollapsible summary="Per-candidate word-survival & backing detail (technical)">
        <div className="admin-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Submitted words</th>
                <th>Authoritative unique</th>
                <th>Hypothetical unique</th>
                <th>Unique removed</th>
                <th>Candidate matched</th>
                <th>Candidates excluded</th>
                <th>Archive-only surv.</th>
                <th>Live-academic-only surv.</th>
                <th>Prior-upload-only surv.</th>
                <th>Overlap surv.</th>
                <th>Admitted-promotion backing</th>
                <th>Submission-ref backing</th>
                <th>Independent backing</th>
                <th>Same-device backing</th>
                <th>Same-Passport</th>
                <th>Cross-account</th>
                <th>Corpus generation</th>
                <th>Snapshot computed</th>
                <th>Truncated</th>
                <th>Runtime (ms)</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {m.recentCandidates.map((row) => (
                <tr key={`detail:${row.reportDeviceKey}:${row.reportId}`}>
                  <td>{row.reportId}</td>
                  <td>{row.submittedWordCount ?? "—"}</td>
                  <td>{row.authoritativeUniqueMatchedWords ?? "—"}</td>
                  <td>{row.hypotheticalUniqueMatchedWords ?? "—"}</td>
                  <td>{row.uniqueMatchedWordsRemoved ?? "—"}</td>
                  <td>{row.candidateMatchedWords ?? "—"}</td>
                  <td>{row.candidatesExcluded ?? "—"}</td>
                  <td>{row.archiveOnlyWordsSurviving ?? "—"}</td>
                  <td>{row.liveAcademicOnlyWordsSurviving ?? "—"}</td>
                  <td>{row.previousUploadOnlyWordsSurviving ?? "—"}</td>
                  <td>{row.overlapWordsSurviving ?? "—"}</td>
                  <td>{row.candidateAdmittedPromotionBackingCount ?? "—"}</td>
                  <td>{row.candidateSubmissionReferenceBackingCount ?? "—"}</td>
                  <td>{row.candidateIndependentBackingCount ?? "—"}</td>
                  <td>{row.candidateSameDeviceBackingCount ?? "—"}</td>
                  <td><YesNoBadge value={row.samePassportCategory} /></td>
                  <td><YesNoBadge value={row.crossAccountCategory} /></td>
                  <td>{row.authoritativeCorpusGeneration ?? "—"}</td>
                  <td>{row.authoritativeSnapshotComputedAt ?? "—"}</td>
                  <td><YesNoBadge value={row.evaluationTruncated} /></td>
                  <td>{row.totalRuntimeMs ?? "—"}</td>
                  <td>{row.createdAt}</td>
                </tr>
              ))}
              {m.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={21}>No corpus-duplicate suppression shadow evaluations yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCollapsible>
    </section>
  );
}
