"use client";

import { useEffect, useState } from "react";
import type { System2EstimateRecord } from "@/lib/system2-unified";

/**
 * ENGLISH SYSTEM 2 — runs behind the scenes inside the normal analysis. The request below is made ONLY when the room
 * page resolved `system2Enabled` on the server (lib/system2-access.ts: administrators, the owner allowlist, verified
 * customers with an active subscription in a room of their plan); every other account never triggers one, and the
 * route refuses it anyway.
 *
 * No separate System 2 feature is shown: the estimate only feeds the ONE similarity percentage
 * (lib/system2-unified.ts). It runs automatically for the eligible account's own Word documents (owner decision
 * 2026-10-30: no consent card or dialog — covered by the privacy policy). The server stores an accepted estimate with
 * the report itself (lib/system2-estimate-record.ts); nothing is kept in the browser. No internal name, model or
 * research detail is shown.
 */

const ESTIMATE_EVENT = "tp:s2-estimate";
const MAX_BYTES = 4_000_000;
const extensionOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
const unavailable = (state: string, final_text: string): System2EstimateRecord => ({ state, estimate_shown: false, final_text });

/** Tells the views already open on this page that the server has just STORED this report's estimate. */
function announceStoredEstimate(reportId: string, result: System2EstimateRecord) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ESTIMATE_EVENT, { detail: { reportId, result } }));
}

/**
 * The estimate the server stored for this report during THIS page's life (null until then). Every later read — a refresh,
 * another device, the report page, the receipt — takes the stored copy from the report itself; this only spares the
 * room tile from waiting for its next server read. Nothing is kept in the browser.
 */
export function useSystem2Estimate(reportId: string | null | undefined, enabled: boolean): System2EstimateRecord | null {
  const [state, setState] = useState<{ reportId: string; result: System2EstimateRecord } | null>(null);
  useEffect(() => {
    if (!enabled || !reportId) return;
    const onEstimate = (event: Event) => {
      const detail = (event as CustomEvent<{ reportId: string; result: System2EstimateRecord }>).detail;
      if (detail?.reportId === reportId) setState({ reportId, result: detail.result });
    };
    window.addEventListener(ESTIMATE_EVENT, onEstimate);
    return () => window.removeEventListener(ESTIMATE_EVENT, onEstimate);
  }, [reportId, enabled]);
  return enabled && state && state.reportId === reportId ? state.result : null;
}

/** Tells the server that this check's file was kept in the browser (no document is sent), so it is recorded as ineligible. */
function reportNotSent(reportId: string, state: "UNSUPPORTED_FILE_TYPE" | "TOO_LARGE") {
  void fetch(`/api/reports/${encodeURIComponent(reportId)}/system2`, {
    method: "POST",
    headers: { "x-s2-consent": "granted", "x-s2-not-sent": state },
    cache: "no-store",
    credentials: "same-origin",
  }).catch(() => undefined);
}

/** The one automatic request, made by the room right after its report is saved — only for an eligible account. Never throws; never invents a score. */
export async function requestSystem2Estimate(reportId: string, file: File): Promise<System2EstimateRecord> {
  let result: System2EstimateRecord;
  if (extensionOf(file.name) !== ".docx") {
    result = unavailable("UNSUPPORTED_FILE_TYPE", "Additional analysis is available for Word (.docx) documents only. The document was not sent.");
    reportNotSent(reportId, "UNSUPPORTED_FILE_TYPE");
  } else if (file.size > MAX_BYTES) {
    result = unavailable("TOO_LARGE", "The file is larger than 4 MB. The document was not sent.");
    reportNotSent(reportId, "TOO_LARGE");
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
  // Only an estimate the server confirms it STORED with the report counts, so this page never shows a figure that a
  // refresh, another device or the receipt would not show too. Anything else leaves System 1's result.
  if (result.estimate_shown && (result as { persisted?: unknown }).persisted === true) announceStoredEstimate(reportId, result);
  return result;
}
