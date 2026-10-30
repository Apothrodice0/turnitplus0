"use client";

import type { PredictedHighlightRange } from "@/lib/report-types";
import { Fragment, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
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
  printSimilarityScale,
  printSourceIdentity,
  printSourceTone,
  printSourcesPage,
  rankPrintSources,
  type PrintRankedSource,
  type PrintSourceTone,
  type ReportSubmitter,
} from "@/lib/similarity-print-layout";
import { buildPrintHighlights, buildPrintPredicted, type PrintHighlight } from "./print-highlights";
import { unifiedPercentText, type UnifiedSimilarity } from "@/lib/system2-unified";

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
// The full-width scale under the score: the three result bands (printSimilarityScale) as segments as wide as the
// ranges they cover, and a marker at the score itself. Drawn with borders and text only, like the rest of the report.
function SimilarityScale({ score, percent }: { score: number; percent: string }) {
  const scale = printSimilarityScale(score);
  const tone = { "--spr-c": printBandColor(scale.activeKey) } as CSSProperties;
  const at = { left: `${scale.markerPercent}%` };
  return (
    <section className="spr-scale" style={tone} aria-label={`Similarity ${percent}: ${scale.activeKey ? PRIMARY_SIMILARITY_BAND_LABELS[scale.activeKey] : "similarity"}`}>
      <div className="spr-scale-bar">
        <span className={`spr-scale-value spr-scale-value-${scale.markerAlign}`} style={at}>{percent}</span>
        <span className="spr-scale-pin" style={at} aria-hidden="true" />
        {scale.segments.map((s, i) => (
          // a 2px gap after each boundary keeps the boundaries exactly at their percentages
          <span key={s.key} className={s.active ? "spr-scale-seg spr-scale-seg-active" : "spr-scale-seg"} style={{ width: i === 0 ? `${s.widthPercent}%` : `calc(${s.widthPercent}% - 2px)` }} />
        ))}
      </div>
      <div className="spr-scale-labels">
        {scale.segments.map((s) => (
          <span key={s.key} className={s.active ? "spr-scale-label spr-scale-label-active" : "spr-scale-label"} style={{ width: `${s.widthPercent}%` }}>
            <b>{s.label}</b> {s.range}
          </span>
        ))}
      </div>
    </section>
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

function OverviewPage({ report, vm, ranked, rankById, total, unified }: { report: SimilarityReport; vm: ReportV2ViewModel; ranked: PrintRankedSource[]; rankById: ReadonlyMap<string, number>; total: number; unified?: UnifiedSimilarity }) {
  const { verifiedSimilarityPercent, matchedWordCount, totalWordCount, matchingEvidenceEntries, breakdown, deferredNote, completion } = vm.summary;
  // The report's one percentage, as on screen and on the receipt. When it is above the verified, source-backed figure
  // (lib/system2-unified.ts), nothing on this page calls it a share of words matched against checked sources.
  const score = unified ? unified.percent : verifiedSimilarityPercent;
  const aboveVerified = Boolean(unified?.includesStatisticalEstimate);
  const band = similarityScoreBand(score);
  const percent = unified ? unifiedPercentText(unified, matchedWordCount) : formatSimilarityPercent(verifiedSimilarityPercent, matchedWordCount);
  const categories = sourceCategories(ranked);
  const notice = vm.unverifiedPublications;
  const complete = completion.state === "COMPLETED";
  return (
    <PrintPage report={report} page={2} total={total} section={SECTION.overview} className="spr-overview">
      <p className="spr-kicker">Similarity overview</p>
      <h2 className="spr-h2">{aboveVerified ? "Overall similarity of this document" : "How much of this document matches checked sources"}</h2>

      <section className="spr-score">
        <div className="spr-score-figure">
          <strong>{percent}</strong>
          <span>overall similarity</span>
        </div>
        <div className="spr-score-side">
          <p className={`spr-pill spr-pill-${band?.key ?? "review"}`}>{band ? PRIMARY_SIMILARITY_BAND_LABELS[band.key] : "Similarity"}</p>
          {!aboveVerified && (
            <p className="spr-score-explain">
              The share of analyzed words that match checked sources word for word. A word that matches several sources
              is counted once.
            </p>
          )}
        </div>
      </section>
      <SimilarityScale score={score} percent={percent} />

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
          {aboveVerified ? (
            <li><b>Matched words</b> count each matching word of your document once, however many sources share it.</li>
          ) : (
            <li><b>The percentage</b> counts each matching word of your document once, however many sources share it.</li>
          )}
          <li><b>Numbers and line patterns</b> in the manuscript (from page 4) point to the ranked sources on page 3, and stay readable in black and white.</li>
          <li><b>The interactive TurnitPlus report</b> lists every evidence entry with its links and lets you step through each match.</li>
        </ol>
      </section>
    </PrintPage>
  );
}

// ── page 3 — matching sources ────────────────────────────────────────────
// Each row: rank and line pattern, the entry's identity (printSourceIdentity — named only when verified), its
// passages, matched words and share of the analyzed document, all from the saved view model.
function SourcesPage({ report, vm, ranked, total, hasPredicted }: { report: SimilarityReport; vm: ReportV2ViewModel; ranked: PrintRankedSource[]; total: number; hasPredicted: boolean }) {
  const { shown, hidden } = printSourcesPage(ranked);
  const anyShared = ranked.some((s) => s.mixedKindLabels.length > 0);
  const entryWords = ranked.reduce((sum, s) => sum + s.matchedWords, 0);
  // A highlight carries the best-ranked source of its passage, so an entry whose every passage is shared with a
  // better-ranked one has no number of its own in the manuscript: say which numbers mark its passages instead.
  const rankOf = new Map(ranked.map((s) => [s.id, s.rank]));
  const markedAs = (s: PrintRankedSource): number[] => {
    const marks = new Set(vm.passages.filter((p) => p.sourceIds.includes(s.id)).map((p) => Math.min(...p.sourceIds.map((id) => rankOf.get(id) ?? Infinity))));
    return marks.has(s.rank) ? [] : [...marks].filter(Number.isFinite).sort((a, b) => a - b).slice(0, 3);
  };
  const pad = (n: number) => String(n).padStart(Math.max(2, String(ranked.length).length), "0");
  return (
    <PrintPage report={report} page={3} total={total} section={SECTION.sources} className="spr-sources">
      <p className="spr-kicker">Matching sources</p>
      <h2 className="spr-h2">Sources behind the highlighted passages</h2>
      <p className="spr-intro">
        Ranked by matched words. Each entry is one piece of matching evidence, and several entries can come from the
        same publication. An entry&apos;s number and line pattern mark its passages in the manuscript, from page 4.
      </p>

      {ranked.length === 0 ? (
        <div className="spr-empty spr-empty-sources">
          <p className="spr-empty-heading">No matching sources</p>
          <p>
            No wording in this document matched the TurnitPlus reference collection or the live academic sources that
            were searched. The manuscript follows from page 4, {hasPredicted ? "with unverified predicted passages underlined" : "without highlights"}.
          </p>
        </div>
      ) : (
        <>
          <div className="spr-source-cols" aria-hidden="true">
            <span />
            <span>Source</span>
            <span>Passages</span>
            <span>Matched words</span>
            <span>Share of document</span>
          </div>
          <ol className="spr-source-list">
            {shown.map((s) => {
              const identity = printSourceIdentity(s, ranked.length);
              const others = markedAs(s);
              // only real details: a verified source's own title, link and year, and where its passages are marked
              const meta: ReactNode[] = [
                ...identity.details,
                ...(identity.link ? [<a key="link" className="spr-source-link" href={identity.link.href}>{identity.link.text}</a>] : []),
                ...(identity.year !== null ? [String(identity.year)] : []),
                ...(others.length > 0 ? [`Passages marked ${others.map((n) => `#${pad(n)}`).join(", ")} in the manuscript`] : []),
              ];
              return (
                <li key={s.id} className={identity.verified ? "spr-source-row" : "spr-source-row spr-source-row-unnamed"}>
                  <span className="spr-source-key">
                    <RankBadge source={s} />
                    <ToneSample tone={s.tone} />
                  </span>
                  <span className="spr-source-text">
                    <span className="spr-source-title" dir="auto">{identity.title}</span>
                    {meta.length > 0 && (
                      <span className="spr-source-meta" dir="auto">
                        {meta.map((part, i) => <Fragment key={i}>{i > 0 && " · "}{part}</Fragment>)}
                      </span>
                    )}
                  </span>
                  <span className="spr-source-num">{s.passageRefs.length.toLocaleString("en-US")}</span>
                  <span className="spr-source-num">{s.matchedWords.toLocaleString("en-US")}</span>
                  <span className="spr-source-share"><b>{formatSimilarityPercent(s.contributionPercent, s.matchedWords)}</b></span>
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
              ? `Showing the ${shown.length} highest-ranked of ${matchingEvidenceEntriesLabel(ranked.length)}. The complete inventory — every entry, with its matched passages — is in the interactive TurnitPlus report.`
              : `All ${matchingEvidenceEntriesLabel(ranked.length)} are shown. The matched passages of each are in the interactive TurnitPlus report.`}
        </p>
        {hidden > 0 && <p>Highlights numbered {shown.length + 1}–{ranked.length} in the manuscript belong to those further entries.</p>}
        {entryWords > vm.summary.matchedWordCount ? (
          <p>
            Entries can share words: the matched words of all {ranked.length.toLocaleString("en-US")} entries add up to {entryWords.toLocaleString("en-US")}, but each
            word counts once in the {vm.summary.matchedWordCount.toLocaleString("en-US")} matched words behind the {formatSimilarityPercent(vm.summary.verifiedSimilarityPercent, vm.summary.matchedWordCount)} overall similarity.
          </p>
        ) : anyShared ? (
          <p>Some words match more than one source; they count once in the {vm.summary.verifiedSimilarityPercent}% overall similarity.</p>
        ) : null}
      </div>
    </PrintPage>
  );
}

// ── page 4+ — highlighted manuscript ─────────────────────────────────────
/** Plain text between verified highlights; model-predicted ranges in it get the neutral dashed underline (prototype). */
function plainWithPredicted(text: string, from: number, to: number, predicted: PredictedHighlightRange[]): ReactNode[] {
  const pieces: ReactNode[] = [];
  let cursor = from;
  for (const p of predicted) {
    const start = Math.max(cursor, p.start);
    const end = Math.min(to, p.end);
    if (end <= start) continue;
    if (start > cursor) pieces.push(text.slice(cursor, start));
    pieces.push(<span key={`p-${start}`} className="predicted-highlight">{text.slice(start, end)}</span>);
    cursor = end;
  }
  if (cursor < to) pieces.push(text.slice(cursor, to));
  return pieces;
}

function renderManuscriptWindow(text: string, highlights: PrintHighlight[], from: number, to: number, predicted: PredictedHighlightRange[] = []): ReactNode[] {
  const pieces: ReactNode[] = [];
  let cursor = from;
  for (const h of highlights) {
    if (h.end <= from || h.start >= to) continue;
    const start = Math.max(cursor, h.start, from);
    const end = Math.min(to, h.end);
    if (end <= start) continue;
    if (start > cursor) pieces.push(...plainWithPredicted(text, cursor, start, predicted));
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
  if (cursor < to) pieces.push(...plainWithPredicted(text, cursor, to, predicted));
  return pieces;
}

function ManuscriptOpener({ report, hasHighlights, hasPredicted }: { report: SimilarityReport; hasHighlights: boolean; hasPredicted: boolean }) {
  const appears = "The text appears as submitted.";
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
        <p className="spr-manuscript-key">
          {hasPredicted ? "No source-verified matches. Dashed underlines mark unverified predicted passages." : "No passages matched."} {appears}
        </p>
      )}
    </div>
  );
}

function ManuscriptPages({ report, highlights, predicted, pages, total, firstPage }: { report: SimilarityReport; highlights: PrintHighlight[]; predicted: PredictedHighlightRange[]; pages: Array<{ start: number; end: number }>; total: number; firstPage: number }) {
  const text = report.text ?? "";
  const language = printLanguageLabel(report);
  const baseDir = language === "Arabic" ? "rtl" : "ltr";
  const opener = <ManuscriptOpener report={report} hasHighlights={highlights.length > 0} hasPredicted={predicted.length > 0} />;
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
            {renderManuscriptWindow(text, highlights, range.start, range.end, predicted)}
          </div>
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

/** The highlights the printed manuscript draws. */
export function similarityPrintHighlights(report: SimilarityReport): PrintHighlight[] {
  const vm = buildReportV2ViewModel(report);
  if (!vm) return [];
  return buildPrintHighlights(report, vm, new Map(rankPrintSources(vm).map((s) => [s.id, s.rank])));
}

export function SimilarityPrintReport({
  report,
  submitter = null,
  unified,
}: {
  report: SimilarityReport;
  submitter?: ReportSubmitter | null;
  /** The report's one similarity percentage (lib/system2-unified.ts), the figure the screen and the receipt show; omitted = System 1's. */
  unified?: UnifiedSimilarity;
}) {
  const model = useMemo(() => {
    const vm = buildReportV2ViewModel(report);
    if (!vm) return null;
    const ranked = rankPrintSources(vm);
    const rankById = new Map(ranked.map((s) => [s.id, s.rank]));
    const highlights = buildPrintHighlights(report, vm, rankById);
    // Pagination sees verified highlights only, so a prediction can never move a page break.
    const pages = paginateManuscriptForPrint(report.text ?? "", highlights.map((h) => ({ start: h.start, end: h.end })));
    return { vm, ranked, rankById, highlights, predicted: buildPrintPredicted(report), pages };
  }, [report]);
  if (!model) return null;
  const { vm, ranked, rankById, highlights, predicted, pages } = model;
  const manuscriptFirst = 4;
  const total = manuscriptFirst - 1 + Math.max(1, pages.length);
  return (
    <div className="spr-report">
      <CoverPage report={report} submitter={submitter} total={total} manuscriptFirst={manuscriptFirst} />
      <OverviewPage report={report} vm={vm} ranked={ranked} rankById={rankById} total={total} unified={unified} />
      <SourcesPage report={report} vm={vm} ranked={ranked} total={total} hasPredicted={predicted.length > 0} />
      <ManuscriptPages report={report} highlights={highlights} predicted={predicted} pages={pages} total={total} firstPage={manuscriptFirst} />
    </div>
  );
}
