"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  CircleCheck,
  CircleHelp,
  ExternalLink,
  Files,
  GitCompareArrows,
  LayoutTemplate,
  Quote,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { SimilarityReport } from "@/lib/report-types";
import type { EvidenceInterpretationKind } from "@/lib/evidence-interpretation/kinds";
import {
  buildReportV2ViewModel,
  type ReportV2Filter,
  type ReportV2Passage,
  type ReportV2SourceCard,
  type ReportV2ViewModel,
} from "@/lib/report-v2-view";

/**
 * REPORT V2 UI — first screen + passage review + source cards, rendered from
 * the additive `evidenceInterpretation` / `reportCompletion` payload only.
 *
 * NO new score: the headline is `primarySimilarityScore(report)` verbatim (via
 * the view-model) and the kind bars are disjoint slices of the SAME matched-
 * word union. Nothing here recomputes a matched position.
 *
 * Renders nothing when the payload is absent — the caller falls back to the
 * existing report UI.
 */

const KIND_ICON: Record<EvidenceInterpretationKind, typeof Search> = {
  DISTINCTIVE_EXTERNAL_MATCH: Search,
  ATTRIBUTED_QUOTATION: Quote,
  DECLARED_QUOTATION: Quote,
  LEGITIMATE_ALTERNATE_SOURCE: Files,
  POSSIBLE_SAME_WORK: GitCompareArrows,
  FAMILY_BOILERPLATE: LayoutTemplate,
};

/** stable CSS hook per kind — drives the shape/border, never colour alone. */
const KIND_CLASS: Record<EvidenceInterpretationKind, string> = {
  DISTINCTIVE_EXTERNAL_MATCH: "rv2-kind-distinctive",
  ATTRIBUTED_QUOTATION: "rv2-kind-attributed",
  DECLARED_QUOTATION: "rv2-kind-declared",
  LEGITIMATE_ALTERNATE_SOURCE: "rv2-kind-alternate",
  POSSIBLE_SAME_WORK: "rv2-kind-samework",
  FAMILY_BOILERPLATE: "rv2-kind-boilerplate",
};

const FILTER_LABEL: Record<ReportV2Filter, string> = {
  all: "All",
  review: "Review",
  quotations: "Quotations",
  other: "Other",
};

function KindIcon({ kind }: { kind: EvidenceInterpretationKind }) {
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden="true" className="rv2-kind-icon" />;
}

function ConfidenceDots({ level, label }: { level: "high" | "medium" | "low"; label: string }) {
  const filled = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span className="rv2-confidence" title={`Confidence: ${label}`}>
      <span aria-hidden="true" className="rv2-confidence-dots">
        {[0, 1, 2].map((i) => (
          <i key={i} className={i < filled ? "on" : ""} />
        ))}
      </span>
      <span className="rv2-sr-only">Confidence: {label}</span>
    </span>
  );
}

// ── first screen ─────────────────────────────────────────────────────────
function CompletionStrip({ vm }: { vm: ReportV2ViewModel }) {
  const c = vm.summary.completion;
  const ok = c.state === "COMPLETED";
  return (
    <div className={`rv2-completion rv2-completion-${ok ? "ok" : "attention"}`} role="status">
      <span className="rv2-completion-icon" aria-hidden="true">
        {ok ? <CircleCheck /> : <TriangleAlert />}
      </span>
      <div>
        <p className="rv2-completion-headline">{c.headline}</p>
        {c.detail && <p className="rv2-completion-detail">{c.detail}</p>}
        <p className="rv2-completion-scope">{c.scopeLine}</p>
      </div>
    </div>
  );
}

function OverlapBreakdown({ vm }: { vm: ReportV2ViewModel }) {
  const { verifiedSimilarityPercent, breakdown, deferredNote, matchedWordCount } = vm.summary;
  if (matchedWordCount === 0) {
    return (
      <section className="rv2-section rv2-breakdown" aria-labelledby="rv2-breakdown-title">
        <h3 id="rv2-breakdown-title">What kind of overlap is this?</h3>
        <p className="rv2-empty">
          No verified overlap was found within the available TurnitPlus source scope.
        </p>
      </section>
    );
  }
  return (
    <section className="rv2-section rv2-breakdown" aria-labelledby="rv2-breakdown-title">
      <h3 id="rv2-breakdown-title">What kind of overlap is this?</h3>
      <p className="rv2-breakdown-lead">
        Of the verified overlap ({verifiedSimilarityPercent}% of the document):
      </p>
      <ul className="rv2-bars">
        {breakdown.map((row) => (
          <li
            key={row.kind}
            className={`rv2-bar-row ${KIND_CLASS[row.kind]}`}
            aria-label={`${row.percentOfDocument} percent, ${row.label}`}
          >
            <span className="rv2-bar-track" aria-hidden="true">
              <span className="rv2-bar-fill" style={{ width: `${Math.max(2, row.shareOfOverlap)}%` }} />
            </span>
            <span className="rv2-bar-meta">
              <KindIcon kind={row.kind} />
              <b className="rv2-bar-pct">{row.percentOfDocument}%</b>
              <span className="rv2-bar-label">{row.label}</span>
              <span className="rv2-bar-words">{row.matchedWords.toLocaleString()} words</span>
            </span>
          </li>
        ))}
      </ul>
      {deferredNote && <p className="rv2-deferred-note">{deferredNote}</p>}
    </section>
  );
}

function TopSources({ vm }: { vm: ReportV2ViewModel }) {
  const { topSources, distinctVerifiedSources } = vm.summary;
  if (topSources.length === 0) return null;
  return (
    <section className="rv2-section rv2-top-sources" aria-labelledby="rv2-top-sources-title">
      <h3 id="rv2-top-sources-title">Top sources</h3>
      <ul className="rv2-top-source-list">
        {topSources.map((s) => (
          <li key={s.id}>
            <a className="rv2-top-source-link" href={`#rv2-source-${s.id}`}>
              <span className="rv2-top-source-name">
                <span className={`rv2-source-dot rv2-source-dot-${s.sourceType}`} aria-hidden="true" />
                <span className="rv2-source-label">{s.label}</span>
              </span>
              <span className="rv2-top-source-figures">
                <b>{s.contributionPercent}%</b>
                <span>{s.matchedWords.toLocaleString()} words</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {distinctVerifiedSources > topSources.length && (
        <a className="rv2-see-all" href="#rv2-sources">
          See all {distinctVerifiedSources} sources
        </a>
      )}
    </section>
  );
}

function FirstScreen({ vm }: { vm: ReportV2ViewModel }) {
  const { verifiedSimilarityPercent, matchedWordCount, totalWordCount, distinctVerifiedSources } = vm.summary;
  return (
    <div className="rv2-first-screen">
      <section className="rv2-section rv2-headline" aria-labelledby="rv2-headline-title">
        <h2 id="rv2-headline-title">{vm.headlineLabel}</h2>
        <p className="rv2-headline-value">
          <strong>{verifiedSimilarityPercent}%</strong>
        </p>
        <p className="rv2-headline-sub">
          {matchedWordCount.toLocaleString()} of {totalWordCount.toLocaleString()} matched words
          {" · "}
          {distinctVerifiedSources} verified source{distinctVerifiedSources === 1 ? "" : "s"}
        </p>
        <p className="rv2-headline-hint">
          The share of your document that word-for-word matches a source we retrieved and checked. It is
          not a judgement about your work.
        </p>
        <CompletionStrip vm={vm} />
      </section>

      <OverlapBreakdown vm={vm} />
      <TopSources vm={vm} />

      {vm.hasPassages && (
        <p className="rv2-jump">
          <a href={`#rv2-passage-${vm.passages[0].id}`}>
            Jump to the first highlighted passage ({vm.filterCounts.all})
          </a>
        </p>
      )}
    </div>
  );
}

// ── passage review ───────────────────────────────────────────────────────
function HighlightedDocument({
  report,
  passages,
  activeFilter,
}: {
  report: SimilarityReport;
  passages: ReportV2Passage[];
  activeFilter: ReportV2Filter;
}) {
  const text = report.text ?? "";
  const runs = passages
    .filter((p) => p.charStart !== null && p.charEnd !== null)
    .filter((p) => activeFilter === "all" || p.filter === activeFilter)
    .sort((a, b) => (a.charStart! - b.charStart!));

  if (text.length === 0) {
    return <p className="rv2-empty">Your submitted text is not available for inline highlighting.</p>;
  }
  if (runs.length === 0) {
    return <div className="rv2-doc rv2-doc-plain">{text}</div>;
  }

  const pieces: ReactNode[] = [];
  let cursor = 0;
  runs.forEach((p, idx) => {
    const start = Math.max(cursor, p.charStart!);
    const end = Math.max(start, p.charEnd!);
    if (start > cursor) pieces.push(<span key={`t-${idx}`}>{text.slice(cursor, start)}</span>);
    pieces.push(
      <mark
        key={`m-${p.id}`}
        id={`rv2-passage-${p.id}`}
        className={`rv2-mark rv2-tone-${p.tone} ${KIND_CLASS[p.kind]}`}
        aria-label={`${p.label}${p.sourceIds.length ? `, matched to ${p.sourceIds.join(", ")}` : ""}`}
      >
        {text.slice(start, end)}
        <span className="rv2-mark-tag" aria-hidden="true">
          <KindIcon kind={p.kind} />
          {p.label}
        </span>
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) pieces.push(<span key="t-tail">{text.slice(cursor)}</span>);

  return <div className="rv2-doc">{pieces}</div>;
}

function PassageRow({ passage, sources }: { passage: ReportV2Passage; sources: ReportV2SourceCard[] }) {
  const matched = passage.sourceIds
    .map((id) => sources.find((s) => s.id === id))
    .filter((s): s is ReportV2SourceCard => Boolean(s));
  return (
    <li className={`rv2-passage-row ${KIND_CLASS[passage.kind]} rv2-tone-${passage.tone}`}>
      <div className="rv2-passage-head">
        <span className="rv2-chip">
          <KindIcon kind={passage.kind} />
          {passage.label}
        </span>
        <ConfidenceDots level={passage.confidence} label={passage.confidenceLabel} />
      </div>
      <blockquote className="rv2-passage-excerpt">{passage.excerpt}</blockquote>
      <p className="rv2-passage-meaning">{passage.meaning}</p>
      <div className="rv2-passage-foot">
        {matched.length > 0 ? (
          <span className="rv2-passage-sources">
            Source{matched.length === 1 ? "" : "s"}:{" "}
            {matched.map((s, i) => (
              <span key={s.id}>
                {i > 0 ? ", " : ""}
                <a href={`#rv2-source-${s.id}`}>{s.label}</a>
              </span>
            ))}
          </span>
        ) : (
          <span className="rv2-passage-sources rv2-muted">Matched source listed below</span>
        )}
        {passage.charStart !== null && (
          <a className="rv2-passage-jump" href={`#rv2-passage-${passage.id}`}>
            Show in document
          </a>
        )}
      </div>
    </li>
  );
}

function PassageReview({
  report,
  vm,
}: {
  report: SimilarityReport;
  vm: ReportV2ViewModel;
}) {
  const [filter, setFilter] = useState<ReportV2Filter>("all");
  const visible = useMemo(
    () => vm.passages.filter((p) => filter === "all" || p.filter === filter),
    [vm.passages, filter],
  );
  const filters: ReportV2Filter[] = ["all", "review", "quotations", "other"];

  return (
    <section className="rv2-section rv2-passage-review" id="rv2-passages" aria-labelledby="rv2-passages-title">
      <h3 id="rv2-passages-title">Passages to review ({vm.filterCounts.all})</h3>

      {vm.filterCounts.all === 0 ? (
        <p className="rv2-empty">No passages were highlighted in your document.</p>
      ) : (
        <>
          <div className="rv2-filter-bar" role="group" aria-label="Filter highlighted passages">
            {filters.map((f) => (
              <button
                key={f}
                type="button"
                className={`rv2-filter ${filter === f ? "is-active" : ""}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {FILTER_LABEL[f]} ({vm.filterCounts[f]})
              </button>
            ))}
          </div>

          <div className="rv2-doc-wrap">
            <HighlightedDocument report={report} passages={vm.passages} activeFilter={filter} />
          </div>

          {visible.length === 0 ? (
            <p className="rv2-empty">No passages match this filter.</p>
          ) : (
            <ol className="rv2-passage-list">
              {visible.map((p) => (
                <PassageRow key={p.id} passage={p} sources={vm.sources} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

// ── source cards ─────────────────────────────────────────────────────────
function SourceCard({ card, verifiedPercent }: { card: ReportV2SourceCard; verifiedPercent: number }) {
  const multiSource = card.mixedKindLabels.length > 0;
  return (
    <article className={`rv2-source-card ${KIND_CLASS[card.primaryKind]}`} id={`rv2-source-${card.id}`}>
      <header className="rv2-source-card-head">
        <h4 className="rv2-source-card-title">{card.label}</h4>
        <span className={`rv2-source-badge rv2-source-badge-${card.sourceType}`}>{card.badge}</span>
      </header>

      <p className="rv2-source-card-figures">
        <b>{card.contributionPercent}% contribution</b>
        {" · "}
        {card.matchedWords.toLocaleString()} matched words
      </p>
      <span className="rv2-source-card-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(2, card.contributionPercent))}%` }} />
      </span>

      <p className="rv2-source-card-interp">
        <span className="rv2-chip">
          <KindIcon kind={card.primaryKind} />
          {card.primaryLabel}
        </span>
        <ConfidenceDots level={card.confidence} label={card.confidenceLabel} />
      </p>

      {card.reasons.length > 0 && (
        <ul className="rv2-source-card-reasons">
          {card.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {multiSource && (
        <p className="rv2-source-card-mixed">Also contains: {card.mixedKindLabels.join(", ")}</p>
      )}

      {card.isGeneric ? (
        <p className="rv2-source-card-generic">
          {card.matchedWords.toLocaleString()} matched words — no account, document, or person is
          identified for this match.
        </p>
      ) : null}

      {card.namedSources.length > 0 && (
        <details className="rv2-disclose">
          <summary>Named sources ({card.namedSources.length})</summary>
          <ul className="rv2-named-sources">
            {card.namedSources.map((n, i) => (
              <li key={i}>
                <span className="rv2-source-label">{n.label}</span>
                <span>
                  {n.contributionPercent}% · {n.matchedWords.toLocaleString()} words
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {card.passageRefs.length > 0 && (
        <details className="rv2-disclose">
          <summary>Matched passages ({card.passageRefs.length})</summary>
          <ul className="rv2-source-card-passages">
            {card.passageRefs.map((ref) => (
              <li key={ref}>
                <a href={`#rv2-passage-${ref}`}>Passage {ref + 1} in your document</a>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="rv2-disclose">
        <summary>Why this label</summary>
        <p className="rv2-source-card-meaning">{card.meaning}</p>
      </details>

      <div className="rv2-source-card-links">
        {card.link ? (
          <a href={card.link} target="_blank" rel="noreferrer" className="rv2-source-card-url">
            <ExternalLink aria-hidden="true" />
            <span className="rv2-source-label">{hostAndPath(card.link)}</span>
          </a>
        ) : card.doi ? (
          <span className="rv2-source-card-doi">DOI: {card.doi}</span>
        ) : null}
        {card.year ? <span className="rv2-source-card-year">({card.year})</span> : null}
      </div>

      {multiSource && (
        <p className="rv2-source-card-note">
          Some of these words also matched another source and are counted once in the {verifiedPercent}%
          total.
        </p>
      )}
    </article>
  );
}

function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

function SourceCards({ vm }: { vm: ReportV2ViewModel }) {
  if (vm.sources.length === 0) return null;
  return (
    <section className="rv2-section rv2-source-cards" id="rv2-sources" aria-labelledby="rv2-sources-title">
      <h3 id="rv2-sources-title">Source details</h3>
      <div className="rv2-source-card-grid">
        {vm.sources.map((card) => (
          <SourceCard key={card.id} card={card} verifiedPercent={vm.summary.verifiedSimilarityPercent} />
        ))}
      </div>
    </section>
  );
}

// ── public component ─────────────────────────────────────────────────────
export function ReportV2View({ report }: { report: SimilarityReport }) {
  const vm = useMemo(() => buildReportV2ViewModel(report), [report]);
  if (!vm) return null;
  return (
    <div className="report-v2" data-interpretation-version={vm.interpretationVersion}>
      <FirstScreen vm={vm} />
      <PassageReview report={report} vm={vm} />
      <SourceCards vm={vm} />
      <p className="rv2-provenance">
        <CircleHelp aria-hidden="true" />
        <span>
          “Verified” means TurnitPlus retrieved the source text and confirmed the overlap
          word-for-word. It is not a judgement about your work.
          {vm.sources.some((s) => s.isGeneric)
            ? " The TurnitPlus reference collection is shown without identifying any account, document, or person."
            : ""}
        </span>
      </p>
    </div>
  );
}

/** Static, print-friendly variant — same content, no interactive filter bar. */
export function ReportV2Print({ report }: { report: SimilarityReport }) {
  const vm = buildReportV2ViewModel(report);
  if (!vm) return null;
  return (
    <div className="report-v2 report-v2-print">
      <FirstScreen vm={vm} />
      <section className="rv2-section" aria-label="Highlighted passages">
        <h3>Passages to review ({vm.filterCounts.all})</h3>
        {vm.hasPassages ? (
          <ol className="rv2-passage-list">
            {vm.passages.map((p) => (
              <PassageRow key={p.id} passage={p} sources={vm.sources} />
            ))}
          </ol>
        ) : (
          <p className="rv2-empty">No passages were highlighted in your document.</p>
        )}
      </section>
      <SourceCards vm={vm} />
    </div>
  );
}
