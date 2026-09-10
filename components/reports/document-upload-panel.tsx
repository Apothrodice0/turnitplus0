"use client";

import type { RefObject } from "react";
import { Check, LockKeyhole, UploadCloud } from "lucide-react";
import { ReferenceFilesPanel } from "@/components/reports/reference-files-panel";
import type {
  ReferenceIntakeEntry,
  ReferenceRejection,
} from "@/lib/user-supplied-reference-constants";

/**
 * The upload/check UI (drag-drop zone, file input, "Generate free report"
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

export function DocumentUploadPanel({ file, isGeneratingReport, progress, processingLabel, fileInputRef, onChooseFile, onGenerate, references }: Props) {
  if (isGeneratingReport) {
    return (
      <>
        <div className="upload-locked-panel" role="status" aria-live="polite">
          <span className="upload-locked-icon"><LockKeyhole aria-hidden="true" /></span>
          <p className="section-label">CHECK IN PROGRESS</p>
          <h3>{file?.name ?? "Your document"}</h3>
          <p>{processingLabel}…</p>
          <div className="progress-track" aria-label={`${progress}% complete`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <strong>{progress}%</strong>
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

      <button className="button primary full" type="button" onClick={onGenerate}>
        <UploadCloud aria-hidden="true" />
        Generate free report
      </button>
      <p className="privacy-note"><LockKeyhole aria-hidden="true" /> Documents are processed in your browser.</p>
    </>
  );
}
