"use client";

import { useEffect, useState } from "react";
import {
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_REVIEW_PASSAGE_PERCENTILE,
  shouldSuppressAiScore,
} from "@/lib/ai-core";
import {
  aiFirstRunExplainer,
  aiPrepDetailLabel,
  aiPrepStageLabel,
  type AiPrepStage,
  type AiPrepUpdate,
} from "@/lib/ai-model-prep";
import { aiSignalDisplay, type AiSignalDisplay, type SimilarityReport } from "@/lib/report-types";
import { ReportPageFooter, ReportPageHeader } from "./report-page-chrome";

function AnimatedAiPercentage({
  value,
  animated = true,
}: {
  value: number | null;
  animated?: boolean;
}) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (value === null) return;
    if (!animated) {
      setDisplayValue(value);
      return;
    }
    let frame = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      frame = window.requestAnimationFrame(() => setDisplayValue(value));
      return () => window.cancelAnimationFrame(frame);
    }
    const startedAt = performance.now();
    const duration = 850;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(value * eased));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [animated, value]);

  return <>{value === null ? "—" : `${animated ? displayValue : value}%`}</>;
}

const AI_PREP_STAGE_ORDER: AiPrepStage[] = [
  "preparing",
  "downloading",
  "preparing-detector",
  "analyzing",
  "generating-report",
  "complete",
];

function AiPreparationPanel({
  prepState,
  onCancel,
}: {
  prepState: AiPrepUpdate | null;
  onCancel?: () => void;
}) {
  const stage = prepState?.stage ?? "preparing";
  const cached = prepState?.cached ?? false;
  const progress = prepState?.progress ?? null;
  const detail = prepState?.label ?? aiPrepDetailLabel({ stage, cached, progress });
  const showFirstRunExplainer = !cached && (stage === "preparing" || stage === "downloading");
  const showDownloadBar = !cached && stage === "downloading";
  const percent = progress && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.loaded / progress.total) * 100)))
    : null;
  const stageIndex = AI_PREP_STAGE_ORDER.indexOf(stage);
  const canCancel = Boolean(onCancel) && (stage === "preparing" || stage === "downloading");

  return (
    <section className="ai-prep-panel" aria-live="polite">
      <div className="ai-analysis-loading">
        <span aria-hidden="true" />
        <div>
          <strong>{aiPrepStageLabel(stage)}</strong>
          <p>{detail}</p>
        </div>
      </div>

      {showDownloadBar && (
        percent !== null ? (
          <div className="progress-track ai-prep-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Model download progress">
            <span style={{ width: `${percent}%` }} />
          </div>
        ) : (
          <div className="progress-track ai-prep-progress indeterminate" role="progressbar" aria-label="Downloading the AI model, progress unknown">
            <span />
          </div>
        )
      )}

      {showFirstRunExplainer && (
        <ul className="ai-prep-explainer">
          {aiFirstRunExplainer().map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}

      <ol className="ai-prep-stage-list" aria-hidden="true">
        {AI_PREP_STAGE_ORDER.map((step, index) => (
          <li key={step} className={index < stageIndex ? "done" : index === stageIndex ? "active" : ""}>
            {aiPrepStageLabel(step)}
          </li>
        ))}
      </ol>

      {canCancel && (
        <button type="button" className="button secondary ai-prep-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </section>
  );
}

export function AiReport({
  report,
  signal: signalProp,
  isRunning = false,
  prepState = null,
  onRetry,
  onCancel,
  printMode = false,
}: {
  report: SimilarityReport;
  /**
   * The already-resolved AI signal from the caller (the report detail
   * shell), computed via aiSignalDisplay(report, { persisted ai_status/
   * ai_score/ai_tone }) — the authoritative headline, which can differ from
   * aiSignalDisplay(report) alone when payload_json.aiAnalysis has lagged
   * the flat columns (see lib/ai-display-state.ts). Omitted by callers that
   * genuinely only have the payload (e.g. the in-run preview), which fall
   * back to the payload-only computation, unchanged.
   */
  signal?: AiSignalDisplay;
  isRunning?: boolean;
  prepState?: AiPrepUpdate | null;
  onRetry?: () => void;
  onCancel?: () => void;
  printMode?: boolean;
}) {
  const rawScore = typeof report.aiScore === "number" ? report.aiScore : null;
  const isSuppressed = rawScore !== null && shouldSuppressAiScore(rawScore);
  const analysis = report.aiAnalysis;
  const signal = signalProp ?? aiSignalDisplay(report);
  // The AI check is authoritatively finished (a real headline score exists —
  // from the persisted columns even if this payload's aiAnalysis was lost to
  // a stale-generation overwrite), just without the passage-level detail.
  const completeWithoutDetail = signal.value !== null && !analysis;

  return (
    <article className={`report-paper ai-paper ${printMode ? "ai-report-print" : "ai-report-enter"} ai-signal-${signal.tone}`}>
      <ReportPageHeader report={report} page={1} label="AI Writing Report" />
      <div className="paper-content">
        <section className="ai-report-heading">
          <p className="paper-kicker">ENGLISH AI WRITING ANALYSIS</p>
          {!isRunning && <h2>
            <span><AnimatedAiPercentage value={signal.value} animated={!printMode} /></span>
            {signal.value === null ? signal.label : "AI writing score"}
          </h2>}
          <p>
            {signal.value !== null
              ? signal.detail
              : analysis?.status === "unsupported"
                ? signal.detail
                : "The AI analysis is ready to calculate this document's writing score."}
          </p>
        </section>
        {!isRunning && !isSuppressed && analysis && analysis.status !== "error" && (
          <section className={`ai-verdict-card ai-signal-card ai-signal-card-${signal.tone}`} aria-label={signal.label}>
            <div className="ai-verdict-score">
              <span>AI writing score</span>
              <strong><AnimatedAiPercentage value={signal.value} animated={!printMode} /></strong>
            </div>
            <div className="ai-verdict-copy">
              <span>Result band</span>
              <strong>{signal.label}</strong>
              <p>{signal.detail}</p>
            </div>
            <span className="ai-verdict-range">{signal.range}</span>
            {signal.value !== null && <div className="ai-signal-meter" aria-hidden="true"><span style={{ width: `${signal.value}%` }} /></div>}
          </section>
        )}
        {!isSuppressed && signal.value !== null && <section className="ai-report-metrics">
          <div><strong>{signal.value}%</strong><span>AI writing score</span></div>
          <div><strong>{analysis?.analyzedWordCount.toLocaleString() ?? "—"}</strong><span>words analyzed</span></div>
          <div><strong>{analysis?.analyzedTokenCount?.toLocaleString() ?? "—"}</strong><span>tokens analyzed</span></div>
          <div><strong>{analysis?.passages.length.toLocaleString() ?? "—"}</strong><span>passage windows</span></div>
        </section>}

        {isRunning && <AiPreparationPanel prepState={prepState} onCancel={onCancel} />}

        {!isRunning && analysis?.status === "complete" && isSuppressed && (
          <section className="ai-analysis-message">
            <strong>—</strong>
            <p>The document was analyzed, but it did not produce a complete AI writing score. Try the analysis again.</p>
          </section>
        )}

        {!isRunning && analysis?.status === "complete" && !isSuppressed && (
          <section className="ai-passage-review">
            <div className="ai-passage-heading">
              <div>
                <p className="paper-kicker">PASSAGE REVIEW</p>
                <h3>Highlighted passage analysis</h3>
              </div>
              <span>
                {analysis.flaggedPassageCount ?? analysis.passages.filter((passage) => passage.flagged).length}
                /{analysis.passages.length} passages · {AI_REVIEW_PASSAGE_PERCENTILE}th-percentile cutoff {(analysis.thresholdLogOdds ?? AI_PASSAGE_LOG_ODDS_THRESHOLD).toFixed(3)}
              </span>
            </div>
            {analysis.passages.length > 0 ? (
              <div className="ai-passage-list">
                {analysis.passages.map((passage, index) => {
                  const isAi = passage.flagged ?? (
                    passage.logOdds != null
                      ? passage.logOdds >= (analysis.thresholdLogOdds ?? AI_PASSAGE_LOG_ODDS_THRESHOLD)
                      : passage.probability >= analysis.threshold
                  );
                  return <article className={isAi ? "ai-detected" : "human-detected"} key={`${passage.start}-${passage.end}`}>
                    <div>
                      <span>{index + 1}</span>
                      {passage.logOdds != null && <strong>Signal {passage.logOdds.toFixed(3)}</strong>}
                      <small>{passage.tokenCount ?? "—"} tokens · {passage.wasTruncated ? "truncated" : "complete window"}</small>
                      <em>{isAi ? "Above review threshold" : "Below review threshold"}</em>
                    </div>
                    <p>{passage.text}</p>
                  </article>;
                })}
              </div>
            ) : (
              <div className="ai-empty-passages">
                <strong>0</strong>
                <span>passages exceeded the human {AI_REVIEW_PASSAGE_PERCENTILE}th-percentile review threshold</span>
              </div>
            )}
          </section>
        )}

        {!isRunning && completeWithoutDetail && (
          <section className="ai-analysis-message">
            <strong>—</strong>
            <div>
              <p>The AI writing score above is this report&apos;s completed result. The passage-level breakdown isn&apos;t available for this saved copy{onRetry ? " — re-run the analysis to regenerate it" : ""}.</p>
              {onRetry && <button className="button primary" type="button" onClick={onRetry}>Re-run AI analysis</button>}
            </div>
          </section>
        )}

        {!isRunning && !completeWithoutDetail && (!analysis || analysis.status === "error") && (
          <section className="ai-analysis-message">
            <strong>—</strong>
            <div>
              <p>{analysis?.error ?? "This saved report has not completed local AI analysis yet."}</p>
              {onRetry && <button className="button primary" type="button" onClick={onRetry}>Run AI analysis</button>}
            </div>
          </section>
        )}
      </div>
      <ReportPageFooter report={report} page={1} label="AI Writing Report" />
    </article>
  );
}
