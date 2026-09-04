import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FileText, Percent, GitBranch, ShieldCheck, FileJson } from "lucide-react";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { getReportDeepDiveForDeveloper, getReportSimilarityDecisionTrace } from "@/lib/developer-repo";
import { AdminHeader } from "@/components/admin/admin-header";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { AdminCollapsible } from "@/components/admin/collapsible";
import { AdminStatusBadge, YesNoBadge } from "@/components/admin/status-badge";
import type {
  AdminSimilarityDecisionTrace,
  DecisionTraceCorpusDuplicateShadow,
  DecisionTraceDeviceSelfSharedGuard,
  DecisionTraceSource,
} from "@/lib/admin-similarity-decision-trace";

export const dynamic = "force-dynamic";

// See lib/developer-gate.ts's own comment: a non-admin must never see a
// page-identifying title either, not just a 404 body.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadDeveloperGate();
  if (!admin) return {};
  return { title: "Report inspection · Developer · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function DeveloperReportInspectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ deviceKey?: string }>;
}) {
  const admin = await loadDeveloperGate();
  if (!admin) notFound();

  const { id } = await params;
  const { deviceKey } = await searchParams;
  if (!deviceKey) notFound();

  const client = await getReportsDbClient();
  let deepDive;
  let similarityDecisionTrace: AdminSimilarityDecisionTrace | null = null;
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
    deepDive = await getReportDeepDiveForDeveloper(client, deviceKey, id);
    try {
      similarityDecisionTrace = await getReportSimilarityDecisionTrace(client, deviceKey, id);
    } catch (err) {
      console.error("getReportSimilarityDecisionTrace failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }

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
  const { report, documentIdentity, familyMembers, academicSearchRuns } = deepDive;

  return (
    <main className="developer-page">
      <AdminHeader
        icon={FileText}
        title={report.payload.title}
        description={`${report.email ? `${report.username} (${report.email})` : "anonymous"} · report ${report.id} · device ${report.deviceKey}`}
        backHref="/admin/developer"
        backLabel="Back to Developer"
      />

      {/* ================= Report overview ================= */}
      <section className="admin-card">
        <h2>
          <FileText size={17} className="admin-card-title-icon" aria-hidden="true" />
          Report overview
        </h2>

        <MetricGrid>
          <MetricTile label="Score band" value={<AdminStatusBadge status={report.payload.scoreBand} />} />
          <MetricTile label="Archive / similarity score" value={`${report.payload.archiveScore ?? report.payload.score}%`} />
          <MetricTile label="AI score" value={report.payload.aiScore ?? "unavailable"} />
          <MetricTile label="Academic evidence" value={report.payload.academicEvidenceStatus ?? "n/a"} variant="text" />
          <MetricTile label="Matched words" value={report.payload.matchedWordCount} />
        </MetricGrid>

        <p className="admin-card-description">
          Report created <strong>{report.reportCreatedAt}</strong> · saved <strong>{report.savedAt}</strong> · last
          updated <strong>{report.updatedAt}</strong>
        </p>

        <h3>Previous submission?</h3>
        {previousReports.length > 0 ? (
          <>
            <p>
              <AdminStatusBadge status="YES" label="YES" /> This document has {previousReports.length} previous saved
              submission{previousReports.length === 1 ? "" : "s"} in TurnitPlus.
            </p>
            <AdminCollapsible summary={`Previous submissions (${previousReports.length})`} defaultOpen={previousReports.length <= 5}>
              <div className="admin-table-scroll">
                <table className="developer-table">
                  <thead><tr><th>Date</th><th>Account</th><th>Title</th><th>Submission ID</th><th>Report ID</th></tr></thead>
                  <tbody>
                    {previousReports.map((previous) => (
                      <tr key={`${previous.deviceKey}:${previous.id}`}>
                        <td>{previous.reportCreatedAt}</td>
                        <td>{previous.email ? `${previous.username} (${previous.email})` : "anonymous"}</td>
                        <td>{previous.title}</td>
                        <td>{previous.submissionId}</td>
                        <td><a href={`/admin/developer/reports/${encodeURIComponent(previous.id)}?deviceKey=${encodeURIComponent(previous.deviceKey)}`} className="admin-action-link">{previous.id}</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminCollapsible>
          </>
        ) : (
          <p><AdminStatusBadge status="NO" label="NO" /> No previous saved report with the same canonical document identity was found.</p>
        )}
      </section>

      {/* ================= Similarity & scoring ================= */}
      <SimilarityDecisionTraceSection trace={similarityDecisionTrace} />

      {/* ================= Source & provenance diagnostics ================= */}
      <section className="admin-card">
        <h2>
          <GitBranch size={17} className="admin-card-title-icon" aria-hidden="true" />
          Source & provenance diagnostics
        </h2>

        <h3>Document identity</h3>
        {documentIdentity ? (
          <>
            <ul className="admin-plain-list">
              <li>Account: {documentIdentity.accountEmail ? `${documentIdentity.accountUsername} (${documentIdentity.accountEmail})` : "anonymous"}</li>
              <li>Title: {documentIdentity.title ?? "—"}</li>
              <li>Author: {documentIdentity.author ?? "—"}</li>
              <li>Created: {documentIdentity.createdAt}</li>
            </ul>
            <AdminCollapsible summary="Identity IDs & hashes (technical)">
              <ul className="admin-plain-list">
                <li>Identity id: <code>{documentIdentity.id}</code></li>
                <li>Raw SHA-256: <code>{documentIdentity.rawSha256}</code></li>
                <li>Canonical SHA-256: <code>{documentIdentity.canonicalSha256}</code></li>
              </ul>
            </AdminCollapsible>
          </>
        ) : (
          <p>No document identity captured for this report (predates capture, or capture failed).</p>
        )}

        <h3>Seen before? (document family)</h3>
        {familyMembers.length > 0 ? (
          <div className="admin-table-scroll">
            <table className="developer-table">
              <thead><tr><th>Relationship</th><th>Identity id</th><th>Account</th><th>Match type</th><th>Evidence score</th></tr></thead>
              <tbody>
                {familyMembers.map((member) => (
                  <tr key={member.id}>
                    <td><AdminStatusBadge status={member.relationship} /></td>
                    <td><code>{member.documentIdentityId}</code></td>
                    <td>{member.accountId ?? "anonymous"}</td>
                    <td><AdminStatusBadge status={member.matchType} /></td>
                    <td>{member.evidenceScore ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No other submission has ever matched this document&apos;s family.</p>
        )}

        <h3>Academic-search runs</h3>
        {academicSearchRuns.length === 0 && <p>No academic-search diagnostics captured for this report.</p>}
        {academicSearchRuns.map((run) => (
          <AdminCollapsible
            key={run.id}
            summary={
              <span className="admin-collapsible-summary-line">
                Run #{run.id} <AdminStatusBadge status={run.status} /> <span className="admin-table-subtext">{run.totalLatencyMs}ms total · {run.createdAt}</span>
              </span>
            }
          >
            <h4>Stats</h4><pre>{JSON.stringify(run.stats, null, 2)}</pre>
            <h4>Generated queries ({run.queries?.length ?? 0})</h4><pre>{JSON.stringify(run.queries, null, 2)}</pre>
            <h4>Ranked candidates ({run.candidates?.length ?? 0})</h4><pre>{JSON.stringify(run.candidates, null, 2)}</pre>
            <h4>Retrieval / comparison outcome per candidate</h4><pre>{JSON.stringify(run.retrievalDiagnostics, null, 2)}</pre>
          </AdminCollapsible>
        ))}
      </section>

      {/* ================= Device Passport & internal diagnostics ================= */}
      <DevicePassportDiagnosticsSection trace={similarityDecisionTrace} />

      {/* ================= Raw data ================= */}
      <section className="admin-card">
        <h2>
          <FileJson size={17} className="admin-card-title-icon" aria-hidden="true" />
          Raw data
        </h2>
        <AdminCollapsible summary="Matched sources (evidence used in the final report)">
          <pre>{JSON.stringify(report.payload.externalAcademicEvidence ?? [], null, 2)}</pre>
        </AdminCollapsible>
        <AdminCollapsible summary="Full report payload (raw payload_json)">
          <pre>{JSON.stringify(report.payload, null, 2)}</pre>
        </AdminCollapsible>
      </section>
    </main>
  );
}

// Phase B2 shadow measurement columns are NULL wherever a real counterfactual
// was never computed (status FAILED / SKIPPED_*). Render that as "not measured",
// NEVER as 0 — a genuine 0 (e.g. hypothetical score 0) is a real measurement.
function notMeasured(value: number | string | boolean | null | undefined): string {
  return value === null || value === undefined ? "not measured" : String(value);
}

/** Per-source "Reason" cell: the counted or exclusion reason as a badge, falling back to the contribution note (or a dash) when neither is set. */
function reasonCell(source: DecisionTraceSource): ReactNode {
  const reason = source.countedReason ?? source.exclusionReason;
  return reason ? <AdminStatusBadge status={reason} /> : (source.contributionNote ?? "—");
}

function CorpusDuplicateShadowBlock({ shadow }: { shadow: DecisionTraceCorpusDuplicateShadow | null }) {
  return (
    <>
      <h3>Corpus-duplicate suppression shadow (Phase B2 — measurement only)</h3>
      {shadow ? (
        <>
          <MetricGrid>
            <MetricTile label="Core status" value={<AdminStatusBadge status={shadow.status} />} sub={shadow.status === "FAILED" ? `error_code: ${notMeasured(shadow.errorCode)}` : undefined} />
            <MetricTile label="Authoritative score" value={notMeasured(shadow.authoritativeScore)} />
            <MetricTile label="Hypothetical score" value={notMeasured(shadow.hypotheticalScore)} sub="candidate excluded" />
            <MetricTile label="Delta" value={notMeasured(shadow.scoreDelta)} />
            <MetricTile label="Candidate count" value={notMeasured(shadow.candidateCount)} />
          </MetricGrid>
          <ul className="admin-plain-list">
            <li>Policy version: <code>{shadow.policyVersion}</code> · computed {shadow.computedAt}</li>
            <li>Candidate category: {shadow.measurementCategory ? <AdminStatusBadge status={shadow.measurementCategory} /> : "not measured"}</li>
            <li>Origin confidence: {shadow.originConfidence ? <AdminStatusBadge status={shadow.originConfidence} /> : "not measured"}</li>
            <li>Multi-origin evidence: {notMeasured(shadow.multiOriginEvidence)}</li>
            <li>
              Surviving matched words — archive: {notMeasured(shadow.archiveOnlyWordsSurviving)},
              academic: {notMeasured(shadow.liveAcademicOnlyWordsSurviving)},
              previous-upload: {notMeasured(shadow.previousUploadOnlyWordsSurviving)},
              overlap: {notMeasured(shadow.overlapWordsSurviving)}
            </li>
            <li>
              Checker accounts: {shadow.checkerAccountsStatus} · distinct-checker bucket: {notMeasured(shadow.distinctCheckerAccountsBucket)}
            </li>
            <li>
              Authoritative corpus generation: {notMeasured(shadow.authoritativeCorpusGeneration)} · snapshot: {notMeasured(shadow.authoritativeSnapshotComputedAt)}
            </li>
            <li>Evaluation truncated (defensive cap hit): <YesNoBadge value={shadow.evaluationTruncated} /></li>
            <li><strong>Production score changed by this shadow: NO</strong> (Phase B2 is measurement only)</li>
          </ul>
        </>
      ) : (
        <p>No corpus-duplicate suppression shadow evaluation has been recorded for this report.</p>
      )}
    </>
  );
}

/**
 * Admin Phase 2C finding: `trace.deviceSelfSharedGuard` — the refined
 * CONSERVATIVE_COMBINED (Policy D) shared-device fan-out TELEMETRY verdict —
 * is computed by lib/report-primary-similarity.ts's resolvePrimarySimilaritySummary
 * and threaded all the way through lib/developer-repo.ts and
 * buildAdminSimilarityDecisionTrace on every single page load, but had NO
 * rendering anywhere on this page. Surfaced here.
 */
function SharedDeviceGuardBlock({ guard }: { guard: DecisionTraceDeviceSelfSharedGuard | null }) {
  return (
    <>
      <h3>Shared-device guard (Policy D — telemetry only)</h3>
      {guard ? (
        guard.sharedGuardEnabled ? (
          <>
            <ul className="admin-plain-list">
              <li>Verdict: <AdminStatusBadge status={guard.sharedGuardReason} label={`${guard.sharedGuardPassed ? "PASS" : "BLOCK"} — ${guard.sharedGuardReason}`} /></li>
              <li>Durable actor history complete: <YesNoBadge value={guard.durableActorHistoryComplete} /></li>
              <li>Device distinct accounts: {guard.deviceDistinctAccounts ?? "—"}</li>
              <li>Device anonymous uploads: {guard.deviceAnonUploads ?? "—"}</li>
              <li>Unordered device-account pairs: {guard.unorderedDeviceAccountPairCount ?? "—"}</li>
              <li>Pair-other-verified-Passport count: {guard.pairOtherVerifiedPassportCount ?? "—"}</li>
              <li><strong>Score changed by this guard: NO</strong> — an accepted Device Passport SELF is kept regardless; this is risk telemetry, not a veto.</li>
            </ul>
          </>
        ) : (
          <p>DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED was off for this resolution — the guard was never consulted.</p>
        )
      ) : (
        <p>Not applicable — DEVICE_PASSPORT_SELF_ENABLED was off, so the shared-device guard was never consulted for this report.</p>
      )}
    </>
  );
}

function DevicePassportDiagnosticsSection({ trace }: { trace: AdminSimilarityDecisionTrace | null }) {
  return (
    <section className="admin-card">
      <h2>
        <ShieldCheck size={17} className="admin-card-title-icon" aria-hidden="true" />
        Device Passport & internal diagnostics
      </h2>

      <h3>Device Passport shadow evidence</h3>
      {trace?.deviceShadow ? (
        <>
          <MetricGrid>
            <MetricTile label="Verified upload passport" value={<YesNoBadge value={trace.deviceShadow.verifiedUploadPassport} />} />
            <MetricTile label="Shadow proposal" value={<AdminStatusBadge status={trace.deviceShadow.shadowProposal} />} />
            <MetricTile label="Agreement" value={<AdminStatusBadge status={trace.deviceShadow.agreement} />} />
            <MetricTile label="Would downgrade" value={<YesNoBadge value={trace.deviceShadow.wouldDowngrade} />} />
            <MetricTile label="Matches evaluated" value={trace.deviceShadow.matchesEvaluated} />
          </MetricGrid>
          <ul className="admin-plain-list">
            <li>Policy version: <code>{trace.deviceShadow.policyVersion}</code> · computed {trace.deviceShadow.computedAt} · status <AdminStatusBadge status={trace.deviceShadow.status} /></li>
            <li>Production status / relationship: {trace.deviceShadow.productionStatus} / {trace.deviceShadow.productionRelationship ? <AdminStatusBadge status={trace.deviceShadow.productionRelationship} /> : "—"}</li>
            {trace.deviceShadow.proposedRelationship && <li>Proposed relationship: <AdminStatusBadge status={trace.deviceShadow.proposedRelationship} /></li>}
            <li>deviceSelfCandidateCount: {trace.deviceShadow.deviceSelfCandidateCount}</li>
            <li>exactSameDeviceMatchCount: {trace.deviceShadow.exactSameDeviceMatchCount}</li>
            <li>independentBlockedCandidateCount: {trace.deviceShadow.independentBlockedCandidateCount}</li>
            <li>deviceDistinctAccounts: {trace.deviceShadow.deviceDistinctAccounts}</li>
            <li>deviceSubmissionCount: {trace.deviceShadow.deviceSubmissionCount}</li>
            <li>deviceAnonUploads: {trace.deviceShadow.deviceAnonUploads}</li>
            <li>deviceSharedAcrossAccounts: <YesNoBadge value={trace.deviceShadow.deviceSharedAcrossAccounts} /></li>
            <li>Shadow reason: {trace.deviceShadow.reason ? <AdminStatusBadge status={trace.deviceShadow.reason} /> : "—"}</li>
            <li>Strongest-candidate reason: {trace.deviceShadow.candidateReason ? <AdminStatusBadge status={trace.deviceShadow.candidateReason} /> : "—"}</li>
            <li><strong>Production score changed by Device Passport shadow: NO</strong> (Phase 4 is observation only)</li>
          </ul>
        </>
      ) : (
        <p>No Device Passport shadow evaluation has been recorded for this report.</p>
      )}

      <SharedDeviceGuardBlock guard={trace?.deviceSelfSharedGuard ?? null} />

      <CorpusDuplicateShadowBlock shadow={trace?.corpusDuplicateSuppressionShadow ?? null} />
    </section>
  );
}

function SimilarityDecisionTraceSection({ trace }: { trace: AdminSimilarityDecisionTrace | null }) {
  if (!trace) {
    return (
      <section className="admin-card">
        <h2>
          <Percent size={17} className="admin-card-title-icon" aria-hidden="true" />
          Similarity & scoring
        </h2>
        <p>Not available for this report.</p>
      </section>
    );
  }

  if (!trace.resolvable) {
    return (
      <section className="admin-card">
        <h2>
          <Percent size={17} className="admin-card-title-icon" aria-hidden="true" />
          Similarity & scoring
        </h2>
        <p>
          <strong>Not resolvable.</strong> {trace.unresolvableReason === "UNIFIED_SIMILARITY_NOT_PERSISTED"
            ? "No finalized unified-similarity result has been persisted for this report (legacy report, or write-time finalization never completed)."
            : trace.unresolvableReason === "HISTORICAL_MATCH_UNAVAILABLE"
              ? "The historical-match computation is currently UNAVAILABLE for this report."
              : "The final similarity result could not be resolved."}
        </p>
        <p>Archive-only fallback score: {trace.finalScore}%</p>
      </section>
    );
  }

  const d = trace.scoreDerivation;

  return (
    <section className="admin-card">
      <h2>
        <Percent size={17} className="admin-card-title-icon" aria-hidden="true" />
        Similarity & scoring
      </h2>

      <MetricGrid>
        <MetricTile label="Final similarity" value={`${trace.finalScore}%`} sub={`basis: ${trace.finalScoreBasis}`} />
        <MetricTile label="Submitted words" value={trace.submittedWordCount} />
        <MetricTile label="Included matched union" value={trace.finalIncludedUnionWordCount} />
        <MetricTile label="Excluded SELF words" value={trace.excludedSelfMatchedWordCount} />
        <MetricTile label="Excluded same-device SELF words" value={trace.excludedEffectiveDeviceSelfMatchedWordCount} />
        <MetricTile label="Excluded UNKNOWN-relationship words" value={trace.excludedUnknownMatchedWordCount} />
      </MetricGrid>
      {trace.excludedEffectiveDeviceSelfMatchedWordCount > 0 && (
        <p className="admin-card-description">
          Preview rule DEVICE_PASSPORT_SELF_ENABLED — baseline relationship preserved, effective scoring relationship
          SELF; per-source reason SAME_DEVICE_EXACT_DOCUMENT or SAME_DEVICE_STRONG_TEXT_DOCUMENT.
        </p>
      )}

      <AdminCollapsible summary="Word-union proof" defaultOpen>
        <p>
          Final percentage = included matched word-position union ÷ submitted words:
          {" "}<code>{d.numerator} / {d.denominator} = {d.rawPercent.toFixed(4)}% → {d.roundedPercent}%{d.cappedAt100 ? " (capped at 100%)" : ""}</code>
        </p>
        <p className="admin-card-description">Per-source raw matched words are NOT summed — the same submitted word found by multiple sources is counted once.</p>
        <ul className="admin-plain-list">
          <li>Archive-only words: {trace.archiveOnlyWordCount}</li>
          <li>Scholarly-only words: {trace.scholarlyOnlyWordCount}</li>
          <li>Previous-submission-only words: {trace.priorSubmissionOnlyWordCount}</li>
          <li>Words matched by more than one source (counted once): {trace.multiSourceOverlapWordCount}</li>
          <li>Union accumulation order: {trace.unionAccumulationOrder.length > 0 ? trace.unionAccumulationOrder.join(" → ") : "—"}</li>
          {trace.unattributedUnionWordCount > 0 && (
            <li><strong>Unattributed union words: {trace.unattributedUnionWordCount}</strong> (archive matched positions were not available on the payload)</li>
          )}
        </ul>
      </AdminCollapsible>

      {trace.zeroScoreExplanation && (
        <div className="admin-card-callout">
          <h3>Why the score is 0%</h3>
          <ul className="admin-plain-list">
            <li>Reason: <AdminStatusBadge status={trace.zeroScoreExplanation.reason} /></li>
            <li>{trace.zeroScoreExplanation.detail}</li>
            <li>SELF sources with matches: {trace.zeroScoreExplanation.excludedSelfSourceCount}</li>
            <li>UNKNOWN-relationship sources with matches: {trace.zeroScoreExplanation.excludedUnknownSourceCount}</li>
            <li>Per-candidate rejection detail: not available (does not survive production matching into the persisted result)</li>
          </ul>
        </div>
      )}

      {trace.fullCoverageExplanation && (
        <div className="admin-card-callout">
          <h3>Why the score is 100%</h3>
          <ul className="admin-plain-list">
            <li>Included union covers every submitted word: {trace.fullCoverageExplanation.includedUnionWordCount} / {trace.fullCoverageExplanation.submittedWordCount}</li>
            <li>Driving sources: {trace.fullCoverageExplanation.drivingSources.join(", ") || "—"}</li>
          </ul>
        </div>
      )}

      <h3>Per-source trace</h3>
      {trace.sources.length === 0 ? (
        <p>No archive, scholarly, or previous-submission source contributed to or was considered for this result.</p>
      ) : (
        <>
          <div className="admin-table-scroll">
            <table className="developer-table">
              <thead>
                <tr>
                  <th>Source</th><th>Kind</th><th>Relationship</th><th>Match type</th><th>Containment</th>
                  <th>Matcher-reported words</th><th>Raw matched words</th><th>Counted words</th><th>Unique contribution</th><th>Overlap</th>
                  <th>Counted?</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {trace.sources.map((source) => (
                  <tr key={source.sourceKey}>
                    <td>{source.label}</td>
                    <td>{source.sourceKind}</td>
                    <td>
                      <AdminStatusBadge status={source.relationshipType} />
                      {source.effectiveScoringReason && (
                        <div className="admin-table-subtext">→ {source.effectiveScoringRelationship} ({source.effectiveScoringReason})</div>
                      )}
                    </td>
                    <td><AdminStatusBadge status={source.matchType} /></td>
                    <td>{source.containment === null ? "—" : source.containment.toFixed(3)}</td>
                    <td>{source.productionReportedMatchedWordCount ?? "—"}</td>
                    <td>{source.rawMatchedWordCount}</td>
                    <td>{source.countedWordCount}</td>
                    <td>{source.newUniqueWordContribution}</td>
                    <td>{source.overlappingWordCount}</td>
                    <td><YesNoBadge value={source.countedTowardScore} /></td>
                    <td>{reasonCell(source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {trace.sources.map((source) => (
            <SourceEvidenceDetails key={`${source.sourceKey}-evidence`} source={source} />
          ))}
        </>
      )}
    </section>
  );
}

function SourceEvidenceDetails({ source }: { source: DecisionTraceSource }) {
  if (!source.accountEvidence && !source.deviceEvidence) return null;
  const a = source.accountEvidence;
  const dev = source.deviceEvidence;
  return (
    <AdminCollapsible summary={`${source.label} — account & device backing evidence`}>
      {a && (
        <>
          <h4>Account / backing evidence</h4>
          <MetricGrid>
            <MetricTile label="Has same-account submission" value={<YesNoBadge value={a.hasSameAccountSubmission} />} />
            <MetricTile label="Other-account submissions" value={a.otherAccountSubmissionCount} />
            <MetricTile label="Same-account backings" value={a.sameAccountBackingCount} />
            <MetricTile label="Other-account backings" value={a.otherAccountBackingCount} />
            <MetricTile label="Anonymous backings" value={a.anonymousBackingCount} />
          </MetricGrid>
          {a.backings.length > 0 && (
            <div className="admin-table-scroll">
              <table className="developer-table">
                <thead>
                  <tr><th>Channel</th><th>Relationship to report account</th><th>Account</th><th>Document identity</th><th>Admission decision</th><th>Source report</th></tr>
                </thead>
                <tbody>
                  {a.backings.map((backing, index) => (
                    <tr key={index}>
                      <td><AdminStatusBadge status={backing.channel} /></td>
                      <td><AdminStatusBadge status={backing.relationshipToReportAccount} /></td>
                      <td>{backing.accountEmail ? `${backing.accountUsername ?? "?"} (${backing.accountEmail})` : backing.accountUsername ?? "anonymous"}</td>
                      <td>{backing.documentIdentityId ?? "—"}</td>
                      <td>{backing.admissionDecisionId ?? "—"}</td>
                      <td>{backing.sourceReportId ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {a.backingListTruncated && <p className="admin-card-description">(backing list truncated)</p>}
        </>
      )}
      {dev && (
        <>
          <h4>Device Passport shadow evidence (per representation)</h4>
          <MetricGrid>
            <MetricTile label="Same verified device backing" value={<YesNoBadge value={dev.sameVerifiedDeviceBacking} />} />
            <MetricTile label="Same-device backings" value={dev.sameDeviceBackingCount} />
            <MetricTile label="Independent backings" value={dev.independentBackingCount} />
            <MetricTile label="Backings without device provenance" value={dev.backingsWithoutDeviceProvenance} />
            <MetricTile label="Admitted, different device" value={dev.admittedBackingsDifferentDevice} />
            <MetricTile label="Admitted, no device provenance" value={dev.admittedBackingsNoDeviceProvenance} />
            <MetricTile label="Admitted-promotion backings" value={dev.admittedPromotionBackingCount} />
            <MetricTile label="Submission-reference backings" value={dev.submissionReferenceBackingCount} />
            <MetricTile label="Identity same account" value={<YesNoBadge value={dev.identitySameAccount} />} />
            <MetricTile label="Prior same-account identities" value={dev.priorSameAccountIdentityCount} />
          </MetricGrid>
        </>
      )}
    </AdminCollapsible>
  );
}
