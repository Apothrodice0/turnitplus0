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
import { mergeAdjacentPositions, tokenSpans } from "@/lib/similarity-core";
import {
  PRIMARY_SIMILARITY_BAND_LABELS,
  archiveOverlapScore,
  hasUnifiedSimilarity,
  primaryMatchedWordCount,
  primaryResultLabel,
  primarySimilarityScore,
  referenceSourceContributionPercent,
  referenceSourceMatchedPositions,
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
          {match.relationshipType === "TURNITPLUS_CORPUS_SOURCE" && (
            <><strong>{Math.round(match.containment * 100)}%</strong> of this submission matches a TurnitPlus corpus reference source ({match.matchedWordCount.toLocaleString()} matched words). This is not another user&apos;s submission — no account or report is associated with this match.</>
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
      {/* Report-source presentation correction: report.sources above is
          archive-only and has no awareness of report.unifiedSimilarity, so
          a corpus/internal-only match previously left every category here
          at 0% even at 100% TurnitPlus Similarity. previousUploadOnlyWords
          (via referenceSourceContributionPercent) is that missing
          contribution, shown under a generic label — never "corpus" or
          "prior submission" — and only when a unified result exists at
          all, since archive-only reports have no such bucket to show.
          Rendered unconditionally whenever it applies, even at a genuine
          0% — matching Indexed publications above, which this list has
          always shown at 0% too. This list documents every category
          TurnitPlus searched, not only the ones that contributed; hiding
          this one specifically below some threshold would break that
          existing convention and would itself leak a signal (a report
          missing the row vs. one showing 0% for it). */}
      {hasUnifiedSimilarity(report) && (
        <div className="category-row" key="turnitplus-reference-sources">
          <strong>{referenceSourceContributionPercent(report)}%</strong>
          <ShieldCheck aria-hidden="true" />
          <span>TurnitPlus reference sources</span>
        </div>
      )}
    </div>
  );
}

/**
 * Highlighting fix — investigated, deliberately left UNCHANGED: "Not Cited
 * or Quoted" is the only one of these four groups with any real
 * classification behind it (the other three — "Manual review required",
 * "Missing Citation", "Cited and Quoted" — are permanent 0%/hardcoded
 * placeholders; no in-text-citation or quotation-mark classifier exists
 * anywhere in this codebase to run over any span, unified or otherwise —
 * searched for one specifically for this fix, there is genuinely nothing to
 * wire in, not an oversight). Documented per this fix's own requirement to
 * never claim highlighted passages explain more of the result than they
 * actually do.
 *
 * "Not Cited or Quoted" itself is INTENTIONALLY archive-scoped, not a gap
 * this fix should close: tests/similarity-result-consistency.test.mjs's own
 * "SIM-01 (d)" test (pre-existing, unrelated to this fix) explicitly
 * requires archiveOverlapScore here, with its own comment stating this
 * tile "must keep doing so... never silently switched to the unified
 * [score] (which would make an archive-specific classification breakdown
 * lie about what it actually measures)." Match Groups is a real,
 * archive-specific classification surface (distinguishing which archive
 * matches lack citation/quotation), not a second rendering of the unified
 * headline — UnifiedSimilaritySection above already covers the full
 * unified breakdown by source type. Switching this to
 * primarySimilarityScore/unified spans would not close a real gap; it
 * would duplicate the headline under a misleading citation-classification
 * label. Left exactly as before.
 */
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

/**
 * Highlighting fix: report.sources is archive-only and has no awareness of
 * report.unifiedSimilarity — the same gap CategorySummary's own
 * "TurnitPlus reference sources" row already closes for the category
 * breakdown (see that function's own comment). "Source Details" (this
 * component's real render target — see SourcesReport's page label) had the
 * identical gap: a report whose entire unified result came from the
 * previous-upload/corpus channel showed "No weighted source matches" here,
 * even at a genuine 100%. Never invents a fake publication — one generic,
 * privacy-safe entry, matching CategorySummary's own wording exactly, using
 * referenceSourceMatchedPositions(report).length (the canonical position
 * count) rather than re-deriving anything from a percentage.
 */
function ReferenceSourceEntry({ report, detailed }: { report: SimilarityReport; detailed: boolean }) {
  const matchedWords = referenceSourceMatchedPositions(report).length;
  if (matchedWords === 0) return null;
  const percent = referenceSourceContributionPercent(report);
  return (
    <article className="ranked-source ranked-source-reference" key="turnitplus-reference-sources">
      <div className="source-tags">
        <span className="source-number" style={{ backgroundColor: REFERENCE_SOURCE_HIGHLIGHT_COLOR }}>
          <ShieldCheck aria-hidden="true" />
        </span>
        <span className="source-type" style={{ backgroundColor: `${REFERENCE_SOURCE_HIGHLIGHT_COLOR}24` }}>
          <ShieldCheck aria-hidden="true" />
          TurnitPlus corpus
        </span>
      </div>
      <div className="source-name-row">
        <div>
          <strong>TurnitPlus reference sources</strong>
          <p>{matchedWords.toLocaleString()} matched word{matchedWords === 1 ? "" : "s"} — no account or report is associated with this match</p>
        </div>
        <b>{percent}%</b>
      </div>
      {detailed && (
        <div className="source-progress" aria-label={`${percent}% match`}>
          <span style={{ width: `${Math.max(4, percent * 5)}%`, backgroundColor: REFERENCE_SOURCE_HIGHLIGHT_COLOR }} />
        </div>
      )}
    </article>
  );
}

export function SourceList({ report, detailed = false }: { report: SimilarityReport; detailed?: boolean }) {
  // Task A correction: an explicit, server-decided authorization signal
  // (see SimilarityReport.viewerIsAdmin's own comment), never inferred from
  // whether report.historicalSubmissionMatch happens to be present — that
  // field's presence conflates "this report has a match to show" with "this
  // viewer is authorized," and would read a real admin's own no-match
  // report as ordinary.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const hasReferenceSources = referenceSourceMatchedPositions(report).length > 0;
  if (report.sources.length === 0 && !hasReferenceSources) {
    return (
      <div className="no-sources">
        <ShieldCheck aria-hidden="true" />
        <strong>No weighted source matches</strong>
        <p>No distinctive five-word passage matched the private full-document database.</p>
      </div>
    );
  }

  // Ordinary-user simplification: an internal-only match has nothing
  // nameable to list here, but real matches DO exist and are highlighted in
  // the submission text — never claim "no matches", which would contradict
  // a nonzero headline score. Admins keep the detailed ReferenceSourceEntry
  // below instead.
  if (report.sources.length === 0 && hasReferenceSources && !canSeeSourceBreakdown) {
    return (
      <div className="no-sources">
        <ShieldCheck aria-hidden="true" />
        <strong>Matched passages found</strong>
        <p>Review the highlighted submission text for the matched passages contributing to this result.</p>
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
      {canSeeSourceBreakdown && <ReferenceSourceEntry report={report} detailed={detailed} />}
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

function AcademicEvidenceCard({ item, canSeeSourceBreakdown }: { item: ExternalAcademicEvidence; canSeeSourceBreakdown: boolean }) {
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
        {/* Ordinary-user simplification: "Source: {provider}" (e.g. "openaire",
            "europe-pmc") names the fetching provider channel, not the cited
            work itself — admin-only. The title/DOI/URL above/below (the
            actual publicly verifiable citation) are unaffected. */}
        {canSeeSourceBreakdown && <span>Source: {item.provider}</span>}
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
 * saved before this phase existed).
 *
 * "start the two fixes now" TASK 2/3: for a report saved after that task,
 * report.academicEvidenceStatus is always one of COMPLETE_WITH_MATCHES/
 * COMPLETE_NO_MATCHES/FAILED (the check is now awaited before the report is
 * ever shown — see app/page.tsx's generateReport()), so this section now
 * renders something honest in all three cases instead of going silent for
 * two of them: FAILED gets an explicit "unavailable" notice (never
 * presented as "no matches"), COMPLETE_NO_MATCHES gets a brief confirmation
 * that the check actually ran, and COMPLETE_WITH_MATCHES keeps the existing
 * evidence list. A report with no academicEvidenceStatus at all (saved
 * before this task) renders nothing here, exactly as before.
 */
export function AcademicEvidenceSection({ report }: { report: SimilarityReport }) {
  // Ordinary-user simplification (Task A, final report simplification):
  // "OpenAIRE"/"Europe PMC" are provider-channel names, not part of the
  // cited work itself — admin-only, same signal as everywhere else in this
  // file. The evidence itself (title/authors/DOI/URL, a real publicly
  // verifiable citation) is unaffected.
  // Task A correction: an explicit, server-decided authorization signal
  // (see SimilarityReport.viewerIsAdmin's own comment), never inferred from
  // whether report.historicalSubmissionMatch happens to be present — that
  // field's presence conflates "this report has a match to show" with "this
  // viewer is authorized," and would read a real admin's own no-match
  // report as ordinary.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const evidence = report.externalAcademicEvidence ? dedupeExternalAcademicEvidence(report.externalAcademicEvidence) : [];
  if (evidence.length > 0) {
    return (
      <section className="academic-evidence-block">
        <h3>External Academic Sources</h3>
        <p className="academic-evidence-intro">
          {evidence.length} potential external academic {evidence.length === 1 ? "source" : "sources"} found.
          This is separate evidence and does not change the similarity result.
        </p>
        <div className="academic-evidence-list">
          {evidence.map((item, index) => (
            <AcademicEvidenceCard item={item} canSeeSourceBreakdown={canSeeSourceBreakdown} key={item.doi ?? item.url ?? `${item.provider}-${item.providerId}-${index}`} />
          ))}
        </div>
      </section>
    );
  }

  if (report.academicEvidenceStatus === "FAILED") {
    return (
      <section className="academic-evidence-block academic-evidence-unavailable">
        <h3>External Academic Sources</h3>
        <p className="academic-evidence-intro">
          {canSeeSourceBreakdown
            ? <>External academic verification was unavailable for this report — OpenAIRE and Europe PMC could not be
                reached, or every request failed. This is not the same as &quot;no matches found&quot;; it means the check
                itself did not complete.</>
            : <>External academic verification was unavailable for this report. This is not the same as &quot;no matches found&quot;; it means the check itself did not complete.</>}
        </p>
      </section>
    );
  }

  if (report.academicEvidenceStatus === "COMPLETE_NO_MATCHES") {
    return (
      <section className="academic-evidence-block">
        <h3>External Academic Sources</h3>
        <p className="academic-evidence-intro">
          {canSeeSourceBreakdown
            ? <>Checked OpenAIRE and Europe PMC — no matching external academic sources were found.</>
            : <>No matching external academic sources were found.</>}
        </p>
      </section>
    );
  }

  return null;
}

/**
 * Phase 6: the unified-similarity read-time result (lib/unified-similarity.ts,
 * computed at read time in app/api/reports/[id]/route.ts and
 * app/reports/[id]/page.tsx) rendered as its own additive section — never
 * replaces or restyles the existing "Similarity result" heading above it,
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
    parts.push(`${unified.archiveOnlyWords.toLocaleString()} word${unified.archiveOnlyWords === 1 ? "" : "s"} from TurnitPlus's own reference material`);
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
  const excludedSelf = unified.selfExcludedWords;
  const excludedUnknown = unified.unknownExcludedWords;
  // Release-hardening audit finding UI-02: the per-source-type breakdown
  // ("X words from Y · Z words from an eligible previous TurnitPlus
  // submission"), the SELF/UNKNOWN exclusion note, and the explanatory
  // headline paragraph all name the exact same "previous submission"/
  // "corpus reference" concepts historicalSubmissionMatch itself is now
  // admin-gated for (see app/api/reports/[id]/route.ts's own comment) —
  // unifiedSimilarity's aggregate unifiedScore stays visible to every
  // viewer unconditionally (below), but these three more granular pieces
  // are additive detail, not the result itself, so they follow the
  // identical gate; a non-admin instead gets a fully generic version of the
  // explanatory paragraph that names no source type at all. Deliberately
  // reuses historicalSubmissionMatch's own presence on `report` — already
  // decided server-side, admin-only — rather than a new, separately-
  // maintained "isAdmin" signal that could drift out of sync with it: there
  // is exactly one place (that route's own role check) that decides who
  // sees this class of detail, not two. Report-source presentation
  // correction: left unchanged deliberately — this admin-only breakdown is
  // the same surface tests/report-historical-match-visibility.test.mjs
  // protects with an explicit "all-or-nothing gate" regression test.
  // Ordinary-user simplification (Task A, final report simplification):
  // CategorySummary's own per-source-type percentage row is now ALSO gated
  // behind this same signal (see OverviewReport/report-detail-shell.tsx's
  // own call sites) — an ordinary viewer no longer sees a source-type
  // breakdown anywhere, only the single authoritative unifiedScore.
  // Task A correction: an explicit, server-decided authorization signal
  // (see SimilarityReport.viewerIsAdmin's own comment), never inferred from
  // whether report.historicalSubmissionMatch happens to be present — that
  // field's presence conflates "this report has a match to show" with "this
  // viewer is authorized," and would read a real admin's own no-match
  // report as ordinary.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const breakdown = unifiedEvidenceBreakdown(report);

  return (
    <section className={`unified-similarity-block ${verdict ? `unified-verdict-${verdict.key}` : ""}`}>
      <h2>
        <span>{unified.unifiedScore}%</span> TurnitPlus Similarity
        {verdict && <em>{verdict.label}</em>}
      </h2>
      <p>
        {canSeeSourceBreakdown
          ? <>Combines TurnitPlus&apos;s own reference matches, verified external academic sources, and eligible
              previous TurnitPlus submissions into one result. The same submitted passage found by more than one
              source counts once, never added twice.</>
          : <>Combines matches identified across every reference source TurnitPlus checks into one result. The same
              submitted passage found by more than one source counts once, never added twice.</>}
      </p>
      {report.academicEvidenceStatus === "FAILED" && (
        <p className="unified-similarity-note unified-similarity-note-warning">
          {canSeeSourceBreakdown
            ? <>External academic verification (OpenAIRE, Europe PMC) was unavailable when this report was generated, so
                this result reflects TurnitPlus&apos;s own reference matches{report.historicalSubmissionMatch ? " and previous submissions" : ""} only. See External Academic Sources below for details.</>
            : <>Some external verification was unavailable when this report was generated, so this result may not reflect every source TurnitPlus checks. See External Academic Sources below for details.</>}
        </p>
      )}
      {canSeeSourceBreakdown && breakdown.length > 0 && (
        <p className="unified-similarity-note">{breakdown.join(" · ")}.</p>
      )}
      {canSeeSourceBreakdown && (excludedSelf > 0 || excludedUnknown > 0) && (
        <p>
          {excludedSelf > 0 && `${excludedSelf.toLocaleString()} matched word${excludedSelf === 1 ? "" : "s"} came from your own earlier TurnitPlus submission and were excluded. `}
          {excludedUnknown > 0 && `${excludedUnknown.toLocaleString()} matched word${excludedUnknown === 1 ? "" : "s"} came from content whose ownership could not be determined and were excluded.`}
        </p>
      )}
    </section>
  );
}

/**
 * Release-hardening audit finding SIM-01: this headline previously read
 * archiveOverlapScore/archiveMatchedWordCount directly — the archive-only
 * component score — even for a report whose authoritative combined result
 * (report.unifiedSimilarity, rendered immediately below by
 * UnifiedSimilaritySection) differed, sometimes dramatically (observed:
 * corpus-source match 100%, sidebar 100%, TurnitPlus Similarity section
 * 100%, this headline 0%). primarySimilarityScore/primaryMatchedWordCount/
 * primaryResultLabel (lib/report-types.ts) already existed and were already
 * used correctly by app/reports/[id]/report-detail-shell.tsx's sidebar score
 * card — this component was simply never wired to them. Both now share the
 * exact same selection, so every surface derived from this report agrees.
 *
 * Release-hardening audit finding SIM-02, refined by SIM-04, widened by
 * LIFECYCLE-06 (corrected): `similarityStatus` — "resolved" (default, so
 * every existing call site: the print bundle, every test fixture in this
 * codebase, renders exactly as before), "pending" (nothing persisted yet —
 * app/reports/[id]/report-detail-shell.tsx has not yet resolved the
 * report's real combined result), "stale" (a real combined result WAS
 * persisted, but the server says it no longer reflects the current corpus
 * generation/CORPUS_SOURCE_MATCHING_ENABLED state — see
 * lib/report-primary-similarity.ts's resolvePersistedSimilarityDisplay),
 * or "failed" (a genuine, persisted, reproducible overall-computation
 * failure — resolvePrimarySimilaritySummary's own computeUnifiedSimilarity
 * threw for this report's own data; see that function's own comment for
 * why a fail-soft individual-source issue, like an UNAVAILABLE historical
 * match, never reaches this status). "pending" and "stale" render a
 * neutral, still-working placeholder instead of the score/band/banner
 * rather than primarySimilarityScore's own archive-only fallback value —
 * requirement SIM-04's own explicit rule for "stale": show "Updating
 * similarity…" RATHER THAN the persisted score, never alongside it, since
 * that persisted number may itself be exactly what is about to change.
 * "failed" renders its own distinct, non-busy placeholder ("Similarity
 * unavailable") — a terminal outcome, not something still in progress, so
 * it deliberately does not share "pending"/"stale"'s spinner treatment.
 * Every matching-derived section below the headline (UnifiedSimilaritySection,
 * the historical-match blocks, the admin-only matchClassification block) is
 * ALSO gated on `similarityStatus === "resolved"` — see that guard's own
 * comment for why this is defensive rather than redundant.
 * MatchGroups/CategorySummary/SourceList and AcademicEvidenceSection are
 * untouched: both read data that is already correct regardless of this
 * status (report.sources is archive data attached at save time;
 * externalAcademicEvidence is resolved before a report is ever first
 * saved — see AcademicEvidenceSection's own call site comment below).
 */
export function OverviewReport({ report, similarityStatus = "resolved" }: { report: SimilarityReport; similarityStatus?: "resolved" | "stale" | "pending" | "failed" }) {
  const primaryScore = primarySimilarityScore(report);
  const primaryLabel = primaryResultLabel(report);
  const isUnified = hasUnifiedSimilarity(report);
  const similarityVerdict = similarityScoreBand(primaryScore);
  const wikipediaMatches = report.webCheck?.phrasesMatched ?? 0;
  const notResolved = similarityStatus !== "resolved";
  // Release-hardening audit finding UI-02: this headline's own "combines...
  // eligible previous TurnitPlus submissions" note named the exact same
  // source type UnifiedSimilaritySection's own breakdown does — a second
  // place carrying that wording this fix would otherwise have missed. Same
  // gate, same reasoning: see that component's own comment.
  // Task A correction: an explicit, server-decided authorization signal
  // (see SimilarityReport.viewerIsAdmin's own comment), never inferred from
  // whether report.historicalSubmissionMatch happens to be present — that
  // field's presence conflates "this report has a match to show" with "this
  // viewer is authorized," and would read a real admin's own no-match
  // report as ordinary.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  return (
    <article className="report-paper overview-paper">
      <ReportPageHeader report={report} page={2} label="Integrity Overview" />
      <div className="paper-content">
        {notResolved ? (
          <section
            className={`similarity-heading similarity-heading-pending similarity-heading-${similarityStatus}`}
            aria-live="polite"
            aria-busy={similarityStatus !== "failed"}
            aria-label={similarityStatus === "stale" ? "Updating similarity" : similarityStatus === "failed" ? "Similarity unavailable" : "Calculating similarity"}
          >
            <h2>
              {similarityStatus !== "failed" && <span className="similarity-skeleton" aria-hidden="true" />}
              {similarityStatus === "stale" ? "Updating similarity…" : similarityStatus === "failed" ? "Similarity unavailable" : "Calculating similarity…"}
            </h2>
            <p>
              {similarityStatus === "stale"
                ? "TurnitPlus's reference sources changed since this result was last computed. Refreshing now — this can take a few seconds."
                : similarityStatus === "failed"
                  ? "TurnitPlus could not complete a similarity check for this submission."
                  : "TurnitPlus is still checking this submission against every reference source. This can take a few seconds."}
            </p>
          </section>
        ) : (
          <section
            className={`similarity-heading ${similarityVerdict ? `similarity-verdict-${similarityVerdict.key}` : ""}`}
            aria-label={`${primaryScore}% ${primaryLabel}${similarityVerdict ? `, ${PRIMARY_SIMILARITY_BAND_LABELS[similarityVerdict.key]}` : ""}`}
          >
            <h2>
              <span>{primaryScore}%</span> {primaryLabel}
              {similarityVerdict && <em>{PRIMARY_SIMILARITY_BAND_LABELS[similarityVerdict.key]}</em>}
            </h2>
            <aside className="archive-scope-note">
              {isUnified
                ? (canSeeSourceBreakdown
                  ? <>TurnitPlus Similarity combines text found through TurnitPlus&apos;s own checks, verified external academic sources, and eligible previous TurnitPlus submissions into one result — the same submitted passage found by more than one source counts once.</>
                  : <>TurnitPlus Similarity combines text found across every reference source TurnitPlus checks into one result — the same submitted passage found by more than one source counts once.</>)
                // SIM-01/SIM-04 (regression guard: tests/similarity-result-
                // consistency.test.mjs): the archive-only fallback must
                // never say "TurnitPlus Similarity" anywhere on the page —
                // that label is reserved for a genuinely computed unified
                // result. Ordinary-user simplification: no longer names
                // "verified academic sources" specifically.
                : <>Similarity result: {primaryScore}% — based on matched passages identified across the sources checked for this submission.</>}
            </aside>
            <p>
              TurnitPlus found {primaryMatchedWordCount(report).toLocaleString()} matched words across identified sources.
              Review the highlighted passages and named sources to see exactly what produced the result.
              {/* Task A correction: only mentioned when the viewer is
                  actually authorized to see the Wikipedia highlight/legend
                  entries this sentence refers to — an ordinary viewer never
                  gets Wikipedia body highlighting (see HighlightedDocument's
                  own findHighlightRanges(report, { includeWikipedia }) call),
                  so claiming it is "shown separately" would be false for
                  them. */}
              {canSeeSourceBreakdown && wikipediaMatches > 0 && <> {wikipediaMatches} exact Wikipedia phrase match{wikipediaMatches === 1 ? "" : "es"} are shown separately and do not change the similarity result.</>}
              {report.excludedDocuments > 0 && (
                <> {report.excludedDocuments} content-identical source was excluded and recorded as a probable self-match.</>
              )}
            </p>
          </section>
        )}

        {/* Release-hardening audit finding SIM-02, SIM-04: every block in
            this run, up to the academic-evidence section, is derived from
            report.unifiedSimilarity/historicalSubmissionMatch/
            matchClassification — fields that are genuinely absent, or no
            longer trustworthy, whenever similarityStatus is not "resolved"
            (they only arrive/refresh via the same read-time enrichment
            fetch that eventually clears it). Gating the whole run, not
            just the headline above, is defensive: it holds even if a
            future change ever let `report` carry that data while the
            caller still says "stale"/"pending" (this component has no way
            to know why a caller says that — it must simply not draw any
            matching-derived conclusion while told not to).
            AcademicEvidenceSection below is NOT gated —
            externalAcademicEvidence is populated before a report is ever
            first saved (Phase 3), so it is already correct on
            initialReport, unlike the fields above. */}
        {!notResolved && (<>
        {/* Phase 6: the combined unified-similarity result — placed directly
            after Archive overlap (unchanged above) and before every
            individual supporting-evidence block below, so a reader sees the
            one combined number first, then the archive/live/prior-submission
            breakdown that produced it. Renders nothing when unavailable —
            see UnifiedSimilaritySection's own comment. */}
        <UnifiedSimilaritySection report={report} />

        {/* Release-hardening audit finding UI-01 (corrected): the first
            version of this fix restored matchClassification for every
            viewer of their own report — too broad. report.matchClassification
            is now ONLY ever present on the payload this component receives
            at all when app/api/reports/[id]/route.ts's GET handler already
            decided, server-side, from the authenticated session's real
            `role === 'admin'` column (never ADMIN_EMAIL, a query param, or
            any client-controlled value), that the current viewer is an
            admin — see that route's own comment for the gate itself. For
            every other viewer (the report's own ordinary owner included,
            anonymous, or cross-account) the field is never attached to the
            JSON response at all, so there is nothing here to strip or hide:
            `report.matchClassification` is simply `undefined` for them, and
            this whole block is dead code on their payload — not a
            CSS-hidden secret sitting in the page's HTML/React payload.
            Labeled explicitly as internal debug information (never shown to
            an ordinary user, even the report's own owner) because it
            exposes cross-account existence (a real prior submission by
            someone else) that this product has never otherwise surfaced to
            end users — see ReportMatchClassification's own comment: the
            percentage itself still never identifies the OTHER account, only
            that one exists. Independent of historicalSubmissionMatch's own
            status, for the same reason as before correction: that signal is
            gated on corpus-reuse consent, this one is not (see
            lib/document-family.ts's captureDocumentIdentityAndFamily,
            unconditional at save time regardless of consent — capture
            itself is untouched by this admin-only gate, only whether an
            admin's own view of it is ever serialized to a response).
            Backend capture/classification stays fully available for a later
            corpus-enhanced-similarity phase to consume directly — this gate
            only concerns what a browser response ever contains, never what
            the server computes or stores. Never adds either percentage into
            overlapScore or any other similarity number above. */}
        {report.matchClassification && (report.matchClassification.selfMatchPercent !== null || report.matchClassification.priorSubmissionPercent !== null) && (
          <section className="submission-history-block admin-debug-block">
            <h3>Submission history <span className="admin-debug-label">— internal debug information, admin only</span></h3>
            <p className="admin-debug-note">Internal diagnostic information. Ordinary users never receive this classification data; it is visible only to authenticated administrators.</p>
            {report.matchClassification.selfMatchPercent !== null && (
              <p>
                <strong>{report.matchClassification.selfMatchPercent}%</strong> of this submission matches the account&apos;s own previous TurnitPlus submission. This self-match is not included in the similarity result above.
              </p>
            )}
            {report.matchClassification.priorSubmissionPercent !== null && (
              <p>
                <strong>{report.matchClassification.priorSubmissionPercent}%</strong> of this submission closely matches a previous TurnitPlus submission from a different account. This is not proof of plagiarism and is not included in the similarity result above.
              </p>
            )}
          </section>
        )}

        {/* Phase E8G: consolidated historical-submission presentation for
            historicalSubmissionMatch specifically (unchanged by the restored
            block above, which is its own independent section) — before this
            phase, Phase D's matchClassification and E8C/E8D's
            historicalSubmissionMatch each rendered their own visible
            section; this phase kept historicalSubmissionMatch's richer
            (passage-evidence, versioned-snapshot) presentation as the
            primary one. Deliberately never combined with the similarity
            result's own number — see lib/report-historical-match.ts's own
            comment. */}
        {report.historicalSubmissionMatch?.status === "UNAVAILABLE" && (
          <section className="historical-match-block">
            <h3>Previously submitted content</h3>
            <p>Historical matching unavailable for this report.</p>
          </section>
        )}
        {report.historicalSubmissionMatch?.status === "MATCHED" && (
          <section className="historical-match-block">
            <h3>Previously submitted content</h3>
            <p className="historical-match-archive-note">This historical submission match is not included in the similarity result.</p>
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

        </>)}

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
          {/* Ordinary-user simplification: the per-source-type percentage
              breakdown is a matching-mechanism detail ("Indexed publications",
              "TurnitPlus reference sources") — admin-only diagnostics, gated
              on the same historicalSubmissionMatch signal used everywhere
              else in this file. */}
          {canSeeSourceBreakdown && (
            <section>
              <h3>Top Sources</h3>
              <CategorySummary report={report} />
            </section>
          )}
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

/** Distinct from archive (#d7263d) and Wikipedia (#0784b4) — a real, named external academic source (OpenAIRE/Europe PMC), individually attributable. Used only in the admin-only detailed legend/Source Details view — see HighlightLegend's canSeeSourceBreakdown branch. */
const ACADEMIC_HIGHLIGHT_COLOR = "#7b3fe4";
/** The one shared color for the generic "TurnitPlus reference sources" bucket, admin-only detailed view. Deliberately a single color regardless of how many distinct corpus documents contributed — never per-item, unlike the archive/academic kinds above. */
const REFERENCE_SOURCE_HIGHLIGHT_COLOR = "#0f9d58";
/**
 * Ordinary-user simplification (Task A, final report simplification): the
 * single red/magenta highlight treatment for every matched position that
 * feeds the authoritative unified score (archive/academic/reference-source
 * alike) — reused from the archive color so the document body's dominant
 * highlight color does not change. Wikipedia (separate evidence, never part
 * of the score) is the only kind that stays visually distinct. This is a
 * render-layer-only unification: findHighlightRanges's own per-kind color/
 * label/kind fields are untouched (still used for internal precedence and by
 * the admin-only detailed legend/Source Details views).
 */
const MATCHED_PASSAGE_COLOR = "#d7263d";

/**
 * Highlighting fix (Task A, final correctness bug): the report body
 * previously highlighted ONLY report.sources (the archive) and
 * report.webCheck (Wikipedia) — real evidence channels that already fed
 * unifiedScore/uniqueMatchedWords (live academic evidence, and especially
 * the previous-upload/TurnitPlus-corpus channel) were never visually
 * accounted for at all, even when they were the entire unified result (a
 * genuine Preview case: 100% / 9,925 matched words, all from a promoted
 * corpus source, zero archive overlap — the body highlighted nothing).
 *
 * Two additions below, each reusing an ALREADY-established mechanism
 * rather than inventing a new one:
 *  - Live academic evidence (OpenAIRE/Europe PMC): real, named,
 *    individually attributable sources — the exact same phrase-regex
 *    search already used for report.sources/webCheck, just reading
 *    matchedPassages[].submittedText instead of source.phrases/a wiki
 *    phrase. "Existing real indexed-publication sources should remain
 *    separately identifiable" — this keeps that property for academic
 *    evidence too, which report.sources never covered.
 *  - Previous-upload/TurnitPlus-corpus channel: privacy requires this
 *    NEVER be individually attributable (no representation id, no
 *    relationship type, no account identity — see this file's own header
 *    comment and lib/unified-similarity.ts's own previousUploadPositions
 *    comment), so it cannot reuse phrase-regex search against per-entry
 *    text the way the other three kinds do. It is also the one channel
 *    whose passages can legitimately be EMPTY even at a real, full-
 *    document 100% match (lib/unified-similarity.ts's own
 *    previousUploadPassageRanges comment — the exact-canonical-match
 *    short-circuit). referenceSourceMatchedPositions(report) — the
 *    canonical, already-deduplicated, already-privacy-safe WORD-INDEX set
 *    — is read directly and converted to character ranges via
 *    tokenSpans()/mergeAdjacentPositions(), never phrase search, so it
 *    highlights correctly in both the common partial-match case and the
 *    exact-full-document case alike.
 */
/**
 * Task A correction: `includeWikipedia` (default true, so every existing
 * caller/test keeps its current behavior) lets a caller exclude Wikipedia
 * candidates from the precedence/acceptance pass entirely — not merely
 * filter them out of the returned list afterward. Wikipedia is auxiliary
 * evidence that never contributes to unifiedScore/matchedPositions, but it
 * previously took FIRST precedence below, so a real scoring position
 * (archive/academic/reference-source) that happened to overlap a Wikipedia
 * phrase match would lose that position to Wikipedia and render with no
 * highlight at all — a real violation of "highlighted positions === positions
 * contributing to the result" for a viewer who should never see Wikipedia
 * highlighting. Excluding Wikipedia from the candidate pool before
 * precedence runs, rather than post-filtering `accepted`, lets the
 * underlying scoring position claim its rightful highlight instead.
 */
export function findHighlightRanges(report: SimilarityReport, options: { includeWikipedia?: boolean } = {}) {
  const includeWikipedia = options.includeWikipedia ?? true;
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

  if (includeWikipedia) {
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
  }

  (report.externalAcademicEvidence ?? []).forEach((evidence, evidenceIndex) => {
    (evidence.matchedPassages ?? []).forEach((passage) => {
      const pattern = phrasePattern(passage.submittedText);
      if (!pattern) return;
      const expression = new RegExp(pattern, "gi");
      let found = expression.exec(report.text);
      while (found) {
        candidates.push({
          start: found.index,
          end: found.index + found[0].length,
          // Never collides with an archive sourceIndex (>=0) or Wikipedia's
          // fixed -1 — only used here to give each academic evidence item
          // a stable identity for its own highlight color/label.
          sourceIndex: -2 - evidenceIndex,
          color: ACADEMIC_HIGHLIGHT_COLOR,
          label: evidence.title ?? `External academic source (${evidence.provider})`,
          kind: "academic",
        });
        if (expression.lastIndex === found.index) expression.lastIndex += 1;
        found = expression.exec(report.text);
      }
    });
  });

  const referenceSourcePositions = referenceSourceMatchedPositions(report);
  if (referenceSourcePositions.length > 0) {
    const spans = tokenSpans(report.text);
    mergeAdjacentPositions(referenceSourcePositions).forEach(([wordStart, wordEnd]) => {
      if (wordStart < 0 || wordEnd >= spans.length) return;
      candidates.push({
        start: spans[wordStart].start,
        end: spans[wordEnd].end,
        sourceIndex: -100,
        color: REFERENCE_SOURCE_HIGHLIGHT_COLOR,
        label: "TurnitPlus reference sources",
        kind: "reference-source",
      });
    });
  }

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
  const academicCandidates = candidates
    .filter((candidate) => candidate.kind === "academic")
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const referenceSourceCandidates = candidates
    .filter((candidate) => candidate.kind === "reference-source")
    .sort((left, right) => left.start - right.start || right.end - left.end);

  // Precedence order: Wikipedia and archive (unchanged from before this
  // fix) win first, then real named academic sources, and the generic
  // "TurnitPlus reference sources" bucket last — it only ever fills
  // positions no more specific, individually-identifiable highlight
  // already claimed. This is what "if the same word position is matched by
  // multiple source types, highlight/count it once" means at the render
  // layer: one visible highlight per position, attributed to whichever
  // eligible source is most specific.
  [...wikipediaCandidates, ...mergedSources, ...academicCandidates, ...referenceSourceCandidates]
    .forEach((candidate) => {
      const overlaps = accepted.some(
        (range) => candidate.start < range.end && candidate.end > range.start,
      );
      if (!overlaps) accepted.push(candidate);
    });

  return accepted.sort((left, right) => left.start - right.start);
}

function HighlightedDocument({ report }: { report: SimilarityReport }) {
  // Task A correction: Wikipedia is auxiliary evidence that never
  // contributes to unifiedScore/matchedPositions — the ordinary-user body
  // highlight layer must represent only the canonical positions that
  // contribute to the authoritative similarity result, so Wikipedia is
  // excluded from the candidate pool entirely (not merely hidden after the
  // fact) unless the viewer is explicitly authorized for admin/debug
  // presentation. See findHighlightRanges's own header comment.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const ranges = findHighlightRanges(report, { includeWikipedia: canSeeSourceBreakdown });
  if (ranges.length === 0) {
    return <div className="submission-rendered-text">{report.text}</div>;
  }

  const pieces: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      pieces.push(report.text.slice(cursor, range.start));
    }
    const isWikipedia = range.kind === "wikipedia";
    // Ordinary-user simplification: every kind that feeds the authoritative
    // unified score (source/academic/reference-source) renders with ONE
    // consistent red/magenta treatment — no color/badge difference based on
    // how or where TurnitPlus found the match. A real public name (archive/
    // academic) stays available on hover, since that remains genuinely
    // useful for reviewing a match; the internal reference-source bucket
    // never gets a name at all. Only Wikipedia (separate evidence, never
    // part of the score) keeps its own distinct color/badge.
    const displayColor = isWikipedia ? range.color : MATCHED_PASSAGE_COLOR;
    const title = isWikipedia
      ? `Found on Wikipedia: ${range.label}`
      : range.kind === "source" || range.kind === "academic"
        ? `Matched passage: ${range.label}`
        : "Matched passage";
    pieces.push(
      <mark
        className={`submission-match ${isWikipedia ? "submission-wikipedia-match" : ""}`}
        key={`${range.start}-${range.end}-${index}`}
        style={{
          backgroundColor: `${displayColor}30`,
          borderBottomColor: displayColor,
          boxShadow: `inset 3px 0 0 ${displayColor}`,
        }}
        title={title}
      >
        {report.text.slice(range.start, range.end)}
        <span style={{ backgroundColor: displayColor }}>
          {isWikipedia ? "W" : ""}
        </span>
        {isWikipedia && range.wikipediaSources?.map((source) => (
          <a className="wikipedia-source-link" key={source.pageId} href={source.url} target="_blank" rel="noreferrer">
            <Globe2 aria-hidden="true" />
            <b>{source.title}</b>
            <small>Found on Wikipedia; shown as separate evidence and not included in the similarity result.</small>
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
  // Ordinary-user simplification: an ordinary viewer's legend collapses
  // every matching-channel distinction into one "Matched passages" item,
  // matching HighlightedDocument's own unified render above. Admins keep
  // the existing detailed, per-source/per-academic-item/reference-source
  // breakdown — same signal used everywhere else in this file.
  // Task A correction: an explicit, server-decided authorization signal
  // (see SimilarityReport.viewerIsAdmin's own comment), never inferred from
  // whether report.historicalSubmissionMatch happens to be present — that
  // field's presence conflates "this report has a match to show" with "this
  // viewer is authorized," and would read a real admin's own no-match
  // report as ordinary.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const wikipediaSources = [...new Map(
    (report.webCheck?.matches ?? [])
      .filter((match) => match.matched)
      .flatMap((match) => match.sources)
      .map((source) => [source.pageId, source]),
  ).values()];
  // Task A correction: Wikipedia never contributes to the score, so an
  // ordinary viewer's legend never mentions it either — matching
  // HighlightedDocument's own findHighlightRanges(report, { includeWikipedia:
  // canSeeSourceBreakdown }) call, so the legend is never left describing a
  // blue "W" treatment that does not actually appear anywhere in the body.
  const visibleWikipediaSources = canSeeSourceBreakdown ? wikipediaSources : [];
  const academicEvidence = report.externalAcademicEvidence
    ? dedupeExternalAcademicEvidence(report.externalAcademicEvidence).filter((item) => (item.matchedPassages ?? []).length > 0)
    : [];
  const hasReferenceSources = referenceSourceMatchedPositions(report).length > 0;
  const hasMatchedPassages = report.sources.length > 0 || academicEvidence.length > 0 || hasReferenceSources;
  return (
    <div className="highlight-legend">
      <div>
        <strong>{visibleWikipediaSources.length > 0 ? "Matched passages" : "Red matched passages"}</strong>
        <span>{visibleWikipediaSources.length > 0 ? "Red marks matched passages; blue W marks separate Wikipedia evidence that does not change the similarity result" : "Red marks the text contributing to the similarity result"}</span>
      </div>
      <div className="highlight-legend-items">
        {canSeeSourceBreakdown ? (
          <>
            {report.sources.map((source, index) => (
              <span className="highlight-legend-item" key={source.name} title={source.name}>
                <i style={{ backgroundColor: source.color }}>{index + 1}</i>
                {source.name}
              </span>
            ))}
            {academicEvidence.map((item, index) => (
              <span className="highlight-legend-item" key={item.doi ?? item.url ?? `academic-${index}`} title={item.title ?? "External academic source"}>
                <i style={{ backgroundColor: ACADEMIC_HIGHLIGHT_COLOR }}>A</i>
                {item.title ?? "External academic source"}
              </span>
            ))}
            {hasReferenceSources && (
              <span className="highlight-legend-item" key="reference-source-legend" title="TurnitPlus reference sources">
                <i style={{ backgroundColor: REFERENCE_SOURCE_HIGHLIGHT_COLOR }}>T</i>
                TurnitPlus reference sources
              </span>
            )}
          </>
        ) : (
          hasMatchedPassages && (
            <span className="highlight-legend-item" key="matched-passages-legend" title="Matched passages">
              <i style={{ backgroundColor: MATCHED_PASSAGE_COLOR }} />
              Matched passages
            </span>
          )
        )}
        {visibleWikipediaSources.map((source) => (
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
