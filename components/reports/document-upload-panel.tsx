"use client";

import type { CSSProperties, ReactNode, RefObject } from "react";
import { Check, LockKeyhole, UploadCloud } from "lucide-react";
import { ReferenceFilesPanel } from "@/components/reports/reference-files-panel";
import { displayedCheckPercent, progressEncouragement } from "@/lib/upload-progress";
import { SUBSCRIPTION_REQUIRED_TITLE, type UploadLock } from "@/lib/account-plan";

export type { UploadLock };
import type {
  ReferenceIntakeEntry,
  ReferenceRejection,
} from "@/lib/user-supplied-reference-constants";

/**
 * The upload/check UI (drag-drop zone, file input, "Generate report"
 * button, and the locked/processing state shown while a check is running) —
 * shared between the anonymous Dashboard view (app/page.tsx) and an
 * authenticated account's empty room panel (components/reports/report-rooms.tsx).
 * Room/slot architecture: for an authenticated account this is now the ONLY
 * place a new check can start — see report-rooms.tsx's own header comment
 * for why "New check" no longer appears as a standalone action on My
 * Reports itself.
 *
 * USER-SUPPLIED REFERENCES V1: the optional "Reference files" section
 * (ReferenceFilesPanel) renders here too whenever the parent wires the
 * reference handlers, so it appears in both the anonymous and room flows and
 * stays visible (read-only) while a check runs.
 */

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ReferencePanelProps = {
  referenceEntries: ReferenceIntakeEntry[];
  referenceRejections: ReferenceRejection[];
  referenceInputRef: RefObject<HTMLInputElement | null>;
  onAddReferenceFiles: (files: File[]) => void;
  onRemoveReferenceFile: (id: string) => void;
  onClearReferenceFiles: () => void;
  onDismissReferenceRejections: () => void;
};

type Props = {
  file: File | null;
  isGeneratingReport: boolean;
  progress: number;
  processingLabel: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onChooseFile: (file: File | undefined) => void;
  onGenerate: () => void;
  /** USER-SUPPLIED REFERENCES V1 — omit to hide the reference-files section entirely. */
  references?: ReferencePanelProps;
  /** UPLOAD PROGRESS (lib/upload-progress.ts): true only once the server has confirmed the finished report; without it the panel never shows 100 %. */
  complete?: boolean;
  /** UPLOAD PROGRESS: the analysed report could not be saved; offers to send the SAME report again (never a second report). */
  saveFailure?: { message: string; retrying: boolean; onRetry: () => void };
  /**
   * MANUAL SUBSCRIPTIONS (lib/account-entitlements.ts): set when this account may not start a new check here — no active
   * subscription, or this room is cooling down / outside the plan. The upload area is then shown dimmed and locked: no
   * file input, no drop target, no generate action. Display only — the server refuses the same checks on its own.
   */
  locked?: UploadLock | null;
  /** The generate button's label; "Generate report" unless the parent says otherwise. */
  generateLabel?: string;
  /** Optional block shown just above the Generate button (the owner's one-time System 2 authorization in report rooms); omitted = unchanged form. */
  extraOption?: ReactNode;
  /** Optional replacement for the privacy line (owner-only, when System 2 transmission is authorized); omitted = unchanged line. */
  privacyNote?: ReactNode;
};

function ReferenceSection({ references, busy }: { references?: ReferencePanelProps; busy: boolean }) {
  if (!references) return null;
  return (
    <ReferenceFilesPanel
      entries={references.referenceEntries}
      rejections={references.referenceRejections}
      busy={busy}
      inputRef={references.referenceInputRef}
      onAdd={references.onAddReferenceFiles}
      onRemove={references.onRemoveReferenceFile}
      onClear={references.onClearReferenceFiles}
      onDismissRejections={references.onDismissReferenceRejections}
    />
  );
}

export function DocumentUploadPanel({ file, isGeneratingReport, progress, processingLabel, fileInputRef, onChooseFile, onGenerate, references, complete = false, saveFailure, locked = null, generateLabel = "Generate report", extraOption, privacyNote }: Props) {
  if (locked && !isGeneratingReport && !saveFailure) {
    // A check already running (or a save to retry) always finishes; only a NEW check is locked.
    return (
      <>
        <div
          className="drop-zone drop-zone-locked"
          role="group"
          aria-disabled="true"
          aria-labelledby="upload-locked-title"
          aria-describedby="upload-locked-message"
          // Swallow drops so a file dragged onto the locked area is neither accepted nor opened by the browser.
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => event.preventDefault()}
        >
          <span className="upload-icon drop-zone-locked-icon"><LockKeyhole aria-hidden="true" /></span>
          <strong id="upload-locked-title">{locked.title}</strong>
          <p id="upload-locked-message">
            {locked.message}
            {locked.contact ? <><br />{locked.contact}</> : null}
          </p>
          {locked.detail && <span className="drop-zone-locked-detail">{locked.detail}</span>}
        </div>
        <button className="button primary full upload-locked-action" type="button" disabled aria-disabled="true">
          <LockKeyhole aria-hidden="true" />
          {locked.actionLabel}
        </button>
        <p className="privacy-note"><LockKeyhole aria-hidden="true" /> {locked.title === SUBSCRIPTION_REQUIRED_TITLE ? "Your account remains available." : "Your account and existing reports remain available."}</p>
      </>
    );
  }
  if (saveFailure) {
    return (
      <>
        <div className="upload-locked-panel upload-save-failed" role="alert">
          <span className="upload-locked-icon"><LockKeyhole aria-hidden="true" /></span>
          <p className="section-label">REPORT NOT SAVED YET</p>
          <h3>{file?.name ?? "Your document"}</h3>
          <p>{saveFailure.message}</p>
          <button className="button primary full" type="button" onClick={saveFailure.onRetry} disabled={saveFailure.retrying}>
            {saveFailure.retrying ? "Saving…" : "Try saving again"}
          </button>
        </div>
        <ReferenceSection references={references} busy />
      </>
    );
  }
  if (isGeneratingReport) {
    // ONE continuous bar (lib/upload-progress.ts): always the same track, always a number; the encouragement above it follows
    // the percentage; 100 % only once the server has confirmed the report.
    const shown = displayedCheckPercent(progress, complete);
    const width = complete ? 100 : Math.min(shown + 0.99, Math.max(0, Number.isFinite(progress) ? progress : 0));
    const encouragement = progressEncouragement(shown, complete);
    return (
      <>
        <div className="upload-locked-panel" role="status" aria-live="polite" aria-busy={!complete}>
          <span className="upload-locked-icon"><LockKeyhole aria-hidden="true" /></span>
          <p className="section-label">CHECK IN PROGRESS</p>
          <h3>{file?.name ?? "Your document"}</h3>
          {/* Keyed so a new stage label fades in (CSS only); the dots keep a fixed width, so the text never shifts. */}
          <p key={processingLabel} className="upload-progress-status">
            {processingLabel}
            {complete ? null : <span className="upload-progress-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>}
          </p>
          <p key={encouragement} className="upload-progress-encouragement">{encouragement}</p>
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-label={`${shown}% complete`}>
            <span style={{ width: `${width}%` }} />
          </div>
          {/* The visible number counts up to `shown` through a CSS-transitioned counter (globals.css): it only moves toward the
              value supplied here, never past it, with no JavaScript timer. The real text stays in the DOM for assistive tech. */}
          <strong className="upload-progress-percent" style={{ "--upload-progress-pct": shown } as CSSProperties}>
            <span className="upload-progress-percent-text">{shown}%</span>
          </strong>
        </div>
        <ReferenceSection references={references} busy />
      </>
    );
  }

  return (
    <>
      <label
        className={`drop-zone ${file ? "uploaded" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onChooseFile(event.dataTransfer.files[0]);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.html,.csv"
          hidden
          onChange={(event) => onChooseFile(event.target.files?.[0])}
        />
        {file ? (
          <>
            <span className="upload-icon upload-success-icon"><Check aria-hidden="true" /></span>
            <strong>Document uploaded</strong>
            <p className="uploaded-file-name">{file.name}</p>
            <span className="uploaded-file-meta">{formatBytes(file.size)} · Ready to generate</span>
            <span className="button secondary">Replace file</span>
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

      <ReferenceSection references={references} busy={false} />

      {extraOption}

      <button className="button primary full" type="button" onClick={onGenerate}>
        <UploadCloud aria-hidden="true" />
        {generateLabel}
      </button>
      {privacyNote ?? <p className="privacy-note"><LockKeyhole aria-hidden="true" /> Documents are processed in your browser.</p>}
    </>
  );
}
