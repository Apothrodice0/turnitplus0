"use client";

import { useEffect, useState } from "react";
import type { System2EstimateRecord } from "@/lib/system2-unified";

/**
 * ENGLISH SYSTEM 2 — runs behind the scenes inside the normal analysis, owner-only (provisional, protected Preview).
 * Everything here is mounted ONLY when the server page resolved `system2Enabled` for the signed-in owner
 * (lib/system2-research.ts); ordinary customers never mount it and never trigger a request.
 *
 * No separate System 2 feature is shown: the estimate only feeds the ONE similarity percentage
 * (lib/system2-unified.ts). It runs automatically for the allowlisted owner's own Word documents (owner decision
 * 2026-10-30: no consent card or dialog — covered by the privacy policy); no customer account ever sends anything. The
 * returned result (numbers and caveat text, never document content) is kept on this device, keyed by report. No
 * internal name, model or research detail is shown.
 */

const resultKey = (reportId: string) => `tp:s2-estimate:${reportId}`;
const ESTIMATE_EVENT = "tp:s2-estimate";
const MAX_BYTES = 4_000_000;
const extensionOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
const unavailable = (state: string, final_text: string): System2EstimateRecord => ({ state, estimate_shown: false, final_text });

export function loadSystem2Estimate(reportId: string): System2EstimateRecord | null {
  try {
    const raw = localStorage.getItem(resultKey(reportId));
    return raw ? (JSON.parse(raw) as System2EstimateRecord) : null;
  } catch {
    return null;
  }
}
function storeSystem2Estimate(reportId: string, result: System2EstimateRecord) {
  try {
    localStorage.setItem(resultKey(reportId), JSON.stringify(result));
  } catch {
    /* storage unavailable: the result still reaches open views through the event below */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ESTIMATE_EVENT, { detail: { reportId, result } }));
}

/** This report's stored estimate (read after hydration), kept current when the automatic request completes. */
export function useSystem2Estimate(reportId: string | null | undefined, enabled: boolean): System2EstimateRecord | null {
  const [state, setState] = useState<{ reportId: string; result: System2EstimateRecord | null } | null>(null);
  useEffect(() => {
    if (!enabled || !reportId) return;
    setState({ reportId, result: loadSystem2Estimate(reportId) });
    const onEstimate = (event: Event) => {
      const detail = (event as CustomEvent<{ reportId: string; result: System2EstimateRecord }>).detail;
      if (detail?.reportId === reportId) setState({ reportId, result: detail.result });
    };
    window.addEventListener(ESTIMATE_EVENT, onEstimate);
    return () => window.removeEventListener(ESTIMATE_EVENT, onEstimate);
  }, [reportId, enabled]);
  return enabled && state && state.reportId === reportId ? state.result : null;
}

/** The one automatic request, made by the room right after its report is saved — only for the allowlisted owner. Never throws; never invents a score. */
export async function requestSystem2Estimate(reportId: string, file: File): Promise<System2EstimateRecord> {
  let result: System2EstimateRecord;
  if (extensionOf(file.name) !== ".docx") {
    result = unavailable("UNSUPPORTED_FILE_TYPE", "Additional analysis is available for Word (.docx) documents only. The document was not sent.");
  } else if (file.size > MAX_BYTES) {
    result = unavailable("TOO_LARGE", "The file is larger than 4 MB. The document was not sent.");
  } else {
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/system2`, {
        method: "POST",
        headers: { "x-s2-consent": "granted", "x-file-extension": ".docx", "content-type": "application/octet-stream" },
        body: await file.arrayBuffer(),
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as System2EstimateRecord | null;
      result = body && typeof body.final_text === "string" && typeof body.estimate_shown === "boolean"
        ? body
        : unavailable("UNAVAILABLE", "Additional analysis did not return a result.");
    } catch {
      result = unavailable("UNAVAILABLE", "Additional analysis could not be reached.");
    }
  }
  storeSystem2Estimate(reportId, result);
  return result;
}
