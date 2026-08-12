"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Download,
  FileCheck2,
  FileText,
  FolderClock,
  Globe2,
  GraduationCap,
  LayoutDashboard,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Printer,
  Quote,
  Search,
  Save,
  ShieldCheck,
  UploadCloud,
  UserRound,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createReceiptPdf } from "@/lib/receipt-pdf";
import { getDeviceKey } from "@/lib/device-key";
import { extractPdfTextDocument } from "@/lib/pdf-text-extraction";
import { clearStoredReports, loadStoredReports, storeReport } from "@/lib/report-store";
import { deleteRemoteReport, fetchRemoteReport, listRemoteReportSummaries, saveReportRemote, type ReportSummary } from "@/lib/reports-remote";
import { combineMatchedWordPositions } from "@/lib/similarity-enrichment";
import type { WebCheckResult } from "@/lib/web-check-core";
import {
  AI_MODEL_VERSION,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_PASSAGE_THRESHOLD,
  AI_REVIEW_PASSAGE_PERCENTILE,
  AI_SCORING_VERSION,
  calibratedAiDisplaySignal,
  similarityScoreBand,
  shouldSuppressAiScore,
} from "@/lib/ai-core";

type View = "home" | "dashboard" | "reports" | "about" | "account" | "welcome" | "legal" | "processing" | "result";
type ResultTab = "full" | "overview" | "submission" | "sources";
type ReportMode = "ai" | "similarity";
type AuthMode = "login" | "signup";
type LegalTab = "privacy" | "terms";
type LocalAccount = { username: string; email: string };
type SourceType = "Internet" | "Publication";

const SIMILARITY_BAND_LABELS = {
  low: "Low archive overlap",
  review: "Moderate archive overlap",
  high: "High archive overlap",
} as const;

const ARCHIVE_DOCUMENT_FALLBACK = 230;

const VIEW_HASH: Record<Exclude<View, "processing" | "result">, string> = {
  home: "#home",
  dashboard: "#dashboard",
  reports: "#reports",
  about: "#how-it-works",
  account: "#account",
  welcome: "#welcome",
  legal: "#privacy-terms",
};

function viewFromHash(hash: string, hasOpenReport: boolean): View {
  if (hash === "#home") return "home";
  if (hash === "#reports") return "reports";
  if (hash === "#how-it-works") return "about";
  if (hash === "#account") return "account";
  if (hash === "#welcome") return "welcome";
  if (hash === "#privacy-terms") return "legal";
  if (hash === "#report") return hasOpenReport ? "result" : "reports";
  return "home";
}

type SourceMatch = {
  name: string;
  type: SourceType;
  percent: number;
  matches: number;
  matchedWords?: number;
  phrases: string[];
  color: string;
};

type AiPassage = {
  start: number;
  end: number;
  wordStart: number;
  wordEnd: number;
  text: string;
  wordCount: number;
  probability: number;
  logOdds?: number;
  flagged?: boolean;
  tokenStart?: number;
  tokenEnd?: number;
  tokenCount?: number;
  wasTruncated?: boolean;
};

type AiAnalysis = {
  status: "complete" | "unsupported" | "error";
  score: number | null;
  model: string;
  engine: "WebGPU" | "CPU" | null;
  threshold: number;
  thresholdLogOdds?: number;
  eligibleWordCount: number;
  analyzedWordCount: number;
  passages: AiPassage[];
  meanProbability?: number;
  maxProbability?: number;
  top3MeanLogOdds?: number | null;
  coveragePercent?: number;
  medianLogOdds?: number | null;
  flaggedWordCount?: number;
  flaggedPassageCount?: number;
  analyzedTokenCount?: number;
  flaggedTokenCount?: number;
  truncatedPassageCount?: number;
  populationPercentile?: number | null;
  scoringVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  error?: string;
};

type AiSignalTone = "low" | "review" | "high" | "unavailable";
type AiSignalDisplay = {
  value: number | null;
  tone: AiSignalTone;
  label: string;
  detail: string;
  range: string;
};

type SimilarityReport = {
  version: 11;
  id: number;
  submissionId: string;
  title: string;
  author: string;
  assignment: string;
  created: string;
  score: number;
  archiveScore?: number;
  aiScore?: number | null;
  aiAnalysis?: AiAnalysis;
  webCheck?: WebCheckResult;
  wordCount: number;
  characterCount: number;
  pageCount: number;
  fileSize: string;
  databaseSize: number;
  corpusVersion: string;
  scoreBand: "Low" | "Moderate" | "High";
  riskStatus: "Elevated" | "Lower";
  riskTarget: number;
  riskCutoff: number;
  riskCalibration: { auc: number; precision: number; recall: number; sampleSize: number };
  features: {
    maxSourceContainment: number;
    longestMatchedSpan: number;
    quotationDensity: number;
    referenceListRatio: number;
    highFrequencyShingleCount: number;
    repeatedThreeGramCount: number;
    detectedLanguage: "Arabic" | "French" | "English" | "Mixed";
  };
  excludedDocuments: number;
  matchedWordCount: number;
  archiveMatchedPositions?: number[];
  wikipediaMatchedWordCount?: number;
  sources: SourceMatch[];
  repeats: [string, number][];
  text: string;
};

function archiveDocumentCount(corpusVersion: string) {
  const match = corpusVersion.match(/^archive-v\d+-(\d+)-/);
  return match ? Number(match[1]) : null;
}

function archiveScopeCount(report: SimilarityReport) {
  return archiveDocumentCount(report.corpusVersion) ?? report.databaseSize ?? ARCHIVE_DOCUMENT_FALLBACK;
}

function archiveOverlapScore(report: SimilarityReport) {
  return report.archiveScore ?? report.score;
}

function archiveMatchedWordCount(report: SimilarityReport) {
  return report.archiveMatchedPositions?.length
    ?? Math.max(0, report.matchedWordCount - (report.wikipediaMatchedWordCount ?? 0));
}

function sourceMatchedWordCount(source: SourceMatch, report: SimilarityReport) {
  return source.matchedWords ?? Math.round((source.percent / 100) * report.wordCount);
}

type HighlightRange = {
  start: number;
  end: number;
  sourceIndex: number;
  color: string;
  label: string;
  kind: "source" | "wikipedia";
  url?: string;
  wikipediaSources?: Array<{ pageId: number; title: string; url: string }>;
};

function aiSignalDisplay(report: SimilarityReport): AiSignalDisplay {
  const analysis = report.aiAnalysis;
  if (analysis?.status === "unsupported") {
    return {
      value: null,
      tone: "unavailable",
      label: "Not enough text",
      detail: "Fewer than 300 eligible English words were available, so no AI percentage was calculated.",
      range: "No AI result",
    };
  }
  if (analysis?.status === "error") {
    return {
      value: null,
      tone: "unavailable",
      label: "Analysis unavailable",
      detail: analysis.error ?? "The local AI analysis did not finish.",
      range: "Try again",
    };
  }
  const normalizedSignal = analysis?.status === "complete"
    && analysis.scoringVersion === AI_SCORING_VERSION
    && typeof analysis.medianLogOdds === "number"
    ? calibratedAiDisplaySignal(analysis.medianLogOdds)
    : null;
  if (normalizedSignal === null) {
    return {
      value: null,
      tone: "unavailable",
      label: "AI report pending",
      detail: "Run the AI analysis to calculate the document's AI writing score.",
      range: "No result yet",
    };
  }
  const value = normalizedSignal.score;
  const scoreDetail = "The score is calculated from the language patterns found across the document's analyzed passages.";
  if (value < 20) {
    return {
      value,
      tone: "low",
      label: "Low AI indicators",
      detail: scoreDetail,
      range: "Green · 0–19%",
    };
  }
  if (value <= 50) {
    return {
      value,
      tone: "review",
      label: "Moderate AI indicators",
      detail: scoreDetail,
      range: "Blue · 20–50%",
    };
  }
  return {
    value,
    tone: "high",
    label: "Strong AI indicators",
    detail: scoreDetail,
    range: "Red · 51–100%",
  };
}

function buildReportSummary(report: SimilarityReport): ReportSummary {
  const aiSignal = aiSignalDisplay(report);
  return {
    id: String(report.id),
    submissionId: report.submissionId,
    title: report.title,
    createdAt: report.created,
    wordCount: report.wordCount,
    archiveScore: archiveOverlapScore(report),
    scoreBand: report.scoreBand,
    aiScore: aiSignal.value,
    aiTone: aiSignal.tone,
  };
}

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

let similarityWorker: Worker | null = null;
let workerRequestId = 0;
let aiDetectorWorker: Worker | null = null;
let aiWorkerRequestId = 0;
let webCheckWorker: Worker | null = null;
let webCheckRequestId = 0;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function analyzeText(
  text: string,
  fileName: string,
  fileSize: number,
  onProgress: (progress: number, label: string) => void,
): Promise<SimilarityReport> {
  similarityWorker ??= new Worker(
    new URL("./similarity-worker.ts", import.meta.url),
    { type: "module" },
  );
  const id = ++workerRequestId;
  const result = await new Promise<{
    score: number;
    wordCount: number;
    databaseSize: number;
    corpusVersion: string;
    scoreBand: "Low" | "Moderate" | "High";
    riskStatus: "Elevated" | "Lower";
    riskTarget: number;
    riskCutoff: number;
    riskCalibration: SimilarityReport["riskCalibration"];
    features: SimilarityReport["features"];
    excludedDocuments: number;
    matchedWordCount: number;
    archiveMatchedPositions: number[];
    sources: SourceMatch[];
    repeats: [string, number][];
  }>((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "progress") {
        onProgress(event.data.progress, event.data.label);
        return;
      }
      if (event.data.id !== id) return;
      similarityWorker?.removeEventListener("message", handleMessage);
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    similarityWorker?.addEventListener("message", handleMessage);
    similarityWorker?.postMessage({ id, text, fileName });
  });
  const now = new Date();

  return {
    version: 11,
    id: Date.now(),
    submissionId: String(Date.now()).slice(-10),
    title: fileName,
    author: "Guest submission",
    assignment: "Personal similarity check",
    created: now.toISOString(),
    score: result.score,
    archiveScore: result.score,
    wordCount: result.wordCount,
    characterCount: text.length,
    pageCount: Math.max(1, Math.ceil(result.wordCount / 450)),
    fileSize: fileSize ? formatBytes(fileSize) : `${new Blob([text]).size} B`,
    databaseSize: result.databaseSize,
    corpusVersion: result.corpusVersion,
    scoreBand: result.scoreBand,
    riskStatus: result.riskStatus,
    riskTarget: result.riskTarget,
    riskCutoff: result.riskCutoff,
    riskCalibration: result.riskCalibration,
    features: result.features,
    excludedDocuments: result.excludedDocuments,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    sources: result.sources,
    repeats: result.repeats,
    text,
  };
}

async function analyzeAiText(
  text: string,
  detectedLanguage: SimilarityReport["features"]["detectedLanguage"],
  onProgress: (label: string) => void,
): Promise<AiAnalysis> {
  aiDetectorWorker ??= new Worker(
    new URL("./ai-detector-worker.ts", import.meta.url),
    { type: "module" },
  );
  const id = ++aiWorkerRequestId;
  return new Promise<AiAnalysis>((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "progress") {
        if (event.data.id === undefined || event.data.id === id) onProgress(event.data.label);
        return;
      }
      if (event.data.id !== id) return;
      aiDetectorWorker?.removeEventListener("message", handleMessage);
      if (event.data.ok) resolve(event.data.result as AiAnalysis);
      else reject(new Error(event.data.error));
    };
    aiDetectorWorker?.addEventListener("message", handleMessage);
    aiDetectorWorker?.postMessage({ id, text, detectedLanguage });
  });
}

async function analyzeWikipediaText(
  text: string,
  title: string,
  onProgress: (current: number, total: number, label: string) => void,
): Promise<WebCheckResult> {
  webCheckWorker ??= new Worker(
    new URL("./web-check-worker.ts", import.meta.url),
    { type: "module" },
  );
  const id = ++webCheckRequestId;
  return new Promise<WebCheckResult>((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      if (event.data.type === "progress") {
        onProgress(event.data.current, event.data.total, event.data.label);
        return;
      }
      webCheckWorker?.removeEventListener("message", handleMessage);
      if (event.data.ok) resolve(event.data.result as WebCheckResult);
      else reject(new Error(event.data.error));
    };
    webCheckWorker?.addEventListener("message", handleMessage);
    webCheckWorker?.postMessage({ id, text, title, count: 20 });
  });
}

async function extractFileText(file: File, onProgress: (progress: number, label: string) => void) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["txt", "md", "html", "csv"].includes(extension ?? "")) {
    onProgress(18, "Reading document content");
    return file.text();
  }
  if (extension === "docx") {
    onProgress(18, "Reading document content");
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    return extractPdfTextDocument(document, (pageNumber, pageCount) => {
      onProgress(8 + Math.round((pageNumber / pageCount) * 20), `Reading page ${pageNumber} of ${pageCount}`);
    });
  }
  throw new Error("This file type is not supported.");
}

function sourceIcon(type: SourceType) {
  if (type === "Internet") return <Globe2 aria-hidden="true" />;
  if (type === "Publication") return <BookOpen aria-hidden="true" />;
  return <GraduationCap aria-hidden="true" />;
}

async function downloadReceipt(report: SimilarityReport) {
  const blob = await createReceiptPdf(report);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const baseName = report.title.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  anchor.href = url;
  anchor.download = `${baseName || "submission"}-receipt.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function phrasePattern(phrase: string) {
  const words = phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? `\\b${words.join("[\\s\\W]+")}\\b` : "";
}

function enrichReportWithWikipedia(report: SimilarityReport, webCheck: WebCheckResult): SimilarityReport {
  const archiveScore = report.archiveScore ?? report.score;
  const combined = report.archiveMatchedPositions
    ? combineMatchedWordPositions(
      report.archiveMatchedPositions,
      webCheck.matches.filter((match) => match.matched),
      report.wordCount,
    )
    : { matchedWordCount: report.matchedWordCount, externalMatchedWordCount: 0, score: archiveScore };
  return {
    ...report,
    archiveScore,
    score: combined.score,
    matchedWordCount: combined.matchedWordCount,
    wikipediaMatchedWordCount: combined.externalMatchedWordCount,
    webCheck,
  };
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

function HighlightLegend({ report }: { report: SimilarityReport }) {
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

function ReportPageHeader({
  report,
  page,
  label,
}: {
  report: SimilarityReport;
  page: number;
  label: string;
}) {
  return (
    <div className="paper-header">
      <div className="paper-brand">
        <span>T+</span>
        <strong>integrity</strong>
      </div>
      <span>Page {page} · {label}</span>
      <span className="paper-id">Submission ID&nbsp;&nbsp; {report.submissionId}</span>
    </div>
  );
}

function ReportPageFooter({
  report,
  page,
  label,
}: {
  report: SimilarityReport;
  page: number;
  label: string;
}) {
  return (
    <div className="paper-footer">
      <div className="paper-brand">
        <span>T+</span>
        <strong>integrity</strong>
      </div>
      <span>Page {page} · {label}</span>
      <span className="paper-id">Submission ID&nbsp;&nbsp; {report.submissionId}</span>
    </div>
  );
}

function CategorySummary({ report }: { report: SimilarityReport }) {
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

function MatchGroups({ report }: { report: SimilarityReport }) {
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

function SourceList({ report, detailed = false }: { report: SimilarityReport; detailed?: boolean }) {
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

function OverviewReport({ report }: { report: SimilarityReport }) {
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

function SubmissionReport({ report }: { report: SimilarityReport }) {
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

function SourcesReport({ report }: { report: SimilarityReport }) {
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

function AiReport({
  report,
  isRunning = false,
  progressLabel = "Loading the local AI model",
  onRetry,
  printMode = false,
}: {
  report: SimilarityReport;
  isRunning?: boolean;
  progressLabel?: string;
  onRetry?: () => void;
  printMode?: boolean;
}) {
  const rawScore = typeof report.aiScore === "number" ? report.aiScore : null;
  const isSuppressed = rawScore !== null && shouldSuppressAiScore(rawScore);
  const analysis = report.aiAnalysis;
  const signal = aiSignalDisplay(report);

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

        {isRunning && (
          <section className="ai-analysis-loading" aria-live="polite">
            <span />
            <div>
              <strong>Running AI analysis</strong>
              <p>{progressLabel}…</p>
            </div>
          </section>
        )}

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

        {!isRunning && (!analysis || analysis.status === "error") && (
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

export default function Home() {
  const [view, setView] = useState<View>("account");
  const [resultTab, setResultTab] = useState<ResultTab>("full");
  const [reportMode, setReportMode] = useState<ReportMode>("similarity");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [processingLabel, setProcessingLabel] = useState("Reading document content");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isRunningAiAnalysis, setIsRunningAiAnalysis] = useState(false);
  const [aiProgressLabel, setAiProgressLabel] = useState("Loading the local AI model");
  const [currentReport, setCurrentReport] = useState<SimilarityReport | null>(null);
  const [reports, setReports] = useState<SimilarityReport[]>([]);
  const [toast, setToast] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [welcomeMode, setWelcomeMode] = useState<AuthMode | null>(null);
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authProgress, setAuthProgress] = useState(0);
  const [authLoadingLabel, setAuthLoadingLabel] = useState("Preparing your sign-in");
  const [authError, setAuthError] = useState<string | null>(null);
  const [profileEditError, setProfileEditError] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<LegalTab>("privacy");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentReportRef = useRef<SimilarityReport | null>(null);
  const generationLockRef = useRef(false);

  useEffect(() => {
    loadStoredReports<SimilarityReport>(11)
      .then(async (localReports) => {
        setReports(localReports);
        // Only fall back to the remote durability copy when local storage is
        // genuinely empty (e.g. IndexedDB was cleared/evicted independently
        // of localStorage) — never overrides reports that are already here.
        if (localReports.length > 0) return;
        const summaries = await listRemoteReportSummaries();
        if (summaries.length === 0) return;
        const restored: SimilarityReport[] = [];
        for (const summary of summaries) {
          const full = await fetchRemoteReport<SimilarityReport>(summary.id);
          if (full) restored.push(full);
        }
        if (restored.length === 0) return;
        setReports(restored);
        for (const report of restored) {
          await storeReport(report);
        }
      })
      .catch(() => setReports([]));
    queueMicrotask(() => {
      setSidebarCollapsed(window.localStorage.getItem("tp_sidebar_collapsed") === "true");
    });
    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : Promise.resolve({ user: null })))
      .then((data) => {
        const result = data as { user: LocalAccount | null };
        if (result && result.user) setAccount(result.user);
      })
      .catch(() => {})
      .finally(() => setAccountLoaded(true));
  }, []);

  useEffect(() => {
    currentReportRef.current = currentReport;
  }, [currentReport]);

  useEffect(() => {
    if (!accountLoaded) return;
    const syncViewFromLocation = () => {
      const requestedView = viewFromHash(window.location.hash, Boolean(currentReportRef.current));
      if (generationLockRef.current && requestedView === "dashboard") {
        window.history.replaceState({ turnitPlusView: "reports" }, "", VIEW_HASH.reports);
        setView("reports");
      } else {
        setView(requestedView);
      }
      setMobileNavOpen(false);
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    syncViewFromLocation();
    window.addEventListener("popstate", syncViewFromLocation);
    window.addEventListener("hashchange", syncViewFromLocation);
    return () => {
      window.removeEventListener("popstate", syncViewFromLocation);
      window.removeEventListener("hashchange", syncViewFromLocation);
    };
  }, [account, accountLoaded]);

  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      window.localStorage.setItem("tp_sidebar_collapsed", String(next));
      return next;
    });
  }

  const reportDate = useMemo(
    () =>
      currentReport
        ? new Date(currentReport.created).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
        : "",
    [currentReport],
  );
  const currentSimilarityVerdict = useMemo(
    () => currentReport ? similarityScoreBand(archiveOverlapScore(currentReport)) : null,
    [currentReport],
  );
  const currentArchiveOverlap = useMemo(
    () => currentReport ? archiveOverlapScore(currentReport) : 0,
    [currentReport],
  );
  const currentAiSignal = useMemo(
    () => currentReport ? aiSignalDisplay(currentReport) : null,
    [currentReport],
  );

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }

  async function submitAuthInterface(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isAuthenticating) return;
    const completedMode = authMode ?? "login";
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const username = String(formData.get("username") ?? "").trim();
    const remember = formData.get("remember") === "on";

    if (completedMode === "signup") {
      const confirmPassword = String(formData.get("confirmPassword") ?? "");
      const confirmInput = event.currentTarget.elements.namedItem("confirmPassword") as HTMLInputElement | null;
      if (password !== confirmPassword) {
        confirmInput?.setCustomValidity("The passwords do not match.");
        confirmInput?.reportValidity();
        return;
      }
      confirmInput?.setCustomValidity("");
    }

    setAuthError(null);
    setIsAuthenticating(true);
    setAuthProgress(10);
    setAuthLoadingLabel(completedMode === "login" ? "Preparing your sign-in" : "Creating your workspace");

    // Real request, not a fixed timer: the progress bar animates toward a
    // minimum display duration while the request is in flight, and pads out
    // to that minimum if the response comes back faster, matching the
    // real-work-plus-minimum-animation pattern used for report generation.
    const minimumAuthMs = 1_800;
    const animationStartedAt = Date.now();
    const progressTimer = window.setInterval(() => {
      const elapsed = Date.now() - animationStartedAt;
      setAuthProgress(Math.min(90, 10 + Math.round((elapsed / minimumAuthMs) * 80)));
    }, 150);
    const labelTimers = [
      window.setTimeout(() => setAuthLoadingLabel("Preparing your private workspace"), 500),
      window.setTimeout(() => setAuthLoadingLabel("Loading your report history"), 1100),
    ];
    const stopAnimation = () => {
      window.clearInterval(progressTimer);
      labelTimers.forEach((timer) => window.clearTimeout(timer));
    };

    let response: Response;
    try {
      response = await fetch(completedMode === "login" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, username, deviceKey: getDeviceKey(), remember }),
      });
    } catch {
      stopAnimation();
      setIsAuthenticating(false);
      setAuthError("Could not reach TurnitPlus. Check your connection and try again.");
      return;
    }

    const data = (await response.json().catch(() => null)) as { user?: LocalAccount; error?: string } | null;
    if (!response.ok || !data?.user) {
      stopAnimation();
      setIsAuthenticating(false);
      setAuthError((data && typeof data.error === "string" && data.error) || "Something went wrong. Please try again.");
      return;
    }

    setAuthLoadingLabel("Almost ready");
    const remainingMs = Math.max(0, minimumAuthMs - (Date.now() - animationStartedAt));
    if (remainingMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
    stopAnimation();
    setAuthProgress(100);

    setAccount(data.user as LocalAccount);
    setIsAuthenticating(false);
    setAuthMode(null);
    setWelcomeMode(completedMode);
    navigate("welcome");
  }

  async function submitProfileEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    const data = new FormData(event.currentTarget);
    const username = String(data.get("profileUsername") ?? "").trim();
    const email = String(data.get("profileEmail") ?? "").trim();

    setProfileEditError(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email }),
      });
    } catch {
      setProfileEditError("Could not reach TurnitPlus. Check your connection and try again.");
      return;
    }

    const result = (await response.json().catch(() => null)) as { user?: LocalAccount; error?: string } | null;
    if (!response.ok || !result?.user) {
      setProfileEditError((result && typeof result.error === "string" && result.error) || "Could not update your account information.");
      return;
    }

    setAccount(result.user as LocalAccount);
    setIsEditingProfile(false);
    notify("Your account information has been updated.");
  }

  function navigate(nextView: View) {
    if (generationLockRef.current && nextView === "dashboard") {
      if (window.location.hash !== VIEW_HASH.reports) {
        window.history.pushState({ turnitPlusView: "reports" }, "", VIEW_HASH.reports);
      }
      setView("reports");
      setMobileNavOpen(false);
      notify("Your current report must finish before another document can be uploaded.");
      return;
    }
    const nextHash = nextView === "result"
      ? "#report"
      : nextView === "processing"
        ? "#reports"
        : VIEW_HASH[nextView];
    if (window.location.hash !== nextHash) {
      window.history.pushState({ turnitPlusView: nextView }, "", nextHash);
    }
    setView(nextView);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAccountPage(mode: AuthMode = "login") {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      window.localStorage.setItem("tp_sidebar_collapsed", "false");
    }
    setAuthMode(mode);
    setMobileNavOpen(false);
    navigate("account");
  }

  function openLegalPage(tab: LegalTab) {
    setLegalTab(tab);
    navigate("legal");
  }

  function signOutAccount() {
    // Best-effort: a network hiccup should never block the local sign-out.
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAccount(null);
    setIsEditingProfile(false);
    setAuthMode("login");
    setWelcomeMode(null);
    window.history.replaceState({ turnitPlusView: "account" }, "", VIEW_HASH.account);
    setView("account");
    notify("You have signed out.");
  }

  function chooseFile(selected: File | undefined) {
    if (generationLockRef.current) {
      notify("Please wait for the current report to finish before choosing another document.");
      return;
    }
    if (!selected) return;
    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "docx", "txt", "md", "html", "csv"].includes(extension ?? "")) {
      notify("Choose a PDF, DOCX, TXT, MD, HTML, or CSV file.");
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      notify("The file must be 10 MB or smaller.");
      return;
    }
    setFile(selected);
  }

  async function saveReport(report: SimilarityReport) {
    setReports((current) => [report, ...current.filter((item) => item.id !== report.id)].slice(0, 50));
    await storeReport(report);
    await saveReportRemote(report, buildReportSummary(report));
  }

  async function generateReport() {
    if (generationLockRef.current) {
      notify("Your current document is still being analyzed.");
      return;
    }
    if (!file) {
      notify("Choose a document to generate the report.");
      return;
    }

    const submittedFile = file;
    generationLockRef.current = true;
    setIsGeneratingReport(true);
    navigate("reports");
    setProgress(4);
    setProcessingLabel("Reading document content");
    const minimumProcessingMs = 8_000 + Math.floor(Math.random() * 7_001);
    const animationStartedAt = Date.now();
    const progressTimer = window.setInterval(() => {
      const elapsed = Date.now() - animationStartedAt;
      setProgress(Math.min(95, 4 + Math.round((elapsed / minimumProcessingMs) * 91)));
    }, 250);

    let text = "";
    try {
      text = (await extractFileText(submittedFile, (_value, label) => {
        setProcessingLabel(label);
      }))
        .replace(/<[^>]*>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    } catch {
      navigate("dashboard");
      notify("I could not read that document. Try another file.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    if (text.length < 80) {
      navigate("dashboard");
      notify("Add at least 80 characters to create a useful report.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    const wikipediaPromise = analyzeWikipediaText(
      text,
      submittedFile.name,
      () => undefined,
    ).catch((error) => {
      console.debug("Wikipedia background enrichment failed.", {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    let report: SimilarityReport;
    try {
      report = await analyzeText(text, submittedFile.name, submittedFile.size, (_value, label) => {
        setProcessingLabel(label);
      });
    } catch {
      navigate("dashboard");
      notify("The private document corpus could not be loaded. Please try again.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    setProcessingLabel("Preparing local English AI analysis");
    try {
      const aiAnalysis = await analyzeAiText(text, report.features.detectedLanguage, setProcessingLabel);
      report = { ...report, aiScore: aiAnalysis.score, aiAnalysis };
    } catch (error) {
      report = {
        ...report,
        aiScore: null,
        aiAnalysis: {
          status: "error",
          score: null,
          model: AI_MODEL_VERSION,
          engine: null,
          threshold: AI_PASSAGE_THRESHOLD,
          thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
          eligibleWordCount: 0,
          analyzedWordCount: 0,
          passages: [],
          error: error instanceof Error ? error.message : "The local AI model could not be loaded.",
        },
      };
    }
    setCurrentReport(report);
    const remainingAnimationMs = Math.max(0, minimumProcessingMs - (Date.now() - animationStartedAt));
    if (remainingAnimationMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, remainingAnimationMs));
    }
    window.clearInterval(progressTimer);
    setProgress(100);
    setProcessingLabel("Preparing your reports");
    try {
      await saveReport(report);
      void wikipediaPromise.then(async (webCheck) => {
        if (!webCheck) return;
        console.debug("Wikipedia background enrichment completed.", {
          reportId: report.id,
          status: webCheck.status,
          outcomes: webCheck.outcomes,
          phrasesMatched: webCheck.phrasesMatched,
        });
        const enriched = enrichReportWithWikipedia(report, webCheck);
        setCurrentReport((current) => current?.id === enriched.id ? { ...current, ...enriched } : current);
        setReports((current) => current.map((item) => item.id === enriched.id ? { ...item, ...enriched } : item));
        await storeReport(enriched);
        await saveReportRemote(enriched, buildReportSummary(enriched));
      });
      setResultTab("full");
      setReportMode("similarity");
      navigate("reports");
      notify("Your reports are ready. Choose AI or Archive overlap.");
    } finally {
      generationLockRef.current = false;
      setIsGeneratingReport(false);
    }
  }

  async function runAiAnalysis(report: SimilarityReport) {
    if (isRunningAiAnalysis) return;
    setIsRunningAiAnalysis(true);
    setAiProgressLabel("Loading the local AI model");
    try {
      const aiAnalysis = await analyzeAiText(report.text, report.features.detectedLanguage, setAiProgressLabel);
      const updated = { ...report, aiScore: aiAnalysis.score, aiAnalysis };
      setCurrentReport(updated);
      setReports((current) => current.map((item) => item.id === updated.id ? updated : item));
      await storeReport(updated);
      await saveReportRemote(updated, buildReportSummary(updated));
      notify(aiAnalysis.status === "complete" ? "AI report completed." : "This document is not eligible for English AI analysis.");
    } catch (error) {
      const failed: SimilarityReport = {
        ...report,
        aiScore: null,
        aiAnalysis: {
          status: "error",
          score: null,
          model: AI_MODEL_VERSION,
          engine: null,
          threshold: AI_PASSAGE_THRESHOLD,
          thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
          eligibleWordCount: 0,
          analyzedWordCount: 0,
          passages: [],
          error: error instanceof Error ? error.message : "The local AI model could not be loaded.",
        },
      };
      setCurrentReport(failed);
      setReports((current) => current.map((item) => item.id === failed.id ? failed : item));
      await storeReport(failed);
      await saveReportRemote(failed, buildReportSummary(failed));
    } finally {
      setIsRunningAiAnalysis(false);
    }
  }

  function openReport(report: SimilarityReport, mode: ReportMode) {
    setCurrentReport(report);
    setResultTab("full");
    setReportMode(mode);
    navigate("result");
    if (
      mode === "ai"
      && (
        !report.aiAnalysis
        || report.aiAnalysis.status === "error"
        || report.aiAnalysis.scoringVersion !== AI_SCORING_VERSION
        || report.aiAnalysis.model !== AI_MODEL_VERSION
      )
    ) {
      void runAiAnalysis(report);
    }
  }

  function startNewCheck() {
    if (generationLockRef.current) {
      navigate("reports");
      notify("Please wait for the current report to finish before starting another check.");
      return;
    }
    setFile(null);
    setProgress(0);
    setCurrentReport(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    navigate("dashboard");
  }

  async function clearHistory() {
    const idsToDelete = reports.map((report) => String(report.id));
    setReports([]);
    await clearStoredReports();
    await Promise.all(idsToDelete.map((id) => deleteRemoteReport(id)));
    notify("Report history cleared.");
  }

  const activeNavView = view === "home" || view === "result" || view === "processing" || view === "welcome" ? "dashboard" : view;

  return (
    <div className={`site-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark">T+</div>
          <div>
            <strong>TurnitPlus</strong>
            <span>AI & similarity detection</span>
          </div>
        </div>

        <button
          className="sidebar-collapse"
          type="button"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </button>

        <button
          className="mobile-menu"
          type="button"
          aria-label="Toggle navigation"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          {mobileNavOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>

        <nav aria-label="Main navigation">
          <div className={`account-nav ${account ? "has-account" : ""} ${activeNavView === "account" ? "current" : ""}`}>
            <button
              className="account-trigger"
              type="button"
              onClick={() => openAccountPage()}
            >
              <span className={`account-avatar ${account ? "signed-in" : ""}`}>
                {account ? account.username.slice(0, 1).toUpperCase() : <UserRound aria-hidden="true" />}
              </span>
              <span className="account-copy">
                <strong>{account?.username ?? "Account"}</strong>
                <span>{account ? "Signed in" : "Log in or create account"}</span>
              </span>
              <ChevronRight className="account-nav-chevron" aria-hidden="true" />
            </button>
          </div>
          <button
            className={view === "home" ? "active" : ""}
            type="button"
            onClick={() => navigate("home")}
          >
            <ShieldCheck aria-hidden="true" />
            <span className="nav-label">Overview</span>
          </button>
          <button
            className={activeNavView === "dashboard" ? "active" : ""}
              type="button"
              disabled={isGeneratingReport}
              aria-label={isGeneratingReport ? "Dashboard unavailable while a report is processing" : "Dashboard"}
              onClick={() => navigate("dashboard")}
            >
              <LayoutDashboard aria-hidden="true" />
              <span className="nav-label">Dashboard</span>
            </button>
            <button
              className={activeNavView === "reports" ? "active" : ""}
              type="button"
              onClick={() => navigate("reports")}
            >
              <FolderClock aria-hidden="true" />
              <span className="nav-label">My reports</span>
              {reports.length > 0 && <span className="nav-count">{reports.length}</span>}
            </button>
            <button
              className={activeNavView === "about" ? "active" : ""}
              type="button"
              onClick={() => navigate("about")}
            >
              <CircleHelp aria-hidden="true" />
              <span className="nav-label">How it works</span>
            </button>
        </nav>

        <div className="sidebar-trust">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Private by design</strong>
            <span>Processing stays in your browser.</span>
          </div>
        </div>
      </aside>

      <main key={view} className={`${view === "result" ? "report-main" : ""} page-stage`}>
        {view !== "result" && view !== "processing" && (
          <header className="topbar">
            <div>
              <p className="eyebrow">{view === "legal" ? "TRUST CENTER" : view === "account" && !account ? "OPTIONAL ACCOUNT" : "AI & SIMILARITY CHECKER"}</p>
              <h1>
                {view === "dashboard" && "Check AI writing and similarity"}
                {view === "reports" && "Your recent reports"}
                {view === "about" && "How the checker works"}
                {view === "account" && (account ? "Your account" : "Log in or create your account")}
                {view === "welcome" && "Welcome to TurnitPlus"}
                {view === "legal" && "Privacy, retention and terms"}
              </h1>
            </div>
            <div className="topbar-actions">
              {accountLoaded && !account && view !== "account" && (
                <button className="register-button" type="button" onClick={() => openAccountPage("signup")}>
                  <UserPlus aria-hidden="true" />
                  Register
                </button>
              )}
              <div className="ready-pill"><span /> Ready</div>
            </div>
          </header>
        )}

        {view === "home" && (
          <section className="landing-page" aria-labelledby="landing-title">
            <div className="landing-hero">
              <div className="landing-hero-copy">
                <span className="landing-badge"><ShieldCheck aria-hidden="true" /> Private by design</span>
                <h2 id="landing-title">Understand what is in your document—without sending the document away.</h2>
                <p className="landing-lede">TurnitPlus checks AI-writing signals and archive overlap in your browser, then gives you the passages and sources behind the result.</p>
                <div className="landing-actions">
                  <button className="button primary landing-cta" type="button" onClick={() => navigate("dashboard")}><UploadCloud aria-hidden="true" /> Check a document free</button>
                  <button className="button secondary" type="button" onClick={() => navigate("about")}><BookOpen aria-hidden="true" /> See how it works</button>
                </div>
                <div className="landing-proof">
                  <span><Check aria-hidden="true" /> No cloud upload</span>
                  <span><Check aria-hidden="true" /> PDF, DOCX, TXT & more</span>
                  <span><Check aria-hidden="true" /> Reports stay on this device</span>
                </div>
              </div>
              <div className="landing-product-card surface-card">
                <div className="landing-product-top">
                  <div><span className="section-label">SAMPLE REPORT</span><strong>Evidence, not just a score</strong></div>
                  <span className="landing-live-dot"><i /> Ready</span>
                </div>
                <div className="landing-score-grid">
                  <div><span>AI-writing signal</span><strong>Review</strong><small>Passages highlighted for inspection</small></div>
                  <div><span>Archive overlap</span><strong>19%</strong><small>Matched phrases linked to sources</small></div>
                </div>
                <div className="landing-match-preview">
                  <div className="landing-line wide" /><div className="landing-line" /><div className="landing-line match" /><div className="landing-line wide" /><div className="landing-line match short" />
                </div>
                <div className="landing-source-row"><span><FileCheck2 aria-hidden="true" /> Evidence attached</span><span>230 indexed documents</span></div>
              </div>
            </div>

            <div className="landing-section-heading">
              <p className="section-label">BUILT FOR REVIEW</p>
              <h2>Three things TurnitPlus does well</h2>
              <p>Keep the result useful, inspectable and honest about what the system can actually prove.</p>
            </div>
            <div className="landing-feature-grid">
              <article className="surface-card landing-feature-card"><span className="landing-feature-icon"><Search aria-hidden="true" /></span><h3>Find meaningful overlap</h3><p>Measure text found inside the indexed archive and show the exact passages that matched.</p></article>
              <article className="surface-card landing-feature-card"><span className="landing-feature-icon"><GraduationCap aria-hidden="true" /></span><h3>Review AI-writing signals</h3><p>Surface calibrated signals and highlighted passages instead of pretending a score is proof of authorship.</p></article>
              <article className="surface-card landing-feature-card"><span className="landing-feature-icon"><ShieldCheck aria-hidden="true" /></span><h3>Keep documents local</h3><p>Extraction and analysis happen in your browser. You stay in control of locally stored reports.</p></article>
            </div>

            <div className="landing-how surface-card">
              <div><p className="section-label">HOW IT WORKS</p><h2>From document to evidence in three steps.</h2><p>There is no complicated setup. Choose a file, let the browser analyze it, then inspect the report.</p></div>
              <div className="landing-step-list">
                <div><span>01</span><strong>Choose a document</strong><p>Upload a supported file up to 10 MB.</p></div>
                <div><span>02</span><strong>Analyze privately</strong><p>Workers extract, compare and score the text locally.</p></div>
                <div><span>03</span><strong>Inspect the evidence</strong><p>Review scores, passages, sources and a downloadable report.</p></div>
              </div>
            </div>

            <div className="landing-bottom-cta">
              <div><p className="section-label">READY WHEN YOU ARE</p><h2>Start with one document.</h2><p>No account is required for the local checking workflow.</p></div>
              <button className="button primary" type="button" onClick={() => navigate("dashboard")}><UploadCloud aria-hidden="true" /> Check a document</button>
            </div>
          </section>
        )}

        {view === "dashboard" && (
          <section className="dashboard-grid">
            <section className="upload-card surface-card">
              <div className="card-heading">
                <div>
                  <p className="section-label">NEW CHECK</p>
                  <h2>Upload your document</h2>
                  <span>PDF, DOCX, TXT, MD, HTML, or CSV · up to 10 MB</span>
                </div>
                <span className="free-badge">FREE</span>
              </div>

              {isGeneratingReport ? (
                <div className="upload-locked-panel" role="status" aria-live="polite">
                  <span className="upload-locked-icon"><LockKeyhole aria-hidden="true" /></span>
                  <p className="section-label">CURRENT CHECK IN PROGRESS</p>
                  <h3>{file?.name ?? "Your document"}</h3>
                  <p>{processingLabel}…</p>
                  <div className="progress-track" aria-label={`${progress}% complete`}>
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <strong>{progress}%</strong>
                  <span>Uploading another document is available when this report is finished.</span>
                </div>
              ) : <>
              <label
                className={`drop-zone ${file ? "uploaded" : ""} ${isGeneratingReport ? "processing" : ""}`}
                aria-busy={isGeneratingReport}
                aria-disabled={isGeneratingReport}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (isGeneratingReport) event.dataTransfer.dropEffect = "none";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  chooseFile(event.dataTransfer.files[0]);
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.html,.csv"
                  hidden
                  disabled={isGeneratingReport}
                  onChange={(event) => chooseFile(event.target.files?.[0])}
                />
                {file ? (
                  <>
                    <span className="upload-icon upload-success-icon"><Check aria-hidden="true" /></span>
                    <strong>Document uploaded</strong>
                    <p className="uploaded-file-name">{file.name}</p>
                    <span className="uploaded-file-meta">{formatBytes(file.size)} · {isGeneratingReport ? "Analysis in progress" : "Ready to generate"}</span>
                    <span className="button secondary">{isGeneratingReport ? "File locked while processing" : "Replace file"}</span>
                  </>
                ) : (
                  <>
                    <span className="upload-icon"><UploadCloud aria-hidden="true" /></span>
                    <strong>Drop your document here</strong>
                    <p>or choose a file from your computer</p>
                    <span className="button secondary">Choose file</span>
                  </>
                )}
              </label>

              <button className="button primary full" type="button" disabled={isGeneratingReport} aria-busy={isGeneratingReport} onClick={generateReport}>
                <UploadCloud aria-hidden="true" />
                {isGeneratingReport ? `Analyzing ${progress}%` : "Generate free report"}
              </button>
              </>}
              <p className="privacy-note"><LockKeyhole aria-hidden="true" /> Documents are processed in your browser.</p>
            </section>

            <section className="dashboard-aside">
              <article className="surface-card report-preview-card">
                <p className="section-label">TWO REPORTS · ONE CHECK</p>
                <h2>AI detection and archive overlap with clear evidence</h2>
                <p>TurnitPlus checks AI-writing signals and measures text found in its indexed archive, then shows the passages behind each result.</p>
                <div className="mini-report">
                  <div>
                    <span>Archive overlap</span>
                    <strong>19%</strong>
                    <small>230 indexed documents</small>
                  </div>
                  <div className="mini-lines">
                    <i /><i /><i />
                  </div>
                </div>
                <ul className="feature-checks">
                  <li><Check aria-hidden="true" /> AI-written content detection</li>
                  <li><Check aria-hidden="true" /> Source similarity detection</li>
                  <li><Check aria-hidden="true" /> Matched phrases highlighted in red</li>
                  <li><Check aria-hidden="true" /> Downloadable full reports and receipt</li>
                </ul>
              </article>

              <article className="surface-card privacy-card">
                <ShieldCheck aria-hidden="true" />
                <div>
                  <strong>Private by design</strong>
                  <p>No account is required to check a document. Reports stay on this device.</p>
                </div>
              </article>
            </section>
          </section>
        )}

        {view === "account" && (
          <section className="account-page">
            {account ? (
              <div className="account-profile-layout">
                <div className="account-profile-card surface-card">
                  <div className="account-profile-hero">
                    <span className="account-profile-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
                    <div className="account-profile-details">
                      <p className="section-label">SIGNED IN</p>
                      <h2>{account.username}</h2>
                      <p>{account.email}</p>
                    </div>
                    <button className="button secondary account-edit-button" type="button" onClick={() => setIsEditingProfile((editing) => !editing)}>
                      <Pencil aria-hidden="true" /> {isEditingProfile ? "Close editor" : "Edit information"}
                    </button>
                  </div>
                  {isEditingProfile && (
                    <form className="account-edit-form" onSubmit={submitProfileEdit}>
                      <div className="account-edit-heading">
                        <div>
                          <strong>Edit account information</strong>
                          <span>Update how your name and email appear in TurnitPlus.</span>
                        </div>
                      </div>
                      <div className="account-edit-fields">
                        <label>
                          <span>Display name</span>
                          <input name="profileUsername" type="text" defaultValue={account.username} minLength={2} maxLength={32} autoComplete="name" required />
                        </label>
                        <label>
                          <span>Email address</span>
                          <input name="profileEmail" type="email" defaultValue={account.email} autoComplete="email" required />
                        </label>
                      </div>
                      {profileEditError && <p className="auth-form-error" role="alert">{profileEditError}</p>}
                      <div className="account-edit-actions">
                        <button className="button subtle" type="button" onClick={() => setIsEditingProfile(false)}>Cancel</button>
                        <button className="button primary" type="submit"><Save aria-hidden="true" /> Save changes</button>
                      </div>
                    </form>
                  )}
                  <div className="account-profile-status"><Check aria-hidden="true" /> Your account session is active on this device.</div>
                  <div className="account-profile-actions">
                    <button className="button primary" type="button" disabled={isGeneratingReport} onClick={startNewCheck}>
                      <UploadCloud aria-hidden="true" /> Start a new check
                    </button>
                    <button className="button secondary" type="button" onClick={() => navigate("reports")}>
                      <FolderClock aria-hidden="true" /> View my reports
                    </button>
                    <button className="button subtle account-signout" type="button" onClick={signOutAccount}>
                      <LogOut aria-hidden="true" /> Sign out
                    </button>
                  </div>
                  <p className="auth-preview-note"><LockKeyhole aria-hidden="true" /> Documents are analyzed in your browser and never uploaded. Your report history is saved securely so you can reach it from any device you sign in on.</p>
                </div>

                <section className="subscription-preview-card surface-card" aria-labelledby="unlimited-plan-title">
                  <div className="subscription-copy">
                    <div className="subscription-heading-row">
                      <span className="subscription-icon"><CreditCard aria-hidden="true" /></span>
                      <div>
                        <p className="section-label">MEMBERSHIP</p>
                        <span className="subscription-coming-soon">COMING SOON</span>
                      </div>
                    </div>
                    <h2 id="unlimited-plan-title">TurnitPlus Unlimited</h2>
                    <p>Unlock unlimited document checks for one simple monthly price.</p>
                    <ul className="subscription-features">
                      <li><Check aria-hidden="true" /> Unlimited similarity checks</li>
                      <li><Check aria-hidden="true" /> Unlimited AI writing reports</li>
                      <li><Check aria-hidden="true" /> Full report previews and downloads</li>
                    </ul>
                  </div>
                  <div className="subscription-price-panel">
                    <span className="subscription-plan-label">MONTHLY PLAN</span>
                    <div className="subscription-price"><strong>$20</strong><span>/ month</span></div>
                    <p>Cancel anytime once billing becomes available.</p>
                    <button className="button primary full" type="button" onClick={() => notify("TurnitPlus Unlimited is coming soon. No payment was taken.")}>Notify me at launch</button>
                    <small>Plan preview only · no payment will be collected.</small>
                  </div>
                </section>
              </div>
            ) : (
              <div className="account-page-grid">
                <section className="auth-page-card surface-card" aria-labelledby="account-page-title">
                  <div className="auth-dialog-brand">
                    <div className="brand-mark">T+</div>
                    <div><strong>TurnitPlus</strong><span>AI & similarity detection</span></div>
                  </div>
                  <div className="auth-mode-tabs" aria-label="Account action">
                    <button className={(authMode ?? "login") === "login" ? "active" : ""} type="button" disabled={isAuthenticating} onClick={() => { setAuthMode("login"); setAuthError(null); }}>Log in</button>
                    <button className={(authMode ?? "login") === "signup" ? "active" : ""} type="button" disabled={isAuthenticating} onClick={() => { setAuthMode("signup"); setAuthError(null); }}>Create account</button>
                  </div>
                  <p className="section-label">{(authMode ?? "login") === "login" ? "WELCOME BACK" : "CREATE YOUR ACCOUNT"}</p>
                  <h2 id="account-page-title">{(authMode ?? "login") === "login" ? "Log in to TurnitPlus" : "Start using TurnitPlus"}</h2>
                  <p className="auth-dialog-intro">
                    {(authMode ?? "login") === "login"
                      ? "Continue to your document checks and saved reports."
                      : "Create an account to keep your report workflow in one place."}
                  </p>
                  <form className="auth-form" onSubmit={submitAuthInterface}>
                    {isAuthenticating ? (
                      <div className="auth-loading-panel" role="status" aria-live="polite" aria-label={`${authLoadingLabel}, ${authProgress}% complete`}>
                        <div className="auth-loading-visual" aria-hidden="true">
                          <span className="auth-loading-ring" />
                          <span className="auth-loading-logo">T+</span>
                        </div>
                        <div className="auth-loading-copy">
                          <strong>{(authMode ?? "login") === "login" ? "Signing you in" : "Setting up your account"}</strong>
                          <p>{authLoadingLabel}</p>
                        </div>
                        <div className="auth-loading-progress" aria-hidden="true"><span style={{ width: `${authProgress}%` }} /></div>
                        <small>{authProgress}%</small>
                      </div>
                    ) : <>
                    {authError && <p className="auth-form-error" role="alert">{authError}</p>}
                    {(authMode ?? "login") === "signup" && (
                      <label>
                        <span>Username</span>
                        <input type="text" name="username" autoComplete="username" placeholder="Choose a username" minLength={2} maxLength={32} autoFocus required />
                      </label>
                    )}
                    <label>
                      <span>Email address</span>
                      <input type="email" name="email" autoComplete="email" placeholder="you@example.com" autoFocus={(authMode ?? "login") === "login"} required />
                    </label>
                    <label>
                      <span>Password</span>
                      <input
                        type="password"
                        name="password"
                        autoComplete={(authMode ?? "login") === "login" ? "current-password" : "new-password"}
                        placeholder="Enter your password"
                        minLength={8}
                        required
                      />
                    </label>
                    {(authMode ?? "login") === "signup" && (
                      <label>
                        <span>Confirm password</span>
                        <input
                          type="password"
                          name="confirmPassword"
                          autoComplete="new-password"
                          placeholder="Repeat your password"
                          minLength={8}
                          onInput={(event) => event.currentTarget.setCustomValidity("")}
                          required
                        />
                      </label>
                    )}
                    {(authMode ?? "login") === "login" && (
                      <div className="auth-form-row">
                        <label className="auth-checkbox"><input type="checkbox" name="remember" /><span>Remember me</span></label>
                        <button type="button" onClick={() => notify("Password recovery will be added with the account service.")}>Forgot password?</button>
                      </div>
                    )}
                    <button className="button primary full auth-submit" type="submit">
                      {(authMode ?? "login") === "login" ? <><LogIn aria-hidden="true" /> Log in</> : <><UserPlus aria-hidden="true" /> Create account</>}
                    </button>
                    </>}
                  </form>
                  <p className="auth-switch">
                    {(authMode ?? "login") === "login" ? "New to TurnitPlus?" : "Already have an account?"}
                    <button type="button" disabled={isAuthenticating} onClick={() => { setAuthMode((authMode ?? "login") === "login" ? "signup" : "login"); setAuthError(null); }}>
                      {(authMode ?? "login") === "login" ? "Create account" : "Log in"}
                    </button>
                  </p>
                  <p className="auth-preview-note"><LockKeyhole aria-hidden="true" /> Your password is never stored — only a one-way cryptographic hash used to verify future sign-ins.</p>
                </section>

                <aside className="account-benefits surface-card">
                  <p className="section-label">YOUR PRIVATE WORKSPACE</p>
                  <h2>Everything stays organized</h2>
                  <div className="account-benefit-list">
                    <article><FolderClock aria-hidden="true" /><div><strong>Report history</strong><p>Return to your recent AI and similarity reports.</p></div></article>
                    <article><ShieldCheck aria-hidden="true" /><div><strong>Private processing</strong><p>Documents continue to be analyzed inside your browser.</p></div></article>
                    <article><FileCheck2 aria-hidden="true" /><div><strong>Clear evidence</strong><p>Open either report from its own dedicated screen.</p></div></article>
                  </div>
                </aside>
              </div>
            )}
          </section>
        )}

        {view === "welcome" && account && (
          <section className="welcome-page-card surface-card" aria-labelledby="welcome-page-title">
            <div className="welcome-identity">
              <span className="welcome-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
              <span className="welcome-check"><Check aria-hidden="true" /></span>
            </div>
            <p className="section-label">{welcomeMode === "signup" ? "ACCOUNT CREATED" : "WELCOME BACK"}</p>
            <h2 id="welcome-page-title">
              {welcomeMode === "signup" ? `You’re ready, ${account.username}` : `Good to see you, ${account.username}`}
            </h2>
            <p className="welcome-intro">Your private review workspace is ready. Here’s the quickest way to get useful evidence from a document.</p>
            <div className="welcome-steps" aria-label="How TurnitPlus works">
              <article><span>1</span><div className="welcome-step-icon"><UploadCloud aria-hidden="true" /></div><div><strong>Upload privately</strong><p>Choose a document. Processing stays inside this browser.</p></div></article>
              <article><span>2</span><div className="welcome-step-icon"><Search aria-hidden="true" /></div><div><strong>Review the evidence</strong><p>See the archive percentage and the exact passages behind it.</p></div></article>
              <article><span>3</span><div className="welcome-step-icon"><FolderClock aria-hidden="true" /></div><div><strong>Return anytime</strong><p>Your report history stays available on this device.</p></div></article>
            </div>
            <div className="welcome-actions">
              <button className="button primary" type="button" disabled={isGeneratingReport} onClick={startNewCheck}><UploadCloud aria-hidden="true" /> Start a new check</button>
              <button className="button secondary" type="button" onClick={() => navigate("reports")}><FolderClock aria-hidden="true" /> View my reports</button>
            </div>
            <p className="welcome-privacy"><LockKeyhole aria-hidden="true" /> No document is uploaded to an account or cloud workspace.</p>
          </section>
        )}

        {view === "welcome" && !account && accountLoaded && (
          <section className="welcome-missing surface-card">
            <UserRound aria-hidden="true" />
            <h2>Log in to continue</h2>
            <p>Your welcome page belongs to an active account session.</p>
            <button className="button primary" type="button" onClick={() => openAccountPage("login")}><LogIn aria-hidden="true" /> Go to login</button>
          </section>
        )}

        {view === "processing" && (
          <section className="processing-screen">
            <div className="processing-card surface-card">
              <div className="scanner-document">
                <span className="scanner-line" />
                <FileText aria-hidden="true" />
              </div>
              <p className="section-label">DOCUMENT ANALYSIS</p>
              <h1>Building your archive-overlap report</h1>
              <p>{processingLabel}…</p>
              <div className="progress-track" aria-label={`${progress}% complete`}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <strong>{progress}%</strong>
            </div>
          </section>
        )}

        {view === "reports" && (
          <section className="reports-card surface-card">
            <div className="card-heading">
              <div>
                <p className="section-label">ON THIS DEVICE</p>
                <h2>Recent reports</h2>
                <span>Open earlier checks or download their processing receipts.</span>
              </div>
              <div className="report-header-actions">
                {isGeneratingReport ? (
                  <div className="report-job-lock" role="status">
                    <LockKeyhole aria-hidden="true" />
                    <span><strong>Current report running</strong><small>{progress}% complete · one document at a time</small></span>
                  </div>
                ) : <>
                  <button className="button primary" type="button" onClick={startNewCheck}>
                    <UploadCloud aria-hidden="true" /> New check
                  </button>
                  {reports.length > 0 && (
                    <button className="button subtle" type="button" onClick={clearHistory}>Clear history</button>
                  )}
                </>}
              </div>
            </div>

            {reports.length === 0 && !isGeneratingReport ? (
              <div className="empty-reports">
                <FolderClock aria-hidden="true" />
                <h3>No reports yet</h3>
                <p>Your reports will appear here after you check a document.</p>
                <button className="button primary" type="button" onClick={() => navigate("dashboard")}>Create a report</button>
              </div>
            ) : (
              <div className="report-history">
                {isGeneratingReport && file && (
                  <article className="history-processing" aria-live="polite">
                    <div className="history-file-icon"><FileText aria-hidden="true" /></div>
                    <div className="history-copy">
                      <strong>{file.name}</strong>
                      <p>{processingLabel}…</p>
                      <div className="history-progress" aria-label={`${progress}% complete`}>
                        <span style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                    <div className="history-processing-value">
                      <strong>{progress}%</strong>
                      <span>Processing</span>
                    </div>
                  </article>
                )}
                {reports.map((report) => {
                  const aiSignal = aiSignalDisplay(report);
                  const overlapScore = archiveOverlapScore(report);
                  const similarityVerdict = similarityScoreBand(overlapScore);
                  return (
                  <article key={report.id}>
                    <div className="history-file-icon"><FileText aria-hidden="true" /></div>
                    <div className="history-copy">
                      <strong>{report.title}</strong>
                      <p>
                        {new Date(report.created).toLocaleDateString("en-GB")} · {report.wordCount.toLocaleString()} words
                      </p>
                    </div>
                    <div className="history-action-group" aria-label={`Actions for ${report.title}`}>
                      <button className={`history-result history-ai-result history-ai-${aiSignal.tone}`} type="button" aria-label={`Open AI report for ${report.title}`} onClick={() => openReport(report, "ai")}>
                        <span className="history-result-score">
                          <strong className="history-ai-value">
                            {aiSignal.value === null ? "—" : `${aiSignal.value}%`}
                          </strong>
                          <span>{aiSignal.label}</span>
                        </span>
                        <span className="history-open-cue" aria-hidden="true"><ChevronRight /></span>
                      </button>
                      <button className={`history-result history-similarity-result ${similarityVerdict ? `history-similarity-${similarityVerdict.key}` : ""}`} type="button" aria-label={`Open Archive overlap report for ${report.title}`} onClick={() => openReport(report, "similarity")}>
                        <span className="history-result-score">
                          <strong>{overlapScore}%</strong>
                          <span>Archive overlap · {archiveScopeCount(report)} docs</span>
                        </span>
                        <span className="history-open-cue" aria-hidden="true"><ChevronRight /></span>
                      </button>
                      <button className="history-receipt" type="button" onClick={() => downloadReceipt(report)}>
                        <Download aria-hidden="true" />
                        <span>Receipt</span>
                      </button>
                    </div>
                  </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {view === "about" && (
          <section className="about-card surface-card">
            <p className="section-label">ONE CHECK · TWO CLEAR REPORTS</p>
            <h2>A stronger way to review every document</h2>
            <p className="about-intro">
              TurnitPlus detects AI-written content and source similarity while keeping the evidence easy to inspect.
              Upload once, open either report, and review the highlighted passages behind the result.
            </p>
            <div className="about-steps">
              <article><span>01</span><FileText aria-hidden="true" /><h3>Upload privately</h3><p>Your document is read and analyzed inside your browser.</p></article>
              <article><span>02</span><Search aria-hidden="true" /><h3>Measure</h3><p>Generate an AI-writing report and measure overlap against 230 indexed documents.</p></article>
              <article><span>03</span><FileCheck2 aria-hidden="true" /><h3>Review the evidence</h3><p>Open highlighted passages, sources and downloadable reports.</p></article>
            </div>
            <section className="methodology-boundary">
              <div>
                <p className="section-label">PUBLISHED CLAIM BOUNDARY</p>
                <h3>Archive matching, not a Turnitin forecast</h3>
                <p>A prospectively sealed 60-document evaluation showed that this archive should not be used to estimate an external Turnitin score. TurnitPlus therefore reports only the text found in its own indexed archive, with the matched sources attached.</p>
                <a href="/data/similarity-boundary-evaluation.json" download>
                  <Download aria-hidden="true" /> Download the sealed evaluation summary
                </a>
              </div>
              <dl>
                <div><dt>Indexed archive</dt><dd>230 documents</dd></div>
                <div><dt>Sealed evaluation</dt><dd>60 documents</dd></div>
                <div><dt>Product decision</dt><dd>Forecast withdrawn</dd></div>
              </dl>
            </section>
          </section>
        )}

        {view === "legal" && (
          <section className="legal-center">
            <header className="legal-hero surface-card">
              <div>
                <p className="section-label">TURNITPLUS TRUST CENTER</p>
                <h2>Private analysis. Clear controls.</h2>
                <p>TurnitPlus provides AI-writing and similarity detection with evidence you can review. This page explains what information is used, where it stays, when it is removed and the rules for using the service.</p>
              </div>
              <div className="legal-effective-date"><ShieldCheck aria-hidden="true" /><span><strong>Effective 8 August 2026</strong><small>Current product policy</small></span></div>
            </header>

            <nav className="legal-tabs" aria-label="Privacy and terms">
              <button className={legalTab === "privacy" ? "active" : ""} type="button" onClick={() => setLegalTab("privacy")}>Privacy & retention</button>
              <button className={legalTab === "terms" ? "active" : ""} type="button" onClick={() => setLegalTab("terms")}>Terms of use</button>
            </nav>

            {legalTab === "privacy" ? (
              <div className="legal-document surface-card">
                <section>
                  <span className="legal-section-number">01</span>
                  <div><h3>What TurnitPlus processes</h3><p>When you choose a document, TurnitPlus reads its text to create AI-writing and similarity reports. The original file is used during the active check. The saved report may include the extracted text, highlighted passages, scores, sources, file name and document statistics.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">02</span>
                  <div><h3>Local processing and external requests</h3><p>Document extraction, AI analysis and archive comparison run in your browser; the original file itself is never uploaded during the check. Once a check finishes, the completed report is saved both on this device (IndexedDB) and to TurnitPlus's database, so it can still be retrieved if this device's local storage is cleared or evicted. For background Wikipedia enrichment, up to 20 selected phrases may be sent to the English Wikipedia search service. Wikipedia receives those phrase queries—not the full document—and handles them under its own privacy practices. Ordinary network metadata may also be processed by the hosting infrastructure to deliver the site.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">03</span>
                  <div><h3>Account information</h3><p>Creating an account stores your email address, a display name and a securely hashed password on TurnitPlus's servers. Your password itself is never stored — only a one-way cryptographic hash used to verify future sign-ins. Signing in issues a session, held in a browser cookie, that keeps you signed in until you sign out or it expires. Signing out ends that session immediately. Using TurnitPlus without an account keeps your report history device-local, as described in the next section.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">04</span>
                  <div><h3>Report identification (no account required)</h3><p>Saving and retrieving reports does not require creating an account or signing in. Each browser is assigned a random identifier, stored locally, that TurnitPlus uses only to show you your own previously saved reports. This identifier is not a username or password and is not authentication — it behaves like an unlisted link: anyone who obtained the identifier or a specific report's address could retrieve that data. A future update may introduce real sign-in to replace it.</p></div>
                </section>

                <section className="legal-retention-section">
                  <span className="legal-section-number">05</span>
                  <div>
                    <h3>Retention rules</h3>
                    <p>Reports are kept both on your device and in TurnitPlus's database until you remove them. TurnitPlus does not apply a separate hidden retention period beyond what the table below describes.</p>
                    <div className="retention-table" role="table" aria-label="TurnitPlus retention rules">
                      <div className="retention-row retention-heading" role="row"><strong role="columnheader">Information</strong><strong role="columnheader">Where it stays</strong><strong role="columnheader">When it is removed</strong></div>
                      <div className="retention-row" role="row"><span role="cell">Original uploaded file</span><span role="cell">Browser memory during the check</span><span role="cell">When replaced, the page closes or the session ends</span></div>
                      <div className="retention-row" role="row"><span role="cell">Extracted text and reports</span><span role="cell">IndexedDB on this device, and TurnitPlus's database (linked to this browser's random identifier, not your identity)</span><span role="cell">Clear history removes both copies. Clearing this site's browser data alone removes only the local copy and this browser's identifier — the saved copy remains until removed with Clear history</span></div>
                      <div className="retention-row" role="row"><span role="cell">Random report identifier</span><span role="cell">Local browser storage</span><span role="cell">When you clear this site's browser data (after this, reports saved from this browser can no longer be retrieved or deleted through the interface)</span></div>
                      <div className="retention-row" role="row"><span role="cell">Display name and email</span><span role="cell">TurnitPlus's account database</span><span role="cell">For as long as your account exists — self-service account deletion is not yet available</span></div>
                      <div className="retention-row" role="row"><span role="cell">Password</span><span role="cell">A salted, irreversible hash is stored; the password itself is never stored or logged</span><span role="cell">For as long as your account exists</span></div>
                      <div className="retention-row" role="row"><span role="cell">Session (sign-in cookie)</span><span role="cell">An httpOnly cookie on this browser, matched to a session record in TurnitPlus's database</span><span role="cell">When you sign out, or automatically after 30 days</span></div>
                      <div className="retention-row" role="row"><span role="cell">Sidebar preference</span><span role="cell">Local browser storage</span><span role="cell">When you clear this site's browser data</span></div>
                      <div className="retention-row" role="row"><span role="cell">Wikipedia phrase results</span><span role="cell">Saved locally and remotely with the report</span><span role="cell">When you clear report history or browser site data</span></div>
                    </div>
                  </div>
                </section>

                <section>
                  <span className="legal-section-number">06</span>
                  <div><h3>Your controls</h3><p>Use Clear history to remove saved reports from both this browser and TurnitPlus's database. Use Sign out to end your active session on this device. You can also use your browser's site-data controls to remove all local TurnitPlus storage at once, though this does not reach reports already saved remotely — use Clear history first if you want both removed. The interface displays up to 50 recent reports.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">07</span>
                  <div><h3>Tracking, sale and training use</h3><p>TurnitPlus does not sell document content or account information. The product does not use advertising trackers. Documents checked in the browser are not added to a TurnitPlus training database.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">08</span>
                  <div><h3>Product stage and contact</h3><p>TurnitPlus is currently an independent university project. Paid subscriptions, server accounts and email verification are not active. A dedicated privacy contact and legal operator details will be published before public commercial billing begins.</p></div>
                </section>
              </div>
            ) : (
              <div className="legal-document surface-card">
                <section>
                  <span className="legal-section-number">01</span>
                  <div><h3>The service</h3><p>TurnitPlus provides automated AI-writing detection, Archive overlap measurement, highlighted passage evidence, source information, downloadable reports and device-local report history. Archive overlap is the percentage of submitted text matched within TurnitPlus&apos;s indexed archive; it is not an estimate of a Turnitin score or another provider&apos;s result.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">02</span>
                  <div><h3>Your responsibility</h3><p>You must have permission to process every document you upload. You are responsible for protecting confidential material, reviewing the evidence, checking citations and complying with your institution’s rules.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">03</span>
                  <div><h3>Responsible decisions</h3><p>Automated results should not be the sole basis for academic discipline, grading, employment or another decision with serious consequences. Human review of the highlighted text, sources and context is required.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">04</span>
                  <div><h3>Acceptable use</h3><p>Do not use TurnitPlus to violate privacy, copyright, access controls or applicable law; upload malicious files; interfere with the service; misrepresent a report; or use the product to harass or falsely accuse another person.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">05</span>
                  <div><h3>Reports and availability</h3><p>Results depend on the submitted text, supported file extraction, available comparison sources and successful browser processing. The service may change, pause or become unavailable. Keep copies of any report you need; local browser history can be deleted by you or your browser.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">06</span>
                  <div><h3>Subscriptions</h3><p>The displayed $20 monthly Unlimited plan is a coming-soon preview. No subscription, recurring payment or unlimited entitlement begins until a real checkout explicitly presents the price and you confirm payment.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">07</span>
                  <div><h3>Ownership</h3><p>You retain your rights in documents you are authorized to use. TurnitPlus branding, interface and software remain the property of their respective owner. Third-party source titles, links and content remain subject to their own rights and terms.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">08</span>
                  <div><h3>Warranty and liability</h3><p>TurnitPlus is provided on an “as available” basis. To the extent permitted by law, no guarantee is made that every source, AI-written passage or similarity will be detected. Liability is limited to the extent allowed by applicable law, and mandatory consumer rights are not excluded.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">09</span>
                  <div><h3>Changes</h3><p>These terms may be updated as accounts, subscriptions and comparison coverage evolve. The effective date at the top of this page identifies the current version.</p></div>
                </section>
              </div>
            )}
          </section>
        )}

        {view === "result" && currentReport && (
          <section className="result-view">
            <header className="result-toolbar">
              <button className="back-button" type="button" onClick={() => navigate("reports")}>
                <ArrowLeft aria-hidden="true" />
                Back to reports
              </button>
              <div className="result-document">
                <FileText aria-hidden="true" />
                <div>
                  <h1>{currentReport.title}</h1>
                  <p>Generated {reportDate} · Submission ID {currentReport.submissionId}</p>
                </div>
              </div>
            </header>

            <div className="report-summary-strip">
              <div>
                <strong className={`summary-chip summary-score-chip ${reportMode === "ai" ? `ai-summary-chip ai-summary-${currentAiSignal?.tone ?? "unavailable"}` : currentSimilarityVerdict ? `summary-verdict-${currentSimilarityVerdict.key}` : ""}`}>
                  <span className={`score-dot ${reportMode === "ai" ? `ai-dot ai-dot-${currentAiSignal?.tone ?? "unavailable"}` : currentSimilarityVerdict ? `score-dot-${currentSimilarityVerdict.key}` : ""}`} />
                  {reportMode === "ai"
                    ? (currentAiSignal
                      ? `${currentAiSignal.value === null ? "" : `${currentAiSignal.value}% · `}${currentAiSignal.label}`
                      : "AI report unavailable")
                    : `${currentArchiveOverlap}% Archive overlap`}
                </strong>
                {reportMode === "similarity" && <span className="summary-chip">Matched against {archiveScopeCount(currentReport).toLocaleString()} indexed documents</span>}
                {reportMode === "similarity" && <span className="summary-chip">{currentReport.sources.length} archive sources</span>}
                {reportMode === "similarity" && (currentReport.webCheck?.phrasesMatched ?? 0) > 0 && <span className="summary-chip wikipedia-evidence-chip"><Globe2 aria-hidden="true" /> Separate Wikipedia evidence</span>}
                {reportMode === "ai" && <span className="summary-chip">English only</span>}
              </div>
              <div>
                <span className="summary-chip">{currentReport.wordCount.toLocaleString()} words</span>
                <span className="summary-chip">{currentReport.pageCount} pages</span>
                <span className="summary-chip">{currentReport.characterCount.toLocaleString()} characters</span>
                <span className="summary-chip">{currentReport.corpusVersion}</span>
              </div>
            </div>

            <nav className="report-tabs" aria-label="Report sections">
              {reportMode === "ai" ? (
                <button className="active" type="button">AI report</button>
              ) : (
                <>
                  <button className={resultTab === "full" ? "active" : ""} type="button" onClick={() => setResultTab("full")}>Full report</button>
                  <button className={resultTab === "overview" ? "active" : ""} type="button" onClick={() => setResultTab("overview")}>Integrity overview</button>
                  <button className={resultTab === "submission" ? "active" : ""} type="button" onClick={() => setResultTab("submission")}>Submission</button>
                  <button className={resultTab === "sources" ? "active" : ""} type="button" onClick={() => setResultTab("sources")}>Source details</button>
                </>
              )}
            </nav>

            <div className="report-workspace">
              {reportMode === "ai" ? (
                <AiReport
                  report={currentReport}
                  isRunning={isRunningAiAnalysis}
                  progressLabel={aiProgressLabel}
                  onRetry={() => void runAiAnalysis(currentReport)}
                />
              ) : (
                <>
                  {resultTab === "full" && (
                    <div className="full-report-preview">
                      <OverviewReport report={currentReport} />
                      <SubmissionReport report={currentReport} />
                      <SourcesReport report={currentReport} />
                    </div>
                  )}
                  {resultTab === "overview" && <OverviewReport report={currentReport} />}
                  {resultTab === "submission" && <SubmissionReport report={currentReport} />}
                  {resultTab === "sources" && <SourcesReport report={currentReport} />}
                </>
              )}

              <aside className="report-inspector">
                <div className={`inspector-score ${reportMode === "ai" && currentAiSignal ? `ai-signal-card-${currentAiSignal.tone}` : reportMode === "similarity" && currentSimilarityVerdict ? `similarity-verdict-${currentSimilarityVerdict.key}` : ""}`}>
                  <span>{reportMode === "ai" ? "AI writing score" : `Archive overlap · ${archiveScopeCount(currentReport)} docs`}</span>
                  <strong>{reportMode === "ai" ? (currentAiSignal?.value === null ? "—" : `${currentAiSignal?.value ?? 0}%`) : `${currentArchiveOverlap}%`}</strong>
                  {reportMode === "ai" && currentAiSignal && <p className="inspector-writing-estimate">{currentAiSignal.label}</p>}
                  {reportMode === "similarity" && currentSimilarityVerdict && <em>{SIMILARITY_BAND_LABELS[currentSimilarityVerdict.key]}</em>}
                  {reportMode === "similarity" && <div><i style={{ width: `${currentArchiveOverlap * 5}%` }} /></div>}
                </div>
                {reportMode === "similarity" && <div className="inspector-section">
                  <h3>Top source types</h3>
                  <CategorySummary report={currentReport} />
                </div>}
                <div className="inspector-section">
                  <h3>Report notes</h3>
                  {reportMode === "ai" ? <p>
                    English-only local analysis. {currentReport.aiAnalysis?.status === "complete"
                      ? `${currentReport.aiAnalysis.analyzedWordCount.toLocaleString()} words analyzed. Review the AI writing score and highlighted passage breakdown.`
                      : "A numeric result requires at least 300 eligible English words and a successful local model load."}
                  </p> : <p>
                    Archive overlap measures the percentage of this document found within TurnitPlus&apos;s {archiveScopeCount(currentReport).toLocaleString()} indexed documents. It is not an estimate of a Turnitin score.
                    {" "}{archiveMatchedWordCount(currentReport).toLocaleString()} words were matched across {currentReport.sources.length} retained source{currentReport.sources.length === 1 ? "" : "s"}.
                    {(currentReport.webCheck?.phrasesMatched ?? 0) > 0 && ` Wikipedia evidence is shown separately and does not change Archive overlap.`}
                    {" "}Language detected: {currentReport.features.detectedLanguage}. Longest matched span: {currentReport.features.longestMatchedSpan} words. Archive: {currentReport.corpusVersion}.
                  </p>}
                </div>
              </aside>
            </div>

            <div className="print-report-bundle">
              {reportMode === "ai" ? <AiReport report={currentReport} printMode /> : <>
                  <OverviewReport report={currentReport} />
                  <SubmissionReport report={currentReport} />
                  <SourcesReport report={currentReport} />
                </>}
            </div>

            <div className="download-report-dock">
              <div>
                <strong>Full report</strong>
                <span>Save a PDF copy</span>
              </div>
              <button className="download-report-fab" type="button" onClick={() => window.print()}>
                <Printer aria-hidden="true" />
                Download
              </button>
            </div>
          </section>
        )}

        {view !== "result" && view !== "processing" && (
          <footer className="site-legal-footer">
            <div><strong>TurnitPlus</strong><span>Private AI & similarity detection</span></div>
            <nav aria-label="Legal information">
              <button type="button" onClick={() => openLegalPage("privacy")}>Privacy & retention</button>
              <button type="button" onClick={() => openLegalPage("terms")}>Terms of use</button>
            </nav>
          </footer>
        )}
      </main>

      <div className={`toast ${toast ? "show" : ""}`} role="status">{toast}</div>
    </div>
  );
}
