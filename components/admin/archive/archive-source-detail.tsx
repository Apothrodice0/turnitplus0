"use client";

import type { ReactNode } from "react";
import { CircleCheck, CircleMinus, Hourglass, X } from "lucide-react";
import { AdminStatusBadge, YesNoBadge } from "@/components/admin/status-badge";
import type { ArchiveExplorerDetail } from "./archive-types";
import { SOURCE_CLASS_LABEL, STATE_BADGE_KEY, STATE_LABEL, formatCount, formatDateTime } from "./archive-format";

const MS_PER_DAY = 86_400_000;

function eligibilityExplanation(detail: ArchiveExplorerDetail): string {
  switch (detail.state) {
    case "active":
      if (detail.sourceClass === "reference_archive") return "Eligible now under the archive matcher's rule. Reference sources have no maturity window.";
      if (detail.sourceClass === "admitted_submission" && detail.maturityExemptionApplies) {
        return "Eligible now under the matching rule: indexed, with the account's maturity exemption in effect.";
      }
      return `Eligible now under the matching rule: indexed and past the ${detail.maturityWindowDays}-day maturity window.`;
    case "maturing": {
      const needsIndex = detail.sourceClass === "admitted_submission" && detail.promotionStatus !== "indexed";
      const base = `Inside the ${detail.maturityWindowDays}-day maturity window until ${formatDateTime(detail.maturesAt)} — not eligible for cross-account matching yet.`;
      const alsoEligible = detail.matchEligible ? " The same content is already match-eligible through another corpus backing." : "";
      return `${base}${needsIndex ? " It must also be indexed before it can become Eligible." : ""}${alsoEligible}`;
    }
    case "stored":
      return detail.sourceClass === "admitted_submission"
        ? `Mature, but not indexed into the matching corpus (promotion: ${detail.promotionStatus ?? "not started"}), so it is not match-eligible.`
        : "Stored, but not eligible under its matcher's rule.";
    case "removed":
      return "Deactivated by an admin. It no longer contributes through this entry.";
    case "review":
      return "Held for review by the admission policy — never stored.";
    case "rejected":
      return "Rejected by the admission policy — never stored.";
    case "duplicate":
      return "Already represented in the corpus — rejected as a duplicate, never stored.";
  }
}

function MaturityTimeline({ detail }: { detail: ArchiveExplorerDetail }) {
  if (!detail.maturesAt) return null;
  const start = new Date(detail.addedAt).getTime();
  const end = new Date(detail.maturesAt).getTime();
  const now = new Date(detail.evaluatedAt).getTime();
  const progress = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
  const daysLeft = Math.max(0, Math.ceil((end - now) / MS_PER_DAY));
  return (
    <div className="admin-archive-timeline">
      <div className="admin-archive-timeline-labels">
        <span>Added<strong>{formatDateTime(detail.addedAt)}</strong></span>
        <span>Matures<strong>{formatDateTime(detail.maturesAt)}</strong></span>
      </div>
      <div
        className={`admin-archive-timeline-track${progress >= 1 ? " is-complete" : ""}`}
        role="progressbar"
        aria-label="Maturity window elapsed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="admin-archive-timeline-caption">
        {progress >= 1 ? "Maturity window elapsed" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`}
      </div>
    </div>
  );
}

function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="admin-archive-fact">
      <dt>{label}</dt>
      <dd className={mono ? "is-mono" : undefined}>{children}</dd>
    </div>
  );
}

export function ArchiveSourceDetail({
  sourceId,
  detail,
  loading,
  error,
  onClose,
}: {
  sourceId: string | null;
  detail: ArchiveExplorerDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  if (!sourceId) {
    return (
      <div className="admin-archive-detail admin-archive-detail--empty">
        <p>Select a source to see its eligibility, maturity, provenance and admission diagnostics.</p>
      </div>
    );
  }

  return (
    <div className="admin-archive-detail" aria-live="polite" aria-busy={loading}>
      <div className="admin-archive-detail-head">
        <div className="admin-archive-detail-chips">
          {detail && <span className="admin-archive-class-chip">{SOURCE_CLASS_LABEL[detail.sourceClass]}</span>}
          {detail && <AdminStatusBadge status={STATE_BADGE_KEY[detail.state]} label={STATE_LABEL[detail.state]} />}
        </div>
        <button type="button" className="admin-archive-icon-button" onClick={onClose} aria-label="Close source details">
          <X size={16} />
        </button>
      </div>

      {error && <p role="alert" className="admin-form-error">{error}</p>}
      {!detail && loading && <p className="admin-corpus-loading">Loading source…</p>}

      {detail && (
        <div className={loading ? "admin-archive-detail-body is-refreshing" : "admin-archive-detail-body"}>
          <h3 className="admin-archive-detail-title">{detail.displayName}</h3>
          <code className="admin-archive-detail-id">{detail.sourceId}</code>

          <div className={`admin-archive-eligibility${detail.matchEligible ? " is-eligible" : ""}`}>
            {detail.matchEligible ? <CircleCheck size={18} aria-hidden="true" /> : detail.state === "maturing" ? <Hourglass size={18} aria-hidden="true" /> : <CircleMinus size={18} aria-hidden="true" />}
            <div>
              <strong>{detail.matchEligible ? "Match-eligible now" : "Not match-eligible"}</strong>
              <span className="admin-archive-eligibility-mode">{detail.eligibilityMode === "ARCHIVE" ? "Archive matcher rule" : `Matching rule (${detail.maturityWindowDays}-day maturity)`}</span>
              <p>{eligibilityExplanation(detail)}</p>
            </div>
          </div>

          <MaturityTimeline detail={detail} />

          <dl className="admin-archive-facts">
            <Fact label="Source class">{SOURCE_CLASS_LABEL[detail.sourceClass]}</Fact>
            <Fact label="Provenance">{detail.provenance}</Fact>
            <Fact label="Word count">{formatCount(detail.wordCount)}</Fact>
            <Fact label="Language">{detail.language ?? "—"}</Fact>
            <Fact label="Added">{formatDateTime(detail.addedAt)}</Fact>
            <Fact label="Matures">{detail.maturesAt ? formatDateTime(detail.maturesAt) : "No maturity window"}</Fact>
            <Fact label="Fingerprint" mono>{detail.fingerprintPrefix ? `${detail.fingerprintPrefix}…` : "—"}</Fact>
          </dl>

          {detail.sourceClass === "reference_archive" && (
            <>
              <h4 className="admin-archive-detail-section">Reference archive</h4>
              <dl className="admin-archive-facts">
                <Fact label="Article id" mono>{detail.archiveArticleId}</Fact>
                <Fact label="Source type">{detail.sourceType}</Fact>
                <Fact label="Corpus version" mono>{detail.corpusVersion}</Fact>
                <Fact label="Archive order">{detail.archiveOrder ?? "—"}</Fact>
                <Fact label="Seed fingerprint" mono>{detail.seedFingerprintVersion}</Fact>
                <Fact label="Active fingerprints" mono>{`${formatCount(detail.fingerprintsUnderActiveVersion)} · ${detail.activeFingerprintVersion}`}</Fact>
              </dl>
            </>
          )}

          {detail.sourceClass === "admitted_submission" && (
            <>
              <h4 className="admin-archive-detail-section">Admission</h4>
              <dl className="admin-archive-facts">
                <Fact label="Decision"><AdminStatusBadge status={detail.decision} /></Fact>
                <Fact label="Policy" mono>{detail.policyVersion}</Fact>
                <Fact label="Hard gates"><YesNoBadge value={detail.hardGatePassed} /></Fact>
                <Fact label="Format">{detail.detectedFormat ?? "—"}</Fact>
                <Fact label="Quality score">{detail.qualityScore === null ? "—" : detail.qualityScore.toFixed(1)}</Fact>
                <Fact label="Corpus value">{detail.corpusValueScore === null ? "—" : detail.corpusValueScore.toFixed(2)}</Fact>
                <Fact label="Language confidence">{detail.languageConfidence === null ? "—" : detail.languageConfidence.toFixed(2)}</Fact>
                <Fact label="Family relation">
                  {detail.familyRelation ?? "—"}
                  {detail.familyContainment !== null ? ` · containment ${detail.familyContainment.toFixed(2)}` : ""}
                </Fact>
              </dl>
              {detail.reasonCodes.length > 0 && (
                <div className="admin-archive-codes">
                  <span>Reason codes</span>
                  <ul>{detail.reasonCodes.map((code) => <li key={code}>{code}</li>)}</ul>
                </div>
              )}
              {detail.hardGateFailureCodes.length > 0 && (
                <div className="admin-archive-codes">
                  <span>Hard-gate failures</span>
                  <ul>{detail.hardGateFailureCodes.map((code) => <li key={code}>{code}</li>)}</ul>
                </div>
              )}

              <h4 className="admin-archive-detail-section">Storage &amp; indexing</h4>
              <dl className="admin-archive-facts">
                <Fact label="Stored fingerprint">{detail.storedFingerprint ?? "none"}</Fact>
                <Fact label="Removed">{detail.removedAt ? formatDateTime(detail.removedAt) : "—"}</Fact>
                <Fact label="Retained text"><YesNoBadge value={detail.hasRetainedText} /></Fact>
                <Fact label="Promotion">{detail.promotionStatus ? <AdminStatusBadge status={detail.promotionStatus} /> : "not started"}</Fact>
                <Fact label="Promotion attempts">{detail.promotionAttemptCount ?? "—"}</Fact>
                <Fact label="Link type" mono>{detail.promotionLinkType ?? "—"}</Fact>
                <Fact label="Indexed">{detail.indexedAt ? formatDateTime(detail.indexedAt) : "—"}</Fact>
                <Fact label="Maturity exemption">{detail.maturityExemptionApplies ? "applies" : "—"}</Fact>
              </dl>
            </>
          )}

          {detail.sourceClass === "legacy_submission" && (
            <>
              <h4 className="admin-archive-detail-section">Legacy corpus entry</h4>
              <dl className="admin-archive-facts">
                <Fact label="Representation" mono>{detail.representationId}</Fact>
                <Fact label="Submission references">{formatCount(detail.submissionReferenceCount)}</Fact>
                <Fact label="Indexed admission backings">{formatCount(detail.indexedAdmissionBackings)}</Fact>
                <Fact label="Canonicalization" mono>{detail.canonicalizationVersion}</Fact>
                <Fact label="Extractor" mono>{detail.extractorVersion ?? "—"}</Fact>
              </dl>
            </>
          )}
        </div>
      )}
    </div>
  );
}
