"use client";

import { useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import type { System2EstimateRecord } from "@/lib/system2-unified";

/**
 * ENGLISH SYSTEM 2 — runs behind the scenes inside the normal analysis, owner-only (provisional, protected Preview).
 * Everything here is mounted ONLY when the server page resolved `system2Enabled` for the signed-in owner
 * (lib/system2-research.ts); ordinary customers never mount it and never trigger a request.
 *
 * No separate System 2 feature is shown: the estimate only feeds the ONE similarity percentage
 * (lib/system2-unified.ts). Because it is the one step that sends the document off the browser, it needs a one-time,
 * informed authorization per account (asked once, at first use, in the room; withdrawable from the upload form's
 * privacy line). Without it nothing is ever sent. The returned result (numbers and caveat text, never document
 * content) is kept on this device, keyed by report.
 */

const resultKey = (reportId: string) => `tp:s2-estimate:${reportId}`;
const authorizationKey = (accountEmail: string) => `tp:s2-authorization:v1:${accountEmail.trim().toLowerCase()}`;
const ESTIMATE_EVENT = "tp:s2-estimate";
const MAX_BYTES = 4_000_000;
const extensionOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
const unavailable = (state: string, final_text: string): System2EstimateRecord => ({ state, estimate_shown: false, final_text });

export type System2Authorization = "granted" | "declined" | null;

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

export function loadSystem2Authorization(accountEmail: string): System2Authorization {
  try {
    const raw = localStorage.getItem(authorizationKey(accountEmail));
    const decision = raw ? (JSON.parse(raw) as { decision?: string }).decision : null;
    return decision === "granted" || decision === "declined" ? decision : null;
  } catch {
    return null;
  }
}
export function storeSystem2Authorization(accountEmail: string, decision: System2Authorization) {
  try {
    if (decision) localStorage.setItem(authorizationKey(accountEmail), JSON.stringify({ decision, at: new Date().toISOString(), disclosure: "v1" }));
    else localStorage.removeItem(authorizationKey(accountEmail));
  } catch {
    /* ignore: without stored authorization nothing is sent */
  }
}

/** The one automatic request, made by the room right after its report is saved — only for an authorized account. Never throws; never invents a score. */
export async function requestSystem2Estimate(reportId: string, file: File): Promise<System2EstimateRecord> {
  let result: System2EstimateRecord;
  if (extensionOf(file.name) !== ".docx") {
    result = unavailable("UNSUPPORTED_FILE_TYPE", "System 2 accepts English Word (.docx) manuscripts only. The document was not sent.");
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
        : unavailable("UNAVAILABLE", "The System 2 service did not return a result.");
    } catch {
      result = unavailable("UNAVAILABLE", "The System 2 service could not be reached.");
    }
  }
  storeSystem2Estimate(reportId, result);
  return result;
}

/** One-time onboarding disclosure + authorization, shown in the room until this account answers it. */
export function System2AuthorizationNotice({ onDecide }: { onDecide: (decision: "granted" | "declined") => void }) {
  return (
    <section className="s2-auth-notice" aria-labelledby="s2-auth-title">
      <h3 id="s2-auth-title">Server-assisted similarity (one-time authorization)</h3>
      <p>
        For English Word (.docx) documents, TurnitPlus can also send the document once, after your report is saved, to its
        private estimation service. It is processed in memory and not stored, and its statistical estimate is used only
        in your similarity percentage. Other files, AI analysis and source matching stay in your browser as usual.
      </p>
      <div className="s2-auth-actions">
        <button type="button" className="button primary" onClick={() => onDecide("granted")}>Allow</button>
        <button type="button" className="button secondary" onClick={() => onDecide("declined")}>Not now</button>
      </div>
    </section>
  );
}

/** The upload form's privacy line for an account that decided — truthful about the transmission, with a way to change it. */
export function System2PrivacyNote({ authorization, onChange }: { authorization: "granted" | "declined"; onChange: () => void }) {
  return (
    <p className="privacy-note">
      <LockKeyhole aria-hidden="true" />{" "}
      {authorization === "granted"
        ? "Documents are processed in your browser; English Word documents are also sent once to TurnitPlus's private estimation service (not stored)."
        : "Documents are processed in your browser."}{" "}
      <button type="button" className="s2-privacy-change" onClick={onChange}>{authorization === "granted" ? "Withdraw" : "Review server-assisted similarity"}</button>
    </p>
  );
}
