"use client";

import { useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import type { System2EstimateRecord } from "@/lib/system2-unified";

/**
 * ENGLISH SYSTEM 2 — runs behind the scenes inside the normal analysis, owner-only (provisional, protected Preview).
 * Everything here is mounted ONLY when the server page resolved `system2Enabled` for the signed-in owner
 * (lib/system2-research.ts); ordinary customers never mount it and never trigger a request.
 *
 * No separate System 2 feature is shown: the estimate only feeds the ONE similarity percentage
 * (lib/system2-unified.ts). Because it is the one step that sends the document off the browser, it needs a one-time,
 * informed authorization per account: a small dialog asked only when it is actually needed — the first time a Word
 * document is checked while no decision is recorded — and never again once answered (changeable from the upload
 * form's privacy line; "Browser only" keeps the verified browser result alone). Without it nothing is ever sent. The
 * returned result (numbers and caveat text, never document content) is kept on this device, keyed by report. No
 * internal name, model or research detail is shown.
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

/**
 * The one-time permission, as a small dialog opened by Generate report only when it is needed (a Word document and no
 * recorded decision). Either answer is recorded and the check then starts; closing it starts nothing and records nothing.
 */
export function System2PermissionDialog({ onDecide, onCancel }: { onDecide: (decision: "granted" | "declined") => void; onCancel: () => void }) {
  const allowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    allowRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="email-verify-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="email-verify-modal surface-card s2-permission"
        role="dialog"
        aria-modal="true"
        aria-labelledby="s2-permission-title"
        aria-describedby="s2-permission-text"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="s2-permission-title">Allow additional analysis?</h2>
        <p id="s2-permission-text" className="email-verify-modal-lead">
          To refine your similarity percentage, TurnitPlus can securely analyse this Word document on its servers once your
          report is saved. The document isn&apos;t stored. You can change this at any time below the upload area.
        </p>
        <div className="s2-permission-actions">
          <button ref={allowRef} type="button" className="button primary" onClick={() => onDecide("granted")}>Allow</button>
          <button type="button" className="button secondary" onClick={() => onDecide("declined")}>Browser only</button>
        </div>
      </div>
    </div>
  );
}

/** The upload form's privacy line once a decision is recorded — truthful about where the document goes, with a way to change it. */
export function System2PrivacyNote({ authorization, onChange }: { authorization: "granted" | "declined"; onChange: () => void }) {
  return (
    <p className="privacy-note">
      <LockKeyhole aria-hidden="true" />{" "}
      {authorization === "granted"
        ? "Documents are processed in your browser; Word documents are also analysed securely by TurnitPlus (not stored)."
        : "Documents are processed in your browser."}{" "}
      <button type="button" className="s2-privacy-change" onClick={onChange}>{authorization === "granted" ? "Stop" : "Change"}</button>
    </p>
  );
}
