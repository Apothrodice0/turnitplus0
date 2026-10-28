"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * ENGLISH SYSTEM 2 — owner-only "Estimated Turnitin-like similarity" (research). Rendered ONLY when the server page
 * resolved `system2Enabled` for the signed-in owner (lib/system2-research.ts); ordinary customers never mount any of
 * this and never trigger a request.
 *
 * Runs automatically as part of the room's normal analysis, right after the report is saved, using the SAME uploaded
 * Word file — but only if the owner ticked the consent option in the upload form before clicking Analyze. The document
 * is sent once, only to this report's owner-gated endpoint; the result (numbers and caveat text, never document content)
 * is kept on this device. It is a separate statistical estimate: it never changes, replaces or adds to the System 1
 * similarity score or the AI result.
 */

export type System2Estimate = {
  state: string;
  estimate_shown: boolean;
  final_text: string;
  conservative_estimate_percent?: number;
  warnings?: string[];
};
export type System2View = { status: "running" } | { status: "done"; result: System2Estimate } | { status: "not-requested" } | null;

const resultKey = (reportId: string) => `tp:s2-estimate:${reportId}`;
const CONSENT_KEY = "tp:s2-consent";
const MAX_BYTES = 4_000_000;
const extensionOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
const unavailable = (state: string, final_text: string): System2Estimate => ({ state, estimate_shown: false, final_text });

export function loadSystem2Estimate(reportId: string): System2Estimate | null {
  try {
    const raw = localStorage.getItem(resultKey(reportId));
    return raw ? (JSON.parse(raw) as System2Estimate) : null;
  } catch {
    return null;
  }
}
function storeSystem2Estimate(reportId: string, result: System2Estimate) {
  try {
    localStorage.setItem(resultKey(reportId), JSON.stringify(result));
  } catch {
    /* storage unavailable: the result is still shown for this session */
  }
}
export function loadSystem2Consent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}
export function storeSystem2Consent(granted: boolean) {
  try {
    if (granted) localStorage.setItem(CONSENT_KEY, "granted");
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* ignore */
  }
}

/** The one automatic request, made by the room right after its report is saved. Never throws; never invents a score. */
export async function requestSystem2Estimate(reportId: string, file: File): Promise<System2Estimate> {
  let result: System2Estimate;
  if (extensionOf(file.name) !== ".docx") {
    result = unavailable("UNSUPPORTED_FILE_TYPE", "Estimate unavailable: System 2 accepts English Word (.docx) manuscripts only. The document was not sent.");
  } else if (file.size > MAX_BYTES) {
    result = unavailable("TOO_LARGE", "Estimate unavailable: the file is larger than 4 MB. The document was not sent.");
  } else {
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/system2`, {
        method: "POST",
        headers: { "x-s2-consent": "granted", "x-file-extension": ".docx", "content-type": "application/octet-stream" },
        body: await file.arrayBuffer(),
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as System2Estimate | null;
      result = body && typeof body.final_text === "string" && typeof body.estimate_shown === "boolean"
        ? body
        : unavailable("UNAVAILABLE", "Estimate unavailable: the System 2 service did not return a result.");
    } catch {
      result = unavailable("UNAVAILABLE", "Estimate unavailable: the System 2 service could not be reached.");
    }
  }
  storeSystem2Estimate(reportId, result);
  return result;
}

/** Consent + disclosure, shown inside the existing upload form (owner only), before the single Analyze click. */
export function System2ConsentOption({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="s2-consent-option">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>Also estimate Turnitin-like similarity (System 2, research)</strong>
        This sends the Word document once to TurnitPlus&apos;s private System 2 service, where it is processed in memory and not
        stored. Similarity and AI analysis still run in your browser as usual.
      </span>
    </label>
  );
}

/** The summary tile beside Similarity and AI in the existing room report card. */
export function System2MetricTile({ view, reportId, room }: { view: System2View; reportId: string; room: number }) {
  if (view?.status === "done" && view.result.estimate_shown) {
    return (
      <Link href={`/reports/${reportId}?room=${room}`} className="room-metric s2-estimate-tile s2-metric">
        <span className="room-metric-label">Estimated Turnitin-like</span>
        <strong className="room-metric-value">{view.result.conservative_estimate_percent}%</strong>
        <span className="room-metric-sub">Statistical estimate</span>
      </Link>
    );
  }
  if (view?.status === "running") {
    return (
      <div className="room-metric room-metric-pending s2-metric">
        <span className="room-metric-label">Estimated Turnitin-like</span>
        <strong className="room-metric-value">···</strong>
        <span className="room-metric-sub">Estimating…</span>
      </div>
    );
  }
  return (
    <div className="room-metric room-metric-unavailable s2-metric" title={view?.status === "done" ? view.result.final_text : undefined}>
      <span className="room-metric-label">Estimated Turnitin-like</span>
      <strong className="room-metric-value">—</strong>
      <span className="room-metric-sub">{view?.status === "not-requested" ? "Not requested" : "Estimate unavailable"}</span>
    </div>
  );
}

export const SYSTEM2_ROOM_NOTE =
  "Estimated Turnitin-like similarity is a research-only statistical estimate (0–20%), not a verified Turnitin result. It is shown separately and never added to the similarity score.";

/** Read-only detail on the report page: the estimate and its caveats, from this device's stored result. */
export function System2EstimateDetail({ reportId }: { reportId: string }) {
  const [result, setResult] = useState<System2Estimate | null>(null);
  useEffect(() => setResult(loadSystem2Estimate(reportId)), [reportId]); // device storage is read after hydration
  const sentences = (result?.final_text ?? "").split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean);
  return (
    <section className="s2-estimate-detail" aria-label="Estimated Turnitin-like similarity">
      <div className="s2-estimate-detail-head">
        <span className="summary-chip">Estimated Turnitin-like similarity</span>
        <strong>{result?.estimate_shown ? `${result.conservative_estimate_percent}%` : "Estimate unavailable"}</strong>
        <span className="s2-estimate-detail-kind">Statistical estimate · research only · not added to the similarity score</span>
      </div>
      {result ? (
        <ul>
          {sentences.map((s, i) => <li key={i}>{s}</li>)}
          {(result.warnings ?? []).map((w, i) => <li key={`w${i}`}>{w}</li>)}
        </ul>
      ) : (
        <p>No System 2 estimate is stored for this report on this device.</p>
      )}
    </section>
  );
}
