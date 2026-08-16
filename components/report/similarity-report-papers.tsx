import type { ReactNode } from "react";
import {
  BookOpen,
  ChevronRight,
  ExternalLink,
  FileText,
  GraduationCap,
  Globe2,
  Quote,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { ExternalAcademicEvidence } from "@/lib/academic-search/types";
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
import { ReuseContextContainer } from "@/components/reuse-context/reuse-context-container";

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

/**
 * Phase 3 STEP 7: a defensive, UI-level re-application of the same
 * DOI-first, then-canonical-URL, then-provider-id identity rule
 * lib/academic-search/deduplicator.ts already applies before evidence is
 * ever attached to a report (see lib/academic-evidence-integration.ts's own
 * comment on why evidence[] should already be unique) — belt-and-suspenders
 * at the last rendering boundary, not a re-implementation of different
 * logic, so a report payload from a future/altered orchestrator version can
 * never show the same paper twice here even if its own dedup step changes.
 */
export function dedupeExternalAcademicEvidence(evidence: ExternalAcademicEvidence[]): ExternalAcademicEvidence[] {
  const seen = new Set<string>();
  const deduped: ExternalAcademicEvidence[] = [];
  for (const item of evidence) {
    const key = item.doi
      ? `doi:${item.doi.trim().toLowerCase()}`
      : item.url
        ? `url:${item.url.trim().toLowerCase()}`
        : `provider:${item.provider}:${item.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

/** Joins only the metadata fields actually present — STEP 6: "If a field is unavailable, omit it gracefully. Do not invent metadata." */
function academicEvidenceMetaLine(item: ExternalAcademicEvidence): string | null {
  const parts: string[] = [];
  if (item.authors && item.authors.length > 0) {
    parts.push(item.authors.length > 3 ? `${item.authors.slice(0, 3).join(", ")}, et al.` : item.authors.join(", "));
  }
  if (item.publication) parts.push(item.publication);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function AcademicEvidenceCard({ item }: { item: ExternalAcademicEvidence }) {
  const meta = academicEvidenceMetaLine(item);
  const bestPassage = item.matchedPassages[0];
  return (
    <article className="academic-evidence-card">
      <div className="academic-evidence-card-head">
        <span className="academic-evidence-tag">
          <GraduationCap aria-hidden="true" />
          Potential match
        </span>
        <span className="academic-evidence-overlap">{item.similarity}% passage overlap</span>
      </div>
      <h4>{item.title ?? "Untitled external source"}</h4>
      {meta && <p className="academic-evidence-meta">{meta}{item.year ? ` (${item.year})` : ""}</p>}
      {bestPassage && (
        <blockquote className="academic-evidence-excerpt">&ldquo;{bestPassage.submittedText}&rdquo;</blockquote>
      )}
      <div className="academic-evidence-links">
        <span>Source: {item.provider}</span>
        {item.doi && <span>DOI: {item.doi}</span>}
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer">
            View source <ExternalLink aria-hidden="true" />
          </a>
        )}
      </div>
    </article>
  );
}

/**
 * Phase 3 STEP 5/8: a clearly separate section from Archive overlap — never
 * styled as a score, never labeled "Plagiarism Score." Renders only when
 * report.externalAcademicEvidence is present and non-empty (STEP 2: absent
 * means exactly "no external academic evidence," including for every report
 * saved before this phase existed); a report still being background-checked
 * simply shows nothing here yet, the same way report.webCheck's own
 * Wikipedia chip shows nothing until that background check resolves.
 */
export function AcademicEvidenceSection({ report }: { report: SimilarityReport }) {
  if (!report.externalAcademicEvidence || report.externalAcademicEvidence.length === 0) return null;
  const evidence = dedupeExternalAcademicEvidence(report.externalAcademicEvidence);
  if (evidence.length === 0) return null;

  return (
    <section className="academic-evidence-block">
      <h3>External Academic Sources</h3>
      <p className="academic-evidence-intro">
        {evidence.length} potential external academic {evidence.length === 1 ? "source" : "sources"} found outside TurnitPlus&apos;s own archive.
        This is separate evidence and does not change Archive overlap.
      </p>
      <div className="academic-evidence-list">
        {evidence.map((item, index) => (
          <AcademicEvidenceCard item={item} key={item.doi ?? item.url ?? `${item.provider}-${item.providerId}-${index}`} />
        ))}
      </div>
    </section>
  );
}

/**
 * Phase 6: the unified-similarity read-time result (lib/unified-similarity.ts,
 * computed at read time in app/api/reports/[id]/route.ts and
 * app/reports/[id]/page.tsx) rendered as its own additive section — never
 * replaces or restyles the existing "Archive overlap" heading above it,
 * matching the same "clearly separate, never a competing score" discipline
 * AcademicEvidenceSection already established for external evidence.
 * Renders nothing for a report that predates this phase, or when the
 * read-time computation itself failed (both leave report.unifiedSimilarity
 * undefined) — the existing Archive overlap section still renders normally
 * either way.
 */
function unifiedEvidenceBreakdown(report: SimilarityReport): string[] {
  const unified = report.unifiedSimilarity;
  if (!unified) return [];
  const parts: string[] = [];
  if (unified.archiveOnlyWords > 0) {
    parts.push(`${unified.archiveOnlyWords.toLocaleString()} word${unified.archiveOnlyWords === 1 ? "" : "s"} from TurnitPlus's own archive`);
  }
  if (unified.liveAcademicOnlyWords > 0) {
    parts.push(`${unified.liveAcademicOnlyWords.toLocaleString()} word${unified.liveAcademicOnlyWords === 1 ? "" : "s"} from verified external academic sources`);
  }
  if (unified.previousUploadOnlyWords > 0) {
    parts.push(`${unified.previousUploadOnlyWords.toLocaleString()} word${unified.previousUploadOnlyWords === 1 ? "" : "s"} from an eligible previous TurnitPlus submission`);
  }
  if (unified.overlapWords > 0) {
    parts.push(`${unified.overlapWords.toLocaleString()} word${unified.overlapWords === 1 ? "" : "s"} identified by more than one source, counted once`);
  }
  return parts;
}

export function UnifiedSimilaritySection({ report }: { report: SimilarityReport }) {
  const unified = report.unifiedSimilarity;
  if (!unified) return null;
  const verdict = similarityScoreBand(unified.unifiedScore);
  const breakdown = unifiedEvidenceBreakdown(report);
  const excludedSelf = unified.selfExcludedWords;
  const excludedUnknown = unified.unknownExcludedWords;

  return (
    <section className={`unified-similarity-block ${verdict ? `unified-verdict-${verdict.key}` : ""}`}>
      <h2>
        <span>{unified.unifiedScore}%</span> TurnitPlus Similarity
        {verdict && <em>{verdict.label}</em>}
      </h2>
      <p>
        Combines TurnitPlus&apos;s own archive matches, verified external academic sources, and eligible previous
        TurnitPlus submissions into one result. The same submitted passage found by more than one source counts once,
        never added twice.
      </p>
      {breakdown.length > 0 && (
        <p className="unified-similarity-note">{breakdown.join(" · ")}.</p>
      )}
      {(excludedSelf > 0 || excludedUnknown > 0) && (
        <p>
          {excludedSelf > 0 && `${excludedSelf.toLocaleString()} matched word${excludedSelf === 1 ? "" : "s"} came from your own earlier TurnitPlus submission and were excluded. `}
          {excludedUnknown > 0 && `${excludedUnknown.toLocaleString()} matched word${excludedUnknown === 1 ? "" : "s"} came from content whose ownership could not be determined and were excluded.`}
        </p>
      )}
    </section>
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

        {/* Phase 6: the combined unified-similarity result — placed directly
            after Archive overlap (unchanged above) and before every
            individual supporting-evidence block below, so a reader sees the
            one combined number first, then the archive/live/prior-submission
            breakdown that produced it. Renders nothing when unavailable —
            see UnifiedSimilaritySection's own comment. */}
        <UnifiedSimilaritySection report={report} />

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
            {report.reuseContext && (
              <ReuseContextContainer documentIdentityId={report.reuseContext.documentIdentityId} representationId={null} />
            )}
          </section>
        )}
        {report.historicalSubmissionMatch?.status === "MATCHED" && (
          <section className="historical-match-block">
            <h3>Previously submitted content</h3>
            <p className="historical-match-archive-note">This historical submission match is not included in Archive overlap.</p>
            {renderHistoricalMatchEntries(report.historicalSubmissionMatch.matches?.slice(0, 5) ?? [])}
            {/* Phase E8S Step 11: additive only — representationId is null
                unless lib/e8s-report-integration.ts already determined the
                primary match is PRIOR_SUBMISSION, so this never appears for
                a SELF match and never touches renderHistoricalMatchEntries
                above (E8R-SELF-UI.2's own consolidated block, untouched). */}
            {report.reuseContext && (
              <ReuseContextContainer
                documentIdentityId={report.reuseContext.documentIdentityId}
                representationId={report.reuseContext.representationId}
              />
            )}
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

        {/* Phase E8S Step 11: the original-submitter pending-declarations
            panel can apply even when THIS report shows no historical match
            of its own (production's own status here reflects only what
            existed BEFORE this submission — a later, unrelated submission
            can still reference this report's own identity). Never renders
            a visible section unless there is actually something to show —
            see ReuseContextContainer's own standalone-mode comment. Placed
            after the E8P.3 block, never inside it, so it can never be
            mistaken for part of that experimental result. */}
        {report.historicalSubmissionMatch?.status !== "UNAVAILABLE" && report.historicalSubmissionMatch?.status !== "MATCHED" && report.reuseContext && (
          <ReuseContextContainer documentIdentityId={report.reuseContext.documentIdentityId} representationId={null} standalone />
        )}

        {/* Phase 3: external academic-source evidence (OpenAIRE + Europe
            PMC) — a completely separate signal from every historical-match
            block above (TurnitPlus's own corpus/account history) and from
            Archive overlap itself. Placed last among the "additional
            evidence, not part of the score" blocks so it never reads as
            more authoritative than TurnitPlus's own primary result above
            it. Renders nothing at all when absent — see
            AcademicEvidenceSection's own comment. */}
        <AcademicEvidenceSection report={report} />

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
