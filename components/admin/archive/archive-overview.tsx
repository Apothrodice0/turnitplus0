import { ArrowRight, CircleCheck, Hourglass, Inbox, Info, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ArchiveExplorerSummary } from "./archive-types";
import { formatCount } from "./archive-format";

/**
 * Top of /admin/archive — the headline "active matching sources" figure,
 * the supporting stat tiles, and the admission lifecycle (Stored → Maturing
 * → Active). Purely presentational over getArchiveExplorerSummary's output;
 * the page gates and loads it.
 */
export function ArchiveOverview({ summary }: { summary: ArchiveExplorerSummary }) {
  const { activeMatchingSources: active, referenceArchive, admissions, added, rejectedOrDuplicate } = summary;
  const referenceShare = active.total > 0 ? (active.referenceArchive / active.total) * 100 : 0;

  return (
    <>
      <section className="admin-archive-summary" aria-label="Corpus totals">
        <div className="admin-archive-hero">
          <div className="admin-archive-eyebrow">Active matching sources</div>
          <div className="admin-archive-hero-value">{formatCount(active.total)}</div>
          <p className="admin-archive-hero-caption">Distinct sources that can contribute a match right now, under each matcher&apos;s own eligibility rule.</p>
          {active.total > 0 && (
            <div className="admin-archive-composition" role="img" aria-label={`${active.referenceArchive} reference archive, ${active.priorSubmissions} prior submissions`}>
              {active.referenceArchive > 0 && <span className="admin-archive-composition-seg admin-archive-composition-seg--reference" style={{ flexGrow: referenceShare }} />}
              {active.priorSubmissions > 0 && <span className="admin-archive-composition-seg admin-archive-composition-seg--submissions" style={{ flexGrow: 100 - referenceShare }} />}
            </div>
          )}
          <ul className="admin-archive-legend">
            <li>
              <span className="admin-archive-key admin-archive-key--reference" aria-hidden="true" />
              <span>Reference archive</span>
              <strong>{formatCount(active.referenceArchive)}</strong>
            </li>
            <li>
              <span className="admin-archive-key admin-archive-key--submissions" aria-hidden="true" />
              <span>Prior submissions</span>
              <strong>{formatCount(active.priorSubmissions)}</strong>
            </li>
          </ul>
        </div>

        <div className="admin-archive-tiles">
          <StatTile
            label="Reference archive sources"
            value={referenceArchive.total}
            sub={`${formatCount(referenceArchive.fingerprintedUnderActiveVersion)} fingerprinted · ${referenceArchive.activeFingerprintVersion}`}
          />
          <StatTile label="Stored submissions" value={admissions.storedTotal} sub="Accepted and retained, any maturity" />
          <StatTile label="Maturing submissions" value={admissions.maturing} sub={`Inside the ${summary.maturityWindowDays}-day window`} />
          <StatTile label="Added today" value={added.today} sub="New stored sources · UTC day" />
          <StatTile label="Added in 7 days" value={added.last7Days} sub={`${formatCount(added.last30Days)} in 30 days`} />
          <StatTile label="Duplicate / rejected" value={rejectedOrDuplicate.total} sub={`${formatCount(rejectedOrDuplicate.last7Days)} in 7 days · never stored`} />
        </div>
      </section>
      <p className="admin-archive-scope-note">
        <Info size={14} aria-hidden="true" />
        Hosted runtime only. The authoritative local archive library is not visible to this deployment and is not counted here.
      </p>
    </>
  );
}

function StatTile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="admin-archive-tile">
      <div className="admin-archive-tile-label">{label}</div>
      <div className="admin-archive-tile-value">{formatCount(value)}</div>
      <div className="admin-archive-tile-sub">{sub}</div>
    </div>
  );
}

/**
 * The admission lifecycle as the policy actually runs it: an accepted upload
 * is Stored and Maturing at once; when its window elapses it leaves
 * Maturing, and becomes Active only if it is also indexed into the matching
 * corpus — otherwise it waits in Awaiting index.
 */
export function ArchiveLifecycle({ summary }: { summary: ArchiveExplorerSummary }) {
  const { admissions, flags, maturityWindowDays } = summary;
  return (
    <div className="admin-archive-lifecycle">
      <div className="admin-archive-flow" role="list" aria-label="Admitted submission lifecycle">
        <FlowStage icon={Inbox} label="Stored" value={admissions.storedTotal} hint="Accepted & retained" tone="stored" />
        <ArrowRight size={18} className="admin-archive-flow-arrow" aria-hidden="true" />
        <FlowStage icon={Hourglass} label="Maturing" value={admissions.maturing} hint={`${maturityWindowDays}-day window`} tone="maturing" />
        <ArrowRight size={18} className="admin-archive-flow-arrow" aria-hidden="true" />
        <FlowStage icon={CircleCheck} label="Active" value={admissions.active} hint="Match-eligible" tone="active" />
        <FlowStage icon={Timer} label="Awaiting index" value={admissions.awaitingIndex} hint="Mature, not indexed" tone="waiting" />
      </div>
      <p className="admin-archive-lifecycle-rule">
        A new accepted upload counts <strong>Stored +1</strong> and <strong>Maturing +1</strong>. After {maturityWindowDays} days it leaves
        Maturing — <strong>Active +1</strong> once it is indexed into the matching corpus, otherwise <strong>Awaiting index +1</strong>.
      </p>
      <dl className="admin-archive-outcomes">
        <div><dt>Duplicate</dt><dd>{formatCount(admissions.duplicate)}</dd></div>
        <div><dt>Rejected</dt><dd>{formatCount(admissions.rejected)}</dd></div>
        <div><dt>Held for review</dt><dd>{formatCount(admissions.review)}</dd></div>
        <div><dt>Removed</dt><dd>{formatCount(admissions.removed)}</dd></div>
        <div><dt>Pending evaluation</dt><dd>{formatCount(admissions.pendingEvaluation)}</dd></div>
        <div><dt>Legacy submissions</dt><dd>{formatCount(summary.legacy.total)}</dd></div>
      </dl>
      {!flags.promotionEnabled && (
        <p className="admin-archive-callout" role="note">
          Promotion is off in this environment, so accepted uploads are stored but cannot become Active.
        </p>
      )}
      {!flags.sourceMatchingEnabled && (
        <p className="admin-archive-callout" role="note">
          Corpus source matching is off: matches from admitted submissions are withheld from reports. Eligibility shown here is unaffected.
        </p>
      )}
    </div>
  );
}

function FlowStage({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  hint: string;
  tone: "stored" | "maturing" | "active" | "waiting";
}) {
  return (
    <div className={`admin-archive-stage admin-archive-stage--${tone}`} role="listitem">
      <span className="admin-archive-stage-icon"><Icon size={16} aria-hidden="true" /></span>
      <span className="admin-archive-stage-label">{label}</span>
      <span className="admin-archive-stage-value">{formatCount(value)}</span>
      <span className="admin-archive-stage-hint">{hint}</span>
    </div>
  );
}

export function ArchiveRuntimePills({ summary }: { summary: ArchiveExplorerSummary }) {
  const pills: { label: string; on: boolean }[] = [
    { label: "Server-side archive", on: summary.flags.archiveServerSideEnabled },
    { label: "Promotion", on: summary.flags.promotionEnabled },
    { label: "Corpus source matching", on: summary.flags.sourceMatchingEnabled },
  ];
  return (
    <ul className="admin-archive-runtime" aria-label="Runtime flags">
      {pills.map((pill) => (
        <li key={pill.label} className={pill.on ? "is-on" : "is-off"}>
          <span className="admin-archive-runtime-dot" aria-hidden="true" />
          {pill.label}
          <strong>{pill.on ? "On" : "Off"}</strong>
        </li>
      ))}
      <li className="is-neutral">
        <Hourglass size={13} aria-hidden="true" />
        Maturity window
        <strong>{summary.maturityWindowDays} days</strong>
      </li>
    </ul>
  );
}
