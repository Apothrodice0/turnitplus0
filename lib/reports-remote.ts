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

// Every function here is fail-soft by design: a network or database problem
// must never interrupt analysis or block the existing local (IndexedDB)
// flow. Failures are logged at debug level and otherwise swallowed.

export async function saveReportRemote<T>(report: T, summary: ReportSummary): Promise<void> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceKey, ...summary, payload: report }),
    });
    if (!response.ok) {
      console.debug("Remote report save was rejected (local copy is unaffected).", { status: response.status });
    }
  } catch (error) {
    console.debug("Remote report save failed (local copy is unaffected).", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listRemoteReportSummaries(): Promise<ReportSummary[]> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports?deviceKey=${encodeURIComponent(deviceKey)}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { reports?: ReportSummary[] };
    return Array.isArray(data.reports) ? data.reports : [];
  } catch (error) {
    console.debug("Remote report list fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function fetchRemoteReport<T>(id: string): Promise<T | null> {
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
