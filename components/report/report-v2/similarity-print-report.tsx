"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { similarityScoreBand } from "@/lib/ai-core";
import { PRIMARY_SIMILARITY_BAND_LABELS, formatSimilarityPercent, type SimilarityReport } from "@/lib/report-types";
import { buildReportV2ViewModel, matchingEvidenceEntriesLabel, type ReportV2ViewModel } from "@/lib/report-v2-view";
import {
  PRINT_PALETTE,
  PRINT_UNRANKED_COLOR,
  buildPrintCoverFields,
  buildPrintDocumentMap,
  formatPrintSubmittedAt,
  printBandColor,
  paginateManuscriptForPrint,
  printDocumentTitle,
  printLanguageLabel,
  printSourceTone,
  printSourcesPage,
  rankPrintSources,
  type PrintRankedSource,
  type PrintSourceTone,
  type ReportSubmitter,
} from "@/lib/similarity-print-layout";
import { buildPrintHighlights, type PrintHighlight } from "./print-highlights";
import { FormattedColumn, FormattedLayoutProbe, formattedHasHiddenText, type FormattedManuscriptSource, type FormattedPlan } from "./formatted-manuscript";

/**
 * SIMILARITY PRINT REPORT (2026-10-21) — the printed/PDF similarity report for a report with the V2 evidence
 * payload: exactly three introductory pages, then the highlighted manuscript from page 4.
 *
 *   1  Submission cover      — who, what and when (only fields the report or the account really has)
 *   2  Similarity overview   — the authoritative score, its band, the evidence breakdown, scope and limitations
 *   3  Matching sources      — the highest-ranked evidence entries on ONE fixed page, with "N of M shown"
 *   4+ Highlighted manuscript — the full text, the same highlight spans as before, numbered by source rank
 *
 * Design: TurnitPlus "modern academic editorial" — serif display type over the Geist UI face, hairline rules, and a
 * restrained palette (PRINT_PALETTE): blue for brand and structure, dark red on a soft red fill for matched text and its
 * source numbers, green only for completed / low-similarity states, red for attention / high-similarity states, white
 * and light greys elsewhere. Every decoration is a border, text colour or inline SVG, so the PDF reads the same with
 * Chrome's "Background graphics" turned off; sources are told apart by number AND underline pattern, so it also
 * reads in grayscale.
 *
 * Data: buildReportV2ViewModel (score, counts, sources, passages) and findHighlightRanges (manuscript spans) —
 * exactly what the previous print pages used. Nothing here computes a score or a matched position.
 */

const SECTION = {
  cover: "Submission",
  overview: "Similarity overview",
  sources: "Matching sources",
  manuscript: "Highlighted manuscript",
} as const;

const noopSubscribe = () => () => {};

/** True after hydration: the submission time is shown in the reader's own time zone, never a server guess. */
function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function SubmittedAt({ iso }: { iso: string }) {
  const isClient = useIsClient();
  const text = isClient ? formatPrintSubmittedAt(iso) : formatPrintSubmittedAt(iso, "UTC");
  return <>{text ?? "—"}</>;
}

function Wordmark() {
  return (
    <span className="spr-wordmark" aria-label="TurnitPlus">
      Turnit<b>Plus</b>
    </span>
  );
}

function PrintPage({
  report,
  page,
  total,
  section,
  className = "",
  children,
}: {
  report: SimilarityReport;
  page: number;
  total: number;
  section: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article className={`report-paper spr-page ${className}`} data-print-page={page}>
      <header className="spr-head">
        <Wordmark />
        <span className="spr-head-section">{section}</span>
        <span className="spr-head-kind">Similarity Report</span>
      </header>
      <div className="spr-body">{children}</div>
      <footer className="spr-foot">
        <span>Submission ID {report.submissionId}</span>
        <span className="spr-foot-page">Page {page} of {total}</span>
      </footer>
    </article>
  );
}

/** A tiny line sample in the source's own colour and pattern — the key the manuscript highlights use. */
function ToneSample({ tone, width = 26 }: { tone: PrintSourceTone; width?: number }) {
  const dash = tone.line === "dashed" ? "5 3" : tone.line === "dotted" ? "1.4 2.6" : undefined;
  return (
    <svg className="spr-tone-sample" width={width} height="8" viewBox={`0 0 ${width} 8`} aria-hidden="true">
      {tone.line === "double" ? (
        <>
          <line x1="1" x2={width - 1} y1="2.5" y2="2.5" stroke={tone.color} strokeWidth="1.3" />
          <line x1="1" x2={width - 1} y1="5.5" y2="5.5" stroke={tone.color} strokeWidth="1.3" />
        </>
      ) : (
        <line x1="1" x2={width - 1} y1="4" y2="4" stroke={tone.color} strokeWidth="2" strokeDasharray={dash} strokeLinecap={tone.line === "dotted" ? "round" : "butt"} />
      )}
    </svg>
  );
}

function RankBadge({ source }: { source: Pick<PrintRankedSource, "rank" | "tone"> }) {
  return (
    <span className="spr-rank" style={{ "--spr-c": source.tone.color } as CSSProperties}>
      {source.rank}
    </span>
  );
}

// ── page 1 — submission cover ────────────────────────────────────────────
function CoverMotif() {
  // Abstract manuscript lines with a few marked spans: the TurnitPlus report, at a glance (grey lines, match-red marks).
  const rows = [168, 150, 172, 126, 160, 144, 170, 98];
  const marks: Record<number, [number, number]> = { 1: [54, 70], 3: [18, 52], 6: [10, 36] };
  return (
    <svg className="spr-cover-motif" width="180" height="128" viewBox="0 0 180 128" aria-hidden="true">
      {rows.map((w, i) => (
        <g key={i}>
          <line x1="4" x2={4 + w} y1={10 + i * 15} y2={10 + i * 15} stroke={PRINT_PALETTE.rule} strokeWidth="3" strokeLinecap="round" />
          {marks[i] && (
            <line x1={4 + marks[i][0]} x2={4 + marks[i][0] + marks[i][1]} y1={10 + i * 15} y2={10 + i * 15} stroke={PRINT_PALETTE.match} strokeWidth="3" strokeLinecap="round" />
          )}
        </g>
      ))}
    </svg>
  );
}

function coverTitleClass(title: string): string {
  const n = [...title].length;
  return n > 200 ? "spr-cover-title spr-cover-title-xs" : n > 110 ? "spr-cover-title spr-cover-title-sm" : "spr-cover-title";
}

function CoverPage({ report, submitter, total, manuscriptFirst }: { report: SimilarityReport; submitter: ReportSubmitter | null; total: number; manuscriptFirst: number }) {
  const title = printDocumentTitle(report.title);
  const fields = buildPrintCoverFields(report, submitter);
  const submittedIndex = fields.findIndex((f) => f.label === "Original file");
  const contents: Array<[string, string]> = [
    [SECTION.overview, "2"],
    [SECTION.sources, "3"],
    [SECTION.manuscript, total > manuscriptFirst ? `${manuscriptFirst}–${total}` : `${manuscriptFirst}`],
  ];
  // A long title or name gets a tighter cover rhythm, so the page still holds everything on one sheet.
  const dense = [...title].length > 110 || [...(submitter?.displayName ?? "")].length > 44;
  return (
    <PrintPage report={report} page={1} total={total} section={SECTION.cover} className={dense ? "spr-cover spr-cover-dense" : "spr-cover"}>
      <div className="spr-cover-top">
        <div>
          <p className="spr-kicker">Similarity report</p>
          <p className="spr-cover-lede">A word-for-word comparison of this submission against TurnitPlus sources.</p>
        </div>
        <CoverMotif />
      </div>

      <section className="spr-cover-title-block" aria-label="Submitted document">
        <p className="spr-label">Submitted document</p>
        <h1 className={coverTitleClass(title)} dir="auto">{title}</h1>
      </section>

      <dl className="spr-cover-meta">
        {fields.slice(0, Math.max(0, submittedIndex)).map((f) => (
          <div key={f.label}><dt>{f.label}</dt><dd dir="auto">{f.value}</dd></div>
        ))}
        <div><dt>Submitted</dt><dd><SubmittedAt iso={report.created} /></dd></div>
        {fields.slice(Math.max(0, submittedIndex)).map((f) => (
          <div key={f.label} className={f.label === "Original file" ? "spr-cover-meta-wide" : undefined}><dt>{f.label}</dt><dd dir="auto">{f.value}</dd></div>
        ))}
      </dl>

      <nav className="spr-cover-contents" aria-label="In this report">
        <p className="spr-label">In this report</p>
        <ol>
          {contents.map(([name, pages]) => (
            <li key={name}><span>{name}</span><i aria-hidden="true" /><b>{pages}</b></li>
          ))}
        </ol>
      </nav>
    </PrintPage>
  );
}

// ── page 2 — similarity overview ─────────────────────────────────────────
// The three existing result bands (lib/ai-core.ts similarityScoreBand) drawn as equal tiers; the marker sits
// within its tier in proportion to the score.
const BAND_SEGMENTS = [
  { key: "low", label: "Low", range: "0–19%", from: 0, to: 20 },
  { key: "review", label: "Moderate", range: "20–40%", from: 20, to: 41 },
  { key: "high", label: "High", range: "41–100%", from: 41, to: 101 },
] as const;

function BandScale({ score }: { score: number }) {
  const band = similarityScoreBand(score);
  const W = 330;
  const tier = (W - 12) / BAND_SEGMENTS.length;
  const index = Math.max(0, BAND_SEGMENTS.findIndex((s) => score >= s.from && score < s.to));
  const seg = BAND_SEGMENTS[index];
  const markerX = 6 + tier * index + tier * Math.min(1, Math.max(0, (score - seg.from) / (seg.to - seg.from)));
  return (
    <svg className="spr-band-scale" width={W} height="58" viewBox={`0 0 ${W} 58`} role="img" aria-label={`Similarity ${score}%: ${band ? PRIMARY_SIMILARITY_BAND_LABELS[band.key] : "similarity"}`}>
      {BAND_SEGMENTS.map((s, i) => {
        const active = band?.key === s.key;
        const x1 = 6 + tier * i;
        return (
          <g key={s.key}>
            <line x1={x1 + 2} x2={x1 + tier - 2} y1="20" y2="20" stroke={active ? printBandColor(s.key) : PRINT_PALETTE.rule} strokeWidth={active ? 6 : 4} />
            <text x={x1 + tier / 2} y="38" textAnchor="middle" className="spr-band-text" fill={active ? printBandColor(s.key) : PRINT_PALETTE.muted} fontWeight={active ? 700 : 400}>{s.label}</text>
            <text x={x1 + tier / 2} y="51" textAnchor="middle" className="spr-band-text spr-band-range">{s.range}</text>
          </g>
        );
      })}
      <path d={`M ${markerX - 5} 6 L ${markerX + 5} 6 L ${markerX} 13 Z`} fill={printBandColor(band?.key)} />
    </svg>
  );
}

function DocumentMap({ vm, totalWords, rankById }: { vm: ReportV2ViewModel; totalWords: number; rankById: ReadonlyMap<string, number> }) {
  const cells = buildPrintDocumentMap(vm, totalWords, rankById);
  const W = 680;
  const cw = W / cells.length;
  const wordsPerCell = Math.max(1, Math.round(Math.max(totalWords, 1) / cells.length));
  return (
    <figure className="spr-map">
      <svg width="100%" height="46" viewBox={`0 0 ${W} 46`} preserveAspectRatio="none" role="img" aria-label="Where matched words occur in the manuscript">
        <line x1="0" x2={W} y1="23" y2="23" stroke={PRINT_PALETTE.rule} strokeWidth="1" />
        {cells.map((cell, i) => {
          if (cell.matchedShare <= 0) return <line key={i} x1={i * cw + cw / 2} x2={i * cw + cw / 2} y1="20" y2="26" stroke={PRINT_PALETTE.rule} strokeWidth={Math.max(1, cw - 2.2)} />;
          const h = 10 + cell.matchedShare * 34;
          const color = cell.rank !== null ? PRINT_PALETTE.match : PRINT_UNRANKED_COLOR;
          return <line key={i} x1={i * cw + cw / 2} x2={i * cw + cw / 2} y1={23 - h / 2} y2={23 + h / 2} stroke={color} strokeWidth={Math.max(1, cw - 2.2)} />;
        })}
      </svg>
      <figcaption>
        <span>Beginning of manuscript</span>
        <span className="spr-map-key">Each column ≈ {wordsPerCell.toLocaleString("en-US")} words · taller = more matched words</span>
        <span>End</span>
      </figcaption>
    </figure>
  );
}

function sourceCategories(ranked: PrintRankedSource[]): Array<{ badge: string; entries: number }> {
  const byBadge = new Map<string, number>();
  for (const s of ranked) byBadge.set(s.badge, (byBadge.get(s.badge) ?? 0) + 1);
  return [...byBadge.entries()].map(([badge, entries]) => ({ badge, entries })).sort((a, b) => b.entries - a.entries || a.badge.localeCompare(b.badge));
}

function OverviewPage({ report, vm, ranked, rankById, total }: { report: SimilarityReport; vm: ReportV2ViewModel; ranked: PrintRankedSource[]; rankById: ReadonlyMap<string, number>; total: number }) {
  const { verifiedSimilarityPercent, matchedWordCount, totalWordCount, matchingEvidenceEntries, breakdown, deferredNote, completion } = vm.summary;
  const band = similarityScoreBand(verifiedSimilarityPercent);
  const percent = formatSimilarityPercent(verifiedSimilarityPercent, matchedWordCount);
  const categories = sourceCategories(ranked);
  const notice = vm.unverifiedPublications;
  const complete = completion.state === "COMPLETED";
  return (
    <PrintPage report={report} page={2} total={total} section={SECTION.overview} className="spr-overview">
      <p className="spr-kicker">Similarity overview</p>
      <h2 className="spr-h2">How much of this document matches checked sources</h2>

      <section className="spr-score">
        <div className="spr-score-figure">
          <strong>{percent}</strong>
          <span>overall similarity</span>
        </div>
        <div className="spr-score-side">
          <p className={`spr-pill spr-pill-${band?.key ?? "review"}`}>{band ? PRIMARY_SIMILARITY_BAND_LABELS[band.key] : "Similarity"}</p>
          <BandScale score={verifiedSimilarityPercent} />
          <p className="spr-score-explain">
            The share of analyzed words that match checked sources word for word. A word that matches several sources
            is counted once.
          </p>
        </div>
      </section>

      <dl className="spr-figures">
        <div><dt>Matched words</dt><dd>{matchedWordCount.toLocaleString("en-US")}</dd></div>
        <div><dt>Words analyzed</dt><dd>{totalWordCount.toLocaleString("en-US")}</dd></div>
        <div><dt>Matching evidence entries</dt><dd>{matchingEvidenceEntries.toLocaleString("en-US")}</dd></div>
        <div><dt>Highlighted passages</dt><dd>{vm.filterCounts.all.toLocaleString("en-US")}</dd></div>
      </dl>

      <section className="spr-block">
        <h3 className="spr-h3">Where the matches are</h3>
        <DocumentMap vm={vm} totalWords={totalWordCount} rankById={rankById} />
      </section>

      <div className="spr-columns">
        <section className="spr-block">
          <h3 className="spr-h3">Kinds of overlap</h3>
          {breakdown.length === 0 ? (
            <p className="spr-muted">No overlap was found within the available TurnitPlus source scope.</p>
          ) : (
            <ul className="spr-kinds">
              {breakdown.map((row) => (
                <li key={row.kind}>
                  <span className="spr-kind-label">{row.label}</span>
                  <span className="spr-kind-figure">{formatSimilarityPercent(row.percentOfDocument, row.matchedWords)}</span>
                  <svg className="spr-kind-bar" width="100%" height="5" viewBox="0 0 100 5" preserveAspectRatio="none" aria-hidden="true">
                    <line x1="0" x2="100" y1="2.5" y2="2.5" stroke={PRINT_PALETTE.rule} strokeWidth="5" />
                    <line x1="0" x2={Math.max(1.5, Math.min(100, row.shareOfOverlap))} y1="2.5" y2="2.5" stroke={PRINT_PALETTE.blue} strokeWidth="5" />
                  </svg>
                  <span className="spr-kind-words">{row.matchedWords.toLocaleString("en-US")} words · {row.shareOfOverlap}% of matched text</span>
                </li>
              ))}
            </ul>
          )}
          {deferredNote && <p className="spr-fine">{deferredNote}</p>}
        </section>

        <section className="spr-block">
          <h3 className="spr-h3">Evidence by source type</h3>
          {categories.length === 0 ? (
            <p className="spr-muted">No matching evidence entries.</p>
          ) : (
            <ul className="spr-categories">
              {categories.map((c) => (
                <li key={c.badge}><span>{c.badge}</span><b>{c.entries}</b></li>
              ))}
            </ul>
          )}
          {categories.length > 0 && <p className="spr-fine">Counts are evidence entries; the same words can appear in more than one.</p>}
        </section>
      </div>

      <section className={`spr-scope${complete ? " spr-scope-ok" : " spr-scope-attention"}`}>
        <h3 className="spr-h3">Scope and limitations</h3>
        <p className="spr-scope-state">
          <span className={`spr-pill ${complete ? "spr-pill-ok" : "spr-pill-attention"}`}>{complete ? "Search completed" : "Needs attention"}</span>
          {completion.headline}
        </p>
        {completion.detail && <p>{completion.detail}</p>}
        <p>{completion.scopeLine}</p>
        {notice && (
          <div className="spr-notice" role="note" aria-label={notice.heading}>
            <p className="spr-notice-heading">{notice.heading}</p>
            <p>{notice.body}</p>
            <ul>
              {notice.publications.map((p) => (
                <li key={p.doi}>
                  <span dir="auto">{p.title}</span> — {p.venue} · {p.year} · <a href={p.doiUrl} target="_blank" rel="noreferrer">doi:{p.doi}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="spr-block spr-howto" aria-label="How to read this report">
        <h3 className="spr-h3">How to read this report</h3>
        <ol>
          <li><b>The percentage</b> counts each matching word of your document once, however many sources share it.</li>
          <li><b>Numbers and line patterns</b> in the manuscript (from page 4) point to the ranked sources on page 3, and stay readable in black and white.</li>
          <li><b>The interactive TurnitPlus report</b> lists every evidence entry with its links and lets you step through each match.</li>
        </ol>
      </section>
    </PrintPage>
  );
}

// ── page 3 — matching sources ────────────────────────────────────────────
function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function SourcesPage({ report, vm, ranked, total }: { report: SimilarityReport; vm: ReportV2ViewModel; ranked: PrintRankedSource[]; total: number }) {
  const { shown, hidden } = printSourcesPage(ranked);
  const anyShared = ranked.some((s) => s.mixedKindLabels.length > 0);
  return (
    <PrintPage report={report} page={3} total={total} section={SECTION.sources} className="spr-sources">
      <p className="spr-kicker">Matching sources</p>
      <h2 className="spr-h2">Sources behind the highlighted passages</h2>
      <p className="spr-intro">
        Ranked by matched words. Each number and line pattern marks the same source&apos;s passages in the manuscript,
        from page 4.
      </p>

      {ranked.length === 0 ? (
        <div className="spr-empty spr-empty-sources">
          <p className="spr-empty-heading">No matching sources</p>
          <p>
            No wording in this document matched the TurnitPlus reference collection or the live academic sources that
            were searched. The manuscript follows from page 4, without highlights.
          </p>
        </div>
      ) : (
        <>
          <div className="spr-source-cols" aria-hidden="true">
            <span>Source</span>
            <span>Share</span>
          </div>
          <ol className="spr-source-list">
            {shown.map((s) => {
              const where = s.link ? hostAndPath(s.link) : s.doi ? `doi:${s.doi}` : null;
              const meta = [s.badge, s.primaryLabel, where, s.year ? String(s.year) : null,
                s.passageRefs.length > 0 ? `${s.passageRefs.length} passage${s.passageRefs.length === 1 ? "" : "s"}` : null].filter(Boolean);
              return (
                <li key={s.id} className="spr-source-row">
                  <span className="spr-source-key">
                    <RankBadge source={s} />
                    <ToneSample tone={s.tone} />
                  </span>
                  <span className="spr-source-text">
                    <span className="spr-source-title" dir="auto">{s.label}</span>
                    <span className="spr-source-meta">{meta.join(" · ")}</span>
                  </span>
                  <span className="spr-source-share">
                    <b>{formatSimilarityPercent(s.contributionPercent, s.matchedWords)}</b>
                    <small>{s.matchedWords.toLocaleString("en-US")} words</small>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <div className="spr-sources-note">
        <p>
          {ranked.length === 0
            ? "The interactive TurnitPlus report shows the full search scope for this submission."
            : hidden > 0
              ? `Showing the ${shown.length} highest-ranked of ${matchingEvidenceEntriesLabel(ranked.length)}. The complete source inventory — every entry, with its links and matched passages — is in the interactive TurnitPlus report.`
              : `All ${matchingEvidenceEntriesLabel(ranked.length)} are shown. Links and matched passages for each are in the interactive TurnitPlus report.`}
        </p>
        {hidden > 0 && <p>Highlights numbered {shown.length + 1}–{ranked.length} in the manuscript belong to those further entries.</p>}
        {anyShared && <p>Some words match more than one source; they count once in the {vm.summary.verifiedSimilarityPercent}% overall similarity.</p>}
      </div>
    </PrintPage>
  );
}

// ── page 4+ — highlighted manuscript ─────────────────────────────────────
function renderManuscriptWindow(text: string, highlights: PrintHighlight[], from: number, to: number): ReactNode[] {
  const pieces: ReactNode[] = [];
  let cursor = from;
  for (const h of highlights) {
    if (h.end <= from || h.start >= to) continue;
    const start = Math.max(cursor, h.start, from);
    const end = Math.min(to, h.end);
    if (end <= start) continue;
    if (start > cursor) pieces.push(text.slice(cursor, start));
    const tone = h.rank !== null ? printSourceTone(h.rank) : null;
    const color = h.wikipedia ? PRINT_PALETTE.match : tone?.color ?? PRINT_UNRANKED_COLOR;
    const line = h.wikipedia ? "dotted" : tone?.line ?? "solid";
    pieces.push(
      <mark key={`${h.start}-${start}`} className={`spr-mark spr-line-${line}`} style={{ "--spr-c": color } as CSSProperties} title={h.title} data-span={`${h.start}-${h.end}`}>
        {text.slice(start, end)}
        {h.wikipedia ? <sup className="spr-mark-n">W</sup> : h.rank !== null ? <sup className="spr-mark-n">{h.rank}</sup> : null}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < to) pieces.push(text.slice(cursor, to));
  return pieces;
}

function ManuscriptOpener({ report, hasHighlights, formatted }: { report: SimilarityReport; hasHighlights: boolean; formatted?: FormattedManuscriptSource | null }) {
  const appears = formatted ? "Shown with the original document’s formatting." : "The text appears as submitted.";
  const warnings = formatted?.doc.warnings ?? [];
  return (
    <div className="spr-manuscript-opener">
      <p className="spr-kicker">Highlighted manuscript</p>
      <h2 className="spr-manuscript-title" dir="auto">{printDocumentTitle(report.title)}</h2>
      {hasHighlights ? (
        <p className="spr-manuscript-key">
          <span className="spr-manuscript-key-sample"><span className="spr-mark spr-line-solid" style={{ "--spr-c": printSourceTone(1).color } as CSSProperties}>matched text<sup className="spr-mark-n">1</sup></span></span>
          Matched passages are underlined and numbered by source (page 3). {appears}
        </p>
      ) : (
        <p className="spr-manuscript-key">No passages matched. {appears}</p>
      )}
      {warnings.length > 0 && (
        <p className="spr-manuscript-key spr-manuscript-limits">Not shown from the original file: {warnings.join(", ")}.</p>
      )}
      {formatted && formattedHasHiddenText(formatted.doc) && (
        <p className="spr-manuscript-key spr-manuscript-limits">Text that is hidden in Word is shown dimmed, because it was part of the analysed text.</p>
      )}
    </div>
  );
}

function ManuscriptPages({ report, highlights, pages, total, firstPage }: { report: SimilarityReport; highlights: PrintHighlight[]; pages: Array<{ start: number; end: number }>; total: number; firstPage: number }) {
  const text = report.text ?? "";
  const language = printLanguageLabel(report);
  const baseDir = language === "Arabic" ? "rtl" : "ltr";
  const opener = <ManuscriptOpener report={report} hasHighlights={highlights.length > 0} />;
  if (pages.length === 0) {
    return (
      <PrintPage report={report} page={firstPage} total={total} section={SECTION.manuscript} className="spr-manuscript">
        {opener}
        <p className="spr-empty">The submitted text is not available for inline highlighting.</p>
      </PrintPage>
    );
  }
  return (
    <>
      {pages.map((range, index) => (
        <PrintPage key={`${range.start}-${range.end}`} report={report} page={firstPage + index} total={total} section={SECTION.manuscript} className="spr-manuscript">
          {index === 0 && opener}
          <div className="spr-manuscript-text" dir={baseDir} lang={language === "Arabic" ? "ar" : language === "French" ? "fr" : undefined}>
            {renderManuscriptWindow(text, highlights, range.start, range.end)}
          </div>
        </PrintPage>
      ))}
    </>
  );
}

/** The manuscript drawn from the re-attached original .docx (formatted-manuscript.tsx), page by planned page. */
function FormattedManuscriptPages({ report, source, plan, total, firstPage }: { report: SimilarityReport; source: FormattedManuscriptSource; plan: FormattedPlan; total: number; firstPage: number }) {
  return (
    <>
      {plan.map((slices, index) => (
        <PrintPage key={index} report={report} page={firstPage + index} total={total} section={SECTION.manuscript} className="spr-manuscript spr-formatted">
          {index === 0 && <ManuscriptOpener report={report} hasHighlights={source.highlights.length > 0} formatted={source} />}
          <FormattedColumn source={source} slices={slices} />
        </PrintPage>
      ))}
    </>
  );
}

// ── public components ────────────────────────────────────────────────────
/**
 * Rendered on screen beside the hidden print bundle, so the report's serif (and, for a document that contains
 * Arabic, the Arabic face) is already loaded when the reader prints — a display:none subtree never requests fonts.
 */
export function SimilarityPrintFontWarmup({ report }: { report: SimilarityReport }) {
  const hasArabic = /[؀-ۿ]/.test(report.text ?? "") || /[؀-ۿ]/.test(report.title ?? "");
  return (
    <span className="spr-font-warmup" aria-hidden="true">
      Aa<i>Aa</i><b>Aa</b>{hasArabic ? " ب" : null}
    </span>
  );
}

/** The highlights the printed manuscript draws — also what a re-attached .docx is mapped against. */
export function similarityPrintHighlights(report: SimilarityReport): PrintHighlight[] {
  const vm = buildReportV2ViewModel(report);
  if (!vm) return [];
  return buildPrintHighlights(report, vm, new Map(rankPrintSources(vm).map((s) => [s.id, s.rank])));
}

export function SimilarityPrintReport({
  report,
  submitter = null,
  formatted = null,
  onFormattedReady,
}: {
  report: SimilarityReport;
  submitter?: ReportSubmitter | null;
  /** a verified, mapped original .docx (prepareFormattedManuscript): pages 4+ are drawn from it */
  formatted?: FormattedManuscriptSource | null;
  /** called once the formatted manuscript is laid out and the whole report is ready to print */
  onFormattedReady?: () => void;
}) {
  const model = useMemo(() => {
    const vm = buildReportV2ViewModel(report);
    if (!vm) return null;
    const ranked = rankPrintSources(vm);
    const rankById = new Map(ranked.map((s) => [s.id, s.rank]));
    const highlights = buildPrintHighlights(report, vm, rankById);
    const pages = paginateManuscriptForPrint(report.text ?? "", highlights.map((h) => ({ start: h.start, end: h.end })));
    return { vm, ranked, rankById, highlights, pages };
  }, [report]);
  const [laidOut, setLaidOut] = useState<{ source: FormattedManuscriptSource; plan: FormattedPlan } | null>(null);
  const plan = formatted && laidOut?.source === formatted ? laidOut.plan : null;
  const handlePlan = useCallback((p: FormattedPlan) => {
    if (formatted) setLaidOut({ source: formatted, plan: p });
  }, [formatted]);
  // announce each laid-out plan once (an effect may run twice in development)
  const announced = useRef<FormattedPlan | null>(null);
  useEffect(() => {
    if (!formatted || !plan || announced.current === plan) return;
    announced.current = plan;
    onFormattedReady?.();
  }, [formatted, plan, onFormattedReady]);
  if (!model) return null;
  const { vm, ranked, rankById, highlights, pages } = model;
  const manuscriptFirst = 4;
  const total = manuscriptFirst - 1 + (plan ? Math.max(1, plan.length) : Math.max(1, pages.length));
  return (
    <div className="spr-report">
      <CoverPage report={report} submitter={submitter} total={total} manuscriptFirst={manuscriptFirst} />
      <OverviewPage report={report} vm={vm} ranked={ranked} rankById={rankById} total={total} />
      <SourcesPage report={report} vm={vm} ranked={ranked} total={total} />
      {formatted && plan ? (
        <FormattedManuscriptPages report={report} source={formatted} plan={plan} total={total} firstPage={manuscriptFirst} />
      ) : (
        <ManuscriptPages report={report} highlights={highlights} pages={pages} total={total} firstPage={manuscriptFirst} />
      )}
      {formatted && !plan && (
        <FormattedLayoutProbe
          source={formatted}
          onPlan={handlePlan}
          probeFirst={
            <PrintPage report={report} page={manuscriptFirst} total={total} section={SECTION.manuscript} className="spr-manuscript spr-formatted">
              <ManuscriptOpener report={report} hasHighlights={formatted.highlights.length > 0} formatted={formatted} />
              <div className="fm-probe-fill" />
            </PrintPage>
          }
          probeRest={
            <PrintPage report={report} page={manuscriptFirst + 1} total={total} section={SECTION.manuscript} className="spr-manuscript spr-formatted">
              <div className="fm-probe-fill" />
            </PrintPage>
          }
        />
      )}
    </div>
  );
}
