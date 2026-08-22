"use client";

import { useEffect, useState } from "react";

type Detail = {
  rowId: string;
  status: string;
  decisionId: string | null;
  decision: string | null;
  policyVersion: string | null;
  reasonCodes: string[];
  hardGatePassed: boolean | null;
  hardGateFailureCodes: string[];
  detectedFormat: string | null;
  extractedWordCount: number | null;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  canonicalSha256: string | null;
  qualityScore: number | null;
  qualityModelVersion: string | null;
  componentScores: Record<string, unknown> | null;
  corpusValueScore: number | null;
  familyRelation: string | null;
  familyMatchedSourceRef: string | null;
  familyContainment: number | null;
  decisionCreatedAt: string | null;
  jobId: string | null;
  jobStatus: string | null;
  attemptCount: number | null;
  lastError: string | null;
  claimedAt: string | null;
  jobCreatedAt: string | null;
  jobUpdatedAt: string | null;
  accountId: string | null;
  accountEmail: string | null;
  deviceKey: string | null;
  reportId: string | null;
  reportStillExists: boolean;
  acceptedRepresentationId: string | null;
  acceptedRepresentationActive: boolean | null;
  revokedAt: string | null;
  hasRetainedText: boolean;
};

/** Client-side detail view for /admin/corpus/[id] — hits GET /api/admin/corpus/[id], and POST .../preview | .../deactivate | .../reactivate, all independently gated by getAdminSessionUser. */
export function AdminCorpusDetail({ rowId }: { rowId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [preview, setPreview] = useState<{ preview: string; truncated: boolean; fullLength: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  function loadDetail() {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/corpus/${encodeURIComponent(rowId)}`)
      .then((response) => {
        if (response.status === 404) throw new Error("Not found.");
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return response.json() as Promise<Detail>;
      })
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setLoading(false));
  }

  useEffect(loadDetail, [rowId]);

  async function revealPreview() {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const response = await fetch(`/api/admin/corpus/${encodeURIComponent(rowId)}/preview`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      setPreview(await response.json());
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runAction(action: "deactivate" | "reactivate") {
    setActionLoading(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/admin/corpus/${encodeURIComponent(rowId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; outcome?: string; activeConflictSourceRef?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? (body?.outcome === "conflict" ? `Conflict: another active fingerprint already holds this content (${body.activeConflictSourceRef}).` : `Request failed (${response.status})`));
      }
      setReason("");
      loadDetail();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!detail) return null;

  return (
    <>
      <header className="developer-header">
        <h1>Admission {detail.rowId}</h1>
        <p>Status: {detail.status} {detail.decision ? `(${detail.decision})` : ""}</p>
      </header>

      <section>
        <h2>Quality &amp; component scores</h2>
        <ul>
          <li>Quality score: {detail.qualityScore ?? "—"} ({detail.qualityModelVersion ?? "—"})</li>
          <li>Corpus value score: {detail.corpusValueScore ?? "—"}</li>
          <li>Family relation: {detail.familyRelation ?? "—"} {detail.familyMatchedSourceRef ? `→ ${detail.familyMatchedSourceRef}` : ""} {detail.familyContainment !== null ? `(containment ${detail.familyContainment})` : ""}</li>
        </ul>
        {detail.componentScores && <details><summary>Raw component scores</summary><pre>{JSON.stringify(detail.componentScores, null, 2)}</pre></details>}
      </section>

      <section>
        <h2>Reason codes &amp; errors (debug)</h2>
        <ul>
          <li>Hard gate passed: {detail.hardGatePassed === null ? "—" : String(detail.hardGatePassed)}</li>
          <li>Hard gate failure codes: {detail.hardGateFailureCodes.length > 0 ? detail.hardGateFailureCodes.join(", ") : "none"}</li>
          <li>Reason codes: {detail.reasonCodes.length > 0 ? detail.reasonCodes.join(", ") : "none"}</li>
          <li>Last error: {detail.lastError ?? "none"}</li>
        </ul>
      </section>

      <section>
        <h2>Language, word count, format</h2>
        <ul>
          <li>Detected language: {detail.detectedLanguage ?? "—"} (confidence {detail.languageConfidence ?? "—"})</li>
          <li>Extracted word count: {detail.extractedWordCount ?? "—"}</li>
          <li>Detected format: {detail.detectedFormat ?? "—"}</li>
          <li>Canonical SHA-256: <code>{detail.canonicalSha256 ?? "—"}</code></li>
        </ul>
      </section>

      <section>
        <h2>Source report</h2>
        {detail.accountId ? (
          <ul>
            <li>Account: {detail.accountEmail ?? detail.accountId}</li>
            <li>Device key: {detail.deviceKey ?? "—"} · Report id: {detail.reportId ?? "—"}</li>
            <li>{detail.reportStillExists ? "The source report still exists." : "The source report has been deleted (accepted content still survives, by design)."}</li>
          </ul>
        ) : (
          <p>No source report is associated with this row (job tracking has been removed, or this was not a live-report submission).</p>
        )}
      </section>

      <section>
        <h2>Timestamps &amp; attempts</h2>
        <ul>
          <li>Decision created: {detail.decisionCreatedAt ?? "—"}</li>
          <li>Job created: {detail.jobCreatedAt ?? "—"} · updated: {detail.jobUpdatedAt ?? "—"}</li>
          <li>Attempt count: {detail.attemptCount ?? "—"}</li>
          <li>Currently claimed: {detail.claimedAt ?? "no"}</li>
        </ul>
      </section>

      <section>
        <h2>Retained text</h2>
        {detail.hasRetainedText ? (
          <>
            <button type="button" onClick={revealPreview} disabled={previewLoading}>
              {previewLoading ? "Loading…" : "Reveal retained text preview"}
            </button>
            <p><em>Revealing a preview is audit-logged.</em></p>
            {previewError && <p role="alert">{previewError}</p>}
            {preview && (
              <>
                <pre>{preview.preview}</pre>
                {preview.truncated && <p>Truncated — full length {preview.fullLength} characters.</p>}
              </>
            )}
          </>
        ) : (
          <p>No retained text exists for this row.</p>
        )}
      </section>

      {detail.acceptedRepresentationId && (
        <section>
          <h2>Fingerprint status</h2>
          <p>{detail.acceptedRepresentationActive ? "Active — participates in family matching." : `Deactivated at ${detail.revokedAt}.`}</p>
          <label>
            Reason (required):{" "}
            <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Short justification" />
          </label>
          {detail.acceptedRepresentationActive ? (
            <button type="button" onClick={() => runAction("deactivate")} disabled={actionLoading}>Deactivate</button>
          ) : (
            <button type="button" onClick={() => runAction("reactivate")} disabled={actionLoading}>Reactivate</button>
          )}
          {actionError && <p role="alert">{actionError}</p>}
        </section>
      )}
    </>
  );
}
