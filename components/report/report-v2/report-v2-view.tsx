"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Download,
  ExternalLink,
  Files,
  GitCompareArrows,
  LayoutTemplate,
  Printer,
  Quote,
  Search,
  TriangleAlert,
} from "lucide-react";
import { similarityScoreBand } from "@/lib/ai-core";
import { PRIMARY_SIMILARITY_BAND_LABELS, formatSimilarityPercent, type SimilarityReport } from "@/lib/report-types";
import type { EvidenceInterpretationKind } from "@/lib/evidence-interpretation/kinds";
import {
  buildReportV2ViewModel,
  paginateManuscriptText,
  resolveWorkspacePassageSelection,
  stepWorkspaceSelection,
  type ReportV2Filter,
  type ReportV2Passage,
  type ReportV2SourceCard,
  type ReportV2ViewModel,
  type ReportV2WorkspaceSelection,
} from "@/lib/report-v2-view";
import { ReportPageFooter, ReportPageHeader } from "../report-page-chrome";
import { buildHighlightedPieces, findHighlightRanges, HighlightLegend } from "../similarity-report-papers";

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
          <strong>{formatSimilarityPercent(verifiedSimilarityPercent, matchedWordCount)}</strong>
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

/**
 * Report-redesign PDF fix — PAGE 1 of the dedicated print/export sequence:
 * the verified overview only (score, breakdown, top sources, completion).
 * Deliberately excludes the old per-passage card catalogue that used to
 * precede the manuscript in print (all N highlighted passages, one full card
 * each) — that wall belongs on screen, inside the interactive "Overlap
 * breakdown" tab (see PassageReview above), never duplicated into a static
 * export where a reader cannot filter it. The manuscript itself (rendered
 * immediately after this in the print bundle — see
 * app/reports/[id]/report-detail-shell.tsx) already shows every matched
 * passage in place, in context. Wrapped in the same `.report-paper` shell
 * (and the shared TurnitPlus chrome) the legacy print papers use, so it
 * picks up the exact same `.print-report-bundle .report-paper` pagination
 * rules — one real page, real TurnitPlus branding, no "T+ integrity".
 */
export function ReportV2PrintOverview({ report }: { report: SimilarityReport }) {
  const vm = buildReportV2ViewModel(report);
  if (!vm) return null;
  // Summary-first pass: this page is now a standalone, self-contained
  // summary — the same hero the screen workspace uses (score, result band,
  // metric cards), PLUS a compact "Top sources" list (vm.summary.topSources
  // — the same already-computed, bounded, authoritative subset the on-screen
  // full view already shows via TopSources; no new computation), so a
  // reader gets result + leading sources without turning a page. No "MATCH
  // REVIEW" heading here any more — SubmissionReport (the next page, forced
  // via the .rv2-print-overview class below) already carries its own
  // "Manuscript" section header and highlight legend, so this page never
  // ends on a heading that dangles in front of a guaranteed page break.
  const toolbarStatus = vm.summary.completion.state === "COMPLETED" ? "Completed" : "Needs attention";
  return (
    <article className="report-paper rv2-print-paper rv2-print-overview">
      <ReportPageHeader report={report} page={1} total={3} label="Similarity Overview" />
      <div className="paper-content">
        <div className="report-v2 report-v2-print">
          <WorkspaceHero vm={vm} toolbarStatus={toolbarStatus} />
          <TopSources vm={vm} />
        </div>
      </div>
      <ReportPageFooter report={report} page={1} total={3} label="Similarity Overview" />
    </article>
  );
}

/**
 * Pagination pass — the manuscript, split into N .report-paper pages
 * instead of one continuously-flowing block. Root cause this replaces: a
 * single tall .submission-paper relied on the BROWSER's own print
 * pagination to spill across physical pages, so only its first and last
 * physical page ever carried real TurnitPlus header/footer chrome — every
 * page in between was bare overflow with no framing at all. Each page here
 * is its own real .report-paper (own ReportPageHeader/ReportPageFooter,
 * own forced break-after so pages never silently re-merge into flowing
 * overflow), computed from the exact same authoritative ranges
 * (findHighlightRanges) and the exact same pagination function
 * (paginateManuscriptText) the screen workspace uses — same boundaries,
 * same red highlight treatment (buildHighlightedPieces, unchanged), same
 * "never split a match across a page" guarantee. The document title and
 * highlight legend appear once, on the first manuscript page only —
 * matching how a real multi-page document's section opener works; every
 * page still repeats the section header/footer via ReportPageHeader/
 * ReportPageFooter, exactly like the summary and appendix pages already do.
 */
export function ReportV2PrintManuscriptPages({ report }: { report: SimilarityReport }) {
  const text = report.text ?? "";
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const ranges = findHighlightRanges(report, { includeWikipedia: canSeeSourceBreakdown });
  const pageRanges = paginateManuscriptText(text, ranges.map((r) => ({ start: r.start, end: r.end })));
  if (pageRanges.length === 0) {
    return (
      <article className="report-paper submission-paper">
        <ReportPageHeader report={report} page={2} total={3} label="Manuscript" />
        <div className="paper-content">
          <div className="submission-title">
            <span>1</span>
            <h2>{report.title.replace(/\.[^.]+$/, "")}</h2>
          </div>
          <div className="submission-rendered-text">Your submitted text is not available for inline highlighting.</div>
        </div>
        <ReportPageFooter report={report} page={2} total={3} label="Manuscript" />
      </article>
    );
  }
  return (
    <>
      {pageRanges.map((range, index) => (
        <article key={`${range.start}-${range.end}`} className="report-paper submission-paper rv2-print-manuscript-page">
          <ReportPageHeader report={report} page={2} total={3} label="Manuscript" />
          <div className="paper-content">
            {index === 0 && (
              <div className="submission-title">
                <span>1</span>
                <h2>{report.title.replace(/\.[^.]+$/, "")}</h2>
              </div>
            )}
            {index === 0 && <HighlightLegend report={report} />}
            <div className="submission-copy">
              <div className="submission-rendered-text">
                {buildHighlightedPieces(text, ranges, range.start, range.end)}
              </div>
            </div>
          </div>
          <ReportPageFooter report={report} page={2} total={3} label="Manuscript" />
        </article>
      ))}
    </>
  );
}

/**
 * Report-redesign PDF fix — FINAL page(s): a compact per-source appendix
 * only (number, title, type, URL/DOI, matched words, match references) —
 * never the full similarity overview a second time. Placed after the
 * manuscript in the print bundle.
 */
export function ReportV2PrintSourceAppendix({ report }: { report: SimilarityReport }) {
  const vm = buildReportV2ViewModel(report);
  // Blank-page fix: SourceCards itself renders nothing for a zero-verified-
  // source report (see its own vm.sources.length === 0 guard) — without this
  // check the wrapping .report-paper chrome (header/footer, one physical
  // page) would still print, leaving a near-empty final page for exactly the
  // "0 matches" case this redesign's own test matrix calls out.
  if (!vm || vm.sources.length === 0) return null;
  return (
    <article className="report-paper rv2-print-paper">
      <ReportPageHeader report={report} page={3} total={3} label="Source Details" />
      <div className="paper-content">
        <div className="report-v2 report-v2-print">
          <SourceCards vm={vm} />
        </div>
      </div>
      <ReportPageFooter report={report} page={3} total={3} label="Source Details" />
    </article>
  );
}

/**
 * Static, print-friendly variant — same content, no interactive filter bar,
 * no passage-card catalogue. Kept as a single combined component for
 * existing callers/tests; app/reports/[id]/report-detail-shell.tsx's own
 * print bundle uses ReportV2PrintOverview/ReportV2PrintSourceAppendix
 * directly instead, so the manuscript can render between them.
 */
export function ReportV2Print({ report }: { report: SimilarityReport }) {
  const vm = buildReportV2ViewModel(report);
  if (!vm) return null;
  return (
    <div className="report-v2 report-v2-print">
      <FirstScreen vm={vm} />
      <SourceCards vm={vm} />
    </div>
  );
}

// ── interactive workspace (screen only) ─────────────────────────────────
// A stable per-source colour identity, layered on top of (never replacing)
// the existing per-KIND tone colouring findHighlightRanges/KIND_CLASS
// already provide — the source NUMBER is always shown too (never colour
// alone), matching this redesign's own accessibility requirement.
const WORKSPACE_SOURCE_COLORS = ["#0f7ea8", "#7b3fe4", "#0f9d58", "#c2410c", "#be185d", "#4338ca", "#0d9488", "#a16207"];
function workspaceSourceColor(index: number): string {
  return WORKSPACE_SOURCE_COLORS[index % WORKSPACE_SOURCE_COLORS.length];
}

/** Same fixed hex palette above, as an rgba() string — used for the manuscript's own translucent match background (a real fill, not a hairline accent), computed in JS rather than a CSS custom property so it works with zero new browser-support assumptions. */
function workspaceSourceTint(index: number, alpha: number): string {
  const hex = workspaceSourceColor(index).replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Visual-correction pass #2: the SAME red the printed manuscript already
 * uses (components/report/similarity-report-papers.tsx's own
 * MATCHED_PASSAGE_COLOR, "#d7263d") — duplicated here as an identical
 * literal rather than imported, since that constant is a private,
 * unexported implementation detail of the print highlighter, and the two
 * files already independently declare their own color constants elsewhere
 * in this codebase (e.g. lib/receipt-pdf.ts's BAND_TONE vs app/globals.css).
 * This is now the ONE color for the "this text is verified-similarity
 * evidence" signal on screen, replacing the previous per-source rainbow
 * background — per-source IDENTITY is still carried by the numbered badge
 * alone (workspaceSourceColor), never by the highlight's own color.
 */
const RV2WS_MATCH_COLOR = "#d7263d";
function rv2wsMatchTint(alpha: number): string {
  return `rgba(215, 38, 61, ${alpha})`;
}

/**
 * Visual-correction pass — the LEFT report surface's own formal introduction,
 * mirroring the AI Detection report's information hierarchy (kicker + big
 * score heading, a tone-coloured result band, then a metric-card grid) one
 * level up from components/report/ai-report.tsx's own AiReport, rather than
 * literally reusing its `.ai-*` classes — this keeps the two report kinds'
 * CSS independently tunable while matching the same visual rhythm, spacing,
 * and typography scale byte-for-byte (see the matching .rv2ws-hero-* rules
 * in app/globals.css, copied from the exact .ai-verdict-card/.ai-report-metrics
 * values). Reads ONLY vm.summary — the identical authoritative numbers the
 * right-side inspector panel renders — so the two can never disagree.
 */
function WorkspaceHero({ vm, toolbarStatus }: { vm: ReportV2ViewModel; toolbarStatus: string }) {
  const { verifiedSimilarityPercent, matchedWordCount, totalWordCount, distinctVerifiedSources } = vm.summary;
  const verdict = similarityScoreBand(verifiedSimilarityPercent);
  const percentDisplay = formatSimilarityPercent(verifiedSimilarityPercent, matchedWordCount);
  return (
    <section className="rv2ws-hero" aria-labelledby="rv2ws-hero-title">
      <p className="paper-kicker">SIMILARITY ANALYSIS</p>
      <h2 id="rv2ws-hero-title" className="rv2ws-hero-title">
        <span>{percentDisplay}</span> Similarity score
      </h2>
      <p className="rv2ws-hero-sub">
        The percentage of analyzed words that overlap verified source text.
      </p>

      <div className={`rv2ws-hero-band${verdict ? ` rv2ws-hero-band-${verdict.key}` : ""}`}>
        <div className="rv2ws-hero-band-score">
          <span>Similarity score</span>
          <strong>{percentDisplay}</strong>
        </div>
        <div className="rv2ws-hero-band-copy">
          <span>Result band</span>
          <strong>{verdict ? PRIMARY_SIMILARITY_BAND_LABELS[verdict.key] : "Similarity"}</strong>
        </div>
        {verdict && <span className="rv2ws-hero-band-range">{verdict.range}</span>}
      </div>

      <div className="rv2ws-hero-metrics">
        <div>
          <strong>{matchedWordCount.toLocaleString()}</strong>
          <span>Matched words</span>
        </div>
        <div>
          <strong>{totalWordCount.toLocaleString()}</strong>
          <span>Words analyzed</span>
        </div>
        <div>
          <strong>{distinctVerifiedSources}</strong>
          <span>Verified source{distinctVerifiedSources === 1 ? "" : "s"}</span>
        </div>
        <div>
          <strong>{toolbarStatus}</strong>
          <span>Search status</span>
        </div>
      </div>
    </section>
  );
}

/** "...context [MATCHED] context..." around one passage's real, verified character range — never the source's own text (see ReportEvidencePassage's own comment: no such text exists in this payload). */
function submittedContextAround(text: string, charStart: number, charEnd: number, pad = 70) {
  return {
    before: text.slice(Math.max(0, charStart - pad), charStart),
    matched: text.slice(charStart, charEnd),
    after: text.slice(charEnd, Math.min(text.length, charEnd + pad)),
  };
}

/**
 * Builds the SAME char-range/tone/kind/red-highlight markup
 * HighlightedDocument (similarity-report-papers.tsx) uses for the print
 * manuscript, bounded to one [rangeStart, rangeEnd) page window — reused
 * per-page by WorkspaceManuscript below rather than one continuous pass
 * over the whole document, so RTL/mixed-direction/typography behavior
 * stays byte-identical to what already ships, just windowed. Adds only: a
 * clickable mark (keyboard-reachable), a stable per-source number badge,
 * and a stronger visual state for the currently active match.
 */
function renderManuscriptWindow(
  text: string,
  runs: ReportV2Passage[],
  rangeStart: number,
  rangeEnd: number,
  sourceIndexById: Map<string, number>,
  activePassageId: number | null,
  onSelectPassage: (passageId: number) => void,
): ReactNode[] {
  const pieces: ReactNode[] = [];
  let cursor = rangeStart;
  const relevant = runs.filter((p) => p.charEnd! > rangeStart && p.charStart! < rangeEnd);
  relevant.forEach((p, idx) => {
    const start = Math.max(cursor, p.charStart!);
    const end = Math.min(rangeEnd, Math.max(start, p.charEnd!));
    if (start > cursor) pieces.push(<span key={`t-${idx}`}>{text.slice(cursor, start)}</span>);
    const firstSourceId = p.sourceIds[0];
    const sourceIndex = firstSourceId !== undefined ? sourceIndexById.get(firstSourceId) : undefined;
    const isActive = p.id === activePassageId;
    // Visual-correction pass #2: the matched WORDS themselves are the
    // primary visual cue (a real translucent background + a solid bottom
    // border), not just the small numbered badge — the previous treatment
    // (a 3px inset box-shadow only) was visually near-invisible next to
    // plain text. Now a single, consistent RED family (RV2WS_MATCH_COLOR —
    // the same red the printed manuscript already uses) for every matched
    // passage, regardless of source: this is the "verified similarity
    // evidence" signal. Per-SOURCE identity moved to the numbered badge
    // alone (still workspaceSourceColor, unchanged below) rather than the
    // highlight's own color, so the manuscript now reads as a classic
    // similarity/plagiarism-style red highlight while still letting a
    // reader tell which numbered source each match belongs to. Applied
    // unconditionally (not gated on sourceIndex like before) — a genuinely
    // matched passage is still evidence even in the rare case its source
    // can't be resolved to a numbered badge, and it should still look
    // highlighted rather than silently falling back to the near-invisible
    // tone-only background.
    const markStyle: CSSProperties = {
      background: rv2wsMatchTint(isActive ? 0.32 : 0.16),
      borderBottomColor: RV2WS_MATCH_COLOR,
    };
    pieces.push(
      <mark
        key={`m-${p.id}`}
        id={`rv2ws-mark-${p.id}`}
        className={`rv2-mark rv2-tone-${p.tone} ${KIND_CLASS[p.kind]} rv2ws-mark${isActive ? " rv2ws-mark-active" : ""}`}
        style={markStyle}
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={`${p.label}${sourceIndex !== undefined ? `, source ${sourceIndex + 1}` : ""}`}
        onClick={() => onSelectPassage(p.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelectPassage(p.id);
          }
        }}
      >
        {text.slice(start, end)}
        {sourceIndex !== undefined && (
          <sup className="rv2ws-mark-number" style={{ background: workspaceSourceColor(sourceIndex) }} aria-hidden="true">
            {sourceIndex + 1}
          </sup>
        )}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < rangeEnd) pieces.push(<span key="t-tail">{text.slice(cursor, rangeEnd)}</span>);
  return pieces;
}

/**
 * The manuscript — now rendered as N separate page-sized cards (one
 * .rv2ws-page per paginateManuscriptText() range) instead of one
 * continuously-flowing block, so the screen view reads as a real paginated
 * document (matching the printed report's own per-page structure) rather
 * than "one long sheet." Page boundaries are computed once from the exact
 * same authoritative char ranges (vm.passages) the right-side panel and
 * the print path already use — never a second, independent text analysis —
 * and a boundary is always pushed past a passage's own [charStart, charEnd)
 * rather than through it, so a single highlighted match is never split
 * across two page cards.
 */
function WorkspaceManuscript({
  report,
  vm,
  activePassageId,
  onSelectPassage,
}: {
  report: SimilarityReport;
  vm: ReportV2ViewModel;
  activePassageId: number | null;
  onSelectPassage: (passageId: number) => void;
}) {
  const text = report.text ?? "";
  const sourceIndexById = useMemo(() => {
    const map = new Map<string, number>();
    vm.sources.forEach((source, index) => map.set(source.id, index));
    return map;
  }, [vm.sources]);
  const runs = useMemo(
    () => vm.passages.filter((p) => p.charStart !== null && p.charEnd !== null).sort((a, b) => a.charStart! - b.charStart!),
    [vm.passages],
  );
  const pageRanges = useMemo(
    () => paginateManuscriptText(text, runs.map((p) => ({ start: p.charStart!, end: p.charEnd! }))),
    [text, runs],
  );

  if (text.length === 0) {
    return <p className="rv2-empty">Your submitted text is not available for inline highlighting.</p>;
  }

  return (
    <>
      {pageRanges.map((range, pageIndex) => (
        <article key={`${range.start}-${range.end}`} className="rv2ws-page">
          {/* Page-label fix (found in review): "Page X of N" alone read as
              though it could be the ORIGINAL uploaded document's own page
              count (shown separately, unrelated, as "Original document
              pages" elsewhere) — these are TurnitPlus's own generated
              manuscript-display pages, not a claim about the source
              document's pagination. "Manuscript page" makes that scope
              explicit. */}
          <p className="rv2ws-page-number">Manuscript page {pageIndex + 1} of {pageRanges.length}</p>
          <div className="rv2-doc rv2ws-manuscript">
            {renderManuscriptWindow(text, runs, range.start, range.end, sourceIndexById, activePassageId, onSelectPassage)}
          </div>
        </article>
      ))}
    </>
  );
}

/**
 * REPORT REDESIGN — the canonical, single customer-facing similarity
 * workspace for a report with a verified V2 payload: manuscript on the
 * left, one authoritative score + source inspector + match navigation on
 * the right. Derives everything from buildReportV2ViewModel — the same
 * server-authoritative view model FirstScreen/SourceCards already use — and
 * recomputes NO score, NO matched position. `onShowLegacy`, when provided
 * (admin only — see app/reports/[id]/report-detail-shell.tsx's own call
 * site), surfaces a single, unobtrusive link back to the old raw
 * tab-per-view presentation for internal/compatibility use; an ordinary
 * customer never sees it.
 */
export function ReportV2Workspace({
  report,
  onDownloadReport,
  onDownloadReceipt,
  isDownloadingReceipt = false,
  onShowLegacy,
}: {
  report: SimilarityReport;
  /** Existing window.print() mechanism, unchanged — this redesign task explicitly does not touch PDF export; this only relocates the same action into the compact workspace toolbar. */
  onDownloadReport?: () => void;
  onDownloadReceipt?: () => void;
  isDownloadingReceipt?: boolean;
  onShowLegacy?: () => void;
}) {
  const vm = useMemo(() => buildReportV2ViewModel(report), [report]);
  const [selection, setSelection] = useState<ReportV2WorkspaceSelection>(null);
  // Mobile/tablet only (see .rv2ws-panel's own CSS) — the desktop panel is
  // always visible regardless of this flag.
  const [panelOpen, setPanelOpen] = useState(false);

  const selectedSource = vm && selection ? vm.sources.find((s) => s.id === selection.sourceId) ?? null : null;
  const sortedRefs = useMemo(
    () => (selectedSource ? [...selectedSource.passageRefs].sort((a, b) => a - b) : []),
    [selectedSource],
  );
  const activePassageId = selectedSource && selection && sortedRefs.length > 0 ? sortedRefs[selection.passageIndex] ?? null : null;
  const activePassage = vm && activePassageId != null ? vm.passages.find((p) => p.id === activePassageId) ?? null : null;
  const matchContext =
    activePassage && activePassage.charStart !== null && activePassage.charEnd !== null
      ? submittedContextAround(report.text ?? "", activePassage.charStart, activePassage.charEnd)
      : null;

  // Selecting a match (from either the manuscript or the source panel)
  // scrolls the manuscript to it — the source panel's own selected state
  // needs no scroll, it is already on screen.
  useEffect(() => {
    if (activePassageId == null) return;
    const el = document.getElementById(`rv2ws-mark-${activePassageId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activePassageId]);

  if (!vm) return null;

  function selectSource(sourceId: string) {
    setSelection({ sourceId, passageIndex: 0 });
    setPanelOpen(true);
  }

  function selectPassage(passageId: number) {
    const next = resolveWorkspacePassageSelection(vm!, passageId);
    if (!next) return;
    setSelection(next);
    setPanelOpen(true);
  }

  function stepMatch(delta: number) {
    setSelection((current) => stepWorkspaceSelection(current, sortedRefs.length, delta));
  }

  const verdict = similarityScoreBand(vm.summary.verifiedSimilarityPercent);
  const percentDisplay = formatSimilarityPercent(vm.summary.verifiedSimilarityPercent, vm.summary.matchedWordCount);
  const selectedSourceIndex = selectedSource ? vm.sources.findIndex((s) => s.id === selectedSource.id) : -1;
  // Concise version of the SAME state CompletionStrip renders in full below
  // — never a second, independently-derived completion computation.
  const toolbarStatus = vm.summary.completion.state === "COMPLETED" ? "Completed" : "Needs attention";

  return (
    <div className="rv2ws">
      {(onDownloadReport || onDownloadReceipt) && (
        <div className="rv2ws-toolbar">
          <span className={`rv2ws-toolbar-status${vm.summary.completion.state === "COMPLETED" ? "" : " rv2ws-toolbar-status-attention"}`}>{toolbarStatus}</span>
          <span className="rv2ws-toolbar-actions">
            {onDownloadReport && (
              <button type="button" className="button secondary" onClick={onDownloadReport}>
                <Printer aria-hidden="true" />
                Download report
              </button>
            )}
            {onDownloadReceipt && (
              <button type="button" className="button secondary" onClick={onDownloadReceipt} disabled={isDownloadingReceipt}>
                <Download aria-hidden="true" />
                {isDownloadingReceipt ? "Preparing…" : "Download receipt"}
              </button>
            )}
          </span>
        </div>
      )}
      <div className="rv2ws-body">
        {/* Pagination pass: the summary hero is now ITS OWN page-1 card
            (.rv2ws-page), matching the printed report's own page 1 exactly,
            and the manuscript (WorkspaceManuscript) renders its own stack of
            page-2+ cards below — .rv2ws-manuscript-pane is now a plain
            column layout (spacing between cards), not one big shared card. */}
        <div className="rv2ws-manuscript-pane">
          <article className="rv2ws-page">
            <p className="rv2ws-page-number">Page 1</p>
            <WorkspaceHero vm={vm} toolbarStatus={toolbarStatus} />
          </article>
          <div className="rv2ws-match-review-heading">
            <p className="paper-kicker">MATCH REVIEW</p>
            <h3>Highlighted manuscript</h3>
          </div>
          <WorkspaceManuscript report={report} vm={vm} activePassageId={activePassageId} onSelectPassage={selectPassage} />
        </div>

        <aside className={`rv2ws-panel${panelOpen ? " rv2ws-panel-open" : ""}`} aria-label="Similarity sources and matches">
          <div className="rv2ws-panel-scroll">
            <div className={`rv2ws-score${verdict ? ` rv2ws-score-${verdict.key}` : ""}`}>
              <span>Similarity</span>
              <strong>{percentDisplay}</strong>
              {verdict && <em>{PRIMARY_SIMILARITY_BAND_LABELS[verdict.key]}</em>}
              <div className="rv2ws-score-metrics">
                <div><b>{vm.summary.matchedWordCount.toLocaleString()}</b><span>Matched words</span></div>
                <div><b>{vm.summary.totalWordCount.toLocaleString()}</b><span>Analyzed</span></div>
                <div><b>{vm.summary.distinctVerifiedSources}</b><span>Verified source{vm.summary.distinctVerifiedSources === 1 ? "" : "s"}</span></div>
              </div>
            </div>

            <CompletionStrip vm={vm} />

            <div className="rv2ws-sources">
              <h3>Sources</h3>
              {vm.sources.length === 0 ? (
                <p className="rv2-empty">No verified sources for this submission.</p>
              ) : (
                <ul className="rv2ws-source-list">
                  {vm.sources.map((source, index) => {
                    const isSelected = selection?.sourceId === source.id;
                    return (
                      <li key={source.id}>
                        <button
                          type="button"
                          className={`rv2ws-source-row${isSelected ? " is-active" : ""}`}
                          aria-pressed={isSelected}
                          onClick={() => (isSelected ? setSelection(null) : selectSource(source.id))}
                        >
                          <span className="rv2ws-source-number" style={{ background: workspaceSourceColor(index) }} aria-hidden="true">
                            {index + 1}
                          </span>
                          <span className="rv2ws-source-body">
                            <span className="rv2ws-source-title">{source.label}</span>
                            <span className="rv2ws-source-meta">
                              <span className="rv2ws-source-badge">{source.badge}</span>
                              {source.matchedWords.toLocaleString()} words · {formatSimilarityPercent(source.contributionPercent, source.matchedWords)}
                              {source.passageRefs.length > 0 ? ` · ${source.passageRefs.length} match${source.passageRefs.length === 1 ? "" : "es"}` : ""}
                            </span>
                          </span>
                          <ChevronDown aria-hidden="true" className={`rv2ws-source-chevron${isSelected ? " is-open" : ""}`} />
                        </button>

                        {isSelected && (
                          <div className="rv2ws-source-detail">
                            {sortedRefs.length > 0 ? (
                              <>
                                <div className="rv2ws-match-nav">
                                  <button type="button" onClick={() => stepMatch(-1)} disabled={selection!.passageIndex === 0} aria-label="Previous match">
                                    <ChevronLeft aria-hidden="true" />
                                  </button>
                                  <span>Match {selection!.passageIndex + 1} of {sortedRefs.length}</span>
                                  <button
                                    type="button"
                                    onClick={() => stepMatch(1)}
                                    disabled={selection!.passageIndex === sortedRefs.length - 1}
                                    aria-label="Next match"
                                  >
                                    <ChevronRight aria-hidden="true" />
                                  </button>
                                </div>

                                {activePassage && (
                                  <div className="rv2ws-match-detail">
                                    <p className="rv2ws-match-detail-label">Submitted text</p>
                                    <p className="rv2ws-match-detail-text">
                                      {matchContext ? (
                                        <>
                                          <span className="rv2ws-context">…{matchContext.before}</span>
                                          <mark className="rv2ws-match-highlight">{matchContext.matched}</mark>
                                          <span className="rv2ws-context">{matchContext.after}…</span>
                                        </>
                                      ) : (
                                        activePassage.excerpt
                                      )}
                                    </p>
                                    <p className="rv2ws-match-detail-label">Supporting source</p>
                                    {/* ReportEvidencePassage carries no source-side text at all
                                        (see report-payload-types.ts's own comment) — never
                                        fabricated here. */}
                                    <p className="rv2ws-source-unavailable">Source passage unavailable.</p>
                                  </div>
                                )}
                              </>
                            ) : (
                              <p className="rv2-empty">
                                This source has no individually highlighted passage — its match covers the submission as a whole.
                              </p>
                            )}
                            <p className="rv2ws-source-meaning">{source.meaning}</p>
                            {source.link ? (
                              <a href={source.link} target="_blank" rel="noreferrer" className="rv2ws-source-open">
                                Open source <ExternalLink aria-hidden="true" />
                              </a>
                            ) : source.doi ? (
                              <span className="rv2ws-source-doi">DOI: {source.doi}</span>
                            ) : null}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {onShowLegacy && (
              <button type="button" className="rv2ws-legacy-link" onClick={onShowLegacy}>
                View legacy diagnostic views (admin)
              </button>
            )}
          </div>
        </aside>
      </div>

      {/* Mobile/tablet only — see .rv2ws-mobile-bar's own CSS (hidden at
          desktop widths). Keeps the score, active match navigation, and a
          way to open the source panel reachable without the permanent
          360px side-by-side column the desktop layout uses. */}
      <div className="rv2ws-mobile-bar">
        <span className="rv2ws-mobile-score">
          {percentDisplay}
          {selectedSourceIndex >= 0 ? ` · Source ${selectedSourceIndex + 1}` : ""}
        </span>
        {selectedSource && sortedRefs.length > 0 && (
          <span className="rv2ws-mobile-nav">
            <button type="button" onClick={() => stepMatch(-1)} disabled={selection!.passageIndex === 0} aria-label="Previous match">
              <ChevronLeft aria-hidden="true" />
            </button>
            Match {selection!.passageIndex + 1} of {sortedRefs.length}
            <button type="button" onClick={() => stepMatch(1)} disabled={selection!.passageIndex === sortedRefs.length - 1} aria-label="Next match">
              <ChevronRight aria-hidden="true" />
            </button>
          </span>
        )}
        <button type="button" className="rv2ws-mobile-toggle" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}>
          {panelOpen ? "Close" : "Sources"}
        </button>
      </div>
    </div>
  );
}
