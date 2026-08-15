import type { ReactNode } from "react";
import {
  BookOpen,
  ChevronRight,
  FileText,
  GraduationCap,
  Globe2,
  Quote,
  Search,
  ShieldCheck,
} from "lucide-react";
import { similarityScoreBand } from "@/lib/ai-core";
import {
  SIMILARITY_BAND_LABELS,
  archiveMatchedWordCount,
  archiveOverlapScore,
  archiveScopeCount,
  sourceMatchedWordCount,
  type HighlightRange,
  type HistoricalSubmissionMatchEntry,
  type SimilarityReport,
  type SourceType,
} from "@/lib/report-types";
import { ReportPageFooter, ReportPageHeader } from "./report-page-chrome";

/**
 * Phase E8R-SELF-UI.2: groups every SELF-relationship entry in matches[]
 * into ONE consolidated block (one heading, one entry per match, one
 * disclaimer) instead of repeating the full heading/disclaimer per match —
 * see this phase's own task description for the UX problem (a report with
 * several prior SELF submissions rendered the same block over and over).
 * PRIOR_SUBMISSION and UNKNOWN_RELATIONSHIP entries are untouched — this
 * function only ever changes how SELF entries are grouped, never their
 * content, and never touches matcher/scoring/threshold code (none of that
 * lives in this file to begin with).
 *
 * Renders each non-SELF match in its original array position, and inserts
 * the one consolidated SELF block at the position of the FIRST SELF match
 * encountered — so relative ordering against PRIOR_SUBMISSION/UNKNOWN_RELATIONSHIP
 * entries is preserved exactly as before, only the SELF entries themselves
 * are pulled together. Subsequent SELF matches are folded into that same
 * block rather than re-rendered at their own array position.
 */
function renderHistoricalMatchEntries(matches: HistoricalSubmissionMatchEntry[]): ReactNode[] {
  const selfMatches = matches.filter((match) => match.relationshipType === "SELF");
  let selfBlockRendered = false;

  return matches.map((match, index) => {
    if (match.relationshipType === "SELF") {
      if (selfBlockRendered) return null;
      selfBlockRendered = true;
      return (
        <div className="historical-match-entry historical-match-entry-self" key="self-consolidated">
          <p className="historical-match-self-heading"><strong>Previously submitted content — your own work</strong></p>
          {selfMatches.map((selfMatch, selfIndex) => (
            <div className="historical-match-self-item" key={selfMatch.matchedRepresentationId ?? `self-${selfIndex}`}>
              <p>
                <strong>{Math.round(selfMatch.containment * 100)}%</strong> of this submission matches {selfIndex === 0 ? "your previous TurnitPlus submission" : "another previous TurnitPlus submission"} ({selfMatch.matchedWordCount.toLocaleString()} matched words).
              </p>
              {selfMatch.passages.length > 0 && (
                <ul className="historical-match-passages">
                  {selfMatch.passages.slice(0, 3).map((passage, passageIndex) => (
                    <li key={passageIndex}>&ldquo;{passage.submittedText}&rdquo;</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p>{selfMatches.length > 1 ? "These are self-matches and are not evidence of plagiarism." : "This is a self-match and is not evidence of plagiarism."}</p>
        </div>
      );
    }
    return (
      <div className="historical-match-entry" key={match.matchedRepresentationId ?? index}>
        <p>
          {match.relationshipType === "PRIOR_SUBMISSION" && (
            <><strong>{Math.round(match.containment * 100)}%</strong> of this submission matches content previously submitted to TurnitPlus ({match.matchedWordCount.toLocaleString()} matched words). This is not proof of plagiarism.</>
          )}
          {match.relationshipType === "UNKNOWN_RELATIONSHIP" && (
            <>Related content was previously observed among TurnitPlus submissions (<strong>{Math.round(match.containment * 100)}%</strong> containment), but ownership could not be determined for this submission.</>
          )}
        </p>
        {match.passages.length > 0 && (
          <ul className="historical-match-passages">
            {match.passages.slice(0, 3).map((passage, passageIndex) => (
              <li key={passageIndex}>&ldquo;{passage.submittedText}&rdquo;</li>
            ))}
          </ul>
        )}
      </div>
    );
  });
}

/**
 * Phase E8P.3: deliberately a small, local, zero-dependency copy of
 * lib/e8p-visibility.ts's own experimentalRelationshipCopy wording (kept
 * textually identical there and here) rather than an import — importing
 * that module here would pull the whole E8M/V2/candidate-search pipeline
 * into this UI component's dependency graph for the sake of three strings.
 */
function experimentalRelationshipLabel(relationship: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP"): string {
  if (relationship === "SELF") return "You previously submitted this content.";
  if (relationship === "PRIOR_SUBMISSION") return "This content was previously submitted to TurnitPlus.";
  return "Related content was previously submitted to TurnitPlus, but ownership could not be determined for this submission.";
}

function sourceIcon(type: SourceType) {
  if (type === "Internet") return <Globe2 aria-hidden="true" />;
  if (type === "Publication") return <BookOpen aria-hidden="true" />;
  return <GraduationCap aria-hidden="true" />;
}

export function CategorySummary({ report }: { report: SimilarityReport }) {
  const categories = [
    {
      label: "Indexed publications",
      type: "Publication" as SourceType,
      icon: <BookOpen aria-hidden="true" />,
    },
  ];

  return (
    <div className="category-list">
      {categories.map((category) => {
        const percent = report.sources
          .filter((source) => source.type === category.type)
          .reduce((sum, source) => sum + source.percent, 0);
        return (
          <div className="category-row" key={category.type}>
            <strong>{percent}%</strong>
            {category.icon}
            <span>{category.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function MatchGroups({ report }: { report: SimilarityReport }) {
  const directMatches = report.sources.reduce((sum, source) => sum + source.matches, 0);
  const directPercent = archiveOverlapScore(report);
  const groups = [
    {
      className: "not-cited",
      icon: <FileText aria-hidden="true" />,
      title: `${directMatches} Not Cited or Quoted`,
      percent: directPercent,
      copy: "Matches with neither in-text citation nor quotation marks",
    },
    {
      className: "missing-quotes",
      icon: <Quote aria-hidden="true" />,
      title: "Manual review required",
      percent: 0,
      copy: "The checker does not decide whether a match is properly quoted",
    },
    {
      className: "missing-citation",
      icon: <Search aria-hidden="true" />,
      title: "0 Missing Citation",
      percent: 0,
      copy: "Matches with quotation marks, but no in-text citation",
    },
    {
      className: "cited",
      icon: <GraduationCap aria-hidden="true" />,
      title: "0 Cited and Quoted",
      percent: 0,
      copy: "Matches with in-text citation present and quotation marks",
    },
  ];

  return (
    <div className="match-groups">
      {groups.map((group) => (
        <div className="match-group" key={group.className}>
          <span className={`match-group-icon ${group.className}`}>{group.icon}</span>
          <div>
            <div className="match-group-title">
              <strong>{group.title}</strong>
              <span>{group.percent}%</span>
            </div>
            <p>{group.copy}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SourceList({ report, detailed = false }: { report: SimilarityReport; detailed?: boolean }) {
  if (report.sources.length === 0) {
    return (
      <div className="no-sources">
        <ShieldCheck aria-hidden="true" />
        <strong>No weighted source matches</strong>
        <p>No distinctive five-word passage matched the private full-document database.</p>
      </div>
    );
  }

  return (
    <div className={`ranked-sources ${detailed ? "detailed" : ""}`}>
      {report.sources.map((source, index) => (
        <article className="ranked-source" key={`${source.name}-${index}`}>
          <div className="source-tags">
            <span className="source-number" style={{ backgroundColor: source.color }}>
              {index + 1}
            </span>
            <span className="source-type" style={{ backgroundColor: `${source.color}24` }}>
              {sourceIcon(source.type)}
              {source.type}
            </span>
          </div>
          <div className="source-name-row">
            <div>
              <strong>{source.name}</strong>
              <p>
                {sourceMatchedWordCount(source, report).toLocaleString()} matched words across {source.matches} passage group{source.matches === 1 ? "" : "s"}
              </p>
            </div>
            <b>{source.percent}%</b>
          </div>
          {detailed && (
            <div className="source-progress" aria-label={`${source.percent}% match`}>
              <span style={{ width: `${Math.max(4, source.percent * 5)}%`, backgroundColor: source.color }} />
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export function OverviewReport({ report }: { report: SimilarityReport }) {
  const overlapScore = archiveOverlapScore(report);
  const similarityVerdict = similarityScoreBand(overlapScore);
  const wikipediaMatches = report.webCheck?.phrasesMatched ?? 0;
  const archiveCount = archiveScopeCount(report);
  return (
    <article className="report-paper overview-paper">
      <ReportPageHeader report={report} page={2} label="Integrity Overview" />
      <div className="paper-content">
        <section className={`similarity-heading ${similarityVerdict ? `similarity-verdict-${similarityVerdict.key}` : ""}`}>
          <h2>
            <span>{overlapScore}%</span> Archive overlap
            {similarityVerdict && <em>{SIMILARITY_BAND_LABELS[similarityVerdict.key]}</em>}
          </h2>
          <aside className="archive-scope-note">
            Archive overlap: {overlapScore}% — matched against {archiveCount.toLocaleString()} indexed documents. This is not an estimate of a Turnitin score.
          </aside>
          <p>
            TurnitPlus found {archiveMatchedWordCount(report).toLocaleString()} matched words within its indexed archive.
            Review the highlighted passages and named sources to see exactly what produced the result.
            {wikipediaMatches > 0 && <> {wikipediaMatches} exact Wikipedia phrase match{wikipediaMatches === 1 ? "" : "es"} are shown separately and do not change Archive overlap.</>}
            {report.excludedDocuments > 0 && (
              <> {report.excludedDocuments} content-identical archive document was excluded and recorded as a probable self-match.</>
            )}
          </p>
        </section>

        {/* Phase E8G: consolidated historical-submission presentation.
            Before this phase, Phase D's matchClassification (family-based)
            and E8C/E8D's historicalSubmissionMatch (corpus/shingle-based,
            passage-level) each rendered their own visible section, showing
            the same underlying signal twice with different wording — see
            this phase's own task description. matchClassification is still
            computed and attached server-side (app/reports/[id]/page.tsx,
            GET /api/reports/[id]) — untouched, since this phase is
            presentation-only — it is simply no longer rendered here.
            historicalSubmissionMatch is the richer of the two (passage
            evidence, versioned snapshot) and is the only one shown.
            Deliberately never combined with Archive overlap's own number —
            see lib/report-historical-match.ts's own comment. */}
        {report.historicalSubmissionMatch?.status === "UNAVAILABLE" && (
          <section className="historical-match-block">
            <h3>Previously submitted content</h3>
            <p>Historical matching unavailable for this report.</p>
          </section>
        )}
        {report.historicalSubmissionMatch?.status === "MATCHED" && (
          <section className="historical-match-block">
            <h3>Previously submitted content</h3>
            <p className="historical-match-archive-note">This historical submission match is not included in Archive overlap.</p>
            {renderHistoricalMatchEntries(report.historicalSubmissionMatch.matches?.slice(0, 5) ?? [])}
          </section>
        )}

        {/* Phase E8P.3: the experimental E8O partial-match result — a
            SEPARATE field from historicalSubmissionMatch above (see
            lib/report-types.ts's own comment), only ever populated
            server-side for an explicitly allowlisted internal/test account
            (lib/e8p-visibility.ts) and only ever when historicalSubmissionMatch
            itself is NOT already MATCHED, so this never appears alongside or
            competes with a real production result. Reuses the existing
            "Previously submitted content" heading/section — not a second
            historical section — with its own clearly-labeled sub-block. */}
        {!report.historicalSubmissionMatch?.matches?.length && report.experimentalHistoricalMatch && (
          <section className="historical-match-block historical-match-block-experimental">
            <h3>Previously submitted content</h3>
            <div className="historical-match-entry historical-match-entry-experimental">
              <p className="historical-match-experimental-label">Historical submission evidence (experimental)</p>
              <p>
                {experimentalRelationshipLabel(report.experimentalHistoricalMatch.relationship)}{" "}
                ({report.experimentalHistoricalMatch.matchedWordCount.toLocaleString()} matched words across {report.experimentalHistoricalMatch.passageCount} passage{report.experimentalHistoricalMatch.passageCount === 1 ? "" : "s"}).
              </p>
              {report.experimentalHistoricalMatch.passages.length > 0 && (
                <ul className="historical-match-passages">
                  {report.experimentalHistoricalMatch.passages.slice(0, 3).map((passage, passageIndex) => (
                    <li key={passageIndex}>&ldquo;{passage.submittedText}&rdquo;</li>
                  ))}
                </ul>
              )}
              <p className="historical-match-archive-note">{report.experimentalHistoricalMatch.disclaimer} This is not proof of plagiarism.</p>
            </div>
          </section>
        )}

        <section className="filtered-block">
          <h3>Filtered from the Report</h3>
          <p><ChevronRight aria-hidden="true" /> Bibliography</p>
        </section>

        <div className="overview-columns">
          <section>
            <h3>Match Groups</h3>
            <MatchGroups report={report} />
          </section>
          <section>
            <h3>Top Sources</h3>
            <CategorySummary report={report} />
          </section>
        </div>

        <section className="top-sources-section">
          <h3>Top Sources</h3>
          <p>The sources with the highest number of potential matches within this submission.</p>
          <SourceList report={report} />
        </section>
      </div>
      <ReportPageFooter report={report} page={2} label="Integrity Overview" />
    </article>
  );
}

function phrasePattern(phrase: string) {
  const words = phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? `\\b${words.join("[\\s\\W]+")}\\b` : "";
}

function findHighlightRanges(report: SimilarityReport) {
  const candidates: HighlightRange[] = [];

  report.sources.forEach((source, sourceIndex) => {
    source.phrases.slice(0, 140).forEach((phrase) => {
      const pattern = phrasePattern(phrase);
      if (!pattern) return;
      const expression = new RegExp(pattern, "gi");
      let match = expression.exec(report.text);
      while (match) {
        candidates.push({
          start: match.index,
          end: match.index + match[0].length,
          sourceIndex,
          color: source.color,
          label: source.name,
          kind: "source",
        });
        if (expression.lastIndex === match.index) expression.lastIndex += 1;
        match = expression.exec(report.text);
      }
    });
  });

  report.webCheck?.matches.filter((match) => match.matched).forEach((match) => {
    const pattern = phrasePattern(match.phrase);
    const source = match.sources[0];
    if (!pattern || !source) return;
    const expression = new RegExp(pattern, "gi");
    let found = expression.exec(report.text);
    while (found) {
      candidates.push({
        start: found.index,
        end: found.index + found[0].length,
        sourceIndex: -1,
        color: "#0784b4",
        label: source.title,
        kind: "wikipedia",
        url: source.url,
        wikipediaSources: match.sources,
      });
      if (expression.lastIndex === found.index) expression.lastIndex += 1;
      found = expression.exec(report.text);
    }
  });

  const sourceCandidates = candidates
    .filter((candidate) => candidate.kind === "source")
    .sort((left, right) => left.sourceIndex - right.sourceIndex || left.start - right.start || right.end - left.end);
  const mergedSources: HighlightRange[] = [];

  sourceCandidates.forEach((candidate) => {
    const previous = mergedSources[mergedSources.length - 1];
    if (
      previous &&
      previous.sourceIndex === candidate.sourceIndex &&
      candidate.start <= previous.end + 3
    ) {
      previous.end = Math.max(previous.end, candidate.end);
      return;
    }
    mergedSources.push({ ...candidate });
  });

  const accepted: HighlightRange[] = [];
  const wikipediaCandidates = candidates
    .filter((candidate) => candidate.kind === "wikipedia")
    .sort((left, right) => left.start - right.start || right.end - left.end);

  [...wikipediaCandidates, ...mergedSources]
    .forEach((candidate) => {
      const overlaps = accepted.some(
        (range) => candidate.start < range.end && candidate.end > range.start,
      );
      if (!overlaps) accepted.push(candidate);
    });

  return accepted.sort((left, right) => left.start - right.start);
}

function HighlightedDocument({ report }: { report: SimilarityReport }) {
  const ranges = findHighlightRanges(report);
  if (ranges.length === 0) {
    return <div className="submission-rendered-text">{report.text}</div>;
  }

  const pieces: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      pieces.push(report.text.slice(cursor, range.start));
    }
    pieces.push(
      <mark
        className={`submission-match ${range.kind === "wikipedia" ? "submission-wikipedia-match" : ""}`}
        key={`${range.start}-${range.end}-${index}`}
        style={{
          backgroundColor: `${range.color}30`,
          borderBottomColor: range.color,
          boxShadow: `inset 3px 0 0 ${range.color}`,
        }}
        title={range.kind === "source" ? `Source ${range.sourceIndex + 1}: ${range.label}` : `Found on Wikipedia: ${range.label}`}
      >
        {report.text.slice(range.start, range.end)}
        <span style={{ backgroundColor: range.color }}>
          {range.kind === "source" ? range.sourceIndex + 1 : "W"}
        </span>
        {range.kind === "wikipedia" && range.wikipediaSources?.map((source) => (
          <a className="wikipedia-source-link" key={source.pageId} href={source.url} target="_blank" rel="noreferrer">
            <Globe2 aria-hidden="true" />
            <b>{source.title}</b>
            <small>Found on Wikipedia; shown as separate evidence and not included in Archive overlap.</small>
          </a>
        ))}
      </mark>,
    );
    cursor = range.end;
  });

  if (cursor < report.text.length) {
    pieces.push(report.text.slice(cursor));
  }

  return <div className="submission-rendered-text">{pieces}</div>;
}

export function HighlightLegend({ report }: { report: SimilarityReport }) {
  const wikipediaSources = [...new Map(
    (report.webCheck?.matches ?? [])
      .filter((match) => match.matched)
      .flatMap((match) => match.sources)
      .map((source) => [source.pageId, source]),
  ).values()];
  return (
    <div className="highlight-legend">
      <div>
        <strong>{wikipediaSources.length > 0 ? "Matched passages" : "Red matched passages"}</strong>
        <span>{wikipediaSources.length > 0 ? "Red marks the indexed archive; blue W marks separate Wikipedia evidence that does not change Archive overlap" : "Each number connects the matched phrase to an indexed source document"}</span>
      </div>
      <div className="highlight-legend-items">
        {report.sources.map((source, index) => (
          <span className="highlight-legend-item" key={source.name} title={source.name}>
            <i style={{ backgroundColor: source.color }}>{index + 1}</i>
            {source.name}
          </span>
        ))}
        {wikipediaSources.map((source) => (
          <a className="highlight-legend-item wikipedia-legend-item" key={`wiki-${source.pageId}`} href={source.url} target="_blank" rel="noreferrer">
            <i>W</i>
            {source.title}
          </a>
        ))}
      </div>
    </div>
  );
}

export function SubmissionReport({ report }: { report: SimilarityReport }) {
  return (
    <article className="report-paper submission-paper">
      <ReportPageHeader report={report} page={3} label="Integrity Submission" />
      <div className="paper-content">
        <div className="submission-title">
          <span>1</span>
          <h2>{report.title.replace(/\.[^.]+$/, "")}</h2>
        </div>
        <HighlightLegend report={report} />
        <div className="submission-copy">
          <HighlightedDocument report={report} />
        </div>
      </div>
      <ReportPageFooter report={report} page={3} label="Integrity Submission" />
    </article>
  );
}

export function SourcesReport({ report }: { report: SimilarityReport }) {
  return (
    <article className="report-paper sources-paper">
      <ReportPageHeader report={report} page={4} label="Source Details" />
      <div className="paper-content">
        <section className="source-detail-heading">
          <p className="paper-kicker">SOURCE REVIEW</p>
          <h2>Potential matching sources</h2>
          <p>Review each source alongside the highlighted submission text before deciding whether a citation is needed.</p>
        </section>
        <SourceList report={report} detailed />
      </div>
      <ReportPageFooter report={report} page={4} label="Source Details" />
    </article>
  );
}
