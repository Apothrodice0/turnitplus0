"use client";

import { useEffect, useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";

/**
 * ENGLISH SYSTEM 2 — owner-only research panel. Rendered ONLY when the server page resolved `system2Enabled` for the
 * signed-in owner account (see lib/system2-research.ts); ordinary customers never mount it and never trigger a request.
 *
 * Uses the manuscript already uploaded to this room when it is a .docx (`uploadedFile`), otherwise lets the owner pick
 * the same Word file. The document is sent only after the explicit consent checkbox, and only to this report's own
 * owner-gated endpoint. The result is kept in this tab's sessionStorage (numbers and caveat text only — never document
 * content) and never changes the System 1 similarity, AI result or the saved report.
 */

type Result = {
  state: string;
  estimate_shown: boolean;
  final_text: string;
  label?: string;
  conservative_estimate_percent?: number;
  warnings?: string[];
  diagnostics?: Record<string, unknown>;
};

const MAX_BYTES = 4_000_000;
const LABEL = "RESEARCH-ONLY ESTIMATED TURNITIN-LIKE SIMILARITY — not a verified Turnitin result";
const storageKey = (reportId: string) => `tp:s2-research:${reportId}`;
const sentences = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean);
const extensionOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();

export function System2ResearchPanel({ reportId, uploadedFile }: { reportId: string; uploadedFile?: File | null }) {
  const roomDocx = useMemo(() => (uploadedFile && extensionOf(uploadedFile.name) === ".docx" ? uploadedFile : null), [uploadedFile]);
  const [picked, setPicked] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey(reportId));
      if (saved) setResult(JSON.parse(saved) as Result);
    } catch {
      /* storage unavailable: start empty */
    }
  }, [reportId]);

  const file = roomDocx ?? picked;

  async function run() {
    if (!file || !consent || running) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setResult({ state: "TOO_LARGE", estimate_shown: false, final_text: `File too large for this test (maximum ${MAX_BYTES.toLocaleString("en-US")} bytes). No estimate.` });
      return;
    }
    setRunning(true);
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/system2`, {
        method: "POST",
        headers: { "x-s2-consent": "granted", "x-file-extension": extensionOf(file.name), "content-type": "application/octet-stream" },
        body: await file.arrayBuffer(),
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as Result | null;
      if (!body || typeof body.final_text !== "string") {
        setError(res.status === 404 ? "System 2 research is not available for this account or report." : "The System 2 research service did not respond. No estimate.");
        return;
      }
      setResult(body);
      try {
        sessionStorage.setItem(storageKey(reportId), JSON.stringify(body));
      } catch {
        /* ignore */
      }
    } catch {
      setError("Network error. No estimate.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="room-report-card s2-research-panel" aria-labelledby={`s2-research-${reportId}`}>
      <div className="room-report-card-header">
        <FlaskConical aria-hidden="true" />
        <div>
          <strong id={`s2-research-${reportId}`}>English System 2 · research preview</strong>
          <span>Owner-only. Separate from the similarity and AI results above, which it never changes.</span>
        </div>
      </div>
      <p className="s2-research-label">{LABEL}</p>

      {result ? (
        <div className="s2-research-result" role="status">
          {result.estimate_shown ? (
            <p className="s2-research-estimate">
              <span>Conservative System 2 estimate</span>
              <strong>{result.conservative_estimate_percent}%</strong>
              <span>range 0–20%</span>
            </p>
          ) : (
            <p className="s2-research-estimate s2-research-unavailable">
              <span>System 2 estimate unavailable</span>
              <strong>—</strong>
              <span>{result.state}</span>
            </p>
          )}
          <ul className="s2-research-caveats">
            {sentences(result.final_text).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          {(result.warnings ?? []).map((w, i) => <p key={i} className="room-cycle-note">{w}</p>)}
          {result.diagnostics && (
            <details className="s2-research-diagnostics">
              <summary>Technical diagnostics</summary>
              <pre>{JSON.stringify(result.diagnostics, null, 1)}</pre>
            </details>
          )}
          <button type="button" className="button subtle" onClick={() => { setResult(null); try { sessionStorage.removeItem(storageKey(reportId)); } catch { /* ignore */ } }}>
            Run again
          </button>
        </div>
      ) : (
        <div className="s2-research-form">
          {roomDocx ? (
            <p className="room-cycle-note">Uses the Word manuscript uploaded to this room: <strong>{roomDocx.name}</strong></p>
          ) : (
            <label className="s2-research-file">
              <span>English Word manuscript (.docx, up to 4 MB) — the same file you checked</span>
              <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
            </label>
          )}
          <label className="s2-research-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I consent to sending this Word document to TurnitPlus&apos;s private System 2 research service for this one estimate. It is processed in memory and is not stored.</span>
          </label>
          <button type="button" className="button primary" onClick={() => void run()} disabled={!file || !consent || running}>
            {running ? "Estimating…" : "Run System 2 estimate"}
          </button>
          {error && <p className="room-cycle-note" role="alert">{error}</p>}
          <p className="room-cycle-note">English Word manuscripts only. PDFs, Arabic manuscripts, reports and documents under 300 words are refused.</p>
        </div>
      )}
    </section>
  );
}
