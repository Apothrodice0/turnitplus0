import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { getReportDeepDiveForDeveloper, getReportSimilarityDecisionTrace } from "@/lib/developer-repo";
import type {
  AdminSimilarityDecisionTrace,
  DecisionTraceSource,
} from "@/lib/admin-similarity-decision-trace";

export const dynamic = "force-dynamic";

// See lib/developer-gate.ts's own comment: a non-admin must never see a
// page-identifying title either, not just a 404 body.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadDeveloperGate();
  if (!admin) return {};
  return { title: "Report inspection · Developer · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
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

      <SimilarityDecisionTraceSection trace={similarityDecisionTrace} />

      <section><h2>Matched sources (evidence used in the final report)</h2><pre>{JSON.stringify(report.payload.externalAcademicEvidence ?? [], null, 2)}</pre></section>
      <section><h2>Full report payload</h2><details><summary>Raw payload_json</summary><pre>{JSON.stringify(report.payload, null, 2)}</pre></details></section>
    </main>
  );
}

function yesNo(value: boolean): string {
  return value ? "YES" : "NO";
}

function SimilarityDecisionTraceSection({ trace }: { trace: AdminSimilarityDecisionTrace | null }) {
  if (!trace) {
    return (
      <section>
        <h2>Similarity decision trace</h2>
        <p>Not available for this report.</p>
      </section>
    );
  }

  if (!trace.resolvable) {
    return (
      <section>
        <h2>Similarity decision trace</h2>
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
    <section>
      <h2>Similarity decision trace</h2>

      <h3>Summary</h3>
      <ul>
        <li>Final similarity: <strong>{trace.finalScore}%</strong> (basis: {trace.finalScoreBasis})</li>
        <li>Submitted words: {trace.submittedWordCount}</li>
        <li>Included matched union: {trace.finalIncludedUnionWordCount}</li>
        <li>Excluded SELF words: {trace.excludedSelfMatchedWordCount}</li>
        <li>Excluded effective same-device SELF words: {trace.excludedEffectiveDeviceSelfMatchedWordCount}{trace.excludedEffectiveDeviceSelfMatchedWordCount > 0 ? " (Preview rule DEVICE_PASSPORT_SELF_ENABLED — baseline relationship preserved, effective scoring relationship SELF, reason SAME_DEVICE_EXACT_DOCUMENT)" : ""}</li>
        <li>Excluded UNKNOWN-relationship words: {trace.excludedUnknownMatchedWordCount}</li>
        <li>Production score changed by Device Passport shadow: <strong>NO</strong></li>
      </ul>

      <h3>Word-union proof</h3>
      <p>
        Final percentage = included matched word-position union ÷ submitted words:
        {" "}<code>{d.numerator} / {d.denominator} = {d.rawPercent.toFixed(4)}% → {d.roundedPercent}%{d.cappedAt100 ? " (capped at 100%)" : ""}</code>
      </p>
      <p>Per-source raw matched words are NOT summed — the same submitted word found by multiple sources is counted once.</p>
      <ul>
        <li>Archive-only words: {trace.archiveOnlyWordCount}</li>
        <li>Scholarly-only words: {trace.scholarlyOnlyWordCount}</li>
        <li>Previous-submission-only words: {trace.priorSubmissionOnlyWordCount}</li>
        <li>Words matched by more than one source (counted once): {trace.multiSourceOverlapWordCount}</li>
        <li>Union accumulation order: {trace.unionAccumulationOrder.length > 0 ? trace.unionAccumulationOrder.join(" → ") : "—"}</li>
        {trace.unattributedUnionWordCount > 0 && (
          <li><strong>Unattributed union words: {trace.unattributedUnionWordCount}</strong> (archive matched positions were not available on the payload)</li>
        )}
      </ul>

      {trace.zeroScoreExplanation && (
        <>
          <h3>Why the score is 0%</h3>
          <ul>
            <li>Reason: <strong>{trace.zeroScoreExplanation.reason}</strong></li>
            <li>{trace.zeroScoreExplanation.detail}</li>
            <li>SELF sources with matches: {trace.zeroScoreExplanation.excludedSelfSourceCount}</li>
            <li>UNKNOWN-relationship sources with matches: {trace.zeroScoreExplanation.excludedUnknownSourceCount}</li>
            <li>Per-candidate rejection detail: not available (does not survive production matching into the persisted result)</li>
          </ul>
        </>
      )}

      {trace.fullCoverageExplanation && (
        <>
          <h3>Why the score is 100%</h3>
          <ul>
            <li>Reason: <strong>{trace.fullCoverageExplanation.reason}</strong></li>
            <li>Included union covers every submitted word: {trace.fullCoverageExplanation.includedUnionWordCount} / {trace.fullCoverageExplanation.submittedWordCount}</li>
            <li>Driving sources: {trace.fullCoverageExplanation.drivingSources.join(", ") || "—"}</li>
          </ul>
        </>
      )}

      <h3>Per-source trace</h3>
      {trace.sources.length === 0 ? (
        <p>No archive, scholarly, or previous-submission source contributed to or was considered for this result.</p>
      ) : (
        <>
          <table className="developer-table">
            <thead>
              <tr>
                <th>Source</th><th>Kind</th><th>Relationship</th><th>Match type</th><th>Containment</th>
                <th>Raw matched words</th><th>Counted words</th><th>Unique contribution</th><th>Overlap</th>
                <th>Counted?</th><th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {trace.sources.map((source) => (
                <tr key={source.sourceKey}>
                  <td>{source.label}</td>
                  <td>{source.sourceKind}</td>
                  <td>{source.effectiveScoringReason
                    ? `${source.relationshipType} → ${source.effectiveScoringRelationship} (${source.effectiveScoringReason})`
                    : source.relationshipType}</td>
                  <td>{source.matchType}</td>
                  <td>{source.containment === null ? "—" : source.containment.toFixed(3)}</td>
                  <td>{source.rawMatchedWordCount}</td>
                  <td>{source.countedWordCount}</td>
                  <td>{source.newUniqueWordContribution}</td>
                  <td>{source.overlappingWordCount}</td>
                  <td>{yesNo(source.countedTowardScore)}</td>
                  <td>{source.countedReason ?? source.exclusionReason ?? source.contributionNote ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trace.sources.map((source) => (
            <SourceEvidenceDetails key={`${source.sourceKey}-evidence`} source={source} />
          ))}
        </>
      )}

      <h3>Device Passport shadow evidence</h3>
      {trace.deviceShadow ? (
        <ul>
          <li>Verified upload passport: <strong>{yesNo(trace.deviceShadow.verifiedUploadPassport)}</strong></li>
          <li>Policy version: {trace.deviceShadow.policyVersion} · computed {trace.deviceShadow.computedAt} · status {trace.deviceShadow.status}</li>
          <li>Production status / relationship: {trace.deviceShadow.productionStatus} / {trace.deviceShadow.productionRelationship ?? "—"}</li>
          <li>Shadow proposal: {trace.deviceShadow.shadowProposal}{trace.deviceShadow.proposedRelationship ? ` (proposedRelationship=${trace.deviceShadow.proposedRelationship})` : ""}</li>
          <li>Agreement: {trace.deviceShadow.agreement}</li>
          <li>wouldDowngrade: {yesNo(trace.deviceShadow.wouldDowngrade)}</li>
          <li>deviceSelfCandidateCount: {trace.deviceShadow.deviceSelfCandidateCount}</li>
          <li>exactSameDeviceMatchCount: {trace.deviceShadow.exactSameDeviceMatchCount}</li>
          <li>independentBlockedCandidateCount: {trace.deviceShadow.independentBlockedCandidateCount}</li>
          <li>matchesEvaluated: {trace.deviceShadow.matchesEvaluated}</li>
          <li>deviceDistinctAccounts: {trace.deviceShadow.deviceDistinctAccounts}</li>
          <li>deviceSubmissionCount: {trace.deviceShadow.deviceSubmissionCount}</li>
          <li>deviceAnonUploads: {trace.deviceShadow.deviceAnonUploads}</li>
          <li>deviceSharedAcrossAccounts: {yesNo(trace.deviceShadow.deviceSharedAcrossAccounts)}</li>
          <li>Shadow reason: {trace.deviceShadow.reason ?? "—"}</li>
          <li>Strongest-candidate reason: {trace.deviceShadow.candidateReason ?? "—"}</li>
          <li><strong>Production score changed by Device Passport shadow: NO</strong> (Phase 4 is observation only)</li>
        </ul>
      ) : (
        <p>No Device Passport shadow evaluation has been recorded for this report.</p>
      )}
    </section>
  );
}

function SourceEvidenceDetails({ source }: { source: DecisionTraceSource }) {
  if (!source.accountEvidence && !source.deviceEvidence) return null;
  const a = source.accountEvidence;
  const dev = source.deviceEvidence;
  return (
    <details>
      <summary>{source.label} — account &amp; device backing evidence</summary>
      {a && (
        <>
          <h4>Account / backing evidence</h4>
          <ul>
            <li>Has same-account submission: {yesNo(a.hasSameAccountSubmission)}</li>
            <li>Other-account submission count: {a.otherAccountSubmissionCount}</li>
            <li>Same-account backings: {a.sameAccountBackingCount} · other-account backings: {a.otherAccountBackingCount} · anonymous backings: {a.anonymousBackingCount}</li>
          </ul>
          {a.backings.length > 0 && (
            <table className="developer-table">
              <thead>
                <tr><th>Channel</th><th>Relationship to report account</th><th>Account</th><th>Document identity</th><th>Admission decision</th><th>Source report</th></tr>
              </thead>
              <tbody>
                {a.backings.map((backing, index) => (
                  <tr key={index}>
                    <td>{backing.channel}</td>
                    <td>{backing.relationshipToReportAccount}</td>
                    <td>{backing.accountEmail ? `${backing.accountUsername ?? "?"} (${backing.accountEmail})` : backing.accountUsername ?? "anonymous"}</td>
                    <td>{backing.documentIdentityId ?? "—"}</td>
                    <td>{backing.admissionDecisionId ?? "—"}</td>
                    <td>{backing.sourceReportId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {a.backingListTruncated && <p>(backing list truncated)</p>}
        </>
      )}
      {dev && (
        <>
          <h4>Device Passport shadow evidence (per representation)</h4>
          <ul>
            <li>sameVerifiedDeviceBacking: {yesNo(dev.sameVerifiedDeviceBacking)}</li>
            <li>sameDeviceBackingCount: {dev.sameDeviceBackingCount}</li>
            <li>independentBackingCount: {dev.independentBackingCount}</li>
            <li>backingsWithoutDeviceProvenance: {dev.backingsWithoutDeviceProvenance}</li>
            <li>admittedBackingsDifferentDevice: {dev.admittedBackingsDifferentDevice}</li>
            <li>admittedBackingsNoDeviceProvenance: {dev.admittedBackingsNoDeviceProvenance}</li>
            <li>admittedPromotionBackingCount: {dev.admittedPromotionBackingCount}</li>
            <li>submissionReferenceBackingCount: {dev.submissionReferenceBackingCount}</li>
            <li>identitySameAccount: {yesNo(dev.identitySameAccount)}</li>
            <li>priorSameAccountIdentityCount: {dev.priorSameAccountIdentityCount}</li>
          </ul>
        </>
      )}
    </details>
  );
}
