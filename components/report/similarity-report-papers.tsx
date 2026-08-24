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
  PRIMARY_SIMILARITY_BAND_LABELS,
  archiveOverlapScore,
  hasUnifiedSimilarity,
  primaryMatchedWordCount,
  primaryResultLabel,
  primarySimilarityScore,
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
            <AcademicEvidenceCard item={item} key={item.doi ?? item.url ?? `${item.provider}-${item.providerId}-${index}`} />
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
          External academic verification was unavailable for this report — OpenAIRE and Europe PMC could not be
          reached, or every request failed. This is not the same as "no matches found"; it means the check itself
          did not complete.
        </p>
      </section>
    );
  }

  if (report.academicEvidenceStatus === "COMPLETE_NO_MATCHES") {
    return (
      <section className="academic-evidence-block">
        <h3>External Academic Sources</h3>
        <p className="academic-evidence-intro">
          Checked OpenAIRE and Europe PMC — no matching external academic sources were found.
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
  const breakdown = unifiedEvidenceBreakdown(report);
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
  // sees this class of detail, not two.
  const canSeeSourceBreakdown = Boolean(report.historicalSubmissionMatch);

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
          External academic verification (OpenAIRE, Europe PMC) was unavailable when this report was generated, so
          this result reflects TurnitPlus&apos;s own reference matches{report.historicalSubmissionMatch ? " and previous submissions" : ""} only. See External Academic Sources below for details.
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
  const canSeeSourceBreakdown = Boolean(report.historicalSubmissionMatch);
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
                  : "TurnitPlus is still checking this submission against every reference source, including previously submitted content. This can take a few seconds."}
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
                : <>Similarity result: {primaryScore}% — based on identified overlapping passages and verified academic sources.</>}
            </aside>
            <p>
              TurnitPlus found {primaryMatchedWordCount(report).toLocaleString()} matched words across identified sources.
              Review the highlighted passages and named sources to see exactly what produced the result.
              {wikipediaMatches > 0 && <> {wikipediaMatches} exact Wikipedia phrase match{wikipediaMatches === 1 ? "" : "es"} are shown separately and do not change the similarity result.</>}
              {report.excludedDocuments > 0 && (
                <> {report.excludedDocuments} content-identical source was excluded and recorded as a probable self-match.</>
              )}
            </p>
          </section>
        )}

        {/* Release-hardening audit finding SIM-02, SIM-04: every block in
            this run, through the standalone ReuseContextContainer just
            before the academic-evidence section, is derived from
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
            {report.reuseContext && (
              <ReuseContextContainer documentIdentityId={report.reuseContext.documentIdentityId} representationId={null} />
            )}
          </section>
        )}
        {report.historicalSubmissionMatch?.status === "MATCHED" && (
          <section className="historical-match-block">
            <h3>Previously submitted content</h3>
            <p className="historical-match-archive-note">This historical submission match is not included in the similarity result.</p>
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
        <span>{wikipediaSources.length > 0 ? "Red marks matched source text; blue W marks separate Wikipedia evidence that does not change the similarity result" : "Each number connects the matched phrase to a matched source"}</span>
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
