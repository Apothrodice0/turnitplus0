import { getDeviceKey } from "./device-key";

export type ReportSummary = {
  id: string;
  submissionId: string;
  title: string;
  createdAt: string;
  wordCount: number;
  archiveScore: number;
  scoreBand: string;
  aiScore: number | null;
  aiTone: string | null;
};

// Report history is a summary index. Full payloads are fetched only when a
// report room is opened. This prevents the history screen from doing an N+1
// waterfall of /api/reports/:id requests for every saved report.
const summaryCache = new Map<string, ReportSummary>();

type LightweightReport = {
  __summaryOnly: true;
  version: 11;
  id: number;
  submissionId: string;
  title: string;
  author: string;
  assignment: string;
  created: string;
  score: number;
  archiveScore: number;
  aiScore: number | null;
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
  sources: [];
  repeats: [];
  text: string;
};

function scoreBand(value: number): "Low" | "Moderate" | "High" {
  if (value >= 50) return "High";
  if (value >= 20) return "Moderate";
  return "Low";
}

function summaryToLightweightReport(summary: ReportSummary): LightweightReport {
  const archiveScore = Number.isFinite(summary.archiveScore) ? summary.archiveScore : 0;
  const id = Number(summary.id);
  return {
    __summaryOnly: true,
    version: 11,
    id: Number.isFinite(id) ? id : 0,
    submissionId: summary.submissionId,
    title: summary.title,
    author: "",
    assignment: "",
    created: summary.createdAt,
    score: archiveScore,
    archiveScore,
    aiScore: summary.aiScore,
    wordCount: summary.wordCount,
    characterCount: 0,
    pageCount: 0,
    fileSize: "—",
    databaseSize: 0,
    corpusVersion: "",
    scoreBand: scoreBand(archiveScore),
    riskStatus: archiveScore >= 50 ? "Elevated" : "Lower",
    riskTarget: 0,
    riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: {
      maxSourceContainment: 0,
      longestMatchedSpan: 0,
      quotationDensity: 0,
      referenceListRatio: 0,
      highFrequencyShingleCount: 0,
      repeatedThreeGramCount: 0,
      detectedLanguage: "English",
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: "",
  };
}

// Every function here is fail-soft by design: a network or database problem
// must never interrupt analysis or block the existing local (IndexedDB) flow.

export type SaveReportRemoteResult =
  | { ok: true }
  | { ok: false; status: number; quotaExceeded: boolean; error?: string; resetsAt?: string };

export async function saveReportRemote<T>(report: T, summary: ReportSummary, academicSearchDiagnosticsId?: number | null): Promise<SaveReportRemoteResult> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceKey, ...summary, payload: report, academicSearchDiagnosticsId: academicSearchDiagnosticsId ?? null }),
    });
    if (!response.ok) {
      console.debug("Remote report save was rejected (local copy is unaffected).", { status: response.status });
      const body = (await response.json().catch(() => null)) as { error?: string; resetsAt?: string } | null;
      const quotaExceeded = response.status === 429 && typeof body?.resetsAt === "string";
      return { ok: false, status: response.status, quotaExceeded, error: body?.error, resetsAt: body?.resetsAt };
    }
    summaryCache.set(summary.id, summary);
    return { ok: true };
  } catch (error) {
    console.debug("Remote report save failed (local copy is unaffected).", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: 0, quotaExceeded: false };
  }
}

export type UploadLimitStatus =
  | { authenticated: false }
  | { authenticated: true; unlimited: true }
  | { authenticated: true; unlimited: false; uploadsToday: number; limit: number };

export async function fetchUploadLimitStatus(): Promise<UploadLimitStatus> {
  try {
    const response = await fetch("/api/upload-limit");
    if (!response.ok) return { authenticated: false };
    const data = (await response.json()) as UploadLimitStatus;
    return data.authenticated ? data : { authenticated: false };
  } catch (error) {
    console.debug("Upload limit status fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { authenticated: false };
  }
}

export async function listRemoteReportSummaries(): Promise<ReportSummary[]> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports?deviceKey=${encodeURIComponent(deviceKey)}`, { cache: "no-store" });
    if (!response.ok) return [];
    const data = (await response.json()) as { reports?: ReportSummary[] };
    const summaries = Array.isArray(data.reports) ? data.reports : [];
    summaryCache.clear();
    for (const summary of summaries) summaryCache.set(summary.id, summary);
    return summaries;
  } catch (error) {
    console.debug("Remote report list fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Full payloads are reserved for report-room/detail consumers. History callers
 * get a tiny in-memory report-shaped summary so existing list rendering and
 * receipt generation do not trigger one request per row.
 */
export async function fetchRemoteReport<T>(id: string, forceFull = false): Promise<T | null> {
  if (!forceFull) {
    const summary = summaryCache.get(id);
    if (summary) return summaryToLightweightReport(summary) as T;
  }
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { payload?: T };
    return (data.payload ?? null) as T | null;
  } catch (error) {
    console.debug("Remote report fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function deleteRemoteReport(id: string): Promise<void> {
  try {
    const deviceKey = getDeviceKey();
    await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`, { method: "DELETE" });
    summaryCache.delete(id);
  } catch (error) {
    console.debug("Remote report delete failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function deleteRemoteReportChecked(id: string): Promise<boolean> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`, { method: "DELETE" });
    if (response.ok) summaryCache.delete(id);
    return response.ok;
  } catch (error) {
    console.debug("Remote report delete failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
