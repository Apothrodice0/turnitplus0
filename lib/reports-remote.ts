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

// Authenticated report lists are deliberately summary-only. The old client
// hydrated every report immediately after fetching the list, which turned a
// 40-report history page into 40 sequential full-payload requests. The cache
// below lets that existing caller keep its shape without fetching any report
// body; a report room asks for the full payload explicitly via forceFull.
const summaryCache = new Map<string, ReportSummary>();
let summaryCacheMode: "authenticated" | "anonymous" | null = null;

// Every function here is fail-soft by design: a network or database problem
// must never interrupt analysis or block the existing local (IndexedDB)
// flow. Failures are logged at debug level and otherwise swallowed.

export type SaveReportRemoteResult =
  | { ok: true }
  /**
   * status 0 means the request never completed (network/DB error) — the
   * existing fail-soft case, where the local copy is the only signal that
   * matters and the caller has never needed to react to a value. status 429
   * with quotaExceeded is new and different: it is not transient, so
   * generateReport() surfaces it to the user instead of treating it like
   * every other silent remote-save failure.
   */
  | { ok: false; status: number; quotaExceeded: boolean; error?: string; resetsAt?: string };

/**
 * `academicSearchDiagnosticsId` is sent as a sibling of `payload`, never
 * nested inside it — it must never become part of SimilarityReport/
 * saved_reports.payload_json. It is only ever a bare row id (see
 * app/api/academic-evidence/route.ts's own header comment for why the raw
 * diagnostic content itself is persisted server-side and never sent to this
 * client at all) — app/api/reports/route.ts uses it to link that
 * already-persisted row to this report, once both exist.
 */
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
    const response = await fetch(`/api/reports?deviceKey=${encodeURIComponent(deviceKey)}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { reports?: ReportSummary[]; authenticated?: boolean };
    const summaries = Array.isArray(data.reports) ? data.reports : [];
    summaryCacheMode = data.authenticated === true ? "authenticated" : "anonymous";
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
 * Fetch one report room payload. During authenticated report-history
 * hydration, the summary already in summaryCache is returned immediately;
 * this removes the old N sequential full-payload fetches. Pass forceFull=true
 * from a report room (or another surface that genuinely needs the document
 * payload).
 */
export async function fetchRemoteReport<T>(id: string, forceFull = false): Promise<T | null> {
  if (!forceFull && summaryCacheMode === "authenticated") {
    const summary = summaryCache.get(id);
    if (summary) return summary as T;
  }
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`);
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
    return response.ok;
  } catch (error) {
    console.debug("Remote report delete failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
